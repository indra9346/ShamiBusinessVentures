/*
 * Order colours in every portal (the owner's note, 11 Nov 2026): "order pending - yellow, order confirmed - green, order
 * rejected or cancelled - red, with saturation of 15 to 30%, in the customer portal and all portals, status-wise".
 * One place decides the group and the tint, so the customer, admin, vendor and channel partner screens agree.
 * Kept free of app imports so the node tests can load it.
 */

/** pending = yellow, confirmed = green, closed = red (cancelled, rejected, expired, refunded). */
export type OrderTone = "pending" | "confirmed" | "closed";

/** Waiting for the customer's payment or for the office: nothing confirmed yet. */
export const PENDING_ORDER_STATUSES = ["Awaiting Payment", "Placed"] as const;
/** Paid and confirmed, through to delivered (the delivery note's and Zoho's own meaning of confirmed). */
export const CONFIRMED_ORDER_STATUSES = ["Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"] as const;
/** Ended without going ahead: cancelled, or a checkout whose payment never came or was rejected. */
export const CLOSED_ORDER_STATUSES = ["Cancelled", "Payment Expired", "Rejected"] as const;

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
const has = (list: readonly string[], value: string | null | undefined) => list.some((item) => item.toLowerCase() === norm(value));

/** The colour group of an order status, or null for a value that is not an order status. */
export function orderTone(status: string | null | undefined): OrderTone | null {
  if (has(PENDING_ORDER_STATUSES, status)) return "pending";
  if (has(CONFIRMED_ORDER_STATUSES, status)) return "confirmed";
  if (has(CLOSED_ORDER_STATUSES, status)) return "closed";
  return null;
}

/** The colour group of a payment status: paid is confirmed; refunded and failed are closed; the rest wait. */
export function paymentTone(payment: string | null | undefined): OrderTone | null {
  const value = norm(payment);
  if (["paid", "successful"].includes(value)) return "confirmed";
  if (["refunded", "failed", "cancelled", "rejected"].includes(value)) return "closed";
  if (["pending", "partially paid", "cod", "overdue", "submitted"].includes(value)) return "pending";
  return null;
}

/**
 * The tints, about 20-30% of the colour over the site's warm canvas, with dark text so small type stays readable.
 * tile: a card or tile; row: a table row (with a hover that still shows); badge: a status pill; text: words only.
 */
export const TONE_CLASSES: Record<OrderTone, { tile: string; row: string; badge: string; text: string; border: string }> = {
  pending: {
    tile: "bg-yellow-300/25 border-yellow-500/40",
    row: "bg-yellow-300/20 hover:bg-yellow-300/30",
    badge: "bg-yellow-300/30 text-yellow-950 border-yellow-500/50",
    text: "text-yellow-900",
    border: "border-yellow-500/50",
  },
  confirmed: {
    tile: "bg-emerald-400/20 border-emerald-600/35",
    row: "bg-emerald-400/15 hover:bg-emerald-400/30",
    badge: "bg-emerald-400/30 text-emerald-950 border-emerald-600/45",
    text: "text-emerald-900",
    border: "border-emerald-600/45",
  },
  closed: {
    tile: "bg-red-400/20 border-red-600/35",
    row: "bg-red-400/15 hover:bg-red-400/30",
    badge: "bg-red-400/30 text-red-950 border-red-600/45",
    text: "text-red-900",
    border: "border-red-600/45",
  },
};

/** The classes for an order status's tile, row, badge, text or border; "" when it is not an order status. */
export function orderToneClass(status: string | null | undefined, part: keyof (typeof TONE_CLASSES)["pending"] = "tile") {
  const tone = orderTone(status);
  return tone ? TONE_CLASSES[tone][part] : "";
}

/** The same for a payment status. */
export function paymentToneClass(payment: string | null | undefined, part: keyof (typeof TONE_CLASSES)["pending"] = "badge") {
  const tone = paymentTone(payment);
  return tone ? TONE_CLASSES[tone][part] : "";
}
