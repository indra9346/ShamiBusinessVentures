-- A return can only be requested for an order the customer has received (Delivered /
-- picked up). Before this, a return could be filed on an order that was just placed.
DROP POLICY IF EXISTS return_requests_customer_create ON public.return_requests;
CREATE POLICY return_requests_customer_create ON public.return_requests
  FOR INSERT TO authenticated WITH CHECK (
    customer_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND private.customer_account_is_active()
    AND status = 'Requested'
    AND refund_status = 'Pending'
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.id = return_requests.order_id
        AND o.user_id = auth.uid()
        AND oi.id = return_requests.order_item_id
        AND oi.product_id = return_requests.product_id
        AND oi.vendor_id = return_requests.vendor_id
        AND o.order_status = 'Delivered'
        AND return_requests.quantity <= oi.qty
        AND return_requests.amount = oi.unit_price * return_requests.quantity::numeric
        AND return_requests.quantity + COALESCE((
          SELECT sum(previous.quantity) FROM public.return_requests previous
          WHERE previous.order_item_id = oi.id AND previous.status <> 'Rejected'
        ), 0) <= oi.qty
    )
  );
