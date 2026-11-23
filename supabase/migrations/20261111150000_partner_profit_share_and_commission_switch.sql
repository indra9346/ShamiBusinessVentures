-- 11 Nov 2026, the owner's handwritten note: a second way of paying a channel partner.
--
--   Type 1  per-unit commission, exactly as before.
--   Type 2  monthly profit share. Each month:
--             income      sales before GST - coupons before GST - purchase cost before GST + delivery charges
--                         (delivered and fully paid orders, in the month they became so)
--             deductions  rent, staff, marketing and anything else, each with a label and an amount
--             income tax  a percentage of what is left, only when something is left
--             remaining   net profit after income tax
--             share       the partner's percentage of the remaining
--
-- The owner's answers, 11 Nov:
--   * Chosen per godown, from a month the admin picks, and it replaces per-unit commission there, so nobody is paid twice.
--     An order keeps the way of paying in force when it was placed.
--   * The partner and the admin both add deductions, and the partner earns less by adding one, which is why the admin can
--     add too. The admin closes the month, which locks it and stores its figures. A month not yet paid can be reopened.
--   * A closed month is one amount on the existing Partner Payouts page, with the same payout numbers, UTR and undo.
--   * A refund or cancellation after a month is closed goes into the next month as a correction.
--   * A month with a loss pays nothing and the loss is not carried forward.
--   * If the partner changes during a month, the statement goes to whoever ran the godown on its last day.
--   * A partner sees the month's totals, never the purchase rate of a product.
--
-- Also 11 Nov, the owner's second list: a per-unit or percent rate can be switched off for one product (or for the godown's
-- default). The rate stays saved. New orders of that product then record commission 0; orders already placed do not change.
--
-- A net-profit godown still writes a commission line per order item (kind 'net_profit', amount 0): the leaderboard, target
-- progress and "who signs this invoice" all read those lines, and a line's earned_at decides which month its order is in.

ALTER TABLE public.partner_commission_rules ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.godown_commission_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  from_month date NOT NULL CHECK (extract(day FROM from_month) = 1),
  -- The moment it takes effect: the start of from_month, or the moment it was set if that month had already begun.
  starts_at timestamptz NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('per_unit', 'net_profit')),
  share_percent numeric(5,2) CHECK (share_percent IS NULL OR (share_percent > 0 AND share_percent <= 100)),
  tax_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
  updated_by uuid,
  updated_by_name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, from_month),
  CHECK (scheme <> 'net_profit' OR share_percent IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS godown_commission_schemes_lookup_idx ON public.godown_commission_schemes (branch_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS public.partner_month_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  -- Who is paid. Set when the month is closed.
  partner_id uuid REFERENCES public.channel_partners(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- While open and rates_custom is false these are empty and the godown's percentages apply. Closing stores what was used.
  share_percent numeric(5,2) CHECK (share_percent IS NULL OR (share_percent > 0 AND share_percent <= 100)),
  tax_percent numeric(5,2) CHECK (tax_percent IS NULL OR (tax_percent >= 0 AND tax_percent <= 100)),
  rates_custom boolean NOT NULL DEFAULT false,
  -- The figures, stored when the month is closed.
  sales numeric(14,2) NOT NULL DEFAULT 0,
  coupons numeric(14,2) NOT NULL DEFAULT 0,
  cost numeric(14,2) NOT NULL DEFAULT 0,
  delivery numeric(14,2) NOT NULL DEFAULT 0,
  corrections numeric(14,2) NOT NULL DEFAULT 0,
  sales_without_cost numeric(14,2) NOT NULL DEFAULT 0,
  lines_without_cost integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  income numeric(14,2) NOT NULL DEFAULT 0,
  deductions numeric(14,2) NOT NULL DEFAULT 0,
  profit_before_tax numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  remaining numeric(14,2) NOT NULL DEFAULT 0,
  share_amount numeric(14,2) NOT NULL DEFAULT 0,
  closed_at timestamptz,
  closed_by uuid,
  closed_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, month)
);

-- What a closed month counted, line by line. Later months compare with this to find refunds and cancellations.
CREATE TABLE IF NOT EXISTS public.partner_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES public.partner_month_statements(id) ON DELETE CASCADE,
  row_kind text NOT NULL CHECK (row_kind IN ('sale', 'correction')),
  -- Not foreign keys: these stay when an order is deleted, which is itself a correction.
  order_item_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_no text NOT NULL,
  product_name text NOT NULL DEFAULT '',
  qty numeric(14,3) NOT NULL,
  sales numeric(14,2) NOT NULL,
  coupon numeric(14,2) NOT NULL,
  cost numeric(14,2) NOT NULL,
  delivery numeric(14,2) NOT NULL DEFAULT 0,
  cost_known boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_statement_lines_statement_idx ON public.partner_statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS partner_statement_lines_item_idx ON public.partner_statement_lines (order_item_id);

CREATE TABLE IF NOT EXISTS public.partner_month_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  category text NOT NULL CHECK (category IN ('rent', 'staff', 'marketing', 'other')),
  label text NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  added_by uuid NOT NULL,
  added_by_name text NOT NULL DEFAULT '',
  added_by_role text NOT NULL CHECK (added_by_role IN ('admin', 'partner')),
  -- The page's own id for one press of the button: pressing twice adds one line.
  request_key uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_month_deductions_month_idx ON public.partner_month_deductions (branch_id, month);

CREATE TABLE IF NOT EXISTS public.partner_statement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL,
  month date NOT NULL,
  event text NOT NULL CHECK (event IN ('method_set', 'rates_set', 'deduction_added', 'deduction_removed', 'closed', 'reopened')),
  at timestamptz NOT NULL DEFAULT now(),
  by_user uuid,
  by_name text NOT NULL DEFAULT '',
  by_role text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS partner_statement_events_month_idx ON public.partner_statement_events (branch_id, month, at);

ALTER TABLE public.partner_payouts ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES public.partner_month_statements(id);
CREATE INDEX IF NOT EXISTS partner_payouts_statement_idx ON public.partner_payouts (statement_id) WHERE statement_id IS NOT NULL;

ALTER TABLE public.godown_commission_schemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_month_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_month_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_statement_events ENABLE ROW LEVEL SECURITY;
-- New tables are granted to everyone by default here. Everything goes through the functions below, which decide what a
-- partner may see; the admin page also reads the godown's way of paying directly.
REVOKE ALL ON public.godown_commission_schemes, public.partner_month_statements, public.partner_statement_lines,
  public.partner_month_deductions, public.partner_statement_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.godown_commission_schemes, public.partner_month_statements, public.partner_statement_lines,
  public.partner_month_deductions, public.partner_statement_events TO service_role;
GRANT SELECT ON public.godown_commission_schemes TO authenticated;
DROP POLICY IF EXISTS godown_commission_schemes_admin_read ON public.godown_commission_schemes;
CREATE POLICY godown_commission_schemes_admin_read ON public.godown_commission_schemes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- helpers

CREATE OR REPLACE FUNCTION private.month_first(_day date)
RETURNS date LANGUAGE sql IMMUTABLE AS $function$
  SELECT _day - (extract(day FROM _day)::integer - 1)
$function$;

CREATE OR REPLACE FUNCTION private.ist_this_month()
RETURNS date LANGUAGE sql STABLE AS $function$
  SELECT private.month_first((now() AT TIME ZONE 'Asia/Kolkata')::date)
$function$;

/** The moment a month starts, India time. */
CREATE OR REPLACE FUNCTION private.ist_month_start(_month date)
RETURNS timestamptz LANGUAGE sql STABLE AS $function$
  SELECT _month::timestamp AT TIME ZONE 'Asia/Kolkata'
$function$;

/** The moment a month ends (the first moment of the next), India time. */
CREATE OR REPLACE FUNCTION private.ist_month_end(_month date)
RETURNS timestamptz LANGUAGE sql STABLE AS $function$
  SELECT (_month + interval '1 month')::date::timestamp AT TIME ZONE 'Asia/Kolkata'
$function$;

/** The way of paying a godown's partner at a moment. No row: per-unit, as every godown was before this. */
CREATE OR REPLACE FUNCTION private.godown_scheme_at(_branch_id text, _at timestamptz)
RETURNS public.godown_commission_schemes LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT s.* FROM public.godown_commission_schemes s
  WHERE s.branch_id = _branch_id AND s.starts_at <= _at
  ORDER BY s.starts_at DESC LIMIT 1
$function$;

/** Who a month's statement belongs to: the partner it was closed for, else whoever ran the godown on its last day (or now). */
CREATE OR REPLACE FUNCTION private.net_month_partner(_branch_id text, _month date)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(
    (SELECT s.partner_id FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = _month AND s.status = 'closed'),
    private.godown_partner_at(_branch_id, LEAST(private.ist_month_end(_month) - interval '1 second', now()))
  )
$function$;

/** Is this month a monthly-profit-share month for the godown? Also when the godown went back to per-unit but orders placed before that finished in it. */
CREATE OR REPLACE FUNCTION private.net_month_applies(_branch_id text, _month date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = _month AND s.status = 'closed')
    OR COALESCE((private.godown_scheme_at(_branch_id, LEAST(private.ist_month_end(_month) - interval '1 second', now()))).scheme = 'net_profit', false)
    OR EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.branch_id = _branch_id AND c.kind = 'net_profit' AND c.status = 'earned'
      AND c.earned_at >= private.ist_month_start(_month) AND c.earned_at < private.ist_month_end(_month))
$function$;

/** The percentages for a month: stored or set for it specially, else the godown's latest monthly-profit-share setting by then. */
CREATE OR REPLACE FUNCTION private.net_month_rates(_branch_id text, _month date, OUT share numeric, OUT tax numeric, OUT custom boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  st public.partner_month_statements%ROWTYPE;
  scheme_row public.godown_commission_schemes%ROWTYPE;
BEGIN
  SELECT * INTO st FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = _month;
  custom := COALESCE(st.rates_custom, false);
  IF FOUND AND (st.status = 'closed' OR st.rates_custom) THEN
    share := st.share_percent; tax := COALESCE(st.tax_percent, 0); RETURN;
  END IF;
  SELECT * INTO scheme_row FROM public.godown_commission_schemes s
    WHERE s.branch_id = _branch_id AND s.scheme = 'net_profit' AND s.starts_at < private.ist_month_end(_month)
    ORDER BY s.starts_at DESC LIMIT 1;
  share := scheme_row.share_percent; tax := COALESCE(scheme_row.tax_percent, 0);
END $function$;

/**
 * What a month counts as things stand now, before it is closed.
 *   sale        lines of net-profit orders that became delivered and fully paid in this month and are not counted yet
 *   correction  lines a closed earlier month counted and that have changed since: cancelled, refunded, returned, deleted
 * A line without a purchase rate is listed with cost_known false and left out of income, as the Godown Report does.
 * Coupons are stored with GST in them, so they are brought down to before GST.
 */
CREATE OR REPLACE FUNCTION private.net_month_rows(_branch_id text, _month date)
RETURNS TABLE (row_kind text, order_item_id uuid, order_id uuid, order_no text, product_name text, qty numeric,
  sales numeric, coupon numeric, cost numeric, delivery numeric, cost_known boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH counted AS (
    SELECT l.order_item_id, (array_agg(l.order_id))[1] AS order_id, (array_agg(l.order_no))[1] AS order_no,
      (array_agg(l.product_name))[1] AS product_name, sum(l.qty) AS qty, sum(l.sales) AS sales, sum(l.coupon) AS coupon,
      sum(l.cost) AS cost, sum(l.delivery) AS delivery, bool_and(l.cost_known) AS cost_known
    FROM public.partner_statement_lines l
    JOIN public.partner_month_statements s ON s.id = l.statement_id
    WHERE s.branch_id = _branch_id AND s.month < _month AND s.status = 'closed'
    GROUP BY l.order_item_id
  ), delivered_before AS (
    SELECT k.order_id, sum(k.delivery) AS delivery FROM counted k GROUP BY k.order_id
  ), live AS (
    SELECT c.order_item_id, c.order_id, c.order_no, c.product_name, c.qty AS full_qty, c.status, c.earned_at, c.line_total, o.shipping,
      GREATEST(0, c.qty - COALESCE((SELECT sum(r.quantity) FROM public.return_requests r
        WHERE r.order_item_id = c.order_item_id AND r.refund_status = 'Refunded'), 0)) AS net_qty,
      COALESCE(i.coupon_share, 0) AS coupon_share, COALESCE(i.gst_rate, 0) AS gst_rate,
      (SELECT CASE WHEN p.payload->>'purchasePrice' ~ '^[0-9]+(\.[0-9]+)?$' THEN (p.payload->>'purchasePrice')::numeric END
        FROM public.catalog_products p WHERE p.id = c.product_id) AS rate
    FROM public.partner_commissions c
    JOIN public.orders o ON o.id = c.order_id
    LEFT JOIN public.order_items i ON i.id = c.order_item_id
    WHERE c.branch_id = _branch_id AND c.kind = 'net_profit'
  ), sale AS (
    SELECT l.*, row_number() OVER (PARTITION BY l.order_id ORDER BY l.order_item_id) AS nth
    FROM live l
    LEFT JOIN counted k ON k.order_item_id = l.order_item_id
    WHERE l.status = 'earned' AND l.earned_at >= private.ist_month_start(_month) AND l.earned_at < private.ist_month_end(_month)
      AND COALESCE(k.qty, 0) = 0
  )
  SELECT 'sale'::text, s.order_item_id, s.order_id, s.order_no, s.product_name, s.net_qty::numeric,
    CASE WHEN s.full_qty > 0 THEN round(s.line_total * s.net_qty / s.full_qty, 2) ELSE 0 END,
    CASE WHEN s.full_qty > 0 THEN round((s.coupon_share * 100 / (100 + s.gst_rate)) * s.net_qty / s.full_qty, 2) ELSE 0 END,
    CASE WHEN s.rate > 0 THEN round(s.rate * s.net_qty, 2) ELSE 0 END,
    CASE WHEN s.nth = 1 AND COALESCE(d.delivery, 0) = 0 THEN s.shipping ELSE 0 END,
    COALESCE(s.rate > 0, false)
  FROM sale s
  LEFT JOIN delivered_before d ON d.order_id = s.order_id
  UNION ALL
  SELECT 'correction'::text, k.order_item_id, k.order_id, k.order_no, k.product_name, z.diff,
    round(k.sales * z.diff / k.qty, 2), round(k.coupon * z.diff / k.qty, 2), round(k.cost * z.diff / k.qty, 2),
    CASE WHEN z.gone THEN -k.delivery ELSE 0 END, k.cost_known
  FROM counted k
  LEFT JOIN live l ON l.order_item_id = k.order_item_id
  CROSS JOIN LATERAL (
    SELECT NOT COALESCE(l.status = 'earned', false) AS gone,
      CASE WHEN l.status = 'earned' THEN l.net_qty ELSE 0 END - k.qty AS diff
  ) z
  WHERE k.qty > 0 AND (z.diff <> 0 OR (z.gone AND k.delivery <> 0))
$function$;

/** A month's figures from its rows, its deductions and its percentages. A loss pays nothing and is not carried forward. */
CREATE OR REPLACE FUNCTION private.net_month_totals(_branch_id text, _month date, _tax_percent numeric, _share_percent numeric)
RETURNS TABLE (sales numeric, coupons numeric, cost numeric, delivery numeric, corrections numeric, sales_without_cost numeric,
  lines_without_cost integer, orders integer, income numeric, deductions numeric, profit_before_tax numeric, tax_amount numeric,
  remaining numeric, share_amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH r AS (SELECT * FROM private.net_month_rows(_branch_id, _month)),
  t AS (
    SELECT COALESCE(sum(r.sales) FILTER (WHERE r.row_kind = 'sale' AND r.cost_known), 0) AS sales,
      COALESCE(sum(r.coupon) FILTER (WHERE r.row_kind = 'sale' AND r.cost_known), 0) AS coupons,
      COALESCE(sum(r.cost) FILTER (WHERE r.row_kind = 'sale' AND r.cost_known), 0) AS cost,
      COALESCE(sum(r.delivery) FILTER (WHERE r.row_kind = 'sale'), 0) AS delivery,
      COALESCE(sum(CASE WHEN r.cost_known THEN r.sales - r.coupon - r.cost ELSE 0 END + r.delivery) FILTER (WHERE r.row_kind = 'correction'), 0) AS corrections,
      COALESCE(sum(r.sales) FILTER (WHERE r.row_kind = 'sale' AND NOT r.cost_known), 0) AS sales_without_cost,
      (count(*) FILTER (WHERE r.row_kind = 'sale' AND NOT r.cost_known))::integer AS lines_without_cost,
      (count(DISTINCT r.order_id) FILTER (WHERE r.row_kind = 'sale'))::integer AS orders
    FROM r
  ), a AS (
    SELECT t.*, round(t.sales - t.coupons - t.cost + t.delivery + t.corrections, 2) AS income,
      COALESCE((SELECT sum(d.amount) FROM public.partner_month_deductions d WHERE d.branch_id = _branch_id AND d.month = _month), 0) AS deductions
    FROM t
  ), b AS (
    SELECT a.*, round(a.income - a.deductions, 2) AS profit_before_tax FROM a
  ), c AS (
    SELECT b.*, CASE WHEN b.profit_before_tax > 0 THEN round(b.profit_before_tax * COALESCE(_tax_percent, 0) / 100, 2) ELSE 0 END AS tax_amount FROM b
  ), f AS (
    SELECT c.*, round(c.profit_before_tax - c.tax_amount, 2) AS remaining FROM c
  )
  SELECT f.sales, f.coupons, f.cost, f.delivery, f.corrections, f.sales_without_cost, f.lines_without_cost, f.orders, f.income, f.deductions,
    f.profit_before_tax, f.tax_amount, f.remaining,
    CASE WHEN f.remaining > 0 THEN round(f.remaining * COALESCE(_share_percent, 0) / 100, 2) ELSE 0 END
  FROM f
$function$;

/** Who is calling, and for which godown. A partner only ever reaches their own godown, and only months that are theirs. */
CREATE OR REPLACE FUNCTION private.net_month_access(_month date, _branch_id text,
  OUT out_admin boolean, OUT out_partner uuid, OUT out_branch text, OUT out_who text, OUT out_allowed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  mine public.channel_partners%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in first'; END IF;
  out_admin := public.has_role(auth.uid(), 'admin');
  IF out_admin THEN
    IF COALESCE(_branch_id, '') = '' THEN RAISE EXCEPTION 'Choose a godown'; END IF;
    out_branch := _branch_id;
    SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO out_who FROM public.profiles p WHERE p.id = auth.uid();
    out_who := COALESCE(out_who, '');
    out_allowed := true;
    RETURN;
  END IF;
  SELECT * INTO mine FROM public.channel_partners p WHERE p.user_id = auth.uid() AND p.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only an active channel partner or an administrator can do this'; END IF;
  out_partner := mine.id;
  out_branch := mine.branch_id;
  out_who := mine.name;
  out_allowed := private.net_month_partner(mine.branch_id, _month) IS NOT DISTINCT FROM mine.id;
END $function$;

REVOKE ALL ON FUNCTION private.month_first(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ist_this_month() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ist_month_start(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ist_month_end(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.godown_scheme_at(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_partner(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_applies(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_rates(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_rows(text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_totals(text, date, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.net_month_access(date, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- recording an order's commission

-- Changed 11 Nov 2026: a godown on monthly profit share writes a zero line whether or not a per-unit rate exists, and a
-- rate switched off records 0.
-- Everything else is as it was, from the live definition.
CREATE OR REPLACE FUNCTION public.record_partner_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o public.orders%ROWTYPE;
  partner uuid;
  rule public.partner_commission_rules%ROWTYPE;
  st text;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR o.branch_id IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO partner FROM public.channel_partners WHERE branch_id = o.branch_id AND status = 'active';
  IF partner IS NULL THEN RETURN NEW; END IF;
  st := public.partner_commission_status(o.order_status, o.payment_status);
  IF COALESCE((private.godown_scheme_at(o.branch_id, o.created_at)).scheme = 'net_profit', false) THEN
    INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id,
      product_name, qty, line_total, kind, rate, amount, status, placed_at, earned_at)
    VALUES (NEW.id, o.id, o.order_no, partner, o.branch_id, NEW.product_id, COALESCE(NEW.product_name, ''),
      NEW.qty, NEW.line_total, 'net_profit', 0, 0, st, o.created_at, CASE WHEN st = 'earned' THEN now() END)
    ON CONFLICT (order_item_id) DO NOTHING;
    RETURN NEW;
  END IF;
  SELECT * INTO rule FROM public.partner_commission_rules
    WHERE branch_id = o.branch_id AND (product_id = NEW.product_id OR product_id IS NULL)
    ORDER BY product_id IS NULL LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id,
    product_name, qty, line_total, kind, rate, amount, status, placed_at, earned_at)
  VALUES (NEW.id, o.id, o.order_no, partner, o.branch_id, NEW.product_id, COALESCE(NEW.product_name, ''),
    NEW.qty, NEW.line_total, rule.kind, CASE WHEN rule.enabled THEN rule.value ELSE 0 END,
    CASE WHEN rule.enabled THEN public.partner_commission_amount(rule.kind, rule.value, NEW.qty, NEW.line_total) ELSE 0 END, st, o.created_at,
    CASE WHEN st = 'earned' THEN now() END)
  ON CONFLICT (order_item_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- what the screens call

/** Admin: how a godown's partner is paid from a month on. This month or later only; earlier months stay as they are. */
CREATE OR REPLACE FUNCTION public.admin_set_godown_commission_scheme(_branch_id text, _from_month date, _scheme text,
  _share_percent numeric DEFAULT NULL, _tax_percent numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_from_month);
  who text;
  saved public.godown_commission_schemes%ROWTYPE;
  tax numeric := COALESCE(_tax_percent, 0);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can change how a partner is paid'; END IF;
  IF _from_month IS NULL OR first_day < private.ist_this_month() THEN RAISE EXCEPTION 'Choose this month or a later one. Earlier months stay as they are.'; END IF;
  IF _scheme NOT IN ('per_unit', 'net_profit') THEN RAISE EXCEPTION 'Choose how this godown''s partner is paid'; END IF;
  IF _scheme = 'net_profit' AND (_share_percent IS NULL OR _share_percent <= 0 OR _share_percent > 100) THEN RAISE EXCEPTION 'Enter the partner''s share, above 0 and up to 100 percent'; END IF;
  IF tax < 0 OR tax > 100 THEN RAISE EXCEPTION 'Enter an income tax percentage from 0 to 100'; END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = _branch_id AND b.vendor_id IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Godown not found'; END IF;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.godown_commission_schemes AS s (branch_id, from_month, starts_at, scheme, share_percent, tax_percent, updated_by, updated_by_name, updated_at)
    VALUES (_branch_id, first_day, GREATEST(private.ist_month_start(first_day), now()), _scheme,
      CASE WHEN _scheme = 'net_profit' THEN round(_share_percent, 2) END, CASE WHEN _scheme = 'net_profit' THEN round(tax, 2) ELSE 0 END,
      auth.uid(), COALESCE(who, ''), now())
    ON CONFLICT (branch_id, from_month) DO UPDATE SET
      -- Changing only the percentages does not move the moment the way of paying began.
      starts_at = CASE WHEN s.scheme = EXCLUDED.scheme THEN s.starts_at ELSE EXCLUDED.starts_at END,
      scheme = EXCLUDED.scheme, share_percent = EXCLUDED.share_percent, tax_percent = EXCLUDED.tax_percent,
      updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
    RETURNING * INTO saved;
  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (_branch_id, first_day, 'method_set', auth.uid(), COALESCE(who, ''), 'admin',
      jsonb_build_object('scheme', saved.scheme, 'share_percent', saved.share_percent, 'tax_percent', saved.tax_percent));
  RETURN to_jsonb(saved);
END $function$;
REVOKE ALL ON FUNCTION public.admin_set_godown_commission_scheme(text, date, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_godown_commission_scheme(text, date, text, numeric, numeric) TO authenticated;

/** Admin: different percentages for one month that is still open. */
CREATE OR REPLACE FUNCTION public.admin_set_partner_month_rates(_branch_id text, _month date, _share_percent numeric, _tax_percent numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_month);
  who text;
  st public.partner_month_statements%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can change the percentages'; END IF;
  IF first_day IS NULL OR first_day > private.ist_this_month() THEN RAISE EXCEPTION 'Choose a month that has started'; END IF;
  IF _share_percent IS NULL OR _share_percent <= 0 OR _share_percent > 100 THEN RAISE EXCEPTION 'Enter the partner''s share, above 0 and up to 100 percent'; END IF;
  IF _tax_percent IS NULL OR _tax_percent < 0 OR _tax_percent > 100 THEN RAISE EXCEPTION 'Enter an income tax percentage from 0 to 100'; END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = _branch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Godown not found'; END IF;
  IF NOT private.net_month_applies(_branch_id, first_day) THEN RAISE EXCEPTION 'This godown is on per-unit commission for this month'; END IF;
  SELECT * INTO st FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = first_day;
  IF FOUND AND st.status = 'closed' THEN RAISE EXCEPTION 'This month is closed. Reopen it first.'; END IF;
  INSERT INTO public.partner_month_statements AS s (branch_id, month, share_percent, tax_percent, rates_custom)
    VALUES (_branch_id, first_day, round(_share_percent, 2), round(_tax_percent, 2), true)
    ON CONFLICT (branch_id, month) DO UPDATE SET share_percent = EXCLUDED.share_percent, tax_percent = EXCLUDED.tax_percent, rates_custom = true;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (_branch_id, first_day, 'rates_set', auth.uid(), COALESCE(who, ''), 'admin', jsonb_build_object('share_percent', _share_percent, 'tax_percent', _tax_percent));
  RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.admin_set_partner_month_rates(text, date, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_partner_month_rates(text, date, numeric, numeric) TO authenticated;

/**
 * One month's statement. A partner gets the totals and the deductions of their own months, never a line or a product's
 * cost; an admin also gets the lines counted and the log. {"applies": false} means the month is on per-unit commission.
 */
CREATE OR REPLACE FUNCTION public.partner_month_statement(_month date, _branch_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_month);
  this_month date := private.ist_this_month();
  caller record;
  st public.partner_month_statements%ROWTYPE;
  rates record;
  t record;
  closed boolean;
  paid numeric := 0;
  owner_id uuid;
  owner_name text;
  deduction_rows jsonb;
  admin_extra jsonb := '{}'::jsonb;
BEGIN
  IF first_day IS NULL OR first_day > this_month THEN RAISE EXCEPTION 'Choose a month that has started'; END IF;
  SELECT * INTO caller FROM private.net_month_access(first_day, _branch_id);
  IF NOT caller.out_allowed OR NOT private.net_month_applies(caller.out_branch, first_day) THEN
    RETURN jsonb_build_object('applies', false, 'month', first_day, 'branch_id', caller.out_branch);
  END IF;

  SELECT * INTO st FROM public.partner_month_statements s WHERE s.branch_id = caller.out_branch AND s.month = first_day;
  closed := FOUND AND st.status = 'closed';
  SELECT * INTO rates FROM private.net_month_rates(caller.out_branch, first_day);
  IF closed THEN
    SELECT st.sales, st.coupons, st.cost, st.delivery, st.corrections, st.sales_without_cost, st.lines_without_cost, st.orders, st.income,
      st.deductions, st.profit_before_tax, st.tax_amount, st.remaining, st.share_amount INTO t;
    SELECT COALESCE(sum(y.amount), 0) INTO paid FROM public.partner_payouts y WHERE y.statement_id = st.id AND y.status = 'paid';
  ELSE
    SELECT * INTO t FROM private.net_month_totals(caller.out_branch, first_day, rates.tax, rates.share);
  END IF;
  owner_id := private.net_month_partner(caller.out_branch, first_day);
  SELECT p.name INTO owner_name FROM public.channel_partners p WHERE p.id = owner_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', d.id, 'category', d.category, 'label', d.label, 'amount', d.amount, 'added_by_name', d.added_by_name,
      'added_by_role', d.added_by_role, 'created_at', d.created_at,
      'can_remove', NOT closed AND (caller.out_admin OR d.added_by = auth.uid())) ORDER BY d.created_at, d.id), '[]'::jsonb)
    INTO deduction_rows FROM public.partner_month_deductions d WHERE d.branch_id = caller.out_branch AND d.month = first_day;

  IF caller.out_admin THEN
    admin_extra := jsonb_build_object(
      'lines', CASE WHEN closed THEN
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('row_kind', l.row_kind, 'order_no', l.order_no, 'product_name', l.product_name, 'qty', l.qty,
          'sales', l.sales, 'coupon', l.coupon, 'cost', l.cost, 'delivery', l.delivery, 'cost_known', l.cost_known) ORDER BY l.row_kind DESC, l.order_no, l.product_name), '[]'::jsonb)
          FROM public.partner_statement_lines l WHERE l.statement_id = st.id)
        ELSE
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('row_kind', r.row_kind, 'order_no', r.order_no, 'product_name', r.product_name, 'qty', r.qty,
          'sales', r.sales, 'coupon', r.coupon, 'cost', r.cost, 'delivery', r.delivery, 'cost_known', r.cost_known) ORDER BY r.row_kind DESC, r.order_no, r.product_name), '[]'::jsonb)
          FROM private.net_month_rows(caller.out_branch, first_day) r)
        END,
      'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('event', e.event, 'at', e.at, 'by_name', e.by_name, 'by_role', e.by_role, 'detail', e.detail) ORDER BY e.at DESC), '[]'::jsonb)
        FROM (SELECT * FROM public.partner_statement_events x WHERE x.branch_id = caller.out_branch AND x.month = first_day ORDER BY x.at DESC LIMIT 50) e));
  END IF;

  RETURN jsonb_build_object('applies', true, 'month', first_day, 'branch_id', caller.out_branch, 'statement_id', CASE WHEN closed THEN st.id END,
    'status', CASE WHEN closed THEN 'closed' ELSE 'open' END, 'month_over', first_day < this_month,
    'partner_id', owner_id, 'partner_name', COALESCE(owner_name, ''),
    'share_percent', rates.share, 'tax_percent', COALESCE(rates.tax, 0), 'rates_custom', COALESCE(rates.custom, false),
    'sales', t.sales, 'coupons', t.coupons, 'cost', t.cost, 'delivery', t.delivery, 'corrections', t.corrections,
    'sales_without_cost', t.sales_without_cost, 'lines_without_cost', t.lines_without_cost, 'orders', t.orders, 'income', t.income,
    'deductions_total', t.deductions, 'profit_before_tax', t.profit_before_tax, 'tax_amount', t.tax_amount, 'remaining', t.remaining, 'share_amount', t.share_amount,
    'paid', paid, 'due', CASE WHEN closed THEN t.share_amount - paid ELSE 0 END,
    'closed_at', CASE WHEN closed THEN st.closed_at END, 'closed_by_name', CASE WHEN closed THEN st.closed_by_name ELSE '' END,
    'deductions', deduction_rows, 'can_add', NOT closed, 'is_admin', caller.out_admin) || admin_extra;
END $function$;
REVOKE ALL ON FUNCTION public.partner_month_statement(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_month_statement(date, text) TO authenticated;

/** The partner (own godown, own months) or an admin adds a deduction to a month that is still open. */
CREATE OR REPLACE FUNCTION public.partner_add_month_deduction(_month date, _category text, _label text, _amount numeric,
  _branch_id text DEFAULT NULL, _request_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_month);
  caller record;
  label_text text := btrim(COALESCE(_label, ''));
  value numeric := round(_amount, 2);
  saved public.partner_month_deductions%ROWTYPE;
BEGIN
  IF first_day IS NULL OR first_day > private.ist_this_month() THEN RAISE EXCEPTION 'Choose a month that has started'; END IF;
  SELECT * INTO caller FROM private.net_month_access(first_day, _branch_id);
  IF NOT caller.out_allowed THEN RAISE EXCEPTION 'This month belongs to another partner'; END IF;
  IF _request_key IS NOT NULL THEN
    SELECT * INTO saved FROM public.partner_month_deductions d WHERE d.request_key = _request_key;
    IF FOUND THEN RETURN to_jsonb(saved) || jsonb_build_object('replayed', true); END IF;
  END IF;
  IF COALESCE(_category, '') NOT IN ('rent', 'staff', 'marketing', 'other') THEN RAISE EXCEPTION 'Choose what this deduction is for'; END IF;
  IF _category = 'other' AND length(label_text) < 2 THEN RAISE EXCEPTION 'Say what this deduction is for'; END IF;
  IF length(label_text) > 120 THEN RAISE EXCEPTION 'The description is too long'; END IF;
  IF value IS NULL OR value <= 0 OR value > 999999999 THEN RAISE EXCEPTION 'Enter the amount of this deduction'; END IF;
  -- The same lock closing takes, so a deduction cannot slip in while the month is being closed.
  PERFORM 1 FROM public.branches b WHERE b.id = caller.out_branch FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Godown not found'; END IF;
  IF NOT private.net_month_applies(caller.out_branch, first_day) THEN RAISE EXCEPTION 'This godown is on per-unit commission for this month'; END IF;
  IF EXISTS (SELECT 1 FROM public.partner_month_statements s WHERE s.branch_id = caller.out_branch AND s.month = first_day AND s.status = 'closed') THEN
    RAISE EXCEPTION 'This month is closed, so deductions can no longer be changed';
  END IF;
  INSERT INTO public.partner_month_deductions (branch_id, month, category, label, amount, added_by, added_by_name, added_by_role, request_key)
    VALUES (caller.out_branch, first_day, _category, label_text, value, auth.uid(), caller.out_who, CASE WHEN caller.out_admin THEN 'admin' ELSE 'partner' END, _request_key)
    RETURNING * INTO saved;
  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (caller.out_branch, first_day, 'deduction_added', auth.uid(), caller.out_who, saved.added_by_role,
      jsonb_build_object('category', saved.category, 'label', saved.label, 'amount', saved.amount));
  RETURN to_jsonb(saved) || jsonb_build_object('replayed', false);
END $function$;
REVOKE ALL ON FUNCTION public.partner_add_month_deduction(date, text, text, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_add_month_deduction(date, text, text, numeric, text, uuid) TO authenticated;

/** Removes a deduction from an open month. A partner removes only what they added; an admin removes any. The log keeps it. */
CREATE OR REPLACE FUNCTION public.partner_remove_month_deduction(_deduction_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  target public.partner_month_deductions%ROWTYPE;
  caller record;
BEGIN
  SELECT * INTO target FROM public.partner_month_deductions d WHERE d.id = _deduction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This deduction is already gone. Refresh the page.'; END IF;
  SELECT * INTO caller FROM private.net_month_access(target.month, target.branch_id);
  IF NOT caller.out_admin AND (NOT caller.out_allowed OR caller.out_branch <> target.branch_id OR target.added_by <> auth.uid()) THEN
    RAISE EXCEPTION 'You can only remove a deduction you added yourself';
  END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = target.branch_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.partner_month_statements s WHERE s.branch_id = target.branch_id AND s.month = target.month AND s.status = 'closed') THEN
    RAISE EXCEPTION 'This month is closed, so deductions can no longer be changed';
  END IF;
  DELETE FROM public.partner_month_deductions d WHERE d.id = target.id;
  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (target.branch_id, target.month, 'deduction_removed', auth.uid(), caller.out_who, CASE WHEN caller.out_admin THEN 'admin' ELSE 'partner' END,
      jsonb_build_object('category', target.category, 'label', target.label, 'amount', target.amount, 'added_by_name', target.added_by_name));
  RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.partner_remove_month_deduction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_remove_month_deduction(uuid) TO authenticated;

/** Admin: closes a finished month, oldest first. Its figures and lines are stored, and it becomes payable. */
CREATE OR REPLACE FUNCTION public.admin_close_partner_month(_branch_id text, _month date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_month);
  who text;
  st public.partner_month_statements%ROWTYPE;
  rates record;
  t record;
  owner_id uuid;
  earliest date;
  earlier date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can close a month'; END IF;
  IF first_day IS NULL OR first_day >= private.ist_this_month() THEN RAISE EXCEPTION 'This month is still running. It can be closed when the month is over.'; END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = _branch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Godown not found'; END IF;
  SELECT * INTO st FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = first_day;
  IF FOUND AND st.status = 'closed' THEN RAISE EXCEPTION 'This month is already closed'; END IF;
  IF NOT private.net_month_applies(_branch_id, first_day) THEN RAISE EXCEPTION 'This godown is on per-unit commission for this month'; END IF;

  -- Oldest first, because a later month picks up the corrections to the months before it.
  SELECT min(s.from_month) INTO earliest FROM public.godown_commission_schemes s WHERE s.branch_id = _branch_id AND s.scheme = 'net_profit';
  FOR earlier IN SELECT d::date FROM generate_series(earliest::timestamp, (first_day - interval '1 month')::timestamp, interval '1 month') d LOOP
    IF NOT EXISTS (SELECT 1 FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = earlier AND s.status = 'closed')
      AND (EXISTS (SELECT 1 FROM private.net_month_rows(_branch_id, earlier))
        OR EXISTS (SELECT 1 FROM public.partner_month_deductions d WHERE d.branch_id = _branch_id AND d.month = earlier)) THEN
      RAISE EXCEPTION 'Close % first', to_char(earlier, 'FMMonth YYYY');
    END IF;
  END LOOP;

  owner_id := private.net_month_partner(_branch_id, first_day);
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Nobody was running this godown on the last day of the month, so there is no partner to pay'; END IF;
  SELECT * INTO rates FROM private.net_month_rates(_branch_id, first_day);
  IF rates.share IS NULL THEN RAISE EXCEPTION 'Set the partner''s share first'; END IF;
  SELECT * INTO t FROM private.net_month_totals(_branch_id, first_day, rates.tax, rates.share);
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.partner_month_statements AS s (branch_id, month, partner_id, status, share_percent, tax_percent, rates_custom,
      sales, coupons, cost, delivery, corrections, sales_without_cost, lines_without_cost, orders, income, deductions, profit_before_tax,
      tax_amount, remaining, share_amount, closed_at, closed_by, closed_by_name)
    VALUES (_branch_id, first_day, owner_id, 'closed', rates.share, COALESCE(rates.tax, 0), COALESCE(rates.custom, false),
      t.sales, t.coupons, t.cost, t.delivery, t.corrections, t.sales_without_cost, t.lines_without_cost, t.orders, t.income, t.deductions, t.profit_before_tax,
      t.tax_amount, t.remaining, t.share_amount, now(), auth.uid(), COALESCE(who, ''))
    ON CONFLICT (branch_id, month) DO UPDATE SET partner_id = EXCLUDED.partner_id, status = 'closed', share_percent = EXCLUDED.share_percent, tax_percent = EXCLUDED.tax_percent,
      sales = EXCLUDED.sales, coupons = EXCLUDED.coupons, cost = EXCLUDED.cost, delivery = EXCLUDED.delivery, corrections = EXCLUDED.corrections,
      sales_without_cost = EXCLUDED.sales_without_cost, lines_without_cost = EXCLUDED.lines_without_cost, orders = EXCLUDED.orders, income = EXCLUDED.income,
      deductions = EXCLUDED.deductions, profit_before_tax = EXCLUDED.profit_before_tax, tax_amount = EXCLUDED.tax_amount, remaining = EXCLUDED.remaining,
      share_amount = EXCLUDED.share_amount, closed_at = EXCLUDED.closed_at, closed_by = EXCLUDED.closed_by, closed_by_name = EXCLUDED.closed_by_name
    RETURNING * INTO st;
  DELETE FROM public.partner_statement_lines l WHERE l.statement_id = st.id;
  INSERT INTO public.partner_statement_lines (statement_id, row_kind, order_item_id, order_id, order_no, product_name, qty, sales, coupon, cost, delivery, cost_known)
    SELECT st.id, r.row_kind, r.order_item_id, r.order_id, r.order_no, r.product_name, r.qty, r.sales, r.coupon, r.cost, r.delivery, r.cost_known
    FROM private.net_month_rows(_branch_id, first_day) r;

  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (_branch_id, first_day, 'closed', auth.uid(), COALESCE(who, ''), 'admin',
      jsonb_build_object('income', st.income, 'deductions', st.deductions, 'tax_amount', st.tax_amount, 'remaining', st.remaining, 'share_amount', st.share_amount,
        'share_percent', st.share_percent, 'tax_percent', st.tax_percent, 'partner_id', st.partner_id));
  RETURN jsonb_build_object('statement_id', st.id, 'share_amount', st.share_amount, 'remaining', st.remaining);
END $function$;
REVOKE ALL ON FUNCTION public.admin_close_partner_month(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_close_partner_month(text, date) TO authenticated;

/** Admin: reopens a closed month that has not been paid and has no later closed month after it. */
CREATE OR REPLACE FUNCTION public.admin_reopen_partner_month(_branch_id text, _month date, _reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  first_day date := private.month_first(_month);
  why text := btrim(COALESCE(_reason, ''));
  who text;
  st public.partner_month_statements%ROWTYPE;
  later date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can reopen a month'; END IF;
  IF length(why) < 4 OR length(why) > 300 THEN RAISE EXCEPTION 'Say why this month is being reopened'; END IF;
  PERFORM 1 FROM public.branches b WHERE b.id = _branch_id FOR NO KEY UPDATE;
  SELECT * INTO st FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month = first_day FOR UPDATE;
  IF NOT FOUND OR st.status <> 'closed' THEN RAISE EXCEPTION 'This month is not closed'; END IF;
  SELECT min(s.month) INTO later FROM public.partner_month_statements s WHERE s.branch_id = _branch_id AND s.month > first_day AND s.status = 'closed';
  IF later IS NOT NULL THEN RAISE EXCEPTION 'Reopen % first', to_char(later, 'FMMonth YYYY'); END IF;
  PERFORM 1 FROM public.channel_partners p WHERE p.id = st.partner_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.partner_payouts y WHERE y.statement_id = st.id AND y.status = 'paid') THEN
    RAISE EXCEPTION 'This month has been paid. Undo the payout first.';
  END IF;
  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who FROM public.profiles p WHERE p.id = auth.uid();
  DELETE FROM public.partner_statement_lines l WHERE l.statement_id = st.id;
  UPDATE public.partner_month_statements s SET status = 'open', partner_id = NULL, closed_at = NULL, closed_by = NULL, closed_by_name = '',
      share_percent = CASE WHEN s.rates_custom THEN s.share_percent END, tax_percent = CASE WHEN s.rates_custom THEN s.tax_percent END,
      sales = 0, coupons = 0, cost = 0, delivery = 0, corrections = 0, sales_without_cost = 0, lines_without_cost = 0, orders = 0, income = 0,
      deductions = 0, profit_before_tax = 0, tax_amount = 0, remaining = 0, share_amount = 0
    WHERE s.id = st.id;
  INSERT INTO public.partner_statement_events (branch_id, month, event, by_user, by_name, by_role, detail)
    VALUES (_branch_id, first_day, 'reopened', auth.uid(), COALESCE(who, ''), 'admin',
      jsonb_build_object('reason', why, 'share_amount', st.share_amount, 'remaining', st.remaining));
  RETURN true;
END $function$;
REVOKE ALL ON FUNCTION public.admin_reopen_partner_month(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reopen_partner_month(text, date, text) TO authenticated;

/** Admin: closed months with what was paid and what is still to pay, for the Partner Payouts page. */
CREATE OR REPLACE FUNCTION public.partner_statements_to_pay()
RETURNS TABLE (statement_id uuid, partner_id uuid, partner_name text, godown text, month date, share_amount numeric, paid numeric, due numeric, closed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can see this'; END IF;
  RETURN QUERY
  SELECT s.id, s.partner_id, p.name, COALESCE(b.name, s.branch_id), s.month, s.share_amount, z.paid, s.share_amount - z.paid, s.closed_at
  FROM public.partner_month_statements s
  JOIN public.channel_partners p ON p.id = s.partner_id
  LEFT JOIN public.branches b ON b.id = s.branch_id
  CROSS JOIN LATERAL (SELECT COALESCE(sum(y.amount), 0) AS paid FROM public.partner_payouts y WHERE y.statement_id = s.id AND y.status = 'paid') z
  WHERE s.status = 'closed'
  ORDER BY s.month DESC, COALESCE(b.name, s.branch_id);
END $function$;
REVOKE ALL ON FUNCTION public.partner_statements_to_pay() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_statements_to_pay() TO authenticated;

/**
 * Admin: records money sent against a closed month. Like a commission payout it gets a PO number, can be part of the
 * amount, and is undone or corrected with the same buttons.
 */
CREATE OR REPLACE FUNCTION public.admin_pay_partner_statement(_statement_id uuid, _paid_on date, _mode text, _reference text,
  _note text DEFAULT '', _amount numeric DEFAULT NULL, _request_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  st public.partner_month_statements%ROWTYPE;
  who text;
  ref text := upper(regexp_replace(btrim(COALESCE(_reference, '')), '\s+', '', 'g'));
  chosen_mode text := btrim(COALESCE(_mode, ''));
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  already numeric;
  most numeric;
  cash numeric;
  saved public.partner_payouts%ROWTYPE;
  other_no text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators can record a payout'; END IF;
  IF _request_key IS NOT NULL THEN
    SELECT * INTO saved FROM public.partner_payouts y WHERE y.request_key = _request_key;
    IF FOUND THEN RETURN jsonb_build_object('payout_no', saved.payout_no, 'id', saved.id, 'amount', saved.amount, 'replayed', true); END IF;
  END IF;
  IF chosen_mode NOT IN ('UPI', 'NEFT', 'RTGS', 'IMPS', 'Cash', 'Cheque') THEN RAISE EXCEPTION 'Choose how the money was paid'; END IF;
  IF _paid_on IS NULL OR _paid_on > today OR _paid_on < DATE '2026-01-01' THEN RAISE EXCEPTION 'Enter the date the money was paid (not in the future)'; END IF;
  IF length(COALESCE(_note, '')) > 300 OR length(ref) > 60 THEN RAISE EXCEPTION 'The reference or note is too long'; END IF;

  SELECT * INTO st FROM public.partner_month_statements s WHERE s.id = _statement_id;
  IF NOT FOUND OR st.status <> 'closed' THEN RAISE EXCEPTION 'This month is not closed'; END IF;
  -- The same lock as a commission payout: the second admin waits, then sees what is left.
  PERFORM 1 FROM public.channel_partners p WHERE p.id = st.partner_id FOR UPDATE;
  SELECT * INTO st FROM public.partner_month_statements s WHERE s.id = _statement_id;
  IF st.status <> 'closed' THEN RAISE EXCEPTION 'This month is not closed'; END IF;
  SELECT COALESCE(sum(y.amount), 0) INTO already FROM public.partner_payouts y WHERE y.statement_id = st.id AND y.status = 'paid';
  most := st.share_amount - already;
  IF most <= 0 THEN RAISE EXCEPTION 'Nothing is left to pay for this month'; END IF;
  cash := COALESCE(round(_amount, 2), most);
  IF cash <= 0 OR cash > most THEN RAISE EXCEPTION 'The most this payout can be is Rs %', to_char(most, 'FM99999990.00'); END IF;
  IF chosen_mode <> 'Cash' AND length(ref) < 4 THEN RAISE EXCEPTION 'Enter the UTR or reference of this payment'; END IF;
  IF ref <> '' AND chosen_mode <> 'Cash' THEN
    SELECT y.payout_no INTO other_no FROM public.partner_payouts y WHERE y.reference = ref AND y.status = 'paid' AND y.mode NOT IN ('Cash', 'Adjustment') LIMIT 1;
    IF other_no IS NOT NULL THEN RAISE EXCEPTION 'This reference was already recorded on payout %', other_no; END IF;
  END IF;

  SELECT left(COALESCE(NULLIF(btrim(p.full_name), ''), ''), 120) INTO who FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.partner_payouts (partner_id, branch_id, paid_on, amount, lines_total, recovered_total, mode, reference, note,
      period_from, period_to, request_key, created_by, created_by_name, statement_id)
    VALUES (st.partner_id, st.branch_id, _paid_on, cash, cash, 0, chosen_mode, ref, btrim(COALESCE(_note, '')),
      st.month, (st.month + interval '1 month' - interval '1 day')::date, _request_key, auth.uid(), COALESCE(who, ''), st.id)
    RETURNING * INTO saved;
  INSERT INTO public.partner_payout_events (payout_id, event, by_user, by_name, detail)
    VALUES (saved.id, 'created', auth.uid(), COALESCE(who, ''), jsonb_build_object('amount', cash, 'month', st.month));
  RETURN jsonb_build_object('payout_no', saved.payout_no, 'id', saved.id, 'amount', cash, 'replayed', false);
END $function$;
REVOKE ALL ON FUNCTION public.admin_pay_partner_statement(uuid, date, text, text, text, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_pay_partner_statement(uuid, date, text, text, text, numeric, uuid) TO authenticated;

-- ---------------------------------------------------------------- the existing settlement, with closed months in it

-- Changed 11 Nov 2026: net-profit lines are paid by the month, so they are not offered for settling line by line.
-- Everything else is as it was, from the live definition.
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
      AND c.kind <> 'net_profit'
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

-- Changed 11 Nov 2026: closed months count as earned and due, so earned - paid = due - owed back still holds with them in it.
-- Everything else is as it was, from the live definition.
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
  ), months AS (
    SELECT s.partner_id, COALESCE(sum(s.share_amount), 0) AS earned, COALESCE(sum(s.share_amount - z.paid), 0) AS due
    FROM public.partner_month_statements s
    CROSS JOIN LATERAL (SELECT COALESCE(sum(y.amount), 0) AS paid FROM public.partner_payouts y WHERE y.statement_id = s.id AND y.status = 'paid') z
    WHERE s.status = 'closed' GROUP BY s.partner_id
  )
  SELECT p.id, p.name, COALESCE(b.name, p.branch_id), p.status,
    COALESCE(t.earned, 0) + COALESCE(n.earned, 0), COALESCE(t.pending, 0), COALESCE(t.cancelled, 0), COALESCE(m.paid, 0),
    COALESCE(t.due, 0) + COALESCE(n.due, 0), COALESCE(t.owed_back, 0), COALESCE(m.payouts, 0), m.last_paid_on
  FROM public.channel_partners p
  LEFT JOIN public.branches b ON b.id = p.branch_id
  LEFT JOIN totals t ON t.partner_id = p.id
  LEFT JOIN money m ON m.partner_id = p.id
  LEFT JOIN months n ON n.partner_id = p.id
  WHERE is_admin OR p.id = me
  ORDER BY COALESCE(b.name, p.branch_id), p.status, p.name;
END;
$function$;

NOTIFY pgrst, 'reload schema';
