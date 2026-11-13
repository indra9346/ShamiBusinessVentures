/*
 * A channel partner confirms their own godown's orders and gets the invoice (owner, 13 Nov 2026: "Channel partner need
 * option to confirm the order & get invoice also").
 *
 * The confirm is the admin's "Mark as Confirmed" (the order moves to Accepted, with the same Zoho invoice, notifications
 * and fulfilment updates), done by the database in partner_confirm_order (migration 20261113230000), which checks
 * everything again. Money stays with the office: a partner confirms only an order whose payment the office (or the bank
 * alert) has already settled in full. A checkout waiting for payment, a part-paid, refunded, cancelled or Zoho-void order
 * is never the partner's to confirm. These helpers only decide what the partner's page offers and says, in the same order
 * as the database's checks. No app imports: the node tests load it.
 */
import { paymentLabel, partnerInvoiceVisible } from "./partner-invoices.ts";
import { INVOICE_STAGE_WORDS, invoiceStage } from "./invoice-visibility.ts";

/** The statuses a partner confirms from, and the one the order then has (as the admin's "Mark as Confirmed"). */
export const PARTNER_CONFIRM_FROM = ["Placed", "Payment Confirmed"] as const;
export const PARTNER_CONFIRM_TO = "Accepted";
/** Already confirmed or further along: a second press changes nothing. */
export const CONFIRMED_STATUSES = ["Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"] as const;

export type PartnerConfirmState = "ready" | "confirmed" | "needs_payment" | "refunded" | "void_in_zoho" | "checkout" | "closed";

export type PartnerConfirmInput = { orderStatus: string; paymentStatus: string; zohoVoid?: boolean };

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
const isIn = (list: readonly string[], value: string) => list.some((item) => item.toLowerCase() === norm(value));

/** Whether the partner may confirm the order now, or why not (the database's checks, in its order). */
export function partnerConfirmState({ orderStatus, paymentStatus, zohoVoid = false }: PartnerConfirmInput): PartnerConfirmState {
  if (isIn(CONFIRMED_STATUSES, orderStatus)) return "confirmed";
  if (norm(orderStatus) === "cancelled") return "closed";
  if (isIn(["Awaiting Payment", "Payment Expired"], orderStatus)) return "checkout";
  if (!isIn(PARTNER_CONFIRM_FROM, orderStatus)) return "closed";
  if (zohoVoid) return "void_in_zoho";
  if (norm(paymentStatus) === "refunded") return "refunded";
  return norm(paymentStatus) === "paid" ? "ready" : "needs_payment";
}

/** What the partner's list says beside each order. */
export const PARTNER_CONFIRM_WORDS: Record<PartnerConfirmState, string> = {
  ready: "Paid in full. Confirm the order when you accept it.",
  confirmed: "Confirmed",
  needs_payment: "Waiting for the full payment. Only our office confirms payments; then you can confirm it here.",
  refunded: "The payment was refunded, so it cannot be confirmed.",
  void_in_zoho: "Void in Zoho. Our office decides what happens to it.",
  checkout: "Not paid yet. Our office confirms the payment first.",
  closed: "Cancelled. Nothing to confirm.",
};

/** One row of partner_orders_to_confirm. */
export type PartnerOrderRow = {
  order_no: string;
  placed_at: string;
  order_status: string;
  payment_status: string;
  payment_method: string;
  shipping_method: string;
  total: number;
  paid_amount: number;
  customer: string;
  items: string;
  zoho_void: boolean;
  invoice_number: string | null;
  invoice_mine: boolean;
  confirmed_at: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** The rows, with numbers as numbers (Postgres numerics come back as text). */
export function partnerOrderRows(rows: unknown): PartnerOrderRow[] {
  return (Array.isArray(rows) ? rows : []).map((value) => {
    const row = record(value);
    return {
      order_no: str(row["order_no"]), placed_at: str(row["placed_at"]), order_status: str(row["order_status"]),
      payment_status: str(row["payment_status"]), payment_method: str(row["payment_method"]), shipping_method: str(row["shipping_method"]),
      total: num(row["total"]), paid_amount: num(row["paid_amount"]), customer: str(row["customer"]) || "Customer", items: str(row["items"]),
      zoho_void: row["zoho_void"] === true, invoice_number: str(row["invoice_number"]).trim() || null,
      invoice_mine: row["invoice_mine"] === true, confirmed_at: str(row["confirmed_at"]) || null,
    };
  }).filter((row) => row.order_no);
}

/** The state of one listed order. */
export const rowConfirmState = (row: Pick<PartnerOrderRow, "order_status" | "payment_status" | "zoho_void">) =>
  partnerConfirmState({ orderStatus: row.order_status, paymentStatus: row.payment_status, zohoVoid: row.zoho_void });

/**
 * The invoice of a listed order, for the partner: whether it opens here, and the words beside it. It opens exactly when
 * the customer's does (paid in full and confirmed: partnerInvoiceVisible) and partner_invoice_order lets this partner
 * open it (orders placed while they ran the godown). Until Zoho Books has given the tax invoice its number, the same
 * copy opens as a proforma.
 */
export function partnerOrderInvoice(row: Pick<PartnerOrderRow, "order_status" | "payment_status" | "invoice_number" | "invoice_mine">): { open: boolean; words: string } {
  if (!partnerInvoiceVisible(row)) {
    const stage = invoiceStage({ orderStatus: row.order_status, payment: paymentLabel(row.payment_status) });
    if (stage === "awaiting_confirmation") return { open: false, words: "Invoice is made when the order is confirmed." };
    if (stage === "awaiting_payment") return { open: false, words: "Invoice is made after the full payment and the confirmation." };
    return { open: false, words: INVOICE_STAGE_WORDS[stage] };
  }
  if (!row.invoice_mine) return { open: false, words: "Placed before you ran this godown: ask our office for this invoice." };
  return row.invoice_number
    ? { open: true, words: `Invoice ${row.invoice_number}` }
    : { open: true, words: "Zoho is making the tax invoice. Until then this opens as a proforma; refresh in a minute." };
}

/** The question asked before a confirm. */
export const confirmQuestion = (orderNo: string) =>
  `Confirm order ${orderNo}? The customer and our office are told, and the order's tax invoice is made in Zoho.`;
