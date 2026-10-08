CREATE TABLE IF NOT EXISTS public.vendor_settings (
  vendor_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, key)
);
ALTER TABLE public.vendor_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_settings TO authenticated;
DROP POLICY IF EXISTS vendor_settings_read ON public.vendor_settings;
CREATE POLICY vendor_settings_read ON public.vendor_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
DROP POLICY IF EXISTS vendor_settings_insert ON public.vendor_settings;
CREATE POLICY vendor_settings_insert ON public.vendor_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
DROP POLICY IF EXISTS vendor_settings_update ON public.vendor_settings;
CREATE POLICY vendor_settings_update ON public.vendor_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
DROP POLICY IF EXISTS vendor_settings_delete ON public.vendor_settings;
CREATE POLICY vendor_settings_delete ON public.vendor_settings FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()));
