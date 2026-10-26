-- Zoho -> Grain Bazar fulfilment, now including Packed: a package created in Zoho marks the
-- website order Packed, a shipment Dispatched, a delivered shipment Delivered. The order only ever
-- moves forward (Placed < Payment Confirmed < Accepted < Packed < Dispatched < Out for Delivery <
-- Delivered), and a cancelled order is never touched. Same signature as before, so the app keeps
-- working whether this or the app update lands first.

CREATE OR REPLACE FUNCTION public.apply_zoho_order_fulfillment(_order_id uuid, _status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  current_status text;
  stage CONSTANT text[] := ARRAY['Placed', 'Payment Confirmed', 'Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered'];
  current_rank integer;
  new_rank integer;
BEGIN
  IF _status NOT IN ('Packed', 'Dispatched', 'Delivered') THEN
    RAISE EXCEPTION 'Unsupported Zoho fulfillment status';
  END IF;
  PERFORM set_config('app.zoho_inbound', 'on', true);
  SELECT order_status INTO current_status FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND OR current_status = 'Cancelled' THEN RETURN; END IF;
  current_rank := COALESCE(array_position(stage, CASE WHEN current_status = 'Awaiting Payment' THEN 'Placed' ELSE current_status END), 0);
  new_rank := array_position(stage, _status);
  IF new_rank > current_rank THEN
    UPDATE public.orders SET order_status = _status, updated_at = now() WHERE id = _order_id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_zoho_order_fulfillment(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_zoho_order_fulfillment(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
