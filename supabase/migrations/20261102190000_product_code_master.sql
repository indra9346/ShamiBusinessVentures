-- Master list of product names and codes, kept by admin (client's request, 2 Nov 2026).
--
--   code = [set prefix][method letter][variety letter][serial]   e.g. RS01 = Raw Rice + Sona Rice + 01
--
-- One set per category (Rice now; Sugar, Oil and others are created by admin when wanted). The seed at
-- the end of this file is the client's workbook Rice_Product_Codes.xlsx, and only that.
--
-- Codes are printed on bags and spoken in the business, so what the workbook did (change a letter and
-- every code changes) must not happen here. The database enforces:
--   * A letter is unique among a set's methods and among its varieties. S for Sona and S for Steam are
--     different positions and both valid. A retired method or variety keeps its letter, but its name is
--     free again, so a replacement can carry the same name under a new letter.
--   * Codes are unique across all categories.
--   * The code text is worked out here when the row is created (never sent by the page) and is fixed
--     from then on. A letter locks as soon as one code uses it; a prefix locks likewise.
--   * A code is never deleted, only retired, and the serial always moves forward, so a retired code can
--     never come back meaning something else.
--
-- A product carries its code in payload.productCode. Nothing here touches an existing product, and the
-- Zoho sync neither reads nor writes that field: Zoho keeps matching items by SKU. Admin sets the code
-- through admin_set_product_code, which changes that field and nothing else, not even updated_at.

CREATE TABLE IF NOT EXISTS public.product_code_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The category name exactly as products carry it (catalog_products.category has no key either).
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  -- Optional, for later sets: with prefix U a Sugar code reads URS01 and can never meet Rice's RS01.
  prefix text NOT NULL DEFAULT '' CHECK (prefix ~ '^[A-Z]{0,3}$'),
  first_label text NOT NULL DEFAULT 'Method' CHECK (length(first_label) BETWEEN 1 AND 40),
  second_label text NOT NULL DEFAULT 'Variety' CHECK (length(second_label) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_code_sets_category_key ON public.product_code_sets (lower(category));
CREATE UNIQUE INDEX IF NOT EXISTS product_code_sets_prefix_key ON public.product_code_sets (prefix) WHERE prefix <> '';

CREATE TABLE IF NOT EXISTS public.product_code_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.product_code_sets(id) ON DELETE RESTRICT,
  letter text NOT NULL CHECK (letter ~ '^[A-Z]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_order integer NOT NULL DEFAULT 0,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, letter),
  UNIQUE (set_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_code_methods_name_key ON public.product_code_methods (set_id, lower(name)) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.product_code_varieties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.product_code_sets(id) ON DELETE RESTRICT,
  letter text NOT NULL CHECK (letter ~ '^[A-Z]$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  sort_order integer NOT NULL DEFAULT 0,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, letter),
  UNIQUE (set_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_code_varieties_name_key ON public.product_code_varieties (set_id, lower(name)) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.product_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.product_code_sets(id) ON DELETE RESTRICT,
  method_id uuid NOT NULL,
  variety_id uuid NOT NULL,
  serial smallint NOT NULL CHECK (serial BETWEEN 1 AND 99),
  code text NOT NULL CHECK (code ~ '^[A-Z]{2,5}[0-9]{2}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  subcategory text NOT NULL CHECK (length(subcategory) BETWEEN 1 AND 80),
  images text[] NOT NULL DEFAULT '{}' CHECK (cardinality(images) <= 8),
  retired_at timestamptz,
  -- Retired because its method or variety was, so it comes back when they do.
  retired_with_part boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code),
  UNIQUE (method_id, variety_id, serial),
  -- The method and the variety must both belong to this code's set.
  FOREIGN KEY (set_id, method_id) REFERENCES public.product_code_methods (set_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (set_id, variety_id) REFERENCES public.product_code_varieties (set_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION public.product_code_set_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.category := regexp_replace(trim(NEW.category), '\s+', ' ', 'g');
  NEW.prefix := upper(trim(NEW.prefix));
  NEW.first_label := trim(NEW.first_label);
  NEW.second_label := trim(NEW.second_label);
  IF TG_OP = 'UPDATE' THEN
    IF NEW.prefix IS DISTINCT FROM OLD.prefix AND EXISTS (SELECT 1 FROM public.product_codes WHERE set_id = OLD.id) THEN
      RAISE EXCEPTION 'This set already has codes, so its prefix can no longer change';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

-- TG_ARGV[0] says which column of product_codes points at this table.
CREATE OR REPLACE FUNCTION public.product_code_part_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  in_use text;
BEGIN
  NEW.letter := upper(trim(NEW.letter));
  NEW.name := regexp_replace(trim(NEW.name), '\s+', ' ', 'g');
  IF TG_OP = 'UPDATE' THEN
    IF NEW.set_id IS DISTINCT FROM OLD.set_id THEN
      RAISE EXCEPTION 'A method or variety cannot move to another category';
    END IF;
    IF NEW.letter IS DISTINCT FROM OLD.letter THEN
      IF OLD.retired_at IS NOT NULL THEN
        RAISE EXCEPTION '% is retired, so letter % stays reserved.', OLD.name, OLD.letter;
      END IF;
      SELECT string_agg(code, ', ' ORDER BY code) INTO in_use FROM public.product_codes
      WHERE (TG_ARGV[0] = 'method_id' AND method_id = OLD.id) OR (TG_ARGV[0] = 'variety_id' AND variety_id = OLD.id);
      IF in_use IS NOT NULL THEN
        RAISE EXCEPTION 'Letter % is locked because these codes use it: %. Codes never change once made. Retire this one and create a new one with the letter you want.', OLD.letter, in_use;
      END IF;
    END IF;
    -- A retired one stays as it was, so restoring it can't bring it back as something else.
    IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT NULL THEN
      IF NEW.name IS DISTINCT FROM OLD.name THEN
        RAISE EXCEPTION '% is retired. Restore it before changing its name.', OLD.name;
      END IF;
      NEW.retired_at := OLD.retired_at;
    ELSIF NEW.retired_at IS NOT NULL THEN
      NEW.retired_at := now();
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

-- Retiring a method or variety retires its codes with it. Restoring brings back the codes that went
-- with it, once both their method and variety are live, and never one retired on its own.
CREATE OR REPLACE FUNCTION public.product_code_part_retired()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL THEN
    UPDATE public.product_codes SET retired_at = NEW.retired_at, retired_with_part = true
    WHERE retired_at IS NULL
      AND ((TG_ARGV[0] = 'method_id' AND method_id = NEW.id) OR (TG_ARGV[0] = 'variety_id' AND variety_id = NEW.id));
  ELSIF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN
    UPDATE public.product_codes c SET retired_at = NULL
    WHERE c.retired_with_part
      AND ((TG_ARGV[0] = 'method_id' AND c.method_id = NEW.id) OR (TG_ARGV[0] = 'variety_id' AND c.variety_id = NEW.id))
      AND EXISTS (SELECT 1 FROM public.product_code_methods m WHERE m.id = c.method_id AND m.retired_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.product_code_varieties v WHERE v.id = c.variety_id AND v.retired_at IS NULL);
  END IF;
  RETURN NULL;
END $$;

-- Whatever the page sends, the serial is the next free one for this method and variety (a retired
-- code keeps its number) and the code is worked out from the letters.
CREATE OR REPLACE FUNCTION public.product_code_before_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  set_row public.product_code_sets%ROWTYPE;
  method_row public.product_code_methods%ROWTYPE;
  variety_row public.product_code_varieties%ROWTYPE;
  other_category text;
BEGIN
  -- A letter, prefix or retirement being changed at this moment finishes first or waits for this.
  SELECT * INTO set_row FROM public.product_code_sets WHERE id = NEW.set_id FOR SHARE;
  -- Two admins adding at once wait here, so they can't work out the same serial.
  SELECT * INTO method_row FROM public.product_code_methods WHERE id = NEW.method_id AND set_id = NEW.set_id FOR UPDATE;
  SELECT * INTO variety_row FROM public.product_code_varieties WHERE id = NEW.variety_id AND set_id = NEW.set_id FOR SHARE;
  IF set_row.id IS NULL OR method_row.id IS NULL OR variety_row.id IS NULL THEN
    RAISE EXCEPTION 'The method and variety must belong to this category''s code set';
  END IF;
  IF method_row.retired_at IS NOT NULL OR variety_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'That method or variety is retired, so it cannot get new codes';
  END IF;
  SELECT COALESCE(MAX(serial), 0) + 1 INTO NEW.serial FROM public.product_codes
  WHERE method_id = NEW.method_id AND variety_id = NEW.variety_id;
  IF NEW.serial > 99 THEN
    RAISE EXCEPTION 'This method and variety have used all 99 serial numbers';
  END IF;
  NEW.code := set_row.prefix || method_row.letter || variety_row.letter || lpad(NEW.serial::text, 2, '0');
  SELECT s.category INTO other_category FROM public.product_codes c JOIN public.product_code_sets s ON s.id = c.set_id WHERE c.code = NEW.code;
  IF other_category IS NOT NULL THEN
    RAISE EXCEPTION 'Code % is already used in %. Give this category''s set a prefix, or use a different letter.', NEW.code, other_category;
  END IF;
  -- The same wording as the workbook's Description column. A later serial must not look like the first.
  NEW.name := COALESCE(NULLIF(regexp_replace(trim(COALESCE(NEW.name, '')), '\s+', ' ', 'g'), ''),
    method_row.name || ' - ' || variety_row.name || CASE WHEN NEW.serial > 1 THEN ' ' || lpad(NEW.serial::text, 2, '0') ELSE '' END);
  NEW.subcategory := COALESCE(NULLIF(regexp_replace(trim(COALESCE(NEW.subcategory, '')), '\s+', ' ', 'g'), ''), method_row.name);
  NEW.description := trim(COALESCE(NEW.description, ''));
  NEW.images := COALESCE(NEW.images, '{}');
  NEW.retired_at := NULL;
  NEW.retired_with_part := false;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.product_code_before_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.code, NEW.set_id, NEW.method_id, NEW.variety_id, NEW.serial) IS DISTINCT FROM (OLD.code, OLD.set_id, OLD.method_id, OLD.variety_id, OLD.serial) THEN
    RAISE EXCEPTION 'Code % never changes. Retire it and add a new one instead.', OLD.code;
  END IF;
  NEW.name := regexp_replace(trim(NEW.name), '\s+', ' ', 'g');
  NEW.subcategory := regexp_replace(trim(NEW.subcategory), '\s+', ' ', 'g');
  NEW.description := trim(NEW.description);
  -- A retired code stays as it was, so restoring it can't bring it back as something else.
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT NULL
    AND (NEW.name, NEW.description, NEW.subcategory, NEW.images) IS DISTINCT FROM (OLD.name, OLD.description, OLD.subcategory, OLD.images) THEN
    RAISE EXCEPTION 'Code % is retired. Restore it before changing its details.', OLD.code;
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.product_code_methods WHERE id = NEW.method_id AND retired_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM public.product_code_varieties WHERE id = NEW.variety_id AND retired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Restore the method and variety of % first', OLD.code;
    END IF;
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT NULL THEN
    NEW.retired_at := OLD.retired_at;
    NEW.retired_with_part := OLD.retired_with_part;
  ELSIF NEW.retired_at IS NULL THEN
    NEW.retired_with_part := false;
  ELSIF pg_trigger_depth() = 1 THEN
    -- Retired on its own, not through its method or variety.
    NEW.retired_at := now();
    NEW.retired_with_part := false;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.product_code_no_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Code % is never deleted, so it can never be used again for something else. Retire it instead.', OLD.code;
END $$;

DROP TRIGGER IF EXISTS product_code_sets_guard ON public.product_code_sets;
CREATE TRIGGER product_code_sets_guard BEFORE INSERT OR UPDATE ON public.product_code_sets
  FOR EACH ROW EXECUTE FUNCTION public.product_code_set_guard();

DROP TRIGGER IF EXISTS product_code_methods_guard ON public.product_code_methods;
CREATE TRIGGER product_code_methods_guard BEFORE INSERT OR UPDATE ON public.product_code_methods
  FOR EACH ROW EXECUTE FUNCTION public.product_code_part_guard('method_id');
DROP TRIGGER IF EXISTS product_code_methods_retired ON public.product_code_methods;
CREATE TRIGGER product_code_methods_retired AFTER UPDATE OF retired_at ON public.product_code_methods
  FOR EACH ROW EXECUTE FUNCTION public.product_code_part_retired('method_id');

DROP TRIGGER IF EXISTS product_code_varieties_guard ON public.product_code_varieties;
CREATE TRIGGER product_code_varieties_guard BEFORE INSERT OR UPDATE ON public.product_code_varieties
  FOR EACH ROW EXECUTE FUNCTION public.product_code_part_guard('variety_id');
DROP TRIGGER IF EXISTS product_code_varieties_retired ON public.product_code_varieties;
CREATE TRIGGER product_code_varieties_retired AFTER UPDATE OF retired_at ON public.product_code_varieties
  FOR EACH ROW EXECUTE FUNCTION public.product_code_part_retired('variety_id');

DROP TRIGGER IF EXISTS product_codes_before_insert ON public.product_codes;
CREATE TRIGGER product_codes_before_insert BEFORE INSERT ON public.product_codes
  FOR EACH ROW EXECUTE FUNCTION public.product_code_before_insert();
DROP TRIGGER IF EXISTS product_codes_before_update ON public.product_codes;
CREATE TRIGGER product_codes_before_update BEFORE UPDATE ON public.product_codes
  FOR EACH ROW EXECUTE FUNCTION public.product_code_before_update();
DROP TRIGGER IF EXISTS product_codes_no_delete ON public.product_codes;
CREATE TRIGGER product_codes_no_delete BEFORE DELETE ON public.product_codes
  FOR EACH ROW EXECUTE FUNCTION public.product_code_no_delete();

ALTER TABLE public.product_code_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_code_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_code_varieties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_codes ENABLE ROW LEVEL SECURITY;

-- Supabase grants new tables to anon and authenticated by default: take that back first.
REVOKE ALL ON public.product_code_sets, public.product_code_methods, public.product_code_varieties, public.product_codes
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.product_code_sets, public.product_code_methods, public.product_code_varieties, public.product_codes
  TO authenticated;
GRANT ALL ON public.product_code_sets, public.product_code_methods, public.product_code_varieties, public.product_codes
  TO service_role;

-- Admin only, for reading too. No DELETE policy: nothing here is ever deleted from the panel.
DROP POLICY IF EXISTS product_code_sets_admin_read ON public.product_code_sets;
CREATE POLICY product_code_sets_admin_read ON public.product_code_sets FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_sets_admin_insert ON public.product_code_sets;
CREATE POLICY product_code_sets_admin_insert ON public.product_code_sets FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_sets_admin_update ON public.product_code_sets;
CREATE POLICY product_code_sets_admin_update ON public.product_code_sets FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS product_code_methods_admin_read ON public.product_code_methods;
CREATE POLICY product_code_methods_admin_read ON public.product_code_methods FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_methods_admin_insert ON public.product_code_methods;
CREATE POLICY product_code_methods_admin_insert ON public.product_code_methods FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_methods_admin_update ON public.product_code_methods;
CREATE POLICY product_code_methods_admin_update ON public.product_code_methods FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS product_code_varieties_admin_read ON public.product_code_varieties;
CREATE POLICY product_code_varieties_admin_read ON public.product_code_varieties FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_varieties_admin_insert ON public.product_code_varieties;
CREATE POLICY product_code_varieties_admin_insert ON public.product_code_varieties FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_code_varieties_admin_update ON public.product_code_varieties;
CREATE POLICY product_code_varieties_admin_update ON public.product_code_varieties FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS product_codes_admin_read ON public.product_codes;
CREATE POLICY product_codes_admin_read ON public.product_codes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_codes_admin_insert ON public.product_codes;
CREATE POLICY product_codes_admin_insert ON public.product_codes FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS product_codes_admin_update ON public.product_codes;
CREATE POLICY product_codes_admin_update ON public.product_codes FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Only an admin (or the server) can put a code on a product or take it off, and only a live code from
-- the master for that product's category. A product keeps its code if the code is retired later: this
-- runs only when the code on the product changes, so every other save (orders, stock, Zoho) is untouched.
CREATE OR REPLACE FUNCTION public.guard_catalog_product_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_code text := NULLIF(NEW.payload->>'productCode', '');
  old_code text;
  code_retired timestamptz;
  code_category text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_code := NULLIF(OLD.payload->>'productCode', '');
  ELSE
    -- A save is an upsert, which fires this before its ON CONFLICT update: a seller saving a product
    -- that already carries a code is not changing it.
    SELECT NULLIF(payload->>'productCode', '') INTO old_code FROM public.catalog_products WHERE id = NEW.id;
  END IF;
  IF new_code IS NOT DISTINCT FROM old_code THEN
    RETURN NEW;
  END IF;
  -- The server never means to change a code: it can only have been writing a copy read a moment before.
  -- Visitors have no user id either, but they aren't the server.
  IF auth.uid() IS NULL AND current_setting('role', true) IS DISTINCT FROM 'anon' THEN
    NEW.payload := CASE WHEN old_code IS NULL THEN NEW.payload - 'productCode' ELSE NEW.payload || jsonb_build_object('productCode', old_code) END;
    RETURN NEW;
  END IF;
  -- This runs before row rules, so a visitor gets the same answer whichever code they try.
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only an administrator can change a product''s code' USING ERRCODE = '42501';
  END IF;
  IF new_code IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.vendor_id LIKE 'zoho:%' THEN
    RAISE EXCEPTION 'Zoho-imported copies do not carry product codes';
  END IF;
  SELECT c.retired_at, s.category INTO code_retired, code_category
  FROM public.product_codes c JOIN public.product_code_sets s ON s.id = c.set_id
  WHERE c.code = new_code;
  IF code_category IS NULL THEN
    RAISE EXCEPTION 'Code % is not in the product code list', new_code;
  END IF;
  IF code_retired IS NOT NULL THEN
    RAISE EXCEPTION 'Code % is retired, so it cannot go on another product', new_code;
  END IF;
  IF lower(regexp_replace(trim(code_category), '\s+', ' ', 'g')) <> lower(regexp_replace(trim(NEW.category), '\s+', ' ', 'g')) THEN
    RAISE EXCEPTION 'Code % belongs to %, but this product is in %', new_code, code_category, NEW.category;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS catalog_products_code_guard_insert ON public.catalog_products;
CREATE TRIGGER catalog_products_code_guard_insert BEFORE INSERT ON public.catalog_products
  FOR EACH ROW WHEN (NEW.payload ? 'productCode') EXECUTE FUNCTION public.guard_catalog_product_code();
DROP TRIGGER IF EXISTS catalog_products_code_guard_update ON public.catalog_products;
CREATE TRIGGER catalog_products_code_guard_update BEFORE UPDATE ON public.catalog_products
  FOR EACH ROW WHEN (NEW.payload->>'productCode' IS DISTINCT FROM OLD.payload->>'productCode')
  EXECUTE FUNCTION public.guard_catalog_product_code();

-- Puts a code on a product or takes it off. Only that field changes, and not updated_at, so the Zoho
-- sync has nothing to notice and "latest edit wins" can't flip. The guard above still does the checking.
CREATE OR REPLACE FUNCTION public.admin_set_product_code(_product_id text, _code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  wanted text := NULLIF(upper(trim(COALESCE(_code, ''))), '');
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only an administrator can change a product''s code' USING ERRCODE = '42501';
  END IF;
  UPDATE public.catalog_products
  SET payload = CASE WHEN wanted IS NULL THEN payload - 'productCode' ELSE payload || jsonb_build_object('productCode', wanted) END
  WHERE id = _product_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.admin_set_product_code(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_product_code(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.product_code_set_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_code_part_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_code_part_retired() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_code_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_code_before_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_code_no_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_catalog_product_code() FROM PUBLIC, anon, authenticated;

-- The client's workbook: Legend sheet for the letters, Code List sheet for the order. The insert
-- trigger above works out each code (RS01 .. NM01) and its name ("Raw Rice - Sona Rice", the workbook's
-- Description column). No other category is seeded and no product is linked.
DO $$
DECLARE
  rice uuid;
  method_row record;
  variety_row record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_code_sets WHERE lower(category) = 'rice') THEN
    RETURN;
  END IF;
  INSERT INTO public.product_code_sets (category) VALUES ('Rice') RETURNING id INTO rice;
  INSERT INTO public.product_code_methods (set_id, letter, name, sort_order) VALUES
    (rice, 'R', 'Raw Rice', 1),
    (rice, 'S', 'Steam Rice', 2),
    (rice, 'P', 'Half Boiled', 3),
    (rice, 'B', 'Boiled', 4),
    (rice, 'N', 'Broken', 5);
  INSERT INTO public.product_code_varieties (set_id, letter, name, sort_order) VALUES
    (rice, 'S', 'Sona Rice', 1),
    (rice, 'K', 'Kaveri Rice', 2),
    (rice, 'N', 'RNR', 3),
    (rice, 'H', 'HMT', 4),
    (rice, 'J', 'JSR (Bullet)', 5),
    (rice, 'M', 'Basmati (Sriram Sona)', 6);
  FOR method_row IN SELECT id FROM public.product_code_methods WHERE set_id = rice ORDER BY sort_order LOOP
    FOR variety_row IN SELECT id FROM public.product_code_varieties WHERE set_id = rice ORDER BY sort_order LOOP
      INSERT INTO public.product_codes (set_id, method_id, variety_id) VALUES (rice, method_row.id, variety_row.id);
    END LOOP;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
