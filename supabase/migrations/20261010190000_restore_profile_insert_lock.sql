-- Profile rows are created by the trusted auth trigger. Self-service updates
-- go through save_profile or approved profile columns; authenticated clients
-- must not insert arbitrary profile fields after the earlier persistence
-- migration re-granted table-wide INSERT.
REVOKE INSERT ON public.profiles FROM authenticated;
DROP POLICY IF EXISTS "profiles_own_insert" ON public.profiles;

-- This SECURITY DEFINER function writes only the caller's own editable fields.
REVOKE ALL ON FUNCTION public.save_profile(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_profile(text, text, text, text, text)
  TO authenticated, service_role;
