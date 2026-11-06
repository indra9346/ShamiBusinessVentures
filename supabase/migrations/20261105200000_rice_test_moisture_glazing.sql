-- Rice cook tests also record moisture and glazing (client request, 5 Nov 2026). Only adds: old tests stay blank.
-- Tests can't be edited once saved, so the new function writes both values with the test. The old function stays,
-- so the page already live keeps working until the new code is uploaded.
ALTER TABLE public.rice_sample_tests
  ADD COLUMN IF NOT EXISTS moisture_percent numeric(5,2) CHECK (moisture_percent IS NULL OR (moisture_percent >= 0 AND moisture_percent <= 100)),
  ADD COLUMN IF NOT EXISTS glazing text NOT NULL DEFAULT '' CHECK (char_length(glazing) <= 60);

CREATE OR REPLACE FUNCTION public.rice_sample_add_measured_test(
  _sample_id uuid, _tested_at timestamptz, _tested_by_name text, _score integer, _grain text, _swelling text, _taste text, _broken text, _notes text, _moisture_percent numeric, _glazing text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  who uuid := auth.uid();
  who_name text;
  old_row public.rice_samples;
  new_id uuid;
BEGIN
  IF _moisture_percent IS NOT NULL AND (_moisture_percent < 0 OR _moisture_percent > 100) THEN
    RAISE EXCEPTION 'Moisture must be between 0 and 100 percent';
  END IF;
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
  INSERT INTO public.rice_sample_tests (moisture_percent, glazing, sample_id, tested_at, tested_by_name, score, grain, swelling, taste, broken, notes, recorded_by)
  VALUES (round(_moisture_percent, 2), left(btrim(COALESCE(_glazing, '')), 60), _sample_id, COALESCE(_tested_at, now()), btrim(_tested_by_name), _score, _grain, _swelling, _taste, _broken, btrim(COALESCE(_notes, '')), who)
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
REVOKE ALL ON FUNCTION public.rice_sample_add_measured_test(uuid, timestamptz, text, integer, text, text, text, text, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rice_sample_add_measured_test(uuid, timestamptz, text, integer, text, text, text, text, text, numeric, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
