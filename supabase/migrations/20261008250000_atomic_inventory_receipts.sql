CREATE OR REPLACE FUNCTION public.admin_receive_inventory_batch(
  _batch_code text, _product_id text, _quantity numeric, _unit_cost numeric,
  _purchase_date date, _warehouse text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE product_row public.catalog_products%ROWTYPE; batch_id uuid; old_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may receive purchase stock'; END IF;
  IF length(trim(COALESCE(_batch_code,''))) = 0 OR _quantity <= 0 OR _unit_cost <= 0 THEN
    RAISE EXCEPTION 'Enter a batch code, positive quantity, and positive unit cost';
  END IF;
  SELECT * INTO product_row FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
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
END; $$;
REVOKE ALL ON FUNCTION public.admin_receive_inventory_batch(text, text, numeric, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_receive_inventory_batch(text, text, numeric, numeric, date, text) TO authenticated;
