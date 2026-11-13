-- Owner's message, 12-13 Nov 2026.
--
-- 1. Stock requirement (indent) from channel partners. A godown's active channel partner asks head office for stock:
--    one or more lines (product, quantity in bags or units, grade, remarks) and a note. Head office sees every request
--    in Admin > Order book from channel partners and moves it New -> Seen -> Arranged (or Cancelled). The partner sees
--    the status and may cancel their own request while it is still New. It is a request only: nothing here touches
--    stock, orders, payments or Zoho. Every change is kept in stock_indent_events.
--
-- 2. Who already signs in with an email (login_email_owner). Supabase's admin "update user" does not check whether the
--    new email belongs to another login; the database refuses it and the admin only sees "Error updating user". The
--    server asks this first (service role only), so the admin is told which kind of account already uses the email.

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Stock requirements
-- ---------------------------------------------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.stock_indent_seq;
REVOKE ALL ON SEQUENCE public.stock_indent_seq FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.stock_indents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indent_no text NOT NULL UNIQUE,
  branch_id text NOT NULL REFERENCES public.branches(id),
  partner_id uuid REFERENCES public.channel_partners(id) ON DELETE SET NULL,
  partner_name text NOT NULL DEFAULT '',
  needed_by date,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'arranged', 'cancelled')),
  status_note text NOT NULL DEFAULT '' CHECK (char_length(status_note) <= 500),
  status_changed_at timestamptz,
  status_changed_by uuid,
  status_changed_by_name text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_indents_branch_created ON public.stock_indents (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_indents_status ON public.stock_indents (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.stock_indent_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indent_id uuid NOT NULL REFERENCES public.stock_indents(id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no BETWEEN 1 AND 30),
  product_id text,
  product_name text NOT NULL CHECK (char_length(btrim(product_name)) BETWEEN 1 AND 120),
  quantity numeric(12,2) NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  unit text NOT NULL CHECK (unit IN ('bags', 'units')),
  grade text NOT NULL DEFAULT '' CHECK (char_length(grade) <= 60),
  remarks text NOT NULL DEFAULT '' CHECK (char_length(remarks) <= 300),
  UNIQUE (indent_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.stock_indent_events (
  id bigserial PRIMARY KEY,
  indent_id uuid NOT NULL REFERENCES public.stock_indents(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('raised', 'new', 'seen', 'arranged', 'cancelled')),
  note text NOT NULL DEFAULT '',
  by_user uuid,
  by_name text NOT NULL DEFAULT '',
  by_role text NOT NULL DEFAULT '' CHECK (by_role IN ('', 'partner', 'admin')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_indent_events_indent ON public.stock_indent_events (indent_id, at);

-- Reading: an admin sees every request; a channel partner sees the requests of the godown they run now. Nobody writes to
-- these tables directly: the functions below do, after their checks.
ALTER TABLE public.stock_indents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_indent_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_indent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_indents, public.stock_indent_lines, public.stock_indent_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.stock_indent_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_indents, public.stock_indent_lines, public.stock_indent_events TO authenticated;
GRANT ALL ON public.stock_indents, public.stock_indent_lines, public.stock_indent_events TO service_role;

-- public.current_partner_branch() (20261031120000, unchanged here): the godown the signed-in user runs as its active
-- channel partner, null for anyone else.

DROP POLICY IF EXISTS stock_indents_read ON public.stock_indents;
CREATE POLICY stock_indents_read ON public.stock_indents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR branch_id = public.current_partner_branch());
DROP POLICY IF EXISTS stock_indent_lines_read ON public.stock_indent_lines;
CREATE POLICY stock_indent_lines_read ON public.stock_indent_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stock_indents i WHERE i.id = indent_id
    AND (public.has_role(auth.uid(), 'admin') OR i.branch_id = public.current_partner_branch())));
DROP POLICY IF EXISTS stock_indent_events_read ON public.stock_indent_events;
CREATE POLICY stock_indent_events_read ON public.stock_indent_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.stock_indents i WHERE i.id = indent_id
    AND (public.has_role(auth.uid(), 'admin') OR i.branch_id = public.current_partner_branch())));

/**
 * A channel partner raises a stock requirement for their godown. _lines is a JSON array of
 * {product_id?, product_name, quantity, unit ('bags'|'units'), grade?, remarks?}, 1 to 30 lines.
 * Returns the request number. Only an active channel partner may call it; it never touches stock or Zoho.
 */
CREATE OR REPLACE FUNCTION public.partner_raise_stock_indent(_lines jsonb, _notes text DEFAULT '', _needed_by date DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  me public.channel_partners%ROWTYPE;
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  line jsonb;
  n integer := 0;
  qty numeric;
  unit_value text;
  name_value text;
  product text;
  new_id uuid;
  new_no text;
  godown_name text;
  clean_notes text := btrim(COALESCE(_notes, ''));
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can send a stock requirement'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one product';
  END IF;
  IF jsonb_array_length(_lines) > 30 THEN RAISE EXCEPTION 'At most 30 products in one requirement'; END IF;
  IF char_length(clean_notes) > 1000 THEN RAISE EXCEPTION 'Keep the notes under 1,000 characters'; END IF;
  IF _needed_by IS NOT NULL AND (_needed_by < today OR _needed_by > today + 366) THEN
    RAISE EXCEPTION 'Choose a "needed by" date from today to a year from now';
  END IF;

  new_no := 'IND-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYMMDD') || '-' || lpad(nextval('public.stock_indent_seq')::text, 4, '0');
  INSERT INTO public.stock_indents (indent_no, branch_id, partner_id, partner_name, needed_by, notes, created_by)
  VALUES (new_no, me.branch_id, me.id, me.name, _needed_by, clean_notes, auth.uid())
  RETURNING id INTO new_id;

  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    n := n + 1;
    IF jsonb_typeof(line) <> 'object' THEN RAISE EXCEPTION 'Line %: not a product line', n; END IF;
    name_value := btrim(COALESCE(line->>'product_name', ''));
    IF name_value = '' THEN RAISE EXCEPTION 'Line %: choose or type the product', n; END IF;
    IF char_length(name_value) > 120 THEN RAISE EXCEPTION 'Line %: the product name is too long', n; END IF;
    BEGIN
      qty := round((line->>'quantity')::numeric, 2);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Line %: enter the quantity as a number', n;
    END;
    IF qty IS NULL OR qty <= 0 THEN RAISE EXCEPTION 'Line %: the quantity must be more than 0', n; END IF;
    IF qty > 100000 THEN RAISE EXCEPTION 'Line %: the quantity is too large', n; END IF;
    unit_value := COALESCE(line->>'unit', '');
    IF unit_value NOT IN ('bags', 'units') THEN RAISE EXCEPTION 'Line %: choose bags or units', n; END IF;
    IF char_length(COALESCE(line->>'grade', '')) > 60 THEN RAISE EXCEPTION 'Line %: the grade is too long', n; END IF;
    IF char_length(COALESCE(line->>'remarks', '')) > 300 THEN RAISE EXCEPTION 'Line %: keep the remarks under 300 characters', n; END IF;
    product := NULLIF(btrim(COALESCE(line->>'product_id', '')), '');
    -- A product id must be one of ours; free-typed names (a product not on the website yet) stay without one.
    IF product IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.catalog_products c WHERE c.id = product) THEN product := NULL; END IF;
    INSERT INTO public.stock_indent_lines (indent_id, line_no, product_id, product_name, quantity, unit, grade, remarks)
    VALUES (new_id, n, product, name_value, qty, unit_value, btrim(COALESCE(line->>'grade', '')), btrim(COALESCE(line->>'remarks', '')));
  END LOOP;

  INSERT INTO public.stock_indent_events (indent_id, event, note, by_user, by_name, by_role)
  VALUES (new_id, 'raised', '', auth.uid(), me.name, 'partner');

  SELECT name INTO godown_name FROM public.branches WHERE id = me.branch_id;
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT NULL, NULL, ur.user_id, 'admin', 'Stock requirement from a channel partner',
    format('%s (%s) asked for stock: %s product%s, request %s.%s See Admin > Order book from channel partners.',
      me.name, COALESCE(godown_name, me.branch_id), n, CASE WHEN n = 1 THEN '' ELSE 's' END, new_no,
      CASE WHEN _needed_by IS NULL THEN '' ELSE ' Needed by ' || to_char(_needed_by, 'DD Mon YYYY') || '.' END),
    'info'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN new_no;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_raise_stock_indent(jsonb, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_raise_stock_indent(jsonb, text, date) TO authenticated;

/** The partner cancels their godown's request while it is still New (head office has not looked at it). */
CREATE OR REPLACE FUNCTION public.partner_cancel_stock_indent(_indent_no text, _reason text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  me public.channel_partners%ROWTYPE;
  ind public.stock_indents%ROWTYPE;
  why text := btrim(COALESCE(_reason, ''));
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT * INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  END IF;
  IF me.id IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can cancel a stock requirement'; END IF;
  SELECT * INTO ind FROM public.stock_indents WHERE indent_no = _indent_no FOR UPDATE;
  IF ind.id IS NULL OR ind.branch_id <> me.branch_id THEN RAISE EXCEPTION 'Stock requirement not found'; END IF;
  IF ind.status <> 'new' THEN
    RAISE EXCEPTION 'Head office has already seen this requirement (%), so it can no longer be cancelled here. Call head office.',
      CASE ind.status WHEN 'seen' THEN 'Seen' WHEN 'arranged' THEN 'Arranged' ELSE 'Cancelled' END;
  END IF;
  IF char_length(why) > 500 THEN RAISE EXCEPTION 'Keep the reason under 500 characters'; END IF;
  UPDATE public.stock_indents SET status = 'cancelled', status_note = why, status_changed_at = now(), status_changed_by = auth.uid(),
    status_changed_by_name = me.name, updated_at = now()
  WHERE id = ind.id;
  INSERT INTO public.stock_indent_events (indent_id, event, note, by_user, by_name, by_role)
  VALUES (ind.id, 'cancelled', why, auth.uid(), me.name, 'partner');
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT NULL, NULL, ur.user_id, 'admin', 'Stock requirement cancelled',
    format('%s cancelled stock requirement %s.%s', me.name, ind.indent_no, COALESCE(' Reason: ' || NULLIF(why, ''), '')), 'info'
  FROM public.user_roles ur WHERE ur.role = 'admin';
END;
$$;
REVOKE ALL ON FUNCTION public.partner_cancel_stock_indent(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_cancel_stock_indent(text, text) TO authenticated;

/** Head office sets a request's status (New, Seen, Arranged or Cancelled), with an optional note the partner sees. */
CREATE OR REPLACE FUNCTION public.admin_set_stock_indent_status(_indent_no text, _status text, _note text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  ind public.stock_indents%ROWTYPE;
  who text;
  why text := btrim(COALESCE(_note, ''));
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  IF _status IS NULL OR _status NOT IN ('new', 'seen', 'arranged', 'cancelled') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  IF char_length(why) > 500 THEN RAISE EXCEPTION 'Keep the note under 500 characters'; END IF;
  SELECT * INTO ind FROM public.stock_indents WHERE indent_no = _indent_no FOR UPDATE;
  IF ind.id IS NULL THEN RAISE EXCEPTION 'Stock requirement not found'; END IF;
  IF ind.status = _status AND why = ind.status_note THEN RETURN; END IF;
  SELECT COALESCE(NULLIF(full_name, ''), 'Head office') INTO who FROM public.profiles WHERE id = auth.uid();
  who := COALESCE(who, 'Head office');
  UPDATE public.stock_indents SET status = _status, status_note = why, status_changed_at = now(), status_changed_by = auth.uid(),
    status_changed_by_name = who, updated_at = now()
  WHERE id = ind.id;
  INSERT INTO public.stock_indent_events (indent_id, event, note, by_user, by_name, by_role)
  VALUES (ind.id, _status, why, auth.uid(), who, 'admin');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_stock_indent_status(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_stock_indent_status(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Which account already signs in with an email (server only)
-- ---------------------------------------------------------------------------------------------------------------

/**
 * The account that signs in with this email, or null: its id, a name to show the admin, and what kind of account it
 * is (channel_partner, admin, staff, vendor or customer). The service role only: it reads auth.users.
 */
CREATE OR REPLACE FUNCTION public.login_email_owner(_email text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'user_id', u.id,
    'name', COALESCE(NULLIF(cp.name, ''), NULLIF(p.full_name, ''), NULLIF(u.raw_user_meta_data->>'full_name', ''), ''),
    'kind', CASE
      WHEN cp.id IS NOT NULL THEN 'channel_partner'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id AND r.role = 'admin') THEN 'admin'
      WHEN EXISTS (SELECT 1 FROM public.staff_employees s WHERE s.user_id = u.id) THEN 'staff'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id AND r.role = 'vendor') THEN 'vendor'
      ELSE 'customer' END,
    'partner_status', cp.status)
  FROM auth.users u
  LEFT JOIN public.channel_partners cp ON cp.user_id = u.id
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE lower(u.email) = lower(btrim(_email)) AND btrim(COALESCE(_email, '')) <> ''
  ORDER BY u.created_at
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.login_email_owner(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_email_owner(text) TO service_role;

COMMIT;
