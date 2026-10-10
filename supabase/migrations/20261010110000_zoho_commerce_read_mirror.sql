-- Read-only Zoho snapshots are stored apart from marketplace operational tables.
-- Access is mediated by admin-guarded server functions using service_role.
CREATE TABLE IF NOT EXISTS public.zoho_commerce_sync_state (
  organization_id text NOT NULL,
  resource text NOT NULL,
  current_batch_id uuid NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  PRIMARY KEY (organization_id, resource)
);

CREATE TABLE IF NOT EXISTS public.zoho_commerce_sync_data (
  organization_id text NOT NULL,
  resource text NOT NULL,
  batch_id uuid NOT NULL,
  external_id text NOT NULL,
  payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, resource, batch_id, external_id)
);

CREATE INDEX IF NOT EXISTS zoho_commerce_sync_data_current_lookup
  ON public.zoho_commerce_sync_data (organization_id, resource, batch_id);

ALTER TABLE public.zoho_commerce_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zoho_commerce_sync_data ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zoho_commerce_sync_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.zoho_commerce_sync_data FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.zoho_commerce_sync_state TO service_role;
GRANT ALL ON public.zoho_commerce_sync_data TO service_role;
