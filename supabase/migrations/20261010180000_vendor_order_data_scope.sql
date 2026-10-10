-- Keep marketplace order lines and payment references scoped to the people
-- who need them. Vendors can see their own lines on a shared customer order;
-- customers and administrators retain the complete order view.

DROP POLICY IF EXISTS "order_items_read" ON public.order_items;
CREATE POLICY "order_items_read" ON public.order_items
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (
      public.has_role(auth.uid(), 'vendor')
      AND vendor_id = public.current_vendor_id()
      AND public.can_read_order(order_id)
    )
    OR (
      NOT public.has_role(auth.uid(), 'vendor')
      AND public.can_read_order(order_id)
    )
  );

-- Order payment status and totals remain available on the order itself.
-- Transaction references and payment method details are limited to the buyer
-- and administrators instead of every vendor on a multi-vendor order.
DROP POLICY IF EXISTS "payments_read" ON public.payments;
CREATE POLICY "payments_read" ON public.payments
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR (
      order_id IS NOT NULL
      AND NOT public.has_role(auth.uid(), 'vendor')
      AND public.can_read_order(order_id)
    )
  );
