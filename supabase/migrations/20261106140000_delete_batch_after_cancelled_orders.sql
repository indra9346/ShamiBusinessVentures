-- Owner's decision, 6 Nov 2026: a batch whose only orders were cancelled or expired, with nothing paid and every unit
-- given back, can be deleted (for example the test batch TEST-CLK-311026). Its released allocation rows go with it;
-- stock does not change and nothing in Zoho is touched. Every other rule of 20261105190000 is unchanged, and each
-- delete is now recorded in deleted_batches_log.

CREATE TABLE IF NOT EXISTS public.deleted_batches_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_code text NOT NULL,
  product_id text,
  product_name text NOT NULL DEFAULT '',
  quantity numeric(14,2) NOT NULL DEFAULT 0,
  released_orders integer NOT NULL DEFAULT 0,
  zoho_adjustment_id text NOT NULL DEFAULT '',
  deleted_by uuid,
  deleted_by_name text NOT NULL DEFAULT '',
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deleted_batches_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_batches_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.deleted_batches_log TO authenticated;
GRANT ALL ON public.deleted_batches_log TO service_role;
DROP POLICY IF EXISTS deleted_batches_log_admin_read ON public.deleted_batches_log;
CREATE POLICY deleted_batches_log_admin_read ON public.deleted_batches_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.admin_delete_batch(_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
  held numeric;
  used integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete batches'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- An order placed now waits for this lock (its FIFO takes the batch FOR UPDATE), so nothing slips in between.
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0), count(*) INTO held, used
    FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  IF held > 0 THEN RAISE EXCEPTION 'Orders have taken stock from batch %, so it can''t be deleted.', batch_row.batch_code; END IF;
  -- A batch whose every order was cancelled or expired, unpaid, with all units back, may go (owner, 6 Nov 2026).
  IF used > 0 AND EXISTS (
    SELECT 1 FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id
      JOIN public.orders o ON o.id = i.order_id
     WHERE a.batch_id = batch_row.id
       AND NOT (o.order_status IN ('Cancelled', 'Payment Expired') AND COALESCE(o.paid_amount, 0) = 0
                AND COALESCE(o.payment_status, '') NOT IN ('Paid', 'Partially Paid', 'Refunded'))
  ) THEN RAISE EXCEPTION 'Orders have used batch % before, so it is kept for their records.', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_adjustments WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Stock counts have changed batch %, so it is kept for their records.', batch_row.batch_code;
  END IF;
  IF batch_row.remaining_quantity <> batch_row.quantity THEN
    RAISE EXCEPTION 'Batch %''s units have moved, so it can''t be deleted.', batch_row.batch_code;
  END IF;
  INSERT INTO public.deleted_batches_log (batch_code, product_id, product_name, quantity, released_orders, zoho_adjustment_id, deleted_by, deleted_by_name)
  VALUES (batch_row.batch_code, batch_row.product_id, batch_row.product_name, batch_row.quantity, used, COALESCE(batch_row.zoho_adjustment_id, ''),
    auth.uid(), COALESCE((SELECT left(COALESCE(p.full_name, ''), 120) FROM public.profiles p WHERE p.id = auth.uid()), ''));
  -- Only released rows of cancelled or expired orders are left here; their units are already back in stock.
  DELETE FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  DELETE FROM public.batches WHERE id = batch_row.id;
  RETURN jsonb_build_object('batch_code', batch_row.batch_code, 'zoho_adjustment_id', batch_row.zoho_adjustment_id);
END $function$;
REVOKE ALL ON FUNCTION public.admin_delete_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_batch(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
