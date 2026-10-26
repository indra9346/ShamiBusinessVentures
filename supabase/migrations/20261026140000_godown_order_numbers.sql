-- Godown-based order numbers: <GODOWN>-<DELIVERY PIN>-<DDMMYY>-<HHMMSS IST>, for example
-- CLK-577522-261026-143215 = Challakere godown, PIN 577522, 26 Oct 2026, 14:32:15. The database
-- makes the number when it decides the order's godown, so it always names the right one; two
-- orders in the same second for the same PIN get -2, -3. Zoho gets GB-<number> as before.
-- place_marketplace_order and its coupon wrapper are the live definitions with only the
-- order-number lines changed. Existing ORD- numbers are kept.

CREATE OR REPLACE FUNCTION public.next_godown_order_no(_branch_id text, _pin text, _at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  godown text;
  pin text := left(regexp_replace(COALESCE(_pin, ''), '\D', '', 'g'), 6);
  base text;
  candidate text;
  n integer := 1;
BEGIN
  SELECT upper(regexp_replace(COALESCE(code, ''), '[^A-Za-z0-9]', '', 'g')) INTO godown
    FROM public.branches WHERE id = _branch_id;
  IF COALESCE(godown, '') = '' THEN godown := 'GB'; END IF;
  IF length(pin) <> 6 THEN pin := '000000'; END IF;
  base := godown || '-' || pin || '-' || to_char(_at AT TIME ZONE 'Asia/Kolkata', 'DDMMYY-HH24MISS');
  -- Held until the order is saved, so two orders in the same second cannot take the same number.
  PERFORM pg_advisory_xact_lock(hashtextextended(base, 0));
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM public.orders WHERE order_no = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$function$;
REVOKE ALL ON FUNCTION public.next_godown_order_no(text, text, timestamptz) FROM PUBLIC, anon, authenticated;

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
  final_order_no text;
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
  -- The order number names its godown, the delivery PIN and the moment it was placed (IST),
  -- e.g. CLK-577522-261026-143215. _order_no from older app versions is no longer used.
  final_order_no := public.next_godown_order_no(target_branch, _shipping_address->>'pin');

  FOR line IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    qty := (line->>'qty')::integer;
    IF qty IS NULL OR qty < 1 THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
    SELECT * INTO item_product FROM public.catalog_products
      WHERE id = line->>'product_id' AND status = 'approved' AND active
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A product is unavailable'; END IF;
    -- With godown matching on, each godown sells the items of its Zoho price list at that list's
    -- price (a godown without a price list sells every item at the base price).
    product_price := CASE WHEN routing_on
      THEN public.branch_product_price(target_branch, item_product.id)
      ELSE COALESCE((item_product.payload->>'price')::numeric, 0) END;
    IF product_price IS NULL THEN
      RAISE EXCEPTION '% is not sold at your godown. Remove it from the cart to continue.', COALESCE(item_product.payload->>'name', 'An item');
    END IF;
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
    final_order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
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
    'order_no', final_order_no, 'subtotal', subtotal, 'discount', 0,
    'gst_amount', gst_amount, 'shipping', shipping_amount,
    'total', order_total, 'items', items_json
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.place_marketplace_order_with_coupon(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  coupon_row public.coupons%ROWTYPE;
  order_result jsonb;
  coupon_code text := NULLIF(upper(trim(_coupon)), '');
  coupon_discount numeric(14,2) := 0;
  order_subtotal numeric(14,2);
  order_total numeric(14,2);
  customer_uses integer;
BEGIN
  IF coupon_code IS NOT NULL THEN
    IF auth.uid() IS NULL OR NOT (
      public.has_role(auth.uid(), 'customer')
      OR public.has_role(auth.uid(), 'admin')
    ) THEN
      RAISE EXCEPTION 'Only a customer or administrator can use a coupon';
    END IF;
    IF public.has_role(auth.uid(), 'customer') AND _target_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Customers can use coupons only on their own orders';
    END IF;
    SELECT * INTO coupon_row FROM public.coupons
      WHERE code = coupon_code FOR UPDATE;
    IF NOT FOUND OR NOT coupon_row.active
      OR coupon_row.starts_on > current_date
      OR coupon_row.ends_on < current_date
      OR coupon_row.used_count >= coupon_row.usage_limit THEN
      RAISE EXCEPTION 'This coupon is not active or has reached its usage limit';
    END IF;
    IF coupon_row.zoho_usage_limit_per_user IS NOT NULL THEN
      SELECT count(*) INTO customer_uses FROM public.orders
        WHERE user_id = _target_user_id AND coupon = coupon_code
          AND order_status <> 'Cancelled';
      IF customer_uses >= coupon_row.zoho_usage_limit_per_user THEN
        RAISE EXCEPTION 'This customer has already used this coupon the maximum number of times';
      END IF;
    END IF;
  END IF;

  order_result := public.place_marketplace_order(
    _order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address,
    _shipping_method, _payment_method, _items
  );
  order_subtotal := (order_result->>'subtotal')::numeric;
  order_total := (order_result->>'total')::numeric;

  IF coupon_code IS NOT NULL THEN
    IF order_subtotal < coupon_row.minimum_order THEN
      RAISE EXCEPTION 'Add more items to meet this coupon’s minimum order amount';
    END IF;
    IF coupon_row.discount_type = 'Percentage' THEN
      coupon_discount := LEAST(
        coupon_row.maximum_discount,
        round(order_subtotal * coupon_row.discount_value / 100, 2)
      );
    ELSE
      coupon_discount := LEAST(order_subtotal, coupon_row.discount_value);
    END IF;
    order_total := GREATEST(0, order_total - coupon_discount);
    PERFORM set_config('app.coupon_checkout', 'on', true);
    UPDATE public.orders
      SET coupon = coupon_code,
          discount = coupon_discount,
          total = order_total,
          balance_due = GREATEST(order_total - paid_amount, 0)
      WHERE order_no = order_result->>'order_no' AND user_id = _target_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Could not apply the coupon to this order'; END IF;
    UPDATE public.coupons SET used_count = used_count + 1 WHERE code = coupon_code;
  END IF;

  RETURN order_result || jsonb_build_object(
    'coupon', coupon_code,
    'discount', coupon_discount,
    'total', order_total
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
