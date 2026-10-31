-- Batch / stock-number tracking per godown (client request, 31 Oct 2026).
--
-- A purchase received at a godown is one batch with a fixed number (CLK-311026-01: godown code,
-- purchase date, running number that day). Website orders take stock from the oldest batch at the
-- order's godown first (FIFO), split over two batches when needed; stock without a batch stays
-- unbatched. Cancels, expired payment holds and quantity cuts give it back (existing release code).
-- Losses and gains from stock counts are kept per batch, so every batch shows purchased, sold,
-- available, lost, sales, profit and how long it took to sell out. Batches the client creates in
-- Zoho (batch-tracked items) are linked or imported by the server sync.
--
-- Writes go only through the functions below: the server (service role) records receipts,
-- adjustments and Zoho links; admins edit only the descriptive fields.

CREATE SCHEMA IF NOT EXISTS private;

-- ---------------------------------------------------------------- batches: godown, Zoho, supplier
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS branch_id text REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'website',
  ADD COLUMN IF NOT EXISTS supplier text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS purchase_ref text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS received_by uuid,
  ADD COLUMN IF NOT EXISTS received_by_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_item_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_batch_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_adjustment_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS zoho_balance numeric(14,2),
  ADD COLUMN IF NOT EXISTS zoho_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS depleted_at timestamptz;

ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_source_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_source_check CHECK (source IN ('website', 'zoho'));
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_quantities_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_quantities_check CHECK (quantity >= 0 AND remaining_quantity >= 0 AND unit_cost >= 0);

-- One number per godown (a Zoho transfer can carry a batch to a second godown under the same number).
CREATE UNIQUE INDEX IF NOT EXISTS batches_code_branch_unique ON public.batches (upper(batch_code), COALESCE(branch_id, ''));
CREATE UNIQUE INDEX IF NOT EXISTS batches_zoho_batch_branch_unique ON public.batches (zoho_batch_id, COALESCE(branch_id, '')) WHERE zoho_batch_id <> '';
CREATE INDEX IF NOT EXISTS batches_fifo_idx ON public.batches (product_id, branch_id, purchase_date, created_at);

/** Sold out = Depleted with the moment it happened; stock back = Active again. */
CREATE OR REPLACE FUNCTION private.batch_stock_state()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.remaining_quantity <= 0 THEN
    NEW.status := 'Depleted';
    IF TG_OP = 'INSERT' OR OLD.remaining_quantity > 0 THEN
      NEW.depleted_at := now();
    ELSE
      NEW.depleted_at := COALESCE(OLD.depleted_at, now());
    END IF;
  ELSE
    NEW.status := 'Active';
    NEW.depleted_at := NULL;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS batches_stock_state ON public.batches;
CREATE TRIGGER batches_stock_state BEFORE INSERT OR UPDATE OF remaining_quantity ON public.batches
  FOR EACH ROW EXECUTE FUNCTION private.batch_stock_state();

-- Only the functions below write batches (the ledger must add up).
DROP POLICY IF EXISTS batches_admin_write ON public.batches;
DROP POLICY IF EXISTS batches_read ON public.batches;
CREATE POLICY batches_read ON public.batches FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.batches TO authenticated;
GRANT ALL ON public.batches TO service_role;

-- ---------------------------------------------------------------- losses and gains per batch
CREATE TABLE IF NOT EXISTS public.batch_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  qty numeric(14,2) NOT NULL CHECK (qty <> 0),
  reason text NOT NULL CHECK (reason IN ('stock_count', 'damaged', 'correction', 'zoho_sync', 'return')),
  note text NOT NULL DEFAULT '',
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  stock_count_id uuid REFERENCES public.stock_counts(id) ON DELETE SET NULL,
  zoho_adjustment_id text NOT NULL DEFAULT '',
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batch_adjustments_batch_idx ON public.batch_adjustments (batch_id, created_at);
ALTER TABLE public.batch_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.batch_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.batch_adjustments TO authenticated;
GRANT ALL ON public.batch_adjustments TO service_role;
DROP POLICY IF EXISTS batch_adjustments_admin_read ON public.batch_adjustments;
CREATE POLICY batch_adjustments_admin_read ON public.batch_adjustments FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX IF NOT EXISTS order_item_batch_allocations_batch_idx ON public.order_item_batch_allocations (batch_id);

-- Zoho "Track batches" on the item (read by the stock sync): its packages and adjustments must name batches.
ALTER TABLE public.zoho_item_links ADD COLUMN IF NOT EXISTS track_batches boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- batch numbers
/** Next free number for a godown and purchase date: CLK-311026-01, CLK-311026-02, ... */
CREATE OR REPLACE FUNCTION public.next_batch_code(_branch_id text, _purchase_date date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  godown_code text;
  prefix text;
  last_no integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may number batches';
  END IF;
  SELECT upper(COALESCE(NULLIF(btrim(code), ''), regexp_replace(id, '^BR-', ''))) INTO godown_code
    FROM public.branches WHERE id = _branch_id;
  IF godown_code IS NULL THEN RAISE EXCEPTION 'Unknown godown'; END IF;
  prefix := godown_code || '-' || to_char(COALESCE(_purchase_date, (now() AT TIME ZONE 'Asia/Kolkata')::date), 'DDMMYY') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('batch_code:' || prefix));
  SELECT COALESCE(max((substring(batch_code FROM length(prefix) + 1))::integer), 0) INTO last_no
    FROM public.batches
    WHERE upper(batch_code) LIKE prefix || '%' AND substring(batch_code FROM length(prefix) + 1) ~ '^[0-9]{1,4}$';
  RETURN prefix || lpad((last_no + 1)::text, 2, '0');
END $function$;
REVOKE ALL ON FUNCTION public.next_batch_code(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_batch_code(text, date) TO authenticated, service_role;

-- ---------------------------------------------------------------- FIFO allocation at the order's godown
/** Takes up to _qty from the oldest batches of the product at the godown; returns what it took. */
CREATE OR REPLACE FUNCTION private.allocate_order_item_batches(_order_item_id uuid, _product_id text, _branch_id text, _qty numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  needed numeric(14,2) := COALESCE(_qty, 0);
  taken numeric(14,2);
  batch_row record;
BEGIN
  IF needed <= 0 OR _branch_id IS NULL OR _product_id IS NULL THEN RETURN 0; END IF;
  FOR batch_row IN
    SELECT id, remaining_quantity, unit_cost FROM public.batches
    WHERE product_id = _product_id AND branch_id = _branch_id AND remaining_quantity > 0
    ORDER BY purchase_date ASC NULLS LAST, created_at ASC, batch_code ASC
    FOR UPDATE
  LOOP
    EXIT WHEN needed <= 0;
    taken := LEAST(needed, batch_row.remaining_quantity);
    UPDATE public.batches SET remaining_quantity = remaining_quantity - taken WHERE id = batch_row.id;
    INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, unit_cost)
      VALUES (_order_item_id, batch_row.id, taken, batch_row.unit_cost);
    needed := needed - taken;
  END LOOP;
  RETURN COALESCE(_qty, 0) - needed;
END $function$;
REVOKE ALL ON FUNCTION private.allocate_order_item_batches(uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- receive a purchase (server only)
/**
 * Records a purchase as one batch at a godown and adds it to the godown's website stock.
 * _zoho_done: Zoho already has the stock (the server made the batch adjustment first), so the
 * website only follows; otherwise the stock waits to go to Zoho like any manual stock edit.
 */
CREATE OR REPLACE FUNCTION public.record_batch_receipt(
  _batch_code text, _branch_id text, _product_id text, _quantity numeric, _unit_cost numeric,
  _purchase_date date, _mfg_date date, _expiry_date date, _supplier text, _purchase_ref text, _notes text,
  _zoho_item_id text, _zoho_batch_id text, _zoho_adjustment_id text, _zoho_done boolean,
  _received_by uuid, _received_by_name text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  product_row public.catalog_products%ROWTYPE;
  branch_row public.branches%ROWTYPE;
  new_id uuid;
  total numeric;
  code text := upper(btrim(COALESCE(_batch_code, '')));
BEGIN
  IF code !~ '^[A-Z0-9][A-Z0-9/_.-]{1,39}$' THEN RAISE EXCEPTION 'Batch number: 2-40 letters, digits, - / _ .'; END IF;
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity > 1000000 THEN RAISE EXCEPTION 'Enter the quantity received'; END IF;
  IF _unit_cost IS NULL OR _unit_cost < 0 OR _unit_cost > 100000000 THEN RAISE EXCEPTION 'Enter the purchase cost per unit'; END IF;
  SELECT * INTO branch_row FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT branch_row.active OR branch_row.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  SELECT * INTO product_row FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND OR COALESCE(product_row.vendor_id, '') LIKE 'zoho:%' THEN RAISE EXCEPTION 'Product not found in the catalogue'; END IF;
  IF EXISTS (SELECT 1 FROM public.batches WHERE upper(batch_code) = code) THEN
    RAISE EXCEPTION 'Batch number % is already used. Each purchase needs its own number.', code;
  END IF;

  INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
    unit_cost, purchase_date, mfg_date, expiry_date, warehouse, branch_id, source, supplier, purchase_ref, notes,
    received_by, received_by_name, zoho_item_id, zoho_batch_id, zoho_adjustment_id, status)
  VALUES (code, product_row.id, COALESCE(product_row.payload->>'name', product_row.id), product_row.payload->>'vendor',
    product_row.vendor_id, _quantity, _quantity, COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'), _unit_cost,
    COALESCE(_purchase_date, (now() AT TIME ZONE 'Asia/Kolkata')::date), _mfg_date, _expiry_date, branch_row.name, branch_row.id,
    'website', left(btrim(COALESCE(_supplier, '')), 120), left(btrim(COALESCE(_purchase_ref, '')), 80),
    left(btrim(COALESCE(_notes, '')), 300), _received_by, left(COALESCE(_received_by_name, ''), 120),
    COALESCE(_zoho_item_id, ''), COALESCE(_zoho_batch_id, ''), COALESCE(_zoho_adjustment_id, ''), 'Active')
  RETURNING id INTO new_id;

  IF COALESCE(_zoho_done, false) THEN
    -- Zoho has it already: the godown's website stock follows, nothing waits to go to Zoho.
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (branch_row.id, product_row.id, _quantity, false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = public.branch_stock.stock + _quantity, updated_at = now();
    SELECT COALESCE(SUM(stock), 0) INTO total FROM public.branch_stock WHERE product_id = product_row.id;
    PERFORM set_config('app.branch_stock_sync', 'on', true);
    UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
      WHERE id = product_row.id;
    PERFORM set_config('app.branch_stock_sync', 'off', true);
  ELSE
    -- Website-only receipt: added to this godown and marked to go to Zoho at the next sync.
    PERFORM set_config('app.branch_id', branch_row.id, true);
    PERFORM set_config('app.stock_manual', 'on', true);
    UPDATE public.catalog_products
      SET payload = jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + _quantity), true), updated_at = now()
      WHERE id = product_row.id;
    PERFORM set_config('app.stock_manual', 'off', true);
    PERFORM set_config('app.branch_id', '', true);
  END IF;
  RETURN new_id;
END $function$;
REVOKE ALL ON FUNCTION public.record_batch_receipt(text, text, text, numeric, numeric, date, date, date, text, text, text, text, text, text, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_batch_receipt(text, text, text, numeric, numeric, date, date, date, text, text, text, text, text, text, boolean, uuid, text) TO service_role;

-- ---------------------------------------------------------------- losses / gains (server only)
/**
 * Applies the per-batch split the server chose (and sent to Zoho) for a stock change:
 * _rows = [{batch_id, qty (+ gain / - loss), reason, note, stock_count_id, zoho_adjustment_id}].
 * A loss never takes a batch below zero; returns how many rows were recorded.
 */
CREATE OR REPLACE FUNCTION public.record_batch_adjustments(_rows jsonb, _created_by uuid, _created_by_name text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  line jsonb;
  batch_row public.batches%ROWTYPE;
  change numeric(14,2);
  recorded integer := 0;
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    SELECT * INTO batch_row FROM public.batches WHERE id = (line->>'batch_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown batch'; END IF;
    change := round(COALESCE((line->>'qty')::numeric, 0), 2);
    IF change < 0 THEN change := GREATEST(change, -batch_row.remaining_quantity); END IF;
    CONTINUE WHEN change = 0;
    UPDATE public.batches SET remaining_quantity = remaining_quantity + change WHERE id = batch_row.id;
    INSERT INTO public.batch_adjustments (batch_id, qty, reason, note, unit_cost, stock_count_id, zoho_adjustment_id, created_by, created_by_name)
    VALUES (batch_row.id, change, COALESCE(line->>'reason', 'correction'), left(COALESCE(line->>'note', ''), 200), batch_row.unit_cost,
      NULLIF(line->>'stock_count_id', '')::uuid, COALESCE(line->>'zoho_adjustment_id', ''), _created_by, left(COALESCE(_created_by_name, ''), 120));
    recorded := recorded + 1;
  END LOOP;
  RETURN recorded;
END $function$;
REVOKE ALL ON FUNCTION public.record_batch_adjustments(jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_batch_adjustments(jsonb, uuid, text) TO service_role;

-- ---------------------------------------------------------------- Zoho batches (server only)
/**
 * The server's Zoho read of batch-tracked items: _rows = [{zoho_batch_id, batch_number, product_id,
 * branch_id, zoho_item_id, in_quantity, balance, mfg_date, expiry_date, unit_cost, seen_on}].
 * A website batch with the same number (or Zoho id) at that godown is linked and gets Zoho's
 * balance for the reconciliation; a batch made in Zoho (e.g. a Zoho purchase receive) is added.
 */
CREATE OR REPLACE FUNCTION public.apply_zoho_batches(_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  line jsonb;
  existing uuid;
  product_row public.catalog_products%ROWTYPE;
  branch_row public.branches%ROWTYPE;
  linked integer := 0;
  added integer := 0;
  balance numeric(14,2);
BEGIN
  FOR line IN SELECT value FROM jsonb_array_elements(COALESCE(_rows, '[]'::jsonb)) LOOP
    CONTINUE WHEN COALESCE(line->>'zoho_batch_id', '') = '' OR COALESCE(line->>'batch_number', '') = '';
    balance := GREATEST(0, COALESCE((line->>'balance')::numeric, 0));
    SELECT id INTO existing FROM public.batches
      WHERE branch_id = line->>'branch_id' AND product_id = line->>'product_id'
        AND (zoho_batch_id = line->>'zoho_batch_id' OR upper(batch_code) = upper(line->>'batch_number'))
      ORDER BY (zoho_batch_id = line->>'zoho_batch_id') DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE public.batches SET zoho_batch_id = line->>'zoho_batch_id', zoho_item_id = COALESCE(line->>'zoho_item_id', zoho_item_id),
        zoho_balance = balance, zoho_checked_at = now()
        WHERE id = existing;
      linked := linked + 1;
      CONTINUE;
    END IF;
    CONTINUE WHEN balance <= 0;  -- an empty Zoho batch the website never had: nothing to track
    SELECT * INTO product_row FROM public.catalog_products WHERE id = line->>'product_id';
    CONTINUE WHEN NOT FOUND;
    SELECT * INTO branch_row FROM public.branches WHERE id = line->>'branch_id';
    CONTINUE WHEN NOT FOUND;
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, purchase_date, mfg_date, expiry_date, warehouse, branch_id, source, notes, zoho_item_id, zoho_batch_id,
      zoho_balance, zoho_checked_at, status)
    VALUES (upper(line->>'batch_number'), product_row.id, COALESCE(product_row.payload->>'name', product_row.id),
      product_row.payload->>'vendor', product_row.vendor_id, GREATEST(balance, COALESCE((line->>'in_quantity')::numeric, 0)), balance,
      COALESCE(NULLIF(product_row.payload->>'unit', ''), 'pack'), GREATEST(0, COALESCE((line->>'unit_cost')::numeric, 0)),
      COALESCE(NULLIF(line->>'seen_on', '')::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),
      NULLIF(line->>'mfg_date', '')::date, NULLIF(line->>'expiry_date', '')::date, branch_row.name, branch_row.id, 'zoho',
      'Created in Zoho', COALESCE(line->>'zoho_item_id', ''), line->>'zoho_batch_id', balance, now(), 'Active');
    added := added + 1;
  END LOOP;
  RETURN jsonb_build_object('linked', linked, 'added', added);
END $function$;
REVOKE ALL ON FUNCTION public.apply_zoho_batches(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_batches(jsonb) TO service_role;

/** Server: remembers the Zoho batch id once Zoho has created the batch for a website receipt. */
CREATE OR REPLACE FUNCTION public.link_zoho_batch(_batch_id uuid, _zoho_batch_id text, _zoho_adjustment_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  UPDATE public.batches
    SET zoho_batch_id = COALESCE(NULLIF(_zoho_batch_id, ''), zoho_batch_id),
        zoho_adjustment_id = COALESCE(NULLIF(_zoho_adjustment_id, ''), zoho_adjustment_id)
    WHERE id = _batch_id;
$function$;
REVOKE ALL ON FUNCTION public.link_zoho_batch(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_zoho_batch(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------- admin edits (descriptive fields)
/** Admin: cost, supplier, bill/PO number, notes and dates of a batch. Quantities change only by orders and counts. */
CREATE OR REPLACE FUNCTION public.admin_update_batch(_batch_id uuid, _unit_cost numeric, _supplier text, _purchase_ref text,
  _notes text, _mfg_date date, _expiry_date date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may edit batches'; END IF;
  IF _unit_cost IS NULL OR _unit_cost < 0 OR _unit_cost > 100000000 THEN RAISE EXCEPTION 'Enter a valid purchase cost'; END IF;
  UPDATE public.batches
    SET unit_cost = _unit_cost, supplier = left(btrim(COALESCE(_supplier, '')), 120),
        purchase_ref = left(btrim(COALESCE(_purchase_ref, '')), 80), notes = left(btrim(COALESCE(_notes, '')), 300),
        mfg_date = _mfg_date, expiry_date = _expiry_date
    WHERE id = _batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- Sales already made from the batch take the corrected cost too (profit stays right).
  UPDATE public.order_item_batch_allocations SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
  UPDATE public.batch_adjustments SET unit_cost = _unit_cost WHERE batch_id = _batch_id;
END $function$;
REVOKE ALL ON FUNCTION public.admin_update_batch(uuid, numeric, text, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_batch(uuid, numeric, text, text, text, date, date) TO authenticated;

-- ---------------------------------------------------------------- customers see their batch numbers
/** Batch numbers on an order the caller may read (customer's own order, admin, vendor's own lines). */
CREATE OR REPLACE FUNCTION public.order_item_batches(_order_id uuid)
RETURNS TABLE (order_item_id uuid, batch_code text, qty numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT a.order_item_id, b.batch_code, SUM(a.reserved_quantity - a.released_quantity)
  FROM public.order_item_batch_allocations a
  JOIN public.order_items oi ON oi.id = a.order_item_id
  JOIN public.batches b ON b.id = a.batch_id
  WHERE oi.order_id = _order_id AND public.can_read_order(_order_id)
  GROUP BY a.order_item_id, b.batch_code, b.purchase_date
  HAVING SUM(a.reserved_quantity - a.released_quantity) > 0
  ORDER BY a.order_item_id, b.purchase_date, b.batch_code;
$function$;
REVOKE ALL ON FUNCTION public.order_item_batches(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_item_batches(uuid) TO authenticated;

-- ---------------------------------------------------------------- the old one-step receipt is replaced
CREATE OR REPLACE FUNCTION public.admin_receive_inventory_batch(_batch_code text, _product_id text, _quantity numeric,
  _unit_cost numeric, _purchase_date date, _warehouse text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  RAISE EXCEPTION 'Record purchases in Admin > Batches > Receive purchase (choose the godown).';
END $function$;

-- ---------------------------------------------------------------- order functions: FIFO at the order's godown
-- Built from the live definitions (pg_get_functiondef, 31 Oct 2026); only the batch block changed.
CREATE OR REPLACE FUNCTION public.place_marketplace_order(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  line jsonb;
  item_product public.catalog_products%ROWTYPE;
  qty integer;
  subtotal numeric(14,2) := 0;
  gst_amount numeric(14,2) := 0;
  shipping_amount numeric(14,2) := 0;
  order_total numeric(14,2);
  product_price numeric(14,2);
  product_gst numeric(5,2);
  stock_now numeric(14,2);
  target_branch text;
  final_order_no text;
  branch_row public.branches%ROWTYPE;
  fulfilment text;
  routing_on boolean;
  vendor_points text[];
  items_json jsonb := '[]'::jsonb;
  created_order_id uuid;
  order_item_id uuid;
  batch_row record;
  qty_to_allocate numeric(14,2);
  batch_take numeric(14,2);
  available_batch_qty numeric(14,2);
  free_above numeric(14,2) := 10000;
  standard_shipping numeric(14,2) := 250;
  express_shipping numeric(14,2) := 650;
  profile_name text;
  profile_email text;
  profile_phone text;
  profile_gstin text;
BEGIN
  IF auth.uid() IS NULL OR _target_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in is required to place an order';
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    IF NOT public.has_role(_target_user_id, 'customer') THEN
      RAISE EXCEPTION 'The selected account is not a customer';
    END IF;
  ELSIF NOT public.has_role(auth.uid(), 'customer') OR _target_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Customers can place orders only for their own account';
  END IF;
  IF jsonb_typeof(_items) <> 'array' OR jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product to the order';
  END IF;
  IF _shipping_method NOT IN ('Pickup', 'Standard', 'Express') THEN
    RAISE EXCEPTION 'Invalid shipping method';
  END IF;
  IF _payment_method = 'Cash on Delivery' THEN
    RAISE EXCEPTION 'Cash on delivery is not enabled for this store';
  END IF;
  IF _shipping_address IS NULL OR jsonb_typeof(_shipping_address) <> 'object' THEN
    RAISE EXCEPTION 'A delivery address is required';
  END IF;
  IF COALESCE(_shipping_address->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT EXISTS (
      SELECT 1 FROM public.addresses
      WHERE id = (_shipping_address->>'id')::uuid AND user_id = _target_user_id
    ) THEN
    RAISE EXCEPTION 'Choose a saved address belonging to this customer account';
  END IF;
  SELECT full_name, email, phone, gstin
    INTO profile_name, profile_email, profile_phone, profile_gstin
    FROM public.profiles WHERE id = _target_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'The customer profile is incomplete'; END IF;

  SELECT COALESCE(MAX((value->>'free_above')::numeric), free_above),
         COALESCE(MAX((value->>'standard')::numeric), standard_shipping),
         COALESCE(MAX((value->>'express')::numeric), express_shipping)
    INTO free_above, standard_shipping, express_shipping
    FROM public.settings WHERE key = 'shipping' AND is_public;

  -- Branch: the godown serving the customer's PIN when branch routing is on, else the default.
  routing_on := COALESCE((SELECT (value->>'branch_routing')::boolean FROM public.settings WHERE key = 'platform_features'), false);
  target_branch := public.default_branch_id();
  IF routing_on THEN
    target_branch := COALESCE((
      SELECT b.id FROM public.branches b
      WHERE b.active AND (_shipping_address->>'pin') = ANY (b.serves_pincodes)
      ORDER BY b.is_default DESC, b.sort_order LIMIT 1), target_branch);
  END IF;
  -- Marketplace ON: an order is fulfilled from its vendors' fulfilment point (a Grain Bazar godown
  -- the vendor stocks, or the vendor's own location). Items from different points are separate orders.
  IF private.marketplace_enabled() THEN
    SELECT array_agg(DISTINCT point) INTO vendor_points FROM (
      SELECT public.vendor_fulfilment_branch(cp.vendor_id) AS point
      FROM jsonb_array_elements(_items) AS item(value)
      JOIN public.catalog_products cp ON cp.id = item.value->>'product_id'
    ) points WHERE point IS NOT NULL;
    IF COALESCE(array_length(vendor_points, 1), 0) > 1 THEN
      RAISE EXCEPTION 'These items are collected from different locations; place them as separate orders';
    END IF;
    IF COALESCE(array_length(vendor_points, 1), 0) = 1 THEN target_branch := vendor_points[1]; END IF;
  END IF;
  IF target_branch IS NULL THEN RAISE EXCEPTION 'No active godown is set up'; END IF;
  -- The order number names its godown, the delivery PIN and the moment it was placed (IST),
  -- e.g. CLK-577522-261026-143215. _order_no from older app versions is no longer used.
  final_order_no := public.next_godown_order_no(target_branch, _shipping_address->>'pin');

  FOR line IN SELECT value FROM jsonb_array_elements(_items)
  LOOP
    qty := (line->>'qty')::integer;
    IF qty IS NULL OR qty < 1 THEN RAISE EXCEPTION 'Invalid product quantity'; END IF;
    SELECT * INTO item_product FROM public.catalog_products
      WHERE id = line->>'product_id' AND status = 'approved' AND active
      FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A product is unavailable'; END IF;
    -- With godown matching on, each godown sells the items of its Zoho price list at that list's
    -- price (a godown without a price list sells every item at the base price).
    product_price := CASE WHEN routing_on
      THEN public.branch_product_price(target_branch, item_product.id)
      ELSE COALESCE((item_product.payload->>'price')::numeric, 0) END;
    IF product_price IS NULL THEN
      RAISE EXCEPTION '% is not sold at your godown. Remove it from the cart to continue.', COALESCE(item_product.payload->>'name', 'An item');
    END IF;
    product_gst := COALESCE((item_product.payload->>'gst')::numeric, 0);
    stock_now := CASE WHEN routing_on
      THEN COALESCE((SELECT stock FROM public.branch_stock WHERE branch_id = target_branch AND product_id = item_product.id), 0)
      ELSE COALESCE((item_product.payload->>'stock')::numeric, 0) END;
    IF product_price <= 0 OR stock_now < (
      SELECT SUM((requested->>'qty')::integer)
      FROM jsonb_array_elements(_items) AS requested(value)
      WHERE value->>'product_id' = line->>'product_id'
    ) THEN
      RAISE EXCEPTION 'A product does not have enough available stock';
    END IF;
    subtotal := subtotal + product_price * qty;
    gst_amount := gst_amount + round(product_price * qty * product_gst / 100, 2);
    items_json := items_json || jsonb_build_array(jsonb_build_object(
      'product_id', item_product.id,
      'product_name', item_product.payload->>'name',
      'sku', item_product.payload->>'sku',
      'vendor', item_product.payload->>'vendor',
      'vendor_id', item_product.vendor_id,
      'capacity', COALESCE(item_product.payload->>'weight', ''),
      'qty', qty,
      'unit_price', product_price,
      'gst_rate', product_gst,
      'line_total', product_price * qty
    ));
  END LOOP;

  -- Pickup or home delivery, as the order's godown offers. Pickup is free; delivery uses the
  -- godown's charge (free above its threshold). A delivery request where the godown only offers
  -- pickup becomes a pickup (older app versions always sent 'Standard').
  SELECT * INTO branch_row FROM public.branches WHERE id = target_branch;
  fulfilment := CASE WHEN _shipping_method = 'Pickup' THEN 'Pickup' ELSE 'Standard' END;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled AND branch_row.pickup_enabled THEN
    fulfilment := 'Pickup';
  END IF;
  IF fulfilment = 'Pickup' AND NOT branch_row.pickup_enabled THEN
    RAISE EXCEPTION 'This godown does not offer pickup; choose home delivery';
  END IF;
  IF fulfilment = 'Standard' AND NOT branch_row.delivery_enabled THEN
    RAISE EXCEPTION 'Home delivery is not available for this address yet';
  END IF;
  IF fulfilment = 'Standard' AND (branch_row.free_delivery_above IS NULL OR subtotal < branch_row.free_delivery_above) THEN
    shipping_amount := branch_row.delivery_fee;
  END IF;
  order_total := subtotal + gst_amount + shipping_amount;

  INSERT INTO public.orders (
    order_no, user_id, customer_name, customer_email, customer_phone, customer_gstin,
    vendor_ids, subtotal, discount, gst_amount, shipping, total, advance_due,
    balance_due, paid_amount, payment_method, payment_status, order_status,
    shipping_method, shipping_address, branch_id
  ) VALUES (
    final_order_no, _target_user_id, COALESCE(profile_name, ''), COALESCE(profile_email, ''),
    profile_phone, profile_gstin,
    ARRAY(SELECT DISTINCT value->>'vendor_id' FROM jsonb_array_elements(items_json)),
    subtotal, 0, gst_amount, shipping_amount, order_total, 0, order_total, 0,
    _payment_method, 'Pending', 'Placed', fulfilment, _shipping_address, target_branch
  ) RETURNING id INTO created_order_id;
  -- Stock leaves this order's godown.
  PERFORM set_config('app.branch_id', target_branch, true);

  FOR line IN SELECT value FROM jsonb_array_elements(items_json)
  LOOP
    INSERT INTO public.order_items (
      order_id, product_id, product_name, sku, vendor, vendor_id, qty,
      unit_price, gst_rate, line_total, capacity
    ) VALUES (
      created_order_id, line->>'product_id', line->>'product_name', line->>'sku',
      line->>'vendor', line->>'vendor_id', (line->>'qty')::integer,
      (line->>'unit_price')::numeric, (line->>'gst_rate')::numeric,
      (line->>'line_total')::numeric, COALESCE(line->>'capacity', '')
    ) RETURNING id INTO order_item_id;

    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) - (line->>'qty')::numeric), true),
        '{sold}', to_jsonb(COALESCE((payload->>'sold')::numeric, 0) + (line->>'qty')::numeric), true
      ), updated_at = now()
      WHERE id = line->>'product_id';

    -- Batches: the oldest purchase at this order's godown first (FIFO), split when needed; stock
    -- without a batch stays unbatched.
    PERFORM private.allocate_order_item_batches(order_item_id, line->>'product_id', target_branch, (line->>'qty')::numeric);
  END LOOP;

  RETURN jsonb_build_object(
    'order_no', final_order_no, 'subtotal', subtotal, 'discount', 0,
    'gst_amount', gst_amount, 'shipping', shipping_amount,
    'total', order_total, 'items', items_json
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_order_item(_order_no text, _order_item_id uuid, _qty integer, _capacity text, _unit_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_order public.orders%ROWTYPE;
  target_item public.order_items%ROWTYPE;
  product_row public.catalog_products%ROWTYPE;
  batch_row record;
  allocation_row record;
  delta integer;
  needed numeric(14,2);
  taken numeric(14,2);
  stock_now numeric(14,2);
  batch_available numeric(14,2);
  subtotal_now numeric(14,2);
  gst_now numeric(14,2);
  total_now numeric(14,2);
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may edit order lines';
  END IF;
  IF _qty IS NULL OR _qty < 1 OR _qty > 100000 THEN
    RAISE EXCEPTION 'Enter an order quantity between 1 and 100,000';
  END IF;
  IF _capacity IS NULL OR length(trim(_capacity)) = 0 OR length(trim(_capacity)) > 100 THEN
    RAISE EXCEPTION 'Enter a valid product capacity';
  END IF;
  IF _unit_price IS NULL OR _unit_price < 0 OR _unit_price > 100000000 THEN
    RAISE EXCEPTION 'Enter a valid unit price';
  END IF;

  SELECT * INTO target_order FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target_order.branch_id, ''), true);
  IF target_order.order_status <> 'Placed'
    OR target_order.payment_status <> 'Pending'
    OR target_order.paid_amount <> 0
    OR target_order.discount <> 0
    OR target_order.coupon IS NOT NULL THEN
    RAISE EXCEPTION 'Only unpaid, non-discounted orders in Placed status can be edited';
  END IF;

  SELECT * INTO target_item FROM public.order_items
    WHERE id = _order_item_id AND order_id = target_order.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  delta := _qty - target_item.qty;

  IF delta <> 0 THEN
    SELECT * INTO product_row FROM public.catalog_products WHERE id = target_item.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The product is no longer in the catalog; quantity cannot be changed'; END IF;
    stock_now := COALESCE((product_row.payload->>'stock')::numeric, 0);
    IF delta > 0 AND stock_now < delta THEN
      RAISE EXCEPTION 'There is not enough available stock for this quantity';
    END IF;
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(product_row.payload, '{stock}', to_jsonb(stock_now - delta), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((product_row.payload->>'sold')::numeric, 0) + delta)),
        true
      ), updated_at = now()
      WHERE id = target_item.product_id;

    IF delta > 0 THEN
      -- More of the item: the oldest batches at the order's godown first (FIFO).
      PERFORM private.allocate_order_item_batches(target_item.id, target_item.product_id, target_order.branch_id, delta);
    ELSE
      needed := abs(delta);
      FOR allocation_row IN
        SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
        FROM public.order_item_batch_allocations a
        WHERE a.order_item_id = target_item.id
          AND a.released_quantity < a.reserved_quantity
        ORDER BY a.created_at DESC, a.id DESC
        FOR UPDATE
      LOOP
        EXIT WHEN needed <= 0;
        taken := LEAST(needed, allocation_row.reserved_quantity - allocation_row.released_quantity);
        UPDATE public.batches
          SET remaining_quantity = remaining_quantity + taken,
              status = CASE WHEN remaining_quantity + taken > 0 THEN 'Active' ELSE 'Depleted' END
          WHERE id = allocation_row.batch_id;
        UPDATE public.order_item_batch_allocations
          SET released_quantity = released_quantity + taken
          WHERE id = allocation_row.id;
        needed := needed - taken;
      END LOOP;
    END IF;
  END IF;

  UPDATE public.order_items
    SET qty = _qty,
        capacity = trim(_capacity),
        unit_price = _unit_price,
        line_total = round(_qty * _unit_price, 2)
    WHERE id = target_item.id;

  SELECT COALESCE(SUM(line_total), 0),
         COALESCE(SUM(round(line_total * gst_rate / 100, 2)), 0)
    INTO subtotal_now, gst_now
    FROM public.order_items WHERE order_id = target_order.id;
  total_now := subtotal_now + gst_now + target_order.shipping - target_order.discount;
  UPDATE public.orders
    SET subtotal = subtotal_now,
        gst_amount = gst_now,
        total = total_now,
        balance_due = GREATEST(0, total_now - paid_amount)
    WHERE id = target_order.id;

  RETURN jsonb_build_object(
    'order_no', target_order.order_no,
    'order_item_id', target_item.id,
    'qty', _qty,
    'capacity', trim(_capacity),
    'unit_price', _unit_price,
    'line_total', round(_qty * _unit_price, 2),
    'subtotal', subtotal_now,
    'gst_amount', gst_now,
    'total', total_now,
    'balance_due', GREATEST(0, total_now - target_order.paid_amount)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
