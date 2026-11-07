-- Rice samples: the available quantity can be entered in bags as well as quintals (owner's request, 7 Nov 2026).
--
-- quantity_qntl stays the one figure everything reads: the list, compare, Buy this and the Zoho purchase order. When a
-- sample was entered in bags, the bag count and the weight of one bag are kept beside it, so the card can say
-- "200 bags × 26 kg" and Edit reopens in bags. Quintals alone can't give the bag size back.
--
-- A bag weight has at most one decimal, so bags × kg / 100 always fits numeric(12,3) exactly, and the check below holds.
-- Only adds: samples already saved stay in quintals. The old rice_sample_save stays (now passing "no bags"), so the page
-- already live keeps working until the new code is uploaded.

ALTER TABLE public.rice_samples
  ADD COLUMN IF NOT EXISTS quantity_bags integer CHECK (quantity_bags IS NULL OR quantity_bags > 0),
  ADD COLUMN IF NOT EXISTS bag_kg numeric(4,1) CHECK (bag_kg IS NULL OR (bag_kg >= 1 AND bag_kg <= 100));

ALTER TABLE public.rice_samples DROP CONSTRAINT IF EXISTS rice_samples_bags_pair_check;
ALTER TABLE public.rice_samples ADD CONSTRAINT rice_samples_bags_pair_check CHECK ((quantity_bags IS NULL) = (bag_kg IS NULL));
ALTER TABLE public.rice_samples DROP CONSTRAINT IF EXISTS rice_samples_bags_match_check;
ALTER TABLE public.rice_samples ADD CONSTRAINT rice_samples_bags_match_check
  CHECK (quantity_bags IS NULL OR quantity_qntl = round(quantity_bags * bag_kg / 100, 3));

-- "52 quintal", or "52 quintal (200 bags of 26 kg)": how the history describes a quantity.
CREATE OR REPLACE FUNCTION public.rice_sample_quantity_text(_qntl numeric, _bags integer, _bag_kg numeric) RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT trim_scale(_qntl)::text || ' quintal'
    || CASE WHEN _bags IS NULL THEN '' ELSE format(' (%s bags of %s kg)', _bags, trim_scale(_bag_kg)) END;
$function$;

CREATE OR REPLACE FUNCTION public.rice_sample_save_with_bags(
  _id uuid, _arrival_date date, _variety text, _method text, _price_per_qntl numeric, _quantity_qntl numeric,
  _party_role text, _party_name text, _party_phone text, _seller_name text, _notes text, _quantity_bags integer, _bag_kg numeric
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  who uuid := auth.uid();
  who_name text;
  phone text := regexp_replace(COALESCE(_party_phone, ''), '[^0-9]', '', 'g');
  qntl numeric := _quantity_qntl;
  old_row public.rice_samples;
  changes text[] := '{}';
  new_id uuid;
BEGIN
  IF who IS NULL OR NOT public.has_role(who, 'admin') THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  who_name := COALESCE(public.rice_sample_actor_name(who), 'Admin');
  IF (_quantity_bags IS NULL) <> (_bag_kg IS NULL) THEN RAISE EXCEPTION 'Enter both the number of bags and the weight of one bag'; END IF;
  IF _quantity_bags IS NOT NULL THEN
    IF _quantity_bags <= 0 THEN RAISE EXCEPTION 'Enter the number of bags as a whole number'; END IF;
    IF _bag_kg < 1 OR _bag_kg > 100 THEN RAISE EXCEPTION 'One bag must weigh from 1 to 100 kg'; END IF;
    IF _bag_kg <> round(_bag_kg, 1) THEN RAISE EXCEPTION 'Enter the bag weight with one decimal at most, like 26 or 26.5'; END IF;
    qntl := round(_quantity_bags * _bag_kg / 100, 3);
    -- The page shows the quintals it works out. If this differs, what is saved would not be what the admin saw.
    IF _quantity_qntl IS NOT NULL AND round(_quantity_qntl, 3) <> qntl THEN
      RAISE EXCEPTION 'The page showed % quintal, but % bags of % kg is % quintal. Reload the page and try again.', trim_scale(round(_quantity_qntl, 3)), _quantity_bags, trim_scale(_bag_kg), trim_scale(qntl);
    END IF;
  END IF;
  IF _arrival_date IS NULL OR _arrival_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'The arrival date cannot be in the future'; END IF;
  IF btrim(COALESCE(_variety, '')) = '' THEN RAISE EXCEPTION 'Enter the rice variety'; END IF;
  IF _price_per_qntl IS NULL OR round(_price_per_qntl, 2) <= 0 THEN RAISE EXCEPTION 'Enter the purchase price per quintal'; END IF;
  IF _price_per_qntl >= 1000000 THEN RAISE EXCEPTION 'The price is too high. It should be rupees per quintal.'; END IF;
  IF qntl IS NULL OR round(qntl, 3) <= 0 THEN RAISE EXCEPTION 'Enter the quantity available in quintals'; END IF;
  IF qntl >= 1000000 THEN RAISE EXCEPTION 'The quantity is too high. It should be in quintals.'; END IF;
  IF char_length(btrim(_variety)) > 80 OR char_length(btrim(COALESCE(_method, ''))) > 80 THEN RAISE EXCEPTION 'The rice variety and method can be 80 characters at most'; END IF;
  IF COALESCE(_party_role, '') NOT IN ('broker', 'seller') THEN RAISE EXCEPTION 'Choose broker or seller'; END IF;
  IF btrim(COALESCE(_party_name, '')) = '' THEN RAISE EXCEPTION 'Enter the broker or seller name'; END IF;
  IF phone !~ '^[0-9]{10,13}$' THEN RAISE EXCEPTION 'Enter a phone number with 10 digits'; END IF;
  IF char_length(btrim(_party_name)) > 120 OR char_length(btrim(COALESCE(_seller_name, ''))) > 120 THEN RAISE EXCEPTION 'A name can be 120 characters at most'; END IF;
  IF char_length(btrim(COALESCE(_notes, ''))) > 1000 THEN RAISE EXCEPTION 'Notes can be 1,000 characters at most'; END IF;

  IF _id IS NULL THEN
    INSERT INTO public.rice_samples (arrival_date, variety, method, price_per_qntl, quantity_qntl, quantity_bags, bag_kg, party_role, party_name,
      party_phone, seller_name, notes, created_by, created_by_name)
    VALUES (_arrival_date, btrim(_variety), btrim(COALESCE(_method, '')), _price_per_qntl, qntl, _quantity_bags, _bag_kg, _party_role,
      btrim(_party_name), phone, btrim(COALESCE(_seller_name, '')), btrim(COALESCE(_notes, '')), who, who_name)
    RETURNING id INTO new_id;
    INSERT INTO public.rice_sample_events (sample_id, action, to_status, detail, actor, actor_name)
    VALUES (new_id, 'arrived', 'arrived', CASE WHEN _quantity_bags IS NULL THEN '' ELSE public.rice_sample_quantity_text(qntl, _quantity_bags, _bag_kg) END, who, who_name);
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
  IF public.rice_sample_quantity_text(old_row.quantity_qntl, old_row.quantity_bags, old_row.bag_kg) <> public.rice_sample_quantity_text(qntl, _quantity_bags, _bag_kg) THEN
    changes := changes || format('Quantity %s to %s', public.rice_sample_quantity_text(old_row.quantity_qntl, old_row.quantity_bags, old_row.bag_kg), public.rice_sample_quantity_text(qntl, _quantity_bags, _bag_kg));
  END IF;
  IF old_row.party_name <> btrim(_party_name) OR old_row.party_role <> _party_role THEN changes := changes || format('Dealing with %s (%s) to %s (%s)', old_row.party_name, old_row.party_role, btrim(_party_name), _party_role); END IF;
  IF old_row.party_phone <> phone THEN changes := changes || 'Phone number changed'::text; END IF;
  IF old_row.variety <> btrim(_variety) OR old_row.method <> btrim(COALESCE(_method, '')) THEN changes := changes || format('Rice %s %s to %s %s', old_row.variety, old_row.method, btrim(_variety), btrim(COALESCE(_method, ''))); END IF;
  IF old_row.arrival_date <> _arrival_date THEN changes := changes || format('Arrival %s to %s', old_row.arrival_date, _arrival_date); END IF;
  IF old_row.seller_name <> btrim(COALESCE(_seller_name, '')) THEN changes := changes || format('Seller %s to %s', COALESCE(NULLIF(old_row.seller_name, ''), 'none'), COALESCE(NULLIF(btrim(COALESCE(_seller_name, '')), ''), 'none')); END IF;
  IF old_row.notes <> btrim(COALESCE(_notes, '')) THEN changes := changes || 'Notes changed'::text; END IF;
  UPDATE public.rice_samples SET arrival_date = _arrival_date, variety = btrim(_variety), method = btrim(COALESCE(_method, '')),
    price_per_qntl = _price_per_qntl, quantity_qntl = qntl, quantity_bags = _quantity_bags, bag_kg = _bag_kg, party_role = _party_role, party_name = btrim(_party_name),
    party_phone = phone, seller_name = btrim(COALESCE(_seller_name, '')), notes = btrim(COALESCE(_notes, '')), updated_at = now()
    WHERE id = _id;
  INSERT INTO public.rice_sample_events (sample_id, action, detail, actor, actor_name)
  VALUES (_id, 'edited', COALESCE(array_to_string(changes, '; '), ''), who, who_name);
  RETURN _id;
END;
$function$;
REVOKE ALL ON FUNCTION public.rice_sample_save_with_bags(uuid, date, text, text, numeric, numeric, text, text, text, text, text, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rice_sample_save_with_bags(uuid, date, text, text, numeric, numeric, text, text, text, text, text, integer, numeric) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rice_sample_quantity_text(numeric, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rice_sample_quantity_text(numeric, integer, numeric) TO authenticated, service_role;

-- The page already live sends quintals only: saving through it records the sample in quintals and clears any bags.
CREATE OR REPLACE FUNCTION public.rice_sample_save(
  _id uuid, _arrival_date date, _variety text, _method text, _price_per_qntl numeric, _quantity_qntl numeric,
  _party_role text, _party_name text, _party_phone text, _seller_name text, _notes text
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public' AS $function$
BEGIN
  RETURN public.rice_sample_save_with_bags(_id, _arrival_date, _variety, _method, _price_per_qntl, _quantity_qntl,
    _party_role, _party_name, _party_phone, _seller_name, _notes, NULL::integer, NULL::numeric);
END;
$function$;

NOTIFY pgrst, 'reload schema';
