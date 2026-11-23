-- Payment rules by order value (client's note, 2 Nov 2026).
--   Below Rs 1,00,000:            UPI or NEFT.
--   Rs 1,00,000 to Rs 1,99,999.99: NEFT.
--   Rs 2,00,000 and above:        NEFT or RTGS.
-- The amount is orders.total: what the customer pays, with GST and delivery, after any coupon.
--
-- NEFT and RTGS need the company's bank details (settings.bank_transfer, entered in Admin). The customer
-- has 1 hour to transfer and enter the UTR, then an admin checks it against the bank account and confirms;
-- only then does the checkout become an order. There is no new order status: "Awaiting Payment" with
-- payment_method NEFT or RTGS is that state, so reports, stock, Zoho and commissions already treat it right.
--
-- A sent UTR stays as sent until it is checked, and a decision is about the UTR on the admin's screen. A third
-- wrong UTR ends the checkout, and an admin can end any checkout. A UTR nobody checked within 24 hours: admins are
-- reminded and told, the customer is told not to pay again, and an admin can record its refund.
-- Bank SMS: money named as NEFT, RTGS or IMPS, or with a NEFT or RTGS order of that amount waiting, never pays
-- an order by its amount alone, and a UTR that already paid an order pays nothing else, however it is written.
--
-- Also fixes what reordering an unpaid checkout runs into: an expired checkout used up a limited coupon,
-- and in an admin's session expiring or cancelling a checkout failed on its fulfilment row.

-- ---------------------------------------------------------------- the rule
CREATE OR REPLACE FUNCTION private.allowed_payment_methods(_total numeric)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE
    WHEN _total < 100000 THEN ARRAY['UPI', 'NEFT']
    WHEN _total < 200000 THEN ARRAY['NEFT']
    ELSE ARRAY['NEFT', 'RTGS']
  END
$function$;
REVOKE ALL ON FUNCTION private.allowed_payment_methods(numeric) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- bank details
-- Not a public settings row: only a signed-in customer reads them, through bank_transfer_details().
CREATE OR REPLACE FUNCTION private.bank_transfer_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE((
    SELECT btrim(COALESCE(value->>'accountName', '')) <> ''
       AND btrim(COALESCE(value->>'bankName', '')) <> ''
       AND COALESCE(value->>'accountNumber', '') ~ '^[0-9A-Z]{6,34}$'
       AND COALESCE(value->>'ifsc', '') ~ '^[A-Z]{4}0[A-Z0-9]{6}$'
    FROM public.settings WHERE key = 'bank_transfer'
  ), false)
$function$;
REVOKE ALL ON FUNCTION private.bank_transfer_ready() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_transfer_details()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to see the bank details'; END IF;
  IF NOT private.bank_transfer_ready() THEN RETURN NULL; END IF;
  RETURN (SELECT jsonb_build_object('accountName', value->>'accountName', 'accountNumber', value->>'accountNumber',
    'ifsc', value->>'ifsc', 'bankName', value->>'bankName', 'branch', COALESCE(value->>'branch', ''))
    FROM public.settings WHERE key = 'bank_transfer');
END;
$function$;
REVOKE ALL ON FUNCTION public.bank_transfer_details() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_transfer_details() TO authenticated;

CREATE TABLE IF NOT EXISTS public.bank_settings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  old_value jsonb,
  new_value jsonb
);
ALTER TABLE public.bank_settings_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_settings_audit_admin ON public.bank_settings_audit;
CREATE POLICY bank_settings_audit_admin ON public.bank_settings_audit FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.bank_settings_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bank_settings_audit TO authenticated;

/** Records each change of the bank details and tells every admin: a changed account redirects customers' money. */
CREATE OR REPLACE FUNCTION public.audit_bank_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  was jsonb := CASE WHEN TG_OP <> 'INSERT' AND OLD.key = 'bank_transfer' THEN OLD.value END;
  is_now jsonb := CASE WHEN TG_OP <> 'DELETE' AND NEW.key = 'bank_transfer' THEN NEW.value END;
BEGIN
  IF was IS NOT DISTINCT FROM is_now THEN RETURN NULL; END IF;
  INSERT INTO public.bank_settings_audit (changed_by, old_value, new_value) VALUES (auth.uid(), was, is_now);
  INSERT INTO public.notifications (recipient_id, recipient_role, title, message, status)
  SELECT ur.user_id, 'admin', 'Bank details changed',
    format('Customers now transfer to %s, account ending %s, IFSC %s. If you did not make this change, check Admin > UPI & Bank Payments at once.',
      COALESCE(NULLIF(is_now->>'accountName', ''), 'none'), COALESCE(NULLIF(right(is_now->>'accountNumber', 4), ''), 'none'),
      COALESCE(NULLIF(is_now->>'ifsc', ''), 'none')),
    'security'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.audit_bank_settings() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS settings_audit_bank ON public.settings;
-- No column list: renaming a row into or out of 'bank_transfer', or deleting it, changes what customers see too.
CREATE TRIGGER settings_audit_bank AFTER INSERT OR UPDATE OR DELETE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_bank_settings();

-- ---------------------------------------------------------------- UTR: NEFT and RTGS have letters and are longer
ALTER TABLE public.upi_payment_submissions DROP CONSTRAINT IF EXISTS upi_payment_submissions_utr_check;
ALTER TABLE public.upi_payment_submissions ADD CONSTRAINT upi_payment_submissions_utr_check CHECK (utr ~ '^[0-9A-Z]{12,22}$');
ALTER TABLE public.upi_payment_submissions ADD COLUMN IF NOT EXISTS rejections integer NOT NULL DEFAULT 0;
-- 'ended': an admin ended the checkout, so the customer is told that and not that their time ran out.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_hold_outcome_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_hold_outcome_check CHECK (payment_hold_outcome IN ('expired', 'dropped', 'ended'));

-- Two UTRs are one transfer when they read the same, with O and 0, I and 1, L and 1 taken as alike (they
-- look alike to the person checking), or when one is exactly 12 digits and is how the other one ends: the same
-- transfer can be written with or without its bank's letters (SBIN422215123456 and 422215123456).
-- Two that both carry letters and differ in them are different transfers.
CREATE OR REPLACE FUNCTION private.utr_form(_utr text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT translate(upper(regexp_replace(COALESCE(_utr, ''), '\s', '', 'g')), 'OIL', '011')
$function$;
REVOKE ALL ON FUNCTION private.utr_form(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.same_utr(_a text, _b text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
  SELECT a <> '' AND (a = b OR (a ~ '^[0-9]{12}$' AND right(b, 12) = a) OR (b ~ '^[0-9]{12}$' AND right(a, 12) = b))
  FROM (SELECT private.utr_form(_a) AS a, private.utr_form(_b) AS b) forms
$function$;
REVOKE ALL ON FUNCTION private.same_utr(text, text) FROM PUBLIC, anon, authenticated;

-- A UTR whose checkout lapsed unchecked, once it has paid a new order: nothing is left to refund or to reorder.
CREATE OR REPLACE FUNCTION private.close_lapsed_utr(_utr text, _order_id uuid, _order_no text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  UPDATE public.upi_payment_submissions SET note = format('Placed again as %s', _order_no)
    WHERE status = 'rejected' AND note = 'we could not check your UTR in time' AND order_id <> _order_id AND private.same_utr(utr, _utr)
$function$;
REVOKE ALL ON FUNCTION private.close_lapsed_utr(text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- orders entered by an admin
-- The method follows the final total on any unpaid order, also after its lines are edited. This trigger
-- is named to run after the order guards, which do not expect a method change. Holds were checked by start_paid_checkout.
CREATE OR REPLACE FUNCTION public.keep_order_method_in_band()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF COALESCE(NEW.paid_amount, 0) = 0 AND COALESCE(NEW.payment_status, '') NOT IN ('Paid', 'Partially Paid')
     AND NEW.payment_method IN ('UPI', 'RTGS') AND NOT NEW.payment_method = ANY (private.allowed_payment_methods(NEW.total)) THEN
    NEW.payment_method := 'NEFT';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.keep_order_method_in_band() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_orders_method_by_total ON public.orders;
CREATE TRIGGER zz_orders_method_by_total BEFORE INSERT OR UPDATE OF total, payment_method ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.keep_order_method_in_band();
-- Orders entered before this rule: a live checkout finishes as it started, within its minutes.
DO $backfill$
BEGIN
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders SET payment_method = 'NEFT'
    WHERE payment_method = 'UPI' AND total >= 100000 AND COALESCE(paid_amount, 0) = 0
      AND COALESCE(payment_status, '') NOT IN ('Paid', 'Partially Paid')
      AND order_status NOT IN ('Cancelled', 'Payment Expired', 'Awaiting Payment');
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$backfill$;

-- ---------------------------------------------------------------- an admin ends a checkout, UTR or not
CREATE OR REPLACE FUNCTION public.admin_end_payment_hold(_order_no text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE target public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can end a checkout'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Only a checkout waiting for payment can be ended'; END IF;
  PERFORM private.release_payment_hold(target.id, 'our team ended this checkout', 'ended');
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_end_payment_hold(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_end_payment_hold(text) TO authenticated;

-- ---------------------------------------------------------------- an admin refunds a UTR that lapsed unchecked
CREATE OR REPLACE FUNCTION public.mark_utr_refunded(_order_no text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE s public.upi_payment_submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can record a refund'; END IF;
  UPDATE public.upi_payment_submissions SET note = 'refunded by our team', reviewed_at = now(), reviewed_by = auth.uid()
    WHERE order_no = _order_no AND status = 'rejected' AND note = 'we could not check your UTR in time' RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a UTR that was not checked in time can be marked refunded'; END IF;
  IF s.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer', 'Refund recorded',
      format('Your transfer with UTR %s for %s was refunded.', s.utr, s.order_no), 'payment');
  END IF;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.mark_utr_refunded(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_utr_refunded(text) TO authenticated;

-- ---------------------------------------------------------------- checkout, confirmation and matching
CREATE OR REPLACE FUNCTION public.start_paid_checkout(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text, _is_b2b boolean DEFAULT NULL::boolean, _business_gstin text DEFAULT NULL::text, _business_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cfg jsonb;
  result jsonb;
  window_minutes integer;
  hold_until timestamptz;
  placed public.orders%ROWTYPE;
  order_pin text;
  address_state text;
  b2b_gstin text := upper(regexp_replace(COALESCE(_business_gstin, ''), '[[:space:]]', '', 'g'));
  b2b_name text := btrim(COALESCE(_business_name, ''));
  state_code text;
  chosen text := upper(btrim(COALESCE(_payment_method, 'UPI')));
  allowed text[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in is required to place an order'; END IF;
  IF chosen NOT IN ('UPI', 'NEFT', 'RTGS') THEN RAISE EXCEPTION 'Choose UPI, NEFT or RTGS to pay'; END IF;
  IF chosen = 'UPI' THEN
    SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
    IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
      RAISE EXCEPTION 'Online payment is being set up. Please call or WhatsApp us to order.';
    END IF;
  ELSIF NOT private.bank_transfer_ready() THEN
    RAISE EXCEPTION 'Payment by NEFT or RTGS is being set up. Please call or WhatsApp us to order.';
  END IF;
  -- The PIN comes from the customer's saved address (never from the browser), and the order is
  -- routed by that same PIN.
  SELECT a.pin, a.state INTO order_pin, address_state FROM public.addresses a
    WHERE a.id::text = _shipping_address->>'id' AND a.user_id = _target_user_id;
  order_pin := regexp_replace(COALESCE(order_pin, _shipping_address->>'pin', ''), '[^0-9]', '', 'g');
  _shipping_address := jsonb_set(COALESCE(_shipping_address, '{}'::jsonb), '{pin}', to_jsonb(order_pin), true);
  -- Only the PIN codes an admin added to an active godown can buy (with PIN matching on): no
  -- falling back to the default godown for an address it does not serve.
  IF COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false)
     AND NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.active AND b.vendor_id IS NULL AND order_pin = ANY (b.serves_pincodes)) THEN
    RAISE EXCEPTION 'We do not deliver to PIN % yet. Request service in your area or become our channel partner there.', COALESCE(NULLIF(order_pin, ''), '(none)');
  END IF;
  -- Company details on the invoice: the company name is required; the GSTIN is optional, but when
  -- given it must be valid and its state (first two digits) must be the address's state.
  IF _is_b2b IS TRUE THEN
    IF length(b2b_name) < 2 THEN RAISE EXCEPTION 'Enter your company name for the invoice'; END IF;
    IF b2b_gstin <> '' AND length(b2b_gstin) <> 15 THEN RAISE EXCEPTION 'A GSTIN has 15 characters'; END IF;
    IF b2b_gstin <> '' AND b2b_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
      RAISE EXCEPTION 'This is not a valid GSTIN (for example 29ABCDE1234F1Z5)';
    END IF;
    state_code := private.gst_state_code(address_state);
    IF b2b_gstin <> '' AND state_code IS NOT NULL AND left(b2b_gstin, 2) <> state_code THEN
      RAISE EXCEPTION 'This GSTIN is registered in state code %, but the address is in % (%). Use an address in the GSTIN''s state.',
        left(b2b_gstin, 2), address_state, state_code;
    END IF;
  END IF;
  PERFORM public.expire_payment_holds();
  -- One checkout at a time per customer, or parallel checkouts could all pass this count.
  PERFORM pg_advisory_xact_lock(hashtextextended('pay-hold:' || _target_user_id::text, 0));
  IF (SELECT count(*) FROM public.orders WHERE user_id = _target_user_id AND order_status = 'Awaiting Payment') >= 3 THEN
    -- A hold with a UTR can be neither paid again nor cancelled, so do not tell them to.
    IF NOT EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.user_id = _target_user_id AND o2.order_status = 'Awaiting Payment'
        AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s2 WHERE s2.order_id = o2.id AND s2.status = 'submitted')) THEN
      RAISE EXCEPTION 'We are still checking your earlier payments. Please call us, or try again once they are confirmed.';
    END IF;
    RAISE EXCEPTION 'You have 3 unpaid orders waiting. Pay or cancel them first.';
  END IF;
  -- UPI: the time set in Admin. NEFT and RTGS: 1 hour to transfer and enter the UTR.
  window_minutes := CASE WHEN chosen = 'UPI'
    THEN LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)))
    ELSE 60 END;

  PERFORM set_config('app.pay_first', 'on', true);
  result := public.place_marketplace_order_with_coupon(_order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address, _shipping_method, chosen, _items, _coupon);

  PERFORM set_config('app.payment_workflow', 'on', true);
  SELECT * INTO placed FROM public.orders WHERE order_no = result->>'order_no' FOR UPDATE;
  IF _is_b2b IS TRUE THEN
    UPDATE public.orders SET customer_gstin = NULLIF(b2b_gstin, ''), business_legal_name = b2b_name, is_b2b = true WHERE id = placed.id;
    -- The customer's Zoho contact (whose name Books bills to) takes the company name, and the GSTIN
    -- when given: registered business with a GSTIN, unregistered business without.
    UPDATE public.profiles SET gstin = NULLIF(b2b_gstin, ''), company = b2b_name WHERE id = _target_user_id;
  ELSIF _is_b2b IS FALSE THEN
    UPDATE public.orders SET customer_gstin = NULL, business_legal_name = NULL, is_b2b = false WHERE id = placed.id;
    -- A personal purchase: the contact goes back to the person, so this invoice is in their name.
    UPDATE public.profiles SET gstin = NULL, company = NULL WHERE id = _target_user_id AND (gstin IS NOT NULL OR company IS NOT NULL);
  ELSE
    UPDATE public.orders SET is_b2b = COALESCE(customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$', false) WHERE id = placed.id;
  END IF;
  SELECT * INTO placed FROM public.orders WHERE id = placed.id;
  IF placed.total <= 0 THEN
    -- Fully covered by a coupon: nothing to pay, so it is an order at once.
    PERFORM set_config('app.pay_first', 'off', true);
    UPDATE public.orders SET order_status = 'Awaiting Payment' WHERE id = placed.id;
    UPDATE public.orders SET order_status = 'Payment Confirmed', payment_status = 'Paid', balance_due = 0 WHERE id = placed.id;
    PERFORM set_config('app.payment_workflow', 'off', true);
    RETURN result || jsonb_build_object('order_status', 'Payment Confirmed', 'hold_until', NULL);
  END IF;
  -- The final total decides the method. Raising here undoes the whole order, stock included.
  allowed := private.allowed_payment_methods(placed.total);
  IF NOT chosen = ANY (allowed) THEN
    RAISE EXCEPTION 'This order comes to Rs %. Pay it by %.', to_char(placed.total, 'FM99999990.00'), array_to_string(allowed, ' or ');
  END IF;
  hold_until := now() + make_interval(mins => window_minutes);
  UPDATE public.orders SET order_status = 'Awaiting Payment', payment_method = chosen, payment_hold_until = hold_until
    WHERE id = placed.id;
  PERFORM set_config('app.payment_workflow', 'off', true);
  PERFORM set_config('app.pay_first', 'off', true);
  RETURN result || jsonb_build_object('order_status', 'Awaiting Payment', 'hold_until', hold_until, 'total', placed.total);
END;
$function$;

CREATE OR REPLACE FUNCTION private.confirm_held_payment(_order_id uuid, _utr text, _note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  paid_by text;
BEGIN
  SELECT * INTO target FROM public.orders WHERE id = _order_id;
  IF target.order_status <> 'Awaiting Payment' THEN RAISE EXCEPTION 'Order % is not waiting for payment', target.order_no; END IF;
  IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, _utr) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  paid_by := COALESCE(NULLIF(target.payment_method, ''), 'UPI');
  PERFORM set_config('app.payment_workflow', 'on', true);
  UPDATE public.orders
    SET paid_amount = total, balance_due = 0, payment_status = 'Paid', order_status = 'Payment Confirmed',
        payment_method = paid_by, payment_hold_until = NULL
    WHERE id = target.id;
  INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, 'advance', target.total - target.paid_amount, paid_by, 'Paid', _utr);
  PERFORM private.close_lapsed_utr(_utr, target.id, target.order_no);
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at)
  VALUES (target.id, target.order_no, target.user_id, COALESCE(target.customer_name, ''), target.total - target.paid_amount, _utr,
    'confirmed', _note, now(), now())
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'confirmed',
    note = EXCLUDED.note, reviewed_at = now(), reviewed_by = NULL;
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$;

CREATE OR REPLACE FUNCTION private.match_bank_credit(_credit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c public.bank_credits%ROWTYPE;
  o public.orders%ROWTYPE;
  candidates uuid[];
  amount_text text;
  bank_named boolean;
  paid_order uuid;
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
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) for %s: %s. Refund it or call the customer.', amount_text, c.utr, o.order_no, c.note));
    RETURN jsonb_build_object('status', c.status, 'order_no', o.order_no);
  END IF;

  -- This UTR already paid an order (an admin confirmed it before the SMS came): that money is accounted for.
  SELECT p.order_id INTO paid_order FROM public.payments p WHERE private.same_utr(p.txn_ref, c.utr) AND p.status = 'Paid' LIMIT 1;
  IF paid_order IS NOT NULL THEN
    SELECT * INTO o FROM public.orders WHERE id = paid_order;
    UPDATE public.bank_credits SET status = 'matched', order_id = o.id, order_no = o.order_no, note = 'Already confirmed by an admin' WHERE id = c.id;
    RETURN jsonb_build_object('status', 'matched', 'order_no', o.order_no);
  END IF;

  -- A waiting NEFT or RTGS order of this amount could be the real payer: its UTR decides, not the amount.
  IF EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Awaiting Payment' AND o2.payment_method IN ('NEFT', 'RTGS')
      AND o2.total - o2.paid_amount = c.amount AND o2.created_at <= c.received_at + interval '2 minutes') THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('A NEFT or RTGS order waits for ₹%s; the customer''s UTR decides', amount_text)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in and a NEFT or RTGS order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- Money named as a bank transfer never pays someone's UPI request by its amount: if one waits, a person decides.
  bank_named := COALESCE(c.raw, '') ~* '(^|[^a-z])(neft|rtgs|imps)([^a-z]|$)';
  IF bank_named AND EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Awaiting Payment'
      AND o2.total - o2.paid_amount = c.amount AND o2.created_at <= c.received_at + interval '2 minutes') THEN
    UPDATE public.bank_credits SET status = 'ambiguous',
      note = format('A bank transfer of ₹%s came in and an unpaid order waits for that amount; the customer''s UTR decides', amount_text)
      WHERE id = c.id RETURNING * INTO c;
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in by bank transfer and an unpaid order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- 2. The one request waiting for exactly this amount at the time the money arrived. A request
  --    whose customer gave a different UTR is not theirs to claim, and a same-amount request that
  --    expired in the last 2 hours could be the real payer: then a person decides. Only UPI requests:
  --    a NEFT or RTGS order is confirmed by its UTR, never by a look-alike amount.
  SELECT array_agg(o2.id ORDER BY o2.created_at) INTO candidates FROM public.orders o2
    WHERE NOT bank_named AND o2.order_status = 'Awaiting Payment'
      AND COALESCE(o2.payment_method, 'UPI') = 'UPI'
      AND o2.total - o2.paid_amount = c.amount
      AND o2.created_at <= c.received_at + interval '2 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o2.id AND s.status = 'submitted');
  IF COALESCE(array_length(candidates, 1), 0) = 1 AND EXISTS (
    SELECT 1 FROM public.orders o2 WHERE o2.order_status = 'Payment Expired' AND o2.payment_hold_outcome = 'expired' AND o2.total = c.amount
      AND o2.updated_at >= c.received_at - interval '2 hours'
      -- The customer's own expired checkout is no rival: reordering gives the same amount, and the money is theirs.
      AND o2.user_id IS DISTINCT FROM (SELECT o3.user_id FROM public.orders o3 WHERE o3.id = candidates[1])
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
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) came in and more than one unpaid order waits for that amount. The customer''s UTR decides; if none comes, match it by hand.', amount_text, c.utr));
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
    PERFORM private.alert_admins_about_credit(c, 'Payment needs you',
      format('₹%s (UTR %s) arrived after %s expired. Refund it or place the order for the customer.', amount_text, c.utr, o.order_no));
    RETURN jsonb_build_object('status', 'late', 'order_no', o.order_no);
  END IF;
  RETURN jsonb_build_object('status', 'unmatched');
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_upi_utr(_order_no text, _utr text)
 RETURNS upi_payment_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  me uuid := auth.uid();
  ref text := upper(regexp_replace(COALESCE(_utr, ''), '\s', '', 'g'));
  ref_key text;
  earlier numeric;
  by_bank boolean;
  o public.orders%ROWTYPE;
  cfg jsonb;
  existing public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
  credit public.bank_credits%ROWTYPE;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Sign in to send the payment details'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF o.user_id IS DISTINCT FROM me AND NOT public.has_role(me, 'admin') THEN RAISE EXCEPTION 'This is not your order'; END IF;
  by_bank := COALESCE(o.payment_method, '') IN ('NEFT', 'RTGS');
  IF by_bank THEN
    IF ref !~ '^[0-9A-Z]{12,22}$' THEN RAISE EXCEPTION 'Enter the UTR from your bank: 12 to 22 letters and numbers'; END IF;
  ELSE
    SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
    IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) OR COALESCE(cfg->>'vpa', '') = '' THEN
      RAISE EXCEPTION 'UPI payment is not switched on';
    END IF;
    IF ref !~ '^[0-9]{12}$' THEN RAISE EXCEPTION 'The UTR has 12 digits'; END IF;
  END IF;
  IF o.order_status = 'Cancelled' THEN RAISE EXCEPTION 'This order is cancelled'; END IF;
  IF o.order_status = 'Payment Expired' THEN
    RAISE EXCEPTION 'The payment time for this order ran out. If money left your account, call us with this UTR.';
  END IF;
  IF o.total - o.paid_amount <= 0 OR o.payment_status = 'Paid' THEN RAISE EXCEPTION 'This order is already paid'; END IF;
  -- NEFT and RTGS: the UTR must come within the 1 hour.
  IF by_bank AND o.order_status = 'Awaiting Payment' AND o.payment_hold_until < now()
     AND NOT EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE order_id = o.id AND status = 'submitted') THEN
    RAISE EXCEPTION 'The 1 hour to enter the UTR is over. If money left your account, call us with this UTR.';
  END IF;
  -- Once only, however the same transfer is written: see private.same_utr. The lock is on how it ends, which is the same for every way of writing it.
  ref_key := right(private.utr_form(ref), 12);
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || ref_key, 0));
  -- A transfer we refunded cannot pay for anything any more.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, ref) AND status = 'rejected' AND note = 'refunded by our team') THEN
    RAISE EXCEPTION 'This UTR was refunded to you. Please pay again for this order.';
  END IF;
  -- Sent again after its checkout lapsed unchecked: it only covers an order of the same amount.
  SELECT amount INTO earlier FROM public.upi_payment_submissions
    WHERE private.same_utr(utr, ref) AND status = 'rejected' AND note = 'we could not check your UTR in time' AND order_id <> o.id LIMIT 1;
  IF earlier IS NOT NULL AND earlier <> o.total - o.paid_amount THEN
    RAISE EXCEPTION 'Your transfer with this UTR was for Rs %, but this order comes to Rs %. Please call us.',
      to_char(earlier, 'FM99999990.00'), to_char(o.total - o.paid_amount, 'FM99999990.00');
  END IF;
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, ref) AND status <> 'rejected' AND order_id <> o.id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, ref) AND status = 'Paid')
     OR EXISTS (SELECT 1 FROM public.bank_credits WHERE private.same_utr(utr, ref) AND status IN ('matched', 'settled') AND order_id IS DISTINCT FROM o.id) THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  SELECT * INTO existing FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  IF FOUND AND existing.status = 'confirmed' THEN RAISE EXCEPTION 'This order''s payment is already confirmed'; END IF;
  -- A UTR stays as sent until it is checked: swapping it could move a real UTR to a second order. Sending it again changes nothing.
  IF FOUND AND existing.status = 'submitted' THEN
    IF private.same_utr(existing.utr, ref) THEN RETURN existing; END IF;
    RAISE EXCEPTION 'We are already checking UTR % for this order. If it was wrong, call us.', existing.utr;
  END IF;
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at, reviewed_by)
  VALUES (o.id, o.order_no, o.user_id, left(COALESCE(o.customer_name, ''), 60), o.total - o.paid_amount, ref, 'submitted', NULL, now(), NULL, NULL)
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

  -- NEFT and RTGS always go to an admin to check.
  IF by_bank THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT o.order_no, o.id, ur.user_id, 'admin', 'Bank transfer to check',
      format('%s UTR %s for %s (Rs %s). Match it in the bank account, then confirm in Admin > UPI & Bank Payments. Customer: %s.',
        o.payment_method, ref, o.order_no, to_char(result.amount, 'FM99999990.00'), left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60)),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
    RETURN result;
  END IF;
  -- Older orders (placed before pay-first) still go to an admin to check.
  IF o.order_status <> 'Awaiting Payment' THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT o.order_no, o.id, ur.user_id, 'admin', 'UPI payment to check',
      format('UTR %s for %s (Rs %s). Match it in the bank account, then confirm in Admin > UPI & Bank Payments. Customer: %s.',
        ref, o.order_no, to_char(result.amount, 'FM99999990.00'), left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60)),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  RETURN result;
END;
$function$;

DROP FUNCTION IF EXISTS public.review_upi_utr(text, text, text);
CREATE OR REPLACE FUNCTION public.review_upi_utr(_order_no text, _decision text, _note text DEFAULT NULL::text, _expected_utr text DEFAULT NULL::text)
 RETURNS upi_payment_submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
  o public.orders%ROWTYPE;
  by_bank boolean;
  cfg jsonb;
  extra_minutes integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm UPI payments'; END IF;
  IF _decision NOT IN ('confirmed', 'rejected') THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UPI payment was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  -- The decision is about the UTR the admin looked at, not whatever the row says by now.
  IF _expected_utr IS NOT NULL AND upper(btrim(_expected_utr)) <> s.utr THEN
    RAISE EXCEPTION 'The UTR for this order is now %. Check the bank again.', s.utr;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = s.order_id FOR UPDATE;
  by_bank := COALESCE(o.payment_method, '') IN ('NEFT', 'RTGS');
  IF _decision = 'confirmed' THEN
    IF o.order_status = 'Awaiting Payment' AND s.amount <> o.total - o.paid_amount THEN
      RAISE EXCEPTION 'An unpaid order is placed only when its full amount is paid';
    END IF;
    PERFORM public.admin_confirm_manual_payment(s.order_no, s.amount, s.utr);
    UPDATE public.orders SET payment_hold_until = NULL WHERE id = s.order_id AND payment_hold_until IS NOT NULL;
    UPDATE public.bank_credits SET status = 'matched', order_id = s.order_id, order_no = s.order_no, note = 'Confirmed by an admin'
      WHERE private.same_utr(utr, s.utr) AND status IN ('unmatched', 'ambiguous', 'mismatch', 'late');
  END IF;
  UPDATE public.upi_payment_submissions SET status = _decision, note = NULLIF(trim(COALESCE(_note, '')), ''),
    reviewed_at = now(), reviewed_by = auth.uid(), rejections = rejections + CASE WHEN _decision = 'rejected' THEN 1 ELSE 0 END
  WHERE id = s.id RETURNING * INTO result;
  IF _decision = 'rejected' AND o.order_status = 'Awaiting Payment' THEN
    -- A third wrong UTR ends the checkout: fake UTRs must not keep stock reserved for ever.
    IF result.rejections >= 3 THEN
      PERFORM private.release_payment_hold(o.id, 'the UTR you sent could not be matched', 'expired');
      RETURN result;
    END IF;
    -- Otherwise time to send the right one, however long the check took: 1 hour for a bank transfer, the Admin setting for UPI.
    IF by_bank THEN
      extra_minutes := 60;
    ELSE
      SELECT value INTO cfg FROM public.settings WHERE key = 'upi_direct';
      extra_minutes := LEAST(60, GREATEST(5, COALESCE(NULLIF(cfg->>'payWindowMinutes', '')::integer, 15)));
    END IF;
    UPDATE public.orders SET payment_hold_until = GREATEST(payment_hold_until, now() + make_interval(mins => extra_minutes)) WHERE id = o.id;
  END IF;
  IF s.user_id IS NOT NULL AND _decision = 'rejected' THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer', CASE WHEN by_bank THEN 'Please check your bank transfer' ELSE 'Please check your UPI payment' END,
      format('UTR %s for order %s could not be matched%s. Open the order and send the correct UTR.', s.utr, s.order_no,
        COALESCE(': ' || NULLIF(trim(COALESCE(_note, '')), ''), '')),
      'payment');
  END IF;
  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_upi_utr(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_upi_utr(text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.expire_payment_holds()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  held record;
  n integer := 0;
  sent_utr text;
BEGIN
  FOR held IN
    SELECT o.id, o.order_no, o.total - o.paid_amount AS due, o.payment_hold_until AS until,
      left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60) AS who, COALESCE(NULLIF(o.customer_phone, ''), 'no phone') AS phone
    FROM public.orders o
    WHERE o.order_status = 'Awaiting Payment' AND o.payment_hold_until IS NOT NULL
      AND (o.payment_hold_until < now() - interval '24 hours'
        OR (o.payment_hold_until < now() AND NOT EXISTS (
          SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = o.id AND s.status = 'submitted')))
    ORDER BY o.payment_hold_until
    FOR UPDATE OF o SKIP LOCKED
  LOOP
    -- Read now that the row is locked: a UTR may have come in the moment before.
    sent_utr := NULL;
    SELECT s.utr INTO sent_utr FROM public.upi_payment_submissions s WHERE s.order_id = held.id AND s.status = 'submitted';
    IF sent_utr IS NULL THEN
      PERFORM private.release_payment_hold(held.id, 'the payment was not received in time', 'expired');
    ELSIF held.until >= now() - interval '24 hours' THEN
      CONTINUE;
    ELSE
      -- A UTR came and nobody checked it within 24 hours: the money may well be in the bank, so say so, to both sides.
      PERFORM private.release_payment_hold(held.id, 'we could not check your UTR in time', 'expired');
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT held.order_no, held.id, ur.user_id, 'admin', 'Payment not checked in time',
        format('UTR %s for %s (Rs %s) was not checked within 24 hours, so its stock was released. Check the bank account: if the money came, ask the customer to press Reorder and send the same UTR, or refund it. Customer: %s, %s.',
          sent_utr, held.order_no, to_char(held.due, 'FM99999990.00'), held.who, held.phone),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    END IF;
    n := n + 1;
  END LOOP;
  -- The customer says they paid, the time is over and no bank alert matched: an admin checks the bank.
  FOR held IN
    SELECT s.id, s.order_id, s.order_no, s.utr, s.amount FROM public.upi_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    WHERE s.status = 'submitted' AND s.note IS NULL AND o.order_status = 'Awaiting Payment' AND o.payment_hold_until < now()
      AND COALESCE(o.payment_method, 'UPI') NOT IN ('NEFT', 'RTGS')  -- admins were told when the UTR came
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.upi_payment_submissions SET note = 'No bank alert yet: check the bank account' WHERE id = held.id;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT held.order_no, held.order_id, ur.user_id, 'admin', 'UPI payment to check',
      format('The customer sent UTR %s for %s (Rs %s) but no bank alert matched it. Check the bank account, then confirm or reject in Admin > UPI & Bank Payments.',
        held.utr, held.order_no, to_char(held.amount, 'FM99999990.00')),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END LOOP;
  -- A NEFT or RTGS UTR still not checked 4 hours before its stock is released: remind the admins once.
  FOR held IN
    SELECT s.id, s.order_id, s.order_no, s.utr, s.amount,
      left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60) AS who, COALESCE(NULLIF(o.customer_phone, ''), 'no phone') AS phone
    FROM public.upi_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    WHERE s.status = 'submitted' AND s.note IS NULL AND o.order_status = 'Awaiting Payment'
      AND o.payment_method IN ('NEFT', 'RTGS') AND o.payment_hold_until < now() - interval '20 hours'
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    UPDATE public.upi_payment_submissions SET note = 'Reminded: check the bank account' WHERE id = held.id;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT held.order_no, held.order_id, ur.user_id, 'admin', 'Bank transfer still to check',
      format('UTR %s for %s (Rs %s) is still not checked. Its stock is released in about 4 hours. Check the bank account, then confirm or reject in Admin > UPI & Bank Payments. Customer: %s, %s.',
        held.utr, held.order_no, to_char(held.amount, 'FM99999990.00'), held.who, held.phone),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END LOOP;
  RETURN n;
END;
$function$;

CREATE OR REPLACE FUNCTION private.release_payment_hold(_order_id uuid, _reason text, _outcome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      format(CASE WHEN _reason = 'we could not check your UTR in time'
        THEN '%s was not placed: %s. Do not pay again. Press Reorder and send the same UTR, or call us and we will refund it.'
        ELSE '%s was not placed: %s. Nothing was charged by us; if money left your account, contact us with the UTR.' END, target.order_no, _reason),
      'payment');
  END IF;
  PERFORM set_config('app.payment_workflow', 'off', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE target public.orders%ROWTYPE; applied numeric; reference text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
  reference := trim(COALESCE(_utr,''));
  IF length(reference) < 4 OR length(reference) > 120 THEN RAISE EXCEPTION 'Enter the verified UTR / transfer reference'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(reference), 0));
  IF EXISTS (SELECT 1 FROM public.payments WHERE lower(txn_ref) = lower(reference) AND status = 'Paid') THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot receive payment'; END IF;
  IF _amount > target.total - target.paid_amount THEN RAISE EXCEPTION 'Payment amount exceeds the unpaid balance'; END IF;
  applied := target.paid_amount + _amount;
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
  -- Paid in full here: the customer's open UTR is settled too, so nothing stays waiting for a check.
  IF applied >= target.total THEN
    UPDATE public.upi_payment_submissions SET status = 'confirmed', note = format('Recorded by an admin with reference %s', reference),
      reviewed_at = now(), reviewed_by = auth.uid()
      WHERE order_id = target.id AND status = 'submitted';
  ELSE
    -- A part payment: that UTR is used up, so the customer can send the next one. A different UTR still waits, for what is left.
    DELETE FROM public.upi_payment_submissions WHERE order_id = target.id AND status = 'submitted' AND private.same_utr(utr, reference);
    UPDATE public.upi_payment_submissions SET amount = target.total - applied WHERE order_id = target.id AND status = 'submitted';
  END IF;
  PERFORM private.close_lapsed_utr(reference, target.id, target.order_no);
  RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION public.audit_upi_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  old_vpa text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.value->>'vpa' END;
  new_vpa text := NEW.value->>'vpa';
  old_on boolean := CASE WHEN TG_OP = 'UPDATE' THEN COALESCE((OLD.value->>'enabled')::boolean, false) END;
  new_on boolean := COALESCE((NEW.value->>'enabled')::boolean, false);
BEGIN
  IF NEW.key <> 'upi_direct' THEN RETURN NEW; END IF;
  IF old_vpa IS NOT DISTINCT FROM new_vpa AND old_on IS NOT DISTINCT FROM new_on THEN RETURN NEW; END IF;
  INSERT INTO public.upi_settings_audit (changed_by, old_vpa, new_vpa, old_enabled, new_enabled, payee_name)
    VALUES (auth.uid(), old_vpa, new_vpa, old_on, new_on, NEW.value->>'payeeName');
  INSERT INTO public.notifications (recipient_id, recipient_role, title, message, status)
  SELECT ur.user_id, 'admin', 'UPI payment settings changed',
    format('Customers now pay UPI ID %s (%s). Direct UPI at checkout is %s. If you did not make this change, check Admin > UPI & Bank Payments at once.',
      COALESCE(NULLIF(new_vpa, ''), 'none'), COALESCE(NEW.value->>'payeeName', ''), CASE WHEN new_on THEN 'ON' ELSE 'OFF' END),
    'security'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- what reordering runs into
CREATE OR REPLACE FUNCTION public.place_marketplace_order_with_coupon(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb, _coupon text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  coupon_row public.coupons%ROWTYPE;
  order_result jsonb;
  coupon_code text := NULLIF(upper(trim(_coupon)), '');
  coupon_discount numeric(14,2) := 0;
  order_subtotal numeric(14,2);
  order_total numeric(14,2);
  customer_uses integer;
BEGIN
  IF coupon_code IS NOT NULL THEN
    IF auth.uid() IS NULL OR NOT (
      public.has_role(auth.uid(), 'customer')
      OR public.has_role(auth.uid(), 'admin')
    ) THEN
      RAISE EXCEPTION 'Only a customer or administrator can use a coupon';
    END IF;
    IF public.has_role(auth.uid(), 'customer') AND _target_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Customers can use coupons only on their own orders';
    END IF;
    SELECT * INTO coupon_row FROM public.coupons
      WHERE code = coupon_code FOR UPDATE;
    IF NOT FOUND OR NOT coupon_row.active
      OR coupon_row.starts_on > current_date
      OR coupon_row.ends_on < current_date
      OR coupon_row.used_count >= coupon_row.usage_limit THEN
      RAISE EXCEPTION 'This coupon is not active or has reached its usage limit';
    END IF;
    IF coupon_row.zoho_usage_limit_per_user IS NOT NULL THEN
      SELECT count(*) INTO customer_uses FROM public.orders
        WHERE user_id = _target_user_id AND coupon = coupon_code
          AND order_status NOT IN ('Cancelled', 'Payment Expired');
      IF customer_uses >= coupon_row.zoho_usage_limit_per_user THEN
        RAISE EXCEPTION 'This customer has already used this coupon the maximum number of times';
      END IF;
    END IF;
  END IF;

  order_result := public.place_marketplace_order(
    _order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address,
    _shipping_method, _payment_method, _items
  );
  order_subtotal := (order_result->>'subtotal')::numeric;
  order_total := (order_result->>'total')::numeric;

  IF coupon_code IS NOT NULL THEN
    IF order_subtotal < coupon_row.minimum_order THEN
      RAISE EXCEPTION 'Add more items to meet this coupon’s minimum order amount';
    END IF;
    IF coupon_row.discount_type = 'Percentage' THEN
      coupon_discount := LEAST(
        coupon_row.maximum_discount,
        round(order_subtotal * coupon_row.discount_value / 100, 2)
      );
    ELSE
      coupon_discount := LEAST(order_subtotal, coupon_row.discount_value);
    END IF;
    order_total := GREATEST(0, order_total - coupon_discount);
    PERFORM set_config('app.coupon_checkout', 'on', true);
    UPDATE public.orders
      SET coupon = coupon_code,
          discount = coupon_discount,
          total = order_total,
          balance_due = GREATEST(order_total - paid_amount, 0)
      WHERE order_no = order_result->>'order_no' AND user_id = _target_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Could not apply the coupon to this order'; END IF;
    UPDATE public.coupons SET used_count = used_count + 1 WHERE code = coupon_code;
  END IF;

  RETURN order_result || jsonb_build_object(
    'coupon', coupon_code,
    'discount', coupon_discount,
    'total', order_total
  );
END;
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
  ELSIF public.has_role(auth.uid(), 'admin') THEN
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

NOTIFY pgrst, 'reload schema';
