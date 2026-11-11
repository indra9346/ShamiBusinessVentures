-- Since 10 Nov 2026 Hostinger answers every call from a server with its "Bot Verification" page, so Zoho's webhooks
-- never reach grainbazar.com. Zoho now delivers to the Supabase Edge Function zoho-webhook, which only parks the call
-- here. The website's 15-minute job checks Zoho's signature, applies the call the same way as before, and removes the
-- row, so customer details in these bodies stay here for minutes, not for good.
-- Nothing but the server key can read or write this table.

CREATE TABLE IF NOT EXISTS public.zoho_webhook_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  signature text NOT NULL,
  content_type text,
  query text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS zoho_webhook_inbox_oldest ON public.zoho_webhook_inbox (id);

ALTER TABLE public.zoho_webhook_inbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.zoho_webhook_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zoho_webhook_inbox TO service_role;

NOTIFY pgrst, 'reload schema';
