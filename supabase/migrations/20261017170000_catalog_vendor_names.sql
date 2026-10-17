-- A product's seller name always comes from its vendor's profile (vendor_id is the source of
-- truth). Old demo names ("Deccan Oil Company", ...) were left on some products and copied
-- onto order lines, so invoices showed the wrong seller.

CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  is_vendor boolean := public.has_role(auth.uid(), 'vendor') AND NOT public.has_role(auth.uid(), 'admin');
  vendor_name text;
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

  -- Seller name from the vendor profile (Zoho mirror rows keep their own).
  IF NEW.vendor_id IS NOT NULL AND NEW.vendor_id NOT LIKE 'zoho:%' THEN
    SELECT NULLIF(trim(company), '') INTO vendor_name FROM public.profiles WHERE vendor_id = NEW.vendor_id LIMIT 1;
    IF vendor_name IS NOT NULL THEN
      NEW.payload := jsonb_set(NEW.payload, '{vendor}', to_jsonb(vendor_name), true);
    END IF;
  END IF;

  NEW.payload := jsonb_set(NEW.payload, '{id}', to_jsonb(NEW.id), true);
  NEW.payload := jsonb_set(NEW.payload, '{vendorId}', to_jsonb(NEW.vendor_id), true);
  NEW.payload := jsonb_set(NEW.payload, '{category}', to_jsonb(NEW.category), true);
  NEW.payload := jsonb_set(NEW.payload, '{status}', to_jsonb(NEW.status), true);
  NEW.payload := jsonb_set(NEW.payload, '{active}', to_jsonb(NEW.active), true);
  RETURN NEW;
END;
$function$;

-- A vendor renaming their business renames it on their products too.
CREATE OR REPLACE FUNCTION public.sync_vendor_name_to_catalog()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.vendor_id IS NOT NULL AND NULLIF(trim(NEW.company), '') IS NOT NULL
    AND NEW.company IS DISTINCT FROM OLD.company THEN
    UPDATE public.catalog_products
       SET payload = jsonb_set(payload, '{vendor}', to_jsonb(trim(NEW.company)), true)
     WHERE vendor_id = NEW.vendor_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_sync_vendor_name ON public.profiles;
CREATE TRIGGER profiles_sync_vendor_name AFTER UPDATE OF company ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_vendor_name_to_catalog();

-- Correct existing rows. The order-line fix is a label only (Zoho lines use item IDs), so it
-- is marked as an internal change and does not re-send those orders to Zoho.
DO $$
BEGIN
  UPDATE public.catalog_products c
     SET payload = jsonb_set(c.payload, '{vendor}', to_jsonb(trim(p.company)), true)
    FROM public.profiles p
   WHERE p.vendor_id = c.vendor_id AND c.vendor_id NOT LIKE 'zoho:%'
     AND NULLIF(trim(p.company), '') IS NOT NULL
     AND (c.payload->>'vendor') IS DISTINCT FROM trim(p.company);

  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.order_items oi
     SET vendor = trim(p.company)
    FROM public.profiles p
   WHERE p.vendor_id = oi.vendor_id AND NULLIF(trim(p.company), '') IS NOT NULL
     AND oi.vendor IS DISTINCT FROM trim(p.company);
END $$;
