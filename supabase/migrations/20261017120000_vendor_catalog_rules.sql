-- Vendor catalogue rules, in one place:
--  * A vendor edit of an approved or rejected product resubmits it ('pending') for admin
--    review. Before this, the live guard refused every vendor status change, so vendors
--    could not save edits to approved products at all.
--  * Price, MRP, cost, GST and purchase limits stay admin-only.
--  * Rating, review count, units sold and reserved stock are system figures; a vendor
--    can never write them (new vendor products start at zero).
--  * A vendor may pause an approved product at once (and resume only a pause they made);
--    stock updates go through vendor_set_product_stock.
--  * A vendor may delete only a product that has never been ordered or reviewed, so
--    order history and reviews cannot be wiped by deleting and re-listing.

CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  is_vendor boolean := public.has_role(auth.uid(), 'vendor') AND NOT public.has_role(auth.uid(), 'admin');
BEGIN
  IF TG_OP = 'UPDATE' AND is_vendor AND (
      (NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status IN ('approved', 'rejected') AND NEW.status = 'pending'))
      OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
      OR NEW.payload->'price' IS DISTINCT FROM OLD.payload->'price'
      OR NEW.payload->'mrp' IS DISTINCT FROM OLD.payload->'mrp'
      OR NEW.payload->'purchasePrice' IS DISTINCT FROM OLD.payload->'purchasePrice'
      OR NEW.payload->'gst' IS DISTINCT FROM OLD.payload->'gst'
      OR NEW.payload->'maxPurchaseQuantity' IS DISTINCT FROM OLD.payload->'maxPurchaseQuantity'
    ) THEN
    RAISE EXCEPTION 'Only administrators may change catalog pricing, tax, status, or customer purchase limits';
  END IF;

  IF TG_OP = 'INSERT' AND is_vendor AND NEW.payload ? 'maxPurchaseQuantity' THEN
    RAISE EXCEPTION 'Only administrators may set customer purchase limits';
  END IF;

  IF is_vendor THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.payload := (NEW.payload - ARRAY['rating', 'reviews', 'sold', 'reserved'])
        || jsonb_strip_nulls(jsonb_build_object(
          'rating', OLD.payload->'rating', 'reviews', OLD.payload->'reviews',
          'sold', OLD.payload->'sold', 'reserved', OLD.payload->'reserved'));
    ELSE
      NEW.payload := NEW.payload || '{"rating": 0, "reviews": 0, "sold": 0, "reserved": 0}'::jsonb;
    END IF;
  END IF;

  IF NEW.payload ? 'maxPurchaseQuantity' AND (
    jsonb_typeof(NEW.payload->'maxPurchaseQuantity') IS DISTINCT FROM 'number'
    OR (NEW.payload->>'maxPurchaseQuantity') !~ '^[1-9][0-9]{0,5}$'
    OR CASE
      WHEN (NEW.payload->>'maxPurchaseQuantity') ~ '^[1-9][0-9]{0,5}$'
        THEN (NEW.payload->>'maxPurchaseQuantity')::numeric > 100000
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'Maximum customer purchase quantity must be a whole number from 1 to 100,000';
  END IF;

  NEW.payload := jsonb_set(NEW.payload, '{id}', to_jsonb(NEW.id), true);
  NEW.payload := jsonb_set(NEW.payload, '{vendorId}', to_jsonb(NEW.vendor_id), true);
  NEW.payload := jsonb_set(NEW.payload, '{category}', to_jsonb(NEW.category), true);
  NEW.payload := jsonb_set(NEW.payload, '{status}', to_jsonb(NEW.status), true);
  NEW.payload := jsonb_set(NEW.payload, '{active}', to_jsonb(NEW.active), true);
  RETURN NEW;
END;
$function$;

-- Pause / resume without review. Resuming is allowed only for a pause the vendor made,
-- so a product an administrator switched off stays off.
CREATE OR REPLACE FUNCTION public.vendor_set_product_active(_product_id text, _active boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text; target public.catalog_products%ROWTYPE;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION public.vendor_set_product_active(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_set_product_active(text, boolean) TO authenticated;

DROP POLICY IF EXISTS catalog_products_delete ON public.catalog_products;
CREATE POLICY catalog_products_delete ON public.catalog_products
  FOR DELETE TO authenticated USING (
    public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()
      AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.product_id = catalog_products.id)
      AND NOT EXISTS (SELECT 1 FROM public.product_reviews r WHERE r.product_id = catalog_products.id))
  );
