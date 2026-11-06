-- Owner's decision, 6 Nov 2026: a partner commission keeps an order only while it can still be earned. When every
-- commission on the order is cancelled (it was never earned, it is worth nothing and nothing refers to it), the order
-- can be deleted and its cancelled commission rows go with it. Every other rule of 20261106120000 is unchanged.
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

NOTIFY pgrst, 'reload schema';
