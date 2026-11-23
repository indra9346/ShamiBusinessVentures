-- 12 Nov 2026, the owner (11 Nov): "during marking handover or delivered their name and details including other data of
-- them should be displayed accurately & later those details should be pushed to invoice below QR code it should mention
-- who handed over goods and time and accordingly godown details".
--
-- The hand-over person's mobile is now kept with each hand-over (staff and partners: their own record's mobile; admins:
-- their profile's), the scan answer says who scanned with their mobile and the godown's details, and the invoice's
-- delivery answer lists who handed over which item, when, at which godown, with the godown's name, address and phone
-- and the order's channel partner (the one whose signature the invoice carries).
-- Only a column, a trigger on new hand-overs and function bodies change; no existing row is touched (the hand-over
-- table is permanent, older hand-overs simply have no mobile).

ALTER TABLE public.delivery_handovers ADD COLUMN IF NOT EXISTS actor_phone text NOT NULL DEFAULT '';

-- Every new hand-over keeps the person's mobile, also those recorded through the older printed paper QRs
-- (public.delivery_paper_scan, unchanged): a blank mobile is filled from the person's own record.
CREATE OR REPLACE FUNCTION private.delivery_handover_fill_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.actor_phone, '') = '' AND NEW.actor_id IS NOT NULL THEN
    NEW.actor_phone := COALESCE(private.delivery_scanner(NEW.actor_id)->>'phone', '');
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_handover_fill_phone() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS delivery_handovers_fill_phone ON public.delivery_handovers;
CREATE TRIGGER delivery_handovers_fill_phone BEFORE INSERT ON public.delivery_handovers
  FOR EACH ROW EXECUTE FUNCTION private.delivery_handover_fill_phone();

-- A godown's details for the scan screen and the invoice: name, address lines, phone, GSTIN, and the channel partner
-- running it today (the invoice puts the order's own partner in their place, see invoice_delivery_code).
CREATE OR REPLACE FUNCTION private.delivery_godown_details(_branch_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object('id', b.id, 'name', COALESCE(b.name, ''), 'address', COALESCE(b.address, ''), 'city', COALESCE(b.city, ''),
    'state', COALESCE(b.state, ''), 'pincode', COALESCE(b.pincode, ''), 'phone', COALESCE(b.phone, ''), 'gstin', COALESCE(b.gstin, ''),
    -- The godown's channel partner too (owner, 11 Nov 2026: "and there is channel partner also").
    'partner_name', COALESCE((SELECT p.name FROM public.channel_partners p WHERE p.branch_id = b.id AND p.status = 'active' ORDER BY p.created_at DESC LIMIT 1), ''),
    'partner_phone', COALESCE((SELECT p.phone FROM public.channel_partners p WHERE p.branch_id = b.id AND p.status = 'active' ORDER BY p.created_at DESC LIMIT 1), ''))
  FROM public.branches b WHERE b.id = _branch_id
$function$;
REVOKE ALL ON FUNCTION private.delivery_godown_details(text) FROM PUBLIC, anon, authenticated;

-- Each item line handed over now, with the hand-over person's mobile.
CREATE OR REPLACE FUNCTION private.delivery_handover_map(_note_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_object_agg(h.slip_line::text, jsonb_build_object(
    'at', h.handed_over_at, 'by', h.actor_name, 'role', h.actor_role, 'phone', h.actor_phone, 'godown', h.branch_name,
    'registered_phone', h.device_registered, 'round', h.round)), '{}'::jsonb)
  FROM public.delivery_handovers h
  WHERE h.note_id = _note_id AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = h.id)
$function$;
REVOKE ALL ON FUNCTION private.delivery_handover_map(uuid) FROM PUBLIC, anon, authenticated;

-- Who is scanning, now with their mobile (from 20261112120000; only the phone is added).
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
  phone text;
BEGIN
  IF private.delivery_actor_is_admin(_actor) THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), '')), COALESCE(btrim(p.phone), '') INTO name, phone FROM public.profiles p WHERE p.id = _actor;
    RETURN jsonb_build_object('role', 'admin', 'name', COALESCE(name, 'Admin ' || left(_actor::text, 8)), 'branch_id', NULL, 'branch_name', '', 'phone', COALESCE(phone, ''));
  END IF;
  SELECT jsonb_build_object('role', CASE WHEN e.is_incharge THEN 'incharge' ELSE 'staff' END, 'name', e.name,
      'branch_id', e.branch_id, 'branch_name', COALESCE(b.name, e.branch_id), 'phone', COALESCE(e.phone, ''))
    INTO who
    FROM public.staff_employees e LEFT JOIN public.branches b ON b.id = e.branch_id
    WHERE e.user_id = _actor AND e.status = 'active';
  IF who IS NOT NULL THEN RETURN who; END IF;
  SELECT jsonb_build_object('role', 'partner', 'name', p.name, 'branch_id', p.branch_id, 'branch_name', COALESCE(b.name, p.branch_id), 'phone', COALESCE(p.phone, ''))
    INTO who
    FROM public.channel_partners p LEFT JOIN public.branches b ON b.id = p.branch_id
    WHERE p.user_id = _actor AND p.status = 'active';
  RETURN who;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_scanner(uuid) FROM PUBLIC, anon, authenticated;

-- The invoice's delivery answer, now with the hand-overs and the godown (from 20261112120000; additions marked).
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
  -- Who handed over which item and when, at which godown (owner, 11 Nov 2026: "later those details should be pushed to
  -- invoice below QR code"), and the godown's own details. The channel partner named is the order's own: the one whose
  -- signature the invoice carries (private.order_signing_partner), so a later change of partner does not change an
  -- older invoice; none when the order has none.
  RETURN jsonb_build_object('code', c.code, 'generation', c.generation, 'why', 'paid',
    'note_no', n.note_no, 'released_at', n.generated_at, 'released_how', n.generated_how,
    'godown', private.delivery_godown_details(private.order_godown_id(o.id)) || COALESCE(
      (SELECT jsonb_build_object('partner_name', COALESCE(p.name, ''), 'partner_phone', COALESCE(p.phone, ''))
        FROM public.channel_partners p WHERE p.id = private.order_signing_partner(o.id)),
      jsonb_build_object('partner_name', '', 'partner_phone', '')),
    'handovers', CASE WHEN n.id IS NULL THEN '[]'::jsonb ELSE (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'line', h.slip_line, 'item', i->>'name', 'qty', i->'qty', 'at', h.handed_over_at, 'by', h.actor_name, 'role', h.actor_role,
          'phone', h.actor_phone, 'godown', h.branch_name) ORDER BY h.handed_over_at, h.slip_line), '[]'::jsonb)
      FROM public.delivery_handovers h
      LEFT JOIN LATERAL (SELECT x AS i FROM jsonb_array_elements(n.snapshot->'items') x WHERE (x->>'line')::integer = h.slip_line LIMIT 1) item ON true
      WHERE h.note_id = n.id AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = h.id)) END,
    'items', CASE WHEN n.id IS NULL THEN 0 ELSE jsonb_array_length(n.snapshot->'items') END,
    -- Hand-overs the office reopened (those items wait to be handed over again).
    'reopened', CASE WHEN n.id IS NULL THEN 0 ELSE (SELECT count(*) FROM public.delivery_handover_reopens r WHERE r.note_id = n.id) END);
END;
$function$;
REVOKE ALL ON FUNCTION public.invoice_delivery_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_delivery_code(text) TO authenticated;

-- The scan of an invoice QR, now recording the hand-over person's mobile and saying the godown's details
-- (from 20261112120000; only those two additions).
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
        INSERT INTO public.delivery_handovers (note_id, slip_line, round, code_id, invoice_code_id, actor_id, actor_name, actor_role, actor_phone, branch_id, branch_name,
            device_registered, device_label, gate_code, gate_source)
          SELECT n.id, x, (SELECT count(*) FROM public.delivery_handovers h WHERE h.note_id = n.id AND h.slip_line = x) + 1, NULL, c.id,
            _actor, who_name, who_role, COALESCE(who->>'phone', ''), who_branch, who_branch_name, dev_registered, dev_label, gate->>'code', source
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
    'by', who_name, 'role', who_role, 'godown', who_branch_name, 'order_godown', godown_name, 'by_phone', COALESCE(who->>'phone', ''),
    'godown_details', private.delivery_godown_details(godown_id),
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

NOTIFY pgrst, 'reload schema';
