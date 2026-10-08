CREATE TABLE IF NOT EXISTS public.customer_settings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE public.customer_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_settings TO authenticated;
DROP POLICY IF EXISTS customer_settings_read_own ON public.customer_settings;
CREATE POLICY customer_settings_read_own ON public.customer_settings FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer'));
DROP POLICY IF EXISTS customer_settings_insert_own ON public.customer_settings;
CREATE POLICY customer_settings_insert_own ON public.customer_settings FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer'));
DROP POLICY IF EXISTS customer_settings_update_own ON public.customer_settings;
CREATE POLICY customer_settings_update_own ON public.customer_settings FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer'))
  WITH CHECK (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer'));
DROP POLICY IF EXISTS customer_settings_delete_own ON public.customer_settings;
CREATE POLICY customer_settings_delete_own ON public.customer_settings FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'customer'));
