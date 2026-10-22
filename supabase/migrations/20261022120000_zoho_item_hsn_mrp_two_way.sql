-- Step 1 of the Zoho plan: product details sync both ways, now including HSN and MRP.
-- Zoho -> Grain Bazar also applies the item's HSN (hsn_or_sac) and the Zoho Commerce MRP
-- (label_rate, folded into the item by the sync when it changed on the Commerce variant).
-- A blank HSN or a zero MRP from Zoho never clears the website's value.

CREATE OR REPLACE FUNCTION public.apply_zoho_catalog_item(
  _product_id text, _item jsonb, _expected_updated_at timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  item_rate numeric;
  item_purchase_rate numeric;
  item_reorder_level numeric;
  item_label_rate numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catalog_products WHERE id = _product_id) THEN
    RAISE EXCEPTION 'Mapped Grain Bazar product no longer exists';
  END IF;
  item_rate := CASE WHEN COALESCE(_item->>'rate', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'rate')::numeric END;
  item_purchase_rate := CASE WHEN COALESCE(_item->>'purchase_rate', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'purchase_rate')::numeric END;
  item_reorder_level := CASE WHEN COALESCE(_item->>'reorder_level', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'reorder_level')::numeric END;
  item_label_rate := CASE WHEN COALESCE(_item->>'label_rate', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (_item->>'label_rate')::numeric END;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.catalog_products
  SET active = CASE lower(COALESCE(_item->>'status', ''))
        WHEN 'active' THEN true WHEN 'inactive' THEN false ELSE active END,
      payload = payload || jsonb_strip_nulls(jsonb_build_object(
        'name', NULLIF(trim(COALESCE(_item->>'name', '')), ''),
        'sku', NULLIF(trim(COALESCE(_item->>'sku', '')), ''),
        'price', CASE WHEN item_rate IS NOT NULL THEN to_jsonb(item_rate) END,
        'purchasePrice', CASE WHEN item_purchase_rate IS NOT NULL THEN to_jsonb(item_purchase_rate) END,
        'minimumStock', CASE WHEN item_reorder_level IS NOT NULL THEN to_jsonb(item_reorder_level) END,
        'description', NULLIF(trim(COALESCE(_item->>'description', '')), ''),
        'hsn', NULLIF(trim(COALESCE(_item->>'hsn_or_sac', '')), ''),
        'mrp', CASE WHEN item_label_rate > 0 THEN to_jsonb(item_label_rate) END
      )),
      updated_at = now()
  WHERE id = _product_id
    AND updated_at = _expected_updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grain Bazar product changed while applying the Zoho item update';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_zoho_catalog_item(text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_catalog_item(text, jsonb, timestamptz) TO service_role;

-- Only Shami's own products (seller VENDOR-001) sync with Zoho items. Other sellers' products
-- stay website-only. An empty list would mean every seller, as before.
INSERT INTO public.settings (key, value, is_public)
VALUES ('zoho_item_sync_vendor_ids', '["VENDOR-001"]'::jsonb, false)
ON CONFLICT (key) DO NOTHING;
