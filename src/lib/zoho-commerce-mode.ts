/**
 * Whether the business still pays for Zoho Commerce. Grain Bazar's own shop, checkout, payments and
 * invoices never need it; only a few Zoho steps talk to Zoho Commerce (its order copy, product page
 * text and MRP, its product and coupon list, its webhooks). Admin > Zoho turns it off before the
 * subscription ends, so those steps stop and the rest goes on through Zoho Inventory and Zoho Books.
 *
 * Stored in `settings` (not public). No row means "in use": how the site worked before this switch.
 */
export const ZOHO_COMMERCE_SETTING_KEY = "zoho_commerce";

export type ZohoCommerceMode = { inUse: boolean; changedAt: string | null };

export function zohoCommerceModeFrom(value: unknown): ZohoCommerceMode {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    // Only an explicit "off" turns it off: a missing or damaged value keeps today's behaviour.
    inUse: row["inUse"] !== false,
    changedAt: typeof row["changedAt"] === "string" ? row["changedAt"] : null,
  };
}

/** Zoho Commerce permissions, asked for only while Zoho Commerce is in use. */
export const ZOHO_COMMERCE_SCOPES = [
  "ZohoCommerce.items.READ", "ZohoCommerce.items.CREATE", "ZohoCommerce.items.UPDATE",
  "ZohoCommerce.coupons.READ", "ZohoCommerce.coupons.CREATE", "ZohoCommerce.coupons.UPDATE",
  "ZohoCommerce.salesorders.READ", "ZohoCommerce.salesorders.CREATE", "ZohoCommerce.salesorders.UPDATE",
  "ZohoCommerce.settings.READ", "ZohoCommerce.settings.UPDATE", "ZohoCommerce.sitesIndex.READ",
  "ZohoCommerce.webhooks.READ", "ZohoCommerce.webhooks.CREATE",
] as const;

/** Zoho Inventory and Zoho Books permissions, always asked for. */
export const ZOHO_CORE_SCOPES = [
  "ZohoInventory.contacts.READ", "ZohoInventory.contacts.CREATE", "ZohoInventory.contacts.UPDATE",
  "ZohoInventory.items.READ", "ZohoInventory.items.CREATE", "ZohoInventory.items.UPDATE",
  "ZohoInventory.salesorders.READ", "ZohoInventory.salesorders.CREATE", "ZohoInventory.salesorders.UPDATE",
  "ZohoInventory.inventoryadjustments.READ", "ZohoInventory.inventoryadjustments.CREATE",
  "ZohoInventory.settings.READ", "ZohoInventory.settings.UPDATE",
  "ZohoBooks.salesorders.CREATE", "ZohoBooks.invoices.READ", "ZohoBooks.invoices.CREATE",
  "ZohoBooks.customerpayments.READ", "ZohoBooks.customerpayments.CREATE", "ZohoBooks.customerpayments.DELETE",
  "ZohoInventory.packages.READ", "ZohoInventory.packages.CREATE",
  "ZohoInventory.shipmentorders.READ", "ZohoInventory.shipmentorders.CREATE", "ZohoInventory.shipmentorders.UPDATE",
  "ZohoInventory.purchaseorders.READ", "ZohoInventory.purchaseorders.CREATE", "ZohoInventory.bills.READ",
  "ZohoBooks.invoices.UPDATE", "ZohoBooks.banking.READ",
  // A sales order's own address, written through Zoho Books once Zoho Commerce is off
  // (Zoho Inventory has no address call for one sales order).
  "ZohoBooks.salesorders.UPDATE",
  // Moving stock between godowns: a bill unloaded at another godown, a batch sent to other godowns (10 Nov 2026).
  "ZohoInventory.transferorders.READ", "ZohoInventory.transferorders.CREATE", "ZohoInventory.transferorders.UPDATE",
  // Batch expenses (14 Nov 2026): freight, hamali and other Zoho Books expenses tagged to batches, read only.
  "ZohoBooks.expenses.READ",
] as const;

/** The permission list for "Connect / Reauthorize Zoho". */
export function zohoOAuthScopes(commerceInUse: boolean) {
  return [...(commerceInUse ? ZOHO_COMMERCE_SCOPES : []), ...ZOHO_CORE_SCOPES].join(",");
}

/** Shown when a step that only Zoho Commerce has is asked for while it is turned off. */
export const ZOHO_COMMERCE_OFF_MESSAGE = "Zoho Commerce is turned off in Admin > Zoho Commerce, so this step is not available";
