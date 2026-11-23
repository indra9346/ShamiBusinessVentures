-- 16 Nov 2026 (owner): "Channel partner should be able to approve the order just like admin".
-- A channel partner can now approve a UTR they sent themselves for a customer (the customer gives the UTR at the godown,
-- the partner sends it and approves it after seeing the money in the bank), as our office can. Everything else stays:
-- only their own godown's orders, the full amount, the same UTR never paying twice, the bank alert's amount, stock,
-- 15 days for an ended checkout, never the partner's own order, never a reject, and every admin is told of each approval.
-- partner_payment_checkouts and partner_approve_payment are the live definitions (read 16 Nov 2026 15:52) with only the
-- partner-sent refusal removed. Columns and privileges are unchanged.

CREATE OR REPLACE FUNCTION public.partner_payment_checkouts()
 RETURNS TABLE(order_no text, status text, total numeric, method text, placed_at timestamp with time zone, hold_until timestamp with time zone, customer text, items text, utr text, utr_status text, utr_late boolean, utr_sent_by text, utr_amount numeric, utr_sent_at timestamp with time zone, paid_amount numeric, can_approve boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  branch text := public.current_partner_branch();
  approving boolean := private.partner_payment_approval_on();
BEGIN
  IF auth.uid() IS NULL OR branch IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can see this'; END IF;
  RETURN QUERY
  SELECT o.order_no, o.order_status, o.total, COALESCE(o.payment_method, 'UPI'), o.created_at, o.payment_hold_until,
    left(COALESCE(NULLIF(btrim(o.customer_name), ''), 'Customer'), 60),
    (SELECT string_agg(i.product_name || ' × ' || to_char(i.qty, 'FM99999990.##'), ', ') FROM public.order_items i WHERE i.order_id = o.id),
    s.utr, s.status, COALESCE(s.late, false), s.sent_by_role,
    -- Added 16 Nov 2026: what the UTR is for and when it came, and whether this partner may approve it now.
    s.amount, s.submitted_at, COALESCE(o.paid_amount, 0),
    COALESCE(approving AND s.status = 'submitted'
      AND o.user_id IS DISTINCT FROM auth.uid()
      AND (o.order_status <> 'Awaiting Payment' OR s.amount = o.total - COALESCE(o.paid_amount, 0))
      AND (o.order_status <> 'Payment Expired' OR o.updated_at > now() - interval '15 days'), false)
  FROM public.orders o
  LEFT JOIN public.upi_payment_submissions s ON s.order_id = o.id
  WHERE o.branch_id = branch
    AND (o.order_status = 'Awaiting Payment' OR (o.order_status = 'Payment Expired' AND o.updated_at > now() - interval '15 days'))
    AND COALESCE(s.note, '') <> 'refunded by our team' AND COALESCE(s.note, '') NOT LIKE 'Placed again as %'
  ORDER BY o.created_at DESC
  LIMIT 100;
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_approve_payment(_order_no text, _expected_utr text, _checked text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  o public.orders%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
  after public.orders%ROWTYPE;
  godown text;
  checked text;
  note text;
  amount numeric;
  placed jsonb;
  failed text;
BEGIN
  SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL;
  IF auth.uid() IS NULL OR NOT FOUND THEN RAISE EXCEPTION 'Only an active channel partner can approve payments here'; END IF;
  IF NOT private.partner_payment_approval_on() THEN
    RAISE EXCEPTION 'Our office has turned off payment approval by channel partners. Our office will check this payment.';
  END IF;
  checked := CASE btrim(COALESCE(_checked, ''))
    WHEN 'bank_sms' THEN 'the bank''s SMS or alert'
    WHEN 'bank_statement' THEN 'the bank statement or passbook'
    WHEN 'upi_app' THEN 'the business UPI app''s received payments'
  END;
  IF checked IS NULL THEN RAISE EXCEPTION 'Choose where you saw this payment'; END IF;
  -- Read here, not locked: review_upi_utr and admin_place_ended_checkout lock what they change, in the same order as
  -- when our office presses Confirm or Place again, and check everything again.
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN RAISE EXCEPTION 'This is not an order of your godown'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_id = o.id;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'No UTR is waiting for a check on this order'; END IF;
  IF _expected_utr IS NULL OR upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the payment again.', s.utr;
  END IF;
  -- 16 Nov 2026 (owner): a partner approves like our office, also a UTR they sent for the customer. Only the partner's
  -- own order (bought for themselves) waits for our office.
  IF o.user_id IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'This is your own order, so our office checks its payment'; END IF;
  SELECT NULLIF(btrim(name), '') INTO godown FROM public.branches WHERE id = me.branch_id;
  godown := COALESCE(godown, me.branch_id);
  note := left(format('Approved by channel partner %s (%s) after checking %s', me.name, godown, checked), 200);
  PERFORM set_config('app.partner_payment', me.id::text, true);
  BEGIN
    IF o.order_status = 'Awaiting Payment' THEN
      amount := s.amount;
      PERFORM public.review_upi_utr(o.order_no, 'confirmed', note, s.utr);
    ELSIF o.order_status = 'Payment Expired' THEN
      -- The same 15 days as the partner's list and the customer's late UTR (the order's last change).
      IF o.updated_at <= now() - interval '15 days' THEN
        RAISE EXCEPTION 'This checkout ended more than 15 days ago. Our office checks it.';
      END IF;
      -- Exactly our office's Place again, which locks the order and then the UTR, so a partner and the office pressing it
      -- at once simply queue. The UTR the partner looked at goes in: Place again refuses it if the order's UTR has changed.
      placed := public.admin_place_ended_checkout(o.order_no, s.utr, NULL, note);
      amount := (placed->>'amount')::numeric;
    ELSE
      RAISE EXCEPTION 'This order is not waiting for payment';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS failed = MESSAGE_TEXT;
    -- Our office's own words ask for office-only steps (reject, refund, record a part payment, add stock): the partner
    -- is told to leave it for our office. Everything else is said as it is.
    IF failed LIKE 'The bank alert for UTR % shows Rs %' THEN
      RAISE EXCEPTION 'The bank shows a different amount for UTR %. Leave this payment for our office.', s.utr;
    ELSIF failed LIKE 'Only % left of % at its godown%' OR failed LIKE 'Only % ready now%' THEN
      RAISE EXCEPTION 'Not enough stock is left at your godown to place this order again. Leave it for our office.';
    ELSIF failed LIKE 'The customer sent this UTR on order %' THEN
      RAISE EXCEPTION 'This UTR was also sent on another order. Leave this payment for our office.';
    ELSIF failed LIKE 'This UTR was sent for an order of Rs % that lapsed%' OR failed LIKE 'This transfer reference has already been recorded on this order.%' THEN
      RAISE EXCEPTION 'This UTR was sent for another checkout. Leave this payment for our office.';
    END IF;
    RAISE EXCEPTION '%', failed;
  WHEN deadlock_detected THEN
    -- Our office decided on this same UTR at the same moment: nothing was changed.
    RAISE EXCEPTION 'Our office is working on this payment right now. Check the list again in a moment.';
  END;
  PERFORM set_config('app.partner_payment', '', true);
  SELECT * INTO after FROM public.orders WHERE id = o.id;
  -- Who approved it stays on the order's history.
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
  VALUES (o.id, after.order_status,
    left(format('Payment approved by channel partner %s at %s: UTR %s, Rs %s, after checking %s.', me.name, godown, s.utr, to_char(amount, 'FM99999990.00'), checked), 500),
    'partner', me.id);
  -- Our office hears of every approval by a partner, to check it in the company's bank account.
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', 'Payment approved by channel partner',
    format('%s (channel partner, %s) approved UTR %s for ₹%s on order %s after checking %s. Check it in the bank account.',
      me.name, godown, s.utr, to_char(amount, 'FM99999990.00'), o.order_no, checked),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN jsonb_build_object('order_no', o.order_no, 'utr', s.utr, 'amount', amount, 'status', after.order_status, 'payment_status', after.payment_status);
END;
$function$;
