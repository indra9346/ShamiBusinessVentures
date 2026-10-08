-- Publicly readable catalog images; only authenticated users can upload into
-- their own folder. Deletion is limited to the uploader's folder.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('catalog-images', 'catalog-images', true, 5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS catalog_images_public_read ON storage.objects;
CREATE POLICY catalog_images_public_read ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'catalog-images');

DROP POLICY IF EXISTS catalog_images_authenticated_upload ON storage.objects;
CREATE POLICY catalog_images_authenticated_upload ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'catalog-images' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS catalog_images_uploader_delete ON storage.objects;
CREATE POLICY catalog_images_uploader_delete ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'catalog-images' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
