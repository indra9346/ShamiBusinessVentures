-- Batch expenses (client, "Approved", 14 Nov 2026): tag Zoho Books expenses (freight, hamali, unloading ...) and the charge
-- lines of supplier bills to batches, so each batch shows its landed cost and profit after expenses.
--
-- How it works (docs: spec section 8):
--   * zoho_cost_documents mirrors one Zoho cost: a Books expense (or one line of an itemized one), or a charge line, the
--     discount or the adjustment of a Zoho bill. Amounts are in base currency. The counted cost is the amount before GST,
--     plus the GST only when it can't be claimed back (cost_amount), so profit stays "before GST" on both sides.
--   * batch_cost_tags splits one document over batches. accepted_cost_amount is the amount the split was last confirmed
--     against. When Zoho later shows another amount (or the expense is gone), the document is flagged; the P&L then uses at
--     most Zoho's current amount (scaled in the app) until an administrator re-splits or accepts it.
--   * A backstop constraint trigger (checked at commit) keeps every tag's sign equal to the document's and the tags' sum
--     within the accepted amount, however the rows are written.
--   * Writes only through the functions below; the server re-reads Zoho before every write. Administrators read.
-- Only adds: three tables, one setting and functions. Safe to run twice. Nothing existing changes.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- tables
CREATE TABLE IF NOT EXISTS public.zoho_cost_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('expense', 'bill')),          -- Books expense, or a charge line of a Zoho bill
  zoho_id text NOT NULL CHECK (btrim(zoho_id) <> ''),                  -- expense_id / bill_id
  zoho_line_id text NOT NULL DEFAULT '',                               -- '' whole expense | line_item_id | 'bill-discount' | 'bill-adjustment'
  doc_number text NOT NULL DEFAULT '',
  doc_date date NOT NULL,
  account_id text NOT NULL DEFAULT '',
  account_name text NOT NULL DEFAULT '',
  vendor_name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  location_id text NOT NULL DEFAULT '',
  currency_code text NOT NULL DEFAULT 'INR',                           -- amounts below are always base currency (bcy_*)
  amount_before_gst numeric(14,2) NOT NULL,
  gst_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  gst_claimable boolean NOT NULL DEFAULT true,                         -- from Zoho itc_eligibility
  gst_override boolean,                                                 -- admin override; NULL = use Zoho's
  reverse_charge boolean NOT NULL DEFAULT false,
  rebilled boolean NOT NULL DEFAULT false,                              -- Books status 'invoiced'
  cost_amount numeric(14,2) NOT NULL CHECK (cost_amount <> 0),          -- before GST + (claimable ? 0 : GST); < 0 only for a discount
  accepted_cost_amount numeric(14,2),                                   -- amount the tags were last confirmed against
  zoho_status text NOT NULL DEFAULT '',
  zoho_modified text NOT NULL DEFAULT '',
  flag text NOT NULL DEFAULT '',
  flag_at timestamptz,
  gone_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  UNIQUE (source, zoho_id, zoho_line_id)
);
CREATE INDEX IF NOT EXISTS zoho_cost_documents_flag_idx ON public.zoho_cost_documents (flag_at) WHERE flag <> '';

CREATE TABLE IF NOT EXISTS public.batch_cost_tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES public.zoho_cost_documents(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  method text NOT NULL CHECK (method IN ('amount', 'percent', 'bags', 'value', 'weight', 'split')),
  weight numeric(18,6) NOT NULL DEFAULT 0,                              -- typed %, bags, value or kg used (record)
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  tagged_by uuid,
  tagged_by_name text NOT NULL DEFAULT '',
  tagged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, batch_id)
);
CREATE INDEX IF NOT EXISTS batch_cost_tags_batch_idx ON public.batch_cost_tags (batch_id);

CREATE TABLE IF NOT EXISTS public.batch_cost_tag_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES public.zoho_cost_documents(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('tag', 'untag', 'accept_change', 'flag', 'split_on_match', 'join')),
  before jsonb NOT NULL DEFAULT '[]'::jsonb,
  after jsonb NOT NULL DEFAULT '[]'::jsonb,
  by_id uuid,
  by_name text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batch_cost_tag_events_document_idx ON public.batch_cost_tag_events (document_id, at);

-- ---------------------------------------------------------------- access: admins read, writes through the functions
ALTER TABLE public.zoho_cost_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_cost_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_cost_tag_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_cost_documents, public.batch_cost_tags, public.batch_cost_tag_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.zoho_cost_documents_id_seq, public.batch_cost_tags_id_seq, public.batch_cost_tag_events_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.zoho_cost_documents, public.batch_cost_tags, public.batch_cost_tag_events TO authenticated;
GRANT ALL ON public.zoho_cost_documents, public.batch_cost_tags, public.batch_cost_tag_events TO service_role;
GRANT ALL ON SEQUENCE public.zoho_cost_documents_id_seq, public.batch_cost_tags_id_seq, public.batch_cost_tag_events_id_seq TO service_role;
DROP POLICY IF EXISTS zoho_cost_documents_admin_read ON public.zoho_cost_documents;
CREATE POLICY zoho_cost_documents_admin_read ON public.zoho_cost_documents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS batch_cost_tags_admin_read ON public.batch_cost_tags;
CREATE POLICY batch_cost_tags_admin_read ON public.batch_cost_tags FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS batch_cost_tag_events_admin_read ON public.batch_cost_tag_events;
CREATE POLICY batch_cost_tag_events_admin_read ON public.batch_cost_tag_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- The expense check's 30-minute throttle (checkBatchCosts).
INSERT INTO public.settings (key, value, is_public) VALUES ('batch_cost_check', '{"at":""}'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- helpers
CREATE SCHEMA IF NOT EXISTS private;

/** Rupees as the app shows them in messages: 1234.5 -> 1234.50. */
CREATE OR REPLACE FUNCTION private.cost_rupees(_amount numeric)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT to_char(COALESCE(_amount, 0), 'FM999999999990.00')
$function$;
REVOKE ALL ON FUNCTION private.cost_rupees(numeric) FROM PUBLIC, anon, authenticated;

/** A document's tags as the event log keeps them. */
CREATE OR REPLACE FUNCTION private.cost_tags_json(_document_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('batch_id', t.batch_id, 'batch_code', b.batch_code, 'amount', t.amount,
           'method', t.method, 'weight', t.weight, 'note', t.note) ORDER BY b.batch_code, t.id), '[]'::jsonb)
    FROM public.batch_cost_tags t JOIN public.batches b ON b.id = t.batch_id
   WHERE t.document_id = _document_id
$function$;
REVOKE ALL ON FUNCTION private.cost_tags_json(bigint) FROM PUBLIC, anon, authenticated;

/** The administrator behind a server call (public.has_role is false for the service role, whose auth.uid() is NULL). */
CREATE OR REPLACE FUNCTION private.cost_actor_is_admin(_by uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE WHEN auth.uid() IS NOT NULL THEN public.has_role(auth.uid(), 'admin')
              ELSE COALESCE(EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _by AND role = 'admin'), false) END
$function$;
REVOKE ALL ON FUNCTION private.cost_actor_is_admin(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- backstop (checked at commit)
/**
 * Every tag has the document's sign, and the tags of a document add up (in size) to at most the amount they were
 * confirmed against (accepted_cost_amount, else the current amount). Fires on tag writes only: when Zoho's amount changes
 * later, the tags stay and the P&L scales them down instead.
 */
CREATE OR REPLACE FUNCTION private.batch_cost_tags_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  total numeric;
  limit_amount numeric;
BEGIN
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = NEW.document_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_cost_tags t WHERE t.document_id = d.id AND sign(t.amount) <> sign(d.cost_amount)) THEN
    RAISE EXCEPTION 'A tag must have the expense''s sign';
  END IF;
  SELECT COALESCE(sum(t.amount), 0) INTO total FROM public.batch_cost_tags t WHERE t.document_id = d.id;
  limit_amount := COALESCE(d.accepted_cost_amount, d.cost_amount);
  IF abs(total) > abs(limit_amount) THEN
    RAISE EXCEPTION 'Expense % would be tagged for ₹% but it is ₹%', COALESCE(NULLIF(d.doc_number, ''), d.zoho_id),
      private.cost_rupees(total), private.cost_rupees(limit_amount);
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION private.batch_cost_tags_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS batch_cost_tags_backstop ON public.batch_cost_tags;
CREATE CONSTRAINT TRIGGER batch_cost_tags_backstop AFTER INSERT OR UPDATE ON public.batch_cost_tags
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.batch_cost_tags_check();

-- ---------------------------------------------------------------- 1. save a document read from Zoho (server only)
/**
 * _doc = {source, zoho_id, zoho_line_id, doc_number, doc_date, account_id, account_name, vendor_name, description,
 *         location_id, currency_code, amount_before_gst, gst_amount, gst_claimable, gst_override?, reverse_charge,
 *         rebilled, zoho_status, zoho_modified}
 * Upserts by (source, zoho_id, zoho_line_id). Seen in Zoho now, so not gone. When it has tags and its counted cost is no
 * longer the amount they were confirmed against, it is flagged. Returns the document id.
 */
CREATE OR REPLACE FUNCTION public.save_cost_document(_doc jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  src text := btrim(COALESCE(_doc->>'source', ''));
  zid text := btrim(COALESCE(_doc->>'zoho_id', ''));
  zline text := btrim(COALESCE(_doc->>'zoho_line_id', ''));
  before_gst numeric(14,2) := round(COALESCE((_doc->>'amount_before_gst')::numeric, 0), 2);
  gst numeric(14,2) := round(GREATEST(COALESCE((_doc->>'gst_amount')::numeric, 0), 0), 2);
  claimable boolean := COALESCE((_doc->>'gst_claimable')::boolean, true);
  old public.zoho_cost_documents%ROWTYPE;
  has_old boolean;
  override boolean;
  cost numeric(14,2);
  has_tags boolean;
  new_flag text;
  new_id bigint;
BEGIN
  IF src NOT IN ('expense', 'bill') OR zid = '' THEN RAISE EXCEPTION 'Not a Zoho expense or bill line'; END IF;
  IF NULLIF(_doc->>'doc_date', '') IS NULL THEN RAISE EXCEPTION 'The expense has no date'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost_doc:' || src || ':' || zid || ':' || zline));
  SELECT * INTO old FROM public.zoho_cost_documents WHERE source = src AND zoho_id = zid AND zoho_line_id = zline FOR UPDATE;
  has_old := FOUND;
  -- The admin's own GST choice stays unless this call sets it (null clears it back to Zoho's).
  override := CASE WHEN _doc ? 'gst_override' THEN (_doc->>'gst_override')::boolean ELSE old.gst_override END;
  cost := before_gst + CASE WHEN COALESCE(override, claimable) THEN 0 ELSE gst END;
  IF cost = 0 THEN RAISE EXCEPTION 'This expense has no amount'; END IF;
  has_tags := has_old AND EXISTS (SELECT 1 FROM public.batch_cost_tags WHERE document_id = old.id);
  new_flag := COALESCE(old.flag, '');
  IF has_tags AND old.accepted_cost_amount IS NOT NULL AND cost <> old.accepted_cost_amount THEN
    new_flag := format('Expense changed in Zoho: ₹%s → ₹%s; re-confirm the split', private.cost_rupees(old.accepted_cost_amount), private.cost_rupees(cost));
  ELSIF new_flag LIKE 'Expense deleted in Zoho%' THEN
    new_flag := '';  -- it is back in Zoho
  END IF;

  INSERT INTO public.zoho_cost_documents AS d (source, zoho_id, zoho_line_id, doc_number, doc_date, account_id, account_name,
    vendor_name, description, location_id, currency_code, amount_before_gst, gst_amount, gst_claimable, gst_override,
    reverse_charge, rebilled, cost_amount, zoho_status, zoho_modified, flag, flag_at, gone_at, fetched_at)
  VALUES (src, zid, zline, left(COALESCE(_doc->>'doc_number', ''), 80), (_doc->>'doc_date')::date,
    left(COALESCE(_doc->>'account_id', ''), 40), left(COALESCE(_doc->>'account_name', ''), 120),
    left(COALESCE(_doc->>'vendor_name', ''), 120), left(COALESCE(_doc->>'description', ''), 200),
    left(COALESCE(_doc->>'location_id', ''), 40), COALESCE(NULLIF(_doc->>'currency_code', ''), 'INR'),
    before_gst, gst, claimable, override, COALESCE((_doc->>'reverse_charge')::boolean, false),
    COALESCE((_doc->>'rebilled')::boolean, false), cost, left(COALESCE(_doc->>'zoho_status', ''), 40),
    left(COALESCE(_doc->>'zoho_modified', ''), 40), new_flag, CASE WHEN new_flag <> '' THEN now() END, NULL, now())
  ON CONFLICT (source, zoho_id, zoho_line_id) DO UPDATE SET
    doc_number = EXCLUDED.doc_number, doc_date = EXCLUDED.doc_date, account_id = EXCLUDED.account_id,
    account_name = EXCLUDED.account_name, vendor_name = EXCLUDED.vendor_name, description = EXCLUDED.description,
    location_id = EXCLUDED.location_id, currency_code = EXCLUDED.currency_code, amount_before_gst = EXCLUDED.amount_before_gst,
    gst_amount = EXCLUDED.gst_amount, gst_claimable = EXCLUDED.gst_claimable, gst_override = EXCLUDED.gst_override,
    reverse_charge = EXCLUDED.reverse_charge, rebilled = EXCLUDED.rebilled, cost_amount = EXCLUDED.cost_amount,
    zoho_status = EXCLUDED.zoho_status, zoho_modified = EXCLUDED.zoho_modified, flag = EXCLUDED.flag,
    flag_at = CASE WHEN EXCLUDED.flag = '' THEN NULL WHEN EXCLUDED.flag = d.flag THEN d.flag_at ELSE now() END,
    gone_at = NULL, fetched_at = now()
  RETURNING id INTO new_id;
  IF has_old AND new_flag <> '' AND new_flag IS DISTINCT FROM old.flag THEN
    INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_name)
    VALUES (new_id, 'flag', jsonb_build_object('cost', old.cost_amount, 'flag', old.flag),
      jsonb_build_object('cost', cost, 'flag', new_flag), 'Zoho');
  END IF;
  RETURN new_id;
END $function$;
REVOKE ALL ON FUNCTION public.save_cost_document(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_cost_document(jsonb) TO service_role;

-- ---------------------------------------------------------------- 2. tag a document to batches (server only)
/**
 * _rows = [{batch_id, amount, method, weight, note}]: the whole split of this document, replacing the one before.
 * The server re-read the document from Zoho (save_cost_document) and worked out the amounts to the paisa.
 * _replace (review fix, 14 Nov 2026): the admin re-split a document Zoho changed (flagged): the flag goes and the new
 * split replaces the old one in this one call, so a failure can never leave it untagged.
 * The batches are locked before the document (a cancel or a match of a pre-order batch runs to the end first), and an
 * expense is tagged either whole or by line, never both.
 */
DROP FUNCTION IF EXISTS public.tag_batch_costs(bigint, jsonb, boolean, uuid, text);
CREATE OR REPLACE FUNCTION public.tag_batch_costs(_document_id bigint, _rows jsonb, _confirm_rebilled boolean, _by uuid, _by_name text,
  _replace boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  r jsonb;
  b public.batches%ROWTYPE;
  amt numeric(14,2);
  total numeric(14,2) := 0;
  seen uuid[] := '{}';
  before_tags jsonb;
  after_tags jsonb;
  ids uuid[];
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can tag expenses to batches'; END IF;
  IF jsonb_typeof(_rows) <> 'array' OR jsonb_array_length(_rows) = 0 THEN RAISE EXCEPTION 'Choose at least one batch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  -- One expense, whole or by line: both at once would count it twice.
  IF d.source = 'expense' THEN
    PERFORM pg_advisory_xact_lock(hashtext('batch_cost_expense:' || d.zoho_id));
    IF d.zoho_line_id = '' AND EXISTS (SELECT 1 FROM public.zoho_cost_documents x JOIN public.batch_cost_tags t ON t.document_id = x.id
                                        WHERE x.source = 'expense' AND x.zoho_id = d.zoho_id AND x.zoho_line_id <> '') THEN
      RAISE EXCEPTION 'This expense is already split by line; untag its lines first';
    END IF;
    IF d.zoho_line_id <> '' AND EXISTS (SELECT 1 FROM public.zoho_cost_documents x JOIN public.batch_cost_tags t ON t.document_id = x.id
                                         WHERE x.source = 'expense' AND x.zoho_id = d.zoho_id AND x.zoho_line_id = '') THEN
      RAISE EXCEPTION 'This expense is already tagged as a whole; untag it first';
    END IF;
  END IF;
  -- The batches first (listed now and tagged before), so a cancel or a bill match of one of them finishes first and
  -- what follows sees its result (a cancelled batch, a remainder's tag).
  ids := ARRAY(SELECT DISTINCT NULLIF(x.value->>'batch_id', '')::uuid FROM jsonb_array_elements(_rows) x WHERE NULLIF(x.value->>'batch_id', '') IS NOT NULL
               UNION SELECT t.batch_id FROM public.batch_cost_tags t WHERE t.document_id = d.id);
  PERFORM 1 FROM public.batches WHERE id = ANY (ids) ORDER BY id FOR SHARE;
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF d.gone_at IS NOT NULL THEN RAISE EXCEPTION 'This expense is no longer in Zoho'; END IF;
  IF d.flag <> '' AND NOT COALESCE(_replace, false) THEN RAISE EXCEPTION 'Zoho changed this expense: review it first'; END IF;
  IF d.rebilled AND NOT COALESCE(_confirm_rebilled, false) THEN
    RAISE EXCEPTION 'This expense was charged on to a customer; tick to count it as your cost';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(_rows) LOOP
    SELECT * INTO b FROM public.batches WHERE id = NULLIF(r->>'batch_id', '')::uuid;
    IF NOT FOUND OR COALESCE(to_jsonb(b)->>'stage', 'received') = 'cancelled' THEN  -- stage comes with the pre-order migration
      RAISE EXCEPTION 'Batch % can''t take expenses', COALESCE(b.batch_code, r->>'batch_id', '?');
    END IF;
    IF b.id = ANY (seen) THEN RAISE EXCEPTION 'Batch % is listed twice', b.batch_code; END IF;
    seen := seen || b.id;
    amt := round(COALESCE((r->>'amount')::numeric, 0), 2);
    IF amt = 0 OR sign(amt) <> sign(d.cost_amount) THEN RAISE EXCEPTION 'A tag must have the expense''s sign'; END IF;
    total := total + amt;
  END LOOP;
  IF abs(total) > abs(d.cost_amount) THEN
    RAISE EXCEPTION '₹% is more than this expense (₹%)', private.cost_rupees(total), private.cost_rupees(d.cost_amount);
  END IF;

  before_tags := private.cost_tags_json(d.id);
  DELETE FROM public.batch_cost_tags WHERE document_id = d.id;
  UPDATE public.zoho_cost_documents SET accepted_cost_amount = cost_amount,
      flag = CASE WHEN COALESCE(_replace, false) THEN '' ELSE flag END,
      flag_at = CASE WHEN COALESCE(_replace, false) THEN NULL ELSE flag_at END
    WHERE id = d.id;
  INSERT INTO public.batch_cost_tags (document_id, batch_id, amount, method, weight, note, tagged_by, tagged_by_name)
  SELECT d.id, (x.value->>'batch_id')::uuid, round((x.value->>'amount')::numeric, 2),
         COALESCE(NULLIF(x.value->>'method', ''), 'amount'), COALESCE(NULLIF(x.value->>'weight', '')::numeric, 0),
         left(btrim(COALESCE(x.value->>'note', '')), 300), _by, left(COALESCE(_by_name, ''), 120)
    FROM jsonb_array_elements(_rows) x;
  after_tags := private.cost_tags_json(d.id);
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (d.id, 'tag', before_tags, after_tags, _by, left(COALESCE(_by_name, ''), 120));
  RETURN jsonb_build_object('document_id', d.id, 'cost_amount', d.cost_amount, 'tagged', total,
    'untagged', d.cost_amount - total, 'tags', after_tags);
END $function$;
REVOKE ALL ON FUNCTION public.tag_batch_costs(bigint, jsonb, boolean, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tag_batch_costs(bigint, jsonb, boolean, uuid, text, boolean) TO service_role;

-- ---------------------------------------------------------------- 3. untag (server only; allowed in any state)
CREATE OR REPLACE FUNCTION public.untag_batch_costs(_document_id bigint, _by uuid, _by_name text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  before_tags jsonb;
  removed integer;
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can tag expenses to batches'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  before_tags := private.cost_tags_json(d.id);
  DELETE FROM public.batch_cost_tags WHERE document_id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  -- Nothing left to confirm: no flag, no accepted amount.
  UPDATE public.zoho_cost_documents SET accepted_cost_amount = NULL, flag = '', flag_at = NULL WHERE id = d.id;
  IF removed > 0 THEN
    INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
    VALUES (d.id, 'untag', before_tags, '[]'::jsonb, _by, left(COALESCE(_by_name, ''), 120));
  END IF;
  RETURN removed;
END $function$;
REVOKE ALL ON FUNCTION public.untag_batch_costs(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.untag_batch_costs(bigint, uuid, text) TO service_role;

-- ---------------------------------------------------------------- 4. the expense check's findings (server only)
/**
 * _rows = [{id, amount_before_gst?, gst_amount?, gst_claimable?, account_id?, account_name?, doc_date?, zoho_status?,
 *           zoho_modified?, rebilled?, gone?, flag?}]
 * Updates the mirror's current values, gone_at, flag, flag_at and checked_at. Never changes tags. A document whose
 * counted cost became 0 in Zoho counts as gone. Returns how many documents carry a flag after this.
 */
CREATE OR REPLACE FUNCTION public.flag_cost_document_changes(_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  r jsonb;
  d public.zoho_cost_documents%ROWTYPE;
  before_gst numeric(14,2);
  gst numeric(14,2);
  claimable boolean;
  cost numeric(14,2);
  gone boolean;
  new_flag text;
  flagged integer := 0;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    SELECT * INTO d FROM public.zoho_cost_documents WHERE id = NULLIF(r->>'id', '')::bigint FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    before_gst := COALESCE(round(NULLIF(r->>'amount_before_gst', '')::numeric, 2), d.amount_before_gst);
    gst := CASE WHEN NULLIF(r->>'gst_amount', '') IS NULL THEN d.gst_amount ELSE round(GREATEST((r->>'gst_amount')::numeric, 0), 2) END;
    claimable := COALESCE(NULLIF(r->>'gst_claimable', '')::boolean, d.gst_claimable);
    cost := before_gst + CASE WHEN COALESCE(d.gst_override, claimable) THEN 0 ELSE gst END;
    gone := COALESCE((r->>'gone')::boolean, false) OR cost = 0;
    new_flag := CASE WHEN r ? 'flag' THEN left(COALESCE(r->>'flag', ''), 200) ELSE d.flag END;
    IF gone AND new_flag = '' THEN new_flag := 'Expense deleted in Zoho'; END IF;
    UPDATE public.zoho_cost_documents SET
      amount_before_gst = CASE WHEN gone AND cost = 0 THEN amount_before_gst ELSE before_gst END,
      gst_amount = CASE WHEN gone AND cost = 0 THEN gst_amount ELSE gst END,
      gst_claimable = CASE WHEN gone AND cost = 0 THEN gst_claimable ELSE claimable END,
      cost_amount = CASE WHEN cost = 0 THEN cost_amount ELSE cost END,
      account_id = COALESCE(left(r->>'account_id', 40), account_id),
      account_name = COALESCE(left(r->>'account_name', 120), account_name),
      doc_date = COALESCE(NULLIF(r->>'doc_date', '')::date, doc_date),
      zoho_status = COALESCE(left(r->>'zoho_status', 40), zoho_status),
      zoho_modified = COALESCE(left(r->>'zoho_modified', 40), zoho_modified),
      rebilled = COALESCE(NULLIF(r->>'rebilled', '')::boolean, rebilled),
      gone_at = CASE WHEN gone THEN COALESCE(gone_at, now()) ELSE NULL END,
      flag = new_flag,
      flag_at = CASE WHEN new_flag = '' THEN NULL WHEN new_flag = d.flag THEN d.flag_at ELSE now() END,
      checked_at = now()
    WHERE id = d.id;
    IF new_flag <> '' AND new_flag IS DISTINCT FROM d.flag THEN
      INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_name)
      VALUES (d.id, 'flag', jsonb_build_object('cost', d.cost_amount, 'flag', d.flag, 'gone', d.gone_at IS NOT NULL),
        jsonb_build_object('cost', CASE WHEN cost = 0 THEN d.cost_amount ELSE cost END, 'flag', new_flag, 'gone', gone), 'Zoho');
    END IF;
    IF new_flag <> '' THEN flagged := flagged + 1; END IF;
  END LOOP;
  RETURN flagged;
END $function$;
REVOKE ALL ON FUNCTION public.flag_cost_document_changes(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_cost_document_changes(jsonb) TO service_role;

-- ---------------------------------------------------------------- 5. accept Zoho's new amount (admin, or the server for one)
CREATE OR REPLACE FUNCTION public.accept_cost_document_change(_document_id bigint, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  total numeric(14,2);
  cur numeric(14,2);
  who uuid := COALESCE(auth.uid(), _by);
  who_name text;
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can accept an expense change'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  SELECT COALESCE(sum(amount), 0) INTO total FROM public.batch_cost_tags WHERE document_id = d.id;
  cur := CASE WHEN d.gone_at IS NOT NULL THEN 0 ELSE d.cost_amount END;
  IF abs(total) > abs(cur) OR (total <> 0 AND sign(total) <> sign(cur)) THEN
    RAISE EXCEPTION 'Tags add up to ₹%, Zoho now has ₹%: re-split first', private.cost_rupees(total), private.cost_rupees(cur);
  END IF;
  who_name := COALESCE(NULLIF(btrim(COALESCE(_by_name, '')), ''),
    (SELECT left(COALESCE(full_name, ''), 120) FROM public.profiles WHERE id = who), '');
  UPDATE public.zoho_cost_documents SET accepted_cost_amount = CASE WHEN gone_at IS NULL THEN cost_amount END, flag = '', flag_at = NULL
    WHERE id = d.id;
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (d.id, 'accept_change', jsonb_build_object('accepted', d.accepted_cost_amount, 'flag', d.flag),
    jsonb_build_object('accepted', CASE WHEN d.gone_at IS NULL THEN d.cost_amount END, 'tags', private.cost_tags_json(d.id)), who, who_name);
  RETURN jsonb_build_object('document_id', d.id, 'accepted', CASE WHEN d.gone_at IS NULL THEN d.cost_amount END, 'tagged', total);
END $function$;
REVOKE ALL ON FUNCTION public.accept_cost_document_change(bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_cost_document_change(bigint, uuid, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
