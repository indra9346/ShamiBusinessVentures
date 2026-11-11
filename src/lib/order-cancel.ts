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
