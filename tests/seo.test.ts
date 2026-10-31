import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteUrl, breadcrumbJsonLd, clip, deliveryAreasForSeo, jsonLdScript, pageHead, productJsonLd, ratingSummary, sitemapXml } from "../src/lib/seo.ts";

test("one canonical address for every page", () => {
  assert.equal(absoluteUrl("/"), "https://grainbazar.com");
  assert.equal(absoluteUrl("/shop"), "https://grainbazar.com/shop");
  assert.equal(absoluteUrl("categories/rice"), "https://grainbazar.com/categories/rice");
  assert.equal(absoluteUrl("https://cdn.example/x.png"), "https://cdn.example/x.png");
});

test("descriptions fit search snippets", () => {
  assert.equal(clip("short"), "short");
  const long = clip("word ".repeat(80));
  assert.ok(long.length <= 158 && long.endsWith("…"));
});

test("page head: title, description, canonical, Open Graph and Twitter; noindex pages get no canonical", () => {
  const head = pageHead({ title: "Shop | Grain Bazar", description: "Buy rice.", path: "/shop?q=rice" });
  const meta = Object.fromEntries(head.meta.map((m) => ["title" in m ? "title" : ("name" in m ? m.name : m.property), "title" in m ? m.title : m.content]));
  assert.equal(meta["title"], "Shop | Grain Bazar");
  assert.equal(meta["og:url"], "https://grainbazar.com/shop");
  assert.equal(meta["og:image"], "https://grainbazar.com/grainbazar-logo.png");
  assert.equal(meta["og:site_name"], "Grain Bazar");
  assert.equal(meta["twitter:site"], undefined); // no leftover @Lovable
  assert.deepEqual(head.links, [{ rel: "canonical", href: "https://grainbazar.com/shop" }]);
  const hidden = pageHead({ title: "Cart", description: "x", path: "/cart", noindex: true });
  assert.ok(hidden.meta.some((m) => "name" in m && m.name === "robots" && m.content === "noindex, follow"));
  assert.deepEqual(hidden.links, []);
});

test("product structured data: INR offer, stock, real ratings only", () => {
  const data = productJsonLd({ id: "P009", name: "Grade A Raw Rice 25kg", price: 1499, stock: 12, sku: "SBV-RI-1008", brand: "Shami Select", image: "/products/rice.jpg", rating: 4.5, reviews: 0 });
  assert.equal(data.offers.price, "1499.00");
  assert.equal(data.offers.priceCurrency, "INR");
  assert.equal(data.offers.availability, "https://schema.org/InStock");
  assert.deepEqual(data.image, ["https://grainbazar.com/products/rice.jpg"]);
  assert.equal("aggregateRating" in data, false); // 0 reviews: no rating claimed
  assert.equal(productJsonLd({ id: "x", name: "x", price: 1, stock: 0 }).offers.availability, "https://schema.org/OutOfStock");
  // Text can never break out of the script tag.
  assert.ok(!jsonLdScript({ name: "</script><b>" }).children.includes("</script>"));
});

test("merchant listing shipping: delivering godowns' PIN codes and fee; pickup-only godowns don't ship", () => {
  const areas = deliveryAreasForSeo([
    { id: "BR-HBL", active: true, delivery_enabled: true, vendor_id: null, delivery_fee: 0, free_delivery_above: null, serves_pincodes: ["580021", "580020", "580020", "bad"] },
    { id: "BR-CLK", active: true, delivery_enabled: false, vendor_id: null, delivery_fee: 0, free_delivery_above: null, serves_pincodes: ["577522"] },
    { id: "BR-X", active: true, delivery_enabled: true, vendor_id: null, delivery_fee: 150, free_delivery_above: 5000, serves_pincodes: ["560001"] },
    { id: "BR-OFF", active: false, delivery_enabled: true, vendor_id: null, delivery_fee: 0, free_delivery_above: null, serves_pincodes: ["560002"] },
    { id: "V-1", active: true, delivery_enabled: true, vendor_id: "VENDOR-001", delivery_fee: 0, free_delivery_above: null, serves_pincodes: ["560003"] },
    { id: "BR-NOPIN", active: true, delivery_enabled: true, vendor_id: null, delivery_fee: 0, free_delivery_above: null, serves_pincodes: [] },
  ]);
  assert.deepEqual(areas, [
    { fee: 0, freeAbove: null, postalCodes: ["580020", "580021"] },
    { fee: 150, freeAbove: 5000, postalCodes: ["560001"] },
  ]);
  const cheap = productJsonLd({ id: "P1", name: "Oil", price: 2151.45, stock: 5, deliveryAreas: areas }).offers;
  assert.deepEqual(cheap.shippingDetails, [
    { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: 0, currency: "INR" },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "IN", postalCode: ["580020", "580021"] } },
    { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: 150, currency: "INR" },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "IN", postalCode: ["560001"] } },
  ]);
  // At or above the free-delivery value the fee is 0.
  const dear = productJsonLd({ id: "P2", name: "Sugar", price: 5000, deliveryAreas: areas }).offers;
  assert.equal(dear.shippingDetails?.[1]?.shippingRate.value, 0);
  assert.equal("shippingDetails" in productJsonLd({ id: "P3", name: "x", price: 1 }).offers, false);
});

test("Google rating comes only from published reviews", () => {
  const ratings = [{ product_id: "P1", rating: 5 }, { product_id: "P1", rating: 4 }, { product_id: "P1", rating: 4 }, { product_id: "P2", rating: 3 }, { product_id: "P1", rating: 9 }];
  assert.deepEqual(ratingSummary(ratings, "P1"), { rating: 4.3, reviews: 3 });
  assert.equal(ratingSummary(ratings, "P9"), null);
  const rated = productJsonLd({ id: "P1", name: "Rice", price: 100, ...ratingSummary(ratings, "P1")! });
  assert.deepEqual(rated.aggregateRating, { "@type": "AggregateRating", ratingValue: 4.3, reviewCount: 3 });
});

test("breadcrumbs and sitemap", () => {
  const crumbs = breadcrumbJsonLd([{ name: "Home", path: "/" }, { name: "Sugar", path: "/categories/sugar" }]);
  assert.equal(crumbs.itemListElement[1]!.item, "https://grainbazar.com/categories/sugar");
  const xml = sitemapXml([
    { path: "/", changefreq: "daily", priority: 1 },
    { path: "/product/P&1", lastmod: "2026-10-27T10:00:00Z" },
    { path: "/" },
  ]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<url>/g) ?? []).length, 2);
  assert.match(xml, /<loc>https:\/\/grainbazar.com\/product\/P&amp;1<\/loc>\s*<lastmod>2026-10-27<\/lastmod>/);
  assert.match(xml, /<priority>1.0<\/priority>/);
});
