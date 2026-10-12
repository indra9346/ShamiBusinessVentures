-- Include the persisted enquiry ID in admin alerts so each alert opens its request.
ALTER TABLE public.contact_enquiries
  ADD COLUMN IF NOT EXISTS email_delivery_status text NOT NULL DEFAULT 'pending';

UPDATE public.contact_enquiries
SET email_delivery_status = CASE WHEN email_sent THEN 'sent' ELSE 'pending' END
WHERE email_delivery_status = 'pending';

-- Public users can create an enquiry without granting them read access to the table.
CREATE OR REPLACE FUNCTION public.submit_contact_enquiry(
  _name text,
  _email text,
  _phone text,
  _message text,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created_id uuid;
BEGIN
  IF length(btrim(_name)) NOT BETWEEN 2 AND 100
     OR length(btrim(_email)) > 255
     OR btrim(_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR length(btrim(_message)) NOT BETWEEN 5 AND 1000
     OR (_phone IS NOT NULL AND btrim(_phone) !~ '^[0-9+[:space:]-]{8,15}$')
     OR (_metadata IS NOT NULL AND jsonb_typeof(_metadata) <> 'object') THEN
    RAISE EXCEPTION 'Invalid enquiry details';
  END IF;

  INSERT INTO public.contact_enquiries (name, email, phone, message, metadata)
  VALUES (btrim(_name), lower(btrim(_email)), NULLIF(btrim(_phone), ''), btrim(_message), COALESCE(_metadata, '{}'::jsonb))
  RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_contact_enquiry(text, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_contact_enquiry(text, text, text, text, jsonb) TO anon, authenticated;
REVOKE INSERT ON TABLE public.contact_enquiries FROM anon, authenticated;
DROP POLICY IF EXISTS "contact_enquiries_insert_policy" ON public.contact_enquiries;

CREATE OR REPLACE FUNCTION public.handle_new_contact_enquiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (recipient_id, recipient_role, title, message, status)
  SELECT ur.user_id, 'admin', 'New customer enquiry',
    format('%s · %s · %s · Enquiry ID: %s', NEW.name, NEW.email,
      COALESCE(NEW.phone, 'Phone not provided'), NEW.id), 'enquiry'
  FROM public.user_roles ur
  WHERE ur.role = 'admin';
  RETURN NEW;
END;
$$;
