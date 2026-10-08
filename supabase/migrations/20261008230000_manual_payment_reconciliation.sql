CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target public.orders%ROWTYPE; applied numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may reconcile a manual payment';
  END IF;
  IF length(trim(COALESCE(_utr,''))) < 4 OR length(_utr) > 120 THEN
    RAISE EXCEPTION 'Enter the verified UTR / transfer reference';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot receive payment'; END IF;
  IF _amount > target.total - target.paid_amount THEN RAISE EXCEPTION 'Payment amount exceeds the unpaid balance'; END IF;
  applied := target.paid_amount + _amount;
  UPDATE public.orders SET
    paid_amount = applied,
    balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
  WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', trim(_utr));
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text) TO authenticated;
