-- UPI checkout time (Sandesh, 19 Nov 2026: "here kept 10 mins time for UPI ordering but it is giving 20 mins").
-- Coming back from the UPI app (or copying the UPI ID) added a fixed 10 minutes once, so a 10-minute setting became 20.
-- The extra time is now the admin's own setting, Admin › UPI & Bank Payments › "Extra minutes after the UPI app"
-- (upi_direct.extraMinutesAfterApp, 0 to 10; missing = 0), so "Minutes to pay" is the whole time unless they add some.
BEGIN;

CREATE OR REPLACE FUNCTION public.extend_my_payment_hold(_order_no text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  until timestamptz;
  extra integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  -- Only a checkout still waiting and still in time, and only once: anything else keeps the time it has.
  IF o.order_status <> 'Awaiting Payment' OR o.payment_hold_until IS NULL OR o.payment_hold_until <= now()
     OR o.payment_hold_extended_at IS NOT NULL THEN
    RETURN o.payment_hold_until;
  END IF;
  -- Bank transfers already have an hour; the extra time is for UPI only.
  IF COALESCE(o.payment_method, 'UPI') <> 'UPI' THEN RETURN o.payment_hold_until; END IF;
  SELECT LEAST(10, GREATEST(0, COALESCE(NULLIF(value->>'extraMinutesAfterApp', '')::integer, 0))) INTO extra
    FROM public.settings WHERE key = 'upi_direct';
  IF COALESCE(extra, 0) = 0 THEN RETURN o.payment_hold_until; END IF;
  until := o.payment_hold_until + make_interval(mins => extra);
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders SET payment_hold_until = until, payment_hold_extended_at = now() WHERE id = o.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  RETURN until;
END $function$;
REVOKE ALL ON FUNCTION public.extend_my_payment_hold(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extend_my_payment_hold(text) TO authenticated;
COMMENT ON COLUMN public.orders.payment_hold_extended_at IS 'When the customer, back from the UPI app, got the admin''s extra minutes (upi_direct.extraMinutesAfterApp) on this checkout.';

NOTIFY pgrst, 'reload schema';

COMMIT;
