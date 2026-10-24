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

/** A purchase lot's entered values (the white columns of Shami's pricing sheet). */
export type PriceLotInput = {
  price: number;
  commission: number;
  gstRate: number;
  transport: number;
  /** Usually negative: the transporter's amali is deducted. */
  amaliTransport: number;
  amaliShami: number;
  driverTips: number;
  unloading: number;
  margin: number;
  /** Bag size in kg (a 50 kg bag is half a quintal). */
  bagKg: number;
};

const paise = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;

/**
 * The calculated columns (green in the sheet), per quintal unless noted. Same formulas as the
 * price_lots table's generated columns:
 *   GST = (price + commission) x rate; landing = price + commission + GST + transport
 *   + amali (transport) + amali (Shami) + driver tips + unloading; selling = landing + margin;
 *   bag = selling x bag kg / 100.
 */
export function priceLotTotals(lot: PriceLotInput) {
  const n = (value: number) => (Number.isFinite(value) ? value : 0);
  const gst = paise((n(lot.price) + n(lot.commission)) * n(lot.gstRate) / 100);
  const landing = paise(n(lot.price) + n(lot.commission) + gst + n(lot.transport) + n(lot.amaliTransport)
    + n(lot.amaliShami) + n(lot.driverTips) + n(lot.unloading));
  const sellingQntl = paise(landing + n(lot.margin));
  const sellingBag = paise(sellingQntl * (n(lot.bagKg) || 50) / 100);
  return { gst, landing, sellingQntl, sellingBag };
}
