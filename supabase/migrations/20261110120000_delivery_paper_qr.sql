-- QR codes on delivery notes and delivery slips (client, 10 Nov 2026):
--   "Delivery slips with unique qr so scanned which is in system recognized then green signal duplicate delivery
--    copies will be avoided if we use this system for delivery notes"
-- and the client's answers the same day: the first print stays the original, later prints are duplicates numbered
-- from 1; an admin can reopen a handed-over item with a reason; staff and channel partners both hand over, on any
-- phone, and every scan shows who did it and on which phone; the note's scan lets them tick which items go; when
-- everything is handed over the order is marked Delivered; the scan screen is in English and Kannada.
--
-- How it works:
--   * Every press of Print gives each paper it prints (the note, and each item's slip) a new random code. The QR on
--     the paper is a link holding that code. The code is 22 characters of a random UUID (122 random bits), so it
--     can't be guessed or worked out from an order or note number. Only its SHA-256 hash is kept here: nothing in the
--     database, or in a copy of it, can be turned back into a working QR.
--   * The first print of each paper is its ORIGINAL, the only paper that can hand goods over. Every later print is a
--     DUPLICATE, numbered 1, 2, ... per paper: it has its own QR, which says "duplicate, do not hand over".
--   * A lost original, or one that never came out of the printer: an administrator prints a REPLACEMENT ORIGINAL with
--     a reason. That cancels the previous original's QR ("original replaced") and the new paper is the one that works.
--   * The goods on each item line are handed over once. delivery_handovers allows one row per note line and round
--     (a unique key), and the note row is locked from the check to the insert, so two people scanning at the same
--     moment can't both record it: the second is told it was already handed over, and by whom. Green appears only
--     after the handover is recorded.
--   * An administrator can reopen a handed-over item, with a reason (delivery_handover_reopens). The item can then be
--     handed over again, in a new round, on its original. Nothing is changed or deleted to do it.
--   * A slip covers its own item. The note covers all items: the person ticks which are being handed over, and only
--     those are recorded. If one of them went meanwhile, nothing is recorded and they are told which.
--   * When every item on the note is handed over, the order is marked Delivered (guard_order_mutation lets this one
--     change through, flag app.delivery_handover). The order change queues the Zoho sync, like an admin's change.
--   * Each scan runs the delivery-note payment check again (private.delivery_note_state). A cancelled, refunded,
--     stopped or Zoho-void order, or one whose items or invoice changed after the note, is refused.
--   * Administrators scan anywhere. Active godown staff and active channel partners scan their own godown's papers,
--     on any phone. The scan records whether it was made on the godown's registered phone (godown_devices).
--   * Every scan is kept in delivery_scans: who (and as what), when, which godown and phone, which paper and copy, and
--     the answer, including codes that are not in the system.
-- record_delivery_print and delivery_note_register are the definitions from 20261103090000_delivery_notes.sql, and
-- guard_order_mutation the one from 20261108100000_partner_payouts_and_money_tools.sql, changed only where these
-- comments say.

BEGIN;

CREATE TABLE IF NOT EXISTS public.delivery_paper_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  -- The press of Print that made this paper: one code per printed paper.
  print_event_id bigint NOT NULL UNIQUE REFERENCES public.delivery_note_events(id) ON DELETE RESTRICT,
  doc text NOT NULL CHECK (doc IN ('note', 'slip')),
  slip_line integer CHECK (slip_line IS NULL OR slip_line >= 1),
  copy_no integer NOT NULL CHECK (copy_no >= 1),
  -- original: the paper's first print. duplicate: any later print (numbered from 1). replacement: a new original an
  -- administrator printed, with a reason, in place of the one before it.
  kind text NOT NULL CHECK (kind IN ('original', 'duplicate', 'replacement')),
  duplicate_no integer CHECK (duplicate_no IS NULL OR duplicate_no >= 1),
  replaces_code_id bigint REFERENCES public.delivery_paper_codes(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  printed_by text NOT NULL DEFAULT '',
  -- sha256 of the code, in hex. The code itself is never stored.
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  printed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((doc = 'slip') = (slip_line IS NOT NULL)),
  CHECK ((kind = 'duplicate') = (duplicate_no IS NOT NULL)),
  CHECK ((kind = 'replacement') = (replaces_code_id IS NOT NULL)),
  CHECK (kind <> 'replacement' OR length(btrim(reason)) >= 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_paper_codes_copy_idx
  ON public.delivery_paper_codes (note_id, doc, COALESCE(slip_line, 0), copy_no);
-- One first original per paper, one number per duplicate, and an original is replaced once.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_paper_codes_original_idx
  ON public.delivery_paper_codes (note_id, doc, COALESCE(slip_line, 0)) WHERE kind = 'original';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_paper_codes_duplicate_idx
  ON public.delivery_paper_codes (note_id, doc, COALESCE(slip_line, 0), duplicate_no) WHERE kind = 'duplicate';
CREATE UNIQUE INDEX IF NOT EXISTS delivery_paper_codes_replaces_idx
  ON public.delivery_paper_codes (replaces_code_id) WHERE replaces_code_id IS NOT NULL;

-- One row per item line and round: the unique key is what makes a handover single-use. A new round starts only
-- after an administrator reopened the item.
CREATE TABLE IF NOT EXISTS public.delivery_handovers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  slip_line integer NOT NULL CHECK (slip_line >= 1),
  round integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  -- The paper that was scanned: the slip itself, or the note.
  code_id bigint NOT NULL REFERENCES public.delivery_paper_codes(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'staff', 'partner')),
  -- The godown of the staff member or partner who handed it over. Empty for an administrator.
  branch_id text,
  branch_name text NOT NULL DEFAULT '',
  -- On the godown's registered phone (godown_devices), or on their own.
  device_registered boolean NOT NULL DEFAULT false,
  device_label text NOT NULL DEFAULT '',
  -- The payment check at that moment, and whether Zoho was read just then or the website's last reading was used.
  gate_code text NOT NULL,
  gate_source text NOT NULL,
  handed_over_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, slip_line, round)
);

-- An administrator's reopening of a handed-over item, with the reason. The handover row stays as it was.
CREATE TABLE IF NOT EXISTS public.delivery_handover_reopens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handover_id bigint NOT NULL UNIQUE REFERENCES public.delivery_handovers(id) ON DELETE RESTRICT,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  slip_line integer NOT NULL CHECK (slip_line >= 1),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  reopened_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_scans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_id bigint REFERENCES public.delivery_paper_codes(id) ON DELETE RESTRICT,
  note_id uuid REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  -- The start of the scanned code's hash. Groups repeated scans of one unknown code without keeping the code.
  code_hint text NOT NULL DEFAULT '',
  action text NOT NULL CHECK (action IN ('check', 'handover')),
  result text NOT NULL CHECK (result IN ('unknown', 'ready', 'handed_over', 'already_handed_over', 'partly_handed_over', 'duplicate', 'replaced', 'order_problem', 'other_godown')),
  doc text CHECK (doc IN ('note', 'slip')),
  slip_line integer,
  copy_no integer,
  paper_kind text,
  duplicate_no integer,
  -- The items ticked on a note, and the item lines this scan handed over.
  asked integer[] NOT NULL DEFAULT '{}',
  lines integer[] NOT NULL DEFAULT '{}',
  gate_code text,
  gate_source text,
  -- This handover was the last item, so the order was marked Delivered (from order_status_before).
  order_delivered boolean NOT NULL DEFAULT false,
  order_status_before text,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'staff', 'partner')),
  branch_id text,
  branch_name text NOT NULL DEFAULT '',
  device_registered boolean NOT NULL DEFAULT false,
  device_label text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_scans_note_idx ON public.delivery_scans (note_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS delivery_scans_time_idx ON public.delivery_scans (occurred_at DESC);

-- Supabase's default privileges hand new tables and sequences to anon, authenticated and service_role, so take them
-- all back. Writes go only through the functions below, which run as their owner.
REVOKE ALL ON public.delivery_paper_codes, public.delivery_handovers, public.delivery_handover_reopens, public.delivery_scans FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.delivery_paper_codes_id_seq, public.delivery_handovers_id_seq, public.delivery_handover_reopens_id_seq, public.delivery_scans_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.delivery_handovers, public.delivery_handover_reopens, public.delivery_scans TO authenticated, service_role;
-- The hashes are read only by the functions below.
GRANT SELECT (id, note_id, print_event_id, doc, slip_line, copy_no, kind, duplicate_no, replaces_code_id, reason, printed_by, printed_at)
  ON public.delivery_paper_codes TO authenticated, service_role;

ALTER TABLE public.delivery_paper_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_handover_reopens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_paper_codes_admin_read ON public.delivery_paper_codes;
CREATE POLICY delivery_paper_codes_admin_read ON public.delivery_paper_codes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_handovers_admin_read ON public.delivery_handovers;
CREATE POLICY delivery_handovers_admin_read ON public.delivery_handovers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_handover_reopens_admin_read ON public.delivery_handover_reopens;
CREATE POLICY delivery_handover_reopens_admin_read ON public.delivery_handover_reopens FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_scans_admin_read ON public.delivery_scans;
CREATE POLICY delivery_scans_admin_read ON public.delivery_scans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Nothing is ever changed or removed (the function is from 20261103090000_delivery_notes.sql).
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_paper_codes', 'delivery_handovers', 'delivery_handover_reopens', 'delivery_scans'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_permanent', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent()', t || '_permanent', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_permanent_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent()', t || '_permanent_truncate', t);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------- codes and papers
-- A new code: the 16 bytes of a random UUID (gen_random_uuid uses the server's strong random source) in URL-safe
-- base64, 22 characters.
CREATE OR REPLACE FUNCTION private.delivery_new_code()
RETURNS text LANGUAGE sql VOLATILE AS $function$
  SELECT rtrim(translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), '=')
$function$;
REVOKE ALL ON FUNCTION private.delivery_new_code() FROM PUBLIC, anon, authenticated;

-- sha256 in hex: the paper codes, and the godown phones' tokens (godown_devices.token_hash is made the same way).
CREATE OR REPLACE FUNCTION private.delivery_code_hash(_code text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT encode(sha256(convert_to(COALESCE(_code, ''), 'UTF8')), 'hex')
$function$;
REVOKE ALL ON FUNCTION private.delivery_code_hash(text) FROM PUBLIC, anon, authenticated;

-- Whether an item line is handed over now: a handover that no administrator has reopened.
CREATE OR REPLACE FUNCTION private.delivery_line_done(_note_id uuid, _line integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.delivery_handovers h
    WHERE h.note_id = _note_id AND h.slip_line = _line
      AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = h.id))
$function$;
REVOKE ALL ON FUNCTION private.delivery_line_done(uuid, integer) FROM PUBLIC, anon, authenticated;

-- Each item line handed over now: { "2": { "at", "by", "role", "godown", "registered_phone", "round" } }.
CREATE OR REPLACE FUNCTION private.delivery_handover_map(_note_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(h.slip_line::text, jsonb_build_object(
    'at', h.handed_over_at, 'by', h.actor_name, 'role', h.actor_role, 'godown', h.branch_name,
    'registered_phone', h.device_registered, 'round', h.round)), '{}'::jsonb)
  FROM public.delivery_handovers h
  WHERE h.note_id = _note_id AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = h.id)
$function$;
REVOKE ALL ON FUNCTION private.delivery_handover_map(uuid) FROM PUBLIC, anon, authenticated;

-- The paper that may hand goods over now: the newest original or replacement original of that note or slip.
CREATE OR REPLACE FUNCTION private.delivery_current_original(_note_id uuid, _doc text, _line integer)
RETURNS public.delivery_paper_codes
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT * FROM public.delivery_paper_codes c
  WHERE c.note_id = _note_id AND c.doc = _doc AND COALESCE(c.slip_line, 0) = COALESCE(_line, 0) AND c.kind IN ('original', 'replacement')
  ORDER BY c.id DESC LIMIT 1
$function$;
REVOKE ALL ON FUNCTION private.delivery_current_original(uuid, text, integer) FROM PUBLIC, anon, authenticated;

/*
 * Files one printed paper under its code: the original if the paper has none yet, a replacement original when the
 * administrator gave a reason, otherwise the next duplicate. Returns how the paper must be labelled.
 */
CREATE OR REPLACE FUNCTION private.delivery_issue_paper(_note_id uuid, _event_id bigint, _doc text, _line integer, _copy integer, _code text, _who text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  cur public.delivery_paper_codes%ROWTYPE := private.delivery_current_original(_note_id, _doc, _line);
  paper_kind text;
  dup integer;
BEGIN
  IF cur.id IS NULL THEN paper_kind := 'original';
  ELSIF COALESCE(_reason, '') <> '' THEN paper_kind := 'replacement';
  ELSE
    paper_kind := 'duplicate';
    SELECT COALESCE(max(c.duplicate_no), 0) + 1 INTO dup FROM public.delivery_paper_codes c
      WHERE c.note_id = _note_id AND c.doc = _doc AND COALESCE(c.slip_line, 0) = COALESCE(_line, 0) AND c.kind = 'duplicate';
  END IF;
  INSERT INTO public.delivery_paper_codes (note_id, print_event_id, doc, slip_line, copy_no, kind, duplicate_no, replaces_code_id, reason, printed_by, code_hash)
    VALUES (_note_id, _event_id, _doc, _line, _copy, paper_kind, dup, CASE WHEN paper_kind = 'replacement' THEN cur.id END,
      CASE WHEN paper_kind = 'replacement' THEN _reason ELSE '' END, _who, private.delivery_code_hash(_code));
  RETURN jsonb_build_object('kind', paper_kind, 'duplicate_no', dup,
    'original_printed_at', CASE WHEN cur.id IS NOT NULL THEN cur.printed_at END,
    'replaces', CASE WHEN paper_kind = 'replacement' THEN jsonb_build_object('kind', cur.kind, 'printed_at', cur.printed_at, 'printed_by', cur.printed_by) END,
    'reason', CASE WHEN paper_kind = 'replacement' THEN _reason ELSE '' END);
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_issue_paper(uuid, bigint, text, integer, integer, text, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- print: now with a code per paper
/*
 * Records one press of Print: who, when, and which copy each paper is. The time returned is the time printed on
 * the paper.
 * Changed: each paper printed gets a new code, returned once (note_code, slip_codes) and kept only as a hash, and is
 * filed as the paper's original (its first print), a duplicate (any later print), or, with _replace_reason, a
 * replacement original that cancels the one before it (only for goods still to go). note_paper and slip_papers say
 * which, for the paper's label. Also returns which lines are handed over already, so their papers say so.
 * The note is locked FOR NO KEY UPDATE as before, which also makes a print wait for a handover on the same note.
 * The new last argument has a default, so the code live before this migration keeps working.
 */
DROP FUNCTION IF EXISTS public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text);
CREATE OR REPLACE FUNCTION public.record_delivery_print(_note_id uuid, _note boolean, _slip_lines integer[], _zoho jsonb, _actor uuid, _actor_name text, _replace_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n public.delivery_notes%ROWTYPE;
  who text := left(btrim(COALESCE(_actor_name, '')), 120);
  why text := left(btrim(COALESCE(_replace_reason, '')), 300);
  gate jsonb;
  code text;
  line_count integer;
  line integer;
  copy integer;
  note_copy integer;
  slip_copies jsonb := '{}'::jsonb;
  lines integer[] := COALESCE(_slip_lines, '{}');
  event_id bigint;
  paper_code text;
  note_code text;
  slip_codes jsonb := '{}'::jsonb;
  note_paper jsonb;
  slip_papers jsonb := '{}'::jsonb;
  handed jsonb;
BEGIN
  IF NOT private.delivery_actor_is_admin(_actor) THEN RAISE EXCEPTION 'Only administrators can print a delivery note'; END IF;
  IF who = '' THEN RAISE EXCEPTION 'Who printed the delivery note must be recorded'; END IF;
  IF _replace_reason IS NOT NULL AND length(why) < 3 THEN RAISE EXCEPTION 'Enter the reason for the replacement original'; END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE id = _note_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery note not found'; END IF;
  line_count := jsonb_array_length(n.snapshot->'items');
  IF NOT COALESCE(_note, false) AND cardinality(lines) = 0 THEN RAISE EXCEPTION 'Choose what to print'; END IF;
  handed := private.delivery_handover_map(n.id);
  IF why <> '' THEN
    IF COALESCE(_note, false) AND (SELECT count(*) FROM jsonb_object_keys(handed)) >= line_count THEN
      RAISE EXCEPTION 'Every item on this note is already handed over, so it needs no replacement original';
    END IF;
    FOR line IN SELECT DISTINCT l FROM unnest(lines) AS l ORDER BY 1 LOOP
      IF handed ? line::text THEN RAISE EXCEPTION 'Item % is already handed over, so its slip needs no replacement original', line; END IF;
    END LOOP;
  END IF;
  gate := private.delivery_note_state(n.order_id, COALESCE(_zoho, jsonb_build_object('read', false, 'error', 'Zoho was not read just now')));
  code := gate->>'code';
  IF COALESCE(_note, false) THEN
    SELECT COALESCE(max(copy_no), 0) + 1 INTO note_copy FROM public.delivery_note_events
      WHERE note_id = n.id AND kind = 'printed' AND doc = 'note';
    INSERT INTO public.delivery_note_events (note_id, kind, doc, copy_no, gate_code, detail, actor_id, actor_name)
      VALUES (n.id, 'printed', 'note', note_copy, code, CASE WHEN why <> '' THEN 'Replacement original: ' || why ELSE '' END, _actor, who)
      RETURNING id INTO event_id;
    note_code := private.delivery_new_code();
    note_paper := private.delivery_issue_paper(n.id, event_id, 'note', NULL, note_copy, note_code, who, why);
  END IF;
  FOR line IN SELECT DISTINCT l FROM unnest(lines) AS l ORDER BY 1 LOOP
    IF line IS NULL OR line < 1 OR line > line_count THEN RAISE EXCEPTION 'This note has no slip %', line; END IF;
    SELECT COALESCE(max(copy_no), 0) + 1 INTO copy FROM public.delivery_note_events
      WHERE note_id = n.id AND kind = 'printed' AND doc = 'slip' AND slip_line = line;
    INSERT INTO public.delivery_note_events (note_id, kind, doc, slip_line, copy_no, gate_code, detail, actor_id, actor_name)
      VALUES (n.id, 'printed', 'slip', line, copy, code, CASE WHEN why <> '' THEN 'Replacement original: ' || why ELSE '' END, _actor, who)
      RETURNING id INTO event_id;
    paper_code := private.delivery_new_code();
    slip_papers := slip_papers || jsonb_build_object(line::text, private.delivery_issue_paper(n.id, event_id, 'slip', line, copy, paper_code, who, why));
    slip_copies := slip_copies || jsonb_build_object(line::text, copy);
    slip_codes := slip_codes || jsonb_build_object(line::text, paper_code);
  END LOOP;
  RETURN jsonb_build_object('printed_at', now(), 'note_copy', note_copy, 'slip_copies', slip_copies, 'gate', gate,
    'note_code', note_code, 'slip_codes', slip_codes, 'note_paper', note_paper, 'slip_papers', slip_papers, 'handovers', handed);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text, text) TO service_role;

-- ---------------------------------------------------------------- scan
-- The order a code belongs to, so the server knows which order to read from Zoho before a handover. NULL for a code
-- the system did not make. Service role only, and the server asks only for a signed-in scanner.
CREATE OR REPLACE FUNCTION public.delivery_paper_order_no(_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT n.order_no FROM public.delivery_paper_codes c JOIN public.delivery_notes n ON n.id = c.note_id
  WHERE COALESCE(_code, '') ~ '^[A-Za-z0-9_-]{22}$' AND c.code_hash = private.delivery_code_hash(_code)
$function$;
REVOKE ALL ON FUNCTION public.delivery_paper_order_no(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_paper_order_no(text) TO service_role;

/*
 * A scan of a delivery note's or slip's QR. _handover false only checks; true records the handover, if the paper may
 * be used now, of the slip's item, or of the items ticked on the note (_lines). Either way the scan is kept.
 * _zoho is what the server read from Zoho Books just now for a handover. When Zoho could not be read (or for a check)
 * the website's last reading is used, and the handover row says which. _device is the godown phone's token, if the
 * phone has one. Service role only: it takes a Zoho reading.
 *
 * Answers, first match wins:
 *   unknown              not a code the system made (forged, mistyped or damaged)                      red
 *   already_handed_over  every item this paper covers is handed over                                   red
 *   duplicate            a duplicate copy: only the original hands goods over                         red
 *   replaced             an original an administrator replaced                                         red
 *   order_problem        the payment check is no longer clean, or the order is void in Zoho             red/amber
 *   other_godown         staff or a partner of another godown                                          amber
 *   ready                genuine original, items still to go (check only)                              not green yet
 *   partly_handed_over   some ticked items went meanwhile: nothing recorded, tick again                 amber
 *   handed_over          recorded now: hand over the goods                                             green
 * When the handover leaves nothing on the note to go, the order is marked Delivered (order_delivered).
 */
CREATE OR REPLACE FUNCTION public.delivery_paper_scan(_code text, _handover boolean, _zoho jsonb, _actor uuid, _lines integer[] DEFAULT NULL, _device text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who_role text;
  who_name text;
  who_branch text;
  who_branch_name text;
  dev_branch text;
  dev_label text := '';
  dev_registered boolean := false;
  given text := left(btrim(COALESCE(_code, '')), 200);
  hash text;
  c public.delivery_paper_codes%ROWTYPE;
  cur public.delivery_paper_codes%ROWTYPE;
  nxt public.delivery_paper_codes%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  o public.orders%ROWTYPE;
  o_void boolean;
  line_count integer;
  scope integer[];
  open_lines integer[];
  asked integer[] := '{}';
  reading jsonb;
  source text;
  gate jsonb;
  problem boolean;
  note_branch text;
  result text;
  handed integer[] := '{}';
  delivered boolean := false;
  status_before text;
  scan_id bigint;
  verb text := CASE WHEN COALESCE(_handover, false) THEN 'handover' ELSE 'check' END;
BEGIN
  -- Who is scanning: an administrator, an active godown employee or an active channel partner. public.has_role is
  -- false for the service role (auth.uid() is NULL there), so each is looked up directly.
  IF private.delivery_actor_is_admin(_actor) THEN
    who_role := 'admin';
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), '')) INTO who_name FROM public.profiles p WHERE p.id = _actor;
    who_name := COALESCE(who_name, 'Admin ' || left(_actor::text, 8));
    who_branch_name := '';
  ELSE
    SELECT 'staff', e.name, e.branch_id, COALESCE(b.name, e.branch_id)
      INTO who_role, who_name, who_branch, who_branch_name
      FROM public.staff_employees e LEFT JOIN public.branches b ON b.id = e.branch_id
      WHERE e.user_id = _actor AND e.status = 'active';
    IF who_role IS NULL THEN
      SELECT 'partner', p.name, p.branch_id, COALESCE(b.name, p.branch_id)
        INTO who_role, who_name, who_branch, who_branch_name
        FROM public.channel_partners p LEFT JOIN public.branches b ON b.id = p.branch_id
        WHERE p.user_id = _actor AND p.status = 'active';
    END IF;
    IF who_role IS NULL THEN RAISE EXCEPTION 'Only godown staff, channel partners and administrators can check delivery papers'; END IF;
  END IF;
  -- Any phone may scan; the scan says whether it was the godown's registered phone (of the scanner's own godown).
  IF btrim(COALESCE(_device, '')) <> '' THEN
    SELECT d.branch_id, d.label INTO dev_branch, dev_label FROM public.godown_devices d
      WHERE d.token_hash = private.delivery_code_hash(btrim(_device)) AND d.active;
    dev_registered := dev_branch IS NOT NULL AND (who_branch IS NULL OR dev_branch = who_branch);
    dev_label := CASE WHEN dev_registered THEN COALESCE(dev_label, '') ELSE '' END;
  END IF;

  hash := private.delivery_code_hash(given);
  IF given ~ '^[A-Za-z0-9_-]{22}$' THEN
    SELECT * INTO c FROM public.delivery_paper_codes WHERE code_hash = hash;
  END IF;
  IF c.id IS NULL THEN
    INSERT INTO public.delivery_scans (code_hint, action, result, actor_id, actor_name, actor_role, branch_id, branch_name, device_registered, device_label)
      VALUES (left(hash, 12), verb, 'unknown', _actor, who_name, who_role, who_branch, who_branch_name, dev_registered, dev_label)
      RETURNING id INTO scan_id;
    RETURN jsonb_build_object('result', 'unknown', 'action', verb, 'scan_id', scan_id, 'scanned_at', now(),
      'by', who_name, 'role', who_role, 'godown', who_branch_name,
      'device', jsonb_build_object('registered', dev_registered, 'label', dev_label));
  END IF;

  -- From here to the end the note is locked: a print or another handover of it waits.
  SELECT * INTO n FROM public.delivery_notes WHERE id = c.note_id FOR NO KEY UPDATE;
  SELECT * INTO o FROM public.orders WHERE id = n.order_id;
  o_void := lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled');
  cur := private.delivery_current_original(n.id, c.doc, c.slip_line);
  IF c.kind <> 'duplicate' AND c.id <> cur.id THEN
    SELECT * INTO nxt FROM public.delivery_paper_codes WHERE replaces_code_id = c.id;
  END IF;
  line_count := jsonb_array_length(n.snapshot->'items');
  scope := CASE WHEN c.doc = 'slip' THEN ARRAY[c.slip_line] ELSE ARRAY(SELECT generate_series(1, line_count)) END;
  open_lines := ARRAY(SELECT l FROM unnest(scope) l WHERE NOT private.delivery_line_done(n.id, l) ORDER BY l);
  IF COALESCE(_handover, false) THEN
    IF c.doc = 'slip' THEN asked := scope;
    ELSE
      asked := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(_lines, '{}')) x WHERE x IS NOT NULL ORDER BY x);
      IF cardinality(asked) = 0 THEN RAISE EXCEPTION 'Tick the items being handed over'; END IF;
      IF EXISTS (SELECT 1 FROM unnest(asked) x WHERE x < 1 OR x > line_count) THEN RAISE EXCEPTION 'This note has no such item'; END IF;
    END IF;
  END IF;

  IF COALESCE(_handover, false) AND COALESCE(_zoho->>'read', '') = 'true' AND COALESCE(_zoho->>'source', '') <> 'last_reading' THEN
    reading := _zoho;
    source := 'zoho_now';
  ELSE
    reading := private.delivery_note_last_reading(n.order_id);
    source := 'last_reading';
  END IF;
  gate := private.delivery_note_state(n.order_id, reading);
  problem := COALESCE(gate->>'code', '') <> 'paid' OR COALESCE((gate->>'items_changed')::boolean, false)
    OR COALESCE((gate->>'invoice_changed')::boolean, false) OR o_void;
  note_branch := NULLIF(n.snapshot->'godown'->>'id', '');

  IF cardinality(open_lines) = 0 THEN result := 'already_handed_over';
  ELSIF c.kind = 'duplicate' THEN result := 'duplicate';
  ELSIF c.id <> cur.id THEN result := 'replaced';
  ELSIF problem THEN result := 'order_problem';
  ELSIF who_role <> 'admin' AND who_branch IS DISTINCT FROM note_branch THEN result := 'other_godown';
  ELSIF NOT COALESCE(_handover, false) THEN result := 'ready';
  -- All or nothing: the screen showed these items as still to go, so if one went meanwhile the list is out of date.
  ELSIF EXISTS (SELECT 1 FROM unnest(asked) x WHERE NOT (x = ANY (open_lines))) THEN result := 'partly_handed_over';
  ELSE
    -- The unique key on (note_id, slip_line, round) stops a second handover even if the lock above were ever
    -- bypassed: the insert fails and nothing is recorded.
    INSERT INTO public.delivery_handovers (note_id, slip_line, round, code_id, actor_id, actor_name, actor_role, branch_id, branch_name,
        device_registered, device_label, gate_code, gate_source)
      SELECT n.id, x, (SELECT count(*) FROM public.delivery_handovers h WHERE h.note_id = n.id AND h.slip_line = x) + 1, c.id,
        _actor, who_name, who_role, who_branch, who_branch_name, dev_registered, dev_label, gate->>'code', source
      FROM unnest(asked) x;
    handed := asked;
    result := 'handed_over';
    -- Everything on the note handed over: the order is delivered (client, 10 Nov 2026), as if an admin set it.
    IF NOT EXISTS (SELECT 1 FROM generate_series(1, line_count) g WHERE NOT private.delivery_line_done(n.id, g))
       AND o.order_status IN ('Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery') THEN
      status_before := o.order_status;
      PERFORM set_config('app.delivery_handover', 'on', true);
      UPDATE public.orders SET order_status = 'Delivered' WHERE id = o.id;
      PERFORM set_config('app.delivery_handover', '', true);
      delivered := true;
    END IF;
  END IF;

  INSERT INTO public.delivery_scans (code_id, note_id, code_hint, action, result, doc, slip_line, copy_no, paper_kind, duplicate_no, asked, lines,
      gate_code, gate_source, order_delivered, order_status_before, actor_id, actor_name, actor_role, branch_id, branch_name, device_registered, device_label)
    VALUES (c.id, n.id, left(hash, 12), verb, result, c.doc, c.slip_line, c.copy_no, c.kind, c.duplicate_no, asked, handed,
      gate->>'code', source, delivered, status_before, _actor, who_name, who_role, who_branch, who_branch_name, dev_registered, dev_label)
    RETURNING id INTO scan_id;

  RETURN jsonb_build_object(
    'result', result, 'action', verb, 'scan_id', scan_id, 'scanned_at', now(),
    'by', who_name, 'role', who_role, 'godown', who_branch_name,
    'device', jsonb_build_object('registered', dev_registered, 'label', dev_label),
    'paper', jsonb_build_object('doc', c.doc, 'slip_line', c.slip_line, 'slips', line_count, 'copy_no', c.copy_no,
      'kind', c.kind, 'duplicate_no', c.duplicate_no, 'printed_at', c.printed_at, 'printed_by', c.printed_by,
      'original_kind', cur.kind, 'original_printed_at', cur.printed_at, 'original_printed_by', cur.printed_by,
      'replaced_at', nxt.printed_at, 'replaced_by', nxt.printed_by, 'replaced_reason', nxt.reason),
    'note', jsonb_build_object('note_no', n.note_no, 'order_no', n.order_no, 'invoice_number', n.invoice_number,
      'customer', COALESCE(NULLIF(n.snapshot->'customer'->>'business_name', ''), n.snapshot->'customer'->>'name', ''),
      'godown', COALESCE(n.snapshot->'godown'->>'name', ''), 'shipping_method', COALESCE(n.snapshot->>'shipping_method', ''),
      'generated_at', n.generated_at),
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'line', (i->>'line')::integer, 'name', i->>'name', 'qty', i->'qty', 'pack_size', COALESCE(i->>'pack_size', ''), 'stock_no', COALESCE(i->>'stock_no', ''),
        'handover', private.delivery_handover_map(n.id)->(i->>'line')) ORDER BY (i->>'line')::integer), '[]'::jsonb)
      FROM jsonb_array_elements(n.snapshot->'items') i WHERE (i->>'line')::integer = ANY (scope)),
    'asked', to_jsonb(asked),
    'handed_now', to_jsonb(handed),
    'order_delivered', delivered,
    'order_status_before', status_before,
    -- Only what the screen needs to say why not: no amounts.
    'gate', jsonb_build_object('code', gate->>'code', 'source', source, 'stop_reason', gate->'stop_reason',
      'items_changed', COALESCE((gate->>'items_changed')::boolean, false), 'invoice_changed', COALESCE((gate->>'invoice_changed')::boolean, false),
      'invoice_number', gate->>'invoice_number', 'zoho_void', o_void)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.delivery_paper_scan(text, boolean, jsonb, uuid, integer[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_paper_scan(text, boolean, jsonb, uuid, integer[], text) TO service_role;

/*
 * An administrator reopens a handed-over item, with a reason: it can be handed over again, on its original, in a new
 * round. The handover itself stays on record. The order's status is not changed: if the handover had made it
 * Delivered, Zoho has that too and would put it back, so the admin is told and corrects it where needed.
 */
CREATE OR REPLACE FUNCTION public.reopen_delivery_handover(_order_no text, _line integer, _reason text, _actor uuid, _actor_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n public.delivery_notes%ROWTYPE;
  h public.delivery_handovers%ROWTYPE;
  who text := left(btrim(COALESCE(_actor_name, '')), 120);
  why text := left(btrim(COALESCE(_reason, '')), 300);
  status text;
BEGIN
  IF NOT private.delivery_actor_is_admin(_actor) THEN RAISE EXCEPTION 'Only administrators can reopen a handed-over item'; END IF;
  IF who = '' THEN RAISE EXCEPTION 'Who reopened the item must be recorded'; END IF;
  IF length(why) < 3 THEN RAISE EXCEPTION 'Enter the reason for reopening'; END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE order_no = _order_no FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order has no delivery note'; END IF;
  SELECT * INTO h FROM public.delivery_handovers x
    WHERE x.note_id = n.id AND x.slip_line = _line AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = x.id);
  IF h.id IS NULL THEN RAISE EXCEPTION 'Item % is not handed over, so there is nothing to reopen', _line; END IF;
  INSERT INTO public.delivery_handover_reopens (handover_id, note_id, slip_line, reason, actor_id, actor_name)
    VALUES (h.id, n.id, _line, why, _actor, who);
  SELECT o.order_status INTO status FROM public.orders o WHERE o.id = n.order_id;
  RETURN jsonb_build_object('reopened', true, 'line', _line, 'order_status', status,
    'delivered_by_handover', EXISTS (SELECT 1 FROM public.delivery_scans s WHERE s.note_id = n.id AND s.order_delivered));
END;
$function$;
REVOKE ALL ON FUNCTION public.reopen_delivery_handover(text, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_delivery_handover(text, integer, text, uuid, text) TO service_role;

/*
 * Admin > Delivery Notes: every note, newest first, with the check run on what the website last knew of Zoho (no
 * Zoho call per row), so a note whose order was cancelled or refunded stands out.
 * Changed: also how many item lines are handed over now, the last handover, reopened items and refused scans.
 */
CREATE OR REPLACE FUNCTION public.delivery_note_register(_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(entry ORDER BY (entry->>'seq')::bigint DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'seq', n.seq, 'note_no', n.note_no, 'order_no', n.order_no, 'invoice_number', n.invoice_number,
      'customer', n.snapshot->'customer'->>'name', 'godown', n.snapshot->'godown'->>'name',
      'items', jsonb_array_length(n.snapshot->'items'),
      'generated_at', n.generated_at, 'generated_by', n.generated_by_name,
      'prints', (SELECT count(*) FROM public.delivery_note_events e WHERE e.note_id = n.id AND e.kind = 'printed'),
      'last_printed_at', (SELECT max(e.occurred_at) FROM public.delivery_note_events e WHERE e.note_id = n.id AND e.kind = 'printed'),
      'handed_over', (SELECT count(*) FROM jsonb_object_keys(private.delivery_handover_map(n.id))),
      'last_handed_over_at', (SELECT max(h.handed_over_at) FROM public.delivery_handovers h WHERE h.note_id = n.id),
      'reopened', (SELECT count(*) FROM public.delivery_handover_reopens r WHERE r.note_id = n.id),
      'refused_scans', (SELECT count(*) FROM public.delivery_scans s WHERE s.note_id = n.id AND s.result NOT IN ('ready', 'handed_over')),
      'state', private.delivery_note_state(n.order_id, private.delivery_note_last_reading(n.order_id))
    ) AS entry
    FROM public.delivery_notes n
    ORDER BY n.seq DESC
    LIMIT GREATEST(1, LEAST(COALESCE(_limit, 500), 2000))
  ) entries
$function$;
REVOKE ALL ON FUNCTION public.delivery_note_register(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_note_register(integer) TO service_role;

-- ---------------------------------------------------------------- the order guard: one new exception
-- From 20261108100000_partner_payouts_and_money_tools.sql. Added only the app.delivery_handover clause: the QR
-- handover (public.delivery_paper_scan, which checks everything itself) marks an order Delivered and changes nothing
-- else on it.
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE required_advance numeric(14,2);
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
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on' AND EXISTS (
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

COMMIT;

NOTIFY pgrst, 'reload schema';
