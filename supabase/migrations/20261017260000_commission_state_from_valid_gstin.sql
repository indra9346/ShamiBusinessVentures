-- A vendor's state for commission comes only from a valid GSTIN (an invalid one could start with
-- any two digits and pick the wrong state's rate).
CREATE OR REPLACE FUNCTION private.commission_rate_for(_gstin text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE rules jsonb; state_code text;
BEGIN
  SELECT value INTO rules FROM public.settings WHERE key = 'marketplace_commission';
  state_code := CASE WHEN upper(COALESCE(_gstin, '')) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN left(_gstin, 2) END;
  RETURN COALESCE(
    NULLIF(rules->'state_rates'->>state_code, '')::numeric,
    NULLIF(rules->>'default_rate', '')::numeric,
    8);
END $$;
