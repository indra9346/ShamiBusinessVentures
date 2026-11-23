-- Back from the UPI app: 10 more minutes, once (owner, 7 Nov 2026).
--
-- What happened: a customer paid ₹130 by UPI inside the 10 minutes, came back to the site, and the countdown kept
-- running. Until the SMS forwarder is set up, the site learns of a UPI payment only from the UTR the customer types,
-- and nobody had typed it when the time ran out, so the checkout ended although the money had arrived.
--
-- Now the page asks for the UTR as soon as the customer is back from the UPI app, and calls this function: the
-- customer's own checkout, still waiting and still within its time, gets 10 more minutes, once. A checkout with a
-- UTR sent already waits for the office's check (up to 24 hours), as before, so this only covers typing the UTR.

BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_hold_extended_at timestamptz;
COMMENT ON COLUMN public.orders.payment_hold_extended_at IS 'When the customer, back from the UPI app, got the one extra 10 minutes on this checkout.';

CREATE OR REPLACE FUNCTION public.extend_my_payment_hold(_order_no text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  until timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  -- Only a checkout still waiting and still in time, and only once: anything else keeps the time it has.
  IF o.order_status <> 'Awaiting Payment' OR o.payment_hold_until IS NULL OR o.payment_hold_until <= now()
     OR o.payment_hold_extended_at IS NOT NULL THEN
    RETURN o.payment_hold_until;
  END IF;
  until := o.payment_hold_until + interval '10 minutes';
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders SET payment_hold_until = until, payment_hold_extended_at = now() WHERE id = o.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  RETURN until;
END $function$;
REVOKE ALL ON FUNCTION public.extend_my_payment_hold(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.extend_my_payment_hold(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
