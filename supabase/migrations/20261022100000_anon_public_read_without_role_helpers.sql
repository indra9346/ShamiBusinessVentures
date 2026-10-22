-- Signed-out shoppers could not read public settings, active godowns or published reviews.
-- 20261008120000 revoked EXECUTE on has_role() and current_vendor_id() from anon, but these
-- SELECT policies still applied to anon and called them, so PostgREST returned
-- "permission denied for function has_role" instead of the public rows. Split each policy so
-- anon only evaluates a plain column check and the role helpers stay authenticated-only.

DROP POLICY IF EXISTS settings_public_read ON public.settings;
DROP POLICY IF EXISTS settings_anon_read ON public.settings;
CREATE POLICY settings_anon_read ON public.settings FOR SELECT TO anon
  USING (is_public);
CREATE POLICY settings_public_read ON public.settings FOR SELECT TO authenticated
  USING (is_public OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS branches_read ON public.branches;
DROP POLICY IF EXISTS branches_anon_read ON public.branches;
CREATE POLICY branches_anon_read ON public.branches FOR SELECT TO anon
  USING (active);
CREATE POLICY branches_read ON public.branches FOR SELECT TO authenticated
  USING (active OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS product_reviews_read ON public.product_reviews;
DROP POLICY IF EXISTS product_reviews_anon_read ON public.product_reviews;
CREATE POLICY product_reviews_anon_read ON public.product_reviews FOR SELECT TO anon
  USING (status = 'Published');
CREATE POLICY product_reviews_read ON public.product_reviews FOR SELECT TO authenticated
  USING (
    status = 'Published'
    OR customer_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id())
  );
