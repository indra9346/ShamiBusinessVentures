-- Hand-over SMS (client and Sandesh, 23 Nov 2026: "once the channel partner marks the product handed over at the godown,
-- the message should go to that customer"): order_customer_messages also keeps 'delivered_sms', so each order gets it
-- once, with what happened shown in Admin › Settings › Customer messages. The SMS itself is off until the admin switches
-- it on there (settings.customer_messages.deliverySms). Only widens a check. Safe to run twice.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.order_customer_messages DROP CONSTRAINT IF EXISTS order_customer_messages_kind_check;
ALTER TABLE public.order_customer_messages ADD CONSTRAINT order_customer_messages_kind_check
  CHECK (kind IN ('invoice_email', 'confirm_sms', 'delivered_sms'));

COMMIT;
NOTIFY pgrst, 'reload schema';
