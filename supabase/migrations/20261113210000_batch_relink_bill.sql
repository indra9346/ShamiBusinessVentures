-- Link a batch to its bill entered again in Zoho (13 Nov 2026).
--
-- The owner deleted the bill "YET TO COME" (Sugar S1, 360) and its purchase receive in Zoho, to enter them again with the
-- real bill number. The batch CLK-131126-02 made from that bill has already sold from it, so it can't be deleted and made
-- again; a second batch from the new bill would count the 360 twice. This moves the batch onto the new bill line instead:
-- only while its own bill is gone from Zoho (flagged deleted or voided), only to a line of the same product and the same
-- quantity that no other batch has, and with the cost the new bill gives (sales and counts made from it take that cost,
-- as admin_update_batch does for a batch typed by hand). Batches sent on from it to other godowns carry the bill too.
-- Server only: the server reads the bill from Zoho itself and passes its numbers.
--   _bill = {bill_id, bill_number, vendor_name, modified, total}
--   _line = {line_id, product_id, zoho_item_id, qty, unit_ex_gst, unit_inc_gst}

CREATE OR REPLACE FUNCTION public.relink_batch_bill(_batch_id uuid, _bill jsonb, _line jsonb, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  line_id text := btrim(COALESCE(_line->>'line_id', ''));
  quantity numeric(14,2) := round(COALESCE((_line->>'qty')::numeric, -1), 2);
  cost_ex numeric(14,2) := round(COALESCE((_line->>'unit_ex_gst')::numeric, -1), 2);
  cost_inc numeric(14,2) := round(COALESCE((_line->>'unit_inc_gst')::numeric, -1), 2);
  new_cost numeric(14,2);
  taken text;
  old_bill text;
BEGIN
  IF bill_id = '' OR bill_no = '' OR line_id = '' THEN RAISE EXCEPTION 'The new bill or its line is missing'; END IF;
  IF cost_ex < 0 OR cost_inc < cost_ex THEN RAISE EXCEPTION 'The new bill line has a wrong cost'; END IF;
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
  IF quantity <> b.quantity THEN
    RAISE EXCEPTION 'The new bill has % of %, the batch %. Correct the bill in Zoho, or tell head office.', quantity, b.product_name, b.quantity;
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
         bill_flag = '', bill_flag_at = NULL, bill_checked_at = now(),
         notes = left(btrim(concat_ws(' · ', NULLIF(notes, ''), format('Bill %s deleted in Zoho; linked to bill %s by %s on %s',
           old_bill, bill_no, COALESCE(NULLIF(_by_name, ''), 'an admin'), to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')))), 300)
   WHERE id = b.id;
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
    'cost_before', b.unit_cost, 'cost_now', new_cost);
END $function$;
REVOKE ALL ON FUNCTION public.relink_batch_bill(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_batch_bill(uuid, jsonb, jsonb, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
