-- Batch stock arriving at the godown is not a gain (13 Nov 2026).
--
-- A batch made from a Zoho bill holds its units from the moment it is made, but the godown's stock on the website
-- only goes up when Zoho's purchase receive reaches the website (the Zoho sync) or when someone enters it. Until
-- now every increase of a godown's stock was added to its newest batch as a "gain", so the batch counted the same
-- units twice. Live, 13 Nov: CLK-131126-02 (Sugar S1, 360 bought from the bill "YET TO COME") showed 720 left,
-- profit ₹9,09,900 and stock lost −₹9,09,900, after Challakere's stock was set to 360 by hand (+360, −360, +360)
-- while the Zoho sync was not running. Zoho itself holds 360 at Challakere (one purchase receive), as it should.
--
-- Rule from here: an increase first covers the batch units the godown's stock does not show yet (its batches hold
-- more than its stock); only units beyond what the batches hold are a gain, on the newest batch as before.
-- Decreases are unchanged (the oldest batch loses first). The staff stock count applies the same rule in the server
-- (batchGainOf in src/lib/batches.ts).

CREATE OR REPLACE FUNCTION private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric,
  _reason text, _note text, _by uuid, _by_name text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := round(abs(COALESCE(_delta, 0)), 2);
  taken numeric(14,2);
  batch_row record;
  stock_after numeric(14,2);
  in_batches numeric(14,2);
BEGIN
  IF needed = 0 THEN RETURN 0; END IF;
  -- A Zoho batch-tracked item: the godown sync records the batches Zoho itself changes.
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = _product_id AND track_batches) THEN RETURN 0; END IF;
  IF _delta < 0 THEN
    FOR batch_row IN
      SELECT id, remaining_quantity, unit_cost FROM public.batches
      WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0
      ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
      FOR UPDATE
    LOOP
      EXIT WHEN needed <= 0;
      taken := LEAST(needed, batch_row.remaining_quantity);
      UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
      INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
        VALUES (batch_row.id, -taken, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
      needed := needed - taken;
    END LOOP;
    RETURN round(abs(_delta), 2) - needed;
  END IF;
  SELECT id, unit_cost INTO batch_row FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id
    ORDER BY purchase_date DESC NULLS LAST, created_at DESC, batch_code DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- Called after the godown's stock was written (admin_set_branch_stock): only what the stock now holds beyond the
  -- batches is a gain; the rest is batch stock reaching the count.
  SELECT COALESCE(stock, 0) INTO stock_after FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  SELECT COALESCE(SUM(remaining_quantity), 0) INTO in_batches FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0;
  needed := LEAST(needed, GREATEST(0, COALESCE(stock_after, 0) - in_batches));
  IF needed <= 0 THEN RETURN 0; END IF;
  UPDATE public.batches SET remaining_quantity = remaining_quantity + needed WHERE id = batch_row.id;
  INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
    VALUES (batch_row.id, needed, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
  RETURN needed;
END $function$;
REVOKE ALL ON FUNCTION private.record_batch_stock_change(text, text, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- The bill check (checkBatchBills) compares a bill's batch lines when only Zoho's edit time moved (a purchase receive
-- or a payment touches the bill too). The edit time it read comes along as "modified" and is kept, so the bill is read
-- again only when Zoho's edit time moves once more: lines as they were clear the flag, a changed line keeps it.
-- _rows = [{bill_id, flag, modified?}]; without "modified" the stored edit time stays.
CREATE OR REPLACE FUNCTION public.flag_batch_bill_changes(_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  line jsonb;
  flagged integer := 0;
  changed integer;
  flag text;
  modified text;
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    flag := left(COALESCE(line->>'flag', ''), 200);
    modified := left(btrim(COALESCE(line->>'modified', '')), 40);
    UPDATE public.batches
      SET bill_flag = flag,
          bill_flag_at = CASE WHEN flag = '' THEN NULL WHEN bill_flag = flag THEN bill_flag_at ELSE now() END,
          bill_checked_at = now(),
          zoho_bill_modified = CASE WHEN modified <> '' THEN modified ELSE zoho_bill_modified END
      WHERE zoho_bill_id = line->>'bill_id' AND zoho_bill_id <> '';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF flag <> '' THEN flagged := flagged + changed; END IF;
  END LOOP;
  RETURN flagged;
END $function$;
REVOKE ALL ON FUNCTION public.flag_batch_bill_changes(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_batch_bill_changes(jsonb) TO service_role;

-- The live batch that took the same 360 units twice (see the top). Its three hand-entered corrections (+360, −360,
-- +360) are taken out and its units go back to what the bill brought less what orders have taken since: at 16:24 IST a
-- checkout (2 bags, awaiting payment) took 2, so 718 becomes 358, the same as Challakere's stock. Only when the batch
-- adds up exactly that way: units left = bought − sent on − held or sold by orders + the 360 counted twice, and its
-- only losses and gains are those three rows. Anywhere else (a new database, or the batch changed otherwise) it does
-- nothing, and running it again does nothing.
DO $fix$
DECLARE
  fake_ids uuid[] := ARRAY['5992eb4c-4720-43d6-9464-89f52c250196', '196c31bf-710f-498f-8ce3-f7d8b56973dd', '7edc0e51-968e-4dd5-be08-320a9addee3f']::uuid[];
  target_batch uuid := '5fc4958b-e737-42d4-8736-a027ddaf867e';
  batch_row public.batches%ROWTYPE;
  found_rows integer;
  net numeric;
  by_orders numeric;
BEGIN
  -- The product first, then the batch (the order of locks orders and transfers use), so no order can take from it
  -- while it is corrected.
  PERFORM 1 FROM public.catalog_products WHERE id = 'ZI-3579709000000834002' FOR UPDATE;
  SELECT * INTO batch_row FROM public.batches b
    WHERE b.id = target_batch AND b.batch_code = 'CLK-131126-02' AND b.quantity = 360
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), COALESCE(SUM(a.qty), 0) INTO found_rows, net FROM public.batch_adjustments a WHERE a.batch_id = target_batch;
  -- Exactly the three hand edits and nothing else on this batch.
  IF found_rows <> 3 OR net <> 360
     OR (SELECT count(*) FROM public.batch_adjustments a
          WHERE a.id = ANY (fake_ids) AND a.batch_id = target_batch AND a.reason = 'correction' AND a.note = 'Godown stock set by head office') <> 3 THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(al.reserved_quantity - al.released_quantity), 0) INTO by_orders
    FROM public.order_item_batch_allocations al WHERE al.batch_id = target_batch;
  IF batch_row.remaining_quantity <> batch_row.quantity - COALESCE(batch_row.sent_quantity, 0) - by_orders + net
     OR batch_row.remaining_quantity - net < 0 THEN
    RETURN;
  END IF;
  DELETE FROM public.batch_adjustments WHERE id = ANY (fake_ids) AND batch_id = target_batch;
  UPDATE public.batches SET remaining_quantity = remaining_quantity - net WHERE id = target_batch;
END $fix$;

NOTIFY pgrst, 'reload schema';
