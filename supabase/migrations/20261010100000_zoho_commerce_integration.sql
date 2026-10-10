-- Zoho Commerce credentials are always written by trusted server code.
-- No authenticated or anonymous role receives access to this table.
CREATE TABLE IF NOT EXISTS public.zoho_commerce_connection (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  organization_id text NOT NULL,
  region text NOT NULL CHECK (region IN ('com', 'eu', 'in', 'com_au', 'jp', 'ca')),
  refresh_token_ciphertext text NOT NULL,
  token_iv text NOT NULL,
  token_tag text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_synced_at timestamptz,
  last_error text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zoho_commerce_connection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_commerce_connection FROM anon, authenticated;
GRANT ALL ON public.zoho_commerce_connection TO service_role;

ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS zoho_coupon_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS zoho_redemption_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS zoho_usage_limit_per_user integer,
  ADD COLUMN IF NOT EXISTS zoho_notice_fingerprint text;

DROP POLICY IF EXISTS coupons_customer_read ON public.coupons;
CREATE POLICY coupons_customer_read ON public.coupons
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'customer')
    AND active
    AND starts_on <= current_date
    AND ends_on >= current_date
    AND used_count < usage_limit
  );

-- Coupon discount values are revalidated and applied by the same trusted order
-- transaction that reserves catalog inventory. The browser never sets totals.
CREATE OR REPLACE FUNCTION public.guard_order_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN RETURN NEW; END IF;
  IF current_setting('app.coupon_checkout', true) = 'on'
    AND OLD.user_id = auth.uid()
    AND NEW.user_id = OLD.user_id
    AND NEW.order_no = OLD.order_no
    AND NEW.order_status = OLD.order_status
    AND NEW.total <= OLD.total
    AND NEW.discount >= 0
    AND NEW.discount <= OLD.total
    AND (to_jsonb(NEW) - ARRAY['total','discount','coupon','balance_due'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['total','discount','coupon','balance_due']) THEN
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - 'order_status' IS DISTINCT FROM to_jsonb(OLD) - 'order_status' THEN
    RAISE EXCEPTION 'Customers and vendors cannot edit order totals, items, or delivery data';
  END IF;
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  IF OLD.user_id = auth.uid() AND public.has_role(auth.uid(), 'customer')
    AND OLD.order_status IN ('Placed', 'Payment Confirmed') AND NEW.order_status = 'Cancelled' THEN
    RETURN NEW;
  END IF;
  IF public.has_role(auth.uid(), 'vendor')
    AND public.current_vendor_id() = ANY (OLD.vendor_ids)
    AND NEW.order_status IN ('Accepted', 'Packed', 'Dispatched', 'Out for Delivery', 'Delivered') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This account is not allowed to make that order status change';
END $$;

CREATE OR REPLACE FUNCTION public.place_marketplace_order_with_coupon(
  _order_no text,
  _target_user_id uuid,
  _customer_name text,
  _customer_email text,
  _customer_phone text,
  _customer_gstin text,
  _shipping_address jsonb,
  _shipping_method text,
  _payment_method text,
  _items jsonb,
  _coupon text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  coupon_row public.coupons%ROWTYPE;
  order_result jsonb;
  coupon_code text := NULLIF(upper(trim(_coupon)), '');
  coupon_discount numeric(14,2) := 0;
  order_subtotal numeric(14,2);
  order_total numeric(14,2);
  customer_uses integer;
BEGIN
  IF coupon_code IS NOT NULL THEN
    IF auth.uid() IS NULL OR NOT (
      public.has_role(auth.uid(), 'customer')
      OR public.has_role(auth.uid(), 'admin')
    ) THEN
      RAISE EXCEPTION 'Only a customer or administrator can use a coupon';
    END IF;
    IF public.has_role(auth.uid(), 'customer') AND _target_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Customers can use coupons only on their own orders';
    END IF;
    SELECT * INTO coupon_row FROM public.coupons
      WHERE code = coupon_code FOR UPDATE;
    IF NOT FOUND OR NOT coupon_row.active
      OR coupon_row.starts_on > current_date
      OR coupon_row.ends_on < current_date
      OR coupon_row.used_count >= coupon_row.usage_limit THEN
      RAISE EXCEPTION 'This coupon is not active or has reached its usage limit';
    END IF;
    IF coupon_row.zoho_usage_limit_per_user IS NOT NULL THEN
      SELECT count(*) INTO customer_uses FROM public.orders
        WHERE user_id = _target_user_id AND coupon = coupon_code
          AND order_status <> 'Cancelled';
      IF customer_uses >= coupon_row.zoho_usage_limit_per_user THEN
        RAISE EXCEPTION 'This customer has already used this coupon the maximum number of times';
      END IF;
    END IF;
  END IF;

  order_result := public.place_marketplace_order(
    _order_no, _target_user_id, _customer_name, _customer_email,
    _customer_phone, _customer_gstin, _shipping_address,
    _shipping_method, _payment_method, _items
  );
  order_subtotal := (order_result->>'subtotal')::numeric;
  order_total := (order_result->>'total')::numeric;

  IF coupon_code IS NOT NULL THEN
    IF order_subtotal < coupon_row.minimum_order THEN
      RAISE EXCEPTION 'Add more items to meet this coupon’s minimum order amount';
    END IF;
    IF coupon_row.discount_type = 'Percentage' THEN
      coupon_discount := LEAST(
        coupon_row.maximum_discount,
        round(order_subtotal * coupon_row.discount_value / 100, 2)
      );
    ELSE
      coupon_discount := LEAST(order_subtotal, coupon_row.discount_value);
    END IF;
    order_total := GREATEST(0, order_total - coupon_discount);
    PERFORM set_config('app.coupon_checkout', 'on', true);
    UPDATE public.orders
      SET coupon = coupon_code,
          discount = coupon_discount,
          total = order_total,
          balance_due = GREATEST(order_total - paid_amount, 0)
      WHERE order_no = _order_no AND user_id = _target_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Could not apply the coupon to this order'; END IF;
    UPDATE public.coupons SET used_count = used_count + 1 WHERE code = coupon_code;
  END IF;

  RETURN order_result || jsonb_build_object(
    'coupon', coupon_code,
    'discount', coupon_discount,
    'total', order_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.place_marketplace_order_with_coupon(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_marketplace_order_with_coupon(text, uuid, text, text, text, text, jsonb, text, text, jsonb, text) TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'coupons') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.coupons;
    END IF;
  END IF;
END $$;
