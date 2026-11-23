-- A sales order voided in Zoho closes the website order too, and such an order can be deleted (owner, 7 Nov 2026).
--
-- What happened: ORD-26889 was voided in the official Zoho books, but the website kept it as Delivered, still offered
-- Re-sync, delivery-note and stage buttons, and every refresh failed with "void in Zoho, but ... is Delivered". The
-- website applied a Zoho void only before dispatch, and an order that had ever gone to Zoho could never be deleted.
--
-- Now:
--   apply_zoho_order_cancellation(): a Zoho void or cancel closes the order whatever its stage, unless money was
--     received here (then it stays for a refund, as before). Before dispatch, stock and batches go back as before.
--     After dispatch the goods left the godown on the website's record, so the website changes no stock: Zoho is the
--     stock master, and its stock after the void reaches the godowns at the next stock read.
--   guard_order_mutation(): lets that one function cancel a dispatched order (flag app.zoho_void). Everyone else is
--     still refused after dispatch.
--   order_delete_reason_internal(): an order whose sales order is void (or cancelled) in Zoho can be deleted when
--     nothing else keeps it: no money, no live Zoho invoice (void, deleted or never made), no delivery note, no push
--     to Zoho running or unanswered. An order still alive in Zoho stays, as before.
--   admin_delete_order(): the deleted-orders log keeps the Zoho sales order ID and its Zoho status.
--   Once, at the end: orders whose sales order the website already knows is void in Zoho are closed the same way.
--     On 7 Nov that is ORD-24198 and ORD-26889 (Delivered, unpaid). ORD-26102686593 has ₹2,518.95 recorded as paid,
--     so it stays open with its review. Their old "void in Zoho, but Delivered" reviews are closed.
-- Built from the live definitions of 7 Nov 2026, changed only where these comments say.

BEGIN;

ALTER TABLE public.deleted_orders_log ADD COLUMN IF NOT EXISTS zoho_salesorder_id text NOT NULL DEFAULT '';
ALTER TABLE public.deleted_orders_log ADD COLUMN IF NOT EXISTS zoho_order_status text NOT NULL DEFAULT '';
COMMENT ON COLUMN public.deleted_orders_log.zoho_salesorder_id IS 'The Zoho sales order of the deleted order. Zoho keeps it, void, on record.';

-- ---------------------------------------------------------------- Zoho void or cancel -> website order
CREATE OR REPLACE FUNCTION public.apply_zoho_order_cancellation(_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
  after_dispatch boolean;
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);

  IF target.order_status = 'Cancelled' THEN RETURN 'already_cancelled'; END IF;

  -- Money received here must be refunded first, at any stage.
  IF COALESCE(target.paid_amount, 0) > 0 OR target.payment_status IN ('Paid', 'Partially Paid') THEN
    RETURN 'blocked_paid';
  END IF;

  -- Zoho is the official book: a void there closes the order here after dispatch too.
  after_dispatch := target.order_status IN ('Dispatched', 'Out for Delivery', 'Delivered');
  IF NOT after_dispatch AND target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN
    RETURN 'blocked_after_dispatch';
  END IF;

  -- Before dispatch the goods are still in the godown: stock and batches go back, as before.
  -- After dispatch they left on the website's record, and Zoho's stock after the void reaches the godowns at the next stock read.
  IF NOT after_dispatch THEN
    FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP
      UPDATE public.catalog_products
        SET payload = jsonb_set(
          jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
          '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),
          true
        ), updated_at = now()
        WHERE id = line.product_id;
    END LOOP;

    FOR allocation_row IN
      SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
      FROM public.order_item_batch_allocations a
      JOIN public.order_items oi ON oi.id = a.order_item_id
      WHERE oi.order_id = target.id AND a.released_quantity < a.reserved_quantity
      ORDER BY a.created_at, a.id
      FOR UPDATE OF a
    LOOP
      restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;
      UPDATE public.batches
        SET remaining_quantity = remaining_quantity + restore_qty,
            status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END
        WHERE id = allocation_row.batch_id;
      UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity
        WHERE id = allocation_row.id;
    END LOOP;
  END IF;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;

  -- Set only now, so the stock changes above are still queued for Zoho; the order change itself
  -- came from Zoho and is not sent back.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  PERFORM set_config('app.zoho_void', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0
    WHERE id = target.id;
  PERFORM set_config('app.zoho_void', 'off', true);
  RETURN CASE WHEN after_dispatch THEN 'cancelled_after_dispatch' ELSE 'cancelled' END;
END
$function$;
REVOKE ALL ON FUNCTION public.apply_zoho_order_cancellation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_order_cancellation(uuid) TO service_role;

-- ---------------------------------------------------------------- the order guard: one change, marked
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE required_advance numeric(14,2);
BEGIN
  -- The trusted server (service role) may record Zoho bookkeeping on any order, and nothing else.
  IF current_user = 'service_role'
    AND (to_jsonb(NEW) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['zoho_salesorder_id','zoho_last_polled_at','zoho_order_status','zoho_last_modified_at','updated_at']) THEN
    RETURN NEW;
  END IF;

  IF OLD.order_status = 'Cancelled' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'Cancelled orders cannot be reopened';
  END IF;
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on' AND EXISTS (
    SELECT 1 FROM public.order_vendor_fulfillments f
    WHERE f.order_id = OLD.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered')
  ) THEN
    RAISE EXCEPTION 'Orders cannot be cancelled after any vendor has dispatched';
  END IF;
  -- A held (unpaid) request leaves "Awaiting Payment" only by being paid in full or expiring.
  IF OLD.order_status = 'Awaiting Payment' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (NEW.order_status = 'Payment Confirmed' AND NEW.payment_status = 'Paid')
    AND NOT (NEW.order_status IN ('Payment Expired', 'Cancelled')) THEN
    RAISE EXCEPTION 'Confirm the full payment before this order moves on';
  END IF;
  IF NEW.order_status = 'Payment Expired' AND OLD.order_status <> 'Payment Expired'
    AND current_setting('app.payment_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected payment workflow';
  END IF;

  -- The pay-first functions (hold, auto-confirm from the bank alert, expiry) check everything themselves.
  IF current_setting('app.payment_workflow', true) = 'on' THEN RETURN NEW; END IF;

  -- Changes applied from Zoho by the SECURITY DEFINER Zoho functions below (shipment milestones,
  -- Zoho cancellations). The cancellation checks above still apply to them.
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;

  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;

  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND NEW.order_status = 'Cancelled'
    AND EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    ) THEN
    RAISE EXCEPTION 'Customer cancellation is unavailable after a vendor has started fulfilment';
  END IF;

  IF current_setting('app.cancel_order_workflow', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed')
    AND NEW.order_status = 'Cancelled'
    AND COALESCE(OLD.paid_amount, 0) = 0
    AND OLD.payment_status NOT IN ('Paid', 'Partially Paid')
    AND NEW.advance_due = 0
    AND NEW.balance_due = 0
    AND NOT EXISTS (
      SELECT 1 FROM public.order_vendor_fulfillments f
      WHERE f.order_id = OLD.id AND f.status NOT IN ('Placed', 'Payment Confirmed', 'Cancelled')
    )
    AND (to_jsonb(NEW) - ARRAY['order_status','advance_due','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','advance_due','balance_due']) THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;

  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;

  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids) THEN
    required_advance := round(OLD.total * COALESCE((
      SELECT NULLIF(value->>'advance_percent', '')::numeric
      FROM public.settings WHERE key = 'order'
    ), 30) / 100, 2);
    IF OLD.order_status = 'Payment Confirmed' AND NEW.order_status = 'Accepted'
      AND OLD.paid_amount >= required_advance THEN
      RETURN NEW;
    END IF;
    IF (OLD.order_status = 'Accepted' AND NEW.order_status = 'Packed')
      OR (OLD.order_status = 'Packed' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Dispatched')
      OR (OLD.order_status = 'Dispatched' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Out for Delivery')
      OR (OLD.order_status = 'Out for Delivery' AND OLD.payment_status = 'Paid' AND NEW.order_status = 'Delivered') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Vendor order updates must follow the next allowed step, meet the required advance, and be fully paid before dispatch';
END
$function$;

-- ---------------------------------------------------------------- why an order must stay
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
  -- Changed 7 Nov 2026: an order whose sales order is void (or cancelled) in Zoho may go. One still alive in Zoho stays,
  -- and so does one whose push to Zoho is running or just got no clear answer (the same 10 minutes the push itself waits),
  -- since Zoho may hold more than the website knows.
  IF EXISTS (SELECT 1 FROM public.zoho_order_push_claims z WHERE z.order_id = o.id
      AND ((z.locked_until IS NOT NULL AND z.locked_until > now()) OR z.write_unanswered_at > now() - interval '10 minutes')) THEN
    RETURN 'A push to Zoho for this order is running or got no clear answer, so it stays. Wait 10 minutes, open the order again, then try again.';
  END IF;
  IF COALESCE(o.zoho_salesorder_id, '') = '' AND EXISTS (SELECT 1 FROM public.zoho_order_push_claims z WHERE z.order_id = o.id) THEN
    RETURN 'This order was sent to Zoho, so it stays to match Zoho.';
  END IF;
  IF COALESCE(o.zoho_salesorder_id, '') <> '' AND COALESCE(o.zoho_order_status, '') NOT IN ('void', 'cancelled') THEN
    RETURN 'This order was sent to Zoho, so it stays to match Zoho. It can be deleted once its sales order is void in Zoho.';
  END IF;
  -- Changed 7 Nov 2026: an invoice that is void or deleted in Zoho, or was never made, no longer keeps the order.
  IF EXISTS (SELECT 1 FROM public.zoho_order_invoices i WHERE i.order_id = o.id
      AND COALESCE(i.status, 'none') NOT IN ('none', 'void', 'deleted', 'awaiting_approval')) THEN
    RETURN 'Zoho Books has a live invoice for this order, so it stays. Void or delete the invoice in Zoho, then open the order again.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.order_id = o.id) THEN
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
END $function$;
REVOKE ALL ON FUNCTION public.order_delete_reason_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_delete_reason_internal(uuid) TO service_role;

-- ---------------------------------------------------------------- admin: delete it (the log keeps the Zoho sales order)
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
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name, utrs,
    zoho_salesorder_id, zoho_order_status)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, left(btrim(COALESCE(_reason, '')), 300),
    auth.uid(), COALESCE(who_name, ''), left(COALESCE(utr_list, ''), 1000),
    COALESCE(o.zoho_salesorder_id, ''), COALESCE(o.zoho_order_status, ''));

  -- Deleting the items would queue a Zoho push for an order that is about to be gone: say this is not a change for Zoho.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$;
REVOKE ALL ON FUNCTION public.admin_delete_order(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_order(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------- once: orders already known to be void in Zoho
DO $backfill$
DECLARE
  r record;
  outcome text;
BEGIN
  FOR r IN
    SELECT id, order_no FROM public.orders
    WHERE zoho_order_status IN ('void', 'cancelled')
      AND order_status NOT IN ('Cancelled', 'Payment Expired', 'Awaiting Payment')
    ORDER BY created_at, id
  LOOP
    outcome := public.apply_zoho_order_cancellation(r.id);
    IF outcome LIKE 'cancelled%' THEN
      UPDATE public.zoho_sync_outbox
        SET status = 'complete', last_error = 'Closed: the sales order is void in Zoho, so the order was cancelled here too.', updated_at = now()
        WHERE entity_type = 'order' AND entity_id = r.id::text AND status IN ('needs_review', 'failed');
    END IF;
    RAISE NOTICE 'Zoho void: % %', r.order_no, outcome;
  END LOOP;
  -- What apply_zoho_order_cancellation left on for this transaction.
  PERFORM set_config('app.zoho_inbound', 'off', true);
  PERFORM set_config('app.cancel_order_workflow', 'off', true);
END
$backfill$;

NOTIFY pgrst, 'reload schema';

COMMIT;
