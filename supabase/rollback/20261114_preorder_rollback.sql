-- Rollback of 20261114110000_preorder_batches.sql (pre-order batches). NOT a migration: run by hand, in one transaction,
-- only after every pre-order batch is matched or cancelled (no batches row with stage = 'incoming') and the old zip is
-- live again. Migration A (20261114100000_batch_expenses.sql) is independent and stays.
--
-- What it does:
--   * switches pre-orders off;
--   * drops the three new triggers (branch_stock derive, lot allocation and lot row);
--   * puts back every replaced function exactly as the LIVE database had it on 13 Nov 2026 (pg_get_functiondef, read
--     read-only before the release; identical to the repo's latest migrations apart from whitespace), with its grants;
--     record_stock_count gets its old 13-argument signature back;
--   * leaves the new columns and tables (branch_stock.stock keeps its meaning throughout: ready stock; free_total,
--     incoming and incoming_detail simply stop being maintained) and the new pre-order functions, with EXECUTE taken
--     from every role on those that change data; drops the order_items preorder_qty CHECK.
-- Read at 13 Nov 2026 from project ppziinqjxqpxpmudinfd with: select pg_get_functiondef(p.oid) ... (read-only).

BEGIN;

DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.batches WHERE stage = 'incoming') THEN
    RAISE EXCEPTION 'Pre-order batches are still open: match or cancel them before rolling back';
  END IF;
END $check$;

UPDATE public.settings SET value = jsonb_set(value, '{enabled}', 'false'::jsonb, true), updated_at = now() WHERE key = 'preorder';
DELETE FROM public.preorder_watch;

DROP TRIGGER IF EXISTS branch_stock_derive ON public.branch_stock;
DROP TRIGGER IF EXISTS order_item_batch_allocations_lot_changed ON public.order_item_batch_allocations;
DROP TRIGGER IF EXISTS batches_lot_changed ON public.batches;
-- branch_stock without lots: the total is the ready stock again. The old writers insert rows without a total, so the
-- column may be empty again (it had NOT NULL only because the derive trigger always filled it).
ALTER TABLE public.branch_stock ALTER COLUMN free_total DROP NOT NULL;
UPDATE public.branch_stock SET free_total = stock, incoming = 0, incoming_detail = '[]'::jsonb
  WHERE free_total IS DISTINCT FROM stock OR incoming <> 0 OR incoming_detail <> '[]'::jsonb;

DROP FUNCTION IF EXISTS public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid, numeric, uuid[]);

-- private.batch_stock_state()
-- live grants: (owner only)
CREATE OR REPLACE FUNCTION private.batch_stock_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.remaining_quantity <= 0 THEN
    NEW.status := 'Depleted';
    IF TG_OP = 'INSERT' OR OLD.remaining_quantity > 0 THEN
      NEW.depleted_at := now();
    ELSE
      NEW.depleted_at := COALESCE(OLD.depleted_at, now());
    END IF;
  ELSE
    NEW.status := 'Active';
    NEW.depleted_at := NULL;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS batches_stock_state ON public.batches;
CREATE TRIGGER batches_stock_state BEFORE INSERT OR UPDATE OF remaining_quantity ON public.batches
  FOR EACH ROW EXECUTE FUNCTION private.batch_stock_state();

-- public.route_stock_to_branch()
-- live grants: postgres=EXECUTE,anon=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE,PUBLIC=EXECUTE
CREATE OR REPLACE FUNCTION public.route_stock_to_branch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_total numeric := COALESCE((NEW.payload->>'stock')::numeric, 0);
  old_total numeric := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE((OLD.payload->>'stock')::numeric, 0) END;
  target text;
  branch_sum numeric;
BEGIN
  IF NEW.vendor_id LIKE 'zoho:%' OR current_setting('app.branch_stock_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND new_total = old_total THEN RETURN NEW; END IF;
  -- The order's / receipt's branch, else the vendor's fulfilment point, else the default godown.
  target := COALESCE(NULLIF(current_setting('app.branch_id', true), ''),
                     public.vendor_fulfilment_branch(NEW.vendor_id),
                     public.default_branch_id());
  IF target IS NULL THEN RETURN NEW; END IF;
  -- A manual stock edit (receipt, stock count) waits to go to the godown's Zoho location;
  -- order stock changes reach Zoho as sales orders instead.
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending)
    VALUES (target, NEW.id, GREATEST(0, new_total - old_total), COALESCE(current_setting('app.stock_manual', true), '') = 'on')
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET stock = GREATEST(0, public.branch_stock.stock + (new_total - old_total)),
        zoho_pending = public.branch_stock.zoho_pending OR COALESCE(current_setting('app.stock_manual', true), '') = 'on',
        updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO branch_sum FROM public.branch_stock WHERE product_id = NEW.id;
  IF branch_sum <> new_total THEN
    PERFORM set_config('app.branch_stock_sync', 'on', true);
    UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(branch_sum), true) WHERE id = NEW.id;
    PERFORM set_config('app.branch_stock_sync', 'off', true);
  END IF;
  RETURN NEW;
END $function$;

-- private.allocate_order_item_batches(_order_item_id uuid, _product_id text, _branch_id text, _qty numeric)
-- live grants: postgres=EXECUTE
CREATE OR REPLACE FUNCTION private.allocate_order_item_batches(_order_item_id uuid, _product_id text, _branch_id text, _qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  needed numeric(14,2) := COALESCE(_qty, 0);
  taken numeric(14,2);
  batch_row record;
BEGIN
  IF needed <= 0 OR _branch_id IS NULL OR _product_id IS NULL THEN RETURN 0; END IF;
  FOR batch_row IN
    SELECT id, remaining_quantity, unit_cost FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0
    ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
    FOR UPDATE
  LOOP
    EXIT WHEN needed <= 0;
    taken := LEAST(needed, batch_row.remaining_quantity);
    UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
    INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost)
      VALUES (_order_item_id, batch_row.id, taken, batch_row.unit_cost);
    needed := needed - taken;
  END LOOP;
  RETURN COALESCE(_qty, 0) - needed;
END $function$;

-- public.place_marketplace_order(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
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

-- public.admin_update_order_item(_order_no text, _order_item_id uuid, _qty integer, _capacity text, _unit_price numeric)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
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

-- public.admin_place_ended_checkout(_order_no text, _utr text, _method text, _checked_against text)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.admin_place_ended_checkout(_order_no text, _utr text DEFAULT NULL::text, _method text DEFAULT NULL::text, _checked_against text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  has_s boolean;
  ref text;
  method text;
  routing_on boolean;
  line record;
  stock_now numeric(14,2);
  due numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status <> 'Payment Expired' THEN RAISE EXCEPTION 'Only a checkout that ended without payment can be placed again here.'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  has_s := FOUND;
  IF has_s AND s.note = 'refunded by our team' THEN RAISE EXCEPTION 'The payment for this checkout was refunded, so it cannot be placed with it.'; END IF;
  IF has_s AND COALESCE(s.note, '') LIKE 'Placed again as %' THEN
    RAISE EXCEPTION 'The payment for this checkout already went to %.', substring(s.note from 'Placed again as (.*)$');
  END IF;
  ref := btrim(COALESCE(NULLIF(_utr, ''), CASE WHEN has_s AND s.status = 'submitted' THEN s.utr END, ''));
  IF length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR of the payment you found in the bank'; END IF;
  method := upper(btrim(COALESCE(NULLIF(_method, ''), o.payment_method, 'UPI')));
  IF method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'CASH', 'CHEQUE') THEN RAISE EXCEPTION 'Choose how it was paid'; END IF;
  method := CASE method WHEN 'CASH' THEN 'Cash' WHEN 'CHEQUE' THEN 'Cheque' ELSE method END;

  -- Its stock went back on sale when it ended: take it again at its godown, as placing it took it, or refuse.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  FOR line IN
    SELECT i.id, i.product_id, i.qty, i.product_name, cp.payload FROM public.order_items i
    LEFT JOIN public.catalog_products cp ON cp.id = i.product_id WHERE i.order_id = o.id
  LOOP
    stock_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = o.branch_id AND product_id = line.product_id), 0)
      ELSE COALESCE((line.payload->>'stock')::numeric, 0) END;
    IF stock_now < line.qty THEN
      RAISE EXCEPTION 'Only % left of % at its godown, so it cannot be placed again. Refund the customer, or add stock first.',
        to_char(stock_now, 'FM99999990.##'), COALESCE(line.product_name, 'an item');
    END IF;
  END LOOP;
  PERFORM set_config('app.branch_id', COALESCE(o.branch_id, ''), true);
  FOR line IN SELECT i.id, i.product_id, i.qty FROM public.order_items i WHERE i.order_id = o.id LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - line.qty), true),
        '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + line.qty), true
      ), updated_at = now()
      WHERE id = line.product_id;
    PERFORM private.allocate_order_item_batches(line.id, line.product_id, o.branch_id, line.qty);
  END LOOP;
  IF o.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = COALESCE(used_count, 0) + 1 WHERE code = o.coupon;
  END IF;

  -- Back to waiting for a moment, then paid in the same step: Confirm paid's own checks and records (the payment, the
  -- UTR settled, the bank alert answered) apply as they always do. Any refusal there undoes all of this.
  PERFORM set_config('app.payment_workflow', 'on', true);
  PERFORM set_config('app.revive_checkout', 'on', true);
  -- The order shows how it was really paid (a UPI checkout paid by NEFT, cash or cheque).
  UPDATE public.orders SET order_status = 'Awaiting Payment', payment_hold_until = now() + interval '30 minutes', payment_hold_outcome = NULL,
    payment_method = method
    WHERE id = o.id;
  PERFORM set_config('app.revive_checkout', 'off', true);
  PERFORM set_config('app.payment_workflow', 'off', true);
  due := o.total - COALESCE(o.paid_amount, 0);
  PERFORM public.admin_confirm_manual_payment(o.order_no, due, ref, method);
  -- Changed 13 Nov 2026: also the order's own lapsed UTR when it is the transfer recorded (admin_confirm_manual_payment
  -- confirms it already; this keeps the rule here too), and the admin who placed it is on the record (Approved by).
  UPDATE public.upi_payment_submissions
    SET status = 'confirmed',
        note = left(format('Paid after the checkout ended; placed again%s', CASE WHEN btrim(COALESCE(_checked_against, '')) <> '' THEN '. ' || btrim(_checked_against) ELSE '' END), 200),
        reviewed_at = now(), reviewed_by = auth.uid()
    WHERE order_id = o.id
      AND (status = 'confirmed' OR (status = 'rejected' AND note = 'we could not check your UTR in time' AND private.same_utr(utr, ref)));
  -- Added 13 Nov 2026: who ended this checkout stays on record, marked placed again, so the order no longer reads Cancelled.
  UPDATE public.order_cancellations
    SET placed_again_at = now(),
        placed_again_by_name = COALESCE((SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) FROM public.profiles WHERE id = auth.uid()), '')
    WHERE order_id = o.id AND stage = 'Awaiting Payment' AND placed_again_at IS NULL;
  -- The customer hears "Order placed" from the order's own status change (notify_order_participants), as for any paid order.
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', ref, 'amount', due, 'status', 'Payment Confirmed');
END;
$function$;

-- private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric, _reason text, _note text, _by uuid, _by_name text)
-- live grants: postgres=EXECUTE
CREATE OR REPLACE FUNCTION private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric, _reason text, _note text, _by uuid, _by_name text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  needed numeric(14,2) := round(abs(COALESCE(_delta, 0)), 2);
  taken numeric(14,2);
  batch_row record;
  stock_after numeric(14,2);
  in_batches numeric(14,2);
BEGIN
  IF needed = 0 THEN RETURN 0; END IF;
  -- A Zoho batch-tracked item: the godown sync records the batches Zoho itself changes.
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = _product_id AND track_batches) THEN RETURN 0; END IF;
  IF _delta < 0 THEN
    FOR batch_row IN
      SELECT id, remaining_quantity, unit_cost FROM public.batches
      WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0
      ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
      FOR UPDATE
    LOOP
      EXIT WHEN needed <= 0;
      taken := LEAST(needed, batch_row.remaining_quantity);
      UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
      INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
        VALUES (batch_row.id, -taken, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
      needed := needed - taken;
    END LOOP;
    RETURN round(abs(_delta), 2) - needed;
  END IF;
  SELECT id, unit_cost INTO batch_row FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id
    ORDER BY purchase_date DESC NULLS LAST, created_at DESC, batch_code DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- Called after the godown's stock was written (admin_set_branch_stock): only what the stock now holds beyond the
  -- batches is a gain; the rest is batch stock reaching the count.
  SELECT COALESCE(stock, 0) INTO stock_after FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  SELECT COALESCE(SUM(remaining_quantity), 0) INTO in_batches FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0;
  needed := LEAST(needed, GREATEST(0, COALESCE(stock_after, 0) - in_batches));
  IF needed <= 0 THEN RETURN 0; END IF;
  UPDATE public.batches SET remaining_quantity = remaining_quantity + needed WHERE id = batch_row.id;
  INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
    VALUES (batch_row.id, needed, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
  RETURN needed;
END $function$;

-- public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE total numeric; before_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set branch stock';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN RAISE EXCEPTION 'Enter a valid stock quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, true)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = true, updated_at = now();
  -- The same change on the godown's batches (correction), so batch reports match the stock.
  PERFORM private.record_batch_stock_change(_branch_id, _product_id, _stock - COALESCE(before_stock, 0), 'correction',
    'Godown stock set by head office', auth.uid(), COALESCE((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''));
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  RETURN total;
END $function$;

-- public.apply_zoho_branch_stock(_branch_id text, _product_id text, _stock numeric, _read_at timestamp with time zone)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.apply_zoho_branch_stock(_branch_id text, _product_id text, _stock numeric, _read_at timestamp with time zone)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE total numeric; row_now public.branch_stock%ROWTYPE;
BEGIN
  IF _stock IS NULL OR _stock < 0 THEN _stock := 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT * INTO row_now FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id FOR UPDATE;
  IF FOUND AND row_now.updated_at > _read_at THEN RETURN NULL; END IF;
  IF FOUND AND row_now.stock = _stock AND NOT row_now.zoho_pending THEN
    RETURN (SELECT COALESCE(SUM(stock), 0) FROM public.branch_stock WHERE product_id = _product_id);
  END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = false, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN total;
END $function$;

-- private.batch_transfer_godown(_branch text, _product text, _delta numeric, _readings jsonb, _reading_only boolean)
-- live grants: postgres=EXECUTE
CREATE OR REPLACE FUNCTION private.batch_transfer_godown(_branch text, _product text, _delta numeric, _readings jsonb, _reading_only boolean)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  reading numeric;
  waiting boolean;
  before numeric;
  after numeric;
BEGIN
  IF _branch IS NULL OR _product IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(_readings) = 'array' THEN
    SELECT (r->>'stock')::numeric INTO reading FROM jsonb_array_elements(_readings) AS r
      WHERE r->>'branch_id' = _branch AND r->>'product_id' = _product AND jsonb_typeof(r->'stock') = 'number' LIMIT 1;
  END IF;
  waiting := false;
  SELECT zoho_pending, stock INTO waiting, before FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  before := COALESCE(before, 0);
  IF reading IS NOT NULL AND NOT COALESCE(waiting, false) THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending)
      VALUES (_branch, _product, GREATEST(0, round(reading - private.batch_transfer_orders_waiting(_branch, _product), 2)), false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = now();
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) < 0 THEN
    UPDATE public.branch_stock SET stock = GREATEST(0, stock + _delta), updated_at = now()
      WHERE branch_id = _branch AND product_id = _product;
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) > 0 THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch, _product, _delta, false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = public.branch_stock.stock + EXCLUDED.stock, updated_at = now();
  END IF;
  SELECT stock INTO after FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product;
  RETURN COALESCE(after, 0) - before;
END $function$;

-- public.record_stock_count(_branch_id text, _product_id text, _counted numeric, _zoho_physical_before numeric, _zoho_delta numeric, _site_after numeric, _reason text, _note text, _flagged boolean, _zoho_adjustment_id text, _counted_by uuid, _counted_by_name text, _employee_id uuid)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.record_stock_count(_branch_id text, _product_id text, _counted numeric, _zoho_physical_before numeric, _zoho_delta numeric, _site_after numeric, _reason text, _note text, _flagged boolean, _zoho_adjustment_id text, _counted_by uuid, _counted_by_name text, _employee_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  product_payload jsonb;
  before_stock numeric;
  total numeric;
  new_id uuid;
BEGIN
  IF _counted IS NULL OR _counted < 0 OR _site_after IS NULL OR _site_after < 0 THEN RAISE EXCEPTION 'Invalid stock count'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  SELECT payload INTO product_payload FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;

  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _site_after, false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = false, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);

  INSERT INTO public.stock_counts (branch_id, product_id, product_name, counted, zoho_physical_before, zoho_delta,
    site_before, site_after, reason, note, flagged, zoho_adjustment_id, counted_by, counted_by_name, employee_id)
  VALUES (_branch_id, _product_id, COALESCE(product_payload->>'name', _product_id), _counted, _zoho_physical_before, _zoho_delta,
    COALESCE(before_stock, 0), _site_after, _reason, left(COALESCE(_note, ''), 200), COALESCE(_flagged, false),
    COALESCE(_zoho_adjustment_id, ''), _counted_by, COALESCE(_counted_by_name, ''), _employee_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid) TO service_role;

-- public.begin_batch_split(_batch_id uuid, _targets jsonb, _by uuid, _by_name text, _request uuid)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.begin_batch_split(_batch_id uuid, _targets jsonb, _by uuid, _by_name text, _request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b public.batches%ROWTYPE;
  src public.branches%ROWTYPE;
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  target jsonb;
  qty numeric;
  total numeric(14,2) := 0;
  item text;
  seen text[] := '{}';
  made jsonb := '[]'::jsonb;
  who text := left(btrim(COALESCE(_by_name, '')), 120);
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can send stock to another godown'; END IF;
  IF jsonb_typeof(_targets) <> 'array' OR jsonb_array_length(_targets) = 0 THEN RAISE EXCEPTION 'Choose a godown and how many to send'; END IF;
  -- Orders take from the batch FOR UPDATE too, so nothing slips in between the check and the move. The product is
  -- locked first, as orders lock it (place_marketplace_order), so the two never wait on each other.
  PERFORM 1 FROM public.catalog_products WHERE id = (SELECT product_id FROM public.batches WHERE id = _batch_id) FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- The same request again (its answer was lost and Send was pressed again): the transfers it began, nothing new.
  IF _request IS NOT NULL AND EXISTS (SELECT 1 FROM public.batch_transfers WHERE request_id = _request) THEN
    RETURN (SELECT jsonb_agg(private.batch_transfer_json(x) ORDER BY x.id) FROM public.batch_transfers x WHERE x.request_id = _request);
  END IF;
  SELECT * INTO src FROM public.branches WHERE id = b.branch_id;
  IF src.id IS NULL OR COALESCE(src.zoho_location_id, '') = '' THEN
    RAISE EXCEPTION 'Batch % is not at a godown linked to a Zoho location', b.batch_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = b.product_id AND track_batches) THEN
    RAISE EXCEPTION '% has batch tracking in Zoho: move it in Zoho, where its batches are', b.product_name;
  END IF;
  SELECT zoho_item_id INTO item FROM public.zoho_item_links WHERE product_id = b.product_id;
  IF COALESCE(item, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho item', b.product_name; END IF;

  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    qty := CASE WHEN jsonb_typeof(target->'qty') = 'number' THEN (target->>'qty')::numeric END;
    IF qty IS NULL OR qty <= 0 OR qty <> round(qty, 2) THEN RAISE EXCEPTION 'Enter how many to send to each godown'; END IF;
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
    IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
    IF dst.id = src.id THEN RAISE EXCEPTION 'Batch % is already at %', b.batch_code, dst.name; END IF;
    IF dst.id = ANY (seen) THEN RAISE EXCEPTION '% is chosen twice', dst.name; END IF;
    seen := seen || dst.id;
    total := total + qty;
  END LOOP;
  IF total > b.remaining_quantity THEN
    RAISE EXCEPTION 'Batch % has % left; % were chosen', b.batch_code, b.remaining_quantity, total;
  END IF;

  UPDATE public.batches SET remaining_quantity = remaining_quantity - total, sent_quantity = sent_quantity + total WHERE id = b.id;
  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    qty := (target->>'qty')::numeric;
    -- The godown's stock is not touched yet: Zoho still has the units there until it has them on the way (finish).
    INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
        parent_batch_id, product_id, quantity, lines, created_by, created_by_name, request_id)
      VALUES (private.next_batch_transfer_no(), 'split', src.id, src.zoho_location_id, src.name, dst.id, dst.zoho_location_id,
        b.id, b.product_id, qty, jsonb_build_array(jsonb_build_object('product_id', b.product_id, 'zoho_item_id', item, 'name', b.product_name, 'qty', qty, 'unit', b.unit)),
        _by, who, _request)
      RETURNING * INTO t;
    made := made || private.batch_transfer_json(t);
  END LOOP;
  RETURN made;
END $function$;

-- public.admin_update_batch(_batch_id uuid, _unit_cost numeric, _supplier text, _purchase_ref text, _notes text, _mfg_date date, _expiry_date date)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.admin_update_batch(_batch_id uuid, _unit_cost numeric, _supplier text, _purchase_ref text, _notes text, _mfg_date date, _expiry_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may edit batches'; END IF;
  IF _unit_cost IS NULL OR _unit_cost < 0 OR _unit_cost > 100000000 THEN RAISE EXCEPTION 'Enter a valid purchase cost'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF batch_row.zoho_bill_id <> '' THEN
    IF round(_unit_cost, 2) <> batch_row.unit_cost THEN RAISE EXCEPTION 'This batch''s cost comes from bill %. Correct the bill in Zoho instead.', batch_row.zoho_bill_number; END IF;
    -- Supplier and bill number come from the bill too.
    UPDATE public.batches SET notes = left(btrim(COALESCE(_notes, '')), 300), mfg_date = _mfg_date, expiry_date = _expiry_date
      WHERE id = _batch_id;
    RETURN;
  END IF;
  UPDATE public.batches
    SET unit_cost = _unit_cost, supplier = left(btrim(COALESCE(_supplier, '')), 120),
        purchase_ref = left(btrim(COALESCE(_purchase_ref, '')), 80), notes = left(btrim(COALESCE(_notes, '')), 300),
        mfg_date = _mfg_date, expiry_date = _expiry_date
    WHERE id = _batch_id;
  -- Sales already made from the batch take the corrected cost too (profit stays right).
  UPDATE public.order_item_batch_allocations SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
  UPDATE public.batch_adjustments SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
END $function$;

-- public.admin_delete_batch(_batch_id uuid)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.admin_delete_batch(_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
  held numeric;
  used integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete batches'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF batch_row.transfer_id IS NOT NULL OR batch_row.parent_batch_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.batch_transfers WHERE parent_batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Batch % is part of a transfer between godowns, so it is kept for the record.', batch_row.batch_code;
  END IF;
  -- An order placed now waits for this lock (its FIFO takes the batch FOR UPDATE), so nothing slips in between.
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0), count(*) INTO held, used
    FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  IF held > 0 THEN RAISE EXCEPTION 'Orders have taken stock from batch %, so it can''t be deleted.', batch_row.batch_code; END IF;
  -- A batch whose every order was cancelled or expired, unpaid, with all units back, may go (owner, 6 Nov 2026).
  IF used > 0 AND EXISTS (
    SELECT 1 FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id
      JOIN public.orders o ON o.id = i.order_id
     WHERE a.batch_id = batch_row.id
       AND NOT (o.order_status IN ('Cancelled', 'Payment Expired') AND COALESCE(o.paid_amount, 0) = 0
                AND COALESCE(o.payment_status, '') NOT IN ('Paid', 'Partially Paid', 'Refunded'))
  ) THEN RAISE EXCEPTION 'Orders have used batch % before, so it is kept for their records.', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_adjustments WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Stock counts have changed batch %, so it is kept for their records.', batch_row.batch_code;
  END IF;
  IF batch_row.remaining_quantity <> batch_row.quantity THEN
    RAISE EXCEPTION 'Batch %''s units have moved, so it can''t be deleted.', batch_row.batch_code;
  END IF;
  INSERT INTO public.deleted_batches_log (batch_code, product_id, product_name, quantity, released_orders, zoho_adjustment_id, deleted_by, deleted_by_name)
  VALUES (batch_row.batch_code, batch_row.product_id, batch_row.product_name, batch_row.quantity, used, COALESCE(batch_row.zoho_adjustment_id, ''),
    auth.uid(), COALESCE((SELECT left(COALESCE(p.full_name, ''), 120) FROM public.profiles p WHERE p.id = auth.uid()), ''));
  -- Only released rows of cancelled or expired orders are left here; their units are already back in stock.
  DELETE FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  DELETE FROM public.batches WHERE id = batch_row.id;
  RETURN jsonb_build_object('batch_code', batch_row.batch_code, 'zoho_adjustment_id', batch_row.zoho_adjustment_id);
END $function$;

-- public.create_batches_from_bill(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.create_batches_from_bill(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  branch_row public.branches%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  bill_date date;
  line_id text;
  quantity numeric(14,2);
  cost_ex numeric(14,2);
  cost_inc numeric(14,2);
  code text;
  new_id uuid;
  done text;
  made jsonb := '[]'::jsonb;
BEGIN
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  bill_date := NULLIF(_bill->>'date', '')::date;
  IF bill_date IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to make batches from'; END IF;
  SELECT * INTO branch_row FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT branch_row.active OR branch_row.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  -- Two admins, or two presses, on one bill: the second waits and then finds the lines done.
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    line_id := btrim(COALESCE(line->>'line_id', ''));
    IF line_id = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line_id;
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    quantity := round(COALESCE((line->>'qty')::numeric, 0), 2);
    cost_ex := round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2);
    cost_inc := round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2);
    IF quantity <= 0 OR quantity > 1000000 THEN RAISE EXCEPTION 'Bill % has a line with no quantity', bill_no; END IF;
    IF cost_ex < 0 OR cost_inc < cost_ex OR cost_inc > 100000000 THEN RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no; END IF;
    SELECT * INTO product_row FROM public.catalog_products WHERE id = line->>'product_id';
    IF NOT FOUND OR COALESCE(product_row.vendor_id, '') LIKE 'zoho:%' THEN RAISE EXCEPTION 'A bill line is not a website product'; END IF;
    -- Zoho makes and reports batches of these items itself (apply_zoho_batches): a second batch would count them twice.
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = product_row.id AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', COALESCE(product_row.payload->>'name', product_row.id);
    END IF;
    code := public.next_batch_code(branch_row.id, bill_date);
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name,
      zoho_item_id, zoho_bill_id, zoho_bill_line_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status)
    VALUES (code, product_row.id, COALESCE(product_row.payload->>'name', product_row.id), product_row.payload->>'vendor',
      product_row.vendor_id, quantity, quantity, COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'),
      CASE WHEN _cost_basis = 'inc_gst' THEN cost_inc ELSE cost_ex END, cost_ex, cost_inc, _cost_basis, bill_date,
      NULLIF(line->>'mfg_date', '')::date, NULLIF(line->>'expiry_date', '')::date, branch_row.name, branch_row.id,
      'website', left(btrim(COALESCE(_bill->>'vendor_name', '')), 120), bill_no, left(btrim(COALESCE(line->>'notes', '')), 300),
      _by, left(COALESCE(_by_name, ''), 120), COALESCE(line->>'zoho_item_id', ''), bill_id, line_id,
      bill_no, left(COALESCE(_bill->>'modified', ''), 40), NULLIF(_bill->>'total', '')::numeric, 'Active')
    RETURNING id INTO new_id;
    made := made || jsonb_build_object('line_id', line_id, 'batch_id', new_id, 'batch_code', code);
  END LOOP;
  RETURN made;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Bill % already has batches for these lines. Refresh the page.', bill_no;
END $function$;

-- public.begin_bill_receive(_branch_id text, _from_location_id text, _from_location_name text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.begin_bill_receive(_branch_id text, _from_location_id text, _from_location_name text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := btrim(COALESCE(_bill->>'bill_number', ''));
  done text;
  from_branch text;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  IF btrim(COALESCE(_from_location_id, '')) = '' THEN RAISE EXCEPTION 'Zoho did not say where bill % is', bill_no; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
  IF dst.zoho_location_id = _from_location_id THEN RAISE EXCEPTION 'Bill % is already at %: nothing to move', bill_no, dst.name; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to receive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id;
  IF FOUND THEN
    IF t.to_branch_id <> dst.id THEN
      RAISE EXCEPTION 'Bill % is already being moved to another godown (%). Finish or cancel that transfer first.', bill_no, t.transfer_no;
    END IF;
    RETURN private.batch_transfer_json(t) || jsonb_build_object('resumed', true);
  END IF;
  IF NULLIF(_bill->>'date', '') IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    -- What create_batches_from_bill checks when the move is finished, checked now, before Zoho moves anything: a line it
    -- would refuse then would leave a transfer that Zoho made and the website can never finish.
    IF btrim(COALESCE(line->>'line_id', '')) = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line->>'line_id';
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    IF round(COALESCE((line->>'qty')::numeric, 0), 2) <= 0 OR round(COALESCE((line->>'qty')::numeric, 0), 2) > 1000000
       OR btrim(COALESCE(line->>'zoho_item_id', '')) = '' THEN
      RAISE EXCEPTION 'Bill % has a line without a Zoho item or quantity', bill_no;
    END IF;
    IF round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2) < 0
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) < round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2)
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) > 100000000 THEN
      RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.catalog_products p WHERE p.id = line->>'product_id' AND COALESCE(p.vendor_id, '') NOT LIKE 'zoho:%') THEN
      RAISE EXCEPTION 'A bill line is not a website product';
    END IF;
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = line->>'product_id' AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', line->>'name';
    END IF;
  END LOOP;
  SELECT id INTO from_branch FROM public.branches WHERE zoho_location_id = _from_location_id AND vendor_id IS NULL ORDER BY active DESC, id LIMIT 1;

  INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
      bill, cost_basis, lines, created_by, created_by_name)
    VALUES (private.next_batch_transfer_no(), 'receive', from_branch, _from_location_id,
      left(btrim(COALESCE(_from_location_name, '')), 120), dst.id, dst.zoho_location_id, _bill, _cost_basis, _lines,
      _by, left(btrim(COALESCE(_by_name, '')), 120))
    RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;

-- public.receive_bill_here(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.receive_bill_here(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF bill_id <> '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));
    SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Bill % is being moved to % in Zoho (transfer %). Press Retry or Cancel on it under Transfers waiting for Zoho first.',
        COALESCE(_bill->>'bill_number', ''), COALESCE((SELECT name FROM public.branches WHERE id = t.to_branch_id), 'another godown'), t.transfer_no;
    END IF;
  END IF;
  RETURN public.create_batches_from_bill(_branch_id, _bill, _lines, _cost_basis, _by, _by_name);
END $function$;

-- public.finish_batch_transfer(_transfer_id bigint, _zoho_transfer_order_id text, _zoho_status text, _actor uuid, _stock jsonb, _claim uuid)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.finish_batch_transfer(_transfer_id bigint, _zoho_transfer_order_id text, _zoho_status text, _actor uuid, _stock jsonb, _claim uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  b public.batches%ROWTYPE;
  dst public.branches%ROWTYPE;
  made jsonb;
  child_code text;
  child_id uuid;
  n integer;
  line jsonb;
  receiver jsonb;
  moved numeric;
  status_now text := lower(btrim(COALESCE(_zoho_status, '')));
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'done' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer % was cancelled', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN
    RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no;
  END IF;
  IF btrim(COALESCE(_zoho_transfer_order_id, '')) = '' THEN RAISE EXCEPTION 'Zoho''s transfer order is missing'; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = t.to_branch_id;
  -- Products first, then batches: the order orders take their locks in (place_marketplace_order), so a Mark received
  -- and a customer's checkout never wait on each other.
  PERFORM 1 FROM public.catalog_products
    WHERE id IN (SELECT t.product_id UNION SELECT l->>'product_id' FROM jsonb_array_elements(t.lines) AS l)
    ORDER BY id FOR UPDATE;

  IF t.kind = 'split' AND status_now IN ('in_transit', 'transferred') AND t.status = 'pending' THEN
    -- It left the sending godown: Zoho's number there, or down by the quantity (what actually went down is kept).
    moved := private.batch_transfer_godown(t.from_branch_id, t.product_id, -t.quantity, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
    UPDATE public.batch_transfers SET status = 'in_transit', sent_at = now(), zoho_transfer_order_id = _zoho_transfer_order_id,
        zoho_status = status_now, last_error = '', reserved = GREATEST(0, -moved)
      WHERE id = t.id RETURNING * INTO t;
  END IF;
  IF status_now <> 'transferred' THEN
    IF t.status = 'pending' THEN
      UPDATE public.batch_transfers SET zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
          attempts = attempts + 1, last_error = format('Zoho shows transfer %s as "%s", not received yet', t.transfer_no, status_now)
        WHERE id = t.id RETURNING * INTO t;
    END IF;
    RETURN private.batch_transfer_json(t);
  END IF;

  IF t.kind = 'split' THEN
    receiver := CASE WHEN _actor IS NULL THEN jsonb_build_object('role', 'zoho', 'name', 'Marked received in Zoho')
      ELSE private.batch_transfer_receiver(_actor, t.to_branch_id) END;
    IF receiver IS NULL THEN
      RAISE EXCEPTION 'Only % staff, its channel partner or an administrator can mark transfer % received', dst.name, t.transfer_no;
    END IF;
    SELECT * INTO b FROM public.batches WHERE id = t.parent_batch_id FOR UPDATE;
    SELECT count(*) + 1 INTO n FROM public.batches WHERE parent_batch_id = b.id AND branch_id = dst.id;
    child_code := b.batch_code || '-' || upper(COALESCE(NULLIF(btrim(dst.code), ''), regexp_replace(dst.id, '^BR-', ''))) || n;
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name, zoho_item_id,
      zoho_bill_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status, parent_batch_id, transfer_id)
    VALUES (child_code, b.product_id, b.product_name, b.vendor, b.vendor_id, t.quantity, t.quantity, b.unit,
      b.unit_cost, b.unit_cost_ex_gst, b.unit_cost_inc_gst, b.cost_basis, b.purchase_date, b.mfg_date, b.expiry_date, dst.name, dst.id,
      'website', b.supplier, b.purchase_ref, left(format('From %s (%s)', b.batch_code, t.transfer_no), 300), _actor, left(receiver->>'name', 120),
      b.zoho_item_id, b.zoho_bill_id, b.zoho_bill_number, b.zoho_bill_modified, b.zoho_bill_total, 'Active', b.id, t.id)
    RETURNING id INTO child_id;
    made := jsonb_build_array(jsonb_build_object('batch_id', child_id, 'batch_code', child_code, 'qty', t.quantity));
    -- It arrived: the receiving godown gains it (the sender's stock went down when it left). Zoho's number there; else,
    -- with Zoho the stock master, the quantity Zoho moved; without (no readings at all), what left the sender's website
    -- stock, so a move between godowns never makes website stock.
    PERFORM private.batch_transfer_godown(t.to_branch_id, t.product_id, CASE WHEN _stock IS NULL THEN t.reserved ELSE t.quantity END, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
  ELSE
    receiver := jsonb_build_object('role', 'admin', 'name', t.created_by_name);
    made := public.create_batches_from_bill(t.to_branch_id, t.bill, t.lines, t.cost_basis, t.created_by, t.created_by_name);
    UPDATE public.batches SET transfer_id = t.id WHERE id IN (SELECT (m->>'batch_id')::uuid FROM jsonb_array_elements(made) m);
    -- Zoho is the stock master: both godowns take Zoho's numbers. Not the stock master (_stock NULL): a bill's units never
    -- reach website stock (as for a bill received at its own godown), so nothing moves.
    IF _stock IS NOT NULL THEN
      FOR line IN SELECT value FROM jsonb_array_elements(t.lines) LOOP
        PERFORM private.batch_transfer_godown(t.from_branch_id, line->>'product_id', -(line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_godown(t.to_branch_id, line->>'product_id', (line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_total(line->>'product_id');
      END LOOP;
    END IF;
  END IF;

  UPDATE public.batch_transfers SET status = 'done', zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
      last_error = '', result = made, finished_at = now(), sent_at = COALESCE(sent_at, now()), received_at = now(),
      received_by = CASE WHEN t.kind = 'split' THEN _actor ELSE t.created_by END,
      received_by_name = left(COALESCE(receiver->>'name', ''), 120), received_by_role = receiver->>'role'
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;

-- public.cancel_batch_transfer(_transfer_id bigint, _reason text, _by uuid, _stock jsonb, _claim uuid)
-- live grants: postgres=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.cancel_batch_transfer(_transfer_id bigint, _reason text, _by uuid, _stock jsonb, _claim uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  IF _by IS NOT NULL AND NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can cancel a transfer'; END IF;
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'cancelled' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'done' THEN RAISE EXCEPTION 'Transfer % is done: its units are at the other godown', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no; END IF;
  IF t.kind = 'split' THEN
    -- Product, then batch: the order checkout locks them in.
    PERFORM 1 FROM public.catalog_products WHERE id = t.product_id FOR UPDATE;
    UPDATE public.batches SET remaining_quantity = remaining_quantity + t.quantity,
        sent_quantity = GREATEST(0, sent_quantity - t.quantity)
      WHERE id = t.parent_batch_id;
    -- One on its way had left the sending godown's stock: back there, as Zoho's number when given, else what went down
    -- then (reserved), so nothing comes back that never left. One waiting for Zoho never moved stock.
    IF t.status = 'in_transit' THEN
      PERFORM private.batch_transfer_godown(t.from_branch_id, t.product_id, t.reserved, _stock, false);
      PERFORM private.batch_transfer_total(t.product_id);
    END IF;
  END IF;
  UPDATE public.batch_transfers SET status = 'cancelled', last_error = left(COALESCE(_reason, ''), 500), finished_at = now()
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;

-- private.delivery_note_gate(_order_id uuid, _zoho jsonb)
-- live grants: postgres=EXECUTE
CREATE OR REPLACE FUNCTION private.delivery_note_gate(_order_id uuid, _zoho jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  total numeric(14,2);
  paid numeric(14,2);
  receipts numeric(14,2);
  bank_short numeric(14,2);
  other_order text;
  stop public.delivery_stops%ROWTYPE;
  website text;
  z_last boolean := COALESCE(_zoho->>'source', '') = 'last_reading';
  z_read boolean := COALESCE(_zoho->>'read', '') = 'true';
  z_live integer := CASE WHEN jsonb_typeof(_zoho->'live_invoices') = 'number' THEN (_zoho->>'live_invoices')::integer ELSE 0 END;
  z_status text := lower(btrim(COALESCE(_zoho->>'status', '')));
  z_total numeric := private.delivery_fact_amount(_zoho, 'total');
  z_balance numeric := private.delivery_fact_amount(_zoho, 'balance');
  z_made numeric := private.delivery_fact_amount(_zoho, 'payment_made');
  z_paid numeric;
  code text;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed', false, 'code', 'not_found'); END IF;
  total := COALESCE(o.total, 0);
  paid := COALESCE(o.paid_amount, 0);
  SELECT COALESCE(sum(p.amount), 0) INTO receipts FROM public.payments p WHERE p.order_id = o.id AND p.status = 'Paid';
  SELECT * INTO stop FROM public.delivery_stops s WHERE s.order_id = o.id ORDER BY s.id DESC LIMIT 1;
  -- A bank alert saying less came in for a transfer recorded as more. Confirming a payment does not compare
  -- them. An alert the office has settled, with a note of what was done, is dealt with.
  SELECT COALESCE(sum(p.amount - c.amount), 0) INTO bank_short
    FROM public.payments p JOIN public.bank_credits c ON private.same_utr(c.utr, p.txn_ref)
    WHERE p.order_id = o.id AND p.status = 'Paid' AND c.amount < p.amount AND c.status <> 'settled';
  -- One bank transfer can pay one order, however its UTR was typed. Only references long enough to be a bank
  -- UTR count: same_utr reads O as 0 and I as 1, which would make "RCPT1" and "RCPTI" the same money.
  SELECT other_o.order_no INTO other_order
    FROM public.payments p
    JOIN public.payments q ON q.order_id <> p.order_id AND q.status = 'Paid' AND private.same_utr(q.txn_ref, p.txn_ref)
    JOIN public.orders other_o ON other_o.id = q.order_id
    WHERE p.order_id = o.id AND p.status = 'Paid' AND length(private.utr_form(p.txn_ref)) >= 12
    LIMIT 1;

  -- What the website's own records say. orders and payments must agree with each other first.
  IF paid < 0 OR total < 0 OR paid <> receipts THEN website := 'broken';
  ELSIF paid >= total THEN website := CASE WHEN o.payment_status = 'Paid' THEN 'full' ELSE 'broken' END;
  ELSIF paid > 0 THEN website := CASE WHEN o.payment_status = 'Partially Paid' THEN 'partly' ELSE 'broken' END;
  ELSE website := CASE WHEN o.payment_status IN ('Paid', 'Partially Paid') THEN 'broken' ELSE 'unpaid' END;
  END IF;

  IF o.order_status = 'Cancelled' THEN code := 'cancelled';
  ELSIF o.order_status = 'Payment Expired' THEN code := 'payment_expired';
  ELSIF o.payment_status = 'Refunded' THEN code := 'refunded';
  ELSIF COALESCE(stop.stopped, false) THEN code := 'stopped';
  ELSIF EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = o.id AND r.refund_status IN ('Processing', 'Refunded')) THEN code := 'return_refunded';
  ELSIF o.order_status NOT IN ('Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN code := 'not_confirmed';
  ELSIF NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = o.id) THEN code := 'no_items';
  ELSIF website = 'broken' THEN code := 'records_disagree';
  ELSIF other_order IS NOT NULL THEN code := 'utr_reused';
  ELSIF bank_short > 0 THEN code := 'bank_credit_short';
  -- Short of full payment on the website: the answer is no whatever Zoho says, so say the plain reason
  -- when Zoho has nothing to add.
  ELSIF NOT z_read THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'zoho_unreadable' END;
  ELSIF z_live > 1 THEN code := 'several_invoices';
  ELSIF z_live < 1 OR COALESCE(_zoho->>'invoice_id', '') = '' THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'no_invoice' END;
  ELSIF z_status = 'draft' THEN code := CASE website WHEN 'unpaid' THEN 'unpaid' WHEN 'partly' THEN 'partly_paid' ELSE 'invoice_draft' END;
  ELSIF z_total IS NULL OR z_balance IS NULL OR z_balance < 0 OR z_total < 0 OR z_balance > z_total
     OR (z_status = 'paid') <> (z_balance = 0)
     OR (z_status = 'paid' AND z_made IS NULL AND NOT z_last) THEN code := 'zoho_inconsistent';
  -- "Paid" in Books can mean a credit note or a write-off, not money: only payments count, less the rounding
  -- write-off of up to Rs 1 (see ROUNDING_WRITE_OFF_LIMIT).
  ELSIF z_status = 'paid' AND NOT z_last AND z_made < z_total - 1 THEN code := 'zoho_not_money';
  ELSIF website = 'full' THEN
    IF z_balance > 0 THEN code := 'zoho_behind';
    -- Zoho rounds CGST and SGST separately, so its total can differ from the website's by paise.
    -- More than a rupee is a different bill.
    ELSIF abs(z_total - total) > 1 THEN code := 'totals_differ';
    ELSIF EXISTS (SELECT 1 FROM public.delivery_notes n WHERE n.zoho_invoice_id = _zoho->>'invoice_id' AND n.order_id <> o.id) THEN code := 'invoice_used';
    ELSE code := 'paid';
    END IF;
  ELSIF z_status = 'paid' THEN code := 'website_behind';
  ELSE
    z_paid := z_total - z_balance;
    IF website = 'unpaid' THEN code := CASE WHEN z_paid > 0 THEN 'zoho_has_payment' ELSE 'unpaid' END;
    -- Part paid on the website: Zoho either has not been told yet, or says about the same.
    ELSE code := CASE WHEN z_paid = 0 OR abs(z_paid - paid) <= 1 THEN 'partly_paid' ELSE 'payment_mismatch' END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', code = 'paid', 'code', code, 'website', website, 'source', CASE WHEN z_last THEN 'last_reading' ELSE 'zoho_now' END,
    'order_no', o.order_no, 'order_status', o.order_status, 'payment_status', o.payment_status,
    'order_total', total, 'paid', paid, 'receipts', receipts,
    'balance', GREATEST(total - paid, 0), 'overpaid', GREATEST(paid - total, 0), 'bank_short', bank_short, 'other_order_no', other_order,
    'stopped', COALESCE(stop.stopped, false), 'stop_reason', CASE WHEN stop.stopped THEN stop.reason END,
    'zoho_read', z_read, 'zoho_error', left(COALESCE(_zoho->>'error', ''), 300), 'live_invoices', z_live,
    'invoice_id', COALESCE(_zoho->>'invoice_id', ''), 'invoice_number', COALESCE(_zoho->>'invoice_number', ''),
    'invoice_status', z_status, 'invoice_total', z_total, 'invoice_balance', z_balance, 'invoice_payment_made', z_made
  );
END;
$function$;

-- public.guard_order_mutation()
-- live grants: postgres=EXECUTE,anon=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE,PUBLIC=EXECUTE
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE required_advance numeric(14,2);
BEGIN
  -- The trusted server (service role) may record Zoho bookkeeping on any order, and nothing else.
  IF current_user = 'service_role'
    AND (to_jsonb(NEW) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at']) THEN
    RETURN NEW;
  END IF;

  IF OLD.order_status = 'Cancelled' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened';
  END IF;
  -- Changed 12 Nov 2026: admin_place_ended_checkout (flag app.revive_checkout) takes a checkout that ended without payment
  -- back to Awaiting Payment for a moment, when the admin has found its payment in the bank; it is paid in the same step.
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (current_setting('app.revive_checkout', true) = 'on' AND NEW.order_status = 'Awaiting Payment') THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  -- Changed 11 Nov 2026: so may an admin, through admin_cancel_order (flag app.admin_cancel), saying whether the goods came back.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on'
    AND current_setting('app.admin_cancel', true) IS DISTINCT FROM 'on' AND EXISTS (
    SELECT 1 FROM public.order_vendor_fulfillments f
    WHERE f.order_id = OLD.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Orders cannot be cancelled after any vendor has dispatched';
  END IF;
  -- A held (unpaid) request leaves "Awaiting Payment" only by being paid in full or expiring.
  IF OLD.order_status = 'Awaiting Payment' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (NEW.order_status = 'Payment Confirmed' AND NEW.payment_status = 'Paid')
    AND NOT (NEW.order_status IN ('Payment Expired', 'Cancelled')) THEN
    RAISE EXCEPTION 'Confirm the full payment before this order moves on';
  END IF;
  IF NEW.order_status = 'Payment Expired' AND OLD.order_status <> 'Payment Expired'
    AND current_setting('app.payment_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected payment workflow';
  END IF;

  -- Added 10 Nov 2026 (20261110120000_delivery_paper_qr.sql): every item on the order's delivery note was handed over
  -- at the godown on a QR scan, so delivery_paper_scan marks it Delivered. Only the status may change.
  IF current_setting('app.delivery_handover', true) = 'on'
    AND NEW.order_status = 'Delivered'
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- Added 13 Nov 2026 (20261113230000_godown_location_partner_confirm.sql): partner_confirm_order (flag app.partner_confirm)
  -- lets the active channel partner of the order's own godown confirm it, as an admin's "Mark as Confirmed" does: only
  -- from Placed or Payment Confirmed, only to Accepted, only when the payment is settled in full, and nothing else changes.
  IF current_setting('app.partner_confirm', true) = 'on'
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Accepted'
    AND OLD.payment_status = 'Paid'
    AND OLD.branch_id IS NOT NULL AND OLD.branch_id = public.current_partner_branch()
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- The pay-first functions (hold, auto-confirm from the bank alert, expiry) check everything themselves.
  IF current_setting('app.payment_workflow', true) = 'on' THEN RETURN NEW; END IF;

  -- Changes applied from Zoho by the SECURITY DEFINER Zoho functions below (shipment milestones,
  -- Zoho cancellations). The cancellation checks above still apply to them.
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;

  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;

  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable']) THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND NEW.order_status = 'Cancelled'
    AND EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    ) THEN
    RAISE EXCEPTION 'Customer cancellation is unavailable after a vendor has started fulfilment';
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed')
    AND NEW.order_status = 'Cancelled'
    AND COALESCE(OLD.paid_amount, 0) = 0
    AND OLD.payment_status NOT IN ('Paid', 'Partially Paid')
    AND NEW.advance_due = 0
    AND NEW.balance_due = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    )
    AND (to_jsonb(NEW) - ARRAY['order_status','advance_due','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','advance_due','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;

  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids) THEN
    required_advance := round(OLD.total * COALESCE((
      SELECT NULLIF(value->>'advance_percent', '')::numeric
      FROM public.settings WHERE key = 'order'
    ), 30) / 100, 2);
    IF OLD.order_status = 'Payment Confirmed' AND NEW.order_status = 'Accepted'
      AND OLD.paid_amount >= required_advance THEN
      RETURN NEW;
    END IF;
    IF (OLD.order_status = 'Accepted' AND NEW.order_status = 'Packed')
      OR (OLD.order_status = 'Packed' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Dispatched')
      OR (OLD.order_status = 'Dispatched' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Out for Delivery')
      OR (OLD.order_status = 'Out for Delivery' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Delivered') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Vendor order updates must follow the next allowed step, meet the required advance, and be fully paid before dispatch';
END
$function$;

-- public.admin_delete_order_all_details(_order_no text, _reason text)
-- live grants: postgres=EXECUTE,authenticated=EXECUTE,service_role=EXECUTE
CREATE OR REPLACE FUNCTION public.admin_delete_order_all_details(_order_no text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  blocker text;
  items integer;
  who_name text;
  utr_list text;
  copy jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this order is being deleted'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order no longer exists.'; END IF;
  blocker := private.order_delete_all_reason(o.id);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%', blocker; END IF;

  SELECT count(*) INTO items FROM public.order_items WHERE order_id = o.id;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who_name FROM public.profiles p WHERE p.id = auth.uid();
  SELECT string_agg(s.utr || ' (' || s.status || COALESCE(': ' || s.note, '') || ')', '; ' ORDER BY s.submitted_at) INTO utr_list
    FROM public.upi_payment_submissions s WHERE s.order_id = o.id;
  copy := jsonb_build_object(
    'order', to_jsonb(o),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.payments p WHERE p.order_id = o.id), '[]'::jsonb),
    'refunds', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.order_refunds r WHERE r.order_id = o.id), '[]'::jsonb),
    'cancellation', (SELECT to_jsonb(c) FROM public.order_cancellations c WHERE c.order_id = o.id),
    'utrs', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.upi_payment_submissions s WHERE s.order_id = o.id), '[]'::jsonb),
    'bank_credits', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.bank_credits c WHERE c.order_id = o.id), '[]'::jsonb),
    'stock_taken', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id WHERE i.order_id = o.id), '[]'::jsonb),
    'zoho_invoices', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.zoho_order_invoices i WHERE i.order_id = o.id), '[]'::jsonb),
    'commissions', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.partner_commissions c WHERE c.order_id = o.id), '[]'::jsonb));
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name, utrs,
    zoho_salesorder_id, zoho_order_status, snapshot)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, why, auth.uid(), COALESCE(who_name, ''), left(COALESCE(utr_list, ''), 1000),
    COALESCE(o.zoho_salesorder_id, ''), COALESCE(o.zoho_order_status, ''), copy);

  -- Deleting the items would queue a Zoho push for an order that is about to be gone.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$;

-- The order guard asked private.order_waiting_goods; nothing does now.
REVOKE EXECUTE ON FUNCTION private.order_waiting_goods(uuid) FROM authenticated, service_role;
REVOKE EXECUTE ON FUNCTION private.preorder_zoho_moved_alert(uuid, text, text) FROM authenticated, service_role;

-- Review fix (14 Nov 2026): the pre-order functions that change data can't run any more. The functions put back above do
-- not know lots: an undo of a match would turn a received batch into a lot that the old checkout sells as ready stock.
DO $revoke$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_incoming_batch(text,text,numeric,numeric,date,numeric,text,jsonb,text,jsonb,jsonb,jsonb,timestamp with time zone,uuid,text)',
    'public.admin_update_incoming_batch(uuid,numeric,date,numeric,numeric,boolean,text,text,text)',
    'public.admin_cancel_incoming_batch(uuid,text)',
    'public.admin_join_incoming_batches(uuid,uuid,text)',
    'public.admin_move_to_ready(uuid,numeric,text)',
    'public.receive_bill_lines(text,jsonb,jsonb,text,jsonb,jsonb,timestamp with time zone,uuid,text)',
    'public.unmatch_incoming_batch(uuid,text,jsonb,jsonb,timestamp with time zone,uuid,text)',
    'public.release_preorder_hold(text,text,numeric,text,jsonb,numeric,uuid[],timestamp with time zone,uuid,text)',
    'public.apply_preorder_reading(text,text,numeric,timestamp with time zone,uuid[],numeric,boolean)',
    'public.preorder_push_start(text,text)',
    'public.preorder_push_finish(text,text,boolean)',
    'public.admin_set_preorder_settings(boolean,integer,boolean)',
    'public.refresh_incoming_all()'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    END IF;
  END LOOP;
END $revoke$;
-- The old admin_update_order_item lowers a quantity without lowering preorder_qty.
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_preorder_qty_check;

COMMIT;

NOTIFY pgrst, 'reload schema';
