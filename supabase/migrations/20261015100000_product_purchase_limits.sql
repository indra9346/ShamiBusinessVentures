-- Store and validate the administrator-configured customer purchase cap in
-- the catalog product payload. Existing products without a cap retain the
-- storefront default of 120 units per order.
CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND public.has_role(auth.uid(), 'vendor')
    AND NOT public.has_role(auth.uid(), 'admin')
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.payload->'price' IS DISTINCT FROM OLD.payload->'price'
      OR NEW.payload->'mrp' IS DISTINCT FROM OLD.payload->'mrp'
      OR NEW.payload->'purchasePrice' IS DISTINCT FROM OLD.payload->'purchasePrice'
      OR NEW.payload->'maxPurchaseQuantity' IS DISTINCT FROM OLD.payload->'maxPurchaseQuantity'
    ) THEN
    RAISE EXCEPTION 'Only administrators may change catalog pricing, status, or customer purchase limits';
  END IF;

  IF TG_OP = 'INSERT'
    AND public.has_role(auth.uid(), 'vendor')
    AND NOT public.has_role(auth.uid(), 'admin')
    AND NEW.payload ? 'maxPurchaseQuantity' THEN
    RAISE EXCEPTION 'Only administrators may set customer purchase limits';
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
$$;

-- Enforce the purchase cap inside the same database transaction that creates
-- order lines, so an old tab or a direct RPC call cannot bypass the storefront.
CREATE OR REPLACE FUNCTION public.enforce_catalog_product_purchase_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  product_payload jsonb;
  purchase_limit integer := 120;
  already_requested integer := 0;
BEGIN
  SELECT payload INTO product_payload
    FROM public.catalog_products
    WHERE id = NEW.product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This product is unavailable';
  END IF;

  IF product_payload ? 'maxPurchaseQuantity'
    AND (product_payload->>'maxPurchaseQuantity') ~ '^[1-9][0-9]{0,5}$' THEN
    purchase_limit := LEAST((product_payload->>'maxPurchaseQuantity')::integer, 100000);
  END IF;

  SELECT COALESCE(SUM(qty), 0)::integer INTO already_requested
    FROM public.order_items
    WHERE order_id = NEW.order_id AND product_id = NEW.product_id;

  IF NEW.qty IS NULL OR NEW.qty < 1 OR already_requested + NEW.qty > purchase_limit THEN
    RAISE EXCEPTION 'Maximum purchase quantity for this product is %', purchase_limit;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_catalog_product_purchase_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS order_items_enforce_product_purchase_limit ON public.order_items;
CREATE TRIGGER order_items_enforce_product_purchase_limit
  BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_catalog_product_purchase_limit();
