-- Zoho's customer and vendor numbers on the website (owner, 12 Nov 2026: "Fetch Customer ID (customer number) & Vendor
-- IDs (vendor number) from Zoho & show the same everywhere in customer details & order details & in invoices & delivery
-- slips and wherever required").
--
-- Zoho Books keeps the number on the contact (`contact_number`: "Customer Number" / "Vendor Number", there when Zoho
-- Books' Customer and Vendor Numbers preference is on). The website already links each account to its Zoho contact
-- (zoho_contact_links); it now keeps the number on that link too, read whenever the website creates, updates or checks
-- the contact, and by Admin > Zoho Commerce > "Fetch customer and vendor numbers from Zoho". Nothing is sent to Zoho.
--
-- The table stays closed to signed-in accounts (service role only, as before). Two read functions hand the number out:
--   zoho_contact_numbers(): an admin gets everyone's; anyone else only their own (a customer's customer number, a
--     vendor's vendor number).
--   invoice_customer_number(): the number printed on an order's invoice, for the order's customer, admins and the
--     channel partner who signs that invoice (the same partner who may open it: partner_invoice_order).
-- This adds two columns and a length check; no existing row is changed (only the website's own sync fills them).

ALTER TABLE public.zoho_contact_links ADD COLUMN IF NOT EXISTS zoho_contact_number text;
-- When the website last asked Zoho for the number (it may have none), so a press of the admin button goes on to the next.
ALTER TABLE public.zoho_contact_links ADD COLUMN IF NOT EXISTS zoho_contact_number_checked_at timestamptz;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'zoho_contact_links_number_length' AND conrelid = 'public.zoho_contact_links'::regclass
  ) THEN
    -- Zoho Books allows 50 characters; an empty number is stored as NULL.
    ALTER TABLE public.zoho_contact_links ADD CONSTRAINT zoho_contact_links_number_length
      CHECK (zoho_contact_number IS NULL OR char_length(zoho_contact_number) BETWEEN 1 AND 50);
  END IF;
END
$do$;

/**
 * The customer and vendor numbers the caller may see: every linked account's for an admin, otherwise only the caller's
 * own. vendor_id is the profile's vendor id, which the admin pages use for a vendor. Only accounts with a number.
 */
CREATE OR REPLACE FUNCTION public.zoho_contact_numbers()
RETURNS TABLE (user_id uuid, vendor_id text, contact_type text, contact_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT l.user_id, NULLIF(btrim(p.vendor_id), ''), l.contact_type, btrim(l.zoho_contact_number)
  FROM public.zoho_contact_links l
  LEFT JOIN public.profiles p ON p.id = l.user_id
  WHERE auth.uid() IS NOT NULL
    AND NULLIF(btrim(l.zoho_contact_number), '') IS NOT NULL
    AND (l.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ORDER BY l.contact_type, l.user_id
$function$;
REVOKE ALL ON FUNCTION public.zoho_contact_numbers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.zoho_contact_numbers() TO authenticated;

/**
 * The customer number printed on an order's invoice, or NULL (no number, or not for the caller). Only for those who may
 * open that invoice's customer copy: the order's customer, an admin, or the active channel partner who signs it (not for
 * a checkout that was never paid, as partner_invoice_order). A vendor's office copy prints none.
 */
CREATE OR REPLACE FUNCTION public.invoice_customer_number(_order_no text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  me uuid := auth.uid();
  o record;
BEGIN
  IF me IS NULL THEN RETURN NULL; END IF;
  SELECT id, user_id, order_status INTO o FROM public.orders WHERE order_no = _order_no;
  IF NOT FOUND OR o.user_id IS NULL THEN RETURN NULL; END IF;
  IF NOT (o.user_id = me
      OR public.has_role(me, 'admin')
      OR (COALESCE(o.order_status, '') NOT IN ('Awaiting Payment', 'Payment Expired') AND EXISTS (
        SELECT 1 FROM public.channel_partners p
        WHERE p.user_id = me AND p.status = 'active' AND p.id = private.order_signing_partner(o.id)))) THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT NULLIF(btrim(l.zoho_contact_number), '') FROM public.zoho_contact_links l
    WHERE l.user_id = o.user_id AND l.contact_type = 'customer');
END $function$;
REVOKE ALL ON FUNCTION public.invoice_customer_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_customer_number(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
