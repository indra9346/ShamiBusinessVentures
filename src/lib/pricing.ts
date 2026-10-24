import type { Coupon } from "./store";

/** Rounds to paise, as the database's numeric(14,2) columns and round(x, 2) do. */
export const toPaise = (amount: number) => Math.round(amount * 100) / 100;

/** GST on one cart line, rounded per line to paise (same as place_marketplace_order). */
export const lineGst = (price: number, qty: number, gstPercent: number) => toPaise((price * qty * gstPercent) / 100);

/**
 * The coupon discount place_marketplace_order_with_coupon stores: a percentage of the
 * pre-GST subtotal capped at the coupon's maximum (no cap when it has none), or a fixed
 * amount up to the subtotal.
 */
export function couponDiscount(coupon: Coupon, subtotal: number) {
  const value = parseFloat(coupon.value.replace(/[^0-9.]/g, "")) || 0;
  if (coupon.type === "Percentage") {
    const discount = toPaise((subtotal * value) / 100);
    return coupon.uncapped ? discount : Math.min(coupon.max, discount);
  }
  return Math.min(subtotal, value);
}
