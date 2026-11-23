-- Some banks' credit SMS carry no UTR. IDFC FIRST Bank's reads only "Your A/C XXXXX000900 is credited with INR 2,484.00
-- on 06/11/26 14:21. Your new balance is INR 4,51,961.38. Team IDFC FIRST Bank", so it can never confirm a payment by
-- itself: bank_credits and the automatic match need the UTR the customer sent.
-- Such a credit is kept here, but only when it is for the account customers are told to pay into (settings.bank_transfer):
-- the company phone also gets alerts for other accounts. The admin sees it next to the waiting order of the same amount
-- and confirms that order with one click, through review_upi_utr as before. Nothing is confirmed without a person.
-- Adds a table and four functions; changes no existing table, function or row.

CREATE TABLE IF NOT EXISTS public.bank_credits_without_reference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- The bank's own time from the SMS, when it gives one.
  credited_at timestamptz,
  sender text,
  raw text NOT NULL,
  -- The same SMS forwarded twice is one credit; two payments of one amount differ in the balance after them.
  fingerprint text NOT NULL UNIQUE,
  account_ending text NOT NULL CHECK (account_ending ~ '^[0-9]{3,6}$'),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  balance numeric(16,2),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'used', 'dismissed')),
  order_no text,
  decided_by uuid,
  decided_at timestamptz,
  note text
);
CREATE INDEX IF NOT EXISTS bank_credits_without_reference_recent ON public.bank_credits_without_reference (status, received_at DESC);

ALTER TABLE public.bank_credits_without_reference ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_credits_without_reference_admin_read ON public.bank_credits_without_reference;
CREATE POLICY bank_credits_without_reference_admin_read ON public.bank_credits_without_reference
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
-- Written only by the functions below.
REVOKE INSERT, UPDATE, DELETE ON public.bank_credits_without_reference FROM anon, authenticated;

-- ---------------------------------------------------------------- the bank's SMS comes in (server only)
CREATE OR REPLACE FUNCTION public.record_bank_credit_without_reference(
  _account_ending text, _amount numeric, _credited_at timestamptz, _balance numeric, _raw text, _sender text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  account text;
  ending text := regexp_replace(COALESCE(_account_ending, ''), '\D', '', 'g');
  sms text := regexp_replace(btrim(COALESCE(_raw, '')), '\s+', ' ', 'g');
  credit_amount numeric(14,2) := round(_amount, 2);
  around timestamptz := COALESCE(_credited_at, now());
  new_id uuid;
  waiting integer;
BEGIN
  IF _amount IS NULL OR _amount <= 0 OR sms = '' OR ending !~ '^[0-9]{3,6}$' THEN
    RETURN jsonb_build_object('status', 'unreadable');
  END IF;
  SELECT regexp_replace(COALESCE(value->>'accountNumber', ''), '\D', '', 'g') INTO account
  FROM public.settings WHERE key = 'bank_transfer';
  IF COALESCE(length(account), 0) < length(ending) OR right(account, length(ending)) <> ending THEN
    RETURN jsonb_build_object('status', 'other_account');
  END IF;
  INSERT INTO public.bank_credits_without_reference (credited_at, sender, raw, fingerprint, account_ending, amount, balance)
  VALUES (_credited_at, left(NULLIF(btrim(COALESCE(_sender, '')), ''), 40), left(sms, 1000), md5(lower(sms)), ending, credit_amount, _balance)
  ON CONFLICT (fingerprint) DO NOTHING
  RETURNING id INTO new_id;
  IF new_id IS NULL THEN RETURN jsonb_build_object('status', 'duplicate'); END IF;
  -- Same rule as the admin page: a UTR waiting for a check, for exactly this amount, sent within a day of the credit.
  SELECT count(*) INTO waiting FROM public.upi_payment_submissions s
  WHERE s.status = 'submitted' AND s.amount = credit_amount
    AND s.submitted_at BETWEEN around - interval '24 hours' AND around + interval '24 hours';
  IF waiting > 0 THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NULL, NULL, ur.user_id, 'admin', 'Bank credit to match',
      format('Rs %s was credited to A/C ...%s%s. The bank''s SMS has no UTR. Orders waiting for this amount: %s. Check and confirm in Admin > UPI & Bank Payments.',
        to_char(credit_amount, 'FM99999990.00'), ending,
        COALESCE(' at ' || to_char(_credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), ''), waiting),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  RETURN jsonb_build_object('status', 'recorded', 'id', new_id, 'waiting_orders', waiting);
END;
$$;
REVOKE ALL ON FUNCTION public.record_bank_credit_without_reference(text, numeric, timestamptz, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bank_credit_without_reference(text, numeric, timestamptz, numeric, text, text) TO service_role;

-- ---------------------------------------------------------------- an admin confirms an order with it
CREATE OR REPLACE FUNCTION public.confirm_order_with_bank_credit(_credit_id uuid, _order_no text, _expected_utr text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.bank_credits_without_reference%ROWTYPE;
  s public.upi_payment_submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can confirm payments'; END IF;
  -- One credit pays one order: the second admin to click waits here, then is told it was used.
  SELECT * INTO c FROM public.bank_credits_without_reference WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This bank credit is not on record'; END IF;
  IF c.status = 'used' THEN RAISE EXCEPTION 'This bank credit already paid for %', COALESCE(c.order_no, 'an order'); END IF;
  IF c.status <> 'new' THEN RAISE EXCEPTION 'This bank credit was dismissed. Reopen it first.'; END IF;
  SELECT * INTO s FROM public.upi_payment_submissions WHERE order_no = _order_no;
  IF NOT FOUND OR s.status <> 'submitted' THEN RAISE EXCEPTION 'This order has no UTR waiting for a check'; END IF;
  IF s.amount <> c.amount THEN
    RAISE EXCEPTION 'The bank credit is Rs % but this order''s payment is Rs %', to_char(c.amount, 'FM99999990.00'), to_char(s.amount, 'FM99999990.00');
  END IF;
  -- The usual check and payment: one transfer pays one order, the order is placed or marked paid, the customer is told.
  PERFORM public.review_upi_utr(_order_no, 'confirmed',
    format('Matched by an admin to Rs %s credited to A/C ...%s%s (the bank''s SMS has no UTR)', to_char(c.amount, 'FM99999990.00'), c.account_ending,
      COALESCE(' at ' || to_char(c.credited_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI on DD Mon'), '')),
    _expected_utr);
  UPDATE public.bank_credits_without_reference
  SET status = 'used', order_no = _order_no, decided_by = auth.uid(), decided_at = now()
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'confirmed', 'order_no', _order_no);
END;
$$;

-- ---------------------------------------------------------------- not a website payment, or a mistake
CREATE OR REPLACE FUNCTION public.dismiss_bank_credit_without_reference(_credit_id uuid, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.bank_credits_without_reference%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can do this'; END IF;
  IF btrim(COALESCE(_note, '')) = '' THEN RAISE EXCEPTION 'Say what this money was for'; END IF;
  SELECT * INTO c FROM public.bank_credits_without_reference WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This bank credit is not on record'; END IF;
  IF c.status <> 'new' THEN RAISE EXCEPTION 'Only a credit not yet used can be dismissed'; END IF;
  UPDATE public.bank_credits_without_reference
  SET status = 'dismissed', note = left(btrim(_note), 300), decided_by = auth.uid(), decided_at = now()
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'dismissed');
END;
$$;

CREATE OR REPLACE FUNCTION public.reopen_bank_credit_without_reference(_credit_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.bank_credits_without_reference%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can do this'; END IF;
  SELECT * INTO c FROM public.bank_credits_without_reference WHERE id = _credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This bank credit is not on record'; END IF;
  IF c.status <> 'dismissed' THEN RAISE EXCEPTION 'Only a dismissed credit can be reopened'; END IF;
  UPDATE public.bank_credits_without_reference
  SET status = 'new', note = NULL, decided_by = NULL, decided_at = NULL
  WHERE id = c.id;
  RETURN jsonb_build_object('status', 'new');
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order_with_bank_credit(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dismiss_bank_credit_without_reference(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_bank_credit_without_reference(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_with_bank_credit(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_bank_credit_without_reference(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_bank_credit_without_reference(uuid) TO authenticated;

-- The admin page updates live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bank_credits_without_reference') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bank_credits_without_reference;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
