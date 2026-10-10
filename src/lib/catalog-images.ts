import { supabase } from "@/integrations/supabase/client";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export async function uploadCatalogImage(file: File, kind: "products" | "categories" | "profiles"): Promise<string> {
  const extension = IMAGE_EXTENSIONS[file.type];
  if (!extension) throw new Error("Choose a JPG, PNG, WebP, GIF or AVIF image");
  if (file.size > MAX_IMAGE_SIZE) throw new Error("Image must be 5 MB or smaller");
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Sign in before uploading an image");

  const path = `${user.id}/${kind}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("catalog-images").upload(path, file, {
    cacheControl: "31536000",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from("catalog-images").getPublicUrl(path).data.publicUrl;
}
