/** Whether a product is shown on the storefront, and the one switch that shows or hides it. */
export type StorefrontFields = {
  status: "approved" | "pending" | "rejected";
  active?: boolean;
  vendorId?: string;
};

/** Read-only copies imported from Zoho Commerce (vendor "zoho:<org>") are never sold on the site. */
export const isZohoMirror = (product: Pick<StorefrontFields, "vendorId">) =>
  (product.vendorId ?? "").startsWith("zoho:");

/** Shown to shoppers only when approved, switched on, and not a Zoho mirror copy. */
export const shownOnStorefront = (product: StorefrontFields) =>
  product.status === "approved" && product.active !== false && !isZohoMirror(product);

/**
 * The change that shows or hides a product. Showing also approves it (the admin's switch is the
 * final word); hiding only switches it off, so its approval stays for when it is shown again.
 * Returns null when nothing needs to change.
 */
export function storefrontPatch(product: StorefrontFields, show: boolean): { status?: "approved"; active?: boolean } | null {
  if (show) {
    const patch: { status?: "approved"; active?: boolean } = {};
    if (product.status !== "approved") patch.status = "approved";
    if (product.active === false) patch.active = true;
    return Object.keys(patch).length ? patch : null;
  }
  return product.active === false ? null : { active: false };
}

/** Why a product is not on the storefront, or null when it is shown. */
export function hiddenReason(product: StorefrontFields): string | null {
  if (isZohoMirror(product)) return "Zoho copy";
  if (product.active === false) return "Switched off";
  if (product.status === "rejected") return "Rejected";
  if (product.status === "pending") return "Awaiting approval";
  return null;
}
