-- 12 Nov 2026, the owner (with his three answers, all the recommended way):
--   "for orders without payment give an option to update payment if he has done offline ... update UTR No, give this
--    option to update UTR No for channel partner also in their login but only admin approves the payment details by
--    checking bank acc statement or give option to admin to upload bank statement and read UTR numbers and auto match".
--
--  1. submit_utr_for_order: a UTR for a checkout still waiting for payment, or for one that ended without payment within
--     the last 15 days ("paid after the time ran out"), from the customer, the channel partner of the order's godown, or
--     an admin. It waits in Payment to check; nothing is confirmed by sending it. The customer on a waiting checkout keeps
--     today's path (submit_upi_utr), unchanged.
--  2. admin_place_ended_checkout: the admin found the money in the bank for a checkout that ended without payment. Its
--     stock is taken again at its godown (refused when there is not enough), and the payment is recorded through
--     admin_confirm_manual_payment, the same step as Confirm paid, with all its UTR checks. The order is then placed.
--  3. partner_payment_checkouts: what a channel partner sees of their own godown's checkouts, to send a UTR for.
--  The bank statement is read and matched in the browser; every match is confirmed by an admin through 1 and 2 or the
--  existing Confirm paid, so the statement itself never confirms anything.

-- ---------------------------------------------------------------- who sent a UTR, and whether it came late

ALTER TABLE public.upi_payment_submissions ADD COLUMN IF NOT EXISTS late boolean NOT NULL DEFAULT false;
ALTER TABLE public.upi_payment_submissions ADD COLUMN IF NOT EXISTS sent_by uuid;
ALTER TABLE public.upi_payment_submissions ADD COLUMN IF NOT EXISTS sent_by_role text NOT NULL DEFAULT 'customer';
DO $$ BEGIN
  ALTER TABLE public.upi_payment_submissions ADD CONSTRAINT upi_payment_submissions_sent_by_role_check CHECK (sent_by_role IN ('customer', 'partner', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- the order guard lets a found payment place an ended checkout

CREATE OR REPLACE FUNCTION public.guard_order_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE required_advance numeric(14,2);
BEGIN
  -- The trusted server (service role) may record Zoho bookkeeping on any order, and nothing else.
  IF current_user = 'service_role'
    AND (to_jsonb(NEW) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at']) THEN
    RETURN NEW;
  END IF;

  IF OLD.order_status = 'Cancelled' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened';
  END IF;
  -- Changed 12 Nov 2026: admin_place_ended_checkout (flag app.revive_checkout) takes a checkout that ended without payment
  -- back to Awaiting Payment for a moment, when the admin has found its payment in the bank; it is paid in the same step.
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (current_setting('app.revive_checkout', true) = 'on' AND NEW.order_status = 'Awaiting Payment') THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  -- Changed 11 Nov 2026: so may an admin, through admin_cancel_order (flag app.admin_cancel), saying whether the goods came back.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on'
    AND current_setting('app.admin_cancel', true) IS DISTINCT FROM 'on' AND EXISTS (
    SELECT 1 FROM public.order_vendor_fulfillments f
    WHERE f.order_id = OLD.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Orders cannot be cancelled after any vendor has dispatched';
  END IF;
  -- A held (unpaid) request leaves "Awaiting Payment" only by being paid in full or expiring.
  IF OLD.order_status = 'Awaiting Payment' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (NEW.order_status = 'Payment Confirmed' AND NEW.payment_status = 'Paid')
    AND NOT (NEW.order_status IN ('Payment Expired', 'Cancelled')) THEN
    RAISE EXCEPTION 'Confirm the full payment before this order moves on';
  END IF;
  IF NEW.order_status = 'Payment Expired' AND OLD.order_status <> 'Payment Expired'
    AND current_setting('app.payment_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected payment workflow';
  END IF;

  -- Added 10 Nov 2026 (20261110120000_delivery_paper_qr.sql): every item on the order's delivery note was handed over
  -- at the godown on a QR scan, so delivery_paper_scan marks it Delivered. Only the status may change.
  IF current_setting('app.delivery_handover', true) = 'on'
    AND NEW.order_status = 'Delivered'
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- The pay-first functions (hold, auto-confirm from the bank alert, expiry) check everything themselves.
  IF current_setting('app.payment_workflow', true) = 'on' THEN RETURN NEW; END IF;

  -- Changes applied from Zoho by the SECURITY DEFINER Zoho functions below (shipment milestones,
  -- Zoho cancellations). The cancellation checks above still apply to them.
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;

  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;

  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable']) THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND NEW.order_status = 'Cancelled'
    AND EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    ) THEN
    RAISE EXCEPTION 'Customer cancellation is unavailable after a vendor has started fulfilment';
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed')
    AND NEW.order_status = 'Cancelled'
    AND COALESCE(OLD.paid_amount, 0) = 0
    AND OLD.payment_status NOT IN ('Paid', 'Partially Paid')
    AND NEW.advance_due = 0
    AND NEW.balance_due = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    )
    AND (to_jsonb(NEW) - ARRAY['order_status','advance_due','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','advance_due','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;

  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids) THEN
    required_advance := round(OLD.total * COALESCE((
      SELECT NULLIF(value->>'advance_percent', '')::numeric
      FROM public.settings WHERE key = 'order'
    ), 30) / 100, 2);
    IF OLD.order_status = 'Payment Confirmed' AND NEW.order_status = 'Accepted'
      AND OLD.paid_amount >= required_advance THEN
      RETURN NEW;
    END IF;
    IF (OLD.order_status = 'Accepted' AND NEW.order_status = 'Packed')
      OR (OLD.order_status = 'Packed' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Dispatched')
      OR (OLD.order_status = 'Dispatched' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Out for Delivery')
      OR (OLD.order_status = 'Out for Delivery' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Delivered') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Vendor order updates must follow the next allowed step, meet the required advance, and be fully paid before dispatch';
END
$function$;

-- ---------------------------------------------------------------- 1. send a UTR

CREATE OR REPLACE FUNCTION public.submit_utr_for_order(_order_no text, _utr text, _method text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  me uuid := auth.uid();
  o public.orders%ROWTYPE;
  who text;
  partner_name text;
  late boolean;
  method text;
  by_bank boolean;
  ref text;
  existing public.upi_payment_submissions%ROWTYPE;
  has_existing boolean;
  due numeric;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Sign in to send the payment details'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  who := CASE WHEN public.has_role(me, 'admin') THEN 'admin'
              WHEN o.user_id = me THEN 'customer'
              WHEN o.branch_id IS NOT NULL AND o.branch_id = public.current_partner_branch() THEN 'partner' END;
  IF who IS NULL THEN RAISE EXCEPTION 'This is not your order'; END IF;

  IF o.order_status = 'Awaiting Payment' THEN
    -- The customer's own checkout keeps exactly today's path (bank alert matching, hold rules).
    IF who = 'customer' THEN RETURN to_jsonb(public.submit_upi_utr(o.order_no, _utr)) || jsonb_build_object('late', false); END IF;
    late := false;
  ELSIF o.order_status = 'Payment Expired' THEN
    late := true;
    IF o.updated_at < now() - interval '15 days' THEN
      RAISE EXCEPTION 'This checkout ended more than 15 days ago. Please call us with the UTR.';
    END IF;
  ELSE
    RAISE EXCEPTION 'This order is not waiting for a payment.';
  END IF;

  SELECT * INTO existing FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  has_existing := FOUND;
  IF has_existing AND existing.status = 'confirmed' THEN RAISE EXCEPTION 'This order''s payment is already confirmed'; END IF;
  IF has_existing AND existing.note = 'refunded by our team' THEN RAISE EXCEPTION 'The payment for this checkout was refunded. Please pay again on a new order.'; END IF;
  IF has_existing AND COALESCE(existing.note, '') LIKE 'Placed again as %' THEN
    RAISE EXCEPTION 'The payment for this checkout already went to %.', substring(existing.note from 'Placed again as (.*)$');
  END IF;

  method := upper(btrim(COALESCE(NULLIF(_method, ''), o.payment_method, 'UPI')));
  IF method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS') THEN RAISE EXCEPTION 'Choose how it was paid: UPI, NEFT, RTGS or IMPS'; END IF;
  by_bank := method <> 'UPI';
  ref := upper(regexp_replace(COALESCE(_utr, ''), '\s', '', 'g'));
  IF by_bank THEN
    IF ref !~ '^[0-9A-Z]{12,22}$' THEN RAISE EXCEPTION 'Enter the UTR from the bank: 12 to 22 letters and numbers'; END IF;
  ELSIF ref !~ '^[0-9]{12}$' THEN
    RAISE EXCEPTION 'The UTR has 12 digits';
  END IF;

  -- Once only, however the same transfer is written (the same lock as submit_upi_utr).
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || right(private.utr_form(ref), 12), 0));
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, ref) AND status <> 'rejected' AND order_id <> o.id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, ref) AND status = 'Paid')
     OR EXISTS (SELECT 1 FROM public.bank_credits WHERE private.same_utr(utr, ref) AND status IN ('matched', 'settled') AND order_id IS DISTINCT FROM o.id) THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  IF has_existing AND existing.status = 'submitted' THEN
    IF private.same_utr(existing.utr, ref) THEN RETURN to_jsonb(existing) || jsonb_build_object('late', existing.late); END IF;
    RAISE EXCEPTION 'We are already checking UTR % for this order. If it was wrong, call us.', existing.utr;
  END IF;

  due := o.total - COALESCE(o.paid_amount, 0);
  IF who = 'partner' THEN SELECT name INTO partner_name FROM public.channel_partners WHERE user_id = me AND status = 'active'; END IF;
  -- A refunded transfer is refused by the trigger on this table (refunded_transfers).
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, late, sent_by, sent_by_role)
  VALUES (o.id, o.order_no, o.user_id, left(COALESCE(o.customer_name, ''), 60), due, ref, 'submitted',
    CASE WHEN late THEN 'paid after the checkout ended' END, now(), late, me, who)
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'submitted', note = EXCLUDED.note,
    submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL, late = EXCLUDED.late, sent_by = EXCLUDED.sent_by, sent_by_role = EXCLUDED.sent_by_role;
  IF method <> COALESCE(o.payment_method, '') AND late THEN
    -- How it was really paid, for the payment record when it is confirmed. A waiting checkout keeps its own method.
    PERFORM set_config('app.payment_workflow', 'on', true);
    UPDATE public.orders SET payment_method = method WHERE id = o.id;
    PERFORM set_config('app.payment_workflow', 'off', true);
  END IF;

  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', CASE WHEN late THEN 'Late payment to check' ELSE 'UTR sent by partner' END,
    format('%s UTR %s for %s (Rs %s)%s. Check the bank, then confirm in Admin > UPI & Bank Payments.%s', method, ref, o.order_no,
      to_char(due, 'FM99999990.00'), CASE WHEN who = 'partner' THEN format(', sent by channel partner %s', COALESCE(partner_name, '')) ELSE '' END,
      CASE WHEN late THEN ' It came after the checkout ended: confirming places the order again if the stock is there.' ELSE '' END),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  IF who <> 'customer' AND o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'Payment being checked',
      format('UTR %s for %s was sent to us. We check it with our bank and tell you when the order is placed.', ref, o.order_no), 'payment');
  END IF;
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'status', 'submitted', 'late', late, 'sent_by_role', who);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_utr_for_order(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_utr_for_order(text, text, text) TO authenticated;

-- ---------------------------------------------------------------- 2. the admin places an ended checkout whose money came

CREATE OR REPLACE FUNCTION public.admin_place_ended_checkout(_order_no text, _utr text DEFAULT NULL, _method text DEFAULT NULL, _checked_against text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  UPDATE public.upi_payment_submissions
    SET note = left(format('Paid after the checkout ended; placed again%s', CASE WHEN btrim(COALESCE(_checked_against, '')) <> '' THEN '. ' || btrim(_checked_against) ELSE '' END), 200)
    WHERE order_id = o.id AND status = 'confirmed';
  -- The customer hears "Order placed" from the order's own status change (notify_order_participants), as for any paid order.
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'amount', due, 'status', 'Payment Confirmed');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_place_ended_checkout(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_place_ended_checkout(text, text, text, text) TO authenticated;

-- ---------------------------------------------------------------- 3. what a channel partner sees, to send a UTR for

CREATE OR REPLACE FUNCTION public.partner_payment_checkouts()
RETURNS TABLE (order_no text, status text, total numeric, method text, placed_at timestamptz, hold_until timestamptz,
  customer text, items text, utr text, utr_status text, utr_late boolean, utr_sent_by text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE branch text := public.current_partner_branch();
BEGIN
  IF auth.uid() IS NULL OR branch IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can see this'; END IF;
  RETURN QUERY
  SELECT o.order_no, o.order_status, o.total, COALESCE(o.payment_method, 'UPI'), o.created_at, o.payment_hold_until,
    left(COALESCE(NULLIF(btrim(o.customer_name), ''), 'Customer'), 60),
    (SELECT string_agg(i.product_name || ' × ' || to_char(i.qty, 'FM99999990.##'), ', ') FROM public.order_items i WHERE i.order_id = o.id),
    s.utr, s.status, COALESCE(s.late, false), s.sent_by_role
  FROM public.orders o
  LEFT JOIN public.upi_payment_submissions s ON s.order_id = o.id
  WHERE o.branch_id = branch
    AND (o.order_status = 'Awaiting Payment' OR (o.order_status = 'Payment Expired' AND o.updated_at > now() - interval '15 days'))
    AND COALESCE(s.note, '') <> 'refunded by our team' AND COALESCE(s.note, '') NOT LIKE 'Placed again as %'
  ORDER BY o.created_at DESC
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_payment_checkouts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_payment_checkouts() TO authenticated;

NOTIFY pgrst, 'reload schema';
