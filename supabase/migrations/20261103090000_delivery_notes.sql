-- Delivery notes and per-item delivery slips (client's handwritten rules, 2 Nov 2026):
--   "Option to generate delivery note only after full invoice amount is paid. Partly paid - Do not
--    generate, show them to make complete payment."
--   "Generate different delivery slips for each item & delivery note, time should be printed."
--
-- The payment rule lives here, not in the browser or the server code:
--   * private.delivery_note_gate is the only thing that decides. It compares the website's records
--     (orders, payments, bank alerts) with what the server has just read from Zoho Books. If they
--     disagree, or Zoho could not be read, the answer is no, with a code saying why.
--   * Money is recorded in two places that only partly talk to each other. A payment confirmed on the
--     website reaches Books at the next sync; a payment entered in Books never reaches orders.paid_amount.
--     That is why orders.payment_status alone proves nothing.
--   * issue_delivery_note and record_delivery_print take the Zoho reading as an argument, so only the
--     trusted server (service role) may call them. An admin's browser cannot pass in a made-up reading.
--
-- Numbers (DN-000001, ...) come from a one-row counter updated in the same transaction as the note, so
-- a failure takes the number back with it: no gaps, no reuse. Notes and their history cannot be changed
-- or deleted; the service role can only read them. Nothing here writes to Zoho or changes an order.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS public.delivery_note_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_no bigint NOT NULL DEFAULT 0 CHECK (last_no >= 0)
);
INSERT INTO public.delivery_note_counter (id, last_no) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.delivery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint NOT NULL UNIQUE,
  note_no text NOT NULL UNIQUE,
  -- One note per order, and an order that has a note cannot be deleted.
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_no text NOT NULL,
  -- One note per invoice.
  zoho_invoice_id text NOT NULL UNIQUE,
  invoice_number text NOT NULL,
  invoice_total numeric(14,2) NOT NULL,
  order_total numeric(14,2) NOT NULL,
  paid_amount numeric(14,2) NOT NULL,
  -- What the paper shows, fixed at generation: customer, address, godown, items, pack sizes.
  snapshot jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid NOT NULL,
  generated_by_name text NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_notes_generated_idx ON public.delivery_notes (generated_at DESC);

CREATE TABLE IF NOT EXISTS public.delivery_note_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.delivery_notes(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('generated', 'printed', 'order_changed', 'invoice_changed', 'payment_problem', 'stop_changed')),
  doc text CHECK (doc IN ('note', 'slip')),
  slip_line integer CHECK (slip_line IS NULL OR slip_line >= 1),
  copy_no integer CHECK (copy_no IS NULL OR copy_no >= 1),
  -- What the payment check said at that moment: a printed copy carries a warning unless this is 'paid'.
  gate_code text,
  detail text NOT NULL DEFAULT '',
  actor_id uuid,
  actor_name text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'printed' OR (doc IS NOT NULL AND copy_no IS NOT NULL)),
  CHECK ((doc = 'slip') = (slip_line IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS delivery_note_events_note_idx ON public.delivery_note_events (note_id, occurred_at);
-- A copy number is used once per document.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_note_events_copy_idx
  ON public.delivery_note_events (note_id, doc, COALESCE(slip_line, 0), copy_no) WHERE kind = 'printed';

-- An admin's stop on an order's delivery. The site has no way to record a refund or a dispute, so this
-- is how the office stops a note and warns on any paper already printed. Each stop and lift is a new row;
-- the newest row for the order decides.
CREATE TABLE IF NOT EXISTS public.delivery_stops (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  stopped boolean NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_stops_order_idx ON public.delivery_stops (order_id, id DESC);

-- Supabase's default privileges hand new tables and sequences to anon, authenticated and service_role, so
-- take them all back first. Writes go only through the functions below, which run as their owner.
REVOKE ALL ON public.delivery_note_counter, public.delivery_notes, public.delivery_note_events, public.delivery_stops FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.delivery_note_events_id_seq, public.delivery_stops_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.delivery_notes, public.delivery_note_events, public.delivery_stops TO authenticated, service_role;

ALTER TABLE public.delivery_note_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_note_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_stops ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_notes_admin_read ON public.delivery_notes;
CREATE POLICY delivery_notes_admin_read ON public.delivery_notes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_note_events_admin_read ON public.delivery_note_events;
CREATE POLICY delivery_note_events_admin_read ON public.delivery_note_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS delivery_stops_admin_read ON public.delivery_stops;
CREATE POLICY delivery_stops_admin_read ON public.delivery_stops FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- nothing is ever changed or removed
CREATE OR REPLACE FUNCTION private.delivery_records_are_permanent()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Delivery notes and their history cannot be changed or deleted';
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_records_are_permanent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS delivery_notes_permanent ON public.delivery_notes;
CREATE TRIGGER delivery_notes_permanent BEFORE UPDATE OR DELETE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_notes_permanent_truncate ON public.delivery_notes;
CREATE TRIGGER delivery_notes_permanent_truncate BEFORE TRUNCATE ON public.delivery_notes
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_note_events_permanent ON public.delivery_note_events;
CREATE TRIGGER delivery_note_events_permanent BEFORE UPDATE OR DELETE ON public.delivery_note_events
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_note_events_permanent_truncate ON public.delivery_note_events;
CREATE TRIGGER delivery_note_events_permanent_truncate BEFORE TRUNCATE ON public.delivery_note_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_stops_permanent ON public.delivery_stops;
CREATE TRIGGER delivery_stops_permanent BEFORE UPDATE OR DELETE ON public.delivery_stops
  FOR EACH ROW EXECUTE FUNCTION private.delivery_records_are_permanent();
DROP TRIGGER IF EXISTS delivery_stops_permanent_truncate ON public.delivery_stops;
CREATE TRIGGER delivery_stops_permanent_truncate BEFORE TRUNCATE ON public.delivery_stops
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_records_are_permanent();

-- The counter only ever goes up by one.
CREATE OR REPLACE FUNCTION private.delivery_note_counter_only_up()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.last_no <> OLD.last_no + 1 THEN
    RAISE EXCEPTION 'Delivery note numbers are never reset or reused';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_counter_only_up() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS delivery_note_counter_guard ON public.delivery_note_counter;
CREATE TRIGGER delivery_note_counter_guard BEFORE UPDATE OR DELETE ON public.delivery_note_counter
  FOR EACH ROW EXECUTE FUNCTION private.delivery_note_counter_only_up();
DROP TRIGGER IF EXISTS delivery_note_counter_guard_truncate ON public.delivery_note_counter;
CREATE TRIGGER delivery_note_counter_guard_truncate BEFORE TRUNCATE ON public.delivery_note_counter
  FOR EACH STATEMENT EXECUTE FUNCTION private.delivery_note_counter_only_up();

-- ---------------------------------------------------------------- the payment gate
-- A number from the Zoho reading, or NULL. A missing amount must never read as zero.
CREATE OR REPLACE FUNCTION private.delivery_fact_amount(_facts jsonb, _key text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE WHEN jsonb_typeof(_facts->_key) = 'number' THEN round((_facts->>_key)::numeric, 2) END
$function$;
REVOKE ALL ON FUNCTION private.delivery_fact_amount(jsonb, text) FROM PUBLIC, anon, authenticated;

-- What the website last read from Zoho, for showing a state without a Zoho call. It can show why not,
-- but it cannot generate a note: issue_delivery_note refuses it. Its copy has no payment_made.
CREATE OR REPLACE FUNCTION private.delivery_note_last_reading(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'source', 'last_reading', 'read', true,
    'live_invoices', CASE WHEN z.zoho_invoice_id IS NOT NULL AND z.status IN ('sent', 'overdue', 'partially_paid', 'paid') THEN 1 ELSE 0 END,
    'invoice_id', COALESCE(z.zoho_invoice_id, ''), 'invoice_number', COALESCE(z.invoice_number, ''),
    'status', COALESCE(z.status, ''), 'total', z.total, 'balance', z.balance)
  FROM (SELECT _order_id AS id) o
  LEFT JOIN public.zoho_order_invoices z ON z.order_id = o.id
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_last_reading(uuid) FROM PUBLIC, anon, authenticated;

/*
 * Whether a delivery note may be generated for the order now, and why not.
 * _zoho is what the server read from Zoho Books a moment ago:
 *   { "read": true, "live_invoices": 1, "invoice_id", "invoice_number", "status", "total", "balance",
 *     "payment_made", "credits_applied", "write_off_amount" }
 *   { "read": false, "error": "..." }
 * Only code 'paid' allows a note. The codes are explained to people in src/lib/delivery-notes.ts.
 */
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
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'not_found'); END IF;
  total := COALESCE(o.total, 0);
  paid := COALESCE(o.paid_amount, 0);
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
    'invoice_status', z_status, 'invoice_total', z_total, 'invoice_balance', z_balance, 'invoice_payment_made', z_made
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_gate(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- The order's lines as the paper shows them, numbered in a fixed order.
CREATE OR REPLACE FUNCTION private.delivery_note_lines(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(line ORDER BY (line->>'line')::integer), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'line', row_number() OVER (ORDER BY i.created_at, i.product_name, i.id),
      'order_item_id', i.id::text, 'product_id', i.product_id, 'name', i.product_name, 'sku', COALESCE(i.sku, ''),
      'qty', i.qty, 'capacity', COALESCE(i.capacity, ''),
      'pack_size', COALESCE(NULLIF(btrim(i.capacity), ''), NULLIF(btrim(c.payload->>'weight'), ''), ''),
      'stock_no', COALESCE(i.batch_code, '')
    ) AS line
    FROM public.order_items i
    LEFT JOIN public.catalog_products c ON c.id = i.product_id
    WHERE i.order_id = _order_id
  ) lines
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_lines(uuid) FROM PUBLIC, anon, authenticated;

-- A list of lines reduced to what must not change on the order itself: which line, how many, what capacity.
-- The catalogue's own weight is left out, so editing a product doesn't look like editing this order.
CREATE OR REPLACE FUNCTION private.delivery_note_line_key(_lines jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_array(l->>'order_item_id', l->'qty', l->>'capacity') ORDER BY l->>'order_item_id'), '[]'::jsonb)
  FROM jsonb_array_elements(_lines) l
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_line_key(jsonb) FROM PUBLIC, anon, authenticated;

-- The gate, plus what has happened to an existing note: items changed, or a different invoice now.
CREATE OR REPLACE FUNCTION private.delivery_note_state(_order_id uuid, _zoho jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  gate jsonb := private.delivery_note_gate(_order_id, _zoho);
  n public.delivery_notes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.delivery_notes WHERE order_id = _order_id;
  IF NOT FOUND THEN RETURN gate || jsonb_build_object('note_no', NULL, 'items_changed', false, 'invoice_changed', false); END IF;
  RETURN gate || jsonb_build_object(
    'note_no', n.note_no,
    'items_changed', private.delivery_note_line_key(n.snapshot->'items') IS DISTINCT FROM private.delivery_note_line_key(private.delivery_note_lines(_order_id)),
    'invoice_changed', COALESCE(gate->>'invoice_id', '') <> '' AND gate->>'invoice_id' <> n.zoho_invoice_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_state(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- called by the trusted server only
-- public.has_role answers false when nobody is signed in, which is how the service role runs, so the
-- server's actor is looked up directly.
CREATE OR REPLACE FUNCTION private.delivery_actor_is_admin(_actor uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = _actor AND ur.role = 'admin'), false)
$function$;
REVOKE ALL ON FUNCTION private.delivery_actor_is_admin(uuid) FROM PUBLIC, anon, authenticated;

-- With _zoho NULL, the check runs on what the website last read from Zoho: no Zoho call to open a page.
CREATE OR REPLACE FUNCTION public.delivery_note_check(_order_no text, _zoho jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE target uuid;
BEGIN
  SELECT id INTO target FROM public.orders WHERE order_no = _order_no;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'not_found'); END IF;
  RETURN private.delivery_note_state(target, COALESCE(_zoho, private.delivery_note_last_reading(target)));
END;
$function$;
REVOKE ALL ON FUNCTION public.delivery_note_check(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_note_check(text, jsonb) TO service_role;

/*
 * Generates the order's one delivery note if the gate allows it. The order row stays locked from the
 * check to the insert, so a payment change cannot slip between them. A second call returns the same
 * note, never a new number. Only a reading of Zoho taken just now can generate one.
 */
CREATE OR REPLACE FUNCTION public.issue_delivery_note(_order_no text, _zoho jsonb, _actor uuid, _actor_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  n public.delivery_notes%ROWTYPE;
  gate jsonb;
  who text := left(btrim(COALESCE(_actor_name, '')), 120);
  reading jsonb := CASE WHEN COALESCE(_zoho->>'source', '') = 'last_reading' THEN NULL ELSE _zoho END;
  next_no bigint;
  godown jsonb;
  company jsonb;
BEGIN
  IF NOT private.delivery_actor_is_admin(_actor) THEN RAISE EXCEPTION 'Only administrators can generate a delivery note'; END IF;
  IF who = '' THEN RAISE EXCEPTION 'Who generated the delivery note must be recorded'; END IF;
  reading := COALESCE(reading, jsonb_build_object('read', false, 'error', 'Zoho was not read just now'));
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('issued', false, 'gate', jsonb_build_object('allowed', false, 'code', 'not_found')); END IF;
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
  INSERT INTO public.delivery_notes (seq, note_no, order_id, order_no, zoho_invoice_id, invoice_number, invoice_total, order_total, paid_amount, snapshot, generated_by, generated_by_name)
  VALUES (next_no, 'DN-' || lpad(next_no::text, GREATEST(6, length(next_no::text)), '0'), o.id, o.order_no, gate->>'invoice_id', gate->>'invoice_number',
    (gate->>'invoice_total')::numeric, o.total, o.paid_amount,
    jsonb_build_object(
      'order_placed_at', o.created_at,
      'shipping_method', COALESCE(o.shipping_method, ''),
      'customer', jsonb_build_object('name', COALESCE(o.customer_name, ''), 'phone', COALESCE(NULLIF(o.customer_phone, ''), o.shipping_address->>'phone', ''),
        'business_name', COALESCE(o.business_legal_name, ''), 'gstin', COALESCE(o.customer_gstin, '')),
      -- The checkout stores this as sent, so take each field as plain text.
      'address', jsonb_build_object('name', COALESCE(o.shipping_address->>'name', ''), 'phone', COALESCE(o.shipping_address->>'phone', ''),
        'line', COALESCE(o.shipping_address->>'line', ''), 'city', COALESCE(o.shipping_address->>'city', ''),
        'state', COALESCE(o.shipping_address->>'state', ''), 'pin', COALESCE(o.shipping_address->>'pin', '')),
      'godown', COALESCE(godown, '{}'::jsonb),
      'company', COALESCE(company, '{}'::jsonb),
      'items', private.delivery_note_lines(o.id)
    ),
    _actor, who)
  RETURNING * INTO n;
  INSERT INTO public.delivery_note_events (note_id, kind, gate_code, actor_id, actor_name)
    VALUES (n.id, 'generated', gate->>'code', _actor, who);
  RETURN jsonb_build_object('issued', true, 'note_id', n.id, 'note_no', n.note_no, 'gate', private.delivery_note_state(o.id, reading));
END;
$function$;
REVOKE ALL ON FUNCTION public.issue_delivery_note(text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_delivery_note(text, jsonb, uuid, text) TO service_role;

/*
 * Records one press of Print: who, when, and which copy each paper is. The time returned is the time
 * printed on the paper. Copy 1 is the original; every later copy is a reprint.
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
      VALUES (n.id, 'printed', 'note', note_copy, code, _actor, who);
  END IF;
  FOR line IN SELECT DISTINCT l FROM unnest(lines) AS l ORDER BY 1 LOOP
    IF line IS NULL OR line < 1 OR line > line_count THEN RAISE EXCEPTION 'This note has no slip %', line; END IF;
    SELECT COALESCE(max(copy_no), 0) + 1 INTO copy FROM public.delivery_note_events
      WHERE note_id = n.id AND kind = 'printed' AND doc = 'slip' AND slip_line = line;
    INSERT INTO public.delivery_note_events (note_id, kind, doc, slip_line, copy_no, gate_code, actor_id, actor_name)
      VALUES (n.id, 'printed', 'slip', line, copy, code, _actor, who);
    slip_copies := slip_copies || jsonb_build_object(line::text, copy);
  END LOOP;
  RETURN jsonb_build_object('printed_at', now(), 'note_copy', note_copy, 'slip_copies', slip_copies, 'gate', gate);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_delivery_print(uuid, boolean, integer[], jsonb, uuid, text) TO service_role;

/*
 * Admin > Delivery Notes: every note, newest first, with the check run on what the website last knew
 * of Zoho (no Zoho call per row), so a note whose order was cancelled or refunded stands out.
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
      'state', private.delivery_note_state(n.order_id, private.delivery_note_last_reading(n.order_id))
    ) AS entry
    FROM public.delivery_notes n
    ORDER BY n.seq DESC
    LIMIT GREATEST(1, LEAST(COALESCE(_limit, 500), 2000))
  ) entries
$function$;
REVOKE ALL ON FUNCTION public.delivery_note_register(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_note_register(integer) TO service_role;

-- ---------------------------------------------------------------- after a note exists
-- Writes the change into the note's history and tells the admins. A failure here is only a warning: it
-- must never stop the order, invoice or bank change that called it.
CREATE OR REPLACE FUNCTION private.delivery_note_flag(_order_id uuid, _kind text, _detail text, _tell_admins text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE n public.delivery_notes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.delivery_notes WHERE order_id = _order_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.delivery_note_events (note_id, kind, detail) VALUES (n.id, _kind, left(_detail, 500));
  IF _tell_admins IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT n.order_no, n.order_id, ur.user_id, 'admin', 'Delivery note affected',
      format('Delivery note %s, order %s: %s', n.note_no, n.order_no, _tell_admins), 'delivery_note'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Delivery note history not written for order %: %', _order_id, SQLERRM;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_flag(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

/*
 * The office stops or lifts delivery on an order, with a reason. A stop refuses a new note and warns on
 * every later print. It changes nothing about the order or its payment.
 */
CREATE OR REPLACE FUNCTION public.set_delivery_stop(_order_no text, _stopped boolean, _reason text, _actor uuid, _actor_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  who text := left(btrim(COALESCE(_actor_name, '')), 120);
  why text := left(btrim(COALESCE(_reason, '')), 300);
  stopped_now boolean;
BEGIN
  IF NOT private.delivery_actor_is_admin(_actor) THEN RAISE EXCEPTION 'Only administrators can stop a delivery'; END IF;
  IF who = '' THEN RAISE EXCEPTION 'Who stopped the delivery must be recorded'; END IF;
  IF _stopped IS NULL THEN RAISE EXCEPTION 'Choose stop or lift'; END IF;
  IF length(why) < 3 THEN RAISE EXCEPTION 'Enter the reason'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  SELECT s.stopped INTO stopped_now FROM public.delivery_stops s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1;
  IF COALESCE(stopped_now, false) = _stopped THEN
    RAISE EXCEPTION '%', CASE WHEN _stopped THEN 'Delivery on this order is already stopped' ELSE 'Delivery on this order is not stopped' END;
  END IF;
  INSERT INTO public.delivery_stops (order_id, stopped, reason, actor_id, actor_name) VALUES (o.id, _stopped, why, _actor, who);
  PERFORM private.delivery_note_flag(o.id, 'stop_changed',
    format('%s by %s: %s', CASE WHEN _stopped THEN 'Delivery stopped' ELSE 'Stop lifted' END, who, why),
    CASE WHEN _stopped THEN format('delivery was stopped by %s: %s. Do not release the goods. Collect any printed note and slips.', who, why) END);
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_delivery_stop(text, boolean, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_delivery_stop(text, boolean, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION private.delivery_note_watch_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ended boolean := NEW.order_status IN ('Cancelled', 'Payment Expired') AND NEW.order_status IS DISTINCT FROM OLD.order_status;
  money boolean := NEW.payment_status IS DISTINCT FROM OLD.payment_status
    OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount OR NEW.total IS DISTINCT FROM OLD.total;
BEGIN
  -- Packed to Dispatched and so on are normal and don't touch the note.
  IF NOT ended AND NOT money THEN RETURN NEW; END IF;
  PERFORM private.delivery_note_flag(NEW.id, 'order_changed',
    concat_ws('; ',
      CASE WHEN NEW.order_status IS DISTINCT FROM OLD.order_status THEN format('Order %s to %s', OLD.order_status, NEW.order_status) END,
      CASE WHEN NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN format('payment %s to %s', OLD.payment_status, NEW.payment_status) END,
      CASE WHEN NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN format('paid Rs %s to Rs %s', OLD.paid_amount, NEW.paid_amount) END,
      CASE WHEN NEW.total IS DISTINCT FROM OLD.total THEN format('total Rs %s to Rs %s', OLD.total, NEW.total) END),
    CASE
      WHEN NEW.order_status = 'Cancelled' THEN 'the order was cancelled. Do not release the goods. Collect any printed note and slips.'
      WHEN NEW.payment_status = 'Refunded' THEN 'the payment was refunded. Do not release the goods. Collect any printed note and slips.'
      ELSE format('the payment record changed (payment %s, paid Rs %s of Rs %s). Check before releasing the goods.', NEW.payment_status, NEW.paid_amount, NEW.total)
    END);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_watch_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_watch_delivery_note ON public.orders;
CREATE TRIGGER orders_watch_delivery_note AFTER UPDATE OF order_status, payment_status, paid_amount, total ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.delivery_note_watch_order();

CREATE OR REPLACE FUNCTION private.delivery_note_watch_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  old_status text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
  new_status text := CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE NEW.status END;
  old_balance numeric := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.balance END;
  new_balance numeric := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.balance END;
  label text := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_number ELSE NEW.invoice_number END;
  target uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.zoho_invoice_id IS NOT DISTINCT FROM OLD.zoho_invoice_id
     AND NEW.balance IS NOT DISTINCT FROM OLD.balance AND NEW.total IS NOT DISTINCT FROM OLD.total THEN
    RETURN NEW;
  END IF;
  PERFORM private.delivery_note_flag(target, 'invoice_changed',
    format('Zoho invoice %s: %s to %s; balance %s to %s', COALESCE(label, ''), COALESCE(old_status, 'none'), new_status, old_balance, new_balance),
    CASE WHEN new_status <> 'paid' OR COALESCE(new_balance, 0) <> 0
      THEN format('its Zoho invoice is no longer fully paid (%s). Check before releasing the goods.', new_status) END);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_watch_invoice() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zoho_order_invoices_watch_delivery_note ON public.zoho_order_invoices;
CREATE TRIGGER zoho_order_invoices_watch_delivery_note AFTER INSERT OR UPDATE OR DELETE ON public.zoho_order_invoices
  FOR EACH ROW EXECUTE FUNCTION private.delivery_note_watch_invoice();

-- A refund started or made on a return of this order's goods.
CREATE OR REPLACE FUNCTION private.delivery_note_watch_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.refund_status NOT IN ('Processing', 'Refunded') OR (TG_OP = 'UPDATE' AND NEW.refund_status IS NOT DISTINCT FROM OLD.refund_status) THEN
    RETURN NEW;
  END IF;
  PERFORM private.delivery_note_flag(NEW.order_id, 'payment_problem',
    format('Return refund %s, Rs %s', NEW.refund_status, NEW.amount),
    format('a refund on a return of this order is %s (Rs %s). Check before releasing the goods.', lower(NEW.refund_status), NEW.amount));
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_watch_return() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS return_requests_watch_delivery_note ON public.return_requests;
CREATE TRIGGER return_requests_watch_delivery_note AFTER INSERT OR UPDATE OF refund_status ON public.return_requests
  FOR EACH ROW EXECUTE FUNCTION private.delivery_note_watch_return();

-- A bank alert saying less than was recorded for that UTR, arriving after the note.
CREATE OR REPLACE FUNCTION private.delivery_note_watch_bank_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.order_id, p.amount FROM public.payments p
    JOIN public.delivery_notes n ON n.order_id = p.order_id
    WHERE p.status = 'Paid' AND p.amount > NEW.amount AND private.same_utr(p.txn_ref, NEW.utr)
  LOOP
    PERFORM private.delivery_note_flag(r.order_id, 'payment_problem',
      format('Bank alert for UTR %s shows Rs %s, recorded as Rs %s', NEW.utr, NEW.amount, r.amount),
      format('the bank shows Rs %s for a transfer recorded as Rs %s. Check before releasing the goods.', NEW.amount, r.amount));
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Delivery note check on a bank alert failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.delivery_note_watch_bank_credit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bank_credits_watch_delivery_note ON public.bank_credits;
CREATE TRIGGER bank_credits_watch_delivery_note AFTER INSERT ON public.bank_credits
  FOR EACH ROW EXECUTE FUNCTION private.delivery_note_watch_bank_credit();

NOTIFY pgrst, 'reload schema';
