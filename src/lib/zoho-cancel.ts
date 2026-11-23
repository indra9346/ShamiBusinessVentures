/*
 * Zoho for an order an admin cancelled on the website (admin_cancel_order, 11 Nov 2026). Before its sales order is voided:
 *   1. every Books invoice of it that still counts is voided. Zoho then keeps the payments on it as the customer's credit;
 *   2. each refund the admin recorded is recorded in Books against its payment, which pays that credit back out of the
 *      account the money went into. Books then shows the money in and the money out, as the website does.
 * The website never deletes anything in Zoho. Where Zoho refuses, a person is told what to do there.
 * No framework imports, so the node tests run this file as it is.
 */

export type WebsiteRefund = {
  id: string;
  amount: number;
  mode: string;
  reference: string;
  refundedOn: string;
  /** The reference of the payment it pays back. */
  paidRef: string;
  zohoPaymentId: string | null;
};

export type ListedZohoRefund = { payment_refund_id?: unknown; reference_number?: unknown; amount?: unknown; date?: unknown; description?: unknown };

const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").trim();
const paise = (value: unknown) => Math.round(Number(value) * 100);
const plain = (value: string) => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/** Books' own refund modes: a bank transfer of any kind, cash or a cheque. The exact way (UPI, NEFT…) is in the description. */
export function zohoRefundMode(mode: string) {
  if (mode === "Cash") return "Cash";
  if (mode === "Cheque") return "Check";
  return "Bank Transfer";
}

/** The body of POST customerpayments/{id}/refunds for one website refund. */
export function zohoRefundBody(refund: WebsiteRefund, orderNo: string, fromAccountId: string) {
  return {
    date: refund.refundedOn,
    amount: paise(refund.amount) / 100,
    refund_mode: zohoRefundMode(refund.mode),
    ...(refund.reference ? { reference_number: refund.reference.slice(0, 100) } : {}),
    from_account_id: fromAccountId,
    description: `Refund by ${refund.mode} for Grain Bazar order ${orderNo}, cancelled on the website.`,
  };
}

/**
 * The refund Books already holds for this website refund, if a sync made it before and its answer was lost: the same
 * amount and the same reference, or, for cash without one, the same amount and date naming the order.
 */
export function refundAlreadyInZoho(listed: ListedZohoRefund[], refund: WebsiteRefund, orderNo: string): string | null {
  for (const row of listed) {
    const id = text(row.payment_refund_id);
    if (!id || paise(row.amount) !== paise(refund.amount)) continue;
    if (refund.reference && plain(text(row.reference_number)) === plain(refund.reference)) return id;
    if (!refund.reference && text(row.date) === refund.refundedOn && text(row.description).includes(orderNo)) return id;
  }
  return null;
}

/** The Books invoices of a sales order that still count (not void), as the sales order lists them. */
export function liveZohoInvoices(salesOrder: Record<string, unknown>) {
  const invoices = Array.isArray(salesOrder["invoices"]) ? salesOrder["invoices"] : [];
  return invoices
    .map((invoice) => (invoice && typeof invoice === "object" ? (invoice as Record<string, unknown>) : {}))
    .map((invoice) => ({ id: text(invoice["invoice_id"]), number: text(invoice["invoice_number"]), status: text(invoice["status"]).toLowerCase() }))
    .filter((invoice) => invoice.id && invoice.status !== "void");
}

/**
 * The Books payment of each website refund whose payment id the website did not keep: the one on the invoice with the
 * same reference and amount. Each Books payment is given to one refund only.
 */
export function matchRefundPayments(refunds: WebsiteRefund[], invoicePayments: { paymentId: string; reference: string; amount: number }[]) {
  const found = new Map<string, string>();
  const used = new Set(refunds.map((refund) => refund.zohoPaymentId).filter(Boolean) as string[]);
  for (const refund of refunds) {
    if (refund.zohoPaymentId || !refund.paidRef) continue;
    const match = invoicePayments.find((payment) => payment.paymentId && !used.has(payment.paymentId)
      && plain(payment.reference) === plain(refund.paidRef) && paise(payment.amount) === paise(refund.amount));
    if (match) {
      found.set(refund.id, match.paymentId);
      used.add(match.paymentId);
    }
  }
  return found;
}

/** The packages and shipments Zoho lists on a sales order, by their numbers. */
export function zohoOrderPapers(salesOrder: Record<string, unknown>) {
  const papers: string[] = [];
  for (const key of ["packages", "shipments"]) {
    const list = Array.isArray(salesOrder[key]) ? salesOrder[key] : [];
    for (const item of list) {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const pkg = text(row["package_number"]);
      const shipment = text(row["shipment_number"]);
      if (key === "packages" && pkg && !papers.includes(`package ${pkg}`)) papers.push(`package ${pkg}`);
      if (shipment && !papers.includes(`shipment ${shipment}`)) papers.push(`shipment ${shipment}`);
    }
  }
  return papers;
}

/** What to tell a person when Zoho would not void the sales order of an order cancelled here. */
export function zohoVoidRefusedReview(orderNo: string, salesOrderNumber: string, message: string, salesOrder: Record<string, unknown>, goodsBack: boolean | null) {
  const papers = zohoOrderPapers(salesOrder);
  const head = `Grain Bazar order ${orderNo} is cancelled, but Zoho would not void sales order ${salesOrderNumber}: ${message}.`;
  const has = papers.length ? ` It has ${papers.join(", ")}.` : "";
  if (goodsBack === false)
    return `${head}${has} The goods did not come back to the godown: ask your accountant how to close it in Zoho (for example a credit note), then Retry.`;
  if (papers.length)
    return `${head}${has} If the goods came back, delete the shipment and then the package in Zoho Inventory, then Retry.`;
  return `${head} Void it in Zoho Inventory, then Retry.`;
}

/** What to tell a person when Books did not take a refund. */
export function zohoRefundProblem(orderNo: string, amount: number, message: string) {
  return `Zoho Books did not record the refund of ₹${(paise(amount) / 100).toFixed(2)} for cancelled Grain Bazar order ${orderNo}: ${message}. Record it in Zoho Books (Payments Received, open the payment, Refund), then Retry.`;
}
