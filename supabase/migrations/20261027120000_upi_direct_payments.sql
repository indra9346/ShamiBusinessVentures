-- Zero-fee direct UPI payments.
-- Customers pay the company's own business UPI ID (money goes straight to the bank account that
-- UPI ID is linked to; no gateway, no commission), then send the 12-digit UTR from their UPI app.
-- An administrator checks the UTR against the bank credit and confirms it, which records the
-- payment exactly like a manual payment (admin_confirm_manual_payment) so it reaches Zoho Books.
--
-- Settings live in settings.upi_direct (off until an admin enters the UPI ID and switches it on).
-- Every change of the UPI ID is recorded in upi_settings_audit and every admin is notified.

-- ---------------------------------------------------------------- UTR submissions
CREATE TABLE IF NOT EXISTS public.upi_payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  user_id uuid,
  customer_name text NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  utr text NOT NULL CHECK (utr ~ '^[0-9]{12}$'),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'confirmed', 'rejected')),
  note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);
-- One UTR pays one order (a rejected one may be corrected and reused).
CREATE UNIQUE INDEX IF NOT EXISTS upi_payment_submissions_utr_once
  ON public.upi_payment_submissions (utr) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS upi_payment_submissions_status ON public.upi_payment_submissions (status, submitted_at DESC);

ALTER TABLE public.upi_payment_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS upi_submissions_read ON public.upi_payment_submissions;
CREATE POLICY upi_submissions_read ON public.upi_payment_submissions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
-- No direct writes: only the functions below change rows.
REVOKE INSERT, UPDATE, DELETE ON public.upi_payment_submissions FROM anon, authenticated;
GRANT SELECT ON public.upi_payment_submissions TO authenticated;

-- ---------------------------------------------------------------- UPI ID change log
CREATE TABLE IF NOT EXISTS public.upi_settings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  old_vpa text,
  new_vpa text,
  old_enabled boolean,
  new_enabled boolean,
  payee_name text
);
ALTER TABLE public.upi_settings_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS upi_settings_audit_admin ON public.upi_settings_audit;
CREATE POLICY upi_settings_audit_admin ON public.upi_settings_audit FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
REVOKE INSERT, UPDATE, DELETE ON public.upi_settings_audit FROM anon, authenticated;
GRANT SELECT ON public.upi_settings_audit TO authenticated;

/** Records each change of the direct-UPI settings and tells every admin when the UPI ID or the switch changes. */
CREATE OR REPLACE FUNCTION public.audit_upi_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
    format('Customers now pay UPI ID %s (%s). Direct UPI at checkout is %s. If you did not make this change, check Admin > UPI Payments at once.',
      COALESCE(NULLIF(new_vpa, ''), 'none'), COALESCE(NEW.value->>'payeeName', ''), CASE WHEN new_on THEN 'ON' ELSE 'OFF' END),
    'security'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS settings_audit_upi ON public.settings;
CREATE TRIGGER settings_audit_upi AFTER INSERT OR UPDATE OF value ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_upi_settings();

-- ---------------------------------------------------------------- customer: send the UTR
/**
 * The customer (or an admin for them) sends the UTR of a UPI payment for their own unpaid order.
 * The amount is the order's unpaid balance, never a figure from the browser. A corrected UTR
 * replaces a rejected or still-unchecked one; a confirmed payment is final.
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
  IF o.total - o.paid_amount <= 0 OR o.payment_status = 'Paid' THEN RAISE EXCEPTION 'This order is already paid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || ref, 0));
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE utr = ref AND status <> 'rejected' AND order_id <> o.id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE lower(txn_ref) = ref AND status = 'Paid') THEN
    RAISE EXCEPTION 'This UTR was already used for another payment';
  END IF;
  SELECT * INTO existing FROM public.upi_payment_submissions WHERE order_id = o.id FOR UPDATE;
  IF FOUND AND existing.status = 'confirmed' THEN RAISE EXCEPTION 'This order''s payment is already confirmed'; END IF;
  INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, customer_name, amount, utr, status, note, submitted_at, reviewed_at, reviewed_by)
  VALUES (o.id, o.order_no, o.user_id, COALESCE(o.customer_name, ''), o.total - o.paid_amount, ref, 'submitted', NULL, now(), NULL, NULL)
  ON CONFLICT (order_id) DO UPDATE SET utr = EXCLUDED.utr, amount = EXCLUDED.amount, status = 'submitted', note = NULL,
    submitted_at = now(), reviewed_at = NULL, reviewed_by = NULL
  RETURNING * INTO result;
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', 'UPI payment to check',
    format('%s sent UTR %s for %s (Rs %s). Match it in the bank account, then confirm in Admin > UPI Payments.',
      COALESCE(NULLIF(o.customer_name, ''), 'A customer'), ref, o.order_no, to_char(result.amount, 'FM99999990.00')),
    'payment'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.submit_upi_utr(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_upi_utr(text, text) TO authenticated;

-- ---------------------------------------------------------------- admin: confirm or reject
/**
 * Admin decision on a UTR. Confirming records the payment with admin_confirm_manual_payment (same
 * checks: UTR not used before, order not cancelled, no overpayment; order becomes Paid / Payment
 * Confirmed; the Zoho sync records it in Zoho Books) in the same transaction. Rejecting tells the
 * customer why, and they can send a corrected UTR.
 */
CREATE OR REPLACE FUNCTION public.review_upi_utr(_order_no text, _decision text, _note text DEFAULT NULL)
RETURNS public.upi_payment_submissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  s public.upi_payment_submissions%ROWTYPE;
  result public.upi_payment_submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm UPI payments'; END IF;
  IF _decision NOT IN ('confirmed', 'rejected') THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No UPI payment was sent for this order'; END IF;
  IF s.status <> 'submitted' THEN RAISE EXCEPTION 'This payment was already %', s.status; END IF;
  IF _decision = 'confirmed' THEN
    PERFORM public.admin_confirm_manual_payment(s.order_no, s.amount, s.utr);
  END IF;
  UPDATE public.upi_payment_submissions SET status = _decision, note = NULLIF(trim(COALESCE(_note, '')), ''),
    reviewed_at = now(), reviewed_by = auth.uid()
  WHERE id = s.id RETURNING * INTO result;
  IF s.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (s.order_no, s.order_id, s.user_id, 'customer',
      CASE WHEN _decision = 'confirmed' THEN 'Payment received' ELSE 'Please check your UPI payment' END,
      CASE WHEN _decision = 'confirmed'
        THEN format('We received Rs %s for order %s (UTR %s). Thank you!', to_char(s.amount, 'FM99999990.00'), s.order_no, s.utr)
        ELSE format('UTR %s for order %s could not be matched%s. Open the order and send the correct UTR.', s.utr, s.order_no,
          COALESCE(': ' || NULLIF(trim(COALESCE(_note, '')), ''), '')) END,
      'payment');
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.review_upi_utr(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_upi_utr(text, text, text) TO authenticated;

-- Admin pages update live as customers send UTRs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'upi_payment_submissions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.upi_payment_submissions;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
