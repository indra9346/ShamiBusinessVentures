-- Track and authorize fulfillment independently for each vendor on a shared order.
CREATE TABLE public.order_vendor_fulfillments (
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  vendor_id text NOT NULL,
  status text NOT NULL DEFAULT 'Placed'
    CHECK (status IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered', 'Cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, vendor_id)
);
CREATE INDEX order_vendor_fulfillments_vendor_idx
  ON public.order_vendor_fulfillments (vendor_id, updated_at DESC);

ALTER TABLE public.order_vendor_fulfillments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_vendor_fulfillments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_vendor_fulfillments TO authenticated;
GRANT ALL ON public.order_vendor_fulfillments TO service_role;
CREATE POLICY order_vendor_fulfillments_read ON public.order_vendor_fulfillments
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id())
    OR (public.has_role(auth.uid(), 'customer') AND EXISTS (
      SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()
    ))
  );

INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status)
SELECT DISTINCT o.id, oi.vendor_id,
  CASE WHEN o.order_status = 'Awaiting Payment' THEN 'Placed'
    WHEN o.order_status IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered', 'Cancelled')
      THEN o.order_status
    ELSE 'Placed'
  END
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
WHERE NULLIF(trim(oi.vendor_id), '') IS NOT NULL
ON CONFLICT (order_id, vendor_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_order_vendor_fulfillment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE initial_status text;
BEGIN
  IF NULLIF(trim(NEW.vendor_id), '') IS NULL THEN RETURN NEW; END IF;
  SELECT CASE WHEN order_status = 'Awaiting Payment' THEN 'Placed'
    WHEN order_status IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered', 'Cancelled')
      THEN order_status
    ELSE 'Placed'
  END INTO initial_status
  FROM public.orders WHERE id = NEW.order_id;
  IF initial_status IS NULL THEN RAISE EXCEPTION 'Order not found for fulfillment line'; END IF;
  INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status)
    VALUES (NEW.order_id, NEW.vendor_id, initial_status)
    ON CONFLICT (order_id, vendor_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_order_vendor_fulfillment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER order_items_ensure_vendor_fulfillment
  AFTER INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.ensure_order_vendor_fulfillment();

CREATE OR REPLACE FUNCTION public.recalculate_marketplace_order_status(_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE next_status text;
BEGIN
  SELECT COALESCE(
    (SELECT f.status
     FROM public.order_vendor_fulfillments f
     WHERE f.order_id = _order_id AND f.status <> 'Cancelled'
     ORDER BY CASE f.status
       WHEN 'Placed' THEN 1 WHEN 'Payment Confirmed' THEN 2 WHEN 'Accepted' THEN 3
       WHEN 'Packed' THEN 4 WHEN 'Dispatched' THEN 5 WHEN 'Out for Delivery' THEN 6
       WHEN 'Delivered' THEN 7 ELSE 99 END
     LIMIT 1),
    CASE WHEN EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f WHERE f.order_id = _order_id
    ) THEN 'Cancelled' END
  ) INTO next_status;
  IF next_status IS NULL THEN RETURN; END IF;
  UPDATE public.orders
    SET order_status = next_status
    WHERE id = _order_id AND order_status IS DISTINCT FROM next_status;
END;
$$;
REVOKE ALL ON FUNCTION public.recalculate_marketplace_order_status(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_marketplace_order_after_fulfillment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF current_setting('app.syncing_vendor_fulfillments', true) = 'on' THEN RETURN NEW; END IF;
    PERFORM public.recalculate_marketplace_order_status(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_marketplace_order_after_fulfillment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER order_vendor_fulfillments_refresh_order
  AFTER UPDATE OF status ON public.order_vendor_fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.refresh_marketplace_order_after_fulfillment();

CREATE OR REPLACE FUNCTION public.sync_order_vendor_fulfillments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE syncing_setting text;
BEGIN
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  syncing_setting := COALESCE(current_setting('app.syncing_vendor_fulfillments', true), 'off');
  IF NEW.order_status = 'Cancelled' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = 'Cancelled', updated_at = now()
      WHERE order_id = NEW.id AND status <> 'Cancelled';
  ELSIF public.has_role(auth.uid(), 'admin') THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = NEW.order_status, updated_at = now()
      WHERE order_id = NEW.id AND status IS DISTINCT FROM NEW.order_status;
  ELSIF OLD.order_status IN ('Placed', 'Awaiting Payment') AND NEW.order_status = 'Payment Confirmed' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = 'Payment Confirmed', updated_at = now()
      WHERE order_id = NEW.id AND status IN ('Placed', 'Awaiting Payment');
  END IF;
  PERFORM set_config('app.syncing_vendor_fulfillments', COALESCE(syncing_setting, 'off'), true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_order_vendor_fulfillments() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER orders_sync_vendor_fulfillments
  AFTER UPDATE OF order_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_vendor_fulfillments();

-- Status changes must go through role-checked RPCs so vendors cannot write the
-- shared parent status instead of their own fulfillment row.
REVOKE UPDATE (order_status) ON public.orders FROM authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_order_status(_order_no text, _status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE target public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set the shared order status';
  END IF;
  IF _status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION 'Unsupported order status';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot be reopened'; END IF;
  UPDATE public.orders SET order_status = _status WHERE id = target.id AND order_status IS DISTINCT FROM _status;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_order_status(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_order_status(text, text) TO authenticated;

-- A vendor advances only its own shipment. The parent order stays at the least
-- advanced vendor status until every vendor reaches the next stage.
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE required_advance numeric(14,2);
BEGIN
  IF OLD.order_status = 'Cancelled' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  IF NEW.order_status = 'Cancelled' AND EXISTS (
    SELECT 1 FROM public.order_vendor_fulfillments f
    WHERE f.order_id = OLD.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Orders cannot be cancelled after any vendor has dispatched';
  END IF;

  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;

  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND NEW.order_status = 'Cancelled'
    AND EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    ) THEN
    RAISE EXCEPTION 'Customer cancellation is unavailable after a vendor has started fulfilment';
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed')
    AND NEW.order_status = 'Cancelled'
    AND COALESCE(OLD.paid_amount, 0) = 0
    AND OLD.payment_status NOT IN ('Paid', 'Partially Paid')
    AND NEW.advance_due = 0
    AND NEW.balance_due = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    )
    AND (to_jsonb(NEW) - ARRAY['order_status','advance_due','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','advance_due','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;

  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids) THEN
    required_advance := round(OLD.total * COALESCE((
      SELECT NULLIF(value->>'advance_percent', '')::numeric
      FROM public.settings WHERE key = 'order'
    ), 30) / 100, 2);
    IF OLD.order_status = 'Payment Confirmed' AND NEW.order_status = 'Accepted'
      AND OLD.paid_amount >= required_advance THEN
      RETURN NEW;
    END IF;
    IF (OLD.order_status = 'Accepted' AND NEW.order_status = 'Packed')
      OR (OLD.order_status = 'Packed' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Dispatched')
      OR (OLD.order_status = 'Dispatched' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Out for Delivery')
      OR (OLD.order_status = 'Out for Delivery' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Delivered') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Vendor order updates must follow the next allowed step, meet the required advance, and be fully paid before dispatch';
END
$$;

CREATE OR REPLACE FUNCTION public.vendor_update_order_fulfillment(_order_no text, _status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target public.orders%ROWTYPE;
  current_status text;
  vendor text;
  vendor_name text;
  required_advance numeric(14,2);
  valid_transition boolean := false;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Only an authenticated vendor can update this fulfillment';
  END IF;
  vendor := public.current_vendor_id();
  IF NULLIF(trim(vendor), '') IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  IF NOT private.vendor_account_is_active(vendor) THEN RAISE EXCEPTION 'Your vendor account is not active'; END IF;
  SELECT COALESCE(NULLIF(company, ''), NULLIF(full_name, ''), 'Vendor') INTO vendor_name
    FROM public.profiles WHERE vendor_id = vendor LIMIT 1;
  IF _status NOT IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RAISE EXCEPTION 'Unsupported vendor fulfillment status';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND OR NOT (vendor = ANY(target.vendor_ids)) THEN RAISE EXCEPTION 'Order not found for this vendor'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot be fulfilled'; END IF;
  SELECT f.status INTO current_status FROM public.order_vendor_fulfillments f
    WHERE f.order_id = target.id AND f.vendor_id = vendor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order has no fulfillment for your vendor'; END IF;

  required_advance := round(target.total * COALESCE((
    SELECT NULLIF(value->>'advance_percent', '')::numeric
    FROM public.settings WHERE key = 'order'
  ), 30) / 100, 2);
  valid_transition :=
    (current_status = 'Payment Confirmed' AND _status = 'Accepted' AND target.paid_amount >= required_advance)
    OR (current_status = 'Accepted' AND _status = 'Packed')
    OR (current_status = 'Packed' AND _status = 'Dispatched' AND target.payment_status = 'Paid')
    OR (current_status = 'Dispatched' AND _status = 'Out for Delivery' AND target.payment_status = 'Paid')
    OR (current_status = 'Out for Delivery' AND _status = 'Delivered' AND target.payment_status = 'Paid');
  IF NOT valid_transition THEN
    RAISE EXCEPTION 'Fulfillment must move to the next allowed step; the required advance is needed to accept and full payment is needed before dispatch';
  END IF;

  UPDATE public.order_vendor_fulfillments SET status = _status, updated_at = now()
    WHERE order_id = target.id AND vendor_id = vendor;
  INSERT INTO public.order_tracking (order_id, status, note, actor_role)
    VALUES (target.id, _status, format('%s updated its shipment to %s.', vendor_name, _status), 'vendor');
  IF target.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (target.order_no, target.id, target.user_id, 'customer',
        'Vendor shipment updated', format('%s marked its order items as %s.', vendor_name, _status), 'order');
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.vendor_update_order_fulfillment(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_update_order_fulfillment(text, text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public' AND tablename = 'order_vendor_fulfillments'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_vendor_fulfillments;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
