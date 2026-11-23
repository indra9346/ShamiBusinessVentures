-- Lot numbers (client's note, 17 Nov 2026): "Now batches is done but lot No is pending. For example we purchased Satish
-- Sugars S1 Grade 340 bags, give that lot No SS/S1/340/003 (Satish Sugars / Grade S1 / No. of bags purchased / PO No)."
--
-- One lot number per purchase batch (the batch made from the bill line); the batches sent on from it to other godowns show
-- the same number (worked out in the app, never copied, so it can't drift). The page suggests it from the batch (mill,
-- grade, bags, PO) and the administrator confirms or corrects it: the mill (Satish Sugars) is not the bill's supplier (the
-- trader) and most purchases have no PO in Zoho. Who set it and when is kept on the batch.
-- Adds columns and one function. Safe to run twice. Nothing existing changes.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS lot_no text NOT NULL DEFAULT '';
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS lot_no_set_by_name text NOT NULL DEFAULT '';
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS lot_no_set_at timestamptz;
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_lot_no_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_lot_no_check
  CHECK (lot_no = '' OR lot_no ~ '^[A-Za-z0-9][A-Za-z0-9/ ._-]{0,59}$');

/**
 * An administrator sets (or clears with '') a purchase batch's lot number. A batch sent on from another godown's batch
 * takes its lot number from that one. Returns the number saved.
 */
CREATE OR REPLACE FUNCTION public.admin_set_batch_lot_no(_batch_id uuid, _lot_no text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  lot text := upper(regexp_replace(btrim(COALESCE(_lot_no, '')), '\s+', ' ', 'g'));
  parent_code text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may set lot numbers'; END IF;
  IF lot <> '' AND lot !~ '^[A-Z0-9][A-Z0-9/ ._-]{0,59}$' THEN
    RAISE EXCEPTION 'Use letters, digits and / . - _ only in the lot number (up to 60)';
  END IF;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF b.parent_batch_id IS NOT NULL THEN
    SELECT batch_code INTO parent_code FROM public.batches WHERE id = b.parent_batch_id;
    RAISE EXCEPTION 'Batch % came from batch %: set the lot number there', b.batch_code, COALESCE(parent_code, '?');
  END IF;
  IF b.stage = 'cancelled' THEN RAISE EXCEPTION 'Batch % was cancelled', b.batch_code; END IF;
  UPDATE public.batches
     SET lot_no = lot,
         lot_no_set_by_name = COALESCE((SELECT NULLIF(full_name, '') FROM public.profiles WHERE id = auth.uid()), 'an admin'),
         lot_no_set_at = now()
   WHERE id = b.id;
  RETURN lot;
END $function$;
REVOKE ALL ON FUNCTION public.admin_set_batch_lot_no(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_batch_lot_no(uuid, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
