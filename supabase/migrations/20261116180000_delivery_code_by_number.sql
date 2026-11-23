-- 16 Nov 2026 (owner): "if QR come also in case in channel partner phone no camera works mean then need proper
-- alternative to enter manually the alphanumeric code and if any invoice id is there".
-- The scan page now also takes, typed: the invoice QR's code (printed under the QR from today), the order number or the
-- Zoho invoice number. private.delivery_code_row finds the delivery code for any of them: the code itself (as before,
-- also a replaced one, so the scan says "replaced"), or for a number the order's live code. delivery_invoice_scan and
-- delivery_invoice_order_no are the live definitions (read 16 Nov 2026) with only their code lookup changed; every
-- check after it (only that godown's people, the admin's rules, payment) is unchanged.

CREATE OR REPLACE FUNCTION private.delivery_code_row(_given text)
RETURNS SETOF private.order_delivery_codes
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH g AS (SELECT regexp_replace(left(btrim(COALESCE(_given, '')), 200), '\s+', '', 'g') AS v)
  SELECT (found.c).* FROM (
    SELECT c, 1 AS pick, c.generation AS gen FROM private.order_delivery_codes c, g
      WHERE g.v ~ '^[A-Za-z0-9_-]{22}$' AND c.code_hash = private.delivery_code_hash(g.v)
    UNION ALL
    SELECT c, 2, c.generation FROM private.order_delivery_codes c JOIN public.orders o ON o.id = c.order_id, g
      WHERE g.v <> '' AND c.revoked_at IS NULL
        AND (upper(o.order_no) = upper(g.v)
          OR EXISTS (SELECT 1 FROM public.zoho_order_invoices z WHERE z.order_id = o.id AND upper(z.invoice_number) = upper(g.v)))
  ) found
  ORDER BY found.pick, found.gen DESC
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION private.delivery_code_row(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.delivery_invoice_order_no(_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT o.order_no FROM private.delivery_code_row(_code) c JOIN public.orders o ON o.id = c.order_id
$function$;
REVOKE ALL ON FUNCTION public.delivery_invoice_order_no(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_invoice_order_no(text) TO service_role;

CREATE OR REPLACE FUNCTION public.delivery_invoice_scan(_code text, _action text, _zoho jsonb, _actor uuid, _lines integer[] DEFAULT NULL::integer[], _device text DEFAULT NULL::text)
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
  -- 16 Nov 2026 (owner): the QR's code, or (typed when the camera does not work) that code or the order's or invoice's
  -- number. The godown check below is the same for all of them.
  SELECT * INTO c FROM private.delivery_code_row(given) LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  hash := c.code_hash;
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
