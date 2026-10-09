-- Migration: 20261009170000_profile_persistence_and_sync.sql
-- Purpose: Ensure profile phone numbers and details reliably persist to Supabase DB,
-- allow authenticated users to upsert their own profile safely, and provide save_profile RPC.

-- 1. Ensure touch_updated_at is SECURITY DEFINER so triggers can update updated_at without column privilege friction
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 2. Grant table and column privileges to authenticated users on profiles
GRANT SELECT, INSERT ON public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, company, gstin, avatar_url, updated_at)
  ON public.profiles TO authenticated;

-- 3. Ensure RLS policies allow own profile insert, select, and update
DROP POLICY IF EXISTS "profiles_own_insert" ON public.profiles;
CREATE POLICY "profiles_own_insert" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_own_select" ON public.profiles;
CREATE POLICY "profiles_own_select" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "profiles_own_update" ON public.profiles;
CREATE POLICY "profiles_own_update" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- 4. Create bulletproof SECURITY DEFINER function to save profile data for auth.uid()
CREATE OR REPLACE FUNCTION public.save_profile(
  _full_name text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _company text DEFAULT NULL,
  _gstin text DEFAULT NULL,
  _avatar_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_email text;
  v_profile public.profiles%ROWTYPE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  INSERT INTO public.profiles (
    id,
    full_name,
    email,
    phone,
    company,
    gstin,
    avatar_url,
    updated_at
  )
  VALUES (
    v_uid,
    COALESCE(NULLIF(TRIM(_full_name), ''), ''),
    COALESCE(v_email, ''),
    NULLIF(TRIM(_phone), ''),
    NULLIF(TRIM(_company), ''),
    NULLIF(TRIM(_gstin), ''),
    _avatar_url,
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = CASE
      WHEN _full_name IS NOT NULL THEN COALESCE(NULLIF(TRIM(_full_name), ''), public.profiles.full_name)
      ELSE public.profiles.full_name
    END,
    phone = CASE
      WHEN _phone IS NOT NULL THEN NULLIF(TRIM(_phone), '')
      ELSE public.profiles.phone
    END,
    company = CASE
      WHEN _company IS NOT NULL THEN NULLIF(TRIM(_company), '')
      ELSE public.profiles.company
    END,
    gstin = CASE
      WHEN _gstin IS NOT NULL THEN NULLIF(TRIM(_gstin), '')
      ELSE public.profiles.gstin
    END,
    avatar_url = CASE
      WHEN _avatar_url IS NOT NULL THEN _avatar_url
      ELSE public.profiles.avatar_url
    END,
    email = CASE
      WHEN public.profiles.email IS NULL OR public.profiles.email = '' THEN COALESCE(v_email, '')
      ELSE public.profiles.email
    END,
    updated_at = now()
  RETURNING * INTO v_profile;

  RETURN to_jsonb(v_profile);
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_profile(text, text, text, text, text) TO authenticated;
