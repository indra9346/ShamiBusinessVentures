-- Queue a Zoho catalogue sync when stock, image or HSN changes, not only name/price fields.
-- Grain Bazar is the stock master: the outbound worker adjusts Zoho stock on hand to match.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_catalog_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  current_fields jsonb;
  previous_fields jsonb;
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' OR NEW.vendor_id LIKE 'zoho:%' THEN
    RETURN NEW;
  END IF;
  current_fields := jsonb_build_object(
    'name', NEW.payload->'name', 'sku', NEW.payload->'sku', 'price', NEW.payload->'price',
    'mrp', NEW.payload->'mrp', 'purchasePrice', NEW.payload->'purchasePrice',
    'minimumStock', NEW.payload->'minimumStock', 'description', NEW.payload->'description',
    'weight', NEW.payload->'weight', 'stock', NEW.payload->'stock', 'image', NEW.payload->'image',
    'hsn', NEW.payload->'hsn', 'category', NEW.category, 'status', NEW.status, 'active', NEW.active
  );
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN PERFORM public.enqueue_zoho_sync('catalog', NEW.id); END IF;
    RETURN NEW;
  END IF;
  previous_fields := jsonb_build_object(
    'name', OLD.payload->'name', 'sku', OLD.payload->'sku', 'price', OLD.payload->'price',
    'mrp', OLD.payload->'mrp', 'purchasePrice', OLD.payload->'purchasePrice',
    'minimumStock', OLD.payload->'minimumStock', 'description', OLD.payload->'description',
    'weight', OLD.payload->'weight', 'stock', OLD.payload->'stock', 'image', OLD.payload->'image',
    'hsn', OLD.payload->'hsn', 'category', OLD.category, 'status', OLD.status, 'active', OLD.active
  );
  IF current_fields IS DISTINCT FROM previous_fields THEN
    PERFORM public.enqueue_zoho_sync('catalog', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_catalog_change() FROM PUBLIC, anon, authenticated;
