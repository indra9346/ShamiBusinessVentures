-- Reject a UTR and end the checkout in one step; delete ended checkouts whose UTR an admin rejected (owner, 6 Nov 2026).
--
-- What happened: an admin rejected a fake NEFT UTR to make the checkout inactive. Rejecting gives the customer time to
-- send the right UTR (1 hour for a bank transfer), so the checkout's timer started again and its 11 bags stayed held in
-- their batches. Ending it needed a second step (End checkout). And an ended checkout whose UTR an admin had rejected
-- could never be deleted: any UTR at all kept it.
--
-- Now:
--   admin_reject_utr_and_end_checkout(): rejects the UTR (with the admin's note, as a reject does) and ends the checkout
--     at once: stock back on sale, the customer told it was not placed. The plain reject is unchanged.
--   order_delete_reason_internal(): an ended checkout whose UTRs an admin checked and rejected, or whose money went to
--     the customer's new order, can be deleted. One whose UTR was refunded, confirmed, still waiting, or never checked
--     against the bank still stays, with a reason that says which.
--   admin_delete_order(): the deleted-orders log keeps the UTRs the customer sent (new column utrs).
-- Built from the live definitions of 6 Nov 2026, changed only where these comments say.

BEGIN;

ALTER TABLE public.deleted_orders_log ADD COLUMN IF NOT EXISTS utrs text NOT NULL DEFAULT '';
COMMENT ON COLUMN public.deleted_orders_log.utrs IS 'The UTRs the customer sent on the deleted checkout, with how each ended.';

CREATE OR REPLACE FUNCTION public.order_delete_reason_internal(_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  held numeric;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN 'This order no longer exists.'; END IF;
  IF o.order_status NOT IN ('Payment Expired', 'Cancelled') THEN
    RETURN 'Only an order whose payment window ran out, or a cancelled order, can be deleted.';
  END IF;
  IF COALESCE(o.paid_amount, 0) > 0 OR COALESCE(o.payment_status, '') IN ('Paid', 'Partially Paid', 'Refunded')
     OR EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id) THEN
    RETURN 'Money was recorded on this order, so it stays for the accounts.';
  END IF;
  -- A UTR that an admin checked against the bank and rejected, or whose money went to the customer's new order, leaves
  -- nothing here to keep: the delete log keeps the UTR. Any other UTR may stand for money in the bank.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
    RETURN 'A UTR on this checkout still waits for a check, so it stays.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'confirmed') THEN
    RETURN 'Money was recorded on this order, so it stays for the accounts.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.note = 'refunded by our team') THEN
    RETURN 'Money came for this checkout and was refunded, so it stays for the accounts.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id
      AND COALESCE(s.note, '') NOT LIKE 'Placed again as %'
      AND (s.reviewed_by IS NULL OR s.note = 'we could not check your UTR in time')) THEN
    RETURN 'Nobody checked the customer''s UTR against the bank. Check the bank for that transfer first, then confirm it on a new order, or refund it and mark it refunded.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_credits c WHERE c.order_id = o.id) THEN
    RETURN 'A bank credit is linked to this order, so it stays for the accounts.';
  END IF;
  IF COALESCE(o.zoho_salesorder_id, '') <> '' OR EXISTS (SELECT 1 FROM public.zoho_order_push_claims z WHERE z.order_id = o.id) THEN
    RETURN 'This order was sent to Zoho, so it stays to match Zoho.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_order_invoices i WHERE i.order_id = o.id)
     OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.order_id = o.id) THEN
    RETURN 'An invoice exists for this order, so it stays.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.order_id = o.id)
     OR EXISTS (SELECT 1 FROM public.delivery_stops d WHERE d.order_id = o.id) THEN
    RETURN 'A delivery note exists for this order, so it stays.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id AND c.status <> 'cancelled') THEN
    RETURN 'A partner commission is recorded on this order, so it stays.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.product_reviews r WHERE r.order_id = o.id)
     OR EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = o.id) THEN
    RETURN 'This order has a review or a return, so it stays.';
  END IF;
  IF o.payment_hold_until IS NOT NULL AND o.payment_hold_until > now() THEN
    RETURN 'Its payment window is still open.';
  END IF;
  SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0) INTO held
    FROM public.order_item_batch_allocations a JOIN public.order_items i ON i.id = a.order_item_id
    WHERE i.order_id = o.id;
  IF held > 0 THEN RETURN 'Stock is still held for this order.'; END IF;
  RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.admin_delete_order(_order_no text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text;
  items integer;
  who_name text;
  utr_list text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order no longer exists.'; END IF;
  why := public.order_delete_reason_internal(o.id);
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why; END IF;

  SELECT count(*) INTO items FROM public.order_items WHERE order_id = o.id;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who_name FROM public.profiles p WHERE p.id = auth.uid();
  -- The UTRs the customer sent stay on record with the delete.
  SELECT string_agg(s.utr || ' (' || s.status || COALESCE(': ' || s.note, '') || ')', '; ' ORDER BY s.submitted_at) INTO utr_list
    FROM public.upi_payment_submissions s WHERE s.order_id = o.id;
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name, utrs)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, left(btrim(COALESCE(_reason, '')), 300),
    auth.uid(), COALESCE(who_name, ''), left(COALESCE(utr_list, ''), 1000));

  -- Deleting the items would queue a Zoho push for an order that is about to be gone: say this is not a change for Zoho.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$
;


-- Reject the customer's UTR and end the checkout in one step.
CREATE OR REPLACE FUNCTION public.admin_reject_utr_and_end_checkout(_order_no text, _note text, _expected_utr text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  sent_utr text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can reject a UTR'; END IF;
  -- The same locks, in the same order, as review_upi_utr.
  SELECT utr INTO sent_utr FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF sent_utr IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(sent_utr)) AS key; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UTR was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  IF _expected_utr IS NOT NULL AND upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the bank again.', s.utr;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
  IF o.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Only a checkout waiting for payment can be ended'; END IF;
  UPDATE public.upi_payment_submissions
     SET status = 'rejected', note = NULLIF(trim(COALESCE(_note, '')), ''), reviewed_at = now(), reviewed_by = auth.uid(),
         rejections = rejections + 1
   WHERE id = s.id;
  -- Stock back on sale; the customer is told it was not placed (one message, not "send the correct UTR").
  PERFORM private.release_payment_hold(o.id, 'the UTR you sent could not be matched', 'ended');
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_reject_utr_and_end_checkout(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reject_utr_and_end_checkout(text, text, text) TO authenticated, service_role;

COMMIT;
