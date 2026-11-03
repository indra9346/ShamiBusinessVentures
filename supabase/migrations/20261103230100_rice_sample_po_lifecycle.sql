-- Rice sample desk, after a live test on 3 Nov 2026: a purchase order removed or cancelled in Zoho left its sample
-- locked for good. Now the two sides stay in step:
--
--   * When Zoho says a purchase order is dead (cancelled, rejected or deleted), rice_sample_po_mark_dead moves it to
--     retired_pos, which only ever grows, and the sample comes back into play with its tests and history.
--   * A new purchase order for that sample gets a new reference (GBS-<id>-2, -3 ...). The old purchase order may still be in
--     Zoho as Cancelled carrying the old reference, so reusing it would make the search find that one instead.
--   * Delete hides a card from every list and keeps everything behind it. It is refused while a purchase order is on its way
--     or alive in Zoho, and it can be undone.
--
-- Nothing here changes a row on its own: a row already raised stays raised until Zoho is asked again.

ALTER TABLE public.rice_sample_purchase_orders ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
-- Every purchase order this sample has had that is now dead in Zoho, oldest first.
ALTER TABLE public.rice_sample_purchase_orders ADD COLUMN IF NOT EXISTS retired_pos jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.rice_sample_purchase_orders DROP CONSTRAINT IF EXISTS rice_sample_purchase_orders_state_check;
-- dead: the last purchase order is dead in Zoho, so nothing is alive and the next one starts a new generation.
ALTER TABLE public.rice_sample_purchase_orders ADD CONSTRAINT rice_sample_purchase_orders_state_check
  CHECK (state IN ('sending', 'uncertain', 'rejected', 'raised', 'dead'));

ALTER TABLE public.rice_samples ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.rice_samples ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.rice_samples ADD COLUMN IF NOT EXISTS deleted_by_name text NOT NULL DEFAULT '';
ALTER TABLE public.rice_samples ADD COLUMN IF NOT EXISTS deleted_reason text NOT NULL DEFAULT '' CHECK (char_length(deleted_reason) <= 500);

-- ---------------------------------------------------------------- Guards

-- A sample with a live purchase order is Zoho's: nothing may change it, except coming back into play once that purchase order is dead.
CREATE OR REPLACE FUNCTION public.rice_samples_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rice samples are not removed from the database. Use Delete on the card, which keeps the history.';
  END IF;
  IF OLD.status = 'selected' AND NOT (
    NEW.status IN ('arrived', 'tested')
    AND EXISTS (SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = NEW.id AND state = 'dead')
  ) THEN
    RAISE EXCEPTION 'This sample is locked: its purchase order is in Zoho.';
  END IF;
  IF NEW.status = 'selected' AND NOT EXISTS (
    SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = NEW.id AND state = 'raised'
  ) THEN
    RAISE EXCEPTION 'A sample is selected only when its purchase order exists in Zoho.';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = NEW.id AND state IN ('sending', 'uncertain', 'raised')
  ) THEN
    RAISE EXCEPTION 'This card cannot be deleted while its purchase order is alive in Zoho or on its way there.';
  END IF;
  RETURN NEW;
END;
$function$;

-- A raised purchase order keeps its Zoho ID until it is retired with a record of what it was, and the record only grows.
CREATE OR REPLACE FUNCTION public.rice_sample_purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A purchase order record is not deleted.';
  END IF;
  IF NOT NEW.retired_pos @> OLD.retired_pos THEN
    RAISE EXCEPTION 'The record of earlier purchase orders is kept.';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'A new purchase order needs a new reference.';
  END IF;
  IF OLD.state = 'raised' AND NEW.state = 'raised' AND (NEW.zoho_po_id <> OLD.zoho_po_id OR NEW.reference <> OLD.reference) THEN
    RAISE EXCEPTION 'A raised purchase order cannot be changed here. Zoho is in control of it.';
  END IF;
  IF OLD.state = 'raised' AND NEW.state <> 'raised' AND (
    NEW.state <> 'dead' OR jsonb_array_length(NEW.retired_pos) <= jsonb_array_length(OLD.retired_pos)
  ) THEN
    RAISE EXCEPTION 'A raised purchase order cannot be changed here. Zoho is in control of it.';
  END IF;
  IF OLD.state = 'dead' AND NEW.state <> 'dead' AND (NEW.generation <= OLD.generation OR NEW.reference = OLD.reference) THEN
    RAISE EXCEPTION 'A new purchase order needs a new reference.';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------- Admin actions (called from the admin's page)

CREATE OR REPLACE FUNCTION public.rice_sample_save(
  _id uuid, _arrival_date date, _variety text, _method text, _price_per_qntl numeric, _quantity_qntl numeric,
  _party_role text, _party_name text, _party_phone text, _seller_name text, _notes text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  who uuid := auth.uid();
  who_name text;
  phone text := regexp_replace(COALESCE(_party_phone, ''), '[^0-9]', '', 'g');
  old_row public.rice_samples;
  changes text[] := '{}';
  new_id uuid;
BEGIN
  IF who IS NULL OR NOT public.has_role(who, 'admin') THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  who_name := COALESCE(public.rice_sample_actor_name(who), 'Admin');
  IF _arrival_date IS NULL OR _arrival_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'The arrival date cannot be in the future'; END IF;
  IF btrim(COALESCE(_variety, '')) = '' THEN RAISE EXCEPTION 'Enter the rice variety'; END IF;
  IF _price_per_qntl IS NULL OR round(_price_per_qntl, 2) <= 0 THEN RAISE EXCEPTION 'Enter the purchase price per quintal'; END IF;
  IF _price_per_qntl >= 1000000 THEN RAISE EXCEPTION 'The price is too high. It should be rupees per quintal.'; END IF;
  IF _quantity_qntl IS NULL OR round(_quantity_qntl, 3) <= 0 THEN RAISE EXCEPTION 'Enter the quantity available in quintals'; END IF;
  IF _quantity_qntl >= 1000000 THEN RAISE EXCEPTION 'The quantity is too high. It should be in quintals.'; END IF;
  IF char_length(btrim(_variety)) > 80 OR char_length(btrim(COALESCE(_method, ''))) > 80 THEN RAISE EXCEPTION 'The rice variety and method can be 80 characters at most'; END IF;
  IF COALESCE(_party_role, '') NOT IN ('broker', 'seller') THEN RAISE EXCEPTION 'Choose broker or seller'; END IF;
  IF btrim(COALESCE(_party_name, '')) = '' THEN RAISE EXCEPTION 'Enter the broker or seller name'; END IF;
  IF phone !~ '^[0-9]{10,13}$' THEN RAISE EXCEPTION 'Enter a phone number with 10 digits'; END IF;
  IF char_length(btrim(_party_name)) > 120 OR char_length(btrim(COALESCE(_seller_name, ''))) > 120 THEN RAISE EXCEPTION 'A name can be 120 characters at most'; END IF;
  IF char_length(btrim(COALESCE(_notes, ''))) > 1000 THEN RAISE EXCEPTION 'Notes can be 1,000 characters at most'; END IF;

  IF _id IS NULL THEN
    INSERT INTO public.rice_samples (arrival_date, variety, method, price_per_qntl, quantity_qntl, party_role, party_name,
      party_phone, seller_name, notes, created_by, created_by_name)
    VALUES (_arrival_date, btrim(_variety), btrim(COALESCE(_method, '')), _price_per_qntl, _quantity_qntl, _party_role,
      btrim(_party_name), phone, btrim(COALESCE(_seller_name, '')), btrim(COALESCE(_notes, '')), who, who_name)
    RETURNING id INTO new_id;
    INSERT INTO public.rice_sample_events (sample_id, action, to_status, actor, actor_name)
    VALUES (new_id, 'arrived', 'arrived', who, who_name);
    RETURN new_id;
  END IF;

  SELECT * INTO old_row FROM public.rice_samples WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  IF old_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This card is deleted. Restore it first.'; END IF;
  IF old_row.status NOT IN ('arrived', 'tested') THEN RAISE EXCEPTION 'Only a sample still in play can be edited. Reopen it first.'; END IF;
  IF EXISTS (SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = _id AND state IN ('sending', 'uncertain', 'raised')) THEN
    RAISE EXCEPTION 'A purchase order for this sample is on its way to Zoho. Check Zoho first.';
  END IF;
  IF old_row.price_per_qntl <> _price_per_qntl THEN changes := changes || format('Price %s to %s per quintal', old_row.price_per_qntl, _price_per_qntl); END IF;
  IF old_row.quantity_qntl <> _quantity_qntl THEN changes := changes || format('Quantity %s to %s quintal', old_row.quantity_qntl, _quantity_qntl); END IF;
  IF old_row.party_name <> btrim(_party_name) OR old_row.party_role <> _party_role THEN changes := changes || format('Dealing with %s (%s) to %s (%s)', old_row.party_name, old_row.party_role, btrim(_party_name), _party_role); END IF;
  IF old_row.party_phone <> phone THEN changes := changes || 'Phone number changed'::text; END IF;
  IF old_row.variety <> btrim(_variety) OR old_row.method <> btrim(COALESCE(_method, '')) THEN changes := changes || format('Rice %s %s to %s %s', old_row.variety, old_row.method, btrim(_variety), btrim(COALESCE(_method, ''))); END IF;
  IF old_row.arrival_date <> _arrival_date THEN changes := changes || format('Arrival %s to %s', old_row.arrival_date, _arrival_date); END IF;
  IF old_row.seller_name <> btrim(COALESCE(_seller_name, '')) THEN changes := changes || format('Seller %s to %s', COALESCE(NULLIF(old_row.seller_name, ''), 'none'), COALESCE(NULLIF(btrim(COALESCE(_seller_name, '')), ''), 'none')); END IF;
  IF old_row.notes <> btrim(COALESCE(_notes, '')) THEN changes := changes || 'Notes changed'::text; END IF;
  UPDATE public.rice_samples SET arrival_date = _arrival_date, variety = btrim(_variety), method = btrim(COALESCE(_method, '')),
    price_per_qntl = _price_per_qntl, quantity_qntl = _quantity_qntl, party_role = _party_role, party_name = btrim(_party_name),
    party_phone = phone, seller_name = btrim(COALESCE(_seller_name, '')), notes = btrim(COALESCE(_notes, '')), updated_at = now()
    WHERE id = _id;
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_id, 'edited', COALESCE(array_to_string(changes, '; '), ''), who, who_name);
  RETURN _id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rice_sample_add_test(
  _sample_id uuid, _tested_at timestamptz, _tested_by_name text, _score integer, _grain text, _swelling text, _taste text, _broken text, _notes text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  who uuid := auth.uid();
  who_name text;
  old_row public.rice_samples;
  new_id uuid;
BEGIN
  IF who IS NULL OR NOT public.has_role(who, 'admin') THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  who_name := COALESCE(public.rice_sample_actor_name(who), 'Admin');
  IF _score IS NULL OR _score NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Choose a score from 1 to 10'; END IF;
  IF COALESCE(_grain, '') NOT IN ('separate', 'slightly_sticky', 'sticky') THEN RAISE EXCEPTION 'Choose how the cooked grain came out'; END IF;
  IF COALESCE(_swelling, '') NOT IN ('good', 'ok', 'poor') THEN RAISE EXCEPTION 'Choose how well it swelled'; END IF;
  IF COALESCE(_taste, '') NOT IN ('good', 'ok', 'off') THEN RAISE EXCEPTION 'Choose the taste and smell'; END IF;
  IF COALESCE(_broken, '') NOT IN ('few', 'some', 'many') THEN RAISE EXCEPTION 'Choose how many grains are broken'; END IF;
  IF btrim(COALESCE(_tested_by_name, '')) = '' THEN RAISE EXCEPTION 'Enter who tested it'; END IF;
  IF char_length(btrim(_tested_by_name)) > 120 THEN RAISE EXCEPTION 'A name can be 120 characters at most'; END IF;
  IF char_length(btrim(COALESCE(_notes, ''))) > 1000 THEN RAISE EXCEPTION 'Notes can be 1,000 characters at most'; END IF;
  IF _tested_at IS NOT NULL AND _tested_at > now() + interval '10 minutes' THEN RAISE EXCEPTION 'The test time cannot be in the future'; END IF;
  SELECT * INTO old_row FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  IF old_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This card is deleted. Restore it first.'; END IF;
  IF old_row.status NOT IN ('arrived', 'tested') THEN RAISE EXCEPTION 'This sample is no longer in play.'; END IF;
  IF EXISTS (SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id AND state IN ('sending', 'uncertain', 'raised')) THEN
    RAISE EXCEPTION 'A purchase order for this sample is on its way to Zoho. Check Zoho first.';
  END IF;
  INSERT INTO public.rice_sample_tests (sample_id, tested_at, tested_by_name, score, grain, swelling, taste, broken, notes, recorded_by)
  VALUES (_sample_id, COALESCE(_tested_at, now()), btrim(_tested_by_name), _score, _grain, _swelling, _taste, _broken, btrim(COALESCE(_notes, '')), who)
  RETURNING id INTO new_id;
  IF old_row.status = 'arrived' THEN
    UPDATE public.rice_samples SET status = 'tested', status_reason = '', status_changed_at = now(), updated_at = now() WHERE id = _sample_id;
  ELSE
    UPDATE public.rice_samples SET updated_at = now() WHERE id = _sample_id;
  END IF;
  INSERT INTO public.rice_sample_events (sample_id, action, from_status, to_status, detail, actor, actor_name)
  VALUES (_sample_id, 'tested', old_row.status, 'tested', format('Cook test %s/10 by %s', _score, btrim(_tested_by_name)), who, who_name);
  RETURN new_id;
END;
$function$;

/**
 * Discard (a reason is required), mark unavailable, reopen, delete the card or restore it. None of these can happen while a
 * purchase order is on its way or alive in Zoho.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_set_status(_sample_id uuid, _action text, _reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  who uuid := auth.uid();
  who_name text;
  old_row public.rice_samples;
  reason text := btrim(COALESCE(_reason, ''));
  next_status text;
BEGIN
  IF who IS NULL OR NOT public.has_role(who, 'admin') THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  who_name := COALESCE(public.rice_sample_actor_name(who), 'Admin');
  SELECT * INTO old_row FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id AND state IN ('sending', 'uncertain', 'raised')) THEN
    RAISE EXCEPTION 'A purchase order for this sample exists or is on its way to Zoho, so its status cannot change here.';
  END IF;

  IF _action = 'delete' THEN
    IF old_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This card is already deleted.'; END IF;
    UPDATE public.rice_samples SET deleted_at = now(), deleted_by = who, deleted_by_name = who_name, deleted_reason = left(reason, 500), updated_at = now() WHERE id = _sample_id;
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
    VALUES (_sample_id, 'deleted', left(reason, 500), who, who_name);
    RETURN old_row.status;
  END IF;
  IF _action = 'restore' THEN
    IF old_row.deleted_at IS NULL THEN RAISE EXCEPTION 'This card is not deleted.'; END IF;
    UPDATE public.rice_samples SET deleted_at = NULL, deleted_by = NULL, deleted_by_name = '', deleted_reason = '', updated_at = now() WHERE id = _sample_id;
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
    VALUES (_sample_id, 'restored', left(reason, 500), who, who_name);
    RETURN old_row.status;
  END IF;
  IF old_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This card is deleted. Restore it first.'; END IF;

  IF _action = 'discard' THEN
    IF old_row.status NOT IN ('arrived', 'tested') THEN RAISE EXCEPTION 'Only a sample still in play can be discarded.'; END IF;
    IF char_length(reason) < 3 THEN RAISE EXCEPTION 'Enter why this sample is discarded'; END IF;
    next_status := 'discarded';
  ELSIF _action = 'unavailable' THEN
    IF old_row.status NOT IN ('arrived', 'tested') THEN RAISE EXCEPTION 'Only a sample still in play can be marked unavailable.'; END IF;
    next_status := 'unavailable';
  ELSIF _action = 'reopen' THEN
    IF old_row.status NOT IN ('discarded', 'unavailable') THEN RAISE EXCEPTION 'Only a discarded or unavailable sample can be reopened.'; END IF;
    next_status := CASE WHEN EXISTS (SELECT 1 FROM public.rice_sample_tests WHERE sample_id = _sample_id) THEN 'tested' ELSE 'arrived' END;
  ELSE
    RAISE EXCEPTION 'Unknown action';
  END IF;
  UPDATE public.rice_samples SET status = next_status, status_reason = CASE WHEN _action = 'reopen' THEN '' ELSE left(reason, 500) END,
    status_changed_at = now(), updated_at = now() WHERE id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, from_status, to_status, detail, actor, actor_name)
  VALUES (_sample_id, _action, old_row.status, next_status, left(reason, 500), who, who_name);
  RETURN next_status;
END;
$function$;

-- ---------------------------------------------------------------- Purchase order lock (server only)

/**
 * The one way to start a purchase order. The sample's row is locked first, so two callers are served one after
 * the other. The answer says what the caller may do:
 *   claimed         this caller, and only this caller, may send it to Zoho now
 *   already_raised  it exists; show it
 *   in_progress     another request is sending it right now
 *   verify_first    an earlier send may have reached Zoho: search Zoho by reference before anything else
 * After a dead purchase order, a claim starts the next generation, which must come with that generation's own reference.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_po_claim(
  _sample_id uuid, _attempt_id uuid, _reference text, _snapshot jsonb, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  sample public.rice_samples;
  po public.rice_sample_purchase_orders;
BEGIN
  SELECT * INTO sample FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id;
  IF FOUND AND po.state = 'raised' THEN
    RETURN jsonb_build_object('outcome', 'already_raised', 'po', to_jsonb(po));
  END IF;
  IF FOUND AND po.state = 'sending' AND po.claimed_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('outcome', 'in_progress', 'by', po.claimed_by_name, 'since', po.claimed_at);
  END IF;
  IF FOUND AND po.state IN ('sending', 'uncertain') THEN
    RETURN jsonb_build_object('outcome', 'verify_first', 'attempt_id', po.attempt_id, 'claimed_at', po.claimed_at, 'snapshot', po.snapshot, 'attempts', po.attempts);
  END IF;
  IF sample.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This card is deleted. Restore it first.'; END IF;
  IF sample.status NOT IN ('arrived', 'tested') THEN
    RAISE EXCEPTION 'This sample is % so a purchase order cannot be raised. Reopen it first.', sample.status;
  END IF;
  IF FOUND AND po.state = 'dead' THEN
    IF _reference IS DISTINCT FROM format('GBS-%s-%s', _sample_id, po.generation + 1) THEN
      RAISE EXCEPTION 'This purchase order has changed. Review it and confirm again.';
    END IF;
    UPDATE public.rice_sample_purchase_orders SET state = 'sending', reference = _reference, generation = generation + 1, attempt_id = _attempt_id, attempts = 1,
      snapshot = _snapshot, claimed_by = _user, claimed_by_name = COALESCE(_user_name, ''), claimed_at = now(), last_error = '', last_error_detail = '', updated_at = now()
      WHERE sample_id = _sample_id;
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
    VALUES (_sample_id, 'po_started', format('Sending to Zoho: reference %s', _reference), _user, COALESCE(_user_name, ''));
    RETURN jsonb_build_object('outcome', 'claimed', 'attempts', 1);
  END IF;
  -- The server read this row earlier. If it has moved on since, the search and the purchase order would use a reference this row doesn't hold.
  IF FOUND AND po.reference IS DISTINCT FROM _reference THEN
    RAISE EXCEPTION 'This purchase order has changed. Review it and confirm again.';
  END IF;
  INSERT INTO public.rice_sample_purchase_orders (sample_id, reference, state, attempt_id, attempts, snapshot, claimed_by, claimed_by_name, claimed_at)
  VALUES (_sample_id, _reference, 'sending', _attempt_id, 1, _snapshot, _user, COALESCE(_user_name, ''), now())
  ON CONFLICT (sample_id) DO UPDATE SET state = 'sending', attempt_id = EXCLUDED.attempt_id,
    attempts = public.rice_sample_purchase_orders.attempts + 1, snapshot = EXCLUDED.snapshot, claimed_by = EXCLUDED.claimed_by,
    claimed_by_name = EXCLUDED.claimed_by_name, claimed_at = now(), last_error = '', last_error_detail = '', updated_at = now();
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_sample_id, 'po_started', format('Sending to Zoho: reference %s', _reference), _user, COALESCE(_user_name, ''));
  RETURN jsonb_build_object('outcome', 'claimed', 'attempts', COALESCE(po.attempts, 0) + 1);
END;
$function$;

/**
 * Zoho says this purchase order is dead: cancelled, rejected or deleted. Retires it and brings the sample back into play. Only
 * for the exact purchase order that is raised: anything else answers "changed" and touches nothing, so two callers are safe.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_po_mark_dead(
  _sample_id uuid, _po_id text, _reason text, _zoho_status text, _note text, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  sample public.rice_samples;
  po public.rice_sample_purchase_orders;
  next_status text;
  actor_name text := COALESCE(NULLIF(btrim(_user_name), ''), 'Zoho');
  note text := left(btrim(COALESCE(_note, '')), 500);
BEGIN
  IF COALESCE(_reason, '') NOT IN ('cancelled', 'rejected', 'deleted') THEN RAISE EXCEPTION 'Unknown reason'; END IF;
  IF COALESCE(_po_id, '') = '' THEN RAISE EXCEPTION 'A Zoho purchase order ID is required'; END IF;
  SELECT * INTO sample FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id;
  IF NOT FOUND OR po.state <> 'raised' OR po.zoho_po_id <> _po_id THEN
    RETURN jsonb_build_object('outcome', 'changed');
  END IF;
  next_status := CASE WHEN EXISTS (SELECT 1 FROM public.rice_sample_tests WHERE sample_id = _sample_id) THEN 'tested' ELSE 'arrived' END;
  UPDATE public.rice_sample_purchase_orders SET state = 'dead',
    retired_pos = retired_pos || COALESCE((SELECT jsonb_agg(jsonb_build_object('generation', po.generation, 'reference', po.reference, 'id', dup->>'id', 'number', COALESCE(dup->>'number', ''),
        'status', COALESCE(dup->>'status', ''), 'reason', 'duplicate', 'retired_at', now(), 'retired_by', actor_name, 'note', ''))
      FROM jsonb_array_elements(po.duplicates) AS dup WHERE NOT po.retired_pos @> jsonb_build_array(jsonb_build_object('id', dup->>'id'))), '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'generation', po.generation, 'reference', po.reference, 'id', po.zoho_po_id, 'number', po.zoho_po_number, 'status', COALESCE(NULLIF(_zoho_status, ''), po.zoho_po_status),
      'reason', _reason, 'total', po.zoho_total, 'vendor_name', po.snapshot->>'vendorName', 'quantity_qntl', po.snapshot->'quantityQntl', 'rate_per_qntl', po.snapshot->'ratePerQntl',
      'raised_at', po.raised_at, 'raised_by_name', po.raised_by_name, 'retired_at', now(), 'retired_by', actor_name, 'note', note)),
    zoho_po_id = '', zoho_po_number = '', zoho_po_status = '', zoho_sub_total = NULL, zoho_tax_total = NULL, zoho_total = NULL, differences = '{}', duplicates = '[]'::jsonb,
    zoho_gone = false, zoho_checked_at = now(), raised_at = NULL, raised_by = NULL, raised_by_name = '', last_error = '', last_error_detail = '', updated_at = now()
    WHERE sample_id = _sample_id;
  UPDATE public.rice_samples SET status = next_status, status_reason = '', status_changed_at = now(), updated_at = now() WHERE id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, from_status, to_status, detail, actor, actor_name)
  VALUES (_sample_id, 'po_dead', sample.status, next_status,
    format('Purchase order %s is %s in Zoho. The sample is back in play.%s', po.zoho_po_number, _reason, CASE WHEN note = '' THEN '' ELSE ' ' || note END),
    _user, actor_name);
  RETURN jsonb_build_object('outcome', 'freed', 'number', po.zoho_po_number, 'reason', _reason, 'status', next_status);
END;
$function$;

/**
 * Records the purchase order Zoho holds and locks the sample. Never loses a Zoho ID: the same ID again changes
 * nothing, and a different ID on an already raised sample is kept as a duplicate for a person to deal with.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_po_record(
  _sample_id uuid, _po_id text, _po_number text, _po_status text, _sub_total numeric, _tax_total numeric, _total numeric,
  _differences text[], _found_by_search boolean, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  sample public.rice_samples;
  po public.rice_sample_purchase_orders;
BEGIN
  IF COALESCE(_po_id, '') = '' THEN RAISE EXCEPTION 'A Zoho purchase order ID is required'; END IF;
  SELECT * INTO sample FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No purchase order was started for this sample'; END IF;
  IF po.state = 'dead' THEN RAISE EXCEPTION 'This purchase order is retired. Start a new one.'; END IF;
  IF po.state = 'raised' THEN
    IF po.zoho_po_id = _po_id THEN RETURN jsonb_build_object('outcome', 'same', 'po', to_jsonb(po)); END IF;
    IF NOT po.duplicates @> jsonb_build_array(jsonb_build_object('id', _po_id)) THEN
      UPDATE public.rice_sample_purchase_orders SET duplicates = duplicates || jsonb_build_array(jsonb_build_object('id', _po_id, 'number', COALESCE(_po_number, ''), 'status', COALESCE(_po_status, ''))),
        updated_at = now() WHERE sample_id = _sample_id RETURNING * INTO po;
      INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
      VALUES (_sample_id, 'po_duplicate', format('Zoho also holds purchase order %s with this reference', COALESCE(_po_number, _po_id)), _user, COALESCE(_user_name, ''));
    END IF;
    RETURN jsonb_build_object('outcome', 'duplicate', 'po', to_jsonb(po));
  END IF;
  UPDATE public.rice_sample_purchase_orders SET state = 'raised', zoho_po_id = _po_id, zoho_po_number = COALESCE(_po_number, ''),
    zoho_po_status = COALESCE(_po_status, ''), zoho_sub_total = _sub_total, zoho_tax_total = _tax_total, zoho_total = _total,
    differences = COALESCE(_differences, '{}'), zoho_checked_at = now(), raised_at = now(), raised_by = _user,
    raised_by_name = COALESCE(_user_name, ''), last_error = '', last_error_detail = '', updated_at = now()
    WHERE sample_id = _sample_id RETURNING * INTO po;
  -- A purchase order Zoho really holds is never lost because the card was deleted meanwhile: the card comes back.
  UPDATE public.rice_samples SET status = 'selected', status_reason = '', status_changed_at = now(), updated_at = now(),
    deleted_at = NULL, deleted_by = NULL, deleted_by_name = '', deleted_reason = '' WHERE id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, from_status, to_status, detail, actor, actor_name)
  VALUES (_sample_id, 'po_raised', sample.status, 'selected',
    format('Purchase order %s (%s)%s%s', COALESCE(_po_number, _po_id), COALESCE(_po_status, ''), CASE WHEN _found_by_search THEN ', found in Zoho by its reference' ELSE '' END,
      CASE WHEN sample.deleted_at IS NOT NULL THEN '. The deleted card is back, because Zoho holds this purchase order.' ELSE '' END),
    _user, COALESCE(_user_name, ''));
  RETURN jsonb_build_object('outcome', 'recorded', 'po', to_jsonb(po));
END;
$function$;

/**
 * Writes what Zoho said about a raised purchase order. _po_id: only if it is still this purchase order, so a check that was slow
 * can't write its answer onto a newer one. Optional because the site still running during an upload doesn't send it.
 */
DROP FUNCTION IF EXISTS public.rice_sample_po_refresh(uuid, text, numeric, numeric, numeric, boolean, jsonb);
CREATE OR REPLACE FUNCTION public.rice_sample_po_refresh(
  _sample_id uuid, _po_status text, _sub_total numeric, _tax_total numeric, _total numeric, _gone boolean, _duplicates jsonb, _po_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  po public.rice_sample_purchase_orders;
BEGIN
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id AND state = 'raised' AND (_po_id IS NULL OR zoho_po_id = _po_id) FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.rice_sample_purchase_orders SET zoho_po_status = COALESCE(_po_status, zoho_po_status), zoho_sub_total = COALESCE(_sub_total, zoho_sub_total),
    zoho_tax_total = COALESCE(_tax_total, zoho_tax_total), zoho_total = COALESCE(_total, zoho_total), zoho_gone = COALESCE(_gone, false),
    duplicates = COALESCE(_duplicates, duplicates), zoho_checked_at = now(), updated_at = now()
    WHERE sample_id = _sample_id;
  IF COALESCE(_gone, false) AND NOT po.zoho_gone THEN
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor_name)
    VALUES (_sample_id, 'po_status', format('Zoho no longer has purchase order %s', po.zoho_po_number), 'Zoho');
  ELSIF COALESCE(_po_status, po.zoho_po_status) <> po.zoho_po_status THEN
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor_name)
    VALUES (_sample_id, 'po_status', format('Status in Zoho: %s to %s', po.zoho_po_status, _po_status), 'Zoho');
  END IF;
END;
$function$;

/** Who asked Zoho to cancel, and why, on the history before the request goes out, so it stays there whatever Zoho answers. */
CREATE OR REPLACE FUNCTION public.rice_sample_po_cancel_asked(_sample_id uuid, _po_number text, _reason text, _user uuid, _user_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_sample_id, 'po_cancel_asked', format('Asked Zoho to cancel %s: %s', _po_number, left(btrim(COALESCE(_reason, '')), 300)), _user, COALESCE(_user_name, ''));
END;
$function$;

-- ---------------------------------------------------------------- Asking Zoho while the page is open (server only)

-- One check at a time across every open page, and a longer wait after one fails, because Zoho locks the whole site out if asked too often.
CREATE TABLE IF NOT EXISTS public.rice_sample_po_poll (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  next_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rice_sample_po_poll ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rice_sample_po_poll FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rice_sample_po_poll TO service_role;

/** True for one caller per gap: however many pages ask together, only one goes on to Zoho. */
CREATE OR REPLACE FUNCTION public.rice_sample_po_poll_claim(_gap_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  claimed integer;
BEGIN
  INSERT INTO public.rice_sample_po_poll (id, next_at) VALUES (true, now() + make_interval(secs => _gap_seconds))
  ON CONFLICT (id) DO UPDATE SET next_at = EXCLUDED.next_at WHERE public.rice_sample_po_poll.next_at <= now();
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed > 0;
END;
$function$;

/** After a failed check: no page asks again for this long. Never shortens a wait. */
CREATE OR REPLACE FUNCTION public.rice_sample_po_poll_hold(_seconds integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  INSERT INTO public.rice_sample_po_poll (id, next_at) VALUES (true, now() + make_interval(secs => _seconds))
  ON CONFLICT (id) DO UPDATE SET next_at = GREATEST(public.rice_sample_po_poll.next_at, EXCLUDED.next_at);
$function$;

REVOKE ALL ON FUNCTION public.rice_sample_po_mark_dead(uuid, text, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_mark_dead(uuid, text, text, text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rice_sample_po_refresh(uuid, text, numeric, numeric, numeric, boolean, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_refresh(uuid, text, numeric, numeric, numeric, boolean, jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.rice_sample_po_cancel_asked(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_cancel_asked(uuid, text, text, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rice_sample_po_poll_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_poll_claim(integer) TO service_role;
REVOKE ALL ON FUNCTION public.rice_sample_po_poll_hold(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_poll_hold(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
