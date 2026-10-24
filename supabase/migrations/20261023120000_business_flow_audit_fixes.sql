-- Business-flow audit fixes (23 Oct 2026). Each function is the LIVE definition with only the
-- change described above it.

-- 1. customer_request_return accepted returns on any order except Cancelled / Awaiting Payment,
--    e.g. a Placed, unpaid order. Returns are for delivered goods only, as the return_requests
--    insert policy (which this SECURITY DEFINER function bypasses) and the order page already say.
CREATE OR REPLACE FUNCTION public.customer_request_return(_order_item_id uuid, _quantity integer, _reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE item public.order_items%ROWTYPE; parent public.orders%ROWTYPE; prior integer; new_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'customer') THEN RAISE EXCEPTION 'Customer sign-in is required'; END IF;
  IF _quantity IS NULL OR _quantity < 1 OR length(trim(COALESCE(_reason,''))) = 0 THEN RAISE EXCEPTION 'Provide a valid quantity and return reason'; END IF;
  SELECT * INTO item FROM public.order_items WHERE id = _order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order item not found'; END IF;
  SELECT * INTO parent FROM public.orders WHERE id = item.order_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND OR parent.order_status <> 'Delivered' THEN RAISE EXCEPTION 'This order is not eligible for a return'; END IF;
  SELECT COALESCE(SUM(quantity),0)::integer INTO prior FROM public.return_requests WHERE order_item_id = item.id AND status <> 'Rejected';
  IF prior + _quantity > item.qty THEN RAISE EXCEPTION 'Requested quantity exceeds the unreturned quantity'; END IF;
  INSERT INTO public.return_requests(order_id, order_item_id, customer_id, product_id, vendor_id, quantity, amount, reason)
  VALUES (item.order_id, item.id, auth.uid(), item.product_id, COALESCE(item.vendor_id,''), _quantity,
    round(item.unit_price * _quantity, 2), trim(_reason)) RETURNING id INTO new_id;
  RETURN new_id;
END; $function$;

-- 2. "Not found" checks that never fired: a PERFORM set_config(...) between SELECT ... INTO and
--    IF NOT FOUND resets FOUND to true. cancel_marketplace_order('ORD-typo') returned true having
--    done nothing, apply_zoho_order_cancellation reported 'cancelled' for a missing order, and a
--    receipt for an unknown product failed on a constraint instead of "Product not found".

CREATE OR REPLACE FUNCTION public.cancel_marketplace_order(_order_no text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target public.orders%ROWTYPE;
  line record;
  allocation_row record;
  restore_qty numeric(14,2);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to cancel this order'; END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);
  IF NOT public.has_role(auth.uid(), 'admin')
    AND (NOT public.has_role(auth.uid(), 'customer') OR target.user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'You cannot cancel this order';
  END IF;
  IF target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN
    RAISE EXCEPTION 'Orders can only be cancelled before dispatch';
  END IF;
  IF NOT public.has_role(auth.uid(), 'admin')
    AND target.order_status NOT IN ('Placed', 'Payment Confirmed') THEN
    RAISE EXCEPTION 'Contact support to cancel an order after vendor acceptance';
  END IF;
  IF COALESCE(target.paid_amount, 0) > 0
    OR target.payment_status IN ('Paid', 'Partially Paid') THEN
    RAISE EXCEPTION 'A verified refund must be completed before cancelling a paid order';
  END IF;

  FOR line IN
    SELECT product_id, qty FROM public.order_items WHERE order_id = target.id
  LOOP
    UPDATE public.catalog_products
      SET payload = jsonb_set(
        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),
        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),
        true
      ), updated_at = now()
      WHERE id = line.product_id;
  END LOOP;

  FOR allocation_row IN
    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity
    FROM public.order_item_batch_allocations a
    JOIN public.order_items oi ON oi.id = a.order_item_id
    WHERE oi.order_id = target.id
      AND a.released_quantity < a.reserved_quantity
    ORDER BY a.created_at, a.id
    FOR UPDATE OF a
  LOOP
    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;
    UPDATE public.batches
      SET remaining_quantity = remaining_quantity + restore_qty,
          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END
      WHERE id = allocation_row.batch_id;
    UPDATE public.order_item_batch_allocations
      SET released_quantity = reserved_quantity
      WHERE id = allocation_row.id;
  END LOOP;

  IF target.coupon IS NOT NULL THEN
    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;
  END IF;
  PERFORM set_config('app.cancel_order_workflow', 'on', true);
  UPDATE public.orders
    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0
    WHERE id = target.id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_zoho_order_cancellation(_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE

  target public.orders%ROWTYPE;

  line record;

  allocation_row record;

  restore_qty numeric(14,2);

BEGIN

  SELECT * INTO target FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  PERFORM set_config('app.branch_id', COALESCE(target.branch_id, ''), true);

  IF target.order_status = 'Cancelled' THEN RETURN 'already_cancelled'; END IF;

  -- Same limits as the admin cancellation: before dispatch, and no money taken.

  IF target.order_status NOT IN ('Placed', 'Payment Confirmed', 'Accepted', 'Packed') THEN

    RETURN 'blocked_after_dispatch';

  END IF;

  IF COALESCE(target.paid_amount, 0) > 0 OR target.payment_status IN ('Paid', 'Partially Paid') THEN

    RETURN 'blocked_paid';

  END IF;



  -- Stock goes back (and is synced to Zoho as usual: Grain Bazar is the stock master).

  FOR line IN SELECT product_id, qty FROM public.order_items WHERE order_id = target.id LOOP

    UPDATE public.catalog_products

      SET payload = jsonb_set(

        jsonb_set(payload, '{stock}', to_jsonb(COALESCE((payload->>'stock')::numeric, 0) + line.qty), true),

        '{sold}', to_jsonb(GREATEST(0, COALESCE((payload->>'sold')::numeric, 0) - line.qty)),

        true

      ), updated_at = now()

      WHERE id = line.product_id;

  END LOOP;



  FOR allocation_row IN

    SELECT a.id, a.batch_id, a.reserved_quantity, a.released_quantity

    FROM public.order_item_batch_allocations a

    JOIN public.order_items oi ON oi.id = a.order_item_id

    WHERE oi.order_id = target.id AND a.released_quantity < a.reserved_quantity

    ORDER BY a.created_at, a.id

    FOR UPDATE OF a

  LOOP

    restore_qty := allocation_row.reserved_quantity - allocation_row.released_quantity;

    UPDATE public.batches

      SET remaining_quantity = remaining_quantity + restore_qty,

          status = CASE WHEN remaining_quantity + restore_qty > 0 THEN 'Active' ELSE 'Depleted' END

      WHERE id = allocation_row.batch_id;

    UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity

      WHERE id = allocation_row.id;

  END LOOP;



  IF target.coupon IS NOT NULL THEN

    UPDATE public.coupons SET used_count = GREATEST(0, COALESCE(used_count, 0) - 1) WHERE code = target.coupon;

  END IF;



  -- Set only now, so the stock changes above are still queued for Zoho; the order change itself

  -- came from Zoho and is not sent back.

  PERFORM set_config('app.zoho_inbound', 'on', true);

  PERFORM set_config('app.cancel_order_workflow', 'on', true);

  UPDATE public.orders

    SET order_status = 'Cancelled', advance_due = 0, balance_due = 0

    WHERE id = target.id;

  RETURN 'cancelled';

END

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
      SELECT COALESCE(SUM(remaining_quantity), 0) INTO batch_available
        FROM public.batches WHERE product_id = target_item.product_id;
      IF batch_available >= delta THEN
        needed := delta;
        FOR batch_row IN
          SELECT id, remaining_quantity, unit_cost FROM public.batches
          WHERE product_id = target_item.product_id AND remaining_quantity > 0
          ORDER BY purchase_date ASC NULLS LAST, created_at ASC
          FOR UPDATE
        LOOP
          EXIT WHEN needed <= 0;
          taken := LEAST(needed, batch_row.remaining_quantity);
          UPDATE public.batches
            SET remaining_quantity = remaining_quantity - taken,
                status = CASE WHEN remaining_quantity - taken <= 0 THEN 'Depleted' ELSE 'Active' END
            WHERE id = batch_row.id;
          INSERT INTO public.order_item_batch_allocations (
            order_item_id, batch_id, reserved_quantity, unit_cost
          ) VALUES (target_item.id, batch_row.id, taken, batch_row.unit_cost);
          needed := needed - taken;
        END LOOP;
      END IF;
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

CREATE OR REPLACE FUNCTION public.admin_receive_inventory_batch(_batch_code text, _product_id text, _quantity numeric, _unit_cost numeric, _purchase_date date, _warehouse text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE product_row public.catalog_products%ROWTYPE; batch_id uuid; old_stock numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Only administrators may receive purchase stock'; END IF;
  IF length(trim(COALESCE(_batch_code,''))) = 0 OR _quantity <= 0 OR _unit_cost <= 0 THEN
    RAISE EXCEPTION 'Enter a batch code, positive quantity, and positive unit cost';
  END IF;
  SELECT * INTO product_row FROM public.catalog_products WHERE id = _product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found in the catalogue'; END IF;
  -- Received stock goes to the named godown (its id, code or name), else the default.
  PERFORM set_config('app.branch_id', COALESCE((
    SELECT id FROM public.branches WHERE NULLIF(trim(_warehouse), '') IN (id, code, name) LIMIT 1), ''), true);
  old_stock := COALESCE((product_row.payload->>'stock')::numeric,0);
  INSERT INTO public.batches(batch_code, product_id, product_name, vendor, vendor_id, quantity, remaining_quantity, unit_cost, purchase_date, warehouse, status)
    VALUES (trim(_batch_code), product_row.id, COALESCE(product_row.payload->>'name',product_row.id),
      product_row.payload->>'vendor', product_row.vendor_id, _quantity, _quantity, _unit_cost, _purchase_date,
      NULLIF(trim(_warehouse),''), 'Active') RETURNING id INTO batch_id;
  UPDATE public.catalog_products SET payload = jsonb_set(
      jsonb_set(payload, '{stock}', to_jsonb(old_stock + _quantity), true),
      '{updated}', to_jsonb(now()::text), true), updated_at = now()
    WHERE id = _product_id;
  RETURN batch_id;
END; $function$;

NOTIFY pgrst, 'reload schema';
