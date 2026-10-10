-- FIFO purchase batches contain warehouse unit costs and are only used by the
-- admin inventory and order-costing screens. Vendors should see their own
-- sellable catalog stock, not internal procurement cost layers.

REVOKE SELECT ON public.batches FROM anon;
GRANT SELECT ON public.batches TO authenticated;

DROP POLICY IF EXISTS "batches_read" ON public.batches;
CREATE POLICY "batches_read" ON public.batches
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
