-- Outside-vendor marketplace switch (Admin > Vendors). While OFF, the database refuses vendor
-- applications and every vendor catalogue / stock / order action; Grain Bazar (the owner)
-- runs the catalogue from the admin panel. Turning it ON needs no code change.
CREATE OR REPLACE FUNCTION private.marketplace_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT (value->>'marketplace_vendors')::boolean FROM public.settings WHERE key = 'platform_features'), false)
$$;
GRANT EXECUTE ON FUNCTION private.marketplace_enabled() TO anon, authenticated;


CREATE OR REPLACE FUNCTION public.customer_submit_vendor_application(_business_name text, _owner_name text, _phone text, _gstin text, _city text, _address text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE current_profile public.profiles%ROWTYPE; app_id uuid;
BEGIN
  IF NOT private.marketplace_enabled() THEN
    RAISE EXCEPTION 'The Grain Bazar vendor marketplace is not open yet';
  END IF;
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') OR public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Sign in with a customer account to request vendor access';
  END IF;
  SELECT * INTO current_profile FROM public.profiles WHERE id = auth.uid();
  IF current_profile.id IS NULL THEN RAISE EXCEPTION 'Your account profile could not be found'; END IF;
  IF position('@' IN current_profile.email) < 2 THEN RAISE EXCEPTION 'A verified email account is required for vendor access'; END IF;
  IF length(trim(COALESCE(_business_name, ''))) < 2 OR length(trim(COALESCE(_owner_name, ''))) < 2
    OR length(regexp_replace(COALESCE(_phone, ''), '[^0-9]', '', 'g')) < 10
    OR length(trim(COALESCE(_city, ''))) < 2 OR length(trim(COALESCE(_address, ''))) < 8 THEN
    RAISE EXCEPTION 'Complete the required business, owner, phone, city and address fields';
  END IF;
  -- GSTIN is optional, but when given it must be a real 15-character Indian GSTIN.
  IF NULLIF(trim(COALESCE(_gstin, '')), '') IS NOT NULL
    AND upper(trim(_gstin)) !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
    RAISE EXCEPTION 'Enter a valid 15-character GSTIN (for example 29ABCDE1234F1Z5), or leave it blank';
  END IF;
  INSERT INTO public.vendor_applications (applicant_id, business_name, owner_name, email, phone, gstin, city, address)
  VALUES (auth.uid(), trim(_business_name), trim(_owner_name), current_profile.email, trim(_phone), upper(trim(COALESCE(_gstin, ''))), trim(_city), trim(_address))
  ON CONFLICT (applicant_id) DO UPDATE SET
    business_name = EXCLUDED.business_name, owner_name = EXCLUDED.owner_name, phone = EXCLUDED.phone,
    gstin = EXCLUDED.gstin, city = EXCLUDED.city, address = EXCLUDED.address,
    status = 'Pending', admin_notes = NULL, reviewed_at = NULL, reviewed_by = NULL, vendor_id = NULL
  WHERE public.vendor_applications.status = 'Rejected'
  RETURNING id INTO app_id;
  IF app_id IS NULL THEN RAISE EXCEPTION 'You already have an application under review or approved'; END IF;
  RETURN app_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.vendor_set_product_stock(_product_id text, _stock integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id text;
BEGIN
  IF NOT private.marketplace_enabled() THEN
    RAISE EXCEPTION 'The Grain Bazar vendor marketplace is not open yet';
  END IF;
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Vendor sign-in is required';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN
    RAISE EXCEPTION 'Enter a valid stock quantity';
  END IF;
  v_id := public.current_vendor_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  UPDATE public.catalog_products
     SET payload = jsonb_set(payload, '{stock}', to_jsonb(_stock), true)
           || jsonb_build_object('updated', to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')),
         updated_at = now()
   WHERE id = _product_id AND vendor_id = v_id;
  RETURN FOUND;
END $function$;

CREATE OR REPLACE FUNCTION public.vendor_set_product_active(_product_id text, _active boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id text; target public.catalog_products%ROWTYPE;
BEGIN
  IF NOT private.marketplace_enabled() THEN
    RAISE EXCEPTION 'The Grain Bazar vendor marketplace is not open yet';
  END IF;
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Vendor sign-in is required';
  END IF;
  v_id := public.current_vendor_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  SELECT * INTO target FROM public.catalog_products WHERE id = _product_id AND vendor_id = v_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF target.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved products can be paused or resumed here; edit and resubmit other products';
  END IF;
  IF _active AND target.active THEN RETURN true; END IF;
  IF _active AND COALESCE((target.payload->>'pausedByVendor')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'This product was switched off by an administrator; ask them to switch it back on';
  END IF;
  UPDATE public.catalog_products
     SET active = _active,
         payload = CASE WHEN _active THEN payload - 'pausedByVendor'
                        ELSE payload || '{"pausedByVendor": true}'::jsonb END,
         updated_at = now()
   WHERE id = target.id;
  RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION public.vendor_update_order_fulfillment(_order_no text, _status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  current_status text;
  vendor text;
  vendor_name text;
  required_advance numeric(14,2);
  valid_transition boolean := false;
BEGIN
  IF NOT private.marketplace_enabled() THEN
    RAISE EXCEPTION 'The Grain Bazar vendor marketplace is not open yet';
  END IF;
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Only an authenticated vendor can update this fulfillment';
  END IF;
  vendor := public.current_vendor_id();
  IF NULLIF(trim(vendor), '') IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  IF NOT private.vendor_account_is_active(vendor) THEN RAISE EXCEPTION 'Your vendor account is not active'; END IF;
  SELECT COALESCE(NULLIF(company, ''), NULLIF(full_name, ''), 'Vendor') INTO vendor_name
    FROM public.profiles WHERE vendor_id = vendor LIMIT 1;
  IF _status NOT IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION 'Unsupported vendor fulfillment status';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND OR NOT (vendor = ANY(target.vendor_ids)) THEN RAISE EXCEPTION 'Order not found for this vendor'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot be fulfilled'; END IF;
  SELECT f.status INTO current_status FROM public.order_vendor_fulfillments f
    WHERE f.order_id = target.id AND f.vendor_id = vendor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order has no fulfillment for your vendor'; END IF;

  required_advance := round(target.total * COALESCE((
    SELECT NULLIF(value->>'advance_percent', '')::numeric
    FROM public.settings WHERE key = 'order'
  ), 30) / 100, 2);
  valid_transition :=
    (current_status = 'Payment Confirmed' AND _status = 'Accepted' AND target.paid_amount >= required_advance)
    OR (current_status = 'Accepted' AND _status = 'Packed')
    OR (current_status = 'Packed' AND _status = 'Dispatched' AND target.payment_status = 'Paid')
    OR (current_status = 'Dispatched' AND _status = 'Out for Delivery' AND target.payment_status = 'Paid')
    OR (current_status = 'Out for Delivery' AND _status = 'Delivered' AND target.payment_status = 'Paid');
  IF NOT valid_transition THEN
    RAISE EXCEPTION 'Fulfillment must move to the next allowed step; the required advance is needed to accept and full payment is needed before dispatch';
  END IF;

  UPDATE public.order_vendor_fulfillments SET status = _status, updated_at = now()
    WHERE order_id = target.id AND vendor_id = vendor;
  INSERT INTO public.order_tracking (order_id, status, note, actor_role)
    VALUES (target.id, _status, format('%s updated its shipment to %s.', vendor_name, _status), 'vendor');
  IF target.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (target.order_no, target.id, target.user_id, 'customer',
        'Vendor shipment updated', format('%s marked its order items as %s.', vendor_name, _status), 'order');
  END IF;
  RETURN true;
END;
$function$;

DROP POLICY IF EXISTS catalog_products_vendor_insert ON public.catalog_products;
CREATE POLICY catalog_products_vendor_insert ON public.catalog_products
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND private.marketplace_enabled() AND vendor_id = public.current_vendor_id()
      AND status = 'pending' AND private.vendor_kyc_is_complete(vendor_id))
  );
DROP POLICY IF EXISTS catalog_products_manage ON public.catalog_products;
CREATE POLICY catalog_products_manage ON public.catalog_products
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()))
  WITH CHECK (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND private.marketplace_enabled() AND vendor_id = public.current_vendor_id()
      AND status = 'pending' AND private.vendor_kyc_is_complete(vendor_id)));
