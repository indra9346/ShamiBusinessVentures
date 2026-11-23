-- 16 Nov 2026 (owner): "Give option to approve payments of customers in their login for channel partners respective to
-- their Godown orders only".
--
-- Until now a channel partner could only send a customer's UTR (submit_utr_for_order); our office confirmed it. Now the
-- active channel partner of the order's own godown can approve it too, in the partner's Customer payments list:
--   * partner_approve_payment(order, UTR they looked at, where they saw the money): for a checkout still waiting for
--     payment it runs review_upi_utr(confirmed); for a checkout that ended without payment in the last 15 days, with a
--     UTR sent for it, admin_place_ended_checkout. Every check those make for an admin applies unchanged (the full amount,
--     the same UTR never paying twice, refunded money, the bank alert's amount, stock still there for an ended checkout).
--   * Only to approve, never to reject: rejecting a UTR stays with our office.
--   * Only the UTR already sent on the order by the customer (or our office), never one typed at approval or sent by the
--     partner, and never the partner's own order: a second person always checks what a partner entered. Only orders of
--     the partner's own godown, and an ended checkout only within the 15 days the partner's list shows it.
--   * Our office can switch it off (Admin > UPI & Bank Payments): settings.partner_payment_approval, on from today.
--   * Every approval is on record: the UTR row says "Approved by channel partner <name> (<godown>) after checking
--     <where>", Approved by shows the partner, the order history has a row with the partner, and every admin gets a
--     "Payment approved by channel partner" notice to check it in the bank account.
--
-- How: review_upi_utr, admin_confirm_manual_payment and admin_place_ended_checkout are the live definitions (read 16 Nov
-- 2026, equal to the repo) with only the lines marked "16 Nov 2026" added. They accept a partner only when
-- partner_approve_payment has set app.partner_payment to that partner's id for this transaction and
-- private.payment_partner_acting finds that id to be the caller's own active partner record (with approval switched on):
-- a partner calling them directly is refused as before. A partner's session is not an admin's, so around their order
-- updates they set app.payment_workflow, as the bank alert's automatic confirmation does; the order guard's own checks
-- still run first.
-- partner_confirm_order: the live definition with only its two refusals about payments reworded (a partner may now
-- approve a checkout's UTR).
-- partner_payment_checkouts gains the UTR's amount and time, the order's paid amount and can_approve (dropped and created
-- again: its columns change).

-- ---------------------------------------------------------------- the switch and the acting partner

INSERT INTO public.settings (key, value, is_public, updated_at)
VALUES ('partner_payment_approval', jsonb_build_object('enabled', true), false, now())
ON CONFLICT (key) DO NOTHING;

/** Whether channel partners may approve their godown's payments (Admin > UPI & Bank Payments). Off when not set. */
CREATE OR REPLACE FUNCTION private.partner_payment_approval_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT lower(COALESCE(value->>'enabled', 'false')) = 'true' FROM public.settings WHERE key = 'partner_payment_approval'), false)
$function$;
REVOKE ALL ON FUNCTION private.partner_payment_approval_on() FROM PUBLIC, anon, authenticated;

/**
 * The channel partner approving a payment in this transaction: the partner named by app.partner_payment (set only by
 * partner_approve_payment), when that is the caller's own active partner record and approval is switched on. No row
 * otherwise, so the flag alone never lets anyone in.
 */
CREATE OR REPLACE FUNCTION private.payment_partner_acting()
RETURNS SETOF public.channel_partners
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.* FROM public.channel_partners p
  WHERE auth.uid() IS NOT NULL
    AND p.id::text = NULLIF(current_setting('app.partner_payment', true), '')
    AND p.user_id = auth.uid() AND p.status = 'active' AND p.branch_id IS NOT NULL
    AND private.partner_payment_approval_on()
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION private.payment_partner_acting() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- the office's functions, now also for the partner

CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text, _method text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  acting public.channel_partners%ROWTYPE;
  by_partner boolean := false;
  flow text;
  credit public.bank_credits%ROWTYPE;
  applied numeric;
  reference text;
  earlier numeric;
  other_order text;
  other_status text;
BEGIN
  -- Changed 16 Nov 2026: or the active channel partner of the order's own godown, through partner_approve_payment only
  -- (its flag app.partner_payment names the partner, and private.payment_partner_acting checks it is the caller).
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    SELECT * INTO acting FROM private.payment_partner_acting();
    by_partner := acting.id IS NOT NULL;
  END IF;
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR by_partner) THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
  -- Digits in another script are the same number, and nothing below would see that. Zoho takes up to 100 characters.
  reference := translate(trim(COALESCE(_utr,'')), '೦೧೨೩೪೫೬೭೮೯०१२३४५६७८९٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹０１２３４５６７８９౦౧౨౩౪౫౬౭౮౯௦௧௨௩௪௫௬௭௮௯০১২৩৪৫৬৭৮৯૦૧૨૩૪૫૬૭૮૯੦੧੨੩੪੫੬੭੮੯൦൧൨൩൪൫൬൭൮൯୦୧୨୩୪୫୬୭୮୯', '012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789');
  IF length(reference) < 4 OR length(reference) > 100 THEN RAISE EXCEPTION 'Enter the verified UTR / transfer reference'; END IF;
  -- The payment dialog sends a float: 70.14999999999999 must not leave a fully paid order "Partially Paid".
  _amount := round(_amount, 2);
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  -- Added 8 Nov 2026: how this payment came in (an order paid by NEFT and UPI has both on its invoice).
  IF _method IS NOT NULL AND _method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how this payment was made'; END IF;
  -- Once only, however the same transfer is written. The same lock as submit_upi_utr and record_bank_credit, for every
  -- number named, always in the same order.
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(reference)) AS key;
  SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
    WHERE private.same_payment_ref(p.txn_ref, reference) AND p.status = 'Paid' ORDER BY p.created_at LIMIT 1;
  IF other_order = _order_no THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded on this order. If that was only part of the money, record the rest under words that do not name it, such as rest of NEFT, and tell the office.';
  ELSIF other_order IS NOT NULL THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded on order %', other_order;
  END IF;
  -- Money that went back pays for nothing, and a payment row marked Refunded has no customer's UTR to catch it by.
  -- Bank transfers only: the word CASH on a refunded row says nothing about new cash.
  IF length(private.utr_form(reference)) >= 12
     AND EXISTS (SELECT 1 FROM public.payments WHERE private.same_payment_ref(txn_ref, reference) AND status = 'Refunded') THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF by_partner AND target.branch_id IS DISTINCT FROM acting.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  -- A partner only ever pays a waiting checkout in full, with the UTR sent for it (review_upi_utr, or Place again after
  -- it took the checkout back to waiting).
  IF by_partner AND (target.order_status <> 'Awaiting Payment' OR round(_amount, 2) <> target.total - target.paid_amount
      OR NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE order_id = target.id AND status = 'submitted' AND private.same_utr(utr, reference))) THEN
    RAISE EXCEPTION 'A channel partner approves only the full amount of a checkout, with the UTR sent for it';
  END IF;
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
    RAISE EXCEPTION 'This UTR was sent for an order of Rs % that lapsed. Record no more than that under it, and the rest under its own reference. If the bank shows more, tell the office.', to_char(earlier, 'FM99999990.00');
  END IF;
  SELECT order_no, status INTO other_order, other_status FROM public.upi_payment_submissions WHERE private.same_utr(utr, reference) AND status <> 'rejected' AND order_id <> target.id LIMIT 1;
  IF other_status = 'submitted' THEN
    RAISE EXCEPTION 'The customer sent this UTR on order % and it waits for a check. Reject it there first (UPI & Bank Payments), then record it here.', other_order;
  ELSIF other_order IS NOT NULL THEN
    RAISE EXCEPTION 'The customer sent this UTR on order %, which was paid under another reference. If this money is really for this order, record it under words that do not name the UTR, and tell the office.', other_order;
  END IF;
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
    other_order := NULL;
    SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
      WHERE private.same_utr(p.txn_ref, credit.utr) AND p.status = 'Paid' LIMIT 1;
    IF other_order IS NOT NULL OR credit.status = 'matched' THEN
      RAISE EXCEPTION 'This UTR was already used for order %', COALESCE(other_order, credit.order_no, 'another order');
    END IF;
    -- Refused, except up to a rupee short when this clears the balance (a customer who typed Rs 677 for Rs 677.25): that is recorded and the alert stays open for a person.
    IF credit.amount < _amount AND (credit.amount + 1 < _amount OR _amount < target.total - target.paid_amount) THEN
      IF target.order_status = 'Awaiting Payment' THEN
        RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Reject this UTR. If you refund the money, also mark the alert settled: a checkout is placed only when its full amount is paid.',
          credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00');
      END IF;
      RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Record Rs % as a part payment (Admin > Payments, % percent of the order), then ask the customer for the rest.',
        credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'), to_char(credit.amount, 'FM99999990.00'),
        to_char(round(credit.amount * 100 / NULLIF(target.total, 0), 8), 'FM990.09999999');
    END IF;
  END IF;
  applied := target.paid_amount + _amount;
  -- A partner's session is not an admin's: the order guard lets this payment step through as it does the bank alert's.
  IF by_partner THEN flow := current_setting('app.payment_workflow', true); PERFORM set_config('app.payment_workflow', 'on', true); END IF;
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  IF by_partner THEN PERFORM set_config('app.payment_workflow', COALESCE(flow, 'off'), true); END IF;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(_method, NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
  -- Paid in full here: the customer's open UTR is settled too, so nothing stays waiting for a check.
  IF applied >= target.total THEN
    -- Changed 13 Nov 2026: so is this order's own UTR that was rejected or lapsed when it is this very transfer (an ended
    -- checkout placed again with the UTR the customer sent): it no longer reads "Not checked in time" on a paid order.
    UPDATE public.upi_payment_submissions SET status = 'confirmed',
      note = CASE WHEN by_partner THEN left(format('Recorded by channel partner %s with reference %s', acting.name, reference), 200)
        ELSE format('Recorded by an admin with reference %s', reference) END,
      reviewed_at = now(), reviewed_by = auth.uid()
      WHERE order_id = target.id
        AND (status = 'submitted'
          OR (status = 'rejected' AND COALESCE(note, '') <> 'refunded by our team' AND COALESCE(note, '') NOT LIKE 'Placed again as %'
              AND private.same_utr(utr, reference)));
    -- Added 13 Nov 2026: the order's own lapsed UTR is another transfer: it stays open under its exact note (the list, the
    -- Refunded button and the delete guard key on it), and says why it is still there.
    UPDATE public.upi_payment_submissions
      SET follow_up = left(format('The order was paid with another payment (%s). Check whether this transfer came too: if it did, refund it and press Refunded.', reference), 300)
      WHERE order_id = target.id AND status = 'rejected' AND note = 'we could not check your UTR in time' AND NOT private.same_utr(utr, reference);
    -- Added 13 Nov 2026: a bank credit without a UTR kept for this checkout is this money, or is freed and named to the admins.
    -- When a bank alert carries this very UTR, that alert is the money recorded, so the kept credit may be a second transfer:
    -- freed and named, as on the automatic path, never closed against the same payment.
    PERFORM private.settle_kept_bank_credit(target.id, reference, _amount, credit.id IS NULL);
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
      UPDATE public.bank_credits SET status = 'matched', order_id = target.id, order_no = target.order_no,
        note = CASE WHEN by_partner THEN left('Confirmed by channel partner ' || acting.name, 200) ELSE 'Confirmed by an admin' END WHERE id = credit.id;
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
          format('The bank shows ₹%s for UTR %s, but only ₹%s was recorded for %s. Refund the extra or call the customer; if it paid another order, say so. Then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      END IF;
    END IF;
  END IF;
  RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION public.review_upi_utr(_order_no text, _decision text, _note text DEFAULT NULL::text, _expected_utr text DEFAULT NULL::text)
 RETURNS upi_payment_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  acting public.channel_partners%ROWTYPE;
  by_partner boolean := false;
  flow text;
  result public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  by_bank boolean;
  cfg jsonb;
  extra_minutes integer;
  sent_utr text;
BEGIN
  -- Changed 16 Nov 2026: or the active channel partner of the order's own godown, through partner_approve_payment only,
  -- and only to confirm: a UTR is rejected by our office.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    SELECT * INTO acting FROM private.payment_partner_acting();
    by_partner := acting.id IS NOT NULL;
  END IF;
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR by_partner) THEN RAISE EXCEPTION 'Only administrators can confirm UPI payments'; END IF;
  IF _decision NOT IN ('confirmed', 'rejected') THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  IF by_partner AND _decision <> 'confirmed' THEN RAISE EXCEPTION 'Only our office can reject a UTR'; END IF;
  -- The UTR's lock before the row locks, as in record_bank_credit: the other way round the two could wait for each other.
  SELECT utr INTO sent_utr FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF sent_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(sent_utr)) AS key; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UPI payment was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  -- The decision is about the UTR the admin looked at, not whatever the row says by now.
  IF _expected_utr IS NOT NULL AND upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the bank again.', s.utr;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
  IF by_partner AND o.branch_id IS DISTINCT FROM acting.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  by_bank := COALESCE(o.payment_method, '') IN ('NEFT', 'RTGS');
  IF _decision = 'confirmed' THEN
    IF o.order_status = 'Awaiting Payment' AND s.amount <> o.total - o.paid_amount THEN
      RAISE EXCEPTION 'An unpaid order is placed only when its full amount is paid';
    END IF;
    -- Compares the UTR with its bank alert and answers the alert.
    PERFORM public.admin_confirm_manual_payment(s.order_no, s.amount, s.utr);
    IF by_partner THEN flow := current_setting('app.payment_workflow', true); PERFORM set_config('app.payment_workflow', 'on', true); END IF;
    UPDATE public.orders SET payment_hold_until = NULL WHERE id = s.order_id AND payment_hold_until IS NOT NULL;
    IF by_partner THEN PERFORM set_config('app.payment_workflow', COALESCE(flow, 'off'), true); END IF;
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

CREATE OR REPLACE FUNCTION public.admin_place_ended_checkout(_order_no text, _utr text DEFAULT NULL::text, _method text DEFAULT NULL::text, _checked_against text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  acting public.channel_partners%ROWTYPE;
  by_partner boolean := false;
  s public.upi_payment_submissions%ROWTYPE;
  has_s boolean;
  ref text;
  method text;
  routing_on boolean;
  line record;
  stock_now numeric(14,2);
  due numeric;
BEGIN
  -- Changed 16 Nov 2026: or the active channel partner of the order's own godown, through partner_approve_payment only,
  -- with the UTR sent for the order, within the 15 days the partner's list shows.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    SELECT * INTO acting FROM private.payment_partner_acting();
    by_partner := acting.id IS NOT NULL;
  END IF;
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR by_partner) THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status <> 'Payment Expired' THEN RAISE EXCEPTION 'Only a checkout that ended without payment can be placed again here.'; END IF;
  IF by_partner AND o.branch_id IS DISTINCT FROM acting.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  IF by_partner AND o.updated_at <= now() - interval '15 days' THEN RAISE EXCEPTION 'This checkout ended more than 15 days ago. Our office checks it.'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  has_s := FOUND;
  IF has_s AND s.note = 'refunded by our team' THEN RAISE EXCEPTION 'The payment for this checkout was refunded, so it cannot be placed with it.'; END IF;
  IF has_s AND COALESCE(s.note, '') LIKE 'Placed again as %' THEN
    RAISE EXCEPTION 'The payment for this checkout already went to %.', substring(s.note from 'Placed again as (.*)$');
  END IF;
  ref := btrim(COALESCE(NULLIF(_utr, ''), CASE WHEN has_s AND s.status = 'submitted' THEN s.utr END, ''));
  IF length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR of the payment you found in the bank'; END IF;
  IF by_partner AND NOT (has_s AND s.status = 'submitted' AND ref = s.utr) THEN RAISE EXCEPTION 'Approve only the UTR sent for this order'; END IF;
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
        placed_again_by_name = CASE WHEN by_partner THEN left(acting.name || ' (channel partner)', 120)
          ELSE COALESCE((SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) FROM public.profiles WHERE id = auth.uid()), '') END
    WHERE order_id = o.id AND stage = 'Awaiting Payment' AND placed_again_at IS NULL;
  -- The customer hears "Order placed" from the order's own status change (notify_order_participants), as for any paid order.
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'amount', due, 'status', 'Payment Confirmed');
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_confirm_order(_order_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  o public.orders%ROWTYPE;
  godown text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can confirm orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN
    RAISE EXCEPTION 'This is not an order of your godown';
  END IF;
  IF o.order_status IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RETURN jsonb_build_object('order_no', o.order_no, 'status', o.order_status, 'confirmed', false, 'already', true);
  END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is cancelled, so there is nothing to confirm'; END IF;
  IF o.order_status IN ('Awaiting Payment', 'Payment Expired') THEN
    RAISE EXCEPTION 'This checkout is not a paid order yet. Approve the customer''s UTR under Customer payments if our office allows it, or our office confirms it; the order then shows here to confirm';
  END IF;
  IF o.order_status NOT IN ('Placed', 'Payment Confirmed') THEN
    RAISE EXCEPTION 'This order cannot be confirmed here (it is %)', o.order_status;
  END IF;
  IF lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled') THEN
    RAISE EXCEPTION 'This order is void in Zoho. Our office decides what happens to it';
  END IF;
  -- Money stays with the office: only an order whose payment the office (or the bank alert) has settled in full.
  IF o.payment_status = 'Refunded' THEN
    RAISE EXCEPTION 'This order''s payment was refunded, so it cannot be confirmed';
  END IF;
  IF o.payment_status IS DISTINCT FROM 'Paid' THEN
    RAISE EXCEPTION 'This order is not fully paid yet. Our office confirms the rest of the payment; once it has, you can confirm the order here';
  END IF;
  SELECT b.name INTO godown FROM public.branches b WHERE b.id = o.branch_id;
  -- The same UPDATE as admin_update_order_status, so every trigger does what it does for an admin.
  PERFORM set_config('app.partner_confirm', 'on', true);
  UPDATE public.orders SET order_status = 'Accepted' WHERE id = o.id;
  PERFORM set_config('app.partner_confirm', 'off', true);
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
    VALUES (o.id, 'Accepted', format('Confirmed by channel partner %s at %s.', me.name, COALESCE(godown, o.branch_id)), 'partner', me.id);
  RETURN jsonb_build_object('order_no', o.order_no, 'status', 'Accepted', 'confirmed', true, 'already', false);
END $function$;

-- ---------------------------------------------------------------- the partner's list and approval

DROP FUNCTION IF EXISTS public.partner_payment_checkouts();
CREATE FUNCTION public.partner_payment_checkouts()
RETURNS TABLE (order_no text, status text, total numeric, method text, placed_at timestamptz, hold_until timestamptz,
  customer text, items text, utr text, utr_status text, utr_late boolean, utr_sent_by text,
  utr_amount numeric, utr_sent_at timestamptz, paid_amount numeric, can_approve boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  branch text := public.current_partner_branch();
  approving boolean := private.partner_payment_approval_on();
BEGIN
  IF auth.uid() IS NULL OR branch IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can see this'; END IF;
  RETURN QUERY
  SELECT o.order_no, o.order_status, o.total, COALESCE(o.payment_method, 'UPI'), o.created_at, o.payment_hold_until,
    left(COALESCE(NULLIF(btrim(o.customer_name), ''), 'Customer'), 60),
    (SELECT string_agg(i.product_name || ' × ' || to_char(i.qty, 'FM99999990.##'), ', ') FROM public.order_items i WHERE i.order_id = o.id),
    s.utr, s.status, COALESCE(s.late, false), s.sent_by_role,
    -- Added 16 Nov 2026: what the UTR is for and when it came, and whether this partner may approve it now.
    s.amount, s.submitted_at, COALESCE(o.paid_amount, 0),
    COALESCE(approving AND s.status = 'submitted'
      AND COALESCE(s.sent_by_role, '') <> 'partner' AND s.sent_by IS DISTINCT FROM auth.uid() AND o.user_id IS DISTINCT FROM auth.uid()
      AND (o.order_status <> 'Awaiting Payment' OR s.amount = o.total - COALESCE(o.paid_amount, 0))
      AND (o.order_status <> 'Payment Expired' OR o.updated_at > now() - interval '15 days'), false)
  FROM public.orders o
  LEFT JOIN public.upi_payment_submissions s ON s.order_id = o.id
  WHERE o.branch_id = branch
    AND (o.order_status = 'Awaiting Payment' OR (o.order_status = 'Payment Expired' AND o.updated_at > now() - interval '15 days'))
    AND COALESCE(s.note, '') <> 'refunded by our team' AND COALESCE(s.note, '') NOT LIKE 'Placed again as %'
  ORDER BY o.created_at DESC
  LIMIT 100;
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_payment_checkouts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_payment_checkouts() TO authenticated;

/**
 * The godown's channel partner approves a customer's payment (16 Nov 2026). _expected_utr: the UTR the partner looked
 * at (refused if the order's UTR has changed since). _checked: where they saw the money (bank_sms, bank_statement or
 * upi_app). Returns the order's number, UTR, amount and new status.
 */
CREATE OR REPLACE FUNCTION public.partner_approve_payment(_order_no text, _expected_utr text, _checked text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  after public.orders%ROWTYPE;
  godown text;
  checked text;
  note text;
  amount numeric;
  placed jsonb;
  failed text;
BEGIN
  SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL;
  IF auth.uid() IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Only an active channel partner can approve payments here'; END IF;
  IF NOT private.partner_payment_approval_on() THEN
    RAISE EXCEPTION 'Our office has turned off payment approval by channel partners. Our office will check this payment.';
  END IF;
  checked := CASE btrim(COALESCE(_checked, ''))
    WHEN 'bank_sms' THEN 'the bank''s SMS or alert'
    WHEN 'bank_statement' THEN 'the bank statement or passbook'
    WHEN 'upi_app' THEN 'the business UPI app''s received payments'
  END;
  IF checked IS NULL THEN RAISE EXCEPTION 'Choose where you saw this payment'; END IF;
  -- Read here, not locked: review_upi_utr and admin_place_ended_checkout lock what they change, in the same order as
  -- when our office presses Confirm or Place again, and check everything again.
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'No UTR is waiting for a check on this order'; END IF;
  IF _expected_utr IS NULL OR upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the payment again.', s.utr;
  END IF;
  -- A second person checks what a partner entered: a UTR the partner sent, or the partner's own order, is our office's.
  IF COALESCE(s.sent_by_role, '') = 'partner' OR s.sent_by IS NOT DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You sent this UTR yourself, so our office checks it';
  END IF;
  IF o.user_id IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;
  SELECT NULLIF(btrim(name), '') INTO godown FROM public.branches WHERE id = me.branch_id;
  godown := COALESCE(godown, me.branch_id);
  note := left(format('Approved by channel partner %s (%s) after checking %s', me.name, godown, checked), 200);
  PERFORM set_config('app.partner_payment', me.id::text, true);
  BEGIN
    IF o.order_status = 'Awaiting Payment' THEN
      amount := s.amount;
      PERFORM public.review_upi_utr(o.order_no, 'confirmed', note, s.utr);
    ELSIF o.order_status = 'Payment Expired' THEN
      -- The same 15 days as the partner's list and the customer's late UTR (the order's last change).
      IF o.updated_at <= now() - interval '15 days' THEN
        RAISE EXCEPTION 'This checkout ended more than 15 days ago. Our office checks it.';
      END IF;
      -- Exactly our office's Place again, which locks the order and then the UTR, so a partner and the office pressing it
      -- at once simply queue. The UTR the partner looked at goes in: Place again refuses it if the order's UTR has changed.
      placed := public.admin_place_ended_checkout(o.order_no, s.utr, NULL, note);
      amount := (placed->>'amount')::numeric;
    ELSE
      RAISE EXCEPTION 'This order is not waiting for payment';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS failed = MESSAGE_TEXT;
    -- Our office's own words ask for office-only steps (reject, refund, record a part payment, add stock): the partner
    -- is told to leave it for our office. Everything else is said as it is.
    IF failed LIKE 'The bank alert for UTR % shows Rs %' THEN
      RAISE EXCEPTION 'The bank shows a different amount for UTR %. Leave this payment for our office.', s.utr;
    ELSIF failed LIKE 'Only % left of % at its godown%' OR failed LIKE 'Only % ready now%' THEN
      RAISE EXCEPTION 'Not enough stock is left at your godown to place this order again. Leave it for our office.';
    ELSIF failed LIKE 'The customer sent this UTR on order %' THEN
      RAISE EXCEPTION 'This UTR was also sent on another order. Leave this payment for our office.';
    ELSIF failed LIKE 'This UTR was sent for an order of Rs % that lapsed%' OR failed LIKE 'This transfer reference has already been recorded on this order.%' THEN
      RAISE EXCEPTION 'This UTR was sent for another checkout. Leave this payment for our office.';
    END IF;
    RAISE EXCEPTION '%', failed;
  WHEN deadlock_detected THEN
    -- Our office decided on this same UTR at the same moment: nothing was changed.
    RAISE EXCEPTION 'Our office is working on this payment right now. Check the list again in a moment.';
  END;
  PERFORM set_config('app.partner_payment', '', true);
  SELECT * INTO after FROM public.orders WHERE id = o.id;
  -- Who approved it stays on the order's history.
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
  VALUES (o.id, after.order_status,
    left(format('Payment approved by channel partner %s at %s: UTR %s, Rs %s, after checking %s.', me.name, godown, s.utr, to_char(amount, 'FM99999990.00'), checked), 500),
    'partner', me.id);
  -- Our office hears of every approval by a partner, to check it in the company's bank account.
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment approved by channel partner',
    format('%s (channel partner, %s) approved UTR %s for ₹%s on order %s after checking %s. Check it in the bank account.',
      me.name, godown, s.utr, to_char(amount, 'FM99999990.00'), o.order_no, checked),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', s.utr, 'amount', amount, 'status', after.order_status, 'payment_status', after.payment_status);
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_approve_payment(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_approve_payment(text, text, text) TO authenticated;

/** Admin > UPI & Bank Payments: whether channel partners may approve their godown's payments. */
CREATE OR REPLACE FUNCTION public.admin_set_partner_payment_approval(_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can change this'; END IF;
  IF _enabled IS NULL THEN RAISE EXCEPTION 'Choose on or off'; END IF;
  v := jsonb_build_object('enabled', _enabled, 'changedAt', now(),
    'changedBy', COALESCE((SELECT NULLIF(btrim(full_name), '') FROM public.profiles WHERE id = auth.uid()), 'an admin'));
  INSERT INTO public.settings (key, value, is_public, updated_at) VALUES ('partner_payment_approval', v, false, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_public = false, updated_at = now();
  RETURN v;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_set_partner_payment_approval(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_partner_payment_approval(boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
