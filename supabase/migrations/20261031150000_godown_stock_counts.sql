-- Godown stock counts by godown staff (client request, 31 Oct 2026). Every active godown employee
-- can count the stock of their own godown in the staff app (/staff). The server brings Zoho's
-- physical stock at the godown's location to the count with an inventory adjustment first (Zoho is
-- the stock master); only when Zoho accepted it does record_stock_count save the count and set the
-- godown's website stock, in one transaction. Head office sees every count (Admin > Stock Counts);
-- the godown's channel partner and its staff see their godown's counts. Counts more than 20% away
-- from Zoho's physical stock are flagged.

CREATE TABLE IF NOT EXISTS public.stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id),
  product_id text NOT NULL REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  product_name text NOT NULL DEFAULT '',
  counted numeric(14,3) NOT NULL CHECK (counted >= 0),
  zoho_physical_before numeric(14,3) NOT NULL,
  zoho_delta numeric(14,3) NOT NULL,
  site_before numeric(14,3) NOT NULL DEFAULT 0,
  site_after numeric(14,3) NOT NULL CHECK (site_after >= 0),
  reason text NOT NULL CHECK (reason IN ('daily_count', 'received', 'damaged', 'correction')),
  note text NOT NULL DEFAULT '',
  flagged boolean NOT NULL DEFAULT false,
  zoho_adjustment_id text NOT NULL DEFAULT '',
  counted_by uuid,
  counted_by_name text NOT NULL DEFAULT '',
  employee_id uuid REFERENCES public.staff_employees(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_counts_branch_idx ON public.stock_counts (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_counts_flagged_idx ON public.stock_counts (created_at DESC) WHERE flagged;

/**
 * Saves a count Zoho has already accepted and sets the godown's website stock to _site_after (no
 * longer waiting for Zoho: the count supersedes any website edit still waiting), keeping the
 * product's total stock in step, exactly as admin_set_branch_stock does. Server (service role) only.
 */
CREATE OR REPLACE FUNCTION public.record_stock_count(
  _branch_id text, _product_id text, _counted numeric, _zoho_physical_before numeric, _zoho_delta numeric,
  _site_after numeric, _reason text, _note text, _flagged boolean, _zoho_adjustment_id text,
  _counted_by uuid, _counted_by_name text, _employee_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  product_payload jsonb;
  before_stock numeric;
  total numeric;
  new_id uuid;
BEGIN
  IF _counted IS NULL OR _counted < 0 OR _site_after IS NULL OR _site_after < 0 THEN RAISE EXCEPTION 'Invalid stock count'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  SELECT payload INTO product_payload FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;

  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _site_after, false)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = false, updated_at = now();
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);

  INSERT INTO public.stock_counts (branch_id, product_id, product_name, counted, zoho_physical_before, zoho_delta,
    site_before, site_after, reason, note, flagged, zoho_adjustment_id, counted_by, counted_by_name, employee_id)
  VALUES (_branch_id, _product_id, COALESCE(product_payload->>'name', _product_id), _counted, _zoho_physical_before, _zoho_delta,
    COALESCE(before_stock, 0), _site_after, _reason, left(COALESCE(_note, ''), 200), COALESCE(_flagged, false),
    COALESCE(_zoho_adjustment_id, ''), _counted_by, COALESCE(_counted_by_name, ''), _employee_id)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stock_count(text, text, numeric, numeric, numeric, numeric, text, text, boolean, text, uuid, text, uuid) TO service_role;

-- Access: admins read every count; a channel partner and the active staff of a godown read that
-- godown's counts. Counts are written by the server only.
ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_counts_admin ON public.stock_counts;
CREATE POLICY stock_counts_admin ON public.stock_counts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS stock_counts_partner ON public.stock_counts;
CREATE POLICY stock_counts_partner ON public.stock_counts FOR SELECT TO authenticated
  USING (branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS stock_counts_staff ON public.stock_counts;
CREATE POLICY stock_counts_staff ON public.stock_counts FOR SELECT TO authenticated
  USING (branch_id = (SELECT branch_id FROM public.staff_employees WHERE user_id = auth.uid() AND status = 'active'));

REVOKE ALL ON public.stock_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_counts TO authenticated;
GRANT ALL ON public.stock_counts TO service_role;

NOTIFY pgrst, 'reload schema';
