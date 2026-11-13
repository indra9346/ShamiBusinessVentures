/*
 * Admin: cancel an order at any step (admin_cancel_order, 11 Nov 2026). The database decides; this says what the dialog
 * asks for first, so the admin sees it before pressing anything:
 *   - after dispatch, whether the goods came back to the godown;
 *   - if money was received, how all of it was paid back (mode, reference, date);
 *   - always, why.
 * No framework imports, so the node tests run this file as it is.
 */

export const REFUND_MODES = ["UPI", "NEFT", "RTGS", "IMPS", "Cash", "Cheque"] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

export type CancelOrder = {
  status: string;
  payment: string;
  paidAmount?: number;
  amount: number;
  vendorStatuses?: { status: string }[];
};

const SENT = ["Dispatched", "Out for Delivery", "Delivered"];

export function adminCancelPlan(order: CancelOrder) {
  const afterDispatch = SENT.includes(order.status) || (order.vendorStatuses ?? []).some((vendor) => SENT.includes(vendor.status));
  const paid = Math.max(0, order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0));
  const needsRefund = paid > 0 || order.payment === "Paid" || order.payment === "Partially Paid";
  const allowed = !["Cancelled", "Awaiting Payment", "Payment Expired"].includes(order.status);
  return { allowed, afterDispatch, needsRefund, refundAmount: Math.round(paid * 100) / 100 };
}

export type CancelForm = {
  reason: string;
  goodsBack: boolean | null;
  refundMode: RefundMode | "";
  refundReference: string;
  refundedOn: string;
};

/** What is still missing in the form, in the database's own words; null when it can be sent. */
export function cancelFormProblem(order: CancelOrder, form: CancelForm, today: string): string | null {
  const plan = adminCancelPlan(order);
  if (!plan.allowed) return "This order cannot be cancelled here.";
  if (plan.afterDispatch && form.goodsBack === null) return "Say whether the goods came back to the godown.";
  if (plan.needsRefund) {
    if (!form.refundMode) return "Choose how the money was paid back";
    if (form.refundMode !== "Cash" && form.refundReference.trim().length < 4) return "Enter the UTR or reference of the refund";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.refundedOn)) return "Enter the date the money was paid back";
    if (form.refundedOn > today) return "The refund date cannot be in the future";
  }
  const reason = form.reason.trim();
  if (reason.length < 4 || reason.length > 300) return "Say why this order is being cancelled";
  return null;
}

/** The refund as admin_cancel_order takes it, or null when nothing was paid. */
export function refundArgument(order: CancelOrder, form: CancelForm) {
  if (!adminCancelPlan(order).needsRefund) return null;
  return { mode: form.refundMode, reference: form.refundReference.trim(), refunded_on: form.refundedOn };
}

/** What cancelling does, in the order it happens, for the dialog. */
export function cancelSteps(order: CancelOrder, goodsBack: boolean | null): string[] {
  const plan = adminCancelPlan(order);
  const steps: string[] = [];
  if (plan.needsRefund) steps.push("The payment stays on record, marked Refunded. In Zoho Books its invoice is voided and the refund recorded.");
  if (!plan.afterDispatch) steps.push("Its stock goes back to the godown.");
  else if (goodsBack === true) steps.push("The goods are back, so the stock goes back to the godown.");
  else if (goodsBack === false) steps.push("The goods did not come back, so the stock stays as it is.");
  steps.push("Its Zoho sales order is voided and any partner commission on it is cancelled.");
  if (plan.afterDispatch) steps.push("If Zoho has a package or shipment for it, the Zoho sync says what to do there.");
  steps.push("Who cancelled it, when and why is kept in the Delete Log.");
  return steps;
}

/** The plain name of a deleted payment record's kind. */
export function deletedPaymentKind(kind: string) {
  return kind === "utr" ? "UTR record" : "Payment";
}

/*
 * Delete any order (11 Nov 2026, the owner on Payments & Matching: "need delete option ... make and work with sense").
 * order_delete_with_payments_check says what the Delete would do; the admin says first whether the money recorded on the
 * order was really received. Only "no, a test or typed by mistake" removes payments: real money is refunded instead, or
 * the order is a real sale and stays.
 */
export type DeleteCheck = {
  blocker: string | null;
  status: string;
  paid: number;
  payments: { id: string; amount: number; method: string; reference: string; in_zoho: boolean }[];
  paid_without_record: number;
  bank_alert: boolean;
  confirmed_utr: string | null;
  needs_cancel: boolean;
  after_dispatch: boolean;
  zoho_alive: boolean;
};
export type MoneyAnswer = "not_real" | "paid_back" | "kept" | null;

const rupees = (value: number) => `₹${(Math.round(value * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether money is recorded on the order, so the dialog must ask about it. */
export function deleteAsksAboutMoney(check: DeleteCheck) {
  return check.paid > 0 || check.paid_without_record > 0;
}

/** The database's order_delete_with_payments_check answer, with its numbers as numbers. */
export function normaliseDeleteCheck(raw: DeleteCheck): DeleteCheck {
  return { ...raw, paid: Number(raw.paid ?? 0), paid_without_record: Number(raw.paid_without_record ?? 0), payments: (raw.payments ?? []).map((p) => ({ ...p, amount: Number(p.amount) })) };
}

/**
 * Whether "Delete all details" may run for a ticked row without asking anything (delete several at once, 13 Nov 2026).
 * A row with money on it, or one that must be cancelled first, needs its own Delete, where the admin answers those
 * questions. Null when it may go.
 */
export function bulkDeleteAllDetailsProblem(check: DeleteCheck): string | null {
  if (check.blocker) return check.blocker;
  if (deleteAsksAboutMoney(check)) return "Money is recorded on it: use its own Delete, which asks whether the money was real.";
  if (check.needs_cancel) return "It must be cancelled first: use its own Delete.";
  return null;
}

/** What the Delete will do, in order, and why it cannot run yet (null when it can). */
export function deletePlan(check: DeleteCheck, answer: MoneyAnswer, goodsBack: boolean | null): { why: string | null; steps: string[] } {
  if (check.blocker) return { why: check.blocker, steps: [] };
  const money = deleteAsksAboutMoney(check);
  if (money) {
    if (answer === null) return { why: "Say whether this money was really received.", steps: [] };
    if (answer === "kept") return { why: "Then it is a real sale and stays for the accounts.", steps: [] };
    if (answer === "paid_back") return { why: "Record the refund first (Refund cancels the order). Then delete it.", steps: [] };
    if (check.bank_alert) return { why: "A bank alert shows this money came in. Record its refund instead.", steps: [] };
    if (check.paid_without_record > 0)
      return { why: `${rupees(check.paid_without_record)} is on this order with no payment record behind it. Record its refund instead.`, steps: [] };
  }
  if (check.needs_cancel && check.after_dispatch && goodsBack === null) return { why: "Say whether the goods came back to the godown.", steps: [] };
  const steps: string[] = [];
  if (money && check.payments.length) {
    steps.push(check.payments.length === 1
      ? `Remove its payment of ${rupees(check.paid)}, keeping a copy.`
      : `Remove its ${check.payments.length} payments (${rupees(check.paid)}), keeping a copy of each.`);
    if (check.payments.some((payment) => payment.in_zoho)) steps.push("A payment that is in Zoho Books is taken out of Zoho Books first.");
  }
  if (check.needs_cancel) {
    steps.push("Cancel the order with your reason.");
    if (check.after_dispatch) steps.push(goodsBack ? "The goods came back, so the stock goes back to the godown." : "The goods did not come back, so the stock stays as it is.");
  }
  if (check.zoho_alive) steps.push("The Zoho sync voids its sales order. If it is not void yet when the delete runs, press Delete again in a minute.");
  steps.push("Delete the order with all its details. A full copy stays in the Delete Log, its number is never used again, and nothing is deleted in Zoho.");
  return { why: null, steps };
}
