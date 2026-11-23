-- Zoho numbers on the portal and the record of a batch's bought quantity changing (client, 17 Nov 2026).
--
-- 1. "Show the Sales Order Number and Invoice Number": the website kept only the Zoho id of an order's sales order, so lists
--    showed the website number (Zoho's Reference#) alone. order_zoho_numbers keeps the sales order's own number
--    (CLK-SO-1711260458), written by the server whenever it creates, links or reads the sales order (the hourly poll reaches
--    every linked order). The invoice numbers are already in zoho_order_invoices. Its own table, so the order guard
--    (guard_order_mutation: the server may change only its listed Zoho columns on an order) stays as it is.
--
-- 2. "The previous 360-bag value is not silently lost": batch_quantity_changes records each change of a batch's bought
--    quantity (relinking it to a bill entered again with another quantity) with before, after, the units left before and
--    after, the bill and who did it. Not a stock adjustment: batch_adjustments rows count as stock lost or found (at cost) in
--    profit, and these 20 bags were never received, so they are no loss. relink_batch_bill writes it (rebuilt from
--    20261117140000, applied live 17 Nov 13:35; only the insert is new). The one change already made live (CLK-131126-02,
--    360 → 340 at 13:41 by Indra Kumar, from its note) is recorded once.
--
-- Adds two tables and changes relink_batch_bill. Safe to run twice.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ================================================================ 1. sales order numbers
CREATE TABLE IF NOT EXISTS public.order_zoho_numbers (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  salesorder_id text NOT NULL DEFAULT '',
  salesorder_number text NOT NULL DEFAULT '' CHECK (length(salesorder_number) <= 80),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_zoho_numbers_order_no_idx ON public.order_zoho_numbers (order_no);
ALTER TABLE public.order_zoho_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_zoho_numbers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_zoho_numbers TO authenticated;
GRANT ALL ON public.order_zoho_numbers TO service_role;
DROP POLICY IF EXISTS order_zoho_numbers_admin_read ON public.order_zoho_numbers;
CREATE POLICY order_zoho_numbers_admin_read ON public.order_zoho_numbers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ================================================================ 2. bought quantity changes
CREATE TABLE IF NOT EXISTS public.batch_quantity_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  quantity_before numeric(14,2) NOT NULL,
  quantity_after numeric(14,2) NOT NULL,
  remaining_before numeric(14,2),
  remaining_after numeric(14,2),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  bill_number text NOT NULL DEFAULT '',
  by_id uuid,
  by_name text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity_before <> quantity_after)
);
CREATE INDEX IF NOT EXISTS batch_quantity_changes_batch_idx ON public.batch_quantity_changes (batch_id, at);
ALTER TABLE public.batch_quantity_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.batch_quantity_changes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.batch_quantity_changes_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.batch_quantity_changes TO authenticated;
GRANT ALL ON public.batch_quantity_changes TO service_role;
GRANT ALL ON SEQUENCE public.batch_quantity_changes_id_seq TO service_role;
DROP POLICY IF EXISTS batch_quantity_changes_admin_read ON public.batch_quantity_changes;
CREATE POLICY batch_quantity_changes_admin_read ON public.batch_quantity_changes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.relink_batch_bill(_batch_id uuid, _bill jsonb, _line jsonb, _by uuid, _by_name text,
  _accept_quantity boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  line_id text := btrim(COALESCE(_line->>'line_id', ''));
  bill_qty numeric(14,2) := round(COALESCE((_line->>'qty')::numeric, -1), 2);
  cost_ex numeric(14,2) := round(COALESCE((_line->>'unit_ex_gst')::numeric, -1), 2);
  cost_inc numeric(14,2) := round(COALESCE((_line->>'unit_inc_gst')::numeric, -1), 2);
  new_cost numeric(14,2);
  used numeric(14,2);
  taken text;
  old_bill text;
  qty_note text := '';
BEGIN
  IF bill_id = '' OR bill_no = '' OR line_id = '' THEN RAISE EXCEPTION 'The new bill or its line is missing'; END IF;
  IF cost_ex < 0 OR cost_inc < cost_ex THEN RAISE EXCEPTION 'The new bill line has a wrong cost'; END IF;
  IF bill_qty <= 0 THEN RAISE EXCEPTION 'The new bill line has no quantity'; END IF;
  -- Product first, then the batch (the order orders and transfers lock in).
  PERFORM 1 FROM public.catalog_products WHERE id = _line->>'product_id' FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF b.zoho_bill_id = '' OR b.zoho_bill_line_id = '' OR b.parent_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'Batch % was not made from a bill line', b.batch_code;
  END IF;
  IF b.bill_flag NOT IN ('Bill deleted in Zoho', 'Bill voided in Zoho') THEN
    RAISE EXCEPTION 'Batch %''s bill % is still in Zoho. A batch moves to another bill only after its own bill was deleted or voided.', b.batch_code, b.zoho_bill_number;
  END IF;
  IF b.zoho_bill_id = bill_id THEN RAISE EXCEPTION 'That is the batch''s own bill'; END IF;
  IF COALESCE(_line->>'product_id', '') <> b.product_id THEN
    RAISE EXCEPTION 'That bill line is another product. Choose the % line.', b.product_name;
  END IF;
  -- Changed 17 Nov 2026: another quantity is allowed once the administrator ticks it, never below what already left.
  used := b.quantity - b.remaining_quantity;
  IF bill_qty <> b.quantity THEN
    IF COALESCE(b.stage, 'received') <> 'received' THEN
      RAISE EXCEPTION 'Batch % is not a received batch; its quantity can''t change here', b.batch_code;
    END IF;
    IF bill_qty < used THEN
      RAISE EXCEPTION 'The new bill has %, but % already left batch % (sold, held for orders, sent or lost). Correct the bill in Zoho, or tell head office.',
        bill_qty, used, b.batch_code;
    END IF;
    IF NOT COALESCE(_accept_quantity, false) THEN
      RAISE EXCEPTION 'The new bill has % of %, the batch %. Tick to make the batch %, then link again.', bill_qty, b.product_name, b.quantity, bill_qty;
    END IF;
    qty_note := format('; purchased %s → %s as on the new bill', to_char(b.quantity, 'FM999999990.##'), to_char(bill_qty, 'FM999999990.##'));
  END IF;
  SELECT batch_code INTO taken FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line_id;
  IF FOUND THEN RAISE EXCEPTION 'That bill line is already batch %', taken; END IF;
  -- The bill being received at a godown right now: it stays with that receive.
  IF EXISTS (SELECT 1 FROM public.batch_transfers t WHERE t.kind = 'receive' AND t.status IN ('pending', 'in_transit')
             AND t.bill->>'bill_id' = bill_id) THEN
    RAISE EXCEPTION 'Bill % is being received at a godown right now. Finish or cancel that first.', bill_no;
  END IF;

  old_bill := b.zoho_bill_number;
  new_cost := CASE WHEN b.cost_basis = 'inc_gst' THEN cost_inc ELSE cost_ex END;
  UPDATE public.batches
     SET zoho_bill_id = bill_id, zoho_bill_line_id = line_id, zoho_bill_number = bill_no, purchase_ref = bill_no,
         supplier = COALESCE(NULLIF(left(btrim(COALESCE(_bill->>'vendor_name', '')), 120), ''), supplier),
         zoho_bill_modified = left(COALESCE(_bill->>'modified', ''), 40), zoho_bill_total = NULLIF(_bill->>'total', '')::numeric,
         zoho_item_id = COALESCE(NULLIF(_line->>'zoho_item_id', ''), zoho_item_id),
         unit_cost_ex_gst = cost_ex, unit_cost_inc_gst = cost_inc, unit_cost = new_cost,
         -- Added 17 Nov 2026: the bill's quantity; the units left move by the difference (what left stays).
         quantity = bill_qty, remaining_quantity = b.remaining_quantity + (bill_qty - b.quantity),
         bill_flag = '', bill_flag_at = NULL, bill_checked_at = now(),
         notes = left(btrim(concat_ws(' · ', NULLIF(notes, ''), format('Bill %s deleted in Zoho; linked to bill %s by %s on %s%s',
           old_bill, bill_no, COALESCE(NULLIF(_by_name, ''), 'an admin'), to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI'), qty_note))), 300)
   WHERE id = b.id;
  -- Added 17 Nov 2026 (second migration): the change of the bought quantity is kept as its own record.
  IF bill_qty <> b.quantity THEN
    INSERT INTO public.batch_quantity_changes (batch_id, quantity_before, quantity_after, remaining_before, remaining_after,
      reason, bill_number, by_id, by_name)
    VALUES (b.id, b.quantity, bill_qty, b.remaining_quantity, b.remaining_quantity + (bill_qty - b.quantity),
      format('Bill %s deleted in Zoho; the purchase entered again as bill %s', old_bill, bill_no), bill_no, _by,
      left(COALESCE(NULLIF(_by_name, ''), 'an admin'), 120));
  END IF;
  -- What was sold, counted or sent from it takes the new bill's cost, so profit stays right.
  IF new_cost <> b.unit_cost THEN
    UPDATE public.order_item_batch_allocations SET unit_cost = new_cost WHERE batch_id = b.id;
    UPDATE public.batch_adjustments SET unit_cost = new_cost WHERE batch_id = b.id;
  END IF;
  -- Batches sent on from it to other godowns: same purchase, same bill.
  UPDATE public.batches c
     SET zoho_bill_id = bill_id, zoho_bill_number = bill_no, zoho_bill_modified = left(COALESCE(_bill->>'modified', ''), 40),
         zoho_bill_total = NULLIF(_bill->>'total', '')::numeric, purchase_ref = bill_no,
         unit_cost_ex_gst = cost_ex, unit_cost_inc_gst = cost_inc,
         unit_cost = CASE WHEN c.cost_basis = 'inc_gst' THEN cost_inc ELSE cost_ex END,
         bill_flag = '', bill_flag_at = NULL, bill_checked_at = now()
   WHERE c.parent_batch_id = b.id;
  IF new_cost <> b.unit_cost THEN
    UPDATE public.order_item_batch_allocations a SET unit_cost = new_cost
      FROM public.batches c WHERE c.parent_batch_id = b.id AND a.batch_id = c.id;
    UPDATE public.batch_adjustments a SET unit_cost = new_cost
      FROM public.batches c WHERE c.parent_batch_id = b.id AND a.batch_id = c.id;
  END IF;
  RETURN jsonb_build_object('batch_id', b.id, 'batch_code', b.batch_code, 'old_bill', old_bill, 'new_bill', bill_no,
    'cost_before', b.unit_cost, 'cost_now', new_cost,
    'quantity_before', b.quantity, 'quantity_now', bill_qty, 'remaining_now', b.remaining_quantity + (bill_qty - b.quantity));
END $function$;
REVOKE ALL ON FUNCTION public.relink_batch_bill(uuid, jsonb, jsonb, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_batch_bill(uuid, jsonb, jsonb, uuid, text, boolean) TO service_role;

-- The change already made live (CLK-131126-02, 17 Nov 2026 13:41 IST), from the note relink_batch_bill wrote. The units
-- left then are not known exactly (orders kept taking from it), so they stay empty. Once only.
INSERT INTO public.batch_quantity_changes (batch_id, quantity_before, quantity_after, reason, bill_number, by_name, at)
SELECT b.id, 360, 340, 'Bill YET TO COME deleted in Zoho; the purchase entered again as bill 142615757840', '142615757840',
       'Indra Kumar', '2026-11-17 13:41:00+05:30'
  FROM public.batches b
 WHERE b.batch_code = 'CLK-131126-02' AND b.quantity = 340 AND b.zoho_bill_number = '142615757840'
   AND b.notes LIKE '%purchased 360 → 340 as on the new bill%'
   AND NOT EXISTS (SELECT 1 FROM public.batch_quantity_changes c WHERE c.batch_id = b.id);

COMMIT;

NOTIFY pgrst, 'reload schema';
