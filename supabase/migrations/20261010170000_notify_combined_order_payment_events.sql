-- Keep order-status and payment notifications separate when one database update changes both.
-- This commonly occurs when a payment is reconciled and the order advances to Payment Confirmed.
CREATE OR REPLACE FUNCTION public.notify_order_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  alert_titles text[] := ARRAY[]::text[];
  alert_messages text[] := ARRAY[]::text[];
  alert_statuses text[] := ARRAY[]::text[];
  event_index integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    alert_titles := array_append(alert_titles, 'New order received');
    alert_messages := array_append(alert_messages,
      format('Order %s was placed for ₹%s.', NEW.order_no, to_char(NEW.total, 'FM999,999,999,990.00')));
    alert_statuses := array_append(alert_statuses, 'order');
  ELSE
    IF NEW.order_status IS DISTINCT FROM OLD.order_status THEN
      alert_titles := array_append(alert_titles, 'Order status updated');
      alert_messages := array_append(alert_messages, format('Order %s is now %s.', NEW.order_no, NEW.order_status));
      alert_statuses := array_append(alert_statuses, 'order');
    END IF;

    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN
      alert_titles := array_append(alert_titles,
        CASE WHEN NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN 'Payment received' ELSE 'Payment status updated' END);
      alert_messages := array_append(alert_messages,
        format('Order %s: paid %s of %s; payment is %s.', NEW.order_no,
          to_char(NEW.paid_amount, 'FM999,999,999,990.00'),
          to_char(NEW.total, 'FM999,999,999,990.00'), NEW.payment_status));
      alert_statuses := array_append(alert_statuses, 'payment');
    END IF;
  END IF;

  IF COALESCE(array_length(alert_titles, 1), 0) = 0 THEN
    RETURN NEW;
  END IF;

  FOR event_index IN 1..array_length(alert_titles, 1) LOOP
    IF NEW.user_id IS NOT NULL THEN
      INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
      VALUES (
        NEW.order_no, NEW.id, NEW.user_id, 'customer',
        CASE WHEN TG_OP = 'INSERT' THEN 'Order placed' ELSE alert_titles[event_index] END,
        CASE WHEN TG_OP = 'INSERT' THEN format('Your order %s has been received.', NEW.order_no) ELSE alert_messages[event_index] END,
        alert_statuses[event_index]
      );
    END IF;

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, recipient_vendor_id, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'vendor', p.vendor_id,
      CASE WHEN TG_OP = 'INSERT' THEN 'New order for your products' ELSE alert_titles[event_index] END,
      CASE WHEN TG_OP = 'INSERT' THEN format('Order %s includes products assigned to your store.', NEW.order_no) ELSE alert_messages[event_index] END,
      alert_statuses[event_index]
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'vendor'
    WHERE p.vendor_id = ANY (NEW.vendor_ids)
      AND (TG_OP = 'INSERT' OR ur.user_id IS DISTINCT FROM auth.uid());

    INSERT INTO public.notifications (order_no, order_id, recipient_id, recipient_role, title, message, status)
    SELECT NEW.order_no, NEW.id, ur.user_id, 'admin', alert_titles[event_index], alert_messages[event_index], alert_statuses[event_index]
    FROM public.user_roles ur
    WHERE ur.role = 'admin'
      AND (TG_OP = 'INSERT' OR ur.user_id IS DISTINCT FROM auth.uid());
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_order_participants() FROM PUBLIC, anon, authenticated;
