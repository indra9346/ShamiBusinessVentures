-- Zoho contact edits never reached the site. public.has_role() answers false whenever there is
-- no signed-in user, and this function only ever runs with the server's key, so every edit was
-- refused and the hourly check counted it as failed without saying why.
--
-- Applying this file is what turns the copying on: an edit in Zoho then changes the customer's
-- details on the site. Apply it only after the owner has said that's wanted.
CREATE OR REPLACE FUNCTION public.apply_zoho_contact_update(
  _user_id uuid, _contact_type text, _full_name text, _phone text,
  _company text, _gstin text, _address jsonb DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  person public.profiles%ROWTYPE;
  address_row public.addresses%ROWTYPE;
  address_line text := NULLIF(trim(COALESCE(_address->>'address', '')), '');
  address_city text := NULLIF(trim(COALESCE(_address->>'city', '')), '');
  address_state text := NULLIF(trim(COALESCE(_address->>'state', '')), '');
  address_pin text := NULLIF(trim(COALESCE(_address->>'zip', '')), '');
  new_phone text := NULLIF(trim(COALESCE(_phone, '')), '');
BEGIN
  IF _contact_type NOT IN ('customer', 'vendor') OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role::text = _contact_type
  ) THEN
    RAISE EXCEPTION 'Zoho contact type does not match the Grain Bazar account role';
  END IF;
  -- A customer whose information was deleted never gets details back from Zoho. The lock means a
  -- delete running now either finished and is seen here, or waits and then clears what this wrote.
  SELECT * INTO person FROM public.profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND OR person.status = 'deleted' THEN
    RAISE EXCEPTION 'This customer''s information was deleted, so nothing is copied from Zoho';
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.profiles
  SET full_name = COALESCE(NULLIF(trim(_full_name), ''), full_name),
      phone = COALESCE(new_phone, phone),
      company = COALESCE(NULLIF(trim(_company), ''), company),
      gstin = COALESCE(NULLIF(trim(_gstin), ''), gstin),
      business_address = CASE WHEN _contact_type = 'vendor' AND address_line IS NOT NULL THEN address_line ELSE business_address END,
      business_city = CASE WHEN _contact_type = 'vendor' AND address_city IS NOT NULL THEN address_city ELSE business_city END,
      updated_at = now()
  WHERE id = _user_id;

  IF _contact_type = 'customer' AND address_line IS NOT NULL
    AND address_city IS NOT NULL AND address_state IS NOT NULL AND address_pin IS NOT NULL THEN
    SELECT * INTO address_row FROM public.addresses
      WHERE user_id = _user_id AND is_default = true LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      -- Zoho holds one phone, the customer's. A delivery phone of its own on this address stays.
      UPDATE public.addresses SET
        line = address_line, city = address_city, state = address_state, pin = address_pin,
        name = COALESCE(NULLIF(trim(_address->>'attention'), ''), name),
        phone = CASE WHEN COALESCE(trim(phone), '') IN ('', COALESCE(trim(person.phone), '')) THEN COALESCE(new_phone, phone) ELSE phone END,
        updated_at = now()
      WHERE id = address_row.id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.addresses WHERE user_id = _user_id) THEN
      INSERT INTO public.addresses (user_id, label, name, phone, line, city, state, pin, is_default)
      VALUES (_user_id, 'Default', COALESCE(NULLIF(trim(_address->>'attention'), ''), COALESCE(NULLIF(trim(_full_name), ''), 'Customer')),
        COALESCE(new_phone, ''), address_line, address_city, address_state, address_pin, true);
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_zoho_contact_update(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_contact_update(uuid, text, text, text, text, text, jsonb) TO service_role;

-- Start from now: edits made in Zoho before this goes live were never reviewed, so they don't come across in one go.
UPDATE public.zoho_contact_links SET last_zoho_modified_at = now()
  WHERE last_zoho_modified_at IS NULL OR last_zoho_modified_at < now();
