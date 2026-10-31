/*
 * Search engine and link-preview tags for the public pages, in one place: one brand (Grain Bazar,
 * run by Shami Business Ventures Pvt. Ltd.), one address (https://grainbazar.com, so www and
 * non-www are not counted as two sites), share images, and Google structured data (JSON-LD).
 * Pure, so the node tests can load it.
 */

export const SITE_URL = "https://grainbazar.com";
export const SITE_NAME = "Grain Bazar";
export const LEGAL_NAME = "Shami Business Ventures Pvt. Ltd.";
export const DEFAULT_IMAGE = "/grainbazar-logo.png";
export const DEFAULT_DESCRIPTION =
  "Buy rice, sugar and cooking oil online from Grain Bazar by Shami Business Ventures: bags and tins at godown prices from Challakere and Hubli, Karnataka, with GST invoices and pickup or delivery.";

/** The full address of a path or image on the site (absolute links pass through). */
export function absoluteUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${SITE_URL}${path === "/" ? "" : path}` || SITE_URL;
}

/** Search snippets are cut near 155-160 characters: keep descriptions within that. */
export function clip(text: string, max = 158) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : cut.length).replace(/[,.;:\s]+$/, "")}…`;
}

export type PageSeo = {
  title: string;
  description: string;
  /** The page's own path, e.g. "/shop" (query strings are left out of the canonical link). */
  path: string;
  image?: string;
  type?: "website" | "product" | "article";
  /** Private or thin pages: kept out of search results (links are still followed). */
  noindex?: boolean;
};

/** The head tags for a public page: title, description, canonical link, Open Graph and Twitter. */
export function pageHead({ title, description, path, image = DEFAULT_IMAGE, type = "website", noindex = false }: PageSeo) {
  const url = absoluteUrl(path.split(/[?#]/)[0] || "/");
  const desc = clip(description);
  const img = absoluteUrl(image);
  return {
    meta: [
      { title },
      { name: "description", content: desc },
      ...(noindex ? [{ name: "robots", content: "noindex, follow" }] : []),
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:locale", content: "en_IN" },
      { property: "og:type", content: type },
      { property: "og:title", content: title },
      { property: "og:description", content: desc },
      { property: "og:url", content: url },
      { property: "og:image", content: img },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: desc },
      { name: "twitter:image", content: img },
    ],
    links: noindex ? [] : [{ rel: "canonical", href: url }],
  };
}

/** A JSON-LD script for head().scripts. "<" is escaped so text can never close the script tag. */
export function jsonLdScript(data: unknown) {
  return { type: "application/ld+json", children: JSON.stringify(data).replace(/</g, "\\u003c") };
}

/** The business behind the store (shown in Google's knowledge panel and rich results). */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    legalName: LEGAL_NAME,
    url: SITE_URL,
    logo: absoluteUrl(DEFAULT_IMAGE),
  };
}

/** The site, with its search box (Google can show it under the result). */
export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${SITE_URL}/shop?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export type ProductForSeo = {
  id: string;
  name: string;
  description?: string;
  image?: string;
  sku?: string;
  brand?: string;
  category?: string;
  price: number;
  mrp?: number;
  stock?: number;
  rating?: number;
  reviews?: number;
  /** Where the godowns deliver (Google's merchant listing "shippingDetails"). */
  deliveryAreas?: DeliveryArea[];
};

/** A godown that delivers: its fee, the order value above which delivery is free, and the PIN codes it serves. */
export type DeliveryArea = { fee: number; freeAbove: number | null; postalCodes: string[] };

/**
 * Delivery areas from the godown rows (branches): active godowns with delivery switched on and the
 * PIN codes they serve. Pickup-only godowns don't ship, so they are left out.
 */
export function deliveryAreasForSeo(branches: Record<string, unknown>[]): DeliveryArea[] {
  return branches
    .filter((b) => b["active"] === true && b["delivery_enabled"] === true && !b["vendor_id"] && Array.isArray(b["serves_pincodes"]))
    .map((b) => ({
      fee: Math.max(0, Number(b["delivery_fee"]) || 0),
      freeAbove: b["free_delivery_above"] === null || b["free_delivery_above"] === undefined ? null : Number(b["free_delivery_above"]),
      postalCodes: [...new Set((b["serves_pincodes"] as unknown[]).map(String).filter((pin) => /^\d{6}$/.test(pin)))].sort(),
    }))
    .filter((area) => area.postalCodes.length > 0);
}

/** Average (one decimal) and count of a product's published review ratings, or null when it has none. */
export function ratingSummary(ratings: { product_id: string; rating: number }[], productId: string) {
  const mine = ratings.filter((row) => row.product_id === productId && row.rating >= 1 && row.rating <= 5);
  if (!mine.length) return null;
  return { rating: Math.round((mine.reduce((sum, row) => sum + row.rating, 0) / mine.length) * 10) / 10, reviews: mine.length };
}

/** Product rich result: name, image, SKU, brand, real ratings and the INR offer with stock and delivery. */
export function productJsonLd(p: ProductForSeo) {
  const price = Math.round(p.price * 100) / 100;
  const offer = {
    "@type": "Offer",
    url: absoluteUrl(`/product/${encodeURIComponent(p.id)}`),
    priceCurrency: "INR",
    price: price.toFixed(2),
    availability: (p.stock ?? 1) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@type": "Organization", name: SITE_NAME },
    ...(p.deliveryAreas?.length
      ? {
          shippingDetails: p.deliveryAreas.map((area) => ({
            "@type": "OfferShippingDetails",
            shippingRate: { "@type": "MonetaryAmount", value: area.freeAbove !== null && price >= area.freeAbove ? 0 : area.fee, currency: "INR" },
            shippingDestination: { "@type": "DefinedRegion", addressCountry: "IN", postalCode: area.postalCodes },
          })),
        }
      : {}),
  };
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    ...(p.description ? { description: clip(p.description, 500) } : {}),
    ...(p.image ? { image: [absoluteUrl(p.image)] } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.brand ? { brand: { "@type": "Brand", name: p.brand } } : {}),
    ...(p.category ? { category: p.category } : {}),
    // Only real ratings: Google penalises made-up review counts.
    ...(p.rating && p.reviews && p.reviews > 0
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: p.rating, reviewCount: p.reviews } }
      : {}),
    offers: offer,
  };
}

/** Breadcrumb trail, e.g. Home › Sugar › S1 Refined Sugar 50kg Bag. */
export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export type SitemapEntry = { path: string; lastmod?: string; changefreq?: "daily" | "weekly" | "monthly"; priority?: number };

const xmlEscape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** sitemap.xml for the given pages (duplicates dropped, dates as YYYY-MM-DD). */
export function sitemapXml(entries: SitemapEntry[]) {
  const seen = new Set<string>();
  const urls = entries.filter((e) => {
    const url = absoluteUrl(e.path);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  }).map((e) => [
    "  <url>",
    `    <loc>${xmlEscape(absoluteUrl(e.path))}</loc>`,
    ...(e.lastmod && !Number.isNaN(Date.parse(e.lastmod)) ? [`    <lastmod>${new Date(e.lastmod).toISOString().slice(0, 10)}</lastmod>`] : []),
    ...(e.changefreq ? [`    <changefreq>${e.changefreq}</changefreq>`] : []),
    ...(e.priority !== undefined ? [`    <priority>${e.priority.toFixed(1)}</priority>`] : []),
    "  </url>",
  ].join("\n"));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
