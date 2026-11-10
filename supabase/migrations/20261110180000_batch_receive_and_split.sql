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
--   * The godowns' website stock takes Zoho's own numbers, read by the server right after Zoho moved the units, so a
--     stock sync that already pulled the move can't count it twice (private.batch_transfer_godown). A send waiting for
--     Zoho changes no stock: Zoho still has those units at the sender until it has moved them.
--   * One server call at a time works on a transfer (a claim that runs out after a few minutes), and a create whose
--     answer was lost is looked up, never sent again, until Zoho has had 10 minutes to finish it (the server's rule).
--   * A transfer on its way that is voided or deleted in Zoho is cancelled: its units go back to the super batch.
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
  -- The server call working on it now (claim_batch_transfer), and until when; another call waits for it or for the time.
  claim_id uuid,
  claimed_until timestamptz,
  -- When a create was last sent to Zoho. Its answer may have been lost, so the next try looks the number up first.
  create_sent_at timestamptz,
  -- Zoho answered the last create with "number already exists" but a look-up could not find it: not cancelled on a guess.
  zoho_number_taken boolean NOT NULL DEFAULT false,
  -- The send request that made it (the Send dialog's key): pressing Send again after a lost answer repeats nothing.
  request_id uuid,
  -- A batch sent on: how much its sending godown's website stock went down when Zoho had it on the way, moved by the
  -- quantity (no Zoho number: Zoho not the stock master, or a waiting website edit). Never below 0, so it can be less
  -- than quantity. Without Zoho's numbers, a cancel gives back exactly this and the receiving godown gains exactly this.
  reserved numeric(14,2) NOT NULL DEFAULT 0,
  CHECK (kind <> 'split' OR (parent_batch_id IS NOT NULL AND product_id IS NOT NULL AND quantity > 0)),
  CHECK (kind <> 'receive' OR (bill IS NOT NULL AND cost_basis IS NOT NULL)),
  CHECK (from_branch_id IS NULL OR from_branch_id <> to_branch_id)
);
CREATE INDEX IF NOT EXISTS batch_transfers_parent_idx ON public.batch_transfers (parent_batch_id) WHERE parent_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS batch_transfers_open_idx ON public.batch_transfers (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS batch_transfers_request_idx ON public.batch_transfers (request_id) WHERE request_id IS NOT NULL;
-- One bill is moved once at a time: a second press finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS batch_transfers_open_bill ON public.batch_transfers ((bill->>'bill_id'))
  WHERE kind = 'receive' AND status = 'pending';

-- sent_quantity: units this batch sent to other godowns (on the way, or arrived), kept with the batch so the report reads
-- one row, not two tables at two moments.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS parent_batch_id uuid REFERENCES public.batches(id),
  ADD COLUMN IF NOT EXISTS transfer_id bigint REFERENCES public.batch_transfers(id),
  ADD COLUMN IF NOT EXISTS sent_quantity numeric(14,2) NOT NULL DEFAULT 0 CHECK (sent_quantity >= 0);
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
 * Website orders at a godown that Zoho does not hold yet: the stock sync's rule (pendingOrderQty in zoho-sync-core.ts).
 * Placed since Zoho became the stock master, not cancelled or expired, and with no Zoho sales order beyond a draft.
 */
CREATE OR REPLACE FUNCTION private.batch_transfer_orders_waiting(_branch_id text, _product_id text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(sum(oi.qty), 0)::numeric
    FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
   WHERE oi.product_id = _product_id
     AND COALESCE(NULLIF(o.branch_id, ''), (SELECT b.id FROM public.branches b WHERE b.is_default LIMIT 1)) = _branch_id
     AND o.order_status NOT IN ('Cancelled', 'Payment Expired')
     AND (COALESCE(o.zoho_salesorder_id, '') = '' OR lower(COALESCE(o.zoho_order_status, '')) IN ('', 'draft'))
     AND o.created_at >= COALESCE(
       (SELECT NULLIF(st.value->>'since', '')::timestamptz FROM public.settings st WHERE st.key = 'zoho_stock_master'),
       (SELECT st.updated_at FROM public.settings st WHERE st.key = 'zoho_stock_master'),
       now())
$function$;
REVOKE ALL ON FUNCTION private.batch_transfer_orders_waiting(text, text) FROM PUBLIC, anon, authenticated;

/*
 * One godown's stock for one product as a transfer moves it (the caller holds the product's lock).
 * _readings: Zoho's stock at the godowns, read by the server after Zoho moved the units ([{branch_id, product_id, stock}],
 * Zoho's own number). The godown takes it, less website orders Zoho doesn't hold yet, worked out here under the lock so
 * an order placed meanwhile still counts; a stock sync that already pulled the move can't count it twice.
 * Moved by _delta instead (never below 0) when there is no reading (Zoho is not the stock master, or gave no number for
 * the godown), or when the godown has a website stock edit still waiting for Zoho (zoho_pending): the next sync sends
 * that count to Zoho, so it has to move with the transfer. _reading_only: never move by _delta (only take a reading).
 * updated_at is now, so a sync that read Zoho before the move doesn't put the old number back. Returns how much the
 * godown's stock changed.
 */
CREATE OR REPLACE FUNCTION private.batch_transfer_godown(_branch text, _product text, _delta numeric, _readings jsonb, _reading_only boolean)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  reading numeric;
  waiting boolean;
  before numeric;
  after numeric;
BEGIN
  IF _branch IS NULL OR _product IS NULL THEN RETURN 0; END IF;
  IF jsonb_typeof(_readings) = 'array' THEN
    SELECT (r->>'stock')::numeric INTO reading FROM jsonb_array_elements(_readings) AS r
      WHERE r->>'branch_id' = _branch AND r->>'product_id' = _product AND jsonb_typeof(r->'stock') = 'number' LIMIT 1;
  END IF;
  waiting := false;
  SELECT zoho_pending, stock INTO waiting, before FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product FOR UPDATE;
  before := COALESCE(before, 0);
  IF reading IS NOT NULL AND NOT COALESCE(waiting, false) THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending)
      VALUES (_branch, _product, GREATEST(0, round(reading - private.batch_transfer_orders_waiting(_branch, _product), 2)), false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = EXCLUDED.stock, updated_at = now();
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) < 0 THEN
    UPDATE public.branch_stock SET stock = GREATEST(0, stock + _delta), updated_at = now()
      WHERE branch_id = _branch AND product_id = _product;
  ELSIF NOT _reading_only AND COALESCE(_delta, 0) > 0 THEN
    INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES (_branch, _product, _delta, false)
    ON CONFLICT (branch_id, product_id) DO UPDATE SET stock = public.branch_stock.stock + EXCLUDED.stock, updated_at = now();
  END IF;
  SELECT stock INTO after FROM public.branch_stock WHERE branch_id = _branch AND product_id = _product;
  RETURN COALESCE(after, 0) - before;
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_godown(text, text, numeric, jsonb, boolean) FROM PUBLIC, anon, authenticated;

-- As apply_zoho_branch_stock does: the product's total follows its godowns, and this is Zoho's own change.
CREATE OR REPLACE FUNCTION private.batch_transfer_total(_product text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(sum(stock), 0) INTO total FROM public.branch_stock WHERE product_id = _product;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  PERFORM set_config('app.branch_stock_sync', 'on', true);
  UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb(total), true), updated_at = now()
    WHERE id = _product;
  PERFORM set_config('app.branch_stock_sync', 'off', true);
  PERFORM set_config('app.zoho_inbound', 'off', true);
END $function$;
REVOKE ALL ON FUNCTION private.batch_transfer_total(text) FROM PUBLIC, anon, authenticated;

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
    'sent_at', _t.sent_at, 'received_at', _t.received_at, 'received_by_name', _t.received_by_name, 'received_by_role', _t.received_by_role,
    'create_sent_at', _t.create_sent_at, 'zoho_number_taken', _t.zoho_number_taken, 'reserved', _t.reserved)
$function$;
REVOKE ALL ON FUNCTION private.batch_transfer_json(public.batch_transfers) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- one server call at a time (server only)
/*
 * A server call claims a transfer before it asks Zoho anything and lets it go when done, so two presses, two admins or
 * a press during the stock sync never create, cancel or finish one transfer at the same time. A claim runs out by
 * itself (_seconds, 30 to 900) if the server stops midway. Returns the transfer as it is now, with claimed true, or
 * claimed false while another call holds it.
 */
CREATE OR REPLACE FUNCTION public.claim_batch_transfer(_transfer_id bigint, _claim uuid, _seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  IF _claim IS NULL THEN RAISE EXCEPTION 'No claim given'; END IF;
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.claim_id IS NOT NULL AND t.claim_id <> _claim AND t.claimed_until > now() THEN
    RETURN private.batch_transfer_json(t) || jsonb_build_object('claimed', false, 'busy_until', t.claimed_until);
  END IF;
  UPDATE public.batch_transfers SET claim_id = _claim,
      claimed_until = now() + make_interval(secs => LEAST(GREATEST(COALESCE(_seconds, 300), 30), 900))
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t) || jsonb_build_object('claimed', true);
END $function$;
REVOKE ALL ON FUNCTION public.claim_batch_transfer(bigint, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_batch_transfer(bigint, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.release_batch_transfer(_transfer_id bigint, _claim uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  UPDATE public.batch_transfers SET claim_id = NULL, claimed_until = NULL WHERE id = _transfer_id AND claim_id = _claim
$function$;
REVOKE ALL ON FUNCTION public.release_batch_transfer(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_batch_transfer(bigint, uuid) TO service_role;

-- Free for this call: nobody holds it, the claim ran out, or the claim is this call's.
CREATE OR REPLACE FUNCTION private.batch_transfer_claim_ok(_t public.batch_transfers, _claim uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT _t.claim_id IS NULL OR _t.claimed_until IS NULL OR _t.claimed_until <= now() OR _t.claim_id = _claim
$function$;
REVOKE ALL ON FUNCTION private.batch_transfer_claim_ok(public.batch_transfers, uuid) FROM PUBLIC, anon, authenticated;

/*
 * Written, and committed, just before a create goes to Zoho: if its answer is lost, every later try knows a create may
 * be in Zoho and looks the number up first.
 */
CREATE OR REPLACE FUNCTION public.note_batch_transfer_create(_transfer_id bigint, _claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'pending' THEN RAISE EXCEPTION 'No pending transfer %', _transfer_id; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN RAISE EXCEPTION 'Transfer % is being worked on right now', t.transfer_no; END IF;
  UPDATE public.batch_transfers SET create_sent_at = now(), zoho_number_taken = false WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.note_batch_transfer_create(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_batch_transfer_create(bigint, uuid) TO service_role;

-- ---------------------------------------------------------------- send part of a batch to other godowns (server only)
/*
 * Starts one transfer per destination godown: _targets = [{branch_id, qty}]. The units leave the super batch now
 * (kept aside, so no order can take them meanwhile); finish_batch_transfer makes the new batches once Zoho has moved
 * them, cancel_batch_transfer gives them back if Zoho has nothing.
 */
CREATE OR REPLACE FUNCTION public.begin_batch_split(_batch_id uuid, _targets jsonb, _by uuid, _by_name text, _request uuid)
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
  -- Orders take from the batch FOR UPDATE too, so nothing slips in between the check and the move. The product is
  -- locked first, as orders lock it (place_marketplace_order), so the two never wait on each other.
  PERFORM 1 FROM public.catalog_products WHERE id = (SELECT product_id FROM public.batches WHERE id = _batch_id) FOR UPDATE;
  SELECT * INTO b FROM public.batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  -- The same request again (its answer was lost and Send was pressed again): the transfers it began, nothing new.
  IF _request IS NOT NULL AND EXISTS (SELECT 1 FROM public.batch_transfers WHERE request_id = _request) THEN
    RETURN (SELECT jsonb_agg(private.batch_transfer_json(x) ORDER BY x.id) FROM public.batch_transfers x WHERE x.request_id = _request);
  END IF;
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

  UPDATE public.batches SET remaining_quantity = remaining_quantity - total, sent_quantity = sent_quantity + total WHERE id = b.id;
  FOR target IN SELECT value FROM jsonb_array_elements(_targets) LOOP
    SELECT * INTO dst FROM public.branches WHERE id = target->>'branch_id';
    qty := (target->>'qty')::numeric;
    -- The godown's stock is not touched yet: Zoho still has the units there until it has them on the way (finish).
    INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, from_location_name, to_branch_id, to_location_id,
        parent_batch_id, product_id, quantity, lines, created_by, created_by_name, request_id)
      VALUES (private.next_batch_transfer_no(), 'split', src.id, src.zoho_location_id, src.name, dst.id, dst.zoho_location_id,
        b.id, b.product_id, qty, jsonb_build_array(jsonb_build_object('product_id', b.product_id, 'zoho_item_id', item, 'name', b.product_name, 'qty', qty, 'unit', b.unit)),
        _by, who, _request)
      RETURNING * INTO t;
    made := made || private.batch_transfer_json(t);
  END LOOP;
  RETURN made;
END $function$;
REVOKE ALL ON FUNCTION public.begin_batch_split(uuid, jsonb, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_batch_split(uuid, jsonb, uuid, text, uuid) TO service_role;

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
  IF NULLIF(_bill->>'date', '') IS NULL THEN RAISE EXCEPTION 'The bill has no date'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    -- What create_batches_from_bill checks when the move is finished, checked now, before Zoho moves anything: a line it
    -- would refuse then would leave a transfer that Zoho made and the website can never finish.
    IF btrim(COALESCE(line->>'line_id', '')) = '' THEN RAISE EXCEPTION 'A bill line has no id'; END IF;
    SELECT batch_code INTO done FROM public.batches WHERE zoho_bill_id = bill_id AND zoho_bill_line_id = line->>'line_id';
    IF FOUND THEN RAISE EXCEPTION 'Bill % line is already batch %. Each bill line makes one batch.', bill_no, done; END IF;
    IF round(COALESCE((line->>'qty')::numeric, 0), 2) <= 0 OR round(COALESCE((line->>'qty')::numeric, 0), 2) > 1000000
       OR btrim(COALESCE(line->>'zoho_item_id', '')) = '' THEN
      RAISE EXCEPTION 'Bill % has a line without a Zoho item or quantity', bill_no;
    END IF;
    IF round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2) < 0
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) < round(COALESCE((line->>'unit_ex_gst')::numeric, -1), 2)
       OR round(COALESCE((line->>'unit_inc_gst')::numeric, -1), 2) > 100000000 THEN
      RAISE EXCEPTION 'Bill % has a line with a wrong cost', bill_no;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.catalog_products p WHERE p.id = line->>'product_id' AND COALESCE(p.vendor_id, '') NOT LIKE 'zoho:%') THEN
      RAISE EXCEPTION 'A bill line is not a website product';
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

/*
 * A bill received at the godown where Zoho already has it: its batches at once (create_batches_from_bill), unless the
 * same bill is being moved to another godown right now. Zoho may have moved its units there already, so batches here
 * would sit where the units are not, and that transfer could never finish. Same lock as begin_bill_receive.
 */
CREATE OR REPLACE FUNCTION public.receive_bill_here(_branch_id text, _bill jsonb, _lines jsonb, _cost_basis text, _by uuid, _by_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  t public.batch_transfers%ROWTYPE;
  bill_id text := btrim(COALESCE(_bill->>'bill_id', ''));
BEGIN
  IF NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can receive purchases'; END IF;
  IF bill_id <> '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('bill_batches:' || bill_id));
    SELECT * INTO t FROM public.batch_transfers WHERE kind = 'receive' AND status = 'pending' AND bill->>'bill_id' = bill_id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Bill % is being moved to % in Zoho (transfer %). Press Retry or Cancel on it under Transfers waiting for Zoho first.',
        COALESCE(_bill->>'bill_number', ''), COALESCE((SELECT name FROM public.branches WHERE id = t.to_branch_id), 'another godown'), t.transfer_no;
    END IF;
  END IF;
  RETURN public.create_batches_from_bill(_branch_id, _bill, _lines, _cost_basis, _by, _by_name);
END $function$;
REVOKE ALL ON FUNCTION public.receive_bill_here(text, jsonb, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_bill_here(text, jsonb, jsonb, text, uuid, text) TO service_role;

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
 * _stock: Zoho's numbers at the godowns, read after the move (see private.batch_transfer_godown); NULL when Zoho is not
 * the stock master. _claim: the calling server's claim (claim_batch_transfer); another call's live claim refuses.
 * Finishing twice returns the first result. Any other Zoho status leaves it as it is, with Zoho's word noted.
 */
CREATE OR REPLACE FUNCTION public.finish_batch_transfer(_transfer_id bigint, _zoho_transfer_order_id text, _zoho_status text, _actor uuid,
  _stock jsonb, _claim uuid)
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
  moved numeric;
  status_now text := lower(btrim(COALESCE(_zoho_status, '')));
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'done' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'cancelled' THEN RAISE EXCEPTION 'Transfer % was cancelled', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN
    RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no;
  END IF;
  IF btrim(COALESCE(_zoho_transfer_order_id, '')) = '' THEN RAISE EXCEPTION 'Zoho''s transfer order is missing'; END IF;
  SELECT * INTO dst FROM public.branches WHERE id = t.to_branch_id;
  -- Products first, then batches: the order orders take their locks in (place_marketplace_order), so a Mark received
  -- and a customer's checkout never wait on each other.
  PERFORM 1 FROM public.catalog_products
    WHERE id IN (SELECT t.product_id UNION SELECT l->>'product_id' FROM jsonb_array_elements(t.lines) AS l)
    ORDER BY id FOR UPDATE;

  IF t.kind = 'split' AND status_now IN ('in_transit', 'transferred') AND t.status = 'pending' THEN
    -- It left the sending godown: Zoho's number there, or down by the quantity (what actually went down is kept).
    moved := private.batch_transfer_godown(t.from_branch_id, t.product_id, -t.quantity, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
    UPDATE public.batch_transfers SET status = 'in_transit', sent_at = now(), zoho_transfer_order_id = _zoho_transfer_order_id,
        zoho_status = status_now, last_error = '', reserved = GREATEST(0, -moved)
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
    -- It arrived: the receiving godown gains it (the sender's stock went down when it left). Zoho's number there; else,
    -- with Zoho the stock master, the quantity Zoho moved; without (no readings at all), what left the sender's website
    -- stock, so a move between godowns never makes website stock.
    PERFORM private.batch_transfer_godown(t.to_branch_id, t.product_id, CASE WHEN _stock IS NULL THEN t.reserved ELSE t.quantity END, _stock, false);
    PERFORM private.batch_transfer_total(t.product_id);
  ELSE
    receiver := jsonb_build_object('role', 'admin', 'name', t.created_by_name);
    made := public.create_batches_from_bill(t.to_branch_id, t.bill, t.lines, t.cost_basis, t.created_by, t.created_by_name);
    UPDATE public.batches SET transfer_id = t.id WHERE id IN (SELECT (m->>'batch_id')::uuid FROM jsonb_array_elements(made) m);
    -- Zoho is the stock master: both godowns take Zoho's numbers. Not the stock master (_stock NULL): a bill's units never
    -- reach website stock (as for a bill received at its own godown), so nothing moves.
    IF _stock IS NOT NULL THEN
      FOR line IN SELECT value FROM jsonb_array_elements(t.lines) LOOP
        PERFORM private.batch_transfer_godown(t.from_branch_id, line->>'product_id', -(line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_godown(t.to_branch_id, line->>'product_id', (line->>'qty')::numeric, _stock, false);
        PERFORM private.batch_transfer_total(line->>'product_id');
      END LOOP;
    END IF;
  END IF;

  UPDATE public.batch_transfers SET status = 'done', zoho_transfer_order_id = _zoho_transfer_order_id, zoho_status = status_now,
      last_error = '', result = made, finished_at = now(), sent_at = COALESCE(sent_at, now()), received_at = now(),
      received_by = CASE WHEN t.kind = 'split' THEN _actor ELSE t.created_by END,
      received_by_name = left(COALESCE(receiver->>'name', ''), 120), received_by_role = receiver->>'role'
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.finish_batch_transfer(bigint, text, text, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_batch_transfer(bigint, text, text, uuid, jsonb, uuid) TO service_role;

-- A try that didn't finish (Zoho gave no answer, or not received yet): noted, and the transfer stays pending.
CREATE OR REPLACE FUNCTION public.note_batch_transfer_attempt(_transfer_id bigint, _error text, _zoho_transfer_order_id text, _zoho_status text, _claim uuid,
  _number_taken boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'pending' THEN RAISE EXCEPTION 'No pending transfer %', _transfer_id; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN RAISE EXCEPTION 'Transfer % is being worked on right now', t.transfer_no; END IF;
  UPDATE public.batch_transfers
    SET attempts = attempts + 1, last_error = left(COALESCE(_error, ''), 500),
        zoho_transfer_order_id = COALESCE(NULLIF(btrim(COALESCE(_zoho_transfer_order_id, '')), ''), zoho_transfer_order_id),
        zoho_status = COALESCE(NULLIF(lower(btrim(COALESCE(_zoho_status, ''))), ''), zoho_status),
        zoho_number_taken = zoho_number_taken OR COALESCE(_number_taken, false)
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.note_batch_transfer_attempt(bigint, text, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_batch_transfer_attempt(bigint, text, text, text, uuid, boolean) TO service_role;

/*
 * A transfer that Zoho does not have (the server checked under its claim: Zoho refused it, has no transfer with its
 * number, or Zoho's is void). Nothing arrived, so the units go back to the super batch, and a bill can be received
 * again. A batch already on its way (in transit) whose transfer was voided or deleted in Zoho is back at the sending
 * godown in Zoho, so that godown's stock comes back too (_stock: Zoho's numbers there now, as in finish).
 */
CREATE OR REPLACE FUNCTION public.cancel_batch_transfer(_transfer_id bigint, _reason text, _by uuid, _stock jsonb, _claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE t public.batch_transfers%ROWTYPE;
BEGIN
  IF _by IS NOT NULL AND NOT private.batch_transfer_admin(_by) THEN RAISE EXCEPTION 'Only administrators can cancel a transfer'; END IF;
  SELECT * INTO t FROM public.batch_transfers WHERE id = _transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF t.status = 'cancelled' THEN RETURN private.batch_transfer_json(t); END IF;
  IF t.status = 'done' THEN RAISE EXCEPTION 'Transfer % is done: its units are at the other godown', t.transfer_no; END IF;
  IF NOT private.batch_transfer_claim_ok(t, _claim) THEN RAISE EXCEPTION 'Transfer % is being worked on right now. Try again in a minute.', t.transfer_no; END IF;
  IF t.kind = 'split' THEN
    -- Product, then batch: the order checkout locks them in.
    PERFORM 1 FROM public.catalog_products WHERE id = t.product_id FOR UPDATE;
    UPDATE public.batches SET remaining_quantity = remaining_quantity + t.quantity,
        sent_quantity = GREATEST(0, sent_quantity - t.quantity)
      WHERE id = t.parent_batch_id;
    -- One on its way had left the sending godown's stock: back there, as Zoho's number when given, else what went down
    -- then (reserved), so nothing comes back that never left. One waiting for Zoho never moved stock.
    IF t.status = 'in_transit' THEN
      PERFORM private.batch_transfer_godown(t.from_branch_id, t.product_id, t.reserved, _stock, false);
      PERFORM private.batch_transfer_total(t.product_id);
    END IF;
  END IF;
  UPDATE public.batch_transfers SET status = 'cancelled', last_error = left(COALESCE(_reason, ''), 500), finished_at = now()
    WHERE id = t.id RETURNING * INTO t;
  RETURN private.batch_transfer_json(t);
END $function$;
REVOKE ALL ON FUNCTION public.cancel_batch_transfer(bigint, text, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_batch_transfer(bigint, text, uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------- delete: a batch in a transfer stays
/**
 * As 20261106140000 (owner, 6 Nov 2026), plus: a batch that came from a transfer, or appears in one as the super batch
 * (even a cancelled one, which still names it), is kept. Its units are at a godown in Zoho because of that transfer,
 * so deleting it would lose them here.
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
     OR EXISTS (SELECT 1 FROM public.batch_transfers WHERE parent_batch_id = batch_row.id) THEN
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
