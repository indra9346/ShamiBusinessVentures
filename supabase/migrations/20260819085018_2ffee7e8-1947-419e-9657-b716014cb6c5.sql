-- roles
CREATE TYPE public.app_role AS ENUM ('admin','vendor','customer');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text,
  company text,
  gstin text,
  avatar_url text,
  vendor_id text,
  status text NOT NULL DEFAULT 'Active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.current_vendor_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT vendor_id FROM public.profiles WHERE id = auth.uid()
$$;

CREATE POLICY "profiles_own_select" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "profiles_own_insert" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_own_update" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (id = auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE POLICY "roles_own_select" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

-- signup trigger: profile + default customer role
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE wanted text;
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, company, gstin, vendor_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name',''),
    COALESCE(NEW.email,''),
    NEW.raw_user_meta_data->>'phone',
    NEW.raw_user_meta_data->>'company',
    NEW.raw_user_meta_data->>'gstin',
    NEW.raw_user_meta_data->>'vendor_id'
  )
  ON CONFLICT (id) DO NOTHING;

  wanted := COALESCE(NEW.raw_user_meta_data->>'role','customer');
  IF wanted NOT IN ('customer','vendor') THEN wanted := 'customer'; END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, wanted::public.app_role)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- addresses
CREATE TABLE public.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Home',
  name text NOT NULL,
  phone text NOT NULL,
  line text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  pin text NOT NULL,
  landmark text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addresses TO authenticated;
GRANT ALL ON public.addresses TO service_role;
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "addresses_own" ON public.addresses FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

-- orders
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text NOT NULL UNIQUE,
  parent_order_no text,
  split_index integer,
  split_count integer,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_name text NOT NULL DEFAULT '',
  customer_email text NOT NULL DEFAULT '',
  customer_phone text,
  customer_gstin text,
  vendor_ids text[] NOT NULL DEFAULT '{}',
  gst_applied boolean NOT NULL DEFAULT true,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount numeric(14,2) NOT NULL DEFAULT 0,
  gst_amount numeric(14,2) NOT NULL DEFAULT 0,
  shipping numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  advance_due numeric(14,2) NOT NULL DEFAULT 0,
  balance_due numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  payment_method text,
  payment_status text NOT NULL DEFAULT 'Pending',
  order_status text NOT NULL DEFAULT 'Awaiting Payment',
  shipping_method text NOT NULL DEFAULT 'Standard',
  shipping_address jsonb,
  coupon text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON public.orders (user_id);
CREATE INDEX orders_parent_idx ON public.orders (parent_order_no);
CREATE INDEX orders_vendor_idx ON public.orders USING gin (vendor_ids);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE POLICY "orders_select" ON public.orders FOR SELECT TO authenticated
  USING (user_id = auth.uid()
     OR public.has_role(auth.uid(),'admin')
     OR (public.has_role(auth.uid(),'vendor') AND public.current_vendor_id() = ANY (vendor_ids)));
CREATE POLICY "orders_insert_own" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "orders_update" ON public.orders FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin')
     OR (public.has_role(auth.uid(),'vendor') AND public.current_vendor_id() = ANY (vendor_ids))
     OR user_id = auth.uid())
  WITH CHECK (public.has_role(auth.uid(),'admin')
     OR (public.has_role(auth.uid(),'vendor') AND public.current_vendor_id() = ANY (vendor_ids))
     OR user_id = auth.uid());
CREATE POLICY "orders_delete_admin" ON public.orders FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'admin'));

CREATE OR REPLACE FUNCTION public.can_read_order(_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = _order
      AND (o.user_id = auth.uid()
        OR public.has_role(auth.uid(),'admin')
        OR (public.has_role(auth.uid(),'vendor') AND public.current_vendor_id() = ANY (o.vendor_ids)))
  )
$$;

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  product_name text NOT NULL,
  sku text,
  vendor text,
  vendor_id text,
  qty integer NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  gst_rate numeric(5,2) NOT NULL DEFAULT 5,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  batch_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx ON public.order_items (order_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_items_read" ON public.order_items FOR SELECT TO authenticated
  USING (public.can_read_order(order_id));
CREATE POLICY "order_items_write" ON public.order_items FOR INSERT TO authenticated
  WITH CHECK (public.can_read_order(order_id));
CREATE POLICY "order_items_update" ON public.order_items FOR UPDATE TO authenticated
  USING (public.can_read_order(order_id)) WITH CHECK (public.can_read_order(order_id));

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'advance',
  amount numeric(14,2) NOT NULL DEFAULT 0,
  method text,
  status text NOT NULL DEFAULT 'Pending',
  txn_ref text,
  session_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON public.payments (order_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER payments_touch BEFORE UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "payments_read" ON public.payments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin')
     OR (order_id IS NOT NULL AND public.can_read_order(order_id)));
CREATE POLICY "payments_insert" ON public.payments FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "payments_update" ON public.payments FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.order_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  note text,
  actor_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_tracking_order_idx ON public.order_tracking (order_id);
GRANT SELECT, INSERT ON public.order_tracking TO authenticated;
GRANT ALL ON public.order_tracking TO service_role;
ALTER TABLE public.order_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tracking_read" ON public.order_tracking FOR SELECT TO authenticated
  USING (public.can_read_order(order_id));
CREATE POLICY "tracking_insert" ON public.order_tracking FOR INSERT TO authenticated
  WITH CHECK (public.can_read_order(order_id));

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_role text NOT NULL DEFAULT 'customer',
  recipient_vendor_id text,
  title text NOT NULL,
  message text NOT NULL,
  status text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON public.notifications (recipient_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications_read" ON public.notifications FOR SELECT TO authenticated
  USING (recipient_id = auth.uid()
     OR public.has_role(auth.uid(),'admin')
     OR (recipient_role = 'vendor' AND recipient_vendor_id IS NOT NULL AND recipient_vendor_id = public.current_vendor_id()));
CREATE POLICY "notifications_insert" ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE TO authenticated
  USING (recipient_id = auth.uid() OR public.has_role(auth.uid(),'admin')
     OR (recipient_role = 'vendor' AND recipient_vendor_id = public.current_vendor_id()))
  WITH CHECK (recipient_id = auth.uid() OR public.has_role(auth.uid(),'admin')
     OR (recipient_role = 'vendor' AND recipient_vendor_id = public.current_vendor_id()));
CREATE POLICY "notifications_delete" ON public.notifications FOR DELETE TO authenticated
  USING (recipient_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code text NOT NULL UNIQUE,
  product_id text NOT NULL,
  product_name text NOT NULL,
  vendor text,
  vendor_id text,
  quantity numeric(14,2) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'KG',
  purchase_date date,
  mfg_date date,
  expiry_date date,
  status text NOT NULL DEFAULT 'Active',
  warehouse text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.batches TO authenticated;
GRANT SELECT ON public.batches TO anon;
GRANT ALL ON public.batches TO service_role;
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER batches_touch BEFORE UPDATE ON public.batches
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE POLICY "batches_read" ON public.batches FOR SELECT TO authenticated USING (true);
CREATE POLICY "batches_write_admin" ON public.batches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR (public.has_role(auth.uid(),'vendor') AND vendor_id = public.current_vendor_id()))
  WITH CHECK (public.has_role(auth.uid(),'admin') OR (public.has_role(auth.uid(),'vendor') AND vendor_id = public.current_vendor_id()));

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text NOT NULL UNIQUE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  gst_amount numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Issued',
  issued_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invoices_read" ON public.invoices FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin')
     OR (order_id IS NOT NULL AND public.can_read_order(order_id)));
CREATE POLICY "invoices_insert" ON public.invoices FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  version text NOT NULL DEFAULT 'v1.0',
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.policies TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.policies TO authenticated;
GRANT ALL ON public.policies TO service_role;
ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "policies_public_read" ON public.policies FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "policies_admin_write" ON public.policies FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.policy_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  order_no text,
  policy_version text NOT NULL DEFAULT 'v1.0',
  accepted_slugs text[] NOT NULL DEFAULT '{}',
  accepted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.policy_acceptance TO authenticated;
GRANT ALL ON public.policy_acceptance TO service_role;
ALTER TABLE public.policy_acceptance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "policy_acc_read" ON public.policy_acceptance FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "policy_acc_insert" ON public.policy_acceptance FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE TABLE public.settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.settings TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_public_read" ON public.settings FOR SELECT TO anon, authenticated
  USING (is_public OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "settings_admin_write" ON public.settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  provider text,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_names text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integrations TO authenticated;
GRANT ALL ON public.integrations TO service_role;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integrations_admin" ON public.integrations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.website_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.website_content TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.website_content TO authenticated;
GRANT ALL ON public.website_content TO service_role;
ALTER TABLE public.website_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY "content_public_read" ON public.website_content FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "content_admin_write" ON public.website_content FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.crm_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL DEFAULT 'customer',
  subject_id text NOT NULL,
  subject_name text,
  note text NOT NULL,
  status text,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_notes TO authenticated;
GRANT ALL ON public.crm_notes TO service_role;
ALTER TABLE public.crm_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "crm_admin" ON public.crm_notes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- seed policies, settings, integrations, website sections
INSERT INTO public.policies (slug, title, version, body) VALUES
 ('terms','Terms & Conditions','v1.0','These terms govern all purchases on Shami Business Ventures. Orders above Rs. 2,80,000 are automatically split into linked sub-orders under a common parent order. A 30% advance is required to begin processing; dispatch happens only after 100% payment.'),
 ('privacy','Privacy Policy','v1.0','We collect only the information required to process your orders. GSTIN is never derived from your phone number or email; it is used only when you provide it yourself on a verified business profile.'),
 ('refund','Refund & Cancellation Policy','v1.0','Orders may be cancelled before dispatch. Advance payments are refundable less transaction charges until the order is packed.'),
 ('shipping','Shipping Policy','v1.0','Standard freight takes 2-4 business days, express freight is next business day. Dispatch is only released once full payment is received.'),
 ('payment','Payment Policy','v1.0','All payments are collected online. Every payment session expires 20 minutes after it is created. Cash on delivery is not available.');

INSERT INTO public.settings (key, value, is_public) VALUES
 ('company', '{"name":"Shami Business Ventures","phone":"+91 98450 11223","email":"support@shamibusiness.in","address":"Industrial Estate, Belagavi, Karnataka 590010","gstin":"29ABCDE1234F1Z5","currency":"INR"}', true),
 ('tax', '{"gst_default":5,"gst_enabled":true,"cess":0}', true),
 ('order', '{"split_threshold":280000,"advance_percent":30,"payment_timer_minutes":20,"cod_enabled":false}', true),
 ('payment', '{"methods":["UPI","Credit Card","Debit Card","Net Banking"],"cod_enabled":false,"advance_percent":30,"timer_minutes":20}', true),
 ('notification', '{"email":true,"sms":true,"whatsapp":false,"push":true}', false),
 ('shipping', '{"standard":250,"express":650,"free_above":10000}', true),
 ('security', '{"session_hours":12,"password_min":8,"rate_limit_per_minute":10}', false),
 ('website', '{"hero_headline":"Institutional grade staples, delivered with certainty","announcement":"","maintenance":false}', true);

INSERT INTO public.integrations (key, name, category, provider, enabled, config, secret_names) VALUES
 ('payment_gateway','Payment Gateway','Payments','Razorpay', false, '{"mode":"sandbox","currency":"INR"}', '{RAZORPAY_KEY_ID,RAZORPAY_KEY_SECRET}'),
 ('email','Transactional Email','Communication','Resend', false, '{"from":"orders@shamibusiness.in"}', '{RESEND_API_KEY}'),
 ('sms','SMS Alerts','Communication','MSG91', false, '{"sender":"SHAMIB"}', '{MSG91_AUTH_KEY}'),
 ('whatsapp','WhatsApp Business','Communication','Meta Cloud API', false, '{"number":"+919845011223"}', '{WHATSAPP_TOKEN}'),
 ('push','Push Notifications','Communication','Web Push', true, '{"topic":"orders"}', '{}'),
 ('gst','GST / Tax Services','Compliance','ClearTax', false, '{"verify_gstin":true}', '{CLEARTAX_API_KEY}'),
 ('shipping','Shipping & Delivery','Logistics','Delhivery', false, '{"pickup_pin":"590010"}', '{DELHIVERY_TOKEN}'),
 ('analytics','Analytics','Insights','Google Analytics 4', false, '{"measurement_id":""}', '{}');

INSERT INTO public.website_content (section, title, data, enabled) VALUES
 ('homepage','Homepage','{"headline":"Institutional grade staples","subline":"Sugar, rice, oils and pulses sourced from verified mills.","cta":"Browse catalogue"}', true),
 ('banners','Banners','{"items":[{"title":"Monsoon sugar contracts","subtitle":"S1 grade at mill rates","cta":"Shop sugar","active":true},{"title":"Bulk rice tenders","subtitle":"Steam & raw rice in 50kg bags","cta":"Shop rice","active":true}]}', true),
 ('featured','Featured Products','{"product_ids":[]}', true),
 ('offers','Offers','{"items":[{"code":"SHAMI10","label":"10% off first institutional order","active":true}]}', true),
 ('about','About','{"body":"Shami Business Ventures is a Belagavi based B2B distributor of sugar and daily staples serving institutions across South India."}', true),
 ('contact','Contact','{"phone":"+91 98450 11223","email":"support@shamibusiness.in","address":"Industrial Estate, Belagavi, Karnataka 590010"}', true),
 ('footer','Footer','{"note":"GSTIN 29ABCDE1234F1Z5 | FSSAI 10018064002045","columns":[]}', true),
 ('faq','FAQ','{"items":[{"q":"What is the minimum order value?","a":"Institutional orders start at Rs. 10,000."},{"q":"Why is 30% advance required?","a":"The advance confirms your slot with the mill; the balance is due before dispatch."}]}', true);