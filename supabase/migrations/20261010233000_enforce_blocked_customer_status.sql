-- Enforce the admin customer Block action at the database boundary as well as
-- in the customer login and panel routes.
CREATE OR REPLACE FUNCTION private.customer_account_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND lower(COALESCE(status, '')) IN ('active', 'approved')
  );
$$;

GRANT USAGE ON SCHEMA private TO authenticated;
REVOKE ALL ON FUNCTION private.customer_account_is_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.customer_account_is_active() TO authenticated;

-- Security-definer RPCs still fire these triggers with the original caller's
-- auth.uid(), so blocked customers cannot bypass RLS by calling an RPC.
CREATE OR REPLACE FUNCTION private.reject_inactive_customer_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  target_user_id uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'orders' THEN target_user_id := NEW.user_id;
    WHEN 'addresses' THEN target_user_id := NEW.user_id;
    WHEN 'return_requests' THEN target_user_id := NEW.customer_id;
    WHEN 'vendor_applications' THEN target_user_id := NEW.applicant_id;
    ELSE RAISE EXCEPTION 'Unsupported account status trigger table: %', TG_TABLE_NAME;
  END CASE;

  IF target_user_id = auth.uid() AND NOT private.customer_account_is_active() THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'This customer account is not active';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.reject_inactive_customer_mutation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS addresses_require_active_customer ON public.addresses;
CREATE TRIGGER addresses_require_active_customer
  BEFORE INSERT OR UPDATE ON public.addresses
  FOR EACH ROW EXECUTE FUNCTION private.reject_inactive_customer_mutation();

DROP TRIGGER IF EXISTS orders_require_active_customer ON public.orders;
CREATE TRIGGER orders_require_active_customer
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION private.reject_inactive_customer_mutation();

DROP TRIGGER IF EXISTS returns_require_active_customer ON public.return_requests;
CREATE TRIGGER returns_require_active_customer
  BEFORE INSERT OR UPDATE ON public.return_requests
  FOR EACH ROW EXECUTE FUNCTION private.reject_inactive_customer_mutation();

DROP TRIGGER IF EXISTS vendor_applications_require_active_customer ON public.vendor_applications;
CREATE TRIGGER vendor_applications_require_active_customer
  BEFORE INSERT OR UPDATE ON public.vendor_applications
  FOR EACH ROW EXECUTE FUNCTION private.reject_inactive_customer_mutation();

DROP POLICY IF EXISTS "addresses_own" ON public.addresses;
CREATE POLICY "addresses_own" ON public.addresses FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (user_id = auth.uid() AND private.customer_account_is_active())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR (user_id = auth.uid() AND private.customer_account_is_active())
  );

DROP POLICY IF EXISTS "orders_insert_own" ON public.orders;
CREATE POLICY "orders_insert_own" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR (user_id = auth.uid() AND private.customer_account_is_active())
  );

DROP POLICY IF EXISTS product_reviews_customer_create ON public.product_reviews;
CREATE POLICY product_reviews_customer_create ON public.product_reviews FOR INSERT TO authenticated
  WITH CHECK (
    customer_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND private.customer_account_is_active()
    AND status = 'Pending'
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.id = public.product_reviews.order_id
        AND o.user_id = auth.uid()
        AND o.order_status = 'Delivered'
        AND oi.product_id = public.product_reviews.product_id
    )
  );

DROP POLICY IF EXISTS return_requests_customer_create ON public.return_requests;
CREATE POLICY return_requests_customer_create ON public.return_requests FOR INSERT TO authenticated
  WITH CHECK (
    customer_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND private.customer_account_is_active()
    AND status = 'Requested'
    AND refund_status = 'Pending'
    AND EXISTS (
      SELECT 1
      FROM public.orders o
      JOIN public.order_items oi ON oi.order_id = o.id
      WHERE o.id = public.return_requests.order_id
        AND o.user_id = auth.uid()
        AND oi.id = public.return_requests.order_item_id
        AND oi.product_id = public.return_requests.product_id
        AND oi.vendor_id = public.return_requests.vendor_id
        AND o.order_status NOT IN ('Cancelled', 'Awaiting Payment')
        AND public.return_requests.quantity <= oi.qty
        AND public.return_requests.amount = oi.unit_price * public.return_requests.quantity
        AND public.return_requests.quantity + COALESCE((
          SELECT SUM(previous.quantity)
          FROM public.return_requests previous
          WHERE previous.order_item_id = oi.id
            AND previous.status <> 'Rejected'
        ), 0) <= oi.qty
    )
  );

DROP POLICY IF EXISTS customer_settings_read_own ON public.customer_settings;
CREATE POLICY customer_settings_read_own ON public.customer_settings FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND private.customer_account_is_active());

DROP POLICY IF EXISTS customer_settings_insert_own ON public.customer_settings;
CREATE POLICY customer_settings_insert_own ON public.customer_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND private.customer_account_is_active());

DROP POLICY IF EXISTS customer_settings_update_own ON public.customer_settings;
CREATE POLICY customer_settings_update_own ON public.customer_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND private.customer_account_is_active())
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND private.customer_account_is_active());

DROP POLICY IF EXISTS customer_settings_delete_own ON public.customer_settings;
CREATE POLICY customer_settings_delete_own ON public.customer_settings FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer') AND private.customer_account_is_active());
