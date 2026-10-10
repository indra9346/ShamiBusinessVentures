-- Public product visibility follows the owning vendor's account status.
-- Admins retain access to moderate records, and vendors retain access to their
-- own products while suspended so they can see what needs attention.

CREATE OR REPLACE FUNCTION private.vendor_account_is_active(_vendor_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE vendor_id = _vendor_id
      AND lower(COALESCE(status, '')) IN ('active', 'approved')
  );
$$;

GRANT USAGE ON SCHEMA private TO anon, authenticated;
REVOKE ALL ON FUNCTION private.vendor_account_is_active(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.vendor_account_is_active(text) TO anon, authenticated;

DROP POLICY IF EXISTS catalog_products_public_read ON public.catalog_products;
CREATE POLICY catalog_products_public_read ON public.catalog_products
  FOR SELECT TO anon
  USING (
    status = 'approved'
    AND active
    AND private.vendor_account_is_active(vendor_id)
  );

DROP POLICY IF EXISTS catalog_products_authenticated_read ON public.catalog_products;
CREATE POLICY catalog_products_authenticated_read ON public.catalog_products
  FOR SELECT TO authenticated
  USING (
    (
      status = 'approved'
      AND active
      AND private.vendor_account_is_active(vendor_id)
    )
    OR public.has_role(auth.uid(), 'admin')
    OR (
      public.has_role(auth.uid(), 'vendor')
      AND vendor_id = public.current_vendor_id()
    )
  );
