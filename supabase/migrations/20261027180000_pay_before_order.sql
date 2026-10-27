-- Pay first, then the order is placed.
--
-- A customer's checkout no longer creates an order straight away. It creates a held request
-- ("Awaiting Payment"): prices and stock are locked for the payment window, but the godown, the
-- channel partner, vendors and admins are not told about a new order, nothing goes to Zoho and the
-- reports leave it out. The customer pays the company's own UPI ID (zero fee).
--
-- The payment is captured automatically: the company phone forwards the bank's credit SMS to the
-- website (POST /api/payments/bank-alert), which calls record_bank_credit with the UTR and amount.
-- A credit that matches a held request confirms it at once: the order becomes "Payment Confirmed"
-- (paid in full), everyone is notified as for a new order, and it goes to Zoho. The customer may
-- also type the UTR; an admin can still confirm by hand from Admin > UPI Payments.
--
-- A request that is not paid in time becomes "Payment Expired": its stock and coupon are given
-- back and it never counts as an order. A credit that arrives for an expired request, matches more
-- than one request, or has the wrong amount is kept for an admin to settle (refund or call).
--
-- Customers cannot create an order any other way: a customer insert into orders outside this
-- checkout is refused. Orders an admin enters for a customer are unchanged.

-- ---------------------------------------------------------------- columns
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_hold_until timestamptz;
-- Why a held request ended without payment: expired (time ran out) or dropped (customer/admin cancelled it).
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_hold_outcome text CHECK (payment_hold_outcome IN ('expired', 'dropped'));
CREATE INDEX IF NOT EXISTS orders_awaiting_payment ON public.orders (payment_hold_until)
  WHERE order_status = 'Awaiting Payment';

-- ---------------------------------------------------------------- bank credits (from SMS alerts)
CREATE TABLE IF NOT EXISTS public.bank_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'sms',
  sender text,
  raw text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  utr text NOT NULL UNIQUE CHECK (utr ~ '^[0-9]{12}$'),
  payer text,
  status text NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('matched', 'unmatched', 'ambiguous', 'mismatch', 'late', 'settled')),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  order_no text,
  note text
);
CREATE INDEX IF NOT EXISTS bank_credits_recent ON public.bank_credits (received_at DESC);
ALTER TABLE public.bank_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_credits_admin_read ON public.bank_credits;
CREATE POLICY bank_credits_admin_read ON public.bank_credits FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
REVOKE INSERT, UPDATE, DELETE ON public.bank_credits FROM anon, authenticated;
GRANT SELECT ON public.bank_credits TO authenticated;

-- ---------------------------------------------------------------- order guard
-- The live guard, plus: the pay-first workflow functions below may move held orders; a held order
-- becomes an order only through a full payment; an expired request can never be reopened.
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
  IF NEW.order_status = 'Cancelled' AND EXISTS (
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

-- ---------------------------------------------------------------- customers pay first
/** A customer can create an order only through start_paid_checkout (admins still enter orders for customers). */
CREATE OR REPLACE FUNCTION public.require_payment_first()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
    AND public.has_role(auth.uid(), 'customer')
    AND NOT public.has_role(auth.uid(), 'admin')
    AND current_setting('app.pay_first', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Pay for your order to place it';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS orders_require_payment_first ON public.orders;
CREATE TRIGGER orders_require_payment_first BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.require_payment_first();

-- ---------------------------------------------------------------- notifications
-- The live notifier, but a held request tells no one, and the moment it is paid is announced as a
-- new order (plus the payment) to the customer, vendors and admins.
CREATE OR REPLACE FUNCTION public.notify_order_participants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  alert_titles text[] := ARRAY[]::text[];
  alert_messages text[] := ARRAY[]::text[];
  alert_statuses text[] := ARRAY[]::text[];
  event_index integer;
  is_new boolean;
BEGIN
  IF current_setting('app.pay_first', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.order_status IN ('Awaiting Payment', 'Payment Expired') THEN RETURN NEW; END IF;
  is_new := TG_OP = 'INSERT' OR OLD.order_status = 'Awaiting Payment';

  IF is_new THEN
    alert_titles := array_append(alert_titles, 'New order received');
    alert_messages := array_append(alert_messages,
      format('Order %s was placed for ₹%s.', NEW.order_no, to_char(NEW.total, 'FM999,999,999,990.00')));
    alert_statuses := array_append(alert_statuses, 'order');
  ELSIF NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    alert_titles := array_append(alert_titles, 'Order status updated');
    alert_messages := array_append(alert_messages, format('Order %s is now %s.', NEW.order_no, NEW.order_status));
    alert_statuses := array_append(alert_statuses, 'order');
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.payment_status IS DISTINCT FROM OLD.payment_status
     OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount) THEN
    alert_titles := array_append(alert_titles,
      CASE WHEN NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN 'Payment received' ELSE 'Payment status updated' END);
    alert_messages := array_append(alert_messages,
      format('Order %s: paid %s of %s; payment is %s.', NEW.order_no,
        to_char(NEW.paid_amount, 'FM999,999,999,990.00'),
        to_char(NEW.total, 'FM999,999,999,990.00'), NEW.payment_status));
    alert_statuses := array_append(alert_statuses, 'payment');
  END IF;

  IF COALESCE(array_length(alert_titles, 1), 0) = 0 THEN
    RETURN NEW;
  END IF;

  FOR event_index IN 1..array_length(alert_titles, 1) LOOP
    IF NEW.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (
        NEW.order_no, NEW.id, NEW.user_id, 'customer',
        CASE WHEN is_new AND event_index = 1 THEN 'Order placed' ELSE alert_titles[event_index] END,
        CASE WHEN is_new AND event_index = 1 THEN format('Your order %s has been received.', NEW.order_no) ELSE alert_messages[event_index] END,
        alert_statuses[event_index]
      );
    END IF;

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'vendor', p.vendor_id,
      CASE WHEN is_new AND event_index = 1 THEN 'New order for your products' ELSE alert_titles[event_index] END,
      CASE WHEN is_new AND event_index = 1 THEN format('Order %s includes products assigned to your store.', NEW.order_no) ELSE alert_messages[event_index] END,
      alert_statuses[event_index]
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
    WHERE p.vendor_id = ANY (NEW.vendor_ids)
      AND (is_new OR ur.user_id IS DISTINCT FROM auth.uid());

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'admin', alert_titles[event_index], alert_messages[event_index], alert_statuses[event_index]
    FROM public.user_roles ur
    WHERE ur.role = 'admin'
      AND (is_new OR ur.user_id IS DISTINCT FROM auth.uid());
  END LOOP;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- Zoho: held requests are not orders
CREATE OR REPLACE FUNCTION public.enqueue_zoho_order_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;
  IF current_setting('app.pay_first', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.order_status IN ('Awaiting Payment', 'Payment Expired') THEN RETURN NEW; END IF;
  PERFORM public.enqueue_zoho_sync('order', NEW.id::text);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_zoho_order_item_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  parent_order_id uuid;
BEGIN
  parent_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  IF current_setting('app.zoho_inbound', true) = 'on' OR current_setting('app.pay_first', true) = 'on'
     OR EXISTS (SELECT 1 FROM public.orders WHERE id = parent_order_id AND order_status IN ('Awaiting Payment', 'Payment Expired')) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM public.enqueue_zoho_sync('order', parent_order_id::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

-- A partner's sales and commission count only paid orders: an unpaid or expired request is
-- "cancelled" for the leaderboard; when it is paid the order update makes it "pending".
CREATE OR REPLACE FUNCTION public.partner_commission_status(_order_status text, _payment_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN _order_status IN ('Cancelled', 'Awaiting Payment', 'Payment Expired') THEN 'cancelled'
              WHEN _order_status = 'Delivered' AND _payment_status = 'Paid' THEN 'earned'
              ELSE 'pending' END
$function$;

/** The live commission lines, without requests that were never paid. */
CREATE OR REPLACE FUNCTION public.partner_commission_lines(_month date)
 RETURNS TABLE(order_item_id uuid, order_no text, placed_at timestamp with time zone, order_status text, payment_status text, customer_name text, pin text, product_name text, qty integer, line_total numeric, kind text, rate numeric, amount numeric, status text, partner_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  me uuid := public.current_partner_id();
  is_admin boolean := public.has_role(auth.uid(), 'admin');
BEGIN
  IF auth.uid() IS NULL OR (me IS NULL AND NOT is_admin) THEN
    RAISE EXCEPTION 'Only channel partners and administrators can view commissions';
  END IF;
  RETURN QUERY
  SELECT c.order_item_id, c.order_no, c.placed_at, o.order_status, o.payment_status, o.customer_name,
    COALESCE(o.shipping_address->>'pin', ''), c.product_name, c.qty, c.line_total, c.kind, c.rate, c.amount, c.status, c.partner_id
  FROM public.partner_commissions c JOIN public.orders o ON o.id = c.order_id
  WHERE (is_admin OR c.partner_id = me)
    AND o.order_status NOT IN ('Awaiting Payment', 'Payment Expired')
    AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('month', _month)::date
    AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date < (date_trunc('month', _month) + interval '1 month')::date
  ORDER BY c.placed_at DESC;
END;
$function$;

-- ---------------------------------------------------------------- give a held request's stock back
CREATE SCHEMA IF NOT EXISTS private;

/** Ends a held request: stock, batches and coupon go back, it becomes "Payment Expired". Caller holds the row lock. */
CREATE OR REPLACE FUNCTION private.release_payment_hold(_order_id uuid, _reason text, _outcome text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id;
  IF NOT FOUND OR target.order_status <> 'Awaiting Payment' THEN RETURN; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);
  PERFORM set_config('app.payment_workflow', 'on', true);

  FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)), true
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
    UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity WHERE id = allocation_row.id;
  END LOOP;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;

  UPDATE public.orders
    SET order_status = 'Payment Expired', advance_due = 0, balance_due = 0, payment_hold_until = NULL, payment_hold_outcome = _outcome
    WHERE id = target.id;
  UPDATE public.upi_payment_submissions SET status = 'rejected', note = _reason, reviewed_at = now()
    WHERE order_id = target.id AND status = 'submitted';
  IF target.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (target.order_no, target.id, target.user_id, 'customer', 'Order not placed',
      format('%s was not placed: %s. Nothing was charged by us; if money left your account, contact us with the UTR.', target.order_no, _reason),
      'payment');
  END IF;
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$;
REVOKE ALL ON FUNCTION private.release_payment_hold(uuid, text, text) FROM PUBLIC, anon, authenticated;

/**
 * Ends every held request whose payment time is over. A request whose customer already sent a UTR
 * gets 24 more hours for the bank alert or an admin. Safe to call often (checkout, bank alerts,
 * admin pages and the 15-minute cron all call it).
 */
CREATE OR REPLACE FUNCTION public.expire_payment_holds()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  held record;
  n integer := 0;
BEGIN
  FOR held IN
    SELECT o.id FROM public.orders o
    WHERE o.order_status = 'Awaiting Payment' AND o.payment_hold_until IS NOT NULL
      AND (o.payment_hold_until < now() - interval '24 hours'
        OR (o.payment_hold_until < now() AND NOT EXISTS (
          SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted')))
    ORDER BY o.payment_hold_until
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    PERFORM private.release_payment_hold(held.id, 'the payment was not received in time', 'expired');
    n := n + 1;
  END LOOP;
  -- The customer says they paid, the time is over and no bank alert matched: an admin checks the bank.
  FOR held IN
    SELECT s.id, s.order_id, s.order_no, s.utr, s.amount FROM public.upi_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    WHERE s.status = 'submitted' AND s.note IS NULL AND o.order_status = 'Awaiting Payment' AND o.payment_hold_until < now()
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.upi_payment_submissions SET note = 'No bank alert yet: check the bank account' WHERE id = held.id;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT held.order_no, held.order_id, ur.user_id, 'admin', 'UPI payment to check',
      format('The customer sent UTR %s for %s (Rs %s) but no bank alert matched it. Check the bank account, then confirm or reject in Admin > UPI Payments.',
        held.utr, held.order_no, to_char(held.amount, 'FM99999990.00')),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END LOOP;
  RETURN n;
END;
$function$;
REVOKE ALL ON FUNCTION public.expire_payment_holds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_payment_holds() TO authenticated, service_role;

/** The customer (or an admin) drops a held request before paying. */
CREATE OR REPLACE FUNCTION public.cancel_payment_hold(_order_no text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE target public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel this order'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.user_id IS DISTINCT FROM auth.uid() AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'This is not your order';
  END IF;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Only an unpaid order can be dropped here'; END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE order_id = target.id AND status = 'submitted') THEN
    RAISE EXCEPTION 'You already sent a UTR for this order; we are checking it';
  END IF;
  PERFORM private.release_payment_hold(target.id, 'you cancelled it before paying', 'dropped');
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_payment_hold(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_payment_hold(text) TO authenticated;

-- ---------------------------------------------------------------- checkout: hold, then pay
/**
 * The customer's checkout. Same arguments and checks as place_marketplace_order_with_coupon
 * (prices, stock, coupon, godown are all decided in the database), but the result is a held
 * request that waits for payment. Refused while direct UPI is off: no order without payment.
 */
CREATE OR REPLACE FUNCTION public.start_paid_checkout(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  cfg jsonb;
  result jsonb;
  window_minutes integer;
  hold_until timestamptz;
  placed public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in is required to place an order'; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
  IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
    RAISE EXCEPTION 'Online payment is being set up. Please call or WhatsApp us to order.';
  END IF;
  PERFORM public.expire_payment_holds();
  IF (SELECT count(*) FROM public.orders WHERE user_id = _target_user_id AND order_status = 'Awaiting Payment') >= 3 THEN
    RAISE EXCEPTION 'You have 3 unpaid orders waiting. Pay or cancel them first.';
  END IF;
  window_minutes := LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)));

  PERFORM set_config('app.pay_first', 'on', true);
  result := public.place_marketplace_order_with_coupon(_order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address, _shipping_method, 'UPI', _items, _coupon);

  PERFORM set_config('app.payment_workflow', 'on', true);
  SELECT * INTO placed FROM public.orders WHERE order_no = result->>'order_no' FOR UPDATE;
  IF placed.total <= 0 THEN
    -- Fully covered by a coupon: nothing to pay, so it is an order at once.
    PERFORM set_config('app.pay_first', 'off', true);
    UPDATE public.orders SET order_status = 'Awaiting Payment' WHERE id = placed.id;
    UPDATE public.orders SET order_status = 'Payment Confirmed', payment_status = 'Paid', balance_due = 0 WHERE id = placed.id;
    PERFORM set_config('app.payment_workflow', 'off', true);
    RETURN result || jsonb_build_object('order_status', 'Payment Confirmed', 'hold_until', NULL);
  END IF;
  hold_until := now() + make_interval(mins => window_minutes);
  UPDATE public.orders SET order_status = 'Awaiting Payment', payment_method = 'UPI', payment_hold_until = hold_until
    WHERE id = placed.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  PERFORM set_config('app.pay_first', 'off', true);
  RETURN result || jsonb_build_object('order_status', 'Awaiting Payment', 'hold_until', hold_until, 'total', placed.total);
END;
$function$;
REVOKE ALL ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_paid_checkout(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------- confirm a held request
/** Records the full UPI payment of a held request; it becomes an order ("Payment Confirmed"). Caller holds the row lock. */
CREATE OR REPLACE FUNCTION private.confirm_held_payment(_order_id uuid, _utr text, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE target public.orders%ROWTYPE;
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Order % is not waiting for payment', target.order_no; END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE lower(txn_ref) = lower(_utr) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders
    SET paid_amount = total, balance_due = 0, payment_status = 'Paid', order_status = 'Payment Confirmed',
        payment_method = 'UPI', payment_hold_until = NULL
    WHERE id = target.id;
  INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, 'advance', target.total - target.paid_amount, 'UPI', 'Paid', _utr);
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at)
  VALUES (target.id, target.order_no, target.user_id, COALESCE(target.customer_name, ''), target.total - target.paid_amount, _utr,
    'confirmed', _note, now(), now())
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'confirmed',
    note = EXCLUDED.note, reviewed_at = now(), reviewed_by = NULL;
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$;
REVOKE ALL ON FUNCTION private.confirm_held_payment(uuid, text, text) FROM PUBLIC, anon, authenticated;

/** Tells every admin about a bank credit that needs a person. */
CREATE OR REPLACE FUNCTION private.alert_admins_about_credit(_credit public.bank_credits, _title text, _message text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT _credit.order_no, _credit.order_id, ur.user_id, 'admin', _title, _message, 'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
$function$;
REVOKE ALL ON FUNCTION private.alert_admins_about_credit(public.bank_credits, text, text) FROM PUBLIC, anon, authenticated;

/**
 * Matches one bank credit to a held request:
 *  1. the request whose customer sent this UTR (amount must be the full balance);
 *  2. otherwise the one held request waiting for exactly this amount when the money arrived.
 * Two or more such requests, a wrong amount, or a request that already expired go to an admin.
 */
CREATE OR REPLACE FUNCTION private.match_bank_credit(_credit_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  c public.bank_credits%ROWTYPE;
  o public.orders%ROWTYPE;
  candidates uuid[];
  amount_text text;
BEGIN
  SELECT * INTO c FROM public.bank_credits WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('unmatched', 'ambiguous') THEN
    RETURN jsonb_build_object('status', COALESCE(c.status, 'missing'), 'order_no', c.order_no);
  END IF;
  amount_text := to_char(c.amount, 'FM99999990.00');

  -- 1. The customer already told us this UTR.
  SELECT o2.* INTO o FROM public.upi_payment_submissions s JOIN public.orders o2 ON o2.id = s.order_id
    WHERE s.utr = c.utr AND s.status = 'submitted' ORDER BY s.submitted_at DESC LIMIT 1;
  IF FOUND THEN
    PERFORM 1 FROM public.orders WHERE id = o.id FOR UPDATE;
    SELECT * INTO o FROM public.orders WHERE id = o.id;
    IF o.order_status = 'Awaiting Payment' AND c.amount = o.total - o.paid_amount THEN
      PERFORM private.confirm_held_payment(o.id, c.utr, 'Confirmed automatically from the bank alert');
      UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = NULL WHERE id = c.id;
      RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
    END IF;
    UPDATE public.bank_credits SET order_id = o.id, order_no = o.order_no,
      status = CASE WHEN o.order_status = 'Payment Expired' THEN 'late' ELSE 'mismatch' END,
      note = CASE WHEN o.order_status = 'Payment Expired' THEN 'Paid after the payment time ran out'
                  WHEN o.order_status <> 'Awaiting Payment' THEN format('Order is already %s', o.order_status)
                  ELSE format('Bank amount ₹%s, order needs ₹%s', amount_text, to_char(o.total - o.paid_amount, 'FM99999990.00')) END
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'UPI payment needs you',
      format('₹%s (UTR %s) for %s: %s. Refund it or call the customer.', amount_text, c.utr, o.order_no, c.note));
    RETURN jsonb_build_object('status', c.status, 'order_no', o.order_no);
  END IF;

  -- 2. The one request waiting for exactly this amount at the time the money arrived. A request
  --    whose customer gave a different UTR is not theirs to claim, and a same-amount request that
  --    expired in the last 2 hours could be the real payer: then a person decides.
  SELECT array_agg(o2.id ORDER BY o2.created_at) INTO candidates FROM public.orders o2
    WHERE o2.order_status = 'Awaiting Payment'
      AND o2.total - o2.paid_amount = c.amount
      AND o2.created_at <= c.received_at + interval '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o2.id AND s.status = 'submitted');
  IF COALESCE(array_length(candidates, 1), 0) = 1 AND EXISTS (
    SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Payment Expired' AND o2.payment_hold_outcome = 'expired' AND o2.total = c.amount
      AND o2.updated_at >= c.received_at - interval '2 hours'
      AND NOT EXISTS (SELECT 1 FROM public.bank_credits b WHERE b.order_id = o2.id)) THEN
    candidates := candidates || NULL::uuid;  -- treat as more than one
  END IF;
  IF COALESCE(array_length(candidates, 1), 0) = 1 THEN
    SELECT * INTO o FROM public.orders WHERE id = candidates[1] FOR UPDATE;
    PERFORM private.confirm_held_payment(o.id, c.utr, 'Confirmed automatically from the bank alert (matched by amount)');
    UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = NULL WHERE id = c.id;
    RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
  END IF;
  IF COALESCE(array_length(candidates, 1), 0) > 1 THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('%s unpaid orders wait for ₹%s; the customer''s UTR decides', array_length(candidates, 1), amount_text)
      WHERE id = c.id RETURNING * INTO c;
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- 3. Paid for a request that already expired (same amount, last 2 days).
  SELECT o2.* INTO o FROM public.orders o2
    WHERE o2.order_status = 'Payment Expired' AND o2.payment_hold_outcome = 'expired' AND o2.total = c.amount
      AND o2.created_at >= c.received_at - interval '2 days' AND o2.created_at <= c.received_at + interval '2 minutes'
    ORDER BY o2.created_at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE public.bank_credits SET status = 'late', order_id = o.id, order_no = o.order_no,
      note = 'Paid after the payment time ran out' WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'UPI payment needs you',
      format('₹%s (UTR %s) arrived after %s expired. Refund it or place the order for the customer.', amount_text, c.utr, o.order_no));
    RETURN jsonb_build_object('status', 'late', 'order_no', o.order_no);
  END IF;
  RETURN jsonb_build_object('status', 'unmatched');
END;
$function$;
REVOKE ALL ON FUNCTION private.match_bank_credit(uuid) FROM PUBLIC, anon, authenticated;

/**
 * A bank credit alert from the company phone (POST /api/payments/bank-alert, server only).
 * The same UTR twice is ignored, so a re-sent SMS never pays twice.
 */
CREATE OR REPLACE FUNCTION public.record_bank_credit(_utr text, _amount numeric, _payer text DEFAULT NULL,
  _raw text DEFAULT NULL, _source text DEFAULT 'sms', _sender text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  ref text := regexp_replace(COALESCE(_utr, ''), '\s', '', 'g');
  credit_id uuid;
BEGIN
  IF ref !~ '^[0-9]{12}$' THEN RAISE EXCEPTION 'A bank credit needs its 12-digit UTR'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'A bank credit needs a positive amount'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || ref, 0));
  IF EXISTS (SELECT 1 FROM public.bank_credits WHERE utr = ref) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  INSERT INTO public.bank_credits (amount, utr, payer, raw, source, sender)
    VALUES (round(_amount, 2), ref, left(_payer, 120), left(_raw, 1000), COALESCE(NULLIF(_source, ''), 'sms'), left(_sender, 60))
    RETURNING id INTO credit_id;
  RETURN private.match_bank_credit(credit_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.record_bank_credit(text, numeric, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bank_credit(text, numeric, text, text, text, text) TO service_role;

/** Admin: mark a credit that needed a person as dealt with (refunded, or the order placed by hand). */
CREATE OR REPLACE FUNCTION public.settle_bank_credit(_credit_id uuid, _note text)
RETURNS public.bank_credits LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE result public.bank_credits%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can settle a bank credit'; END IF;
  IF NULLIF(trim(COALESCE(_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Say what was done (for example: refunded on 27 Oct)'; END IF;
  UPDATE public.bank_credits SET status = 'settled', note = trim(_note)
    WHERE id = _credit_id AND status IN ('unmatched', 'ambiguous', 'mismatch', 'late')
    RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'This credit is already matched or settled'; END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.settle_bank_credit(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_bank_credit(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- customer: send the UTR
/**
 * As before, plus: a held request is confirmed at once when the bank alert for this UTR and amount
 * already arrived; an expired request takes no UTR.
 */
CREATE OR REPLACE FUNCTION public.submit_upi_utr(_order_no text, _utr text)
RETURNS public.upi_payment_submissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := auth.uid();
  ref text := regexp_replace(COALESCE(_utr, ''), '\s', '', 'g');
  o public.orders%ROWTYPE;
  cfg jsonb;
  existing public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
  credit public.bank_credits%ROWTYPE;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Sign in to send the payment details'; END IF;
  SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
  IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
    RAISE EXCEPTION 'UPI payment is not switched on';
  END IF;
  IF ref !~ '^[0-9]{12}$' THEN RAISE EXCEPTION 'The UTR has 12 digits'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.user_id IS DISTINCT FROM me AND NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'This is not your order'; END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is cancelled'; END IF;
  IF o.order_status = 'Payment Expired' THEN
    RAISE EXCEPTION 'The payment time for this order ran out. If money left your account, call us with this UTR.';
  END IF;
  IF o.total - o.paid_amount <= 0 OR o.payment_status = 'Paid' THEN RAISE EXCEPTION 'This order is already paid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || ref, 0));
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE utr = ref AND status <> 'rejected' AND order_id <> o.id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE lower(txn_ref) = ref AND status = 'Paid')
     OR EXISTS (SELECT 1 FROM public.bank_credits WHERE utr = ref AND status IN ('matched', 'settled') AND order_id IS DISTINCT FROM o.id) THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  SELECT * INTO existing FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  IF FOUND AND existing.status = 'confirmed' THEN RAISE EXCEPTION 'This order''s payment is already confirmed'; END IF;
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at, reviewed_by)
  VALUES (o.id, o.order_no, o.user_id, COALESCE(o.customer_name, ''), o.total - o.paid_amount, ref, 'submitted', NULL, now(), NULL, NULL)
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'submitted', note = NULL,
    submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL
  RETURNING * INTO result;

  -- The bank alert came first: confirm now.
  SELECT * INTO credit FROM public.bank_credits WHERE utr = ref AND status IN ('unmatched', 'ambiguous') FOR UPDATE;
  IF FOUND AND o.order_status = 'Awaiting Payment' AND credit.amount = o.total - o.paid_amount THEN
    PERFORM private.confirm_held_payment(o.id, ref, 'Confirmed automatically from the bank alert');
    UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = NULL WHERE id = credit.id;
    SELECT * INTO result FROM public.upi_payment_submissions WHERE order_id = o.id;
    RETURN result;
  END IF;

  -- Older orders (placed before pay-first) still go to an admin to check.
  IF o.order_status <> 'Awaiting Payment' THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT o.order_no, o.id, ur.user_id, 'admin', 'UPI payment to check',
      format('%s sent UTR %s for %s (Rs %s). Match it in the bank account, then confirm in Admin > UPI Payments.',
        COALESCE(NULLIF(o.customer_name, ''), 'A customer'), ref, o.order_no, to_char(result.amount, 'FM99999990.00')),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.submit_upi_utr(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_upi_utr(text, text) TO authenticated;

-- ---------------------------------------------------------------- admin: confirm or reject by hand
/** As before; confirming also clears the hold and settles a waiting bank credit with the same UTR. */
CREATE OR REPLACE FUNCTION public.review_upi_utr(_order_no text, _decision text, _note text DEFAULT NULL)
RETURNS public.upi_payment_submissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm UPI payments'; END IF;
  IF _decision NOT IN ('confirmed', 'rejected') THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UPI payment was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  IF _decision = 'confirmed' THEN
    SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
    IF o.order_status = 'Awaiting Payment' AND s.amount <> o.total - o.paid_amount THEN
      RAISE EXCEPTION 'An unpaid order is placed only when its full amount is paid';
    END IF;
    PERFORM public.admin_confirm_manual_payment(s.order_no, s.amount, s.utr);
    UPDATE public.orders SET payment_hold_until = NULL WHERE id = s.order_id AND payment_hold_until IS NOT NULL;
    UPDATE public.bank_credits SET status = 'matched', order_id = s.order_id, order_no = s.order_no, note = 'Confirmed by an admin'
      WHERE utr = s.utr AND status IN ('unmatched', 'ambiguous', 'mismatch');
  END IF;
  UPDATE public.upi_payment_submissions SET status = _decision, note = NULLIF(trim(COALESCE(_note, '')), ''),
    reviewed_at = now(), reviewed_by = auth.uid()
  WHERE id = s.id RETURNING * INTO result;
  IF s.user_id IS NOT NULL AND _decision = 'rejected' THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer', 'Please check your UPI payment',
      format('UTR %s for order %s could not be matched%s. Open the order and send the correct UTR.', s.utr, s.order_no,
        COALESCE(': ' || NULLIF(trim(COALESCE(_note, '')), ''), '')),
      'payment');
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.review_upi_utr(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_upi_utr(text, text, text) TO authenticated;

-- Admin pages and the customer's payment screen update live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bank_credits') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bank_credits;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
