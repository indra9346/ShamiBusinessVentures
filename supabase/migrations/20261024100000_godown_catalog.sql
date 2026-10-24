-- Godown catalogue, two-way with Zoho. Each godown can be linked to a Zoho Inventory price list
-- and Zoho location. A godown linked to a price list sells only the items listed there, at those
-- prices. Prices and godown stock can be edited on the website or in Zoho:
--   * a website edit is saved at once and flagged as waiting for Zoho (pending); the sync sends
--     it to Zoho and clears the flag;
--   * a Zoho edit is pulled in by the sync (webhook or the 15-minute run) unless the website has
--     an edit still waiting, which then wins and is sent to Zoho.
-- Website orders reach Zoho as sales orders, never as stock edits, so they are not counted twice.

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS zoho_pricebook_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_pricebook_name text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS public.branch_prices (
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  price numeric(14,2) NOT NULL CHECK (price > 0),
  listed boolean NOT NULL DEFAULT true,
  pending boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id)
);
CREATE INDEX IF NOT EXISTS branch_prices_product_idx ON public.branch_prices (product_id);
ALTER TABLE public.branch_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_prices_read ON public.branch_prices;
CREATE POLICY branch_prices_read ON public.branch_prices FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.branch_prices TO anon, authenticated;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'branch_prices') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.branch_prices;
  END IF;
END $$;

-- A godown stock count edited on the website and not yet sent to its Zoho location.
ALTER TABLE public.branch_stock ADD COLUMN IF NOT EXISTS zoho_pending boolean NOT NULL DEFAULT false;

-- Zoho is the stock master per location when this is on (off until the owner switches it on).
-- Off: today's behaviour (the website's total stock is sent to the default godown's location).
INSERT INTO public.settings (key, value, is_public)
VALUES ('zoho_stock_master', '{"enabled": false}'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

-- The price an item sells at in a godown; NULL when that godown does not sell it.
CREATE OR REPLACE FUNCTION public.branch_product_price(_branch_id text, _product_id text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN COALESCE(b.zoho_pricebook_id, '') = '' THEN NULLIF((cp.payload->>'price')::numeric, 0)
    ELSE (SELECT bp.price FROM public.branch_prices bp WHERE bp.branch_id = b.id AND bp.product_id = cp.id AND bp.listed)
  END
  FROM public.branches b, public.catalog_products cp
  WHERE b.id = _branch_id AND cp.id = _product_id
$$;
GRANT EXECUTE ON FUNCTION public.branch_product_price(text, text) TO anon, authenticated;

-- Admin: set an item's price at a godown, or stop selling it there (_listed = false).
CREATE OR REPLACE FUNCTION public.admin_set_branch_price(_branch_id text, _product_id text, _price numeric, _listed boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE book text; current_price numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set godown prices';
  END IF;
  SELECT zoho_pricebook_id INTO book FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  IF COALESCE(book, '') = '' THEN
    RAISE EXCEPTION 'Link this godown to a Zoho price list first (Admin → Godowns)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catalog_products WHERE id = _product_id) THEN RAISE EXCEPTION 'Unknown product'; END IF;
  IF _listed AND (_price IS NULL OR _price <= 0 OR _price > 100000000) THEN RAISE EXCEPTION 'Enter a valid price'; END IF;
  SELECT price INTO current_price FROM public.branch_prices WHERE branch_id = _branch_id AND product_id = _product_id;
  INSERT INTO public.branch_prices (branch_id, product_id, price, listed, pending, updated_at)
  VALUES (_branch_id, _product_id, COALESCE(CASE WHEN _listed THEN _price END, current_price, 1), _listed, true, now())
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET price = COALESCE(CASE WHEN _listed THEN _price END, public.branch_prices.price),
        listed = _listed, pending = true, updated_at = now();
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_set_branch_price(text, text, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_price(text, text, numeric, boolean) TO authenticated;

-- Zoho sync: a godown's prices after reconciling with its Zoho price list (_prices =
-- {product_id: price}; items absent are not sold there). Rows changed on the website after
-- _read_at (when the sync read them) are left alone for the next run.
CREATE OR REPLACE FUNCTION public.apply_zoho_branch_prices(_branch_id text, _pricebook_name text, _prices jsonb, _read_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE kept integer;
BEGIN
  IF jsonb_typeof(_prices) <> 'object' THEN RAISE EXCEPTION 'Prices must be an object'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  -- No longer in the list: not sold here.
  UPDATE public.branch_prices bp SET listed = false, pending = false, updated_at = now()
    WHERE bp.branch_id = _branch_id AND NOT (_prices ? bp.product_id)
      AND (bp.listed OR bp.pending) AND bp.updated_at <= _read_at;
  -- In the list: sold here at this price.
  INSERT INTO public.branch_prices (branch_id, product_id, price, listed, pending)
    SELECT _branch_id, p.key, p.value::numeric, true, false
    FROM jsonb_each_text(_prices) p
    JOIN public.catalog_products cp ON cp.id = p.key
    WHERE p.value::numeric > 0
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET price = EXCLUDED.price, listed = true, pending = false, updated_at = now()
    WHERE public.branch_prices.updated_at <= _read_at
      AND (public.branch_prices.price IS DISTINCT FROM EXCLUDED.price OR NOT public.branch_prices.listed OR public.branch_prices.pending);
  UPDATE public.branches SET zoho_pricebook_name = COALESCE(_pricebook_name, '')
    WHERE id = _branch_id AND zoho_pricebook_name IS DISTINCT FROM COALESCE(_pricebook_name, '');
  SELECT count(*) INTO kept FROM public.branch_prices WHERE branch_id = _branch_id AND listed;
  RETURN kept;
END $$;
REVOKE ALL ON FUNCTION public.apply_zoho_branch_prices(text, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_branch_prices(text, text, jsonb, timestamptz) TO service_role;

-- Zoho sync: a godown's stock after reconciling with its Zoho location; clears the "waiting for
-- Zoho" flag. Skipped (returns NULL) when the row changed after _read_at, for example an order or
-- a website edit during the sync; the next run picks it up. Marked as coming from Zoho, so it is
-- not queued back to Zoho.
CREATE OR REPLACE FUNCTION public.apply_zoho_branch_stock(_branch_id text, _product_id text, _stock numeric, _read_at timestamptz)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;
REVOKE ALL ON FUNCTION public.apply_zoho_branch_stock(text, text, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_branch_stock(text, text, numeric, timestamptz) TO service_role;

-- Website orders at a godown whose stock Zoho does not hold yet (no sales order, or a draft one).
CREATE OR REPLACE FUNCTION public.branch_pending_order_qty(_branch_id text)
RETURNS TABLE (product_id text, qty numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT oi.product_id, SUM(oi.qty)::numeric
  FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
  WHERE COALESCE(o.branch_id, public.default_branch_id()) = _branch_id
    AND o.order_status <> 'Cancelled'
    AND (o.zoho_salesorder_id IS NULL OR lower(COALESCE(o.zoho_order_status, '')) IN ('', 'draft'))
    AND oi.product_id IS NOT NULL
  GROUP BY oi.product_id
$$;
REVOKE ALL ON FUNCTION public.branch_pending_order_qty(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.branch_pending_order_qty(text) TO service_role;

-- Checkout charges the customer's godown price (live definition; only the price lines change).
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

-- Stock routing: manual stock edits wait to go to Zoho (live definition; only the upsert changes).
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

-- Admin godown stock: waits to go to Zoho (live definition; only the upsert changes).
CREATE OR REPLACE FUNCTION public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE total numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set branch stock';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN RAISE EXCEPTION 'Enter a valid stock quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, true)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = true, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  RETURN total;
END $function$;

-- Stock receipts: wait to go to Zoho (live definition; one line added).
CREATE OR REPLACE FUNCTION public.admin_receive_inventory_batch(_batch_code text, _product_id text, _quantity numeric, _unit_cost numeric, _purchase_date date, _warehouse text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE product_row public.catalog_products%ROWTYPE; batch_id uuid; old_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may receive purchase stock'; END IF;
  IF length(trim(COALESCE(_batch_code,''))) = 0 OR _quantity <= 0 OR _unit_cost <= 0 THEN
    RAISE EXCEPTION 'Enter a batch code, positive quantity, and positive unit cost';
  END IF;
  SELECT * INTO product_row FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in the catalogue'; END IF;
  -- Received stock goes to the named godown (its id, code or name), else the default.
  PERFORM set_config('app.branch_id', COALESCE((
    SELECT id FROM public.branches WHERE NULLIF(trim(_warehouse), '') IN (id, code, name) LIMIT 1), ''), true);
  old_stock := COALESCE((product_row.payload->>'stock')::numeric,0);
  INSERT INTO public.batches(batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit_cost, purchase_date, warehouse, status)
    VALUES (trim(_batch_code), product_row.id, COALESCE(product_row.payload->>'name',product_row.id),
      product_row.payload->>'vendor', product_row.vendor_id, _quantity, _quantity, _unit_cost, _purchase_date,
      NULLIF(trim(_warehouse),''), 'Active') RETURNING id INTO batch_id;
  PERFORM set_config('app.stock_manual', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(
      jsonb_set(payload, '{stock}', to_jsonb(old_stock + _quantity), true),
      '{updated}', to_jsonb(now()::text), true), updated_at = now()
    WHERE id = _product_id;
  RETURN batch_id;
END; $function$;

NOTIFY pgrst, 'reload schema';
