-- 13 Nov 2026 (owner: "fix all this kind of glitches"): a list, card, notice or customer message that still shows something
-- as open, unpaid, rejected, lapsed or needing action after it was resolved another way. Database side.
--
-- Every function below is built from its LIVE definition (pg_get_functiondef, read 13 Nov 2026), not from an older
-- migration. CREATE OR REPLACE keeps each function's grants; the one signature that changes (settle_bank_credit) gets the
-- grants it had. Safe to run twice: the one-off data fixes are guarded and change nothing the second time.
--
--  1. admin_confirm_manual_payment (paid in full): the order's own rejected UTR with the same transfer is confirmed too;
--     a lapsed UTR that is NOT the money recorded stays open (its exact note drives every tool) and gets a follow_up line.
--     admin_place_ended_checkout's closing note also takes that row and names the admin who placed it.
--  2. mark_utr_refunded: locks the row and refuses when the transfer already paid something, naming the order.
--  3. One-off: CLK-577522-111126-155932 / UTR 578086325096 -> confirmed (guarded).
--  4. sync_order_vendor_fulfillments: forward-only copy for any role; one-off for the 2 live seller rows (guarded).
--  5. order_cancellations: an ended checkout placed again is marked, not deleted; a later real cancel replaces it.
--  6. A bank credit without a UTR kept for a checkout is settled when that checkout is paid another way
--     (private.settle_kept_bank_credit), and reopened when that payment is removed.
--  7. One refund records both sides: private.record_utr_refund, called by mark_utr_refunded and
--     settle_bank_credit(..., _refunded => true).
--  8. Customer data delete: a lapsed UTR blocks only while its money is not accounted for.
--  9. admin_cancel_order with a refund: the order's confirmed UTR reads refunded.
-- 10. admin_delete_payment: a lapsed UTR it had placed again is open again.
-- 11. cancel_marketplace_order refuses while a UTR waits; apply_zoho_order_cancellation closes a waiting UTR as not
--     checked in time and tells the admins.
-- 12. admin_utr_conflicts: a lapsed UTR placed again on the same account is settled on its own.

-- ---------------------------------------------------------------- new columns

ALTER TABLE public.upi_payment_submissions ADD COLUMN IF NOT EXISTS follow_up text;
COMMENT ON COLUMN public.upi_payment_submissions.follow_up IS
  'What an admin still has to do about a UTR nobody checked in time, when its order was paid with another payment. Cleared when the row is settled.';

ALTER TABLE public.order_cancellations
  ADD COLUMN IF NOT EXISTS placed_again_at timestamptz,
  ADD COLUMN IF NOT EXISTS placed_again_by_name text,
  ADD COLUMN IF NOT EXISTS earlier jsonb;
COMMENT ON COLUMN public.order_cancellations.placed_again_at IS
  'An ended checkout (stage Awaiting Payment) that an admin placed again after finding its payment: the order is not cancelled.';
COMMENT ON COLUMN public.order_cancellations.earlier IS
  'The record this one replaced: the ended checkout of an order that was placed again and later cancelled.';

ALTER TABLE public.bank_credits_without_reference ADD COLUMN IF NOT EXISTS paid_by_ref text;
COMMENT ON COLUMN public.bank_credits_without_reference.paid_by_ref IS
  'The payment reference this credit was taken as (used): removing that payment reopens the credit.';

-- A follow_up line belongs to an open lapsed UTR only: once the row is settled any other way it would be stale.
CREATE OR REPLACE FUNCTION private.clear_settled_follow_up()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.follow_up IS NOT NULL AND NOT (NEW.status = 'rejected' AND NEW.note IS NOT DISTINCT FROM 'we could not check your UTR in time') THEN
    NEW.follow_up := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.clear_settled_follow_up() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS upi_submissions_clear_follow_up ON public.upi_payment_submissions;
CREATE TRIGGER upi_submissions_clear_follow_up BEFORE UPDATE OF status, note ON public.upi_payment_submissions
  FOR EACH ROW EXECUTE FUNCTION private.clear_settled_follow_up();

-- ---------------------------------------------------------------- 6. a kept bank credit, when its checkout is paid another way

-- Called wherever an order becomes Paid in full. A credit without a UTR kept for this checkout (orders.bank_credit_id, or
-- suggested for it) is taken as the money recorded when an admin recorded it (_taken) and the amount is the same. Otherwise
-- (the automatic UTR path, another amount, a second credit, or another credit being used right now) it is freed for its
-- real order or a refund, and the admins are told.
CREATE OR REPLACE FUNCTION private.settle_kept_bank_credit(_order_id uuid, _reference text, _amount numeric, _taken boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  c public.bank_credits_without_reference%ROWTYPE;
  paying uuid := NULLIF(current_setting('app.paying_with_bank_credit', true), '')::uuid;
  workflow text := COALESCE(current_setting('app.payment_workflow', true), 'off');
  taken integer := 0;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR c IN
    SELECT * FROM public.bank_credits_without_reference
     WHERE status = 'new' AND (id = o.bank_credit_id OR suggested_order_no = o.order_no) AND id IS DISTINCT FROM paying
     ORDER BY received_at, id
     FOR UPDATE
  LOOP
    IF _taken AND paying IS NULL AND taken = 0 AND c.amount = round(_amount, 2) THEN
      UPDATE public.bank_credits_without_reference
         SET status = 'used', order_no = o.order_no, decided_by = auth.uid(), decided_at = now(), paid_by_ref = _reference,
             note = left(format('Its checkout %s was paid with reference %s; taken as that money', o.order_no, _reference), 300)
       WHERE id = c.id;
      taken := taken + 1;
    ELSE
      UPDATE public.bank_credits_without_reference SET suggested_order_no = NULL WHERE id = c.id AND suggested_order_no = o.order_no;
      IF o.bank_credit_id = c.id THEN
        PERFORM set_config('app.payment_workflow', 'on', true);
        UPDATE public.orders SET bank_credit_id = NULL WHERE id = o.id AND bank_credit_id = c.id;
        PERFORM set_config('app.payment_workflow', workflow, true);
      END IF;
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment needs you',
        format('Rs %s credited to A/C ...%s%s was kept for %s, and %s has now been paid with reference %s. If that is the same money, dismiss this credit as already recorded; if not, refund it or find its order (Admin > UPI & Bank Payments).',
          to_char(c.amount, 'FM99999990.00'), c.account_ending,
          COALESCE(' at ' || to_char(c.credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), ''), o.order_no, o.order_no, _reference),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    END IF;
  END LOOP;
  RETURN taken;
END;
$function$;
REVOKE ALL ON FUNCTION private.settle_kept_bank_credit(uuid, text, numeric, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 7. one refund, both sides

-- Money for a UTR went back to the customer: every lapsed UTR row of that transfer is marked refunded (the trigger puts it
-- on refunded_transfers) and its customer is told once, and every bank alert for it still open is settled. When the
-- transfer paid an order, what went back was only an extra: the UTR rows stay as they are.
CREATE OR REPLACE FUNCTION private.record_utr_refund(_utr text, _note text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s record;
  marked integer := 0;
  told uuid[] := '{}';
BEGIN
  IF length(private.utr_form(COALESCE(_utr, ''))) < 12 THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(_utr)) AS key;
  IF NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.status = 'Paid' AND private.same_payment_ref(p.txn_ref, _utr))
     AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions x WHERE x.status = 'confirmed' AND private.same_utr(x.utr, _utr)) THEN
    FOR s IN
      UPDATE public.upi_payment_submissions SET note = 'refunded by our team', reviewed_at = now(), reviewed_by = auth.uid()
       WHERE status = 'rejected' AND note = 'we could not check your UTR in time' AND private.same_utr(utr, _utr)
      RETURNING order_no, order_id, user_id, utr
    LOOP
      marked := marked + 1;
      IF s.user_id IS NOT NULL AND NOT (s.user_id = ANY (told)) THEN
        INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
        VALUES (s.order_no, s.order_id, s.user_id, 'customer', 'Refund recorded',
          format('Your transfer with UTR %s for %s was refunded.', s.utr, s.order_no), 'payment');
        told := told || s.user_id;
      END IF;
    END LOOP;
  END IF;
  UPDATE public.bank_credits SET status = 'settled', note = left('Refunded: ' || COALESCE(NULLIF(btrim(_note), ''), 'money sent back'), 300)
   WHERE private.same_utr(utr, _utr) AND status IN ('unmatched', 'ambiguous', 'mismatch', 'late', 'balance');
  RETURN marked;
END;
$function$;
REVOKE ALL ON FUNCTION private.record_utr_refund(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 1. + 6. recording a payment

CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text, _method text DEFAULT NULL::text)
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
  other_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
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
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(_method, NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
  -- Paid in full here: the customer's open UTR is settled too, so nothing stays waiting for a check.
  IF applied >= target.total THEN
    -- Changed 13 Nov 2026: so is this order's own UTR that was rejected or lapsed when it is this very transfer (an ended
    -- checkout placed again with the UTR the customer sent): it no longer reads "Not checked in time" on a paid order.
    UPDATE public.upi_payment_submissions SET status = 'confirmed', note = format('Recorded by an admin with reference %s', reference),
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
    PERFORM private.settle_kept_bank_credit(target.id, reference, _amount, true);
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
          format('The bank shows ₹%s for UTR %s, but only ₹%s was recorded for %s. Refund the extra or call the customer; if it paid another order, say so. Then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      END IF;
    END IF;
  END IF;
  RETURN true;
END; $function$;

-- The automatic path (a bank alert with this UTR): a kept credit without a UTR may be a second transfer, so it is freed and
-- named to the admins rather than taken.
CREATE OR REPLACE FUNCTION private.confirm_held_payment(_order_id uuid, _utr text, _note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  paid_by text;
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Order % is not waiting for payment', target.order_no; END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, _utr) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  paid_by := COALESCE(NULLIF(target.payment_method, ''), 'UPI');
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders
    SET paid_amount = total, balance_due = 0, payment_status = 'Paid', order_status = 'Payment Confirmed',
        payment_method = paid_by, payment_hold_until = NULL
    WHERE id = target.id;
  INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, 'advance', target.total - target.paid_amount, paid_by, 'Paid', _utr);
  PERFORM private.close_lapsed_utr(_utr, target.id, target.order_no);
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at)
  VALUES (target.id, target.order_no, target.user_id, COALESCE(target.customer_name, ''), target.total - target.paid_amount, _utr,
    'confirmed', _note, now(), now())
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'confirmed',
    note = EXCLUDED.note, reviewed_at = now(), reviewed_by = NULL;
  -- Added 13 Nov 2026.
  PERFORM private.settle_kept_bank_credit(target.id, _utr, target.total - target.paid_amount, false);
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$;

-- One credit pays one order: when an admin gives a credit to an order, any other credit kept for that order is freed
-- rather than taken too, and the credit remembers the payment it became (so removing it reopens the credit).
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
  kept_here uuid;
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
  PERFORM set_config('app.paying_with_bank_credit', c.id::text, true);
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF FOUND AND s.status = 'submitted' THEN
    IF s.amount <> c.amount THEN
      RAISE EXCEPTION 'The bank credit is Rs % but this order''s payment is Rs %', to_char(c.amount, 'FM99999990.00'), to_char(s.amount, 'FM99999990.00');
    END IF;
    -- Added 13 Nov 2026: as below, one order is paid by one credit.
    SELECT bank_credit_id INTO kept_here FROM public.orders WHERE order_no = _order_no;
    IF kept_here IS NOT NULL AND kept_here <> c.id THEN RAISE EXCEPTION 'Another bank credit is kept for this order'; END IF;
    reference := s.utr;
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
  PERFORM set_config('app.paying_with_bank_credit', '', true);
  UPDATE public.bank_credits_without_reference
  SET status = 'used', order_no = _order_no, decided_by = auth.uid(), decided_at = now(), paid_by_ref = reference
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'confirmed', 'order_no', _order_no);
END;
$function$;

-- ---------------------------------------------------------------- 1. + 5. an ended checkout placed again

CREATE OR REPLACE FUNCTION public.admin_place_ended_checkout(_order_no text, _utr text DEFAULT NULL::text, _method text DEFAULT NULL::text, _checked_against text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  has_s boolean;
  ref text;
  method text;
  routing_on boolean;
  line record;
  stock_now numeric(14,2);
  due numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status <> 'Payment Expired' THEN RAISE EXCEPTION 'Only a checkout that ended without payment can be placed again here.'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  has_s := FOUND;
  IF has_s AND s.note = 'refunded by our team' THEN RAISE EXCEPTION 'The payment for this checkout was refunded, so it cannot be placed with it.'; END IF;
  IF has_s AND COALESCE(s.note, '') LIKE 'Placed again as %' THEN
    RAISE EXCEPTION 'The payment for this checkout already went to %.', substring(s.note from 'Placed again as (.*)$');
  END IF;
  ref := btrim(COALESCE(NULLIF(_utr, ''), CASE WHEN has_s AND s.status = 'submitted' THEN s.utr END, ''));
  IF length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR of the payment you found in the bank'; END IF;
  method := upper(btrim(COALESCE(NULLIF(_method, ''), o.payment_method, 'UPI')));
  IF method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'CASH', 'CHEQUE') THEN RAISE EXCEPTION 'Choose how it was paid'; END IF;
  method := CASE method WHEN 'CASH' THEN 'Cash' WHEN 'CHEQUE' THEN 'Cheque' ELSE method END;

  -- Its stock went back on sale when it ended: take it again at its godown, as placing it took it, or refuse.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  FOR line IN
    SELECT i.id, i.product_id, i.qty, i.product_name, cp.payload FROM public.order_items i
    LEFT JOIN public.catalog_products cp ON cp.id = i.product_id WHERE i.order_id = o.id
  LOOP
    stock_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = o.branch_id AND product_id = line.product_id), 0)
      ELSE COALESCE((line.payload->>'stock')::numeric, 0) END;
    IF stock_now < line.qty THEN
      RAISE EXCEPTION 'Only % left of % at its godown, so it cannot be placed again. Refund the customer, or add stock first.',
        to_char(stock_now, 'FM99999990.##'), COALESCE(line.product_name, 'an item');
    END IF;
  END LOOP;
  PERFORM set_config('app.branch_id', COALESCE(o.branch_id, ''), true);
  FOR line IN SELECT i.id, i.product_id, i.qty FROM public.order_items i WHERE i.order_id = o.id LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - line.qty), true),
        '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + line.qty), true
      ), updated_at = now()
      WHERE id = line.product_id;
    PERFORM private.allocate_order_item_batches(line.id, line.product_id, o.branch_id, line.qty);
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
        placed_again_by_name = COALESCE((SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) FROM public.profiles WHERE id = auth.uid()), '')
    WHERE order_id = o.id AND stage = 'Awaiting Payment' AND placed_again_at IS NULL;
  -- The customer hears "Order placed" from the order's own status change (notify_order_participants), as for any paid order.
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'amount', due, 'status', 'Payment Confirmed');
END;
$function$;

-- ---------------------------------------------------------------- 2. + 7. refunds

CREATE OR REPLACE FUNCTION public.mark_utr_refunded(_order_no text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  sent_utr text;
  paid_order text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can record a refund'; END IF;
  -- Changed 13 Nov 2026: the UTR's lock, then the row's (as review_upi_utr takes them), so a payment being recorded with
  -- this transfer at the same moment is seen.
  SELECT utr INTO sent_utr FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF sent_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(sent_utr)) AS key; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND OR s.status <> 'rejected' OR s.note IS DISTINCT FROM 'we could not check your UTR in time' THEN
    RAISE EXCEPTION 'Only a UTR that was not checked in time can be marked refunded';
  END IF;
  -- Money that paid an order was not sent back: nothing to refund.
  SELECT o.order_no INTO paid_order FROM public.payments p JOIN public.orders o ON o.id = p.order_id
    WHERE p.status = 'Paid' AND private.same_payment_ref(p.txn_ref, s.utr) ORDER BY p.created_at LIMIT 1;
  IF paid_order IS NULL THEN
    SELECT x.order_no INTO paid_order FROM public.upi_payment_submissions x
      WHERE x.id <> s.id AND x.status = 'confirmed' AND private.same_utr(x.utr, s.utr) LIMIT 1;
  END IF;
  IF paid_order IS NULL THEN
    SELECT COALESCE(b.order_no, 'another order') INTO paid_order FROM public.bank_credits b
      WHERE b.status = 'matched' AND private.same_utr(b.utr, s.utr) LIMIT 1;
  END IF;
  IF paid_order IS NOT NULL THEN
    RAISE EXCEPTION 'UTR % already paid order %, so there is nothing to refund. If the bank shows this money twice, refund the second transfer under its own UTR.', s.utr, paid_order;
  END IF;
  -- The bank alert for this transfer is with another order's payment: it is decided there.
  SELECT b.order_no INTO paid_order FROM public.bank_credits b
    WHERE b.status IN ('mismatch', 'balance') AND b.order_id IS NOT NULL AND b.order_id <> s.order_id AND private.same_utr(b.utr, s.utr) LIMIT 1;
  IF paid_order IS NOT NULL THEN
    RAISE EXCEPTION 'The bank alert for UTR % is on order %. Settle it there first.', s.utr, paid_order;
  END IF;
  -- Added 13 Nov 2026: one refund, both sides: this row (and any other lapsed row of the same transfer), the refunded
  -- list, the customer's message and the bank alert for it.
  PERFORM private.record_utr_refund(s.utr, format('marked refunded on %s', s.order_no));
  RETURN true;
END;
$function$;

-- The signature gains _refunded, so the old one goes (a second overload would make two-argument calls ambiguous).
DROP FUNCTION IF EXISTS public.settle_bank_credit(uuid, text);
CREATE OR REPLACE FUNCTION public.settle_bank_credit(_credit_id uuid, _note text, _refunded boolean DEFAULT false)
 RETURNS bank_credits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result public.bank_credits%ROWTYPE;
  credit_utr text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can settle a bank credit'; END IF;
  IF NULLIF(trim(COALESCE(_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Say what was done (for example: refunded on 27 Oct)'; END IF;
  IF _refunded THEN
    -- The UTR's lock before the alert's row, as admin_confirm_manual_payment takes them.
    SELECT utr INTO credit_utr FROM public.bank_credits WHERE id = _credit_id;
    IF credit_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(credit_utr)) AS key; END IF;
  END IF;
  UPDATE public.bank_credits SET status = 'settled', note = trim(_note)
    WHERE id = _credit_id AND status IN ('unmatched', 'ambiguous', 'mismatch', 'late', 'balance')
    RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'This credit is already matched or settled'; END IF;
  -- Added 13 Nov 2026: refunded here is refunded everywhere: the customer's lapsed UTR for it is marked refunded too.
  IF _refunded THEN PERFORM private.record_utr_refund(result.utr, trim(_note)); END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.settle_bank_credit(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_bank_credit(uuid, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reopen_bank_credit(_credit_id uuid)
 RETURNS bank_credits
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result public.bank_credits%ROWTYPE;
  was text;
  credit_utr text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can reopen a bank credit'; END IF;
  SELECT note, utr INTO was, credit_utr FROM public.bank_credits WHERE id = _credit_id AND status = 'settled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a settled credit can be reopened'; END IF;
  -- Added 13 Nov 2026: money recorded as sent back can pay nothing, so reopening it would promise what every payment refuses.
  IF private.utr_is_refunded(credit_utr) THEN
    RAISE EXCEPTION 'This transfer was recorded as refunded, so it cannot pay an order.';
  END IF;
  UPDATE public.bank_credits SET status = 'mismatch',
    note = format('Reopened. It was settled: %s', COALESCE(was, 'no note'))
    WHERE id = _credit_id RETURNING * INTO result;
  PERFORM private.alert_admins_about_credit(result, 'Payment needs you',
    format('The bank alert for ₹%s (UTR %s) was settled and has been reopened. It was settled: %s', to_char(result.amount, 'FM99999990.00'), result.utr, COALESCE(was, 'no note')));
  RETURN result;
END;
$function$;

-- ---------------------------------------------------------------- 4. seller rows follow the order forward

CREATE OR REPLACE FUNCTION public.sync_order_vendor_fulfillments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  syncing_setting text;
  stage text[] := ARRAY['Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered'];
BEGIN
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  -- An unpaid checkout has no fulfilment to move. In an admin's session this copy broke the status CHECK.
  IF NEW.order_status IN ('Awaiting Payment', 'Payment Expired') THEN RETURN NEW; END IF;
  syncing_setting := COALESCE(current_setting('app.syncing_vendor_fulfillments', true), 'off');
  IF NEW.order_status = 'Cancelled' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = 'Cancelled', updated_at = now()
      WHERE order_id = NEW.id AND status <> 'Cancelled';
  ELSIF public.has_role(auth.uid(), 'admin') THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = NEW.order_status, updated_at = now()
      WHERE order_id = NEW.id AND status IS DISTINCT FROM NEW.order_status;
  ELSIF array_position(stage, NEW.order_status) IS NOT NULL THEN
    -- Changed 13 Nov 2026: any role moves the seller rows forward, never back and never out of Cancelled: a channel
    -- partner's hand-over scan (Delivered), Zoho's packages and shipments, the automatic payment confirmation.
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = NEW.order_status, updated_at = now()
      WHERE order_id = NEW.id AND status <> 'Cancelled'
        AND array_position(stage, status) < array_position(stage, NEW.order_status);
  END IF;
  PERFORM set_config('app.syncing_vendor_fulfillments', COALESCE(syncing_setting, 'off'), true);
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- 5. + 9. cancelling with a refund

CREATE OR REPLACE FUNCTION public.admin_cancel_order(_order_no text, _reason text, _goods_back boolean DEFAULT NULL::boolean, _refund jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  who text;
  after_dispatch boolean;
  stock_back boolean;
  paid_rows numeric;
  paid numeric;
  refund_mode text;
  refund_ref text;
  refund_date_text text;
  refund_date date;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  other text;
  p record;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may cancel orders here'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this order is being cancelled'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is already cancelled.'; END IF;
  IF o.order_status = 'Awaiting Payment' THEN
    RAISE EXCEPTION 'This checkout is still waiting for payment. End it with End checkout on UPI & Bank Payments.';
  END IF;
  IF o.order_status = 'Payment Expired' THEN
    RAISE EXCEPTION 'This checkout already ended without payment. Delete it from the ended checkouts list if it is not wanted.';
  END IF;
  -- A UTR still being checked may be money on its way: it is confirmed or rejected first.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
    RAISE EXCEPTION 'A UTR on this order waits for a check. Confirm or reject it on UPI & Bank Payments first.';
  END IF;
  PERFORM set_config('app.branch_id', COALESCE(o.branch_id, ''), true);

  after_dispatch := o.order_status IN ('Dispatched', 'Out for Delivery', 'Delivered')
    OR EXISTS (SELECT 1 FROM public.order_vendor_fulfillments f WHERE f.order_id = o.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered'));
  IF after_dispatch AND _goods_back IS NULL THEN RAISE EXCEPTION 'Say whether the goods came back to the godown.'; END IF;
  stock_back := NOT after_dispatch OR _goods_back;

  -- Money received is paid back first, all of it, and the payment records stay, marked Refunded.
  SELECT COALESCE(sum(amount), 0) INTO paid_rows FROM public.payments WHERE order_id = o.id AND status = 'Paid';
  paid := GREATEST(paid_rows, COALESCE(o.paid_amount, 0));
  IF paid > 0 OR COALESCE(o.payment_status, '') IN ('Paid', 'Partially Paid') THEN
    IF _refund IS NULL OR jsonb_typeof(_refund) <> 'object' THEN
      RAISE EXCEPTION 'Rs % was paid on this order. Record how it was paid back to the customer first.', to_char(paid, 'FM99999990.00');
    END IF;
    refund_mode := btrim(COALESCE(_refund->>'mode', ''));
    IF refund_mode NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how the money was paid back'; END IF;
    -- A bank reference is kept without spaces, like every UTR here; a note about cash or a cheque as it was typed.
    refund_ref := CASE WHEN refund_mode IN ('Cash', 'Cheque')
      THEN btrim(regexp_replace(COALESCE(_refund->>'reference', ''), '\s+', ' ', 'g'))
      ELSE upper(regexp_replace(COALESCE(_refund->>'reference', ''), '\s+', '', 'g')) END;
    IF refund_mode <> 'Cash' AND length(refund_ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR or reference of the refund'; END IF;
    IF length(refund_ref) > 100 THEN RAISE EXCEPTION 'The refund reference is too long'; END IF;
    refund_date_text := btrim(COALESCE(_refund->>'refunded_on', ''));
    IF refund_date_text !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Enter the date the money was paid back'; END IF;
    refund_date := refund_date_text::date;
    IF refund_date > today THEN RAISE EXCEPTION 'The refund date cannot be in the future'; END IF;
    IF refund_date < (o.created_at AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'The refund date is before the order was placed'; END IF;
    -- Our own transfer out can pay back one order only.
    IF length(private.utr_form(refund_ref)) >= 12 THEN
      SELECT r.order_no INTO other FROM public.order_refunds r
        WHERE r.order_id <> o.id AND private.same_payment_ref(r.reference, refund_ref) LIMIT 1;
      IF other IS NOT NULL THEN RAISE EXCEPTION 'This refund reference is already recorded on order %', other; END IF;
    END IF;
    SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();

    FOR p IN SELECT * FROM public.payments WHERE order_id = o.id AND status = 'Paid' ORDER BY created_at, id FOR UPDATE LOOP
      UPDATE public.payments SET status = 'Refunded' WHERE id = p.id;
      INSERT INTO public.order_refunds (order_id, order_no, payment_id, paid_ref, amount, mode, reference, refunded_on, created_by, created_by_name, zoho_payment_id)
      VALUES (o.id, o.order_no, p.id, COALESCE(p.txn_ref, ''), p.amount, refund_mode, refund_ref, refund_date, auth.uid(), COALESCE(who, ''), NULLIF(p.zoho_payment_id, ''));
      IF length(private.utr_form(COALESCE(p.txn_ref, ''))) >= 12 THEN
        INSERT INTO public.refunded_transfers (utr, order_no, amount, source) VALUES (p.txn_ref, o.order_no, p.amount, 'order_refund')
          ON CONFLICT (utr, order_no) DO NOTHING;
      END IF;
    END LOOP;
    -- Money on the order with no payment record behind it (older orders) is refunded too.
    IF COALESCE(o.paid_amount, 0) > paid_rows THEN
      INSERT INTO public.order_refunds (order_id, order_no, amount, mode, reference, refunded_on, created_by, created_by_name)
      VALUES (o.id, o.order_no, o.paid_amount - paid_rows, refund_mode, refund_ref, refund_date, auth.uid(), COALESCE(who, ''));
    END IF;
    -- A bank alert that paid this order paid for nothing in the end: it is settled, with the refund named.
    UPDATE public.bank_credits SET status = 'settled',
        note = left(format('Refunded by %s%s on %s (order %s cancelled)', refund_mode, CASE WHEN refund_ref <> '' THEN ' ' || refund_ref ELSE '' END,
          to_char(refund_date, 'DD Mon YYYY'), o.order_no), 300)
      WHERE order_id = o.id AND status <> 'settled';
    -- Added 13 Nov 2026: the customer's UTR that paid this order no longer reads "Confirmed paid": it was paid back (every
    -- Paid payment above was, whatever reference it was recorded under; an order has one UTR row). Who approved it and when
    -- stay (Approved by); the refund itself is on order_refunds and order_cancellations with who did it.
    UPDATE public.upi_payment_submissions SET status = 'rejected', note = 'refunded by our team'
      WHERE order_id = o.id AND status = 'confirmed';
  ELSIF _refund IS NOT NULL AND jsonb_typeof(_refund) = 'object' THEN
    RAISE EXCEPTION 'Nothing was paid on this order, so there is no refund to record.';
  ELSE
    SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  END IF;

  -- The goods are in the godown (not yet sent, or back): stock and batches get them back, as a cancel always did.
  IF stock_back THEN
    FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = o.id LOOP
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
      WHERE oi.order_id = o.id AND a.released_quantity < a.reserved_quantity
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
  END IF;

  IF o.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = o.coupon;
  END IF;

  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  PERFORM set_config('app.admin_cancel', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0, payment_hold_until = NULL,
        paid_amount = CASE WHEN paid > 0 THEN 0 ELSE paid_amount END,
        payment_status = CASE WHEN paid > 0 OR payment_status IN ('Paid', 'Partially Paid') THEN 'Refunded' ELSE payment_status END
    WHERE id = o.id;
  PERFORM set_config('app.admin_cancel', 'off', true);
  PERFORM set_config('app.cancel_order_workflow', 'off', true);

  -- Changed 13 Nov 2026: an ended checkout that was placed again already has a record (who ended it): this cancel replaces
  -- it, and the ended checkout is kept in "earlier". Before, the second insert failed on the one-per-order key.
  INSERT INTO public.order_cancellations AS c (order_id, order_no, stage, goods_back, refunded, reason, cancelled_by, cancelled_by_name)
  VALUES (o.id, o.order_no, o.order_status, CASE WHEN after_dispatch THEN _goods_back END, paid, why, auth.uid(), COALESCE(who, ''))
  ON CONFLICT (order_id) DO UPDATE SET
    stage = EXCLUDED.stage, goods_back = EXCLUDED.goods_back, refunded = EXCLUDED.refunded, reason = EXCLUDED.reason,
    cancelled_by = EXCLUDED.cancelled_by, cancelled_by_name = EXCLUDED.cancelled_by_name, cancelled_at = now(),
    placed_again_at = NULL, placed_again_by_name = NULL,
    earlier = to_jsonb(c) - 'earlier' - 'id' - 'order_id';

  IF paid > 0 AND o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'Refund recorded',
      format('Order %s was cancelled. Rs %s was paid back to you by %s on %s.', o.order_no, to_char(paid, 'FM99999990.00'), refund_mode,
        to_char(refund_date, 'DD Mon YYYY')) || CASE WHEN refund_ref <> '' THEN format(' Reference: %s.', refund_ref) ELSE '' END,
      'payment');
  END IF;
  RETURN jsonb_build_object('order_no', o.order_no, 'stage', o.order_status, 'refunded', paid, 'stock_back', stock_back, 'after_dispatch', after_dispatch);
END;
$function$;

-- ---------------------------------------------------------------- 8. customer data delete

CREATE OR REPLACE FUNCTION private.customer_deletion_blockers(_customer_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'orders', orders) ORDER BY step), '[]'::jsonb)
  FROM (
    SELECT code, min(step) AS step, COALESCE(jsonb_agg(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL), '[]'::jsonb) AS orders
    FROM (
      SELECT 1 AS step, 'other_login' AS code, NULL::text AS order_no
      WHERE EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _customer_id AND role <> 'customer')
         OR EXISTS (SELECT 1 FROM public.profiles WHERE id = _customer_id AND vendor_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.channel_partners WHERE user_id = _customer_id)
         OR EXISTS (SELECT 1 FROM public.staff_employees WHERE user_id = _customer_id)
      UNION ALL
      SELECT 2, 'open_order', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status NOT IN ('Delivered', 'Cancelled', 'Payment Expired')
      UNION ALL
      SELECT 3, 'unpaid_delivery', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status = 'Delivered' AND o.payment_status NOT IN ('Paid', 'Refunded')
      UNION ALL
      SELECT 4, 'money_not_refunded', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status IN ('Cancelled', 'Payment Expired') AND o.paid_amount > 0 AND o.payment_status <> 'Refunded'
      UNION ALL
      SELECT 5, 'open_return', o.order_no FROM public.return_requests r JOIN public.orders o ON o.id = r.order_id
      WHERE r.customer_id = _customer_id AND r.status <> 'Rejected' AND (r.status <> 'Completed' OR r.refund_status IN ('Pending', 'Processing'))
      UNION ALL
      -- A UTR nobody checked in time stays open on the payments page until someone closes it: the money may be in the bank.
      -- Changed 13 Nov 2026: only while that money is not accounted for: no payment (paid, or paid back) carries the
      -- transfer and no other UTR row confirmed it. A lapsed UTR that paid its own order placed again does not block.
      SELECT 6, 'unconfirmed_payment', o.order_no FROM public.upi_payment_submissions s JOIN public.orders o ON o.id = s.order_id
      WHERE o.user_id = _customer_id
        AND (s.status = 'submitted'
          OR (s.status = 'rejected' AND s.note = 'we could not check your UTR in time'
              AND NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.status IN ('Paid', 'Refunded') AND private.same_payment_ref(p.txn_ref, s.utr))
              AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions x WHERE x.id <> s.id AND x.status = 'confirmed' AND private.same_utr(x.utr, s.utr))))
      UNION ALL
      -- Money the bank says arrived and an admin must still refund or place. Paid amount stays 0 on these.
      SELECT 7, 'open_bank_money', o.order_no FROM public.bank_credits c JOIN public.orders o ON o.user_id = _customer_id
        AND (c.order_id = o.id OR EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND private.same_utr(s.utr, c.utr)))
      WHERE c.status IN ('ambiguous', 'mismatch', 'late')
      UNION ALL
      SELECT 8, 'waiting_for_zoho', o.order_no FROM public.zoho_sync_outbox q JOIN public.orders o ON o.id::text = q.entity_id
      WHERE o.user_id = _customer_id AND q.status IN ('pending', 'processing', 'failed', 'needs_review')
      UNION ALL
      -- A worker holding this customer's job right now would finish it after the delete.
      SELECT 9, 'zoho_busy', NULL FROM public.zoho_sync_outbox q
      WHERE q.entity_type = 'customer' AND q.entity_id = _customer_id::text AND q.status = 'processing' AND q.locked_until > now()
      UNION ALL
      -- A later change to such an order would look for its Zoho contact using the phone and email this removes.
      -- Any connection counts: its status turns to 'error' after a partly failed refresh, and pushes still run.
      SELECT 10, 'not_in_zoho', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status = 'Delivered' AND o.zoho_salesorder_id IS NULL
        AND EXISTS (SELECT 1 FROM public.zoho_commerce_connection)
    ) reasons
    GROUP BY code
  ) grouped;
$function$;

-- ---------------------------------------------------------------- 6. + 10. removing a payment

CREATE OR REPLACE FUNCTION public.admin_delete_payment(_payment_id uuid, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.payments%ROWTYPE;
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  blocker text;
  who text;
  paid_now numeric;
  reopened_credits uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may remove payments'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this payment is being removed'; END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This payment no longer exists.'; END IF;
  SELECT * INTO o FROM public.orders WHERE id = p.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The order of this payment no longer exists.'; END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This payment no longer exists.'; END IF;
  blocker := public.payment_delete_blocker(_payment_id);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%', blocker; END IF;
  IF COALESCE(p.zoho_payment_id, '') <> '' OR COALESCE(p.zoho_invoice_id, '') <> '' THEN
    RAISE EXCEPTION 'This payment is in Zoho Books. Remove it from the order page, which takes it out of Zoho first.';
  END IF;

  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  DELETE FROM public.payments WHERE id = p.id;
  SELECT COALESCE(sum(amount), 0) INTO paid_now FROM public.payments WHERE order_id = o.id AND status = 'Paid';
  INSERT INTO public.deleted_payments_log (order_no, payment, order_paid_before, order_paid_after, reason, deleted_by, deleted_by_name)
    VALUES (o.order_no, to_jsonb(p), COALESCE(o.paid_amount, 0), paid_now, why, auth.uid(), COALESCE(who, ''));
  UPDATE public.orders SET paid_amount = paid_now, balance_due = GREATEST(0, total - paid_now),
    payment_status = CASE WHEN paid_now >= total AND total > 0 THEN 'Paid' WHEN paid_now > 0 THEN 'Partially Paid' ELSE 'Pending' END,
    order_status = CASE WHEN paid_now = 0 AND order_status = 'Payment Confirmed' THEN 'Placed' ELSE order_status END
    WHERE id = o.id;
  -- The transfer is free again: nothing should still say it paid for this order.
  UPDATE public.upi_payment_submissions SET status = 'rejected', note = 'payment removed by an admin', reviewed_at = now(), reviewed_by = auth.uid()
    WHERE order_id = o.id AND status = 'confirmed' AND private.same_payment_ref(utr, p.txn_ref);
  UPDATE public.bank_credits SET status = 'unmatched', order_id = NULL, order_no = NULL, note = 'Payment removed by an admin'
    WHERE order_id = o.id AND status IN ('matched', 'mismatch', 'balance') AND private.same_payment_ref(utr, p.txn_ref);
  -- Added 13 Nov 2026: a lapsed checkout's UTR that this payment had placed again is open again (refund it, or record it on
  -- the right order), unless another payment still holds that transfer. reviewed_at stays: close_lapsed_utr never set it.
  WITH reopened AS (
    UPDATE public.upi_payment_submissions SET note = 'we could not check your UTR in time'
     WHERE status = 'rejected' AND note = format('Placed again as %s', o.order_no) AND private.same_utr(utr, p.txn_ref)
       AND NOT EXISTS (SELECT 1 FROM public.payments q WHERE q.status = 'Paid' AND private.same_utr(q.txn_ref, p.txn_ref))
    RETURNING order_no, utr
  )
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT r.order_no, NULL, ur.user_id, 'admin', 'Payment needs you',
    format('UTR %s no longer pays %s (its payment was removed). It is back under Not checked in time on %s: refund it, or record it on the right order.',
      r.utr, o.order_no, r.order_no),
    'payment'
  FROM reopened r CROSS JOIN public.user_roles ur WHERE ur.role = 'admin';
  -- Added 13 Nov 2026: a bank credit without a UTR that was taken as this payment is free again.
  WITH freed AS (
    UPDATE public.bank_credits_without_reference
       SET status = 'new', order_no = NULL, suggested_order_no = NULL, decided_by = NULL, decided_at = NULL, paid_by_ref = NULL, note = NULL
     WHERE status = 'used' AND order_no = o.order_no AND paid_by_ref IS NOT NULL AND private.same_payment_ref(paid_by_ref, p.txn_ref)
    RETURNING id
  )
  SELECT array_agg(id) INTO reopened_credits FROM freed;
  IF reopened_credits IS NOT NULL THEN
    UPDATE public.orders SET bank_credit_id = NULL WHERE id = o.id AND bank_credit_id = ANY (reopened_credits);
  END IF;
  IF o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'Payment record corrected',
      format('A payment record on order %s was corrected. Amount paid is now ₹%s and ₹%s is due.', o.order_no,
        to_char(paid_now, 'FM99999990.00'), to_char(GREATEST(0, o.total - paid_now), 'FM99999990.00')), 'payment');
  END IF;
  RETURN jsonb_build_object('order_no', o.order_no, 'paid', paid_now, 'balance', GREATEST(0, o.total - paid_now));
END;
$function$;

-- ---------------------------------------------------------------- 11. cancelling while a UTR waits

CREATE OR REPLACE FUNCTION public.cancel_marketplace_order(_order_no text)
 RETURNS boolean
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
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel this order'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);
  IF NOT public.has_role(auth.uid(), 'admin')
    AND (NOT public.has_role(auth.uid(), 'customer') OR target.user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'You cannot cancel this order';
  END IF;
  IF target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN
    RAISE EXCEPTION 'Orders can only be cancelled before dispatch';
  END IF;
  IF NOT public.has_role(auth.uid(), 'admin')
    AND target.order_status NOT IN ('Placed', 'Payment Confirmed') THEN
    RAISE EXCEPTION 'Contact support to cancel an order after vendor acceptance';
  END IF;
  IF COALESCE(target.paid_amount, 0) > 0
    OR target.payment_status IN ('Paid', 'Partially Paid') THEN
    RAISE EXCEPTION 'A verified refund must be completed before cancelling a paid order';
  END IF;
  -- Added 13 Nov 2026: a UTR still being checked may be money on its way, as in admin_cancel_order. Cancelling now left it
  -- "waiting for your check" on an order that could no longer take it.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = target.id AND s.status = 'submitted') THEN
    IF public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'A UTR on this order waits for a check. Confirm or reject it on UPI & Bank Payments first.';
    END IF;
    RAISE EXCEPTION 'We are still checking the UTR you sent for this order. We will call you, or you can cancel once it is checked.';
  END IF;

  FOR line IN
    SELECT product_id, qty FROM public.order_items WHERE order_id = target.id
  LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),
        true
      ), updated_at = now()
      WHERE id = line.product_id;
  END LOOP;

  FOR allocation_row IN
    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
    FROM public.order_item_batch_allocations a
    JOIN public.order_items oi ON oi.id = a.order_item_id
    WHERE oi.order_id = target.id
      AND a.released_quantity < a.reserved_quantity
    ORDER BY a.created_at, a.id
    FOR UPDATE OF a
  LOOP
    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;
    UPDATE public.batches
      SET remaining_quantity = remaining_quantity + restore_qty,
          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END
      WHERE id = allocation_row.batch_id;
    UPDATE public.order_item_batch_allocations
      SET released_quantity = reserved_quantity
      WHERE id = allocation_row.id;
  END LOOP;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;
  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0
    WHERE id = target.id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_zoho_order_cancellation(_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
  after_dispatch boolean;
  waiting public.upi_payment_submissions%ROWTYPE;
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);

  IF target.order_status = 'Cancelled' THEN RETURN 'already_cancelled'; END IF;

  -- Money received here must be refunded first, at any stage.
  IF COALESCE(target.paid_amount, 0) > 0 OR target.payment_status IN ('Paid', 'Partially Paid') THEN
    RETURN 'blocked_paid';
  END IF;

  -- Zoho is the official book: a void there closes the order here after dispatch too.
  after_dispatch := target.order_status IN ('Dispatched', 'Out for Delivery', 'Delivered');
  IF NOT after_dispatch AND target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN
    RETURN 'blocked_after_dispatch';
  END IF;

  -- Before dispatch the goods are still in the godown: stock and batches go back, as before.
  -- After dispatch they left on the website's record, and Zoho's stock after the void reaches the godowns at the next stock read.
  IF NOT after_dispatch THEN
    FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP
      UPDATE public.catalog_products
        SET payload = jsonb_set(
          jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
          '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),
          true
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
      UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity
        WHERE id = allocation_row.id;
    END LOOP;
  END IF;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;

  -- Set only now, so the stock changes above are still queued for Zoho; the order change itself
  -- came from Zoho and is not sent back.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  PERFORM set_config('app.zoho_void', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0
    WHERE id = target.id;
  PERFORM set_config('app.zoho_void', 'off', true);
  -- Added 13 Nov 2026: Zoho's void cannot be refused, so a UTR the customer sent and nobody checked is closed as not checked
  -- in time: it goes under that list (refund it and press Refunded, or the customer sends it on a new order), the delete
  -- guard keeps it, and the admins are told. It no longer waits for a check on an order that cannot take it.
  UPDATE public.upi_payment_submissions SET status = 'rejected', note = 'we could not check your UTR in time', reviewed_at = now()
    WHERE order_id = target.id AND status = 'submitted'
    RETURNING * INTO waiting;
  IF waiting.id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT target.order_no, target.id, ur.user_id, 'admin', 'Payment needs you',
      format('Order %s was voided in Zoho while UTR %s (Rs %s) waited for a check, so it was cancelled here too. The UTR is under Not checked in time: check the bank, then refund it and press Refunded, or record it on the customer''s new order.',
        target.order_no, waiting.utr, to_char(waiting.amount, 'FM99999990.00')),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  RETURN CASE WHEN after_dispatch THEN 'cancelled_after_dispatch' ELSE 'cancelled' END;
END
$function$;

-- ---------------------------------------------------------------- 12. UTR checks

CREATE OR REPLACE FUNCTION public.admin_utr_conflicts(_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  since timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(_days, 90), 1), 366));
  found_groups jsonb;
  paused_accounts jsonb;
  recent_tries jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can see this'; END IF;
  WITH recs AS (
    SELECT 'utr_sent'::text AS source, s.order_no, s.user_id, o.customer_name AS who, o.customer_phone AS phone, s.amount,
      s.status AS state, s.submitted_at AS at, s.utr AS ref, private.utr_key(s.utr) AS key, s.note AS detail
    FROM public.upi_payment_submissions s LEFT JOIN public.orders o ON o.id = s.order_id
    WHERE s.submitted_at > since
    UNION ALL
    SELECT 'utr_replaced', s.order_no, s.user_id, o.customer_name, o.customer_phone, s.amount, 'replaced', s.submitted_at, e.ref, private.utr_key(e.ref), 'an earlier UTR for this order'
    FROM public.upi_payment_submissions s LEFT JOIN public.orders o ON o.id = s.order_id CROSS JOIN LATERAL unnest(s.earlier_utrs) AS e(ref)
    WHERE s.submitted_at > since
    UNION ALL
    SELECT 'tried', a.order_no, a.user_id, o.customer_name, o.customer_phone, a.amount, a.outcome, a.at, a.utr, a.utr_key, a.reason
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome <> 'accepted' AND a.at > since
    UNION ALL
    SELECT 'payment', o.order_no, o.user_id, o.customer_name, o.customer_phone, p.amount, p.status, p.created_at, p.txn_ref, private.utr_key(p.txn_ref), p.method
    FROM public.payments p JOIN public.orders o ON o.id = p.order_id
    WHERE p.txn_ref IS NOT NULL AND length(private.utr_form(p.txn_ref)) >= 12 AND p.created_at > since
    UNION ALL
    SELECT 'bank_sms', b.order_no, NULL, b.payer, NULL, b.amount, b.status, b.received_at, b.utr, private.utr_key(b.utr), b.sender
    FROM public.bank_credits b
    WHERE b.received_at > since
  ), grouped AS (
    SELECT key,
      count(*) AS records,
      count(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL) AS orders,
      count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS accounts,
      max(at) AS last_at,
      jsonb_agg(jsonb_build_object('source', source, 'order_no', order_no, 'user_id', user_id, 'who', who, 'phone', phone,
        'amount', amount, 'state', state, 'at', at, 'ref', ref, 'detail', detail) ORDER BY at) AS items
    FROM recs WHERE length(key) = 12
    GROUP BY key
    HAVING count(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL) >= 2 OR count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) >= 2
  ),
  -- Added 13 Nov 2026: the designed reuse of a lapsed UTR is settled on its own. One order holds the Paid payment of this
  -- transfer, every other order's UTR reads "Placed again as" that order, and it is all one account. A second account
  -- keeps the group open (the panel's fraud warning), and so does any other order.
  per_order AS (
    SELECT key, order_no,
      bool_or(source = 'payment' AND state = 'Paid') AS paid,
      max(substring(detail from '^Placed again as (.+)$')) FILTER (WHERE source = 'utr_sent' AND state = 'rejected') AS placed_again_as
    FROM recs WHERE length(key) = 12 AND order_no IS NOT NULL
    GROUP BY key, order_no
  ), paid_one AS (
    SELECT key, min(order_no) AS paid_order, count(*) AS paid_orders FROM per_order WHERE paid GROUP BY key
  ), settled AS (
    SELECT p.key, p.paid_order, string_agg(po.order_no, ', ' ORDER BY po.order_no) FILTER (WHERE po.order_no <> p.paid_order) AS lapsed
    FROM paid_one p JOIN per_order po ON po.key = p.key
    WHERE p.paid_orders = 1
    GROUP BY p.key, p.paid_order
    HAVING bool_and(po.order_no = p.paid_order OR po.placed_again_as = p.paid_order)
  ), judged AS (
    SELECT g.*, r.note AS manual_note, r.reviewed_at AS manual_at,
      (r.utr_key IS NOT NULL AND r.reviewed_at >= g.last_at) AS manual,
      (st.key IS NOT NULL AND g.accounts = 1) AS auto,
      st.paid_order, st.lapsed
    FROM grouped g LEFT JOIN public.utr_conflict_reviews r ON r.utr_key = g.key LEFT JOIN settled st ON st.key = g.key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', j.key, 'records', j.records, 'orders', j.orders, 'accounts', j.accounts, 'last_at', j.last_at,
      'severity', CASE WHEN j.accounts >= 2 THEN 'high' ELSE 'medium' END,
      'reviewed', j.manual OR j.auto,
      'auto_settled', j.auto AND NOT j.manual,
      'review_note', CASE WHEN j.auto AND NOT j.manual
        THEN format('Lapsed checkout %s placed again as %s on the same account', j.lapsed, j.paid_order) ELSE j.manual_note END,
      'reviewed_at', j.manual_at,
      'items', j.items) ORDER BY (j.manual OR j.auto), j.accounts DESC, j.last_at DESC), '[]'::jsonb)
  INTO found_groups
  FROM judged j;

  -- Accounts with refused UTRs in the last day, the most first.
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.refused DESC, x.last_at DESC), '[]'::jsonb) INTO paused_accounts FROM (
    SELECT a.user_id, max(o.customer_name) AS who, max(o.customer_phone) AS phone, count(*) AS refused,
      bool_or(a.outcome = 'blocked' AND a.at > now() - interval '1 hour') AS paused_now, max(a.at) AS last_at
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome IN ('refused', 'blocked') AND a.at > now() - interval '24 hours' AND a.user_id IS NOT NULL
    GROUP BY a.user_id HAVING count(*) >= 2
  ) x;

  -- The latest refused tries, whatever the reason.
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.at DESC), '[]'::jsonb) INTO recent_tries FROM (
    SELECT a.at, a.order_no, a.user_id, o.customer_name AS who, a.utr AS ref, a.amount, a.outcome, a.reason
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome <> 'accepted' AND a.at > now() - interval '7 days'
    ORDER BY a.at DESC LIMIT 50
  ) x;

  RETURN jsonb_build_object('groups', found_groups, 'accounts', paused_accounts, 'tries', recent_tries, 'since', since);
END;
$function$;

-- ---------------------------------------------------------------- one-off data fixes (guarded, safe to run twice)

-- 3. The one live lapsed UTR that paid its own order (placed again on 12 Nov through admin_place_ended_checkout, which
-- left the row "Not checked in time" with a Refunded button on a delivered, paid order). Only while it is still exactly
-- that: rejected with the lapse note, its order Paid, a Paid payment carrying this UTR, the UTR not refunded and not on
-- another open row. The checked time is when it was placed again (that payment). Approved by: nobody recorded who placed it
-- then; only an admin can, so when the site has exactly one admin that is who it was, otherwise it stays empty.
DO $$
DECLARE
  only_admin uuid;
BEGIN
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(user_id))[1] END INTO only_admin FROM public.user_roles WHERE role = 'admin';
  UPDATE public.upi_payment_submissions s
     SET status = 'confirmed', note = 'Paid after the checkout ended; placed again',
         reviewed_at = (SELECT min(p.created_at) FROM public.payments p
                         WHERE p.order_id = s.order_id AND p.status = 'Paid' AND private.same_payment_ref(p.txn_ref, s.utr)),
         reviewed_by = COALESCE(s.reviewed_by, only_admin)
   WHERE s.order_no = 'CLK-577522-111126-155932' AND s.utr = '578086325096'
     AND s.status = 'rejected' AND s.note = 'we could not check your UTR in time'
     AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = s.order_id AND o.payment_status = 'Paid')
     AND EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = s.order_id AND p.status = 'Paid' AND private.same_payment_ref(p.txn_ref, s.utr))
     AND NOT private.utr_is_refunded(s.utr)
     AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions x WHERE x.id <> s.id AND x.status <> 'rejected' AND x.utr = s.utr);
END $$;

-- 4. The two live seller rows of Delivered orders that a channel partner handed over (the copy above was admin-only).
-- Forward to Delivered only while the order is Delivered and the row is behind it and not cancelled.
DO $$
BEGIN
  PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
  UPDATE public.order_vendor_fulfillments f SET status = 'Delivered', updated_at = now()
    FROM public.orders o
   WHERE o.id = f.order_id AND o.order_no IN ('CLK-577522-111126-155932', 'CLK-577522-071126-164455')
     AND o.order_status = 'Delivered'
     AND f.status IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery');
  PERFORM set_config('app.syncing_vendor_fulfillments', 'off', true);
END $$;

-- 5. Backstop: an ended checkout's record whose order is no longer ended or cancelled was placed again (none live today).
UPDATE public.order_cancellations c
   SET placed_again_at = COALESCE((SELECT min(p.created_at) FROM public.payments p WHERE p.order_id = c.order_id), now())
  FROM public.orders o
 WHERE o.id = c.order_id AND c.stage = 'Awaiting Payment' AND c.placed_again_at IS NULL
   AND o.order_status NOT IN ('Cancelled', 'Payment Expired');

NOTIFY pgrst, 'reload schema';
