-- The same UTR on more than one order or account (owner, 6 Nov 2026): find it, show it, act on it.
-- submit_upi_utr already refuses a UTR that pays, or waits on, another order, but the refusal left no trace: an admin
-- never saw that a second account tried someone else's UTR, or kept guessing. Now:
--   send_payment_utr wraps submit_upi_utr (unchanged) and records every UTR a customer sends, accepted or refused, in
--     utr_attempts. A refusal because the UTR belongs to another order tells the admins at once. An account whose UTRs
--     were refused 5 times in an hour is paused for the rest of that hour, and the admins are told once.
--   admin_utr_conflicts lists every transfer (same key as the database's one-transfer lock: the last 12 characters of
--     private.utr_form) that appears on two or more orders or accounts, across UTRs sent, UTRs replaced, refused
--     tries, recorded payments and bank SMS, with who, which order, how much, when and what happened.
--   review_utr_conflict marks a group as looked at; a record newer than the review brings it back.
-- Adds two tables and four functions; changes no existing table, function or row. submit_upi_utr stays callable as
-- before, so the website keeps working while the new code goes live.

CREATE TABLE IF NOT EXISTS public.utr_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  order_id uuid,
  order_no text NOT NULL,
  utr text NOT NULL,
  utr_key text NOT NULL,
  amount numeric(14,2),
  method text,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'refused', 'blocked')),
  reason text
);
CREATE INDEX IF NOT EXISTS utr_attempts_key ON public.utr_attempts (utr_key);
CREATE INDEX IF NOT EXISTS utr_attempts_user_recent ON public.utr_attempts (user_id, at DESC);
CREATE INDEX IF NOT EXISTS utr_attempts_recent ON public.utr_attempts (at DESC);
ALTER TABLE public.utr_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utr_attempts_admin_read ON public.utr_attempts;
CREATE POLICY utr_attempts_admin_read ON public.utr_attempts FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE INSERT, UPDATE, DELETE ON public.utr_attempts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.utr_conflict_reviews (
  utr_key text PRIMARY KEY,
  reviewed_by uuid,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  -- A record newer than reviewed_at brings the group back.
  note text NOT NULL
);
ALTER TABLE public.utr_conflict_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utr_conflict_reviews_admin_read ON public.utr_conflict_reviews;
CREATE POLICY utr_conflict_reviews_admin_read ON public.utr_conflict_reviews FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE INSERT, UPDATE, DELETE ON public.utr_conflict_reviews FROM anon, authenticated;

-- How the database tells one transfer: the same key submit_upi_utr and record_bank_credit lock on.
CREATE OR REPLACE FUNCTION private.utr_key(_utr text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT right(private.utr_form(_utr), 12) $$;
REVOKE ALL ON FUNCTION private.utr_key(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- a customer sends a UTR
CREATE OR REPLACE FUNCTION public.send_payment_utr(_order_no text, _utr text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := auth.uid();
  ref text := left(upper(regexp_replace(COALESCE(_utr, ''), '\s', '', 'g')), 40);
  key text;
  o public.orders%ROWTYPE;
  refused_lately integer;
  sent public.upi_payment_submissions%ROWTYPE;
  message text;
  others text;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Sign in to send the payment details'); END IF;
  key := private.utr_key(ref);
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no;
  -- Someone trying UTR after UTR may be guessing another person's: pause the account for the rest of the hour.
  SELECT count(*) INTO refused_lately FROM public.utr_attempts
  WHERE user_id = me AND outcome IN ('refused', 'blocked') AND at > now() - interval '1 hour';
  IF refused_lately >= 5 THEN
    INSERT INTO public.utr_attempts (user_id, order_id, order_no, utr, utr_key, amount, method, outcome, reason)
    VALUES (me, o.id, left(COALESCE(_order_no, ''), 60), ref, key, o.total - o.paid_amount, o.payment_method, 'blocked', 'too many refused UTRs in an hour');
    IF refused_lately = 5 THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT o.order_no, o.id, ur.user_id, 'admin', 'UTR tries paused',
        format('An account had 5 UTRs refused within an hour, so it can''t send more for an hour. Last order: %s. Customer: %s, %s. See Admin > UPI & Bank Payments > UTR checks.',
          COALESCE(o.order_no, _order_no), left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60), COALESCE(NULLIF(o.customer_phone, ''), 'no phone')),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'Too many UTRs could not be used in the last hour. Please try again in an hour, or call us.');
  END IF;

  BEGIN
    sent := public.submit_upi_utr(_order_no, _utr);
  EXCEPTION WHEN OTHERS THEN
    -- Only the submit is undone; the record of the try stays.
    message := SQLERRM;
    INSERT INTO public.utr_attempts (user_id, order_id, order_no, utr, utr_key, amount, method, outcome, reason)
    VALUES (me, o.id, left(COALESCE(_order_no, ''), 60), ref, key, o.total - o.paid_amount, o.payment_method, 'refused', left(message, 300));
    IF message ILIKE '%already used for another payment%' OR message ILIKE '%was refunded%' THEN
      SELECT string_agg(DISTINCT x.order_no, ', ') INTO others FROM (
        SELECT s.order_no FROM public.upi_payment_submissions s WHERE private.utr_key(s.utr) = key AND s.order_no <> COALESCE(_order_no, '')
        UNION SELECT po.order_no FROM public.payments p JOIN public.orders po ON po.id = p.order_id WHERE p.status = 'Paid' AND private.utr_key(p.txn_ref) = key AND po.order_no <> COALESCE(_order_no, '')
        UNION SELECT b.order_no FROM public.bank_credits b WHERE private.utr_key(b.utr) = key AND b.order_no IS NOT NULL AND b.order_no <> COALESCE(_order_no, '')
      ) x;
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      SELECT o.order_no, o.id, ur.user_id, 'admin', 'Same UTR tried on another order',
        format('UTR %s was sent for %s but it belongs to %s. Customer: %s, %s. Check Admin > UPI & Bank Payments > UTR checks.',
          ref, COALESCE(o.order_no, _order_no), COALESCE(others, 'another order'),
          left(COALESCE(NULLIF(o.customer_name, ''), 'not given'), 60), COALESCE(NULLIF(o.customer_phone, ''), 'no phone')),
        'payment'
      FROM public.user_roles ur WHERE ur.role = 'admin';
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', message);
  END;
  INSERT INTO public.utr_attempts (user_id, order_id, order_no, utr, utr_key, amount, method, outcome, reason)
  VALUES (me, sent.order_id, sent.order_no, sent.utr, private.utr_key(sent.utr), sent.amount, o.payment_method, 'accepted', NULL);
  RETURN jsonb_build_object('ok', true, 'submission', to_jsonb(sent));
END;
$$;
REVOKE ALL ON FUNCTION public.send_payment_utr(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_payment_utr(text, text) TO authenticated;

-- ---------------------------------------------------------------- what an admin sees
CREATE OR REPLACE FUNCTION public.admin_utr_conflicts(_days integer DEFAULT 90)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  since timestamptz := now() - make_interval(days => LEAST(GREATEST(COALESCE(_days, 90), 1), 366));
  found_groups jsonb;
  paused_accounts jsonb;
  recent_tries jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can see this'; END IF;
  WITH recs AS (
    SELECT 'utr_sent'::text AS source, s.order_no, s.user_id, o.customer_name AS who, o.customer_phone AS phone, s.amount,
      s.status AS state, s.submitted_at AS at, s.utr AS ref, private.utr_key(s.utr) AS key, s.note AS detail
    FROM public.upi_payment_submissions s LEFT JOIN public.orders o ON o.id = s.order_id
    WHERE s.submitted_at > since
    UNION ALL
    SELECT 'utr_replaced', s.order_no, s.user_id, o.customer_name, o.customer_phone, s.amount, 'replaced', s.submitted_at, e.ref, private.utr_key(e.ref), 'an earlier UTR for this order'
    FROM public.upi_payment_submissions s LEFT JOIN public.orders o ON o.id = s.order_id CROSS JOIN LATERAL unnest(s.earlier_utrs) AS e(ref)
    WHERE s.submitted_at > since
    UNION ALL
    SELECT 'tried', a.order_no, a.user_id, o.customer_name, o.customer_phone, a.amount, a.outcome, a.at, a.utr, a.utr_key, a.reason
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome <> 'accepted' AND a.at > since
    UNION ALL
    SELECT 'payment', o.order_no, o.user_id, o.customer_name, o.customer_phone, p.amount, p.status, p.created_at, p.txn_ref, private.utr_key(p.txn_ref), p.method
    FROM public.payments p JOIN public.orders o ON o.id = p.order_id
    WHERE p.txn_ref IS NOT NULL AND length(private.utr_form(p.txn_ref)) >= 12 AND p.created_at > since
    UNION ALL
    SELECT 'bank_sms', b.order_no, NULL, b.payer, NULL, b.amount, b.status, b.received_at, b.utr, private.utr_key(b.utr), b.sender
    FROM public.bank_credits b
    WHERE b.received_at > since
  ), grouped AS (
    SELECT key,
      count(*) AS records,
      count(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL) AS orders,
      count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS accounts,
      max(at) AS last_at,
      jsonb_agg(jsonb_build_object('source', source, 'order_no', order_no, 'user_id', user_id, 'who', who, 'phone', phone,
        'amount', amount, 'state', state, 'at', at, 'ref', ref, 'detail', detail) ORDER BY at) AS items
    FROM recs WHERE length(key) = 12
    GROUP BY key
    HAVING count(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL) >= 2 OR count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) >= 2
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', g.key, 'records', g.records, 'orders', g.orders, 'accounts', g.accounts, 'last_at', g.last_at,
      'severity', CASE WHEN g.accounts >= 2 THEN 'high' ELSE 'medium' END,
      'reviewed', r.utr_key IS NOT NULL AND r.reviewed_at >= g.last_at,
      'review_note', r.note, 'reviewed_at', r.reviewed_at,
      'items', g.items) ORDER BY (r.utr_key IS NOT NULL AND r.reviewed_at >= g.last_at), g.accounts DESC, g.last_at DESC), '[]'::jsonb)
  INTO found_groups
  FROM grouped g LEFT JOIN public.utr_conflict_reviews r ON r.utr_key = g.key;

  -- Accounts with refused UTRs in the last day, the most first.
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.refused DESC, x.last_at DESC), '[]'::jsonb) INTO paused_accounts FROM (
    SELECT a.user_id, max(o.customer_name) AS who, max(o.customer_phone) AS phone, count(*) AS refused,
      bool_or(a.outcome = 'blocked' AND a.at > now() - interval '1 hour') AS paused_now, max(a.at) AS last_at
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome IN ('refused', 'blocked') AND a.at > now() - interval '24 hours' AND a.user_id IS NOT NULL
    GROUP BY a.user_id HAVING count(*) >= 2
  ) x;

  -- The latest refused tries, whatever the reason.
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.at DESC), '[]'::jsonb) INTO recent_tries FROM (
    SELECT a.at, a.order_no, a.user_id, o.customer_name AS who, a.utr AS ref, a.amount, a.outcome, a.reason
    FROM public.utr_attempts a LEFT JOIN public.orders o ON o.id = a.order_id
    WHERE a.outcome <> 'accepted' AND a.at > now() - interval '7 days'
    ORDER BY a.at DESC LIMIT 50
  ) x;

  RETURN jsonb_build_object('groups', found_groups, 'accounts', paused_accounts, 'tries', recent_tries, 'since', since);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_utr_conflicts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_utr_conflicts(integer) TO authenticated;

-- ---------------------------------------------------------------- an admin says they looked at a group
CREATE OR REPLACE FUNCTION public.review_utr_conflict(_key text, _note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k text := upper(btrim(COALESCE(_key, '')));
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can do this'; END IF;
  IF length(k) <> 12 THEN RAISE EXCEPTION 'Not a UTR group'; END IF;
  IF btrim(COALESCE(_note, '')) = '' THEN RAISE EXCEPTION 'Say what you found or did'; END IF;
  INSERT INTO public.utr_conflict_reviews (utr_key, reviewed_by, reviewed_at, note)
  VALUES (k, auth.uid(), now(), left(btrim(_note), 300))
  ON CONFLICT (utr_key) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, note = EXCLUDED.note;
  RETURN jsonb_build_object('key', k, 'reviewed_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.review_utr_conflict(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_utr_conflict(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
