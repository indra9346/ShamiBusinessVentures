-- 8 Nov 2026, the owner's list after the 7 Nov daily report. Built from the live function definitions.
--
--  1. Channel partner payouts. A commission can now be closed: the admin pays what is owed, by day or period, and the
--     partner sees every payout. Each payout says which commission lines it paid, line by line, and those amounts always
--     add up to the money sent. What a line still owes is worked out from them, never stored, so nothing can drift:
--       payable   the line's commission if it is earned (Delivered and fully Paid), less any refunded return; else 0
--       settled   the sum of its lines in payouts that were not undone
--       due       payable - settled. Above 0: still to pay. Below 0: paid too much (order later cancelled, refunded or
--                 voided), which comes off the next payout by itself.
--     A wrong payout is undone or corrected with a reason and a log, and is never deleted.
--  2. A recorded payment can be removed by an admin, with a reason and a log, and the order's balance follows.
--  3. "Delete all details": an admin can delete a closed order that the ordinary delete keeps for its refund or Zoho
--     papers. A complete copy stays in the delete log, and its number can never be used again.
--  4. A coupon comes off the item amounts proportionally, and the GST with it (prices include GST).
--  5. A signature picture per godown, printed on that godown's invoices.
--  6. The date Zoho gave the invoice, for the website's copy of it.

-- ---------------------------------------------------------------- 1. Channel partner payouts

CREATE SEQUENCE IF NOT EXISTS public.partner_payout_no_seq;

CREATE TABLE IF NOT EXISTS public.partner_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_no text NOT NULL UNIQUE DEFAULT ('PO-' || lpad(nextval('public.partner_payout_no_seq')::text, 6, '0')),
  partner_id uuid NOT NULL REFERENCES public.channel_partners(id),
  branch_id text NOT NULL,
  paid_on date NOT NULL,
  -- The money actually sent. lines_total = amount + recovered_total.
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  lines_total numeric(14,2) NOT NULL CHECK (lines_total > 0),
  recovered_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (recovered_total >= 0),
  mode text NOT NULL CHECK (mode IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque', 'Adjustment')),
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  period_from date,
  period_to date,
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'voided')),
  -- The page's own id for one press of the button: pressing twice records one payout.
  request_key uuid UNIQUE,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  voided_by_name text NOT NULL DEFAULT '',
  void_reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS partner_payouts_partner_idx ON public.partner_payouts (partner_id, paid_on DESC);
-- One bank reference pays one payout. Undoing a payout frees its reference. Cash vouchers may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS partner_payouts_one_reference ON public.partner_payouts (reference)
  WHERE status = 'paid' AND reference <> '' AND mode NOT IN ('Cash', 'Adjustment');

CREATE TABLE IF NOT EXISTS public.partner_payout_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES public.partner_payouts(id),
  -- Not a foreign key: this stays when an order line is gone. Copies below keep it readable.
  order_item_id uuid NOT NULL,
  order_id uuid,
  order_no text NOT NULL,
  partner_id uuid NOT NULL,
  product_name text NOT NULL DEFAULT '',
  placed_at timestamptz NOT NULL,
  -- Plus: paid for this line. Minus: taken back for this line (it had been paid and is no longer earned).
  amount numeric(14,2) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX IF NOT EXISTS partner_payout_lines_payout_idx ON public.partner_payout_lines (payout_id);
CREATE INDEX IF NOT EXISTS partner_payout_lines_item_idx ON public.partner_payout_lines (order_item_id);
CREATE INDEX IF NOT EXISTS partner_payout_lines_order_idx ON public.partner_payout_lines (order_id);

CREATE TABLE IF NOT EXISTS public.partner_payout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES public.partner_payouts(id),
  event text NOT NULL CHECK (event IN ('created', 'corrected', 'voided')),
  at timestamptz NOT NULL DEFAULT now(),
  by_user uuid,
  by_name text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS partner_payout_events_payout_idx ON public.partner_payout_events (payout_id, at);

ALTER TABLE public.partner_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_payout_events ENABLE ROW LEVEL SECURITY;
-- New tables are granted to everyone by default here; only the functions below write these.
REVOKE ALL ON public.partner_payouts, public.partner_payout_lines, public.partner_payout_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.partner_payout_no_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.partner_payouts, public.partner_payout_lines TO authenticated;
GRANT SELECT ON public.partner_payout_events TO authenticated;
GRANT ALL ON public.partner_payouts, public.partner_payout_lines, public.partner_payout_events TO service_role;

DROP POLICY IF EXISTS partner_payouts_read ON public.partner_payouts;
CREATE POLICY partner_payouts_read ON public.partner_payouts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR partner_id = public.current_partner_id());
DROP POLICY IF EXISTS partner_payout_lines_read ON public.partner_payout_lines;
CREATE POLICY partner_payout_lines_read ON public.partner_payout_lines FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR partner_id = public.current_partner_id());
DROP POLICY IF EXISTS partner_payout_events_admin_read ON public.partner_payout_events;
CREATE POLICY partner_payout_events_admin_read ON public.partner_payout_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

/** A payout, its lines and its log are never deleted: undo a payout instead. */
CREATE OR REPLACE FUNCTION private.keep_payout_records()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Partner payout records are never deleted. Undo the payout instead.';
END $function$;
DROP TRIGGER IF EXISTS partner_payouts_keep ON public.partner_payouts;
CREATE TRIGGER partner_payouts_keep BEFORE DELETE ON public.partner_payouts FOR EACH ROW EXECUTE FUNCTION private.keep_payout_records();
DROP TRIGGER IF EXISTS partner_payout_lines_keep ON public.partner_payout_lines;
CREATE TRIGGER partner_payout_lines_keep BEFORE DELETE OR UPDATE ON public.partner_payout_lines FOR EACH ROW EXECUTE FUNCTION private.keep_payout_records();
DROP TRIGGER IF EXISTS partner_payout_events_keep ON public.partner_payout_events;
CREATE TRIGGER partner_payout_events_keep BEFORE DELETE OR UPDATE ON public.partner_payout_events FOR EACH ROW EXECUTE FUNCTION private.keep_payout_records();

/** What a commission line pays once everything is taken into account: nothing until earned, less refunded returns. */
CREATE OR REPLACE FUNCTION private.commission_payable(_item uuid, _amount numeric, _qty integer, _status text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT CASE WHEN _status <> 'earned' OR COALESCE(_qty, 0) <= 0 THEN 0::numeric
    ELSE round(_amount * GREATEST(0, _qty - COALESCE((SELECT sum(r.quantity) FROM public.return_requests r
           WHERE r.order_item_id = _item AND r.refund_status = 'Refunded'), 0)) / _qty, 2) END
$function$;

/** What payouts not undone have settled on a commission line. */
CREATE OR REPLACE FUNCTION private.commission_settled(_item uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(sum(l.amount), 0) FROM public.partner_payout_lines l
    JOIN public.partner_payouts p ON p.id = l.payout_id
    WHERE l.order_item_id = _item AND p.status = 'paid'
$function$;

/** A commission line that a payout still covers cannot disappear: undo the payout first. */
CREATE OR REPLACE FUNCTION private.keep_paid_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF private.commission_settled(OLD.order_item_id) <> 0 THEN
    RAISE EXCEPTION 'A partner payout covers the commission on %. Undo that payout first.', OLD.order_no;
  END IF;
  RETURN OLD;
END $function$;
DROP TRIGGER IF EXISTS partner_commissions_keep_paid ON public.partner_commissions;
CREATE TRIGGER partner_commissions_keep_paid BEFORE DELETE ON public.partner_commissions
  FOR EACH ROW EXECUTE FUNCTION private.keep_paid_commission();

-- Changed 8 Nov 2026: a refunded order earns nothing (it used to stay Pending for ever).
CREATE OR REPLACE FUNCTION public.partner_commission_status(_order_status text, _payment_status text)
RETURNS text LANGUAGE sql IMMUTABLE AS $function$
  SELECT CASE WHEN _order_status IN ('Cancelled', 'Awaiting Payment', 'Payment Expired') OR _payment_status = 'Refunded' THEN 'cancelled'
              WHEN _order_status = 'Delivered' AND _payment_status = 'Paid' THEN 'earned'
              ELSE 'pending' END
$function$;
UPDATE public.partner_commissions c SET status = public.partner_commission_status(o.order_status, o.payment_status), updated_at = now()
  FROM public.orders o WHERE o.id = c.order_id AND o.payment_status = 'Refunded' AND c.status <> 'cancelled';

-- The lines now also say what was paid and what is left.
DROP FUNCTION IF EXISTS public.partner_commission_lines(date);
CREATE FUNCTION public.partner_commission_lines(_month date)
RETURNS TABLE (order_item_id uuid, order_no text, placed_at timestamptz, order_status text, payment_status text,
  customer_name text, pin text, product_name text, qty integer, line_total numeric, kind text, rate numeric,
  amount numeric, status text, partner_id uuid, paid_amount numeric, due_amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := public.current_partner_id();
  is_admin boolean := public.has_role(auth.uid(), 'admin');
BEGIN
  IF auth.uid() IS NULL OR (me IS NULL AND NOT is_admin) THEN
    RAISE EXCEPTION 'Only channel partners and administrators can view commissions';
  END IF;
  RETURN QUERY
  SELECT c.order_item_id, c.order_no, c.placed_at, o.order_status, o.payment_status, o.customer_name,
    COALESCE(o.shipping_address->>'pin', ''), c.product_name, c.qty, c.line_total, c.kind, c.rate, c.amount, c.status, c.partner_id,
    private.commission_settled(c.order_item_id),
    private.commission_payable(c.order_item_id, c.amount, c.qty, c.status) - private.commission_settled(c.order_item_id)
  FROM public.partner_commissions c
  JOIN public.orders o ON o.id = c.order_id
  WHERE (is_admin OR c.partner_id = me)
    AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('month', _month)::date
    AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date < (date_trunc('month', _month) + interval '1 month')::date
  ORDER BY c.placed_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_commission_lines(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_commission_lines(date) TO authenticated;

/**
 * Commission lines for settling, by the day the order was placed (India time). An admin sees every partner, or one; a
 * partner only their own, whatever is asked for. Unpaid checkout requests are not orders, so their lines are left out.
 */
CREATE OR REPLACE FUNCTION public.partner_settlement_lines(_partner_id uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (order_item_id uuid, partner_id uuid, partner_name text, order_no text, placed_at timestamptz, earned_at timestamptz,
  order_status text, payment_status text, customer_name text, pin text, product_name text, qty integer, line_total numeric,
  kind text, rate numeric, amount numeric, status text, payable numeric, paid_amount numeric, due_amount numeric, payout_nos text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := public.current_partner_id();
  is_admin boolean := public.has_role(auth.uid(), 'admin');
BEGIN
  IF auth.uid() IS NULL OR (me IS NULL AND NOT is_admin) THEN
    RAISE EXCEPTION 'Only channel partners and administrators can view commissions';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT c.*, private.commission_payable(c.order_item_id, c.amount, c.qty, c.status) AS payable_now,
      private.commission_settled(c.order_item_id) AS settled_now
    FROM public.partner_commissions c
    WHERE (is_admin OR c.partner_id = me)
      AND (_partner_id IS NULL OR c.partner_id = _partner_id)
      AND (_from IS NULL OR (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date >= _from)
      AND (_to IS NULL OR (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date <= _to)
  )
  SELECT c.order_item_id, c.partner_id, p.name, c.order_no, c.placed_at, c.earned_at, o.order_status, o.payment_status, o.customer_name,
    COALESCE(o.shipping_address->>'pin', ''), c.product_name, c.qty, c.line_total, c.kind, c.rate, c.amount, c.status,
    c.payable_now, c.settled_now, c.payable_now - c.settled_now,
    COALESCE((SELECT array_agg(DISTINCT y.payout_no) FROM public.partner_payout_lines x JOIN public.partner_payouts y ON y.id = x.payout_id
      WHERE x.order_item_id = c.order_item_id AND y.status = 'paid'), ARRAY[]::text[])
  FROM picked c
  JOIN public.orders o ON o.id = c.order_id
  JOIN public.channel_partners p ON p.id = c.partner_id
  WHERE o.order_status NOT IN ('Awaiting Payment', 'Payment Expired')
  ORDER BY c.placed_at, c.order_item_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_settlement_lines(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_settlement_lines(uuid, date, date) TO authenticated;

/** Each partner's running position, for all time: earned - paid = due - owed back. Suspended partners are still owed. */
CREATE OR REPLACE FUNCTION public.partner_settlement_summary()
RETURNS TABLE (partner_id uuid, partner_name text, godown text, partner_status text, earned numeric, pending numeric, cancelled numeric,
  paid numeric, due numeric, owed_back numeric, payouts integer, last_paid_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := public.current_partner_id();
  is_admin boolean := public.has_role(auth.uid(), 'admin');
BEGIN
  IF auth.uid() IS NULL OR (me IS NULL AND NOT is_admin) THEN
    RAISE EXCEPTION 'Only channel partners and administrators can view commissions';
  END IF;
  RETURN QUERY
  WITH lines AS (
    SELECT c.partner_id, c.status, c.amount,
      private.commission_payable(c.order_item_id, c.amount, c.qty, c.status) AS payable,
      private.commission_settled(c.order_item_id) AS settled
    FROM public.partner_commissions c
    JOIN public.orders o ON o.id = c.order_id
    WHERE o.order_status NOT IN ('Awaiting Payment', 'Payment Expired')
  ), totals AS (
    SELECT l.partner_id,
      COALESCE(sum(l.payable), 0) AS earned,
      COALESCE(sum(l.amount) FILTER (WHERE l.status = 'pending'), 0) AS pending,
      COALESCE(sum(l.amount) FILTER (WHERE l.status = 'cancelled'), 0) AS cancelled,
      COALESCE(sum(GREATEST(l.payable - l.settled, 0)), 0) AS due,
      COALESCE(sum(GREATEST(l.settled - l.payable, 0)), 0) AS owed_back
    FROM lines l GROUP BY l.partner_id
  ), money AS (
    SELECT y.partner_id, COALESCE(sum(y.amount), 0) AS paid, count(*)::integer AS payouts, max(y.paid_on) AS last_paid_on
    FROM public.partner_payouts y WHERE y.status = 'paid' GROUP BY y.partner_id
  )
  SELECT p.id, p.name, COALESCE(b.name, p.branch_id), p.status,
    COALESCE(t.earned, 0), COALESCE(t.pending, 0), COALESCE(t.cancelled, 0), COALESCE(m.paid, 0),
    COALESCE(t.due, 0), COALESCE(t.owed_back, 0), COALESCE(m.payouts, 0), m.last_paid_on
  FROM public.channel_partners p
  LEFT JOIN public.branches b ON b.id = p.branch_id
  LEFT JOIN totals t ON t.partner_id = p.id
  LEFT JOIN money m ON m.partner_id = p.id
  WHERE is_admin OR p.id = me
  ORDER BY COALESCE(b.name, p.branch_id), p.status, p.name;
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_settlement_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_settlement_summary() TO authenticated;

/**
 * Records money sent to a partner against the commission lines the admin ticked. Whatever was paid too much earlier comes
 * off first; then the lines are paid oldest first, so a part payout leaves the newest lines (or part of one) still due.
 * One partner at a time, so two admins cannot pay the same line. _request_key makes a double press record one payout.
 */
CREATE OR REPLACE FUNCTION public.admin_create_partner_payout(_partner_id uuid, _item_ids uuid[], _paid_on date, _mode text, _reference text,
  _note text DEFAULT '', _amount numeric DEFAULT NULL, _period_from date DEFAULT NULL, _period_to date DEFAULT NULL, _request_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  partner public.channel_partners%ROWTYPE;
  who text;
  ref text := upper(regexp_replace(btrim(COALESCE(_reference, '')), '\s+', '', 'g'));
  chosen_mode text := btrim(COALESCE(_mode, ''));
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  owed numeric := 0;
  owed_back numeric := 0;
  recover numeric;
  most numeric;
  cash numeric;
  left_to_settle numeric;
  left_to_recover numeric;
  piece numeric;
  line record;
  bad integer;
  saved public.partner_payouts%ROWTYPE;
  other_no text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can record a payout'; END IF;
  IF _request_key IS NOT NULL THEN
    SELECT * INTO saved FROM public.partner_payouts WHERE request_key = _request_key;
    IF FOUND THEN RETURN jsonb_build_object('payout_no', saved.payout_no, 'id', saved.id, 'amount', saved.amount, 'recovered', saved.recovered_total, 'replayed', true); END IF;
  END IF;
  IF chosen_mode NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how the money was paid'; END IF;
  IF _paid_on IS NULL OR _paid_on > today OR _paid_on < DATE '2026-01-01' THEN RAISE EXCEPTION 'Enter the date the money was paid (not in the future)'; END IF;
  IF COALESCE(array_length(_item_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'Choose the commissions this payout covers'; END IF;
  IF length(COALESCE(_note, '')) > 300 OR length(ref) > 60 THEN RAISE EXCEPTION 'The reference or note is too long'; END IF;

  -- One payout at a time per partner: the second admin waits, then sees the lines already paid.
  SELECT * INTO partner FROM public.channel_partners WHERE id = _partner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partner not found'; END IF;
  PERFORM 1 FROM public.partner_commissions WHERE partner_id = _partner_id FOR UPDATE;

  CREATE TEMP TABLE IF NOT EXISTS payout_work (order_item_id uuid, order_id uuid, order_no text, product_name text, placed_at timestamptz, due numeric, picked boolean) ON COMMIT DROP;
  DELETE FROM payout_work;
  INSERT INTO payout_work
    SELECT c.order_item_id, c.order_id, c.order_no, c.product_name, c.placed_at,
      private.commission_payable(c.order_item_id, c.amount, c.qty, c.status) - private.commission_settled(c.order_item_id),
      c.order_item_id = ANY(_item_ids)
    FROM public.partner_commissions c WHERE c.partner_id = _partner_id;

  SELECT count(*) INTO bad FROM unnest(_item_ids) AS wanted(id)
    WHERE NOT EXISTS (SELECT 1 FROM payout_work w WHERE w.order_item_id = wanted.id AND w.due > 0);
  IF bad > 0 THEN RAISE EXCEPTION 'A commission you ticked is no longer due (paid already, or its order changed). Refresh the page and try again.'; END IF;

  SELECT COALESCE(sum(due) FILTER (WHERE picked AND due > 0), 0), COALESCE(sum(-due) FILTER (WHERE due < 0), 0) INTO owed, owed_back FROM payout_work;
  recover := LEAST(owed, owed_back);
  most := owed - recover;
  cash := COALESCE(round(_amount, 2), most);
  IF cash < 0 OR cash > most THEN
    RAISE EXCEPTION 'The most this payout can be is Rs %', to_char(most, 'FM99999990.00');
  END IF;
  IF cash = 0 AND recover = 0 THEN RAISE EXCEPTION 'Enter the amount paid'; END IF;
  IF cash = 0 THEN
    -- Everything owed was taken up by earlier overpayments: no money moved, only the books are squared.
    chosen_mode := 'Adjustment'; ref := '';
  ELSIF chosen_mode <> 'Cash' AND length(ref) < 4 THEN
    RAISE EXCEPTION 'Enter the UTR or reference of this payment';
  END IF;
  IF ref <> '' AND chosen_mode NOT IN ('Cash', 'Adjustment') THEN
    SELECT payout_no INTO other_no FROM public.partner_payouts WHERE reference = ref AND status = 'paid' AND mode NOT IN ('Cash', 'Adjustment') LIMIT 1;
    IF other_no IS NOT NULL THEN RAISE EXCEPTION 'This reference was already recorded on payout %', other_no; END IF;
  END IF;

  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.partner_payouts (partner_id, branch_id, paid_on, amount, lines_total, recovered_total, mode, reference, note,
      period_from, period_to, request_key, created_by, created_by_name)
    VALUES (_partner_id, partner.branch_id, _paid_on, cash, cash + recover, recover, chosen_mode, ref, btrim(COALESCE(_note, '')),
      _period_from, _period_to, _request_key, auth.uid(), COALESCE(who, ''))
    RETURNING * INTO saved;

  left_to_settle := cash + recover;
  FOR line IN SELECT * FROM payout_work WHERE picked AND due > 0 ORDER BY placed_at, order_item_id LOOP
    EXIT WHEN left_to_settle <= 0;
    piece := LEAST(line.due, left_to_settle);
    INSERT INTO public.partner_payout_lines (payout_id, order_item_id, order_id, order_no, partner_id, product_name, placed_at, amount)
      VALUES (saved.id, line.order_item_id, line.order_id, line.order_no, _partner_id, line.product_name, line.placed_at, piece);
    left_to_settle := left_to_settle - piece;
  END LOOP;
  left_to_recover := recover;
  FOR line IN SELECT * FROM payout_work WHERE due < 0 ORDER BY placed_at, order_item_id LOOP
    EXIT WHEN left_to_recover <= 0;
    piece := LEAST(-line.due, left_to_recover);
    INSERT INTO public.partner_payout_lines (payout_id, order_item_id, order_id, order_no, partner_id, product_name, placed_at, amount)
      VALUES (saved.id, line.order_item_id, line.order_id, line.order_no, _partner_id, line.product_name, line.placed_at, -piece);
    left_to_recover := left_to_recover - piece;
  END LOOP;

  INSERT INTO public.partner_payout_events (payout_id, event, by_user, by_name, detail)
    VALUES (saved.id, 'created', auth.uid(), COALESCE(who, ''), jsonb_build_object('amount', cash, 'recovered', recover, 'lines', cardinality(_item_ids)));
  RETURN jsonb_build_object('payout_no', saved.payout_no, 'id', saved.id, 'amount', cash, 'recovered', recover, 'replayed', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_create_partner_payout(uuid, uuid[], date, text, text, text, numeric, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_partner_payout(uuid, uuid[], date, text, text, text, numeric, date, date, uuid) TO authenticated;

/** Undoes a payout that was wrong (for example the transfer bounced): its lines fall due again. The record stays, marked. */
CREATE OR REPLACE FUNCTION public.admin_void_partner_payout(_payout_id uuid, _reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  target public.partner_payouts%ROWTYPE;
  who text;
  why text := btrim(COALESCE(_reason, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can undo a payout'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this payout is being undone'; END IF;
  SELECT * INTO target FROM public.partner_payouts WHERE id = _payout_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;
  PERFORM 1 FROM public.channel_partners WHERE id = target.partner_id FOR UPDATE;
  SELECT * INTO target FROM public.partner_payouts WHERE id = _payout_id FOR UPDATE;
  IF target.status <> 'paid' THEN RAISE EXCEPTION 'This payout was already undone'; END IF;
  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  UPDATE public.partner_payouts SET status = 'voided', voided_at = now(), voided_by = auth.uid(), voided_by_name = COALESCE(who, ''), void_reason = why WHERE id = target.id;
  INSERT INTO public.partner_payout_events (payout_id, event, by_user, by_name, detail)
    VALUES (target.id, 'voided', auth.uid(), COALESCE(who, ''), jsonb_build_object('reason', why, 'amount', target.amount));
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_void_partner_payout(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_void_partner_payout(uuid, text) TO authenticated;

/** Corrects a payout's date, mode, reference or note, keeping the old values in its log. A wrong amount is undone and entered again. */
CREATE OR REPLACE FUNCTION public.admin_correct_partner_payout(_payout_id uuid, _paid_on date, _mode text, _reference text, _note text, _reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  target public.partner_payouts%ROWTYPE;
  who text;
  why text := btrim(COALESCE(_reason, ''));
  ref text := upper(regexp_replace(btrim(COALESCE(_reference, '')), '\s+', '', 'g'));
  chosen_mode text := btrim(COALESCE(_mode, ''));
  other_no text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can correct a payout'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this payout is being corrected'; END IF;
  SELECT * INTO target FROM public.partner_payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;
  IF target.status <> 'paid' THEN RAISE EXCEPTION 'An undone payout cannot be corrected'; END IF;
  IF target.mode = 'Adjustment' THEN chosen_mode := 'Adjustment'; ref := ''; END IF;
  IF chosen_mode NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque', 'Adjustment') THEN RAISE EXCEPTION 'Choose how the money was paid'; END IF;
  IF chosen_mode = 'Adjustment' AND target.mode <> 'Adjustment' THEN RAISE EXCEPTION 'Choose how the money was paid'; END IF;
  IF _paid_on IS NULL OR _paid_on > (now() AT TIME ZONE 'Asia/Kolkata')::date OR _paid_on < DATE '2026-01-01' THEN RAISE EXCEPTION 'Enter the date the money was paid (not in the future)'; END IF;
  IF chosen_mode NOT IN ('Cash', 'Adjustment') AND length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR or reference of this payment'; END IF;
  IF length(COALESCE(_note, '')) > 300 OR length(ref) > 60 THEN RAISE EXCEPTION 'The reference or note is too long'; END IF;
  IF ref <> '' AND chosen_mode NOT IN ('Cash', 'Adjustment') THEN
    SELECT payout_no INTO other_no FROM public.partner_payouts WHERE reference = ref AND status = 'paid' AND mode NOT IN ('Cash', 'Adjustment') AND id <> target.id LIMIT 1;
    IF other_no IS NOT NULL THEN RAISE EXCEPTION 'This reference was already recorded on payout %', other_no; END IF;
  END IF;
  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  UPDATE public.partner_payouts SET paid_on = _paid_on, mode = chosen_mode, reference = ref, note = btrim(COALESCE(_note, '')) WHERE id = target.id;
  INSERT INTO public.partner_payout_events (payout_id, event, by_user, by_name, detail)
    VALUES (target.id, 'corrected', auth.uid(), COALESCE(who, ''), jsonb_build_object('reason', why,
      'before', jsonb_build_object('paid_on', target.paid_on, 'mode', target.mode, 'reference', target.reference, 'note', target.note)));
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_correct_partner_payout(uuid, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_correct_partner_payout(uuid, date, text, text, text, text) TO authenticated;

-- Changing a partner's login email or phone goes in the partner's log too.
ALTER TABLE public.channel_partner_events DROP CONSTRAINT IF EXISTS channel_partner_events_event_check;
ALTER TABLE public.channel_partner_events ADD CONSTRAINT channel_partner_events_event_check
  CHECK (event IN ('added', 'suspended', 'reactivated', 'moved', 'contact_changed'));
ALTER TABLE public.channel_partner_events ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------- 2. Removing a payment that was recorded

CREATE TABLE IF NOT EXISTS public.deleted_payments_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text NOT NULL,
  payment jsonb NOT NULL,
  order_paid_before numeric(14,2) NOT NULL,
  order_paid_after numeric(14,2) NOT NULL,
  reason text NOT NULL,
  deleted_by uuid NOT NULL,
  deleted_by_name text NOT NULL DEFAULT '',
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deleted_payments_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_payments_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.deleted_payments_log TO authenticated;
GRANT ALL ON public.deleted_payments_log TO service_role;
DROP POLICY IF EXISTS deleted_payments_log_admin_read ON public.deleted_payments_log;
CREATE POLICY deleted_payments_log_admin_read ON public.deleted_payments_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP TRIGGER IF EXISTS deleted_payments_log_keep ON public.deleted_payments_log;
CREATE TRIGGER deleted_payments_log_keep BEFORE DELETE OR UPDATE ON public.deleted_payments_log FOR EACH ROW EXECUTE FUNCTION private.keep_payout_records();

/** Why this payment cannot be removed, or NULL. Payments in Zoho Books are taken out there first (the server does that). */
CREATE OR REPLACE FUNCTION public.payment_delete_blocker(_payment_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  p public.payments%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may remove payments'; END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN RETURN 'This payment no longer exists.'; END IF;
  IF p.status <> 'Paid' THEN RETURN 'Only a payment marked Paid can be removed here.'; END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.order_id = p.order_id) THEN
    RETURN 'A delivery note was issued against this payment, so it stays.';
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.payment_delete_blocker(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_delete_blocker(uuid) TO authenticated;

/**
 * Removes one recorded payment. The order's paid amount, balance and payment status are worked out again from what is left,
 * the partner's commission follows (a paid-out one comes back off the next payout), a copy stays in the log, and the same
 * UTR can be entered again on the right order.
 */
CREATE OR REPLACE FUNCTION public.admin_delete_payment(_payment_id uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  p public.payments%ROWTYPE;
  o public.orders%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
  blocker text;
  who text;
  paid_now numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may remove payments'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this payment is being removed'; END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This payment no longer exists.'; END IF;
  SELECT * INTO o FROM public.orders WHERE id = p.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The order of this payment no longer exists.'; END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This payment no longer exists.'; END IF;
  blocker := public.payment_delete_blocker(_payment_id);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%', blocker; END IF;
  IF COALESCE(p.zoho_payment_id, '') <> '' OR COALESCE(p.zoho_invoice_id, '') <> '' THEN
    RAISE EXCEPTION 'This payment is in Zoho Books. Remove it from the order page, which takes it out of Zoho first.';
  END IF;

  SELECT left(COALESCE(NULLIF(btrim(full_name), ''), ''), 120) INTO who FROM public.profiles WHERE id = auth.uid();
  DELETE FROM public.payments WHERE id = p.id;
  SELECT COALESCE(sum(amount), 0) INTO paid_now FROM public.payments WHERE order_id = o.id AND status = 'Paid';
  INSERT INTO public.deleted_payments_log (order_no, payment, order_paid_before, order_paid_after, reason, deleted_by, deleted_by_name)
    VALUES (o.order_no, to_jsonb(p), COALESCE(o.paid_amount, 0), paid_now, why, auth.uid(), COALESCE(who, ''));
  UPDATE public.orders SET paid_amount = paid_now, balance_due = GREATEST(0, total - paid_now),
    payment_status = CASE WHEN paid_now >= total AND total > 0 THEN 'Paid' WHEN paid_now > 0 THEN 'Partially Paid' ELSE 'Pending' END,
    order_status = CASE WHEN paid_now = 0 AND order_status = 'Payment Confirmed' THEN 'Placed' ELSE order_status END
    WHERE id = o.id;
  -- The transfer is free again: nothing should still say it paid for this order.
  UPDATE public.upi_payment_submissions SET status = 'rejected', note = 'payment removed by an admin', reviewed_at = now(), reviewed_by = auth.uid()
    WHERE order_id = o.id AND status = 'confirmed' AND private.same_payment_ref(utr, p.txn_ref);
  UPDATE public.bank_credits SET status = 'unmatched', order_id = NULL, order_no = NULL, note = 'Payment removed by an admin'
    WHERE order_id = o.id AND status IN ('matched', 'mismatch', 'balance') AND private.same_payment_ref(utr, p.txn_ref);
  IF o.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (o.order_no, o.id, o.user_id, 'customer', 'Payment record corrected',
      format('A payment record on order %s was corrected. Amount paid is now ₹%s and ₹%s is due.', o.order_no,
        to_char(paid_now, 'FM99999990.00'), to_char(GREATEST(0, o.total - paid_now), 'FM99999990.00')), 'payment');
  END IF;
  RETURN jsonb_build_object('order_no', o.order_no, 'paid', paid_now, 'balance', GREATEST(0, o.total - paid_now));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_delete_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_payment(uuid, text) TO authenticated;

-- ---------------------------------------------------------------- 3. Delete all details of a closed order

ALTER TABLE public.deleted_orders_log ADD COLUMN IF NOT EXISTS snapshot jsonb;

/**
 * Why an order cannot go even with everything on it, or NULL. It must be finished with: closed, or void in Zoho and unpaid.
 * Money still counted, a UTR nobody has checked, a live Zoho sales order, a delivery note (their numbers are permanent) and
 * a partner payout still keep it. A refund on record and a Zoho invoice copy do not: those are what this delete is for.
 */
CREATE OR REPLACE FUNCTION private.order_delete_all_reason(_order_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
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
  IF EXISTS (SELECT 1 FROM public.bank_credits c WHERE c.order_id = o.id) THEN
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
  IF held > 0 AND o.order_status NOT IN ('Dispatched', 'Out for Delivery', 'Delivered') THEN RETURN 'Stock is still held for this order.'; END IF;
  RETURN NULL;
END $function$;

/** What the delete-all dialog tells the admin first: what stops it, or what will go and what stays in Zoho. */
CREATE OR REPLACE FUNCTION public.order_delete_all_check(_order_no text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  notes text[] := ARRAY[]::text[];
  zoho_invoice text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete orders'; END IF;
  SELECT * INTO o FROM public.orders WHERE order_no = btrim(COALESCE(_order_no, ''));
  IF NOT FOUND THEN RETURN jsonb_build_object('blocker', 'This order no longer exists.', 'notes', '[]'::jsonb); END IF;
  IF EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id AND p.status <> 'Paid') THEN
    notes := notes || 'Its refunded payment record goes too.'::text;
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
REVOKE ALL ON FUNCTION public.order_delete_all_check(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_delete_all_check(text) TO authenticated;

/** Deletes a closed order with everything on it. A full copy stays in the delete log, and the number is never used again. */
CREATE OR REPLACE FUNCTION public.admin_delete_order_all_details(_order_no text, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
    'utrs', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.upi_payment_submissions s WHERE s.order_id = o.id), '[]'::jsonb),
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
REVOKE ALL ON FUNCTION public.admin_delete_order_all_details(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_order_all_details(text, text) TO authenticated;

-- ---------------------------------------------------------------- 4. Coupons take the GST down with the item amounts

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS coupon_share numeric(14,2) NOT NULL DEFAULT 0;
-- The part of the coupon that came off the taxable value; the rest of it is GST not charged. NULL on orders without one.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_taxable numeric(14,2);

-- ---------------------------------------------------------------- 5. Godown signature

ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS signature_path text;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('godown-signatures', 'godown-signatures', false, 1048576, ARRAY['image/png'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 1048576, allowed_mime_types = ARRAY['image/png'];
-- Printed on invoices made in the browser of whoever is signed in, so signed-in accounts can read it; never the public.
DROP POLICY IF EXISTS godown_signatures_read ON storage.objects;
CREATE POLICY godown_signatures_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'godown-signatures');
DROP POLICY IF EXISTS godown_signatures_admin_insert ON storage.objects;
CREATE POLICY godown_signatures_admin_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'godown-signatures' AND public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS godown_signatures_admin_update ON storage.objects;
CREATE POLICY godown_signatures_admin_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'godown-signatures' AND public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS godown_signatures_admin_delete ON storage.objects;
CREATE POLICY godown_signatures_admin_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'godown-signatures' AND public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- 6. Zoho's invoice date

ALTER TABLE public.zoho_order_invoices ADD COLUMN IF NOT EXISTS invoice_date date;

-- ---------------------------------------------------------------- Live functions changed (each from pg_get_functiondef)


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
  -- Added 8 Nov 2026: a payout that was not undone still counts on this order's commission.
  IF EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id AND private.commission_settled(c.order_item_id) <> 0) THEN
    RETURN 'A partner payout covers this order. Undo that payout first.';
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
  coupon_line record;
  coupon_left numeric(14,2);
  goods_left numeric(14,2);
  line_share numeric(14,2);
  gst_before numeric(14,2);
  gst_after numeric(14,2);
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
  -- Changed 7 Nov 2026: the minimum and the percentage go by the goods total the customer sees (GST included).
  order_subtotal := COALESCE((order_result->>'goods_total')::numeric, (order_result->>'subtotal')::numeric);
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
    -- Changed 8 Nov 2026 (owner): the coupon comes off each item in proportion to its amount, and each item's GST is worked
    -- out again on what is left. Orders placed before this keep their figures.
    gst_before := (order_result->>'gst_amount')::numeric;
    gst_after := gst_before;
    IF COALESCE((order_result->>'prices_include_gst')::boolean, false) AND coupon_discount > 0 THEN
      gst_after := 0;
      coupon_left := coupon_discount;
      goods_left := order_subtotal;
      FOR coupon_line IN
        SELECT i.id, round(i.qty * i.unit_price, 2) AS gross, i.gst_rate FROM public.order_items i
          JOIN public.orders o ON o.id = i.order_id
          WHERE o.order_no = order_result->>'order_no' ORDER BY round(i.qty * i.unit_price, 2) DESC, i.id
      LOOP
        line_share := CASE WHEN goods_left > 0 THEN LEAST(coupon_line.gross, round(coupon_left * coupon_line.gross / goods_left, 2)) ELSE 0 END;
        UPDATE public.order_items SET coupon_share = line_share WHERE id = coupon_line.id;
        gst_after := gst_after + CASE WHEN coupon_line.gst_rate > 0
          THEN round((coupon_line.gross - line_share) * coupon_line.gst_rate / (100 + coupon_line.gst_rate), 2) ELSE 0 END;
        coupon_left := coupon_left - line_share;
        goods_left := goods_left - coupon_line.gross;
      END LOOP;
    END IF;
    UPDATE public.orders
      SET coupon = coupon_code,
          discount = coupon_discount,
          total = order_total,
          balance_due = GREATEST(order_total - paid_amount, 0),
          gst_amount = gst_after,
          discount_taxable = coupon_discount - (gst_before - gst_after)
      WHERE order_no = order_result->>'order_no' AND user_id = _target_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Could not apply the coupon to this order'; END IF;
    UPDATE public.coupons SET used_count = used_count + 1 WHERE code = coupon_code;
  END IF;

  RETURN order_result || jsonb_build_object(
    'coupon', coupon_code,
    'discount', coupon_discount,
    'total', order_total,
    'gst_amount', COALESCE(gst_after, (order_result->>'gst_amount')::numeric)
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.admin_confirm_manual_payment(text, numeric, text);
CREATE OR REPLACE FUNCTION public.admin_confirm_manual_payment(_order_no text, _amount numeric, _utr text, _method text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  credit public.bank_credits%ROWTYPE;
  applied numeric;
  reference text;
  earlier numeric;
  other_order text;
  other_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may reconcile a manual payment'; END IF;
  -- Digits in another script are the same number, and nothing below would see that. Zoho takes up to 100 characters.
  reference := translate(trim(COALESCE(_utr,'')), '೦೧೨೩೪೫೬೭೮೯०१२३४५६७८९٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹０１２３４５６７８９౦౧౨౩౪౫౬౭౮౯௦௧௨௩௪௫௬௭௮௯০১২৩৪৫৬৭৮৯૦૧૨૩૪૫૬૭૮૯੦੧੨੩੪੫੬੭੮੯൦൧൨൩൪൫൬൭൮൯୦୧୨୩୪୫୬୭୮୯', '012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789');
  IF length(reference) < 4 OR length(reference) > 100 THEN RAISE EXCEPTION 'Enter the verified UTR / transfer reference'; END IF;
  -- The payment dialog sends a float: 70.14999999999999 must not leave a fully paid order "Partially Paid".
  _amount := round(_amount, 2);
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
  -- Added 8 Nov 2026: how this payment came in (an order paid by NEFT and UPI has both on its invoice).
  IF _method IS NOT NULL AND _method NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how this payment was made'; END IF;
  -- Once only, however the same transfer is written. The same lock as submit_upi_utr and record_bank_credit, for every
  -- number named, always in the same order.
  PERFORM pg_advisory_xact_lock(hashtextextended('upi-utr:' || key, 0)) FROM unnest(private.utr_lock_keys(reference)) AS key;
  SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
    WHERE private.same_payment_ref(p.txn_ref, reference) AND p.status = 'Paid' ORDER BY p.created_at LIMIT 1;
  IF other_order = _order_no THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded on this order. If that was only part of the money, record the rest under words that do not name it, such as rest of NEFT, and tell the office.';
  ELSIF other_order IS NOT NULL THEN
    RAISE EXCEPTION 'This transfer reference has already been recorded on order %', other_order;
  END IF;
  -- Money that went back pays for nothing, and a payment row marked Refunded has no customer's UTR to catch it by.
  -- Bank transfers only: the word CASH on a refunded row says nothing about new cash.
  IF length(private.utr_form(reference)) >= 12
     AND EXISTS (SELECT 1 FROM public.payments WHERE private.same_payment_ref(txn_ref, reference) AND status = 'Refunded') THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status = 'Cancelled' THEN RAISE EXCEPTION 'Cancelled orders cannot receive payment'; END IF;
  -- Its stock went back on sale and it can never be reopened: money recorded here would pay for nothing.
  IF target.order_status = 'Payment Expired' THEN RAISE EXCEPTION 'This checkout has ended. Place the order again, then record the payment on the new order.'; END IF;
  IF _amount > target.total - target.paid_amount THEN RAISE EXCEPTION 'Payment amount exceeds the unpaid balance'; END IF;
  -- The same checks as a customer's UTR gets in submit_upi_utr.
  IF EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, reference) AND status = 'rejected' AND note = 'refunded by our team') THEN
    RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
  END IF;
  SELECT amount INTO earlier FROM public.upi_payment_submissions
    WHERE private.same_utr(utr, reference) AND status = 'rejected' AND note = 'we could not check your UTR in time' AND order_id <> target.id LIMIT 1;
  IF earlier IS NOT NULL AND earlier < _amount THEN
    RAISE EXCEPTION 'This UTR was sent for an order of Rs % that lapsed. Record no more than that under it, and the rest under its own reference. If the bank shows more, tell the office.', to_char(earlier, 'FM99999990.00');
  END IF;
  SELECT order_no, status INTO other_order, other_status FROM public.upi_payment_submissions WHERE private.same_utr(utr, reference) AND status <> 'rejected' AND order_id <> target.id LIMIT 1;
  IF other_status = 'submitted' THEN
    RAISE EXCEPTION 'The customer sent this UTR on order % and it waits for a check. Reject it there first (UPI & Bank Payments), then record it here.', other_order;
  ELSIF other_order IS NOT NULL THEN
    RAISE EXCEPTION 'The customer sent this UTR on order %, which was paid under another reference. If this money is really for this order, record it under words that do not name the UTR, and tell the office.', other_order;
  END IF;
  -- What the bank said about this transfer, if it said anything. Two alerts cannot be one transfer: their UTRs are unique and all digits.
  SELECT * INTO credit FROM public.bank_credits WHERE private.same_utr(utr, reference) LIMIT 1 FOR UPDATE;
  IF credit.id IS NOT NULL THEN
    IF credit.status = 'settled' THEN
      RAISE EXCEPTION 'The bank alert for UTR % was marked settled (%), so it cannot pay an order. If that was a mistake, reopen it first.', credit.utr, COALESCE(credit.note, 'no note');
    END IF;
    -- This alert's money went back, or was already recorded, whatever bank letters that reference or this one carries.
    IF EXISTS (SELECT 1 FROM public.payments WHERE private.same_utr(txn_ref, credit.utr) AND status = 'Refunded')
       OR EXISTS (SELECT 1 FROM public.upi_payment_submissions WHERE private.same_utr(utr, credit.utr) AND status = 'rejected' AND note = 'refunded by our team') THEN
      RAISE EXCEPTION 'This UTR was refunded. It cannot pay for anything any more.';
    END IF;
    other_order := NULL;
    SELECT o2.order_no INTO other_order FROM public.payments p JOIN public.orders o2 ON o2.id = p.order_id
      WHERE private.same_utr(p.txn_ref, credit.utr) AND p.status = 'Paid' LIMIT 1;
    IF other_order IS NOT NULL OR credit.status = 'matched' THEN
      RAISE EXCEPTION 'This UTR was already used for order %', COALESCE(other_order, credit.order_no, 'another order');
    END IF;
    -- Refused, except up to a rupee short when this clears the balance (a customer who typed Rs 677 for Rs 677.25): that is recorded and the alert stays open for a person.
    IF credit.amount < _amount AND (credit.amount + 1 < _amount OR _amount < target.total - target.paid_amount) THEN
      IF target.order_status = 'Awaiting Payment' THEN
        RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Reject this UTR. If you refund the money, also mark the alert settled: a checkout is placed only when its full amount is paid.',
          credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00');
      END IF;
      RAISE EXCEPTION 'The bank alert for UTR % shows Rs %, not Rs %. Record Rs % as a part payment (Admin > Payments, % percent of the order), then ask the customer for the rest.',
        credit.utr, to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'), to_char(credit.amount, 'FM99999990.00'),
        to_char(round(credit.amount * 100 / NULLIF(target.total, 0), 8), 'FM990.09999999');
    END IF;
  END IF;
  applied := target.paid_amount + _amount;
  UPDATE public.orders SET paid_amount = applied, balance_due = GREATEST(0, total - applied),
    payment_status = CASE WHEN applied >= total THEN 'Paid' ELSE 'Partially Paid' END,
    order_status = CASE WHEN target.paid_amount = 0 AND target.order_status IN ('Placed','Awaiting Payment') THEN 'Payment Confirmed' ELSE target.order_status END
    WHERE id = target.id;
  INSERT INTO public.payments(order_id, user_id, kind, amount, method, status, txn_ref)
    VALUES (target.id, target.user_id, CASE WHEN target.paid_amount = 0 THEN 'advance' ELSE 'balance' END,
      _amount, COALESCE(_method, NULLIF(target.payment_method,''), 'Manual Bank Transfer'), 'Paid', reference);
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
  IF earlier IS NOT NULL AND earlier > _amount THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT target.order_no, target.id, ur.user_id, 'admin', 'Payment needs you',
      format('UTR %s was sent for ₹%s on a checkout that lapsed, and ₹%s of it was recorded for %s. Refund the rest or call the customer.',
        reference, to_char(earlier, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'), target.order_no),
      'payment'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;
  -- The alert is answered, unless the amounts differ: then what is left stays open for a person.
  IF credit.id IS NOT NULL THEN
    IF credit.amount = _amount THEN
      UPDATE public.bank_credits SET status = 'matched', order_id = target.id, order_no = target.order_no, note = 'Confirmed by an admin' WHERE id = credit.id;
    ELSE
      UPDATE public.bank_credits SET status = 'mismatch', order_id = target.id, order_no = target.order_no,
        note = format('Bank amount ₹%s, recorded as ₹%s', to_char(credit.amount, 'FM99999990.00'), to_char(_amount, 'FM99999990.00'))
        WHERE id = credit.id RETURNING * INTO credit;
      IF credit.amount < _amount THEN
        PERFORM private.alert_admins_about_credit(credit, 'Payment needs you',
          format('The bank shows ₹%s for UTR %s, but ₹%s was recorded for %s. Check the bank account, collect the difference or tell the office, then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      ELSE
        PERFORM private.alert_admins_about_credit(credit, 'Payment needs you',
          format('The bank shows ₹%s for UTR %s, but only ₹%s was recorded for %s. Refund the extra or call the customer; if it paid another order, say so. Then mark it settled.',
            to_char(credit.amount, 'FM99999990.00'), credit.utr, to_char(_amount, 'FM99999990.00'), target.order_no));
      END IF;
    END IF;
  END IF;
  RETURN true;
END; $function$;
REVOKE ALL ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_manual_payment(text, numeric, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
