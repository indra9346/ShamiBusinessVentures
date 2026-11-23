// No app imports, so the tests load it directly.

/**
 * Whether the storefront shows a product's MRP and savings (owner, 19 Nov 2026: a product set to "Discounted with
 * Strikethrough" with MRP ₹50 and price ₹45 showed only ₹45, because the site-wide switch in Admin › Settings ›
 * Storefront was off). A product saved as "Discounted with Strikethrough" shows them; any other follows the site-wide
 * switch.
 */
export function showsMrpSavings(product: { pricingDisplayMode?: string | undefined }, siteWide: boolean): boolean {
  // "Direct MRP Only" never adds anything (no strike-through, no discount), so it keeps today's look either way.
  if (product.pricingDisplayMode === "strike_through") return true;
  return siteWide;
}

/** Whether a struck-through MRP is shown for a product: its mode allows it and its MRP is above the price. */
export function showsStruckMrp(product: { mrp: number; price: number; pricingDisplayMode?: string | undefined }, siteWide: boolean): boolean {
  return showsMrpSavings(product, siteWide) && product.pricingDisplayMode !== "mrp_only" && Number(product.mrp) > Number(product.price);
}
