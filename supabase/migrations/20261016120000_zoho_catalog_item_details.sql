-- Queue a Zoho catalogue sync when the Zoho item details set in Admin > Products change
-- (brand, manufacturer, unit, GST, trade-rate pricing), not only name/price/stock fields.
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
    'hsn', NEW.payload->'hsn', 'brand', NEW.payload->'brand', 'manufacturer', NEW.payload->'manufacturer',
    'unit', NEW.payload->'unit', 'gst', NEW.payload->'gst', 'ratePricing', NEW.payload->'ratePricing',
    'category', NEW.category, 'status', NEW.status, 'active', NEW.active
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
    'hsn', OLD.payload->'hsn', 'brand', OLD.payload->'brand', 'manufacturer', OLD.payload->'manufacturer',
    'unit', OLD.payload->'unit', 'gst', OLD.payload->'gst', 'ratePricing', OLD.payload->'ratePricing',
    'category', OLD.category, 'status', OLD.status, 'active', OLD.active
  );
  IF current_fields IS DISTINCT FROM previous_fields THEN
    PERFORM public.enqueue_zoho_sync('catalog', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_catalog_change() FROM PUBLIC, anon, authenticated;
