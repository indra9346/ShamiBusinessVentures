/*
 * Which godown serves an order and what a product costs and has in stock there. These mirror the
 * database (place_marketplace_order, branch_product_price) so screens show what an order will
 * really be charged. Kept free of app imports so the node tests can load it.
 */
import type { Branch, BranchState } from "./branches";

export const defaultBranchOf = (branches: Branch[]) => branches.find((branch) => branch.isDefault && branch.active) ?? branches.find((branch) => branch.active && !branch.vendorId) ?? null;

/** The godown serving a PIN code: one that lists it, else the default godown. */
export function branchForPin(branches: Branch[], pin: string | null | undefined) {
  const active = branches.filter((branch) => branch.active && !branch.vendorId);
  const clean = (pin ?? "").replace(/\D/g, "");
  return (clean ? active.find((branch) => branch.servesPincodes.includes(clean)) : undefined) ?? defaultBranchOf(branches);
}

export const branchStockOf = (state: Pick<BranchState, "stock">, productId: string, branchId: string) => state.stock.get(productId)?.get(branchId) ?? 0;

/**
 * The price a product sells at in a godown (same rule as the database's branch_product_price):
 * a godown linked to a Zoho price list sells only its listed items at their prices; any other
 * godown sells every item at the base price. Null = not sold at that godown.
 */
export function godownPriceOf(state: Pick<BranchState, "prices">, branch: Branch | null, productId: string, basePrice: number) {
  if (!branch || !branch.zohoPricebookId) return basePrice > 0 ? basePrice : null;
  const entry = state.prices.get(productId)?.get(branch.id);
  return entry && entry.listed && entry.price > 0 ? entry.price : null;
}

/** The godown an order shipping to this PIN belongs to: by PIN when PIN matching is on, else the default. */
export function orderGodownFor(state: Pick<BranchState, "branches" | "features">, pin: string | null | undefined) {
  return state.features.branchRouting ? branchForPin(state.branches, pin) : defaultBranchOf(state.branches);
}

/**
 * The price and stock an order from that godown gets for a product, as the database charges it:
 * with PIN matching on, the godown's price and stock; otherwise the product's own. A null price
 * means the godown does not sell it.
 */
export function godownOfferOf(
  state: Pick<BranchState, "prices" | "stock" | "features">,
  branch: Branch | null,
  product: { id: string; price: number; stock: number },
): { price: number | null; stock: number } {
  if (!state.features.branchRouting) return { price: product.price > 0 ? product.price : null, stock: product.stock };
  return {
    price: godownPriceOf(state, branch, product.id, product.price),
    stock: branch ? branchStockOf(state, product.id, branch.id) : 0,
  };
}

/** The Zoho location an order's sales order sits in: its godown's Zoho location, else Zoho's primary one. */
export function zohoLocationLabel(branch: Pick<Branch, "zohoLocationId" | "zohoLocationName" | "name"> | null | undefined) {
  if (!branch?.zohoLocationId) return "the primary Zoho location";
  return `the Zoho location "${branch.zohoLocationName || branch.name}"`;
}
