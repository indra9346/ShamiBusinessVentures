-- Private vendor compliance documents with explicit vendor/admin access.
CREATE TABLE IF NOT EXISTS public.vendor_kyc_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('gst_certificate', 'pan_card', 'bank_proof', 'business_registration')),
  object_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS vendor_kyc_vendor_created_idx
  ON public.vendor_kyc_documents (vendor_id, created_at DESC);

ALTER TABLE public.vendor_kyc_documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.vendor_kyc_documents TO authenticated;
GRANT ALL ON public.vendor_kyc_documents TO service_role;

DROP POLICY IF EXISTS vendor_kyc_read_own_or_admin ON public.vendor_kyc_documents;
CREATE POLICY vendor_kyc_read_own_or_admin ON public.vendor_kyc_documents
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (user_id = auth.uid() AND vendor_id = public.current_vendor_id())
  );

DROP POLICY IF EXISTS vendor_kyc_submit_own ON public.vendor_kyc_documents;
CREATE POLICY vendor_kyc_submit_own ON public.vendor_kyc_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.has_role(auth.uid(), 'vendor')
    AND vendor_id = public.current_vendor_id()
    AND status = 'Pending'
    AND admin_notes IS NULL
    AND reviewed_at IS NULL
    AND reviewed_by IS NULL
    AND object_path LIKE auth.uid()::text || '/%'
  );

CREATE OR REPLACE FUNCTION public.admin_review_vendor_kyc(_id uuid, _status text, _notes text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only administrators may review vendor documents';
  END IF;
  IF _status NOT IN ('Approved', 'Rejected', 'Pending') THEN
    RAISE EXCEPTION 'Invalid document review status';
  END IF;
  IF length(COALESCE(_notes, '')) > 2000 THEN
    RAISE EXCEPTION 'Review notes must be 2000 characters or fewer';
  END IF;
  UPDATE public.vendor_kyc_documents
  SET status = _status,
      admin_notes = NULLIF(trim(COALESCE(_notes, '')), ''),
      reviewed_at = CASE WHEN _status = 'Pending' THEN NULL ELSE now() END,
      reviewed_by = CASE WHEN _status = 'Pending' THEN NULL ELSE auth.uid() END
  WHERE id = _id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_vendor_kyc(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_vendor_kyc(uuid, text, text) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vendor-kyc', 'vendor-kyc', false, 15728640,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS vendor_kyc_objects_read_own_or_admin ON storage.objects;
CREATE POLICY vendor_kyc_objects_read_own_or_admin ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'vendor-kyc'
    AND ((storage.foldername(name))[1] = (SELECT auth.uid())::text OR public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS vendor_kyc_objects_vendor_upload ON storage.objects;
CREATE POLICY vendor_kyc_objects_vendor_upload ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'vendor-kyc'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND public.has_role(auth.uid(), 'vendor')
  );

DROP POLICY IF EXISTS vendor_kyc_objects_vendor_delete ON storage.objects;
CREATE POLICY vendor_kyc_objects_vendor_delete ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'vendor-kyc'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND public.has_role(auth.uid(), 'vendor')
  );

-- Vendor KYC is enabled by default. When enabled, a vendor must have approved
-- PAN, bank proof and business registration documents (plus GST certificate
-- when their profile has a GSTIN) before submitting or editing listings.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.vendor_kyc_is_complete(_vendor_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  WITH kyc_policy AS (
    SELECT COALESCE(
      (SELECT lower(value->>'vendorKyc') IN ('true', '1', 'yes') FROM public.settings WHERE key = 'security_config'),
      (SELECT lower(value->>'vendorKyc') IN ('true', '1', 'yes') FROM public.settings WHERE key = 'security'),
      true
    ) AS required
  )
  SELECT NOT (SELECT required FROM kyc_policy)
    OR EXISTS (
      SELECT 1 FROM public.profiles profile
      WHERE profile.id = auth.uid() AND profile.vendor_id = _vendor_id
        AND NOT EXISTS (
          SELECT required_type FROM (VALUES ('pan_card'), ('bank_proof'), ('business_registration')) required(required_type)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.vendor_kyc_documents doc
            WHERE doc.user_id = profile.id AND doc.vendor_id = _vendor_id
              AND doc.document_type = required.required_type AND doc.status = 'Approved'
          )
        )
        AND (NULLIF(trim(profile.gstin), '') IS NULL OR EXISTS (
          SELECT 1 FROM public.vendor_kyc_documents doc
          WHERE doc.user_id = profile.id AND doc.vendor_id = _vendor_id
            AND doc.document_type = 'gst_certificate' AND doc.status = 'Approved'
        ))
    );
$$;
REVOKE ALL ON FUNCTION private.vendor_kyc_is_complete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.vendor_kyc_is_complete(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_catalog_product_payload()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.has_role(auth.uid(), 'vendor') AND NOT public.has_role(auth.uid(), 'admin') THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
      OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'pending'))
      OR NEW.payload->'price' IS DISTINCT FROM OLD.payload->'price'
      OR NEW.payload->'mrp' IS DISTINCT FROM OLD.payload->'mrp'
      OR NEW.payload->'gst' IS DISTINCT FROM OLD.payload->'gst'
      OR NEW.payload->'purchasePrice' IS DISTINCT FROM OLD.payload->'purchasePrice' THEN
      RAISE EXCEPTION 'Vendor changes require admin review; only administrators may change price and tax';
    END IF;
  END IF;
  NEW.payload := jsonb_set(NEW.payload, '{id}', to_jsonb(NEW.id), true);
  NEW.payload := jsonb_set(NEW.payload, '{vendorId}', to_jsonb(NEW.vendor_id), true);
  NEW.payload := jsonb_set(NEW.payload, '{category}', to_jsonb(NEW.category), true);
  NEW.payload := jsonb_set(NEW.payload, '{status}', to_jsonb(NEW.status), true);
  NEW.payload := jsonb_set(NEW.payload, '{active}', to_jsonb(NEW.active), true);
  RETURN NEW;
END $$;

DROP POLICY IF EXISTS catalog_products_vendor_insert ON public.catalog_products;
CREATE POLICY catalog_products_vendor_insert ON public.catalog_products
  FOR INSERT TO authenticated WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()
      AND status = 'pending' AND private.vendor_kyc_is_complete(vendor_id))
  );

DROP POLICY IF EXISTS catalog_products_manage ON public.catalog_products;
CREATE POLICY catalog_products_manage ON public.catalog_products
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()))
  WITH CHECK (public.has_role(auth.uid(), 'admin')
    OR (public.has_role(auth.uid(), 'vendor') AND vendor_id = public.current_vendor_id()
      AND status = 'pending' AND private.vendor_kyc_is_complete(vendor_id)));
