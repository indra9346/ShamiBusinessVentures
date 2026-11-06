-- The shop's own products (seller code VENDOR-001) are sold by the company, not by somebody's login (owner, 6 Nov 2026).
--
-- What went wrong: a test login was linked to VENDOR-001. It also shopped as a customer and checked out as a business
-- called "i-developmentworks". Checkout saves that business name as the login's company, the vendor-name trigger copied
-- it onto every shop product, and every order line since copied it from the product. So every order said its seller was
-- "i-developmentworks". Worse, the shop lists a product only while its seller has an active login, so the whole shop
-- depended on that test login staying approved: removing it would have emptied the shop.
--
-- Now:
--   1. house_seller_name(): the seller name of the shop's own products is the company name in Admin > Website details.
--   2. The shop lists the company's own products without any seller login.
--   3. A product's seller name is set from the company for house products, from the vendor's profile otherwise.
--   4. A login's company name (a customer's business name at checkout) never renames the shop's products again.
--   5. Renaming the company in Website details renames the seller on the shop's products.
--   6. No login can be the house seller: the test login loses its vendor rights and the link (it stays a customer
--      account, with its order history and its business name for its own invoices), and a check keeps it that way.
--   7. The shop's products, the 56 order lines and the batches that said "i-developmentworks" now say the company name.
--      The order lines are changed with Zoho sync paused for this transaction: the seller name is not on Zoho orders.
-- Zoho is not touched. Old notification texts and one order-tracking note keep their wording (they are history).

BEGIN;

-- 1. The house seller's name, or NULL for any other seller.
CREATE OR REPLACE FUNCTION public.house_seller_name(_vendor_id text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN _vendor_id = 'VENDOR-001' THEN
    COALESCE(
      (SELECT COALESCE(NULLIF(trim(value->>'legal_name'), ''), NULLIF(trim(value->>'name'), ''))
         FROM public.settings WHERE key = 'company'),
      'Shami Business Ventures Private Limited'
    )
  END;
$function$;
REVOKE ALL ON FUNCTION public.house_seller_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.house_seller_name(text) TO authenticated, service_role;

-- 2. The shop shows the company's own products without a seller login; other sellers still need an active account.
CREATE OR REPLACE FUNCTION private.vendor_account_is_active(_vendor_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
  SELECT _vendor_id = 'VENDOR-001' OR EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE vendor_id = _vendor_id
      AND lower(COALESCE(status, '')) IN ('active', 'approved')
  );
$function$;

-- 3. The live function, with the seller name taken from the company for the shop's own products.
CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  is_vendor boolean := public.has_role(auth.uid(), 'vendor') AND NOT public.has_role(auth.uid(), 'admin');
  vendor_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND is_vendor AND (
      (NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status IN ('approved', 'rejected') AND NEW.status = 'pending'))
      OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
      OR NEW.payload->'price' IS DISTINCT FROM OLD.payload->'price'
      OR NEW.payload->'mrp' IS DISTINCT FROM OLD.payload->'mrp'
      OR NEW.payload->'purchasePrice' IS DISTINCT FROM OLD.payload->'purchasePrice'
      OR NEW.payload->'gst' IS DISTINCT FROM OLD.payload->'gst'
      OR NEW.payload->'maxPurchaseQuantity' IS DISTINCT FROM OLD.payload->'maxPurchaseQuantity'
    ) THEN
    RAISE EXCEPTION 'Only administrators may change catalog pricing, tax, status, or customer purchase limits';
  END IF;

  IF TG_OP = 'INSERT' AND is_vendor AND NEW.payload ? 'maxPurchaseQuantity' THEN
    RAISE EXCEPTION 'Only administrators may set customer purchase limits';
  END IF;

  IF is_vendor THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.payload := (NEW.payload - ARRAY['rating', 'reviews', 'sold', 'reserved'])
        || jsonb_strip_nulls(jsonb_build_object(
          'rating', OLD.payload->'rating', 'reviews', OLD.payload->'reviews',
          'sold', OLD.payload->'sold', 'reserved', OLD.payload->'reserved'));
    ELSE
      NEW.payload := NEW.payload || '{"rating": 0, "reviews": 0, "sold": 0, "reserved": 0}'::jsonb;
    END IF;
  END IF;

  IF NEW.payload ? 'maxPurchaseQuantity' AND (
    jsonb_typeof(NEW.payload->'maxPurchaseQuantity') IS DISTINCT FROM 'number'
    OR (NEW.payload->>'maxPurchaseQuantity') !~ '^[1-9][0-9]{0,5}$'
    OR CASE
      WHEN (NEW.payload->>'maxPurchaseQuantity') ~ '^[1-9][0-9]{0,5}$'
        THEN (NEW.payload->>'maxPurchaseQuantity')::numeric > 100000
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'Maximum customer purchase quantity must be a whole number from 1 to 100,000';
  END IF;

  -- Seller name: the company for the shop's own products, else the vendor's profile (Zoho mirror rows keep their own).
  IF NEW.vendor_id IS NOT NULL AND NEW.vendor_id NOT LIKE 'zoho:%' THEN
    vendor_name := public.house_seller_name(NEW.vendor_id);
    IF vendor_name IS NULL THEN
      SELECT NULLIF(trim(company), '') INTO vendor_name FROM public.profiles WHERE vendor_id = NEW.vendor_id LIMIT 1;
    END IF;
    IF vendor_name IS NOT NULL THEN
      NEW.payload := jsonb_set(NEW.payload, '{vendor}', to_jsonb(vendor_name), true);
    END IF;
  END IF;

  NEW.payload := jsonb_set(NEW.payload, '{id}', to_jsonb(NEW.id), true);
  NEW.payload := jsonb_set(NEW.payload, '{vendorId}', to_jsonb(NEW.vendor_id), true);
  NEW.payload := jsonb_set(NEW.payload, '{category}', to_jsonb(NEW.category), true);
  NEW.payload := jsonb_set(NEW.payload, '{status}', to_jsonb(NEW.status), true);
  NEW.payload := jsonb_set(NEW.payload, '{active}', to_jsonb(NEW.active), true);
  RETURN NEW;
END;
$function$;

-- 4. A vendor renaming their business renames it on their products; never on the shop's own products.
CREATE OR REPLACE FUNCTION public.sync_vendor_name_to_catalog()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.vendor_id IS NOT NULL AND NULLIF(trim(NEW.company), '') IS NOT NULL
    AND NEW.company IS DISTINCT FROM OLD.company
    AND public.house_seller_name(NEW.vendor_id) IS NULL THEN
    UPDATE public.catalog_products
       SET payload = jsonb_set(payload, '{vendor}', to_jsonb(trim(NEW.company)), true)
     WHERE vendor_id = NEW.vendor_id;
  END IF;
  RETURN NEW;
END $function$;

-- 5. A new company name in Website details becomes the seller name on the shop's products (the product trigger
--    sets it; price, stock and Zoho are untouched because nothing else changes).
CREATE OR REPLACE FUNCTION private.sync_house_seller_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  seller text := public.house_seller_name('VENDOR-001');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.value->>'name' IS NOT DISTINCT FROM OLD.value->>'name'
    AND NEW.value->>'legal_name' IS NOT DISTINCT FROM OLD.value->>'legal_name' THEN RETURN NEW; END IF;
  UPDATE public.catalog_products SET payload = payload
   WHERE vendor_id = 'VENDOR-001' AND payload->>'vendor' IS DISTINCT FROM seller;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION private.sync_house_seller_name() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS settings_house_seller_name ON public.settings;
CREATE TRIGGER settings_house_seller_name AFTER INSERT OR UPDATE OF value ON public.settings
  FOR EACH ROW WHEN (NEW.key = 'company') EXECUTE FUNCTION private.sync_house_seller_name();

-- 6. No login is the house seller. The login keeps its customer role, orders and business name.
DELETE FROM public.user_roles r
 USING public.profiles p
 WHERE r.user_id = p.id AND p.vendor_id = 'VENDOR-001' AND r.role = 'vendor';
UPDATE public.profiles SET vendor_id = NULL WHERE vendor_id = 'VENDOR-001';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_not_house_seller;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_not_house_seller CHECK (vendor_id IS DISTINCT FROM 'VENDOR-001');

-- 7. The company name on the shop's products, its order lines and its batches.
UPDATE public.catalog_products SET payload = payload
 WHERE vendor_id = 'VENDOR-001' AND payload->>'vendor' IS DISTINCT FROM public.house_seller_name('VENDOR-001');
SELECT set_config('app.zoho_inbound', 'on', true);
UPDATE public.order_items SET vendor = public.house_seller_name('VENDOR-001')
 WHERE vendor_id = 'VENDOR-001' AND vendor IS DISTINCT FROM public.house_seller_name('VENDOR-001');
SELECT set_config('app.zoho_inbound', 'off', true);
UPDATE public.batches SET vendor = public.house_seller_name('VENDOR-001')
 WHERE vendor_id = 'VENDOR-001' AND vendor IS DISTINCT FROM public.house_seller_name('VENDOR-001');

COMMIT;
