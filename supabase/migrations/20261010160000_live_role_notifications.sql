-- Persist transactional order, payment, return, and enquiry alerts for their actual recipients.
-- The database is the source of truth; Supabase Realtime delivers these rows to each inbox.

CREATE OR REPLACE FUNCTION public.notify_order_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alert_title text;
  alert_message text;
  alert_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    alert_title := 'New order received';
    alert_message := format('Order %s was placed for ₹%s.', NEW.order_no, to_char(NEW.total, 'FM999,999,999,990.00'));
    alert_status := 'order';

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'admin', alert_title, alert_message, alert_status
    FROM public.user_roles ur WHERE ur.role = 'admin';

    IF NEW.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (NEW.order_no, NEW.id, NEW.user_id, 'customer', 'Order placed',
        format('Your order %s has been received.', NEW.order_no), alert_status);
    END IF;

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'vendor', p.vendor_id, 'New order for your products',
      format('Order %s includes products assigned to your store.', NEW.order_no), alert_status
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
    WHERE p.vendor_id = ANY (NEW.vendor_ids);
    RETURN NEW;
  END IF;

  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status
     AND NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status
     AND NEW.paid_amount IS NOT DISTINCT FROM OLD.paid_amount THEN
    RETURN NEW;
  END IF;

  IF NEW.order_status IS DISTINCT FROM OLD.order_status THEN
    alert_title := 'Order status updated';
    alert_message := format('Order %s is now %s.', NEW.order_no, NEW.order_status);
    alert_status := 'order';
  ELSE
    alert_title := CASE WHEN NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN 'Payment received' ELSE 'Payment status updated' END;
    alert_message := format('Order %s: paid %s of %s; payment is %s.', NEW.order_no,
      to_char(NEW.paid_amount, 'FM999,999,999,990.00'), to_char(NEW.total, 'FM999,999,999,990.00'), NEW.payment_status);
    alert_status := 'payment';
  END IF;

  IF NEW.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (NEW.order_no, NEW.id, NEW.user_id, 'customer', alert_title, alert_message, alert_status);
  END IF;

  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
  SELECT NEW.order_no, NEW.id, ur.user_id, 'vendor', p.vendor_id, alert_title, alert_message, alert_status
  FROM public.profiles p
  JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
  WHERE p.vendor_id = ANY (NEW.vendor_ids);

  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT NEW.order_no, NEW.id, ur.user_id, 'admin', alert_title, alert_message, alert_status
  FROM public.user_roles ur
  WHERE ur.role = 'admin' AND ur.user_id IS DISTINCT FROM auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_notify_participants ON public.orders;
CREATE TRIGGER orders_notify_participants
AFTER INSERT OR UPDATE OF order_status, payment_status, paid_amount ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.notify_order_participants();

CREATE OR REPLACE FUNCTION public.notify_return_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_order public.orders%ROWTYPE;
  alert_title text;
  alert_message text;
BEGIN
  SELECT * INTO parent_order FROM public.orders WHERE id = NEW.order_id;
  IF TG_OP = 'INSERT' THEN
    alert_title := 'Return request received';
    alert_message := format('A return was requested for order %s.', parent_order.order_no);
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.refund_status IS DISTINCT FROM OLD.refund_status THEN
    alert_title := 'Return request updated';
    alert_message := format('The return for order %s is %s (refund: %s).', parent_order.order_no, NEW.status, NEW.refund_status);
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
  SELECT parent_order.order_no, parent_order.id, ur.user_id, 'admin', alert_title, alert_message, 'return'
  FROM public.user_roles ur WHERE ur.role = 'admin' AND ur.user_id IS DISTINCT FROM auth.uid();

  IF NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM auth.uid() THEN
    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    VALUES (parent_order.order_no, parent_order.id, NEW.customer_id, 'customer', alert_title, alert_message, 'return');
  END IF;

  INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
  SELECT parent_order.order_no, parent_order.id, ur.user_id, 'vendor', p.vendor_id, alert_title, alert_message, 'return'
  FROM public.profiles p JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
  WHERE p.vendor_id = NEW.vendor_id AND ur.user_id IS DISTINCT FROM auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS return_requests_notify_participants ON public.return_requests;
CREATE TRIGGER return_requests_notify_participants
AFTER INSERT OR UPDATE OF status, refund_status ON public.return_requests
FOR EACH ROW EXECUTE FUNCTION public.notify_return_participants();

CREATE OR REPLACE FUNCTION public.notify_low_stock_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_stock numeric := COALESCE(NULLIF(NEW.payload->>'stock', '')::numeric, 0);
  new_reorder numeric := COALESCE(NULLIF(NEW.payload->>'minimumStock', '')::numeric, 30);
  old_stock numeric := 0;
  old_reorder numeric := 30;
  alert_title text;
  alert_message text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_stock := COALESCE(NULLIF(OLD.payload->>'stock', '')::numeric, 0);
    old_reorder := COALESCE(NULLIF(OLD.payload->>'minimumStock', '')::numeric, 30);
    IF new_stock IS NOT DISTINCT FROM old_stock AND new_reorder IS NOT DISTINCT FROM old_reorder THEN
      RETURN NEW;
    END IF;
  END IF;

  IF new_stock <= 0 AND (TG_OP = 'INSERT' OR old_stock > 0) THEN
    alert_title := 'Product out of stock';
    alert_message := format('%s is out of stock.', COALESCE(NEW.payload->>'name', NEW.id));
  ELSIF new_stock < new_reorder AND (TG_OP = 'INSERT' OR old_stock >= old_reorder) THEN
    alert_title := 'Low stock alert';
    alert_message := format('%s has %s units remaining; reorder level is %s.',
      COALESCE(NEW.payload->>'name', NEW.id), new_stock, new_reorder);
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (recipient_id, recipient_role, recipient_vendor_id, title, message, status)
  SELECT ur.user_id, 'admin', NULL, alert_title, alert_message, 'warning'
  FROM public.user_roles ur WHERE ur.role = 'admin' AND ur.user_id IS DISTINCT FROM auth.uid();

  INSERT INTO public.notifications (recipient_id, recipient_role, recipient_vendor_id, title, message, status)
  SELECT ur.user_id, 'vendor', NEW.vendor_id, alert_title, alert_message, 'warning'
  FROM public.user_roles ur
  JOIN public.profiles p ON p.id = ur.user_id
  WHERE ur.role = 'vendor' AND p.vendor_id = NEW.vendor_id AND ur.user_id IS DISTINCT FROM auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_products_notify_low_stock ON public.catalog_products;
CREATE TRIGGER catalog_products_notify_low_stock
AFTER INSERT OR UPDATE OF payload ON public.catalog_products
FOR EACH ROW EXECUTE FUNCTION public.notify_low_stock_participants();

-- Fix the earlier enquiry trigger, which used notification columns that do not exist.
CREATE OR REPLACE FUNCTION public.handle_new_contact_enquiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (recipient_id, recipient_role, title, message, status)
  SELECT ur.user_id, 'admin', 'New customer enquiry',
    format('%s · %s · %s', NEW.name, NEW.email, COALESCE(NEW.phone, 'Phone not provided')), 'enquiry'
  FROM public.user_roles ur WHERE ur.role = 'admin';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_order_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_return_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_low_stock_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_contact_enquiry() FROM PUBLIC, anon, authenticated;
