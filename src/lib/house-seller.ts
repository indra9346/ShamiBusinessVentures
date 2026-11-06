/*
 * The shop's own seller. Shami Business Ventures sells its own products under seller code VENDOR-001; that seller is
 * the company itself, not anybody's login. The database names it from Admin > Website details (house_seller_name) and
 * lists its products without a seller login. Pure helpers, so the node tests can load them.
 */

export const HOUSE_SELLER_ID = "VENDOR-001";
export const DEFAULT_HOUSE_SELLER_NAME = "Shami Business Ventures Private Limited";

export type SellerChoice = { id: string; business: string };

/** The company's seller name: what its products already say, else the default. */
export function houseSellerName(products: readonly { vendorId: string; vendor: string }[]) {
  return products.find((product) => product.vendorId === HOUSE_SELLER_ID && product.vendor.trim())?.vendor.trim()
    || DEFAULT_HOUSE_SELLER_NAME;
}

/** Who a product can be listed under: the company first, then the vendor accounts (marketplace sellers). */
export function sellerChoices(
  vendors: readonly { id: string; business: string }[],
  products: readonly { vendorId: string; vendor: string }[],
): SellerChoice[] {
  const others = vendors
    .filter((vendor) => vendor.id && vendor.id !== HOUSE_SELLER_ID)
    .map((vendor) => ({ id: vendor.id, business: vendor.business }));
  return [{ id: HOUSE_SELLER_ID, business: houseSellerName(products) }, ...others];
}
