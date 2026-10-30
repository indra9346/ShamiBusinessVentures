-- Advertising banners for the storefront home page (offers, hot deals, new products, festival
-- banners, promo videos). Admins upload an image or a video of any shape in Admin > Ad Banners;
-- shoppers see the ones that are switched on and inside their start/end dates.
--
-- Banners are website content (like categories), so they live here, not in Zoho.

CREATE TABLE IF NOT EXISTS public.ad_banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  subtitle text NOT NULL DEFAULT '' CHECK (length(subtitle) <= 200),
  media_kind text NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image', 'video')),
  media_url text NOT NULL CHECK (media_url ~ '^https://'),
  -- Optional separate picture for phones (for example a square or tall crop).
  mobile_media_url text CHECK (mobile_media_url IS NULL OR mobile_media_url ~ '^https://'),
  -- "cover" fills the banner area (edges may be cropped); "contain" shows the whole picture.
  fit text NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover', 'contain')),
  background text NOT NULL DEFAULT '#1f3d2f' CHECK (background ~ '^#[0-9A-Fa-f]{6}$'),
  -- Where a tap goes: a page on this site ("/shop?...") or a full https link.
  link_url text CHECK (link_url IS NULL OR link_url ~ '^(/|https://)'),
  cta_label text NOT NULL DEFAULT '' CHECK (length(cta_label) <= 40),
  -- "main": the big sliding banner; "side": the smaller tiles beside it.
  placement text NOT NULL DEFAULT 'main' CHECK (placement IN ('main', 'side')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS ad_banners_live_idx ON public.ad_banners (placement, sort_order) WHERE active;

CREATE OR REPLACE FUNCTION private.touch_ad_banner()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ad_banners_touch ON public.ad_banners;
CREATE TRIGGER ad_banners_touch BEFORE UPDATE ON public.ad_banners
  FOR EACH ROW EXECUTE FUNCTION private.touch_ad_banner();

ALTER TABLE public.ad_banners ENABLE ROW LEVEL SECURITY;

-- Shoppers: banners that are on and running now.
DROP POLICY IF EXISTS ad_banners_public_read ON public.ad_banners;
CREATE POLICY ad_banners_public_read ON public.ad_banners
  FOR SELECT TO anon, authenticated
  USING (
    active
    AND (starts_at IS NULL OR starts_at <= now())
    AND (ends_at IS NULL OR ends_at > now())
  );

-- Admins: everything, including drafts and scheduled or ended banners.
DROP POLICY IF EXISTS ad_banners_admin_all ON public.ad_banners;
CREATE POLICY ad_banners_admin_all ON public.ad_banners
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.ad_banners TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_banners TO authenticated;

-- Banner pictures and promo videos: public to read, only admins upload or remove. 50 MB covers a
-- short promo video; pictures are usually far smaller.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('ad-media', 'ad-media', true, 52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS ad_media_public_read ON storage.objects;
CREATE POLICY ad_media_public_read ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'ad-media');
DROP POLICY IF EXISTS ad_media_admin_insert ON storage.objects;
CREATE POLICY ad_media_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ad-media' AND public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS ad_media_admin_update ON storage.objects;
CREATE POLICY ad_media_admin_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'ad-media' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'ad-media' AND public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS ad_media_admin_delete ON storage.objects;
CREATE POLICY ad_media_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'ad-media' AND public.has_role(auth.uid(), 'admin'));

NOTIFY pgrst, 'reload schema';
