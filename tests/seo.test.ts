import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteUrl, breadcrumbJsonLd, clip, jsonLdScript, pageHead, productJsonLd, sitemapXml } from "../src/lib/seo.ts";

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
