-- Money records that could go wrong, found by the reviews of the delivery notes (3 Nov 2026).
--   One bank transfer could pay two orders through an admin: SBIN849320392376 and 849320392376 read as two payments.
--   An admin could confirm more than the bank alert for that UTR shows, and a short alert that came after was marked
--   matched, which nobody can settle.
--   The payment dialog's float left a fully paid order "Partially Paid".
--   The exact balance of a part-paid order was reported as a wrong amount to refund.
--   An admin could record money on a checkout that had ended, whose stock had gone back on sale.
--   A transfer recorded as refunded could pay another order.
-- Also records when a payment reached a Zoho invoice, so the sync never posts it twice (see ensureZohoBooksInvoice).
-- Built from the live text of these functions, which was the same as the migrations on 3 Nov.

-- ---------------------------------------------------------------- one transfer, one payment
-- What an admin types can have words around the UTR (UTR: 849320392376, or UPI/849320392376/NAME from a statement).
-- A 12-digit number standing alone is the transfer. Otherwise punctuation goes: 8493-2039-2376 is 849320392376.
CREATE OR REPLACE FUNCTION private.utr_form(_utr text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT translate(upper(COALESCE(
    (regexp_match(COALESCE(_utr, ''), '(?:^|[^0-9A-Za-z])([0-9]{12})(?:$|[^0-9A-Za-z])'))[1],
    regexp_replace(COALESCE(_utr, ''), '[^0-9A-Za-z]', '', 'g'))), 'OIL', '011')
$function$;
REVOKE ALL ON FUNCTION private.utr_form(text) FROM PUBLIC, anon, authenticated;

-- Every 12-digit number standing alone in what was typed: an account number can come first, or two transfers can be named.
CREATE OR REPLACE FUNCTION private.utr_numbers(_text text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $function$
  SELECT COALESCE(array_agg(m[1]), ARRAY[]::text[])
  FROM regexp_matches(COALESCE(_text, ''), '(?:^|[^0-9A-Za-z])([0-9]{12})(?=$|[^0-9A-Za-z])', 'g') AS m
$function$;
REVOKE ALL ON FUNCTION private.utr_numbers(text) FROM PUBLIC, anon, authenticated;

-- As before, plus any standing number shared, or one standing in the first that is how the second ends. Two that both
-- carry letters and differ in them, with no number standing alone, are still different transfers.
CREATE OR REPLACE FUNCTION private.same_utr(_a text, _b text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
  SELECT a <> '' AND (a = b OR (a ~ '^[0-9]{12}$' AND right(b, 12) = a) OR (b ~ '^[0-9]{12}$' AND right(a, 12) = b)
    OR numbers_a && numbers_b OR right(b, 12) = ANY (numbers_a) OR right(a, 12) = ANY (numbers_b))
  FROM (SELECT private.utr_form(_a) AS a, private.utr_form(_b) AS b, private.utr_numbers(_a) AS numbers_a, private.utr_numbers(_b) AS numbers_b) forms
$function$;
REVOKE ALL ON FUNCTION private.same_utr(text, text) FROM PUBLIC, anon, authenticated;

-- References an admin types can be anything. As long as a bank's UTR they are one payment when they are one transfer
-- (private.same_utr). Shorter ones are no UTR, so O and 0, I and 1 stay apart: RCPT1 and RCPTI are different money,
-- while rcpt 1 and RCPT1 are one reference.
CREATE OR REPLACE FUNCTION private.same_payment_ref(_a text, _b text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE WHEN length(private.utr_form(_a)) >= 12 AND length(private.utr_form(_b)) >= 12 THEN private.same_utr(_a, _b)
    ELSE upper(regexp_replace(COALESCE(_a, ''), '\s', '', 'g')) = upper(regexp_replace(COALESCE(_b, ''), '\s', '', 'g')) END
$function$;
REVOKE ALL ON FUNCTION private.same_payment_ref(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- what a bank alert can be
-- 'balance': the exact balance of an order already placed. Nothing to refund: an admin confirms it.
ALTER TABLE public.bank_credits DROP CONSTRAINT IF EXISTS bank_credits_status_check;
ALTER TABLE public.bank_credits ADD CONSTRAINT bank_credits_status_check
  CHECK (status IN ('matched', 'unmatched', 'ambiguous', 'mismatch', 'late', 'settled', 'balance'));

-- ---------------------------------------------------------------- a payment that reached a Zoho invoice
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS zoho_invoice_id text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS zoho_payment_id text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS zoho_pushed_at timestamptz;

-- ---------------------------------------------------------------- an admin records a payment
CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  credit public.bank_credits%ROWTYPE;
  applied numeric;
  reference text;
  earlier numeric;
  other_order text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
  reference := trim(COALESCE(_utr,''));
  IF length(reference) < 4 OR length(reference) > 120 THEN RAISE EXCEPTION 'Enter the verified UTR / transfer reference'; END IF;
  -- The payment dialog sends a float: 70.14999999999999 must not leave a fully paid order "Partially Paid".
  _amount := round(_amount, 2);
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  -- Once only, however the same transfer is written. The same lock as submit_upi_utr and record_bank_credit.
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || right(private.utr_form(reference), 12), 0));
  IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_payment_ref(txn_ref, reference) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded';
  END IF;
  -- Money that went back pays for nothing, and a payment row marked Refunded has no customer's UTR to catch it by.
  IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_payment_ref(txn_ref, reference) AND status = 'Refunded') THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot receive payment'; END IF;
  -- Its stock went back on sale and it can never be reopened: money recorded here would pay for nothing.
  IF target.order_status = 'Payment Expired' THEN RAISE EXCEPTION 'This checkout has ended. Place the order again, then record the payment on the new order.'; END IF;
  IF _amount > target.total - target.paid_amount THEN RAISE EXCEPTION 'Payment amount exceeds the unpaid balance'; END IF;
  -- The same checks as a customer's UTR gets in submit_upi_utr.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, reference) AND status = 'rejected' AND note = 'refunded by our team') THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  SELECT amount INTO earlier FROM public.upi_payment_submissions
    WHERE private.same_utr(utr, reference) AND status = 'rejected' AND note = 'we could not check your UTR in time' AND order_id <> target.id LIMIT 1;
  IF earlier IS NOT NULL AND earlier < _amount THEN
    RAISE EXCEPTION 'This UTR was sent for Rs % on a checkout that lapsed, so it covers no more than that.', to_char(earlier, 'FM99999990.00');
  END IF;
  SELECT order_no INTO other_order FROM public.upi_payment_submissions WHERE private.same_utr(utr, reference) AND status <> 'rejected' AND order_id <> target.id LIMIT 1;
  IF other_order IS NOT NULL THEN RAISE EXCEPTION 'This UTR was already used for order %', other_order; END IF;
  -- What the bank said about this transfer, if it said anything. Two alerts cannot be one transfer: their UTRs are unique and all digits.
  SELECT * INTO credit FROM public.bank_credits WHERE private.same_utr(utr, reference) LIMIT 1 FOR UPDATE;
  IF credit.id IS NOT NULL THEN
    IF credit.status = 'settled' THEN
      RAISE EXCEPTION 'The bank alert for UTR % was marked settled (%), so it cannot pay an order. If that was a mistake, reopen it first.', credit.utr, COALESCE(credit.note, 'no note');
    END IF;
    -- This alert's money went back, or was already recorded, whatever bank letters that reference or this one carries.
    IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, credit.utr) AND status = 'Refunded')
       OR EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, credit.utr) AND status = 'rejected' AND note = 'refunded by our team') THEN
      RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
    END IF;
    SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
      WHERE private.same_utr(p.txn_ref, credit.utr) AND p.status = 'Paid' LIMIT 1;
    IF other_order IS NOT NULL OR credit.status = 'matched' THEN
      RAISE EXCEPTION 'This UTR was already used for order %', COALESCE(other_order, credit.order_no, 'another order');
    END IF;
    -- Refused, except up to a rupee short when this clears the balance (a customer who typed Rs 677 for Rs 677.25): that is recorded and the alert stays open for a person.
    IF credit.amount < _amount AND (credit.amount + 1 < _amount OR _amount < target.total - target.paid_amount) THEN
      IF target.order_status = 'Awaiting Payment' THEN
        RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Reject this UTR, or refund it and mark the alert settled: a checkout is placed only when its full amount is paid.',
          credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00');
      END IF;
      RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Record Rs % as a part payment (Admin > Payments, % percent of the order), then ask the customer for the rest.',
        credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'), to_char(credit.amount, 'FM99999990.00'),
        to_char(round(credit.amount * 100 / NULLIF(target.total, 0), 6), 'FM990.099999');
    END IF;
  END IF;
  applied := target.paid_amount + _amount;
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
  -- Paid in full here: the customer's open UTR is settled too, so nothing stays waiting for a check.
  IF applied >= target.total THEN
    UPDATE public.upi_payment_submissions SET status = 'confirmed', note = format('Recorded by an admin with reference %s', reference),
      reviewed_at = now(), reviewed_by = auth.uid()
      WHERE order_id = target.id AND status = 'submitted';
  ELSE
    -- A part payment: that UTR is used up, so the customer can send the next one. A different UTR still waits, for what is left.
    DELETE FROM public.upi_payment_submissions WHERE order_id = target.id AND status = 'submitted' AND private.same_utr(utr, reference);
    UPDATE public.upi_payment_submissions SET amount = target.total - applied WHERE order_id = target.id AND status = 'submitted';
  END IF;
  PERFORM private.close_lapsed_utr(reference, target.id, target.order_no);
  IF earlier IS NOT NULL AND earlier > _amount THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT target.order_no, target.id, ur.user_id, 'admin', 'Payment needs you',
      format('UTR %s was sent for ₹%s on a checkout that lapsed, and ₹%s of it was recorded for %s. Refund the rest or call the customer.',
        reference, to_char(earlier, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'), target.order_no),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  -- The alert is answered, unless the amounts differ: then what is left stays open for a person.
  IF credit.id IS NOT NULL THEN
    IF credit.amount = _amount THEN
      UPDATE public.bank_credits SET status = 'matched', order_id = target.id, order_no = target.order_no, note = 'Confirmed by an admin' WHERE id = credit.id;
    ELSE
      UPDATE public.bank_credits SET status = 'mismatch', order_id = target.id, order_no = target.order_no,
        note = format('Bank amount ₹%s, recorded as ₹%s', to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'))
        WHERE id = credit.id RETURNING * INTO credit;
      IF credit.amount < _amount THEN
        PERFORM private.alert_admins_about_credit(credit, 'Payment needs you',
          format('The bank shows ₹%s for UTR %s, but ₹%s was recorded for %s. Check the bank account, collect the difference or tell the office, then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      ELSE
        PERFORM private.alert_admins_about_credit(credit, 'Payment needs you',
          format('The bank shows ₹%s for UTR %s, but only ₹%s was recorded for %s. Refund the extra or call the customer, then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      END IF;
    END IF;
  END IF;
  RETURN true;
END; $function$;

-- ---------------------------------------------------------------- an admin decides on a customer's UTR
CREATE OR REPLACE FUNCTION public.review_upi_utr(_order_no text, _decision text, _note text DEFAULT NULL::text, _expected_utr text DEFAULT NULL::text)
 RETURNS upi_payment_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  by_bank boolean;
  cfg jsonb;
  extra_minutes integer;
  sent_utr text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm UPI payments'; END IF;
  IF _decision NOT IN ('confirmed', 'rejected') THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  -- The UTR's lock before the row locks, as in record_bank_credit: the other way round the two could wait for each other.
  SELECT utr INTO sent_utr FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF sent_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || right(private.utr_form(sent_utr), 12), 0)); END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UPI payment was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  -- The decision is about the UTR the admin looked at, not whatever the row says by now.
  IF _expected_utr IS NOT NULL AND upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the bank again.', s.utr;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
  by_bank := COALESCE(o.payment_method, '') IN ('NEFT', 'RTGS');
  IF _decision = 'confirmed' THEN
    IF o.order_status = 'Awaiting Payment' AND s.amount <> o.total - o.paid_amount THEN
      RAISE EXCEPTION 'An unpaid order is placed only when its full amount is paid';
    END IF;
    -- Compares the UTR with its bank alert and answers the alert.
    PERFORM public.admin_confirm_manual_payment(s.order_no, s.amount, s.utr);
    UPDATE public.orders SET payment_hold_until = NULL WHERE id = s.order_id AND payment_hold_until IS NOT NULL;
  END IF;
  UPDATE public.upi_payment_submissions SET status = _decision, note = NULLIF(trim(COALESCE(_note, '')), ''),
    reviewed_at = now(), reviewed_by = auth.uid(), rejections = rejections + CASE WHEN _decision = 'rejected' THEN 1 ELSE 0 END
  WHERE id = s.id RETURNING * INTO result;
  IF _decision = 'rejected' AND o.order_status = 'Awaiting Payment' THEN
    -- A third wrong UTR ends the checkout: fake UTRs must not keep stock reserved for ever.
    IF result.rejections >= 3 THEN
      PERFORM private.release_payment_hold(o.id, 'the UTR you sent could not be matched', 'expired');
      RETURN result;
    END IF;
    -- Otherwise time to send the right one, however long the check took: 1 hour for a bank transfer, the Admin setting for UPI.
    IF by_bank THEN
      extra_minutes := 60;
    ELSE
      SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
      extra_minutes := LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)));
    END IF;
    UPDATE public.orders SET payment_hold_until = GREATEST(payment_hold_until, now() + make_interval(mins => extra_minutes)) WHERE id = o.id;
  END IF;
  IF s.user_id IS NOT NULL AND _decision = 'rejected' THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer', CASE WHEN by_bank THEN 'Please check your bank transfer' ELSE 'Please check your UPI payment' END,
      format('UTR %s for order %s could not be matched%s. Open the order and send the correct UTR.', s.utr, s.order_no,
        COALESCE(': ' || NULLIF(trim(COALESCE(_note, '')), ''), '')),
      'payment');
  END IF;
  RETURN result;
END;
$function$;

-- ---------------------------------------------------------------- a bank alert comes in
CREATE OR REPLACE FUNCTION private.match_bank_credit(_credit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.bank_credits%ROWTYPE;
  o public.orders%ROWTYPE;
  candidates uuid[];
  amount_text text;
  bank_named boolean;
  paid_order uuid;
  recorded numeric;
  orders_paid integer;
  sent integer;
BEGIN
  SELECT * INTO c FROM public.bank_credits WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('unmatched', 'ambiguous') THEN
    RETURN jsonb_build_object('status', COALESCE(c.status, 'missing'), 'order_no', c.order_no);
  END IF;
  amount_text := to_char(c.amount, 'FM99999990.00');

  -- A transfer recorded as refunded pays for nothing, not even by its amount or a UTR sent again: a person looks.
  SELECT p.order_id INTO paid_order FROM public.payments p
    WHERE private.same_utr(p.txn_ref, c.utr) AND p.status = 'Refunded' ORDER BY p.created_at LIMIT 1;
  IF paid_order IS NULL THEN
    SELECT s.order_id INTO paid_order FROM public.upi_payment_submissions s
      WHERE private.same_utr(s.utr, c.utr) AND s.status = 'rejected' AND s.note = 'refunded by our team' LIMIT 1;
  END IF;
  IF paid_order IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = paid_order;
    UPDATE public.bank_credits SET status = 'mismatch', order_id = o.id, order_no = o.order_no,
      note = format('This transfer was recorded as refunded on %s', o.order_no)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in, but this transfer was recorded as refunded on %s. Check the bank account, then mark it settled.', amount_text, c.utr, o.order_no));
    RETURN jsonb_build_object('status', 'mismatch', 'order_no', o.order_no);
  END IF;

  -- This UTR already paid an order (an admin confirmed it before the SMS came): that money is accounted for, if the bank agrees.
  -- The same transfer can sit on more than one row, written with different bank letters: all of it counts against this alert.
  SELECT (array_agg(p.order_id ORDER BY p.created_at))[1], sum(p.amount), count(DISTINCT p.order_id) INTO paid_order, recorded, orders_paid FROM public.payments p
    WHERE private.same_utr(p.txn_ref, c.utr) AND p.status = 'Paid';
  IF paid_order IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = paid_order;
    IF c.amount = recorded AND orders_paid = 1 THEN
      UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = 'Already confirmed by an admin' WHERE id = c.id;
      RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
    END IF;
    UPDATE public.bank_credits SET status = 'mismatch', order_id = o.id, order_no = o.order_no,
      note = format('Bank amount ₹%s, recorded as ₹%s', amount_text, to_char(recorded, 'FM99999990.00'))
      WHERE id = c.id RETURNING * INTO c;
    IF orders_paid > 1 THEN
      PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
        format('The bank shows ₹%s for UTR %s, and that one transfer is recorded on more than one order, first %s. Check the bank account and correct it, then mark it settled.',
          amount_text, c.utr, o.order_no));
    ELSIF c.amount < recorded THEN
      PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
        format('The bank shows ₹%s for UTR %s, but ₹%s was recorded for %s. Check the bank account, collect the difference or tell the office, then mark it settled.',
          amount_text, c.utr, to_char(recorded, 'FM99999990.00'), o.order_no));
    ELSE
      PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
        format('The bank shows ₹%s for UTR %s, but only ₹%s was recorded for %s. Refund the extra or call the customer, then mark it settled.',
          amount_text, c.utr, to_char(recorded, 'FM99999990.00'), o.order_no));
    END IF;
    RETURN jsonb_build_object('status', 'mismatch', 'order_no', o.order_no);
  END IF;

  -- The customer's UTR was closed when an admin recorded that order's payment under another reference. This may be
  -- that same money or a second payment: only a person can tell.
  SELECT s.order_id INTO paid_order FROM public.upi_payment_submissions s
    WHERE private.same_utr(s.utr, c.utr) AND s.status = 'confirmed' ORDER BY s.reviewed_at DESC LIMIT 1;
  IF paid_order IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = paid_order;
    UPDATE public.bank_credits SET status = 'mismatch', order_id = o.id, order_no = o.order_no,
      note = format('The customer sent this UTR for %s, and its payment was recorded under another reference', o.order_no)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in. The customer sent this UTR for %s, and its payment was recorded under another reference. If this is a second payment, refund it. Then mark it settled.', amount_text, c.utr, o.order_no));
    RETURN jsonb_build_object('status', 'mismatch', 'order_no', o.order_no);
  END IF;

  -- Two orders sent this transfer, with different bank letters: its amount can't choose between them.
  SELECT count(*) INTO sent FROM public.upi_payment_submissions s WHERE private.same_utr(s.utr, c.utr) AND s.status = 'submitted';
  IF sent > 1 THEN
    UPDATE public.bank_credits SET status = 'ambiguous', note = format('%s orders sent this UTR with different bank letters', sent) WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in and more than one order sent this UTR with different bank letters. Check which it is, confirm that order and reject the other.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- 1. The customer already told us this UTR, however they wrote it.
  SELECT o2.* INTO o FROM public.upi_payment_submissions s JOIN public.orders o2 ON o2.id = s.order_id
    WHERE private.same_utr(s.utr, c.utr) AND s.status = 'submitted' ORDER BY s.submitted_at DESC LIMIT 1;
  IF FOUND THEN
    PERFORM 1 FROM public.orders WHERE id = o.id FOR UPDATE;
    SELECT * INTO o FROM public.orders WHERE id = o.id;
    IF o.order_status = 'Awaiting Payment' AND c.amount = o.total - o.paid_amount THEN
      PERFORM private.confirm_held_payment(o.id, c.utr, 'Confirmed automatically from the bank alert');
      UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = NULL WHERE id = c.id;
      RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
    END IF;
    -- The exact balance of an order already placed: nothing to refund. An admin confirms it, as with any such UTR.
    IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired', 'Cancelled') AND o.total - o.paid_amount > 0 AND c.amount = o.total - o.paid_amount THEN
      UPDATE public.bank_credits SET order_id = o.id, order_no = o.order_no, status = 'balance', note = format('The balance of %s', o.order_no)
        WHERE id = c.id RETURNING * INTO c;
      PERFORM private.alert_admins_about_credit(c, 'Balance to confirm',
        format('₹%s (UTR %s) is the exact balance of %s. Check the bank account, then confirm it in Admin > UPI & Bank Payments.', amount_text, c.utr, o.order_no));
      RETURN jsonb_build_object('status', 'balance', 'order_no', o.order_no);
    END IF;
    UPDATE public.bank_credits SET order_id = o.id, order_no = o.order_no,
      status = CASE WHEN o.order_status = 'Payment Expired' THEN 'late' ELSE 'mismatch' END,
      note = CASE WHEN o.order_status = 'Payment Expired' THEN 'Paid after the payment time ran out'
                  WHEN o.order_status = 'Cancelled' OR (o.order_status <> 'Awaiting Payment' AND o.total - o.paid_amount <= 0) THEN format('Order is already %s', o.order_status)
                  ELSE format('Bank amount ₹%s, order needs ₹%s', amount_text, to_char(o.total - o.paid_amount, 'FM99999990.00')) END
      WHERE id = c.id RETURNING * INTO c;
    -- Part of the balance of an order that can be part paid: that much can be recorded.
    IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired', 'Cancelled') AND c.amount < o.total - o.paid_amount THEN
      PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
        format('₹%s (UTR %s) for %s: %s. Record what came as a part payment, or refund it or call the customer.', amount_text, c.utr, o.order_no, c.note));
    ELSE
      PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
        format('₹%s (UTR %s) for %s: %s. Refund it or call the customer.', amount_text, c.utr, o.order_no, c.note));
    END IF;
    RETURN jsonb_build_object('status', c.status, 'order_no', o.order_no);
  END IF;

  -- A waiting NEFT or RTGS order of this amount could be the real payer: its UTR decides, not the amount.
  IF EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Awaiting Payment' AND o2.payment_method IN ('NEFT', 'RTGS')
      AND o2.total - o2.paid_amount = c.amount AND o2.created_at <= c.received_at + interval '2 minutes') THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('A NEFT or RTGS order waits for ₹%s; the customer''s UTR decides', amount_text)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in and a NEFT or RTGS order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- Money named as a bank transfer never pays someone's UPI request by its amount: if one waits, a person decides.
  bank_named := COALESCE(c.raw, '') ~* '(^|[^a-z])(neft|rtgs|imps)([^a-z]|$)';
  IF bank_named AND EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Awaiting Payment'
      AND o2.total - o2.paid_amount = c.amount AND o2.created_at <= c.received_at + interval '2 minutes') THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('A bank transfer of ₹%s came in and an unpaid order waits for that amount; the customer''s UTR decides', amount_text)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in by bank transfer and an unpaid order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- 2. The one request waiting for exactly this amount at the time the money arrived. A request
  --    whose customer gave a different UTR is not theirs to claim, and a same-amount request that
  --    expired in the last 2 hours could be the real payer: then a person decides. Only UPI requests:
  --    a NEFT or RTGS order is confirmed by its UTR, never by a look-alike amount.
  SELECT array_agg(o2.id ORDER BY o2.created_at) INTO candidates FROM public.orders o2
    WHERE NOT bank_named AND o2.order_status = 'Awaiting Payment'
      AND COALESCE(o2.payment_method, 'UPI') = 'UPI'
      AND o2.total - o2.paid_amount = c.amount
      AND o2.created_at <= c.received_at + interval '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o2.id AND s.status = 'submitted');
  IF COALESCE(array_length(candidates, 1), 0) = 1 AND EXISTS (
    SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Payment Expired' AND o2.payment_hold_outcome = 'expired' AND o2.total = c.amount
      AND o2.updated_at >= c.received_at - interval '2 hours'
      -- The customer's own expired checkout is no rival: reordering gives the same amount, and the money is theirs.
      AND o2.user_id IS DISTINCT FROM (SELECT o3.user_id FROM public.orders o3 WHERE o3.id = candidates[1])
      AND NOT EXISTS (SELECT 1 FROM public.bank_credits b WHERE b.order_id = o2.id)) THEN
    candidates := candidates || NULL::uuid;  -- treat as more than one
  END IF;
  IF COALESCE(array_length(candidates, 1), 0) = 1 THEN
    SELECT * INTO o FROM public.orders WHERE id = candidates[1] FOR UPDATE;
    PERFORM private.confirm_held_payment(o.id, c.utr, 'Confirmed automatically from the bank alert (matched by amount)');
    UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = NULL WHERE id = c.id;
    RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
  END IF;
  IF COALESCE(array_length(candidates, 1), 0) > 1 THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('%s unpaid orders wait for ₹%s; the customer''s UTR decides', array_length(candidates, 1), amount_text)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in and more than one unpaid order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- 3. Paid for a request that already expired (same amount, last 2 days).
  SELECT o2.* INTO o FROM public.orders o2
    WHERE o2.order_status = 'Payment Expired' AND o2.payment_hold_outcome = 'expired' AND o2.total = c.amount
      AND o2.created_at >= c.received_at - interval '2 days' AND o2.created_at <= c.received_at + interval '2 minutes'
    ORDER BY o2.created_at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE public.bank_credits SET status = 'late', order_id = o.id, order_no = o.order_no,
      note = 'Paid after the payment time ran out' WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) arrived after %s expired. Refund it or place the order for the customer.', amount_text, c.utr, o.order_no));
    RETURN jsonb_build_object('status', 'late', 'order_no', o.order_no);
  END IF;
  RETURN jsonb_build_object('status', 'unmatched');
END;
$function$;

-- ---------------------------------------------------------------- an admin says what was done about an alert
CREATE OR REPLACE FUNCTION public.settle_bank_credit(_credit_id uuid, _note text)
 RETURNS bank_credits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE result public.bank_credits%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can settle a bank credit'; END IF;
  IF NULLIF(trim(COALESCE(_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Say what was done (for example: refunded on 27 Oct)'; END IF;
  UPDATE public.bank_credits SET status = 'settled', note = trim(_note)
    WHERE id = _credit_id AND status IN ('unmatched', 'ambiguous', 'mismatch', 'late', 'balance')
    RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'This credit is already matched or settled'; END IF;
  RETURN result;
END;
$function$;

-- A settled alert pays for nothing, so one settled by mistake needs a way back. Every admin is told. It reopens to a
-- status a customer's UTR can't confirm by itself: a person records it.
CREATE OR REPLACE FUNCTION public.reopen_bank_credit(_credit_id uuid)
RETURNS public.bank_credits LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  result public.bank_credits%ROWTYPE;
  was text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can reopen a bank credit'; END IF;
  SELECT note INTO was FROM public.bank_credits WHERE id = _credit_id AND status = 'settled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a settled credit can be reopened'; END IF;
  UPDATE public.bank_credits SET status = 'mismatch',
    note = format('Reopened. It was settled: %s', COALESCE(was, 'no note'))
    WHERE id = _credit_id RETURNING * INTO result;
  PERFORM private.alert_admins_about_credit(result, 'Payment needs you',
    format('The bank alert for ₹%s (UTR %s) was settled and has been reopened. It was settled: %s', to_char(result.amount, 'FM99999990.00'), result.utr, COALESCE(was, 'no note')));
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.reopen_bank_credit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_bank_credit(uuid) TO authenticated;

-- Payments the sync has already posted, as far as the website can tell: oldest first, as many as the money on the
-- invoice covers. Wrongly noted, one goes to review at the next sync, which is the safe way to be wrong.
WITH running AS (
  SELECT p.id, i.zoho_invoice_id, i.updated_at, i.total - i.balance AS on_invoice,
    sum(p.amount) OVER (PARTITION BY p.order_id ORDER BY p.created_at, p.id) AS so_far
  FROM public.payments p JOIN public.zoho_order_invoices i ON i.order_id = p.order_id
  WHERE p.status = 'Paid' AND p.zoho_pushed_at IS NULL AND i.zoho_invoice_id IS NOT NULL
)
UPDATE public.payments p SET zoho_invoice_id = r.zoho_invoice_id, zoho_pushed_at = r.updated_at
  FROM running r WHERE r.id = p.id AND r.so_far <= r.on_invoice + 1;

-- A short alert marked matched before this fix could never be settled: it goes back to a person.
WITH recorded AS (
  SELECT c.id, sum(p.amount) AS amount, (array_agg(p.order_id ORDER BY p.created_at))[1] AS order_id
  FROM public.bank_credits c JOIN public.payments p ON p.status = 'Paid' AND private.same_utr(p.txn_ref, c.utr)
  WHERE c.status = 'matched' GROUP BY c.id
)
UPDATE public.bank_credits c
  SET status = 'mismatch', order_id = r.order_id, order_no = o.order_no,
    note = format('Bank amount ₹%s, recorded as ₹%s', to_char(c.amount, 'FM99999990.00'), to_char(r.amount, 'FM99999990.00'))
  FROM recorded r JOIN public.orders o ON o.id = r.order_id
  WHERE c.id = r.id AND r.amount <> c.amount;

NOTIFY pgrst, 'reload schema';
