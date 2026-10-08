-- Serialize payout eligibility checks per vendor to prevent simultaneous
-- requests from reserving the same delivered-order balance twice.
CREATE OR REPLACE FUNCTION public.request_vendor_payout(_amount numeric, _method text DEFAULT 'NEFT')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text; v_rate numeric; eligible numeric; existing numeric; result_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN RAISE EXCEPTION 'Vendor sign-in is required'; END IF;
  SELECT vendor_id, commission_rate INTO v_id, v_rate FROM public.profiles WHERE id = auth.uid() FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  IF _amount IS NULL OR _amount <= 0 OR _method NOT IN ('NEFT','IMPS','RTGS','Bank Transfer') THEN RAISE EXCEPTION 'Enter a valid payout amount and method'; END IF;
  SELECT COALESCE(SUM(oi.line_total),0) * (1 - COALESCE(v_rate,8) / 100)
    INTO eligible FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
    WHERE o.order_status = 'Delivered' AND o.payment_status = 'Paid' AND oi.vendor_id = v_id;
  SELECT COALESCE(SUM(amount),0) INTO existing FROM public.vendor_payout_requests
    WHERE vendor_id = v_id AND status IN ('Pending','Processing','Paid');
  IF _amount > eligible - existing THEN RAISE EXCEPTION 'Amount exceeds available settled earnings'; END IF;
  INSERT INTO public.vendor_payout_requests(vendor_id, amount, method) VALUES (v_id, _amount, _method) RETURNING id INTO result_id;
  RETURN result_id;
END; $$;
REVOKE ALL ON FUNCTION public.request_vendor_payout(numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_vendor_payout(numeric, text) TO authenticated;

-- Prevent accidental double-entry if an admin submits the same UTR twice.
CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE target public.orders%ROWTYPE; applied numeric; reference text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
  reference := trim(COALESCE(_utr,''));
  IF length(reference) < 4 OR length(reference) > 120 THEN RAISE EXCEPTION 'Enter the verified UTR / transfer reference'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(reference), 0));
  IF EXISTS (SELECT 1 FROM public.payments WHERE lower(txn_ref) = lower(reference) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot receive payment'; END IF;
  IF _amount > target.total - target.paid_amount THEN RAISE EXCEPTION 'Payment amount exceeds the unpaid balance'; END IF;
  applied := target.paid_amount + _amount;
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text) TO authenticated;
