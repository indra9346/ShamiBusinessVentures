-- Rice sample and purchase desk (client's note, 2 Nov 2026). Samples arrive with a purchase price, the
-- quantity available and the broker or seller; the business cooks and tests them, compares them, and raises
-- one Zoho purchase order for the sample it chooses. After that Zoho is in control and the sample is locked.
--
--   * rice_samples: one row per sample. Prices and contacts: admins only.
--   * rice_sample_tests: every cook test, kept. Nothing overwrites an earlier result.
--   * rice_sample_events: who did what and when. Written only by the functions below.
--   * rice_sample_purchase_orders: at most one row per sample (the primary key). This row is the lock that
--     stops a second purchase order, whatever the cause: double tap, retry, timeout or two admins.
--   * rice_sample_zoho_creations: the same protection for a new Zoho vendor or item.
--
-- The browser cannot write to any of these tables. An admin's page calls the rice_sample_save, _add_test and
-- _set_status functions, which check the admin role. The purchase order functions are for the server only.

CREATE TABLE IF NOT EXISTS public.rice_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A short number to write on the sample bag, so a test lands on the right one.
  sample_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  arrival_date date NOT NULL,
  variety text NOT NULL CHECK (char_length(btrim(variety)) BETWEEN 1 AND 80),
  method text NOT NULL DEFAULT '' CHECK (char_length(method) <= 80),
  -- Rupees per quintal (100 kg) before GST, the same unit as price_lots.
  price_per_qntl numeric(12,2) NOT NULL CHECK (price_per_qntl > 0 AND price_per_qntl < 1000000),
  quantity_qntl numeric(12,3) NOT NULL CHECK (quantity_qntl > 0 AND quantity_qntl < 1000000),
  -- The person the business deals with, and whether that person is a broker or the seller.
  party_role text NOT NULL CHECK (party_role IN ('broker', 'seller')),
  party_name text NOT NULL CHECK (char_length(btrim(party_name)) BETWEEN 1 AND 120),
  party_phone text NOT NULL CHECK (party_phone ~ '^[0-9]{10,13}$'),
  -- The mill or owner behind a broker, when known.
  seller_name text NOT NULL DEFAULT '' CHECK (char_length(seller_name) <= 120),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'arrived' CHECK (status IN ('arrived', 'tested', 'selected', 'discarded', 'unavailable')),
  status_reason text NOT NULL DEFAULT '' CHECK (char_length(status_reason) <= 500),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rice_samples_status_idx ON public.rice_samples (status, arrival_date DESC);

CREATE TABLE IF NOT EXISTS public.rice_sample_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id uuid NOT NULL REFERENCES public.rice_samples(id) ON DELETE RESTRICT,
  tested_at timestamptz NOT NULL DEFAULT now(),
  tested_by_name text NOT NULL CHECK (char_length(btrim(tested_by_name)) BETWEEN 1 AND 120),
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 10),
  grain text NOT NULL CHECK (grain IN ('separate', 'slightly_sticky', 'sticky')),
  swelling text NOT NULL CHECK (swelling IN ('good', 'ok', 'poor')),
  taste text NOT NULL CHECK (taste IN ('good', 'ok', 'off')),
  broken text NOT NULL CHECK (broken IN ('few', 'some', 'many')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rice_sample_tests_sample_idx ON public.rice_sample_tests (sample_id, tested_at DESC);

CREATE TABLE IF NOT EXISTS public.rice_sample_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sample_id uuid NOT NULL REFERENCES public.rice_samples(id) ON DELETE RESTRICT,
  action text NOT NULL,
  from_status text,
  to_status text,
  detail text NOT NULL DEFAULT '',
  actor uuid,
  actor_name text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rice_sample_events_sample_idx ON public.rice_sample_events (sample_id, at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.rice_sample_purchase_orders (
  sample_id uuid PRIMARY KEY REFERENCES public.rice_samples(id) ON DELETE RESTRICT,
  -- What goes into Zoho's Reference# field, and how the purchase order is found again after a timeout.
  reference text NOT NULL UNIQUE,
  -- sending: a request may be on its way. uncertain: Zoho may or may not have created it.
  -- rejected: Zoho refused, so nothing exists. raised: the purchase order exists.
  state text NOT NULL CHECK (state IN ('sending', 'uncertain', 'rejected', 'raised')),
  attempt_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  -- Exactly what the admin confirmed: vendor, item, quantity, rate, total, godown.
  snapshot jsonb NOT NULL,
  claimed_by uuid,
  claimed_by_name text NOT NULL DEFAULT '',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT '',
  last_error_detail text NOT NULL DEFAULT '',
  zoho_po_id text NOT NULL DEFAULT '',
  zoho_po_number text NOT NULL DEFAULT '',
  zoho_po_status text NOT NULL DEFAULT '',
  zoho_sub_total numeric(14,2),
  zoho_tax_total numeric(14,2),
  zoho_total numeric(14,2),
  -- Where Zoho's copy differs from what was confirmed, in plain words. Empty when they agree.
  differences text[] NOT NULL DEFAULT '{}',
  -- Any further purchase orders Zoho holds with this reference: [{ id, number, status }]. Normally empty.
  duplicates jsonb NOT NULL DEFAULT '[]'::jsonb,
  zoho_gone boolean NOT NULL DEFAULT false,
  zoho_checked_at timestamptz,
  raised_at timestamptz,
  raised_by uuid,
  raised_by_name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'raised' OR zoho_po_id <> '')
);

CREATE TABLE IF NOT EXISTS public.rice_sample_zoho_creations (
  kind text NOT NULL CHECK (kind IN ('vendor', 'item')),
  name_key text NOT NULL,
  display_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'uncertain', 'rejected', 'done')),
  attempt_id uuid NOT NULL,
  zoho_id text NOT NULL DEFAULT '',
  claimed_by uuid,
  claimed_by_name text NOT NULL DEFAULT '',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT '',
  PRIMARY KEY (kind, name_key),
  CHECK (state <> 'done' OR zoho_id <> '')
);

-- ---------------------------------------------------------------- Guards

-- A sample with a purchase order is Zoho's now: nothing may change it, not even the server by mistake.
-- Only a raised purchase order can make a sample "selected".
CREATE OR REPLACE FUNCTION public.rice_samples_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rice samples are not deleted. Discard it instead.';
  END IF;
  IF OLD.status = 'selected' THEN
    RAISE EXCEPTION 'This sample is locked: its purchase order is in Zoho.';
  END IF;
  IF NEW.status = 'selected' AND NOT EXISTS (
    SELECT 1 FROM public.rice_sample_purchase_orders WHERE sample_id = NEW.id AND state = 'raised'
  ) THEN
    RAISE EXCEPTION 'A sample is selected only when its purchase order exists in Zoho.';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS rice_samples_guard ON public.rice_samples;
CREATE TRIGGER rice_samples_guard BEFORE UPDATE OR DELETE ON public.rice_samples
  FOR EACH ROW EXECUTE FUNCTION public.rice_samples_guard();

-- A raised purchase order keeps its Zoho ID for good, and its row is never removed.
CREATE OR REPLACE FUNCTION public.rice_sample_purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A purchase order record is not deleted.';
  END IF;
  IF OLD.state = 'raised' AND (NEW.state <> 'raised' OR NEW.zoho_po_id <> OLD.zoho_po_id OR NEW.reference <> OLD.reference) THEN
    RAISE EXCEPTION 'A raised purchase order cannot be changed here. Zoho is in control of it.';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS rice_sample_purchase_orders_guard ON public.rice_sample_purchase_orders;
CREATE TRIGGER rice_sample_purchase_orders_guard BEFORE UPDATE OR DELETE ON public.rice_sample_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.rice_sample_purchase_orders_guard();

-- Tests and history are added to, never edited or removed.
CREATE OR REPLACE FUNCTION public.rice_sample_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  RAISE EXCEPTION 'Rice sample tests and history are kept. Add a new entry instead.';
END;
$function$;
DROP TRIGGER IF EXISTS rice_sample_tests_append_only ON public.rice_sample_tests;
CREATE TRIGGER rice_sample_tests_append_only BEFORE UPDATE OR DELETE ON public.rice_sample_tests
  FOR EACH ROW EXECUTE FUNCTION public.rice_sample_append_only();
DROP TRIGGER IF EXISTS rice_sample_events_append_only ON public.rice_sample_events;
CREATE TRIGGER rice_sample_events_append_only BEFORE UPDATE OR DELETE ON public.rice_sample_events
  FOR EACH ROW EXECUTE FUNCTION public.rice_sample_append_only();

-- ---------------------------------------------------------------- Admin actions (called from the admin's page)

CREATE OR REPLACE FUNCTION public.rice_sample_actor_name(_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(email), ''), 'Admin') FROM public.profiles WHERE id = _user;
$function$;

/** Adds a sample (_id NULL) or corrects one still in play, noting every change to price and quantity. */
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

/** Adds a cook test. The first one moves the sample from arrived to tested. */
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
 * Discard (a reason is required), mark unavailable (the broker or seller said so) or reopen. None of these
 * can happen while a purchase order is on its way or exists.
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
  IF sample.status NOT IN ('arrived', 'tested') THEN
    RAISE EXCEPTION 'This sample is % so a purchase order cannot be raised. Reopen it first.', sample.status;
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
 * After a complete search of Zoho found nothing: takes over from an earlier send that never answered. Refuses
 * until two minutes after that send (Zoho may still be working on it) and if anyone else has moved on since.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_po_takeover(
  _sample_id uuid, _expected_attempt uuid, _attempt_id uuid, _snapshot jsonb, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  po public.rice_sample_purchase_orders;
  sample public.rice_samples;
BEGIN
  SELECT * INTO sample FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sample not found'; END IF;
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id;
  IF NOT FOUND OR po.state NOT IN ('sending', 'uncertain') OR po.attempt_id <> _expected_attempt THEN
    RETURN jsonb_build_object('outcome', 'changed');
  END IF;
  IF po.claimed_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('outcome', 'too_soon', 'wait_seconds', CEIL(EXTRACT(EPOCH FROM (po.claimed_at + interval '2 minutes' - now()))));
  END IF;
  UPDATE public.rice_sample_purchase_orders SET state = 'sending', attempt_id = _attempt_id, attempts = attempts + 1, snapshot = _snapshot,
    claimed_by = _user, claimed_by_name = COALESCE(_user_name, ''), claimed_at = now(), last_error = '', last_error_detail = '', updated_at = now()
    WHERE sample_id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_sample_id, 'po_retry', 'Zoho had no purchase order with this reference after a full search, so it was sent again', _user, COALESCE(_user_name, ''));
  RETURN jsonb_build_object('outcome', 'claimed', 'attempts', po.attempts + 1);
END;
$function$;

/**
 * After a complete search of Zoho found nothing, two minutes or more after the last send: nothing exists, so the sample is
 * free again. Without this, a rice the broker sold just after a timeout could only be cleared by raising a purchase order.
 * _by_hand: the search could not finish, and an admin looked in Zoho and said it is not there. That goes on the record by name.
 */
CREATE OR REPLACE FUNCTION public.rice_sample_po_release(_sample_id uuid, _expected_attempt uuid, _user uuid, _user_name text, _by_hand boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  po public.rice_sample_purchase_orders;
BEGIN
  PERFORM 1 FROM public.rice_samples WHERE id = _sample_id FOR UPDATE;
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id;
  IF NOT FOUND OR po.state NOT IN ('sending', 'uncertain') OR po.attempt_id <> _expected_attempt THEN
    RETURN jsonb_build_object('outcome', 'changed');
  END IF;
  IF po.claimed_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('outcome', 'too_soon', 'wait_seconds', CEIL(EXTRACT(EPOCH FROM (po.claimed_at + interval '2 minutes' - now()))));
  END IF;
  UPDATE public.rice_sample_purchase_orders SET state = 'rejected',
    last_error = CASE WHEN _by_hand THEN format('%s searched Zoho by hand and found no purchase order for this sample.', COALESCE(_user_name, 'An admin')) ELSE 'Zoho has no purchase order for this sample, after a full search.' END,
    updated_at = now() WHERE sample_id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_sample_id, 'po_released', CASE WHEN _by_hand THEN 'The automatic search could not finish. This admin searched Zoho by hand for the reference and confirmed it is not there.' ELSE 'Zoho had no purchase order with this reference after a full search, so the sample was freed' END, _user, COALESCE(_user_name, ''));
  RETURN jsonb_build_object('outcome', 'released');
END;
$function$;

/** rejected: Zoho refused and nothing exists. uncertain: nobody knows yet, so the next step must search Zoho. */
CREATE OR REPLACE FUNCTION public.rice_sample_po_mark_failed(
  _sample_id uuid, _attempt_id uuid, _state text, _message text, _detail text, _user uuid, _user_name text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  updated integer;
BEGIN
  IF _state NOT IN ('rejected', 'uncertain') THEN RAISE EXCEPTION 'Unknown state'; END IF;
  UPDATE public.rice_sample_purchase_orders SET state = _state, last_error = left(COALESCE(_message, ''), 500),
    last_error_detail = left(COALESCE(_detail, ''), 500), updated_at = now()
    WHERE sample_id = _sample_id AND attempt_id = _attempt_id AND state = 'sending';
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated > 0 THEN
    INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
    VALUES (_sample_id, CASE WHEN _state = 'rejected' THEN 'po_rejected' ELSE 'po_uncertain' END, left(COALESCE(_message, ''), 500), _user, COALESCE(_user_name, ''));
  END IF;
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
  UPDATE public.rice_samples SET status = 'selected', status_reason = '', status_changed_at = now(), updated_at = now() WHERE id = _sample_id;
  INSERT INTO public.rice_sample_events (sample_id, action, from_status, to_status, detail, actor, actor_name)
  VALUES (_sample_id, 'po_raised', sample.status, 'selected',
    format('Purchase order %s (%s)%s', COALESCE(_po_number, _po_id), COALESCE(_po_status, ''), CASE WHEN _found_by_search THEN ', found in Zoho by its reference' ELSE '' END),
    _user, COALESCE(_user_name, ''));
  RETURN jsonb_build_object('outcome', 'recorded', 'po', to_jsonb(po));
END;
$function$;

/** What Zoho says now, shown read-only on the sample. Nothing here can send anything to Zoho. */
CREATE OR REPLACE FUNCTION public.rice_sample_po_refresh(
  _sample_id uuid, _po_status text, _sub_total numeric, _tax_total numeric, _total numeric, _gone boolean, _duplicates jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  po public.rice_sample_purchase_orders;
BEGIN
  SELECT * INTO po FROM public.rice_sample_purchase_orders WHERE sample_id = _sample_id AND state = 'raised' FOR UPDATE;
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

-- ---------------------------------------------------------------- A new Zoho vendor or item (server only)

/** Same answers as rice_sample_po_claim. done: it was already created, here is its ID. */
CREATE OR REPLACE FUNCTION public.rice_sample_creation_claim(
  _kind text, _name_key text, _display_name text, _attempt_id uuid, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  row_now public.rice_sample_zoho_creations;
BEGIN
  INSERT INTO public.rice_sample_zoho_creations (kind, name_key, display_name, state, attempt_id, claimed_by, claimed_by_name)
  VALUES (_kind, _name_key, _display_name, 'sending', _attempt_id, _user, COALESCE(_user_name, ''))
  ON CONFLICT (kind, name_key) DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'claimed'); END IF;
  SELECT * INTO row_now FROM public.rice_sample_zoho_creations WHERE kind = _kind AND name_key = _name_key FOR UPDATE;
  IF row_now.state = 'done' THEN
    RETURN jsonb_build_object('outcome', 'done', 'zoho_id', row_now.zoho_id, 'attempt_id', row_now.attempt_id);
  END IF;
  IF row_now.state = 'sending' AND row_now.claimed_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('outcome', 'in_progress', 'by', row_now.claimed_by_name);
  END IF;
  IF row_now.state IN ('sending', 'uncertain') THEN
    RETURN jsonb_build_object('outcome', 'verify_first', 'attempt_id', row_now.attempt_id);
  END IF;
  UPDATE public.rice_sample_zoho_creations SET state = 'sending', attempt_id = _attempt_id, display_name = _display_name, claimed_by = _user,
    claimed_by_name = COALESCE(_user_name, ''), claimed_at = now(), last_error = ''
    WHERE kind = _kind AND name_key = _name_key;
  RETURN jsonb_build_object('outcome', 'claimed');
END;
$function$;

/** After Zoho was searched and has no such vendor or item: takes over. */
CREATE OR REPLACE FUNCTION public.rice_sample_creation_takeover(
  _kind text, _name_key text, _expected_attempt uuid, _attempt_id uuid, _user uuid, _user_name text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  row_now public.rice_sample_zoho_creations;
BEGIN
  SELECT * INTO row_now FROM public.rice_sample_zoho_creations WHERE kind = _kind AND name_key = _name_key FOR UPDATE;
  IF NOT FOUND OR row_now.attempt_id <> _expected_attempt OR row_now.state NOT IN ('sending', 'uncertain', 'done') THEN
    RETURN jsonb_build_object('outcome', 'changed');
  END IF;
  IF row_now.claimed_at > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('outcome', 'too_soon', 'wait_seconds', CEIL(EXTRACT(EPOCH FROM (row_now.claimed_at + interval '2 minutes' - now()))));
  END IF;
  UPDATE public.rice_sample_zoho_creations SET state = 'sending', attempt_id = _attempt_id, zoho_id = '', claimed_by = _user,
    claimed_by_name = COALESCE(_user_name, ''), claimed_at = now(), last_error = ''
    WHERE kind = _kind AND name_key = _name_key;
  RETURN jsonb_build_object('outcome', 'claimed');
END;
$function$;

CREATE OR REPLACE FUNCTION public.rice_sample_creation_finish(
  _kind text, _name_key text, _attempt_id uuid, _state text, _zoho_id text, _message text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF _state NOT IN ('done', 'rejected', 'uncertain') THEN RAISE EXCEPTION 'Unknown state'; END IF;
  UPDATE public.rice_sample_zoho_creations SET state = _state, zoho_id = COALESCE(_zoho_id, ''), last_error = left(COALESCE(_message, ''), 500)
    WHERE kind = _kind AND name_key = _name_key AND attempt_id = _attempt_id;
END;
$function$;

-- ---------------------------------------------------------------- Who can see and do what

-- Admins read; nobody writes directly. Customers, vendors, channel partners and godown staff see nothing.
REVOKE ALL ON public.rice_samples, public.rice_sample_tests, public.rice_sample_events,
  public.rice_sample_purchase_orders, public.rice_sample_zoho_creations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rice_samples, public.rice_sample_tests, public.rice_sample_events,
  public.rice_sample_purchase_orders TO authenticated;
GRANT ALL ON public.rice_samples, public.rice_sample_tests, public.rice_sample_events,
  public.rice_sample_purchase_orders, public.rice_sample_zoho_creations TO service_role;
-- Identity columns bring their own sequences, which are open by default.
REVOKE ALL ON SEQUENCE public.rice_sample_events_id_seq, public.rice_samples_sample_no_seq FROM PUBLIC, anon, authenticated;
-- TRUNCATE skips the guard triggers, so not even the server gets it.
REVOKE TRUNCATE ON public.rice_samples, public.rice_sample_tests, public.rice_sample_events,
  public.rice_sample_purchase_orders, public.rice_sample_zoho_creations FROM service_role;

ALTER TABLE public.rice_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rice_sample_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rice_sample_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rice_sample_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rice_sample_zoho_creations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rice_samples_admin_read ON public.rice_samples;
CREATE POLICY rice_samples_admin_read ON public.rice_samples FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS rice_sample_tests_admin_read ON public.rice_sample_tests;
CREATE POLICY rice_sample_tests_admin_read ON public.rice_sample_tests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS rice_sample_events_admin_read ON public.rice_sample_events;
CREATE POLICY rice_sample_events_admin_read ON public.rice_sample_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS rice_sample_purchase_orders_admin_read ON public.rice_sample_purchase_orders;
CREATE POLICY rice_sample_purchase_orders_admin_read ON public.rice_sample_purchase_orders FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON FUNCTION public.rice_samples_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_purchase_orders_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_actor_name(uuid) FROM PUBLIC, anon, authenticated;

-- The admin's page. Each function checks the admin role itself.
REVOKE ALL ON FUNCTION public.rice_sample_save(uuid, date, text, text, numeric, numeric, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rice_sample_add_test(uuid, timestamptz, text, integer, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rice_sample_set_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rice_sample_save(uuid, date, text, text, numeric, numeric, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_add_test(uuid, timestamptz, text, integer, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_set_status(uuid, text, text) TO authenticated;

-- The server only: a browser, even an admin's, cannot claim the lock or write a Zoho ID into a record.
REVOKE ALL ON FUNCTION public.rice_sample_po_claim(uuid, uuid, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_po_takeover(uuid, uuid, uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_po_release(uuid, uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_po_mark_failed(uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_po_record(uuid, text, text, text, numeric, numeric, numeric, text[], boolean, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_po_refresh(uuid, text, numeric, numeric, numeric, boolean, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_creation_claim(text, text, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_creation_takeover(text, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rice_sample_creation_finish(text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_claim(uuid, uuid, text, jsonb, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_takeover(uuid, uuid, uuid, jsonb, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_release(uuid, uuid, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_mark_failed(uuid, uuid, text, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_record(uuid, text, text, text, numeric, numeric, numeric, text[], boolean, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_po_refresh(uuid, text, numeric, numeric, numeric, boolean, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_creation_claim(text, text, text, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_creation_takeover(text, text, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rice_sample_creation_finish(text, text, uuid, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
