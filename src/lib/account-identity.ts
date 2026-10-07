import type { Order } from "@/lib/data";
import type { SessionUser } from "@/lib/store";
import type { Notif } from "@/lib/store";

export function normalizePhone(phone: string | undefined) {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function orderBelongsToUser(order: Order, user: SessionUser | null) {
  if (!user || user.role !== "customer") return false;

  const emailMatches = Boolean(
    user.email && order.email.toLowerCase() === user.email.toLowerCase(),
  );
  const userPhone = normalizePhone(user.phone);
  const phoneMatches = Boolean(userPhone && normalizePhone(order.phone) === userPhone);
  return emailMatches || phoneMatches;
}

export function notificationBelongsToUser(
  notification: Notif,
  user: SessionUser | null,
  orders: Order[],
) {
  if (!user || user.role !== "customer") return false;
  if (notification.source !== "live" && notification.id <= 34) return false;

  const orderId = notification.body.match(/\bORD-\d+\b/)?.[0];
  if (!orderId) return true;
  const order = orders.find((candidate) => candidate.id === orderId);
  return order ? orderBelongsToUser(order, user) : false;
}
