-- "Need cancel option for a wrong UTR number" (Sandesh, 21 Nov 2026): the customer can take back a UTR they sent by
-- mistake while it is still being checked, then send the right one (submit_upi_utr accepts a new UTR after a rejected
-- one). The checkout keeps its own time: if that has already run out, it ends at the next check as before (stock back),
-- and the customer can still send a late UTR. Safe to run twice.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.customer_withdraw_utr(_order_no text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired') THEN
    RAISE EXCEPTION 'This order''s payment is already settled. Call us if the UTR was wrong.';
  END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'No UTR is being checked on this order'; END IF;
  UPDATE public.upi_payment_submissions
     SET status = 'rejected', note = 'Taken back by the customer: wrong UTR', reviewed_at = now(), reviewed_by = auth.uid()
   WHERE id = s.id;
  INSERT INTO public.order_tracking (order_id, status, note, actor_role)
  VALUES (o.id, o.order_status, left(format('The customer took back UTR %s as wrong.', s.utr), 500), 'customer');
  RETURN jsonb_build_object('ok', true, 'utr', s.utr);
END $function$;
REVOKE ALL ON FUNCTION public.customer_withdraw_utr(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_withdraw_utr(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
