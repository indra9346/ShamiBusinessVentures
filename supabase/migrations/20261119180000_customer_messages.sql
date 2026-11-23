-- Customer messages on a confirmed payment (client, 19 Nov 2026: "emails are not going to customers; integrate that
-- emails should go from Zoho Books and SMS order confirmation after marking payment confirmed from admin panel").
--
-- order_customer_messages: one row per order and kind ('invoice_email' through Zoho Books, 'confirm_sms' through
-- Fast2SMS), claimed by the server before it sends, so each goes once however often the order syncs; with what happened
-- (sent, skipped, failed) for the admin's list. settings.customer_messages: the admin's switches (both off at first).
-- Only adds. Safe to run twice.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.order_customer_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invoice_email', 'confirm_sms')),
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'skipped', 'failed')),
  sent_to text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS order_customer_messages_created_idx ON public.order_customer_messages (created_at DESC);
ALTER TABLE public.order_customer_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_customer_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.order_customer_messages_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_customer_messages TO authenticated;
GRANT ALL ON public.order_customer_messages TO service_role;
GRANT ALL ON SEQUENCE public.order_customer_messages_id_seq TO service_role;
DROP POLICY IF EXISTS order_customer_messages_admin_read ON public.order_customer_messages;
CREATE POLICY order_customer_messages_admin_read ON public.order_customer_messages FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.settings (key, value, is_public)
VALUES ('customer_messages', '{"email": false, "sms": false, "smsRoute": "q", "senderId": "", "dltMessageId": ""}'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
