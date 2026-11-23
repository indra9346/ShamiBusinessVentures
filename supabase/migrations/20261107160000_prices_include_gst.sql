-- Selling prices include GST (owner, 7 Nov 2026). A ₹130 item costs the customer ₹130: ₹123.81 taxable value
-- and ₹6.19 GST at 5% (130 x 5 / 105). Until now GST was added on top, so ₹130 came to ₹136.50, above the
-- printed MRP on items sold at MRP.
--
-- Orders placed from now on carry prices_include_gst = true. Orders placed before keep their figures, and
-- false, so their invoices, Zoho copies and edits stay as they were. On a new order:
--   order_items.unit_price  the price the customer saw, GST included
--   order_items.line_total  the line's taxable value before GST (as before, so commissions and reports
--                           stay "before GST")
--   orders.subtotal         the goods before GST (as before); orders.gst_amount the GST inside the prices
--   orders.total            what the customer pays: the prices with GST, plus delivery, less any coupon
-- GST is worked out per line and rounded to paise: round(price x qty x rate / (100 + rate), 2).
-- Free delivery and coupons compare against the goods total the customer sees (GST included).
-- Built from the live definitions of 7 Nov 2026, changed only where these comments say.
-- Apply before uploading the matching zip: the page shows the new totals and the database must charge them.

BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS prices_include_gst boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.orders.prices_include_gst IS
  'true from 7 Nov 2026: item prices include GST (unit_price with GST, line_total and subtotal before GST). false: GST was added on top.';

-- ---------------------------------------------------------------- placing an order
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
  goods_total numeric(14,2) := 0;
  line_gross numeric(14,2);
  line_gst numeric(14,2);
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
    -- Changed 7 Nov 2026: the price includes GST. The line's GST is inside it; line_total is the taxable value.
    line_gross := round(product_price * qty, 2);
    line_gst := CASE WHEN product_gst > 0 THEN round(line_gross * product_gst / (100 + product_gst), 2) ELSE 0 END;
    goods_total := goods_total + line_gross;
    subtotal := subtotal + (line_gross - line_gst);
    gst_amount := gst_amount + line_gst;
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
      'line_total', line_gross - line_gst
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
  -- Changed 7 Nov 2026: free delivery goes by the goods total the customer sees (GST included).
  IF fulfilment = 'Standard' AND (branch_row.free_delivery_above IS NULL OR goods_total < branch_row.free_delivery_above) THEN
    shipping_amount := branch_row.delivery_fee;
  END IF;
  order_total := goods_total + shipping_amount;

  INSERT INTO public.orders (
    order_no, user_id, customer_name, customer_email, customer_phone, customer_gstin,
    vendor_ids, subtotal, discount, gst_amount, shipping, total, advance_due,
    balance_due, paid_amount, payment_method, payment_status, order_status,
    shipping_method, shipping_address, branch_id, prices_include_gst
  ) VALUES (
    final_order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
    profile_phone, profile_gstin,
    ARRAY(SELECT DISTINCT value->>'vendor_id' FROM jsonb_array_elements(items_json)),
    subtotal, 0, gst_amount, shipping_amount, order_total, 0, order_total, 0,
    _payment_method, 'Pending', 'Placed', fulfilment, _shipping_address, target_branch, true
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

    -- Batches: the oldest purchase at this order's godown first (FIFO), split when needed; stock
    -- without a batch stays unbatched.
    PERFORM private.allocate_order_item_batches(order_item_id, line->>'product_id', target_branch, (line->>'qty')::numeric);
  END LOOP;

  RETURN jsonb_build_object(
    'order_no', final_order_no, 'subtotal', subtotal, 'discount', 0,
    'gst_amount', gst_amount, 'shipping', shipping_amount,
    'total', order_total, 'goods_total', goods_total, 'prices_include_gst', true, 'items', items_json
  );
END;
$function$;

-- ---------------------------------------------------------------- coupons: on the goods total the customer sees
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
          AND order_status NOT IN ('Cancelled', 'Payment Expired');
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
  -- Changed 7 Nov 2026: the minimum and the percentage go by the goods total the customer sees (GST included).
  order_subtotal := COALESCE((order_result->>'goods_total')::numeric, (order_result->>'subtotal')::numeric);
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

-- ---------------------------------------------------------------- admin edit of an order line
CREATE OR REPLACE FUNCTION public.admin_update_order_item(_order_no text, _order_item_id uuid, _qty integer, _capacity text, _unit_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_order public.orders%ROWTYPE;
  target_item public.order_items%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  batch_row record;
  allocation_row record;
  delta integer;
  needed numeric(14,2);
  taken numeric(14,2);
  stock_now numeric(14,2);
  batch_available numeric(14,2);
  subtotal_now numeric(14,2);
  gst_now numeric(14,2);
  total_now numeric(14,2);
  new_line_total numeric(14,2);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may edit order lines';
  END IF;
  IF _qty IS NULL OR _qty < 1 OR _qty > 100000 THEN
    RAISE EXCEPTION 'Enter an order quantity between 1 and 100,000';
  END IF;
  IF _capacity IS NULL OR length(trim(_capacity)) = 0 OR length(trim(_capacity)) > 100 THEN
    RAISE EXCEPTION 'Enter a valid product capacity';
  END IF;
  IF _unit_price IS NULL OR _unit_price < 0 OR _unit_price > 100000000 THEN
    RAISE EXCEPTION 'Enter a valid unit price';
  END IF;

  SELECT * INTO target_order FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target_order.branch_id, ''), true);
  IF target_order.order_status <> 'Placed'
    OR target_order.payment_status <> 'Pending'
    OR target_order.paid_amount <> 0
    OR target_order.discount <> 0
    OR target_order.coupon IS NOT NULL THEN
    RAISE EXCEPTION 'Only unpaid, non-discounted orders in Placed status can be edited';
  END IF;

  SELECT * INTO target_item FROM public.order_items
    WHERE id = _order_item_id AND order_id = target_order.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  delta := _qty - target_item.qty;

  IF delta <> 0 THEN
    SELECT * INTO product_row FROM public.catalog_products WHERE id = target_item.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The product is no longer in the catalog; quantity cannot be changed'; END IF;
    stock_now := COALESCE((product_row.payload->>'stock')::numeric, 0);
    IF delta > 0 AND stock_now < delta THEN
      RAISE EXCEPTION 'There is not enough available stock for this quantity';
    END IF;
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(product_row.payload, '{stock}', to_jsonb(stock_now - delta), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((product_row.payload->>'sold')::numeric, 0) + delta)),
        true
      ), updated_at = now()
      WHERE id = target_item.product_id;

    IF delta > 0 THEN
      -- More of the item: the oldest batches at the order's godown first (FIFO).
      PERFORM private.allocate_order_item_batches(target_item.id, target_item.product_id, target_order.branch_id, delta);
    ELSE
      needed := abs(delta);
      FOR allocation_row IN
        SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
        FROM public.order_item_batch_allocations a
        WHERE a.order_item_id = target_item.id
          AND a.released_quantity < a.reserved_quantity
        ORDER BY a.created_at DESC, a.id DESC
        FOR UPDATE
      LOOP
        EXIT WHEN needed <= 0;
        taken := LEAST(needed, allocation_row.reserved_quantity - allocation_row.released_quantity);
        UPDATE public.batches
          SET remaining_quantity = remaining_quantity + taken,
              status = CASE WHEN remaining_quantity + taken > 0 THEN 'Active' ELSE 'Depleted' END
          WHERE id = allocation_row.batch_id;
        UPDATE public.order_item_batch_allocations
          SET released_quantity = released_quantity + taken
          WHERE id = allocation_row.id;
        needed := needed - taken;
      END LOOP;
    END IF;
  END IF;

  -- Changed 7 Nov 2026: on an order whose prices include GST, the typed price includes GST and line_total is the
  -- taxable value; an older order adds GST on top, as before.
  new_line_total := CASE
    WHEN target_order.prices_include_gst AND target_item.gst_rate > 0
      THEN round(_qty * _unit_price, 2) - round(round(_qty * _unit_price, 2) * target_item.gst_rate / (100 + target_item.gst_rate), 2)
    ELSE round(_qty * _unit_price, 2) END;
  UPDATE public.order_items
    SET qty = _qty,
        capacity = trim(_capacity),
        unit_price = _unit_price,
        line_total = new_line_total
    WHERE id = target_item.id;

  IF target_order.prices_include_gst THEN
    SELECT COALESCE(SUM(line_total), 0),
           COALESCE(SUM(round(qty * unit_price, 2) - line_total), 0)
      INTO subtotal_now, gst_now
      FROM public.order_items WHERE order_id = target_order.id;
  ELSE
    SELECT COALESCE(SUM(line_total), 0),
           COALESCE(SUM(round(line_total * gst_rate / 100, 2)), 0)
      INTO subtotal_now, gst_now
      FROM public.order_items WHERE order_id = target_order.id;
  END IF;
  total_now := subtotal_now + gst_now + target_order.shipping - target_order.discount;
  UPDATE public.orders
    SET subtotal = subtotal_now,
        gst_amount = gst_now,
        total = total_now,
        balance_due = GREATEST(0, total_now - paid_amount)
    WHERE id = target_order.id;

  RETURN jsonb_build_object(
    'order_no', target_order.order_no,
    'order_item_id', target_item.id,
    'qty', _qty,
    'capacity', trim(_capacity),
    'unit_price', _unit_price,
    'line_total', new_line_total,
    'subtotal', subtotal_now,
    'gst_amount', gst_now,
    'total', total_now,
    'balance_due', GREATEST(0, total_now - target_order.paid_amount)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
