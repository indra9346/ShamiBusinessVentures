-- Admins can delete an order that never went anywhere (client request, 6 Nov 2026): its payment window ran out,
-- or it was cancelled, and nothing was paid, sent to Zoho, invoiced, delivered, reviewed or returned. One
-- transaction removes the order and what cascades from it. Nothing in Zoho is touched and stock does not change.
-- Every delete leaves a row in deleted_orders_log, and a deleted order number is never used again. Only adds.

-- ---------------------------------------------------------------- the record of each delete
CREATE TABLE IF NOT EXISTS public.deleted_orders_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  order_status text NOT NULL,
  total numeric(14,2) NOT NULL,
  item_count integer NOT NULL DEFAULT 0,
  order_created_at timestamptz,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  deleted_by uuid,
  deleted_by_name text NOT NULL DEFAULT '',
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deleted_orders_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_orders_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.deleted_orders_log TO authenticated;
GRANT ALL ON public.deleted_orders_log TO service_role;
DROP POLICY IF EXISTS deleted_orders_log_admin_read ON public.deleted_orders_log;
CREATE POLICY deleted_orders_log_admin_read ON public.deleted_orders_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- why an order must stay (server only)
/** NULL when the order may be deleted, otherwise the reason it stays, in words an admin can act on. */
CREATE OR REPLACE FUNCTION public.order_delete_reason_internal(_order_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
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
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id) THEN
    RETURN 'The customer sent a UTR for this order, so it stays. Check the bank for that transfer.';
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
  IF EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id) THEN
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

-- ---------------------------------------------------------------- admin: can it be deleted?
CREATE OR REPLACE FUNCTION public.order_delete_blocker(_order_no text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  target uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT id INTO target FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND THEN RETURN 'This order no longer exists.'; END IF;
  RETURN public.order_delete_reason_internal(target);
END $function$;
REVOKE ALL ON FUNCTION public.order_delete_blocker(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_delete_blocker(text) TO authenticated, service_role;

-- ---------------------------------------------------------------- admin: delete it
CREATE OR REPLACE FUNCTION public.admin_delete_order(_order_no text, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text;
  items integer;
  who_name text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order no longer exists.'; END IF;
  why := public.order_delete_reason_internal(o.id);
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why; END IF;

  SELECT count(*) INTO items FROM public.order_items WHERE order_id = o.id;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who_name FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, left(btrim(COALESCE(_reason, '')), 300),
    auth.uid(), COALESCE(who_name, ''));

  -- Deleting the items would queue a Zoho push for an order that is about to be gone: say this is not a change for Zoho.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$;
REVOKE ALL ON FUNCTION public.admin_delete_order(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_order(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------- a deleted number is never used again
CREATE OR REPLACE FUNCTION public.orders_never_reuse_deleted_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.deleted_orders_log WHERE order_no = NEW.order_no) THEN
    RAISE EXCEPTION 'Order number % was used before and deleted, so it cannot be used again', NEW.order_no;
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS orders_never_reuse_deleted_number ON public.orders;
CREATE TRIGGER orders_never_reuse_deleted_number BEFORE INSERT OR UPDATE OF order_no ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_never_reuse_deleted_number();

NOTIFY pgrst, 'reload schema';
