/*
 * When a customer's invoice, and the delivery QR on it, shows (owner, 11 Nov 2026): "the invoice (with the QR) shows
 * automatically in the customer's own orders section, only after payment and the admin's confirmation". The customer's
 * order page, their Invoices page and the channel partner's invoice list all ask this one place, so they always agree.
 * It only decides what the screens offer: the database decides again whether to hand out the QR's code
 * (invoice_delivery_code checks the payment against the last reading of Zoho). Kept free of app imports so the node
 * tests can load it.
 */
import { orderTone } from "./order-status-tone.ts";

export type InvoiceVisibilityInput = { orderStatus: string | null | undefined; payment: string | null | undefined };

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/**
 * True only when the order is paid in full AND confirmed (Payment Confirmed through Delivered). Not before the admin
 * confirms it, and never for a cancelled order or a refunded payment.
 */
export function customerInvoiceVisible({ orderStatus, payment }: InvoiceVisibilityInput) {
  return norm(payment) === "paid" && orderTone(orderStatus) === "confirmed";
}

/** Where an order's invoice stands, for the words and the colour beside it. */
export type InvoiceStage = "visible" | "awaiting_payment" | "awaiting_confirmation" | "cancelled" | "refunded";

export function invoiceStage(input: InvoiceVisibilityInput): InvoiceStage {
  if (norm(input.payment) === "refunded") return "refunded";
  if (orderTone(input.orderStatus) === "closed") return "cancelled";
  if (customerInvoiceVisible(input)) return "visible";
  return norm(input.payment) === "paid" ? "awaiting_confirmation" : "awaiting_payment";
}

/** The short words for each stage, as the invoice lists show them. */
export const INVOICE_STAGE_WORDS: Record<InvoiceStage, string> = {
  visible: "Invoice ready",
  awaiting_payment: "Available after payment",
  awaiting_confirmation: "Available once the order is confirmed",
  cancelled: "No invoice: order cancelled",
  refunded: "No invoice: payment refunded",
};

/** The colour group of a stage: ready is green, waiting is yellow, cancelled or refunded is red. */
export function invoiceStageTone(stage: InvoiceStage): "pending" | "confirmed" | "closed" {
  return stage === "visible" ? "confirmed" : stage === "cancelled" || stage === "refunded" ? "closed" : "pending";
}
