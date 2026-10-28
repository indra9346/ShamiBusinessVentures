-- Company details on the invoice, the way the client's own store asks for them.
--
-- "I want to include my company name and GST details in the invoice": the company name is required,
-- the GSTIN optional. With a GSTIN the buyer is a registered business (Zoho "business_gst", GSTIN,
-- place of supply); with only a company name an unregistered business (Zoho "business_none"). Either
-- way the company name is stored on the order (business_legal_name) and on the customer's profile
-- (company), which is the name their Zoho contact - and so the Books invoice - is billed to. A
-- personal purchase (box not ticked) clears the profile's company and GSTIN, so that invoice is in
-- the person's name.
--
-- Same function as 20261028150000_b2b_gstin_invoice.sql with the GSTIN made optional.

CREATE OR REPLACE FUNCTION public.start_paid_checkout(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text,
  _is_b2b boolean DEFAULT NULL, _business_gstin text DEFAULT NULL, _business_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  cfg jsonb;
  result jsonb;
  window_minutes integer;
  hold_until timestamptz;
  placed public.orders%ROWTYPE;
  order_pin text;
  address_state text;
  b2b_gstin text := upper(regexp_replace(COALESCE(_business_gstin, ''), '[[:space:]]', '', 'g'));
  b2b_name text := btrim(COALESCE(_business_name, ''));
  state_code text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in is required to place an order'; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
  IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
    RAISE EXCEPTION 'Online payment is being set up. Please call or WhatsApp us to order.';
  END IF;
  -- The PIN comes from the customer's saved address (never from the browser), and the order is
  -- routed by that same PIN.
  SELECT a.pin, a.state INTO order_pin, address_state FROM public.addresses a
    WHERE a.id::text = _shipping_address->>'id' AND a.user_id = _target_user_id;
  order_pin := regexp_replace(COALESCE(order_pin, _shipping_address->>'pin', ''), '[^0-9]', '', 'g');
  _shipping_address := jsonb_set(COALESCE(_shipping_address, '{}'::jsonb), '{pin}', to_jsonb(order_pin), true);
  -- Only the PIN codes an admin added to an active godown can buy (with PIN matching on): no
  -- falling back to the default godown for an address it does not serve.
  IF COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false)
     AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.active AND b.vendor_id IS NULL AND order_pin = ANY (b.serves_pincodes)) THEN
    RAISE EXCEPTION 'We do not deliver to PIN % yet. Request service in your area or become our channel partner there.', COALESCE(NULLIF(order_pin, ''), '(none)');
  END IF;
  -- Company details on the invoice: the company name is required; the GSTIN is optional, but when
  -- given it must be valid and its state (first two digits) must be the address's state.
  IF _is_b2b IS TRUE THEN
    IF length(b2b_name) < 2 THEN RAISE EXCEPTION 'Enter your company name for the invoice'; END IF;
    IF b2b_gstin <> '' AND length(b2b_gstin) <> 15 THEN RAISE EXCEPTION 'A GSTIN has 15 characters'; END IF;
    IF b2b_gstin <> '' AND b2b_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
      RAISE EXCEPTION 'This is not a valid GSTIN (for example 29ABCDE1234F1Z5)';
    END IF;
    state_code := private.gst_state_code(address_state);
    IF b2b_gstin <> '' AND state_code IS NOT NULL AND left(b2b_gstin, 2) <> state_code THEN
      RAISE EXCEPTION 'This GSTIN is registered in state code %, but the address is in % (%). Use an address in the GSTIN''s state.',
        left(b2b_gstin, 2), address_state, state_code;
    END IF;
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
  IF _is_b2b IS TRUE THEN
    UPDATE public.orders SET customer_gstin = NULLIF(b2b_gstin, ''), business_legal_name = b2b_name, is_b2b = true WHERE id = placed.id;
    -- The customer's Zoho contact (whose name Books bills to) takes the company name, and the GSTIN
    -- when given: registered business with a GSTIN, unregistered business without.
    UPDATE public.profiles SET gstin = NULLIF(b2b_gstin, ''), company = b2b_name WHERE id = _target_user_id;
  ELSIF _is_b2b IS FALSE THEN
    UPDATE public.orders SET customer_gstin = NULL, business_legal_name = NULL, is_b2b = false WHERE id = placed.id;
    -- A personal purchase: the contact goes back to the person, so this invoice is in their name.
    UPDATE public.profiles SET gstin = NULL, company = NULL WHERE id = _target_user_id AND (gstin IS NOT NULL OR company IS NOT NULL);
  ELSE
    UPDATE public.orders SET is_b2b = COALESCE(customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', false) WHERE id = placed.id;
  END IF;
  SELECT * INTO placed FROM public.orders WHERE id = placed.id;
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
REVOKE ALL ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text, boolean, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
