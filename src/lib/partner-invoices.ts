/*
 * A channel partner's customer invoices (/partner). The database hands over only the orders of the partner's godown
 * placed while they ran it (partner_invoice_orders / partner_invoice_order, migration 20261110200000), with the
 * fields a customer copy prints: no cost, vendor or commission. These helpers turn that into the same Order the
 * customer's own invoice is built from, so both copies come out identical. No app imports: the node tests load it.
 */
import type { Order, OrderStatus } from "./data.ts";
import { invoicePayments, type InvoiceFacts, type InvoicePaymentRow, type ZohoInvoiceCopy } from "./invoice-lines.ts";
import { customerInvoiceVisible, invoiceStage, type InvoiceStage } from "./invoice-visibility.ts";

/** One row of the partner's invoice list. */
export type PartnerInvoiceRow = {
  order_no: string;
  placed_at: string;
  order_status: string;
  payment_status: string;
  customer_name: string;
  total: number;
  gst_amount: number;
  invoice_number: string | null;
};

/** What partner_invoice_order returns for one order. */
export type PartnerInvoiceData = {
  order: Record<string, unknown>;
  items: Record<string, unknown>[];
  zoho: ZohoInvoiceCopy | null;
  payments: InvoicePaymentRow[];
};

const STATUSES: OrderStatus[] = ["Placed", "Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered", "Cancelled"];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Paid in full: the payment half of partnerInvoiceVisible below, which the list uses. */
export const invoiceReady = (paymentStatus: string) => paymentStatus.trim().toLowerCase() === "paid";

/** The payment status as the site shows it (the customer's account uses the same words). */
export function paymentLabel(paymentStatus: string): Order["payment"] {
  const status = paymentStatus.trim().toLowerCase();
  return status === "paid" ? "Paid" : status.includes("partial") ? "Partially Paid" : status === "refunded" ? "Refunded" : status === "failed" ? "Failed" : "Pending";
}

/**
 * The partner opens an order's invoice exactly when its customer can: paid in full and confirmed by the office, never
 * cancelled or refunded (customerInvoiceVisible, the rule the customer's own pages use).
 */
export const partnerInvoiceVisible = (row: Pick<PartnerInvoiceRow, "order_status" | "payment_status">) =>
  customerInvoiceVisible({ orderStatus: row.order_status, payment: paymentLabel(row.payment_status) });

/** Where a row's invoice stands, for the words beside a row that cannot be opened yet. */
export const partnerInvoiceStage = (row: Pick<PartnerInvoiceRow, "order_status" | "payment_status">): InvoiceStage =>
  invoiceStage({ orderStatus: row.order_status, payment: paymentLabel(row.payment_status) });

/** The rows of the list, with numbers as numbers (Postgres numerics come back as text). */
export function partnerInvoiceRows(rows: unknown): PartnerInvoiceRow[] {
  return (Array.isArray(rows) ? rows : []).map((value) => {
    const row = record(value);
    return {
      order_no: str(row["order_no"]), placed_at: str(row["placed_at"]), order_status: str(row["order_status"]),
      payment_status: str(row["payment_status"]), customer_name: str(row["customer_name"]),
      total: num(row["total"]), gst_amount: num(row["gst_amount"]),
      invoice_number: str(row["invoice_number"]).trim() || null,
    };
  }).filter((row) => row.order_no);
}

/** The order (customer copy) and the facts the invoice prints, from partner_invoice_order. */
export function partnerInvoiceOrder(data: unknown): { order: Order; facts: InvoiceFacts } {
  const raw = record(data);
  const o = record(raw["order"]);
  const address = record(o["shipping_address"]);
  const payments = (Array.isArray(raw["payments"]) ? raw["payments"] : []).map((value) => {
    const row = record(value);
    return { amount: num(row["amount"]), method: str(row["method"]) || null, status: str(row["status"]) || null, txn_ref: str(row["txn_ref"]) || null, created_at: str(row["created_at"]) };
  });
  const latest = [...payments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const items = (Array.isArray(raw["items"]) ? raw["items"] : []).map((value) => {
    const item = record(value);
    const price = num(item["unit_price"]);
    return {
      product: {
        id: str(item["product_id"]), name: str(item["product_name"]), sku: str(item["sku"]), brand: "", vendor: "", vendorId: "",
        category: "", subcategory: "", image: "", mrp: price, price, gst: num(item["gst_rate"]), rating: 0, reviews: 0, stock: 0,
        reserved: 0, sold: 0, weight: str(item["weight"]), status: "approved" as const, active: true, tags: [], description: "", specs: [], created: "", updated: "",
        // The catalogue's HSN and unit, so the copy matches the customer's even where the page has no catalogue loaded.
        ...(str(item["hsn"]) ? { hsn: str(item["hsn"]) } : {}),
        ...(str(item["unit"]) ? { unit: str(item["unit"]) } : {}),
      },
      qty: num(item["qty"]), vendor: "", vendorId: "", capacity: str(item["capacity"]), unitPrice: price,
      gstRate: num(item["gst_rate"]), dbItemId: str(item["id"]), couponShare: num(item["coupon_share"]),
    };
  });
  const createdAt = str(o["created_at"]);
  const placed = new Date(createdAt);
  const shippingMethod = str(o["shipping_method"]);
  const status = str(o["order_status"]) as OrderStatus;
  const paid = num(o["paid_amount"]);
  const order: Order = {
    id: str(o["order_no"]),
    date: Number.isNaN(placed.getTime()) ? createdAt : placed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
    createdAt,
    customer: str(o["customer_name"]), customerId: "", email: str(o["customer_email"]), phone: str(o["customer_phone"]),
    ...(str(o["customer_gstin"]) ? { gstin: str(o["customer_gstin"]) } : {}),
    ...(str(o["business_legal_name"]) ? { businessName: str(o["business_legal_name"]) } : {}),
    ...(o["is_b2b"] === true ? { isB2b: true } : {}),
    items,
    subtotal: num(o["subtotal"]), discount: num(o["discount"]), tax: num(o["gst_amount"]), shipping: num(o["shipping"]), amount: num(o["total"]),
    payment: paymentLabel(str(o["payment_status"])),
    ...(paid ? { paidAmount: paid } : {}),
    method: str(o["payment_method"]), txn: latest?.txn_ref ?? "",
    ...(latest?.txn_ref ? { utr: latest.txn_ref } : {}),
    status: STATUSES.includes(status) ? status : "Placed",
    address: str(address["line"]), city: str(address["city"]), state: str(address["state"]), pin: str(address["pin"]),
    delivery: shippingMethod === "Pickup" ? "Pickup from godown" : shippingMethod === "Express" ? "Express Freight — next business day" : "Standard Freight — 2 to 4 days",
    ...(str(o["branch_id"]) ? { branchId: str(o["branch_id"]) } : {}),
    ...(str(o["coupon"]) ? { coupon: str(o["coupon"]) } : {}),
    pricesIncludeGst: o["prices_include_gst"] === true,
  };
  const zoho = record(raw["zoho"]);
  return {
    order,
    facts: {
      zoho: raw["zoho"] ? { invoice_number: str(zoho["invoice_number"]) || null, status: str(zoho["status"]) || null, invoice_date: str(zoho["invoice_date"]) || null } : null,
      payments: invoicePayments(payments),
      paid,
    },
  };
}
