import type { Notif, Role, SessionUser } from "@/lib/store";
import type { Order } from "@/lib/data";
import { orderBelongsToUser } from "@/lib/account-identity";

export function notificationTarget(
  notification: Notif,
  role: Role,
  user: SessionUser | null,
  orders: Order[],
) {
  const orderId = notification.body.match(/\bORD-\d+\b/)?.[0];
  const order = orderId ? orders.find((item) => item.id === orderId) : undefined;

  if (role === "customer") {
    return order && orderBelongsToUser(order, user)
      ? `/account/orders/${order.id}`
      : "/account/orders";
  }

  if (role === "vendor") {
    return order ? `/vendor/orders/${order.id}` : "/vendor/orders";
  }

  if (order) return `/admin/orders/${order.id}`;

  const title = notification.title.toLowerCase();
  if (title.includes("payment")) return "/admin/payments";
  if (title.includes("vendor")) return "/admin/vendors";
  if (title.includes("stock")) return "/admin/inventory";
  if (title.includes("review")) return "/admin/reviews";
  if (title.includes("customer")) return "/admin/customers";
  return "/admin/notifications";
}
