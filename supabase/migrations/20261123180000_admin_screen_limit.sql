-- Admin screen limit (owner, 23 Nov 2026): "option to limit the number of admin screens that can be active with the
-- same credentials, set and managed by the admin in Settings, any range".
--
-- A "screen" is one signed-in browser or device (one Supabase session; tabs of one browser share it). Each admin
-- screen checks in every minute (admin_screen_checkin). Settings key 'admin_screens' = {"max_screens": N}; 0 or no
-- row = no limit. With N set, the first N screens of a login that are open (checked in within 3 minutes) are let in;
-- another screen is held at "screen limit reached" until one closes, or it takes over (the least recently used
-- screen is signed out). Admins can sign any admin screen out from Settings > Security.
-- A held or signed-out screen is refused admin rights by has_role() too, so it is not only hidden in the browser.
-- Safe to run twice.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS public.admin_screens (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz,
  -- 'limit' (waiting for a free place, lets itself in when one frees), 'signed_out' (by an admin or taken over).
  blocked_reason text
);
CREATE INDEX IF NOT EXISTS admin_screens_user_idx ON public.admin_screens (user_id, last_seen DESC);
ALTER TABLE public.admin_screens ENABLE ROW LEVEL SECURITY;
-- Only the functions below read or write it.
REVOKE ALL ON public.admin_screens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_screens TO service_role;

-- This request's Supabase session id (the access token's session_id claim), or null.
CREATE OR REPLACE FUNCTION private.current_session_id()
RETURNS uuid LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT CASE WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (auth.jwt() ->> 'session_id')::uuid END
$function$;

-- True when this request comes from an admin screen that is held at the limit or was signed out.
CREATE OR REPLACE FUNCTION private.admin_screen_blocked()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_screens
     WHERE session_id = private.current_session_id() AND blocked_at IS NOT NULL
  )
$function$;
-- Called only from SECURITY DEFINER functions (has_role and the ones below), so nobody else needs to run them.
REVOKE ALL ON FUNCTION private.current_session_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.admin_screen_blocked() FROM PUBLIC, anon, authenticated;

-- has_role as in 20261011010000_scope_has_role_queries.sql, plus: a held or signed-out admin screen has no admin rights.
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

  IF (_role = 'admin'::public.app_role OR _user_id <> requester_id) AND private.admin_screen_blocked() THEN
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

-- The limit: 0 = no limit.
CREATE OR REPLACE FUNCTION private.admin_screen_limit()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT GREATEST(0, LEAST(9999, COALESCE(
    (SELECT CASE WHEN jsonb_typeof(value -> 'max_screens') = 'number' THEN floor((value ->> 'max_screens')::numeric)::integer END
       FROM public.settings WHERE key = 'admin_screens'), 0)))
$function$;
REVOKE ALL ON FUNCTION private.admin_screen_limit() FROM PUBLIC, anon;

-- The open admin screens, for Settings and the "limit reached" screen.
CREATE OR REPLACE FUNCTION private.admin_screen_list()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'session_id', s.session_id,
           'email', u.email,
           'device', s.device,
           'started_at', s.started_at,
           'last_seen', s.last_seen,
           'held', s.blocked_at IS NOT NULL,
           'this_screen', s.session_id = private.current_session_id()
         ) ORDER BY s.user_id, s.started_at), '[]'::jsonb)
    FROM public.admin_screens s
    LEFT JOIN auth.users u ON u.id = s.user_id
   WHERE s.last_seen > now() - interval '3 minutes'
     AND (s.blocked_at IS NULL OR s.blocked_reason = 'limit')
$function$;
REVOKE ALL ON FUNCTION private.admin_screen_list() FROM PUBLIC, anon;

-- Every minute from each open admin screen. _take_over: this screen comes in and the least recently used screens of
-- the same login are signed out to make room.
CREATE OR REPLACE FUNCTION public.admin_screen_checkin(_device text DEFAULT '', _take_over boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  uid uuid := auth.uid();
  sid uuid := private.current_session_id();
  max_screens integer := private.admin_screen_limit();
  me public.admin_screens%ROWTYPE;
  others integer;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  -- Straight from user_roles: has_role() says no to a held screen, which still has to check in.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = uid AND role = 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'Admins only';
  END IF;
  IF sid IS NULL THEN
    -- No session id in the token (should not happen with Supabase Auth): not counted, never held.
    RETURN jsonb_build_object('ok', true, 'limit', max_screens, 'counted', false);
  END IF;

  -- One check-in at a time per login, so two screens opening together cannot both take the last place.
  PERFORM pg_advisory_xact_lock(hashtextextended('admin_screens:' || uid::text, 0));

  DELETE FROM public.admin_screens WHERE last_seen < now() - interval '2 days';

  INSERT INTO public.admin_screens (session_id, user_id, device)
  VALUES (sid, uid, left(COALESCE(_device, ''), 200))
  ON CONFLICT (session_id) DO UPDATE SET last_seen = now(), device = CASE WHEN EXCLUDED.device <> '' THEN EXCLUDED.device ELSE admin_screens.device END
  RETURNING * INTO me;

  IF me.user_id <> uid THEN RAISE EXCEPTION 'This screen belongs to another login'; END IF;

  IF me.blocked_at IS NOT NULL AND me.blocked_reason <> 'limit' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'signed_out', 'limit', max_screens);
  END IF;

  IF max_screens = 0 THEN
    UPDATE public.admin_screens SET blocked_at = NULL, blocked_reason = NULL WHERE session_id = sid AND blocked_at IS NOT NULL;
    RETURN jsonb_build_object('ok', true, 'limit', 0, 'screens', private.admin_screen_list());
  END IF;

  IF _take_over THEN
    -- Sign out the least recently used open screens of this login until this one fits.
    UPDATE public.admin_screens SET blocked_at = now(), blocked_reason = 'signed_out'
     WHERE session_id IN (
       SELECT session_id FROM public.admin_screens
        WHERE user_id = uid AND session_id <> sid AND blocked_at IS NULL AND last_seen > now() - interval '3 minutes'
        ORDER BY last_seen ASC
        LIMIT GREATEST(0, (SELECT count(*) FROM public.admin_screens
                            WHERE user_id = uid AND session_id <> sid AND blocked_at IS NULL
                              AND last_seen > now() - interval '3 minutes') - (max_screens - 1))
     );
    UPDATE public.admin_screens SET blocked_at = NULL, blocked_reason = NULL WHERE session_id = sid;
    RETURN jsonb_build_object('ok', true, 'limit', max_screens, 'screens', private.admin_screen_list());
  END IF;

  IF me.blocked_at IS NULL THEN
    -- Already in: it keeps its place unless more screens of this login that opened before it fill the limit
    -- (the limit was lowered).
    SELECT count(*) INTO others FROM public.admin_screens
     WHERE user_id = uid AND session_id <> sid AND blocked_at IS NULL
       AND last_seen > now() - interval '3 minutes' AND started_at <= me.started_at;
  ELSE
    -- Held: comes in once fewer than the limit are open.
    SELECT count(*) INTO others FROM public.admin_screens
     WHERE user_id = uid AND session_id <> sid AND blocked_at IS NULL
       AND last_seen > now() - interval '3 minutes';
  END IF;

  IF others >= max_screens THEN
    UPDATE public.admin_screens SET blocked_at = COALESCE(blocked_at, now()), blocked_reason = 'limit' WHERE session_id = sid;
    RETURN jsonb_build_object('ok', false, 'reason', 'limit', 'limit', max_screens, 'screens', private.admin_screen_list());
  END IF;
  UPDATE public.admin_screens SET blocked_at = NULL, blocked_reason = NULL WHERE session_id = sid AND blocked_at IS NOT NULL;
  RETURN jsonb_build_object('ok', true, 'limit', max_screens, 'screens', private.admin_screen_list());
END $function$;
REVOKE ALL ON FUNCTION public.admin_screen_checkin(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_screen_checkin(text, boolean) TO authenticated;

-- Settings > Security: the open admin screens (any admin login).
CREATE OR REPLACE FUNCTION public.admin_screens_open()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Admins only'; END IF;
  RETURN jsonb_build_object('limit', private.admin_screen_limit(), 'screens', private.admin_screen_list());
END $function$;
REVOKE ALL ON FUNCTION public.admin_screens_open() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_screens_open() TO authenticated;

-- Settings > Security: sign an admin screen out (it is sent to the admin login at its next check-in, within a minute).
CREATE OR REPLACE FUNCTION public.admin_screen_sign_out(_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN RAISE EXCEPTION 'Admins only'; END IF;
  IF _session_id = private.current_session_id() THEN RAISE EXCEPTION 'This is your own screen: use Log out instead'; END IF;
  UPDATE public.admin_screens SET blocked_at = now(), blocked_reason = 'signed_out' WHERE session_id = _session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That screen is no longer open'; END IF;
  RETURN jsonb_build_object('ok', true);
END $function$;
REVOKE ALL ON FUNCTION public.admin_screen_sign_out(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_screen_sign_out(uuid) TO authenticated;

-- Log out frees the screen's place at once.
CREATE OR REPLACE FUNCTION public.admin_screen_leave()
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  DELETE FROM public.admin_screens WHERE session_id = private.current_session_id() AND user_id = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public.admin_screen_leave() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_screen_leave() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
