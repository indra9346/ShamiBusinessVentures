-- Order alerts for channel partners and godown staff (owner, 19 Nov 2026: "order notification sound enable for channel
-- partner login and staff portal login"). They cannot read the orders table (RLS: admins, vendors and the customer
-- only), so live database changes never reach them; their panels ask this function every 20 seconds instead. It
-- returns only the orders of the caller's own godown(s): an active channel partner's, or an active employee's.
-- Read-only; no table changes.

CREATE OR REPLACE FUNCTION public.my_godown_order_alerts(_since timestamptz, _with_averages boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  godowns text[];
  since timestamptz := GREATEST(COALESCE(_since, now() - interval '12 hours'), now() - interval '12 hours');
  result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT array_agg(DISTINCT branch_id) INTO godowns FROM (
    SELECT branch_id FROM public.channel_partners WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL
    UNION
    SELECT branch_id FROM public.staff_employees WHERE user_id = auth.uid() AND status = 'active' AND branch_id IS NOT NULL
  ) mine;
  IF godowns IS NULL THEN
    RETURN jsonb_build_object('now', now(), 'godowns', '[]'::jsonb, 'orders', '[]'::jsonb, 'averages', '[]'::jsonb, 'voice', NULL);
  END IF;

  SELECT jsonb_build_object(
    'now', now(),
    'godowns', to_jsonb(godowns),
    'orders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'order_no', o.order_no, 'order_status', o.order_status, 'total', o.total, 'branch_id', o.branch_id,
        'created_at', o.created_at, 'customer_name', o.customer_name,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'product_name', i.product_name, 'qty', i.qty))
                           FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb)
      ) ORDER BY o.created_at)
      FROM (SELECT * FROM public.orders
             WHERE branch_id = ANY (godowns) AND GREATEST(created_at, COALESCE(updated_at, created_at)) >= since
             ORDER BY created_at DESC LIMIT 50) o
    ), '[]'::jsonb),
    -- Units of real orders per item over the last 30 days at these godowns (for "unusual order").
    'averages', CASE WHEN _with_averages THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('product_id', s.product_id, 'product_name', s.product_name, 'units', s.units))
      FROM (SELECT COALESCE(i.product_id, i.product_name) AS product_id, max(i.product_name) AS product_name, sum(i.qty) AS units
              FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
             WHERE o.branch_id = ANY (godowns) AND o.created_at >= now() - interval '30 days'
               AND o.order_status NOT IN ('Awaiting Payment', 'Payment Expired', 'Cancelled')
             GROUP BY 1) s
    ), '[]'::jsonb) ELSE '[]'::jsonb END,
    -- The office's wording (Admin › Settings › Order alerts); the settings row is admin-only to read.
    'voice', (SELECT value FROM public.settings WHERE key = 'order_voice_alerts')
  ) INTO result;
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.my_godown_order_alerts(timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_godown_order_alerts(timestamptz, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
