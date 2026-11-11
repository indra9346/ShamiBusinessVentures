-- 12 Nov 2026, the owner (11 Nov): no separate delivery note paper any more. One delivery QR is printed on the
-- invoice. The delivery note is raised automatically once the full payment is confirmed (and Zoho has the paid
-- invoice). The godown in-charge (a godown employee the admin marks, with their own login, not the channel partner)
-- scans the QR on the customer's invoice, sees the delivery note is released, prints it and hands the goods over.
-- Ordinary staff and channel partners may print slips or hand over only if the admin switches that on.
--
-- What this adds:
--   staff_employees.is_incharge, set by an admin (admin_set_staff_incharge)
--   settings 'delivery_qr_rules': what staff and channel partners may do on a scan (admin_set_delivery_qr_rules)
--   private.order_delivery_codes: one working delivery code per order, the same on every copy of the invoice. Unlike a
--     printed paper's code it is kept (in the private schema, which the API never serves), so every download of the
--     invoice carries the same QR; an admin can replace it with a reason (the old one then scans red).
--   invoice_delivery_code(): the code for the invoice, only to the order's customer, its channel partner and admins,
--     and only once the order is paid, confirmed and invoiced (the delivery note's own payment check).
--   issue_delivery_note_auto(): the delivery note raised without an admin's press (payment confirmed, or the in-charge's
--     scan when it was not raised yet). issue_delivery_note keeps working for admins.
--   delivery_invoice_scan(): a scan of the invoice QR: check, hand over (ticked items), print the note or the slips.
--   delivery_release_print(): an admin's print of the released note and slips (no QR on them: the invoice QR is the
--     only one that hands goods over).
--   godown_released_notes(): the in-charge's list of released notes at their godown.
-- Existing printed note and slip QR codes (DN-000001) keep working through delivery_paper_scan, unchanged.
-- Everything stays permanent: nothing existing is updated (the permanence triggers block it); only columns, checks
-- and new rows are added.

-- ---------------------------------------------------------------- the godown in-charge
ALTER TABLE public.staff_employees ADD COLUMN IF NOT EXISTS is_incharge boolean NOT NULL DEFAULT false;
ALTER TABLE public.staff_employees ADD COLUMN IF NOT EXISTS incharge_set_at timestamptz;
ALTER TABLE public.staff_employees ADD COLUMN IF NOT EXISTS incharge_set_by text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.admin_set_staff_incharge(_employee_id uuid, _on boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  e public.staff_employees%ROWTYPE;
  who text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can choose the godown in-charge'; END IF;
  SELECT * INTO e FROM public.staff_employees WHERE id = _employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;
  IF COALESCE(_on, false) AND e.status <> 'active' THEN RAISE EXCEPTION 'Only an active employee can be the godown in-charge'; END IF;
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), '')) INTO who FROM public.profiles p WHERE p.id = auth.uid();
  UPDATE public.staff_employees
    SET is_incharge = COALESCE(_on, false), incharge_set_at = now(), incharge_set_by = COALESCE(who, 'Admin'), updated_at = now()
    WHERE id = e.id;
  RETURN jsonb_build_object('id', e.id, 'is_incharge', COALESCE(_on, false));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_staff_incharge(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_staff_incharge(uuid, boolean) TO authenticated;

-- Who is scanning, and what they may do: an administrator, the in-charge of a godown (an active employee the admin
-- marked), other active godown staff, or the godown's active channel partner. public.has_role is false for the
-- service role, so each is looked up directly. Returns NULL for anyone else.
CREATE OR REPLACE FUNCTION private.delivery_scanner(_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who jsonb;
  name text;
BEGIN
  IF private.delivery_actor_is_admin(_actor) THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), '')) INTO name FROM public.profiles p WHERE p.id = _actor;
    RETURN jsonb_build_object('role', 'admin', 'name', COALESCE(name, 'Admin ' || left(_actor::text, 8)), 'branch_id', NULL, 'branch_name', '');
  END IF;
  SELECT jsonb_build_object('role', CASE WHEN e.is_incharge THEN 'incharge' ELSE 'staff' END, 'name', e.name,
      'branch_id', e.branch_id, 'branch_name', COALESCE(b.name, e.branch_id))
    INTO who
    FROM public.staff_employees e LEFT JOIN public.branches b ON b.id = e.branch_id
    WHERE e.user_id = _actor AND e.status = 'active';
  IF who IS NOT NULL THEN RETURN who; END IF;
  SELECT jsonb_build_object('role', 'partner', 'name', p.name, 'branch_id', p.branch_id, 'branch_name', COALESCE(b.name, p.branch_id))
    INTO who
    FROM public.channel_partners p LEFT JOIN public.branches b ON b.id = p.branch_id
    WHERE p.user_id = _actor AND p.status = 'active';
  RETURN who;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_scanner(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- the admin's rules for staff and partners
-- The in-charge and admins may always print and hand over. What ordinary staff and the channel partner may do is the
-- admin's choice (owner, 11 Nov: "both options should be there and enable this option in admin for controlling").
CREATE OR REPLACE FUNCTION private.delivery_qr_rules()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'staff_print_slips', COALESCE((s.value->>'staff_print_slips')::boolean, true),
    'staff_print_note', COALESCE((s.value->>'staff_print_note')::boolean, false),
    'staff_handover', COALESCE((s.value->>'staff_handover')::boolean, false),
    'partner_print_slips', COALESCE((s.value->>'partner_print_slips')::boolean, false),
    'partner_print_note', COALESCE((s.value->>'partner_print_note')::boolean, false),
    'partner_handover', COALESCE((s.value->>'partner_handover')::boolean, false))
  FROM (SELECT (SELECT value FROM public.settings WHERE key = 'delivery_qr_rules') AS value) s
$function$;
REVOKE ALL ON FUNCTION private.delivery_qr_rules() FROM PUBLIC, anon, authenticated;

-- The rules as they stand, for the admin's settings card and the godown apps.
CREATE OR REPLACE FUNCTION public.delivery_qr_rules()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT private.delivery_qr_rules()
$function$;
REVOKE ALL ON FUNCTION public.delivery_qr_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_qr_rules() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_delivery_qr_rules(_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  merged jsonb := private.delivery_qr_rules();
  k text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can change the delivery rules'; END IF;
  IF jsonb_typeof(COALESCE(_rules, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'Send the rules as switches'; END IF;
  FOR k IN SELECT jsonb_object_keys(_rules) LOOP
    IF NOT merged ? k THEN RAISE EXCEPTION 'Unknown delivery rule %', k; END IF;
    IF jsonb_typeof(_rules->k) <> 'boolean' THEN RAISE EXCEPTION 'The delivery rule % must be on or off', k; END IF;
    merged := jsonb_set(merged, ARRAY[k], _rules->k);
  END LOOP;
  INSERT INTO public.settings (key, value) VALUES ('delivery_qr_rules', merged)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  RETURN merged;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_delivery_qr_rules(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_delivery_qr_rules(jsonb) TO authenticated;

-- ---------------------------------------------------------------- the invoice's delivery code
-- One working code per order, the same on every copy of the invoice. A replacement (an admin, with a reason) revokes
-- the old one; old rows stay as the record. The private schema is never served by the API: only the functions below
-- read it.
CREATE TABLE IF NOT EXISTS private.order_delivery_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation >= 1),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{22}$'),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text NOT NULL DEFAULT '',
  revoke_reason text NOT NULL DEFAULT '',
  UNIQUE (order_id, generation),
  CHECK (revoked_at IS NULL OR length(btrim(revoke_reason)) >= 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS order_delivery_codes_live_idx ON private.order_delivery_codes (order_id) WHERE revoked_at IS NULL;
REVOKE ALL ON private.order_delivery_codes FROM PUBLIC, anon, authenticated;

-- How a note came to be: an admin's press, raised automatically when the payment was confirmed, or by the in-charge's
-- scan when it had not been raised yet. Adding a column with a default does not touch the existing rows.
ALTER TABLE public.delivery_notes ADD COLUMN IF NOT EXISTS generated_how text NOT NULL DEFAULT 'admin';
ALTER TABLE public.delivery_notes DROP CONSTRAINT IF EXISTS delivery_notes_generated_how_check;
ALTER TABLE public.delivery_notes ADD CONSTRAINT delivery_notes_generated_how_check CHECK (generated_how IN ('admin', 'auto', 'scan'));

-- The order's godown, the same rule the note's snapshot uses: the order's branch, else the default one.
CREATE OR REPLACE FUNCTION private.order_godown_id(_order_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT b.id FROM public.orders o JOIN public.branches b ON b.id = o.branch_id WHERE o.id = _order_id),
    (SELECT b.id FROM public.branches b WHERE b.is_default LIMIT 1))
$function$;
REVOKE ALL ON FUNCTION private.order_godown_id(uuid) FROM PUBLIC, anon, authenticated;

/*
 * The delivery code for an order's invoice, and the delivery note's state. Only the order's customer, the order's
 * channel partner (the one whose signature goes on its invoice) and admins get it, and only when the order passes the
 * delivery note's payment check on the website's last reading of Zoho (paid in full, confirmed, a live paid invoice,
 * no stop or refund). Otherwise code is null and 'why' says the check's answer. The first call makes the code.
 */
CREATE OR REPLACE FUNCTION public.invoice_delivery_code(_order_no text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me uuid := auth.uid();
  o public.orders%ROWTYPE;
  gate jsonb;
  c private.order_delivery_codes%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  allowed boolean;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Sign in to see the invoice'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no;
  -- One answer for "no such order" and "not yours", so nobody can test which order numbers exist.
  IF NOT FOUND THEN
    IF public.has_role(me, 'admin') THEN RETURN jsonb_build_object('code', NULL, 'why', 'not_found'); END IF;
    RAISE EXCEPTION 'This is not your order';
  END IF;
  -- The order's own channel partner only while active (a suspended partner can still sign in).
  allowed := public.has_role(me, 'admin') OR o.user_id = me
    OR EXISTS (SELECT 1 FROM public.channel_partners p WHERE p.user_id = me AND p.status = 'active' AND p.id = private.order_signing_partner(o.id));
  IF NOT allowed THEN RAISE EXCEPTION 'This is not your order'; END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE order_id = o.id;
  gate := private.delivery_note_state(o.id, private.delivery_note_last_reading(o.id));
  IF COALESCE(gate->>'code', '') <> 'paid' THEN
    RETURN jsonb_build_object('code', NULL, 'why', gate->>'code', 'note_no', n.note_no);
  END IF;
  SELECT * INTO c FROM private.order_delivery_codes WHERE order_id = o.id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    -- Two first calls at once: the unique index lets one in; the other reads the row it made.
    BEGIN
      INSERT INTO private.order_delivery_codes (order_id, generation, code, code_hash)
        SELECT o.id, COALESCE(max(x.generation), 0) + 1, k.code, private.delivery_code_hash(k.code)
        FROM (SELECT private.delivery_new_code() AS code) k
        LEFT JOIN private.order_delivery_codes x ON x.order_id = o.id
        GROUP BY k.code
        RETURNING * INTO c;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO c FROM private.order_delivery_codes WHERE order_id = o.id AND revoked_at IS NULL;
    END;
  END IF;
  RETURN jsonb_build_object('code', c.code, 'generation', c.generation, 'why', 'paid',
    'note_no', n.note_no, 'released_at', n.generated_at, 'released_how', n.generated_how);
END;
$function$;
REVOKE ALL ON FUNCTION public.invoice_delivery_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_delivery_code(text) TO authenticated;

-- An admin replaces the invoice's QR (lost, shared or misused), with a reason. The old one scans red from now on; the
-- customer downloads the invoice again for the new one.
CREATE OR REPLACE FUNCTION public.admin_replace_invoice_delivery_code(_order_no text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text := left(btrim(COALESCE(_reason, '')), 300);
  who text;
  c private.order_delivery_codes%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can replace the invoice QR'; END IF;
  IF length(why) < 3 THEN RAISE EXCEPTION 'Enter the reason for replacing the QR'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), 'Admin') INTO who FROM public.profiles p WHERE p.id = auth.uid();
  UPDATE private.order_delivery_codes SET revoked_at = now(), revoked_by = COALESCE(who, 'Admin'), revoke_reason = why
    WHERE order_id = o.id AND revoked_at IS NULL;
  INSERT INTO private.order_delivery_codes (order_id, generation, code, code_hash)
    SELECT o.id, COALESCE(max(x.generation), 0) + 1, k.code, private.delivery_code_hash(k.code)
    FROM (SELECT private.delivery_new_code() AS code) k
    LEFT JOIN private.order_delivery_codes x ON x.order_id = o.id
    GROUP BY k.code
    RETURNING * INTO c;
  RETURN jsonb_build_object('generation', c.generation);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_replace_invoice_delivery_code(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_invoice_delivery_code(text, text) TO authenticated;

-- The order an invoice code belongs to, so the server knows which order to read from Zoho. NULL for any other code.
CREATE OR REPLACE FUNCTION public.delivery_invoice_order_no(_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT o.order_no FROM private.order_delivery_codes c JOIN public.orders o ON o.id = c.order_id
  WHERE COALESCE(_code, '') ~ '^[A-Za-z0-9_-]{22}$' AND c.code_hash = private.delivery_code_hash(_code)
$function$;
REVOKE ALL ON FUNCTION public.delivery_invoice_order_no(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_invoice_order_no(text) TO service_role;

-- ---------------------------------------------------------------- the note, raised without an admin's press
/*
 * The order's one delivery note, made the same way as issue_delivery_note (same payment check on a reading of Zoho
 * taken just now, same snapshot, same numbering), recorded as raised automatically ('auto', no person) or by the
 * godown in-charge's scan ('scan', the in-charge of the order's godown, or an admin). A second call returns the note
 * already made. Service role only.
 */
CREATE OR REPLACE FUNCTION public.issue_delivery_note_auto(_order_no text, _zoho jsonb, _actor uuid DEFAULT NULL, _how text DEFAULT 'auto')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  gate jsonb;
  reading jsonb := CASE WHEN COALESCE(_zoho->>'source', '') = 'last_reading' THEN NULL ELSE _zoho END;
  next_no bigint;
  godown jsonb;
  company jsonb;
  who jsonb;
  who_id uuid;
  who_name text;
  how text := COALESCE(NULLIF(btrim(_how), ''), 'auto');
BEGIN
  IF how NOT IN ('auto', 'scan') THEN RAISE EXCEPTION 'Unknown way of raising a delivery note'; END IF;
  reading := COALESCE(reading, jsonb_build_object('read', false, 'error', 'Zoho was not read just now'));
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('issued', false, 'gate', jsonb_build_object('allowed', false, 'code', 'not_found')); END IF;
  IF how = 'scan' THEN
    who := private.delivery_scanner(_actor);
    IF who IS NULL OR NOT (who->>'role' = 'admin' OR (who->>'role' = 'incharge' AND who->>'branch_id' = private.order_godown_id(o.id))) THEN
      RAISE EXCEPTION 'Only the godown in-charge or an administrator can release a delivery note';
    END IF;
    who_id := _actor;
    who_name := who->>'name';
  ELSE
    -- No person pressed anything: the system raised it when the payment was confirmed.
    who_id := '00000000-0000-0000-0000-000000000000';
    who_name := 'Automatic (payment confirmed)';
  END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE order_id = o.id;
  IF FOUND THEN
    RETURN jsonb_build_object('issued', false, 'already', true, 'note_id', n.id, 'note_no', n.note_no, 'gate', private.delivery_note_state(o.id, reading));
  END IF;
  gate := private.delivery_note_state(o.id, reading);
  IF NOT COALESCE((gate->>'allowed')::boolean, false) THEN
    RETURN jsonb_build_object('issued', false, 'gate', gate);
  END IF;

  SELECT to_jsonb(b) - 'zoho_pricebook_id' - 'zoho_pricebook_name' - 'serves_pincodes' INTO godown
    FROM public.branches b WHERE b.id = o.branch_id;
  IF godown IS NULL THEN
    SELECT to_jsonb(b) - 'zoho_pricebook_id' - 'zoho_pricebook_name' - 'serves_pincodes' INTO godown
      FROM public.branches b WHERE b.is_default LIMIT 1;
  END IF;
  SELECT value INTO company FROM public.settings WHERE key = 'company';

  UPDATE public.delivery_note_counter SET last_no = last_no + 1 WHERE id RETURNING last_no INTO next_no;
  IF next_no IS NULL THEN RAISE EXCEPTION 'The delivery note counter is missing'; END IF;
  INSERT INTO public.delivery_notes (seq, note_no, order_id, order_no, zoho_invoice_id, invoice_number, invoice_total, order_total, paid_amount, snapshot, generated_by, generated_by_name, generated_how)
  VALUES (next_no, 'DN-' || lpad(next_no::text, GREATEST(6, length(next_no::text)), '0'), o.id, o.order_no, gate->>'invoice_id', gate->>'invoice_number',
    (gate->>'invoice_total')::numeric, o.total, o.paid_amount,
    jsonb_build_object(
      'order_placed_at', o.created_at,
      'shipping_method', COALESCE(o.shipping_method, ''),
      'customer', jsonb_build_object('name', COALESCE(o.customer_name, ''), 'phone', COALESCE(NULLIF(o.customer_phone, ''), o.shipping_address->>'phone', ''),
        'business_name', COALESCE(o.business_legal_name, ''), 'gstin', COALESCE(o.customer_gstin, '')),
      'address', jsonb_build_object('name', COALESCE(o.shipping_address->>'name', ''), 'phone', COALESCE(o.shipping_address->>'phone', ''),
        'line', COALESCE(o.shipping_address->>'line', ''), 'city', COALESCE(o.shipping_address->>'city', ''),
        'state', COALESCE(o.shipping_address->>'state', ''), 'pin', COALESCE(o.shipping_address->>'pin', '')),
      'godown', COALESCE(godown, '{}'::jsonb),
      'company', COALESCE(company, '{}'::jsonb),
      'items', private.delivery_note_lines(o.id)
    ),
    who_id, who_name, how)
  RETURNING * INTO n;
  INSERT INTO public.delivery_note_events (note_id, kind, gate_code, detail, actor_id, actor_name)
    VALUES (n.id, 'generated', gate->>'code', CASE WHEN how = 'auto' THEN 'Raised automatically when the payment was confirmed' ELSE 'Released by the godown in-charge''s scan of the invoice QR' END,
      CASE WHEN how = 'auto' THEN NULL ELSE who_id END, who_name);
  -- The godown hears about it: its in-charge and channel partner see it in their apps (godown_released_notes).
  RETURN jsonb_build_object('issued', true, 'note_id', n.id, 'note_no', n.note_no, 'gate', private.delivery_note_state(o.id, reading));
END;
$function$;
REVOKE ALL ON FUNCTION public.issue_delivery_note_auto(text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_delivery_note_auto(text, jsonb, uuid, text) TO service_role;

-- ---------------------------------------------------------------- scans and handovers of the invoice QR
ALTER TABLE public.delivery_handovers ADD COLUMN IF NOT EXISTS invoice_code_id bigint REFERENCES private.order_delivery_codes(id) ON DELETE RESTRICT;
ALTER TABLE public.delivery_handovers ALTER COLUMN code_id DROP NOT NULL;
ALTER TABLE public.delivery_handovers DROP CONSTRAINT IF EXISTS delivery_handovers_paper_check;
ALTER TABLE public.delivery_handovers ADD CONSTRAINT delivery_handovers_paper_check CHECK (code_id IS NOT NULL OR invoice_code_id IS NOT NULL);
ALTER TABLE public.delivery_handovers DROP CONSTRAINT IF EXISTS delivery_handovers_actor_role_check;
ALTER TABLE public.delivery_handovers ADD CONSTRAINT delivery_handovers_actor_role_check CHECK (actor_role IN ('admin', 'incharge', 'staff', 'partner'));

ALTER TABLE public.delivery_scans ADD COLUMN IF NOT EXISTS invoice_code_id bigint REFERENCES private.order_delivery_codes(id) ON DELETE RESTRICT;
ALTER TABLE public.delivery_scans ADD COLUMN IF NOT EXISTS order_no text;
ALTER TABLE public.delivery_scans DROP CONSTRAINT IF EXISTS delivery_scans_action_check;
ALTER TABLE public.delivery_scans ADD CONSTRAINT delivery_scans_action_check CHECK (action IN ('check', 'handover', 'print_note', 'print_slips'));
ALTER TABLE public.delivery_scans DROP CONSTRAINT IF EXISTS delivery_scans_result_check;
ALTER TABLE public.delivery_scans ADD CONSTRAINT delivery_scans_result_check CHECK (result IN ('unknown', 'ready', 'handed_over', 'already_handed_over', 'partly_handed_over',
  'duplicate', 'replaced', 'order_problem', 'other_godown', 'released', 'not_released', 'not_allowed', 'printed'));
ALTER TABLE public.delivery_scans DROP CONSTRAINT IF EXISTS delivery_scans_doc_check;
ALTER TABLE public.delivery_scans ADD CONSTRAINT delivery_scans_doc_check CHECK (doc IN ('note', 'slip', 'invoice'));
ALTER TABLE public.delivery_scans DROP CONSTRAINT IF EXISTS delivery_scans_actor_role_check;
ALTER TABLE public.delivery_scans ADD CONSTRAINT delivery_scans_actor_role_check CHECK (actor_role IN ('admin', 'incharge', 'staff', 'partner'));

-- Records printed copies of a released note (no QR on them) and returns what the paper shows. Shared by the godown's
-- prints from a scan and the office's prints.
CREATE OR REPLACE FUNCTION private.delivery_release_print(_note_id uuid, _note boolean, _slip_lines integer[], _actor uuid, _actor_name text, _role text, _gate text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  n public.delivery_notes%ROWTYPE;
  line_count integer;
  lines integer[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(_slip_lines, '{}')) x WHERE x IS NOT NULL ORDER BY x);
  note_copy integer;
  slip_copies jsonb := '{}'::jsonb;
  x integer;
  next_copy integer;
  label text := CASE _role WHEN 'incharge' THEN 'godown in-charge' WHEN 'staff' THEN 'godown staff' WHEN 'partner' THEN 'channel partner' ELSE 'office' END;
BEGIN
  SELECT * INTO n FROM public.delivery_notes WHERE id = _note_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery note not found'; END IF;
  line_count := jsonb_array_length(n.snapshot->'items');
  IF NOT COALESCE(_note, false) AND cardinality(lines) = 0 THEN RAISE EXCEPTION 'Choose what to print'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(lines) y WHERE y < 1 OR y > line_count) THEN RAISE EXCEPTION 'This note has no such slip'; END IF;
  IF COALESCE(_note, false) THEN
    SELECT COALESCE(max(copy_no), 0) + 1 INTO note_copy FROM public.delivery_note_events WHERE note_id = n.id AND kind = 'printed' AND doc = 'note';
    INSERT INTO public.delivery_note_events (note_id, kind, doc, copy_no, gate_code, detail, actor_id, actor_name)
      VALUES (n.id, 'printed', 'note', note_copy, _gate, 'Printed by the ' || label, _actor, _actor_name);
  END IF;
  FOREACH x IN ARRAY lines LOOP
    SELECT COALESCE(max(copy_no), 0) + 1 INTO next_copy FROM public.delivery_note_events WHERE note_id = n.id AND kind = 'printed' AND doc = 'slip' AND slip_line = x;
    INSERT INTO public.delivery_note_events (note_id, kind, doc, slip_line, copy_no, gate_code, detail, actor_id, actor_name)
      VALUES (n.id, 'printed', 'slip', x, next_copy, _gate, 'Printed by the ' || label, _actor, _actor_name);
    slip_copies := slip_copies || jsonb_build_object(x::text, next_copy);
  END LOOP;
  RETURN jsonb_build_object('printed_at', now(), 'note_copy', note_copy, 'slip_copies', slip_copies, 'printed_by', _actor_name, 'printed_role', _role,
    'note', jsonb_build_object('note_no', n.note_no, 'order_no', n.order_no, 'invoice_number', n.invoice_number, 'snapshot', n.snapshot,
      'generated_at', n.generated_at, 'generated_by_name', n.generated_by_name, 'generated_how', n.generated_how));
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_release_print(uuid, boolean, integer[], uuid, text, text, text) FROM PUBLIC, anon, authenticated;

/*
 * A scan of the QR on an invoice. Returns NULL when the code is not an invoice code (the server then tries the printed
 * papers' scan). _action: 'check' (look), 'handover' (the items ticked in _lines), 'print_note' or 'print_slips'
 * (_lines: which slips, all if empty). _zoho: what the server read from Zoho Books just now. Service role only.
 *
 * The godown is checked first, before anything about the order is shown. Then, first match wins:
 *   replaced             an invoice QR an administrator replaced                                         red
 *   other_godown         staff, in-charge or partner of another godown: nothing about the order shown    amber
 *   not_released         no delivery note yet (the payment is not confirmed in full, or Zoho is behind;
 *                        the in-charge's or an admin's scan raises it when the check passes)              amber
 *   order_problem        the payment check is no longer clean, or the order is void in Zoho             red
 *   not_allowed          this person may not do that (the admin's delivery rules)                       amber
 *   already_handed_over  every item is handed over (check or handover)                                  red
 *   partly_handed_over   some ticked items went meanwhile: nothing recorded, tick again                 amber
 *   released             the note is released and items are still to go (check)                        blue
 *   printed              the copies were recorded; the paper comes with the answer                       blue
 *   handed_over          recorded now: hand over the goods                                              green
 * The answer says what this person may do next ('can'): print the note, print slips, hand over.
 */
CREATE OR REPLACE FUNCTION public.delivery_invoice_scan(_code text, _action text, _zoho jsonb, _actor uuid, _lines integer[] DEFAULT NULL, _device text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who jsonb := private.delivery_scanner(_actor);
  who_role text;
  who_name text;
  who_branch text;
  who_branch_name text;
  dev_branch text;
  dev_label text := '';
  dev_registered boolean := false;
  given text := left(btrim(COALESCE(_code, '')), 200);
  hash text := private.delivery_code_hash(left(btrim(COALESCE(_code, '')), 200));
  act text := COALESCE(NULLIF(btrim(_action), ''), 'check');
  c private.order_delivery_codes%ROWTYPE;
  live private.order_delivery_codes%ROWTYPE;
  o public.orders%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  godown_id text;
  godown_name text;
  rules jsonb := private.delivery_qr_rules();
  can_note boolean;
  can_slips boolean;
  can_hand boolean;
  o_void boolean;
  reading jsonb;
  source text;
  gate jsonb;
  problem boolean;
  line_count integer := 0;
  open_lines integer[] := '{}';
  asked integer[] := '{}';
  handed integer[] := '{}';
  result text;
  delivered boolean := false;
  status_before text;
  issued jsonb;
  printed jsonb;
  scan_id bigint;
BEGIN
  IF act NOT IN ('check', 'handover', 'print_note', 'print_slips') THEN RAISE EXCEPTION 'Unknown scan action'; END IF;
  IF given !~ '^[A-Za-z0-9_-]{22}$' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM private.order_delivery_codes WHERE code_hash = hash;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF who IS NULL THEN RAISE EXCEPTION 'Only godown staff, channel partners and administrators can check delivery papers'; END IF;
  who_role := who->>'role';
  who_name := who->>'name';
  who_branch := who->>'branch_id';
  who_branch_name := COALESCE(who->>'branch_name', '');
  IF btrim(COALESCE(_device, '')) <> '' THEN
    SELECT d.branch_id, d.label INTO dev_branch, dev_label FROM public.godown_devices d
      WHERE d.token_hash = private.delivery_code_hash(btrim(_device)) AND d.active;
    dev_registered := dev_branch IS NOT NULL AND (who_branch IS NULL OR dev_branch = who_branch);
    dev_label := CASE WHEN dev_registered THEN COALESCE(dev_label, '') ELSE '' END;
  END IF;

  -- The order is locked to the end: a second scan, a print or a payment change waits.
  SELECT * INTO o FROM public.orders WHERE id = c.order_id FOR NO KEY UPDATE;
  godown_id := private.order_godown_id(o.id);
  SELECT COALESCE(b.name, godown_id) INTO godown_name FROM public.branches b WHERE b.id = godown_id;
  o_void := lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled');

  -- Admins may do everything anywhere; the in-charge everything at their godown; staff and the partner what the admin
  -- switched on.
  can_note := who_role IN ('admin', 'incharge') OR (who_role = 'staff' AND (rules->>'staff_print_note')::boolean)
    OR (who_role = 'partner' AND (rules->>'partner_print_note')::boolean);
  can_slips := who_role IN ('admin', 'incharge') OR (who_role = 'staff' AND (rules->>'staff_print_slips')::boolean)
    OR (who_role = 'partner' AND (rules->>'partner_print_slips')::boolean);
  can_hand := who_role IN ('admin', 'incharge') OR (who_role = 'staff' AND (rules->>'staff_handover')::boolean)
    OR (who_role = 'partner' AND (rules->>'partner_handover')::boolean);

  IF COALESCE(_zoho->>'read', '') = 'true' AND COALESCE(_zoho->>'source', '') <> 'last_reading' THEN
    reading := _zoho;
    source := 'zoho_now';
  ELSE
    reading := private.delivery_note_last_reading(o.id);
    source := 'last_reading';
  END IF;

  -- The godown first: another godown's people learn nothing more, not even why a QR was replaced.
  IF who_role <> 'admin' AND who_branch IS DISTINCT FROM godown_id THEN
    result := 'other_godown';
  ELSIF c.revoked_at IS NOT NULL THEN
    result := 'replaced';
    SELECT * INTO live FROM private.order_delivery_codes WHERE order_id = o.id AND revoked_at IS NULL;
  ELSE
    SELECT * INTO n FROM public.delivery_notes WHERE order_id = o.id FOR NO KEY UPDATE;
    IF NOT FOUND AND who_role IN ('admin', 'incharge') AND source = 'zoho_now' THEN
      -- Not raised yet (Zoho was behind when the payment was confirmed): the in-charge's or an admin's scan raises it
      -- now, if the payment check passes on Zoho read just now.
      issued := public.issue_delivery_note_auto(o.order_no, reading, _actor, 'scan');
      SELECT * INTO n FROM public.delivery_notes WHERE order_id = o.id FOR NO KEY UPDATE;
    END IF;
    IF n.id IS NULL THEN
      result := 'not_released';
      gate := COALESCE(issued->'gate', private.delivery_note_state(o.id, reading));
    ELSE
      line_count := jsonb_array_length(n.snapshot->'items');
      open_lines := ARRAY(SELECT g FROM generate_series(1, line_count) g WHERE NOT private.delivery_line_done(n.id, g) ORDER BY g);
      gate := private.delivery_note_state(o.id, reading);
      problem := COALESCE(gate->>'code', '') <> 'paid' OR COALESCE((gate->>'items_changed')::boolean, false)
        OR COALESCE((gate->>'invoice_changed')::boolean, false) OR o_void;
      IF act = 'handover' THEN
        asked := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(_lines, '{}')) x WHERE x IS NOT NULL ORDER BY x);
        IF cardinality(asked) = 0 THEN RAISE EXCEPTION 'Tick the items being handed over'; END IF;
        IF EXISTS (SELECT 1 FROM unnest(asked) x WHERE x < 1 OR x > line_count) THEN RAISE EXCEPTION 'This note has no such item'; END IF;
      END IF;

      IF problem THEN result := 'order_problem';
      ELSIF act = 'handover' AND NOT can_hand THEN result := 'not_allowed';
      ELSIF act = 'print_note' AND NOT can_note THEN result := 'not_allowed';
      ELSIF act = 'print_slips' AND NOT can_slips THEN result := 'not_allowed';
      ELSIF act IN ('print_note', 'print_slips') THEN
        printed := private.delivery_release_print(n.id, act = 'print_note',
          CASE WHEN act = 'print_slips' THEN COALESCE(NULLIF(_lines, '{}'), ARRAY(SELECT generate_series(1, line_count))) ELSE '{}'::integer[] END,
          _actor, who_name, who_role, gate->>'code');
        IF act = 'print_slips' THEN
          -- Slips show the items, the customer's name and the godown: whoever prints only slips does not get the
          -- customer's phone, GSTIN or address.
          printed := jsonb_set(printed, '{note,snapshot}', (n.snapshot - 'address') || jsonb_build_object(
            'customer', jsonb_build_object('name', COALESCE(n.snapshot->'customer'->>'name', ''),
              'business_name', COALESCE(n.snapshot->'customer'->>'business_name', ''), 'phone', '', 'gstin', ''),
            'address', '{}'::jsonb));
        END IF;
        result := 'printed';
      ELSIF cardinality(open_lines) = 0 THEN result := 'already_handed_over';
      ELSIF act = 'check' THEN result := 'released';
      -- All or nothing: the screen showed these items as still to go, so if one went meanwhile the list is out of date.
      ELSIF EXISTS (SELECT 1 FROM unnest(asked) x WHERE NOT (x = ANY (open_lines))) THEN result := 'partly_handed_over';
      ELSE
        -- The unique key on (note_id, slip_line, round) stops a second handover even if the lock were ever bypassed.
        INSERT INTO public.delivery_handovers (note_id, slip_line, round, code_id, invoice_code_id, actor_id, actor_name, actor_role, branch_id, branch_name,
            device_registered, device_label, gate_code, gate_source)
          SELECT n.id, x, (SELECT count(*) FROM public.delivery_handovers h WHERE h.note_id = n.id AND h.slip_line = x) + 1, NULL, c.id,
            _actor, who_name, who_role, who_branch, who_branch_name, dev_registered, dev_label, gate->>'code', source
          FROM unnest(asked) x;
        handed := asked;
        result := 'handed_over';
        -- Everything handed over: the order is delivered, as if an admin set it (client, 10 Nov 2026).
        IF NOT EXISTS (SELECT 1 FROM generate_series(1, line_count) g WHERE NOT private.delivery_line_done(n.id, g))
           AND o.order_status IN ('Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery') THEN
          status_before := o.order_status;
          PERFORM set_config('app.delivery_handover', 'on', true);
          UPDATE public.orders SET order_status = 'Delivered' WHERE id = o.id;
          PERFORM set_config('app.delivery_handover', '', true);
          delivered := true;
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.delivery_scans (invoice_code_id, note_id, order_no, code_hint, action, result, doc, asked, lines,
      gate_code, gate_source, order_delivered, order_status_before, actor_id, actor_name, actor_role, branch_id, branch_name, device_registered, device_label)
    VALUES (c.id, n.id, o.order_no, left(hash, 12), act, result, 'invoice', asked, handed,
      gate->>'code', source, delivered, status_before, _actor, who_name, who_role, who_branch, who_branch_name, dev_registered, dev_label)
    RETURNING id INTO scan_id;

  IF result IN ('replaced', 'other_godown') THEN
    -- Nothing about the customer or the items for someone who may not see them.
    RETURN jsonb_build_object('kind', 'invoice', 'result', result, 'action', act, 'scan_id', scan_id, 'scanned_at', now(),
      'by', who_name, 'role', who_role, 'godown', who_branch_name, 'order_godown', godown_name,
      'device', jsonb_build_object('registered', dev_registered, 'label', dev_label),
      'invoice', CASE WHEN result = 'replaced'
        THEN jsonb_build_object('order_no', o.order_no, 'generation', c.generation, 'revoked_at', c.revoked_at,
          'revoked_by', c.revoked_by, 'revoke_reason', c.revoke_reason, 'live_generation', live.generation)
        ELSE jsonb_build_object('order_no', o.order_no, 'generation', c.generation) END);
  END IF;

  RETURN jsonb_build_object(
    'kind', 'invoice', 'result', result, 'action', act, 'scan_id', scan_id, 'scanned_at', now(),
    'by', who_name, 'role', who_role, 'godown', who_branch_name, 'order_godown', godown_name,
    'device', jsonb_build_object('registered', dev_registered, 'label', dev_label),
    'can', jsonb_build_object('print_note', can_note, 'print_slips', can_slips, 'handover', can_hand),
    'invoice', jsonb_build_object('order_no', o.order_no, 'generation', c.generation),
    'released_now', COALESCE((issued->>'issued')::boolean, false),
    'note', CASE WHEN n.id IS NULL THEN NULL ELSE jsonb_build_object('note_no', n.note_no, 'order_no', n.order_no, 'invoice_number', n.invoice_number,
      'customer', COALESCE(NULLIF(n.snapshot->'customer'->>'business_name', ''), n.snapshot->'customer'->>'name', ''),
      -- The last four digits of the customer's phone, to check who collects.
      'phone_end', right(regexp_replace(COALESCE(n.snapshot->'customer'->>'phone', ''), '\D', '', 'g'), 4),
      'godown', COALESCE(n.snapshot->'godown'->>'name', ''), 'shipping_method', COALESCE(n.snapshot->>'shipping_method', ''),
      'generated_at', n.generated_at, 'generated_how', n.generated_how, 'generated_by_name', n.generated_by_name) END,
    'lines', CASE WHEN n.id IS NULL THEN '[]'::jsonb ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'line', (i->>'line')::integer, 'name', i->>'name', 'qty', i->'qty', 'pack_size', COALESCE(i->>'pack_size', ''), 'stock_no', COALESCE(i->>'stock_no', ''),
        'handover', private.delivery_handover_map(n.id)->(i->>'line')) ORDER BY (i->>'line')::integer), '[]'::jsonb)
      FROM jsonb_array_elements(n.snapshot->'items') i) END,
    'asked', to_jsonb(asked),
    'handed_now', to_jsonb(handed),
    'order_delivered', delivered,
    'order_status_before', status_before,
    'print', printed,
    'gate', jsonb_build_object('code', gate->>'code', 'source', source, 'stop_reason', gate->'stop_reason',
      'items_changed', COALESCE((gate->>'items_changed')::boolean, false), 'invoice_changed', COALESCE((gate->>'invoice_changed')::boolean, false),
      'invoice_number', gate->>'invoice_number', 'zoho_void', o_void)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.delivery_invoice_scan(text, text, jsonb, uuid, integer[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_invoice_scan(text, text, jsonb, uuid, integer[], text) TO service_role;

/*
 * An administrator prints the released note and slips from the office (no QR on them: the invoice QR is the only one
 * that hands goods over). Service role only; the server passes the admin's id.
 */
CREATE OR REPLACE FUNCTION public.delivery_admin_release_print(_order_no text, _note boolean, _slip_lines integer[], _zoho jsonb, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who jsonb := private.delivery_scanner(_actor);
  n public.delivery_notes%ROWTYPE;
  gate jsonb;
BEGIN
  IF who IS NULL OR who->>'role' <> 'admin' THEN RAISE EXCEPTION 'Only administrators can print a delivery note from the office'; END IF;
  SELECT * INTO n FROM public.delivery_notes WHERE order_no = _order_no;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order has no delivery note yet'; END IF;
  gate := private.delivery_note_state(n.order_id, CASE WHEN COALESCE(_zoho->>'read', '') = 'true' AND COALESCE(_zoho->>'source', '') <> 'last_reading'
    THEN _zoho ELSE private.delivery_note_last_reading(n.order_id) END);
  RETURN private.delivery_release_print(n.id, _note, _slip_lines, _actor, who->>'name', 'admin', gate->>'code')
    || jsonb_build_object('gate', gate);
END;
$function$;
REVOKE ALL ON FUNCTION public.delivery_admin_release_print(text, boolean, integer[], jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_admin_release_print(text, boolean, integer[], jsonb, uuid) TO service_role;

/*
 * The godown's released delivery notes, newest first, for the in-charge's and the partner's apps (staff and partners
 * cannot read orders): the last 30 days, with how many items are still to go. Admins see every godown.
 */
CREATE OR REPLACE FUNCTION public.godown_released_notes()
RETURNS TABLE (note_no text, order_no text, customer text, items integer, to_go integer, released_at timestamptz, released_how text, delivered boolean, godown text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  who jsonb := private.delivery_scanner(auth.uid());
BEGIN
  IF who IS NULL THEN RAISE EXCEPTION 'Only godown staff, channel partners and administrators can see released delivery notes'; END IF;
  RETURN QUERY
  SELECT n.note_no, n.order_no,
    COALESCE(NULLIF(n.snapshot->'customer'->>'business_name', ''), n.snapshot->'customer'->>'name', ''),
    jsonb_array_length(n.snapshot->'items'),
    (SELECT count(*)::integer FROM generate_series(1, jsonb_array_length(n.snapshot->'items')) g WHERE NOT private.delivery_line_done(n.id, g)),
    n.generated_at, n.generated_how, o.order_status = 'Delivered', COALESCE(n.snapshot->'godown'->>'name', '')
  FROM public.delivery_notes n JOIN public.orders o ON o.id = n.order_id
  WHERE n.generated_at > now() - interval '30 days'
    AND (who->>'role' = 'admin' OR NULLIF(n.snapshot->'godown'->>'id', '') = who->>'branch_id')
  ORDER BY n.generated_at DESC
  LIMIT 200;
END;
$function$;
REVOKE ALL ON FUNCTION public.godown_released_notes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.godown_released_notes() TO authenticated;

-- Who am I at the godown: the scan screen and the staff app show the right buttons (the database decides again on each
-- press). NULL for a customer.
CREATE OR REPLACE FUNCTION public.my_delivery_role()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN w IS NULL THEN NULL ELSE w || jsonb_build_object('rules', private.delivery_qr_rules()) END
  FROM (SELECT private.delivery_scanner(auth.uid()) AS w) s
$function$;
REVOKE ALL ON FUNCTION public.my_delivery_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_delivery_role() TO authenticated;

NOTIFY pgrst, 'reload schema';
