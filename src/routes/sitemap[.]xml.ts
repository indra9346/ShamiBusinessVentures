import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sitemapXml, type SitemapEntry } from "@/lib/seo";

/*
 * /sitemap.xml for search engines: the public pages, every enabled category and every product
 * shoppers can see (approved, switched on, not a Zoho copy), read live so new products appear
 * on their own. Private pages (account, admin, checkout) are never listed.
 */
const STATIC_PAGES: SitemapEntry[] = [
  { path: "/", changefreq: "daily", priority: 1 },
  { path: "/shop", changefreq: "daily", priority: 0.9 },
  { path: "/categories", changefreq: "weekly", priority: 0.8 },
  { path: "/about", changefreq: "monthly", priority: 0.5 },
  { path: "/contact", changefreq: "monthly", priority: 0.5 },
];

const categorySlug = (name: string) => (name.toLowerCase() === "cooking oil" ? "oil" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries: SitemapEntry[] = [...STATIC_PAGES];
        const url = process.env["SUPABASE_URL"];
        const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
        if (url && key) {
          const db = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
          const [categories, products] = await Promise.all([
            db.from("store_categories").select("name,payload"),
            db.from("catalog_products").select("id,status,active,vendor_id,updated_at")
              .eq("status", "approved").eq("active", true).not("vendor_id", "like", "zoho:%"),
          ]);
          for (const row of categories.data ?? []) {
            if ((row.payload as { enabled?: boolean } | null)?.enabled === false) continue;
            entries.push({ path: `/categories/${categorySlug(row.name)}`, changefreq: "daily", priority: 0.8 });
          }
          for (const row of products.data ?? [])
            entries.push({ path: `/product/${encodeURIComponent(row.id)}`, lastmod: row.updated_at, changefreq: "daily", priority: 0.7 });
        }
        return new Response(sitemapXml(entries), {
          headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
        });
      },
    },
  },
});
