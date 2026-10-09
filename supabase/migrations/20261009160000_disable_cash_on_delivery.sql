-- Migration: 20261009160000_disable_cash_on_delivery.sql
-- Enforce platform-wide policy: Cash on Delivery is strictly disabled.
-- Only online/prepaid methods (UPI, Credit Card, Debit Card, Net Banking) are supported.

DO $$
BEGIN
  -- 1. Ensure no existing constraint conflicts before adding CHECK constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_no_cash_on_delivery_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_no_cash_on_delivery_check
      CHECK (payment_method IS NULL OR payment_method NOT IN ('Cash on Delivery', 'COD'));
  END IF;
END $$;

-- 2. Update commerce and payment settings to permanently record COD as disabled
INSERT INTO public.settings (key, value, is_public)
VALUES (
  'payment_policy',
  jsonb_build_object(
    'cod_enabled', false,
    'online_only', true,
    'supported_methods', jsonb_build_array('UPI', 'Credit Card', 'Debit Card', 'Net Banking'),
    'policy_notice', 'All payments must be made online via UPI, Credit/Debit Card, or Net Banking. Cash on delivery is not accepted.'
  ),
  true
)
ON CONFLICT (key) DO UPDATE
SET
  value = jsonb_build_object(
    'cod_enabled', false,
    'online_only', true,
    'supported_methods', jsonb_build_array('UPI', 'Credit Card', 'Debit Card', 'Net Banking'),
    'policy_notice', 'All payments must be made online via UPI, Credit/Debit Card, or Net Banking. Cash on delivery is not accepted.'
  ),
  is_public = true,
  updated_at = now();

-- 3. Update public settings 'commerce_rules' to record cod_enabled = false
UPDATE public.settings
SET
  value = jsonb_set(
    COALESCE(value, '{}'::jsonb),
    '{cod_enabled}',
    'false'::jsonb,
    true
  ),
  updated_at = now()
WHERE key = 'commerce_rules';
