-- Migration: FIFO Batches and Admin-Only Pricing Security
-- Extends the batches table with remaining_quantity and unit_cost for FIFO layer calculations
-- Enforces backend RLS to restrict price and cost modifications to Administrators only

ALTER TABLE public.batches 
  ADD COLUMN IF NOT EXISTS remaining_quantity numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0;

-- Ensure RLS is active
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;

-- Drop prior permissive write policies if present
DROP POLICY IF EXISTS "batches_write_admin" ON public.batches;
DROP POLICY IF EXISTS "batches_write_vendor" ON public.batches;

-- Only authenticated users with admin role can create, update or delete purchase batches and cost layers
CREATE POLICY "batches_admin_write" ON public.batches
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Read policy allows viewing batch tracking records
DROP POLICY IF EXISTS "batches_read" ON public.batches;
CREATE POLICY "batches_read" ON public.batches
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id())
  );
