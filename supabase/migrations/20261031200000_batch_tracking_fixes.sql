-- Batch tracking fixes (review of 20261031190000_batch_tracking.sql, 31 Oct 2026).
--
-- 1. The original UNIQUE (batch_code) stayed in place: a Zoho batch moved to a second godown (or a
--    Zoho batch number used by two items) could not be imported, and the clash rolled back the
--    whole item's import every 15 minutes. Website receipts stay unique across the company
--    (record_batch_receipt checks that); the table only needs one row per number, godown and product.
-- 2. Automatic numbers are reserved when they are handed out, so two receipts at the same godown
--    on the same day can never get the same number (the Zoho adjustment is made before the batch
--    row exists).
-- 3. A batch made in Zoho is imported with the balance Zoho holds now as its opening quantity (the
--    website never saw the units used before), so its ledger adds up.
-- 4. A vendor sees batch numbers only for their own lines of a shared order (as order_items_read).
-- 5. An admin's godown stock edit is recorded per batch when it is made, down (oldest batch first)
--    and up (newest batch), instead of the sync recording only the losses.

-- ---------------------------------------------------------------- 1. uniqueness
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_batch_code_key;
DROP INDEX IF EXISTS public.batches_code_branch_unique;
CREATE UNIQUE INDEX IF NOT EXISTS batches_code_branch_product_unique
  ON public.batches (upper(batch_code), COALESCE(branch_id, ''), product_id);

-- Batches recorded before godowns existed (none live on 31 Oct 2026; kept for other databases).
UPDATE public.batches b
  SET branch_id = COALESCE((SELECT br.id FROM public.branches br
                            WHERE NULLIF(btrim(b.warehouse), '') IN (br.id, br.code, br.name) LIMIT 1),
                           public.default_branch_id())
  WHERE b.branch_id IS NULL;
UPDATE public.batches SET depleted_at = updated_at WHERE remaining_quantity <= 0 AND depleted_at IS NULL;

-- ---------------------------------------------------------------- 2. reserved numbers
CREATE TABLE IF NOT EXISTS public.batch_code_reservations (
  code text PRIMARY KEY,
  branch_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.batch_code_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.batch_code_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.batch_code_reservations TO service_role;

/** Next free number for a godown and purchase date (CLK-311026-01, -02, ...), reserved for the caller. */
CREATE OR REPLACE FUNCTION public.next_batch_code(_branch_id text, _purchase_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  godown_code text;
  prefix text;
  last_no integer;
  new_code text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may number batches';
  END IF;
  SELECT upper(COALESCE(NULLIF(btrim(b.code), ''), regexp_replace(b.id, '^BR-', ''))) INTO godown_code
    FROM public.branches b WHERE b.id = _branch_id;
  IF godown_code IS NULL THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  prefix := godown_code || '-' || to_char(COALESCE(_purchase_date, (now() AT TIME ZONE 'Asia/Kolkata')::date), 'DDMMYY') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('batch_code:' || prefix));
  SELECT COALESCE(max((substring(c FROM length(prefix) + 1))::integer), 0) INTO last_no
    FROM (
      SELECT upper(batch_code) AS c FROM public.batches
      UNION ALL SELECT upper(r.code) FROM public.batch_code_reservations r
    ) used
    WHERE c LIKE prefix || '%' AND substring(c FROM length(prefix) + 1) ~ '^[0-9]{1,4}$';
  new_code := prefix || lpad((last_no + 1)::text, 2, '0');
  INSERT INTO public.batch_code_reservations (code, branch_id) VALUES (new_code, _branch_id);
  RETURN new_code;
END $function$;
REVOKE ALL ON FUNCTION public.next_batch_code(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_batch_code(text, date) TO authenticated, service_role;

-- ---------------------------------------------------------------- 3. Zoho import
CREATE OR REPLACE FUNCTION public.apply_zoho_batches(_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  line jsonb;
  existing uuid;
  existing_zoho text;
  product_row public.catalog_products%ROWTYPE;
  branch_row public.branches%ROWTYPE;
  linked integer := 0;
  added integer := 0;
  skipped integer := 0;
  balance numeric(14,2);
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    CONTINUE WHEN COALESCE(line->>'zoho_batch_id', '') = '' OR COALESCE(line->>'batch_number', '') = '';
    balance := GREATEST(0, COALESCE((line->>'balance')::numeric, 0));
    SELECT id, zoho_batch_id INTO existing, existing_zoho FROM public.batches
      WHERE branch_id = line->>'branch_id' AND product_id = line->>'product_id'
        AND (zoho_batch_id = line->>'zoho_batch_id' OR upper(batch_code) = upper(line->>'batch_number'))
      ORDER BY (zoho_batch_id = line->>'zoho_batch_id') DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      -- Same number but already linked to another Zoho batch: never re-point it.
      IF existing_zoho <> '' AND existing_zoho <> line->>'zoho_batch_id' THEN
        skipped := skipped + 1;
        CONTINUE;
      END IF;
      BEGIN
        UPDATE public.batches SET zoho_batch_id = line->>'zoho_batch_id', zoho_item_id = COALESCE(line->>'zoho_item_id', zoho_item_id),
          zoho_balance = balance, zoho_checked_at = now()
          WHERE id = existing;
        linked := linked + 1;
      EXCEPTION WHEN unique_violation THEN
        skipped := skipped + 1;
      END;
      CONTINUE;
    END IF;
    CONTINUE WHEN balance <= 0;  -- an empty Zoho batch the website never had: nothing to track
    SELECT * INTO product_row FROM public.catalog_products WHERE id = line->>'product_id';
    CONTINUE WHEN NOT FOUND;
    SELECT * INTO branch_row FROM public.branches WHERE id = line->>'branch_id';
    CONTINUE WHEN NOT FOUND;
    BEGIN
      -- Opening quantity = what Zoho holds now: units used before the website saw the batch were
      -- never the website's, so the batch ledger (purchased - sold - lost + found) adds up.
      INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
        unit_cost, purchase_date, mfg_date, expiry_date, warehouse, branch_id, source, notes, zoho_item_id, zoho_batch_id,
        zoho_balance, zoho_checked_at, status)
      VALUES (upper(line->>'batch_number'), product_row.id, COALESCE(product_row.payload->>'name', product_row.id),
        product_row.payload->>'vendor', product_row.vendor_id, balance, balance,
        COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'), GREATEST(0, COALESCE((line->>'unit_cost')::numeric, 0)),
        COALESCE(NULLIF(line->>'seen_on', '')::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),
        NULLIF(line->>'mfg_date', '')::date, NULLIF(line->>'expiry_date', '')::date, branch_row.name, branch_row.id, 'zoho',
        'Created in Zoho' || CASE WHEN COALESCE((line->>'in_quantity')::numeric, 0) > balance
          THEN ' (' || (line->>'in_quantity') || ' received in Zoho, ' || balance || ' left when first seen)' ELSE '' END,
        COALESCE(line->>'zoho_item_id', ''), line->>'zoho_batch_id', balance, now(), 'Active');
      added := added + 1;
    EXCEPTION WHEN unique_violation THEN
      -- Same number already used for this product at this godown: leave it for head office.
      skipped := skipped + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('linked', linked, 'added', added, 'skipped', skipped);
END $function$;
REVOKE ALL ON FUNCTION public.apply_zoho_batches(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_batches(jsonb) TO service_role;

-- ---------------------------------------------------------------- 4. vendor scoping
CREATE OR REPLACE FUNCTION public.order_item_batches(_order_id uuid)
RETURNS TABLE (order_item_id uuid, batch_code text, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT a.order_item_id, b.batch_code, SUM(a.reserved_quantity - a.released_quantity)
  FROM public.order_item_batch_allocations a
  JOIN public.order_items oi ON oi.id = a.order_item_id
  JOIN public.batches b ON b.id = a.batch_id
  WHERE oi.order_id = _order_id AND public.can_read_order(_order_id)
    AND (public.has_role(auth.uid(), 'admin') OR NOT public.has_role(auth.uid(), 'vendor') OR oi.vendor_id = public.current_vendor_id())
  GROUP BY a.order_item_id, b.batch_code, b.purchase_date
  HAVING SUM(a.reserved_quantity - a.released_quantity) > 0
  ORDER BY a.order_item_id, b.purchase_date, b.batch_code;
$function$;
REVOKE ALL ON FUNCTION public.order_item_batches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_item_batches(uuid) TO authenticated;

-- ---------------------------------------------------------------- 5. admin stock edits per batch
/** A stock change at a godown spread over its batches: a cut from the oldest first, an increase to the newest. */
CREATE OR REPLACE FUNCTION private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric,
  _reason text, _note text, _by uuid, _by_name text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := round(abs(COALESCE(_delta, 0)), 2);
  taken numeric(14,2);
  batch_row record;
BEGIN
  IF needed = 0 THEN RETURN 0; END IF;
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
  UPDATE public.batches SET remaining_quantity = remaining_quantity + needed WHERE id = batch_row.id;
  INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
    VALUES (batch_row.id, needed, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
  RETURN needed;
END $function$;
REVOKE ALL ON FUNCTION private.record_batch_stock_change(text, text, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- Live definition (31 Oct 2026) plus the per-batch record of the change.
CREATE OR REPLACE FUNCTION public.admin_set_branch_stock(_branch_id text, _product_id text, _stock numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE total numeric; before_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators can set branch stock';
  END IF;
  IF _stock IS NULL OR _stock < 0 OR _stock > 10000000 THEN RAISE EXCEPTION 'Enter a valid stock quantity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch_id) THEN RAISE EXCEPTION 'Unknown branch'; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown product'; END IF;
  SELECT stock INTO before_stock FROM public.branch_stock WHERE branch_id = _branch_id AND product_id = _product_id;
  INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch_id, _product_id, _stock, true)
  ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, zoho_pending = true, updated_at = now();
  -- The same change on the godown's batches (correction), so batch reports match the stock.
  PERFORM private.record_batch_stock_change(_branch_id, _product_id, _stock - COALESCE(before_stock, 0), 'correction',
    'Godown stock set by head office', auth.uid(), COALESCE((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''));
  SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product_id;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  RETURN total;
END $function$;

NOTIFY pgrst, 'reload schema';
