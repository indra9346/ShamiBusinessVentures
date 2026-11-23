-- 11 Nov 2026, the owner's "delete this refunded order and give option to delete details of payment and order to cancel
-- at all steps", with the eight answers he approved. Built from the live function definitions of 11 Nov 2026.
--
--  1. Cancel at any step (admin_cancel_order). An admin can cancel an order at every stage, always with a reason:
--       - before it leaves the godown, the stock goes back, as before;
--       - after dispatch, the admin says whether the goods came back to the godown: yes puts the stock back, no leaves it out;
--       - a paid order is refunded first: how the money went back (UPI, NEFT, RTGS, IMPS, cash or cheque), its reference
--         and date. The payment records stay, marked Refunded, and each refund is kept in order_refunds, so the books show
--         the money in and the money out. The Zoho side (void the invoice, record the refund against the Books payment,
--         void the sales order) is done by the sync.
--     Every cancel by an admin is kept in order_cancellations with who, when, the stage and the reason.
--  2. A transfer that was refunded can never pay for anything again, even after its records are deleted: it is kept in
--     refunded_transfers, which nothing deletes, and a new payment or UTR naming it is refused.
--  3. End checkout (admin_end_payment_hold) takes a reason and is logged with the cancellations.
--  4. Delete a UTR record (admin_delete_utr) that was rejected or refunded, with a reason, kept in deleted_payments_log.
--  5. Delete all details also takes a cancelled order whose goods did not come back, or whose bank alert was settled, and
--     its copy now holds the refunds, the cancellation and the stock taken. A refund not yet in Zoho Books is named.

-- ---------------------------------------------------------------- tables

CREATE TABLE IF NOT EXISTS public.order_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  -- The status the order had when it was cancelled ('Awaiting Payment' for an ended checkout).
  stage text NOT NULL,
  -- Only asked after dispatch: did the goods come back to the godown? NULL before dispatch (they never left).
  goods_back boolean,
  refunded numeric(14,2) NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  cancelled_by uuid,
  cancelled_by_name text NOT NULL DEFAULT '',
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS public.order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  -- The website payment this pays back (NULL for money recorded on the order without a payment row).
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  -- The payment's own reference, so the refund can be read without it.
  paid_ref text NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  mode text NOT NULL CHECK (mode IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque')),
  reference text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 100),
  refunded_on date NOT NULL,
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Zoho Books: the customer payment it refunds, and the refund made there. zoho_claimed_at is set just before the refund
  -- is sent, so two syncs at once cannot both send it.
  zoho_payment_id text,
  zoho_refund_id text,
  zoho_claimed_at timestamptz,
  zoho_refunded_at timestamptz,
  zoho_problem text
);
CREATE INDEX IF NOT EXISTS order_refunds_order_idx ON public.order_refunds (order_id);

-- Never deleted: what makes a refunded transfer unusable after its payment or UTR record is gone.
CREATE TABLE IF NOT EXISTS public.refunded_transfers (
  id bigserial PRIMARY KEY,
  utr text NOT NULL,
  order_no text NOT NULL,
  amount numeric(14,2),
  source text NOT NULL CHECK (source IN ('utr_marked_refunded', 'order_refund')),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utr, order_no)
);

ALTER TABLE public.order_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunded_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_cancellations, public.order_refunds, public.refunded_transfers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.refunded_transfers_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_cancellations, public.order_refunds, public.refunded_transfers TO authenticated;
GRANT ALL ON public.order_cancellations, public.order_refunds, public.refunded_transfers TO service_role;
GRANT ALL ON SEQUENCE public.refunded_transfers_id_seq TO service_role;
DROP POLICY IF EXISTS order_cancellations_admin_read ON public.order_cancellations;
CREATE POLICY order_cancellations_admin_read ON public.order_cancellations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS order_refunds_admin_read ON public.order_refunds;
CREATE POLICY order_refunds_admin_read ON public.order_refunds FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS refunded_transfers_admin_read ON public.refunded_transfers;
CREATE POLICY refunded_transfers_admin_read ON public.refunded_transfers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- What kind of record a row of the removed-payments log is: a payment (as before) or a customer's UTR record.
ALTER TABLE public.deleted_payments_log ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payment';
DO $$ BEGIN
  ALTER TABLE public.deleted_payments_log ADD CONSTRAINT deleted_payments_log_kind_check CHECK (kind IN ('payment', 'utr'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- 2. refunded transfers stay refunded

-- Only a bank reference can be caught again: the word CASH on a refunded payment says nothing about new cash.
CREATE OR REPLACE FUNCTION private.utr_is_refunded(_ref text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT length(private.utr_form(COALESCE(_ref, ''))) >= 12
     AND EXISTS (SELECT 1 FROM public.refunded_transfers t WHERE private.same_utr(t.utr, _ref));
$$;
REVOKE ALL ON FUNCTION private.utr_is_refunded(text) FROM PUBLIC, anon, authenticated;

-- What is already refunded today.
INSERT INTO public.refunded_transfers (utr, order_no, amount, source, refunded_at)
SELECT s.utr, s.order_no, s.amount, 'utr_marked_refunded', COALESCE(s.reviewed_at, now())
  FROM public.upi_payment_submissions s WHERE s.status = 'rejected' AND s.note = 'refunded by our team'
ON CONFLICT (utr, order_no) DO NOTHING;
INSERT INTO public.refunded_transfers (utr, order_no, amount, source, refunded_at)
SELECT p.txn_ref, o.order_no, p.amount, 'order_refund', COALESCE(p.updated_at, now())
  FROM public.payments p JOIN public.orders o ON o.id = p.order_id
  WHERE p.status = 'Refunded' AND length(private.utr_form(COALESCE(p.txn_ref, ''))) >= 12
ON CONFLICT (utr, order_no) DO NOTHING;

-- A UTR marked refunded (mark_utr_refunded, or any later way) goes on the list at once.
CREATE OR REPLACE FUNCTION private.note_refunded_utr()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'rejected' AND NEW.note = 'refunded by our team' THEN
    INSERT INTO public.refunded_transfers (utr, order_no, amount, source)
    VALUES (NEW.utr, NEW.order_no, NEW.amount, 'utr_marked_refunded') ON CONFLICT (utr, order_no) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS upi_submissions_note_refunded ON public.upi_payment_submissions;
CREATE TRIGGER upi_submissions_note_refunded AFTER INSERT OR UPDATE OF status, note ON public.upi_payment_submissions
  FOR EACH ROW EXECUTE FUNCTION private.note_refunded_utr();

-- Every way money can be recorded passes through one of these two tables, so the check lives here and catches a
-- refunded transfer whatever record of it was deleted since.
CREATE OR REPLACE FUNCTION private.refuse_refunded_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_TABLE_NAME = 'upi_payment_submissions' THEN
    IF NEW.status IN ('submitted', 'confirmed')
       AND (TG_OP = 'INSERT' OR NEW.utr IS DISTINCT FROM OLD.utr OR NEW.status IS DISTINCT FROM OLD.status)
       AND private.utr_is_refunded(NEW.utr) THEN
      RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
    END IF;
  ELSIF NEW.status = 'Paid'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'Paid' OR NEW.txn_ref IS DISTINCT FROM OLD.txn_ref)
     AND private.utr_is_refunded(NEW.txn_ref) THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS upi_submissions_refuse_refunded ON public.upi_payment_submissions;
CREATE TRIGGER upi_submissions_refuse_refunded BEFORE INSERT OR UPDATE OF utr, status ON public.upi_payment_submissions
  FOR EACH ROW EXECUTE FUNCTION private.refuse_refunded_transfer();
DROP TRIGGER IF EXISTS payments_refuse_refunded ON public.payments;
CREATE TRIGGER payments_refuse_refunded BEFORE INSERT OR UPDATE OF status, txn_ref ON public.payments
  FOR EACH ROW EXECUTE FUNCTION private.refuse_refunded_transfer();

-- ---------------------------------------------------------------- 1. the order guard lets an admin cancel after dispatch

-- Changed 11 Nov 2026: admin_cancel_order (flag app.admin_cancel) may cancel an order after dispatch, like a void in Zoho.
-- Everything else is as live on 11 Nov 2026.
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

-- ---------------------------------------------------------------- 1. cancel at any step

CREATE OR REPLACE FUNCTION public.admin_cancel_order(_order_no text, _reason text, _goods_back boolean DEFAULT NULL, _refund jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  who text;
  after_dispatch boolean;
  stock_back boolean;
  paid_rows numeric;
  paid numeric;
  refund_mode text;
  refund_ref text;
  refund_date_text text;
  refund_date date;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  other text;
  p record;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may cancel orders here'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this order is being cancelled'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is already cancelled.'; END IF;
  IF o.order_status = 'Awaiting Payment' THEN
    RAISE EXCEPTION 'This checkout is still waiting for payment. End it with End checkout on UPI & Bank Payments.';
  END IF;
  IF o.order_status = 'Payment Expired' THEN
    RAISE EXCEPTION 'This checkout already ended without payment. Delete it from the ended checkouts list if it is not wanted.';
  END IF;
  -- A UTR still being checked may be money on its way: it is confirmed or rejected first.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
    RAISE EXCEPTION 'A UTR on this order waits for a check. Confirm or reject it on UPI & Bank Payments first.';
  END IF;
  PERFORM set_config('app.branch_id', COALESCE(o.branch_id, ''), true);

  after_dispatch := o.order_status IN ('Dispatched', 'Out for Delivery', 'Delivered')
    OR EXISTS (SELECT 1 FROM public.order_vendor_fulfillments f WHERE f.order_id = o.id AND f.status IN ('Dispatched', 'Out for Delivery', 'Delivered'));
  IF after_dispatch AND _goods_back IS NULL THEN RAISE EXCEPTION 'Say whether the goods came back to the godown.'; END IF;
  stock_back := NOT after_dispatch OR _goods_back;

  -- Money received is paid back first, all of it, and the payment records stay, marked Refunded.
  SELECT COALESCE(sum(amount), 0) INTO paid_rows FROM public.payments WHERE order_id = o.id AND status = 'Paid';
  paid := GREATEST(paid_rows, COALESCE(o.paid_amount, 0));
  IF paid > 0 OR COALESCE(o.payment_status, '') IN ('Paid', 'Partially Paid') THEN
    IF _refund IS NULL OR jsonb_typeof(_refund) <> 'object' THEN
      RAISE EXCEPTION 'Rs % was paid on this order. Record how it was paid back to the customer first.', to_char(paid, 'FM99999990.00');
    END IF;
    refund_mode := btrim(COALESCE(_refund->>'mode', ''));
    IF refund_mode NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how the money was paid back'; END IF;
    -- A bank reference is kept without spaces, like every UTR here; a note about cash or a cheque as it was typed.
    refund_ref := CASE WHEN refund_mode IN ('Cash', 'Cheque')
      THEN btrim(regexp_replace(COALESCE(_refund->>'reference', ''), '\s+', ' ', 'g'))
      ELSE upper(regexp_replace(COALESCE(_refund->>'reference', ''), '\s+', '', 'g')) END;
    IF refund_mode <> 'Cash' AND length(refund_ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR or reference of the refund'; END IF;
    IF length(refund_ref) > 100 THEN RAISE EXCEPTION 'The refund reference is too long'; END IF;
    refund_date_text := btrim(COALESCE(_refund->>'refunded_on', ''));
    IF refund_date_text !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Enter the date the money was paid back'; END IF;
    refund_date := refund_date_text::date;
    IF refund_date > today THEN RAISE EXCEPTION 'The refund date cannot be in the future'; END IF;
    IF refund_date < (o.created_at AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'The refund date is before the order was placed'; END IF;
    -- Our own transfer out can pay back one order only.
    IF length(private.utr_form(refund_ref)) >= 12 THEN
      SELECT r.order_no INTO other FROM public.order_refunds r
        WHERE r.order_id <> o.id AND private.same_payment_ref(r.reference, refund_ref) LIMIT 1;
      IF other IS NOT NULL THEN RAISE EXCEPTION 'This refund reference is already recorded on order %', other; END IF;
    END IF;
    SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();

    FOR p IN SELECT * FROM public.payments WHERE order_id = o.id AND status = 'Paid' ORDER BY created_at, id FOR UPDATE LOOP
      UPDATE public.payments SET status = 'Refunded' WHERE id = p.id;
      INSERT INTO public.order_refunds (order_id, order_no, payment_id, paid_ref, amount, mode, reference, refunded_on, created_by, created_by_name, zoho_payment_id)
      VALUES (o.id, o.order_no, p.id, COALESCE(p.txn_ref, ''), p.amount, refund_mode, refund_ref, refund_date, auth.uid(), COALESCE(who, ''), NULLIF(p.zoho_payment_id, ''));
      IF length(private.utr_form(COALESCE(p.txn_ref, ''))) >= 12 THEN
        INSERT INTO public.refunded_transfers (utr, order_no, amount, source) VALUES (p.txn_ref, o.order_no, p.amount, 'order_refund')
          ON CONFLICT (utr, order_no) DO NOTHING;
      END IF;
    END LOOP;
    -- Money on the order with no payment record behind it (older orders) is refunded too.
    IF COALESCE(o.paid_amount, 0) > paid_rows THEN
      INSERT INTO public.order_refunds (order_id, order_no, amount, mode, reference, refunded_on, created_by, created_by_name)
      VALUES (o.id, o.order_no, o.paid_amount - paid_rows, refund_mode, refund_ref, refund_date, auth.uid(), COALESCE(who, ''));
    END IF;
    -- A bank alert that paid this order paid for nothing in the end: it is settled, with the refund named.
    UPDATE public.bank_credits SET status = 'settled',
        note = left(format('Refunded by %s%s on %s (order %s cancelled)', refund_mode, CASE WHEN refund_ref <> '' THEN ' ' || refund_ref ELSE '' END,
          to_char(refund_date, 'DD Mon YYYY'), o.order_no), 300)
      WHERE order_id = o.id AND status <> 'settled';
  ELSIF _refund IS NOT NULL AND jsonb_typeof(_refund) = 'object' THEN
    RAISE EXCEPTION 'Nothing was paid on this order, so there is no refund to record.';
  ELSE
    SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  END IF;

  -- The goods are in the godown (not yet sent, or back): stock and batches get them back, as a cancel always did.
  IF stock_back THEN
    FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = o.id LOOP
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
      WHERE oi.order_id = o.id AND a.released_quantity < a.reserved_quantity
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
  END IF;

  IF o.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = o.coupon;
  END IF;

  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  PERFORM set_config('app.admin_cancel', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0, payment_hold_until = NULL,
        paid_amount = CASE WHEN paid > 0 THEN 0 ELSE paid_amount END,
        payment_status = CASE WHEN paid > 0 OR payment_status IN ('Paid', 'Partially Paid') THEN 'Refunded' ELSE payment_status END
    WHERE id = o.id;
  PERFORM set_config('app.admin_cancel', 'off', true);
  PERFORM set_config('app.cancel_order_workflow', 'off', true);

  INSERT INTO public.order_cancellations (order_id, order_no, stage, goods_back, refunded, reason, cancelled_by, cancelled_by_name)
  VALUES (o.id, o.order_no, o.order_status, CASE WHEN after_dispatch THEN _goods_back END, paid, why, auth.uid(), COALESCE(who, ''));

  IF paid > 0 AND o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'Refund recorded',
      format('Order %s was cancelled. Rs %s was paid back to you by %s on %s.', o.order_no, to_char(paid, 'FM99999990.00'), refund_mode,
        to_char(refund_date, 'DD Mon YYYY')) || CASE WHEN refund_ref <> '' THEN format(' Reference: %s.', refund_ref) ELSE '' END,
      'payment');
  END IF;
  RETURN jsonb_build_object('order_no', o.order_no, 'stage', o.order_status, 'refunded', paid, 'stock_back', stock_back, 'after_dispatch', after_dispatch);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_cancel_order(text, text, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_order(text, text, boolean, jsonb) TO authenticated;

-- ---------------------------------------------------------------- 3. end checkout, with a reason

-- Replaces admin_end_payment_hold(text). The reason may be missing only from a screen older than this migration.
DROP FUNCTION IF EXISTS public.admin_end_payment_hold(text);
CREATE OR REPLACE FUNCTION public.admin_end_payment_hold(_order_no text, _reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  target public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  who text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can end a checkout'; END IF;
  IF _reason IS NOT NULL AND (length(why) < 4 OR length(why) > 300) THEN RAISE EXCEPTION 'Say why this checkout is being ended'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Only a checkout waiting for payment can be ended'; END IF;
  PERFORM private.release_payment_hold(target.id, 'our team ended this checkout', 'ended');
  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.order_cancellations (order_id, order_no, stage, reason, cancelled_by, cancelled_by_name)
  VALUES (target.id, target.order_no, 'Awaiting Payment', why, auth.uid(), COALESCE(who, ''))
  ON CONFLICT (order_id) DO NOTHING;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_end_payment_hold(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_end_payment_hold(text, text) TO authenticated;

-- ---------------------------------------------------------------- 4. delete a rejected or refunded UTR record

CREATE OR REPLACE FUNCTION public.admin_delete_utr(_order_no text, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  who text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete payment records'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this UTR record is being deleted'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This UTR record no longer exists.'; END IF;
  IF s.status = 'submitted' THEN RAISE EXCEPTION 'This UTR still waits for a check. Confirm or reject it first.'; END IF;
  IF s.status = 'confirmed' THEN
    RAISE EXCEPTION 'This UTR paid for order %. To take it off, remove the payment on that order (Payments received, Remove).', s.order_no;
  END IF;
  IF s.note = 'we could not check your UTR in time' THEN
    RAISE EXCEPTION 'Nobody checked this UTR against the bank. Check the bank first: if the money came, refund it and press Refunded, or confirm it on the customer''s new order.';
  END IF;
  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  DELETE FROM public.upi_payment_submissions WHERE id = s.id;
  INSERT INTO public.deleted_payments_log (kind, order_no, payment, order_paid_before, order_paid_after, reason, deleted_by, deleted_by_name)
  VALUES ('utr', s.order_no, to_jsonb(s), COALESCE(o.paid_amount, 0), COALESCE(o.paid_amount, 0), why, auth.uid(), COALESCE(who, ''));
  RETURN jsonb_build_object('order_no', s.order_no, 'utr', s.utr);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_utr(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_utr(text, text) TO authenticated;

-- ---------------------------------------------------------------- 5. delete all details after any cancel

-- Changed 11 Nov 2026 from 20261108100000: a settled bank alert, and stock that left with goods that did not come back,
-- no longer keep a cancelled order. Everything else as live on 11 Nov 2026.
CREATE OR REPLACE FUNCTION private.order_delete_all_reason(_order_id uuid)
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
  IF o.order_status NOT IN ('Payment Expired', 'Cancelled') AND COALESCE(o.zoho_order_status, '') NOT IN ('void', 'cancelled') THEN
    RETURN 'Only a cancelled or expired order, or one that is void in Zoho, can be deleted.';
  END IF;
  IF COALESCE(o.paid_amount, 0) > 0 OR EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id AND p.status = 'Paid') THEN
    RETURN 'This order still counts money as paid. Remove its payments first (Payments received on the order page).';
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted') THEN
    RETURN 'A UTR on this order still waits for a check, so it stays.';
  END IF;
  IF o.payment_hold_until IS NOT NULL AND o.payment_hold_until > now() THEN RETURN 'Its payment window is still open.'; END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_order_push_claims z WHERE z.order_id = o.id
      AND ((z.locked_until IS NOT NULL AND z.locked_until > now()) OR z.write_unanswered_at > now() - interval '10 minutes')) THEN
    RETURN 'A push to Zoho for this order is running or got no clear answer. Wait 10 minutes, then try again.';
  END IF;
  IF COALESCE(o.zoho_salesorder_id, '') <> '' AND COALESCE(o.zoho_order_status, '') NOT IN ('void', 'cancelled') THEN
    RETURN 'Its sales order is still alive in Zoho. Void it in Zoho first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_credits c WHERE c.order_id = o.id AND c.status <> 'settled') THEN
    RETURN 'A bank credit is linked to this order, so it stays for the accounts.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.order_id = o.id)
     OR EXISTS (SELECT 1 FROM public.delivery_stops d WHERE d.order_id = o.id) THEN
    RETURN 'A delivery note exists for this order, so it stays.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id AND private.commission_settled(c.order_item_id) <> 0) THEN
    RETURN 'A partner payout covers this order. Undo that payout first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = o.id) THEN
    RETURN 'This order has a return, so it stays.';
  END IF;
  SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0) INTO held
    FROM public.order_item_batch_allocations a JOIN public.order_items i ON i.id = a.order_item_id WHERE i.order_id = o.id;
  IF held > 0 AND o.order_status NOT IN ('Dispatched', 'Out for Delivery', 'Delivered')
     AND NOT EXISTS (SELECT 1 FROM public.order_cancellations c WHERE c.order_id = o.id AND c.goods_back IS FALSE) THEN
    RETURN 'Stock is still held for this order.';
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.order_delete_all_check(_order_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  notes text[] := ARRAY[]::text[];
  zoho_invoice text;
  not_in_zoho numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND THEN RETURN jsonb_build_object('blocker', 'This order no longer exists.', 'notes', '[]'::jsonb); END IF;
  IF EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id AND p.status <> 'Paid') THEN
    notes := notes || 'Its refunded payment record goes too.'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_refunds r WHERE r.order_id = o.id) THEN
    notes := notes || 'Its refund records go too. The refunded UTRs stay blocked from paying again.'::text;
  END IF;
  SELECT sum(r.amount) INTO not_in_zoho FROM public.order_refunds r
    WHERE r.order_id = o.id AND COALESCE(r.zoho_payment_id, '') <> '' AND r.zoho_refunded_at IS NULL;
  IF not_in_zoho IS NOT NULL THEN
    notes := notes || format('The refund of Rs %s is not in Zoho Books yet. If you delete now, record it in Zoho Books by hand.', to_char(not_in_zoho, 'FM99999990.00'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id) THEN
    notes := notes || 'The UTRs sent for it go too.'::text;
  END IF;
  SELECT invoice_number INTO zoho_invoice FROM public.zoho_order_invoices i WHERE i.order_id = o.id AND COALESCE(i.invoice_number, '') <> ''
    AND COALESCE(i.status, 'none') NOT IN ('none', 'void', 'deleted', 'awaiting_approval') LIMIT 1;
  IF zoho_invoice IS NOT NULL THEN
    notes := notes || format('Zoho Books invoice %s stays in Zoho. Void it there as well if it should not count.', zoho_invoice);
  END IF;
  RETURN jsonb_build_object('blocker', private.order_delete_all_reason(o.id), 'notes', to_jsonb(notes));
END $function$;

-- Changed 11 Nov 2026: the copy also keeps the refunds, the cancellation, the stock taken and any settled bank alert.
CREATE OR REPLACE FUNCTION public.admin_delete_order_all_details(_order_no text, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  blocker text;
  items integer;
  who_name text;
  utr_list text;
  copy jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this order is being deleted'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, '')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This order no longer exists.'; END IF;
  blocker := private.order_delete_all_reason(o.id);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%', blocker; END IF;

  SELECT count(*) INTO items FROM public.order_items WHERE order_id = o.id;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who_name FROM public.profiles p WHERE p.id = auth.uid();
  SELECT string_agg(s.utr || ' (' || s.status || COALESCE(': ' || s.note, '') || ')', '; ' ORDER BY s.submitted_at) INTO utr_list
    FROM public.upi_payment_submissions s WHERE s.order_id = o.id;
  copy := jsonb_build_object(
    'order', to_jsonb(o),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.payments p WHERE p.order_id = o.id), '[]'::jsonb),
    'refunds', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.order_refunds r WHERE r.order_id = o.id), '[]'::jsonb),
    'cancellation', (SELECT to_jsonb(c) FROM public.order_cancellations c WHERE c.order_id = o.id),
    'utrs', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.upi_payment_submissions s WHERE s.order_id = o.id), '[]'::jsonb),
    'bank_credits', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.bank_credits c WHERE c.order_id = o.id), '[]'::jsonb),
    'stock_taken', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id WHERE i.order_id = o.id), '[]'::jsonb),
    'zoho_invoices', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM public.zoho_order_invoices i WHERE i.order_id = o.id), '[]'::jsonb),
    'commissions', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.partner_commissions c WHERE c.order_id = o.id), '[]'::jsonb));
  INSERT INTO public.deleted_orders_log (order_no, order_status, total, item_count, order_created_at, reason, deleted_by, deleted_by_name, utrs,
    zoho_salesorder_id, zoho_order_status, snapshot)
  VALUES (o.order_no, o.order_status, COALESCE(o.total, 0), items, o.created_at, why, auth.uid(), COALESCE(who_name, ''), left(COALESCE(utr_list, ''), 1000),
    COALESCE(o.zoho_salesorder_id, ''), COALESCE(o.zoho_order_status, ''), copy);

  -- Deleting the items would queue a Zoho push for an order that is about to be gone.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = o.id::text AND status = 'pending';
  DELETE FROM public.orders WHERE id = o.id;
  PERFORM set_config('app.zoho_inbound', 'off', true);
  RETURN jsonb_build_object('order_no', o.order_no, 'items', items);
END $function$;

NOTIFY pgrst, 'reload schema';
