-- Vendor stock counts are operational data, not listing content. A vendor may
-- set the stock of their own product without sending it back to admin review
-- (every other vendor edit still returns the product to 'pending').
-- The catalog update fires the existing Zoho enqueue trigger, so the new stock
-- also reaches Zoho on the next sync (and instantly from the app).
CREATE OR REPLACE FUNCTION public.vendor_set_product_stock(_product_id text, _stock integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Vendor sign-in is required';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN
    RAISE EXCEPTION 'Enter a valid stock quantity';
  END IF;
  v_id := public.current_vendor_id();
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  UPDATE public.catalog_products
     SET payload = jsonb_set(payload, '{stock}', to_jsonb(_stock), true)
           || jsonb_build_object('updated', to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')),
         updated_at = now()
   WHERE id = _product_id AND vendor_id = v_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.vendor_set_product_stock(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_set_product_stock(text, integer) TO authenticated;
