CREATE OR REPLACE FUNCTION public.customer_set_default_address(_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') THEN
    RAISE EXCEPTION 'Customer sign-in is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.addresses WHERE id = _id AND user_id = auth.uid()) THEN
    RETURN false;
  END IF;
  UPDATE public.addresses SET is_default = (id = _id) WHERE user_id = auth.uid();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.customer_set_default_address(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_set_default_address(uuid) TO authenticated;
