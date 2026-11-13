-- 13 Nov 2026 (owner, on the website's tax invoice): "Add Location QR here (location link will be uploaded in admin panel
-- for godown location) and show Collect goods from here and rest details" and "Channel partner need option to confirm
-- the order & get invoice also".
--
-- 1. branches.map_url, the godown's location link that Admin > Godowns saves and the invoice prints as a QR: an https
--    link of at most 150 characters, or nothing. A longer link (a Google Maps address-bar link is often 250-500) makes a
--    QR too dense to read from paper; Google Maps' Share > Copy link gives a short maps.app.goo.gl link. NOT VALID: rows
--    saved before are left as they are (the invoice prints only a link that passes the same rule; on 13 Nov 2026 both
--    godowns had none).
-- 2. A channel partner confirms an order of their own godown, with the same effect as an admin's "Mark as Confirmed"
--    (admin_update_order_status to Accepted): the same UPDATE, so the same triggers run (Zoho sync job and, from it, the
--    Zoho Books invoice; notifications to the customer, vendors and every admin; partner commission status; vendor
--    fulfilments). Stock and batches are not touched by a confirm, for the admin either (they move at checkout and at
--    cancellation).
--    The money rule: payment approval stays with the office. A partner may confirm only an order whose payment is
--    already settled in full (payment_status 'Paid', which only the office's payment functions and the bank alert set),
--    from Placed or Payment Confirmed, never a checkout waiting for payment (Awaiting Payment), an ended one (Payment
--    Expired), a cancelled order, or one void in Zoho. There is no pay-at-godown or credit sale on the site today
--    (settings.order.cod_enabled is false and require_payment_first refuses unpaid customer orders), so nothing else
--    qualifies. A partly paid order stays for the admin, who can still move it (with the advance warning).
--    partner_orders_to_confirm lists the godown's orders waiting for that, and the ones confirmed by a partner in the
--    last 3 days, with whether the partner may open each invoice (partner_invoice_order's rule: orders placed while they
--    ran the godown).
-- 3. Who confirmed an order can be trusted. order_tracking rows are written only by the database's own SECURITY DEFINER
--    functions (vendor_update_order_fulfillment and partner_confirm_order); the site never inserts them. The old
--    tracking_insert policy still let any signed-in customer or vendor of an order add a row of their own, so a
--    "Confirmed by channel partner" line (or a vendor's shipment line) could be made up. That right is withdrawn, and a
--    partner's confirm also keeps the channel partner's id (order_tracking.partner_id), which is what
--    partner_orders_to_confirm reads.
-- guard_order_mutation and sync_order_vendor_fulfillments are the live definitions (read 13 Nov 2026) with only the
-- app.partner_confirm lines added.

ALTER TABLE public.branches DROP CONSTRAINT IF EXISTS branches_map_url_https;
ALTER TABLE public.branches ADD CONSTRAINT branches_map_url_https
  CHECK (map_url = '' OR (map_url ~ '^https://[^[:space:]]+$' AND char_length(map_url) <= 150)) NOT VALID;

DROP POLICY IF EXISTS tracking_insert ON public.order_tracking;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.order_tracking FROM PUBLIC, anon, authenticated;
ALTER TABLE public.order_tracking ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.channel_partners(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.order_tracking.partner_id IS
  'The channel partner who made this step (partner_confirm_order). Only the database''s own functions write order_tracking.';

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
  -- Changed 12 Nov 2026: admin_place_ended_checkout (flag app.revive_checkout) takes a checkout that ended without payment
  -- back to Awaiting Payment for a moment, when the admin has found its payment in the bank; it is paid in the same step.
  IF OLD.order_status = 'Payment Expired' AND NEW.order_status IS DISTINCT FROM OLD.order_status
    AND NOT (current_setting('app.revive_checkout', true) = 'on' AND NEW.order_status = 'Awaiting Payment') THEN
    RAISE EXCEPTION 'This order was not paid in time and cannot be reopened; place a new order';
  END IF;
  IF NEW.order_status = 'Cancelled' AND OLD.order_status <> 'Cancelled'
    AND current_setting('app.cancel_order_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Use the protected order cancellation workflow';
  END IF;
  -- Changed 7 Nov 2026: apply_zoho_order_cancellation (flag app.zoho_void) may close a dispatched order whose sales order is void in Zoho.
  -- Changed 11 Nov 2026: so may an admin, through admin_cancel_order (flag app.admin_cancel), saying whether the goods came back.
  IF NEW.order_status = 'Cancelled' AND current_setting('app.zoho_void', true) IS DISTINCT FROM 'on'
    AND current_setting('app.admin_cancel', true) IS DISTINCT FROM 'on' AND EXISTS (
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

  -- Added 10 Nov 2026 (20261110120000_delivery_paper_qr.sql): every item on the order's delivery note was handed over
  -- at the godown on a QR scan, so delivery_paper_scan marks it Delivered. Only the status may change.
  IF current_setting('app.delivery_handover', true) = 'on'
    AND NEW.order_status = 'Delivered'
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- Added 13 Nov 2026 (20261113230000_godown_location_partner_confirm.sql): partner_confirm_order (flag app.partner_confirm)
  -- lets the active channel partner of the order's own godown confirm it, as an admin's "Mark as Confirmed" does: only
  -- from Placed or Payment Confirmed, only to Accepted, only when the payment is settled in full, and nothing else changes.
  IF current_setting('app.partner_confirm', true) = 'on'
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Accepted'
    AND OLD.payment_status = 'Paid'
    AND OLD.branch_id IS NOT NULL AND OLD.branch_id = public.current_partner_branch()
    AND (to_jsonb(NEW) - ARRAY['order_status','updated_at']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['order_status','updated_at']) THEN
    RETURN NEW;
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
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due','gst_amount','discount_taxable']) THEN
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

CREATE OR REPLACE FUNCTION public.sync_order_vendor_fulfillments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE syncing_setting text;
BEGIN
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  -- An unpaid checkout has no fulfilment to move. In an admin's session this copy broke the status CHECK.
  IF NEW.order_status IN ('Awaiting Payment', 'Payment Expired') THEN RETURN NEW; END IF;
  syncing_setting := COALESCE(current_setting('app.syncing_vendor_fulfillments', true), 'off');
  IF NEW.order_status = 'Cancelled' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = 'Cancelled', updated_at = now()
      WHERE order_id = NEW.id AND status <> 'Cancelled';
  -- Changed 13 Nov 2026: a channel partner's confirm (partner_confirm_order, flag app.partner_confirm) moves the
  -- fulfilments with the order, exactly as an admin's status change does.
  ELSIF public.has_role(auth.uid(), 'admin') OR current_setting('app.partner_confirm', true) = 'on' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = NEW.order_status, updated_at = now()
      WHERE order_id = NEW.id AND status IS DISTINCT FROM NEW.order_status;
  ELSIF OLD.order_status IN ('Placed', 'Awaiting Payment') AND NEW.order_status = 'Payment Confirmed' THEN
    PERFORM set_config('app.syncing_vendor_fulfillments', 'on', true);
    UPDATE public.order_vendor_fulfillments SET status = 'Payment Confirmed', updated_at = now()
      WHERE order_id = NEW.id AND status IN ('Placed', 'Awaiting Payment');
  END IF;
  PERFORM set_config('app.syncing_vendor_fulfillments', COALESCE(syncing_setting, 'off'), true);
  RETURN NEW;
END;
$function$;

/**
 * The channel partner confirms an order of their own godown (13 Nov 2026). Returns {order_no, status, confirmed, already}:
 * already = true when it was confirmed before (a second press does nothing). The order's number and godown are checked
 * together, so another godown's order looks exactly like one that does not exist.
 */
CREATE OR REPLACE FUNCTION public.partner_confirm_order(_order_no text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
  o public.orders%ROWTYPE;
  godown text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can confirm orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND OR o.branch_id IS DISTINCT FROM me.branch_id THEN
    RAISE EXCEPTION 'This is not an order of your godown';
  END IF;
  IF o.order_status IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RETURN jsonb_build_object('order_no', o.order_no, 'status', o.order_status, 'confirmed', false, 'already', true);
  END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is cancelled, so there is nothing to confirm'; END IF;
  IF o.order_status IN ('Awaiting Payment', 'Payment Expired') THEN
    RAISE EXCEPTION 'This checkout is not a paid order. Our office confirms the payment first; the order then shows here to confirm';
  END IF;
  IF o.order_status NOT IN ('Placed', 'Payment Confirmed') THEN
    RAISE EXCEPTION 'This order cannot be confirmed here (it is %)', o.order_status;
  END IF;
  IF lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled') THEN
    RAISE EXCEPTION 'This order is void in Zoho. Our office decides what happens to it';
  END IF;
  -- Money stays with the office: only an order whose payment the office (or the bank alert) has settled in full.
  IF o.payment_status = 'Refunded' THEN
    RAISE EXCEPTION 'This order''s payment was refunded, so it cannot be confirmed';
  END IF;
  IF o.payment_status IS DISTINCT FROM 'Paid' THEN
    RAISE EXCEPTION 'This order is not fully paid yet. Only our office confirms payments; once it has, you can confirm the order here';
  END IF;
  SELECT b.name INTO godown FROM public.branches b WHERE b.id = o.branch_id;
  -- The same UPDATE as admin_update_order_status, so every trigger does what it does for an admin.
  PERFORM set_config('app.partner_confirm', 'on', true);
  UPDATE public.orders SET order_status = 'Accepted' WHERE id = o.id;
  PERFORM set_config('app.partner_confirm', 'off', true);
  INSERT INTO public.order_tracking (order_id, status, note, actor_role, partner_id)
    VALUES (o.id, 'Accepted', format('Confirmed by channel partner %s at %s.', me.name, COALESCE(godown, o.branch_id)), 'partner', me.id);
  RETURN jsonb_build_object('order_no', o.order_no, 'status', 'Accepted', 'confirmed', true, 'already', false);
END $function$;
REVOKE ALL ON FUNCTION public.partner_confirm_order(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_confirm_order(text) TO authenticated;

/**
 * The partner's own godown's orders waiting to be confirmed (Placed or Payment Confirmed, whatever their payment: the
 * page says why one cannot be confirmed yet), then those confirmed by a partner in the last 3 days and still Accepted,
 * so the invoice can be opened right after. invoice_mine: partner_invoice_order lets this partner open that invoice.
 */
CREATE OR REPLACE FUNCTION public.partner_orders_to_confirm()
RETURNS TABLE (order_no text, placed_at timestamptz, order_status text, payment_status text, payment_method text,
  shipping_method text, total numeric, paid_amount numeric, customer text, items text, zoho_void boolean,
  invoice_number text, invoice_mine boolean, confirmed_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  me public.channel_partners%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners p WHERE p.user_id = auth.uid() AND p.status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can confirm orders'; END IF;
  RETURN QUERY
  SELECT o.order_no, o.created_at, o.order_status, o.payment_status, COALESCE(o.payment_method, ''), COALESCE(o.shipping_method, ''),
    o.total, COALESCE(o.paid_amount, 0),
    left(COALESCE(NULLIF(btrim(o.customer_name), ''), 'Customer'), 60),
    (SELECT string_agg(i.product_name || ' × ' || to_char(i.qty, 'FM99999990.##'), ', ' ORDER BY i.product_name)
       FROM public.order_items i WHERE i.order_id = o.id),
    lower(COALESCE(o.zoho_order_status, '')) IN ('void', 'cancelled'),
    (SELECT z.invoice_number FROM public.zoho_order_invoices z WHERE z.order_id = o.id LIMIT 1),
    COALESCE(private.order_signing_partner(o.id) = me.id, false),
    t.created_at
  FROM public.orders o
  -- A partner's confirm is the row partner_confirm_order wrote, with the partner's id (nobody else can write one).
  LEFT JOIN LATERAL (
    SELECT tr.created_at FROM public.order_tracking tr
    WHERE tr.order_id = o.id AND tr.partner_id IS NOT NULL AND tr.status = 'Accepted'
    ORDER BY tr.created_at DESC LIMIT 1) t ON true
  WHERE o.branch_id = me.branch_id
    AND (o.order_status IN ('Placed', 'Payment Confirmed')
      OR (o.order_status = 'Accepted' AND t.created_at > now() - interval '3 days'))
  ORDER BY (o.order_status = 'Accepted'), o.created_at
  LIMIT 200;
END $function$;
REVOKE ALL ON FUNCTION public.partner_orders_to_confirm() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_orders_to_confirm() TO authenticated;
