-- QR codes on delivery notes and delivery slips (client, 10 Nov 2026):
--   "Delivery slips with unique qr so scanned which is in system recognized then green signal duplicate delivery
--    copies will be avoided if we use this system for delivery notes"
--
-- How it works:
--   * Every press of Print gives each paper it prints (the note, and each item's slip) a new random code. The QR on
--     the paper is a link holding that code. The code is 22 characters of a random UUID (122 random bits), so it
--     can't be guessed or worked out from an order or note number. Only its SHA-256 hash is kept here: nothing in the
--     database, or in a copy of it, can be turned back into a working QR.
--   * Only the newest printed copy of each paper counts. Printing a paper again cancels the code on every earlier
--     copy of that paper (they scan as "replaced"), so there is never a second paper of the same slip that works.
--   * The goods on each item line are handed over once. delivery_handovers allows one row per note line (a unique
--     key), and the note row is locked from the check to the insert, so two people scanning at the same moment can't
--     both record it: the second is told it was already handed over, and by whom. Green appears only after the
--     handover is recorded.
--   * Scanning the note covers all its item lines; scanning a slip covers its own line.
--   * Each scan runs the delivery-note payment check again (private.delivery_note_state). A cancelled, refunded,
--     stopped or Zoho-void order, or one whose items or invoice changed after the note, is refused.
--   * Only administrators and active godown staff can scan. Staff can hand over only their own godown's goods.
--   * Every scan is kept in delivery_scans: who, when, which godown, which paper and what the answer was, including
--     codes that are not in the system. Nothing here can be changed or deleted, and nothing here writes to Zoho or
--     changes an order.
-- record_delivery_print and delivery_note_register are the definitions from 20261103090000_delivery_notes.sql,
-- changed only where these comments say.

BEGIN;

CREATE TABLE IF NOT EXISTS public.delivery_paper_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  -- The press of Print that made this paper: one code per printed paper.
  print_event_id bigint NOT NULL UNIQUE REFERENCES public.delivery_note_events(id) ON DELETE RESTRICT,
  doc text NOT NULL CHECK (doc IN ('note', 'slip')),
  slip_line integer CHECK (slip_line IS NULL OR slip_line >= 1),
  copy_no integer NOT NULL CHECK (copy_no >= 1),
  -- sha256 of the code, in hex. The code itself is never stored.
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  printed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((doc = 'slip') = (slip_line IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_paper_codes_copy_idx
  ON public.delivery_paper_codes (note_id, doc, COALESCE(slip_line, 0), copy_no);

-- One row per item line handed over, at most: the unique key is what makes a handover single-use.
CREATE TABLE IF NOT EXISTS public.delivery_handovers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  slip_line integer NOT NULL CHECK (slip_line >= 1),
  -- The paper that was scanned: the slip itself, or the note.
  code_id bigint NOT NULL REFERENCES public.delivery_paper_codes(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'staff')),
  -- The godown of the staff member who handed it over. Empty for an administrator.
  branch_id text,
  branch_name text NOT NULL DEFAULT '',
  -- The payment check at that moment, and whether Zoho was read just then or the website's last reading was used.
  gate_code text NOT NULL,
  gate_source text NOT NULL,
  handed_over_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, slip_line)
);

CREATE TABLE IF NOT EXISTS public.delivery_scans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_id bigint REFERENCES public.delivery_paper_codes(id) ON DELETE RESTRICT,
  note_id uuid REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  -- The start of the scanned code's hash. Groups repeated scans of one unknown code without keeping the code.
  code_hint text NOT NULL DEFAULT '',
  action text NOT NULL CHECK (action IN ('check', 'handover')),
  result text NOT NULL CHECK (result IN ('unknown', 'ready', 'handed_over', 'already_handed_over', 'replaced', 'order_problem', 'other_godown')),
  doc text CHECK (doc IN ('note', 'slip')),
  slip_line integer,
  copy_no integer,
  -- The item lines this scan handed over.
  lines integer[] NOT NULL DEFAULT '{}',
  gate_code text,
  gate_source text,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('admin', 'staff')),
  branch_id text,
  branch_name text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_scans_note_idx ON public.delivery_scans (note_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS delivery_scans_time_idx ON public.delivery_scans (occurred_at DESC);

-- Supabase's default privileges hand new tables and sequences to anon, authenticated and service_role, so take them
-- all back. Writes go only through the functions below, which run as their owner.
REVOKE ALL ON public.delivery_paper_codes, public.delivery_handovers, public.delivery_scans FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.delivery_paper_codes_id_seq, public.delivery_handovers_id_seq, public.delivery_scans_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.delivery_handovers, public.delivery_scans TO authenticated, service_role;
-- The hashes are read only by the functions below.
GRANT SELECT (id, note_id, print_event_id, doc, slip_line, copy_no, printed_at) ON public.delivery_paper_codes TO authenticated, service_role;

ALTER TABLE public.delivery_paper_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_paper_codes_admin_read ON public.delivery_paper_codes;
CREATE POLICY delivery_paper_codes_admin_read ON public.delivery_paper_codes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_handovers_admin_read ON public.delivery_handovers;
CREATE POLICY delivery_handovers_admin_read ON public.delivery_handovers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_scans_admin_read ON public.delivery_scans;
CREATE POLICY delivery_scans_admin_read ON public.delivery_scans FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Nothing is ever changed or removed (the function is from 20261103090000_delivery_notes.sql).
DROP TRIGGER IF EXISTS delivery_paper_codes_permanent ON public.delivery_paper_codes;
CREATE TRIGGER delivery_paper_codes_permanent BEFORE UPDATE OR DELETE ON public.delivery_paper_codes
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_paper_codes_permanent_truncate ON public.delivery_paper_codes;
CREATE TRIGGER delivery_paper_codes_permanent_truncate BEFORE TRUNCATE ON public.delivery_paper_codes
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_handovers_permanent ON public.delivery_handovers;
CREATE TRIGGER delivery_handovers_permanent BEFORE UPDATE OR DELETE ON public.delivery_handovers
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_handovers_permanent_truncate ON public.delivery_handovers;
CREATE TRIGGER delivery_handovers_permanent_truncate BEFORE TRUNCATE ON public.delivery_handovers
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_scans_permanent ON public.delivery_scans;
CREATE TRIGGER delivery_scans_permanent BEFORE UPDATE OR DELETE ON public.delivery_scans
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_scans_permanent_truncate ON public.delivery_scans;
CREATE TRIGGER delivery_scans_permanent_truncate BEFORE TRUNCATE ON public.delivery_scans
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();

-- ---------------------------------------------------------------- codes
-- A new code: the 16 bytes of a random UUID (gen_random_uuid uses the server's strong random source) in URL-safe
-- base64, 22 characters.
CREATE OR REPLACE FUNCTION private.delivery_new_code()
RETURNS text LANGUAGE sql VOLATILE AS $function$
  SELECT rtrim(translate(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '+/', '-_'), '=')
$function$;
REVOKE ALL ON FUNCTION private.delivery_new_code() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.delivery_code_hash(_code text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT encode(sha256(convert_to(COALESCE(_code, ''), 'UTF8')), 'hex')
$function$;
REVOKE ALL ON FUNCTION private.delivery_code_hash(text) FROM PUBLIC, anon, authenticated;

-- Each handed-over line of a note: { "2": { "at", "by", "role", "godown" } }.
CREATE OR REPLACE FUNCTION private.delivery_handover_map(_note_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(h.slip_line::text, jsonb_build_object(
    'at', h.handed_over_at, 'by', h.actor_name, 'role', h.actor_role, 'godown', h.branch_name)), '{}'::jsonb)
  FROM public.delivery_handovers h WHERE h.note_id = _note_id
$function$;
REVOKE ALL ON FUNCTION private.delivery_handover_map(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- print: now with a code per paper
/*
 * Records one press of Print: who, when, and which copy each paper is. The time returned is the time printed on
 * the paper. Copy 1 is the original; every later copy is a reprint.
 * Changed: each paper printed gets a new code, returned once (note_code, slip_codes) and kept only as a hash. The
 * newest copy is the only one whose code works, so this press cancels the codes on earlier copies of these papers.
 * The note is locked FOR NO KEY UPDATE as before, which also makes a print wait for a handover on the same note.
 * Also returns which lines are handed over already, so their reprints say so.
 */
CREATE OR REPLACE FUNCTION public.record_delivery_print(_note_id uuid, _note boolean, _slip_lines integer[], _zoho jsonb, _actor uuid, _actor_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n public.delivery_notes%ROWTYPE;
  who text := left(btrim(COALESCE(_actor_name, '')), 120);
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
BEGIN
  IF NOT private.delivery_actor_is_admin(_actor) THEN RAISE EXCEPTION 'Only administrators can print a delivery note'; END IF;
  IF who = '' THEN RAISE EXCEPTION 'Who printed the delivery note must be recorded'; END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE id = _note_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery note not found'; END IF;
  line_count := jsonb_array_length(n.snapshot->'items');
  IF NOT COALESCE(_note, false) AND cardinality(lines) = 0 THEN RAISE EXCEPTION 'Choose what to print'; END IF;
  gate := private.delivery_note_state(n.order_id, COALESCE(_zoho, jsonb_build_object('read', false, 'error', 'Zoho was not read just now')));
  code := gate->>'code';
  IF COALESCE(_note, false) THEN
    SELECT COALESCE(max(copy_no), 0) + 1 INTO note_copy FROM public.delivery_note_events
      WHERE note_id = n.id AND kind = 'printed' AND doc = 'note';
    INSERT INTO public.delivery_note_events (note_id, kind, doc, copy_no, gate_code, actor_id, actor_name)
      VALUES (n.id, 'printed', 'note', note_copy, code, _actor, who)
      RETURNING id INTO event_id;
    note_code := private.delivery_new_code();
    INSERT INTO public.delivery_paper_codes (note_id, print_event_id, doc, slip_line, copy_no, code_hash)
      VALUES (n.id, event_id, 'note', NULL, note_copy, private.delivery_code_hash(note_code));
  END IF;
  FOR line IN SELECT DISTINCT l FROM unnest(lines) AS l ORDER BY 1 LOOP
    IF line IS NULL OR line < 1 OR line > line_count THEN RAISE EXCEPTION 'This note has no slip %', line; END IF;
    SELECT COALESCE(max(copy_no), 0) + 1 INTO copy FROM public.delivery_note_events
      WHERE note_id = n.id AND kind = 'printed' AND doc = 'slip' AND slip_line = line;
    INSERT INTO public.delivery_note_events (note_id, kind, doc, slip_line, copy_no, gate_code, actor_id, actor_name)
      VALUES (n.id, 'printed', 'slip', line, copy, code, _actor, who)
      RETURNING id INTO event_id;
    paper_code := private.delivery_new_code();
    INSERT INTO public.delivery_paper_codes (note_id, print_event_id, doc, slip_line, copy_no, code_hash)
      VALUES (n.id, event_id, 'slip', line, copy, private.delivery_code_hash(paper_code));
    slip_copies := slip_copies || jsonb_build_object(line::text, copy);
    slip_codes := slip_codes || jsonb_build_object(line::text, paper_code);
  END LOOP;
  RETURN jsonb_build_object('printed_at', now(), 'note_copy', note_copy, 'slip_copies', slip_copies, 'gate', gate,
    'note_code', note_code, 'slip_codes', slip_codes, 'handovers', private.delivery_handover_map(n.id));
END;
$function$;
REVOKE ALL ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text) TO service_role;

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
 * A scan of a delivery note's or slip's QR. _handover false only checks; true records the handover of every line
 * the paper covers that is not handed over yet, if the paper may be used now. Either way the scan is kept.
 * _zoho is what the server read from Zoho Books just now for a handover. When Zoho could not be read (or for a check)
 * the website's last reading is used, and the handover row says which. Service role only: it takes a Zoho reading.
 *
 * Answers, first match wins:
 *   unknown              not a code the system made (forged, mistyped or damaged)                      red
 *   already_handed_over  every line this paper covers is handed over already                           red
 *   replaced             a newer copy of this paper was printed, which cancelled this one              red
 *   order_problem        the payment check is no longer clean, or the order is void in Zoho             red/amber
 *   other_godown         a staff member of another godown                                              amber
 *   ready                genuine, newest copy, not handed over: may be handed over (check only)       not green yet
 *   handed_over          recorded now: hand over the goods                                             green
 */
CREATE OR REPLACE FUNCTION public.delivery_paper_scan(_code text, _handover boolean, _zoho jsonb, _actor uuid)
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
  given text := left(btrim(COALESCE(_code, '')), 200);
  hash text;
  c public.delivery_paper_codes%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  o_void boolean;
  latest integer;
  latest_at timestamptz;
  latest_by text;
  line_count integer;
  scope integer[];
  open_lines integer[];
  reading jsonb;
  source text;
  gate jsonb;
  problem boolean;
  note_branch text;
  result text;
  handed integer[] := '{}';
  scan_id bigint;
  verb text := CASE WHEN COALESCE(_handover, false) THEN 'handover' ELSE 'check' END;
BEGIN
  -- Who is scanning: an administrator, or an active godown employee. public.has_role is false for the service role
  -- (auth.uid() is NULL there), so both are looked up directly.
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
    IF who_role IS NULL THEN RAISE EXCEPTION 'Only godown staff and administrators can check delivery papers'; END IF;
  END IF;

  hash := private.delivery_code_hash(given);
  IF given ~ '^[A-Za-z0-9_-]{22}$' THEN
    SELECT * INTO c FROM public.delivery_paper_codes WHERE code_hash = hash;
  END IF;
  IF c.id IS NULL THEN
    INSERT INTO public.delivery_scans (code_hint, action, result, actor_id, actor_name, actor_role, branch_id, branch_name)
      VALUES (left(hash, 12), verb, 'unknown', _actor, who_name, who_role, who_branch, who_branch_name)
      RETURNING id INTO scan_id;
    RETURN jsonb_build_object('result', 'unknown', 'action', verb, 'scan_id', scan_id, 'scanned_at', now(),
      'by', who_name, 'role', who_role, 'godown', who_branch_name);
  END IF;

  -- From here to the end the note is locked: a print (which cancels codes) or another handover of it waits.
  SELECT * INTO n FROM public.delivery_notes WHERE id = c.note_id FOR NO KEY UPDATE;
  SELECT lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled') INTO o_void FROM public.orders o WHERE o.id = n.order_id;
  SELECT e.copy_no, e.occurred_at, e.actor_name INTO latest, latest_at, latest_by
    FROM public.delivery_note_events e
    WHERE e.note_id = n.id AND e.kind = 'printed' AND e.doc = c.doc AND COALESCE(e.slip_line, 0) = COALESCE(c.slip_line, 0)
    ORDER BY e.copy_no DESC LIMIT 1;
  line_count := jsonb_array_length(n.snapshot->'items');
  scope := CASE WHEN c.doc = 'slip' THEN ARRAY[c.slip_line]
    ELSE ARRAY(SELECT generate_series(1, line_count)) END;
  open_lines := ARRAY(SELECT l FROM unnest(scope) l
    WHERE NOT EXISTS (SELECT 1 FROM public.delivery_handovers h WHERE h.note_id = n.id AND h.slip_line = l) ORDER BY l);

  IF COALESCE(_handover, false) AND COALESCE(_zoho->>'read', '') = 'true' AND COALESCE(_zoho->>'source', '') <> 'last_reading' THEN
    reading := _zoho;
    source := 'zoho_now';
  ELSE
    reading := private.delivery_note_last_reading(n.order_id);
    source := 'last_reading';
  END IF;
  gate := private.delivery_note_state(n.order_id, reading);
  problem := COALESCE(gate->>'code', '') <> 'paid' OR COALESCE((gate->>'items_changed')::boolean, false)
    OR COALESCE((gate->>'invoice_changed')::boolean, false) OR COALESCE(o_void, false);
  note_branch := NULLIF(n.snapshot->'godown'->>'id', '');

  IF cardinality(open_lines) = 0 THEN result := 'already_handed_over';
  ELSIF c.copy_no < latest THEN result := 'replaced';
  ELSIF problem THEN result := 'order_problem';
  ELSIF who_role = 'staff' AND who_branch IS DISTINCT FROM note_branch THEN result := 'other_godown';
  ELSIF NOT COALESCE(_handover, false) THEN result := 'ready';
  ELSE
    -- The unique key on (note_id, slip_line) stops a second handover even if the lock above were ever bypassed:
    -- the insert fails and nothing is recorded.
    INSERT INTO public.delivery_handovers (note_id, slip_line, code_id, actor_id, actor_name, actor_role, branch_id, branch_name, gate_code, gate_source)
      SELECT n.id, l, c.id, _actor, who_name, who_role, who_branch, who_branch_name, gate->>'code', source FROM unnest(open_lines) l;
    handed := open_lines;
    result := 'handed_over';
  END IF;

  INSERT INTO public.delivery_scans (code_id, note_id, code_hint, action, result, doc, slip_line, copy_no, lines, gate_code, gate_source,
      actor_id, actor_name, actor_role, branch_id, branch_name)
    VALUES (c.id, n.id, left(hash, 12), verb, result, c.doc, c.slip_line, c.copy_no, handed, gate->>'code', source,
      _actor, who_name, who_role, who_branch, who_branch_name)
    RETURNING id INTO scan_id;

  RETURN jsonb_build_object(
    'result', result, 'action', verb, 'scan_id', scan_id, 'scanned_at', now(),
    'by', who_name, 'role', who_role, 'godown', who_branch_name,
    'paper', jsonb_build_object('doc', c.doc, 'slip_line', c.slip_line, 'slips', line_count, 'copy_no', c.copy_no, 'printed_at', c.printed_at,
      'latest_copy', latest, 'latest_printed_at', latest_at, 'latest_printed_by', latest_by),
    'note', jsonb_build_object('note_no', n.note_no, 'order_no', n.order_no, 'invoice_number', n.invoice_number,
      'customer', COALESCE(NULLIF(n.snapshot->'customer'->>'business_name', ''), n.snapshot->'customer'->>'name', ''),
      'godown', COALESCE(n.snapshot->'godown'->>'name', ''), 'shipping_method', COALESCE(n.snapshot->>'shipping_method', ''),
      'generated_at', n.generated_at),
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'line', (i->>'line')::integer, 'name', i->>'name', 'qty', i->'qty', 'pack_size', COALESCE(i->>'pack_size', ''), 'stock_no', COALESCE(i->>'stock_no', ''),
        'handover', private.delivery_handover_map(n.id)->(i->>'line')) ORDER BY (i->>'line')::integer), '[]'::jsonb)
      FROM jsonb_array_elements(n.snapshot->'items') i WHERE (i->>'line')::integer = ANY (scope)),
    'handed_now', to_jsonb(handed),
    -- Only what the screen needs to say why not: no amounts.
    'gate', jsonb_build_object('code', gate->>'code', 'source', source, 'stop_reason', gate->'stop_reason',
      'items_changed', COALESCE((gate->>'items_changed')::boolean, false), 'invoice_changed', COALESCE((gate->>'invoice_changed')::boolean, false),
      'invoice_number', gate->>'invoice_number', 'zoho_void', COALESCE(o_void, false))
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.delivery_paper_scan(text, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_paper_scan(text, boolean, jsonb, uuid) TO service_role;

/*
 * Admin > Delivery Notes: every note, newest first, with the check run on what the website last knew of Zoho (no
 * Zoho call per row), so a note whose order was cancelled or refunded stands out.
 * Changed: also how many item lines are handed over, and the last scan.
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
      'handed_over', (SELECT count(*) FROM public.delivery_handovers h WHERE h.note_id = n.id),
      'last_handed_over_at', (SELECT max(h.handed_over_at) FROM public.delivery_handovers h WHERE h.note_id = n.id),
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

COMMIT;

NOTIFY pgrst, 'reload schema';
