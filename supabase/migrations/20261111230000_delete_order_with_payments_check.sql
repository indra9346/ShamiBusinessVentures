-- 11 Nov 2026, the owner on Admin > Payments & Matching (ORD-26102686593, a test order with 3 typed-in payments):
-- "No delete option ... make and work with sense ... need delete option".
--
-- One Delete for any order, which asks first whether the money recorded on it was really received:
--   - no (a test, or typed by mistake): its payments are removed (each kept in deleted_payments_log, and taken out of
--     Zoho Books first if it was sent there), the order is cancelled with a reason (asking whether goods came back after
--     dispatch), then it is deleted with all its details (a full copy in deleted_orders_log);
--   - yes, and it was paid back: the refund is recorded with Cancel and refund, then it can be deleted;
--   - yes, and kept: it is a real sale and stays.
-- This function says what that Delete would do, and what stops it whatever the answer. The steps themselves are the
-- existing deleteOrderPayment / admin_delete_payment, admin_cancel_order and admin_delete_order_all_details, each with
-- its own checks.

CREATE OR REPLACE FUNCTION public.order_delete_with_payments_check(_order_no text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  o public.orders%ROWTYPE;
  blocker text;
  paid_rows numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND THEN RETURN jsonb_build_object('blocker', 'This order no longer exists.'); END IF;
  SELECT COALESCE(sum(amount), 0) INTO paid_rows FROM public.payments WHERE order_id = o.id AND status = 'Paid';

  -- What keeps the order whatever is said about the money.
  IF o.order_status = 'Awaiting Payment' THEN
    blocker := 'This checkout is still waiting for payment. End it first (End checkout), then delete it.';
  ELSIF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
    blocker := 'A UTR on this order waits for a check. Confirm or reject it on UPI & Bank Payments first.';
  ELSIF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.order_id = o.id) OR EXISTS (SELECT 1 FROM public.delivery_stops d WHERE d.order_id = o.id) THEN
    blocker := 'A delivery note was issued for this order, so it stays. It can still be cancelled.';
  ELSIF EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id AND private.commission_settled(c.order_item_id) <> 0) THEN
    blocker := 'A partner payout covers this order. Undo that payout first.';
  ELSIF EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = o.id) THEN
    blocker := 'This order has a return, so it stays.';
  ELSIF EXISTS (SELECT 1 FROM public.zoho_order_push_claims z WHERE z.order_id = o.id
      AND ((z.locked_until IS NOT NULL AND z.locked_until > now()) OR z.write_unanswered_at > now() - interval '10 minutes')) THEN
    blocker := 'A push to Zoho for this order is running or got no clear answer. Wait 10 minutes, then try again.';
  END IF;

  RETURN jsonb_build_object(
    'blocker', blocker,
    'status', o.order_status,
    'payment_status', o.payment_status,
    'total', o.total,
    'paid', paid_rows,
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'method', COALESCE(p.method, ''), 'reference', COALESCE(p.txn_ref, ''),
        'in_zoho', COALESCE(p.zoho_payment_id, '') <> '' OR COALESCE(p.zoho_invoice_id, '') <> '') ORDER BY p.created_at)
      FROM public.payments p WHERE p.order_id = o.id AND p.status = 'Paid'), '[]'::jsonb),
    -- Money on the order with no payment record behind it cannot be removed as a mistake, only refunded.
    'paid_without_record', GREATEST(0, COALESCE(o.paid_amount, 0) - paid_rows),
    -- The bank said this money came in: it is real, so only a refund closes it.
    'bank_alert', EXISTS (SELECT 1 FROM public.bank_credits c WHERE c.order_id = o.id AND c.status <> 'settled'),
    'confirmed_utr', (SELECT s.utr FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'confirmed' LIMIT 1),
    'needs_cancel', o.order_status NOT IN ('Cancelled', 'Payment Expired'),
    'after_dispatch', o.order_status IN ('Dispatched', 'Out for Delivery', 'Delivered')
      OR EXISTS (SELECT 1 FROM public.order_vendor_fulfillments f WHERE f.order_id = o.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')),
    'zoho_alive', COALESCE(o.zoho_salesorder_id, '') <> '' AND COALESCE(o.zoho_order_status, '') NOT IN ('void', 'cancelled')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.order_delete_with_payments_check(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_delete_with_payments_check(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
