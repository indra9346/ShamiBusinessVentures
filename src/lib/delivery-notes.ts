/*
 * Delivery notes and per-item delivery slips (client's handwritten rules, 2 Nov 2026). What the
 * screens and the paper say. Kept free of app imports so the node tests can load it.
 *
 * The decision itself is made in the database, by private.delivery_note_gate
 * (supabase/migrations/20261103090000_delivery_notes.sql). Nothing here can allow a note: these
 * functions only put the database's answer into words.
 */
import type { DeliveryHandoverRow, DeliveryPaperRow, DeliveryReopenRow, DeliveryScanRow, PaperHandover, PaperPrint } from "./delivery-papers.ts";

export type DeliveryGateCode =
  | "paid" | "unpaid" | "partly_paid" | "payment_mismatch" | "website_behind" | "zoho_has_payment" | "zoho_behind"
  | "no_invoice" | "invoice_draft" | "zoho_unreadable" | "several_invoices" | "zoho_inconsistent" | "totals_differ"
  | "zoho_not_money" | "invoice_used" | "records_disagree" | "utr_reused" | "bank_credit_short" | "stopped"
  | "refunded" | "return_refunded" | "cancelled" | "payment_expired" | "not_confirmed" | "no_items" | "not_found";

/** What the database answered. Amounts are rupees. */
export type DeliveryGate = {
  allowed: boolean;
  code: DeliveryGateCode;
  website?: "full" | "partly" | "unpaid" | "broken";
  order_no?: string;
  order_status?: string;
  payment_status?: string;
  order_total?: number;
  paid?: number;
  receipts?: number;
  balance?: number;
  overpaid?: number;
  bank_short?: number;
  other_order_no?: string | null;
  stopped?: boolean;
  stop_reason?: string | null;
  /** zoho_now: read a moment ago. last_reading: what the website last knew, which shows a state but cannot generate. */
  source?: "zoho_now" | "last_reading";
  zoho_read?: boolean;
  zoho_error?: string;
  live_invoices?: number;
  invoice_id?: string;
  invoice_number?: string;
  invoice_status?: string;
  invoice_total?: number | null;
  invoice_balance?: number | null;
  invoice_payment_made?: number | null;
  /** Only with a note: what has happened since it was generated. */
  note_no?: string | null;
  items_changed?: boolean;
  invoice_changed?: boolean;
};

export type DeliveryNoteLine = {
  line: number;
  order_item_id: string;
  product_id: string;
  name: string;
  sku: string;
  qty: number;
  pack_size: string;
  stock_no: string;
  /** The order line's own capacity, kept to tell later whether the order itself changed. */
  capacity?: string;
};

/** The paper's content, fixed when the note was generated. */
export type DeliveryNoteSnapshot = {
  order_placed_at: string;
  shipping_method: string;
  customer: { name: string; phone: string; business_name: string; gstin: string };
  address: { name?: string; phone?: string; line?: string; city?: string; state?: string; pin?: string };
  godown: { name?: string; code?: string; address?: string; city?: string; state?: string; pincode?: string; phone?: string; gstin?: string };
  company: Record<string, string | number | boolean | null>;
  items: DeliveryNoteLine[];
};

export type DeliveryNote = {
  id: string;
  seq: number;
  note_no: string;
  order_no: string;
  invoice_number: string;
  invoice_total: number;
  order_total: number;
  paid_amount: number;
  snapshot: DeliveryNoteSnapshot;
  generated_at: string;
  generated_by_name: string;
};

export type DeliveryNoteEvent = {
  id: number;
  kind: "generated" | "printed" | "order_changed" | "invoice_changed" | "payment_problem" | "stop_changed";
  doc: "note" | "slip" | null;
  slip_line: number | null;
  copy_no: number | null;
  gate_code: string | null;
  detail: string;
  actor_name: string;
  occurred_at: string;
};

export type DeliveryNoteView = {
  checkedAt: string;
  /** True when Zoho was read for this view. */
  fresh: boolean;
  state: DeliveryGate;
  note: DeliveryNote | null;
  events: DeliveryNoteEvent[];
  /**
   * Item lines handed over at the godown on a QR scan (every round), administrators' reopenings, the printed papers
   * (original, duplicate or replacement, by print) and the scans of this note's papers, newest first.
   */
  handovers: DeliveryHandoverRow[];
  reopens: DeliveryReopenRow[];
  papers: DeliveryPaperRow[];
  scans: DeliveryScanRow[];
  /** False while the database lacks the QR migration: the note shows, but printing is refused. */
  qrReady: boolean;
};

export type DeliveryPrintRecord = {
  printedAt: string;
  noteCopy: number | null;
  slipCopies: Record<string, number>;
  /** This press's QR codes, given once: only their hashes are kept. */
  noteCode: string | null;
  slipCodes: Record<string, string>;
  /** What each printed paper is (original, duplicate n, replacement original), for its label. */
  notePaper: PaperPrint | null;
  slipPapers: Record<string, PaperPrint>;
  /** Lines already handed over, by line number. */
  handovers: Record<string, PaperHandover>;
};

export type DeliveryRegisterRow = {
  seq: number;
  note_no: string;
  order_no: string;
  invoice_number: string;
  customer: string;
  godown: string;
  items: number;
  generated_at: string;
  generated_by: string;
  prints: number;
  last_printed_at: string | null;
  /** Item lines handed over now on a QR scan, items an administrator reopened, and scans that were refused. */
  handed_over: number;
  last_handed_over_at: string | null;
  reopened: number;
  refused_scans: number;
  state: DeliveryGate;
};

/** ₹1,23,456.00: rupees and paise, Indian grouping. */
const money = (value: number | null | undefined) =>
  `₹${Number(value ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Exact date and time in India, seconds included: 03 Nov 2026, 12:05:33 AM IST. */
export function istDateTime(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}:${part("second")} ${part("dayPeriod").toUpperCase()} IST`;
}

/** Copy 1 is the original; every later copy says so on the paper. */
export const copyLabel = (copy: number | null | undefined) => ((copy ?? 1) <= 1 ? "Original" : `Reprint, copy ${copy}`);
export const isReprint = (copy: number | null | undefined) => (copy ?? 1) > 1;

export type GateWords = { title: string; detail: string; tone: "ok" | "wait" | "stop" };

/** The database's answer in plain words, for the admin. */
export function gateWords(gate: DeliveryGate): GateWords {
  const invoice = gate.invoice_number || "the invoice";
  const words = (title: string, detail: string, tone: GateWords["tone"] = "stop"): GateWords => ({ title, detail, tone });
  switch (gate.code) {
    case "paid":
      return words("Paid in full", `The website and Zoho Books both show ${invoice} fully paid.`
        + (gate.overpaid ? ` ${money(gate.overpaid)} more than the order total was recorded: check whether to refund it.` : ""), "ok");
    case "unpaid":
      return words("Not paid", `Nothing has been received for this order (${money(gate.order_total)}). A delivery note can be generated only after the full invoice amount is paid.`, "wait");
    case "partly_paid":
      return words("Partly paid: do not generate", `${money(gate.paid)} paid of ${money(gate.order_total)}. ${money(gate.balance)} is still due. Ask the customer to complete the payment; the note can be generated after that.`, "wait");
    case "payment_mismatch":
      return words("Payment records differ", `The website shows ${money(gate.paid)} paid, but Zoho Books shows ${money(Number(gate.invoice_total ?? 0) - Number(gate.invoice_balance ?? 0))} paid on ${invoice}. Correct them so they match, then check again.`);
    case "website_behind":
      return words("Zoho shows paid, the website does not", `Zoho Books shows ${invoice} fully paid, but the website has only ${money(gate.paid)} of ${money(gate.order_total)}. Record the payment with its UTR in Payments & Matching, then check again.`);
    case "zoho_has_payment":
      return words("Zoho has a payment the website does not", `Zoho Books shows ${money(Number(gate.invoice_total ?? 0) - Number(gate.invoice_balance ?? 0))} paid on ${invoice}, but the website has nothing. Record the payment with its UTR in Payments & Matching, then check again.`);
    case "zoho_behind":
      return words("Zoho has not caught up", `The website shows this order fully paid, but Zoho Books still shows ${money(gate.invoice_balance)} due on ${invoice}. Press Re-sync to Zoho on this page, then check again.`);
    case "no_invoice":
      return words("No Zoho invoice yet", "The order is fully paid but has no live invoice in Zoho Books. Press Re-sync to Zoho, or approve a new invoice on this page, then check again.");
    case "invoice_draft":
      return words("Invoice still a draft", `${invoice} is still a draft in Zoho Books. Press Re-sync to Zoho on this page, then check again.`);
    case "zoho_unreadable":
      return words("Could not check Zoho", `Zoho Books could not be read just now, so the payment cannot be confirmed${gate.zoho_error ? `: ${gate.zoho_error}` : ""}. Try again in a moment.`, "wait");
    case "several_invoices":
      return words("More than one invoice", `This sales order has ${gate.live_invoices} live invoices in Zoho Books. Void the extra one in Zoho, then check again.`);
    case "zoho_inconsistent":
      return words("Zoho's figures do not add up", `Zoho Books shows ${invoice} as "${gate.invoice_status || "unknown"}" with total ${gate.invoice_total == null ? "missing" : money(gate.invoice_total)} and balance ${gate.invoice_balance == null ? "missing" : money(gate.invoice_balance)}. Check the invoice in Zoho Books.`);
    case "totals_differ":
      return words("Invoice and order totals differ", `${invoice} totals ${money(gate.invoice_total)}, the order totals ${money(gate.order_total)}. Correct the invoice in Zoho Books, then check again.`);
    case "zoho_not_money":
      return words("Zoho closed the invoice without full payment", `Zoho Books shows ${invoice} as paid, but only ${money(gate.invoice_payment_made)} of ${money(gate.invoice_total)} came in as payment. The rest is a credit note or a write-off. Check the invoice in Zoho Books.`);
    case "invoice_used":
      return words("Invoice already on another note", `${invoice} is already on another order's delivery note. Check that this order is linked to the right Zoho sales order.`);
    case "utr_reused":
      return words("Same bank transfer on another order", `A payment on this order has the same UTR as a payment on order ${gate.other_order_no}. One transfer can pay one order only. Check the bank account. If it is a mistake, the record needs correcting by your developer; there is no screen for this yet.`);
    case "bank_credit_short":
      return words("The bank shows less than was recorded", `The bank alert for a payment on this order shows ${money(gate.bank_short)} less than the amount recorded. Check the bank account. If the rest came another way, mark that alert settled in UPI & Bank Payments, with a note of what was done. If it is already marked matched, the record needs correcting by your developer.`);
    case "stopped":
      return words("Delivery stopped by the office", `${gate.stop_reason || "No reason given"}. Lift the stop on this page once it is settled.`);
    case "records_disagree":
      return words("The website's payment records do not match", `The order says ${money(gate.paid)} paid (${gate.payment_status}), but its confirmed payments add up to ${money(gate.receipts)}. These need correcting by your developer before a note can be generated; there is no screen for this yet.`);
    case "refunded":
      return words("Refunded", "The payment for this order was refunded, so it cannot be delivered.");
    case "return_refunded":
      return words("A refund on this order", "A refund on a return of this order has been started or made. Check before delivering anything on it.");
    case "cancelled":
      return words("Order cancelled", "This order is cancelled, so it cannot be delivered.");
    case "payment_expired":
      return words("Payment time ran out", "This order was not paid in time and was not placed, so it cannot be delivered.");
    case "not_confirmed":
      return words("Not confirmed yet", "This order is not confirmed yet. Confirm its full payment first.", "wait");
    case "no_items":
      return words("No items", "This order has no items to deliver.");
    case "not_found":
      return words("Order not found", "This order could not be found.");
    default:
      return words("Cannot be checked", "The payment could not be checked, so no delivery note can be generated.");
  }
}

/**
 * The warnings on the paper itself. A note exists but the check is no longer clean, so nobody should
 * release goods on it unseen. Empty means the paper prints clean.
 */
export function paperWarnings(gate: DeliveryGate): string[] {
  const warnings: string[] = [];
  switch (gate.code) {
    case "paid": break;
    case "cancelled": warnings.push("ORDER CANCELLED. DO NOT DELIVER."); break;
    case "refunded": warnings.push("PAYMENT REFUNDED. DO NOT DELIVER."); break;
    case "payment_expired": warnings.push("ORDER NOT PLACED. DO NOT DELIVER."); break;
    case "stopped": warnings.push("DELIVERY STOPPED BY THE OFFICE. DO NOT DELIVER."); break;
    case "return_refunded": warnings.push("A REFUND WAS STARTED OR MADE ON THIS ORDER. CHECK WITH THE OFFICE BEFORE DELIVERY."); break;
    case "unpaid":
    case "partly_paid": warnings.push("NOT FULLY PAID. DO NOT DELIVER."); break;
    case "zoho_unreadable": warnings.push("PAYMENT COULD NOT BE RE-CHECKED WHEN THIS WAS PRINTED. CHECK WITH THE OFFICE BEFORE DELIVERY."); break;
    default: warnings.push("PAYMENT RECORDS NEED CHECKING. CHECK WITH THE OFFICE BEFORE DELIVERY.");
  }
  if (gate.items_changed) warnings.push("ORDER ITEMS CHANGED AFTER THIS NOTE. CHECK WITH THE OFFICE BEFORE DELIVERY.");
  if (gate.invoice_changed) warnings.push(`ZOHO INVOICE CHANGED AFTER THIS NOTE (NOW ${gate.invoice_number || "ANOTHER INVOICE"}). CHECK WITH THE OFFICE BEFORE DELIVERY.`);
  return warnings;
}

export const isPickup = (snapshot: Pick<DeliveryNoteSnapshot, "shipping_method">) => snapshot.shipping_method === "Pickup";

/** An address as lines of text, leaving out what is blank. */
export function addressLines(address: { line?: string; address?: string; city?: string; state?: string; pin?: string; pincode?: string }) {
  const place = [address.city, [address.state, address.pin ?? address.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [address.line ?? address.address ?? "", place].map((line) => String(line).trim()).filter(Boolean);
}

export const deliveryMethodLabel = (method: string) =>
  (method === "Pickup" ? "Pickup from godown" : method === "Express" ? "Express delivery" : "Standard delivery");

export type SlipPage = DeliveryNoteLine & { slip: number; of: number };

/** One slip per item line: "slip x of y". */
export const slipPages = (snapshot: Pick<DeliveryNoteSnapshot, "items">): SlipPage[] =>
  [...snapshot.items].sort((a, b) => a.line - b.line).map((item, index, all) => ({ ...item, slip: index + 1, of: all.length }));

export type OrderPaymentNotice =
  | { kind: "part"; paid: number; total: number; balance: number }
  | { kind: "check" };

/**
 * What the customer's own order page says about a part payment. "part" gives the figures when the
 * records agree. "check" is for when they do not (for example a payment entered only in Zoho Books):
 * asking the customer to pay then could take the wrong amount, so they are asked to call instead.
 * A display only; the delivery note is decided in the database.
 */
export function orderPaymentNotice(order: {
  total: number; paid: number; paymentStatus: string; orderStatus: string;
  invoice?: { status: string; total: number | null; balance: number | null } | null;
}): OrderPaymentNotice | null {
  if (["Cancelled", "Payment Expired", "Awaiting Payment"].includes(order.orderStatus) || order.paymentStatus === "Refunded") return null;
  const invoice = order.invoice ?? null;
  const zohoPaid = invoice?.status === "paid" ? Number(invoice.total ?? 0)
    : invoice?.status === "partially_paid" ? Number(invoice.total ?? 0) - Number(invoice.balance ?? 0)
    : 0;
  const shows = (amount: number) => Math.abs(amount - order.paid) <= 1;
  if (order.paid >= order.total) return null;
  if (order.paid > 0) {
    if (zohoPaid > 0 && !shows(zohoPaid)) return { kind: "check" };
    return { kind: "part", paid: order.paid, total: order.total, balance: order.total - order.paid };
  }
  return zohoPaid > 0 ? { kind: "check" } : null;
}

/** The company block on the paper, from Settings as saved when the note was generated. */
export function companyHeading(company: Record<string, unknown>) {
  const text = (key: string) => (typeof company[key] === "string" ? String(company[key]).trim() : "");
  return {
    name: text("legal_name") || text("name"),
    addressLines: text("address").split("\n").map((line) => line.trim()).filter(Boolean),
    gstin: text("gstin"),
    phone: text("phone"),
  };
}
