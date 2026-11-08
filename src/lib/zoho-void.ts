/*
 * An order whose Zoho sales order is void (or cancelled) in Zoho, as the website last read it. Zoho is the official
 * book, so the website closes such an order too (apply_zoho_order_cancellation) and its page offers nothing to change.
 * No framework imports, so the node tests run this file as it is.
 */

export type ZohoVoidOrder = {
  status: string;
  payment: string;
  paidAmount?: number | null;
  zohoSalesOrderId?: string | null;
  zohoOrderStatus?: string | null;
};

const CLOSED_IN_ZOHO = ["void", "cancelled"];

/** The order's sales order is void or cancelled in Zoho. */
export const isVoidInZoho = (order: Pick<ZohoVoidOrder, "zohoSalesOrderId" | "zohoOrderStatus">) =>
  Boolean(order.zohoSalesOrderId) &&
  CLOSED_IN_ZOHO.includes((order.zohoOrderStatus ?? "").trim().toLowerCase());

/** Money was received here, so a void in Zoho cannot close the order before a refund. */
const moneyReceived = (order: ZohoVoidOrder) =>
  Number(order.paidAmount ?? 0) > 0 ||
  order.payment === "Paid" ||
  order.payment === "Partially Paid";

/** What the order page says at the top, or null when the sales order is alive in Zoho. */
export function zohoVoidNotice(
  order: ZohoVoidOrder,
): { tone: "closed" | "refund" | "closing"; title: string; detail: string } | null {
  if (!isVoidInZoho(order)) return null;
  const word =
    (order.zohoOrderStatus ?? "").trim().toLowerCase() === "cancelled" ? "cancelled" : "void";
  if (order.status === "Cancelled") {
    return {
      tone: "closed",
      title: `Sales order ${word} in Zoho`,
      detail: `Its sales order is ${word} in the official Zoho books, so this order is closed here and nothing on it can be changed. You can delete it with Delete order.`,
    };
  }
  if (moneyReceived(order)) {
    return {
      tone: "refund",
      title: `Sales order ${word} in Zoho, but money was received`,
      detail: `Its sales order is ${word} in Zoho, but a payment was recorded for this order here, so it stays open until the customer is refunded. Nothing else on it can be changed meanwhile.`,
    };
  }
  return {
    tone: "closing",
    title: `Sales order ${word} in Zoho`,
    detail: `Its sales order is ${word} in the official Zoho books, so this order is being closed here too. Nothing on it can be changed. If it still shows ${order.status} in a minute, open the order again.`,
  };
}
