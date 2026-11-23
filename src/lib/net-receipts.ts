/*
 * The admin dashboard's "Net Money Received (All Time)": money customers paid, minus refunds and seller payouts, from
 * the website's own records (not a bank feed). Pure helpers, so the node tests can load them.
 */

/**
 * Money that came in for an order, whatever happened to the order later. A paid order that was cancelled and refunded
 * still brought its money in once; the refund is what takes it out again. Counting it as 0 and also taking the refund
 * off is what showed Rs -2,151 on 6 Nov 2026 for the one order that was paid and then refunded.
 */
export function moneyReceived(order: { amount: number; paidAmount?: number; payment: string }): number {
  if (order.paidAmount !== undefined && order.paidAmount > 0) return order.paidAmount;
  return order.payment === "Paid" || order.payment === "Refunded" ? order.amount : 0;
}

export function netMoneyReceived(
  orders: readonly { amount: number; paidAmount?: number; payment: string }[],
  payouts: readonly { amount: number; status: string }[],
) {
  const paid = orders.reduce((sum, order) => sum + moneyReceived(order), 0);
  const refunded = orders.filter((order) => order.payment === "Refunded").reduce((sum, order) => sum + order.amount, 0);
  const toSellers = payouts.filter((payout) => payout.status === "Paid").reduce((sum, payout) => sum + payout.amount, 0);
  return { paid, refunded, toSellers, net: paid - refunded - toSellers };
}
