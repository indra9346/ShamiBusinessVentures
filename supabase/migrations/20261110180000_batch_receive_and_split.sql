-- Receiving a purchase at the godown where it is unloaded, and sending part of a batch to other godowns
-- (client, 10 Nov 2026):
--   "When we receive batches, at that time we should enter to which warehouse it is unloaded & same should be
--    updated to Zoho inventory."
--   "need feature to make batches from super batch and those batches can be sent for multiple any intended godowns"
--
-- How it works:
--   * Receive purchase: the admin picks the godown where the bill's goods were unloaded. When the bill's location in
--     Zoho is another place (another godown, or Head Office), the website moves the units there in Zoho with a
--     transfer order and only then makes the batches, at the unloading godown. Same place: as before, no Zoho call.
--   * Send to other godowns: part of a batch (the "super batch") goes to one or more other godowns. Each godown gets
--     a Zoho transfer order and a new batch of its own, numbered after the super batch
--     (CLK-031126-08 -> CLK-031126-08-HBL1), with the same cost, bill, supplier and dates.
--   * Every transfer has a fixed number (GB-TR-000001), which is also its number in Zoho. The website writes the
--     transfer first and keeps the units aside; then the server asks Zoho; then the website finishes it. A transfer
--     whose Zoho answer was lost stays "pending", and a retry looks the number up in Zoho before creating anything, so
--     one transfer never becomes two. One Zoho refused (nothing there) is cancelled and its units go back.
--   * A batch sent to another godown travels: Zoho holds it "in transit" and it leaves the sending godown's stock at
--     once. The receiving godown (its staff, its channel partner, or an administrator) marks it received when it
--     arrives (owner, 10 Nov 2026); only then is the new batch made and the receiving godown's stock raised, in Zoho
--     and here. Both sides see where it came from and where it went, when and by whom.
--   * A bill received at the godown where it was unloaded is already there, so its transfer is received at once.
--   * The godowns' website stock moves with Zoho at each step, so the 15-minute stock sync finds nothing to change.
-- Only adds: tables, columns, functions; admin_delete_batch is the 6 Nov definition plus one rule (see there).

-- ---------------------------------------------------------------- transfers
CREATE TABLE IF NOT EXISTS public.batch_transfer_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_no bigint NOT NULL DEFAULT 0 CHECK (last_no >= 0)
);
INSERT INTO public.batch_transfer_counter (id, last_no) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;

-- Numbers are never reused: a retry looks a transfer up in Zoho by its number, so a reused number could find an old
-- transfer and finish the wrong one. The counter only goes up by one.
CREATE OR REPLACE FUNCTION private.batch_transfer_counter_only_up()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.last_no <> OLD.last_no + 1 THEN
    RAISE EXCEPTION 'Transfer numbers are never reset or reused';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_counter_only_up() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS batch_transfer_counter_guard ON public.batch_transfer_counter;
CREATE TRIGGER batch_transfer_counter_guard BEFORE UPDATE OR DELETE ON public.batch_transfer_counter
  FOR EACH ROW EXECUTE FUNCTION private.batch_transfer_counter_only_up();
DROP TRIGGER IF EXISTS batch_transfer_counter_guard_truncate ON public.batch_transfer_counter;
CREATE TRIGGER batch_transfer_counter_guard_truncate BEFORE TRUNCATE ON public.batch_transfer_counter
  FOR EACH STATEMENT EXECUTE FUNCTION private.batch_transfer_counter_only_up();

CREATE TABLE IF NOT EXISTS public.batch_transfers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Also the transfer order's number in Zoho: a retry finds it by this.
  transfer_no text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('receive', 'split')),
  -- pending: units kept aside, Zoho not confirmed yet. in_transit: Zoho has it on the way (a batch sent to another godown),
  -- waiting for that godown to mark it received. done: received there, in Zoho and here. cancelled: nothing in Zoho, units back.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'done', 'cancelled')),
  -- The godown the units leave; NULL when the bill's Zoho location is not a godown (Head Office).
  from_branch_id text REFERENCES public.branches(id),
  from_location_id text NOT NULL,
  from_location_name text NOT NULL DEFAULT '',
  to_branch_id text NOT NULL REFERENCES public.branches(id),
  to_location_id text NOT NULL,
  -- A split: the super batch and how many units leave it.
  parent_batch_id uuid REFERENCES public.batches(id),
  product_id text,
  quantity numeric(14,2),
  -- A receive: the bill, its lines (as create_batches_from_bill takes them, plus Zoho item and unit) and the cost basis.
  bill jsonb,
  cost_basis text CHECK (cost_basis IS NULL OR cost_basis IN ('ex_gst', 'inc_gst')),
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  zoho_transfer_order_id text NOT NULL DEFAULT '',
  zoho_status text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  -- What finishing made: the new batches.
  result jsonb,
  -- When it left (Zoho has it in transit, or received at once) and who at the receiving godown marked it received.
  sent_at timestamptz,
  received_at timestamptz,
  received_by uuid,
  received_by_name text NOT NULL DEFAULT '',
  received_by_role text CHECK (received_by_role IS NULL OR received_by_role IN ('admin', 'staff', 'partner', 'zoho')),
  created_by uuid,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (kind <> 'split' OR (parent_batch_id IS NOT NULL AND product_id IS NOT NULL AND quantity > 0)),
  CHECK (kind <> 'receive' OR (bill IS NOT NULL AND cost_basis IS NOT NULL)),
  CHECK (from_branch_id IS NULL OR from_branch_id <> to_branch_id)
);
CREATE INDEX IF NOT EXISTS batch_transfers_parent_idx ON public.batch_transfers (parent_batch_id) WHERE parent_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS batch_transfers_open_idx ON public.batch_transfers (created_at) WHERE status = 'pending';
-- One bill is moved once at a time: a second press finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS batch_transfers_open_bill ON public.batch_transfers ((bill->>'bill_id'))
  WHERE kind = 'receive' AND status = 'pending';

ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS parent_batch_id uuid REFERENCES public.batches(id),
  ADD COLUMN IF NOT EXISTS transfer_id bigint REFERENCES public.batch_transfers(id);
CREATE INDEX IF NOT EXISTS batches_parent_idx ON public.batches (parent_batch_id) WHERE parent_batch_id IS NOT NULL;

-- Supabase's default privileges hand new tables to anon, authenticated and service_role: take them back. Writes go only
-- through the functions below; admins read.
REVOKE ALL ON public.batch_transfer_counter, public.batch_transfers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.batch_transfers_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.batch_transfers TO authenticated, service_role;
ALTER TABLE public.batch_transfer_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS batch_transfers_admin_read ON public.batch_transfers;
CREATE POLICY batch_transfers_admin_read ON public.batch_transfers FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------- helpers
-- public.has_role is false for the service role (auth.uid() is NULL there): look the actor up directly.
CREATE OR REPLACE FUNCTION private.batch_transfer_admin(_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'admin'), false)
$function$;
REVOKE ALL ON FUNCTION private.batch_transfer_admin(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.next_batch_transfer_no()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE next_no bigint;
BEGIN
  UPDATE public.batch_transfer_counter SET last_no = last_no + 1 WHERE id RETURNING last_no INTO next_no;
  IF next_no IS NULL THEN RAISE EXCEPTION 'The transfer counter is missing'; END IF;
  RETURN 'GB-TR-' || lpad(next_no::text, GREATEST(6, length(next_no::text)), '0');
END $function$;
REVOKE ALL ON FUNCTION private.next_batch_transfer_no() FROM PUBLIC, anon, authenticated;

/*
 * Units that moved in Zoho move on the website too, at once: the source godown's stock goes down (never below 0) and
 * the destination's up. _from NULL: the units came from a Zoho location that is no godown (Head Office). _to NULL: the
 * units left and are on the way (in transit), so only the source changes. updated_at is now, so a stock sync that read
 * Zoho before the transfer doesn't put the old numbers back (apply_zoho_branch_stock skips rows changed after its read).
 */
CREATE OR REPLACE FUNCTION private.batch_transfer_stock(_from text, _to text, _product text, _qty numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE total numeric;
BEGIN
  IF COALESCE(_qty, 0) <= 0 THEN RETURN; END IF;
  PERFORM 1 FROM public.catalog_products WHERE id = _product FOR UPDATE;
  IF _from IS NOT NULL THEN
    UPDATE public.branch_stock SET stock = GREATEST(0, stock - _qty), updated_at = now()
      WHERE branch_id = _from AND product_id = _product;
  END IF;
  IF _to IS NOT NULL THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_to, _product, _qty, false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = public.branch_stock.stock + EXCLUDED.stock, updated_at = now();
  END IF;
  SELECT COALESCE(sum(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product;
  -- As apply_zoho_branch_stock does: the product's total follows its godowns, and this is Zoho's own change.
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  PERFORM set_config('app.zoho_inbound', 'off', true);
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_stock(text, text, text, numeric) FROM PUBLIC, anon, authenticated;

-- What the server needs to send a transfer to Zoho, and to show it.
CREATE OR REPLACE FUNCTION private.batch_transfer_json(_t public.batch_transfers)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT jsonb_build_object(
    'id', _t.id, 'transfer_no', _t.transfer_no, 'kind', _t.kind, 'status', _t.status,
    'from_branch_id', _t.from_branch_id, 'from_location_id', _t.from_location_id, 'from_location_name', _t.from_location_name,
    'from_name', COALESCE((SELECT name FROM public.branches WHERE id = _t.from_branch_id), _t.from_location_name),
    'to_branch_id', _t.to_branch_id, 'to_location_id', _t.to_location_id,
    'to_name', (SELECT name FROM public.branches WHERE id = _t.to_branch_id),
    'parent_batch_id', _t.parent_batch_id, 'parent_batch_code', (SELECT batch_code FROM public.batches WHERE id = _t.parent_batch_id),
    'quantity', _t.quantity, 'bill_number', _t.bill->>'bill_number', 'lines', _t.lines,
    'zoho_transfer_order_id', _t.zoho_transfer_order_id, 'zoho_status', _t.zoho_status, 'attempts', _t.attempts,
    'last_error', _t.last_error, 'result', _t.result, 'created_at', _t.created_at, 'created_by_name', _t.created_by_name,
    'sent_at', _t.sent_at, 'received_at', _t.received_at, 'received_by_name', _t.received_by_name, 'received_by_role', _t.received_by_role)
$function$;
REVOKE ALL ON FUNCTION private.batch_transfer_json(public.batch_transfers) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- send part of a batch to other godowns (server only)
/*
 * Starts one transfer per destination godown: _targets = [{branch_id, qty}]. The units leave the super batch now
 * (kept aside, so no order can take them meanwhile); finish_batch_transfer makes the new batches once Zoho has moved
 * them, cancel_batch_transfer gives them back if Zoho has nothing.
 */
CREATE OR REPLACE FUNCTION public.begin_batch_split(_batch_id uuid, _targets jsonb, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  b public.batches%ROWTYPE;
  src public.branches%ROWTYPE;
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  target jsonb;
  qty numeric;
  total numeric(14,2) := 0;
  item text;
  seen text[] := '{}';
  made jsonb := '[]'::jsonb;
  who text := left(btrim(COALESCE(_by_name, '')), 120);
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can send stock to another godown'; END IF;
  IF jsonb_typeof(_targets) <> 'array' OR jsonb_array_length(_targets) = 0 THEN RAISE EXCEPTION 'Choose a godown and how many to send'; END IF;
  -- Orders take from the batch FOR UPDATE too, so nothing slips in between the check and the move.
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  SELECT * INTO src FROM public.branches WHERE id = b.branch_id;
  IF src.id IS NULL OR COALESCE(src.zoho_location_id, '') = '' THEN
    RAISE EXCEPTION 'Batch % is not at a godown linked to a Zoho location', b.batch_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = b.product_id AND track_batches) THEN
    RAISE EXCEPTION '% has batch tracking in Zoho: move it in Zoho, where its batches are', b.product_name;
  END IF;
  SELECT zoho_item_id INTO item FROM public.zoho_item_links WHERE product_id = b.product_id;
  IF COALESCE(item, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho item', b.product_name; END IF;

  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    qty := CASE WHEN jsonb_typeof(target->'qty') = 'number' THEN (target->>'qty')::numeric END;
    IF qty IS NULL OR qty <= 0 OR qty <> round(qty, 2) THEN RAISE EXCEPTION 'Enter how many to send to each godown'; END IF;
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
    IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
    IF dst.id = src.id THEN RAISE EXCEPTION 'Batch % is already at %', b.batch_code, dst.name; END IF;
    IF dst.id = ANY (seen) THEN RAISE EXCEPTION '% is chosen twice', dst.name; END IF;
    seen := seen || dst.id;
    total := total + qty;
  END LOOP;
  IF total > b.remaining_quantity THEN
    RAISE EXCEPTION 'Batch % has % left; % were chosen', b.batch_code, b.remaining_quantity, total;
  END IF;

  UPDATE public.batches SET remaining_quantity = remaining_quantity - total WHERE id = b.id;
  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    qty := (target->>'qty')::numeric;
    INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
        parent_batch_id, product_id, quantity, lines, created_by, created_by_name)
      VALUES (private.next_batch_transfer_no(), 'split', src.id, src.zoho_location_id, src.name, dst.id, dst.zoho_location_id,
        b.id, b.product_id, qty, jsonb_build_array(jsonb_build_object('product_id', b.product_id, 'zoho_item_id', item, 'name', b.product_name, 'qty', qty, 'unit', b.unit)),
        _by, who)
      RETURNING * INTO t;
    made := made || private.batch_transfer_json(t);
  END LOOP;
  RETURN made;
END $function$;
REVOKE ALL ON FUNCTION public.begin_batch_split(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_batch_split(uuid, jsonb, uuid, text) TO service_role;

-- ---------------------------------------------------------------- receive a bill at another place (server only)
/*
 * A bill whose Zoho location is not the godown where its goods were unloaded. The server read the bill from Zoho:
 * _bill and _lines as create_batches_from_bill takes them, each line with zoho_item_id, name and unit too. Nothing is
 * made yet: finish_batch_transfer makes the batches once Zoho has moved the units. A second press while one is
 * pending gets the pending one back (to the same godown), never a second transfer.
 */
CREATE OR REPLACE FUNCTION public.begin_bill_receive(_branch_id text, _from_location_id text, _from_location_name text,
  _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  dst public.branches%ROWTYPE;
  t public.batch_transfers%ROWTYPE;
  line jsonb;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
  bill_no text := btrim(COALESCE(_bill->>'bill_number', ''));
  done text;
  from_branch text;
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF _cost_basis IS NULL OR _cost_basis NOT IN ('ex_gst', 'inc_gst') THEN RAISE EXCEPTION 'Choose cost without GST or cost with GST'; END IF;
  IF bill_id = '' OR bill_no = '' THEN RAISE EXCEPTION 'The bill has no number'; END IF;
  IF btrim(COALESCE(_from_location_id, '')) = '' THEN RAISE EXCEPTION 'Zoho did not say where bill % is', bill_no; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = _branch_id;
  IF NOT FOUND OR NOT dst.active OR dst.vendor_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an active godown'; END IF;
  IF COALESCE(dst.zoho_location_id, '') = '' THEN RAISE EXCEPTION '% is not linked to a Zoho location', dst.name; END IF;
  IF dst.zoho_location_id = _from_location_id THEN RAISE EXCEPTION 'Bill % is already at %: nothing to move', bill_no, dst.name; END IF;
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN RAISE EXCEPTION 'No bill lines to receive'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));

  SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id;
  IF FOUND THEN
    IF t.to_branch_id <> dst.id THEN
      RAISE EXCEPTION 'Bill % is already being moved to another godown (%). Finish or cancel that transfer first.', bill_no, t.transfer_no;
    END IF;
    RETURN private.batch_transfer_json(t) || jsonb_build_object('resumed', true);
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line->>'line_id';
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    IF COALESCE((line->>'qty')::numeric, 0) <= 0 OR btrim(COALESCE(line->>'zoho_item_id', '')) = '' THEN
      RAISE EXCEPTION 'Bill % has a line without a Zoho item or quantity', bill_no;
    END IF;
    IF EXISTS (SELECT 1 FROM public.zoho_item_links WHERE product_id = line->>'product_id' AND track_batches) THEN
      RAISE EXCEPTION '% has batch tracking in Zoho: its batch comes in from Zoho.', line->>'name';
    END IF;
  END LOOP;
  SELECT id INTO from_branch FROM public.branches WHERE zoho_location_id = _from_location_id AND vendor_id IS NULL ORDER BY active DESC, id LIMIT 1;

  INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
      bill, cost_basis, lines, created_by, created_by_name)
    VALUES (private.next_batch_transfer_no(), 'receive', from_branch, _from_location_id,
      left(btrim(COALESCE(_from_location_name, '')), 120), dst.id, dst.zoho_location_id, _bill, _cost_basis, _lines,
      _by, left(btrim(COALESCE(_by_name, '')), 120))
    RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.begin_bill_receive(text, text, text, jsonb, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_bill_receive(text, text, text, jsonb, jsonb, text, uuid, text) TO service_role;

-- ---------------------------------------------------------------- finish, note an attempt, cancel (server only)
/*
 * Who may mark a transfer received at a godown: an administrator, or that godown's active staff or channel partner.
 * Returns {role, name}, or NULL for anyone else. public.has_role is false for the service role, so all are looked up.
 */
CREATE OR REPLACE FUNCTION private.batch_transfer_receiver(_actor uuid, _branch_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE who text;
BEGIN
  IF _actor IS NULL THEN RETURN NULL; END IF;
  IF private.batch_transfer_admin(_actor) THEN
    SELECT COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), '')) INTO who FROM public.profiles p WHERE p.id = _actor;
    RETURN jsonb_build_object('role', 'admin', 'name', COALESCE(who, 'Admin ' || left(_actor::text, 8)));
  END IF;
  SELECT name INTO who FROM public.staff_employees WHERE user_id = _actor AND status = 'active' AND branch_id = _branch_id;
  IF FOUND THEN RETURN jsonb_build_object('role', 'staff', 'name', who); END IF;
  SELECT name INTO who FROM public.channel_partners WHERE user_id = _actor AND status = 'active' AND branch_id = _branch_id;
  IF FOUND THEN RETURN jsonb_build_object('role', 'partner', 'name', who); END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_receiver(uuid, text) FROM PUBLIC, anon, authenticated;

/*
 * Takes a transfer forward on what Zoho says now (the server read it a moment ago).
 *   A bill received elsewhere: Zoho 'transferred' makes its batches at the unloading godown at once.
 *   A batch sent to another godown:
 *     Zoho 'in_transit': it left. The sending godown's stock goes down; the transfer waits for the receiving godown.
 *     Zoho 'transferred': it arrived. _actor (who pressed Mark received) must be an administrator or that godown's
 *     staff or channel partner; NULL means Zoho shows it received already (marked in Zoho itself). The new batch is
 *     made and the receiving godown's stock goes up.
 * Finishing twice returns the first result. Any other Zoho status leaves it as it is, with Zoho's word noted.
 */
CREATE OR REPLACE FUNCTION public.finish_batch_transfer(_transfer_id bigint, _zoho_transfer_order_id text, _zoho_status text, _actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  b public.batches%ROWTYPE;
  dst public.branches%ROWTYPE;
  made jsonb;
  child_code text;
  child_id uuid;
  n integer;
  line jsonb;
  receiver jsonb;
  status_now text := lower(btrim(COALESCE(_zoho_status, '')));
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'done' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer % was cancelled', t.transfer_no; END IF;
  IF btrim(COALESCE(_zoho_transfer_order_id, '')) = '' THEN RAISE EXCEPTION 'Zoho''s transfer order is missing'; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = t.to_branch_id;

  IF t.kind = 'split' AND status_now IN ('in_transit', 'transferred') AND t.status = 'pending' THEN
    -- It left the sending godown.
    PERFORM private.batch_transfer_stock(t.from_branch_id, NULL, t.product_id, t.quantity);
    UPDATE public.batch_transfers SET status = 'in_transit', sent_at = now(), zoho_transfer_order_id = _zoho_transfer_order_id,
        zoho_status = status_now, last_error = ''
      WHERE id = t.id RETURNING * INTO t;
  END IF;
  IF status_now <> 'transferred' THEN
    IF t.status = 'pending' THEN
      UPDATE public.batch_transfers SET zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
          attempts = attempts + 1, last_error = format('Zoho shows transfer %s as "%s", not received yet', t.transfer_no, status_now)
        WHERE id = t.id RETURNING * INTO t;
    END IF;
    RETURN private.batch_transfer_json(t);
  END IF;

  IF t.kind = 'split' THEN
    receiver := CASE WHEN _actor IS NULL THEN jsonb_build_object('role', 'zoho', 'name', 'Marked received in Zoho')
      ELSE private.batch_transfer_receiver(_actor, t.to_branch_id) END;
    IF receiver IS NULL THEN
      RAISE EXCEPTION 'Only % staff, its channel partner or an administrator can mark transfer % received', dst.name, t.transfer_no;
    END IF;
    SELECT * INTO b FROM public.batches WHERE id = t.parent_batch_id FOR UPDATE;
    SELECT count(*) + 1 INTO n FROM public.batches WHERE parent_batch_id = b.id AND branch_id = dst.id;
    child_code := b.batch_code || '-' || upper(COALESCE(NULLIF(btrim(dst.code), ''), regexp_replace(dst.id, '^BR-', ''))) || n;
    INSERT INTO public.batches (batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit,
      unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis, purchase_date, mfg_date, expiry_date, warehouse, branch_id,
      source, supplier, purchase_ref, notes, received_by, received_by_name, zoho_item_id,
      zoho_bill_id, zoho_bill_number, zoho_bill_modified, zoho_bill_total, status, parent_batch_id, transfer_id)
    VALUES (child_code, b.product_id, b.product_name, b.vendor, b.vendor_id, t.quantity, t.quantity, b.unit,
      b.unit_cost, b.unit_cost_ex_gst, b.unit_cost_inc_gst, b.cost_basis, b.purchase_date, b.mfg_date, b.expiry_date, dst.name, dst.id,
      'website', b.supplier, b.purchase_ref, left(format('From %s (%s)', b.batch_code, t.transfer_no), 300), _actor, left(receiver->>'name', 120),
      b.zoho_item_id, b.zoho_bill_id, b.zoho_bill_number, b.zoho_bill_modified, b.zoho_bill_total, 'Active', b.id, t.id)
    RETURNING id INTO child_id;
    made := jsonb_build_array(jsonb_build_object('batch_id', child_id, 'batch_code', child_code, 'qty', t.quantity));
    -- It arrived: only the receiving godown changes now (the sender's stock went down when it left).
    PERFORM private.batch_transfer_stock(NULL, t.to_branch_id, t.product_id, t.quantity);
  ELSE
    receiver := jsonb_build_object('role', 'admin', 'name', t.created_by_name);
    made := public.create_batches_from_bill(t.to_branch_id, t.bill, t.lines, t.cost_basis, t.created_by, t.created_by_name);
    UPDATE public.batches SET transfer_id = t.id WHERE id IN (SELECT (m->>'batch_id')::uuid FROM jsonb_array_elements(made) m);
    FOR line IN SELECT value FROM jsonb_array_elements(t.lines) LOOP
      PERFORM private.batch_transfer_stock(t.from_branch_id, t.to_branch_id, line->>'product_id', (line->>'qty')::numeric);
    END LOOP;
  END IF;

  UPDATE public.batch_transfers SET status = 'done', zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
      last_error = '', result = made, finished_at = now(), sent_at = COALESCE(sent_at, now()), received_at = now(),
      received_by = CASE WHEN t.kind = 'split' THEN _actor ELSE t.created_by END,
      received_by_name = left(COALESCE(receiver->>'name', ''), 120), received_by_role = receiver->>'role'
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.finish_batch_transfer(bigint, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_batch_transfer(bigint, text, text, uuid) TO service_role;

-- A try that didn't finish (Zoho gave no answer, or not received yet): noted, and the transfer stays pending.
CREATE OR REPLACE FUNCTION public.note_batch_transfer_attempt(_transfer_id bigint, _error text, _zoho_transfer_order_id text, _zoho_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  UPDATE public.batch_transfers
    SET attempts = attempts + 1, last_error = left(COALESCE(_error, ''), 500),
        zoho_transfer_order_id = COALESCE(NULLIF(btrim(COALESCE(_zoho_transfer_order_id, '')), ''), zoho_transfer_order_id),
        zoho_status = COALESCE(NULLIF(lower(btrim(COALESCE(_zoho_status, ''))), ''), zoho_status)
    WHERE id = _transfer_id AND status = 'pending' RETURNING * INTO t;
  IF NOT FOUND THEN RAISE EXCEPTION 'No pending transfer %', _transfer_id; END IF;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.note_batch_transfer_attempt(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_batch_transfer_attempt(bigint, text, text, text) TO service_role;

/*
 * A pending transfer that Zoho does not have (the server checked: Zoho refused it, or has no transfer with its number,
 * or Zoho's is void). The units go back to the super batch; a bill can be received again.
 */
CREATE OR REPLACE FUNCTION public.cancel_batch_transfer(_transfer_id bigint, _reason text, _by uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  IF _by IS NOT NULL AND NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can cancel a transfer'; END IF;
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'cancelled' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'done' THEN RAISE EXCEPTION 'Transfer % is done: its units are at the other godown', t.transfer_no; END IF;
  IF t.status = 'in_transit' THEN RAISE EXCEPTION 'Transfer % is on its way in Zoho: mark it received at the godown, or void it in Zoho first', t.transfer_no; END IF;
  IF t.kind = 'split' THEN
    UPDATE public.batches SET remaining_quantity = remaining_quantity + t.quantity WHERE id = t.parent_batch_id;
  END IF;
  UPDATE public.batch_transfers SET status = 'cancelled', last_error = left(COALESCE(_reason, ''), 500), finished_at = now()
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.cancel_batch_transfer(bigint, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_batch_transfer(bigint, text, uuid) TO service_role;

-- ---------------------------------------------------------------- delete: a batch in a transfer stays
/**
 * As 20261106140000 (owner, 6 Nov 2026), plus: a batch that came from a transfer, or has sent units in one (pending or
 * done), is kept. Its units are at a godown in Zoho because of that transfer, so deleting it would lose them here.
 */
CREATE OR REPLACE FUNCTION public.admin_delete_batch(_batch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  batch_row public.batches%ROWTYPE;
  held numeric;
  used integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may delete batches'; END IF;
  SELECT * INTO batch_row FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF batch_row.transfer_id IS NOT NULL OR batch_row.parent_batch_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.batch_transfers WHERE parent_batch_id = batch_row.id AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'Batch % is part of a transfer between godowns, so it is kept for the record.', batch_row.batch_code;
  END IF;
  -- An order placed now waits for this lock (its FIFO takes the batch FOR UPDATE), so nothing slips in between.
  SELECT COALESCE(sum(reserved_quantity - released_quantity), 0), count(*) INTO held, used
    FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  IF held > 0 THEN RAISE EXCEPTION 'Orders have taken stock from batch %, so it can''t be deleted.', batch_row.batch_code; END IF;
  -- A batch whose every order was cancelled or expired, unpaid, with all units back, may go (owner, 6 Nov 2026).
  IF used > 0 AND EXISTS (
    SELECT 1 FROM public.order_item_batch_allocations a
      JOIN public.order_items i ON i.id = a.order_item_id
      JOIN public.orders o ON o.id = i.order_id
     WHERE a.batch_id = batch_row.id
       AND NOT (o.order_status IN ('Cancelled', 'Payment Expired') AND COALESCE(o.paid_amount, 0) = 0
                AND COALESCE(o.payment_status, '') NOT IN ('Paid', 'Partially Paid', 'Refunded'))
  ) THEN RAISE EXCEPTION 'Orders have used batch % before, so it is kept for their records.', batch_row.batch_code; END IF;
  IF EXISTS (SELECT 1 FROM public.batch_adjustments WHERE batch_id = batch_row.id) THEN
    RAISE EXCEPTION 'Stock counts have changed batch %, so it is kept for their records.', batch_row.batch_code;
  END IF;
  IF batch_row.remaining_quantity <> batch_row.quantity THEN
    RAISE EXCEPTION 'Batch %''s units have moved, so it can''t be deleted.', batch_row.batch_code;
  END IF;
  INSERT INTO public.deleted_batches_log (batch_code, product_id, product_name, quantity, released_orders, zoho_adjustment_id, deleted_by, deleted_by_name)
  VALUES (batch_row.batch_code, batch_row.product_id, batch_row.product_name, batch_row.quantity, used, COALESCE(batch_row.zoho_adjustment_id, ''),
    auth.uid(), COALESCE((SELECT left(COALESCE(p.full_name, ''), 120) FROM public.profiles p WHERE p.id = auth.uid()), ''));
  -- Only released rows of cancelled or expired orders are left here; their units are already back in stock.
  DELETE FROM public.order_item_batch_allocations WHERE batch_id = batch_row.id;
  DELETE FROM public.batches WHERE id = batch_row.id;
  RETURN jsonb_build_object('batch_code', batch_row.batch_code, 'zoho_adjustment_id', batch_row.zoho_adjustment_id);
END $function$;
REVOKE ALL ON FUNCTION public.admin_delete_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_batch(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
