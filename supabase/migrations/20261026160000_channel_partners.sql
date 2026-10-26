-- Channel partners (godown distributors). Each godown has at most one active channel partner, who
-- earns a commission on the godown's orders and sees it live in the partner panel (/partner):
--   * The admin sets the godown's commission rates: a default for every product, and per-product
--     overrides, each either a fixed rupee amount per unit (e.g. Rs 2.50 per rice bag) or a
--     percentage of the line's selling price (excluding GST).
--   * Every order line placed at the godown records the rate in force at that moment
--     (partner_commissions). Later rate changes never alter past commissions.
--   * A commission is Pending while its order is open, Earned once the order is Delivered and
--     fully Paid, and Cancelled with the order. Line edits keep the recorded rate.
--   * The admin sets a monthly sales target; every partner sees the monthly leaderboard.
-- Partners are a separate kind of account (table channel_partners), not customers or vendors.

CREATE TABLE IF NOT EXISTS public.channel_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_partners_one_active_per_godown
  ON public.channel_partners (branch_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.partner_commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id text NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  -- NULL = the godown's default rate for every product without its own rate.
  product_id text REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('per_unit', 'percent')),
  value numeric(12,2) NOT NULL CHECK (value >= 0 AND (kind <> 'percent' OR value <= 100)),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_commission_rules_one_per_product
  ON public.partner_commission_rules (branch_id, COALESCE(product_id, ''));

CREATE TABLE IF NOT EXISTS public.partner_targets (
  partner_id uuid NOT NULL REFERENCES public.channel_partners(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  target_sales numeric(14,2) NOT NULL CHECK (target_sales >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, month)
);

CREATE TABLE IF NOT EXISTS public.partner_commissions (
  order_item_id uuid PRIMARY KEY REFERENCES public.order_items(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  partner_id uuid NOT NULL REFERENCES public.channel_partners(id),
  branch_id text NOT NULL,
  product_id text,
  product_name text NOT NULL DEFAULT '',
  qty integer NOT NULL,
  line_total numeric(14,2) NOT NULL,
  kind text NOT NULL,
  rate numeric(12,2) NOT NULL,
  amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'earned', 'cancelled')),
  placed_at timestamptz NOT NULL DEFAULT now(),
  earned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_commissions_partner_idx ON public.partner_commissions (partner_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS partner_commissions_order_idx ON public.partner_commissions (order_id);

/** The commission on one line: a fixed amount per unit, or a percentage of the line (excl. GST). */
CREATE OR REPLACE FUNCTION public.partner_commission_amount(_kind text, _rate numeric, _qty integer, _line_total numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT round(CASE WHEN _kind = 'percent' THEN COALESCE(_line_total, 0) * _rate / 100 ELSE _rate * COALESCE(_qty, 0) END, 2)
$$;

/** The caller's channel partner record (active or not), or NULL. */
CREATE OR REPLACE FUNCTION public.current_partner_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT id FROM public.channel_partners WHERE user_id = auth.uid()
$$;

/** Commission status for an order: Cancelled -> cancelled, Delivered and fully Paid -> earned. */
CREATE OR REPLACE FUNCTION public.partner_commission_status(_order_status text, _payment_status text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN _order_status = 'Cancelled' THEN 'cancelled'
              WHEN _order_status = 'Delivered' AND _payment_status = 'Paid' THEN 'earned'
              ELSE 'pending' END
$$;

/** Records the commission of a new order line at the godown's active partner, at today's rate. */
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
  SELECT * INTO rule FROM public.partner_commission_rules
    WHERE branch_id = o.branch_id AND (product_id = NEW.product_id OR product_id IS NULL)
    ORDER BY product_id IS NULL LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;
  st := public.partner_commission_status(o.order_status, o.payment_status);
  INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id,
    product_name, qty, line_total, kind, rate, amount, status, placed_at, earned_at)
  VALUES (NEW.id, o.id, o.order_no, partner, o.branch_id, NEW.product_id, COALESCE(NEW.product_name, ''),
    NEW.qty, NEW.line_total, rule.kind, rule.value,
    public.partner_commission_amount(rule.kind, rule.value, NEW.qty, NEW.line_total), st, o.created_at,
    CASE WHEN st = 'earned' THEN now() END)
  ON CONFLICT (order_item_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

/** A line edited later (quantity / price) keeps its recorded rate; the amount follows the line. */
CREATE OR REPLACE FUNCTION public.update_partner_commission_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  UPDATE public.partner_commissions SET qty = NEW.qty, line_total = NEW.line_total,
    product_id = NEW.product_id, product_name = COALESCE(NEW.product_name, product_name),
    amount = public.partner_commission_amount(kind, rate, NEW.qty, NEW.line_total), updated_at = now()
  WHERE order_item_id = NEW.id;
  RETURN NEW;
END;
$function$;

/** The order's status decides each line's commission status (and its number, if renumbered). */
CREATE OR REPLACE FUNCTION public.update_partner_commission_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE st text := public.partner_commission_status(NEW.order_status, NEW.payment_status);
BEGIN
  UPDATE public.partner_commissions SET status = st, order_no = NEW.order_no,
    earned_at = CASE WHEN st = 'earned' THEN COALESCE(earned_at, now()) ELSE NULL END, updated_at = now()
  WHERE order_id = NEW.id AND (status IS DISTINCT FROM st OR order_no IS DISTINCT FROM NEW.order_no);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS order_items_partner_commission ON public.order_items;
CREATE TRIGGER order_items_partner_commission AFTER INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.record_partner_commission();
DROP TRIGGER IF EXISTS order_items_partner_commission_update ON public.order_items;
CREATE TRIGGER order_items_partner_commission_update AFTER UPDATE OF qty, line_total, product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.update_partner_commission_line();
DROP TRIGGER IF EXISTS orders_partner_commission_status ON public.orders;
CREATE TRIGGER orders_partner_commission_status AFTER UPDATE OF order_status, payment_status, order_no ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_partner_commission_status();

-- Access: admins manage everything; a partner reads only their own record, rates and commissions.
ALTER TABLE public.channel_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_commissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_partners_admin ON public.channel_partners;
CREATE POLICY channel_partners_admin ON public.channel_partners FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS channel_partners_self ON public.channel_partners;
CREATE POLICY channel_partners_self ON public.channel_partners FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS partner_rules_admin ON public.partner_commission_rules;
CREATE POLICY partner_rules_admin ON public.partner_commission_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS partner_rules_own_godown ON public.partner_commission_rules;
CREATE POLICY partner_rules_own_godown ON public.partner_commission_rules FOR SELECT TO authenticated
  USING (branch_id = (SELECT branch_id FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active'));

DROP POLICY IF EXISTS partner_targets_admin ON public.partner_targets;
CREATE POLICY partner_targets_admin ON public.partner_targets FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS partner_targets_self ON public.partner_targets;
CREATE POLICY partner_targets_self ON public.partner_targets FOR SELECT TO authenticated
  USING (partner_id = public.current_partner_id());

DROP POLICY IF EXISTS partner_commissions_admin ON public.partner_commissions;
CREATE POLICY partner_commissions_admin ON public.partner_commissions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS partner_commissions_self ON public.partner_commissions;
CREATE POLICY partner_commissions_self ON public.partner_commissions FOR SELECT TO authenticated
  USING (partner_id = public.current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_partners, public.partner_commission_rules, public.partner_targets TO authenticated;
GRANT SELECT ON public.partner_commissions TO authenticated;

/**
 * The monthly leaderboard every active partner (and admin) sees: sales of non-cancelled lines,
 * commission (earned + pending), target and % of target, ranked by % of target, then sales.
 * Names and godowns only; no customer details.
 */
CREATE OR REPLACE FUNCTION public.partner_leaderboard(_month date DEFAULT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date)
RETURNS TABLE (rank integer, partner_id uuid, partner_name text, godown text, sales numeric, commission numeric,
  earned numeric, target numeric, achieved_percent numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'admin') OR EXISTS (
    SELECT 1 FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active')) THEN
    RAISE EXCEPTION 'Only channel partners and administrators can view the leaderboard';
  END IF;
  RETURN QUERY
  WITH m AS (SELECT date_trunc('month', _month)::date AS start),
  totals AS (
    SELECT p.id, p.name, b.name AS godown,
      COALESCE(sum(c.line_total) FILTER (WHERE c.status <> 'cancelled'), 0) AS sales,
      COALESCE(sum(c.amount) FILTER (WHERE c.status <> 'cancelled'), 0) AS commission,
      COALESCE(sum(c.amount) FILTER (WHERE c.status = 'earned'), 0) AS earned,
      COALESCE((SELECT t.target_sales FROM public.partner_targets t WHERE t.partner_id = p.id AND t.month = (SELECT start FROM m)), 0) AS target
    FROM public.channel_partners p
    JOIN public.branches b ON b.id = p.branch_id
    LEFT JOIN public.partner_commissions c ON c.partner_id = p.id
      AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date >= (SELECT start FROM m)
      AND (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date < ((SELECT start FROM m) + interval '1 month')::date
    WHERE p.status = 'active'
    GROUP BY p.id, p.name, b.name
  )
  SELECT (row_number() OVER (ORDER BY CASE WHEN t.target > 0 THEN t.sales / t.target ELSE 0 END DESC, t.sales DESC, t.name))::integer,
    t.id, t.name, t.godown, t.sales, t.commission, t.earned, t.target,
    CASE WHEN t.target > 0 THEN round(t.sales * 100 / t.target, 1) ELSE NULL END
  FROM totals t
  ORDER BY 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.partner_leaderboard(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_leaderboard(date) TO authenticated;

/** A partner's commission lines with their order's live status, customer and PIN (own lines only). */
CREATE OR REPLACE FUNCTION public.partner_commission_lines(_month date)
RETURNS TABLE (order_item_id uuid, order_no text, placed_at timestamptz, order_status text, payment_status text,
  customer_name text, pin text, product_name text, qty integer, line_total numeric, kind text, rate numeric,
  amount numeric, status text, partner_id uuid)
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
    COALESCE(o.shipping_address->>'pin', ''), c.product_name, c.qty, c.line_total, c.kind, c.rate, c.amount, c.status, c.partner_id
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

NOTIFY pgrst, 'reload schema';
