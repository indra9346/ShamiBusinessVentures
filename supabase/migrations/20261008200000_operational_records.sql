-- Persistent operational records used by admin and vendor workspaces.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,2) NOT NULL DEFAULT 8
  CHECK (commission_rate >= 0 AND commission_rate <= 100);

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  vendor_reply text,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Published','Rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id, customer_id)
);
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.product_reviews TO authenticated;
GRANT SELECT ON public.product_reviews TO anon;
DROP POLICY IF EXISTS product_reviews_read ON public.product_reviews;
CREATE POLICY product_reviews_read ON public.product_reviews FOR SELECT TO anon, authenticated
  USING (status = 'Published' OR customer_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
DROP POLICY IF EXISTS product_reviews_customer_create ON public.product_reviews;
CREATE POLICY product_reviews_customer_create ON public.product_reviews FOR INSERT TO authenticated
  WITH CHECK (
    customer_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND status = 'Pending'
    AND EXISTS (
      SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.id = public.product_reviews.order_id AND o.user_id = auth.uid() AND o.order_status = 'Delivered'
        AND oi.product_id = public.product_reviews.product_id
    )
  );

CREATE OR REPLACE FUNCTION public.admin_set_review_status(_id uuid, _status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may moderate reviews'; END IF;
  IF _status NOT IN ('Pending','Published','Rejected') THEN RAISE EXCEPTION 'Invalid review status'; END IF;
  UPDATE public.product_reviews SET status = _status WHERE id = _id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.admin_set_review_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_review_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_review(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete reviews'; END IF;
  DELETE FROM public.product_reviews WHERE id = _id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.admin_delete_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_review(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.vendor_reply_to_review(_id uuid, _reply text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN RAISE EXCEPTION 'Vendor sign-in is required'; END IF;
  IF length(trim(COALESCE(_reply,''))) = 0 OR length(_reply) > 3000 THEN RAISE EXCEPTION 'Enter a reply under 3000 characters'; END IF;
  UPDATE public.product_reviews SET vendor_reply = trim(_reply)
    WHERE id = _id AND vendor_id = public.current_vendor_id();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.vendor_reply_to_review(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_reply_to_review(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.customer_delete_own_review(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') THEN RAISE EXCEPTION 'Customer sign-in is required'; END IF;
  DELETE FROM public.product_reviews WHERE id = _id AND customer_id = auth.uid() AND status = 'Pending';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 AND EXISTS (SELECT 1 FROM public.product_reviews WHERE id = _id AND customer_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only pending reviews can be deleted';
  END IF;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.customer_delete_own_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_delete_own_review(uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  vendor_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested','Approved','Rejected','Picked Up','Completed')),
  refund_status text NOT NULL DEFAULT 'Pending' CHECK (refund_status IN ('Pending','Processing','Refunded','Not Applicable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_requests_order_idx ON public.return_requests(order_id);
ALTER TABLE public.return_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.return_requests TO authenticated;
DROP POLICY IF EXISTS return_requests_read ON public.return_requests;
CREATE POLICY return_requests_read ON public.return_requests FOR SELECT TO authenticated
  USING (customer_id = auth.uid() OR public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
DROP POLICY IF EXISTS return_requests_customer_create ON public.return_requests;
CREATE POLICY return_requests_customer_create ON public.return_requests FOR INSERT TO authenticated
  WITH CHECK (
    customer_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND status = 'Requested'
    AND refund_status = 'Pending'
    AND EXISTS (
      SELECT 1 FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.id = public.return_requests.order_id AND o.user_id = auth.uid() AND oi.id = public.return_requests.order_item_id
        AND oi.product_id = public.return_requests.product_id AND oi.vendor_id = public.return_requests.vendor_id
        AND o.order_status NOT IN ('Cancelled','Awaiting Payment')
        AND public.return_requests.quantity <= oi.qty
        AND public.return_requests.amount = oi.unit_price * public.return_requests.quantity
        AND public.return_requests.quantity + COALESCE((
          SELECT SUM(previous.quantity) FROM public.return_requests previous
          WHERE previous.order_item_id = oi.id AND previous.status <> 'Rejected'
        ),0) <= oi.qty
    )
  );

CREATE OR REPLACE FUNCTION public.customer_request_return(_order_item_id uuid, _quantity integer, _reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item public.order_items%ROWTYPE; parent public.orders%ROWTYPE; prior integer; new_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') THEN RAISE EXCEPTION 'Customer sign-in is required'; END IF;
  IF _quantity IS NULL OR _quantity < 1 OR length(trim(COALESCE(_reason,''))) = 0 THEN RAISE EXCEPTION 'Provide a valid quantity and return reason'; END IF;
  SELECT * INTO item FROM public.order_items WHERE id = _order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  SELECT * INTO parent FROM public.orders WHERE id = item.order_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND OR parent.order_status IN ('Cancelled','Awaiting Payment') THEN RAISE EXCEPTION 'This order is not eligible for a return'; END IF;
  SELECT COALESCE(SUM(quantity),0)::integer INTO prior FROM public.return_requests WHERE order_item_id = item.id AND status <> 'Rejected';
  IF prior + _quantity > item.qty THEN RAISE EXCEPTION 'Requested quantity exceeds the unreturned quantity'; END IF;
  INSERT INTO public.return_requests(order_id, order_item_id, customer_id, product_id, vendor_id, quantity, amount, reason)
  VALUES (item.order_id, item.id, auth.uid(), item.product_id, COALESCE(item.vendor_id,''), _quantity,
    round(item.unit_price * _quantity, 2), trim(_reason)) RETURNING id INTO new_id;
  RETURN new_id;
END; $$;
REVOKE ALL ON FUNCTION public.customer_request_return(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_request_return(uuid, integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_return(_id uuid, _status text, _refund_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may process returns'; END IF;
  IF _status NOT IN ('Requested','Approved','Rejected','Picked Up','Completed') OR _refund_status NOT IN ('Pending','Processing','Refunded','Not Applicable') THEN RAISE EXCEPTION 'Invalid return status'; END IF;
  UPDATE public.return_requests SET status = _status, refund_status = _refund_status, updated_at = now() WHERE id = _id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.admin_update_return(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_return(uuid, text, text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.coupons (
  code text PRIMARY KEY CHECK (code = upper(code)),
  discount_type text NOT NULL CHECK (discount_type IN ('Percentage','Fixed')),
  discount_value numeric(12,2) NOT NULL CHECK (discount_value > 0),
  minimum_order numeric(14,2) NOT NULL DEFAULT 0 CHECK (minimum_order >= 0),
  maximum_discount numeric(14,2) NOT NULL CHECK (maximum_discount >= 0),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  usage_limit integer NOT NULL CHECK (usage_limit > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  CHECK (discount_type <> 'Percentage' OR discount_value <= 100)
);
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.coupons TO authenticated;
DROP POLICY IF EXISTS coupons_admin_all ON public.coupons;
CREATE POLICY coupons_admin_all ON public.coupons FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.vendor_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'NEFT',
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Processing','Paid','Rejected')),
  reference text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS vendor_payout_requests_vendor_idx ON public.vendor_payout_requests(vendor_id, requested_at DESC);
ALTER TABLE public.vendor_payout_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.vendor_payout_requests TO authenticated;
DROP POLICY IF EXISTS vendor_payout_requests_read ON public.vendor_payout_requests;
CREATE POLICY vendor_payout_requests_read ON public.vendor_payout_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));

CREATE OR REPLACE FUNCTION public.admin_set_vendor_commission(_vendor_id text, _rate numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may change commission rates';
  END IF;
  IF _rate < 0 OR _rate > 100 THEN RAISE EXCEPTION 'Commission must be between 0 and 100'; END IF;
  UPDATE public.profiles SET commission_rate = _rate, updated_at = now()
    WHERE vendor_id = _vendor_id AND EXISTS (
      SELECT 1 FROM public.user_roles ur WHERE ur.user_id = profiles.id AND ur.role = 'vendor'
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.admin_set_vendor_commission(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_vendor_commission(text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_vendor_payout(_amount numeric, _method text DEFAULT 'NEFT')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id text; v_rate numeric; eligible numeric; existing numeric; result_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Vendor sign-in is required';
  END IF;
  SELECT vendor_id, commission_rate INTO v_id, v_rate FROM public.profiles WHERE id = auth.uid();
  IF v_id IS NULL THEN RAISE EXCEPTION 'Vendor profile is not linked'; END IF;
  IF _amount IS NULL OR _amount <= 0 OR _method NOT IN ('NEFT','IMPS','RTGS','Bank Transfer') THEN
    RAISE EXCEPTION 'Enter a valid payout amount and method';
  END IF;
  SELECT COALESCE(SUM(oi.line_total),0) * (1 - COALESCE(v_rate,8) / 100)
    INTO eligible
    FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
    WHERE o.order_status = 'Delivered' AND o.payment_status = 'Paid' AND oi.vendor_id = v_id;
  SELECT COALESCE(SUM(amount),0) INTO existing FROM public.vendor_payout_requests
    WHERE vendor_id = v_id AND status IN ('Pending','Processing','Paid');
  IF _amount > eligible - existing THEN RAISE EXCEPTION 'Amount exceeds available settled earnings'; END IF;
  INSERT INTO public.vendor_payout_requests(vendor_id, amount, method)
    VALUES (v_id, _amount, _method) RETURNING id INTO result_id;
  RETURN result_id;
END; $$;
REVOKE ALL ON FUNCTION public.request_vendor_payout(numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_vendor_payout(numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_update_payout(_id uuid, _status text, _reference text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may process vendor payouts';
  END IF;
  IF _status NOT IN ('Processing','Paid','Rejected') THEN RAISE EXCEPTION 'Invalid payout status'; END IF;
  IF _status = 'Paid' AND COALESCE(trim(_reference),'') = '' THEN
    RAISE EXCEPTION 'Enter the bank transfer reference before marking a payout paid';
  END IF;
  UPDATE public.vendor_payout_requests SET status = _status,
    reference = COALESCE(NULLIF(trim(_reference),''), reference),
    processed_at = CASE WHEN _status = 'Paid' THEN now() ELSE processed_at END,
    processed_by = auth.uid()
    WHERE id = _id AND status <> 'Paid';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END; $$;
REVOKE ALL ON FUNCTION public.admin_update_payout(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_payout(uuid, text, text) TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'product_reviews') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.product_reviews; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'return_requests') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.return_requests; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'vendor_payout_requests') THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.vendor_payout_requests; END IF;
  END IF;
END $$;
