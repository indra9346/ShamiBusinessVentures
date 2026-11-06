/*
 * One rule for the products an admin can choose for a godown. Commission rates, a product's godown
 * prices, the pricing lot form and the staff app's godown stock list all use it, so no screen quietly
 * leaves a product out. Every website product is offered, hidden ones too, so a rate or a price can be
 * ready before the product goes on the shop, and each one says where it stands. Zoho Commerce copies
 * (vendor "zoho:…") are read-only mirrors, not products, so they are never offered.
 * No "@/" imports, so the node tests can load this file directly.
 */

export type GodownProductFields = {
  id: string;
  name: string;
  vendorId?: string | null;
  status?: string | null;
  active?: boolean | null;
};

/** A godown as far as this rule needs it: one linked to a Zoho price list sells only that list's items. */
export type GodownForProducts = { id: string; zohoPricebookId?: string | null } | null | undefined;

/** Godown prices by product, then by godown (the shape useBranches() gives). */
export type GodownPriceBook = ReadonlyMap<string, ReadonlyMap<string, { price: number; listed: boolean }>>;

/** Where a product stands on the shop. Only "on_shop" can be bought (same rule as the storefront). */
export type ShopState = "on_shop" | "hidden" | "pending" | "rejected";

export const isZohoCopy = (product: Pick<GodownProductFields, "vendorId">) => (product.vendorId ?? "").startsWith("zoho:");

/** Approved and switched on is on the shop; anything not approved is waiting for approval or rejected. */
export function shopState(product: Pick<GodownProductFields, "status" | "active">): ShopState {
  if (product.status === "rejected") return "rejected";
  if (product.status !== "approved") return "pending";
  return product.active === false ? "hidden" : "on_shop";
}

/**
 * Whether the godown lists the product: a godown with no Zoho price list sells every item; one with a
 * price list sells only its listed items with a price (same rule as godownPriceOf and the database).
 */
export function onGodownPriceList(productId: string, godown: GodownForProducts, prices?: GodownPriceBook) {
  if (!godown || !godown.zohoPricebookId) return true;
  const entry = prices?.get(productId)?.get(godown.id);
  return !!entry && entry.listed && entry.price > 0;
}

export type GodownProductOption<T extends GodownProductFields> = {
  product: T;
  state: ShopState;
  onPriceList: boolean;
  /** On the shop and sold at this godown: the only products a customer of this godown can buy. */
  soldHere: boolean;
};

const STATE_ORDER: Record<ShopState, number> = { on_shop: 0, pending: 1, hidden: 2, rejected: 3 };

/** Every website product for this godown, what it can buy first, then by name. */
export function godownProductOptions<T extends GodownProductFields>(
  products: readonly T[],
  godown?: GodownForProducts,
  prices?: GodownPriceBook,
): GodownProductOption<T>[] {
  return products
    .filter((product) => !isZohoCopy(product))
    .map((product) => {
      const state = shopState(product);
      const onPriceList = onGodownPriceList(product.id, godown, prices);
      return { product, state, onPriceList, soldHere: state === "on_shop" && onPriceList };
    })
    .sort((a, b) => Number(b.soldHere) - Number(a.soldHere)
      || STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || a.product.name.localeCompare(b.product.name, "en"));
}

/** The English headings products are listed under (screens translate them with t()). */
export const GODOWN_PRODUCT_GROUPS = {
  soldHere: "On the shop",
  notOnList: "On the shop, not on this godown's price list",
  pending: "Waiting for approval (hidden on the shop)",
  hidden: "Hidden on the shop",
  rejected: "Rejected (hidden on the shop)",
} as const;

export function godownProductGroup(option: Pick<GodownProductOption<GodownProductFields>, "state" | "onPriceList">) {
  if (option.state === "on_shop") return option.onPriceList ? GODOWN_PRODUCT_GROUPS.soldHere : GODOWN_PRODUCT_GROUPS.notOnList;
  return GODOWN_PRODUCT_GROUPS[option.state];
}

/** The options under their headings, in a fixed order, leaving out empty headings. */
export function groupGodownProducts<T extends GodownProductFields>(options: readonly GodownProductOption<T>[]) {
  const groups = Object.values(GODOWN_PRODUCT_GROUPS).map((label) => ({ label, options: [] as GodownProductOption<T>[] }));
  for (const option of options) groups.find((group) => group.label === godownProductGroup(option))!.options.push(option);
  return groups.filter((group) => group.options.length > 0);
}

/** A short tag for a product that can't be bought at this godown, or null when it can. */
export function godownProductTag(option: Pick<GodownProductOption<GodownProductFields>, "state" | "onPriceList">) {
  if (option.state === "pending") return "Waiting for approval";
  if (option.state === "rejected") return "Rejected";
  if (option.state === "hidden") return "Hidden on the shop";
  return option.onPriceList ? null : "Not on this godown's price list";
}

/**
 * Why a saved commission rate earns nothing at this godown, or null when it can: commission is earned
 * only on order lines, and only a product on the shop and sold at the godown can be ordered there.
 */
export function godownRateWarning(
  productId: string | null | undefined,
  products: readonly GodownProductFields[],
  godown?: GodownForProducts,
  prices?: GodownPriceBook,
) {
  if (!productId) return null;
  const product = products.find((item) => item.id === productId);
  if (!product || isZohoCopy(product)) return "This product is no longer on the website: this rate earns nothing.";
  if (shopState(product) !== "on_shop") return "Hidden on the shop: this rate earns nothing until the product is switched on.";
  if (!onGodownPriceList(product.id, godown, prices)) return "Not on this godown's price list: this rate earns nothing until the product is sold here.";
  return null;
}

/** What a product's own page says above its godown prices when it can't be bought anywhere yet. */
export function godownPricesNote(product: Pick<GodownProductFields, "status" | "active">) {
  const state = shopState(product);
  if (state === "on_shop") return null;
  if (state === "rejected") return "Rejected, so hidden on the shop. Prices saved here are used only if it is approved and switched on.";
  if (state === "pending") return "Waiting for approval, so hidden on the shop. Prices saved here are used once it is switched on.";
  return "Hidden on the shop. Prices saved here are used once it is switched on.";
}
