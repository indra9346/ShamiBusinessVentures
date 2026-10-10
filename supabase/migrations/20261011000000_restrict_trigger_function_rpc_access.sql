-- Remove default API execute access from trigger-only SECURITY DEFINER functions.
-- PostgreSQL invokes trigger functions as part of their trigger and does not
-- require the caller to have EXECUTE on the trigger function itself.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_profile_email_from_auth() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- RLS policies for order items and payments call this helper for signed-in users.
-- It must stay callable by authenticated users but is not needed by anon callers.
REVOKE EXECUTE ON FUNCTION public.can_read_order(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_order(uuid) TO authenticated;
