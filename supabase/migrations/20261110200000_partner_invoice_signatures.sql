-- Invoice signature per channel partner, and signed invoices in the partner app (client question, 10 Nov 2026:
-- "is there an area in admin to decide the signature of the respective channel partners ... shown to those
-- partners in their app, in the invoice sign"). The owner chose, on 10 Nov:
--   * The signature follows the person: admin uploads it on each channel partner (Admin > Channel Partners).
--     An invoice prints the signature of the partner who ran the order's godown when the order was placed, so
--     an old invoice keeps the old partner's signature after a change. When that partner has none, the godown's
--     own signature (Admin > Branches, from 8 Nov) is printed, else the blank signature line.
--   * Only admins upload or change it. The file goes in the private bucket godown-signatures, under
--     partners/<partner id>/; the bucket's write policies already allow admins only, and channel_partners'
--     admin policy is the only one that lets a row be updated.
--   * A channel partner opens, downloads and prints the customer copy of the invoices of the orders placed at
--     their godown while they ran it, and nothing else: a new partner does not see the earlier partner's
--     customers. The fields are listed one by one: no cost, vendor or commission.

ALTER TABLE public.channel_partners ADD COLUMN IF NOT EXISTS signature_path text;

/**
 * The active channel partner of a godown at a moment, from the partner change log (channel_partner_events):
 * their last added / reactivated / suspended event at or before it says whether they were active, and their
 * last added / reactivated / moved event says at which godown. Same rules as src/lib/partner-history.ts.
 * A partner with no log at all (none since the 1 Nov backfill) is judged by the record's own dates.
 */
CREATE OR REPLACE FUNCTION private.godown_partner_at(_branch_id text, _at timestamptz)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH logged AS (
    SELECT p.id, s.at AS since
    FROM public.channel_partners p
    CROSS JOIN LATERAL (
      SELECT e.event, e.at FROM public.channel_partner_events e
      WHERE e.partner_id = p.id AND e.at <= _at AND e.event IN ('added', 'reactivated', 'suspended')
      ORDER BY e.at DESC, CASE e.event WHEN 'added' THEN 0 WHEN 'reactivated' THEN 2 ELSE 3 END DESC
      LIMIT 1
    ) s
    CROSS JOIN LATERAL (
      SELECT e.branch_id FROM public.channel_partner_events e
      WHERE e.partner_id = p.id AND e.at <= _at AND e.event IN ('added', 'reactivated', 'moved')
      ORDER BY e.at DESC, CASE e.event WHEN 'added' THEN 0 WHEN 'moved' THEN 1 ELSE 2 END DESC
      LIMIT 1
    ) g
    WHERE s.event IN ('added', 'reactivated') AND g.branch_id = _branch_id
  ), unlogged AS (
    SELECT p.id, p.created_at AS since
    FROM public.channel_partners p
    WHERE p.branch_id = _branch_id AND p.created_at <= _at AND (p.status = 'active' OR _at < p.updated_at)
      AND NOT EXISTS (SELECT 1 FROM public.channel_partner_events e WHERE e.partner_id = p.id)
  )
  SELECT id FROM (SELECT * FROM logged UNION ALL SELECT * FROM unlogged) candidates
  ORDER BY since DESC, id
  LIMIT 1
$function$;
REVOKE ALL ON FUNCTION private.godown_partner_at(text, timestamptz) FROM PUBLIC, anon, authenticated;

/**
 * The channel partner who signs an order's invoice: the one who ran its godown when it was placed. The commission
 * lines are the exact record of that (written at the moment of the order), so they decide when there are any;
 * the change log decides for orders without a commission rate. NULL when the godown had no partner then.
 */
CREATE OR REPLACE FUNCTION private.order_signing_partner(_order_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o record;
  by_time uuid;
  by_line uuid;
BEGIN
  SELECT id, branch_id, created_at INTO o FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.branch_id IS NOT NULL THEN by_time := private.godown_partner_at(o.branch_id, o.created_at); END IF;
  IF by_time IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_commissions c WHERE c.order_id = o.id AND c.partner_id = by_time) THEN
    RETURN by_time;
  END IF;
  -- A line added by an admin after a handover carries the later partner: the partner of most lines signs.
  SELECT c.partner_id INTO by_line FROM public.partner_commissions c WHERE c.order_id = o.id
    GROUP BY c.partner_id ORDER BY count(*) DESC, min(c.placed_at), c.partner_id LIMIT 1;
  RETURN COALESCE(by_line, by_time);
END $function$;
REVOKE ALL ON FUNCTION private.order_signing_partner(uuid) FROM PUBLIC, anon, authenticated;

/**
 * The stored path of the partner signature printed on an order's invoice, or NULL (no partner then, or they have
 * no signature: the invoice then prints the godown's own signature, else the blank line). Only for those who may
 * open that invoice: an admin, the order's customer, a vendor on it, or the channel partner who signs it.
 */
CREATE OR REPLACE FUNCTION public.invoice_partner_signature(_order_no text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  o record;
  signer uuid;
  me uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  SELECT id, user_id, vendor_ids INTO o FROM public.orders WHERE order_no = _order_no;
  IF NOT FOUND THEN RETURN NULL; END IF;
  signer := private.order_signing_partner(o.id);
  IF signer IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  IF NOT (o.user_id IS NOT DISTINCT FROM auth.uid()
      OR public.has_role(auth.uid(), 'admin')
      OR (public.has_role(auth.uid(), 'vendor') AND public.current_vendor_id() = ANY (o.vendor_ids))
      OR (me IS NOT NULL AND me = signer)) THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT NULLIF(signature_path, '') FROM public.channel_partners WHERE id = signer);
END $function$;
REVOKE ALL ON FUNCTION public.invoice_partner_signature(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_partner_signature(text) TO authenticated;

/** The caller's channel partner record when it is active; refuses everyone else. */
CREATE OR REPLACE FUNCTION private.active_partner_or_refuse()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE me uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO me FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active';
  END IF;
  IF me IS NULL THEN RAISE EXCEPTION 'Only an active channel partner can open these invoices'; END IF;
  RETURN me;
END $function$;
REVOKE ALL ON FUNCTION private.active_partner_or_refuse() FROM PUBLIC, anon, authenticated;

/**
 * A channel partner's customer invoices for a period (IST dates, at most 400 days): the orders of their godown
 * placed while they ran it. Unpaid checkout requests are not orders and are left out.
 */
CREATE OR REPLACE FUNCTION public.partner_invoice_orders(_from date, _to date)
RETURNS TABLE (order_no text, placed_at timestamptz, order_status text, payment_status text, customer_name text,
  total numeric, gst_amount numeric, invoice_number text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := private.active_partner_or_refuse();
BEGIN
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN RAISE EXCEPTION 'The end date is before the start date'; END IF;
  IF _to - _from > 400 THEN RAISE EXCEPTION 'Choose a period of about a year or less'; END IF;
  RETURN QUERY
  SELECT o.order_no, o.created_at, o.order_status, o.payment_status, o.customer_name, o.total, o.gst_amount,
    (SELECT z.invoice_number FROM public.zoho_order_invoices z WHERE z.order_id = o.id LIMIT 1)
  FROM public.orders o
  WHERE o.branch_id IN (SELECT e.branch_id FROM public.channel_partner_events e WHERE e.partner_id = me
                        UNION SELECT p.branch_id FROM public.channel_partners p WHERE p.id = me)
    AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN _from AND _to
    AND o.order_status NOT IN ('Awaiting Payment', 'Payment Expired')
    AND private.order_signing_partner(o.id) = me
  ORDER BY o.created_at DESC
  LIMIT 1000;
END $function$;
REVOKE ALL ON FUNCTION public.partner_invoice_orders(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_invoice_orders(date, date) TO authenticated;

/**
 * One of those invoices, to print the customer copy: the order as the customer sees it, its lines, Zoho's invoice
 * number and date, and the payments (mode, UTR). Refused for any order the caller does not sign.
 */
CREATE OR REPLACE FUNCTION public.partner_invoice_order(_order_no text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := private.active_partner_or_refuse();
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE order_no = _order_no;
  IF NOT FOUND OR o.order_status IN ('Awaiting Payment', 'Payment Expired') OR private.order_signing_partner(o.id) IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'This invoice is not one of your godown''s orders';
  END IF;
  RETURN jsonb_build_object(
    'order', jsonb_build_object(
      'order_no', o.order_no, 'created_at', o.created_at, 'order_status', o.order_status, 'payment_status', o.payment_status,
      'payment_method', o.payment_method, 'customer_name', o.customer_name, 'customer_email', o.customer_email,
      'customer_phone', o.customer_phone, 'customer_gstin', o.customer_gstin, 'business_legal_name', o.business_legal_name,
      'is_b2b', o.is_b2b, 'shipping_address', o.shipping_address, 'shipping_method', o.shipping_method, 'branch_id', o.branch_id,
      'coupon', o.coupon, 'subtotal', o.subtotal, 'discount', o.discount, 'gst_amount', o.gst_amount, 'shipping', o.shipping,
      'total', o.total, 'paid_amount', o.paid_amount, 'prices_include_gst', o.prices_include_gst),
    -- HSN, unit and pack come from the catalogue, as on the customer's own copy: those three fields only, never the
    -- product's purchase price or anything else in its record.
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'product_id', i.product_id, 'product_name', i.product_name, 'sku', i.sku, 'qty', i.qty,
        'unit_price', i.unit_price, 'gst_rate', i.gst_rate, 'capacity', i.capacity, 'coupon_share', i.coupon_share,
        'hsn', cp.payload->>'hsn', 'unit', cp.payload->>'unit', 'weight', cp.payload->>'weight') ORDER BY i.id)
      FROM public.order_items i LEFT JOIN public.catalog_products cp ON cp.id = i.product_id
      WHERE i.order_id = o.id), '[]'::jsonb),
    'zoho', (SELECT jsonb_build_object('invoice_number', z.invoice_number, 'status', z.status, 'invoice_date', z.invoice_date)
      FROM public.zoho_order_invoices z WHERE z.order_id = o.id LIMIT 1),
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('amount', p.amount, 'method', p.method, 'status', p.status, 'txn_ref', p.txn_ref,
        'created_at', p.created_at) ORDER BY p.created_at DESC)
      FROM public.payments p WHERE p.order_id = o.id), '[]'::jsonb)
  );
END $function$;
REVOKE ALL ON FUNCTION public.partner_invoice_order(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_invoice_order(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
