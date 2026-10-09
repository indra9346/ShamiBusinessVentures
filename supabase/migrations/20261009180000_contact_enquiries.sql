-- Migration: 20261009180000_contact_enquiries.sql
-- Purpose: Table and RLS policies for contact / wholesale enquiries dispatched to care@shamiventures.in

CREATE TABLE IF NOT EXISTS public.contact_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  message text NOT NULL,
  recipient_email text NOT NULL DEFAULT 'care@shamiventures.in',
  status text NOT NULL DEFAULT 'new',
  email_sent boolean NOT NULL DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.contact_enquiries ENABLE ROW LEVEL SECURITY;

-- Allow public and authenticated users to insert enquiries
DROP POLICY IF EXISTS "contact_enquiries_insert_policy" ON public.contact_enquiries;
CREATE POLICY "contact_enquiries_insert_policy" ON public.contact_enquiries
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Allow admins to view and manage enquiries
DROP POLICY IF EXISTS "contact_enquiries_admin_select" ON public.contact_enquiries;
CREATE POLICY "contact_enquiries_admin_select" ON public.contact_enquiries
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "contact_enquiries_admin_update" ON public.contact_enquiries;
CREATE POLICY "contact_enquiries_admin_update" ON public.contact_enquiries
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Privileges
GRANT INSERT ON public.contact_enquiries TO anon, authenticated;
GRANT SELECT, UPDATE ON public.contact_enquiries TO authenticated;

-- Operational trigger to log enquiry receipt
CREATE OR REPLACE FUNCTION public.handle_new_contact_enquiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Insert into notifications for administrators if notifications table exists
  IF EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = 'notifications'
  ) THEN
    INSERT INTO public.notifications (role, type, title, body, metadata)
    VALUES (
      'admin',
      'system',
      'New Enquiry from ' || NEW.name,
      'Email: ' || NEW.email || ' | Phone: ' || COALESCE(NEW.phone, 'N/A') || ' | Dispatched to: ' || NEW.recipient_email,
      jsonb_build_object('enquiry_id', NEW.id, 'email', NEW.email, 'phone', NEW.phone, 'recipient', NEW.recipient_email)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contact_enquiry_notify ON public.contact_enquiries;
CREATE TRIGGER trg_contact_enquiry_notify
  AFTER INSERT ON public.contact_enquiries
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_contact_enquiry();
