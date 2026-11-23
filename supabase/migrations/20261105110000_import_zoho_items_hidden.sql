-- A brand-new item made in Zoho comes to the website hidden, for an admin to check and switch on.
-- The product and its Zoho link are made together. app.zoho_inbound keeps this out of the Zoho queue,
-- so nothing is sent back to Zoho. Changes no existing row.
CREATE OR REPLACE FUNCTION public.import_zoho_catalog_item(
  _id text, _vendor_id text, _category text, _payload jsonb,
  _zoho_item_id text, _zoho_modified_at timestamptz, _fingerprint text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- An admin deleted this one and the deletion is still on its way to Zoho, or it's already here.
  IF EXISTS (SELECT 1 FROM public.zoho_catalog_tombstones WHERE zoho_item_id = _zoho_item_id)
     OR EXISTS (SELECT 1 FROM public.zoho_item_links WHERE zoho_item_id = _zoho_item_id) THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload)
  VALUES (_id, _vendor_id, _category, 'pending', false, _payload)
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.zoho_item_links (product_id, zoho_item_id, last_polled_at, last_zoho_modified_at, app_fingerprint)
  VALUES (_id, _zoho_item_id, now(), _zoho_modified_at, _fingerprint);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.import_zoho_catalog_item(text, text, text, jsonb, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_zoho_catalog_item(text, text, text, jsonb, text, timestamptz, text) TO service_role;

NOTIFY pgrst, 'reload schema';
