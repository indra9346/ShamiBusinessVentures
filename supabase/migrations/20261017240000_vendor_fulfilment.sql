-- Vendor fulfilment (used when the vendor marketplace is ON). A vendor either keeps stock at a
-- Grain Bazar godown (chosen branch) or fulfils from their own place: then they get their own
-- branch row (vendor_id set) with their address, PIN codes, pickup and/or home delivery and charge.
ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS vendor_id text;
CREATE INDEX IF NOT EXISTS branches_vendor_idx ON public.branches (vendor_id);

-- The fulfilment point for a vendor's items, or NULL for Grain Bazar's own stock (PIN routing decides).
CREATE OR REPLACE FUNCTION public.vendor_fulfilment_branch(_vendor_id text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE choice jsonb; point text;
BEGIN
  IF _vendor_id IS NULL OR NOT private.marketplace_enabled() THEN RETURN NULL; END IF;
  SELECT value INTO choice FROM public.vendor_settings WHERE vendor_id = _vendor_id AND key = 'fulfilment';
  IF choice IS NULL THEN RETURN NULL; END IF;
  IF choice->>'mode' = 'self' THEN
    SELECT id INTO point FROM public.branches WHERE vendor_id = _vendor_id AND active LIMIT 1;
  ELSE
    SELECT id INTO point FROM public.branches WHERE id = choice->>'branch_id' AND active AND vendor_id IS NULL;
  END IF;
  RETURN point;
END $$;
GRANT EXECUTE ON FUNCTION public.vendor_fulfilment_branch(text) TO anon, authenticated;

-- Vendor: choose fulfilment. Only while the marketplace is ON.
CREATE OR REPLACE FUNCTION public.vendor_set_fulfilment(_mode text, _branch_id text, _details jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text; pins text[]; fee numeric; free numeric; code text;
BEGIN
  IF NOT private.marketplace_enabled() THEN RAISE EXCEPTION 'The Grain Bazar vendor marketplace is not open yet'; END IF;
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN RAISE EXCEPTION 'Vendor sign-in is required'; END IF;
  v_id := public.current_vendor_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  IF _mode NOT IN ('godown', 'self') THEN RAISE EXCEPTION 'Choose a fulfilment option'; END IF;
  IF _mode = 'godown' THEN
    IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id AND active AND vendor_id IS NULL) THEN
      RAISE EXCEPTION 'Choose an active Grain Bazar godown';
    END IF;
    UPDATE public.branches SET active = false, updated_at = now() WHERE vendor_id = v_id;
  ELSE
    pins := ARRAY(SELECT DISTINCT trim(p) FROM jsonb_array_elements_text(COALESCE(_details->'pincodes', '[]'::jsonb)) p WHERE trim(p) ~ '^[0-9]{6}$');
    IF length(trim(COALESCE(_details->>'address', ''))) < 8 THEN RAISE EXCEPTION 'Enter your full pickup address'; END IF;
    IF COALESCE(_details->>'pincode', '') !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Enter your 6-digit PIN code'; END IF;
    IF NOT COALESCE((_details->>'pickup')::boolean, false) AND NOT COALESCE((_details->>'delivery')::boolean, false) THEN
      RAISE EXCEPTION 'Offer pickup, home delivery, or both';
    END IF;
    fee := GREATEST(0, COALESCE(NULLIF(_details->>'delivery_fee', '')::numeric, 0));
    free := NULLIF(_details->>'free_delivery_above', '')::numeric;
    code := 'V' || right(regexp_replace(v_id, '[^A-Za-z0-9]', '', 'g'), 7);
    INSERT INTO public.branches (id, code, name, address, city, state, state_code, pincode, phone, map_url, instructions,
      serves_pincodes, pickup_enabled, delivery_enabled, delivery_fee, free_delivery_above, is_default, active, vendor_id, sort_order)
    VALUES ('VB-' || v_id, code, 'Partner pickup point', trim(_details->>'address'), COALESCE(_details->>'city', ''),
      COALESCE(NULLIF(_details->>'state', ''), 'Karnataka'), COALESCE(NULLIF(_details->>'state_code', ''), '29'),
      _details->>'pincode', COALESCE(_details->>'phone', ''), COALESCE(_details->>'map_url', ''),
      COALESCE(_details->>'instructions', ''), CASE WHEN array_length(pins, 1) > 0 THEN pins ELSE ARRAY[_details->>'pincode'] END,
      COALESCE((_details->>'pickup')::boolean, false), COALESCE((_details->>'delivery')::boolean, false), fee, free,
      false, true, v_id, 1000)
    ON CONFLICT (id) DO UPDATE SET address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state,
      state_code = EXCLUDED.state_code, pincode = EXCLUDED.pincode, phone = EXCLUDED.phone, map_url = EXCLUDED.map_url,
      instructions = EXCLUDED.instructions, serves_pincodes = EXCLUDED.serves_pincodes,
      pickup_enabled = EXCLUDED.pickup_enabled, delivery_enabled = EXCLUDED.delivery_enabled,
      delivery_fee = EXCLUDED.delivery_fee, free_delivery_above = EXCLUDED.free_delivery_above, active = true, updated_at = now();
  END IF;
  INSERT INTO public.vendor_settings (vendor_id, key, value, updated_at)
    VALUES (v_id, 'fulfilment', jsonb_build_object('mode', _mode, 'branch_id', CASE WHEN _mode = 'godown' THEN _branch_id END), now())
  ON CONFLICT (vendor_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.vendor_set_fulfilment(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_set_fulfilment(text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.place_marketplace_order(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  line jsonb;
  item_product public.catalog_products%ROWTYPE;
  qty integer;
  subtotal numeric(14,2) := 0;
  gst_amount numeric(14,2) := 0;
  shipping_amount numeric(14,2) := 0;
  order_total numeric(14,2);
  product_price numeric(14,2);
  product_gst numeric(5,2);
  stock_now numeric(14,2);
  target_branch text;
  branch_row public.branches%ROWTYPE;
  fulfilment text;
  routing_on boolean;
  vendor_points text[];
  items_json jsonb := '[]'::jsonb;
  created_order_id uuid;
  order_item_id uuid;
  batch_row record;
  qty_to_allocate numeric(14,2);
  batch_take numeric(14,2);
  available_batch_qty numeric(14,2);
  free_above numeric(14,2) := 10000;
  standard_shipping numeric(14,2) := 250;
  express_shipping numeric(14,2) := 650;
  profile_name text;
  profile_email text;
  profile_phone text;
  profile_gstin text;
BEGIN
  IF auth.uid() IS NULL OR _target_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in is required to place an order';
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    IF NOT public.has_role(_target_user_id, 'customer') THEN
      RAISE EXCEPTION 'The selected account is not a customer';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'customer') OR _target_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Customers can place orders only for their own account';
  END IF;
  IF jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product to the order';
  END IF;
  IF _shipping_method NOT IN ('Pickup', 'Standard', 'Express') THEN
    RAISE EXCEPTION 'Invalid shipping method';
  END IF;
  IF _payment_method = 'Cash on Delivery' THEN
    RAISE EXCEPTION 'Cash on delivery is not enabled for this store';
  END IF;
  IF _shipping_address IS NULL OR jsonb_typeof(_shipping_address) <> 'object' THEN
    RAISE EXCEPTION 'A delivery address is required';
  END IF;
  IF COALESCE(_shipping_address->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT EXISTS (
      SELECT 1 FROM public.addresses
      WHERE id = (_shipping_address->>'id')::uuid AND user_id = _target_user_id
    ) THEN
    RAISE EXCEPTION 'Choose a saved address belonging to this customer account';
  END IF;
  SELECT full_name, email, phone, gstin
    INTO profile_name, profile_email, profile_phone, profile_gstin
    FROM public.profiles WHERE id = _target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The customer profile is incomplete'; END IF;

  SELECT COALESCE(MAX((value->>'free_above')::numeric), free_above),
         COALESCE(MAX((value->>'standard')::numeric), standard_shipping),
         COALESCE(MAX((value->>'express')::numeric), express_shipping)
    INTO free_above, standard_shipping, express_shipping
    FROM public.settings WHERE key = 'shipping' AND is_public;

  -- Branch: the godown serving the customer's PIN when branch routing is on, else the default.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  target_branch := public.default_branch_id();
  IF routing_on THEN
    target_branch := COALESCE((
      SELECT b.id FROM public.branches b
      WHERE b.active AND (_shipping_address->>'pin') = ANY (b.serves_pincodes)
      ORDER BY b.is_default DESC, b.sort_order LIMIT 1), target_branch);
  END IF;
  -- Marketplace ON: an order is fulfilled from its vendors' fulfilment point (a Grain Bazar godown
  -- the vendor stocks, or the vendor's own location). Items from different points are separate orders.
  IF private.marketplace_enabled() THEN
    SELECT array_agg(DISTINCT point) INTO vendor_points FROM (
      SELECT public.vendor_fulfilment_branch(cp.vendor_id) AS point
      FROM jsonb_array_elements(_items) AS item(value)
      JOIN public.catalog_products cp ON cp.id = item.value->>'product_id'
    ) points WHERE point IS NOT NULL;
    IF COALESCE(array_length(vendor_points, 1), 0) > 1 THEN
      RAISE EXCEPTION 'These items are collected from different locations; place them as separate orders';
    END IF;
    IF COALESCE(array_length(vendor_points, 1), 0) = 1 THEN target_branch := vendor_points[1]; END IF;
  END IF;
  IF target_branch IS NULL THEN RAISE EXCEPTION 'No active godown is set up'; END IF;

  FOR line IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    qty := (line->>'qty')::integer;
    IF qty IS NULL OR qty < 1 THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
    SELECT * INTO item_product FROM public.catalog_products
      WHERE id = line->>'product_id' AND status = 'approved' AND active
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A product is unavailable'; END IF;
    product_price := COALESCE((item_product.payload->>'price')::numeric, 0);
    product_gst := COALESCE((item_product.payload->>'gst')::numeric, 0);
    stock_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = target_branch AND product_id = item_product.id), 0)
      ELSE COALESCE((item_product.payload->>'stock')::numeric, 0) END;
    IF product_price <= 0 OR stock_now < (
      SELECT SUM((requested->>'qty')::integer)
      FROM jsonb_array_elements(_items) AS requested(value)
      WHERE value->>'product_id' = line->>'product_id'
    ) THEN
      RAISE EXCEPTION 'A product does not have enough available stock';
    END IF;
    subtotal := subtotal + product_price * qty;
    gst_amount := gst_amount + round(product_price * qty * product_gst / 100, 2);
    items_json := items_json || jsonb_build_array(jsonb_build_object(
      'product_id', item_product.id,
      'product_name', item_product.payload->>'name',
      'sku', item_product.payload->>'sku',
      'vendor', item_product.payload->>'vendor',
      'vendor_id', item_product.vendor_id,
      'capacity', COALESCE(item_product.payload->>'weight', ''),
      'qty', qty,
      'unit_price', product_price,
      'gst_rate', product_gst,
      'line_total', product_price * qty
    ));
  END LOOP;

  -- Pickup or home delivery, as the order's godown offers. Pickup is free; delivery uses the
  -- godown's charge (free above its threshold). A delivery request where the godown only offers
  -- pickup becomes a pickup (older app versions always sent 'Standard').
  SELECT * INTO branch_row FROM public.branches WHERE id = target_branch;
  fulfilment := CASE WHEN _shipping_method = 'Pickup' THEN 'Pickup' ELSE 'Standard' END;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled AND branch_row.pickup_enabled THEN
    fulfilment := 'Pickup';
  END IF;
  IF fulfilment = 'Pickup' AND NOT branch_row.pickup_enabled THEN
    RAISE EXCEPTION 'This godown does not offer pickup; choose home delivery';
  END IF;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled THEN
    RAISE EXCEPTION 'Home delivery is not available for this address yet';
  END IF;
  IF fulfilment = 'Standard' AND (branch_row.free_delivery_above IS NULL OR subtotal < branch_row.free_delivery_above) THEN
    shipping_amount := branch_row.delivery_fee;
  END IF;
  order_total := subtotal + gst_amount + shipping_amount;

  INSERT INTO public.orders (
    order_no, user_id, customer_name, customer_email, customer_phone, customer_gstin,
    vendor_ids, subtotal, discount, gst_amount, shipping, total, advance_due,
    balance_due, paid_amount, payment_method, payment_status, order_status,
    shipping_method, shipping_address, branch_id
  ) VALUES (
    _order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
    profile_phone, profile_gstin,
    ARRAY(SELECT DISTINCT value->>'vendor_id' FROM jsonb_array_elements(items_json)),
    subtotal, 0, gst_amount, shipping_amount, order_total, 0, order_total, 0,
    _payment_method, 'Pending', 'Placed', fulfilment, _shipping_address, target_branch
  ) RETURNING id INTO created_order_id;
  -- Stock leaves this order's godown.
  PERFORM set_config('app.branch_id', target_branch, true);

  FOR line IN SELECT value FROM jsonb_array_elements(items_json)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_id, product_name, sku, vendor, vendor_id, qty,
      unit_price, gst_rate, line_total, capacity
    ) VALUES (
      created_order_id, line->>'product_id', line->>'product_name', line->>'sku',
      line->>'vendor', line->>'vendor_id', (line->>'qty')::integer,
      (line->>'unit_price')::numeric, (line->>'gst_rate')::numeric,
      (line->>'line_total')::numeric, COALESCE(line->>'capacity', '')
    ) RETURNING id INTO order_item_id;

    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - (line->>'qty')::numeric), true),
        '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + (line->>'qty')::numeric), true
      ), updated_at = now()
      WHERE id = line->>'product_id';

    SELECT COALESCE(SUM(remaining_quantity), 0) INTO available_batch_qty
      FROM public.batches WHERE product_id = line->>'product_id';
    IF available_batch_qty >= (line->>'qty')::numeric THEN
      qty_to_allocate := (line->>'qty')::numeric;
      FOR batch_row IN
        SELECT id, remaining_quantity, unit_cost FROM public.batches
        WHERE product_id = line->>'product_id' AND remaining_quantity > 0
        ORDER BY purchase_date ASC NULLS LAST, created_at ASC
        FOR UPDATE
      LOOP
        EXIT WHEN qty_to_allocate <= 0;
        batch_take := LEAST(qty_to_allocate, batch_row.remaining_quantity);
        UPDATE public.batches
          SET remaining_quantity = remaining_quantity - batch_take,
              status = CASE WHEN remaining_quantity - batch_take <= 0 THEN 'Depleted' ELSE 'Active' END
          WHERE id = batch_row.id;
        INSERT INTO public.order_item_batch_allocations (
          order_item_id, batch_id, reserved_quantity, unit_cost
        ) VALUES (order_item_id, batch_row.id, batch_take, batch_row.unit_cost);
        qty_to_allocate := qty_to_allocate - batch_take;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'order_no', _order_no, 'subtotal', subtotal, 'discount', 0,
    'gst_amount', gst_amount, 'shipping', shipping_amount,
    'total', order_total, 'items', items_json
  );
END;
$function$;
