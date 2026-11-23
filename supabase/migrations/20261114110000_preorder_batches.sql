-- Pre-order batches and bill matching (client, "Approved", 14 Nov 2026):
--   "Sell goods that are ordered but not yet at the godown, under a batch made in advance. When the bill and the bags
--    arrive, match the bill lines to that batch, or make new batches for lines that have none."
--
-- The stock model (pre-order spec, section 2):
--   * A lot is a batches row with stage 'incoming' (no bill yet). It is received when a bill line is matched to it, and
--     cancelled when the purchase is called off.
--   * branch_stock.stock keeps exactly today's meaning: READY stock (in Zoho and not promised). branch_stock.free_total (T)
--     is everything at the godown that may be promised (ready + arriving); a BEFORE trigger derives
--       stock = max(0, T - I)            I = arriving units of the godown's lots not sold or held (their remaining)
--       incoming = max(0, min(sellable, T))
--     For a godown and product with no lot the trigger only mirrors (free_total = stock), so every existing writer and
--     the four release paths work unchanged: they give back the full quantity, and the lot's remaining tells the trigger
--     how much of it is arriving rather than ready.
--   * While a product has a lot anywhere, every active Zoho godown has a preorder_watch row: Zoho's last reading and the
--     "held" units, a rise in Zoho the website has not explained (for example a bill typed in Zoho, not matched yet).
--     Held units are never sold as ready. At every Zoho reading: hold step, then T = Z - held - W + U (W waiting orders,
--     U lot units still to come). Falls never reduce held. So the website is never above the truth, whenever the bill
--     is typed and whatever order things happen in.
--   * Nothing leaves before it arrives: an order holding lot units can't be packed or handed over, gets no delivery
--     note or invoice QR, and its Zoho sales order stays a draft (server).
-- Three deliberate changes to the spec's hold step, each never above the spec's total (tests/db/preorder-property):
--   1. The rise held at a reading is measured against the website's own total, not against Zoho's last number:
--      rise = max(0, (Z - held - W + U) - T now). With Zoho's number alone, a bill typed in Zoho and an invoice of an
--      order in the same hour net out and the website would count the invoiced bags again until the match.
--   2. Changes the website itself makes (lots made, resized, matched, unmatched, cancelled; a transfer's units; a count
--      that found fewer) move T at once, so the reading sees only Zoho's own change.
--   3. A website stock edit still waiting to go to Zoho (zoho_pending) is remembered in preorder_watch.pending_delta, so
--      a match, count or transfer at that godown still takes Zoho's reading (the spec skipped it, which could leave a
--      bill held forever: the push waits for the match and the match waited for the push).
--   Limit (Zoho gives net numbers only): a counter sale in Zoho and an unread rise at the same godown in one pull
--   interval net out; the sale shows when that bill is matched.
-- Review fixes (14 Nov 2026):
--   * Change 1 no longer makes a low reading permanent. The lines a reading counts in W although Zoho may already have
--     taken them out (only in the snapshot; an order whose push to Zoho is running; a sales order past draft kept only
--     by rule (b)) are remembered (preorder_watch.suspect_lines), with how many of their units Zoho's own number really
--     fell by (suspect_cap: never more than Zoho's fall at that reading, beyond the website's own changes). At a later
--     reading, the units of those lines that have left W since (not cancelled or expired) may come back into the total
--     unheld, up to that cap. Same class of limit as above: a counter sale in that reading's interval can stand in for
--     the fall.
--   * A website stock edit goes to Zoho as its own change (pending_delta), after Zoho's reading is applied and only while
--     nothing is held: preorder_push_start / preorder_push_finish. While it is on its way, readings of that godown wait.
--   * Readings are taken at the total's precision (2 decimals, rounded down).
-- Ships with settings.preorder.enabled = false: until an administrator switches it on no lot can be made, and every
-- changed function gives today's results (the old site keeps working). Safe to run twice.
-- Every replaced function is the live definition of 13 Nov 2026 (checked equal to the repo, whitespace aside) with only
-- the lines marked "14 Nov 2026" changed. Rollback: supabase/rollback/20261114_preorder_rollback.sql.
-- Apply 20261114100000_batch_expenses.sql first, outside the cron minute (hh:00): the ALTER TABLEs below wait at most 5
-- seconds for the shop's locks and then fail (run it again) instead of stalling checkouts.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.batch_cost_tags') IS NULL OR to_regprocedure('private.cost_tags_json(bigint)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261114100000_batch_expenses.sql first';
  END IF;
END $guard$;

INSERT INTO public.settings (key, value, is_public)
VALUES ('preorder', '{"enabled":false,"graceDays":0,"requireAck":true}'::jsonb, true)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- batches: lots
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS expected_quantity numeric(14,2),            -- first expectation; NOT NULL = was a pre-order
  ADD COLUMN IF NOT EXISTS expected_date date,
  ADD COLUMN IF NOT EXISTS hold_back numeric(14,2) NOT NULL DEFAULT 0, -- units not offered before arrival
  ADD COLUMN IF NOT EXISTS selling_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_reason text NOT NULL DEFAULT '',     -- '' | 'admin' | 'receiving'
  ADD COLUMN IF NOT EXISTS est_unit_cost_ex_gst numeric(14,2),         -- kept after match (variance)
  ADD COLUMN IF NOT EXISTS est_unit_cost_inc_gst numeric(14,2),
  ADD COLUMN IF NOT EXISTS zoho_po_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_po_number text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_po_line_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS split_from_batch_id uuid REFERENCES public.batches(id) ON DELETE RESTRICT, -- remainder of
  ADD COLUMN IF NOT EXISTS preorder_checks jsonb NOT NULL DEFAULT '{}'::jsonb, -- bills ticked "not this purchase", opening holds
  ADD COLUMN IF NOT EXISTS matched_at timestamptz,
  ADD COLUMN IF NOT EXISTS matched_by uuid,
  ADD COLUMN IF NOT EXISTS matched_by_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_note text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS not_preorder_note text NOT NULL DEFAULT '';  -- why a bill line was NOT matched to an open lot
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_stage_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_stage_check CHECK (stage IN ('incoming', 'received', 'cancelled'));
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_paused_reason_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_paused_reason_check CHECK (paused_reason IN ('', 'admin', 'receiving'));
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_incoming_shape;
ALTER TABLE public.batches ADD CONSTRAINT batches_incoming_shape CHECK (stage <> 'incoming' OR (
  expected_date IS NOT NULL AND expected_quantity IS NOT NULL AND quantity > 0 AND remaining_quantity <= quantity
  AND hold_back >= 0 AND hold_back <= quantity AND est_unit_cost_ex_gst IS NOT NULL AND cost_basis = 'ex_gst'
  AND zoho_bill_id = '' AND zoho_bill_line_id = '' AND parent_batch_id IS NULL AND transfer_id IS NULL
  AND COALESCE(sent_quantity, 0) = 0 AND source = 'website'));
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_cancelled_shape;
ALTER TABLE public.batches ADD CONSTRAINT batches_cancelled_shape CHECK (stage <> 'cancelled' OR (
  quantity = 0 AND remaining_quantity = 0 AND zoho_bill_line_id = '' AND expected_quantity IS NOT NULL));
CREATE INDEX IF NOT EXISTS batches_incoming_idx ON public.batches (product_id, branch_id, expected_date, created_at)
  WHERE stage = 'incoming';
CREATE UNIQUE INDEX IF NOT EXISTS batches_incoming_po_line_unique ON public.batches (zoho_po_id, zoho_po_line_id)
  WHERE stage = 'incoming' AND zoho_po_line_id <> '';
CREATE INDEX IF NOT EXISTS batches_split_from_idx ON public.batches (split_from_batch_id) WHERE split_from_batch_id IS NOT NULL;
-- One lot per "Make pre-order batch" press (the dialog's request id), so a retried request returns the same lot.
CREATE UNIQUE INDEX IF NOT EXISTS batches_preorder_request_unique ON public.batches ((preorder_checks->>'request'))
  WHERE preorder_checks ? 'request';

/** Sold out = Depleted with the moment it happened; stock back = Active again. 14 Nov 2026: a lot is always Active. */
CREATE OR REPLACE FUNCTION private.batch_stock_state()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  -- Added 14 Nov 2026: a pre-order batch waiting for its bill is Active, however much of it is sold.
  IF NEW.stage = 'incoming' THEN NEW.status := 'Active'; NEW.depleted_at := NULL; RETURN NEW; END IF;
  IF NEW.remaining_quantity <= 0 THEN
    NEW.status := 'Depleted';
    IF TG_OP = 'INSERT' OR OLD.remaining_quantity > 0 THEN
      NEW.depleted_at := now();
    ELSE
      NEW.depleted_at := COALESCE(OLD.depleted_at, now());
    END IF;
  ELSE
    NEW.status := 'Active';
    NEW.depleted_at := NULL;
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS batches_stock_state ON public.batches;
CREATE TRIGGER batches_stock_state BEFORE INSERT OR UPDATE OF remaining_quantity, stage ON public.batches
  FOR EACH ROW EXECUTE FUNCTION private.batch_stock_state();

-- ---------------------------------------------------------------- allocations: moves between lots are traceable
ALTER TABLE public.order_item_batch_allocations
  ADD COLUMN IF NOT EXISTS moved_from_allocation_id uuid REFERENCES public.order_item_batch_allocations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- order lines and orders
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS preorder_qty numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS preorder_by date;
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_preorder_qty_check;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_preorder_qty_check CHECK (preorder_qty >= 0 AND preorder_qty <= qty);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS preorder_ack_at timestamptz;

-- ---------------------------------------------------------------- branch_stock: total, arriving, detail
ALTER TABLE public.branch_stock
  ADD COLUMN IF NOT EXISTS free_total numeric(14,2),
  ADD COLUMN IF NOT EXISTS incoming numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incoming_detail jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE public.branch_stock SET free_total = stock WHERE free_total IS NULL;   -- no lots yet: the total is the ready stock
ALTER TABLE public.branch_stock ALTER COLUMN free_total SET NOT NULL;
ALTER TABLE public.branch_stock DROP CONSTRAINT IF EXISTS branch_stock_incoming_check;
ALTER TABLE public.branch_stock ADD CONSTRAINT branch_stock_incoming_check CHECK (incoming >= 0);
-- (the existing anon/authenticated SELECT policy covers the new columns: no codes, costs or suppliers in them)

-- ---------------------------------------------------------------- the watch, the audit, the bill-line cache
CREATE TABLE IF NOT EXISTS public.preorder_watch (
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  zoho_last numeric(14,3) NOT NULL,
  held numeric(14,3) NOT NULL DEFAULT 0 CHECK (held >= 0),
  held_since timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz NOT NULL,
  last_waiting numeric(14,2) NOT NULL DEFAULT 0,   -- W at the last reading (Stock maths panel)
  last_unbilled numeric(14,2) NOT NULL DEFAULT 0,  -- U
  last_raw numeric(14,2),                          -- T - I; < 0 = oversold
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id)
);
-- The website's own stock edits there not yet sent to Zoho (admin_set_branch_stock while zoho_pending): readings keep
-- them in the total, and the hold step does not take them for a rise in Zoho.
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS pending_delta numeric(14,2) NOT NULL DEFAULT 0;
-- The lines the last reading counted as waiting although Zoho may already have taken them out (private.reading_lines).
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS suspect_lines uuid[] NOT NULL DEFAULT '{}'::uuid[];
-- At most this many of their units may come back unheld: what Zoho's own number fell by while they were counted.
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS suspect_cap numeric(14,2) NOT NULL DEFAULT 0;
-- A website stock edit on its way to Zoho (preorder_push_start .. preorder_push_finish): the part of pending_delta sent,
-- the change posted, when.
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS push_pending numeric(14,2);
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS push_delta numeric(14,3);
ALTER TABLE public.preorder_watch ADD COLUMN IF NOT EXISTS push_started_at timestamptz;
CREATE INDEX IF NOT EXISTS preorder_watch_product_idx ON public.preorder_watch (product_id);

CREATE TABLE IF NOT EXISTS public.batch_lot_events (   -- append-only audit
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid REFERENCES public.batches(id) ON DELETE RESTRICT,
  branch_id text NOT NULL,
  product_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'changed', 'paused', 'resumed', 'matched', 'unmatched', 'remainder', 'joined',
    'cancelled', 'moved_to_ready', 'hold_seen', 'hold_released', 'left_unseen', 'oversold', 'overdue', 'bill_flag', 'watch_closed')),
  qty numeric(14,3),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_user uuid,
  by_name text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batch_lot_events_batch_idx ON public.batch_lot_events (batch_id, created_at);
CREATE INDEX IF NOT EXISTS batch_lot_events_pair_idx ON public.batch_lot_events (product_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS public.zoho_bill_line_cache (     -- bill lines read once per Zoho modification
  bill_id text PRIMARY KEY,
  modified text NOT NULL,
  bill_number text NOT NULL DEFAULT '',
  bill_date date,
  created_time text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  location_id text NOT NULL DEFAULT '',
  vendor_name text NOT NULL DEFAULT '',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,                 -- [{line_id,item_id,qty,location_id,item_type,account_name,taxable,gst}]
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.preorder_watch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_lot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zoho_bill_line_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.preorder_watch, public.batch_lot_events, public.zoho_bill_line_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.batch_lot_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.preorder_watch, public.batch_lot_events, public.zoho_bill_line_cache TO authenticated;
GRANT ALL ON public.preorder_watch, public.batch_lot_events, public.zoho_bill_line_cache TO service_role;
GRANT ALL ON SEQUENCE public.batch_lot_events_id_seq TO service_role;
DROP POLICY IF EXISTS preorder_watch_admin_read ON public.preorder_watch;
CREATE POLICY preorder_watch_admin_read ON public.preorder_watch FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS batch_lot_events_admin_read ON public.batch_lot_events;
CREATE POLICY batch_lot_events_admin_read ON public.batch_lot_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS zoho_bill_line_cache_admin_read ON public.zoho_bill_line_cache;
CREATE POLICY zoho_bill_line_cache_admin_read ON public.zoho_bill_line_cache FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- The order guard (guard_order_mutation, not SECURITY DEFINER) asks private.order_waiting_goods for any role that
-- updates an order, the server's included.
GRANT USAGE ON SCHEMA private TO service_role;

-- ================================================================ helpers (section 5.2)
CREATE OR REPLACE FUNCTION private.ist_today()
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date
$function$;

CREATE OR REPLACE FUNCTION private.preorder_on()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE((SELECT lower(COALESCE(value->>'enabled', '')) = 'true' FROM public.settings WHERE key = 'preorder'), false)
     AND COALESCE((SELECT lower(COALESCE(value->>'branch_routing', '')) = 'true' FROM public.settings WHERE key = 'platform_features'), false)
     AND COALESCE((SELECT lower(COALESCE(value->>'enabled', '')) = 'true' FROM public.settings WHERE key = 'zoho_stock_master'), false)
$function$;

CREATE OR REPLACE FUNCTION private.preorder_grace()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT LEAST(14, GREATEST(0, COALESCE((SELECT CASE WHEN COALESCE(value->>'graceDays', '') ~ '^[0-9]{1,3}$'
    THEN (value->>'graceDays')::integer END FROM public.settings WHERE key = 'preorder'), 0)))
$function$;

CREATE OR REPLACE FUNCTION private.preorder_require_ack()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE((SELECT lower(COALESCE(value->>'requireAck', 'true')) <> 'false' FROM public.settings WHERE key = 'preorder'), true)
$function$;

/** Quantities in messages: 50 -> "50", 2.5 -> "2.5". */
CREATE OR REPLACE FUNCTION private.qty_text(_qty numeric)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT rtrim(to_char(COALESCE(_qty, 0), 'FM999999999990.###'), '.')
$function$;

CREATE OR REPLACE FUNCTION private.godown_name(_branch text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE((SELECT NULLIF(btrim(name), '') FROM public.branches WHERE id = _branch), _branch, 'the godown')
$function$;

CREATE OR REPLACE FUNCTION private.product_name(_product text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE((SELECT NULLIF(btrim(payload->>'name'), '') FROM public.catalog_products WHERE id = _product), _product, 'An item')
$function$;

/** A Zoho time ("2026-11-13T14:00:15+0530"), or NULL when it can't be read. */
CREATE OR REPLACE FUNCTION private.zoho_time(_text text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
BEGIN
  IF btrim(COALESCE(_text, '')) = '' THEN RETURN NULL; END IF;
  RETURN regexp_replace(btrim(_text), '([+-][0-9]{2})([0-9]{2})$', '\1:\2')::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $function$;

/**
 * Whether a bill came into Zoho after the watch opened, so its rise is "explained" by matching it. Without Zoho's
 * created_time, the bill's date after the opening day (errs to "no").
 */
CREATE OR REPLACE FUNCTION private.bill_after(_bill jsonb, _opened_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN _opened_at IS NULL THEN false
    WHEN private.zoho_time(_bill->>'created_time') IS NOT NULL THEN private.zoho_time(_bill->>'created_time') > _opened_at
    WHEN COALESCE(_bill->>'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (_bill->>'date')::date > (_opened_at AT TIME ZONE 'Asia/Kolkata')::date
    ELSE false END
$function$;

CREATE OR REPLACE FUNCTION private.lot_accepting(b public.batches)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT b.stage = 'incoming' AND NOT b.selling_paused AND b.expected_date IS NOT NULL
     AND b.expected_date + private.preorder_grace() >= private.ist_today() AND private.preorder_on()
$function$;

CREATE OR REPLACE FUNCTION private.lot_sellable(b public.batches)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE WHEN private.lot_accepting(b) THEN GREATEST(0, b.remaining_quantity - b.hold_back) ELSE 0 END
$function$;

/** The pair's lots: units still to come (U), arriving units not sold or held (I), sellable now, by date, how many. */
CREATE OR REPLACE FUNCTION private.pair_lots(_branch text, _product text)
RETURNS TABLE (u numeric, i numeric, open numeric, detail jsonb, n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH lots AS (
    SELECT b.quantity, b.remaining_quantity, b.expected_date, private.lot_sellable(b) AS s
      FROM public.batches b
     WHERE b.product_id = _product AND b.branch_id = _branch AND b.stage = 'incoming')
  SELECT COALESCE(sum(quantity), 0)::numeric, COALESCE(sum(remaining_quantity), 0)::numeric, COALESCE(sum(s), 0)::numeric,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('by', d.by, 'qty', d.qty) ORDER BY d.by)
                FROM (SELECT expected_date AS by, sum(s) AS qty FROM lots WHERE s > 0 GROUP BY expected_date) d), '[]'::jsonb),
    count(*)::integer
  FROM lots
$function$;

/** [{by, qty}] trimmed, earliest first, so the quantities add up to _total. */
CREATE OR REPLACE FUNCTION private.trim_detail(_detail jsonb, _total numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public' AS $function$
DECLARE
  e jsonb;
  left_qty numeric := GREATEST(0, COALESCE(_total, 0));
  out_json jsonb := '[]'::jsonb;
  q numeric;
BEGIN
  FOR e IN SELECT value FROM jsonb_array_elements(COALESCE(_detail, '[]'::jsonb)) LOOP
    EXIT WHEN left_qty <= 0;
    q := LEAST(left_qty, COALESCE((e->>'qty')::numeric, 0));
    CONTINUE WHEN q <= 0;
    out_json := out_json || jsonb_build_array(jsonb_build_object('by', e->'by', 'qty', q));
    left_qty := left_qty - q;
  END LOOP;
  RETURN out_json;
END $function$;

CREATE OR REPLACE FUNCTION private.stock_master_since()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(
    (SELECT NULLIF(st.value->>'since', '')::timestamptz FROM public.settings st WHERE st.key = 'zoho_stock_master'),
    (SELECT st.updated_at FROM public.settings st WHERE st.key = 'zoho_stock_master'),
    now())
$function$;

/**
 * The order lines W counts at a godown for a product (spec 2.2): since Zoho became the stock master, not cancelled or
 * expired, and (a) with no Zoho sales order beyond a draft, or (b) holding lot units with no live Books invoice; united
 * with the lines of the server's snapshot taken before it read Zoho, still not cancelled or expired.
 */
CREATE OR REPLACE FUNCTION private.waiting_lines(_branch text, _product text, _snapshot uuid[])
RETURNS TABLE (item_id uuid, item_qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT oi.id, oi.qty::numeric
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
   WHERE oi.product_id = _product
     AND COALESCE(NULLIF(o.branch_id, ''), (SELECT b.id FROM public.branches b WHERE b.is_default LIMIT 1)) = _branch
     AND o.order_status NOT IN ('Cancelled', 'Payment Expired')
     AND (oi.id = ANY (COALESCE(_snapshot, '{}'::uuid[]))
       OR (o.created_at >= private.stock_master_since()
           AND ((COALESCE(o.zoho_salesorder_id, '') = '' OR lower(COALESCE(o.zoho_order_status, '')) IN ('', 'draft'))
             OR (EXISTS (SELECT 1 FROM public.order_items oi2
                           JOIN public.order_item_batch_allocations a ON a.order_item_id = oi2.id
                           JOIN public.batches lb ON lb.id = a.batch_id
                          WHERE oi2.order_id = o.id AND lb.stage = 'incoming' AND a.reserved_quantity > a.released_quantity)
                 AND NOT EXISTS (SELECT 1 FROM public.zoho_order_invoices z
                                  WHERE z.order_id = o.id AND COALESCE(z.status, 'none') NOT IN ('none', 'void', 'deleted'))))))
$function$;

CREATE OR REPLACE FUNCTION private.waiting_units(_branch text, _product text, _snapshot uuid[])
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(sum(item_qty), 0)::numeric FROM private.waiting_lines(_branch, _product, _snapshot)
$function$;

/*
 * Added 14 Nov 2026 (review): W at a reading, the lines it counts, and the "suspect" ones among them: counted although
 * Zoho may already have taken them out, so the website may have subtracted them twice. They are the lines
 *   * only in the snapshot (they left W while the server read Zoho),
 *   * of an order whose push to Zoho is running (it may have confirmed or invoiced in Zoho before the read),
 *   * with a sales order past draft, kept only by rule (b) (confirmed by hand in Zoho before the goods arrived).
 */
CREATE OR REPLACE FUNCTION private.reading_lines(_branch text, _product text, _snapshot uuid[])
RETURNS TABLE (w numeric, ids uuid[], suspect uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH x AS (SELECT item_id, item_qty FROM private.waiting_lines(_branch, _product, _snapshot)),
       now_rule AS (SELECT item_id FROM private.waiting_lines(_branch, _product, NULL))
  SELECT COALESCE(sum(x.item_qty), 0)::numeric,
         COALESCE(array_agg(x.item_id ORDER BY x.item_id), '{}'::uuid[]),
         COALESCE(array_agg(x.item_id ORDER BY x.item_id) FILTER (WHERE
              x.item_id NOT IN (SELECT item_id FROM now_rule)
           OR EXISTS (SELECT 1 FROM public.order_items oi JOIN public.zoho_order_push_claims c ON c.order_id = oi.order_id
                       WHERE oi.id = x.item_id AND c.locked_until > now())
           OR EXISTS (SELECT 1 FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
                       WHERE oi.id = x.item_id AND COALESCE(o.zoho_salesorder_id, '') <> ''
                         AND lower(COALESCE(o.zoho_order_status, '')) NOT IN ('', 'draft'))), '{}'::uuid[])
    FROM x
$function$;

/** The units of the last reading's suspect lines that have left W since (not cancelled or expired: those gave their
 * units back through the release path already). At most this much may come back into the total unheld. */
CREATE OR REPLACE FUNCTION private.reading_heal_cap(_product text, _prev uuid[], _now uuid[])
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(sum(oi.qty), 0)::numeric
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
   WHERE oi.id = ANY (COALESCE(_prev, '{}'::uuid[])) AND NOT (oi.id = ANY (COALESCE(_now, '{}'::uuid[])))
     AND oi.product_id = _product AND o.order_status NOT IN ('Cancelled', 'Payment Expired')
$function$;

/**
 * Added 14 Nov 2026 (review): a transfer of the product between godowns (touching _branch, or any when NULL) that the
 * website has not finished. Zoho may show it already: a reading taken now would hold (or take off) units the finish then
 * moves again, so readings other than the finish's own wait for it, as the hourly pull does (holdBack).
 */
CREATE OR REPLACE FUNCTION private.transfer_unfinished(_product text, _branch text DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.batch_transfers t
                  WHERE t.status IN ('pending', 'in_transit')
                    AND (t.product_id = _product OR (jsonb_typeof(t.lines) = 'array'
                         AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) l WHERE l->>'product_id' = _product)))
                    AND (_branch IS NULL OR t.from_branch_id = _branch OR t.to_branch_id = _branch))
$function$;

/** Raised while a website stock edit of the pair is on its way to Zoho (Zoho may or may not show it yet). */
CREATE OR REPLACE FUNCTION private.push_in_flight(_branch text, _product text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.preorder_watch WHERE branch_id = _branch AND product_id = _product
                  AND push_started_at IS NOT NULL AND push_started_at > now() - interval '2 minutes')
$function$;

/** The lot units inside W (their bags are not in Zoho yet): the push plan leaves them out. */
CREATE OR REPLACE FUNCTION private.lot_units_waiting(_branch text, _product text, _snapshot uuid[])
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0)::numeric
    FROM private.waiting_lines(_branch, _product, _snapshot) w
    JOIN public.order_item_batch_allocations a ON a.order_item_id = w.item_id
    JOIN public.batches b ON b.id = a.batch_id
   WHERE b.stage = 'incoming' AND b.product_id = _product AND b.branch_id = _branch
$function$;

/** {"BR|P": [order_item_id, ...]} -> the pair's ids. */
CREATE OR REPLACE FUNCTION private.snapshot_for(_snapshot jsonb, _branch text, _product text)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT COALESCE(array_agg(x::uuid), '{}'::uuid[])
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(_snapshot -> (_branch || '|' || _product)) = 'array'
                                        THEN _snapshot -> (_branch || '|' || _product) ELSE '[]'::jsonb END) x
$function$;

/**
 * A Zoho reading at the total's precision: 2 decimals, rounded down (12.344 kg -> 12.34), so a gram the total can't hold
 * is never taken for a rise. Rounding down errs low.
 */
CREATE OR REPLACE FUNCTION private.zoho_units(_reading numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT floor(round(COALESCE(_reading, 0), 3) * 100) / 100
$function$;

/** Zoho's number for a godown (and product) in [{branch_id, product_id?, zoho | stock, waiting?}]; NULL when not given. */
CREATE OR REPLACE FUNCTION private.reading_for(_readings jsonb, _branch text, _product text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT private.zoho_units(CASE WHEN jsonb_typeof(r->'zoho') = 'number' THEN (r->>'zoho')::numeric ELSE (r->>'stock')::numeric END)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_readings) = 'array' THEN _readings ELSE '[]'::jsonb END) r
   WHERE r->>'branch_id' = _branch AND (NULLIF(r->>'product_id', '') IS NULL OR r->>'product_id' = _product)
     AND (jsonb_typeof(r->'zoho') = 'number' OR jsonb_typeof(r->'stock') = 'number')
   LIMIT 1
$function$;

/** The waiting snapshot that came with a reading (r->'waiting'). */
CREATE OR REPLACE FUNCTION private.reading_waiting(_readings jsonb, _branch text, _product text)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT COALESCE((SELECT array_agg(x::uuid)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_readings) = 'array' THEN _readings ELSE '[]'::jsonb END) r,
         jsonb_array_elements_text(CASE WHEN jsonb_typeof(r->'waiting') = 'array' THEN r->'waiting' ELSE '[]'::jsonb END) x
   WHERE r->>'branch_id' = _branch AND (NULLIF(r->>'product_id', '') IS NULL OR r->>'product_id' = _product)), '{}'::uuid[])
$function$;

CREATE OR REPLACE FUNCTION private.lot_event(_batch uuid, _branch text, _product text, _kind text, _qty numeric, _detail jsonb,
  _note text, _by uuid DEFAULT NULL, _by_name text DEFAULT '')
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  INSERT INTO public.batch_lot_events (batch_id, branch_id, product_id, kind, qty, detail, by_user, by_name, note)
  VALUES (_batch, COALESCE(_branch, ''), COALESCE(_product, ''), _kind, _qty, COALESCE(_detail, '{}'::jsonb), _by,
    left(COALESCE(_by_name, ''), 120), left(COALESCE(_note, ''), 500))
$function$;

CREATE OR REPLACE FUNCTION private.notify_admins(_title text, _message text, _order_no text DEFAULT NULL, _order_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT _order_no, _order_id, ur.user_id, 'admin', _title, _message, 'info'
    FROM public.user_roles ur WHERE ur.role = 'admin'
$function$;

CREATE OR REPLACE FUNCTION private.notify_customer(_order_id uuid, _title text, _message text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, o.user_id, 'customer', _title, _message, 'info'
    FROM public.orders o WHERE o.id = _order_id AND o.user_id IS NOT NULL
$function$;

/** The lot codes of a product at a godown (else anywhere), earliest first: for messages. */
CREATE OR REPLACE FUNCTION private.lot_codes(_branch text, _product text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(
    (SELECT string_agg(batch_code, ', ' ORDER BY expected_date, created_at) FROM public.batches
      WHERE product_id = _product AND branch_id = _branch AND stage = 'incoming'),
    (SELECT string_agg(batch_code, ', ' ORDER BY expected_date, created_at) FROM public.batches
      WHERE product_id = _product AND stage = 'incoming'),
    '(none open)')
$function$;

/**
 * As private.batch_transfer_total: the product's total follows its godowns. The caller's flags are put back after.
 * While a pre-order function is still moving the numbers (app.preorder_write, private.preorder_write_begin) it waits:
 * the function syncs once at its end, so no "out of stock" or "low stock" alert goes out for a number that only exists
 * half-way through it.
 */
CREATE OR REPLACE FUNCTION private.sync_product_total(_product text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  total numeric;
  prev_inbound text := COALESCE(current_setting('app.zoho_inbound', true), '');
  prev_sync text := COALESCE(current_setting('app.branch_stock_sync', true), '');
BEGIN
  IF COALESCE(current_setting('app.preorder_write', true), '') = 'on' THEN RETURN; END IF;
  SELECT COALESCE(sum(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product;
  IF EXISTS (SELECT 1 FROM public.catalog_products WHERE id = _product
              AND COALESCE(payload->>'stock', '') ~ '^-?[0-9]+(\.[0-9]+)?$' AND (payload->>'stock')::numeric = total) THEN
    RETURN;
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product;
  PERFORM set_config('app.branch_stock_sync', prev_sync, true);
  PERFORM set_config('app.zoho_inbound', prev_inbound, true);
END $function$;

/** T := _total at the pair (the derive trigger works out ready and arriving), then the product's total. */
CREATE OR REPLACE FUNCTION private.set_pair_total(_branch text, _product text, _total numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.branch_stock (branch_id, product_id, stock, free_total, zoho_pending)
    VALUES (_branch, _product, 0, round(COALESCE(_total, 0), 2), false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET free_total = round(COALESCE(_total, 0), 2), updated_at = now();
  PERFORM private.sync_product_total(_product);
END $function$;

/** T += _delta at the pair. */
CREATE OR REPLACE FUNCTION private.shift_pair_total(_branch text, _product text, _delta numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.branch_stock (branch_id, product_id, stock, free_total, zoho_pending)
    VALUES (_branch, _product, 0, round(COALESCE(_delta, 0), 2), false)
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET free_total = public.branch_stock.free_total + round(COALESCE(_delta, 0), 2), updated_at = now();
  PERFORM private.sync_product_total(_product);
END $function$;

/** Ready and arriving worked out again (a lot changed); updated_at is left alone, so no Zoho reading is skipped. */
CREATE OR REPLACE FUNCTION private.refresh_pair(_branch text, _product text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF _branch IS NULL OR _product IS NULL THEN RETURN; END IF;
  UPDATE public.branch_stock SET free_total = free_total WHERE branch_id = _branch AND product_id = _product;
  PERFORM private.sync_product_total(_product);
END $function$;

/** A pre-order function starts moving numbers: the products' totals wait until private.preorder_write_end. Returns the
 * flag as it was (a nested call leaves the outer one's flag alone). */
CREATE OR REPLACE FUNCTION private.preorder_write_begin()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE prev text := COALESCE(current_setting('app.preorder_write', true), '');
BEGIN
  PERFORM set_config('app.preorder_write', 'on', true);
  RETURN prev;
END $function$;

/** ... and ends: the flag as it was, and (outermost call) each product's total once, from its godowns' final numbers. */
CREATE OR REPLACE FUNCTION private.preorder_write_end(_prev text, _products text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE p text;
BEGIN
  PERFORM set_config('app.preorder_write', COALESCE(_prev, ''), true);
  IF COALESCE(_prev, '') = 'on' THEN RETURN; END IF;
  FOR p IN SELECT DISTINCT x FROM unnest(COALESCE(_products, '{}'::text[])) x WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM private.sync_product_total(p);
  END LOOP;
END $function$;

/** {waiting: lot units the order holds, codes: [...], products: [...], expected_date: latest}. */
CREATE OR REPLACE FUNCTION private.order_waiting_goods(_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT jsonb_build_object(
    'waiting', COALESCE(sum(a.reserved_quantity - a.released_quantity), 0),
    'codes', COALESCE(jsonb_agg(DISTINCT b.batch_code), '[]'::jsonb),
    'products', COALESCE(jsonb_agg(DISTINCT b.product_name), '[]'::jsonb),
    'expected_date', max(b.expected_date))
  FROM public.order_items oi
  JOIN public.order_item_batch_allocations a ON a.order_item_id = oi.id AND a.reserved_quantity > a.released_quantity
  JOIN public.batches b ON b.id = a.batch_id AND b.stage = 'incoming'
  WHERE oi.order_id = _order_id
$function$;

/*
 * The hold step (spec 2.4) at one godown for one product: a rise Zoho shows that this action did not bring (_explained)
 * is held; falls never reduce held. Locks the watch row. Returns {held_before, rise, held, left} (left: explained units
 * Zoho does not show), or NULL when the pair is not watched. Tells the admins once per episode.
 * _rise: the rise to hold, as private.apply_reading measures it (see there); NULL = Zoho's own change since the last
 * reading (spec 2.4).
 */
CREATE OR REPLACE FUNCTION private.watch_step(_branch text, _product text, _reading numeric, _explained numeric, _rise numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  z numeric := round(COALESCE(_reading, 0), 3);
  e numeric := GREATEST(0, round(COALESCE(_explained, 0), 3));
  rise numeric;
  unseen numeric;
  held_now numeric;
  since timestamptz;
BEGIN
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  rise := GREATEST(0, round(COALESCE(_rise, z - w.zoho_last), 3));
  unseen := GREATEST(0, e - (w.held + rise));
  held_now := GREATEST(0, w.held + rise - e);
  since := CASE WHEN held_now <= 0 THEN NULL ELSE COALESCE(w.held_since, now()) END;
  UPDATE public.preorder_watch SET zoho_last = z, held = held_now, held_since = since, updated_at = now()
    WHERE branch_id = _branch AND product_id = _product;
  IF held_now > w.held THEN
    PERFORM private.lot_event(NULL, _branch, _product, 'hold_seen', held_now - w.held,
      jsonb_build_object('zoho_before', w.zoho_last, 'zoho_now', z, 'explained', e, 'held', held_now), '');
    IF w.held_since IS NULL THEN
      PERFORM private.notify_admins('Zoho shows stock the website can''t explain',
        format('Zoho shows %s more %s at %s than the website counts (since %s). If it is the bill for pre-order batch %s, match it: Admin › Batches › Receive purchase. Those bags are not on sale until then.',
          private.qty_text(held_now), private.product_name(_product), private.godown_name(_branch),
          to_char(since AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'), private.lot_codes(_branch, _product)));
    END IF;
  END IF;
  RETURN jsonb_build_object('held_before', w.held, 'rise', rise, 'held', held_now, 'left', unseen);
END $function$;

/*
 * One Zoho reading of a watched pair (spec 2.3): hold step, then T := Z - held - W + U. Skipped when a website stock
 * edit there still waits to go to Zoho. Returns {T, ready, incoming, held, raw, left, waiting, unbilled, arriving, zoho}.
 *
 * The rise held is measured against the website's own total, not against Zoho's last number (a deliberate change to
 * spec 2.4, never above the spec's total): rise = max(0, (Z - held - W + U) - T now). Every website-side change (orders,
 * releases, lots made, resized, matched or cancelled) already moved T, so what is left is Zoho's own change, with the
 * units of orders that reached Zoho since the last reading (invoiced or confirmed, so out of W and out of Z) counted
 * back in. With Zoho's number alone, a bill typed in Zoho and an invoice of q bags in the same hour net out: q of the
 * bill's bags would not be held and the website would count q bags it does not have until the match.
 * Changed 14 Nov 2026 (review): that alone made any low reading permanent (a line Zoho took out before the read but the
 * website still counted came back as a "rise" and was held). The last reading's suspect lines that have left W since
 * may now come back unheld, up to their units (private.reading_lines, private.reading_heal_cap). Readings wait while a
 * stock edit of the pair is on its way to Zoho.
 */
CREATE OR REPLACE FUNCTION private.apply_reading(_branch text, _product text, _reading numeric, _read_at timestamptz,
  _snapshot uuid[], _explained numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  bs public.branch_stock%ROWTYPE;
  wa public.preorder_watch%ROWTYPE;
  step jsonb;
  rl record;
  w_units numeric;
  l record;
  t numeric;
  prev_raw numeric;
  after_row public.branch_stock%ROWTYPE;
  z numeric := private.zoho_units(_reading);
  pd numeric;
  base numeric;
  heal numeric;
  suspect_units numeric;
BEGIN
  PERFORM 1 FROM public.catalog_products WHERE id = _product FOR UPDATE;
  SELECT * INTO wa FROM public.preorder_watch WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('watched', false); END IF;
  prev_raw := wa.last_raw;
  IF private.push_in_flight(_branch, _product) THEN
    RAISE EXCEPTION 'A stock edit for % at % is being sent to Zoho right now. Try again in a minute.',
      private.product_name(_product), private.godown_name(_branch);
  END IF;
  SELECT * INTO bs FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  -- A website edit still waiting to go to Zoho (pending_delta) stays in the total and is no rise in Zoho.
  pd := CASE WHEN COALESCE(bs.zoho_pending, false) THEN COALESCE(wa.pending_delta, 0) ELSE 0 END;
  SELECT * INTO rl FROM private.reading_lines(_branch, _product, _snapshot);
  w_units := rl.w;
  SELECT * INTO l FROM private.pair_lots(_branch, _product);
  base := COALESCE(bs.free_total, 0) - pd;
  heal := LEAST(wa.suspect_cap, private.reading_heal_cap(_product, wa.suspect_lines, rl.ids),
    GREATEST(0, round(z - wa.held - w_units + l.u - base, 2)));
  step := private.watch_step(_branch, _product, z, _explained, z - wa.held - w_units + l.u - base - heal);
  t := round(z - (step->>'held')::numeric - w_units + l.u + pd, 2);
  PERFORM private.set_pair_total(_branch, _product, t);
  -- The suspect lines now, and how many of their units may come back later: what is left of the cap plus Zoho's own fall
  -- at this reading (zoho_last already moved by the website's own changes in Zoho: pushes, counts, transfers).
  SELECT COALESCE(sum(oi.qty), 0) INTO suspect_units FROM public.order_items oi WHERE oi.id = ANY (rl.suspect);
  UPDATE public.preorder_watch
     SET read_at = COALESCE(_read_at, now()), last_waiting = w_units, last_unbilled = l.u, last_raw = round(t - l.i, 2),
         suspect_lines = rl.suspect,
         suspect_cap = LEAST(suspect_units, GREATEST(0, wa.suspect_cap - heal) + GREATEST(0, round(wa.zoho_last - z, 2))),
         updated_at = now()
   WHERE branch_id = _branch AND product_id = _product;
  IF t - l.i < 0 AND COALESCE(prev_raw, 0) >= 0 THEN
    PERFORM private.lot_event(NULL, _branch, _product, 'oversold', l.i - t,
      jsonb_build_object('zoho', z, 'held', step->'held', 'waiting', w_units, 'unbilled', l.u, 'arriving', l.i, 'total', t), '');
    PERFORM private.notify_admins('Pre-order oversold',
      format('%s at %s: %s units promised to customers are neither in stock nor on the way. Check pre-order batch %s and Zoho.',
        private.product_name(_product), private.godown_name(_branch), private.qty_text(l.i - t), private.lot_codes(_branch, _product)));
  END IF;
  IF (step->>'left')::numeric > 0 THEN
    PERFORM private.lot_event(NULL, _branch, _product, 'left_unseen', (step->>'left')::numeric,
      jsonb_build_object('zoho', z, 'explained', _explained), 'Zoho shows fewer of the explained units than expected; never carried as credit');
  END IF;
  SELECT * INTO after_row FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product;
  RETURN jsonb_build_object('T', after_row.free_total, 'ready', after_row.stock, 'incoming', after_row.incoming,
    'held', (step->>'held')::numeric, 'raw', round(t - l.i, 2), 'left', (step->>'left')::numeric,
    'waiting', w_units, 'unbilled', l.u, 'arriving', l.i, 'zoho', z, 'healed', heal);
END $function$;

/** The rise a reading would hold (read-only): (Z - held - W + U) - T now, less what may come back unheld. */
CREATE OR REPLACE FUNCTION private.reading_rise(_branch text, _product text, _reading numeric, _snapshot uuid[])
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT private.zoho_units(_reading) - w.held - rl.w
         + (SELECT u FROM private.pair_lots(_branch, _product))
         - (COALESCE(bs.free_total, 0) - CASE WHEN COALESCE(bs.zoho_pending, false) THEN w.pending_delta ELSE 0 END)
         - LEAST(w.suspect_cap, private.reading_heal_cap(_product, w.suspect_lines, rl.ids))
    FROM public.preorder_watch w
    CROSS JOIN LATERAL private.reading_lines(_branch, _product, _snapshot) rl
    LEFT JOIN public.branch_stock bs ON bs.branch_id = w.branch_id AND bs.product_id = w.product_id
   WHERE w.branch_id = _branch AND w.product_id = _product
$function$;

/*
 * A product's first lot (or a godown missing its row): a watch row at every active, Zoho-linked, non-vendor godown.
 * A godown already watched takes the reading as any other. A new row starts at Zoho's reading and holds any rise since
 * the website's last pull: held = max(0, Z - (T_before + W)). T becomes Z - held - W + U (U already counts the new lot).
 * Returns {branch_id: held} per godown.
 */
CREATE OR REPLACE FUNCTION private.watch_open(_product text, _readings jsonb, _snapshot jsonb, _read_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  g record;
  z numeric;
  snap uuid[];
  t_before numeric;
  w_units numeric;
  rl record;
  h numeric;
  l record;
  t numeric;
  res jsonb;
  opening jsonb := '{}'::jsonb;
BEGIN
  FOR g IN SELECT b.id FROM public.branches b
            WHERE b.active AND b.vendor_id IS NULL AND COALESCE(b.zoho_location_id, '') <> '' ORDER BY b.id LOOP
    z := private.reading_for(_readings, g.id, _product);
    snap := private.snapshot_for(_snapshot, g.id, _product);
    IF z IS NULL THEN RAISE EXCEPTION 'Zoho''s stock reading is too old; try again'; END IF;
    IF EXISTS (SELECT 1 FROM public.preorder_watch WHERE branch_id = g.id AND product_id = _product) THEN
      res := private.apply_reading(g.id, _product, z, _read_at, snap, 0);
      opening := opening || jsonb_build_object(g.id, COALESCE(res->'held', '0'::jsonb));
      CONTINUE;
    END IF;
    SELECT free_total INTO t_before FROM public.branch_stock WHERE branch_id = g.id AND product_id = _product FOR UPDATE;
    SELECT * INTO rl FROM private.reading_lines(g.id, _product, snap);
    w_units := rl.w;
    h := GREATEST(0, round(z - (COALESCE(t_before, 0) + w_units), 2));
    INSERT INTO public.preorder_watch (branch_id, product_id, zoho_last, held, held_since, opened_at, read_at, updated_at, suspect_lines)
      VALUES (g.id, _product, z, h, CASE WHEN h > 0 THEN now() END, now(), COALESCE(_read_at, now()), now(), rl.suspect);
    IF h > 0 THEN
      PERFORM private.lot_event(NULL, g.id, _product, 'hold_seen', h,
        jsonb_build_object('zoho_now', z, 'website_before', COALESCE(t_before, 0), 'waiting', w_units, 'opening', true), 'Held at opening');
      PERFORM private.notify_admins('Zoho shows stock the website can''t explain',
        format('Zoho shows %s more %s at %s than the website counts (since %s). If it is the bill for pre-order batch %s, match it: Admin › Batches › Receive purchase. Those bags are not on sale until then.',
          private.qty_text(h), private.product_name(_product), private.godown_name(g.id),
          to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'), private.lot_codes(g.id, _product)));
    END IF;
    SELECT * INTO l FROM private.pair_lots(g.id, _product);
    t := round(z - h - w_units + l.u, 2);
    PERFORM private.set_pair_total(g.id, _product, t);
    UPDATE public.preorder_watch SET last_waiting = w_units, last_unbilled = l.u, last_raw = round(t - l.i, 2)
      WHERE branch_id = g.id AND product_id = _product;
    opening := opening || jsonb_build_object(g.id, h);
  END LOOP;
  RETURN opening;
END $function$;

/*
 * When a product's last lot has left 'incoming' (matched, cancelled, joined or deleted), its watch closes. With a fresh
 * reading every godown takes T := Z - W (held units now count as stock: logged and told to the admins); without one, T
 * stays and the next pull sets Z - W. Returns true when it closed.
 */
CREATE OR REPLACE FUNCTION private.watch_close_if_done(_product text, _readings jsonb, _snapshot jsonb, _read_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  z numeric;
  pend boolean;
  w_units numeric;
  closed_detail jsonb := '{}'::jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.batches WHERE product_id = _product AND stage = 'incoming') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.preorder_watch WHERE product_id = _product) THEN RETURN false; END IF;
  FOR w IN SELECT * FROM public.preorder_watch WHERE product_id = _product ORDER BY branch_id FOR UPDATE LOOP
    z := private.reading_for(_readings, w.branch_id, _product);
    SELECT zoho_pending INTO pend FROM public.branch_stock WHERE branch_id = w.branch_id AND product_id = _product FOR UPDATE;
    IF z IS NOT NULL THEN
      -- Zoho less waiting orders, plus a website edit still waiting to go to Zoho (it goes at the next sync, as before).
      w_units := private.waiting_units(w.branch_id, _product, private.snapshot_for(_snapshot, w.branch_id, _product));
      PERFORM private.set_pair_total(w.branch_id, _product,
        GREATEST(0, round(z - w_units + CASE WHEN COALESCE(pend, false) THEN w.pending_delta ELSE 0 END, 2)));
    ELSE
      -- Back to today's rule: the total is the ready stock, never below 0.
      UPDATE public.branch_stock SET free_total = GREATEST(0, free_total) WHERE branch_id = w.branch_id AND product_id = _product;
    END IF;
    IF w.held > 0 THEN
      PERFORM private.lot_event(NULL, w.branch_id, _product, 'hold_released', w.held,
        jsonb_build_object('zoho', z, 'at_close', true), format('counted as stock when the last pre-order of %s closed', private.product_name(_product)));
      PERFORM private.notify_admins('Held stock now counts',
        format('When the last pre-order of %s closed, Zoho still showed %s at %s that the website could not explain; it now counts as stock. Check Zoho for a duplicate bill.',
          private.product_name(_product), private.qty_text(w.held), private.godown_name(w.branch_id)));
    END IF;
    PERFORM private.lot_event(NULL, w.branch_id, _product, 'watch_closed', w.held,
      jsonb_build_object('zoho', z, 'held', w.held, 'opened_at', w.opened_at), '');
    closed_detail := closed_detail || jsonb_build_object(w.branch_id, w.held);
  END LOOP;
  DELETE FROM public.preorder_watch WHERE product_id = _product;
  PERFORM private.sync_product_total(_product);
  RETURN true;
END $function$;

-- ================================================================ triggers (section 5.3)
/*
 * branch_stock: ready (stock) and arriving (incoming) from the total (free_total) and the pair's lots. A legacy write
 * (a new row without a total, or stock changed alone) is READY stock: total = stock + arriving units. With no lot the
 * total just mirrors the ready stock, as before.
 */
CREATE OR REPLACE FUNCTION private.branch_stock_derive()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  legacy boolean;
  l record;
BEGIN
  legacy := (TG_OP = 'INSERT' AND NEW.free_total IS NULL)
         OR (TG_OP = 'UPDATE' AND NEW.stock IS DISTINCT FROM OLD.stock AND NEW.free_total IS NOT DISTINCT FROM OLD.free_total);
  SELECT * INTO l FROM private.pair_lots(NEW.branch_id, NEW.product_id);
  IF COALESCE(l.n, 0) = 0 THEN
    IF legacy THEN NEW.free_total := NEW.stock; ELSE NEW.stock := GREATEST(0, round(NEW.free_total, 2)); END IF;
    NEW.incoming := 0;
    NEW.incoming_detail := '[]'::jsonb;
    RETURN NEW;
  END IF;
  IF legacy THEN NEW.free_total := NEW.stock + l.i; END IF;
  NEW.free_total := round(NEW.free_total, 2);
  NEW.stock := GREATEST(0, round(NEW.free_total - l.i, 2));
  NEW.incoming := GREATEST(0, LEAST(l.open, NEW.free_total));
  NEW.incoming_detail := private.trim_detail(l.detail, NEW.incoming);
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS branch_stock_derive ON public.branch_stock;
CREATE TRIGGER branch_stock_derive BEFORE INSERT OR UPDATE ON public.branch_stock
  FOR EACH ROW EXECUTE FUNCTION private.branch_stock_derive();

/** Allocations on a lot changed (taken, released, moved): ready vs arriving again, in the same transaction. */
CREATE OR REPLACE FUNCTION private.lot_allocation_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  ob public.batches%ROWTYPE;
  nb public.batches%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.batch_id = OLD.batch_id
     AND NEW.reserved_quantity - NEW.released_quantity = OLD.reserved_quantity - OLD.released_quantity THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN SELECT * INTO ob FROM public.batches WHERE id = OLD.batch_id; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN SELECT * INTO nb FROM public.batches WHERE id = NEW.batch_id; END IF;
  IF ob.stage = 'incoming' THEN PERFORM private.refresh_pair(ob.branch_id, ob.product_id); END IF;
  IF nb.stage = 'incoming' AND (ob.id IS NULL OR ob.stage IS DISTINCT FROM 'incoming'
                                OR ob.branch_id IS DISTINCT FROM nb.branch_id OR ob.product_id IS DISTINCT FROM nb.product_id) THEN
    PERFORM private.refresh_pair(nb.branch_id, nb.product_id);
  END IF;
  RETURN NULL;
END $function$;
DROP TRIGGER IF EXISTS order_item_batch_allocations_lot_changed ON public.order_item_batch_allocations;
CREATE TRIGGER order_item_batch_allocations_lot_changed
  AFTER INSERT OR UPDATE OF reserved_quantity, released_quantity, batch_id OR DELETE ON public.order_item_batch_allocations
  FOR EACH ROW EXECUTE FUNCTION private.lot_allocation_changed();

/** A lot changed (made, resized, sold from, paused, dated, matched, cancelled): its godown's split again. */
CREATE OR REPLACE FUNCTION private.lot_row_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.stage = 'incoming' THEN
    PERFORM private.refresh_pair(OLD.branch_id, OLD.product_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.stage = 'incoming'
     AND NOT (TG_OP = 'UPDATE' AND OLD.stage = 'incoming' AND OLD.branch_id IS NOT DISTINCT FROM NEW.branch_id
              AND OLD.product_id = NEW.product_id) THEN
    PERFORM private.refresh_pair(NEW.branch_id, NEW.product_id);
  END IF;
  RETURN NULL;
END $function$;
DROP TRIGGER IF EXISTS batches_lot_changed ON public.batches;
CREATE TRIGGER batches_lot_changed
  AFTER INSERT OR UPDATE OF quantity, remaining_quantity, stage, expected_date, hold_back, selling_paused, branch_id OR DELETE
  ON public.batches FOR EACH ROW EXECUTE FUNCTION private.lot_row_changed();

-- ================================================================ taking an order line (5.4.12)
/*
 * Takes _qty of a product at a godown for an order line the caller just inserted (it holds the product's lock and has
 * set app.branch_id). Ready units first (received batches, FIFO), then the accepting lots by expected date, up to
 * _preorder_allowed. Lowers payload.stock by _qty (the route trigger lowers the godown's total). Returns
 * {ready, preorder, by}.
 */
CREATE OR REPLACE FUNCTION private.take_order_line(_item uuid, _product text, _branch text, _qty numeric, _routing_on boolean,
  _preorder_allowed numeric, _context text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  prod public.catalog_products%ROWTYPE;
  bs public.branch_stock%ROWTYPE;
  lot public.batches%ROWTYPE;
  ready_now numeric;
  ready_part numeric;
  pre_part numeric;
  need numeric;
  take numeric;
  sellable_sum numeric;
  first_by date;
  last_by date;
BEGIN
  SELECT * INTO prod FROM public.catalog_products WHERE id = _product;
  IF _routing_on THEN
    SELECT * INTO bs FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
    ready_now := COALESCE(bs.stock, 0);
  ELSE
    ready_now := COALESCE((prod.payload->>'stock')::numeric, 0);
  END IF;
  ready_part := LEAST(_qty, GREATEST(0, floor(ready_now)));
  pre_part := _qty - ready_part;
  IF pre_part > 0 THEN
    IF NOT private.preorder_on() OR NOT _routing_on THEN RAISE EXCEPTION 'A product does not have enough available stock'; END IF;
    PERFORM 1 FROM public.batches WHERE product_id = _product AND branch_id = _branch AND stage = 'incoming' ORDER BY id FOR UPDATE;
    SELECT COALESCE(sum(private.lot_sellable(b)), 0), min(b.expected_date) FILTER (WHERE private.lot_sellable(b) > 0)
      INTO sellable_sum, first_by
      FROM public.batches b WHERE b.product_id = _product AND b.branch_id = _branch AND b.stage = 'incoming';
    IF pre_part > COALESCE(_preorder_allowed, 0) THEN
      IF _context = 'admin_edit' THEN
        RAISE EXCEPTION 'Only % ready now at %; pre-order units can only be ordered by the customer.', private.qty_text(ready_part), private.godown_name(_branch);
      ELSIF _context = 'replace' THEN
        RAISE EXCEPTION 'Only % ready now; the rest would be a pre-order the customer did not agree to. Refund, or wait for stock.', private.qty_text(ready_part);
      ELSIF sellable_sum > 0 THEN
        RAISE EXCEPTION '% is partly arriving later (by %). Tick the pre-order box to continue.', private.product_name(_product), to_char(first_by, 'DD Mon YYYY');
      ELSE
        RAISE EXCEPTION 'A product does not have enough available stock';
      END IF;
    END IF;
    IF pre_part > LEAST(sellable_sum, GREATEST(0, COALESCE(bs.free_total, 0) - ready_part)) THEN
      RAISE EXCEPTION 'Arriving stock of % changed while you were ordering. Refresh and try again.', private.product_name(_product);
    END IF;
  END IF;

  UPDATE public.catalog_products
    SET payload = jsonb_set(
      jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - _qty), true),
      '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + _qty), true
    ), updated_at = now()
    WHERE id = _product;

  -- Batches: the oldest purchase at this order's godown first (FIFO), split when needed; stock without a batch stays
  -- unbatched. Received batches only.
  IF ready_part > 0 THEN
    PERFORM private.allocate_order_item_batches(_item, _product, _branch, ready_part);
  END IF;
  need := pre_part;
  IF need > 0 THEN
    FOR lot IN SELECT * FROM public.batches
                WHERE product_id = _product AND branch_id = _branch AND stage = 'incoming'
                ORDER BY expected_date, created_at, batch_code LOOP
      EXIT WHEN need <= 0;
      take := LEAST(need, private.lot_sellable(lot));
      CONTINUE WHEN take <= 0;
      UPDATE public.batches SET remaining_quantity = remaining_quantity - take WHERE id = lot.id;
      INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost)
        VALUES (_item, lot.id, take, lot.unit_cost);
      need := need - take;
      last_by := GREATEST(last_by, lot.expected_date);
    END LOOP;
    IF need > 0 THEN
      RAISE EXCEPTION 'Arriving stock of % changed while you were ordering. Refresh and try again.', private.product_name(_product);
    END IF;
    UPDATE public.order_items SET preorder_qty = pre_part, preorder_by = last_by WHERE id = _item;
  END IF;
  RETURN jsonb_build_object('ready', ready_part, 'preorder', pre_part, 'by', last_by);
END $function$;

-- ================================================================ matching a bill line (5.4.10)
/** The rules a match must meet (match_incoming_line, and begin_bill_receive before Zoho moves anything). */
CREATE OR REPLACE FUNCTION private.match_line_check(_branch text, _lot public.batches, _bill jsonb, _line jsonb, _rest text,
  _rest_expected date, _transfer_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  bill_status text := lower(btrim(COALESCE(_bill->>'status', '')));
  line_id text := btrim(COALESCE(_line->>'line_id', ''));
  qb numeric := round(COALESCE((_line->>'qty')::numeric, 0), 2);
  ex numeric := round(COALESCE((_line->>'unit_ex_gst')::numeric, -1), 2);
  inc numeric := round(COALESCE((_line->>'unit_inc_gst')::numeric, -1), 2);
  q numeric := _lot.quantity;
  s numeric := _lot.quantity - _lot.remaining_quantity;
  rest text := COALESCE(NULLIF(btrim(COALESCE(_rest, '')), ''), 'none');
  done text;
  receiving_bill text;
BEGIN
  IF _lot.id IS NULL THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF _lot.stage <> 'incoming' THEN RAISE EXCEPTION 'Batch % is not waiting for a bill (it is %)', _lot.batch_code, _lot.stage; END IF;
  IF _lot.branch_id IS DISTINCT FROM _branch THEN
    RAISE EXCEPTION 'Batch % is at %, not at %. Choose % as the unloading godown.', _lot.batch_code,
      private.godown_name(_lot.branch_id), private.godown_name(_branch), private.godown_name(_lot.branch_id);
  END IF;
  IF COALESCE(_line->>'product_id', '') <> _lot.product_id THEN
    RAISE EXCEPTION 'That bill line is another product. Choose the % line.', _lot.product_name;
  END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  IF bill_status = 'draft' THEN RAISE EXCEPTION 'Open bill % in Zoho first: a draft bill has not added stock', bill_no; END IF;
  IF bill_status = 'void' THEN RAISE EXCEPTION 'Bill % is void in Zoho', bill_no; END IF;
  IF _lot.paused_reason = 'receiving' AND NOT (_transfer_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.batch_transfers t, jsonb_array_elements(t.lines) l
        WHERE t.id = _transfer_id AND l->>'match_batch_id' = _lot.id::text)) THEN
    SELECT t.bill->>'bill_number' INTO receiving_bill FROM public.batch_transfers t, jsonb_array_elements(t.lines) l
     WHERE t.kind = 'receive' AND t.status IN ('pending', 'in_transit') AND l->>'match_batch_id' = _lot.id::text LIMIT 1;
    RAISE EXCEPTION 'Batch % is being received from another bill%', _lot.batch_code, COALESCE(' (' || receiving_bill || ')', '');
  END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = _lot.product_id AND track_batches) THEN
    RAISE EXCEPTION '% has batch tracking in Zoho: its batches come from Zoho', _lot.product_name;
  END IF;
  IF line_id = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
  IF qb <= 0 OR qb > 1000000 THEN RAISE EXCEPTION 'Bill % has a line with no quantity', bill_no; END IF;
  IF ex < 0 OR inc < ex OR inc > 100000000 THEN RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no; END IF;
  IF rest NOT IN ('coming', 'none') THEN RAISE EXCEPTION 'Say whether the rest of batch % is still coming', _lot.batch_code; END IF;
  SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line_id;
  IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
  IF qb < q AND rest = 'none' AND qb < s THEN
    RAISE EXCEPTION 'Bill % has % of %, but customers already bought % on batch %. Choose "the rest is still coming", or cancel and refund % of those orders first.',
      bill_no, private.qty_text(qb), _lot.product_name, private.qty_text(s), _lot.batch_code, private.qty_text(s - qb);
  END IF;
  -- (Review, 14 Nov 2026: checked when the match is asked for; a transfer finishing it on a later day is not refused.)
  IF qb < q AND rest = 'coming' AND _transfer_id IS NULL AND COALESCE(_rest_expected, _lot.expected_date) < private.ist_today() THEN
    RAISE EXCEPTION 'Choose when the rest should arrive';
  END IF;
END $function$;

/*
 * Moves _units held on lot _from to lot _to: allocations of orders still awaiting payment first, then the newest. Whole
 * unreleased rows change lot (moved_from_allocation_id = their own id); others are split (the new row names the old).
 * Returns [{order_id, order_item_id, qty}].
 */
CREATE OR REPLACE FUNCTION private.move_lot_allocations(_from uuid, _to uuid, _units numeric, _unit_cost numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  a record;
  need numeric := COALESCE(_units, 0);
  net numeric;
  m numeric;
  moved jsonb := '[]'::jsonb;
BEGIN
  IF need <= 0 THEN RETURN moved; END IF;
  FOR a IN SELECT al.id, al.order_item_id, al.reserved_quantity, al.released_quantity, oi.order_id
             FROM public.order_item_batch_allocations al
             JOIN public.order_items oi ON oi.id = al.order_item_id
             JOIN public.orders o ON o.id = oi.order_id
            WHERE al.batch_id = _from AND al.reserved_quantity > al.released_quantity
            ORDER BY (o.order_status = 'Awaiting Payment') DESC, al.created_at DESC, al.id DESC
            FOR UPDATE OF al LOOP
    EXIT WHEN need <= 0;
    net := a.reserved_quantity - a.released_quantity;
    m := LEAST(need, net);
    IF m = net AND a.released_quantity = 0 THEN
      UPDATE public.order_item_batch_allocations SET batch_id = _to, unit_cost = _unit_cost, moved_from_allocation_id = a.id WHERE id = a.id;
    ELSE
      UPDATE public.order_item_batch_allocations SET reserved_quantity = reserved_quantity - m WHERE id = a.id;
      INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost, moved_from_allocation_id)
        VALUES (a.order_item_id, _to, m, _unit_cost, a.id);
    END IF;
    moved := moved || jsonb_build_array(jsonb_build_object('order_id', a.order_id, 'order_item_id', a.order_item_id, 'qty', m));
    need := need - m;
  END LOOP;
  RETURN moved;
END $function$;

/** A lot's expense tags split between it and its remainder by bags, to the paisa (largest remainder, ties to the lot). */
CREATE OR REPLACE FUNCTION private.split_lot_tags(_lot uuid, _rest uuid, _w_lot numeric, _w_rest numeric, _by uuid, _by_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t record;
  paise bigint;
  sgn integer;
  total numeric := COALESCE(_w_lot, 0) + COALESCE(_w_rest, 0);
  s1 bigint;
  s2 bigint;
  f1 numeric;
  f2 numeric;
  before_tags jsonb;
BEGIN
  IF total <= 0 OR COALESCE(_w_rest, 0) <= 0 THEN RETURN; END IF;
  FOR t IN SELECT * FROM public.batch_cost_tags WHERE batch_id = _lot ORDER BY id FOR UPDATE LOOP
    before_tags := private.cost_tags_json(t.document_id);
    paise := abs(round(t.amount * 100))::bigint;
    sgn := sign(t.amount)::integer;
    s1 := floor(paise * _w_lot / total)::bigint;
    s2 := floor(paise * _w_rest / total)::bigint;
    f1 := paise * _w_lot / total - s1;
    f2 := paise * _w_rest / total - s2;
    IF paise - s1 - s2 > 0 THEN
      IF f2 > f1 THEN s2 := s2 + (paise - s1 - s2); ELSE s1 := s1 + (paise - s1 - s2); END IF;
    END IF;
    IF s1 = 0 THEN
      DELETE FROM public.batch_cost_tags WHERE id = t.id;
    ELSE
      UPDATE public.batch_cost_tags SET amount = sgn * s1 / 100.0 WHERE id = t.id;
    END IF;
    IF s2 > 0 THEN
      INSERT INTO public.batch_cost_tags (document_id, batch_id, amount, method, weight, note, tagged_by, tagged_by_name)
        VALUES (t.document_id, _rest, sgn * s2 / 100.0, 'split', _w_rest, 'Split from the pre-order at its bill match', _by, left(COALESCE(_by_name, ''), 120));
    END IF;
    INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
      VALUES (t.document_id, 'split_on_match', before_tags, private.cost_tags_json(t.document_id), _by, left(COALESCE(_by_name, ''), 120));
  END LOOP;
END $function$;

/** Tags of lot _from added to lot _into (same document: amounts add up). */
CREATE OR REPLACE FUNCTION private.merge_lot_tags(_from uuid, _into uuid, _action text, _by uuid, _by_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t record;
  before_tags jsonb;
BEGIN
  FOR t IN SELECT * FROM public.batch_cost_tags WHERE batch_id = _from ORDER BY id FOR UPDATE LOOP
    before_tags := private.cost_tags_json(t.document_id);
    IF EXISTS (SELECT 1 FROM public.batch_cost_tags WHERE document_id = t.document_id AND batch_id = _into) THEN
      UPDATE public.batch_cost_tags SET amount = amount + t.amount WHERE document_id = t.document_id AND batch_id = _into;
      DELETE FROM public.batch_cost_tags WHERE id = t.id;
    ELSE
      UPDATE public.batch_cost_tags SET batch_id = _into WHERE id = t.id;
    END IF;
    INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
      VALUES (t.document_id, _action, before_tags, private.cost_tags_json(t.document_id), _by, left(COALESCE(_by_name, ''), 120));
  END LOOP;
END $function$;

/*
 * Matches one bill line to a lot (the caller holds the product locks and the bill's advisory lock).
 *   _bill = {bill_id, bill_number, vendor_name, date, created_time, modified, total, status}
 *   _line = {line_id, product_id, zoho_item_id, qty, unit_ex_gst, unit_inc_gst, mfg_date, expiry_date, notes}
 * The lot becomes a received bill batch at the bill's cost (everything already sold from it is re-costed). A short bill
 * with the rest still coming leaves a remainder lot (-R1) with the rest; bags sold beyond the bill move to it (orders
 * awaiting payment first, then the newest). Returns what happened, with explain: the units this match explains in Zoho
 * (the bill's quantity when Zoho made the bill after the watch opened, else 0). The caller applies the readings.
 */
CREATE OR REPLACE FUNCTION private.match_incoming_line(_branch text, _batch_id uuid, _bill jsonb, _line jsonb, _rest text,
  _rest_expected date, _transfer_id bigint, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  lot public.batches%ROWTYPE;
  r public.batches%ROWTYPE;
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  bill_date date := CASE WHEN COALESCE(_bill->>'date', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (_bill->>'date')::date END;
  qb numeric(14,2) := round(COALESCE((_line->>'qty')::numeric, 0), 2);
  ex numeric(14,2) := round(COALESCE((_line->>'unit_ex_gst')::numeric, -1), 2);
  inc numeric(14,2) := round(COALESCE((_line->>'unit_inc_gst')::numeric, -1), 2);
  q numeric(14,2);
  s numeric(14,2);
  mv numeric(14,2) := 0;
  rest text;
  rest_date date;
  r_code text;
  r_no integer;
  base text;
  moved jsonb := '[]'::jsonb;
  before_orders uuid[];
  arrived text[] := '{}';
  moved_orders text[] := '{}';
  o record;
  m jsonb;
  opened timestamptz;
  explain numeric := 0;
  line_waiting numeric;
  remainder jsonb;
  u_before numeric;
BEGIN
  SELECT * INTO lot FROM public.batches WHERE id = _batch_id FOR UPDATE;
  PERFORM private.match_line_check(_branch, lot, _bill, _line, _rest, _rest_expected, _transfer_id);
  SELECT u INTO u_before FROM private.pair_lots(lot.branch_id, lot.product_id);
  IF bill_date IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  q := lot.quantity;
  s := lot.quantity - lot.remaining_quantity;
  rest := CASE WHEN qb >= q THEN 'none' ELSE COALESCE(NULLIF(btrim(COALESCE(_rest, '')), ''), 'none') END;
  SELECT array_agg(DISTINCT oi.order_id) INTO before_orders
    FROM public.order_item_batch_allocations a JOIN public.order_items oi ON oi.id = a.order_item_id
   WHERE a.batch_id = lot.id AND a.reserved_quantity > a.released_quantity;

  -- The lot becomes the bill's batch.
  UPDATE public.batches SET
      stage = 'received', quantity = qb,
      remaining_quantity = CASE WHEN rest = 'coming' THEN qb - (s - GREATEST(0, s - qb)) ELSE qb - s END,
      hold_back = 0, selling_paused = false, paused_reason = '',
      zoho_bill_id = btrim(_bill->>'bill_id'), zoho_bill_line_id = btrim(_line->>'line_id'), zoho_bill_number = bill_no,
      zoho_bill_modified = left(COALESCE(_bill->>'modified', ''), 40), zoho_bill_total = NULLIF(_bill->>'total', '')::numeric,
      purchase_ref = bill_no, supplier = COALESCE(NULLIF(left(btrim(COALESCE(_bill->>'vendor_name', '')), 120), ''), supplier),
      zoho_item_id = COALESCE(NULLIF(_line->>'zoho_item_id', ''), zoho_item_id),
      unit_cost_ex_gst = ex, unit_cost_inc_gst = inc, cost_basis = 'ex_gst', unit_cost = ex,
      purchase_date = bill_date,
      mfg_date = COALESCE(NULLIF(_line->>'mfg_date', '')::date, mfg_date),
      expiry_date = COALESCE(NULLIF(_line->>'expiry_date', '')::date, expiry_date),
      matched_at = now(), matched_by = _by, matched_by_name = left(COALESCE(_by_name, ''), 120), transfer_id = _transfer_id,
      bill_flag = '', bill_flag_at = NULL, bill_checked_at = now(),
      notes = left(btrim(concat_ws(' · ', NULLIF(notes, ''), NULLIF(left(btrim(COALESCE(_line->>'notes', '')), 120), ''),
        format('Pre-order since %s; matched to bill %s by %s on %s', to_char(lot.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY'),
          bill_no, COALESCE(NULLIF(_by_name, ''), 'an admin'), to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')))), 300)
    WHERE id = lot.id;

  IF rest = 'coming' AND qb < q THEN
    mv := GREATEST(0, s - qb);
    rest_date := COALESCE(_rest_expected, lot.expected_date);
    base := regexp_replace(lot.batch_code, '-R[0-9]+$', '');
    SELECT COALESCE(max((substring(batch_code FROM length(base) + 3))::integer), 0) + 1 INTO r_no
      FROM public.batches
     WHERE product_id = lot.product_id AND COALESCE(branch_id, '') = COALESCE(lot.branch_id, '')
       AND upper(batch_code) LIKE upper(base) || '-R%' AND substring(batch_code FROM length(base) + 3) ~ '^[0-9]{1,4}$';
    r_code := base || '-R' || r_no;
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, warehouse, branch_id, source, supplier,
      purchase_ref, notes, received_by, received_by_name, zoho_item_id, status, stage, expected_quantity, expected_date,
      hold_back, est_unit_cost_ex_gst, est_unit_cost_inc_gst, zoho_po_id, zoho_po_number, zoho_po_line_id, split_from_batch_id,
      preorder_checks)
    VALUES (r_code, lot.product_id, lot.product_name, lot.vendor, lot.vendor_id, q - qb, (q - qb) - mv, lot.unit,
      lot.est_unit_cost_ex_gst, lot.est_unit_cost_ex_gst, lot.est_unit_cost_inc_gst, 'ex_gst', private.ist_today(), lot.warehouse,
      lot.branch_id, 'website', lot.supplier, lot.zoho_po_number,
      left(format('The rest of %s after bill %s', lot.batch_code, bill_no), 300), _by, left(COALESCE(_by_name, ''), 120),
      lot.zoho_item_id, 'Active', 'incoming', q - qb, rest_date, LEAST(lot.hold_back, q - qb), lot.est_unit_cost_ex_gst,
      lot.est_unit_cost_inc_gst, lot.zoho_po_id, lot.zoho_po_number, lot.zoho_po_line_id, lot.id, '{}'::jsonb)
    RETURNING * INTO r;
    moved := private.move_lot_allocations(lot.id, r.id, mv, r.unit_cost);
    PERFORM private.split_lot_tags(lot.id, r.id, qb, q - qb, _by, _by_name);
    remainder := jsonb_build_object('id', r.id, 'code', r.batch_code, 'quantity', r.quantity, 'expected_date', r.expected_date);
  END IF;

  -- The lot units that left U (all of them, or the bill's when the rest is still coming) leave the total now, as any
  -- website-side change; the bill's bags come back through the reading the caller applies (explain).
  PERFORM private.shift_pair_total(lot.branch_id, lot.product_id, (SELECT u FROM private.pair_lots(lot.branch_id, lot.product_id)) - u_before);

  -- Everything already sold from it takes the bill's cost.
  UPDATE public.order_item_batch_allocations SET unit_cost = ex WHERE batch_id = lot.id AND unit_cost IS DISTINCT FROM ex;

  -- Orders: arrived ones go on to Zoho (their sales order is confirmed and invoiced now); moved ones hear the rest comes later.
  FOR o IN SELECT od.id, od.order_no, od.order_status FROM public.orders od WHERE od.id = ANY (COALESCE(before_orders, '{}'::uuid[])) ORDER BY od.created_at LOOP
    IF COALESCE((private.order_waiting_goods(o.id)->>'waiting')::numeric, 0) = 0 THEN
      arrived := arrived || o.order_no;
      IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired', 'Cancelled') THEN
        PERFORM public.enqueue_zoho_sync('order', o.id::text);
        PERFORM private.notify_customer(o.id, 'Your goods have arrived',
          format('%s: %s has arrived at the %s godown. Your invoice and pickup QR follow shortly.', o.order_no, lot.product_name,
            private.godown_name(lot.branch_id)));
      ELSIF o.order_status = 'Awaiting Payment' THEN
        -- Review fix: an unpaid checkout gets no invoice or QR until it is paid.
        PERFORM private.notify_customer(o.id, 'Your goods have arrived',
          format('%s: %s has arrived. Pay to complete your order.', o.order_no, lot.product_name));
      END IF;
    END IF;
  END LOOP;
  FOR m IN SELECT value FROM jsonb_array_elements(moved) LOOP
    SELECT od.id, od.order_no, oi.qty INTO o FROM public.orders od JOIN public.order_items oi ON oi.order_id = od.id
     WHERE oi.id = (m->>'order_item_id')::uuid;
    CONTINUE WHEN o.order_no = ANY (moved_orders);
    moved_orders := moved_orders || o.order_no;
    SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0) INTO line_waiting
      FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id
     WHERE a.order_item_id = (m->>'order_item_id')::uuid AND b.stage = 'incoming';
    PERFORM private.notify_customer(o.id, 'Part of your order comes later',
      format('%s: %s of %s came now; the other %s come with the next delivery, expected by %s.', o.order_no,
        private.qty_text(o.qty - line_waiting), private.qty_text(o.qty), private.qty_text(line_waiting), to_char(rest_date, 'DD Mon YYYY')));
  END LOOP;

  SELECT opened_at INTO opened FROM public.preorder_watch WHERE branch_id = lot.branch_id AND product_id = lot.product_id;
  explain := CASE WHEN private.bill_after(_bill, opened) THEN qb ELSE 0 END;
  PERFORM private.lot_event(lot.id, lot.branch_id, lot.product_id, 'matched', qb,
    jsonb_build_object('bill', jsonb_build_object('bill_id', _bill->>'bill_id', 'bill_number', bill_no, 'created_time', _bill->>'created_time',
        'status', _bill->>'status'),
      'line', _line->>'line_id', 'Q', q, 'Qb', qb, 'S', s, 'move', mv, 'est_cost', lot.est_unit_cost_ex_gst, 'bill_cost', ex,
      'remainder', remainder, 'explain', explain, 'transfer_id', _transfer_id, 'before', to_jsonb(lot)),
    '', _by, _by_name);
  IF r.id IS NOT NULL THEN
    PERFORM private.lot_event(r.id, r.branch_id, r.product_id, 'remainder', r.quantity,
      jsonb_build_object('from', lot.batch_code, 'from_id', lot.id, 'bill_number', bill_no, 'moved', mv), '', _by, _by_name);
  END IF;
  RETURN jsonb_build_object('batch_id', lot.id, 'batch_code', lot.batch_code, 'line_id', _line->>'line_id', 'Q', q, 'Qb', qb, 'S', s,
    'cost_before', lot.unit_cost, 'cost_now', ex, 'remainder', remainder, 'arrived_orders', to_jsonb(arrived),
    'moved_orders', to_jsonb(moved_orders), 'explain', explain);
END $function$;

-- ================================================================ lock helper
/** Products locked in id order (the order every path takes them in). */
CREATE OR REPLACE FUNCTION private.lock_products(_ids text[])
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT 1 FROM (SELECT id FROM public.catalog_products WHERE id = ANY (COALESCE(_ids, '{}'::text[])) ORDER BY id FOR UPDATE) x
$function$;

-- ================================================================ new public functions (5.4)
/*
 * 5.4.1 A pre-order batch (server only; the server read Zoho first and passes the readings).
 *   _readings = [{branch_id, zoho}] for every active Zoho godown; _snapshot = {"BR|P": [order_item_id ...]};
 *   _po = {po_id, po_number, line_id} or null; _checks = {unreceived: [{bill_id, bill_number, line_id, qty, branch_id, ack}]}
 */
CREATE OR REPLACE FUNCTION public.create_incoming_batch(_branch_id text, _product_id text, _quantity numeric, _unit_cost_ex_gst numeric,
  _expected_date date, _hold_back numeric, _supplier text, _po jsonb, _notes text, _checks jsonb,
  _readings jsonb, _snapshot jsonb, _read_at timestamptz, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  g public.branches%ROWTYPE;
  p public.catalog_products%ROWTYPE;
  link public.zoho_item_links%ROWTYPE;
  q numeric(14,2) := round(COALESCE(_quantity, 0), 2);
  hb numeric(14,2) := round(COALESCE(_hold_back, 0), 2);
  c numeric(14,2) := round(COALESCE(_unit_cost_ex_gst, 0), 2);
  whole boolean;
  gst numeric;
  code text;
  new_id uuid;
  chk jsonb;
  po_id text := btrim(COALESCE(_po->>'po_id', ''));
  po_no text := left(btrim(COALESCE(_po->>'po_number', '')), 80);
  po_line text := btrim(COALESCE(_po->>'line_id', ''));
  taken text;
  opening jsonb;
  bs public.branch_stock%ROWTYPE;
  pending_at text;
  dup public.batches%ROWTYPE;
  prev_write text;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can create pre-order batches'; END IF;
  IF NOT COALESCE((SELECT lower(COALESCE(value->>'enabled', '')) = 'true' FROM public.settings WHERE key = 'preorder'), false) THEN
    RAISE EXCEPTION 'Pre-orders are switched off (Admin › Settings › Pre-orders)';
  END IF;
  IF NOT COALESCE((SELECT lower(COALESCE(value->>'enabled', '')) = 'true' FROM public.settings WHERE key = 'zoho_stock_master'), false) THEN
    RAISE EXCEPTION 'Pre-orders need Zoho as the stock master';
  END IF;
  IF NOT COALESCE((SELECT lower(COALESCE(value->>'branch_routing', '')) = 'true' FROM public.settings WHERE key = 'platform_features'), false) THEN
    RAISE EXCEPTION 'Pre-orders need godown matching by PIN to be on';
  END IF;
  SELECT * INTO g FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT g.active OR g.vendor_id IS NOT NULL OR COALESCE(g.zoho_location_id, '') = '' THEN
    RAISE EXCEPTION 'Choose an active godown linked to a Zoho location';
  END IF;
  -- 1. The product first (the lock every path takes first).
  SELECT * INTO p FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'approved' OR NOT p.active OR COALESCE(p.vendor_id, '') LIKE 'zoho:%' THEN
    RAISE EXCEPTION '% is not a website product', COALESCE(p.payload->>'name', _product_id);
  END IF;
  -- Added 14 Nov 2026 (review): a retried press of "Make pre-order batch" (same request id) gets the lot it made.
  IF COALESCE(_checks->>'request', '') <> '' THEN
    SELECT b.* INTO dup FROM public.batches b WHERE b.preorder_checks->>'request' = _checks->>'request';
    IF FOUND THEN
      SELECT * INTO bs FROM public.branch_stock WHERE branch_id = dup.branch_id AND product_id = dup.product_id;
      RETURN jsonb_build_object('batch_id', dup.id, 'batch_code', dup.batch_code, 'ready', bs.stock, 'incoming', bs.incoming,
        'total', bs.free_total, 'held_at_open', COALESCE(dup.preorder_checks->'opening', '{}'::jsonb), 'repeated', true);
    END IF;
  END IF;
  SELECT * INTO link FROM public.zoho_item_links WHERE product_id = p.id;
  IF NOT FOUND OR COALESCE(link.zoho_item_id, '') = '' THEN
    RAISE EXCEPTION '% is not linked to a Zoho item, so its bill can''t be matched', COALESCE(p.payload->>'name', p.id);
  END IF;
  IF link.track_batches THEN RAISE EXCEPTION '% has batch tracking in Zoho: its batches come from Zoho', COALESCE(p.payload->>'name', p.id); END IF;
  IF public.branch_product_price(g.id, p.id) IS NULL THEN
    RAISE EXCEPTION '% is not sold at %', COALESCE(p.payload->>'name', p.id), g.name;
  END IF;
  whole := lower(btrim(COALESCE(p.payload->>'unit', ''))) IN ('', 'pcs', 'pack', 'bag', 'bags', 'pc', 'packs');
  IF q <= 0 OR q > 1000000 OR (whole AND q <> trunc(q)) OR round(COALESCE(_quantity, 0), 2) <> COALESCE(_quantity, 0) THEN
    RAISE EXCEPTION 'Enter the expected quantity in whole units (1 to 10,00,000)';
  END IF;
  IF hb < 0 OR hb > q OR (whole AND hb <> trunc(hb)) OR round(COALESCE(_hold_back, 0), 2) <> COALESCE(_hold_back, 0) THEN
    RAISE EXCEPTION 'Hold back must be between 0 and the expected quantity';
  END IF;
  IF c <= 0 OR c > 100000000 THEN RAISE EXCEPTION 'Enter the expected cost per unit before GST'; END IF;
  IF _expected_date IS NULL OR _expected_date < private.ist_today() OR _expected_date > private.ist_today() + 180 THEN
    RAISE EXCEPTION 'The expected date must be between today and 180 days ahead';
  END IF;
  SELECT branch_id INTO pending_at FROM public.branch_stock WHERE product_id = p.id AND zoho_pending ORDER BY branch_id LIMIT 1;
  IF pending_at IS NOT NULL THEN
    RAISE EXCEPTION 'A stock edit for % at % is waiting to go to Zoho. Press Sync godowns now first.', COALESCE(p.payload->>'name', p.id), private.godown_name(pending_at);
  END IF;
  IF EXISTS (SELECT 1 FROM public.batch_transfers t WHERE t.status IN ('pending', 'in_transit')
              AND (t.product_id = p.id OR EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) l WHERE l->>'product_id' = p.id))) THEN
    RAISE EXCEPTION 'A transfer of % between godowns is not finished. Finish or cancel it first.', COALESCE(p.payload->>'name', p.id);
  END IF;
  IF _read_at IS NULL OR _read_at <= now() - interval '10 minutes' OR EXISTS (
       SELECT 1 FROM public.branches b WHERE b.active AND b.vendor_id IS NULL AND COALESCE(b.zoho_location_id, '') <> ''
          AND private.reading_for(_readings, b.id, p.id) IS NULL) THEN
    RAISE EXCEPTION 'Zoho''s stock reading is too old; try again';
  END IF;
  FOR chk IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_checks->'unreceived') = 'array' THEN _checks->'unreceived' ELSE '[]'::jsonb END) LOOP
    IF lower(COALESCE(chk->>'ack', '')) <> 'true' THEN
      RAISE EXCEPTION 'Bill % has % % at % that is not received on the website. Receive it, or tick "Not this purchase".',
        COALESCE(NULLIF(chk->>'bill_number', ''), chk->>'bill_id', '?'), private.qty_text(NULLIF(chk->>'qty', '')::numeric),
        COALESCE(p.payload->>'name', p.id), private.godown_name(COALESCE(NULLIF(chk->>'branch_id', ''), g.id));
    END IF;
  END LOOP;
  IF po_line <> '' THEN
    SELECT batch_code INTO taken FROM public.batches WHERE stage = 'incoming' AND zoho_po_id = po_id AND zoho_po_line_id = po_line;
    IF FOUND THEN RAISE EXCEPTION 'PO % line is already pre-order batch %', COALESCE(NULLIF(po_no, ''), po_id), taken; END IF;
  END IF;

  -- 2.-3. The lot, numbered as any purchase that day.
  gst := COALESCE(CASE WHEN COALESCE(p.payload->>'gst', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (p.payload->>'gst')::numeric END, 0);
  code := public.next_batch_code(g.id, private.ist_today());
  prev_write := private.preorder_write_begin();
  BEGIN
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, warehouse, branch_id, source, supplier,
      purchase_ref, notes, received_by, received_by_name, zoho_item_id, status, stage, expected_quantity, expected_date,
      hold_back, est_unit_cost_ex_gst, est_unit_cost_inc_gst, zoho_po_id, zoho_po_number, zoho_po_line_id, preorder_checks)
    VALUES (code, p.id, COALESCE(p.payload->>'name', p.id), p.payload->>'vendor', p.vendor_id, q, q,
      COALESCE(NULLIF(p.payload->>'unit', ''), 'pack'), c, c, round(c * (1 + gst / 100), 2), 'ex_gst', private.ist_today(),
      g.name, g.id, 'website', left(btrim(COALESCE(_supplier, '')), 120), po_no, left(btrim(COALESCE(_notes, '')), 300),
      _by, left(COALESCE(_by_name, ''), 120), link.zoho_item_id, 'Active', 'incoming', q, _expected_date, hb, c,
      round(c * (1 + gst / 100), 2), po_id, po_no, po_line,
      CASE WHEN jsonb_typeof(_checks) = 'object' THEN _checks ELSE '{}'::jsonb END)
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT batch_code INTO taken FROM public.batches WHERE stage = 'incoming' AND zoho_po_id = po_id AND zoho_po_line_id = po_line AND po_line <> '';
    IF taken IS NULL THEN RAISE EXCEPTION 'This pre-order batch was made already. Refresh the list.'; END IF;
    RAISE EXCEPTION 'PO % line is already pre-order batch %', COALESCE(NULLIF(po_no, ''), po_id), taken;
  END;

  -- 4.-5. Watch rows at every godown (the new lot is already in U, so T rises by its quantity here).
  -- A godown already watched (another lot of this product) takes the new lot into its total now, as any website-side
  -- change; a godown watched from now is set from Zoho's reading in watch_open.
  IF EXISTS (SELECT 1 FROM public.preorder_watch WHERE branch_id = g.id AND product_id = p.id) THEN
    PERFORM private.shift_pair_total(g.id, p.id, q);
  END IF;
  opening := private.watch_open(p.id, _readings, _snapshot, _read_at);
  UPDATE public.batches SET preorder_checks = preorder_checks || jsonb_build_object('opening', opening) WHERE id = new_id;
  PERFORM private.lot_event(new_id, g.id, p.id, 'created', q,
    jsonb_build_object('cost', c, 'expected_date', _expected_date, 'hold_back', hb, 'po', _po, 'opening', opening), left(btrim(COALESCE(_notes, '')), 300),
    _by, _by_name);
  PERFORM private.preorder_write_end(prev_write, ARRAY[p.id]);
  SELECT * INTO bs FROM public.branch_stock WHERE branch_id = g.id AND product_id = p.id;
  RETURN jsonb_build_object('batch_id', new_id, 'batch_code', code, 'ready', bs.stock, 'incoming', bs.incoming, 'total', bs.free_total,
    'held_at_open', opening);
END $function$;
REVOKE ALL ON FUNCTION public.create_incoming_batch(text, text, numeric, numeric, date, numeric, text, jsonb, text, jsonb, jsonb, jsonb, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_incoming_batch(text, text, numeric, numeric, date, numeric, text, jsonb, text, jsonb, jsonb, jsonb, timestamptz, uuid, text) TO service_role;

/** 5.4.2 Admin: quantity, date, cost, hold-back, pause, supplier and notes of a lot. A NULL keeps the value. */
CREATE OR REPLACE FUNCTION public.admin_update_incoming_batch(_batch_id uuid, _quantity numeric, _expected_date date, _unit_cost_ex_gst numeric,
  _hold_back numeric, _paused boolean, _supplier text, _notes text, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  pid text;
  q numeric(14,2);
  hb numeric(14,2);
  c numeric(14,2);
  d date;
  s numeric(14,2);
  whole boolean;
  gst numeric;
  delta numeric(14,2);
  bill_no text;
  o record;
  me uuid := auth.uid();
  my_name text;
  changed jsonb := '{}'::jsonb;
  prev_write text;
BEGIN
  IF me IS NULL OR NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'Only administrators can edit pre-order batches'; END IF;
  SELECT product_id INTO pid FROM public.batches WHERE id = _batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = pid FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF b.stage <> 'incoming' THEN RAISE EXCEPTION 'Batch % is not waiting for its bill; edit it as a normal batch', b.batch_code; END IF;
  IF b.paused_reason = 'receiving' THEN
    SELECT t.bill->>'bill_number' INTO bill_no FROM public.batch_transfers t, jsonb_array_elements(t.lines) l
     WHERE t.kind = 'receive' AND t.status IN ('pending', 'in_transit') AND l->>'match_batch_id' = b.id::text LIMIT 1;
    RAISE EXCEPTION 'Batch % is being received from bill %; wait for that to finish', b.batch_code, COALESCE(bill_no, '?');
  END IF;
  SELECT left(COALESCE(full_name, ''), 120) INTO my_name FROM public.profiles WHERE id = me;
  q := round(COALESCE(_quantity, b.quantity), 2);
  hb := round(COALESCE(_hold_back, b.hold_back), 2);
  c := round(COALESCE(_unit_cost_ex_gst, b.est_unit_cost_ex_gst), 2);
  d := COALESCE(_expected_date, b.expected_date);
  s := b.quantity - b.remaining_quantity;
  whole := lower(btrim(COALESCE((SELECT payload->>'unit' FROM public.catalog_products WHERE id = b.product_id), ''))) IN ('', 'pcs', 'pack', 'bag', 'bags', 'pc', 'packs');
  IF q <= 0 OR q > 1000000 OR (whole AND q <> trunc(q)) THEN RAISE EXCEPTION 'Enter the expected quantity in whole units (1 to 10,00,000)'; END IF;
  IF q < s THEN
    RAISE EXCEPTION '% units are already sold or held on batch %; the expected quantity can''t go below that', private.qty_text(s), b.batch_code;
  END IF;
  IF hb < 0 OR hb > q OR (whole AND hb <> trunc(hb)) THEN RAISE EXCEPTION 'Hold back must be between 0 and the expected quantity'; END IF;
  IF c <= 0 OR c > 100000000 THEN RAISE EXCEPTION 'Enter the expected cost per unit before GST'; END IF;
  IF d IS DISTINCT FROM b.expected_date AND (d < private.ist_today() OR d > private.ist_today() + 180) THEN
    RAISE EXCEPTION 'The expected date must be between today and 180 days ahead';
  END IF;
  delta := q - b.quantity;
  gst := COALESCE((SELECT CASE WHEN COALESCE(payload->>'gst', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (payload->>'gst')::numeric END
    FROM public.catalog_products WHERE id = b.product_id), 0);
  prev_write := private.preorder_write_begin();
  UPDATE public.batches SET
      quantity = q, expected_quantity = q, remaining_quantity = remaining_quantity + delta, hold_back = hb, expected_date = d,
      unit_cost = c, unit_cost_ex_gst = c, est_unit_cost_ex_gst = c,
      unit_cost_inc_gst = round(c * (1 + gst / 100), 2), est_unit_cost_inc_gst = round(c * (1 + gst / 100), 2),
      selling_paused = COALESCE(_paused, selling_paused),
      paused_reason = CASE WHEN COALESCE(_paused, selling_paused) THEN 'admin' ELSE '' END,
      supplier = CASE WHEN _supplier IS NULL THEN supplier ELSE left(btrim(_supplier), 120) END,
      notes = CASE WHEN _notes IS NULL THEN notes ELSE left(btrim(_notes), 300) END,
      overdue_notified_at = CASE WHEN d > b.expected_date THEN NULL ELSE overdue_notified_at END
    WHERE id = b.id;
  IF delta <> 0 THEN PERFORM private.shift_pair_total(b.branch_id, b.product_id, delta); END IF;
  IF c <> b.unit_cost THEN
    UPDATE public.order_item_batch_allocations SET unit_cost = c WHERE batch_id = b.id;
  END IF;
  -- Customers whose goods come later than they were told hear it.
  IF d > b.expected_date THEN
    FOR o IN SELECT DISTINCT od.id, od.order_no FROM public.order_item_batch_allocations a
               JOIN public.order_items oi ON oi.id = a.order_item_id JOIN public.orders od ON od.id = oi.order_id
              WHERE a.batch_id = b.id AND a.reserved_quantity > a.released_quantity
                AND od.order_status NOT IN ('Cancelled', 'Payment Expired') LOOP
      PERFORM private.notify_customer(o.id, 'Arrival date changed',
        format('%s: %s is now expected by %s.', o.order_no, b.product_name, to_char(d, 'DD Mon YYYY')));
    END LOOP;
  END IF;
  changed := jsonb_strip_nulls(jsonb_build_object(
    'quantity', CASE WHEN q <> b.quantity THEN jsonb_build_array(b.quantity, q) END,
    'expected_date', CASE WHEN d IS DISTINCT FROM b.expected_date THEN jsonb_build_array(b.expected_date, d) END,
    'cost', CASE WHEN c <> b.est_unit_cost_ex_gst THEN jsonb_build_array(b.est_unit_cost_ex_gst, c) END,
    'hold_back', CASE WHEN hb <> b.hold_back THEN jsonb_build_array(b.hold_back, hb) END,
    'supplier', CASE WHEN _supplier IS NOT NULL AND left(btrim(_supplier), 120) <> b.supplier THEN jsonb_build_array(b.supplier, left(btrim(_supplier), 120)) END,
    'notes', CASE WHEN _notes IS NOT NULL AND left(btrim(_notes), 300) <> b.notes THEN true END));
  IF changed <> '{}'::jsonb THEN
    PERFORM private.lot_event(b.id, b.branch_id, b.product_id, 'changed', delta, changed, _note, me, my_name);
  END IF;
  IF _paused IS NOT NULL AND _paused IS DISTINCT FROM b.selling_paused THEN
    PERFORM private.lot_event(b.id, b.branch_id, b.product_id, CASE WHEN _paused THEN 'paused' ELSE 'resumed' END, NULL, '{}'::jsonb, _note, me, my_name);
  END IF;
  PERFORM private.preorder_write_end(prev_write, ARRAY[b.product_id]);
  RETURN (SELECT jsonb_build_object('batch_id', x.id, 'batch_code', x.batch_code, 'quantity', x.quantity, 'remaining', x.remaining_quantity,
    'expected_date', x.expected_date, 'hold_back', x.hold_back, 'paused', x.selling_paused, 'cost', x.est_unit_cost_ex_gst)
    FROM public.batches x WHERE x.id = b.id);
END $function$;
REVOKE ALL ON FUNCTION public.admin_update_incoming_batch(uuid, numeric, date, numeric, numeric, boolean, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_incoming_batch(uuid, numeric, date, numeric, numeric, boolean, text, text, text) TO authenticated;

/** 5.4.3 Admin: the supplier called it off. Only with nothing sold or held on it and no expenses tagged. */
CREATE OR REPLACE FUNCTION public.admin_cancel_incoming_batch(_batch_id uuid, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  pid text;
  net numeric;
  me uuid := auth.uid();
  my_name text;
  closed boolean;
  bill_no text;
  prev_write text;
BEGIN
  IF me IS NULL OR NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'Only administrators can cancel pre-order batches'; END IF;
  SELECT product_id INTO pid FROM public.batches WHERE id = _batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = pid FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF b.stage <> 'incoming' THEN RAISE EXCEPTION 'Batch % is not waiting for its bill', b.batch_code; END IF;
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0) INTO net FROM public.order_item_batch_allocations WHERE batch_id = b.id;
  IF net > 0 THEN
    RAISE EXCEPTION 'Orders still wait for % units of batch %. Cancel and refund them, or move them to ready stock, first.', private.qty_text(net), b.batch_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.batch_cost_tags WHERE batch_id = b.id) THEN
    RAISE EXCEPTION 'Expenses are tagged to batch %; move or remove them first', b.batch_code;
  END IF;
  IF length(btrim(COALESCE(_note, ''))) < 4 THEN RAISE EXCEPTION 'Say why the pre-order is cancelled'; END IF;
  IF b.paused_reason = 'receiving' THEN
    SELECT t.bill->>'bill_number' INTO bill_no FROM public.batch_transfers t, jsonb_array_elements(t.lines) l
     WHERE t.kind = 'receive' AND t.status IN ('pending', 'in_transit') AND l->>'match_batch_id' = b.id::text LIMIT 1;
    RAISE EXCEPTION 'Batch % is being received from bill %; wait for that to finish', b.batch_code, COALESCE(bill_no, '?');
  END IF;
  SELECT left(COALESCE(full_name, ''), 120) INTO my_name FROM public.profiles WHERE id = me;
  prev_write := private.preorder_write_begin();
  UPDATE public.batches SET stage = 'cancelled', quantity = 0, remaining_quantity = 0, hold_back = 0, selling_paused = false,
      paused_reason = '', closed_at = now(), closed_note = left(btrim(_note), 300)
    WHERE id = b.id;
  PERFORM private.shift_pair_total(b.branch_id, b.product_id, -b.quantity);
  PERFORM private.lot_event(b.id, b.branch_id, b.product_id, 'cancelled', b.quantity, jsonb_build_object('quantity', b.quantity), _note, me, my_name);
  closed := private.watch_close_if_done(b.product_id, NULL, NULL, NULL);
  PERFORM private.preorder_write_end(prev_write, ARRAY[b.product_id]);
  RETURN jsonb_build_object('batch_id', b.id, 'batch_code', b.batch_code, 'cancelled', b.quantity, 'watch_closed', closed);
END $function$;
REVOKE ALL ON FUNCTION public.admin_cancel_incoming_batch(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_incoming_batch(uuid, text) TO authenticated;

/** 5.4.4 Admin: one bill line covers two lots: _from goes into _into (orders, quantities and expenses), T unchanged. */
CREATE OR REPLACE FUNCTION public.admin_join_incoming_batches(_into uuid, _from uuid, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  a public.batches%ROWTYPE;
  f public.batches%ROWTYPE;
  al record;
  net numeric;
  me uuid := auth.uid();
  my_name text;
  prev_write text;
BEGIN
  IF me IS NULL OR NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'Only administrators can join pre-order batches'; END IF;
  IF _into IS NULL OR _from IS NULL OR _into = _from THEN RAISE EXCEPTION 'Choose two different pre-order batches'; END IF;
  PERFORM private.lock_products(ARRAY(SELECT DISTINCT product_id FROM public.batches WHERE id IN (_into, _from)));
  PERFORM 1 FROM public.batches WHERE id IN (_into, _from) ORDER BY id FOR UPDATE;
  SELECT * INTO a FROM public.batches WHERE id = _into;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  SELECT * INTO f FROM public.batches WHERE id = _from;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF a.stage <> 'incoming' THEN RAISE EXCEPTION 'Batch % is not waiting for its bill', a.batch_code; END IF;
  IF f.stage <> 'incoming' THEN RAISE EXCEPTION 'Batch % is not waiting for its bill', f.batch_code; END IF;
  IF a.product_id <> f.product_id OR a.branch_id IS DISTINCT FROM f.branch_id THEN
    RAISE EXCEPTION 'Batches % and % are not the same product at the same godown', a.batch_code, f.batch_code;
  END IF;
  IF a.paused_reason = 'receiving' OR f.paused_reason = 'receiving' THEN
    RAISE EXCEPTION 'Batch % is being received from a bill; wait for that to finish', CASE WHEN a.paused_reason = 'receiving' THEN a.batch_code ELSE f.batch_code END;
  END IF;
  IF length(btrim(COALESCE(_note, ''))) < 4 THEN RAISE EXCEPTION 'Say why the batches are joined'; END IF;
  SELECT left(COALESCE(full_name, ''), 120) INTO my_name FROM public.profiles WHERE id = me;
  prev_write := private.preorder_write_begin();

  -- The orders on _from move with it.
  FOR al IN SELECT * FROM public.order_item_batch_allocations WHERE batch_id = f.id AND reserved_quantity > released_quantity ORDER BY created_at, id FOR UPDATE LOOP
    net := al.reserved_quantity - al.released_quantity;
    IF al.released_quantity = 0 THEN
      UPDATE public.order_item_batch_allocations SET batch_id = a.id, unit_cost = a.unit_cost, moved_from_allocation_id = al.id WHERE id = al.id;
    ELSE
      UPDATE public.order_item_batch_allocations SET reserved_quantity = released_quantity WHERE id = al.id;
      INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost, moved_from_allocation_id)
        VALUES (al.order_item_id, a.id, net, a.unit_cost, al.id);
    END IF;
  END LOOP;
  UPDATE public.batches SET stage = 'cancelled', quantity = 0, remaining_quantity = 0, hold_back = 0, selling_paused = false,
      paused_reason = '', closed_at = now(), closed_note = left(format('Joined into %s: %s', a.batch_code, btrim(_note)), 300)
    WHERE id = f.id;
  UPDATE public.batches SET quantity = quantity + f.quantity, remaining_quantity = remaining_quantity + f.remaining_quantity,
      expected_quantity = COALESCE(expected_quantity, 0) + COALESCE(f.expected_quantity, 0),
      hold_back = LEAST(hold_back + f.hold_back, quantity + f.quantity)
    WHERE id = a.id;
  PERFORM private.merge_lot_tags(f.id, a.id, 'join', me, my_name);
  PERFORM private.lot_event(a.id, a.branch_id, a.product_id, 'joined', f.quantity, jsonb_build_object('from', f.batch_code, 'from_id', f.id), _note, me, my_name);
  PERFORM private.lot_event(f.id, f.branch_id, f.product_id, 'joined', f.quantity, jsonb_build_object('into', a.batch_code, 'into_id', a.id), _note, me, my_name);
  PERFORM private.preorder_write_end(prev_write, ARRAY[a.product_id]);
  RETURN (SELECT jsonb_build_object('batch_id', x.id, 'batch_code', x.batch_code, 'quantity', x.quantity, 'remaining', x.remaining_quantity,
    'joined', f.batch_code) FROM public.batches x WHERE x.id = a.id);
END $function$;
REVOKE ALL ON FUNCTION public.admin_join_incoming_batches(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_join_incoming_batches(uuid, uuid, text) TO authenticated;

/** 5.4.5 Admin: part of an order line waiting for a lot is served from ready stock instead. T unchanged. */
CREATE OR REPLACE FUNCTION public.admin_move_to_ready(_order_item_id uuid, _qty numeric, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  it public.order_items%ROWTYPE;
  o public.orders%ROWTYPE;
  q numeric(14,2) := round(COALESCE(_qty, 0), 2);
  waiting numeric;
  ready numeric;
  need numeric;
  take numeric;
  al record;
  lot_ids uuid[] := '{}';
  me uuid := auth.uid();
  my_name text;
  now_waiting numeric;
  prev_write text;
BEGIN
  IF me IS NULL OR NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'Only administrators can move an order to ready stock'; END IF;
  SELECT * INTO it FROM public.order_items WHERE id = _order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  -- The order first, then the product: the order every cancel and release path locks them in (review fix).
  SELECT * INTO o FROM public.orders WHERE id = it.order_id FOR UPDATE;
  PERFORM 1 FROM public.catalog_products WHERE id = it.product_id FOR UPDATE;
  SELECT * INTO it FROM public.order_items WHERE id = _order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  IF o.order_status IN ('Cancelled', 'Payment Expired') THEN RAISE EXCEPTION 'Order % is %', o.order_no, lower(o.order_status); END IF;
  prev_write := private.preorder_write_begin();
  SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0) INTO waiting
    FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id
   WHERE a.order_item_id = it.id AND b.stage = 'incoming';
  IF q <= 0 OR q > waiting THEN RAISE EXCEPTION 'Only % of this line is waiting', private.qty_text(waiting); END IF;
  SELECT COALESCE(stock, 0) INTO ready FROM public.branch_stock WHERE branch_id = o.branch_id AND product_id = it.product_id FOR UPDATE;
  IF COALESCE(ready, 0) < q THEN RAISE EXCEPTION 'Only % ready at %', private.qty_text(COALESCE(ready, 0)), private.godown_name(o.branch_id); END IF;
  SELECT left(COALESCE(full_name, ''), 120) INTO my_name FROM public.profiles WHERE id = me;
  PERFORM 1 FROM public.batches WHERE id IN (SELECT a.batch_id FROM public.order_item_batch_allocations a WHERE a.order_item_id = it.id) ORDER BY id FOR UPDATE;
  need := q;
  FOR al IN SELECT a.* FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id
             WHERE a.order_item_id = it.id AND b.stage = 'incoming' AND a.reserved_quantity > a.released_quantity
             ORDER BY a.created_at DESC, a.id DESC FOR UPDATE OF a LOOP
    EXIT WHEN need <= 0;
    take := LEAST(need, al.reserved_quantity - al.released_quantity);
    UPDATE public.batches SET remaining_quantity = remaining_quantity + take WHERE id = al.batch_id;
    UPDATE public.order_item_batch_allocations SET released_quantity = released_quantity + take WHERE id = al.id;
    lot_ids := lot_ids || al.batch_id;
    need := need - take;
  END LOOP;
  PERFORM private.allocate_order_item_batches(it.id, it.product_id, o.branch_id, q);
  now_waiting := COALESCE((private.order_waiting_goods(o.id)->>'waiting')::numeric, 0);
  IF now_waiting = 0 THEN
    IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired', 'Cancelled') THEN
      PERFORM public.enqueue_zoho_sync('order', o.id::text);
      PERFORM private.notify_customer(o.id, 'Your goods are ready',
        format('%s: %s has arrived at the %s godown. Your invoice and pickup QR follow shortly.', o.order_no, it.product_name, private.godown_name(o.branch_id)));
    ELSIF o.order_status = 'Awaiting Payment' THEN
      PERFORM private.notify_customer(o.id, 'Your goods are ready',
        format('%s: %s has arrived. Pay to complete your order.', o.order_no, it.product_name));
    END IF;
  END IF;
  PERFORM private.lot_event(lot_ids[1], o.branch_id, it.product_id, 'moved_to_ready', q,
    jsonb_build_object('order_no', o.order_no, 'order_item_id', it.id, 'lots', to_jsonb(lot_ids), 'still_waiting', now_waiting), _note, me, my_name);
  PERFORM private.preorder_write_end(prev_write, ARRAY[it.product_id]);
  RETURN jsonb_build_object('order_no', o.order_no, 'moved', q, 'still_waiting', now_waiting);
END $function$;
REVOKE ALL ON FUNCTION public.admin_move_to_ready(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_move_to_ready(uuid, numeric, text) TO authenticated;

/*
 * 5.4.6 A Zoho reading of a watched pair (hourly pull, Sync godowns now). {watched:false}: not watched, use the old path.
 * {skipped:'newer'}: a newer reading was applied. {skipped:'pushing'}: a stock edit of the pair is on its way to Zoho.
 * Changed 14 Nov 2026 (review): a website stock edit still waiting (zoho_pending) no longer stops the reading: it stays
 * in the total (pending_delta), so a counter sale in Zoho is seen while the edit waits. The edit itself goes to Zoho through
 * preorder_push_start / preorder_push_finish; _after_push (older servers) is read as a plain reading.
 */
CREATE OR REPLACE FUNCTION public.apply_preorder_reading(_branch_id text, _product_id text, _reading numeric, _read_at timestamptz,
  _snapshot uuid[], _explained numeric DEFAULT 0, _after_push boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('watched', false); END IF;
  IF private.push_in_flight(_branch_id, _product_id) THEN RETURN jsonb_build_object('skipped', 'pushing'); END IF;
  IF _read_at IS NOT NULL AND w.read_at > _read_at THEN RETURN jsonb_build_object('skipped', 'newer'); END IF;
  RETURN private.apply_reading(_branch_id, _product_id, _reading, _read_at, _snapshot,
    CASE WHEN COALESCE(_after_push, false) THEN 0 ELSE GREATEST(0, COALESCE(_explained, 0)) END);
END $function$;
REVOKE ALL ON FUNCTION public.apply_preorder_reading(text, text, numeric, timestamptz, uuid[], numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_preorder_reading(text, text, numeric, timestamptz, uuid[], numeric, boolean) TO service_role;

/** Why a waiting edit can't go to Zoho now: Zoho shows units the website can't explain (held), or it would raise Zoho's
 * stock where a lot is (I3). NULL: it may go. */
CREATE OR REPLACE FUNCTION private.push_blocker(_branch text, _product text, _held numeric, _delta numeric)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE
    WHEN COALESCE(_held, 0) > 0 THEN format('Zoho shows %s unexplained %s at %s; the stock edit waits until it is matched or explained.',
      private.qty_text(_held), private.product_name(_product), private.godown_name(_branch))
    WHEN COALESCE(_delta, 0) > 0 AND EXISTS (SELECT 1 FROM public.batches b WHERE b.product_id = _product AND b.branch_id = _branch AND b.stage = 'incoming')
      THEN format('%s has a pre-order batch at %s, so the website never raises its stock in Zoho there; the edit waits.',
        private.product_name(_product), private.godown_name(_branch))
  END
$function$;

/*
 * 5.4.7 Read-only: may the website stock edit waiting for Zoho on a watched pair be sent now, and by how much?
 * Changed 14 Nov 2026 (review): the change sent is the edit itself (pending_delta), not "ready + waiting - Zoho": the
 * floored ready stock of an oversold pair made that a stock increase in Zoho. Blocked while Zoho shows a rise the website
 * has not explained (held, or this reading's rise), and never a rise in Zoho where a lot is (I3).
 */
CREATE OR REPLACE FUNCTION public.preorder_push_plan(_branch_id text, _product_id text, _reading numeric, _snapshot uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  pend boolean;
  unexplained numeric;
  d numeric;
  why text;
BEGIN
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('watched', false); END IF;
  SELECT zoho_pending INTO pend FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  d := CASE WHEN COALESCE(pend, false) THEN w.pending_delta ELSE 0 END;
  unexplained := w.held + CASE WHEN _reading IS NULL THEN 0
    ELSE GREATEST(0, COALESCE(private.reading_rise(_branch_id, _product_id, _reading, _snapshot), 0)) END;
  why := private.push_blocker(_branch_id, _product_id, unexplained, d);
  IF why IS NOT NULL THEN
    RETURN jsonb_build_object('watched', true, 'blocked', true, 'unexplained', unexplained, 'message', why, 'pending', d);
  END IF;
  RETURN jsonb_build_object('watched', true, 'blocked', false, 'pending', d, 'delta', d, 'reading', _reading,
    'in_flight', private.push_in_flight(_branch_id, _product_id));
END $function$;
REVOKE ALL ON FUNCTION public.preorder_push_plan(text, text, numeric, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preorder_push_plan(text, text, numeric, uuid[]) TO service_role;

/*
 * Added 14 Nov 2026 (review). The server sends a waiting website stock edit of a watched pair to Zoho after applying
 * Zoho's reading (apply_preorder_reading): start, post the adjustment by delta, finish. Until finish (or 2 minutes) the
 * pair's readings wait, since Zoho may or may not show the change yet. Returns {watched, blocked, message?, delta,
 * pending} or {skipped}. delta 0: nothing to send (the edit is done).
 */
CREATE OR REPLACE FUNCTION public.preorder_push_start(_branch_id text, _product_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  bs public.branch_stock%ROWTYPE;
  why text;
BEGIN
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('watched', false); END IF;
  SELECT * INTO bs FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF NOT COALESCE(bs.zoho_pending, false) THEN RETURN jsonb_build_object('watched', true, 'skipped', 'not_pending'); END IF;
  IF private.push_in_flight(_branch_id, _product_id) THEN RETURN jsonb_build_object('watched', true, 'skipped', 'pushing'); END IF;
  why := private.push_blocker(_branch_id, _product_id, w.held, w.pending_delta);
  IF why IS NOT NULL THEN
    UPDATE public.preorder_watch SET push_pending = NULL, push_delta = NULL, push_started_at = NULL
     WHERE branch_id = _branch_id AND product_id = _product_id AND push_started_at IS NOT NULL;
    RETURN jsonb_build_object('watched', true, 'blocked', true, 'message', why, 'pending', w.pending_delta);
  END IF;
  IF w.pending_delta = 0 THEN
    -- Marked waiting without a change the website still owes Zoho: nothing to send.
    UPDATE public.branch_stock SET zoho_pending = false WHERE branch_id = _branch_id AND product_id = _product_id;
    UPDATE public.preorder_watch SET push_pending = NULL, push_delta = NULL, push_started_at = NULL
     WHERE branch_id = _branch_id AND product_id = _product_id;
    RETURN jsonb_build_object('watched', true, 'blocked', false, 'delta', 0, 'pending', 0);
  END IF;
  UPDATE public.preorder_watch SET push_pending = w.pending_delta, push_delta = w.pending_delta, push_started_at = now()
   WHERE branch_id = _branch_id AND product_id = _product_id;
  RETURN jsonb_build_object('watched', true, 'blocked', false, 'delta', w.pending_delta, 'pending', w.pending_delta);
END $function$;
REVOKE ALL ON FUNCTION public.preorder_push_start(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preorder_push_start(text, text) TO service_role;

/*
 * Zoho took the change (_ok) or did not. Taken: the part of the edit that was sent waits no more (an edit made while it
 * was on its way still does), and Zoho's last number moves by it; the total does not move (it held the edit already).
 * Not taken: the edit keeps waiting.
 */
CREATE OR REPLACE FUNCTION public.preorder_push_finish(_branch_id text, _product_id text, _ok boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  left_over numeric;
BEGIN
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF NOT FOUND OR w.push_started_at IS NULL THEN RETURN jsonb_build_object('skipped', 'not_pushing'); END IF;
  IF NOT COALESCE(_ok, false) THEN
    UPDATE public.preorder_watch SET push_pending = NULL, push_delta = NULL, push_started_at = NULL
     WHERE branch_id = _branch_id AND product_id = _product_id;
    RETURN jsonb_build_object('pending', w.pending_delta, 'sent', 0);
  END IF;
  left_over := w.pending_delta - COALESCE(w.push_pending, 0);
  UPDATE public.preorder_watch SET pending_delta = left_over, zoho_last = zoho_last + COALESCE(push_delta, 0),
      push_pending = NULL, push_delta = NULL, push_started_at = NULL, updated_at = now()
   WHERE branch_id = _branch_id AND product_id = _product_id;
  UPDATE public.branch_stock SET zoho_pending = (left_over <> 0) WHERE branch_id = _branch_id AND product_id = _product_id;
  RETURN jsonb_build_object('pending', left_over, 'sent', COALESCE(w.push_delta, 0));
END $function$;
REVOKE ALL ON FUNCTION public.preorder_push_finish(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preorder_push_finish(text, text, boolean) TO service_role;

/*
 * 5.4.8 An administrator says what held units are (other stock, not a pre-order's bill): they become stock. The server
 * ran the bill check and passes only the bills the admin ticked as regular stock.
 */
CREATE OR REPLACE FUNCTION public.release_preorder_hold(_branch_id text, _product_id text, _qty numeric, _note text, _regular_bills jsonb,
  _reading numeric, _snapshot uuid[], _read_at timestamptz, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  w public.preorder_watch%ROWTYPE;
  q numeric := round(COALESCE(_qty, 0), 3);
  held_after_step numeric;
  res jsonb;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can release held stock'; END IF;
  IF length(btrim(COALESCE(_note, ''))) < 10 THEN RAISE EXCEPTION 'Say what this stock is (at least 10 letters)'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  SELECT * INTO w FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only 0 is held at %', private.godown_name(_branch_id); END IF;
  IF _reading IS NULL OR _read_at IS NULL OR _read_at <= now() - interval '10 minutes' THEN RAISE EXCEPTION 'Zoho''s stock reading is too old; try again'; END IF;
  IF private.push_in_flight(_branch_id, _product_id) THEN
    RAISE EXCEPTION 'A stock edit for % at % is being sent to Zoho right now. Try again in a minute.',
      private.product_name(_product_id), private.godown_name(_branch_id);
  END IF;
  IF private.transfer_unfinished(_product_id, _branch_id) THEN
    RAISE EXCEPTION 'A transfer of % between godowns is not finished. Finish or cancel it first.', private.product_name(_product_id);
  END IF;
  held_after_step := GREATEST(0, w.held + GREATEST(0, private.reading_rise(_branch_id, _product_id, _reading, _snapshot)));
  IF q <= 0 OR q > held_after_step THEN RAISE EXCEPTION 'Only % is held at %', private.qty_text(held_after_step), private.godown_name(_branch_id); END IF;
  res := private.apply_reading(_branch_id, _product_id, _reading, _read_at, _snapshot, q);
  PERFORM private.lot_event(NULL, _branch_id, _product_id, 'hold_released', q,
    jsonb_build_object('regular_bills', COALESCE(_regular_bills, '[]'::jsonb), 'zoho', _reading, 'result', res), btrim(_note), _by, _by_name);
  RETURN res;
END $function$;
REVOKE ALL ON FUNCTION public.release_preorder_hold(text, text, numeric, text, jsonb, numeric, uuid[], timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_preorder_hold(text, text, numeric, text, jsonb, numeric, uuid[], timestamptz, uuid, text) TO service_role;

/*
 * 5.4.9 Undo a match within 7 days while nothing has moved since (no new orders on it, no confirmed or invoiced sales
 * order, no delivery note, no hand-over, no count, no send, no bill flag). The bill's bags are held again.
 */
CREATE OR REPLACE FUNCTION public.unmatch_incoming_batch(_batch_id uuid, _note text, _readings jsonb, _snapshot jsonb, _read_at timestamptz,
  _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  r public.batches%ROWTYPE;
  pid text;
  ev public.batch_lot_events%ROWTYPE;
  bef jsonb;
  why text;
  qb numeric;
  q numeric;
  al record;
  net_now numeric;
  g record;
  z numeric;
  res jsonb;
  readings_out jsonb := '{}'::jsonb;
  reopened boolean := false;
  u_before numeric;
  pending_at text;
  cd record;
  cd_before jsonb;
  untagged numeric := 0;
  prev_write text;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can undo a match'; END IF;
  SELECT product_id INTO pid FROM public.batches WHERE id = _batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = pid FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  SELECT * INTO ev FROM public.batch_lot_events WHERE batch_id = b.id AND kind = 'matched' ORDER BY id DESC LIMIT 1;
  bef := ev.detail->'before';
  -- The remainder this match made, if any.
  IF COALESCE(ev.detail->'remainder'->>'id', '') <> '' THEN
    SELECT * INTO r FROM public.batches WHERE id = (ev.detail->'remainder'->>'id')::uuid FOR UPDATE;
  END IF;
  IF b.expected_quantity IS NULL OR b.stage <> 'received' OR b.matched_at IS NULL OR bef IS NULL THEN why := 'it is not a matched pre-order batch';
  ELSIF b.matched_at <= now() - interval '7 days' THEN why := 'matched more than 7 days ago';
  ELSIF EXISTS (SELECT 1 FROM public.order_item_batch_allocations a WHERE a.batch_id IN (b.id, r.id)
                 AND a.created_at > b.matched_at AND a.moved_from_allocation_id IS NULL)
        -- (and by the ledger, whatever the clock says: more sold from either than the match left there)
        OR b.quantity - b.remaining_quantity > COALESCE((ev.detail->>'S')::numeric, 0) - COALESCE((ev.detail->>'move')::numeric, 0)
        OR (r.id IS NOT NULL AND r.quantity - r.remaining_quantity > COALESCE((ev.detail->>'move')::numeric, 0)) THEN why := 'new orders took from it';
  ELSIF EXISTS (SELECT 1 FROM public.order_item_batch_allocations a JOIN public.order_items oi ON oi.id = a.order_item_id
                  JOIN public.orders o ON o.id = oi.order_id
                 WHERE a.batch_id IN (b.id, r.id)
                   AND (lower(COALESCE(o.zoho_order_status, '')) NOT IN ('', 'draft')
                     OR EXISTS (SELECT 1 FROM public.zoho_order_invoices z WHERE z.order_id = o.id AND COALESCE(z.status, 'none') NOT IN ('none', 'void', 'deleted'))
                     OR EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.order_id = o.id))) THEN
    why := 'an order on it went on to Zoho or got a delivery note';
  ELSIF EXISTS (SELECT 1 FROM public.batch_adjustments x WHERE x.batch_id = b.id) OR COALESCE(b.sent_quantity, 0) <> 0
        OR EXISTS (SELECT 1 FROM public.batches c WHERE c.parent_batch_id = b.id) THEN why := 'it was counted or sent on';
  ELSIF b.transfer_id IS NOT NULL THEN why := 'it was received through a transfer';
  ELSIF b.bill_flag <> '' THEN why := 'its bill is flagged';
  ELSIF r.id IS NOT NULL AND (r.stage <> 'incoming' OR r.paused_reason = 'receiving') THEN why := 'its remainder has moved on';
  END IF;
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'Batch % has moved on since its match (%), so it can''t be undone. Correct it with the bill flags instead.', b.batch_code, why;
  END IF;
  -- Added 14 Nov 2026 (review): an order on it whose push to Zoho is running (or got no clear answer in the last 10
  -- minutes) may be confirmed or invoiced in Zoho any moment: its goods can't become "not arrived" again now.
  PERFORM 1 FROM public.orders o WHERE o.id IN (SELECT oi.order_id FROM public.order_item_batch_allocations a
      JOIN public.order_items oi ON oi.id = a.order_item_id WHERE a.batch_id IN (b.id, r.id)) ORDER BY o.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.order_item_batch_allocations a JOIN public.order_items oi ON oi.id = a.order_item_id
               JOIN public.zoho_order_push_claims c ON c.order_id = oi.order_id
              WHERE a.batch_id IN (b.id, r.id)
                AND ((c.locked_until IS NOT NULL AND c.locked_until > now()) OR c.write_unanswered_at > now() - interval '10 minutes'))
     OR EXISTS (SELECT 1 FROM public.order_item_batch_allocations a JOIN public.order_items oi ON oi.id = a.order_item_id
               JOIN public.zoho_sync_outbox q ON q.entity_type = 'order' AND q.entity_id = oi.order_id::text AND q.status = 'processing'
              WHERE a.batch_id IN (b.id, r.id)) THEN
    RAISE EXCEPTION 'Batch % has moved on since its match (an order on it is being sent to Zoho), so it can''t be undone now. Try again in a few minutes.', b.batch_code;
  END IF;
  -- Added 14 Nov 2026 (review): a website stock edit of this product still waiting for Zoho first (as for a new lot), so
  -- the watch this may reopen starts with nothing pending.
  SELECT branch_id INTO pending_at FROM public.branch_stock WHERE product_id = b.product_id AND zoho_pending ORDER BY branch_id LIMIT 1;
  IF pending_at IS NOT NULL THEN
    RAISE EXCEPTION 'A stock edit for % at % is waiting to go to Zoho. Press Sync godowns now first.', b.product_name, private.godown_name(pending_at);
  END IF;
  IF private.transfer_unfinished(b.product_id, NULL) THEN
    RAISE EXCEPTION 'A transfer of % between godowns is not finished. Finish or cancel it first.', b.product_name;
  END IF;
  IF length(btrim(COALESCE(_note, ''))) < 4 THEN RAISE EXCEPTION 'Say why the match is undone'; END IF;
  IF _read_at IS NULL OR _read_at <= now() - interval '10 minutes' OR EXISTS (
       SELECT 1 FROM public.branches x WHERE x.active AND x.vendor_id IS NULL AND COALESCE(x.zoho_location_id, '') <> ''
          AND private.reading_for(_readings, x.id, b.product_id) IS NULL) THEN
    RAISE EXCEPTION 'Zoho''s stock reading is too old; try again';
  END IF;
  qb := b.quantity;
  q := COALESCE((ev.detail->>'Q')::numeric, (bef->>'quantity')::numeric);
  prev_write := private.preorder_write_begin();

  SELECT u INTO u_before FROM private.pair_lots(b.branch_id, b.product_id);
  -- 1.-2. Moved orders come back; the remainder goes, its expenses come back.
  IF r.id IS NOT NULL THEN
    FOR al IN SELECT * FROM public.order_item_batch_allocations WHERE batch_id = r.id AND moved_from_allocation_id IS NOT NULL ORDER BY id FOR UPDATE LOOP
      IF al.moved_from_allocation_id = al.id THEN
        UPDATE public.order_item_batch_allocations SET batch_id = b.id, moved_from_allocation_id = NULL WHERE id = al.id;
      ELSE
        UPDATE public.order_item_batch_allocations SET reserved_quantity = reserved_quantity + (al.reserved_quantity - al.released_quantity)
          WHERE id = al.moved_from_allocation_id;
        IF al.released_quantity = 0 THEN
          DELETE FROM public.order_item_batch_allocations WHERE id = al.id;
        ELSE
          UPDATE public.order_item_batch_allocations SET reserved_quantity = released_quantity WHERE id = al.id;
        END IF;
      END IF;
    END LOOP;
    PERFORM private.merge_lot_tags(r.id, b.id, 'join', _by, _by_name);
    UPDATE public.batches SET stage = 'cancelled', quantity = 0, remaining_quantity = 0, hold_back = 0, selling_paused = false,
        paused_reason = '', closed_at = now(), closed_note = left(format('Match of %s undone: %s', b.batch_code, btrim(_note)), 300)
      WHERE id = r.id;
  END IF;

  -- Added 14 Nov 2026 (review): the charges of the bill being undone (freight, discount, round-off: tagged with it at
  -- Receive purchase) are that bill's, not the lot's: they come off it (they go to the batch the bill really becomes).
  FOR cd IN SELECT DISTINCT d.id, d.doc_number, d.zoho_id FROM public.zoho_cost_documents d JOIN public.batch_cost_tags t ON t.document_id = d.id
              WHERE t.batch_id = b.id AND d.source = 'bill' AND d.zoho_id = b.zoho_bill_id AND b.zoho_bill_id <> '' ORDER BY d.id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || cd.id));
    PERFORM 1 FROM public.zoho_cost_documents WHERE id = cd.id FOR UPDATE;
    cd_before := private.cost_tags_json(cd.id);
    untagged := untagged + COALESCE((SELECT sum(amount) FROM public.batch_cost_tags WHERE document_id = cd.id AND batch_id = b.id), 0);
    DELETE FROM public.batch_cost_tags WHERE document_id = cd.id AND batch_id = b.id;
    IF NOT EXISTS (SELECT 1 FROM public.batch_cost_tags WHERE document_id = cd.id) THEN
      UPDATE public.zoho_cost_documents SET accepted_cost_amount = NULL, flag = '', flag_at = NULL WHERE id = cd.id;
    END IF;
    INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
      VALUES (cd.id, 'untag', cd_before, private.cost_tags_json(cd.id), _by, left(COALESCE(_by_name, ''), 120));
  END LOOP;

  -- 3.-4. The lot again, as it was before the match.
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0) INTO net_now FROM public.order_item_batch_allocations WHERE batch_id = b.id;
  UPDATE public.batches SET
      stage = 'incoming', quantity = q, remaining_quantity = q - net_now,
      hold_back = LEAST(COALESCE((bef->>'hold_back')::numeric, 0), q), selling_paused = false, paused_reason = '',
      zoho_bill_id = '', zoho_bill_line_id = '', zoho_bill_number = '', zoho_bill_modified = '', zoho_bill_total = NULL,
      bill_flag = '', bill_flag_at = NULL, bill_checked_at = NULL,
      unit_cost = est_unit_cost_ex_gst, unit_cost_ex_gst = est_unit_cost_ex_gst, unit_cost_inc_gst = est_unit_cost_inc_gst, cost_basis = 'ex_gst',
      purchase_date = COALESCE(NULLIF(bef->>'purchase_date', '')::date, (created_at AT TIME ZONE 'Asia/Kolkata')::date),
      supplier = COALESCE(bef->>'supplier', supplier), purchase_ref = COALESCE(bef->>'purchase_ref', purchase_ref),
      notes = COALESCE(bef->>'notes', notes), mfg_date = NULLIF(bef->>'mfg_date', '')::date, expiry_date = NULLIF(bef->>'expiry_date', '')::date,
      zoho_item_id = COALESCE(bef->>'zoho_item_id', zoho_item_id),
      matched_at = NULL, matched_by = NULL, matched_by_name = '', transfer_id = NULL
    WHERE id = b.id;
  UPDATE public.order_item_batch_allocations SET unit_cost = (SELECT est_unit_cost_ex_gst FROM public.batches WHERE id = b.id) WHERE batch_id = b.id;

  -- 5.-6. The watch (reopened if it closed), the bill's bags held again, and T from Zoho at every godown.
  IF NOT EXISTS (SELECT 1 FROM public.preorder_watch WHERE product_id = b.product_id) THEN
    reopened := true;
    FOR g IN SELECT x.id FROM public.branches x WHERE x.active AND x.vendor_id IS NULL AND COALESCE(x.zoho_location_id, '') <> '' ORDER BY x.id LOOP
      INSERT INTO public.preorder_watch (branch_id, product_id, zoho_last, held, opened_at, read_at, updated_at)
        VALUES (g.id, b.product_id, private.reading_for(_readings, g.id, b.product_id), 0, b.created_at, _read_at, now());
    END LOOP;
  END IF;
  UPDATE public.preorder_watch SET held = held + qb, held_since = COALESCE(held_since, now())
    WHERE branch_id = b.branch_id AND product_id = b.product_id;
  -- The website-side change at the godown: the lot units are to come again, and the bill's bags (held again) are no
  -- longer stock.
  PERFORM private.shift_pair_total(b.branch_id, b.product_id, (SELECT u FROM private.pair_lots(b.branch_id, b.product_id)) - u_before - qb);
  FOR g IN SELECT w.branch_id FROM public.preorder_watch w WHERE w.product_id = b.product_id ORDER BY w.branch_id LOOP
    z := private.reading_for(_readings, g.branch_id, b.product_id);
    CONTINUE WHEN z IS NULL;
    res := private.apply_reading(g.branch_id, b.product_id, z, _read_at, private.snapshot_for(_snapshot, g.branch_id, b.product_id), 0);
    readings_out := readings_out || jsonb_build_object(g.branch_id, res);
  END LOOP;
  PERFORM private.lot_event(b.id, b.branch_id, b.product_id, 'unmatched', qb,
    jsonb_build_object('bill_number', ev.detail->'bill'->>'bill_number', 'quantity', q, 'remainder', r.batch_code, 'reopened', reopened,
      'readings', readings_out, 'charges_untagged', untagged), _note, _by, _by_name);
  PERFORM private.preorder_write_end(prev_write, ARRAY[b.product_id]);
  RETURN jsonb_build_object('batch_id', b.id, 'batch_code', b.batch_code, 'quantity', q, 'held_again', qb,
    'remainder_cancelled', r.batch_code, 'readings', readings_out, 'charges_untagged', untagged);
END $function$;
REVOKE ALL ON FUNCTION public.unmatch_incoming_batch(uuid, text, jsonb, jsonb, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unmatch_incoming_batch(uuid, text, jsonb, jsonb, timestamptz, uuid, text) TO service_role;

/*
 * 5.4.11 Receive purchase at the bill's own godown (server only). Each line: action 'new' (a batch, as
 * create_batches_from_bill makes it; not_preorder_note when the product has a lot here) or 'match' (match_batch_id, rest
 * 'coming' | 'none', rest_expected). Then Zoho's readings: at this godown the units the bill explains, elsewhere none.
 *   _readings = [{branch_id, product_id, zoho}]; _snapshot = {"BR|P": [order_item_id ...]}
 */
CREATE OR REPLACE FUNCTION public.receive_bill_lines(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _readings jsonb,
  _snapshot jsonb, _read_at timestamptz, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  g public.branches%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  line jsonb;
  new_lines jsonb := '[]'::jsonb;
  made jsonb := '[]'::jsonb;
  matched jsonb := '[]'::jsonb;
  res jsonb;
  products text[];
  watched text[];
  p text;
  w record;
  explained numeric;
  z numeric;
  readings_out jsonb := '{}'::jsonb;
  closed jsonb := '[]'::jsonb;
  opened timestamptz;
  prev_write text;
  moving text;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to make batches from'; END IF;
  IF bill_id = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  SELECT * INTO g FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT g.active OR g.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  products := ARRAY(SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(_lines) l WHERE COALESCE(l->>'product_id', '') <> '');
  PERFORM private.lock_products(products);
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));
  SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Bill % is being moved to % in Zoho (transfer %). Press Retry or Cancel on it under Transfers waiting for Zoho first.',
      COALESCE(_bill->>'bill_number', ''), COALESCE((SELECT name FROM public.branches WHERE id = t.to_branch_id), 'another godown'), t.transfer_no;
  END IF;
  watched := ARRAY(SELECT DISTINCT w2.product_id FROM public.preorder_watch w2 WHERE w2.product_id = ANY (products) ORDER BY 1);
  IF cardinality(watched) > 0 THEN
    IF _read_at IS NULL OR _read_at <= now() - interval '10 minutes'
       OR EXISTS (SELECT 1 FROM unnest(watched) x(pid) WHERE private.reading_for(_readings, _branch_id, x.pid) IS NULL) THEN
      RAISE EXCEPTION 'Zoho''s stock reading is too old; try again';
    END IF;
    -- Added 14 Nov 2026 (review): not while a transfer of one of them is unfinished (its readings would count it twice).
    SELECT x.pid INTO moving FROM unnest(watched) x(pid) WHERE private.transfer_unfinished(x.pid, NULL) ORDER BY 1 LIMIT 1;
    IF moving IS NOT NULL THEN
      RAISE EXCEPTION 'A transfer of % between godowns is not finished. Finish or cancel it first.', private.product_name(moving);
    END IF;
  END IF;
  prev_write := private.preorder_write_begin();

  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    IF lower(COALESCE(line->>'action', 'new')) = 'match' OR COALESCE(line->>'match_batch_id', '') <> '' THEN
      IF COALESCE(line->>'match_batch_id', '') = '' THEN RAISE EXCEPTION 'Choose the pre-order batch for this bill line'; END IF;
      res := private.match_incoming_line(_branch_id, (line->>'match_batch_id')::uuid, _bill, line, line->>'rest',
        NULLIF(line->>'rest_expected', '')::date, NULL, _by, _by_name);
      matched := matched || jsonb_build_array(res || jsonb_build_object('product_id', line->>'product_id'));
    ELSE
      new_lines := new_lines || jsonb_build_array(line);
    END IF;
  END LOOP;
  IF jsonb_array_length(new_lines) > 0 THEN
    made := public.create_batches_from_bill(_branch_id, _bill, new_lines, _cost_basis, _by, _by_name);
  END IF;

  -- Zoho's readings for every watched product: at this godown the units this bill explains, at the others none.
  FOREACH p IN ARRAY watched LOOP
    SELECT opened_at INTO opened FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = p;
    explained := COALESCE((SELECT sum((m->>'explain')::numeric) FROM jsonb_array_elements(matched) m WHERE m->>'product_id' = p), 0)
      + CASE WHEN private.bill_after(_bill, opened)
          THEN COALESCE((SELECT sum(round((l->>'qty')::numeric, 2)) FROM jsonb_array_elements(new_lines) l WHERE l->>'product_id' = p), 0) ELSE 0 END;
    FOR w IN SELECT w2.branch_id FROM public.preorder_watch w2 WHERE w2.product_id = p ORDER BY w2.branch_id LOOP
      z := private.reading_for(_readings, w.branch_id, p);
      CONTINUE WHEN z IS NULL;
      res := private.apply_reading(w.branch_id, p, z, _read_at, private.snapshot_for(_snapshot, w.branch_id, p),
        CASE WHEN w.branch_id = _branch_id THEN explained ELSE 0 END);
      readings_out := readings_out || jsonb_build_object(w.branch_id || '|' || p, res);
    END LOOP;
    IF private.watch_close_if_done(p, _readings, _snapshot, _read_at) THEN closed := closed || to_jsonb(p); END IF;
  END LOOP;
  PERFORM private.preorder_write_end(prev_write, products);
  RETURN jsonb_build_object('made', made, 'matched', matched, 'readings', readings_out, 'watch_closed', closed);
END $function$;
REVOKE ALL ON FUNCTION public.receive_bill_lines(text, jsonb, jsonb, text, jsonb, jsonb, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_bill_lines(text, jsonb, jsonb, text, jsonb, jsonb, timestamptz, uuid, text) TO service_role;

-- ---------------------------------------------------------------- 5.4.13 read RPCs and housekeeping
/** The server's snapshot of waiting order lines, taken before it reads Zoho (spec 2.5). */
CREATE OR REPLACE FUNCTION public.preorder_waiting_items(_product_ids text[])
RETURNS TABLE (branch_id text, product_id text, order_item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT x.bid, x.pid, w.item_id
    FROM (SELECT b.id AS bid, p.pid FROM public.branches b, unnest(COALESCE(_product_ids, '{}'::text[])) p(pid)) x,
         LATERAL private.waiting_lines(x.bid, x.pid, NULL) w
$function$;
REVOKE ALL ON FUNCTION public.preorder_waiting_items(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preorder_waiting_items(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.order_waiting_goods(_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT private.order_waiting_goods(_order_id)
$function$;
REVOKE ALL ON FUNCTION public.order_waiting_goods(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_waiting_goods(uuid) TO service_role;

/** An order's pre-ordered lines for whoever may read the order: waiting, expected and arrived dates. No codes or costs. */
CREATE OR REPLACE FUNCTION public.order_item_arrivals(_order_id uuid)
RETURNS TABLE (order_item_id uuid, preorder_qty numeric, waiting numeric, expected_date date, arrived_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT oi.id, oi.preorder_qty,
    COALESCE(sum(a.reserved_quantity - a.released_quantity) FILTER (WHERE b.stage = 'incoming'), 0),
    COALESCE(max(b.expected_date) FILTER (WHERE b.stage = 'incoming'), max(b.expected_date) FILTER (WHERE b.expected_quantity IS NOT NULL), oi.preorder_by),
    CASE WHEN COALESCE(sum(a.reserved_quantity - a.released_quantity) FILTER (WHERE b.stage = 'incoming'), 0) = 0
      THEN (max(b.matched_at) FILTER (WHERE b.stage = 'received' AND b.expected_quantity IS NOT NULL) AT TIME ZONE 'Asia/Kolkata')::date END
  FROM public.order_items oi
  LEFT JOIN public.order_item_batch_allocations a ON a.order_item_id = oi.id AND a.reserved_quantity > a.released_quantity
  LEFT JOIN public.batches b ON b.id = a.batch_id
  WHERE oi.order_id = _order_id AND public.can_read_order(_order_id)
    AND (public.has_role(auth.uid(), 'admin') OR NOT public.has_role(auth.uid(), 'vendor') OR oi.vendor_id = public.current_vendor_id())
  GROUP BY oi.id, oi.preorder_qty, oi.preorder_by
  HAVING oi.preorder_qty > 0 OR COALESCE(sum(a.reserved_quantity - a.released_quantity) FILTER (WHERE b.stage = 'incoming'), 0) > 0
$function$;
REVOKE ALL ON FUNCTION public.order_item_arrivals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_item_arrivals(uuid) TO authenticated;

/**
 * Added 14 Nov 2026 (review): the channel partner's orders (as partner_orders_to_confirm lists them) that wait for goods
 * still on a pre-order: their invoice and pickup QR come when the goods arrive. No codes or costs.
 */
CREATE OR REPLACE FUNCTION public.partner_orders_waiting_goods()
RETURNS TABLE (order_no text, waiting numeric, expected_date date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners p WHERE p.user_id = auth.uid() AND p.status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can see these orders'; END IF;
  RETURN QUERY
  SELECT o.order_no, (g->>'waiting')::numeric, NULLIF(g->>'expected_date', '')::date
    FROM public.orders o
    CROSS JOIN LATERAL private.order_waiting_goods(o.id) g
   WHERE o.branch_id = me.branch_id AND o.order_status IN ('Placed', 'Payment Confirmed', 'Accepted')
     AND COALESCE((g->>'waiting')::numeric, 0) > 0
   ORDER BY o.created_at
   LIMIT 200;
END $function$;
REVOKE ALL ON FUNCTION public.partner_orders_waiting_goods() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_orders_waiting_goods() TO authenticated;

/** "Coming to your godown": its lots for its staff, its channel partner and admins. No costs, suppliers or bills. */
CREATE OR REPLACE FUNCTION public.godown_incoming_lots(_branch_id text)
RETURNS TABLE (product_id text, product_name text, expected numeric, sold numeric, waiting_orders integer, expected_date date, paused boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR private.batch_transfer_receiver(auth.uid(), _branch_id) IS NOT NULL) THEN
    RAISE EXCEPTION 'Only this godown''s staff, its channel partner or an administrator can see what is coming';
  END IF;
  RETURN QUERY
  SELECT b.product_id, b.product_name, b.quantity, b.quantity - b.remaining_quantity,
    (SELECT count(DISTINCT oi.order_id)::integer FROM public.order_item_batch_allocations a
       JOIN public.order_items oi ON oi.id = a.order_item_id
      WHERE a.batch_id = b.id AND a.reserved_quantity > a.released_quantity),
    b.expected_date, b.selling_paused
  FROM public.batches b
  WHERE b.branch_id = _branch_id AND b.stage = 'incoming'
  ORDER BY b.expected_date, b.created_at;
END $function$;
REVOKE ALL ON FUNCTION public.godown_incoming_lots(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.godown_incoming_lots(text) TO authenticated;

/** Every 15 minutes (cron): ready vs arriving again for every pair with lots (dates roll over at IST midnight), and one
 * alert per overdue lot. Returns how many pairs it refreshed. */
CREATE OR REPLACE FUNCTION public.refresh_incoming_all()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  pr record;
  lot public.batches%ROWTYPE;
  n integer := 0;
  waiting_orders integer;
BEGIN
  FOR pr IN SELECT DISTINCT b.product_id, b.branch_id FROM public.batches b WHERE b.stage = 'incoming' ORDER BY 1, 2 LOOP
    PERFORM 1 FROM public.catalog_products WHERE id = pr.product_id FOR UPDATE;
    PERFORM private.refresh_pair(pr.branch_id, pr.product_id);
    n := n + 1;
  END LOOP;
  FOR lot IN SELECT * FROM public.batches b WHERE b.stage = 'incoming' AND b.overdue_notified_at IS NULL
              AND b.expected_date + private.preorder_grace() < private.ist_today() ORDER BY b.id FOR UPDATE LOOP
    SELECT count(DISTINCT oi.order_id)::integer INTO waiting_orders FROM public.order_item_batch_allocations a
      JOIN public.order_items oi ON oi.id = a.order_item_id WHERE a.batch_id = lot.id AND a.reserved_quantity > a.released_quantity;
    PERFORM private.notify_admins('Pre-order batch overdue',
      format('Pre-order batch %s was expected by %s and has no bill. New pre-orders stopped; %s orders wait.',
        lot.batch_code, to_char(lot.expected_date, 'DD Mon YYYY'), waiting_orders));
    UPDATE public.batches SET overdue_notified_at = now() WHERE id = lot.id;
    PERFORM private.lot_event(lot.id, lot.branch_id, lot.product_id, 'overdue', lot.quantity - lot.remaining_quantity,
      jsonb_build_object('expected_date', lot.expected_date, 'waiting_orders', waiting_orders), '');
  END LOOP;
  RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.refresh_incoming_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_incoming_all() TO service_role;

/** Admin › Settings › Pre-orders. Switching off with lots open is refused. */
CREATE OR REPLACE FUNCTION public.admin_set_preorder_settings(_enabled boolean, _grace_days integer, _require_ack boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  open_lots integer;
  v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can change pre-order settings'; END IF;
  IF _enabled IS NULL OR _require_ack IS NULL THEN RAISE EXCEPTION 'Choose every pre-order setting'; END IF;
  IF _grace_days IS NULL OR _grace_days < 0 OR _grace_days > 14 THEN RAISE EXCEPTION 'Grace days must be between 0 and 14'; END IF;
  SELECT count(*) INTO open_lots FROM public.batches WHERE stage = 'incoming';
  IF NOT _enabled AND open_lots > 0 THEN RAISE EXCEPTION 'Close, match or cancel the % pre-order batches first', open_lots; END IF;
  v := jsonb_build_object('enabled', _enabled, 'graceDays', _grace_days, 'requireAck', _require_ack);
  INSERT INTO public.settings (key, value, is_public, updated_at) VALUES ('preorder', v, true, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_public = true, updated_at = now();
  PERFORM public.refresh_incoming_all();
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.admin_set_preorder_settings(boolean, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_preorder_settings(boolean, integer, boolean) TO authenticated;

/** The admin alert when Zoho moves an order holding lot units on (Zoho is the record, so it is allowed). */
CREATE OR REPLACE FUNCTION private.preorder_zoho_moved_alert(_order_id uuid, _order_no text, _status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE wg jsonb := private.order_waiting_goods(_order_id);
BEGIN
  PERFORM private.notify_admins('Order moved on in Zoho before its goods arrived',
    format('Order %s was marked %s in Zoho before batch %s was matched.', _order_no, _status,
      COALESCE((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(wg->'codes') x), '?')), _order_no, _order_id);
END $function$;

-- ================================================================ changed existing functions (5.5)
-- route_stock_to_branch: live definition (20261024100000) + the pre-order branch.
CREATE OR REPLACE FUNCTION public.route_stock_to_branch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_total numeric := COALESCE((NEW.payload->>'stock')::numeric, 0);
  old_total numeric := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE((OLD.payload->>'stock')::numeric, 0) END;
  target text;
  branch_sum numeric;
BEGIN
  IF NEW.vendor_id LIKE 'zoho:%' OR current_setting('app.branch_stock_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND new_total = old_total THEN RETURN NEW; END IF;
  -- The order's / receipt's branch, else the vendor's fulfilment point, else the default godown.
  target := COALESCE(NULLIF(current_setting('app.branch_id', true), ''),
                     public.vendor_fulfilment_branch(NEW.vendor_id),
                     public.default_branch_id());
  IF target IS NULL THEN RETURN NEW; END IF;
  -- Changed 14 Nov 2026: a godown with a pre-order batch (or watched for one) moves its total, unfloored; the trigger on
  -- branch_stock works out ready and arriving from it. Anywhere else, exactly as before.
  IF EXISTS (SELECT 1 FROM public.batches b WHERE b.product_id = NEW.id AND b.branch_id = target AND b.stage = 'incoming')
     OR EXISTS (SELECT 1 FROM public.preorder_watch w WHERE w.product_id = NEW.id AND w.branch_id = target) THEN
    -- Review fix: a manual stock change (a receipt typed on the website) is never a rise where a lot is on its way, and a
    -- watched godown remembers it until it is in Zoho, as admin_set_branch_stock does.
    IF COALESCE(current_setting('app.stock_manual', true), '') = 'on' THEN
      IF new_total > old_total AND EXISTS (SELECT 1 FROM public.batches b WHERE b.product_id = NEW.id AND b.branch_id = target AND b.stage = 'incoming') THEN
        RAISE EXCEPTION 'Pre-order batch % is on its way to %. Its bags come into stock with its Zoho bill, so don''t type them in. You can still lower this stock.',
          (SELECT b.batch_code FROM public.batches b WHERE b.product_id = NEW.id AND b.branch_id = target AND b.stage = 'incoming'
            ORDER BY b.expected_date, b.created_at LIMIT 1), private.godown_name(target);
      END IF;
      UPDATE public.preorder_watch SET pending_delta = pending_delta + (new_total - old_total)
       WHERE product_id = NEW.id AND branch_id = target;
    END IF;
    INSERT INTO public.branch_stock (branch_id, product_id, stock, free_total, zoho_pending)
      VALUES (target, NEW.id, 0, new_total - old_total, COALESCE(current_setting('app.stock_manual', true), '') = 'on')
    ON CONFLICT (branch_id, product_id) DO UPDATE
      SET free_total = public.branch_stock.free_total + (new_total - old_total),
          zoho_pending = public.branch_stock.zoho_pending OR COALESCE(current_setting('app.stock_manual', true), '') = 'on',
          updated_at = now();
  ELSE
  -- A manual stock edit (receipt, stock count) waits to go to the godown's Zoho location;
  -- order stock changes reach Zoho as sales orders instead.
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending)
    VALUES (target, NEW.id, GREATEST(0, new_total - old_total), COALESCE(current_setting('app.stock_manual', true), '') = 'on')
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET stock = GREATEST(0, public.branch_stock.stock + (new_total - old_total)),
        zoho_pending = public.branch_stock.zoho_pending OR COALESCE(current_setting('app.stock_manual', true), '') = 'on',
        updated_at = now();
  END IF;
  SELECT COALESCE(SUM(stock), 0) INTO branch_sum FROM public.branch_stock WHERE product_id = NEW.id;
  IF branch_sum <> new_total THEN
    PERFORM set_config('app.branch_stock_sync', 'on', true);
    UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(branch_sum), true) WHERE id = NEW.id;
    PERFORM set_config('app.branch_stock_sync', 'off', true);
  END IF;
  RETURN NEW;
END $function$;

-- private.allocate_order_item_batches: live definition (20261031190000) + received batches only.
CREATE OR REPLACE FUNCTION private.allocate_order_item_batches(_order_item_id uuid, _product_id text, _branch_id text, _qty numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := COALESCE(_qty, 0);
  taken numeric(14,2);
  batch_row record;
BEGIN
  IF needed <= 0 OR _branch_id IS NULL OR _product_id IS NULL THEN RETURN 0; END IF;
  FOR batch_row IN
    SELECT id, remaining_quantity, unit_cost FROM public.batches
    -- Changed 14 Nov 2026: received batches only (a pre-order batch is taken by private.take_order_line).
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0 AND stage = 'received'
    ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
    FOR UPDATE
  LOOP
    EXIT WHEN needed <= 0;
    taken := LEAST(needed, batch_row.remaining_quantity);
    UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
    INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost)
      VALUES (_order_item_id, batch_row.id, taken, batch_row.unit_cost);
    needed := needed - taken;
  END LOOP;
  RETURN COALESCE(_qty, 0) - needed;
END $function$;
REVOKE ALL ON FUNCTION private.allocate_order_item_batches(uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;

-- place_marketplace_order: live definition (20261107160000) + ready and arriving at the gate, private.take_order_line.
CREATE OR REPLACE FUNCTION public.place_marketplace_order(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  line jsonb;
  item_product public.catalog_products%ROWTYPE;
  qty integer;
  subtotal numeric(14,2) := 0;
  gst_amount numeric(14,2) := 0;
  goods_total numeric(14,2) := 0;
  line_gross numeric(14,2);
  line_gst numeric(14,2);
  shipping_amount numeric(14,2) := 0;
  order_total numeric(14,2);
  product_price numeric(14,2);
  product_gst numeric(5,2);
  stock_now numeric(14,2);
  target_branch text;
  final_order_no text;
  branch_row public.branches%ROWTYPE;
  fulfilment text;
  routing_on boolean;
  vendor_points text[];
  items_json jsonb := '[]'::jsonb;
  created_order_id uuid;
  order_item_id uuid;
  batch_row record;
  qty_to_allocate numeric(14,2);
  batch_take numeric(14,2);
  available_batch_qty numeric(14,2);
  free_above numeric(14,2) := 10000;
  standard_shipping numeric(14,2) := 250;
  express_shipping numeric(14,2) := 650;
  profile_name text;
  profile_email text;
  profile_phone text;
  profile_gstin text;
  -- Added 14 Nov 2026: pre-orders.
  preorder_ok boolean := private.preorder_on();
  require_ack boolean := private.preorder_require_ack();
  ready_now numeric(14,2);
  requested_qty numeric(14,2);
  any_pre boolean := false;
  accept boolean;
  took jsonb;
  out_items jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR _target_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in is required to place an order';
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    IF NOT public.has_role(_target_user_id, 'customer') THEN
      RAISE EXCEPTION 'The selected account is not a customer';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'customer') OR _target_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Customers can place orders only for their own account';
  END IF;
  IF jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product to the order';
  END IF;
  IF _shipping_method NOT IN ('Pickup', 'Standard', 'Express') THEN
    RAISE EXCEPTION 'Invalid shipping method';
  END IF;
  IF _payment_method = 'Cash on Delivery' THEN
    RAISE EXCEPTION 'Cash on delivery is not enabled for this store';
  END IF;
  IF _shipping_address IS NULL OR jsonb_typeof(_shipping_address) <> 'object' THEN
    RAISE EXCEPTION 'A delivery address is required';
  END IF;
  IF COALESCE(_shipping_address->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT EXISTS (
      SELECT 1 FROM public.addresses
      WHERE id = (_shipping_address->>'id')::uuid AND user_id = _target_user_id
    ) THEN
    RAISE EXCEPTION 'Choose a saved address belonging to this customer account';
  END IF;
  SELECT full_name, email, phone, gstin
    INTO profile_name, profile_email, profile_phone, profile_gstin
    FROM public.profiles WHERE id = _target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The customer profile is incomplete'; END IF;

  SELECT COALESCE(MAX((value->>'free_above')::numeric), free_above),
         COALESCE(MAX((value->>'standard')::numeric), standard_shipping),
         COALESCE(MAX((value->>'express')::numeric), express_shipping)
    INTO free_above, standard_shipping, express_shipping
    FROM public.settings WHERE key = 'shipping' AND is_public;

  -- Branch: the godown serving the customer's PIN when branch routing is on, else the default.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  target_branch := public.default_branch_id();
  IF routing_on THEN
    target_branch := COALESCE((
      SELECT b.id FROM public.branches b
      WHERE b.active AND (_shipping_address->>'pin') = ANY (b.serves_pincodes)
      ORDER BY b.is_default DESC, b.sort_order LIMIT 1), target_branch);
  END IF;
  -- Marketplace ON: an order is fulfilled from its vendors' fulfilment point (a Grain Bazar godown
  -- the vendor stocks, or the vendor's own location). Items from different points are separate orders.
  IF private.marketplace_enabled() THEN
    SELECT array_agg(DISTINCT point) INTO vendor_points FROM (
      SELECT public.vendor_fulfilment_branch(cp.vendor_id) AS point
      FROM jsonb_array_elements(_items) AS item(value)
      JOIN public.catalog_products cp ON cp.id = item.value->>'product_id'
    ) points WHERE point IS NOT NULL;
    IF COALESCE(array_length(vendor_points, 1), 0) > 1 THEN
      RAISE EXCEPTION 'These items are collected from different locations; place them as separate orders';
    END IF;
    IF COALESCE(array_length(vendor_points, 1), 0) = 1 THEN target_branch := vendor_points[1]; END IF;
  END IF;
  IF target_branch IS NULL THEN RAISE EXCEPTION 'No active godown is set up'; END IF;
  -- The order number names its godown, the delivery PIN and the moment it was placed (IST),
  -- e.g. CLK-577522-261026-143215. _order_no from older app versions is no longer used.
  final_order_no := public.next_godown_order_no(target_branch, _shipping_address->>'pin');

  -- Added 14 Nov 2026 (review): every product of the cart locked first, in id order, as every pre-order path locks them
  -- (refresh_incoming_all, Receive purchase), so a checkout and those never wait on each other in a circle.
  PERFORM private.lock_products(ARRAY(SELECT DISTINCT value->>'product_id' FROM jsonb_array_elements(_items) WHERE value->>'product_id' IS NOT NULL));

  FOR line IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    qty := (line->>'qty')::integer;
    IF qty IS NULL OR qty < 1 THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
    SELECT * INTO item_product FROM public.catalog_products
      WHERE id = line->>'product_id' AND status = 'approved' AND active
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A product is unavailable'; END IF;
    -- With godown matching on, each godown sells the items of its Zoho price list at that list's
    -- price (a godown without a price list sells every item at the base price).
    product_price := CASE WHEN routing_on
      THEN public.branch_product_price(target_branch, item_product.id)
      ELSE COALESCE((item_product.payload->>'price')::numeric, 0) END;
    IF product_price IS NULL THEN
      RAISE EXCEPTION '% is not sold at your godown. Remove it from the cart to continue.', COALESCE(item_product.payload->>'name', 'An item');
    END IF;
    product_gst := COALESCE((item_product.payload->>'gst')::numeric, 0);
    -- Changed 14 Nov 2026: with pre-orders on, a godown sells its ready stock and then what is arriving.
    ready_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = target_branch AND product_id = item_product.id), 0)
      ELSE COALESCE((item_product.payload->>'stock')::numeric, 0) END;
    stock_now := ready_now + CASE WHEN routing_on AND preorder_ok
      THEN COALESCE((SELECT incoming FROM public.branch_stock WHERE branch_id = target_branch AND product_id = item_product.id), 0)
      ELSE 0 END;
    requested_qty := (
      SELECT SUM((requested->>'qty')::integer)
      FROM jsonb_array_elements(_items) AS requested(value)
      WHERE value->>'product_id' = line->>'product_id'
    );
    IF product_price <= 0 OR stock_now < requested_qty THEN
      RAISE EXCEPTION 'A product does not have enough available stock';
    END IF;
    IF routing_on AND preorder_ok AND requested_qty > floor(GREATEST(ready_now, 0)) THEN any_pre := true; END IF;
    accept := lower(COALESCE(line->>'accept_preorder', '')) = 'true';
    -- Changed 7 Nov 2026: the price includes GST. The line's GST is inside it; line_total is the taxable value.
    line_gross := round(product_price * qty, 2);
    line_gst := CASE WHEN product_gst > 0 THEN round(line_gross * product_gst / (100 + product_gst), 2) ELSE 0 END;
    goods_total := goods_total + line_gross;
    subtotal := subtotal + (line_gross - line_gst);
    gst_amount := gst_amount + line_gst;
    items_json := items_json || jsonb_build_array(jsonb_build_object(
      'product_id', item_product.id,
      'product_name', item_product.payload->>'name',
      'sku', item_product.payload->>'sku',
      'vendor', item_product.payload->>'vendor',
      'vendor_id', item_product.vendor_id,
      'capacity', COALESCE(item_product.payload->>'weight', ''),
      'qty', qty,
      'unit_price', product_price,
      'gst_rate', product_gst,
      'line_total', line_gross - line_gst,
      'accept_preorder', accept
    ));
  END LOOP;

  -- Pickup or home delivery, as the order's godown offers. Pickup is free; delivery uses the
  -- godown's charge (free above its threshold). A delivery request where the godown only offers
  -- pickup becomes a pickup (older app versions always sent 'Standard').
  SELECT * INTO branch_row FROM public.branches WHERE id = target_branch;
  fulfilment := CASE WHEN _shipping_method = 'Pickup' THEN 'Pickup' ELSE 'Standard' END;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled AND branch_row.pickup_enabled THEN
    fulfilment := 'Pickup';
  END IF;
  IF fulfilment = 'Pickup' AND NOT branch_row.pickup_enabled THEN
    RAISE EXCEPTION 'This godown does not offer pickup; choose home delivery';
  END IF;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled THEN
    RAISE EXCEPTION 'Home delivery is not available for this address yet';
  END IF;
  -- Changed 7 Nov 2026: free delivery goes by the goods total the customer sees (GST included).
  IF fulfilment = 'Standard' AND (branch_row.free_delivery_above IS NULL OR goods_total < branch_row.free_delivery_above) THEN
    shipping_amount := branch_row.delivery_fee;
  END IF;
  order_total := goods_total + shipping_amount;

  INSERT INTO public.orders (
    order_no, user_id, customer_name, customer_email, customer_phone, customer_gstin,
    vendor_ids, subtotal, discount, gst_amount, shipping, total, advance_due,
    balance_due, paid_amount, payment_method, payment_status, order_status,
    shipping_method, shipping_address, branch_id, prices_include_gst, preorder_ack_at
  ) VALUES (
    final_order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
    profile_phone, profile_gstin,
    ARRAY(SELECT DISTINCT value->>'vendor_id' FROM jsonb_array_elements(items_json)),
    subtotal, 0, gst_amount, shipping_amount, order_total, 0, order_total, 0,
    _payment_method, 'Pending', 'Placed', fulfilment, _shipping_address, target_branch, true,
    CASE WHEN any_pre THEN now() END
  ) RETURNING id INTO created_order_id;
  -- Stock leaves this order's godown.
  PERFORM set_config('app.branch_id', target_branch, true);

  FOR line IN SELECT value FROM jsonb_array_elements(items_json)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_id, product_name, sku, vendor, vendor_id, qty,
      unit_price, gst_rate, line_total, capacity
    ) VALUES (
      created_order_id, line->>'product_id', line->>'product_name', line->>'sku',
      line->>'vendor', line->>'vendor_id', (line->>'qty')::integer,
      (line->>'unit_price')::numeric, (line->>'gst_rate')::numeric,
      (line->>'line_total')::numeric, COALESCE(line->>'capacity', '')
    ) RETURNING id INTO order_item_id;

    -- Changed 14 Nov 2026: private.take_order_line lowers the stock and takes the batches: ready units first (the oldest
    -- purchase at this order's godown first, FIFO), then arriving units of the godown's pre-order batches, which the
    -- customer agreed to (accept_preorder) unless the tick is not required.
    took := private.take_order_line(order_item_id, line->>'product_id', target_branch, (line->>'qty')::numeric, routing_on,
      CASE WHEN (line->>'accept_preorder')::boolean OR NOT require_ack THEN (line->>'qty')::numeric ELSE 0 END, 'checkout');
    out_items := out_items || jsonb_build_array(line || jsonb_build_object('ready_qty', took->'ready', 'preorder_qty', took->'preorder',
      'preorder_by', took->'by'));
  END LOOP;

  RETURN jsonb_build_object(
    'order_no', final_order_no, 'subtotal', subtotal, 'discount', 0,
    'gst_amount', gst_amount, 'shipping', shipping_amount,
    'total', order_total, 'goods_total', goods_total, 'prices_include_gst', true, 'items', out_items
  );
END;
$function$;

-- admin_update_order_item: live definition (20261107160000) + the order's godown ready stock and private.take_order_line.
CREATE OR REPLACE FUNCTION public.admin_update_order_item(_order_no text, _order_item_id uuid, _qty integer, _capacity text, _unit_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_order public.orders%ROWTYPE;
  target_item public.order_items%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  batch_row record;
  allocation_row record;
  delta integer;
  needed numeric(14,2);
  taken numeric(14,2);
  stock_now numeric(14,2);
  batch_available numeric(14,2);
  subtotal_now numeric(14,2);
  gst_now numeric(14,2);
  total_now numeric(14,2);
  new_line_total numeric(14,2);
  routing_on boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may edit order lines';
  END IF;
  IF _qty IS NULL OR _qty < 1 OR _qty > 100000 THEN
    RAISE EXCEPTION 'Enter an order quantity between 1 and 100,000';
  END IF;
  IF _capacity IS NULL OR length(trim(_capacity)) = 0 OR length(trim(_capacity)) > 100 THEN
    RAISE EXCEPTION 'Enter a valid product capacity';
  END IF;
  IF _unit_price IS NULL OR _unit_price < 0 OR _unit_price > 100000000 THEN
    RAISE EXCEPTION 'Enter a valid unit price';
  END IF;

  SELECT * INTO target_order FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target_order.branch_id, ''), true);
  IF target_order.order_status <> 'Placed'
    OR target_order.payment_status <> 'Pending'
    OR target_order.paid_amount <> 0
    OR target_order.discount <> 0
    OR target_order.coupon IS NOT NULL THEN
    RAISE EXCEPTION 'Only unpaid, non-discounted orders in Placed status can be edited';
  END IF;

  SELECT * INTO target_item FROM public.order_items
    WHERE id = _order_item_id AND order_id = target_order.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  delta := _qty - target_item.qty;

  IF delta <> 0 THEN
    SELECT * INTO product_row FROM public.catalog_products WHERE id = target_item.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The product is no longer in the catalog; quantity cannot be changed'; END IF;
    stock_now := COALESCE((product_row.payload->>'stock')::numeric, 0);
    IF delta > 0 THEN
      -- Changed 14 Nov 2026: with godown matching on, the order's own godown's READY stock (it was the catalogue total),
      -- and the units come from private.take_order_line (ready only: pre-order units only by the customer).
      routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
      IF routing_on THEN
        stock_now := COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = target_order.branch_id AND product_id = target_item.product_id), 0);
      END IF;
      IF stock_now < delta THEN
        RAISE EXCEPTION 'There is not enough available stock for this quantity';
      END IF;
      PERFORM private.take_order_line(target_item.id, target_item.product_id, target_order.branch_id, delta, routing_on, 0, 'admin_edit');
    ELSE
      UPDATE public.catalog_products
        SET payload = jsonb_set(
          jsonb_set(product_row.payload, '{stock}', to_jsonb(stock_now - delta), true),
          '{sold}', to_jsonb(GREATEST(0, COALESCE((product_row.payload->>'sold')::numeric, 0) + delta)),
          true
        ), updated_at = now()
        WHERE id = target_item.product_id;
      needed := abs(delta);
      FOR allocation_row IN
        SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
        FROM public.order_item_batch_allocations a
        WHERE a.order_item_id = target_item.id
          AND a.released_quantity < a.reserved_quantity
        ORDER BY a.created_at DESC, a.id DESC
        FOR UPDATE
      LOOP
        EXIT WHEN needed <= 0;
        taken := LEAST(needed, allocation_row.reserved_quantity - allocation_row.released_quantity);
        UPDATE public.batches
          SET remaining_quantity = remaining_quantity + taken,
              status = CASE WHEN remaining_quantity + taken > 0 THEN 'Active' ELSE 'Depleted' END
          WHERE id = allocation_row.batch_id;
        UPDATE public.order_item_batch_allocations
          SET released_quantity = released_quantity + taken
          WHERE id = allocation_row.id;
        needed := needed - taken;
      END LOOP;
    END IF;
  END IF;

  -- Changed 7 Nov 2026: on an order whose prices include GST, the typed price includes GST and line_total is the
  -- taxable value; an older order adds GST on top, as before.
  new_line_total := CASE
    WHEN target_order.prices_include_gst AND target_item.gst_rate > 0
      THEN round(_qty * _unit_price, 2) - round(round(_qty * _unit_price, 2) * target_item.gst_rate / (100 + target_item.gst_rate), 2)
    ELSE round(_qty * _unit_price, 2) END;
  UPDATE public.order_items
    SET qty = _qty,
        capacity = trim(_capacity),
        unit_price = _unit_price,
        line_total = new_line_total,
        -- Added 14 Nov 2026: a smaller line keeps at most its own quantity on pre-order.
        preorder_qty = LEAST(preorder_qty, _qty)
    WHERE id = target_item.id;

  IF target_order.prices_include_gst THEN
    SELECT COALESCE(SUM(line_total), 0),
           COALESCE(SUM(round(qty * unit_price, 2) - line_total), 0)
      INTO subtotal_now, gst_now
      FROM public.order_items WHERE order_id = target_order.id;
  ELSE
    SELECT COALESCE(SUM(line_total), 0),
           COALESCE(SUM(round(line_total * gst_rate / 100, 2)), 0)
      INTO subtotal_now, gst_now
      FROM public.order_items WHERE order_id = target_order.id;
  END IF;
  total_now := subtotal_now + gst_now + target_order.shipping - target_order.discount;
  UPDATE public.orders
    SET subtotal = subtotal_now,
        gst_amount = gst_now,
        total = total_now,
        balance_due = GREATEST(0, total_now - paid_amount)
    WHERE id = target_order.id;

  RETURN jsonb_build_object(
    'order_no', target_order.order_no,
    'order_item_id', target_item.id,
    'qty', _qty,
    'capacity', trim(_capacity),
    'unit_price', _unit_price,
    'line_total', new_line_total,
    'subtotal', subtotal_now,
    'gst_amount', gst_now,
    'total', total_now,
    'balance_due', GREATEST(0, total_now - target_order.paid_amount)
  );
END;
$function$;

-- admin_place_ended_checkout: live definition (20261113200000) + ready and arriving per product, private.take_order_line.
CREATE OR REPLACE FUNCTION public.admin_place_ended_checkout(_order_no text, _utr text DEFAULT NULL::text, _method text DEFAULT NULL::text, _checked_against text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  has_s boolean;
  ref text;
  method text;
  routing_on boolean;
  line record;
  stock_now numeric(14,2);
  due numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status <> 'Payment Expired' THEN RAISE EXCEPTION 'Only a checkout that ended without payment can be placed again here.'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  has_s := FOUND;
  IF has_s AND s.note = 'refunded by our team' THEN RAISE EXCEPTION 'The payment for this checkout was refunded, so it cannot be placed with it.'; END IF;
  IF has_s AND COALESCE(s.note, '') LIKE 'Placed again as %' THEN
    RAISE EXCEPTION 'The payment for this checkout already went to %.', substring(s.note from 'Placed again as (.*)$');
  END IF;
  ref := btrim(COALESCE(NULLIF(_utr, ''), CASE WHEN has_s AND s.status = 'submitted' THEN s.utr END, ''));
  IF length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR of the payment you found in the bank'; END IF;
  method := upper(btrim(COALESCE(NULLIF(_method, ''), o.payment_method, 'UPI')));
  IF method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'CASH', 'CHEQUE') THEN RAISE EXCEPTION 'Choose how it was paid'; END IF;
  method := CASE method WHEN 'CASH' THEN 'Cash' WHEN 'CHEQUE' THEN 'Cheque' ELSE method END;

  -- Its stock went back on sale when it ended: take it again at its godown, as placing it took it, or refuse.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  -- Changed 14 Nov 2026: per product (two lines of one product share its stock), ready and arriving.
  PERFORM private.lock_products(ARRAY(SELECT DISTINCT i.product_id FROM public.order_items i WHERE i.order_id = o.id AND i.product_id IS NOT NULL));
  FOR line IN
    SELECT i.product_id, sum(i.qty) AS qty, min(i.product_name) AS product_name, (array_agg(cp.payload))[1] AS payload
      FROM public.order_items i
      LEFT JOIN public.catalog_products cp ON cp.id = i.product_id WHERE i.order_id = o.id
     GROUP BY i.product_id
  LOOP
    stock_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock + CASE WHEN private.preorder_on() THEN incoming ELSE 0 END
                       FROM public.branch_stock WHERE branch_id = o.branch_id AND product_id = line.product_id), 0)
      ELSE COALESCE((line.payload->>'stock')::numeric, 0) END;
    IF stock_now < line.qty THEN
      RAISE EXCEPTION 'Only % left of % at its godown, so it cannot be placed again. Refund the customer, or add stock first.',
        to_char(stock_now, 'FM99999990.##'), COALESCE(line.product_name, 'an item');
    END IF;
  END LOOP;
  PERFORM set_config('app.branch_id', COALESCE(o.branch_id, ''), true);
  FOR line IN SELECT i.id, i.product_id, i.qty, i.preorder_qty FROM public.order_items i WHERE i.order_id = o.id ORDER BY i.id LOOP
    CONTINUE WHEN line.product_id IS NULL;
    -- Changed 14 Nov 2026: ready units first; arriving units only as many as the customer pre-ordered on this line.
    PERFORM private.take_order_line(line.id, line.product_id, o.branch_id, line.qty, routing_on, line.preorder_qty, 'replace');
  END LOOP;
  IF o.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = COALESCE(used_count, 0) + 1 WHERE code = o.coupon;
  END IF;

  -- Back to waiting for a moment, then paid in the same step: Confirm paid's own checks and records (the payment, the
  -- UTR settled, the bank alert answered) apply as they always do. Any refusal there undoes all of this.
  PERFORM set_config('app.payment_workflow', 'on', true);
  PERFORM set_config('app.revive_checkout', 'on', true);
  -- The order shows how it was really paid (a UPI checkout paid by NEFT, cash or cheque).
  UPDATE public.orders SET order_status = 'Awaiting Payment', payment_hold_until = now() + interval '30 minutes', payment_hold_outcome = NULL,
    payment_method = method
    WHERE id = o.id;
  PERFORM set_config('app.revive_checkout', 'off', true);
  PERFORM set_config('app.payment_workflow', 'off', true);
  due := o.total - COALESCE(o.paid_amount, 0);
  PERFORM public.admin_confirm_manual_payment(o.order_no, due, ref, method);
  -- Changed 13 Nov 2026: also the order's own lapsed UTR when it is the transfer recorded (admin_confirm_manual_payment
  -- confirms it already; this keeps the rule here too), and the admin who placed it is on the record (Approved by).
  UPDATE public.upi_payment_submissions
    SET status = 'confirmed',
        note = left(format('Paid after the checkout ended; placed again%s', CASE WHEN btrim(COALESCE(_checked_against, '')) <> '' THEN '. ' || btrim(_checked_against) ELSE '' END), 200),
        reviewed_at = now(), reviewed_by = auth.uid()
    WHERE order_id = o.id
      AND (status = 'confirmed' OR (status = 'rejected' AND note = 'we could not check your UTR in time' AND private.same_utr(utr, ref)));
  -- Added 13 Nov 2026: who ended this checkout stays on record, marked placed again, so the order no longer reads Cancelled.
  UPDATE public.order_cancellations
    SET placed_again_at = now(),
        placed_again_by_name = COALESCE((SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) FROM public.profiles WHERE id = auth.uid()), '')
    WHERE order_id = o.id AND stage = 'Awaiting Payment' AND placed_again_at IS NULL;
  -- The customer hears "Order placed" from the order's own status change (notify_order_participants), as for any paid order.
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'amount', due, 'status', 'Payment Confirmed');
END;
$function$;

-- private.record_batch_stock_change: live definition (20261113160000) + received batches only.
CREATE OR REPLACE FUNCTION private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric,
  _reason text, _note text, _by uuid, _by_name text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := round(abs(COALESCE(_delta, 0)), 2);
  taken numeric(14,2);
  batch_row record;
  stock_after numeric(14,2);
  in_batches numeric(14,2);
BEGIN
  IF needed = 0 THEN RETURN 0; END IF;
  -- A Zoho batch-tracked item: the godown sync records the batches Zoho itself changes.
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = _product_id AND track_batches) THEN RETURN 0; END IF;
  -- Changed 14 Nov 2026: received batches only, everywhere below (a pre-order batch has no stock in the godown yet).
  IF _delta < 0 THEN
    FOR batch_row IN
      SELECT id, remaining_quantity, unit_cost FROM public.batches
      WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0 AND stage = 'received'
      ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
      FOR UPDATE
    LOOP
      EXIT WHEN needed <= 0;
      taken := LEAST(needed, batch_row.remaining_quantity);
      UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
      INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
        VALUES (batch_row.id, -taken, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
      needed := needed - taken;
    END LOOP;
    RETURN round(abs(_delta), 2) - needed;
  END IF;
  SELECT id, unit_cost INTO batch_row FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND stage = 'received'
    ORDER BY purchase_date DESC NULLS LAST, created_at DESC, batch_code DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- Called after the godown's stock was written (admin_set_branch_stock): only what the stock now holds beyond the
  -- batches is a gain; the rest is batch stock reaching the count.
  SELECT COALESCE(stock, 0) INTO stock_after FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  SELECT COALESCE(SUM(remaining_quantity), 0) INTO in_batches FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0 AND stage = 'received';
  needed := LEAST(needed, GREATEST(0, COALESCE(stock_after, 0) - in_batches));
  IF needed <= 0 THEN RETURN 0; END IF;
  UPDATE public.batches SET remaining_quantity = remaining_quantity + needed WHERE id = batch_row.id;
  INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
    VALUES (batch_row.id, needed, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
  RETURN needed;
END $function$;
REVOKE ALL ON FUNCTION private.record_batch_stock_change(text, text, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- admin_set_branch_stock: live definition (20261031200000) + the two pre-order refusals.
CREATE OR REPLACE FUNCTION public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE total numeric; before_stock numeric; lot_code text; held_now numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set branch stock';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN RAISE EXCEPTION 'Enter a valid stock quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  -- Added 14 Nov 2026: a pre-order batch's bags come into stock with its Zoho bill, never typed in; and while Zoho shows
  -- stock the website can't explain here, the number waits for that to be matched or explained.
  SELECT batch_code INTO lot_code FROM public.batches
   WHERE product_id = _product_id AND branch_id = _branch_id AND stage = 'incoming' ORDER BY expected_date, created_at LIMIT 1;
  IF lot_code IS NOT NULL AND _stock > COALESCE(before_stock, 0) THEN
    RAISE EXCEPTION 'Pre-order batch % is on its way to %. Its bags come into stock with its Zoho bill, so don''t type them in. You can still lower this stock.',
      lot_code, private.godown_name(_branch_id);
  END IF;
  SELECT held INTO held_now FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id;
  IF COALESCE(held_now, 0) > 0 AND _stock IS DISTINCT FROM COALESCE(before_stock, 0) THEN
    RAISE EXCEPTION 'Zoho shows % more % at % than the website counts. Match its bill or explain it first.',
      private.qty_text(held_now), private.product_name(_product_id), private.godown_name(_branch_id);
  END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, true)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = true, updated_at = now();
  -- Added 14 Nov 2026: a watched godown remembers the edit until it is in Zoho (private.apply_reading).
  UPDATE public.preorder_watch SET pending_delta = pending_delta + (_stock - COALESCE(before_stock, 0))
    WHERE branch_id = _branch_id AND product_id = _product_id;
  -- The same change on the godown's batches (correction), so batch reports match the stock.
  PERFORM private.record_batch_stock_change(_branch_id, _product_id, _stock - COALESCE(before_stock, 0), 'correction',
    'Godown stock set by head office', auth.uid(), COALESCE((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''));
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  RETURN total;
END $function$;

-- apply_zoho_branch_stock: live definition (20261024100000) + a watched pair is skipped (apply_preorder_reading takes it).
CREATE OR REPLACE FUNCTION public.apply_zoho_branch_stock(_branch_id text, _product_id text, _stock numeric, _read_at timestamptz)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE total numeric; row_now public.branch_stock%ROWTYPE;
BEGIN
  IF _stock IS NULL OR _stock < 0 THEN _stock := 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  -- Added 14 Nov 2026: a product with a pre-order batch is watched; its readings go through apply_preorder_reading.
  IF EXISTS (SELECT 1 FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id) THEN RETURN NULL; END IF;
  SELECT * INTO row_now FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF FOUND AND row_now.updated_at > _read_at THEN RETURN NULL; END IF;
  IF FOUND AND row_now.stock = _stock AND NOT row_now.zoho_pending THEN
    RETURN (SELECT COALESCE(SUM(stock), 0) FROM public.branch_stock WHERE product_id = _product_id);
  END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = false, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN total;
END $function$;

-- private.batch_transfer_godown: live definition (20261110180000) + watched pairs take the reading through the hold step.
CREATE OR REPLACE FUNCTION private.batch_transfer_godown(_branch text, _product text, _delta numeric, _readings jsonb, _reading_only boolean)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  reading numeric;
  waiting boolean;
  before numeric;
  after numeric;
BEGIN
  IF _branch IS NULL OR _product IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(_readings) = 'array' THEN
    SELECT (r->>'stock')::numeric INTO reading FROM jsonb_array_elements(_readings) AS r
      WHERE r->>'branch_id' = _branch AND r->>'product_id' = _product AND jsonb_typeof(r->'stock') = 'number' LIMIT 1;
  END IF;
  waiting := false;
  SELECT zoho_pending, stock INTO waiting, before FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  before := COALESCE(before, 0);
  -- Added 14 Nov 2026: a product with a pre-order batch is watched: the move is the website's own (its total moves by
  -- it, as spec 2.4 explains the units a transfer brings in), then Zoho's number goes through the hold step. Without a
  -- reading (or with a website edit still waiting) the total moves by the quantity and so does the watch's last Zoho
  -- number.
  IF EXISTS (SELECT 1 FROM public.preorder_watch w WHERE w.branch_id = _branch AND w.product_id = _product) THEN
    -- (Review, 14 Nov 2026: the shift stays. Explaining the move instead (e = moved units, no shift) lets the transfer's
    -- own fall at the sending godown net out an unread bill there, and a counter sale at the receiving one eat units held
    -- for a lot's bill: both above the truth. A reading that saw the move before this finish holds those units until an
    -- administrator releases them: below the truth, never above.) A website edit still waiting stays in the total.
    IF reading IS NOT NULL THEN
      IF NOT _reading_only AND COALESCE(_delta, 0) <> 0 THEN
        PERFORM private.shift_pair_total(_branch, _product, _delta);
        -- Zoho's number moves by the website's own transfer too (it is no fall of Zoho's own).
        UPDATE public.preorder_watch SET zoho_last = zoho_last + _delta WHERE branch_id = _branch AND product_id = _product;
      END IF;
      PERFORM private.apply_reading(_branch, _product, reading, now(), private.reading_waiting(_readings, _branch, _product), 0);
    ELSIF NOT _reading_only AND COALESCE(_delta, 0) <> 0 THEN
      PERFORM private.shift_pair_total(_branch, _product, _delta);
      UPDATE public.preorder_watch SET zoho_last = zoho_last + _delta, updated_at = now() WHERE branch_id = _branch AND product_id = _product;
    END IF;
    SELECT stock INTO after FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product;
    RETURN COALESCE(after, 0) - before;
  END IF;
  IF reading IS NOT NULL AND NOT COALESCE(waiting, false) THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending)
      VALUES (_branch, _product, GREATEST(0, round(reading - private.batch_transfer_orders_waiting(_branch, _product), 2)), false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = now();
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) < 0 THEN
    UPDATE public.branch_stock SET stock = GREATEST(0, stock + _delta), updated_at = now()
      WHERE branch_id = _branch AND product_id = _product;
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) > 0 THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch, _product, _delta, false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = public.branch_stock.stock + EXCLUDED.stock, updated_at = now();
  END IF;
  SELECT stock INTO after FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product;
  RETURN COALESCE(after, 0) - before;
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_godown(text, text, numeric, jsonb, boolean) FROM PUBLIC, anon, authenticated;

-- record_stock_count: live definition (20261031150000) + _zoho_after and _snapshot for a watched pair. The old signature
-- goes (a call with the old arguments reaches this one through the defaults).
DROP FUNCTION IF EXISTS public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.record_stock_count(
  _branch_id text, _product_id text, _counted numeric, _zoho_physical_before numeric, _zoho_delta numeric,
  _site_after numeric, _reason text, _note text, _flagged boolean, _zoho_adjustment_id text,
  _counted_by uuid, _counted_by_name text, _employee_id uuid, _zoho_after numeric DEFAULT NULL, _snapshot uuid[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  product_payload jsonb;
  before_stock numeric;
  total numeric;
  new_id uuid;
  after_stock numeric := _site_after;
  pd numeric;
BEGIN
  IF _counted IS NULL OR _counted < 0 OR _site_after IS NULL OR _site_after < 0 THEN RAISE EXCEPTION 'Invalid stock count'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  SELECT payload INTO product_payload FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;

  -- Added 14 Nov 2026: a product with a pre-order batch is watched: the godown takes Zoho's number after the count
  -- through the hold step (a count explains no rise), never _site_after.
  IF EXISTS (SELECT 1 FROM public.preorder_watch WHERE branch_id = _branch_id AND product_id = _product_id) THEN
    IF _zoho_after IS NULL THEN
      RAISE EXCEPTION '% has a pre-order batch, so this count needs Zoho''s stock after it. Count again.', COALESCE(product_payload->>'name', _product_id);
    END IF;
    -- Review fix: not while a transfer of it at this godown is unfinished (Zoho may show it already; the finish moves the
    -- total again). The server checks this before it writes to Zoho.
    IF private.transfer_unfinished(_product_id, _branch_id) THEN
      RAISE EXCEPTION 'A transfer of % at % is not finished in Zoho. Count again after it is.', COALESCE(product_payload->>'name', _product_id),
        private.godown_name(_branch_id);
    END IF;
    -- Review fix: a website edit still waiting for Zoho is replaced by the count (the floor is the truth now), so it comes
    -- out of the total first; else the same bags would come off twice and the count's reading look like a rise.
    SELECT w.pending_delta INTO pd FROM public.preorder_watch w WHERE w.branch_id = _branch_id AND w.product_id = _product_id FOR UPDATE;
    pd := CASE WHEN COALESCE((SELECT zoho_pending FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id), false)
               THEN COALESCE(pd, 0) ELSE 0 END;
    IF pd <> 0 THEN PERFORM private.shift_pair_total(_branch_id, _product_id, -pd); END IF;
    UPDATE public.branch_stock SET zoho_pending = false WHERE branch_id = _branch_id AND product_id = _product_id AND zoho_pending;
    UPDATE public.preorder_watch SET pending_delta = 0 WHERE branch_id = _branch_id AND product_id = _product_id;
    -- A count that found fewer is the website's own change in Zoho (the server posted it): the total falls by it first. A
    -- count that found more explains nothing (spec 2.4): its rise is held like any other, except the part that carries a
    -- head-office increase that was waiting (a godown with no lot).
    IF COALESCE(_zoho_delta, 0) < 0 THEN PERFORM private.shift_pair_total(_branch_id, _product_id, _zoho_delta); END IF;
    -- Zoho's number moved by the count's own adjustment (no fall or rise of Zoho's own).
    UPDATE public.preorder_watch SET zoho_last = zoho_last + COALESCE(_zoho_delta, 0) WHERE branch_id = _branch_id AND product_id = _product_id;
    PERFORM private.apply_reading(_branch_id, _product_id, _zoho_after, now(), _snapshot, GREATEST(0, LEAST(pd, COALESCE(_zoho_delta, 0))));
    SELECT stock INTO after_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  ELSE
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _site_after, false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = false, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  END IF;

  INSERT INTO public.stock_counts (branch_id, product_id, product_name, counted, zoho_physical_before, zoho_delta,
    site_before, site_after, reason, note, flagged, zoho_adjustment_id, counted_by, counted_by_name, employee_id)
  VALUES (_branch_id, _product_id, COALESCE(product_payload->>'name', _product_id), _counted, _zoho_physical_before, _zoho_delta,
    COALESCE(before_stock, 0), COALESCE(after_stock, 0), _reason, left(COALESCE(_note, ''), 200), COALESCE(_flagged, false),
    COALESCE(_zoho_adjustment_id, ''), _counted_by, COALESCE(_counted_by_name, ''), _employee_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid, numeric, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid, numeric, uuid[]) TO service_role;

-- begin_batch_split: live definition (20261110180000) + a lot can't be sent.
CREATE OR REPLACE FUNCTION public.begin_batch_split(_batch_id uuid, _targets jsonb, _by uuid, _by_name text, _request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  src public.branches%ROWTYPE;
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  target jsonb;
  qty numeric;
  total numeric(14,2) := 0;
  item text;
  seen text[] := '{}';
  made jsonb := '[]'::jsonb;
  who text := left(btrim(COALESCE(_by_name, '')), 120);
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can send stock to another godown'; END IF;
  IF jsonb_typeof(_targets) <> 'array' OR jsonb_array_length(_targets) = 0 THEN RAISE EXCEPTION 'Choose a godown and how many to send'; END IF;
  -- Orders take from the batch FOR UPDATE too, so nothing slips in between the check and the move. The product is
  -- locked first, as orders lock it (place_marketplace_order), so the two never wait on each other.
  PERFORM 1 FROM public.catalog_products WHERE id = (SELECT product_id FROM public.batches WHERE id = _batch_id) FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- Added 14 Nov 2026: a pre-order batch is not in the godown yet.
  IF b.stage <> 'received' THEN
    RAISE EXCEPTION 'Batch % has not arrived yet. Send it to other godowns after it is matched to its bill.', b.batch_code;
  END IF;
  -- The same request again (its answer was lost and Send was pressed again): the transfers it began, nothing new.
  IF _request IS NOT NULL AND EXISTS (SELECT 1 FROM public.batch_transfers WHERE request_id = _request) THEN
    RETURN (SELECT jsonb_agg(private.batch_transfer_json(x) ORDER BY x.id) FROM public.batch_transfers x WHERE x.request_id = _request);
  END IF;
  SELECT * INTO src FROM public.branches WHERE id = b.branch_id;
  IF src.id IS NULL OR COALESCE(src.zoho_location_id, '') = '' THEN
    RAISE EXCEPTION 'Batch % is not at a godown linked to a Zoho location', b.batch_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = b.product_id AND track_batches) THEN
    RAISE EXCEPTION '% has batch tracking in Zoho: move it in Zoho, where its batches are', b.product_name;
  END IF;
  SELECT zoho_item_id INTO item FROM public.zoho_item_links WHERE product_id = b.product_id;
  IF COALESCE(item, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho item', b.product_name; END IF;

  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    qty := CASE WHEN jsonb_typeof(target->'qty') = 'number' THEN (target->>'qty')::numeric END;
    IF qty IS NULL OR qty <= 0 OR qty <> round(qty, 2) THEN RAISE EXCEPTION 'Enter how many to send to each godown'; END IF;
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
    IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
    IF dst.id = src.id THEN RAISE EXCEPTION 'Batch % is already at %', b.batch_code, dst.name; END IF;
    IF dst.id = ANY (seen) THEN RAISE EXCEPTION '% is chosen twice', dst.name; END IF;
    seen := seen || dst.id;
    total := total + qty;
  END LOOP;
  IF total > b.remaining_quantity THEN
    RAISE EXCEPTION 'Batch % has % left; % were chosen', b.batch_code, b.remaining_quantity, total;
  END IF;

  UPDATE public.batches SET remaining_quantity = remaining_quantity - total, sent_quantity = sent_quantity + total WHERE id = b.id;
  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    qty := (target->>'qty')::numeric;
    -- The godown's stock is not touched yet: Zoho still has the units there until it has them on the way (finish).
    INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
        parent_batch_id, product_id, quantity, lines, created_by, created_by_name, request_id)
      VALUES (private.next_batch_transfer_no(), 'split', src.id, src.zoho_location_id, src.name, dst.id, dst.zoho_location_id,
        b.id, b.product_id, qty, jsonb_build_array(jsonb_build_object('product_id', b.product_id, 'zoho_item_id', item, 'name', b.product_name, 'qty', qty, 'unit', b.unit)),
        _by, who, _request)
      RETURNING * INTO t;
    made := made || private.batch_transfer_json(t);
  END LOOP;
  RETURN made;
END $function$;

-- admin_update_batch: live definition (20261105190000) + a lot is edited as a pre-order.
CREATE OR REPLACE FUNCTION public.admin_update_batch(_batch_id uuid, _unit_cost numeric, _supplier text, _purchase_ref text,
  _notes text, _mfg_date date, _expiry_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may edit batches'; END IF;
  IF _unit_cost IS NULL OR _unit_cost < 0 OR _unit_cost > 100000000 THEN RAISE EXCEPTION 'Enter a valid purchase cost'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- Added 14 Nov 2026.
  IF batch_row.stage = 'incoming' THEN RAISE EXCEPTION 'Edit pre-order batch % instead', batch_row.batch_code; END IF;
  IF batch_row.zoho_bill_id <> '' THEN
    IF round(_unit_cost, 2) <> batch_row.unit_cost THEN RAISE EXCEPTION 'This batch''s cost comes from bill %. Correct the bill in Zoho instead.', batch_row.zoho_bill_number; END IF;
    -- Supplier and bill number come from the bill too.
    UPDATE public.batches SET notes = left(btrim(COALESCE(_notes, '')), 300), mfg_date = _mfg_date, expiry_date = _expiry_date
      WHERE id = _batch_id;
    RETURN;
  END IF;
  UPDATE public.batches
    SET unit_cost = _unit_cost, supplier = left(btrim(COALESCE(_supplier, '')), 120),
        purchase_ref = left(btrim(COALESCE(_purchase_ref, '')), 80), notes = left(btrim(COALESCE(_notes, '')), 300),
        mfg_date = _mfg_date, expiry_date = _expiry_date
    WHERE id = _batch_id;
  -- Sales already made from the batch take the corrected cost too (profit stays right).
  UPDATE public.order_item_batch_allocations SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
  UPDATE public.batch_adjustments SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
END $function$;

-- admin_delete_batch: live definition (20261110180000) + lots are cancelled instead, and a batch with expenses stays.
CREATE OR REPLACE FUNCTION public.admin_delete_batch(_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
  held numeric;
  used integer;
  rest_code text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete batches'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- Added 14 Nov 2026.
  IF batch_row.stage = 'incoming' THEN RAISE EXCEPTION 'Cancel pre-order batch % instead', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_cost_tags WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Expenses are tagged to batch %; remove them first', batch_row.batch_code;
  END IF;
  SELECT batch_code INTO rest_code FROM public.batches WHERE split_from_batch_id = batch_row.id LIMIT 1;
  IF rest_code IS NOT NULL THEN
    RAISE EXCEPTION 'Batch % is the pre-order that % came from, so it is kept for the record.', batch_row.batch_code, rest_code;
  END IF;
  IF batch_row.transfer_id IS NOT NULL OR batch_row.parent_batch_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.batch_transfers WHERE parent_batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Batch % is part of a transfer between godowns, so it is kept for the record.', batch_row.batch_code;
  END IF;
  -- An order placed now waits for this lock (its FIFO takes the batch FOR UPDATE), so nothing slips in between.
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0), count(*) INTO held, used
    FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  IF held > 0 THEN RAISE EXCEPTION 'Orders have taken stock from batch %, so it can''t be deleted.', batch_row.batch_code; END IF;
  -- A batch whose every order was cancelled or expired, unpaid, with all units back, may go (owner, 6 Nov 2026).
  IF used > 0 AND EXISTS (
    SELECT 1 FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id
      JOIN public.orders o ON o.id = i.order_id
     WHERE a.batch_id = batch_row.id
       AND NOT (o.order_status IN ('Cancelled', 'Payment Expired') AND COALESCE(o.paid_amount, 0) = 0
                AND COALESCE(o.payment_status, '') NOT IN ('Paid', 'Partially Paid', 'Refunded'))
  ) THEN RAISE EXCEPTION 'Orders have used batch % before, so it is kept for their records.', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_adjustments WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Stock counts have changed batch %, so it is kept for their records.', batch_row.batch_code;
  END IF;
  IF batch_row.remaining_quantity <> batch_row.quantity THEN
    RAISE EXCEPTION 'Batch %''s units have moved, so it can''t be deleted.', batch_row.batch_code;
  END IF;
  INSERT INTO public.deleted_batches_log (batch_code, product_id, product_name, quantity, released_orders, zoho_adjustment_id, deleted_by, deleted_by_name)
  VALUES (batch_row.batch_code, batch_row.product_id, batch_row.product_name, batch_row.quantity, used, COALESCE(batch_row.zoho_adjustment_id, ''),
    auth.uid(), COALESCE((SELECT left(COALESCE(p.full_name, ''), 120) FROM public.profiles p WHERE p.id = auth.uid()), ''));
  -- Added 14 Nov 2026: a cancelled pre-order's audit rows stay, naming it.
  UPDATE public.batch_lot_events SET detail = detail || jsonb_build_object('batch_code', batch_row.batch_code, 'deleted', true), batch_id = NULL
    WHERE batch_id = batch_row.id;
  -- Only released rows of cancelled or expired orders are left here; their units are already back in stock.
  DELETE FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  DELETE FROM public.batches WHERE id = batch_row.id;
  RETURN jsonb_build_object('batch_code', batch_row.batch_code, 'zoho_adjustment_id', batch_row.zoho_adjustment_id);
END $function$;

-- create_batches_from_bill: live definition (20261105190000) + product locks first, and a line of a product with a
-- pre-order batch at this godown needs the reason it is a different purchase.
CREATE OR REPLACE FUNCTION public.create_batches_from_bill(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text,
  _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  branch_row public.branches%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  bill_date date;
  line_id text;
  quantity numeric(14,2);
  cost_ex numeric(14,2);
  cost_inc numeric(14,2);
  code text;
  new_id uuid;
  done text;
  made jsonb := '[]'::jsonb;
  lot_code text;
  why_not text;
BEGIN
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  bill_date := NULLIF(_bill->>'date', '')::date;
  IF bill_date IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to make batches from'; END IF;
  SELECT * INTO branch_row FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT branch_row.active OR branch_row.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  -- Added 14 Nov 2026: the line products first, in id order (the lock orders and matches take first).
  PERFORM private.lock_products(ARRAY(SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(_lines) l));
  -- Two admins, or two presses, on one bill: the second waits and then finds the lines done.
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    line_id := btrim(COALESCE(line->>'line_id', ''));
    IF line_id = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line_id;
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    quantity := round(COALESCE((line->>'qty')::numeric, 0), 2);
    cost_ex := round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2);
    cost_inc := round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2);
    IF quantity <= 0 OR quantity > 1000000 THEN RAISE EXCEPTION 'Bill % has a line with no quantity', bill_no; END IF;
    IF cost_ex < 0 OR cost_inc < cost_ex OR cost_inc > 100000000 THEN RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no; END IF;
    SELECT * INTO product_row FROM public.catalog_products WHERE id = line->>'product_id';
    IF NOT FOUND OR COALESCE(product_row.vendor_id, '') LIKE 'zoho:%' THEN RAISE EXCEPTION 'A bill line is not a website product'; END IF;
    -- Zoho makes and reports batches of these items itself (apply_zoho_batches): a second batch would count them twice.
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = product_row.id AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', COALESCE(product_row.payload->>'name', product_row.id);
    END IF;
    -- Added 14 Nov 2026: a product with a pre-order batch waiting here: match the line to it, or say why it is another purchase.
    why_not := left(btrim(COALESCE(line->>'not_preorder_note', '')), 300);
    SELECT batch_code INTO lot_code FROM public.batches
     WHERE product_id = product_row.id AND branch_id = branch_row.id AND stage = 'incoming' ORDER BY expected_date, created_at LIMIT 1;
    IF lot_code IS NOT NULL AND length(why_not) < 10 THEN
      RAISE EXCEPTION '% has pre-order batch % waiting at %. Match this line to it, or say why it is a different purchase.',
        COALESCE(product_row.payload->>'name', product_row.id), lot_code, branch_row.name;
    END IF;
    code := public.next_batch_code(branch_row.id, bill_date);
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name,
      zoho_item_id, zoho_bill_id, zoho_bill_line_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status, not_preorder_note)
    VALUES (code, product_row.id, COALESCE(product_row.payload->>'name', product_row.id), product_row.payload->>'vendor',
      product_row.vendor_id, quantity, quantity, COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'),
      CASE WHEN _cost_basis = 'inc_gst' THEN cost_inc ELSE cost_ex END, cost_ex, cost_inc, _cost_basis, bill_date,
      NULLIF(line->>'mfg_date', '')::date, NULLIF(line->>'expiry_date', '')::date, branch_row.name, branch_row.id,
      'website', left(btrim(COALESCE(_bill->>'vendor_name', '')), 120), bill_no, left(btrim(COALESCE(line->>'notes', '')), 300),
      _by, left(COALESCE(_by_name, ''), 120), COALESCE(line->>'zoho_item_id', ''), bill_id, line_id,
      bill_no, left(COALESCE(_bill->>'modified', ''), 40), NULLIF(_bill->>'total', '')::numeric, 'Active',
      CASE WHEN lot_code IS NOT NULL THEN why_not ELSE '' END)
    RETURNING id INTO new_id;
    made := made || jsonb_build_object('line_id', line_id, 'batch_id', new_id, 'batch_code', code);
  END LOOP;
  RETURN made;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Bill % already has batches for these lines. Refresh the page.', bill_no;
END $function$;

-- begin_bill_receive: live definition (20261110180000) + match lines, checked now and their lots paused.
CREATE OR REPLACE FUNCTION public.begin_bill_receive(_branch_id text, _from_location_id text, _from_location_name text,
  _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := btrim(COALESCE(_bill->>'bill_number', ''));
  done text;
  from_branch text;
  lot public.batches%ROWTYPE;
  match_ids uuid[] := '{}';
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  IF btrim(COALESCE(_from_location_id, '')) = '' THEN RAISE EXCEPTION 'Zoho did not say where bill % is', bill_no; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
  IF dst.zoho_location_id = _from_location_id THEN RAISE EXCEPTION 'Bill % is already at %: nothing to move', bill_no, dst.name; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to receive'; END IF;
  -- Added 14 Nov 2026: the line products first (a matched lot is paused below).
  PERFORM private.lock_products(ARRAY(SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(_lines) l));
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id;
  IF FOUND THEN
    IF t.to_branch_id <> dst.id THEN
      RAISE EXCEPTION 'Bill % is already being moved to another godown (%). Finish or cancel that transfer first.', bill_no, t.transfer_no;
    END IF;
    RETURN private.batch_transfer_json(t) || jsonb_build_object('resumed', true);
  END IF;
  IF NULLIF(_bill->>'date', '') IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    -- What create_batches_from_bill checks when the move is finished, checked now, before Zoho moves anything: a line it
    -- would refuse then would leave a transfer that Zoho made and the website can never finish.
    IF btrim(COALESCE(line->>'line_id', '')) = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line->>'line_id';
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    IF round(COALESCE((line->>'qty')::numeric, 0), 2) <= 0 OR round(COALESCE((line->>'qty')::numeric, 0), 2) > 1000000
       OR btrim(COALESCE(line->>'zoho_item_id', '')) = '' THEN
      RAISE EXCEPTION 'Bill % has a line without a Zoho item or quantity', bill_no;
    END IF;
    IF round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2) < 0
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) < round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2)
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) > 100000000 THEN
      RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.catalog_products p WHERE p.id = line->>'product_id' AND COALESCE(p.vendor_id, '') NOT LIKE 'zoho:%') THEN
      RAISE EXCEPTION 'A bill line is not a website product';
    END IF;
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = line->>'product_id' AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', line->>'name';
    END IF;
    -- Added 14 Nov 2026: a match line meets every rule of the match at the unloading godown now; any other line of a
    -- product with a lot there says why it is another purchase.
    IF lower(COALESCE(line->>'action', 'new')) = 'match' OR COALESCE(line->>'match_batch_id', '') <> '' THEN
      IF COALESCE(line->>'match_batch_id', '') = '' THEN RAISE EXCEPTION 'Choose the pre-order batch for this bill line'; END IF;
      SELECT * INTO lot FROM public.batches WHERE id = (line->>'match_batch_id')::uuid FOR UPDATE;
      PERFORM private.match_line_check(dst.id, lot, _bill, line, line->>'rest', NULLIF(line->>'rest_expected', '')::date, NULL);
      IF lot.id = ANY (match_ids) THEN RAISE EXCEPTION 'Batch % is chosen for two bill lines. Join pre-orders first, or match one line.', lot.batch_code; END IF;
      match_ids := match_ids || lot.id;
    ELSIF EXISTS (SELECT 1 FROM public.batches b WHERE b.product_id = line->>'product_id' AND b.branch_id = dst.id AND b.stage = 'incoming')
          AND length(btrim(COALESCE(line->>'not_preorder_note', ''))) < 10 THEN
      RAISE EXCEPTION '% has pre-order batch % waiting at %. Match this line to it, or say why it is a different purchase.',
        private.product_name(line->>'product_id'),
        (SELECT b.batch_code FROM public.batches b WHERE b.product_id = line->>'product_id' AND b.branch_id = dst.id AND b.stage = 'incoming'
          ORDER BY b.expected_date, b.created_at LIMIT 1), dst.name;
    END IF;
  END LOOP;
  SELECT id INTO from_branch FROM public.branches WHERE zoho_location_id = _from_location_id AND vendor_id IS NULL ORDER BY active DESC, id LIMIT 1;

  INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
      bill, cost_basis, lines, created_by, created_by_name)
    VALUES (private.next_batch_transfer_no(), 'receive', from_branch, _from_location_id,
      left(btrim(COALESCE(_from_location_name, '')), 120), dst.id, dst.zoho_location_id, _bill, _cost_basis, _lines,
      _by, left(btrim(COALESCE(_by_name, '')), 120))
    RETURNING * INTO t;
  -- Added 14 Nov 2026: a lot being received sells nothing more until the transfer finishes or is cancelled.
  IF cardinality(match_ids) > 0 THEN
    UPDATE public.batches SET selling_paused = true, paused_reason = 'receiving' WHERE id = ANY (match_ids);
  END IF;
  RETURN private.batch_transfer_json(t);
END $function$;

-- receive_bill_here: live definition (20261110180000) + a match needs receive_bill_lines (with Zoho's readings).
CREATE OR REPLACE FUNCTION public.receive_bill_here(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  -- Added 14 Nov 2026.
  IF jsonb_typeof(_lines) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(_lines) l
       WHERE lower(COALESCE(l->>'action', '')) = 'match' OR COALESCE(l->>'match_batch_id', '') <> '') THEN
    RAISE EXCEPTION 'Matching needs a fresh Zoho reading; open Receive purchase again';
  END IF;
  IF bill_id <> '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));
    SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Bill % is being moved to % in Zoho (transfer %). Press Retry or Cancel on it under Transfers waiting for Zoho first.',
        COALESCE(_bill->>'bill_number', ''), COALESCE((SELECT name FROM public.branches WHERE id = t.to_branch_id), 'another godown'), t.transfer_no;
    END IF;
  END IF;
  RETURN public.create_batches_from_bill(_branch_id, _bill, _lines, _cost_basis, _by, _by_name);
END $function$;

-- finish_batch_transfer: live definition (20261110180000) + match lines of a received bill, then the watch.
CREATE OR REPLACE FUNCTION public.finish_batch_transfer(_transfer_id bigint, _zoho_transfer_order_id text, _zoho_status text, _actor uuid,
  _stock jsonb, _claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  b public.batches%ROWTYPE;
  dst public.branches%ROWTYPE;
  made jsonb;
  child_code text;
  child_id uuid;
  n integer;
  line jsonb;
  receiver jsonb;
  moved numeric;
  status_now text := lower(btrim(COALESCE(_zoho_status, '')));
  new_lines jsonb := '[]'::jsonb;
  pid text;
  prev_write text;
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'done' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer % was cancelled', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN
    RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no;
  END IF;
  IF btrim(COALESCE(_zoho_transfer_order_id, '')) = '' THEN RAISE EXCEPTION 'Zoho''s transfer order is missing'; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = t.to_branch_id;
  -- Products first, then batches: the order orders take their locks in (place_marketplace_order), so a Mark received
  -- and a customer's checkout never wait on each other.
  PERFORM 1 FROM public.catalog_products
    WHERE id IN (SELECT t.product_id UNION SELECT l->>'product_id' FROM jsonb_array_elements(t.lines) AS l)
    ORDER BY id FOR UPDATE;

  IF t.kind = 'split' AND status_now IN ('in_transit', 'transferred') AND t.status = 'pending' THEN
    -- It left the sending godown: Zoho's number there, or down by the quantity (what actually went down is kept).
    moved := private.batch_transfer_godown(t.from_branch_id, t.product_id, -t.quantity, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
    UPDATE public.batch_transfers SET status = 'in_transit', sent_at = now(), zoho_transfer_order_id = _zoho_transfer_order_id,
        zoho_status = status_now, last_error = '', reserved = GREATEST(0, -moved)
      WHERE id = t.id RETURNING * INTO t;
  END IF;
  IF status_now <> 'transferred' THEN
    IF t.status = 'pending' THEN
      UPDATE public.batch_transfers SET zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
          attempts = attempts + 1, last_error = format('Zoho shows transfer %s as "%s", not received yet', t.transfer_no, status_now)
        WHERE id = t.id RETURNING * INTO t;
    END IF;
    RETURN private.batch_transfer_json(t);
  END IF;

  IF t.kind = 'split' THEN
    receiver := CASE WHEN _actor IS NULL THEN jsonb_build_object('role', 'zoho', 'name', 'Marked received in Zoho')
      ELSE private.batch_transfer_receiver(_actor, t.to_branch_id) END;
    IF receiver IS NULL THEN
      RAISE EXCEPTION 'Only % staff, its channel partner or an administrator can mark transfer % received', dst.name, t.transfer_no;
    END IF;
    SELECT * INTO b FROM public.batches WHERE id = t.parent_batch_id FOR UPDATE;
    SELECT count(*) + 1 INTO n FROM public.batches WHERE parent_batch_id = b.id AND branch_id = dst.id;
    child_code := b.batch_code || '-' || upper(COALESCE(NULLIF(btrim(dst.code), ''), regexp_replace(dst.id, '^BR-', ''))) || n;
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name, zoho_item_id,
      zoho_bill_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status, parent_batch_id, transfer_id)
    VALUES (child_code, b.product_id, b.product_name, b.vendor, b.vendor_id, t.quantity, t.quantity, b.unit,
      b.unit_cost, b.unit_cost_ex_gst, b.unit_cost_inc_gst, b.cost_basis, b.purchase_date, b.mfg_date, b.expiry_date, dst.name, dst.id,
      'website', b.supplier, b.purchase_ref, left(format('From %s (%s)', b.batch_code, t.transfer_no), 300), _actor, left(receiver->>'name', 120),
      b.zoho_item_id, b.zoho_bill_id, b.zoho_bill_number, b.zoho_bill_modified, b.zoho_bill_total, 'Active', b.id, t.id)
    RETURNING id INTO child_id;
    made := jsonb_build_array(jsonb_build_object('batch_id', child_id, 'batch_code', child_code, 'qty', t.quantity));
    -- It arrived: the receiving godown gains it (the sender's stock went down when it left). Zoho's number there; else,
    -- with Zoho the stock master, the quantity Zoho moved; without (no readings at all), what left the sender's website
    -- stock, so a move between godowns never makes website stock.
    PERFORM private.batch_transfer_godown(t.to_branch_id, t.product_id, CASE WHEN _stock IS NULL THEN t.reserved ELSE t.quantity END, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
  ELSE
    receiver := jsonb_build_object('role', 'admin', 'name', t.created_by_name);
    -- Changed 14 Nov 2026: match lines become their pre-order batch (at the unloading godown, through this transfer);
    -- the other lines make batches as before. Both before the readings, so the readings see the lots gone.
    prev_write := private.preorder_write_begin();
    made := '[]'::jsonb;
    FOR line IN SELECT value FROM jsonb_array_elements(t.lines) LOOP
      IF lower(COALESCE(line->>'action', 'new')) = 'match' OR COALESCE(line->>'match_batch_id', '') <> '' THEN
        made := made || jsonb_build_array(private.match_incoming_line(t.to_branch_id, (line->>'match_batch_id')::uuid, t.bill, line,
          line->>'rest', NULLIF(line->>'rest_expected', '')::date, t.id, t.created_by, t.created_by_name));
      ELSE
        new_lines := new_lines || jsonb_build_array(line);
      END IF;
    END LOOP;
    IF jsonb_array_length(new_lines) > 0 THEN
      made := made || public.create_batches_from_bill(t.to_branch_id, t.bill, new_lines, t.cost_basis, t.created_by, t.created_by_name);
    END IF;
    UPDATE public.batches SET transfer_id = t.id WHERE id IN (SELECT (m->>'batch_id')::uuid FROM jsonb_array_elements(made) m);
    -- Zoho is the stock master: both godowns take Zoho's numbers. Not the stock master (_stock NULL): a bill's units never
    -- reach website stock (as for a bill received at its own godown), so nothing moves.
    IF _stock IS NOT NULL THEN
      FOR line IN SELECT value FROM jsonb_array_elements(t.lines) LOOP
        PERFORM private.batch_transfer_godown(t.from_branch_id, line->>'product_id', -(line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_godown(t.to_branch_id, line->>'product_id', (line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_total(line->>'product_id');
      END LOOP;
    END IF;
    -- Added 14 Nov 2026: a product whose last lot this matched closes its watch (with these readings).
    FOR pid IN SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(t.lines) l
                WHERE lower(COALESCE(l->>'action', 'new')) = 'match' OR COALESCE(l->>'match_batch_id', '') <> '' LOOP
      PERFORM private.watch_close_if_done(pid,
        (SELECT COALESCE(jsonb_agg(r || jsonb_build_object('zoho', r->'stock')), '[]'::jsonb)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_stock) = 'array' THEN _stock ELSE '[]'::jsonb END) r
          WHERE r->>'product_id' = pid),
        (SELECT COALESCE(jsonb_object_agg(r->>'branch_id' || '|' || pid, COALESCE(r->'waiting', '[]'::jsonb)), '{}'::jsonb)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_stock) = 'array' THEN _stock ELSE '[]'::jsonb END) r
          WHERE r->>'product_id' = pid),
        now());
    END LOOP;
    PERFORM private.preorder_write_end(prev_write, ARRAY(SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(t.lines) l));
  END IF;

  UPDATE public.batch_transfers SET status = 'done', zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
      last_error = '', result = made, finished_at = now(), sent_at = COALESCE(sent_at, now()), received_at = now(),
      received_by = CASE WHEN t.kind = 'split' THEN _actor ELSE t.created_by END,
      received_by_name = left(COALESCE(receiver->>'name', ''), 120), received_by_role = receiver->>'role'
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;

-- cancel_batch_transfer: live definition (20261110180000) + a lot paused for this receive sells again.
CREATE OR REPLACE FUNCTION public.cancel_batch_transfer(_transfer_id bigint, _reason text, _by uuid, _stock jsonb, _claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  IF _by IS NOT NULL AND NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can cancel a transfer'; END IF;
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'cancelled' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'done' THEN RAISE EXCEPTION 'Transfer % is done: its units are at the other godown', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no; END IF;
  IF t.kind = 'split' THEN
    -- Product, then batch: the order checkout locks them in.
    PERFORM 1 FROM public.catalog_products WHERE id = t.product_id FOR UPDATE;
    UPDATE public.batches SET remaining_quantity = remaining_quantity + t.quantity,
        sent_quantity = GREATEST(0, sent_quantity - t.quantity)
      WHERE id = t.parent_batch_id;
    -- One on its way had left the sending godown's stock: back there, as Zoho's number when given, else what went down
    -- then (reserved), so nothing comes back that never left. One waiting for Zoho never moved stock.
    IF t.status = 'in_transit' THEN
      PERFORM private.batch_transfer_godown(t.from_branch_id, t.product_id, t.reserved, _stock, false);
      PERFORM private.batch_transfer_total(t.product_id);
    END IF;
  ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) l WHERE COALESCE(l->>'match_batch_id', '') <> '') THEN
    -- Added 14 Nov 2026: the lots this receive paused sell again.
    PERFORM private.lock_products(ARRAY(SELECT DISTINCT l->>'product_id' FROM jsonb_array_elements(t.lines) l));
    UPDATE public.batches SET selling_paused = false, paused_reason = ''
      WHERE stage = 'incoming' AND paused_reason = 'receiving'
        AND id IN (SELECT (l->>'match_batch_id')::uuid FROM jsonb_array_elements(t.lines) l WHERE COALESCE(l->>'match_batch_id', '') <> '');
  END IF;
  UPDATE public.batch_transfers SET status = 'cancelled', last_error = left(COALESCE(_reason, ''), 500), finished_at = now()
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;

-- private.delivery_note_gate: live definition (20261103090000) + 'not_arrived' while the order waits for a lot.
CREATE OR REPLACE FUNCTION private.delivery_note_gate(_order_id uuid, _zoho jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  total numeric(14,2);
  paid numeric(14,2);
  receipts numeric(14,2);
  bank_short numeric(14,2);
  other_order text;
  stop public.delivery_stops%ROWTYPE;
  website text;
  z_last boolean := COALESCE(_zoho->>'source', '') = 'last_reading';
  z_read boolean := COALESCE(_zoho->>'read', '') = 'true';
  z_live integer := CASE WHEN jsonb_typeof(_zoho->'live_invoices') = 'number' THEN (_zoho->>'live_invoices')::integer ELSE 0 END;
  z_status text := lower(btrim(COALESCE(_zoho->>'status', '')));
  z_total numeric := private.delivery_fact_amount(_zoho, 'total');
  z_balance numeric := private.delivery_fact_amount(_zoho, 'balance');
  z_made numeric := private.delivery_fact_amount(_zoho, 'payment_made');
  z_paid numeric;
  code text;
  goods jsonb;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'not_found'); END IF;
  total := COALESCE(o.total, 0);
  paid := COALESCE(o.paid_amount, 0);
  goods := private.order_waiting_goods(o.id);
  SELECT COALESCE(sum(p.amount), 0) INTO receipts FROM public.payments p WHERE p.order_id = o.id AND p.status = 'Paid';
  SELECT * INTO stop FROM public.delivery_stops s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1;
  -- A bank alert saying less came in for a transfer recorded as more. Confirming a payment does not compare
  -- them. An alert the office has settled, with a note of what was done, is dealt with.
  SELECT COALESCE(sum(p.amount - c.amount), 0) INTO bank_short
    FROM public.payments p JOIN public.bank_credits c ON private.same_utr(c.utr, p.txn_ref)
    WHERE p.order_id = o.id AND p.status = 'Paid' AND c.amount < p.amount AND c.status <> 'settled';
  -- One bank transfer can pay one order, however its UTR was typed. Only references long enough to be a bank
  -- UTR count: same_utr reads O as 0 and I as 1, which would make "RCPT1" and "RCPTI" the same money.
  SELECT other_o.order_no INTO other_order
    FROM public.payments p
    JOIN public.payments q ON q.order_id <> p.order_id AND q.status = 'Paid' AND private.same_utr(q.txn_ref, p.txn_ref)
    JOIN public.orders other_o ON other_o.id = q.order_id
    WHERE p.order_id = o.id AND p.status = 'Paid' AND length(private.utr_form(p.txn_ref)) >= 12
    LIMIT 1;

  -- What the website's own records say. orders and payments must agree with each other first.
  IF paid < 0 OR total < 0 OR paid <> receipts THEN website := 'broken';
  ELSIF paid >= total THEN website := CASE WHEN o.payment_status = 'Paid' THEN 'full' ELSE 'broken' END;
  ELSIF paid > 0 THEN website := CASE WHEN o.payment_status = 'Partially Paid' THEN 'partly' ELSE 'broken' END;
  ELSE website := CASE WHEN o.payment_status IN ('Paid', 'Partially Paid') THEN 'broken' ELSE 'unpaid' END;
  END IF;

  IF o.order_status = 'Cancelled' THEN code := 'cancelled';
  ELSIF o.order_status = 'Payment Expired' THEN code := 'payment_expired';
  ELSIF o.payment_status = 'Refunded' THEN code := 'refunded';
  ELSIF COALESCE(stop.stopped, false) THEN code := 'stopped';
  ELSIF EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = o.id AND r.refund_status IN ('Processing', 'Refunded')) THEN code := 'return_refunded';
  ELSIF o.order_status NOT IN ('Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN code := 'not_confirmed';
  ELSIF NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = o.id) THEN code := 'no_items';
  -- Added 14 Nov 2026: goods of a pre-order batch not here yet: nothing is handed over before its bill is matched.
  ELSIF COALESCE((goods->>'waiting')::numeric, 0) > 0 THEN code := 'not_arrived';
  ELSIF website = 'broken' THEN code := 'records_disagree';
  ELSIF other_order IS NOT NULL THEN code := 'utr_reused';
  ELSIF bank_short > 0 THEN code := 'bank_credit_short';
  -- Short of full payment on the website: the answer is no whatever Zoho says, so say the plain reason
  -- when Zoho has nothing to add.
  ELSIF NOT z_read THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'zoho_unreadable' END;
  ELSIF z_live > 1 THEN code := 'several_invoices';
  ELSIF z_live < 1 OR COALESCE(_zoho->>'invoice_id', '') = '' THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'no_invoice' END;
  ELSIF z_status = 'draft' THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'invoice_draft' END;
  ELSIF z_total IS NULL OR z_balance IS NULL OR z_balance < 0 OR z_total < 0 OR z_balance > z_total
     OR (z_status = 'paid') <> (z_balance = 0)
     OR (z_status = 'paid' AND z_made IS NULL AND NOT z_last) THEN code := 'zoho_inconsistent';
  -- "Paid" in Books can mean a credit note or a write-off, not money: only payments count, less the rounding
  -- write-off of up to Rs 1 (see ROUNDING_WRITE_OFF_LIMIT).
  ELSIF z_status = 'paid' AND NOT z_last AND z_made < z_total - 1 THEN code := 'zoho_not_money';
  ELSIF website = 'full' THEN
    IF z_balance > 0 THEN code := 'zoho_behind';
    -- Zoho rounds CGST and SGST separately, so its total can differ from the website's by paise.
    -- More than a rupee is a different bill.
    ELSIF abs(z_total - total) > 1 THEN code := 'totals_differ';
    ELSIF EXISTS (SELECT 1 FROM public.delivery_notes n WHERE n.zoho_invoice_id = _zoho->>'invoice_id' AND n.order_id <> o.id) THEN code := 'invoice_used';
    ELSE code := 'paid';
    END IF;
  ELSIF z_status = 'paid' THEN code := 'website_behind';
  ELSE
    z_paid := z_total - z_balance;
    IF website = 'unpaid' THEN code := CASE WHEN z_paid > 0 THEN 'zoho_has_payment' ELSE 'unpaid' END;
    -- Part paid on the website: Zoho either has not been told yet, or says about the same.
    ELSE code := CASE WHEN z_paid = 0 OR abs(z_paid - paid) <= 1 THEN 'partly_paid' ELSE 'payment_mismatch' END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', code = 'paid', 'code', code, 'website', website, 'source', CASE WHEN z_last THEN 'last_reading' ELSE 'zoho_now' END,
    'order_no', o.order_no, 'order_status', o.order_status, 'payment_status', o.payment_status,
    'order_total', total, 'paid', paid, 'receipts', receipts,
    'balance', GREATEST(total - paid, 0), 'overpaid', GREATEST(paid - total, 0), 'bank_short', bank_short, 'other_order_no', other_order,
    'stopped', COALESCE(stop.stopped, false), 'stop_reason', CASE WHEN stop.stopped THEN stop.reason END,
    'zoho_read', z_read, 'zoho_error', left(COALESCE(_zoho->>'error', ''), 300), 'live_invoices', z_live,
    'invoice_id', COALESCE(_zoho->>'invoice_id', ''), 'invoice_number', COALESCE(_zoho->>'invoice_number', ''),
    'invoice_status', z_status, 'invoice_total', z_total, 'invoice_balance', z_balance, 'invoice_payment_made', z_made,
    'waiting', COALESCE((goods->>'waiting')::numeric, 0), 'expected_date', goods->'expected_date', 'waiting_batches', COALESCE(goods->'codes', '[]'::jsonb)
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_gate(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- guard_order_mutation: live definition (20261113230000) + nothing leaves before it arrives (I5).
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE required_advance numeric(14,2); goods jsonb;
BEGIN
  -- The trusted server (service role) may record Zoho bookkeeping on any order, and nothing else.
  IF current_user = 'service_role'
    AND (to_jsonb(NEW) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at']) THEN
    RETURN NEW;
  END IF;

  IF OLD.order_status = 'Cancelled' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened';
  END IF;
  -- Changed 12 Nov 2026: admin_place_ended_checkout (flag app.revive_checkout) takes a checkout that ended without payment
  -- back to Awaiting Payment for a moment, when the admin has found its payment in the bank; it is paid in the same step.
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (current_setting('app.revive_checkout', true) = 'on' AND NEW.order_status = 'Awaiting Payment') THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  -- Added 14 Nov 2026: an order holding units of a pre-order batch is not packed or handed over before that batch is
  -- matched to its bill, for anyone (Accepted stays allowed). A change applied from Zoho is the record: allowed, and the
  -- admins are told.
  IF NEW.order_status IN ('Packed', 'Dispatched', 'Out for Delivery', 'Delivered')
    AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    goods := private.order_waiting_goods(NEW.id);
    IF COALESCE((goods->>'waiting')::numeric, 0) > 0 THEN
      IF current_setting('app.zoho_inbound', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'Order % is waiting for goods: % has not arrived (expected %). It can be packed or handed over once its bill is matched.',
          NEW.order_no, COALESCE((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(goods->'codes') x), 'its pre-order batch'),
          COALESCE(to_char((goods->>'expected_date')::date, 'DD Mon YYYY'), '?');
      END IF;
      PERFORM private.preorder_zoho_moved_alert(NEW.id, NEW.order_no, NEW.order_status);
    END IF;
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  -- Changed 11 Nov 2026: so may an admin, through admin_cancel_order (flag app.admin_cancel), saying whether the goods came back.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on'
    AND current_setting('app.admin_cancel', true) IS DISTINCT FROM 'on' AND EXISTS (
    SELECT 1 FROM public.order_vendor_fulfillments f
    WHERE f.order_id = OLD.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Orders cannot be cancelled after any vendor has dispatched';
  END IF;
  -- A held (unpaid) request leaves "Awaiting Payment" only by being paid in full or expiring.
  IF OLD.order_status = 'Awaiting Payment' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (NEW.order_status = 'Payment Confirmed' AND NEW.payment_status = 'Paid')
    AND NOT (NEW.order_status IN ('Payment Expired', 'Cancelled')) THEN
    RAISE EXCEPTION 'Confirm the full payment before this order moves on';
  END IF;
  IF NEW.order_status = 'Payment Expired' AND OLD.order_status <> 'Payment Expired'
    AND current_setting('app.payment_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected payment workflow';
  END IF;

  -- Added 10 Nov 2026 (20261110120000_delivery_paper_qr.sql): every item on the order's delivery note was handed over
  -- at the godown on a QR scan, so delivery_paper_scan marks it Delivered. Only the status may change.
  IF current_setting('app.delivery_handover', true) = 'on'
    AND NEW.order_status = 'Delivered'
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- Added 13 Nov 2026 (20261113230000_godown_location_partner_confirm.sql): partner_confirm_order (flag app.partner_confirm)
  -- lets the active channel partner of the order's own godown confirm it, as an admin's "Mark as Confirmed" does: only
  -- from Placed or Payment Confirmed, only to Accepted, only when the payment is settled in full, and nothing else changes.
  IF current_setting('app.partner_confirm', true) = 'on'
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Accepted'
    AND OLD.payment_status = 'Paid'
    AND OLD.branch_id IS NOT NULL AND OLD.branch_id = public.current_partner_branch()
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- The pay-first functions (hold, auto-confirm from the bank alert, expiry) check everything themselves.
  IF current_setting('app.payment_workflow', true) = 'on' THEN RETURN NEW; END IF;

  -- Changes applied from Zoho by the SECURITY DEFINER Zoho functions below (shipment milestones,
  -- Zoho cancellations). The cancellation checks above still apply to them.
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;

  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;

  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable']) THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND NEW.order_status = 'Cancelled'
    AND EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    ) THEN
    RAISE EXCEPTION 'Customer cancellation is unavailable after a vendor has started fulfilment';
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed')
    AND NEW.order_status = 'Cancelled'
    AND COALESCE(OLD.paid_amount, 0) = 0
    AND OLD.payment_status NOT IN ('Paid', 'Partially Paid')
    AND NEW.advance_due = 0
    AND NEW.balance_due = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    )
    AND (to_jsonb(NEW) - ARRAY['order_status','advance_due','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','advance_due','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;

  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids) THEN
    required_advance := round(OLD.total * COALESCE((
      SELECT NULLIF(value->>'advance_percent', '')::numeric
      FROM public.settings WHERE key = 'order'
    ), 30) / 100, 2);
    IF OLD.order_status = 'Payment Confirmed' AND NEW.order_status = 'Accepted'
      AND OLD.paid_amount >= required_advance THEN
      RETURN NEW;
    END IF;
    IF (OLD.order_status = 'Accepted' AND NEW.order_status = 'Packed')
      OR (OLD.order_status = 'Packed' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Dispatched')
      OR (OLD.order_status = 'Dispatched' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Out for Delivery')
      OR (OLD.order_status = 'Out for Delivery' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Delivered') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Vendor order updates must follow the next allowed step, meet the required advance, and be fully paid before dispatch';
END
$function$;

-- admin_delete_order_all_details: live definition (20261111200000) + an order waiting for a lot's bags is cancelled first.
CREATE OR REPLACE FUNCTION public.admin_delete_order_all_details(_order_no text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  blocker text;
  items integer;
  who_name text;
  utr_list text;
  copy jsonb;
  goods jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this order is being deleted'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order no longer exists.'; END IF;
  -- Added 14 Nov 2026.
  goods := private.order_waiting_goods(o.id);
  IF COALESCE((goods->>'waiting')::numeric, 0) > 0 THEN
    RAISE EXCEPTION 'Order % is waiting for bags of batch %. Cancel it (with refund) first.', o.order_no,
      COALESCE((SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(goods->'codes') x), '?');
  END IF;
  blocker := private.order_delete_all_reason(o.id);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%', blocker; END IF;

  SELECT count(*) INTO items FROM public.order_items WHERE order_id = o.id;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who_name FROM public.profiles p WHERE p.id = auth.uid();
  SELECT string_agg(s.utr || ' (' || s.status || COALESCE(': ' || s.note, '') || ')', '; ' ORDER BY s.submitted_at) INTO utr_list
    FROM public.upi_payment_submissions s WHERE s.order_id = o.id;
  copy := jsonb_build_object(
    'order', to_jsonb(o),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.payments p WHERE p.order_id = o.id), '[]'::jsonb),
    'refunds', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.order_refunds r WHERE r.order_id = o.id), '[]'::jsonb),
    'cancellation', (SELECT to_jsonb(c) FROM public.order_cancellations c WHERE c.order_id = o.id),
    'utrs', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.upi_payment_submissions s WHERE s.order_id = o.id), '[]'::jsonb),
    'bank_credits', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.bank_credits c WHERE c.order_id = o.id), '[]'::jsonb),
    'stock_taken', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id WHERE i.order_id = o.id), '[]'::jsonb),
    'zoho_invoices', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.zoho_order_invoices i WHERE i.order_id = o.id), '[]'::jsonb),
    'commissions', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.partner_commissions c WHERE c.order_id = o.id), '[]'::jsonb));
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name, utrs,
    zoho_salesorder_id, zoho_order_status, snapshot)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, why, auth.uid(), COALESCE(who_name, ''), left(COALESCE(utr_list, ''), 1000),
    COALESCE(o.zoho_salesorder_id, ''), COALESCE(o.zoho_order_status, ''), copy);

  -- Deleting the items would queue a Zoho push for an order that is about to be gone.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$;

-- ================================================================ grants of the helpers
-- Every private helper: no one but its owner (the definer functions above call them).
DO $grants$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND p.proname IN ('ist_today', 'preorder_on', 'preorder_grace', 'preorder_require_ack', 'qty_text',
              'godown_name', 'product_name', 'zoho_time', 'bill_after', 'lot_accepting', 'lot_sellable', 'pair_lots', 'trim_detail',
              'stock_master_since', 'waiting_lines', 'waiting_units', 'lot_units_waiting', 'snapshot_for', 'reading_for', 'reading_waiting',
              'lot_event', 'notify_admins', 'notify_customer', 'lot_codes', 'sync_product_total', 'set_pair_total', 'shift_pair_total',
              'refresh_pair', 'order_waiting_goods', 'watch_step', 'apply_reading', 'reading_rise', 'watch_open', 'watch_close_if_done',
              'branch_stock_derive', 'lot_allocation_changed', 'lot_row_changed', 'take_order_line', 'match_line_check',
              'move_lot_allocations', 'split_lot_tags', 'merge_lot_tags', 'match_incoming_line', 'lock_products',
              'preorder_zoho_moved_alert',
              -- review fixes (14 Nov 2026)
              'reading_lines', 'reading_heal_cap', 'push_in_flight', 'zoho_units', 'preorder_write_begin', 'preorder_write_end',
              'push_blocker', 'transfer_unfinished') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f.sig);
  END LOOP;
END $grants$;
-- The order guard runs as whoever updates the order (it is not SECURITY DEFINER): it may ask these two.
GRANT EXECUTE ON FUNCTION private.order_waiting_goods(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.preorder_zoho_moved_alert(uuid, text, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
