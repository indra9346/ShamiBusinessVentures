-- Bank SMS without a UTR, matched to the customer's checkout automatically; an admin confirms (owner, 6 Nov 2026).
--
-- IDFC FIRST Bank's credit SMS says only the account, the amount and the minute ("Your A/C XXXXX000900 is credited with
-- INR 1.00 on 06/11/26 17:51 ..."). Until now such a credit only waited in a list: a customer who paid by the QR and did
-- not type the UTR saw their checkout end after the 10 minutes, with their money in the bank.
--
-- Now, when the credit comes in (record_bank_credit_without_reference):
--   * exactly one UPI checkout waits for exactly that amount, was made before the money came, was still open when it
--     came, has no UTR and no other credit: the credit is kept for it. The checkout stays open (stock held) for up to
--     24 hours more, the customer's screen and a notification say the money has reached us, and the admins are told
--     "Payment received: confirm it" with the order and the customer. Nothing is paid until an admin confirms.
--   * two or more such checkouts: nothing is kept; the admins are told how many, to pick by the payer in the bank app.
--   * none, but a checkout for the same amount ended within half an hour: the admins are told, to call the customer.
-- confirm_order_with_bank_credit now also pays a checkout that has no UTR (the credit is the payment's reference, and
-- the order then goes to Zoho as a paid order: sales order and invoice, as for every confirmed payment).
-- A kept checkout cannot be cancelled by the customer, and its credit cannot be dismissed or used for another order
-- while it waits. A kept checkout nobody confirmed in 24 hours ends with words that say the money came, and the credit
-- is free again for the order the customer places instead.
--
-- Built from the live definitions of 6 Nov 2026, changed only where these comments say.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS bank_credit_id uuid REFERENCES public.bank_credits_without_reference(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bank_credit_seen_at timestamptz;
COMMENT ON COLUMN public.orders.bank_credit_id IS 'A bank credit without a UTR kept for this checkout (it waits for an admin), or the one that paid it.';
COMMENT ON COLUMN public.orders.bank_credit_seen_at IS 'When that money reached the bank (from its SMS). The customer''s screen shows it.';
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_order_per_bank_credit ON public.orders (bank_credit_id) WHERE bank_credit_id IS NOT NULL;

ALTER TABLE public.bank_credits_without_reference ADD COLUMN IF NOT EXISTS suggested_order_no text;
COMMENT ON COLUMN public.bank_credits_without_reference.suggested_order_no IS 'The only checkout waiting for this amount when the credit came, kept for it until an admin decides.';

CREATE OR REPLACE FUNCTION public.record_bank_credit_without_reference(_account_ending text, _amount numeric, _credited_at timestamp with time zone, _balance numeric, _raw text, _sender text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  account text;
  ending text := regexp_replace(COALESCE(_account_ending, ''), '\D', '', 'g');
  sms text := regexp_replace(btrim(COALESCE(_raw, '')), '\s+', ' ', 'g');
  credit_amount numeric(14,2) := round(_amount, 2);
  around timestamptz := COALESCE(_credited_at, now());
  new_id uuid;
  waiting integer;
  candidates uuid[];
  o public.orders%ROWTYPE;
  linked text;
  ended text;
  credit_time text := COALESCE(' at ' || to_char(_credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), '');
BEGIN
  IF _amount IS NULL OR _amount <= 0 OR sms = '' OR ending !~ '^[0-9]{3,6}$' THEN
    RETURN jsonb_build_object('status', 'unreadable');
  END IF;
  SELECT regexp_replace(COALESCE(value->>'accountNumber', ''), '\D', '', 'g') INTO account
  FROM public.settings WHERE key = 'bank_transfer';
  IF COALESCE(length(account), 0) < length(ending) OR right(account, length(ending)) <> ending THEN
    RETURN jsonb_build_object('status', 'other_account');
  END IF;
  INSERT INTO public.bank_credits_without_reference (credited_at, sender, raw, fingerprint, account_ending, amount, balance)
  VALUES (_credited_at, left(NULLIF(btrim(COALESCE(_sender, '')), ''), 40), left(sms, 1000), md5(lower(sms)), ending, credit_amount, _balance)
  ON CONFLICT (fingerprint) DO NOTHING
  RETURNING id INTO new_id;
  IF new_id IS NULL THEN RETURN jsonb_build_object('status', 'duplicate'); END IF;
  -- Same rule as the admin page: a UTR waiting for a check, for exactly this amount, sent within a day of the credit.
  SELECT count(*) INTO waiting FROM public.upi_payment_submissions s
  WHERE s.status = 'submitted' AND s.amount = credit_amount
    AND s.submitted_at BETWEEN around - interval '24 hours' AND around + interval '24 hours';
  IF waiting > 0 THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NULL, NULL, ur.user_id, 'admin', 'Bank credit to match',
      format('Rs %s was credited to A/C ...%s%s. The bank''s SMS has no UTR. Orders waiting for this amount: %s. Check and confirm in Admin > UPI & Bank Payments.',
        to_char(credit_amount, 'FM99999990.00'), ending,
        COALESCE(' at ' || to_char(_credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), ''), waiting),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  -- No UTR waits for this amount. Exactly one UPI checkout waiting for exactly this amount, made before the money came
  -- and still open when it came, with no other credit on it: the money is very likely its payment. Keep it (stock held
  -- up to 24 hours more) and say so to the admins and the customer. An admin still confirms it; nothing is paid here.
  -- Two or more such checkouts link nothing: the admins pick the right one from the payer in their bank app.
  IF waiting = 0 THEN
    SELECT array_agg(c.id ORDER BY c.created_at) INTO candidates FROM public.orders c
    WHERE c.order_status = 'Awaiting Payment' AND COALESCE(c.payment_method, 'UPI') NOT IN ('NEFT', 'RTGS')
      AND c.total - c.paid_amount = credit_amount AND c.bank_credit_id IS NULL
      AND date_trunc('minute', c.created_at) <= around AND c.payment_hold_until >= around - interval '1 minute'
      AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = c.id AND s.status = 'submitted');
    IF cardinality(candidates) = 1 THEN
      SELECT * INTO o FROM public.orders WHERE id = candidates[1] FOR UPDATE;
      -- Checked again under the lock: the checkout may have ended, or got a UTR or another credit, a moment before.
      IF o.order_status = 'Awaiting Payment' AND o.bank_credit_id IS NULL AND o.total - o.paid_amount = credit_amount
         AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
        PERFORM set_config('app.payment_workflow', 'on', true);
        UPDATE public.orders
           SET bank_credit_id = new_id, bank_credit_seen_at = around,
               payment_hold_until = GREATEST(payment_hold_until, now() + interval '24 hours')
         WHERE id = o.id;
        PERFORM set_config('app.payment_workflow', 'off', true);
        UPDATE public.bank_credits_without_reference SET suggested_order_no = o.order_no WHERE id = new_id;
        linked := o.order_no;
        INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
        SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment received: confirm it',
          format('Rs %s came in to A/C ...%s%s. It matches %s (%s, %s), the only checkout waiting for this amount. The bank''s SMS has no UTR, so check the payer in your bank app, then confirm it in Admin > UPI & Bank Payments. Its stock is kept for 24 hours.',
            to_char(credit_amount, 'FM99999990.00'), ending, credit_time, o.order_no,
            left(COALESCE(NULLIF(o.customer_name, ''), 'name not given'), 60), COALESCE(NULLIF(o.customer_phone, ''), 'no phone')),
          'payment'
        FROM public.user_roles ur WHERE ur.role = 'admin';
        IF o.user_id IS NOT NULL THEN
          INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
          VALUES (o.order_no, o.id, o.user_id, 'customer', 'Payment received: confirming',
            format('We received Rs %s for %s. Our team is confirming it; your order is placed as soon as they do. Please do not pay again.',
              to_char(credit_amount, 'FM99999990.00'), o.order_no),
            'payment');
        END IF;
      END IF;
    ELSIF cardinality(candidates) > 1 THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT NULL, NULL, ur.user_id, 'admin', 'Bank credit to match',
        format('Rs %s came in to A/C ...%s%s. %s checkouts wait for this amount, so none was picked. Check the payer in your bank app and confirm the right one in Admin > UPI & Bank Payments.',
          to_char(credit_amount, 'FM99999990.00'), ending, credit_time, cardinality(candidates)),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    ELSE
      -- Nothing open for this amount, but a UPI checkout for it ended within half an hour of the money: the SMS came
      -- late or the customer paid at the last moment. Its stock is back on sale, so an admin has to sort it out.
      SELECT c.order_no INTO ended FROM public.orders c
      WHERE c.order_status = 'Payment Expired' AND COALESCE(c.payment_method, 'UPI') NOT IN ('NEFT', 'RTGS')
        AND c.total = credit_amount AND c.paid_amount = 0 AND c.updated_at BETWEEN around - interval '30 minutes' AND around + interval '30 minutes'
        AND date_trunc('minute', c.created_at) <= around
      ORDER BY abs(extract(epoch FROM c.updated_at - around)) LIMIT 1;
      IF ended IS NOT NULL THEN
        INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
        SELECT ended, NULL, ur.user_id, 'admin', 'Payment for a checkout that ended',
          format('Rs %s came in to A/C ...%s%s, around when checkout %s for the same amount ended unpaid. Its stock went back on sale. Call the customer: ask them to press Reorder, then confirm this credit on the new checkout; or refund it.',
            to_char(credit_amount, 'FM99999990.00'), ending, credit_time, ended),
          'payment'
        FROM public.user_roles ur WHERE ur.role = 'admin';
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('status', 'recorded', 'id', new_id, 'waiting_orders', waiting, 'linked_order', linked);
END;
$function$
;

CREATE OR REPLACE FUNCTION private.release_payment_hold(_order_id uuid, _reason text, _outcome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id;
  IF NOT FOUND OR target.order_status <> 'Awaiting Payment' THEN RETURN; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);
  PERFORM set_config('app.payment_workflow', 'on', true);

  FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)), true
      ), updated_at = now()
      WHERE id = line.product_id;
  END LOOP;

  FOR allocation_row IN
    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
    FROM public.order_item_batch_allocations a
    JOIN public.order_items oi ON oi.id = a.order_item_id
    WHERE oi.order_id = target.id AND a.released_quantity < a.reserved_quantity
    ORDER BY a.created_at, a.id
    FOR UPDATE OF a
  LOOP
    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;
    UPDATE public.batches
      SET remaining_quantity = remaining_quantity + restore_qty,
          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END
      WHERE id = allocation_row.batch_id;
    UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity WHERE id = allocation_row.id;
  END LOOP;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;

  UPDATE public.orders
    SET order_status = 'Payment Expired', advance_due = 0, balance_due = 0, payment_hold_until = NULL, payment_hold_outcome = _outcome,
        bank_credit_id = NULL
    WHERE id = target.id;
  -- A bank credit kept for this checkout is free again, for the order the customer places instead (or a refund).
  IF target.bank_credit_id IS NOT NULL THEN
    UPDATE public.bank_credits_without_reference SET suggested_order_no = NULL
     WHERE id = target.bank_credit_id AND status = 'new' AND suggested_order_no = target.order_no;
  END IF;
  UPDATE public.upi_payment_submissions SET status = 'rejected', note = _reason, reviewed_at = now()
    WHERE order_id = target.id AND status = 'submitted';
  IF target.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (target.order_no, target.id, target.user_id, 'customer', 'Order not placed',
      format(CASE WHEN _reason = 'we could not confirm your payment in time'
        THEN '%s was not placed: %s. Your money reached us, so do not pay again. Press Reorder and call us: we will place the order with it or refund it.'
        WHEN _reason = 'we could not check your UTR in time'
        THEN '%s was not placed: %s. Do not pay again. Press Reorder and send the same UTR, or call us and we will refund it.'
        ELSE '%s was not placed: %s. Nothing was charged by us; if money left your account, contact us with the UTR.' END, target.order_no, _reason),
      'payment');
  END IF;
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_payment_hold(_order_no text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE target public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel this order'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.user_id IS DISTINCT FROM auth.uid() AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'This is not your order';
  END IF;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Only an unpaid order can be dropped here'; END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE order_id = target.id AND status = 'submitted') THEN
    RAISE EXCEPTION 'You already sent a UTR for this order; we are checking it';
  END IF;
  IF target.bank_credit_id IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Your payment has reached our bank and we are confirming it. Please call us if you want to cancel';
  END IF;
  PERFORM private.release_payment_hold(target.id, 'you cancelled it before paying', 'dropped');
  RETURN true;
END;
$function$
;

-- An admin confirms a bank credit without a UTR as an order's payment: through the customer's UTR when one waits,
-- else as the payment itself.
CREATE OR REPLACE FUNCTION public.confirm_order_with_bank_credit(_credit_id uuid, _order_no text, _expected_utr text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.bank_credits_without_reference%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  kept_for text;
  reference text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  -- One credit pays one order: the second admin to click waits here, then is told it was used.
  SELECT * INTO c FROM public.bank_credits_without_reference WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This bank credit is not on record'; END IF;
  IF c.status = 'used' THEN RAISE EXCEPTION 'This bank credit already paid for %', COALESCE(c.order_no, 'an order'); END IF;
  IF c.status <> 'new' THEN RAISE EXCEPTION 'This bank credit was dismissed. Reopen it first.'; END IF;
  -- Kept for another customer's checkout, which still waits: that customer was told their money arrived.
  SELECT order_no INTO kept_for FROM public.orders
   WHERE bank_credit_id = c.id AND order_no <> _order_no AND order_status = 'Awaiting Payment' LIMIT 1;
  IF kept_for IS NOT NULL THEN
    RAISE EXCEPTION 'This bank credit is kept for checkout %, whose customer was told the money arrived. If it is really for %, end checkout % first.', kept_for, _order_no, kept_for;
  END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF FOUND AND s.status = 'submitted' THEN
    IF s.amount <> c.amount THEN
      RAISE EXCEPTION 'The bank credit is Rs % but this order''s payment is Rs %', to_char(c.amount, 'FM99999990.00'), to_char(s.amount, 'FM99999990.00');
    END IF;
    -- The usual check and payment: one transfer pays one order, the order is placed or marked paid, the customer is told.
    PERFORM public.review_upi_utr(_order_no, 'confirmed',
      format('Matched by an admin to Rs %s credited to A/C ...%s%s (the bank''s SMS has no UTR)', to_char(c.amount, 'FM99999990.00'), c.account_ending,
        COALESCE(' at ' || to_char(c.credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), '')),
      _expected_utr);
  ELSE
    -- No UTR from the customer: this credit is the payment.
    SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
    IF o.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Order % is not waiting for a payment', _order_no; END IF;
    IF o.total - o.paid_amount <> c.amount THEN
      RAISE EXCEPTION 'The bank credit is Rs % but this order needs Rs %', to_char(c.amount, 'FM99999990.00'), to_char(o.total - o.paid_amount, 'FM99999990.00');
    END IF;
    IF o.bank_credit_id IS NOT NULL AND o.bank_credit_id <> c.id THEN RAISE EXCEPTION 'Another bank credit is kept for this order'; END IF;
    -- The admin may give it to a checkout made after the money came: the customer paid for one that ended, then pressed
    -- Reorder. Only the automatic match requires the checkout to come first.
    -- Unique per credit (its SMS fingerprint), so the same SMS can never pay twice under any spelling.
    reference := format('BANK SMS %s A/C %s #%s',
      to_char(COALESCE(c.credited_at, c.received_at) AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'), c.account_ending, upper(left(c.fingerprint, 10)));
    PERFORM public.admin_confirm_manual_payment(_order_no, c.amount, reference);
    UPDATE public.orders
       SET payment_hold_until = NULL, bank_credit_id = c.id, bank_credit_seen_at = COALESCE(bank_credit_seen_at, c.credited_at, c.received_at)
     WHERE id = o.id;
  END IF;
  UPDATE public.bank_credits_without_reference
  SET status = 'used', order_no = _order_no, decided_by = auth.uid(), decided_at = now()
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'confirmed', 'order_no', _order_no);
END;
$function$;

-- A credit kept for a waiting checkout cannot be put aside: its customer was told the money arrived.
CREATE OR REPLACE FUNCTION public.dismiss_bank_credit_without_reference(_credit_id uuid, _note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.bank_credits_without_reference%ROWTYPE;
  kept_for text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can do this'; END IF;
  IF btrim(COALESCE(_note, '')) = '' THEN RAISE EXCEPTION 'Say what this money was for'; END IF;
  SELECT * INTO c FROM public.bank_credits_without_reference WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This bank credit is not on record'; END IF;
  IF c.status <> 'new' THEN RAISE EXCEPTION 'Only a credit not yet used can be dismissed'; END IF;
  SELECT order_no INTO kept_for FROM public.orders WHERE bank_credit_id = c.id AND order_status = 'Awaiting Payment' LIMIT 1;
  IF kept_for IS NOT NULL THEN
    RAISE EXCEPTION 'This credit is kept for checkout %, whose customer was told the money arrived. Confirm it there, or end that checkout first.', kept_for;
  END IF;
  UPDATE public.bank_credits_without_reference
  SET status = 'dismissed', note = left(btrim(_note), 300), decided_by = auth.uid(), decided_at = now()
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'dismissed');
END;
$function$;

COMMIT;
