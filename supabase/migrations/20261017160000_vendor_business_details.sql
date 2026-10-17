-- GSTIN must be a real 15-character Indian GSTIN whenever it is set or changed (blank is
-- allowed). Existing values are only checked when someone changes them, so an old bad value
-- never blocks unrelated profile edits.
CREATE OR REPLACE FUNCTION public.guard_profile_gstin()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.gstin IS DISTINCT FROM OLD.gstin THEN
    NEW.gstin := NULLIF(upper(trim(COALESCE(NEW.gstin, ''))), '');
    IF NEW.gstin IS NOT NULL AND NEW.gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
      RAISE EXCEPTION 'Enter a valid 15-character GSTIN (for example 29ABCDE1234F1Z5), or leave it blank';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_guard_gstin ON public.profiles;
CREATE TRIGGER profiles_guard_gstin BEFORE INSERT OR UPDATE OF gstin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_gstin();

-- Administrators correct a vendor's registered business details (GSTIN, city, address).
-- City and address are not writable by users directly, so this is the only path.
CREATE OR REPLACE FUNCTION public.admin_update_vendor_business(
  _vendor_id text, _gstin text, _city text, _address text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may change vendor business details';
  END IF;
  IF length(trim(COALESCE(_city, ''))) < 2 THEN RAISE EXCEPTION 'Enter the vendor''s city'; END IF;
  IF length(trim(COALESCE(_address, ''))) < 8 THEN RAISE EXCEPTION 'Enter the vendor''s full business address'; END IF;
  UPDATE public.profiles
     SET gstin = NULLIF(upper(trim(COALESCE(_gstin, ''))), ''),
         business_city = trim(_city),
         business_address = trim(_address)
   WHERE vendor_id = _vendor_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.admin_update_vendor_business(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_vendor_business(text, text, text, text) TO authenticated;
