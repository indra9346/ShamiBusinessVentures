import { supabase } from "@/integrations/supabase/client";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export async function uploadCatalogImage(file: File, kind: "products" | "categories" | "profiles"): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
  if (file.size > MAX_IMAGE_SIZE) throw new Error("Image must be 5 MB or smaller");
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Sign in before uploading an image");

  const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "image";
  const path = `${user.id}/${kind}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("catalog-images").upload(path, file, {
    cacheControl: "31536000",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from("catalog-images").getPublicUrl(path).data.publicUrl;
}
