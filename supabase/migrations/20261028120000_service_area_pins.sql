-- Service area: customers can buy only in the PIN codes an admin added to a godown.
-- Before, an address no godown listed fell back to the default godown (a Bengaluru customer could
-- order from Challakere). start_paid_checkout (the only way a customer creates an order) now
-- refuses a PIN that no active godown serves while PIN matching (branch routing) is on. The
-- website shows those customers "not in your area yet" with ways to request the service or to
-- become the channel partner there (contact enquiries).
--
-- Same function as 20261027180000_pay_before_order.sql plus the PIN check.

CREATE OR REPLACE FUNCTION public.start_paid_checkout(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  cfg jsonb;
  result jsonb;
  window_minutes integer;
  hold_until timestamptz;
  placed public.orders%ROWTYPE;
  order_pin text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in is required to place an order'; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
  IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
    RAISE EXCEPTION 'Online payment is being set up. Please call or WhatsApp us to order.';
  END IF;
  -- The PIN comes from the customer's saved address (never from the browser), and the order is
  -- routed by that same PIN.
  SELECT a.pin INTO order_pin FROM public.addresses a
    WHERE a.id::text = _shipping_address->>'id' AND a.user_id = _target_user_id;
  order_pin := regexp_replace(COALESCE(order_pin, _shipping_address->>'pin', ''), '[^0-9]', '', 'g');
  _shipping_address := jsonb_set(COALESCE(_shipping_address, '{}'::jsonb), '{pin}', to_jsonb(order_pin), true);
  -- Only the PIN codes an admin added to an active godown can buy (with PIN matching on): no
  -- falling back to the default godown for an address it does not serve.
  IF COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false)
     AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.active AND b.vendor_id IS NULL AND order_pin = ANY (b.serves_pincodes)) THEN
    RAISE EXCEPTION 'We do not deliver to PIN % yet. Request service in your area or become our channel partner there.', COALESCE(NULLIF(order_pin, ''), '(none)');
  END IF;
  PERFORM public.expire_payment_holds();
  IF (SELECT count(*) FROM public.orders WHERE user_id = _target_user_id AND order_status = 'Awaiting Payment') >= 3 THEN
    RAISE EXCEPTION 'You have 3 unpaid orders waiting. Pay or cancel them first.';
  END IF;
  window_minutes := LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)));

  PERFORM set_config('app.pay_first', 'on', true);
  result := public.place_marketplace_order_with_coupon(_order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address, _shipping_method, 'UPI', _items, _coupon);

  PERFORM set_config('app.payment_workflow', 'on', true);
  SELECT * INTO placed FROM public.orders WHERE order_no = result->>'order_no' FOR UPDATE;
  IF placed.total <= 0 THEN
    -- Fully covered by a coupon: nothing to pay, so it is an order at once.
    PERFORM set_config('app.pay_first', 'off', true);
    UPDATE public.orders SET order_status = 'Awaiting Payment' WHERE id = placed.id;
    UPDATE public.orders SET order_status = 'Payment Confirmed', payment_status = 'Paid', balance_due = 0 WHERE id = placed.id;
    PERFORM set_config('app.payment_workflow', 'off', true);
    RETURN result || jsonb_build_object('order_status', 'Payment Confirmed', 'hold_until', NULL);
  END IF;
  hold_until := now() + make_interval(mins => window_minutes);
  UPDATE public.orders SET order_status = 'Awaiting Payment', payment_method = 'UPI', payment_hold_until = hold_until
    WHERE id = placed.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  PERFORM set_config('app.pay_first', 'off', true);
  RETURN result || jsonb_build_object('order_status', 'Awaiting Payment', 'hold_until', hold_until, 'total', placed.total);
END;
$function$;
REVOKE ALL ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
