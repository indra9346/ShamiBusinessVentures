-- Vendor applications: reject a malformed GSTIN (it becomes the vendor's tax ID on approval).
CREATE OR REPLACE FUNCTION public.customer_submit_vendor_application(_business_name text, _owner_name text, _phone text, _gstin text, _city text, _address text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- GSTIN is optional, but when given it must be a real 15-character Indian GSTIN.
  IF NULLIF(trim(COALESCE(_gstin, '')), '') IS NOT NULL
    AND upper(trim(_gstin)) !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
    RAISE EXCEPTION 'Enter a valid 15-character GSTIN (for example 29ABCDE1234F1Z5), or leave it blank';
  END IF;
  INSERT INTO public.vendor_applications (applicant_id, business_name, owner_name, email, phone, gstin, city, address)
  VALUES (auth.uid(), trim(_business_name), trim(_owner_name), current_profile.email, trim(_phone), upper(trim(COALESCE(_gstin, ''))), trim(_city), trim(_address))
  ON CONFLICT (applicant_id) DO UPDATE SET
    business_name = EXCLUDED.business_name, owner_name = EXCLUDED.owner_name, phone = EXCLUDED.phone,
    gstin = EXCLUDED.gstin, city = EXCLUDED.city, address = EXCLUDED.address,
    status = 'Pending', admin_notes = NULL, reviewed_at = NULL, reviewed_by = NULL, vendor_id = NULL
  WHERE public.vendor_applications.status = 'Rejected'
  RETURNING id INTO app_id;
  IF app_id IS NULL THEN RAISE EXCEPTION 'You already have an application under review or approved'; END IF;
  RETURN app_id;
END;
$function$;
