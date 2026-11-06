/**
 * A brand-new item made in Zoho comes to the website hidden, for an admin to check and switch on.
 * No "@/" imports, so the tests can load this file directly.
 */

/** Items made before this stay out: they were left off the website on purpose. */
export const ZOHO_ITEM_IMPORT_FROM = "2026-11-04T00:00:00+05:30";

type ZohoItem = Record<string, unknown>;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

const amount = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Why this Zoho item can't be sold on the website, or null when it can. The same checks apply to new
 * items coming in by themselves and to an older item an admin brings in by hand.
 */
export function zohoItemSaleProblem(item: ZohoItem) {
  if (text(item["item_id"]) === "" || text(item["name"]) === "") return "Zoho sent this item without a name";
  if (text(item["status"]).toLowerCase() !== "active") return "Inactive in Zoho: switch it on in Zoho first";
  if (item["can_be_sold"] === false) return "Zoho marks this item as not for sale";
  if (text(item["product_type"]).toLowerCase() === "service") return "A service, not goods: it can't be sold on the website";
  if ((amount(item["rate"]) ?? -1) < 0) return "Zoho has no selling price for this item";
  return null;
}

/** Whether this Zoho item should come to the website by itself. Anything already linked is checked by the caller. */
export function zohoItemImportable(item: ZohoItem) {
  const created = Date.parse(text(item["created_time"]));
  return zohoItemSaleProblem(item) === null
    && Number.isFinite(created)
    && created >= Date.parse(ZOHO_ITEM_IMPORT_FROM);
}

/** A Zoho item with no website product, as the admin's "Zoho items not on the website" list shows it. */
export type ZohoItemNotOnWebsite = {
  itemId: string;
  name: string;
  sku: string;
  rate: number;
  unit: string;
  active: boolean;
  stock: number | null;
  createdAt: string;
  /** Why it can't be brought in now, or null when it can. */
  problem: string | null;
};

/**
 * Zoho items that have no website product (no zoho_item_links row), active ones first. An item whose SKU a
 * website product already uses can't come in: two products on one SKU would push different stock to it.
 */
export function zohoItemsNotOnWebsite(items: ZohoItem[], linkedItemIds: ReadonlySet<string>, websiteSkus: ReadonlySet<string>): ZohoItemNotOnWebsite[] {
  return items
    .filter((item) => text(item["item_id"]) !== "" && !linkedItemIds.has(text(item["item_id"])))
    .map((item) => {
      const sku = text(item["sku"]);
      const problem = zohoItemSaleProblem(item) ?? (sku && websiteSkus.has(sku.toLowerCase()) ? "A website product already uses this SKU" : null);
      return {
        itemId: text(item["item_id"]),
        name: text(item["name"]),
        sku,
        rate: amount(item["rate"]) ?? 0,
        unit: text(item["unit"]),
        active: text(item["status"]).toLowerCase() === "active",
        stock: amount(item["available_stock"]) ?? amount(item["stock_on_hand"]),
        createdAt: text(item["created_time"]),
        problem,
      };
    })
    .sort((a, b) => Number(a.problem !== null) - Number(b.problem !== null) || a.name.localeCompare(b.name, "en"));
}

/** The GST the item carries within the state, which is what the website adds to its price. */
export function zohoItemGstPercent(item: ZohoItem) {
  const preferences = Array.isArray(item["item_tax_preferences"]) ? (item["item_tax_preferences"] as ZohoItem[]) : [];
  const intra = preferences.find((preference) => text(preference["tax_specification"]).toLowerCase() === "intra");
  return amount(intra?.["tax_percentage"]) ?? amount(item["tax_percentage"]) ?? 0;
}

/** Zoho's SKU, or one in the website's own style, because the website can't sync an item without one. */
export function zohoItemSku(item: ZohoItem, category: string) {
  const own = text(item["sku"]);
  if (own) return own;
  const code = category === "Uncategorized" ? "GN" : (category.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "GN");
  return `SBV-${code.padEnd(2, "X")}-${text(item["item_id"]).slice(-8)}`;
}

const dateLabel = (when: Date) =>
  when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** The website product for a new Zoho item. "pending" keeps it hidden whatever Zoho says about the item. */
export function zohoItemAsHiddenProduct(item: ZohoItem, vendorId: string, vendorName: string, now = new Date()) {
  const itemId = text(item["item_id"]);
  const id = `ZI-${itemId}`;
  const category = text(item["category_name"]) || "Uncategorized";
  const price = amount(item["rate"]) ?? 0;
  const mrp = amount(item["label_rate"]) ?? 0;
  const stock = amount(item["available_for_sale_stock"]) ?? amount(item["available_stock"]) ?? 0;
  const purchasePrice = amount(item["purchase_rate"]);
  const minimumStock = amount(item["reorder_level"]);
  return {
    id,
    vendor_id: vendorId,
    category,
    status: "pending" as const,
    active: false,
    payload: {
      id,
      zohoImported: true,
      name: text(item["name"]),
      sku: zohoItemSku(item, category),
      brand: text(item["brand"]),
      manufacturer: text(item["manufacturer"]),
      vendor: vendorName,
      vendorId,
      category,
      subcategory: "",
      image: "",
      mrp: mrp > 0 ? mrp : price,
      price,
      gst: zohoItemGstPercent(item),
      rating: 0,
      reviews: 0,
      stock: Math.max(0, stock),
      minimumStock: minimumStock ?? 0,
      warehouseStock: Math.max(0, stock),
      requiredStock: 0,
      reserved: 0,
      sold: 0,
      weight: "",
      unit: text(item["unit"]),
      hsn: text(item["hsn_or_sac"]),
      status: "pending",
      active: false,
      tags: [],
      description: text(item["description"]),
      specs: [],
      created: dateLabel(now),
      updated: dateLabel(now),
      ...(purchasePrice !== null ? { purchasePrice } : {}),
    },
  };
}

/** An imported item still waiting for an admin: nothing on the website may change it in Zoho yet. */
export function awaitingImportApproval(status: unknown, payload: unknown) {
  return status === "pending" && !!payload && typeof payload === "object"
    && (payload as Record<string, unknown>)["zohoImported"] === true;
}
