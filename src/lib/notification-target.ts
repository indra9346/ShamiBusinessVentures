import type { Notif, Role, SessionUser } from "@/lib/store";
import type { Order } from "@/lib/data";
import { orderBelongsToUser } from "@/lib/account-identity";
import { orderNumberIn } from "@/lib/order-number";
import { paymentNoticeTarget } from "@/lib/payment-rules";

export function notificationTarget(
  notification: Notif,
  role: Role,
  user: SessionUser | null,
  orders: Order[],
  holds: { orderNo: string }[] = [],
) {
  const orderId = orderNumberIn(notification.body);
  const order = orderId ? orders.find((item) => item.id === orderId) : undefined;

  if (role === "customer") {
    // A checkout that is not an order yet (or was not placed) has its own page, with Pay or Reorder.
    if (orderId && holds.some((hold) => hold.orderNo === orderId)) return `/account/orders/${orderId}`;
    return order && orderBelongsToUser(order, user)
      ? `/account/orders/${order.id}`
      : "/account/orders";
  }

  if (role === "vendor") {
    if (notification.title.toLowerCase().includes("stock")) return "/vendor/inventory";
    return order ? `/vendor/orders/${order.id}` : "/vendor/orders";
  }

  const paymentPage = paymentNoticeTarget(notification.title);
  if (paymentPage) return paymentPage;
  if (order) return `/admin/orders/${order.id}`;

  const title = notification.title.toLowerCase();
  const enquiryId = notification.body.match(/\bEnquiry ID:\s*([0-9a-f]{8}-[0-9a-f-]{27,})\b/i)?.[1];
  if (enquiryId || title.includes("enquiry")) {
    return enquiryId ? `/admin/enquiries/${enquiryId}` : "/admin/enquiries";
  }
  if (title.includes("payment")) return "/admin/payments";
  if (title.includes("vendor")) return "/admin/vendors";
  if (title.includes("stock")) return "/admin/inventory";
  if (title.includes("review")) return "/admin/reviews";
  if (title.includes("customer")) return "/admin/customers";
  return "/admin/notifications";
}
