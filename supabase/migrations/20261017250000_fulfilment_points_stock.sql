-- Where each marketplace vendor's items are fulfilled (public, so the storefront can show the right
-- stock), and stock changes without an explicit branch go to the vendor's fulfilment point.

CREATE OR REPLACE FUNCTION public.vendor_fulfilment_points()
RETURNS TABLE (vendor_id text, branch_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT vs.vendor_id, public.vendor_fulfilment_branch(vs.vendor_id)
  FROM public.vendor_settings vs
  WHERE vs.key = 'fulfilment' AND private.marketplace_enabled()
    AND public.vendor_fulfilment_branch(vs.vendor_id) IS NOT NULL
$$;
GRANT EXECUTE ON FUNCTION public.vendor_fulfilment_points() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.route_stock_to_branch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_total numeric := COALESCE((NEW.payload->>'stock')::numeric, 0);
  old_total numeric := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE((OLD.payload->>'stock')::numeric, 0) END;
  target text;
  branch_sum numeric;
BEGIN
  IF NEW.vendor_id LIKE 'zoho:%' OR current_setting('app.branch_stock_sync', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND new_total = old_total THEN RETURN NEW; END IF;
  -- The order's / receipt's branch, else the vendor's fulfilment point, else the default godown.
  target := COALESCE(NULLIF(current_setting('app.branch_id', true), ''),
                     public.vendor_fulfilment_branch(NEW.vendor_id),
                     public.default_branch_id());
  IF target IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.branch_stock (branch_id, product_id, stock)
    VALUES (target, NEW.id, GREATEST(0, new_total - old_total))
  ON CONFLICT (branch_id, product_id) DO UPDATE
    SET stock = GREATEST(0, public.branch_stock.stock + (new_total - old_total)), updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO branch_sum FROM public.branch_stock WHERE product_id = NEW.id;
  IF branch_sum <> new_total THEN
    PERFORM set_config('app.branch_stock_sync', 'on', true);
    UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(branch_sum), true) WHERE id = NEW.id;
    PERFORM set_config('app.branch_stock_sync', 'off', true);
  END IF;
  RETURN NEW;
END $$;
