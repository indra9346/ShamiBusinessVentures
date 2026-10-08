-- Public vendor onboarding is an application flow; only an admin can grant a
-- vendor role and assign the corresponding vendor ID.
CREATE TABLE IF NOT EXISTS public.vendor_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  owner_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  gstin text NOT NULL DEFAULT '',
  city text NOT NULL,
  address text NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  admin_notes text,
  vendor_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS vendor_applications_status_created_idx
  ON public.vendor_applications (status, created_at DESC);
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS business_city text,
  ADD COLUMN IF NOT EXISTS business_address text;
ALTER TABLE public.vendor_applications ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.vendor_applications TO authenticated;
GRANT ALL ON public.vendor_applications TO service_role;

DROP POLICY IF EXISTS vendor_applications_own_or_admin_read ON public.vendor_applications;
CREATE POLICY vendor_applications_own_or_admin_read ON public.vendor_applications
  FOR SELECT TO authenticated
  USING (applicant_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.customer_submit_vendor_application(
  _business_name text, _owner_name text, _phone text, _gstin text, _city text, _address text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_profile public.profiles%ROWTYPE; app_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') OR public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Sign in with a customer account to request vendor access';
  END IF;
  SELECT * INTO current_profile FROM public.profiles WHERE id = auth.uid();
  IF current_profile.id IS NULL THEN RAISE EXCEPTION 'Your account profile could not be found'; END IF;
  IF position('@' IN current_profile.email) < 2 THEN RAISE EXCEPTION 'A verified email account is required for vendor access'; END IF;
  IF length(trim(COALESCE(_business_name, ''))) < 2 OR length(trim(COALESCE(_owner_name, ''))) < 2
    OR length(regexp_replace(COALESCE(_phone, ''), '[^0-9]', '', 'g')) < 10
    OR length(trim(COALESCE(_city, ''))) < 2 OR length(trim(COALESCE(_address, ''))) < 8 THEN
    RAISE EXCEPTION 'Complete the required business, owner, phone, city and address fields';
  END IF;
  INSERT INTO public.vendor_applications (applicant_id, business_name, owner_name, email, phone, gstin, city, address)
  VALUES (auth.uid(), trim(_business_name), trim(_owner_name), current_profile.email, trim(_phone), trim(COALESCE(_gstin, '')), trim(_city), trim(_address))
  ON CONFLICT (applicant_id) DO UPDATE SET
    business_name = EXCLUDED.business_name, owner_name = EXCLUDED.owner_name, phone = EXCLUDED.phone,
    gstin = EXCLUDED.gstin, city = EXCLUDED.city, address = EXCLUDED.address,
    status = 'Pending', admin_notes = NULL, reviewed_at = NULL, reviewed_by = NULL, vendor_id = NULL
  WHERE public.vendor_applications.status = 'Rejected'
  RETURNING id INTO app_id;
  IF app_id IS NULL THEN RAISE EXCEPTION 'You already have an application under review or approved'; END IF;
  RETURN app_id;
END;
$$;
REVOKE ALL ON FUNCTION public.customer_submit_vendor_application(text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_submit_vendor_application(text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_review_vendor_application(_id uuid, _status text, _notes text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE application_row public.vendor_applications%ROWTYPE; generated_vendor_id text; changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may review vendor applications';
  END IF;
  IF _status NOT IN ('Approved', 'Rejected') THEN RAISE EXCEPTION 'Choose Approved or Rejected'; END IF;
  IF length(COALESCE(_notes, '')) > 2000 THEN RAISE EXCEPTION 'Review notes must be 2000 characters or fewer'; END IF;
  SELECT * INTO application_row FROM public.vendor_applications WHERE id = _id FOR UPDATE;
  IF application_row.id IS NULL THEN RETURN false; END IF;
  IF application_row.status <> 'Pending' THEN RAISE EXCEPTION 'This application has already been reviewed'; END IF;
  IF _status = 'Approved' THEN
    generated_vendor_id := 'VND-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    INSERT INTO public.user_roles (user_id, role) VALUES (application_row.applicant_id, 'vendor') ON CONFLICT DO NOTHING;
    UPDATE public.profiles SET vendor_id = generated_vendor_id, company = application_row.business_name,
      full_name = application_row.owner_name, phone = application_row.phone, gstin = NULLIF(application_row.gstin, ''),
      business_city = application_row.city, business_address = application_row.address, status = 'approved', updated_at = now()
      WHERE id = application_row.applicant_id;
  END IF;
  UPDATE public.vendor_applications SET status = _status, admin_notes = NULLIF(trim(COALESCE(_notes, '')), ''),
    vendor_id = generated_vendor_id, reviewed_at = now(), reviewed_by = auth.uid() WHERE id = _id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_vendor_application(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_vendor_application(uuid, text, text) TO authenticated;

DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'profiles', 'user_roles', 'vendor_applications', 'vendor_kyc_documents', 'vendor_payout_requests',
    'catalog_products', 'store_categories', 'orders', 'order_items', 'payments', 'product_reviews',
    'return_requests', 'coupons', 'batches', 'notifications'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = target_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', target_table);
    END IF;
  END LOOP;
END;
$$;
