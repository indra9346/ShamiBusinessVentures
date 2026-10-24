/**
 * Pure helpers for the Grain Bazar -> Zoho order sync: the sales-order number, retry policy,
 * webhook key check, reconciliation and log lines. No network, no database, no secrets, so they
 * are unit-tested directly (`npm run test:zoho`).
 */

/** Zoho sales-order number for a Grain Bazar order. It is unique in Zoho, which is what makes pushes idempotent. */
export function zohoOrderNumber(orderNo: string | number) {
  return `GB-${String(orderNo).replace(/[^A-Za-z0-9-]/g, "-").slice(-40)}`;
}

export type HttpMethod = "GET" | "POST" | "PUT";

/**
 * Whether a failed Zoho call may be sent again.
 * - 429 (throttled): Zoho did not process it, so any method may retry.
 * - 5xx / network error: only GET and PUT, which are safe to repeat. A POST may already have been
 *   applied; creating a sales order is instead made safe by looking up its unique number first.
 */
export function shouldRetryZohoCall(method: HttpMethod, status: number | "network") {
  if (status === 429) return true;
  if (method === "POST") return false;
  return status === "network" || (status >= 500 && status <= 599);
}

/** Wait before retry number `retry` (1-based): Retry-After when Zoho sends one, else 1s, 2s, 4s... capped. */
export function zohoRetryDelayMs(retry: number, retryAfterHeader: string | null, capMs = 10_000) {
  const header = Number(retryAfterHeader);
  if (retryAfterHeader && Number.isFinite(header) && header >= 0) return Math.min(capMs, Math.max(1000, header * 1000));
  return Math.min(capMs, 1000 * 2 ** Math.max(0, retry - 1));
}

/** Constant-time comparison of the webhook key. */
export function webhookKeyMatches(provided: string | null | undefined, expected: string) {
  const a = provided ?? "";
  if (!expected || a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The string Zoho Books signs (Help > Webhooks > "Validate Webhooks"): every query-string and
 * x-www-form-urlencoded key-value pair, sorted by key and joined as key+value with no separators,
 * followed by the raw JSON body for Default Payload / Raw webhooks. Form payloads are decoded first.
 */
export function zohoSignatureBaseString(query: Array<[string, string]>, rawBody: string, contentType: string | null | undefined) {
  const pairs: Array<[string, string]> = [...query];
  let json = "";
  if (contentType && /x-www-form-urlencoded/i.test(contentType)) {
    for (const [key, value] of new URLSearchParams(rawBody)) pairs.push([key, value]);
  } else {
    json = rawBody;
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([key, value]) => key + value).join("") + json;
}

/**
 * Checks Zoho's X-Zoho-Webhook-Signature: HMAC-SHA256 of zohoSignatureBaseString keyed with the
 * webhook's secret token. Zoho's sample code compares base64; live deliveries to this site carried
 * hex, so both encodings of the same digest are accepted. Returns which matched, or null.
 */
export async function verifyZohoSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
  request: { query?: Array<[string, string]>; contentType?: string | null } = {},
) {
  const provided = (signature ?? "").trim();
  if (!provided || !secret) return null;
  const signed = zohoSignatureBaseString(request.query ?? [], rawBody, request.contentType ?? "application/json");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const base64 = btoa(String.fromCharCode(...digest));
  if (webhookKeyMatches(provided.toLowerCase(), hex)) return "hex";
  if (webhookKeyMatches(provided, base64)) return "base64";
  return null;
}

export type GbOrderForReconcile = {
  order_no: string;
  order_status: string;
  total: number;
  zoho_salesorder_id: string | null;
  created_at: string;
};
export type ZohoOrderForReconcile = {
  salesorder_id: string;
  salesorder_number: string;
  status: string;
  total: number;
};
export type ReconcileIssue =
  | "missing_in_zoho"
  | "linked_but_not_listed"
  | "link_mismatch"
  | "duplicate_in_zoho"
  | "total_mismatch"
  | "status_mismatch"
  | "zoho_without_grain_bazar_order";
export type ReconcileRow = { orderNo: string; issue: ReconcileIssue; detail: string; zohoId?: string };

const ZOHO_CLOSED = new Set(["void", "cancelled"]);
const TOTAL_TOLERANCE = 2;

/**
 * Compares Grain Bazar orders with the Zoho sales orders fetched for the same period.
 * Read-only: it reports differences and changes nothing.
 */
export function reconcileOrders(gbOrders: GbOrderForReconcile[], zohoOrders: ZohoOrderForReconcile[]) {
  const byNumber = new Map<string, ZohoOrderForReconcile[]>();
  for (const zoho of zohoOrders) {
    if (!zoho.salesorder_number.startsWith("GB-")) continue;
    const list = byNumber.get(zoho.salesorder_number) ?? [];
    list.push(zoho);
    byNumber.set(zoho.salesorder_number, list);
  }
  const issues: ReconcileRow[] = [];
  let inSync = 0;
  const seen = new Set<string>();
  for (const order of gbOrders) {
    const number = zohoOrderNumber(order.order_no);
    seen.add(number);
    const matches = byNumber.get(number) ?? [];
    if (matches.length > 1) {
      issues.push({ orderNo: order.order_no, issue: "duplicate_in_zoho", detail: `${matches.length} Zoho sales orders use ${number}` });
      continue;
    }
    const zoho = matches[0];
    if (!zoho) {
      issues.push(order.zoho_salesorder_id
        ? { orderNo: order.order_no, issue: "linked_but_not_listed", detail: `Linked to Zoho ID ${order.zoho_salesorder_id}, but ${number} was not in the Zoho orders fetched; open it in Zoho to confirm`, zohoId: order.zoho_salesorder_id }
        : { orderNo: order.order_no, issue: "missing_in_zoho", detail: `No Zoho sales order ${number}; it has not been pushed yet` });
      continue;
    }
    if (order.zoho_salesorder_id && order.zoho_salesorder_id !== zoho.salesorder_id) {
      issues.push({ orderNo: order.order_no, issue: "link_mismatch", detail: `Grain Bazar points to Zoho ID ${order.zoho_salesorder_id}, but ${number} is Zoho ID ${zoho.salesorder_id}`, zohoId: zoho.salesorder_id });
      continue;
    }
    const zohoClosed = ZOHO_CLOSED.has(zoho.status.toLowerCase());
    const gbCancelled = order.order_status === "Cancelled";
    if (zohoClosed !== gbCancelled) {
      issues.push({ orderNo: order.order_no, issue: "status_mismatch", detail: `Grain Bazar is ${order.order_status}; Zoho is ${zoho.status}`, zohoId: zoho.salesorder_id });
      continue;
    }
    if (!gbCancelled && Math.abs(Number(zoho.total) - Number(order.total)) > TOTAL_TOLERANCE) {
      issues.push({ orderNo: order.order_no, issue: "total_mismatch", detail: `Grain Bazar ₹${Number(order.total).toFixed(2)}; Zoho ₹${Number(zoho.total).toFixed(2)}`, zohoId: zoho.salesorder_id });
      continue;
    }
    if (!order.zoho_salesorder_id) {
      // Exists in Zoho but the ID was never stored; the next push records it (no duplicate is created).
      issues.push({ orderNo: order.order_no, issue: "missing_in_zoho", detail: `${number} exists in Zoho (ID ${zoho.salesorder_id}) but is not linked yet; "Push" links it without creating another`, zohoId: zoho.salesorder_id });
      continue;
    }
    inSync += 1;
  }
  for (const [number, list] of byNumber) {
    if (!seen.has(number))
      issues.push({ orderNo: number, issue: "zoho_without_grain_bazar_order", detail: `Zoho has ${number}, but no Grain Bazar order in this period matches it`, zohoId: list[0]?.salesorder_id ?? "" });
  }
  return { checked: gbOrders.length, inSync, issues };
}

export type AppProductForParity = { id: string; name: string; sku: string; price: number | null; stock: number | null; active: boolean };
export type ZohoItemForParity = { item_id: string; sku: string; name: string; rate: number | null; available: number | null; status: string };
export type CatalogIssue = "duplicate_sku" | "not_linked" | "missing_in_zoho" | "sku_mismatch" | "price_mismatch" | "stock_mismatch" | "inactive_in_zoho";
export type CatalogRow = { productId: string; name: string; issue: CatalogIssue; detail: string; zohoId?: string };

/**
 * Products: Grain Bazar catalogue vs the linked Zoho items. Grain Bazar is the stock master, so
 * Zoho's available-for-sale should equal the app stock. Read-only; reports differences only.
 * `zohoItems` holds the items fetched (available = null where it was not read).
 */
export function reconcileCatalog(
  products: AppProductForParity[],
  links: Map<string, string>,
  zohoItems: ZohoItemForParity[],
) {
  const byId = new Map(zohoItems.map((item) => [item.item_id, item]));
  const linkedIds = new Set(links.values());
  const issues: CatalogRow[] = [];
  let inSync = 0;
  let inactiveUnlinked = 0;
  // Two Grain Bazar products with one SKU would both write to the same Zoho item.
  const skuCount = new Map<string, number>();
  for (const product of products) {
    const sku = product.sku.trim().toLowerCase();
    if (sku) skuCount.set(sku, (skuCount.get(sku) ?? 0) + 1);
  }
  for (const product of products) {
    const sharedBy = skuCount.get(product.sku.trim().toLowerCase()) ?? 0;
    if (sharedBy > 1) {
      issues.push({ productId: product.id, name: product.name, issue: "duplicate_sku", detail: `SKU ${product.sku} is used by ${sharedBy} Grain Bazar products; keep one` });
      continue;
    }
    const zohoId = links.get(product.id);
    if (!zohoId) {
      // Inactive products are never pushed to Zoho, so no link is expected for them.
      if (!product.active) { inactiveUnlinked += 1; continue; }
      issues.push({ productId: product.id, name: product.name, issue: "not_linked", detail: `SKU ${product.sku || "-"} has no Zoho item link yet` });
      continue;
    }
    const zoho = byId.get(zohoId);
    if (!zoho) {
      issues.push({ productId: product.id, name: product.name, issue: "missing_in_zoho", detail: `Linked Zoho item ${zohoId} was not found in Zoho`, zohoId });
      continue;
    }
    const before = issues.length;
    if (product.sku.trim().toLowerCase() !== zoho.sku.trim().toLowerCase())
      issues.push({ productId: product.id, name: product.name, issue: "sku_mismatch", detail: `Grain Bazar SKU ${product.sku || "-"}; Zoho SKU ${zoho.sku || "-"}`, zohoId });
    if (product.price !== null && zoho.rate !== null && Math.abs(product.price - zoho.rate) > 0.01)
      issues.push({ productId: product.id, name: product.name, issue: "price_mismatch", detail: `Grain Bazar \u20b9${product.price.toFixed(2)}; Zoho \u20b9${zoho.rate.toFixed(2)}`, zohoId });
    if (product.stock !== null && zoho.available !== null && Math.abs(product.stock - zoho.available) > 0.0005)
      issues.push({ productId: product.id, name: product.name, issue: "stock_mismatch", detail: `Grain Bazar stock ${product.stock}; Zoho available for sale ${zoho.available}`, zohoId });
    if (product.active && zoho.status.toLowerCase() === "inactive")
      issues.push({ productId: product.id, name: product.name, issue: "inactive_in_zoho", detail: "Active in Grain Bazar but inactive in Zoho", zohoId });
    if (issues.length === before) inSync += 1;
  }
  const zohoOnly = zohoItems.filter((item) => !linkedIds.has(item.item_id)).length;
  return { checked: products.length, inSync, issues, zohoOnly, inactiveUnlinked };
}

export type CustomerForParity = { id: string; name: string; hasOrders: boolean };
export type CustomerRow = { userId: string; name: string; issue: "not_linked_with_orders" | "contact_missing_in_zoho"; detail: string };

/**
 * Customers: Grain Bazar customer accounts vs their linked Zoho contacts. A customer without a
 * link is only a problem once they have ordered (contacts are created on the first order).
 * Pass `zohoContactIds` = null when Zoho's contact list could not be read completely.
 */
export function reconcileCustomers(
  customers: CustomerForParity[],
  links: Map<string, string>,
  zohoContactIds: Set<string> | null,
) {
  const issues: CustomerRow[] = [];
  let linked = 0;
  let notLinkedNoOrders = 0;
  for (const customer of customers) {
    const contactId = links.get(customer.id);
    if (!contactId) {
      if (customer.hasOrders) issues.push({ userId: customer.id, name: customer.name, issue: "not_linked_with_orders", detail: "Has orders but no linked Zoho contact" });
      else notLinkedNoOrders += 1;
      continue;
    }
    linked += 1;
    if (zohoContactIds && !zohoContactIds.has(contactId))
      issues.push({ userId: customer.id, name: customer.name, issue: "contact_missing_in_zoho", detail: `Linked Zoho contact ${contactId} was not found among Zoho contacts` });
  }
  return { checked: customers.length, linked, notLinkedNoOrders, issues };
}

/** Only well-formed, de-duplicated email addresses (at most `max`). */
export function cleanEmailList(values: string[], max = 5) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const email = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= max) break;
  }
  return out;
}

/** Subject and body for Zoho Books "Email a sales order" when a website order reaches Zoho. */
export function newOrderEmail(order: { number: string; customer: string; total: number; delivery: string }) {
  return {
    subject: `New Grain Bazar order ${order.number}`,
    body: [
      `A new Grain Bazar website order has been created in Zoho: ${order.number}.`,
      `Customer: ${order.customer || "-"}`,
      `Total: \u20b9${order.total.toFixed(2)}`,
      `Fulfilment: ${order.delivery || "-"}`,
      "Open the sales order in Zoho to confirm and process it.",
    ].join("<br>"),
  };
}

/** One JSON log line per sync event, for Vercel logs. Never pass tokens or customer details. */
export function zohoLogLine(event: string, fields: Record<string, string | number | boolean | null | undefined>) {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 300) : value;
  }
  return JSON.stringify({ source: "zoho-sync", event, at: new Date().toISOString(), ...clean });
}

/**
 * Whether a seller's products are kept in step with Zoho items. An empty list (setting not
 * saved yet) keeps every seller's products, as before the setting existed.
 */
export function zohoItemSyncAllows(vendorIds: string[], vendorId: string) {
  return vendorIds.length === 0 || vendorIds.includes(vendorId);
}

/** Reads the `zoho_item_sync_vendor_ids` setting value: a list of seller IDs, anything else = none. */
export function parseZohoItemSyncVendorIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
}

/* ------------------------------------------------------------------------- */
/* Godown catalogue (Zoho-primary): price lists and stock per Zoho location.  */
/* ------------------------------------------------------------------------- */

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A Zoho price list as godown prices: {productId: price}. "per_item" lists price only the items
 * they contain; "fixed_percentage" lists mark every linked item up or down from its base price.
 * Items not linked to a Grain Bazar product, and non-positive prices, are left out.
 */
export function godownPricesFromPricebook(
  pricebook: Record<string, unknown>,
  productByZohoItem: Map<string, string>,
  basePriceByProduct: Map<string, number>,
) {
  const prices: Record<string, number> = {};
  const type = String(pricebook["pricebook_type"] ?? "per_item");
  if (type === "fixed_percentage") {
    const percentage = finite(pricebook["percentage"]) ?? 0;
    const factor = pricebook["is_increase"] === false ? 1 - percentage / 100 : 1 + percentage / 100;
    for (const productId of new Set(productByZohoItem.values())) {
      const base = basePriceByProduct.get(productId);
      if (base && base > 0 && factor > 0) prices[productId] = Math.round(base * factor * 100) / 100;
    }
    return prices;
  }
  const items = Array.isArray(pricebook["pricebook_items"]) ? (pricebook["pricebook_items"] as Record<string, unknown>[]) : [];
  for (const item of items) {
    const productId = productByZohoItem.get(String(item["item_id"] ?? ""));
    const rate = finite(item["pricebook_rate"]);
    if (productId && rate !== null && rate > 0) prices[productId] = Math.round(rate * 100) / 100;
  }
  return prices;
}

/**
 * A godown's sellable stock from its Zoho location: Zoho's available stock there, less website
 * orders Zoho does not hold yet (no sales order, or a draft). Never below zero; null when the
 * item has no entry for that location.
 */
export function godownStockFromZohoItem(item: Record<string, unknown>, zohoLocationId: string, pendingQty = 0) {
  const locations = Array.isArray(item["locations"]) ? (item["locations"] as Record<string, unknown>[]) : [];
  const location = locations.find((entry) => String(entry["location_id"] ?? "") === zohoLocationId);
  if (!location) return null;
  const available = finite(location["location_available_stock"]) ?? finite(location["location_stock_on_hand"]);
  if (available === null) return null;
  return Math.max(0, Math.round((available - Math.max(0, pendingQty)) * 100) / 100);
}

export type GodownPriceRow = { product_id: string; price: number | string; listed: boolean; pending: boolean };

/** Zoho's godown prices with website edits still waiting for Zoho applied on top (they win). */
export function mergeGodownPrices(zohoPrices: Record<string, number>, rows: GodownPriceRow[]) {
  const merged: Record<string, number> = { ...zohoPrices };
  for (const row of rows) {
    if (!row.pending) continue;
    const price = Number(row.price);
    if (row.listed && Number.isFinite(price) && price > 0) merged[row.product_id] = Math.round(price * 100) / 100;
    else delete merged[row.product_id];
  }
  return merged;
}

export function sameGodownPrices(a: Record<string, number>, b: Record<string, number>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/**
 * The full item list to send back to a Zoho per-item price list: Zoho's own entries are kept as
 * they are (items not on the website, volume brackets), linked items take the merged price, items
 * dropped on the website are removed, and newly listed items are added.
 */
export function zohoPricebookItemsFor(
  originalItems: Record<string, unknown>[],
  merged: Record<string, number>,
  productByZohoItem: Map<string, string>,
  zohoItemByProduct: Map<string, string>,
) {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const original of originalItems) {
    const itemId = String(original["item_id"] ?? "");
    if (!itemId) continue;
    const productId = productByZohoItem.get(itemId);
    const keep: Record<string, unknown> = { item_id: itemId, pricebook_rate: original["pricebook_rate"] };
    for (const key of ["pricebook_item_id", "pricing_scheme", "price_brackets", "pricebook_discount"]) {
      if (original[key] !== undefined && original[key] !== null && original[key] !== "") keep[key] = original[key];
    }
    if (!productId) { out.push(keep); continue; }
    seen.add(productId);
    if (productId in merged) out.push({ ...keep, pricebook_rate: merged[productId] });
  }
  for (const [productId, rate] of Object.entries(merged)) {
    if (seen.has(productId)) continue;
    const itemId = zohoItemByProduct.get(productId);
    if (itemId) out.push({ item_id: itemId, pricebook_rate: rate });
  }
  return out;
}

export type OrderForPending = {
  branch_id: string | null;
  order_status: string;
  zoho_salesorder_id: string | null;
  zoho_order_status: string | null;
  created_at: string;
  items: { product_id: string | null; qty: number }[];
};

/**
 * Website orders at each godown whose stock Zoho does not hold yet: not cancelled, with no Zoho
 * sales order or only a draft one. Only orders placed after Zoho became the stock master count;
 * earlier orders were already taken off Zoho's stock by the website's stock corrections.
 * Returns branch id -> product id -> quantity.
 */
export function pendingOrderQty(orders: OrderForPending[], since: string, defaultBranchId: string) {
  const cutoff = Date.parse(since);
  const out = new Map<string, Map<string, number>>();
  for (const order of orders) {
    if (order.order_status === "Cancelled") continue;
    if (!Number.isFinite(cutoff) || Date.parse(order.created_at) < cutoff) continue;
    const zohoStatus = (order.zoho_order_status ?? "").toLowerCase();
    if (order.zoho_salesorder_id && zohoStatus !== "" && zohoStatus !== "draft") continue;
    const branchId = order.branch_id || defaultBranchId;
    const byProduct = out.get(branchId) ?? new Map<string, number>();
    for (const item of order.items) {
      if (!item.product_id) continue;
      byProduct.set(item.product_id, (byProduct.get(item.product_id) ?? 0) + (Number(item.qty) || 0));
    }
    out.set(branchId, byProduct);
  }
  return out;
}
