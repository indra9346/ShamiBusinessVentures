/**
 * One rule for every screen: an order whose payment window ran out, or a cancelled order, with nothing paid,
 * owes nothing. It is not "Pending" money, it gets no Confirm payment button and no pay panel.
 */

export const CLOSED_ORDER_STATUSES = ["Cancelled", "Payment Expired"] as const;

export function paymentClosed(order: { status: string; paidAmount?: number | null; payment?: string | null }) {
  return (CLOSED_ORDER_STATUSES as readonly string[]).includes(order.status)
    && Number(order.paidAmount ?? 0) <= 0
    && order.payment !== "Paid";
}

/** What an admin reads for such an order, instead of "Pending". */
export function closedPaymentLabel(status: string) {
  return status === "Payment Expired" ? "Payment expired, cancelled" : "Cancelled, not paid";
}

/** How an unpaid checkout ended. */
export function endedOutcomeLabel(outcome: string | null | undefined) {
  if (outcome === "dropped") return "Customer left the checkout";
  if (outcome === "ended") return "Ended by an admin";
  return "Time ran out";
}
