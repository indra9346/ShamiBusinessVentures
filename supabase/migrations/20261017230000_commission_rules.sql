-- Marketplace commission rules (used when the vendor marketplace is ON).
-- A vendor's commission = the admin's explicit rate for that vendor, else the rate for the
-- vendor's state (from the first two digits of their GSTIN), else the default rate.
-- The effective rate is kept on profiles.commission_rate, which payouts already use.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS commission_override boolean NOT NULL DEFAULT false;
-- Existing rates were set by an administrator: keep them as explicit rates.
UPDATE public.profiles SET commission_override = true WHERE vendor_id IS NOT NULL AND commission_rate IS NOT NULL;

INSERT INTO public.settings (key, value, is_public)
VALUES ('marketplace_commission', '{"default_rate": 8, "state_rates": {}}'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION private.commission_rate_for(_gstin text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE rules jsonb; state_code text;
BEGIN
  SELECT value INTO rules FROM public.settings WHERE key = 'marketplace_commission';
  state_code := CASE WHEN COALESCE(_gstin, '') ~ '^[0-9]{2}' THEN left(_gstin, 2) END;
  RETURN COALESCE(
    NULLIF(rules->'state_rates'->>state_code, '')::numeric,
    NULLIF(rules->>'default_rate', '')::numeric,
    8);
END $$;

-- Apply the rules to every vendor without an explicit rate.
CREATE OR REPLACE FUNCTION public.admin_apply_commission_rules()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may change commission rules';
  END IF;
  UPDATE public.profiles p SET commission_rate = private.commission_rate_for(p.gstin), updated_at = now()
   WHERE p.vendor_id IS NOT NULL AND NOT p.commission_override
     AND p.commission_rate IS DISTINCT FROM private.commission_rate_for(p.gstin);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.admin_apply_commission_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_apply_commission_rules() TO authenticated;

-- An explicit rate for one vendor (overrides the rules); NULL returns the vendor to the rules.
CREATE OR REPLACE FUNCTION public.admin_set_vendor_commission(_vendor_id text, _rate numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may change commission rates';
  END IF;
  IF _rate IS NOT NULL AND (_rate < 0 OR _rate > 100) THEN RAISE EXCEPTION 'Commission must be between 0 and 100'; END IF;
  UPDATE public.profiles
     SET commission_rate = COALESCE(_rate, private.commission_rate_for(gstin)),
         commission_override = _rate IS NOT NULL,
         updated_at = now()
   WHERE vendor_id = _vendor_id AND EXISTS (
     SELECT 1 FROM public.user_roles ur WHERE ur.user_id = profiles.id AND ur.role = 'vendor');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END $$;

-- A vendor's GSTIN change (state) re-applies the rules to them.
CREATE OR REPLACE FUNCTION public.reapply_vendor_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.vendor_id IS NOT NULL AND NOT NEW.commission_override AND NEW.gstin IS DISTINCT FROM OLD.gstin THEN
    NEW.commission_rate := private.commission_rate_for(NEW.gstin);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_reapply_commission ON public.profiles;
CREATE TRIGGER profiles_reapply_commission BEFORE UPDATE OF gstin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.reapply_vendor_commission();
