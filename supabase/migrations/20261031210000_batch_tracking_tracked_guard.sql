-- Batch tracking, second review (31 Oct 2026): for an item with Zoho "Track batches", a head-office
-- godown stock edit is recorded on the batches Zoho changes (by the godown sync, from Zoho's own batch
-- plan), not on the website's oldest / newest batch here, so the two never pick different batches.
-- Items without Zoho batch tracking are unchanged.

CREATE OR REPLACE FUNCTION private.record_batch_stock_change(_branch_id text, _product_id text, _delta numeric,
  _reason text, _note text, _by uuid, _by_name text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := round(abs(COALESCE(_delta, 0)), 2);
  taken numeric(14,2);
  batch_row record;
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
  UPDATE public.batches SET remaining_quantity = remaining_quantity + needed WHERE id = batch_row.id;
  INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, created_by, created_by_name)
    VALUES (batch_row.id, needed, _reason, left(COALESCE(_note, ''), 200), batch_row.unit_cost, _by, left(COALESCE(_by_name, ''), 120));
  RETURN needed;
END $function$;
REVOKE ALL ON FUNCTION private.record_batch_stock_change(text, text, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
