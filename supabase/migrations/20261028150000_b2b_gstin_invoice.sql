-- Business (B2B) purchases with a GSTIN, and invoice details.
--
-- Checkout can say "Buying for a business": the buyer's GSTIN and legal business name. The database
-- checks the GSTIN format, that a legal name is given, and that the GSTIN's state (first two digits)
-- is the state of the customer's saved address, then stores them on the order (customer_gstin,
-- business_legal_name, is_b2b) and on the customer's profile (gstin, company), so their Zoho contact,
-- sales order and Books invoice are "Registered Business - Regular" with that GSTIN and place of
-- supply, ready for the IRP (e-invoice IRN + QR). Without it the order is B2C (consumer).
--
-- Invoices: each godown's invoice shows its channel partner's mobile (godown_contact_phones), and
-- the company email on invoices becomes headoffice@shamibusiness.com.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS business_legal_name text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_b2b boolean NOT NULL DEFAULT false;
UPDATE public.orders SET is_b2b = true
  WHERE NOT is_b2b AND customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';

CREATE SCHEMA IF NOT EXISTS private;
/** GST state code of a state name ("Karnataka" -> "29"); null when unknown. */
CREATE OR REPLACE FUNCTION private.gst_state_code(_state text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT code FROM (VALUES
    ('jammu and kashmir','01'),('himachal pradesh','02'),('punjab','03'),('chandigarh','04'),('uttarakhand','05'),
    ('haryana','06'),('delhi','07'),('rajasthan','08'),('uttar pradesh','09'),('bihar','10'),('sikkim','11'),
    ('arunachal pradesh','12'),('nagaland','13'),('manipur','14'),('mizoram','15'),('tripura','16'),('meghalaya','17'),
    ('assam','18'),('west bengal','19'),('jharkhand','20'),('odisha','21'),('chhattisgarh','22'),('madhya pradesh','23'),
    ('gujarat','24'),('dadra and nagar haveli and daman and diu','26'),('maharashtra','27'),('karnataka','29'),('goa','30'),
    ('lakshadweep','31'),('kerala','32'),('tamil nadu','33'),('puducherry','34'),('andaman and nicobar islands','35'),
    ('telangana','36'),('andhra pradesh','37'),('ladakh','38')
  ) AS s(name, code)
  WHERE name = regexp_replace(replace(lower(btrim(COALESCE(_state, ''))), '&', 'and'), '[[:space:]]+', ' ', 'g')
$function$;

-- ---------------------------------------------------------------- checkout with optional business details
DROP FUNCTION IF EXISTS public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text);
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
  -- Buying for a business: a valid GSTIN, its legal name, and the GSTIN's state = the address's state.
  IF _is_b2b IS TRUE THEN
    IF b2b_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
      RAISE EXCEPTION 'This is not a valid GSTIN (for example 29ABCDE1234F1Z5)';
    END IF;
    IF length(b2b_name) < 2 THEN RAISE EXCEPTION 'Enter the legal business name registered with this GSTIN'; END IF;
    state_code := private.gst_state_code(address_state);
    IF state_code IS NOT NULL AND left(b2b_gstin, 2) <> state_code THEN
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
    UPDATE public.orders SET customer_gstin = b2b_gstin, business_legal_name = b2b_name, is_b2b = true WHERE id = placed.id;
    -- The customer's Zoho contact becomes a registered business with this GSTIN and legal name.
    UPDATE public.profiles SET gstin = b2b_gstin, company = b2b_name WHERE id = _target_user_id;
  ELSIF _is_b2b IS FALSE THEN
    UPDATE public.orders SET customer_gstin = NULL, business_legal_name = NULL, is_b2b = false WHERE id = placed.id;
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

-- ---------------------------------------------------------------- invoices
/** Each godown's contact mobile for its invoices: the active channel partner's, else the godown's own. */
CREATE OR REPLACE FUNCTION public.godown_contact_phones()
RETURNS TABLE(branch_id text, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT b.id, COALESCE(NULLIF(btrim(p.phone), ''), NULLIF(btrim(b.phone), ''))
  FROM public.branches b
  LEFT JOIN public.channel_partners p ON p.branch_id = b.id AND p.status = 'active'
  WHERE b.active
$function$;
REVOKE ALL ON FUNCTION public.godown_contact_phones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.godown_contact_phones() TO anon, authenticated;

UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{email}', '"headoffice@shamibusiness.com"', true), updated_at = now()
  WHERE key = 'company';

NOTIFY pgrst, 'reload schema';
