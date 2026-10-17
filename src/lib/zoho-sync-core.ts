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
 * Checks Zoho's X-Zoho-Webhook-Signature: an HMAC-SHA256 of the raw request body keyed with the
 * webhook's Secret. Accepts hex or base64 encoding of the digest (both carry the same secret).
 * Returns which encoding matched, or null when the signature is missing or wrong.
 */
export async function verifyZohoSignature(rawBody: string, signature: string | null | undefined, secret: string) {
  const provided = (signature ?? "").trim();
  if (!provided || !secret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
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

/** One JSON log line per sync event, for Vercel logs. Never pass tokens or customer details. */
export function zohoLogLine(event: string, fields: Record<string, string | number | boolean | null | undefined>) {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    clean[key] = typeof value === "string" ? value.slice(0, 300) : value;
  }
  return JSON.stringify({ source: "zoho-sync", event, at: new Date().toISOString(), ...clean });
}
