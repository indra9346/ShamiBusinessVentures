-- UTR mistakes (Sandesh, 21 Nov 2026):
--   * "Need cancel option for a wrong UTR number": the customer can take back a UTR they sent by mistake while it is
--     still being checked, and send the right one (submit_upi_utr already accepts a new UTR after a rejected one).
--   * "Enable option to reject the order if the UTR is not matching for the channel partner login, it is there in
--     admin": the channel partner of the order's godown can reject a UTR they could not find in the bank, when partner
--     payment approval is switched on, as they can approve. Our office is told of every rejection.
-- Neither ends the checkout by itself: the customer can still send the right UTR while the time lasts, and an order
-- whose time has run out ends as before (stock back).
BEGIN;

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

CREATE OR REPLACE FUNCTION public.partner_reject_payment(_order_no text, _expected_utr text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  godown text;
  reason text := left(btrim(COALESCE(_reason, '')), 160);
  note text;
BEGIN
  SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL;
  IF auth.uid() IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Only an active channel partner can reject payments here'; END IF;
  IF NOT private.partner_payment_approval_on() THEN
    RAISE EXCEPTION 'Our office has turned off payment checks by channel partners. Our office will check this payment.';
  END IF;
  IF length(reason) < 3 THEN RAISE EXCEPTION 'Say why the UTR does not match (for example: not in the bank, other amount)'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  IF o.user_id IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;
  IF o.order_status NOT IN ('Awaiting Payment', 'Payment Expired') THEN RAISE EXCEPTION 'This order is not waiting for payment'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'No UTR is waiting for a check on this order'; END IF;
  IF _expected_utr IS NULL OR upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the payment again.', s.utr;
  END IF;
  SELECT NULLIF(btrim(name), '') INTO godown FROM public.branches WHERE id = me.branch_id;
  godown := COALESCE(godown, me.branch_id);
  note := left(format('Rejected by channel partner %s (%s): %s', me.name, godown, reason), 200);
  UPDATE public.upi_payment_submissions
     SET status = 'rejected', note = note, reviewed_at = now(), reviewed_by = auth.uid(), rejections = rejections + 1
   WHERE id = s.id;
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
  VALUES (o.id, o.order_status, left(format('UTR %s rejected by channel partner %s at %s: %s', s.utr, me.name, godown, reason), 500), 'partner', me.id);
  -- Our office hears of every rejection, to look at it in the company's bank account.
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', 'UTR rejected by channel partner',
    format('%s (channel partner, %s) rejected UTR %s for ₹%s on order %s: %s. Check it in the bank account.',
      me.name, godown, s.utr, to_char(s.amount, 'FM99999990.00'), o.order_no, reason),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  -- The customer is told to check the UTR.
  IF o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'UTR not matched',
      format('UTR %s for order %s could not be matched with our bank. Check the 12-digit UPI Ref No. in your UPI app and send it again, or call us.', s.utr, o.order_no),
      'payment');
  END IF;
  RETURN jsonb_build_object('ok', true, 'utr', s.utr);
END $function$;
REVOKE ALL ON FUNCTION public.partner_reject_payment(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_reject_payment(text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
