-- The Zoho Books invoice of each website order, as Zoho has it, so admins, the customer and the
-- order's vendors all see it:
--   * the first invoice is created automatically when an admin confirms the order;
--   * if that invoice is deleted or voided in Zoho, the order shows it, and a new invoice is made
--     only after an admin approves it in the order page (never automatically a second time);
--   * every change (issued, paid, cancelled in Zoho, awaiting approval) notifies the customer, the
--     order's vendors and the admins.
-- Only the trusted server (service role) writes rows; the approval goes through
-- request_zoho_invoice_approval(), which admins may call.

CREATE TABLE IF NOT EXISTS public.zoho_order_invoices (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  zoho_invoice_id text,
  invoice_number text,
  -- none | sent | partially_paid | paid | overdue | void | deleted | awaiting_approval
  status text NOT NULL DEFAULT 'none',
  total numeric(14,2),
  balance numeric(14,2),
  auto_attempts integer NOT NULL DEFAULT 0,
  admin_approved boolean NOT NULL DEFAULT false,
  approved_by uuid,
  approved_at timestamptz,
  last_event text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zoho_order_invoices_order_no_idx ON public.zoho_order_invoices (order_no);

ALTER TABLE public.zoho_order_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zoho_order_invoices_admin_read ON public.zoho_order_invoices;
CREATE POLICY zoho_order_invoices_admin_read ON public.zoho_order_invoices FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS zoho_order_invoices_customer_read ON public.zoho_order_invoices;
CREATE POLICY zoho_order_invoices_customer_read ON public.zoho_order_invoices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));
DROP POLICY IF EXISTS zoho_order_invoices_vendor_read ON public.zoho_order_invoices;
CREATE POLICY zoho_order_invoices_vendor_read ON public.zoho_order_invoices FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'vendor') AND EXISTS (
    SELECT 1 FROM public.orders o WHERE o.id = order_id AND public.current_vendor_id() = ANY (o.vendor_ids)));
GRANT SELECT ON public.zoho_order_invoices TO authenticated;

-- Orders already confirmed have had their one automatic invoice: from now on a (new) invoice for
-- them needs an admin's approval. The next Zoho sync fills in their real invoice details.
INSERT INTO public.zoho_order_invoices (order_id, order_no, auto_attempts, last_event)
SELECT o.id, o.order_no, 1, 'Existing order: further invoices need admin approval'
FROM public.orders o
WHERE o.zoho_salesorder_id IS NOT NULL
  AND o.order_status NOT IN ('Placed', 'Awaiting Payment', 'Cancelled')
ON CONFLICT (order_id) DO NOTHING;

/** An admin approves creating the order's Zoho invoice now (its next one after a deleted/void invoice). */
CREATE OR REPLACE FUNCTION public.request_zoho_invoice_approval(_order_no text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE target public.orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may approve a Zoho invoice';
  END IF;
  SELECT * INTO target FROM public.orders WHERE order_no = _order_no;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF target.order_status IN ('Placed', 'Awaiting Payment', 'Cancelled') THEN
    RAISE EXCEPTION 'Confirm the order before invoicing it';
  END IF;
  INSERT INTO public.zoho_order_invoices (order_id, order_no, admin_approved, approved_by, approved_at, last_event, updated_at)
  VALUES (target.id, target.order_no, true, auth.uid(), now(), 'Admin approved a new invoice', now())
  ON CONFLICT (order_id) DO UPDATE SET admin_approved = true, approved_by = auth.uid(), approved_at = now(),
    last_event = 'Admin approved a new invoice', updated_at = now();
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.request_zoho_invoice_approval(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_zoho_invoice_approval(text) TO authenticated;

/** Tells the customer, the order's vendors and the admins when the order's invoice changes. */
CREATE OR REPLACE FUNCTION public.notify_zoho_invoice_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  title text;
  message text;
  admins_only boolean := false;
  label text := COALESCE(NULLIF(NEW.invoice_number, ''), 'the invoice');
  amount text := CASE WHEN NEW.total IS NULL THEN '' ELSE ' (₹' || to_char(NEW.total, 'FM999,999,999,990.00') || ')' END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.zoho_invoice_id IS NOT DISTINCT FROM OLD.zoho_invoice_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('sent', 'overdue') AND (TG_OP = 'INSERT' OR NEW.zoho_invoice_id IS DISTINCT FROM OLD.zoho_invoice_id OR OLD.status IN ('none', 'void', 'deleted', 'awaiting_approval')) THEN
    title := 'Invoice issued';
    message := format('Invoice %s%s was issued for order %s.', label, amount, NEW.order_no);
  ELSIF NEW.status = 'partially_paid' THEN
    title := 'Invoice partly paid';
    message := format('Invoice %s for order %s is partly paid; ₹%s is due.', label, NEW.order_no, to_char(COALESCE(NEW.balance, 0), 'FM999,999,999,990.00'));
  ELSIF NEW.status = 'paid' THEN
    title := 'Invoice paid';
    message := format('Invoice %s%s for order %s is fully paid.', label, amount, NEW.order_no);
  ELSIF NEW.status IN ('void', 'deleted') THEN
    title := 'Invoice cancelled';
    message := format('Invoice %s for order %s was %s in Zoho Books. A new invoice will be issued after admin approval.',
      label, NEW.order_no, CASE WHEN NEW.status = 'void' THEN 'voided' ELSE 'deleted' END);
  ELSIF NEW.status = 'awaiting_approval' THEN
    title := 'Invoice awaiting approval';
    message := format('Order %s has no Zoho invoice. Approve a new invoice from the order page.', NEW.order_no);
    admins_only := true;
  ELSE
    RETURN NEW;
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT admins_only THEN
    IF o.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (o.order_no, o.id, o.user_id, 'customer', title, message, 'invoice');
    END IF;
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
    SELECT o.order_no, o.id, ur.user_id, 'vendor', p.vendor_id, title, message, 'invoice'
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
    WHERE p.vendor_id = ANY (o.vendor_ids);
  END IF;
  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT o.order_no, o.id, ur.user_id, 'admin', title, message, 'invoice'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zoho_order_invoices_notify ON public.zoho_order_invoices;
CREATE TRIGGER zoho_order_invoices_notify AFTER INSERT OR UPDATE ON public.zoho_order_invoices
  FOR EACH ROW EXECUTE FUNCTION public.notify_zoho_invoice_change();

-- The approval is acted on by the next sync of the order: queue it straight away.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_invoice_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.admin_approved AND (TG_OP = 'INSERT' OR NOT OLD.admin_approved) THEN
    INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type)
    VALUES ('order', NEW.order_id::text, 'upsert')
    ON CONFLICT (entity_type, entity_id, event_type) WHERE status = 'pending' DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zoho_order_invoices_enqueue ON public.zoho_order_invoices;
CREATE TRIGGER zoho_order_invoices_enqueue AFTER INSERT OR UPDATE OF admin_approved ON public.zoho_order_invoices
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_zoho_invoice_approval();

NOTIFY pgrst, 'reload schema';
