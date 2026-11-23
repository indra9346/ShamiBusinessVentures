-- Batch relink with another quantity, and batch expenses typed by hand (client, Sandesh, 17 Nov 2026).
--
-- 1. "In this link new bill option quantity is changed in new bill, 360 was earlier and now we received 340 bags":
--    batch CLK-131126-02 (Sugar S1, 360) lost its bill "YET TO COME" in Zoho; the purchase was entered again as a bill of
--    340. relink_batch_bill refused any other quantity. Now, when the administrator ticks it (_accept_quantity), the batch
--    takes the new bill's quantity and its units left move by the difference. What already left the batch (sold, held for
--    orders, sent on, lost in counts) stays exactly as it is, with its orders and customers; the new quantity may never be
--    below it. Only a received batch. Rebuilt from the LIVE definition (pg_get_functiondef, 17 Nov 2026, equal to
--    20261113210000); the old 5-argument call keeps working through the default.
--
-- 2. "An option to attach expense occurred for that batch like transport, amali, driver commission etc and channel
--    partner commission and other ... give option to edit the expense": expenses typed in on the website (source
--    'manual' in zoho_cost_documents, so the batch profit and loss, landed cost and cost check take them exactly as the
--    Zoho Books expenses tagged since 14 Nov), a type on every expense (category), and functions to save, edit and delete
--    them. Zoho's expense check never reads a manual expense (it lists source 'expense' and 'bill' only).
--
-- Adds only; nothing existing changes except relink_batch_bill. Safe to run twice. Server only (service role), like the
-- functions it sits next to.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ================================================================ 1. relink with another quantity
DROP FUNCTION IF EXISTS public.relink_batch_bill(uuid, jsonb, jsonb, uuid, text);
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

-- ================================================================ 2. expenses typed in, and a type on every expense
ALTER TABLE public.zoho_cost_documents DROP CONSTRAINT IF EXISTS zoho_cost_documents_source_check;
ALTER TABLE public.zoho_cost_documents ADD CONSTRAINT zoho_cost_documents_source_check
  CHECK (source IN ('expense', 'bill', 'manual'));
-- '' = not chosen (the page guesses from the Zoho account name).
ALTER TABLE public.zoho_cost_documents ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE public.zoho_cost_documents DROP CONSTRAINT IF EXISTS zoho_cost_documents_category_check;
ALTER TABLE public.zoho_cost_documents ADD CONSTRAINT zoho_cost_documents_category_check
  CHECK (category IN ('', 'transport', 'hamali', 'driver_commission', 'partner_commission', 'other'));
-- Who typed a manual expense in (Zoho ones come from Zoho).
ALTER TABLE public.zoho_cost_documents ADD COLUMN IF NOT EXISTS entered_by uuid;
ALTER TABLE public.zoho_cost_documents ADD COLUMN IF NOT EXISTS entered_by_name text NOT NULL DEFAULT '';
ALTER TABLE public.zoho_cost_documents ADD COLUMN IF NOT EXISTS entered_at timestamptz;

ALTER TABLE public.batch_cost_tag_events DROP CONSTRAINT IF EXISTS batch_cost_tag_events_action_check;
ALTER TABLE public.batch_cost_tag_events ADD CONSTRAINT batch_cost_tag_events_action_check
  CHECK (action IN ('tag', 'untag', 'accept_change', 'flag', 'split_on_match', 'join', 'manual_save', 'manual_delete', 'category'));

/** The name a type shows as (also the manual expense's account name, so every list shows it). */
CREATE OR REPLACE FUNCTION private.cost_category_name(_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  SELECT CASE _category WHEN 'transport' THEN 'Transport' WHEN 'hamali' THEN 'Hamali (loading / unloading)'
    WHEN 'driver_commission' THEN 'Driver commission' WHEN 'partner_commission' THEN 'Channel partner commission'
    WHEN 'other' THEN 'Other expense' ELSE '' END
$function$;
REVOKE ALL ON FUNCTION private.cost_category_name(text) FROM PUBLIC, anon, authenticated;

/** A document's own fields as the event log keeps them. */
CREATE OR REPLACE FUNCTION private.cost_doc_json(_document_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT jsonb_build_object('category', d.category, 'date', d.doc_date, 'before_gst', d.amount_before_gst, 'gst', d.gst_amount,
           'claimable', d.gst_claimable, 'cost', d.cost_amount, 'paid_to', d.vendor_name, 'reference', d.doc_number,
           'note', d.description, 'tags', private.cost_tags_json(d.id))
    FROM public.zoho_cost_documents d WHERE d.id = _document_id
$function$;
REVOKE ALL ON FUNCTION private.cost_doc_json(bigint) FROM PUBLIC, anon, authenticated;

/**
 * Saves an expense typed in by an administrator (new when _document_id is NULL, else edits it) and puts it on batches.
 *   _doc  = {category, doc_date, amount_before_gst, gst_amount, gst_claimable, paid_to, reference, note}
 *   _rows = [{batch_id, amount, method, weight}]: the whole expense, to the paisa (one batch, or shared by bags).
 * The counted cost is the amount before GST, plus the GST only when it can't be claimed back, as for Zoho expenses.
 */
CREATE OR REPLACE FUNCTION public.save_manual_batch_expense(_document_id bigint, _doc jsonb, _rows jsonb, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  cat text := btrim(COALESCE(_doc->>'category', ''));
  before_gst numeric(14,2) := round(COALESCE(NULLIF(_doc->>'amount_before_gst', '')::numeric, 0), 2);
  gst numeric(14,2) := round(COALESCE(NULLIF(_doc->>'gst_amount', '')::numeric, 0), 2);
  claimable boolean := COALESCE(NULLIF(_doc->>'gst_claimable', '')::boolean, true);
  on_date date := NULLIF(_doc->>'doc_date', '')::date;
  cost numeric(14,2);
  d public.zoho_cost_documents%ROWTYPE;
  r jsonb;
  b public.batches%ROWTYPE;
  amt numeric(14,2);
  total numeric(14,2) := 0;
  seen uuid[] := '{}';
  ids uuid[];
  before_doc jsonb := '{}'::jsonb;
  doc_id bigint := _document_id;
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can add batch expenses'; END IF;
  IF private.cost_category_name(cat) = '' THEN RAISE EXCEPTION 'Choose what the expense is for'; END IF;
  IF on_date IS NULL THEN RAISE EXCEPTION 'Enter the expense date'; END IF;
  IF on_date > (now() AT TIME ZONE 'Asia/Kolkata')::date + 1 THEN RAISE EXCEPTION 'The expense date is in the future'; END IF;
  IF before_gst <= 0 OR before_gst > 100000000 THEN RAISE EXCEPTION 'Enter the amount before GST'; END IF;
  IF gst < 0 OR gst > before_gst THEN RAISE EXCEPTION 'Enter a valid GST amount'; END IF;
  cost := before_gst + CASE WHEN claimable THEN 0 ELSE gst END;
  IF jsonb_typeof(_rows) <> 'array' OR jsonb_array_length(_rows) = 0 THEN RAISE EXCEPTION 'Choose the batch'; END IF;

  -- The batches first (as tag_batch_costs), then the document.
  ids := ARRAY(SELECT DISTINCT NULLIF(x.value->>'batch_id', '')::uuid FROM jsonb_array_elements(_rows) x WHERE NULLIF(x.value->>'batch_id', '') IS NOT NULL
               UNION SELECT t.batch_id FROM public.batch_cost_tags t WHERE _document_id IS NOT NULL AND t.document_id = _document_id);
  PERFORM 1 FROM public.batches WHERE id = ANY (ids) ORDER BY id FOR SHARE;
  FOR r IN SELECT value FROM jsonb_array_elements(_rows) LOOP
    SELECT * INTO b FROM public.batches WHERE id = NULLIF(r->>'batch_id', '')::uuid;
    IF NOT FOUND OR COALESCE(b.stage, 'received') = 'cancelled' THEN
      RAISE EXCEPTION 'Batch % can''t take expenses', COALESCE(b.batch_code, r->>'batch_id', '?');
    END IF;
    IF b.id = ANY (seen) THEN RAISE EXCEPTION 'Batch % is listed twice', b.batch_code; END IF;
    seen := seen || b.id;
    amt := round(COALESCE(NULLIF(r->>'amount', '')::numeric, 0), 2);
    IF amt <= 0 THEN RAISE EXCEPTION 'Each batch''s share must be more than ₹0'; END IF;
    total := total + amt;
  END LOOP;
  IF total <> cost THEN
    RAISE EXCEPTION 'The batches'' shares add up to ₹%, the expense is ₹%', private.cost_rupees(total), private.cost_rupees(cost);
  END IF;

  IF doc_id IS NULL THEN
    INSERT INTO public.zoho_cost_documents (source, zoho_id, zoho_line_id, doc_number, doc_date, account_name, vendor_name,
      description, amount_before_gst, gst_amount, gst_claimable, cost_amount, accepted_cost_amount, category,
      entered_by, entered_by_name, entered_at, fetched_at)
    VALUES ('manual', 'manual-' || gen_random_uuid()::text, '', left(btrim(COALESCE(_doc->>'reference', '')), 80), on_date,
      private.cost_category_name(cat), left(btrim(COALESCE(_doc->>'paid_to', '')), 120), left(btrim(COALESCE(_doc->>'note', '')), 200),
      before_gst, gst, claimable, cost, cost, cat, _by, left(COALESCE(_by_name, ''), 120), now(), now())
    RETURNING id INTO doc_id;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || doc_id));
    SELECT * INTO d FROM public.zoho_cost_documents WHERE id = doc_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF d.source <> 'manual' THEN RAISE EXCEPTION 'This expense comes from Zoho: correct it in Zoho Books, or re-split it'; END IF;
    IF d.gone_at IS NOT NULL THEN RAISE EXCEPTION 'This expense was deleted'; END IF;
    before_doc := private.cost_doc_json(d.id);
    DELETE FROM public.batch_cost_tags WHERE document_id = d.id;
    UPDATE public.zoho_cost_documents
       SET doc_number = left(btrim(COALESCE(_doc->>'reference', '')), 80), doc_date = on_date, account_name = private.cost_category_name(cat),
           vendor_name = left(btrim(COALESCE(_doc->>'paid_to', '')), 120), description = left(btrim(COALESCE(_doc->>'note', '')), 200),
           amount_before_gst = before_gst, gst_amount = gst, gst_claimable = claimable, cost_amount = cost, accepted_cost_amount = cost,
           category = cat, fetched_at = now()
     WHERE id = d.id;
  END IF;
  INSERT INTO public.batch_cost_tags (document_id, batch_id, amount, method, weight, note, tagged_by, tagged_by_name)
  SELECT doc_id, (x.value->>'batch_id')::uuid, round((x.value->>'amount')::numeric, 2),
         CASE WHEN x.value->>'method' IN ('amount', 'bags', 'percent', 'value', 'weight', 'split') THEN x.value->>'method' ELSE 'amount' END,
         COALESCE(NULLIF(x.value->>'weight', '')::numeric, 0), '', _by, left(COALESCE(_by_name, ''), 120)
    FROM jsonb_array_elements(_rows) x;
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (doc_id, 'manual_save', before_doc, private.cost_doc_json(doc_id), _by, left(COALESCE(_by_name, ''), 120));
  RETURN jsonb_build_object('document_id', doc_id, 'cost_amount', cost, 'tags', private.cost_tags_json(doc_id));
END $function$;
REVOKE ALL ON FUNCTION public.save_manual_batch_expense(bigint, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_manual_batch_expense(bigint, jsonb, jsonb, uuid, text) TO service_role;

/** Deletes an expense typed in: off its batches; the row stays (deleted) for its history. */
CREATE OR REPLACE FUNCTION public.delete_manual_batch_expense(_document_id bigint, _by uuid, _by_name text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  before_doc jsonb;
  removed integer;
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can delete batch expenses'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF d.source <> 'manual' THEN RAISE EXCEPTION 'This expense comes from Zoho: untag it instead'; END IF;
  IF d.gone_at IS NOT NULL THEN RETURN 0; END IF;
  before_doc := private.cost_doc_json(d.id);
  DELETE FROM public.batch_cost_tags WHERE document_id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE public.zoho_cost_documents SET gone_at = now(), accepted_cost_amount = NULL, flag = '', flag_at = NULL WHERE id = d.id;
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (d.id, 'manual_delete', before_doc, '{}'::jsonb, _by, left(COALESCE(_by_name, ''), 120));
  RETURN removed;
END $function$;
REVOKE ALL ON FUNCTION public.delete_manual_batch_expense(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_manual_batch_expense(bigint, uuid, text) TO service_role;

/** Sets what an expense is for (any expense; a manual one always has a type). */
CREATE OR REPLACE FUNCTION public.set_cost_document_category(_document_id bigint, _category text, _by uuid, _by_name text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  d public.zoho_cost_documents%ROWTYPE;
  cat text := btrim(COALESCE(_category, ''));
BEGIN
  IF NOT private.cost_actor_is_admin(_by) THEN RAISE EXCEPTION 'Only administrators can change batch expenses'; END IF;
  IF cat <> '' AND private.cost_category_name(cat) = '' THEN RAISE EXCEPTION 'Unknown expense type'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('batch_cost:' || _document_id));
  SELECT * INTO d FROM public.zoho_cost_documents WHERE id = _document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF d.source = 'manual' AND cat = '' THEN RAISE EXCEPTION 'Choose what the expense is for'; END IF;
  IF d.category = cat THEN RETURN cat; END IF;
  UPDATE public.zoho_cost_documents
     SET category = cat, account_name = CASE WHEN d.source = 'manual' THEN private.cost_category_name(cat) ELSE account_name END
   WHERE id = d.id;
  INSERT INTO public.batch_cost_tag_events (document_id, action, before, after, by_id, by_name)
  VALUES (d.id, 'category', jsonb_build_object('category', d.category), jsonb_build_object('category', cat), _by, left(COALESCE(_by_name, ''), 120));
  RETURN cat;
END $function$;
REVOKE ALL ON FUNCTION public.set_cost_document_category(bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cost_document_category(bigint, text, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
