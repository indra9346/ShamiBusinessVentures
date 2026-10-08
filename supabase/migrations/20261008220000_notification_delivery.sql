-- Admin broadcasts are persisted as inbox notifications for actual accounts.
CREATE OR REPLACE FUNCTION public.admin_broadcast_notification(_audience text, _title text, _message text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE affected integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may send platform broadcasts';
  END IF;
  IF _audience NOT IN ('All Vendors','All Customers','All Users','Pending KYC Vendors') THEN RAISE EXCEPTION 'Invalid audience'; END IF;
  IF length(trim(COALESCE(_title,''))) = 0 OR length(trim(COALESCE(_message,''))) < 5 THEN RAISE EXCEPTION 'Enter a subject and message'; END IF;
  INSERT INTO public.notifications(recipient_id, recipient_role, recipient_vendor_id, title, message, status)
  SELECT p.id, ur.role::text, CASE WHEN ur.role = 'vendor' THEN p.vendor_id END, trim(_title), trim(_message), 'broadcast'
  FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
  WHERE CASE _audience
    WHEN 'All Vendors' THEN ur.role = 'vendor'
    WHEN 'All Customers' THEN ur.role = 'customer'
    WHEN 'Pending KYC Vendors' THEN ur.role = 'vendor' AND lower(COALESCE(p.status,'')) NOT IN ('approved','active')
    ELSE ur.role IN ('vendor','customer','admin')
  END;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END; $$;
REVOKE ALL ON FUNCTION public.admin_broadcast_notification(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_broadcast_notification(text, text, text) TO authenticated;

DROP POLICY IF EXISTS notifications_insert ON public.notifications;
CREATE POLICY notifications_insert ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
