-- Keep self-service profile edits away from role, vendor assignment, and status.
-- Auth signup is handled by the trusted SECURITY DEFINER trigger; ordinary
-- authenticated clients must not be able to insert arbitrary profile rows.
DROP POLICY IF EXISTS "profiles_own_insert" ON public.profiles;

REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, company, gstin, avatar_url)
  ON public.profiles TO authenticated;

-- Role assignments are provisioned through a trusted Supabase administrative
-- path only. The app may read its own role for route authorization.
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
GRANT SELECT ON public.user_roles TO authenticated;

-- These helpers are used by RLS policies. They are not public APIs and should
-- not be callable by anonymous clients.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)
  TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.current_vendor_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_vendor_id()
  TO authenticated, service_role;
