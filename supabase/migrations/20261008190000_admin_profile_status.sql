-- Admin-only profile status changes. The browser has no direct UPDATE grant
-- on the status column, so expose this narrowly scoped role-checked function.
CREATE OR REPLACE FUNCTION public.admin_set_profile_status(_profile_id uuid, _status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may change account status';
  END IF;
  IF _status NOT IN ('active', 'blocked', 'pending', 'approved', 'suspended') THEN
    RAISE EXCEPTION 'Invalid account status';
  END IF;

  UPDATE public.profiles SET status = _status, updated_at = now()
  WHERE id = _profile_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_profile_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_profile_status(uuid, text) TO authenticated;
