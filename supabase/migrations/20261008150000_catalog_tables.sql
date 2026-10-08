-- Persistent marketplace catalog. Product and category details stay in JSONB so
-- the existing storefront model can evolve without losing typed catalog fields.
CREATE TABLE IF NOT EXISTS public.catalog_products (
  id text PRIMARY KEY,
  vendor_id text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('approved', 'pending', 'rejected')),
  active boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_products_public_idx
  ON public.catalog_products (category, status, active);
CREATE INDEX IF NOT EXISTS catalog_products_vendor_idx
  ON public.catalog_products (vendor_id);

CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND public.has_role(auth.uid(), 'vendor')
    AND NOT public.has_role(auth.uid(), 'admin')
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.payload->'price' IS DISTINCT FROM OLD.payload->'price'
      OR NEW.payload->'mrp' IS DISTINCT FROM OLD.payload->'mrp'
      OR NEW.payload->'purchasePrice' IS DISTINCT FROM OLD.payload->'purchasePrice'
    ) THEN
    RAISE EXCEPTION 'Only administrators may change catalog pricing';
  END IF;
  NEW.payload := jsonb_set(NEW.payload, '{id}', to_jsonb(NEW.id), true);
  NEW.payload := jsonb_set(NEW.payload, '{vendorId}', to_jsonb(NEW.vendor_id), true);
  NEW.payload := jsonb_set(NEW.payload, '{category}', to_jsonb(NEW.category), true);
  NEW.payload := jsonb_set(NEW.payload, '{status}', to_jsonb(NEW.status), true);
  NEW.payload := jsonb_set(NEW.payload, '{active}', to_jsonb(NEW.active), true);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS catalog_products_payload_sync ON public.catalog_products;
CREATE TRIGGER catalog_products_payload_sync
  BEFORE INSERT OR UPDATE ON public.catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.sync_catalog_product_payload();

ALTER TABLE public.catalog_products ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.catalog_products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.catalog_products TO authenticated;

DROP POLICY IF EXISTS catalog_products_public_read ON public.catalog_products;
CREATE POLICY catalog_products_public_read ON public.catalog_products
  FOR SELECT TO anon
  USING (status = 'approved' AND active);
DROP POLICY IF EXISTS catalog_products_authenticated_read ON public.catalog_products;
CREATE POLICY catalog_products_authenticated_read ON public.catalog_products
  FOR SELECT TO authenticated
  USING ((status = 'approved' AND active) OR public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));

DROP POLICY IF EXISTS catalog_products_vendor_insert ON public.catalog_products;
CREATE POLICY catalog_products_vendor_insert ON public.catalog_products
  FOR INSERT TO authenticated
  WITH CHECK (
    (public.has_role(auth.uid(), 'admin'))
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()
      AND status = 'pending')
  );

DROP POLICY IF EXISTS catalog_products_manage ON public.catalog_products;
CREATE POLICY catalog_products_manage ON public.catalog_products
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()))
  WITH CHECK (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));

DROP POLICY IF EXISTS catalog_products_delete ON public.catalog_products;
CREATE POLICY catalog_products_delete ON public.catalog_products
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));

CREATE TABLE IF NOT EXISTS public.store_categories (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_categories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.store_categories TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.store_categories TO authenticated;

DROP POLICY IF EXISTS store_categories_public_read ON public.store_categories;
CREATE POLICY store_categories_public_read ON public.store_categories
  FOR SELECT TO anon
  USING (enabled);
DROP POLICY IF EXISTS store_categories_authenticated_read ON public.store_categories;
CREATE POLICY store_categories_authenticated_read ON public.store_categories
  FOR SELECT TO authenticated
  USING (enabled OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS store_categories_admin_write ON public.store_categories;
CREATE POLICY store_categories_admin_write ON public.store_categories
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'catalog_products') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.catalog_products;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'store_categories') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.store_categories;
    END IF;
  END IF;
END $$;

-- Orders are created atomically from current catalog prices and stock. The
-- browser never supplies authoritative totals or payment confirmation.
CREATE OR REPLACE FUNCTION public.place_marketplace_order(
  _order_no text,
  _target_user_id uuid,
  _customer_name text,
  _customer_email text,
  _customer_phone text,
  _customer_gstin text,
  _shipping_address jsonb,
  _shipping_method text,
  _payment_method text,
  _items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  items_json jsonb := '[]'::jsonb;
  created_order_id uuid;
  batch_row record;
  qty_to_allocate numeric(14,2);
  batch_take numeric(14,2);
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
    stock_now := COALESCE((item_product.payload->>'stock')::numeric, 0);
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
      'qty', qty,
      'unit_price', product_price,
      'gst_rate', product_gst,
      'line_total', product_price * qty
    ));
  END LOOP;

  IF subtotal < free_above THEN
    shipping_amount := CASE WHEN _shipping_method = 'Express' THEN express_shipping ELSE standard_shipping END;
  END IF;
  order_total := subtotal + gst_amount + shipping_amount;

  INSERT INTO public.orders (
    order_no, user_id, customer_name, customer_email, customer_phone, customer_gstin,
    vendor_ids, subtotal, discount, gst_amount, shipping, total, advance_due,
    balance_due, paid_amount, payment_method, payment_status, order_status,
    shipping_method, shipping_address
  ) VALUES (
    _order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
    profile_phone, profile_gstin,
    ARRAY(SELECT DISTINCT value->>'vendor_id' FROM jsonb_array_elements(items_json)),
    subtotal, 0, gst_amount, shipping_amount, order_total, 0, order_total, 0,
    _payment_method, 'Pending', 'Placed', _shipping_method, _shipping_address
  ) RETURNING id INTO created_order_id;

  INSERT INTO public.order_items (
    order_id, product_id, product_name, sku, vendor, vendor_id, qty,
    unit_price, gst_rate, line_total
  )
  SELECT created_order_id, value->>'product_id', value->>'product_name', value->>'sku',
         value->>'vendor', value->>'vendor_id', (value->>'qty')::integer,
         (value->>'unit_price')::numeric, (value->>'gst_rate')::numeric,
         (value->>'line_total')::numeric
    FROM jsonb_array_elements(items_json);

  FOR line IN SELECT value FROM jsonb_array_elements(items_json)
  LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - (line->>'qty')::numeric), true),
        '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + (line->>'qty')::numeric), true
      ), updated_at = now()
      WHERE id = line->>'product_id';

    IF (SELECT COALESCE(SUM(remaining_quantity), 0) FROM public.batches
        WHERE product_id = line->>'product_id' AND remaining_quantity > 0) >= (line->>'qty')::numeric THEN
      qty_to_allocate := (line->>'qty')::numeric;
      FOR batch_row IN
        SELECT id, remaining_quantity FROM public.batches
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
$$;

REVOKE ALL ON FUNCTION public.place_marketplace_order(text, uuid, text, text, text, text, jsonb, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_marketplace_order(text, uuid, text, text, text, text, jsonb, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_profile_email_from_auth()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = COALESCE(NEW.email, ''), updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sync_profile_email_after_auth_email_change ON auth.users;
CREATE TRIGGER sync_profile_email_after_auth_email_change
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_email_from_auth();

-- Keep clients from changing order totals, ownership, item lines, or payment
-- records directly. Authenticated clients may only request an allowed status
-- change; the trigger enforces the caller's role and row scope.
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM authenticated;
GRANT UPDATE (order_status, shipping_method) ON public.orders TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.order_items FROM authenticated;
GRANT SELECT ON public.order_items TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM authenticated;
GRANT SELECT ON public.payments TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_order_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;
  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;
  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids)
    AND NEW.order_status IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This account is not allowed to make that order status change';
END $$;

DROP TRIGGER IF EXISTS orders_guard_mutation ON public.orders;
CREATE TRIGGER orders_guard_mutation
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_mutation();
