-- Cashfree Payment Gateway for pay-first checkouts (owner, 28 Nov 2026).
--
-- Why: the UPI link and QR the site builds itself (src/lib/upi-pay.ts) are not signed by any payment gateway, so UPI apps
-- refuse bigger amounts whichever UPI ID is used. With Cashfree switched on, a UPI checkout opens Cashfree's own payment
-- screen instead; Cashfree tells us when the payment succeeds.
--
-- How it fits the pay-first path (start_paid_checkout -> Awaiting Payment with stock held -> paid -> Payment Confirmed):
--   * cashfree_orders: one row per Cashfree order made for a checkout. The website server (service role) makes them,
--     through cashfree_open_order, which also decides when an earlier one can be used again. Cashfree's order_id is our
--     order number (a second try gets "_2", "_3").
--   * cashfree_record_payment: the only way a Cashfree payment reaches an order. Called by the website server after it
--     checked the payment with Cashfree (signed webhook, or Cashfree's own API). A successful payment for a checkout that
--     is still waiting pays it in full the way private.confirm_held_payment does for a bank alert (order Payment
--     Confirmed, payment row, customer told, Zoho sales order and invoice queued by the usual triggers); only the UTR
--     table is left alone, since a Cashfree reference is not a bank UTR (upi_payment_submissions_utr_check).
--     One Cashfree payment is recorded once (cf_payment_id is unique, behind an advisory lock); its reference carries the
--     payment id and the UPI UTR, so the same transfer cannot also be sent in as a UTR for another order. A failed,
--     cancelled or dropped payment changes nothing on the order. Money that arrives for a checkout that already ended,
--     was cancelled or was already paid is kept on record as "needs refund" and the admins and the customer are told.
--   * cashfree_webhook_inbox: Cashfree's webhook goes to the Supabase Edge Function cashfree-webhook (Hostinger's bot
--     check refuses calls from servers to grainbazar.com, see 20261111100000_zoho_webhook_inbox.sql). It only parks the
--     call here; the website checks Cashfree's signature with the secret key, which only the website holds.
--   * expire_payment_holds (live text read 28 Nov 2026, equal to 20261106220000_bank_credit_auto_match.sql) gains one
--     condition: a checkout whose Cashfree order is still open is not ended for up to 30 minutes after its time, so a
--     payment made in the last moments is not lost while the website asks Cashfree. The website closes the Cashfree
--     order (asks Cashfree to end it when no payment came) at the end of the time, on the customer's page or on the
--     15-minute job, and the checkout then ends as before.
--   * settings.cashfree_gateway {enabled, testers}: the admin switch (Admin > UPI & Bank Payments), off until an admin
--     turns it on. The website also needs CASHFREE_APP_ID, CASHFREE_SECRET_KEY and CASHFREE_ENV; without them Cashfree is
--     never offered. In sandbox mode only admins and the listed test logins see it.
-- UPI QR and NEFT/RTGS with a UTR keep working exactly as before. Safe to run twice.

BEGIN;

-- ---------------------------------------------------------------- the switch

INSERT INTO public.settings (key, value, is_public, updated_at)
VALUES ('cashfree_gateway', jsonb_build_object('enabled', false, 'testers', jsonb_build_array()), false, now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS public.cashfree_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  -- The order_id we gave Cashfree: our order number, or our order number and _2, _3 for later tries (two orders made in the same second are X and X-2).
  cf_order_ref text NOT NULL UNIQUE CHECK (cf_order_ref ~ '^[0-9A-Za-z_-]{3,45}$'),
  cf_order_id text,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  amount numeric(14,2) NOT NULL CHECK (amount >= 1),
  payment_session_id text,
  expires_at timestamptz,
  -- open: a payment may still come; paid: Cashfree took a payment for it; closed: no payment can come any more.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'closed')),
  cashfree_status text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  closed_at timestamptz,
  closed_note text
);
CREATE INDEX IF NOT EXISTS cashfree_orders_order_idx ON public.cashfree_orders (order_id);
CREATE INDEX IF NOT EXISTS cashfree_orders_open_idx ON public.cashfree_orders (created_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.cashfree_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_payment_id text NOT NULL UNIQUE,
  cf_order_ref text NOT NULL,
  -- Kept when the order is deleted: this is a record of money.
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  order_no text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  amount numeric(14,2) NOT NULL,
  payment_status text NOT NULL,
  payment_group text,
  bank_reference text,
  payment_time timestamptz,
  -- The reference on the website's payment row (and in Zoho): CASHFREE <payment id>[ UTR <12 digits>].
  reference text NOT NULL,
  -- paid_order: it paid the checkout; not_paid: failed, dropped, cancelled or pending; needs_refund: money came for a
  -- checkout that had ended or was already paid; needs_review: the amount or reference did not fit, a person checks.
  outcome text NOT NULL CHECK (outcome IN ('paid_order', 'not_paid', 'needs_refund', 'needs_review')),
  outcome_note text,
  payment_row_id uuid,
  source text NOT NULL CHECK (source IN ('return', 'webhook', 'check', 'admin')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An admin dealt with a needs_refund / needs_review payment: refunded in Cashfree, or the order placed with it.
  settled_at timestamptz,
  settled_by uuid,
  settled_note text
);
CREATE INDEX IF NOT EXISTS cashfree_payments_order_idx ON public.cashfree_payments (order_id);
CREATE INDEX IF NOT EXISTS cashfree_payments_recent_idx ON public.cashfree_payments (first_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.cashfree_webhook_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  signature text NOT NULL,
  webhook_timestamp text NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cashfree_webhook_inbox_oldest ON public.cashfree_webhook_inbox (id);

-- Admins read the Cashfree records; only the server key writes them. Nobody but the server key touches the inbox.
ALTER TABLE public.cashfree_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashfree_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashfree_webhook_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cashfree_orders, public.cashfree_payments, public.cashfree_webhook_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cashfree_orders, public.cashfree_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cashfree_orders, public.cashfree_payments, public.cashfree_webhook_inbox TO service_role;
DROP POLICY IF EXISTS cashfree_orders_admin_read ON public.cashfree_orders;
CREATE POLICY cashfree_orders_admin_read ON public.cashfree_orders FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS cashfree_payments_admin_read ON public.cashfree_payments;
CREATE POLICY cashfree_payments_admin_read ON public.cashfree_payments FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- a Cashfree order for a checkout

/**
 * The website server asks before it makes a Cashfree order for checkout _order_no, paid by _user_id (the signed-in
 * customer, checked by the server). Returns one of:
 *   {action: 'reuse', cf_order_ref, payment_session_id, amount}   an open Cashfree order that still has time;
 *   {action: 'create', cf_order_ref, amount, hold_until, customer}  a new row was made: make it at Cashfree now, then
 *                                                                  save it (cashfree_order_made) or drop it;
 *   {action: 'busy'}                                                another tab is making one this moment.
 * Refuses a checkout that is not this customer's, is not waiting for a UPI payment, or whose time is up.
 */
CREATE OR REPLACE FUNCTION public.cashfree_open_order(_order_no text, _user_id uuid, _environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  c public.cashfree_orders%ROWTYPE;
  due numeric;
  tries integer;
  ref text;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Only the website server makes Cashfree orders'; END IF;
  IF _environment NOT IN ('sandbox', 'production') THEN RAISE EXCEPTION 'Cashfree is not set up'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF _user_id IS NULL OR o.user_id IS DISTINCT FROM _user_id THEN RAISE EXCEPTION 'This is not your order'; END IF;
  IF o.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'This order is not waiting for a payment'; END IF;
  IF COALESCE(o.payment_method, 'UPI') <> 'UPI' THEN RAISE EXCEPTION 'This order is paid by bank transfer'; END IF;
  IF o.payment_hold_until IS NULL OR o.payment_hold_until <= now() THEN RAISE EXCEPTION 'The time to pay for this order is over'; END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE order_id = o.id AND status = 'submitted') THEN
    RAISE EXCEPTION 'You already sent a UTR for this order; we are checking it';
  END IF;
  due := round(o.total - COALESCE(o.paid_amount, 0), 2);
  IF due < 1 THEN RAISE EXCEPTION 'Nothing is due on this order'; END IF;

  SELECT * INTO c FROM public.cashfree_orders
   WHERE order_id = o.id AND status = 'open' AND environment = _environment AND amount = due
     AND payment_session_id IS NOT NULL AND expires_at > now() + interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('action', 'reuse', 'cf_order_ref', c.cf_order_ref, 'payment_session_id', c.payment_session_id, 'amount', c.amount);
  END IF;
  IF EXISTS (SELECT 1 FROM public.cashfree_orders WHERE order_id = o.id AND status = 'open' AND payment_session_id IS NULL
               AND created_at > now() - interval '60 seconds') THEN
    RETURN jsonb_build_object('action', 'busy');
  END IF;
  SELECT count(*) INTO tries FROM public.cashfree_orders WHERE order_id = o.id;
  IF tries >= 9 THEN RAISE EXCEPTION 'Too many tries for this order. Please call us.'; END IF;
  ref := CASE WHEN tries = 0 THEN o.order_no ELSE o.order_no || '_' || (tries + 1) END;
  IF ref !~ '^[0-9A-Za-z_-]{3,45}$' THEN RAISE EXCEPTION 'This order number cannot be sent to Cashfree'; END IF;
  INSERT INTO public.cashfree_orders (order_id, order_no, cf_order_ref, environment, amount, created_by)
  VALUES (o.id, o.order_no, ref, _environment, due, _user_id);
  -- Cashfree needs a mobile number: the order's, else the address's (a pickup order may have none), else the profile's.
  RETURN jsonb_build_object('action', 'create', 'cf_order_ref', ref, 'amount', due, 'hold_until', o.payment_hold_until,
    'customer', jsonb_build_object('name', COALESCE(o.customer_name, ''), 'email', COALESCE(o.customer_email, ''),
      'phone', COALESCE(NULLIF(btrim(o.customer_phone), ''), NULLIF(btrim(o.shipping_address->>'phone'), ''),
        (SELECT NULLIF(btrim(p.phone), '') FROM public.profiles p WHERE p.id = o.user_id), '')));
END;
$function$;
REVOKE ALL ON FUNCTION public.cashfree_open_order(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cashfree_open_order(text, uuid, text) TO service_role;

-- ---------------------------------------------------------------- may a Cashfree payment still come?

/** While a checkout's Cashfree order is open, for up to 30 minutes after its time: the website is still asking Cashfree. */
CREATE OR REPLACE FUNCTION private.cashfree_payment_may_come(_order_id uuid, _hold_until timestamptz)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _hold_until IS NOT NULL AND _hold_until > now() - interval '30 minutes'
     AND EXISTS (SELECT 1 FROM public.cashfree_orders c WHERE c.order_id = _order_id AND c.status = 'open')
$function$;
REVOKE ALL ON FUNCTION private.cashfree_payment_may_come(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- a Cashfree payment reaches the order

CREATE OR REPLACE FUNCTION public.cashfree_record_payment(
  _cf_order_ref text, _cf_payment_id text, _payment_status text, _amount numeric,
  _bank_reference text DEFAULT NULL, _payment_group text DEFAULT NULL, _payment_time timestamptz DEFAULT NULL,
  _source text DEFAULT 'check')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  co public.cashfree_orders%ROWTYPE;
  cp public.cashfree_payments%ROWTYPE;
  o public.orders%ROWTYPE;
  pid text := btrim(COALESCE(_cf_payment_id, ''));
  pay_status text := upper(btrim(COALESCE(_payment_status, '')));
  rrn text := btrim(COALESCE(_bank_reference, ''));
  grp text := lower(btrim(COALESCE(_payment_group, '')));
  amount numeric := round(COALESCE(_amount, 0), 2);
  ref text;
  how text;
  pay_method text;
  due numeric;
  earlier_utr text;
  other_order text;
  paid_row uuid;
  outcome text;
  note text;
  test_money boolean;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Only the website server records Cashfree payments'; END IF;
  IF pid !~ '^[0-9A-Za-z_-]{1,64}$' THEN RAISE EXCEPTION 'Not a Cashfree payment id'; END IF;
  IF _source NOT IN ('return', 'webhook', 'check', 'admin') THEN RAISE EXCEPTION 'Unknown source'; END IF;
  IF pay_status !~ '^[A-Z_]{2,30}$' THEN RAISE EXCEPTION 'Unknown Cashfree payment status'; END IF;
  -- One payment at a time, however it arrives (the customer's page, the webhook and the 15-minute job may all bring it).
  PERFORM pg_advisory_xact_lock(hashtextextended('cashfree-payment:' || pid, 0));
  SELECT * INTO co FROM public.cashfree_orders WHERE cf_order_ref = btrim(COALESCE(_cf_order_ref, ''));
  IF NOT FOUND THEN RAISE EXCEPTION 'Cashfree order % is not one of ours', _cf_order_ref; END IF;
  test_money := co.environment = 'sandbox';
  SELECT * INTO cp FROM public.cashfree_payments WHERE cf_payment_id = pid FOR UPDATE;
  IF FOUND AND cp.cf_order_ref <> co.cf_order_ref THEN RAISE EXCEPTION 'Cashfree payment % belongs to another order', pid; END IF;
  -- A successful payment is recorded once; nothing that arrives later (a repeat, or an older failure) changes it.
  IF FOUND AND cp.payment_status = 'SUCCESS' THEN
    RETURN jsonb_build_object('outcome', cp.outcome, 'order_no', cp.order_no, 'reference', cp.reference, 'already', true);
  END IF;

  how := CASE
    WHEN grp LIKE '%upi%' THEN 'UPI'
    WHEN grp LIKE '%emi%' THEN 'EMI'
    WHEN grp LIKE '%card%' THEN 'Card'
    WHEN grp = 'net_banking' THEN 'Net Banking'
    WHEN grp LIKE '%wallet%' THEN 'Wallet'
    WHEN grp = 'pay_later' THEN 'Pay Later'
    WHEN grp LIKE '%transfer%' THEN 'Bank Transfer'
    ELSE 'Online' END;
  pay_method := CASE WHEN test_money THEN 'Cashfree TEST ' ELSE 'Cashfree ' END || how;
  -- The UPI UTR (12 digits) on the reference, so this transfer can never be sent in again as a UTR for another order.
  ref := CASE WHEN test_money THEN 'CASHFREE TEST ' ELSE 'CASHFREE ' END || pid
    || CASE WHEN how = 'UPI' AND rrn ~ '^[0-9]{12}$' THEN ' UTR ' || rrn ELSE '' END;

  IF pay_status <> 'SUCCESS' THEN
    INSERT INTO public.cashfree_payments (cf_payment_id, cf_order_ref, order_id, order_no, environment, amount, payment_status,
      payment_group, bank_reference, payment_time, reference, outcome, outcome_note, source)
    VALUES (pid, co.cf_order_ref, co.order_id, co.order_no, co.environment, amount, pay_status, NULLIF(grp, ''), NULLIF(rrn, ''),
      _payment_time, ref, 'not_paid', format('Cashfree says %s', pay_status), _source)
    ON CONFLICT (cf_payment_id) DO UPDATE SET payment_status = EXCLUDED.payment_status, outcome_note = EXCLUDED.outcome_note,
      payment_group = COALESCE(EXCLUDED.payment_group, cashfree_payments.payment_group), updated_at = now();
    RETURN jsonb_build_object('outcome', 'not_paid', 'order_no', co.order_no, 'status', pay_status, 'already', false);
  END IF;

  -- The same lock as every other way a transfer is recorded (admin_confirm_manual_payment, record_bank_credit), in the
  -- same order: the transfer's keys first, then the order.
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(ref)) AS key;
  SELECT * INTO o FROM public.orders WHERE id = co.order_id FOR UPDATE;
  SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
   WHERE private.same_payment_ref(p.txn_ref, ref) AND p.status = 'Paid' ORDER BY p.created_at LIMIT 1;

  IF o.id IS NULL THEN
    outcome := 'needs_refund';
    note := 'The checkout was deleted before the payment was recorded';
  ELSIF amount <> co.amount THEN
    outcome := 'needs_review';
    note := format('Cashfree shows Rs %s, but Rs %s was asked for', to_char(amount, 'FM99999990.00'), to_char(co.amount, 'FM99999990.00'));
  ELSIF other_order IS NOT NULL THEN
    -- Recorded by hand already (an admin placed the order with this payment): nothing more to do on that order.
    outcome := CASE WHEN other_order = o.order_no THEN 'paid_order' ELSE 'needs_review' END;
    note := format('Already recorded on order %s', other_order);
    SELECT p.id INTO paid_row FROM public.payments p WHERE p.order_id = o.id AND private.same_payment_ref(p.txn_ref, ref) AND p.status = 'Paid' LIMIT 1;
  ELSIF EXISTS (SELECT 1 FROM public.payments WHERE private.same_payment_ref(txn_ref, ref) AND status = 'Refunded') THEN
    outcome := 'needs_review';
    note := 'This payment was refunded before';
  ELSIF o.order_status = 'Awaiting Payment' THEN
    due := round(o.total - COALESCE(o.paid_amount, 0), 2);
    IF amount <> due THEN
      outcome := 'needs_review';
      note := format('Cashfree took Rs %s, but the checkout needs Rs %s', to_char(amount, 'FM99999990.00'), to_char(due, 'FM99999990.00'));
    ELSE
      SELECT utr INTO earlier_utr FROM public.upi_payment_submissions WHERE order_id = o.id AND status = 'submitted';
      -- As private.confirm_held_payment (the bank alert's automatic path) does: paid in full, Payment Confirmed (the
      -- customer is told and Zoho gets the order by the usual triggers), one payment row, a lapsed UTR of this transfer
      -- closed, a bank credit kept for the checkout freed and named to the admins. Only the UTR row differs: a Cashfree
      -- reference is not a bank UTR, so a UTR the customer sent stays theirs, marked as settled by this payment.
      PERFORM set_config('app.payment_workflow', 'on', true);
      UPDATE public.orders
        SET paid_amount = total, balance_due = 0, payment_status = 'Paid', order_status = 'Payment Confirmed', payment_hold_until = NULL
        WHERE id = o.id;
      INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref)
        VALUES (o.id, o.user_id, CASE WHEN COALESCE(o.paid_amount, 0) = 0 THEN 'advance' ELSE 'balance' END, due, pay_method, 'Paid', ref)
        RETURNING id INTO paid_row;
      PERFORM private.close_lapsed_utr(ref, o.id, o.order_no);
      UPDATE public.upi_payment_submissions
        SET status = 'confirmed', reviewed_at = now(),
            note = left(format('The order was paid through Cashfree (%s). Check whether this UTR''s transfer came too: if it did, refund it.', ref), 200)
        WHERE order_id = o.id AND status = 'submitted';
      PERFORM private.settle_kept_bank_credit(o.id, ref, due, false);
      PERFORM set_config('app.payment_workflow', 'off', true);
      outcome := 'paid_order';
      note := CASE WHEN test_money THEN 'Sandbox test payment: no real money. Cancel this order after the test.' ELSE NULL END;
      IF earlier_utr IS NOT NULL AND NOT private.same_utr(earlier_utr, ref) THEN
        INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
        SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment needs you',
          left(format('%s was paid through Cashfree (%s). The customer had also sent UTR %s for it: check whether that transfer reached the bank too. If it did, refund it.',
            o.order_no, ref, earlier_utr), 500),
          'payment'
        FROM public.user_roles ur WHERE ur.role = 'admin';
      END IF;
    END IF;
  ELSE
    outcome := 'needs_refund';
    note := CASE
      WHEN o.order_status = 'Payment Expired' THEN 'The money came after the checkout ended'
      WHEN o.order_status = 'Cancelled' THEN 'The money came after the order was cancelled'
      ELSE format('The money came after the order was already paid (%s)', o.order_status) END;
  END IF;

  INSERT INTO public.cashfree_payments (cf_payment_id, cf_order_ref, order_id, order_no, environment, amount, payment_status,
    payment_group, bank_reference, payment_time, reference, outcome, outcome_note, payment_row_id, source)
  VALUES (pid, co.cf_order_ref, o.id, co.order_no, co.environment, amount, 'SUCCESS', NULLIF(grp, ''), NULLIF(rrn, ''),
    _payment_time, ref, outcome, note, paid_row, _source)
  ON CONFLICT (cf_payment_id) DO UPDATE SET payment_status = 'SUCCESS', outcome = EXCLUDED.outcome, outcome_note = EXCLUDED.outcome_note,
    payment_row_id = EXCLUDED.payment_row_id, reference = EXCLUDED.reference, amount = EXCLUDED.amount,
    payment_group = EXCLUDED.payment_group, bank_reference = EXCLUDED.bank_reference, payment_time = EXCLUDED.payment_time,
    source = EXCLUDED.source, updated_at = now();
  UPDATE public.cashfree_orders SET status = 'paid', cashfree_status = 'PAID', checked_at = now() WHERE id = co.id;

  IF outcome IN ('needs_refund', 'needs_review') THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT co.order_no, o.id, ur.user_id, 'admin', 'Payment needs you',
      left(format('Cashfree payment of Rs %s (%s) for %s: %s. Place the order with it or refund it in the Cashfree dashboard (Admin > UPI & Bank Payments > Cashfree).',
        to_char(amount, 'FM99999990.00'), ref, co.order_no, note), 500),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
    IF o.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (co.order_no, o.id, o.user_id, 'customer', 'Payment received',
        format('Your payment of Rs %s for %s reached us, but the order could not be placed with it automatically. Please do not pay again: our team will place the order with it or refund it, and tell you.',
          to_char(amount, 'FM99999990.00'), co.order_no),
        'payment');
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', outcome, 'order_no', co.order_no, 'reference', ref, 'note', note, 'already', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.cashfree_record_payment(text, text, text, numeric, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cashfree_record_payment(text, text, text, numeric, text, text, timestamptz, text) TO service_role;

-- ---------------------------------------------------------------- an admin deals with money that needs a person

/**
 * _how 'refunded': the admin refunded it in the Cashfree dashboard. _how 'placed': the order was placed with it (Place
 * again on the ended checkout, with this reference): that payment row must exist. _how 'kept': the admin keeps it as it
 * is, with a note (for example a sandbox test).
 */
CREATE OR REPLACE FUNCTION public.admin_settle_cashfree_payment(_cf_payment_id text, _how text, _note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cp public.cashfree_payments%ROWTYPE;
  paid_row uuid;
  who text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can do this'; END IF;
  IF _how NOT IN ('refunded', 'placed', 'kept') THEN RAISE EXCEPTION 'Choose refunded, placed or kept'; END IF;
  SELECT * INTO cp FROM public.cashfree_payments WHERE cf_payment_id = btrim(COALESCE(_cf_payment_id, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This Cashfree payment is not on record'; END IF;
  IF cp.payment_status <> 'SUCCESS' OR cp.outcome NOT IN ('needs_refund', 'needs_review') THEN RAISE EXCEPTION 'This payment needs nothing more'; END IF;
  IF cp.settled_at IS NOT NULL THEN RAISE EXCEPTION 'This payment was already dealt with'; END IF;
  who := COALESCE((SELECT NULLIF(btrim(full_name), '') FROM public.profiles WHERE id = auth.uid()), 'an admin');
  IF _how = 'placed' THEN
    SELECT p.id INTO paid_row FROM public.payments p
     WHERE p.order_id = cp.order_id AND p.status = 'Paid' AND private.same_payment_ref(p.txn_ref, cp.reference) LIMIT 1;
    IF paid_row IS NULL THEN RAISE EXCEPTION 'No payment with reference % is recorded on %', cp.reference, cp.order_no; END IF;
    UPDATE public.cashfree_payments SET outcome = 'paid_order', payment_row_id = paid_row, settled_at = now(), settled_by = auth.uid(),
      settled_note = left(format('Order placed with it by %s%s', who, COALESCE('. ' || NULLIF(btrim(_note), ''), '')), 300), updated_at = now()
     WHERE id = cp.id;
  ELSE
    UPDATE public.cashfree_payments SET settled_at = now(), settled_by = auth.uid(),
      settled_note = left(format('%s by %s%s', CASE WHEN _how = 'refunded' THEN 'Refunded in Cashfree' ELSE 'Kept' END, who,
        COALESCE('. ' || NULLIF(btrim(_note), ''), '')), 300), updated_at = now()
     WHERE id = cp.id;
  END IF;
  RETURN jsonb_build_object('cf_payment_id', cp.cf_payment_id, 'how', _how);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_settle_cashfree_payment(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_settle_cashfree_payment(text, text, text) TO authenticated;

-- ---------------------------------------------------------------- expire_payment_holds: wait for an open Cashfree order

-- The live definition (read 28 Nov 2026, equal to 20261106220000_bank_credit_auto_match.sql) with only the lines marked
-- "28 Nov 2026" added.
CREATE OR REPLACE FUNCTION public.expire_payment_holds()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  held record;
  n integer := 0;
  sent_utr text;
BEGIN
  FOR held IN
    SELECT o.id, o.order_no, o.total - o.paid_amount AS due, o.payment_hold_until AS until,
      left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60) AS who, COALESCE(NULLIF(o.customer_phone, ''), 'no phone') AS phone,
      o.bank_credit_id AS credit
    FROM public.orders o
    WHERE o.order_status = 'Awaiting Payment' AND o.payment_hold_until IS NOT NULL
      AND (o.payment_hold_until < now() - interval '24 hours'
        OR (o.payment_hold_until < now() AND NOT EXISTS (
          SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted')))
      -- Added 28 Nov 2026: not while the website is still asking Cashfree about this checkout (at most 30 minutes).
      AND NOT private.cashfree_payment_may_come(o.id, o.payment_hold_until)
    ORDER BY o.payment_hold_until
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Read now that the row is locked: a UTR may have come in the moment before.
    sent_utr := NULL;
    SELECT s.utr INTO sent_utr FROM public.upi_payment_submissions s WHERE s.order_id = held.id AND s.status = 'submitted';
    IF sent_utr IS NULL AND held.credit IS NOT NULL THEN
      -- The bank showed this payment and nobody confirmed it in 24 hours: the money is with us, so say so to both sides.
      PERFORM private.release_payment_hold(held.id, 'we could not confirm your payment in time', 'expired');
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT held.order_no, held.id, ur.user_id, 'admin', 'Payment not confirmed in time',
        format('Rs %s came in to the bank for %s, but nobody confirmed it within 24 hours, so its stock was released. The credit is still in Admin > UPI & Bank Payments: when the customer presses Reorder, confirm it on the new checkout, or refund it. Customer: %s, %s.',
          to_char(held.due, 'FM99999990.00'), held.order_no, held.who, held.phone),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    ELSIF sent_utr IS NULL THEN
      PERFORM private.release_payment_hold(held.id, 'the payment was not received in time', 'expired');
    ELSIF held.until >= now() - interval '24 hours' THEN
      CONTINUE;
    ELSE
      -- A UTR came and nobody checked it within 24 hours: the money may well be in the bank, so say so, to both sides.
      PERFORM private.release_payment_hold(held.id, 'we could not check your UTR in time', 'expired');
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT held.order_no, held.id, ur.user_id, 'admin', 'Payment not checked in time',
        format('UTR %s for %s (Rs %s) was not checked within 24 hours, so its stock was released. Check the bank account: if the money came, ask the customer to press Reorder and send the same UTR, or refund it. Customer: %s, %s.',
          sent_utr, held.order_no, to_char(held.due, 'FM99999990.00'), held.who, held.phone),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    END IF;
    n := n + 1;
  END LOOP;
  -- The customer says they paid, the time is over and no bank alert matched: an admin checks the bank.
  FOR held IN
    SELECT s.id, s.order_id, s.order_no, s.utr, s.amount FROM public.upi_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    WHERE s.status = 'submitted' AND s.note IS NULL AND o.order_status = 'Awaiting Payment' AND o.payment_hold_until < now()
      AND COALESCE(o.payment_method, 'UPI') NOT IN ('NEFT', 'RTGS')  -- admins were told when the UTR came
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.upi_payment_submissions SET note = 'No bank alert yet: check the bank account' WHERE id = held.id;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT held.order_no, held.order_id, ur.user_id, 'admin', 'UPI payment to check',
      format('The customer sent UTR %s for %s (Rs %s) but no bank alert matched it. Check the bank account, then confirm or reject in Admin > UPI & Bank Payments.',
        held.utr, held.order_no, to_char(held.amount, 'FM99999990.00')),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END LOOP;
  -- A NEFT or RTGS UTR still not checked 4 hours before its stock is released: remind the admins once.
  FOR held IN
    SELECT s.id, s.order_id, s.order_no, s.utr, s.amount,
      left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60) AS who, COALESCE(NULLIF(o.customer_phone, ''), 'no phone') AS phone
    FROM public.upi_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    WHERE s.status = 'submitted' AND s.note IS NULL AND o.order_status = 'Awaiting Payment'
      AND o.payment_method IN ('NEFT', 'RTGS') AND o.payment_hold_until < now() - interval '20 hours'
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.upi_payment_submissions SET note = 'Reminded: check the bank account' WHERE id = held.id;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT held.order_no, held.order_id, ur.user_id, 'admin', 'Bank transfer still to check',
      format('UTR %s for %s (Rs %s) is still not checked. Its stock is released in about 4 hours. Check the bank account, then confirm or reject in Admin > UPI & Bank Payments. Customer: %s, %s.',
        held.utr, held.order_no, to_char(held.amount, 'FM99999990.00'), held.who, held.phone),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END LOOP;
  RETURN n;
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
