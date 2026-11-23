-- Zoho's own sales order number (CLK-SO-…) for each order, to show beside the invoice number in our panels (Sandesh,
-- 21 Nov 2026: "make it show Sales Order Number and Invoice number in our portal"). Written by the Zoho sync (service
-- role) each time it reads the sales order; kept in its own table so the orders guard is untouched.
BEGIN;

CREATE TABLE IF NOT EXISTS public.order_zoho_numbers (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  salesorder_number text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_zoho_numbers_order_no_idx ON public.order_zoho_numbers (order_no);
ALTER TABLE public.order_zoho_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_zoho_numbers FROM anon;
GRANT SELECT ON public.order_zoho_numbers TO authenticated;
GRANT ALL ON public.order_zoho_numbers TO service_role;

-- Admins see every number; customers their own orders' numbers.
DROP POLICY IF EXISTS order_zoho_numbers_admin_read ON public.order_zoho_numbers;
CREATE POLICY order_zoho_numbers_admin_read ON public.order_zoho_numbers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS order_zoho_numbers_customer_read ON public.order_zoho_numbers;
CREATE POLICY order_zoho_numbers_customer_read ON public.order_zoho_numbers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));

NOTIFY pgrst, 'reload schema';
COMMIT;
