-- Answering a customer's request to see or delete their information, from Admin > Customers.
-- Written for review: apply it before any zip that contains the matching code.

-- Who downloaded or deleted whose information, and when. Holds a short masked label instead of the
-- customer's details, and has no foreign key on customer_id, so it outlives the customer's login.
CREATE TABLE IF NOT EXISTS public.customer_data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('export', 'delete')),
  customer_id uuid NOT NULL,
  customer_label text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  actor_email text NOT NULL DEFAULT '',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  login_removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_data_requests_customer_idx ON public.customer_data_requests (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_data_requests_created_idx ON public.customer_data_requests (created_at DESC);

ALTER TABLE public.customer_data_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_data_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_data_requests TO authenticated;
GRANT ALL ON public.customer_data_requests TO service_role;
DROP POLICY IF EXISTS customer_data_requests_admin_read ON public.customer_data_requests;
CREATE POLICY customer_data_requests_admin_read ON public.customer_data_requests
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- "R.K. ··3210": enough to recognise the entry in the log, without keeping the details themselves.
CREATE OR REPLACE FUNCTION private.customer_data_label(_name text, _phone text, _email text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(concat_ws(' ',
    NULLIF((SELECT string_agg(upper(left(word, 1)) || '.', '') FROM unnest(string_to_array(btrim(COALESCE(_name, '')), ' ')) AS word WHERE word <> ''), ''),
    CASE
      WHEN length(regexp_replace(COALESCE(_phone, ''), '[^0-9]', '', 'g')) >= 4
        THEN '··' || right(regexp_replace(_phone, '[^0-9]', '', 'g'), 4)
      WHEN position('@' IN COALESCE(_email, '')) > 1
        THEN left(_email, 1) || '··@' || split_part(_email, '@', 2)
    END
  ));
$$;
REVOKE ALL ON FUNCTION private.customer_data_label(text, text, text) FROM PUBLIC, anon, authenticated;

-- An enquiry has no customer id, so it is matched on the customer's email or phone (last 10 digits).
-- The export and the delete both use this, so they always mean the same enquiries. An order's phone is
-- left out: it can be whoever receives the delivery, and their enquiry is not this customer's.
CREATE OR REPLACE FUNCTION private.customer_enquiry_matches(_customer_id uuid)
RETURNS TABLE (enquiry_id uuid, matched_by text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH emails AS (
    SELECT lower(btrim(email)) AS email FROM public.profiles WHERE id = _customer_id
    UNION SELECT lower(btrim(email)) FROM auth.users WHERE id = _customer_id
    UNION SELECT lower(btrim(customer_email)) FROM public.orders WHERE user_id = _customer_id
  ), phones AS (
    SELECT right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) AS phone FROM public.profiles WHERE id = _customer_id
    UNION SELECT right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) FROM auth.users WHERE id = _customer_id
  )
  SELECT e.id,
    CASE WHEN lower(btrim(e.email)) IN (SELECT email FROM emails WHERE email <> '') THEN 'email' ELSE 'phone' END
  FROM public.contact_enquiries e
  WHERE lower(btrim(e.email)) IN (SELECT email FROM emails WHERE email <> '')
     OR right(regexp_replace(COALESCE(e.phone, ''), '[^0-9]', '', 'g'), 10) IN (SELECT phone FROM phones WHERE length(phone) = 10);
$$;
REVOKE ALL ON FUNCTION private.customer_enquiry_matches(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.require_admin_actor()
RETURNS public.profiles LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access is required';
  END IF;
  SELECT * INTO actor FROM public.profiles WHERE id = auth.uid();
  RETURN actor;
END $$;
REVOKE ALL ON FUNCTION private.require_admin_actor() FROM PUBLIC, anon, authenticated;

-- Delivery notes arrive with PR #94, so they are looked up only if the table exists. A note is permanent
-- by the client's rule and its fixed copy holds the customer's phone, so a delete cannot remove that: it
-- goes in the customer's file, and the confirmation says it stays.
CREATE OR REPLACE FUNCTION private.customer_delivery_notes(_order_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE notes jsonb;
BEGIN
  IF to_regclass('public.delivery_notes') IS NULL THEN RETURN '[]'::jsonb; END IF;
  EXECUTE $q$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'note_no', note_no, 'order_no', order_no, 'invoice_number', invoice_number, 'generated_at', generated_at,
        'customer', snapshot->'customer', 'address', snapshot->'address') ORDER BY generated_at), '[]'::jsonb)
    FROM public.delivery_notes WHERE order_id = ANY ($1)
  $q$ INTO notes USING _order_ids;
  RETURN notes;
END $$;
REVOKE ALL ON FUNCTION private.customer_delivery_notes(uuid[]) FROM PUBLIC, anon, authenticated;

-- Everything the site holds on one customer, as one reply, recorded in the log in the same step.
-- Left out on purpose: the raw text and sender of the store's own bank SMS, which can show the
-- store's balance, and the ids of staff who reviewed something. Partner commissions and stock
-- batches are the store's records about an order, not information about the customer.
CREATE OR REPLACE FUNCTION public.admin_export_customer_data(_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor public.profiles%ROWTYPE := private.require_admin_actor();
  person public.profiles%ROWTYPE;
  order_ids uuid[];
  file jsonb;
  counts jsonb;
BEGIN
  SELECT * INTO person FROM public.profiles WHERE id = _customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Customer not found'; END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO order_ids FROM public.orders WHERE user_id = _customer_id;

  file := jsonb_build_object(
    'customer_id', _customer_id,
    'generated_at', now(),
    'generated_by', COALESCE(NULLIF(actor.full_name, ''), actor.email),
    'label', private.customer_data_label(person.full_name, person.phone, person.email),
    'account', (SELECT to_jsonb(a) FROM (
        SELECT email, phone, created_at, last_sign_in_at, email_confirmed_at, phone_confirmed_at, raw_user_meta_data AS details
        FROM auth.users WHERE id = _customer_id) a),
    'sign_in_methods', (SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]') FROM (
        SELECT provider, identity_data AS details FROM auth.identities WHERE user_id = _customer_id) i),
    'profile', to_jsonb(person) - 'commission_rate' - 'commission_override' - 'vendor_id',
    'roles', (SELECT COALESCE(jsonb_agg(to_jsonb(r) - 'id' - 'user_id'), '[]') FROM public.user_roles r WHERE r.user_id = _customer_id),
    'addresses', (SELECT COALESCE(jsonb_agg(to_jsonb(a) - 'user_id' ORDER BY a.created_at), '[]') FROM public.addresses a WHERE a.user_id = _customer_id),
    'settings', (SELECT COALESCE(jsonb_agg(to_jsonb(s) - 'user_id' ORDER BY s.key), '[]') FROM public.customer_settings s WHERE s.user_id = _customer_id),
    'orders', (SELECT COALESCE(jsonb_agg(to_jsonb(o) - 'user_id' - 'vendor_ids' - 'zoho_last_polled_at' - 'zoho_last_modified_at' ORDER BY o.created_at), '[]') FROM public.orders o WHERE o.user_id = _customer_id),
    'order_items', (SELECT COALESCE(jsonb_agg((to_jsonb(i) - 'vendor_id') || jsonb_build_object('order_no', o.order_no) ORDER BY o.created_at, i.created_at), '[]')
        FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE i.order_id = ANY (order_ids)),
    'order_tracking', (SELECT COALESCE(jsonb_agg(to_jsonb(t) || jsonb_build_object('order_no', o.order_no) ORDER BY t.created_at), '[]')
        FROM public.order_tracking t JOIN public.orders o ON o.id = t.order_id WHERE t.order_id = ANY (order_ids)),
    'invoices', (SELECT COALESCE(jsonb_agg(to_jsonb(v) - 'user_id' ORDER BY v.issued_at), '[]') FROM public.invoices v WHERE v.user_id = _customer_id OR v.order_id = ANY (order_ids)),
    'delivery_notes', private.customer_delivery_notes(order_ids),
    'zoho_invoices', (SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.order_no), '[]') FROM (
        SELECT order_no, invoice_number, status, total, balance, updated_at FROM public.zoho_order_invoices WHERE order_id = ANY (order_ids)) z),
    'payments', (SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'user_id' || jsonb_build_object('order_no', o.order_no) ORDER BY p.created_at), '[]')
        FROM public.payments p LEFT JOIN public.orders o ON o.id = p.order_id WHERE p.user_id = _customer_id OR p.order_id = ANY (order_ids)),
    'payment_references', (SELECT COALESCE(jsonb_agg(to_jsonb(s) - 'user_id' - 'reviewed_by' ORDER BY s.submitted_at), '[]') FROM public.upi_payment_submissions s WHERE s.user_id = _customer_id OR s.order_id = ANY (order_ids)),
    'bank_receipts', (SELECT COALESCE(jsonb_agg(to_jsonb(c) - 'raw' - 'sender' ORDER BY c.received_at), '[]') FROM public.bank_credits c WHERE c.order_id = ANY (order_ids)),
    'reviews', (SELECT COALESCE(jsonb_agg(to_jsonb(r) - 'customer_id' - 'vendor_id' ORDER BY r.created_at), '[]') FROM public.product_reviews r WHERE r.customer_id = _customer_id),
    'returns', (SELECT COALESCE(jsonb_agg((to_jsonb(r) - 'customer_id' - 'vendor_id') || jsonb_build_object('order_no', o.order_no) ORDER BY r.created_at), '[]')
        FROM public.return_requests r LEFT JOIN public.orders o ON o.id = r.order_id WHERE r.customer_id = _customer_id),
    'enquiries', (SELECT COALESCE(jsonb_agg(to_jsonb(e) || jsonb_build_object('matched_by', m.matched_by) ORDER BY e.created_at), '[]')
        FROM private.customer_enquiry_matches(_customer_id) m JOIN public.contact_enquiries e ON e.id = m.enquiry_id),
    'notifications', (SELECT COALESCE(jsonb_agg(to_jsonb(n) - 'recipient_id' - 'recipient_vendor_id' ORDER BY n.created_at), '[]') FROM public.notifications n WHERE n.recipient_id = _customer_id),
    'policy_acceptance', (SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'user_id' ORDER BY p.accepted_at), '[]') FROM public.policy_acceptance p WHERE p.user_id = _customer_id),
    'admin_notes', (SELECT COALESCE(jsonb_agg(to_jsonb(c) - 'author_id' ORDER BY c.created_at), '[]') FROM public.crm_notes c WHERE c.subject_type = 'customer' AND c.subject_id = _customer_id::text),
    'seller_applications', (SELECT COALESCE(jsonb_agg(to_jsonb(v) - 'applicant_id' - 'reviewed_by' ORDER BY v.created_at), '[]') FROM public.vendor_applications v WHERE v.applicant_id = _customer_id),
    'seller_documents', (SELECT COALESCE(jsonb_agg(to_jsonb(d) - 'user_id' - 'reviewed_by' ORDER BY d.created_at), '[]') FROM public.vendor_kyc_documents d WHERE d.user_id = _customer_id),
    'zoho_contacts', (SELECT COALESCE(jsonb_agg(to_jsonb(z)), '[]') FROM (SELECT contact_type, zoho_contact_id FROM public.zoho_contact_links WHERE user_id = _customer_id) z),
    -- The site's own copy of Zoho's sales orders: this customer's, by order or by Zoho contact.
    'zoho_sales_orders', (SELECT COALESCE(jsonb_agg(m.payload ORDER BY m.external_id), '[]') FROM public.zoho_commerce_sync_data m
        WHERE m.resource = 'sales_orders' AND (
          m.external_id IN (SELECT zoho_salesorder_id FROM public.orders WHERE user_id = _customer_id AND zoho_salesorder_id IS NOT NULL)
          OR m.payload->>'customer_id' IN (SELECT zoho_contact_id FROM public.zoho_contact_links WHERE user_id = _customer_id)))
  );

  SELECT jsonb_object_agg(key, jsonb_array_length(value)) INTO counts FROM jsonb_each(file) WHERE jsonb_typeof(value) = 'array';

  INSERT INTO public.customer_data_requests (kind, customer_id, customer_label, actor_id, actor_name, actor_email, summary)
  VALUES ('export', _customer_id, file->>'label', auth.uid(), COALESCE(actor.full_name, ''), COALESCE(actor.email, ''), jsonb_build_object('counts', counts));

  RETURN file;
END $$;
REVOKE ALL ON FUNCTION public.admin_export_customer_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_export_customer_data(uuid) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Deleting a customer's information (the owner's option A, 3 Nov 2026).
-- What goes and what stays is decided here, in customer_order_is_sale and admin_delete_customer_data,
-- so a change of rule from the lawyer or CA is a change to these two. Nothing is ever sent to Zoho.
--
-- Goes: login, profile, saved addresses and map positions, preferences, reviews, enquiries, messages,
--   admin notes, seller applications, and the name, phone, GSTIN and address on orders that never
--   became a sale.
-- Stays: sales (see customer_order_is_sale) with the name, address and GSTIN, because invoices and
--   accounts may have to be kept by law; their invoices, payments, returns and partner commissions.
--   Phone and email come off them, except on a delivery note (see customer_delivery_notes). Totals and
--   items stay on every order, for reports and commissions.
-- ---------------------------------------------------------------------------------------------

-- A return is a money record, so it must outlive the customer's login instead of going with it.
ALTER TABLE public.return_requests ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE public.return_requests DROP CONSTRAINT IF EXISTS return_requests_customer_id_fkey;
ALTER TABLE public.return_requests ADD CONSTRAINT return_requests_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- An order that became a sale, or that money or a tax document ever touched.
CREATE OR REPLACE FUNCTION private.customer_order_is_sale(_order public.orders)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _order.order_status = 'Delivered'
    OR _order.paid_amount > 0
    OR _order.payment_status IN ('Paid', 'Partially Paid', 'Refunded')
    OR EXISTS (SELECT 1 FROM public.invoices v WHERE v.order_id = _order.id)
    OR EXISTS (SELECT 1 FROM public.zoho_order_invoices z WHERE z.order_id = _order.id AND (z.zoho_invoice_id IS NOT NULL OR z.invoice_number IS NOT NULL))
    OR EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = _order.id AND p.status NOT IN ('Pending', 'Failed'))
    OR EXISTS (SELECT 1 FROM public.upi_payment_submissions s WHERE s.order_id = _order.id AND s.status = 'confirmed')
    OR EXISTS (SELECT 1 FROM public.bank_credits c WHERE c.order_id = _order.id)
    OR EXISTS (SELECT 1 FROM public.return_requests r WHERE r.order_id = _order.id);
$$;
REVOKE ALL ON FUNCTION private.customer_order_is_sale(public.orders) FROM PUBLIC, anon, authenticated;

-- Why this customer can't be deleted yet, one entry per reason with the order numbers it concerns.
-- The screen words each code (src/lib/customer-data.ts).
CREATE OR REPLACE FUNCTION private.customer_deletion_blockers(_customer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'orders', orders) ORDER BY step), '[]'::jsonb)
  FROM (
    SELECT code, min(step) AS step, COALESCE(jsonb_agg(DISTINCT order_no) FILTER (WHERE order_no IS NOT NULL), '[]'::jsonb) AS orders
    FROM (
      SELECT 1 AS step, 'other_login' AS code, NULL::text AS order_no
      WHERE EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _customer_id AND role <> 'customer')
         OR EXISTS (SELECT 1 FROM public.profiles WHERE id = _customer_id AND vendor_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.channel_partners WHERE user_id = _customer_id)
         OR EXISTS (SELECT 1 FROM public.staff_employees WHERE user_id = _customer_id)
      UNION ALL
      SELECT 2, 'open_order', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status NOT IN ('Delivered', 'Cancelled', 'Payment Expired')
      UNION ALL
      SELECT 3, 'unpaid_delivery', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status = 'Delivered' AND o.payment_status NOT IN ('Paid', 'Refunded')
      UNION ALL
      SELECT 4, 'money_not_refunded', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status IN ('Cancelled', 'Payment Expired') AND o.paid_amount > 0 AND o.payment_status <> 'Refunded'
      UNION ALL
      SELECT 5, 'open_return', o.order_no FROM public.return_requests r JOIN public.orders o ON o.id = r.order_id
      WHERE r.customer_id = _customer_id AND r.status <> 'Rejected' AND (r.status <> 'Completed' OR r.refund_status IN ('Pending', 'Processing'))
      UNION ALL
      SELECT 6, 'unconfirmed_payment', o.order_no FROM public.upi_payment_submissions s JOIN public.orders o ON o.id = s.order_id
      WHERE o.user_id = _customer_id AND s.status = 'submitted'
      UNION ALL
      SELECT 7, 'waiting_for_zoho', o.order_no FROM public.zoho_sync_outbox q JOIN public.orders o ON o.id::text = q.entity_id
      WHERE o.user_id = _customer_id AND q.status IN ('pending', 'processing', 'failed', 'needs_review')
      UNION ALL
      -- A later change to such an order would look for its Zoho contact using the phone and email this removes.
      SELECT 8, 'not_in_zoho', o.order_no FROM public.orders o
      WHERE o.user_id = _customer_id AND o.order_status = 'Delivered' AND o.zoho_salesorder_id IS NULL
        AND EXISTS (SELECT 1 FROM public.zoho_commerce_connection c WHERE c.status = 'connected')
    ) reasons
    GROUP BY code
  ) grouped;
$$;
REVOKE ALL ON FUNCTION private.customer_deletion_blockers(uuid) FROM PUBLIC, anon, authenticated;

-- What a delete would do, for the confirmation and for the record.
CREATE OR REPLACE FUNCTION private.customer_deletion_plan(_customer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH mine AS (
    SELECT o.id, o.order_no, private.customer_order_is_sale(o) AS is_sale FROM public.orders o WHERE o.user_id = _customer_id
  )
  SELECT jsonb_build_object(
    'removed', jsonb_build_object(
      'addresses', (SELECT count(*) FROM public.addresses WHERE user_id = _customer_id),
      'preferences', (SELECT count(*) FROM public.customer_settings WHERE user_id = _customer_id),
      'reviews', (SELECT count(*) FROM public.product_reviews WHERE customer_id = _customer_id),
      'enquiries', (SELECT count(*) FROM private.customer_enquiry_matches(_customer_id)),
      'enquiries_by_phone', (SELECT count(*) FROM private.customer_enquiry_matches(_customer_id) WHERE matched_by = 'phone'),
      'notifications', (SELECT count(*) FROM public.notifications WHERE recipient_id = _customer_id),
      'admin_notes', (SELECT count(*) FROM public.crm_notes WHERE subject_type = 'customer' AND subject_id = _customer_id::text),
      'seller_applications', (SELECT count(*) FROM public.vendor_applications WHERE applicant_id = _customer_id),
      'seller_documents', (SELECT count(*) FROM public.vendor_kyc_documents WHERE user_id = _customer_id),
      'orders_cleared', (SELECT count(*) FROM mine WHERE NOT is_sale)
    ),
    'kept', jsonb_build_object(
      'orders', (SELECT count(*) FROM mine WHERE is_sale),
      'invoices', (SELECT count(*) FROM public.invoices WHERE user_id = _customer_id OR order_id IN (SELECT id FROM mine)),
      'payments', (SELECT count(*) FROM public.payments WHERE user_id = _customer_id OR order_id IN (SELECT id FROM mine)),
      'payment_references', (SELECT count(*) FROM public.upi_payment_submissions WHERE user_id = _customer_id OR order_id IN (SELECT id FROM mine)),
      'returns', (SELECT count(*) FROM public.return_requests WHERE customer_id = _customer_id),
      'partner_commissions', (SELECT count(*) FROM public.partner_commissions WHERE order_id IN (SELECT id FROM mine)),
      'delivery_notes', (SELECT jsonb_array_length(private.customer_delivery_notes(COALESCE(array_agg(id), '{}'))) FROM mine)
    ),
    'kept_orders', (SELECT COALESCE(jsonb_agg(order_no ORDER BY order_no) FILTER (WHERE is_sale), '[]'::jsonb) FROM mine),
    'cleared_orders', (SELECT COALESCE(jsonb_agg(order_no ORDER BY order_no) FILTER (WHERE NOT is_sale), '[]'::jsonb) FROM mine),
    'zoho_contacts', (SELECT COALESCE(jsonb_agg(zoho_contact_id ORDER BY zoho_contact_id), '[]'::jsonb) FROM public.zoho_contact_links WHERE user_id = _customer_id)
  );
$$;
REVOKE ALL ON FUNCTION private.customer_deletion_plan(uuid) FROM PUBLIC, anon, authenticated;

-- The confirmation screen's facts. Changes nothing, so it leaves no record.
CREATE OR REPLACE FUNCTION public.admin_customer_deletion_preview(_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor public.profiles%ROWTYPE := private.require_admin_actor();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = _customer_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Customer not found';
  END IF;
  RETURN jsonb_build_object(
    'blockers', private.customer_deletion_blockers(_customer_id),
    'plan', private.customer_deletion_plan(_customer_id)
  );
END $$;
REVOKE ALL ON FUNCTION public.admin_customer_deletion_preview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_customer_deletion_preview(uuid) TO authenticated;

-- Removes what can go, all or nothing, and records who did it. The server then removes any uploaded
-- seller files and the login itself (src/lib/customer-data.functions.ts). If that step fails the
-- profile is left marked 'deleted', and calling this again only hands back the same record.
CREATE OR REPLACE FUNCTION public.admin_delete_customer_data(_customer_id uuid, _confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor public.profiles%ROWTYPE := private.require_admin_actor();
  person public.profiles%ROWTYPE;
  earlier public.customer_data_requests%ROWTYPE;
  problems jsonb;
  plan jsonb;
  kept_ids uuid[];
  cleared_ids uuid[];
  all_ids uuid[];
  contact_ids text[];
  sales_order_ids text[];
  known_names text[];
  known_name text;
  mirror_rows integer;
  request_id uuid;
BEGIN
  IF _confirmation IS DISTINCT FROM 'DELETE' THEN
    RAISE EXCEPTION 'Type DELETE to confirm';
  END IF;

  SELECT * INTO person FROM public.profiles WHERE id = _customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Customer not found'; END IF;

  IF person.status = 'deleted' THEN
    SELECT * INTO earlier FROM public.customer_data_requests
      WHERE customer_id = _customer_id AND kind = 'delete' ORDER BY created_at DESC LIMIT 1;
    RETURN jsonb_build_object('request_id', earlier.id, 'summary', earlier.summary, 'already_done', true);
  END IF;

  PERFORM 1 FROM public.orders WHERE user_id = _customer_id FOR UPDATE;
  problems := private.customer_deletion_blockers(_customer_id);
  IF jsonb_array_length(problems) > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'This customer cannot be deleted yet', DETAIL = problems::text;
  END IF;
  plan := private.customer_deletion_plan(_customer_id);

  -- Everything below stays out of the Zoho queue, and the guard on orders lets it through.
  PERFORM set_config('app.zoho_inbound', 'on', true);

  SELECT COALESCE(array_agg(o.id) FILTER (WHERE private.customer_order_is_sale(o)), '{}'),
         COALESCE(array_agg(o.id) FILTER (WHERE NOT private.customer_order_is_sale(o)), '{}'),
         COALESCE(array_agg(o.id), '{}'),
         COALESCE(array_agg(o.zoho_salesorder_id) FILTER (WHERE o.zoho_salesorder_id IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT o.customer_name), '{}')
    INTO kept_ids, cleared_ids, all_ids, sales_order_ids, known_names
    FROM public.orders o WHERE o.user_id = _customer_id;
  SELECT COALESCE(array_agg(zoho_contact_id), '{}') INTO contact_ids FROM public.zoho_contact_links WHERE user_id = _customer_id;

  -- Messages to the admin that repeat an enquiry's details go with the enquiry; names in order alerts are replaced.
  DELETE FROM public.notifications n
    USING private.customer_enquiry_matches(_customer_id) m JOIN public.contact_enquiries e ON e.id = m.enquiry_id
    WHERE n.status = 'enquiry'
      AND (position(e.id::text IN n.message) > 0 OR (btrim(e.email) <> '' AND position(lower(e.email) IN lower(n.message)) > 0));
  DELETE FROM public.contact_enquiries WHERE id IN (SELECT enquiry_id FROM private.customer_enquiry_matches(_customer_id));
  DELETE FROM public.notifications WHERE recipient_id = _customer_id;
  FOREACH known_name IN ARRAY array_append(known_names, person.full_name) LOOP
    IF length(btrim(COALESCE(known_name, ''))) >= 3 THEN
      UPDATE public.notifications
        SET title = replace(title, known_name, 'A customer'), message = replace(message, known_name, 'A customer')
        WHERE order_id = ANY (all_ids) AND (position(known_name IN title) > 0 OR position(known_name IN message) > 0);
    END IF;
  END LOOP;

  DELETE FROM public.addresses WHERE user_id = _customer_id;
  DELETE FROM public.customer_settings WHERE user_id = _customer_id;
  DELETE FROM public.product_reviews WHERE customer_id = _customer_id;
  DELETE FROM public.crm_notes WHERE subject_type = 'customer' AND subject_id = _customer_id::text;
  DELETE FROM public.vendor_applications WHERE applicant_id = _customer_id;

  -- Sales keep the name, address and GSTIN. The order's address also carries a phone and a link to the saved address.
  UPDATE public.orders SET
      user_id = NULL, customer_email = '', customer_phone = NULL,
      shipping_address = CASE WHEN jsonb_typeof(shipping_address) = 'object'
        THEN shipping_address - ARRAY['id', 'phone', 'mobile', 'email', 'latitude', 'longitude', 'location_accuracy_m', 'located_at']
        ELSE shipping_address END
    WHERE id = ANY (kept_ids);
  UPDATE public.orders SET
      user_id = NULL, customer_name = 'Deleted customer', customer_email = '', customer_phone = NULL,
      customer_gstin = NULL, business_legal_name = NULL, shipping_address = NULL
    WHERE id = ANY (cleared_ids);

  -- These stay as records, no longer tied to a person's account. A UTR must stay: the duplicate checks read it.
  UPDATE public.invoices SET user_id = NULL WHERE user_id = _customer_id;
  UPDATE public.payments SET user_id = NULL WHERE user_id = _customer_id;
  UPDATE public.upi_payment_submissions SET user_id = NULL WHERE user_id = _customer_id OR order_id = ANY (all_ids);
  UPDATE public.upi_payment_submissions SET customer_name = 'Deleted customer' WHERE order_id = ANY (cleared_ids);
  UPDATE public.return_requests SET customer_id = NULL WHERE customer_id = _customer_id;
  DELETE FROM public.policy_acceptance WHERE user_id = _customer_id AND (order_id IS NULL OR order_id = ANY (cleared_ids));
  UPDATE public.policy_acceptance SET user_id = NULL WHERE user_id = _customer_id;

  -- The Zoho contact stays in Zoho. Dropping the link stops a Zoho edit being copied back to the site.
  DELETE FROM public.zoho_contact_links WHERE user_id = _customer_id;
  DELETE FROM public.zoho_sync_outbox WHERE entity_type = 'customer' AND entity_id = _customer_id::text;
  UPDATE public.zoho_sync_outbox SET last_error = NULL WHERE entity_id = ANY (SELECT id::text FROM unnest(all_ids) AS id) AND status = 'complete';
  -- The site's own copy of Zoho's sales orders. It refills from Zoho at the next mirror refresh.
  DELETE FROM public.zoho_commerce_sync_data
    WHERE resource = 'sales_orders' AND (external_id = ANY (sales_order_ids) OR payload->>'customer_id' = ANY (contact_ids));
  GET DIAGNOSTICS mirror_rows = ROW_COUNT;
  IF mirror_rows > 0 THEN
    UPDATE public.zoho_commerce_sync_state SET record_count = GREATEST(0, record_count - mirror_rows) WHERE resource = 'sales_orders';
  END IF;

  UPDATE public.profiles SET
      full_name = 'Deleted customer', email = '', phone = NULL, company = NULL, gstin = NULL, avatar_url = NULL,
      business_city = NULL, business_address = NULL, status = 'deleted'
    WHERE id = _customer_id;

  INSERT INTO public.customer_data_requests (kind, customer_id, customer_label, actor_id, actor_name, actor_email, summary)
  VALUES ('delete', _customer_id, private.customer_data_label(person.full_name, person.phone, person.email),
    auth.uid(), COALESCE(actor.full_name, ''), COALESCE(actor.email, ''), plan)
  RETURNING id INTO request_id;

  RETURN jsonb_build_object('request_id', request_id, 'summary', plan, 'already_done', false);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_customer_data(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_customer_data(uuid, text) TO authenticated;

-- Any later route to the queue, such as the initial export, skips a customer whose login is still being removed.
CREATE OR REPLACE FUNCTION public.enqueue_zoho_sync(_entity_type text, _entity_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _entity_type = 'customer' AND EXISTS (SELECT 1 FROM public.profiles WHERE id::text = _entity_id AND status = 'deleted') THEN
    RETURN;
  END IF;
  INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type)
  VALUES (_entity_type, _entity_id, 'upsert')
  ON CONFLICT (entity_type, entity_id, event_type) WHERE status = 'pending'
  DO UPDATE SET available_at = now(), updated_at = now(), last_error = NULL;
END;
$$;
