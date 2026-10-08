CREATE OR REPLACE FUNCTION public.vendor_report_review(_id uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  review_row public.product_reviews%ROWTYPE;
  admin_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'vendor') THEN
    RAISE EXCEPTION 'Only vendors may report reviews';
  END IF;
  IF length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'Provide a clear moderation reason';
  END IF;
  SELECT * INTO review_row FROM public.product_reviews WHERE id = _id;
  IF NOT FOUND OR review_row.vendor_id <> public.current_vendor_id() THEN
    RAISE EXCEPTION 'Review not found for this vendor';
  END IF;
  INSERT INTO public.notifications(recipient_id, recipient_role, title, message, status)
  SELECT ur.user_id, 'admin', 'Vendor review moderation report',
    format('Review %s was reported by vendor %s. Reason: %s', _id, public.current_vendor_id(), trim(_reason)),
    'unread'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  GET DIAGNOSTICS admin_count = ROW_COUNT;
  RETURN admin_count > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.vendor_report_review(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_report_review(uuid, text) TO authenticated;
