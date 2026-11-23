-- Two payment fixes (client, 19 Nov 2026).
--
-- 1. "Here kept 10 mins time for UPI ordering but it is giving 20 mins": a customer coming back from their UPI app got
--    10 more minutes, once (7 Nov 2026), whatever Minutes to pay said. The extra time is now the admin's setting
--    upi_direct.extraMinutes (0 to 30; not set = 0), so Minutes to pay is what the customer gets unless the admin adds
--    more. Rebuilt from the live extend_my_payment_hold (pg_get_functiondef, 19 Nov 2026).
--
-- 2. "Channel partner still do not have option to reject if payment details uploaded by customer is wrong":
--    partner_reject_payment rejects a UTR on a checkout of the partner's own godown, exactly as our office's Reject
--    (review_upi_utr 'rejected', live text): the customer is told to send the right UTR and gets the time to do it, a
--    third wrong UTR ends the checkout. Only while our office lets partners approve payments, never on the partner's own
--    order, never on a checkout that already ended (those stay with our office), and with the reason, which the customer,
--    our office and the order's history see.
-- Safe to run twice.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ================================================================ 1. extra minutes after the UPI app
CREATE OR REPLACE FUNCTION public.extend_my_payment_hold(_order_no text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Changed 19 Nov 2026: the admin's setting (0 to 30 minutes; not set = none), no longer always 10.
  SELECT LEAST(30, GREATEST(0, COALESCE(NULLIF(value->>'extraMinutes', '')::numeric, 0)))::integer INTO extra
    FROM public.settings WHERE key = 'upi_direct';
  IF COALESCE(extra, 0) = 0 THEN RETURN o.payment_hold_until; END IF;
  until := o.payment_hold_until + make_interval(mins => extra);
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders SET payment_hold_until = until, payment_hold_extended_at = now() WHERE id = o.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  RETURN until;
END $function$;

-- ================================================================ 2. a channel partner rejects a wrong UTR
CREATE OR REPLACE FUNCTION public.partner_reject_payment(_order_no text, _expected_utr text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  godown text;
  reason text := left(btrim(regexp_replace(COALESCE(_reason, ''), '\s+', ' ', 'g')), 160);
  reject_note text;
  sent_utr text;
  by_bank boolean;
  cfg jsonb;
  extra_minutes integer;
  times integer;
  ended boolean := false;
BEGIN
  SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL;
  IF auth.uid() IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Only an active channel partner can reject payments here'; END IF;
  IF NOT private.partner_payment_approval_on() THEN
    RAISE EXCEPTION 'Our office has turned off payment checks by channel partners. Our office will check this payment.';
  END IF;
  IF length(reason) < 3 THEN RAISE EXCEPTION 'Say why the payment is wrong'; END IF;
  -- The same locks, in the same order, as review_upi_utr and admin_reject_utr_and_end_checkout.
  SELECT utr INTO sent_utr FROM public.upi_payment_submissions WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF sent_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(sent_utr)) AS key; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'No UTR is waiting for a check on this order'; END IF;
  IF _expected_utr IS NULL OR upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the payment again.', s.utr;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
  IF o.branch_id IS DISTINCT FROM me.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  IF o.user_id IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;
  IF o.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'This checkout is not waiting for payment any more. Leave it for our office.'; END IF;
  SELECT NULLIF(btrim(name), '') INTO godown FROM public.branches WHERE id = me.branch_id;
  godown := COALESCE(godown, me.branch_id);
  reject_note := left(format('%s (rejected by channel partner %s, %s)', reason, me.name, godown), 200);
  UPDATE public.upi_payment_submissions
     SET status = 'rejected', note = reject_note, reviewed_at = now(), reviewed_by = auth.uid(), rejections = upi_payment_submissions.rejections + 1
   WHERE id = s.id RETURNING upi_payment_submissions.rejections INTO times;
  by_bank := COALESCE(o.payment_method, '') IN ('NEFT', 'RTGS');
  IF times >= 3 THEN
    -- A third wrong UTR ends the checkout, as with our office: fake UTRs must not keep stock reserved for ever.
    PERFORM private.release_payment_hold(o.id, 'the UTR you sent could not be matched', 'expired');
    ended := true;
  ELSE
    -- Time to send the right one: 1 hour for a bank transfer, Minutes to pay for UPI (as review_upi_utr).
    IF by_bank THEN
      extra_minutes := 60;
    ELSE
      SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
      extra_minutes := LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)));
    END IF;
    PERFORM set_config('app.payment_workflow', 'on', true);
    UPDATE public.orders SET payment_hold_until = GREATEST(payment_hold_until, now() + make_interval(mins => extra_minutes)) WHERE id = o.id;
    PERFORM set_config('app.payment_workflow', 'off', true);
  END IF;
  IF s.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer', CASE WHEN by_bank THEN 'Please check your bank transfer' ELSE 'Please check your UPI payment' END,
      CASE WHEN ended
        THEN format('UTR %s for order %s could not be matched: %s. The order was not placed and nothing is due. If money left your account, call us with the UTR.', s.utr, s.order_no, reason)
        ELSE format('UTR %s for order %s could not be matched: %s. Open the order and send the correct UTR.', s.utr, s.order_no, reason) END,
      'payment');
  END IF;
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
  VALUES (o.id, CASE WHEN ended THEN 'Payment Expired' ELSE o.order_status END,
    left(format('UTR %s rejected by channel partner %s at %s: %s.', s.utr, me.name, godown, reason), 500), 'partner', me.id);
  -- Our office hears of every rejection by a partner.
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment rejected by channel partner',
    format('%s (channel partner, %s) rejected UTR %s on order %s: %s.%s', me.name, godown, s.utr, o.order_no, reason,
      CASE WHEN ended THEN ' It was the third wrong UTR, so the checkout ended.' ELSE ' The customer was asked for the correct UTR.' END),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', s.utr, 'rejections', times, 'ended', ended);
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_reject_payment(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_reject_payment(text, text, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
