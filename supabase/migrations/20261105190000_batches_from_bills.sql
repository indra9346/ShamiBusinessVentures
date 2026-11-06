-- Batches from Zoho bills (client request, 5 Nov 2026).
-- Stock comes in only through Zoho bills. Receive purchase used to post a Zoho stock adjustment as well, so a bill
-- and its batch counted the stock twice (Ekadantha 12 -> 24, Zandu 4 -> 8). From here a batch is made from a bill
-- line, records the line's cost (without and with GST, and which one the admin chose for that bill), and never
-- changes stock on either side. Only adds: new columns, an index and functions; existing batches keep working.

-- ---------------------------------------------------------------- batches: the bill line and both costs
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS unit_cost_ex_gst numeric(14,2),
  ADD COLUMN IF NOT EXISTS unit_cost_inc_gst numeric(14,2),
  ADD COLUMN IF NOT EXISTS cost_basis text,
  ADD COLUMN IF NOT EXISTS zoho_bill_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_bill_line_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_bill_number text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_bill_modified text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_bill_total numeric(14,2),
  ADD COLUMN IF NOT EXISTS bill_flag text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bill_flag_at timestamptz,
  ADD COLUMN IF NOT EXISTS bill_checked_at timestamptz;

ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_cost_basis_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_cost_basis_check CHECK (cost_basis IS NULL OR cost_basis IN ('ex_gst', 'inc_gst'));

-- One bill line makes one batch, however often the button is pressed or by whom.
CREATE UNIQUE INDEX IF NOT EXISTS batches_bill_line_unique ON public.batches (zoho_bill_id, zoho_bill_line_id) WHERE zoho_bill_line_id <> '';
CREATE INDEX IF NOT EXISTS batches_bill_idx ON public.batches (zoho_bill_id) WHERE zoho_bill_id <> '';

-- ---------------------------------------------------------------- the old receipt no longer runs
-- It added the batch's units to the godown's stock (and the server sent them to Zoho): stock now comes from the bill.
REVOKE ALL ON FUNCTION public.record_batch_receipt(text, text, text, numeric, numeric, date, date, date, text, text, text, text, text, text, boolean, uuid, text) FROM service_role;

-- ---------------------------------------------------------------- batches from a bill (server only)
/**
 * One batch per bill line, all or none. The server read the bill from Zoho itself and worked out each line's cost:
 *   _bill  = {bill_id, bill_number, vendor_name, date, modified, total}
 *   _lines = [{line_id, product_id, qty, unit_ex_gst, unit_inc_gst, mfg_date, expiry_date, notes}]
 * Numbers come from next_batch_code. Stock is not touched here, on purpose: the bill already brought it in Zoho, and
 * the godown stock sync brings it to the website.
 */
CREATE OR REPLACE FUNCTION public.create_batches_from_bill(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text,
  _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  branch_row public.branches%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := left(btrim(COALESCE(_bill->>'bill_number', '')), 80);
  bill_date date;
  line_id text;
  quantity numeric(14,2);
  cost_ex numeric(14,2);
  cost_inc numeric(14,2);
  code text;
  new_id uuid;
  done text;
  made jsonb := '[]'::jsonb;
BEGIN
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  bill_date := NULLIF(_bill->>'date', '')::date;
  IF bill_date IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to make batches from'; END IF;
  SELECT * INTO branch_row FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT branch_row.active OR branch_row.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  -- Two admins, or two presses, on one bill: the second waits and then finds the lines done.
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    line_id := btrim(COALESCE(line->>'line_id', ''));
    IF line_id = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line_id;
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    quantity := round(COALESCE((line->>'qty')::numeric, 0), 2);
    cost_ex := round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2);
    cost_inc := round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2);
    IF quantity <= 0 OR quantity > 1000000 THEN RAISE EXCEPTION 'Bill % has a line with no quantity', bill_no; END IF;
    IF cost_ex < 0 OR cost_inc < cost_ex OR cost_inc > 100000000 THEN RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no; END IF;
    SELECT * INTO product_row FROM public.catalog_products WHERE id = line->>'product_id';
    IF NOT FOUND OR COALESCE(product_row.vendor_id, '') LIKE 'zoho:%' THEN RAISE EXCEPTION 'A bill line is not a website product'; END IF;
    -- Zoho makes and reports batches of these items itself (apply_zoho_batches): a second batch would count them twice.
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = product_row.id AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', COALESCE(product_row.payload->>'name', product_row.id);
    END IF;
    code := public.next_batch_code(branch_row.id, bill_date);
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name,
      zoho_item_id, zoho_bill_id, zoho_bill_line_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status)
    VALUES (code, product_row.id, COALESCE(product_row.payload->>'name', product_row.id), product_row.payload->>'vendor',
      product_row.vendor_id, quantity, quantity, COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'),
      CASE WHEN _cost_basis = 'inc_gst' THEN cost_inc ELSE cost_ex END, cost_ex, cost_inc, _cost_basis, bill_date,
      NULLIF(line->>'mfg_date', '')::date, NULLIF(line->>'expiry_date', '')::date, branch_row.name, branch_row.id,
      'website', left(btrim(COALESCE(_bill->>'vendor_name', '')), 120), bill_no, left(btrim(COALESCE(line->>'notes', '')), 300),
      _by, left(COALESCE(_by_name, ''), 120), COALESCE(line->>'zoho_item_id', ''), bill_id, line_id,
      bill_no, left(COALESCE(_bill->>'modified', ''), 40), NULLIF(_bill->>'total', '')::numeric, 'Active')
    RETURNING id INTO new_id;
    made := made || jsonb_build_object('line_id', line_id, 'batch_id', new_id, 'batch_code', code);
  END LOOP;
  RETURN made;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Bill % already has batches for these lines. Refresh the page.', bill_no;
END $function$;
REVOKE ALL ON FUNCTION public.create_batches_from_bill(text, jsonb, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_batches_from_bill(text, jsonb, jsonb, text, uuid, text) TO service_role;

-- ---------------------------------------------------------------- delete a batch nothing has touched
/**
 * Admin: deletes a batch only while no order has ever taken from it (paid, held or released), no stock count has
 * changed it and every unit is still in it. Stock is never changed. Returns the batch's number and any Zoho
 * adjustment it once posted (the old Receive purchase), which the admin removes in Zoho if it should go.
 */
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
  IF used > 0 THEN RAISE EXCEPTION 'Orders have used batch % before, so it is kept for their records.', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_adjustments WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Stock counts have changed batch %, so it is kept for their records.', batch_row.batch_code;
  END IF;
  IF batch_row.remaining_quantity <> batch_row.quantity THEN
    RAISE EXCEPTION 'Batch %''s units have moved, so it can''t be deleted.', batch_row.batch_code;
  END IF;
  DELETE FROM public.batches WHERE id = batch_row.id;
  RETURN jsonb_build_object('batch_code', batch_row.batch_code, 'zoho_adjustment_id', batch_row.zoho_adjustment_id);
END $function$;
REVOKE ALL ON FUNCTION public.admin_delete_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_batch(uuid) TO authenticated;

-- ---------------------------------------------------------------- a bill that changed in Zoho (server only)
/**
 * The server's check of bills that have batches: _rows = [{bill_id, flag}], flag "" when the bill is as it was.
 * Only the flag columns change; a person decides what to do with the batch.
 */
CREATE OR REPLACE FUNCTION public.flag_batch_bill_changes(_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  line jsonb;
  flagged integer := 0;
  changed integer;
  flag text;
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    flag := left(COALESCE(line->>'flag', ''), 200);
    UPDATE public.batches
      SET bill_flag = flag,
          bill_flag_at = CASE WHEN flag = '' THEN NULL WHEN bill_flag = flag THEN bill_flag_at ELSE now() END,
          bill_checked_at = now()
      WHERE zoho_bill_id = line->>'bill_id' AND zoho_bill_id <> '';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF flag <> '' THEN flagged := flagged + changed; END IF;
  END LOOP;
  RETURN flagged;
END $function$;
REVOKE ALL ON FUNCTION public.flag_batch_bill_changes(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flag_batch_bill_changes(jsonb) TO service_role;

-- ---------------------------------------------------------------- admin edits: a bill's cost stays the bill's
/** As before (20261031190000), except that the cost of a batch made from a bill comes from the bill and is not typed over. */
CREATE OR REPLACE FUNCTION public.admin_update_batch(_batch_id uuid, _unit_cost numeric, _supplier text, _purchase_ref text,
  _notes text, _mfg_date date, _expiry_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may edit batches'; END IF;
  IF _unit_cost IS NULL OR _unit_cost < 0 OR _unit_cost > 100000000 THEN RAISE EXCEPTION 'Enter a valid purchase cost'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF batch_row.zoho_bill_id <> '' THEN
    IF round(_unit_cost, 2) <> batch_row.unit_cost THEN RAISE EXCEPTION 'This batch''s cost comes from bill %. Correct the bill in Zoho instead.', batch_row.zoho_bill_number; END IF;
    -- Supplier and bill number come from the bill too.
    UPDATE public.batches SET notes = left(btrim(COALESCE(_notes, '')), 300), mfg_date = _mfg_date, expiry_date = _expiry_date
      WHERE id = _batch_id;
    RETURN;
  END IF;
  UPDATE public.batches
    SET unit_cost = _unit_cost, supplier = left(btrim(COALESCE(_supplier, '')), 120),
        purchase_ref = left(btrim(COALESCE(_purchase_ref, '')), 80), notes = left(btrim(COALESCE(_notes, '')), 300),
        mfg_date = _mfg_date, expiry_date = _expiry_date
    WHERE id = _batch_id;
  -- Sales already made from the batch take the corrected cost too (profit stays right).
  UPDATE public.order_item_batch_allocations SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
  UPDATE public.batch_adjustments SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
END $function$;
REVOKE ALL ON FUNCTION public.admin_update_batch(uuid, numeric, text, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_batch(uuid, numeric, text, text, text, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
