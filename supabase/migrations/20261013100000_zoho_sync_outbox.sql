-- Reliable outbound sync queue. Database triggers only enqueue identifiers;
-- the worker always reads the latest authoritative row before sending to Zoho.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS zoho_salesorder_id text,
  ADD COLUMN IF NOT EXISTS zoho_last_polled_at timestamptz;

CREATE TABLE IF NOT EXISTS public.zoho_item_links (
  product_id text PRIMARY KEY REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  zoho_item_id text NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_polled_at timestamptz,
  last_zoho_modified_at timestamptz,
  app_fingerprint text
);
ALTER TABLE public.zoho_item_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_item_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_item_links TO service_role;

-- A catalog row may be hard-deleted by an administrator or vendor. Keep its
-- remote item ID only until the worker deactivates the Zoho item.
CREATE TABLE IF NOT EXISTS public.zoho_catalog_tombstones (
  product_id text PRIMARY KEY,
  zoho_item_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zoho_catalog_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_catalog_tombstones FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_catalog_tombstones TO service_role;

CREATE TABLE IF NOT EXISTS public.zoho_contact_links (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_type text NOT NULL CHECK (contact_type IN ('customer', 'vendor')),
  zoho_contact_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_type),
  UNIQUE (zoho_contact_id, contact_type)
);
ALTER TABLE public.zoho_contact_links ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;
ALTER TABLE public.zoho_contact_links ADD COLUMN IF NOT EXISTS last_zoho_modified_at timestamptz;
ALTER TABLE public.zoho_contact_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_contact_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_contact_links TO service_role;

ALTER TABLE public.addresses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS addresses_touch ON public.addresses;
CREATE TRIGGER addresses_touch BEFORE UPDATE ON public.addresses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- OAuth state is retained only as a hash, is tied to the initiating Grain
-- Bazar administrator, and is consumed atomically by the callback. This adds
-- one-time-use protection in addition to the signed, short-lived state value.
CREATE TABLE IF NOT EXISTS public.zoho_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  region text NOT NULL CHECK (region IN ('com', 'eu', 'in', 'com_au', 'jp', 'ca')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zoho_oauth_states_expiry_idx
  ON public.zoho_oauth_states (expires_at);
ALTER TABLE public.zoho_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_oauth_states TO service_role;

CREATE TABLE IF NOT EXISTS public.zoho_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('customer', 'order', 'catalog')),
  entity_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('upsert')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed', 'complete', 'needs_review')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Retain forward compatibility when this migration is re-applied to an early
-- preview database that was created before catalog jobs were added.
ALTER TABLE public.zoho_sync_outbox
  DROP CONSTRAINT IF EXISTS zoho_sync_outbox_entity_type_check;
ALTER TABLE public.zoho_sync_outbox
  ADD CONSTRAINT zoho_sync_outbox_entity_type_check
  CHECK (entity_type IN ('customer', 'order', 'catalog'));
ALTER TABLE public.zoho_sync_outbox
  ALTER COLUMN entity_id TYPE text USING entity_id::text;

CREATE INDEX IF NOT EXISTS zoho_sync_outbox_ready_idx
  ON public.zoho_sync_outbox (available_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS zoho_sync_outbox_one_pending_entity
  ON public.zoho_sync_outbox (entity_type, entity_id, event_type)
  WHERE status = 'pending';

ALTER TABLE public.zoho_sync_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_sync_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_sync_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_zoho_sync(_entity_type text, _entity_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type)
  VALUES (_entity_type, _entity_id, 'upsert')
  ON CONFLICT (entity_type, entity_id, event_type) WHERE status = 'pending'
  DO UPDATE SET available_at = now(), updated_at = now(), last_error = NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_sync(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_zoho_customer_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM public.enqueue_zoho_sync('customer', NEW.id::text);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_customer_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS profiles_enqueue_zoho_sync ON public.profiles;
CREATE TRIGGER profiles_enqueue_zoho_sync
  AFTER INSERT OR UPDATE OF full_name, email, phone, company, gstin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_customer_change();

-- A customer created by the auth trigger gets its role after its profile. Queue
-- the role insert too, otherwise that first profile event may be skipped.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_role_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.role IN ('customer', 'vendor') THEN
    PERFORM public.enqueue_zoho_sync('customer', NEW.user_id::text);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_role_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS user_roles_enqueue_zoho_sync ON public.user_roles;
CREATE TRIGGER user_roles_enqueue_zoho_sync
  AFTER INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_role_change();

CREATE OR REPLACE FUNCTION public.enqueue_zoho_catalog_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  current_fields jsonb;
  previous_fields jsonb;
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' OR NEW.vendor_id LIKE 'zoho:%' THEN
    RETURN NEW;
  END IF;
  current_fields := jsonb_build_object(
    'name', NEW.payload->'name', 'sku', NEW.payload->'sku', 'price', NEW.payload->'price',
    'mrp', NEW.payload->'mrp', 'purchasePrice', NEW.payload->'purchasePrice',
    'minimumStock', NEW.payload->'minimumStock', 'description', NEW.payload->'description',
    'weight', NEW.payload->'weight', 'category', NEW.category, 'status', NEW.status, 'active', NEW.active
  );
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN PERFORM public.enqueue_zoho_sync('catalog', NEW.id); END IF;
    RETURN NEW;
  END IF;
  previous_fields := jsonb_build_object(
    'name', OLD.payload->'name', 'sku', OLD.payload->'sku', 'price', OLD.payload->'price',
    'mrp', OLD.payload->'mrp', 'purchasePrice', OLD.payload->'purchasePrice',
    'minimumStock', OLD.payload->'minimumStock', 'description', OLD.payload->'description',
    'weight', OLD.payload->'weight', 'category', OLD.category, 'status', OLD.status, 'active', OLD.active
  );
  IF current_fields IS DISTINCT FROM previous_fields THEN
    PERFORM public.enqueue_zoho_sync('catalog', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_catalog_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_products_enqueue_zoho_sync ON public.catalog_products;
CREATE TRIGGER catalog_products_enqueue_zoho_sync
  AFTER INSERT OR UPDATE ON public.catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_catalog_change();

CREATE OR REPLACE FUNCTION public.enqueue_zoho_catalog_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.vendor_id NOT LIKE 'zoho:%' THEN
    INSERT INTO public.zoho_catalog_tombstones (product_id, zoho_item_id)
      SELECT OLD.id, zoho_item_id FROM public.zoho_item_links WHERE product_id = OLD.id
      ON CONFLICT (product_id) DO UPDATE
        SET zoho_item_id = EXCLUDED.zoho_item_id, deleted_at = now();
    PERFORM public.enqueue_zoho_sync('catalog', OLD.id);
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_catalog_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS catalog_products_enqueue_zoho_delete ON public.catalog_products;
CREATE TRIGGER catalog_products_enqueue_zoho_delete
  BEFORE DELETE ON public.catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_catalog_delete();

CREATE OR REPLACE FUNCTION public.enqueue_zoho_address_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM public.enqueue_zoho_sync('customer', OLD.user_id::text);
    RETURN OLD;
  END IF;
  PERFORM public.enqueue_zoho_sync('customer', NEW.user_id::text);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_address_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS addresses_enqueue_zoho_sync ON public.addresses;
CREATE TRIGGER addresses_enqueue_zoho_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.addresses
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_address_change();

CREATE OR REPLACE FUNCTION public.enqueue_zoho_order_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.zoho_inbound', true) = 'on' THEN RETURN NEW; END IF;
  PERFORM public.enqueue_zoho_sync('order', NEW.id::text);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_order_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_enqueue_zoho_sync ON public.orders;
CREATE TRIGGER orders_enqueue_zoho_sync
  AFTER INSERT OR UPDATE OF customer_name, customer_email, customer_phone, customer_gstin,
    subtotal, discount, gst_amount, shipping, total, payment_status, order_status,
    shipping_method, shipping_address ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_order_change();

-- Order totals and line items can be corrected by the protected admin order
-- workflow after placement. Requeue the parent order when that happens so a
-- later Zoho sales-order sync always reads the final line quantity, price and
-- tax instead of a stale header-only snapshot. The normal checkout inserts the
-- header and lines in one transaction, so outside workers only see the fully
-- committed order; this trigger covers subsequent line edits as well.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_order_item_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  parent_order_id uuid;
BEGIN
  parent_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  IF current_setting('app.zoho_inbound', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM public.enqueue_zoho_sync('order', parent_order_id::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_zoho_order_item_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS order_items_enqueue_zoho_sync ON public.order_items;
CREATE TRIGGER order_items_enqueue_zoho_sync
  AFTER INSERT OR UPDATE OR DELETE
  ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_order_item_change();

-- Worker claim is atomic: concurrent cron invocations cannot claim the same row.
CREATE OR REPLACE FUNCTION public.claim_zoho_sync_jobs(_limit integer DEFAULT 20)
RETURNS SETOF public.zoho_sync_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH ready AS (
    SELECT id FROM public.zoho_sync_outbox
    WHERE ((status IN ('pending', 'failed') AND available_at <= now())
      OR (status = 'processing' AND locked_until < now()))
      AND attempts < 12
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(_limit, 1), 50)
  )
  UPDATE public.zoho_sync_outbox q
    SET status = 'processing', attempts = q.attempts + 1,
        locked_until = now() + interval '3 minutes', updated_at = now()
  FROM ready WHERE q.id = ready.id
  RETURNING q.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_zoho_sync_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_zoho_sync_jobs(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_zoho_sync_job(_id uuid, _status text, _error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _status NOT IN ('complete', 'failed', 'needs_review') THEN
    RAISE EXCEPTION 'Invalid Zoho sync job result';
  END IF;
  UPDATE public.zoho_sync_outbox
  SET status = _status,
      last_error = left(_error, 1000),
      locked_until = NULL,
      available_at = CASE WHEN _status = 'failed'
        THEN now() + LEAST(interval '6 hours', interval '15 seconds' * power(2, LEAST(attempts, 10)))
        ELSE available_at END,
      updated_at = now()
  WHERE id = _id AND status = 'processing';
END;
$$;
REVOKE ALL ON FUNCTION public.finish_zoho_sync_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_zoho_sync_job(uuid, text, text) TO service_role;

-- Requeue only a selected review/failed job. A newer pending change wins; the
-- older job is never allowed to overwrite it after a human retry.
CREATE OR REPLACE FUNCTION public.retry_zoho_sync_job(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  selected_job public.zoho_sync_outbox%ROWTYPE;
  pending_job_id uuid;
BEGIN
  SELECT * INTO selected_job FROM public.zoho_sync_outbox
    WHERE id = _id AND status IN ('failed', 'needs_review') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only failed or review-required jobs can be retried'; END IF;

  SELECT id INTO pending_job_id FROM public.zoho_sync_outbox
    WHERE entity_type = selected_job.entity_type AND entity_id = selected_job.entity_id
      AND event_type = selected_job.event_type AND status = 'pending'
    LIMIT 1 FOR UPDATE;
  IF pending_job_id IS NOT NULL THEN
    UPDATE public.zoho_sync_outbox
      SET available_at = now(), updated_at = now(), last_error = NULL
      WHERE id = pending_job_id;
    UPDATE public.zoho_sync_outbox
      SET status = 'complete', last_error = 'Superseded by a newer pending sync job', updated_at = now()
      WHERE id = _id;
  ELSE
    UPDATE public.zoho_sync_outbox
      SET status = 'pending', attempts = 0, available_at = now(), locked_until = NULL,
          last_error = NULL, updated_at = now()
      WHERE id = _id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_zoho_sync_job(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_zoho_sync_job(uuid) TO service_role;

-- Inbound Zoho edits affect only marketplace-owned contact/address fields.
-- Zoho email edits are excluded because they must be verified in Supabase Auth.
CREATE OR REPLACE FUNCTION public.apply_zoho_contact_update(
  _user_id uuid, _contact_type text, _full_name text, _phone text,
  _company text, _gstin text, _address jsonb DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  address_row public.addresses%ROWTYPE;
  address_line text := NULLIF(trim(COALESCE(_address->>'address', '')), '');
  address_city text := NULLIF(trim(COALESCE(_address->>'city', '')), '');
  address_state text := NULLIF(trim(COALESCE(_address->>'state', '')), '');
  address_pin text := NULLIF(trim(COALESCE(_address->>'zip', '')), '');
BEGIN
  IF _contact_type NOT IN ('customer', 'vendor') OR NOT public.has_role(_user_id, _contact_type::public.app_role) THEN
    RAISE EXCEPTION 'Zoho contact type does not match the Grain Bazar account role';
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.profiles
  SET full_name = COALESCE(NULLIF(trim(_full_name), ''), full_name),
      phone = COALESCE(NULLIF(trim(_phone), ''), phone),
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
      UPDATE public.addresses SET
        line = address_line, city = address_city, state = address_state, pin = address_pin,
        name = COALESCE(NULLIF(trim(_address->>'attention'), ''), name),
        phone = COALESCE(NULLIF(trim(_phone), ''), phone), updated_at = now()
      WHERE id = address_row.id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.addresses WHERE user_id = _user_id) THEN
      INSERT INTO public.addresses (user_id, label, name, phone, line, city, state, pin, is_default)
      VALUES (_user_id, 'Default', COALESCE(NULLIF(trim(_address->>'attention'), ''), COALESCE(NULLIF(trim(_full_name), ''), 'Customer')),
        COALESCE(NULLIF(trim(_phone), ''), ''), address_line, address_city, address_state, address_pin, true);
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_zoho_contact_update(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_contact_update(uuid, text, text, text, text, text, jsonb) TO service_role;

-- Only the item attributes that are shared with the marketplace can move from
-- Zoho into an app product. Product images, categories and stock adjustments
-- need their own Zoho endpoint/approval workflow and are intentionally kept
-- out of this contact/order worker.
CREATE OR REPLACE FUNCTION public.apply_zoho_catalog_item(
  _product_id text, _item jsonb, _expected_updated_at timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  item_rate numeric;
  item_purchase_rate numeric;
  item_reorder_level numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catalog_products WHERE id = _product_id) THEN
    RAISE EXCEPTION 'Mapped Grain Bazar product no longer exists';
  END IF;
  item_rate := CASE WHEN COALESCE(_item->>'rate', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'rate')::numeric END;
  item_purchase_rate := CASE WHEN COALESCE(_item->>'purchase_rate', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'purchase_rate')::numeric END;
  item_reorder_level := CASE WHEN COALESCE(_item->>'reorder_level', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (_item->>'reorder_level')::numeric END;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  UPDATE public.catalog_products
  SET active = CASE lower(COALESCE(_item->>'status', ''))
        WHEN 'active' THEN true WHEN 'inactive' THEN false ELSE active END,
      payload = payload || jsonb_strip_nulls(jsonb_build_object(
        'name', NULLIF(trim(COALESCE(_item->>'name', '')), ''),
        'sku', NULLIF(trim(COALESCE(_item->>'sku', '')), ''),
        'price', CASE WHEN item_rate IS NOT NULL THEN to_jsonb(item_rate) END,
        'purchasePrice', CASE WHEN item_purchase_rate IS NOT NULL THEN to_jsonb(item_purchase_rate) END,
        'minimumStock', CASE WHEN item_reorder_level IS NOT NULL THEN to_jsonb(item_reorder_level) END,
        'description', NULLIF(trim(COALESCE(_item->>'description', '')), '')
      )),
      updated_at = now()
  WHERE id = _product_id
    AND updated_at = _expected_updated_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Grain Bazar product changed while applying the Zoho item update';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_zoho_catalog_item(text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_catalog_item(text, jsonb, timestamptz) TO service_role;

-- Shipment records are authoritative only for explicit shipped/delivered
-- milestones. Generic Zoho sales-order states are deliberately ignored.
CREATE OR REPLACE FUNCTION public.apply_zoho_order_fulfillment(_order_id uuid, _status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  current_status text;
BEGIN
  IF _status NOT IN ('Dispatched', 'Delivered') THEN
    RAISE EXCEPTION 'Unsupported Zoho fulfillment status';
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  SELECT order_status INTO current_status FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF current_status <> 'Cancelled'
    AND NOT (current_status = 'Delivered' AND _status = 'Dispatched')
    AND NOT (current_status = 'Out for Delivery' AND _status = 'Dispatched') THEN
    UPDATE public.orders SET order_status = _status, updated_at = now()
      WHERE id = _order_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_zoho_order_fulfillment(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_order_fulfillment(uuid, text) TO service_role;
