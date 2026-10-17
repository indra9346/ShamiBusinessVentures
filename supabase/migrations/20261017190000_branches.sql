
-- Godown branches (multi-location). One catalogue; stock is kept per branch and the product's
-- total stock (payload.stock) is always the sum of its branch stock. Every existing stock change
-- (checkout, cancellation, Zoho cancellation, order edits, inventory receipts, vendor stock) is
-- routed to the right branch by a trigger, using the branch set for the transaction
-- (app.branch_id) or the default branch.

CREATE TABLE IF NOT EXISTS public.branches (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'Karnataka',
  state_code text NOT NULL DEFAULT '29',
  pincode text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  map_url text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  gstin text NOT NULL DEFAULT '',
  zoho_location_id text NOT NULL DEFAULT '',
  zoho_location_name text NOT NULL DEFAULT '',
  serves_pincodes text[] NOT NULL DEFAULT '{}',
  pickup_enabled boolean NOT NULL DEFAULT true,
  delivery_enabled boolean NOT NULL DEFAULT false,
  delivery_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  free_delivery_above numeric(12,2) CHECK (free_delivery_above IS NULL OR free_delivery_above >= 0),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default ON public.branches ((is_default)) WHERE is_default;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branches_read ON public.branches;
CREATE POLICY branches_read ON public.branches FOR SELECT TO anon, authenticated
  USING (active OR public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS branches_admin_write ON public.branches;
CREATE POLICY branches_admin_write ON public.branches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
GRANT SELECT ON public.branches TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.branches TO authenticated;

-- Seed the Challakere godown from the current pickup settings (or the registered address).
INSERT INTO public.branches (id, code, name, address, city, state, state_code, pincode, phone, email, map_url,
  instructions, zoho_location_id, zoho_location_name, serves_pincodes, is_default, active)
SELECT 'BR-CLK', 'CLK',
  COALESCE(NULLIF(p->>'name', ''), 'Grain Bazar Challakere Godown'),
  COALESCE(NULLIF(p->>'address', ''), 'Pavagada Road, Behind Mahalakshmi Kalyana Mantapa, Mahadevi Road, Challakere, Karnataka 577522'),
  'Challakere', 'Karnataka', '29', '577522',
  COALESCE(NULLIF(p->>'phone', ''), '8310084308'), 'shamibusinessventurespvtltd@gmail.com',
  COALESCE(p->>'mapUrl', ''),
  COALESCE(NULLIF(p->>'instructions', ''), 'Bring your order number. Collect during working hours.'),
  COALESCE(p->>'zohoLocationId', ''), COALESCE(NULLIF(p->>'zohoLocationName', ''), 'CLK Shami Business Ventures'),
  COALESCE(ARRAY(SELECT jsonb_array_elements_text(p->'pincodes')), ARRAY['577522','577536','577537','577538','577543']),
  true, true
FROM (SELECT (SELECT value->'points'->0 FROM public.settings WHERE key = 'pickup_points') AS p) seed
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.default_branch_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.branches WHERE is_default AND active ORDER BY sort_order LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.default_branch_id() TO anon, authenticated;

-- Stock per branch.
CREATE TABLE IF NOT EXISTS public.branch_stock (
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  stock numeric(14,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id)
);
CREATE INDEX IF NOT EXISTS branch_stock_product_idx ON public.branch_stock (product_id);
ALTER TABLE public.branch_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS branch_stock_read ON public.branch_stock;
CREATE POLICY branch_stock_read ON public.branch_stock FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.branch_stock TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.branch_stock FROM anon, authenticated;

INSERT INTO public.branch_stock (branch_id, product_id, stock)
SELECT 'BR-CLK', c.id, GREATEST(0, COALESCE((c.payload->>'stock')::numeric, 0))
FROM public.catalog_products c
WHERE c.vendor_id IS NULL OR c.vendor_id NOT LIKE 'zoho:%'
ON CONFLICT (branch_id, product_id) DO NOTHING;

-- Orders belong to a branch.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS branch_id text REFERENCES public.branches(id);
DO $$ BEGIN
  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.orders SET branch_id = 'BR-CLK' WHERE branch_id IS NULL;
END $$;
CREATE INDEX IF NOT EXISTS orders_branch_idx ON public.orders (branch_id);

CREATE OR REPLACE FUNCTION public.orders_default_branch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN NEW.branch_id := public.default_branch_id(); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS orders_default_branch ON public.orders;
CREATE TRIGGER orders_default_branch BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_default_branch();

-- Route every change of a product's total stock to a branch, and keep the total = sum.
CREATE OR REPLACE FUNCTION public.route_stock_to_branch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_total numeric := COALESCE((NEW.payload->>'stock')::numeric, 0);
  old_total numeric := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE((OLD.payload->>'stock')::numeric, 0) END;
  target text;
  branch_sum numeric;
BEGIN
  IF NEW.vendor_id LIKE 'zoho:%' OR current_setting('app.branch_stock_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND new_total = old_total THEN RETURN NEW; END IF;
  target := COALESCE(NULLIF(current_setting('app.branch_id', true), ''), public.default_branch_id());
  IF target IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock)
    VALUES (target, NEW.id, GREATEST(0, new_total - old_total))
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET stock = GREATEST(0, public.branch_stock.stock + (new_total - old_total)), updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO branch_sum FROM public.branch_stock WHERE product_id = NEW.id;
  IF branch_sum <> new_total THEN
    PERFORM set_config('app.branch_stock_sync', 'on', true);
    UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(branch_sum), true) WHERE id = NEW.id;
    PERFORM set_config('app.branch_stock_sync', 'off', true);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS catalog_products_route_stock ON public.catalog_products;
CREATE TRIGGER catalog_products_route_stock AFTER INSERT OR UPDATE OF payload ON public.catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.route_stock_to_branch();

-- Admin: set one branch's stock for a product (the total follows).
CREATE OR REPLACE FUNCTION public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE total numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set branch stock';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN RAISE EXCEPTION 'Enter a valid stock quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock) VALUES (_branch_id, _product_id, _stock)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.admin_set_branch_stock(text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_branch_stock(text, text, numeric) TO authenticated;

-- Platform switches (both OFF until an administrator turns them on).
INSERT INTO public.settings (key, value, is_public)
VALUES ('platform_features', '{"branch_routing": false, "marketplace_vendors": false}'::jsonb, true)
ON CONFLICT (key) DO NOTHING;


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
  routing_on boolean;
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
  IF _shipping_method NOT IN ('Standard', 'Express') THEN
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

  -- Pickup-only (no home delivery yet): customers collect from the godown, so no freight.
  IF subtotal < free_above AND COALESCE((
      SELECT (value->>'homeDelivery')::boolean FROM public.settings WHERE key = 'pickup_points'
    ), false) THEN
    shipping_amount := CASE WHEN _shipping_method = 'Express' THEN express_shipping ELSE standard_shipping END;
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
    _payment_method, 'Pending', 'Placed', _shipping_method, _shipping_address, target_branch
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

CREATE OR REPLACE FUNCTION public.cancel_marketplace_order(_order_no text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel this order'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.has_role(auth.uid(), 'admin')
    AND (NOT public.has_role(auth.uid(), 'customer') OR target.user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'You cannot cancel this order';
  END IF;
  IF target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN
    RAISE EXCEPTION 'Orders can only be cancelled before dispatch';
  END IF;
  IF NOT public.has_role(auth.uid(), 'admin')
    AND target.order_status NOT IN ('Placed', 'Payment Confirmed') THEN
    RAISE EXCEPTION 'Contact support to cancel an order after vendor acceptance';
  END IF;
  IF COALESCE(target.paid_amount, 0) > 0
    OR target.payment_status IN ('Paid', 'Partially Paid') THEN
    RAISE EXCEPTION 'A verified refund must be completed before cancelling a paid order';
  END IF;

  FOR line IN
    SELECT product_id, qty FROM public.order_items WHERE order_id = target.id
  LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),
        true
      ), updated_at = now()
      WHERE id = line.product_id;
  END LOOP;

  FOR allocation_row IN
    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
    FROM public.order_item_batch_allocations a
    JOIN public.order_items oi ON oi.id = a.order_item_id
    WHERE oi.order_id = target.id
      AND a.released_quantity < a.reserved_quantity
    ORDER BY a.created_at, a.id
    FOR UPDATE OF a
  LOOP
    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;
    UPDATE public.batches
      SET remaining_quantity = remaining_quantity + restore_qty,
          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END
      WHERE id = allocation_row.batch_id;
    UPDATE public.order_item_batch_allocations
      SET released_quantity = reserved_quantity
      WHERE id = allocation_row.id;
  END LOOP;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;
  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0
    WHERE id = target.id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_zoho_order_cancellation(_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE

  target public.orders%ROWTYPE;

  line record;

  allocation_row record;

  restore_qty numeric(14,2);

BEGIN

  SELECT * INTO target FROM public.orders WHERE id = _order_id FOR UPDATE;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);

  IF NOT FOUND THEN RETURN 'missing'; END IF;

  IF target.order_status = 'Cancelled' THEN RETURN 'already_cancelled'; END IF;

  -- Same limits as the admin cancellation: before dispatch, and no money taken.

  IF target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN

    RETURN 'blocked_after_dispatch';

  END IF;

  IF COALESCE(target.paid_amount, 0) > 0 OR target.payment_status IN ('Paid', 'Partially Paid') THEN

    RETURN 'blocked_paid';

  END IF;



  -- Stock goes back (and is synced to Zoho as usual: Grain Bazar is the stock master).

  FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP

    UPDATE public.catalog_products

      SET payload = jsonb_set(

        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),

        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),

        true

      ), updated_at = now()

      WHERE id = line.product_id;

  END LOOP;



  FOR allocation_row IN

    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity

    FROM public.order_item_batch_allocations a

    JOIN public.order_items oi ON oi.id = a.order_item_id

    WHERE oi.order_id = target.id AND a.released_quantity < a.reserved_quantity

    ORDER BY a.created_at, a.id

    FOR UPDATE OF a

  LOOP

    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;

    UPDATE public.batches

      SET remaining_quantity = remaining_quantity + restore_qty,

          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END

      WHERE id = allocation_row.batch_id;

    UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity

      WHERE id = allocation_row.id;

  END LOOP;



  IF target.coupon IS NOT NULL THEN

    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;

  END IF;



  -- Set only now, so the stock changes above are still queued for Zoho; the order change itself

  -- came from Zoho and is not sent back.

  PERFORM set_config('app.zoho_inbound', 'on', true);

  PERFORM set_config('app.cancel_order_workflow', 'on', true);

  UPDATE public.orders

    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0

    WHERE id = target.id;

  RETURN 'cancelled';

END

$function$;

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
  PERFORM set_config('app.branch_id', COALESCE(target_order.branch_id, ''), true);
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
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
      SELECT COALESCE(SUM(remaining_quantity), 0) INTO batch_available
        FROM public.batches WHERE product_id = target_item.product_id;
      IF batch_available >= delta THEN
        needed := delta;
        FOR batch_row IN
          SELECT id, remaining_quantity, unit_cost FROM public.batches
          WHERE product_id = target_item.product_id AND remaining_quantity > 0
          ORDER BY purchase_date ASC NULLS LAST, created_at ASC
          FOR UPDATE
        LOOP
          EXIT WHEN needed <= 0;
          taken := LEAST(needed, batch_row.remaining_quantity);
          UPDATE public.batches
            SET remaining_quantity = remaining_quantity - taken,
                status = CASE WHEN remaining_quantity - taken <= 0 THEN 'Depleted' ELSE 'Active' END
            WHERE id = batch_row.id;
          INSERT INTO public.order_item_batch_allocations (
            order_item_id, batch_id, reserved_quantity, unit_cost
          ) VALUES (target_item.id, batch_row.id, taken, batch_row.unit_cost);
          needed := needed - taken;
        END LOOP;
      END IF;
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

  UPDATE public.order_items
    SET qty = _qty,
        capacity = trim(_capacity),
        unit_price = _unit_price,
        line_total = round(_qty * _unit_price, 2)
    WHERE id = target_item.id;

  SELECT COALESCE(SUM(line_total), 0),
         COALESCE(SUM(round(line_total * gst_rate / 100, 2)), 0)
    INTO subtotal_now, gst_now
    FROM public.order_items WHERE order_id = target_order.id;
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
    'line_total', round(_qty * _unit_price, 2),
    'subtotal', subtotal_now,
    'gst_amount', gst_now,
    'total', total_now,
    'balance_due', GREATEST(0, total_now - target_order.paid_amount)
  );
END;
$function$;

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
  -- Received stock goes to the named godown (its id, code or name), else the default.
  PERFORM set_config('app.branch_id', COALESCE((
    SELECT id FROM public.branches WHERE NULLIF(trim(_warehouse), '') IN (id, code, name) LIMIT 1), ''), true);
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in the catalogue'; END IF;
  old_stock := COALESCE((product_row.payload->>'stock')::numeric,0);
  INSERT INTO public.batches(batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit_cost, purchase_date, warehouse, status)
    VALUES (trim(_batch_code), product_row.id, COALESCE(product_row.payload->>'name',product_row.id),
      product_row.payload->>'vendor', product_row.vendor_id, _quantity, _quantity, _unit_cost, _purchase_date,
      NULLIF(trim(_warehouse),''), 'Active') RETURNING id INTO batch_id;
  UPDATE public.catalog_products SET payload = jsonb_set(
      jsonb_set(payload, '{stock}', to_jsonb(old_stock + _quantity), true),
      '{updated}', to_jsonb(now()::text), true), updated_at = now()
    WHERE id = _product_id;
  RETURN batch_id;
END; $function$;
