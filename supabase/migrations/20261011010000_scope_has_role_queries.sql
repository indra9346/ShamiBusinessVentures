-- Prevent authenticated callers from probing another user's role by UUID.
-- RLS policies and normal RPCs only need to check the current user. Admin
-- order-entry workflows may still validate a target customer's role.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  requester_id uuid := auth.uid();
  requester_is_admin boolean := false;
BEGIN
  IF requester_id IS NULL OR _user_id IS NULL OR _role IS NULL THEN
    RETURN false;
  END IF;

  IF _user_id <> requester_id THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = requester_id
        AND role = 'admin'::public.app_role
    ) INTO requester_is_admin;

    IF NOT requester_is_admin THEN
      RETURN false;
    END IF;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  );
END;
$$;
