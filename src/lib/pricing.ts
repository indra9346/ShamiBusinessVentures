import type { Coupon } from "./store";

/** Rounds to paise, as the database's numeric(14,2) columns and round(x, 2) do. */
export const toPaise = (amount: number) => Math.round(Number((amount * 100).toPrecision(12))) / 100;

/*
 * Every selling price includes GST (owner, 7 Nov 2026): a ₹130 item costs the customer ₹130, of which
 * ₹6.19 is GST at 5% and ₹123.81 the taxable value. Orders placed before then added GST on top; they
 * keep their own figures (orders.prices_include_gst is false for them).
 */

/** The GST inside one cart line's price, rounded per line to paise (same as place_marketplace_order): price x qty x rate / (100 + rate). */
export const lineGstInside = (price: number, qty: number, gstPercent: number) =>
  gstPercent > 0 ? toPaise((price * qty * gstPercent) / (100 + gstPercent)) : 0;

/** The GST left inside the goods once a coupon has come off each line in proportion to its amount. */
export function gstAfterCoupon(lines: ReadonlyArray<{ price: number; qty: number; gstPercent: number }>, discount: number) {
  const gross = lines.map((line) => toPaise(line.price * line.qty));
  const goods = toPaise(gross.reduce((sum, value) => sum + value, 0));
  let discountLeft = toPaise(Math.min(discount, goods));
  let goodsLeft = goods;
  const ranked = lines.map((line, index) => ({ line, gross: gross[index]! })).sort((a, b) => b.gross - a.gross);
  let gst = 0;
  for (const { line, gross: lineGross } of ranked) {
    const share = goodsLeft > 0 ? Math.min(lineGross, toPaise((discountLeft * lineGross) / goodsLeft)) : 0;
    const left = toPaise(lineGross - share);
    gst += line.gstPercent > 0 ? toPaise((left * line.gstPercent) / (100 + line.gstPercent)) : 0;
    discountLeft = toPaise(discountLeft - share);
    goodsLeft = toPaise(goodsLeft - lineGross);
  }
  return toPaise(gst);
}

/** One line's figures: what the customer pays, the GST inside it, and the taxable value before GST. */
export function lineFigures(price: number, qty: number, gstPercent: number) {
  const gross = toPaise(price * qty);
  const gst = lineGstInside(price, qty, gstPercent);
  return { gross, gst, taxable: toPaise(gross - gst) };
}

/** A before-GST price with GST added, for prices worked out from costs (Admin > Pricing sheet). */
export const addGst = (beforeGst: number, gstPercent: number) => toPaise((beforeGst * (100 + gstPercent)) / 100);

/**
 * A price before GST, for comparing with a cost before GST: a price that includes GST has it taken out
 * (₹130 at 5% → ₹123.81, unrounded); one that doesn't is already before GST.
 */
export const priceBeforeGst = (price: number, gstPercent: number, includesGst: boolean) =>
  (includesGst ? (Number(price) * 100) / (100 + (Number(gstPercent) || 0)) : Number(price));

/**
 * The coupon discount place_marketplace_order_with_coupon stores: a percentage of the goods
 * total the customer sees (GST included), capped at the coupon's maximum (no cap when it has
 * none), or a fixed amount up to that total.
 */
export function couponDiscount(coupon: Coupon, goodsTotal: number) {
  const value = parseFloat(coupon.value.replace(/[^0-9.]/g, "")) || 0;
  if (coupon.type === "Percentage") {
    const discount = toPaise((goodsTotal * value) / 100);
    return coupon.uncapped ? discount : Math.min(coupon.max, discount);
  }
  return Math.min(goodsTotal, value);
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

/**
 * The rate (per QTL or per litre) to show for a pack price. Multiplying a rounded pack price
 * is off by up to a paisa per pack: a ₹2,617.13 bag comes from ₹5,234.25 per QTL (5,234.25 ÷ 2 =
 * 2,617.125 → 2,617.13), but 2,617.13 × 2 = 5,234.26. So this picks the simplest rate - whole
 * rupees, then 10 paise, then paise, lowest first - whose pack price rounds to exactly this
 * price. packPerBasis = pack size ÷ rate unit (a 50 kg bag per QTL = 0.5).
 */
export function rateForPackPrice(packPrice: number, packPerBasis: number): number {
  if (!(packPrice > 0) || !(packPerBasis > 0)) return 0;
  const target = Math.round(packPrice * 100);
  const packOf = (ratePaise: number) => Math.round(ratePaise * packPerBasis + 1e-7);
  const lo = (target - 0.5) / packPerBasis;
  const hi = (target + 0.5) / packPerBasis;
  for (const step of [100, 10, 1]) {
    for (let value = Math.ceil(lo / step - 1e-9) * step; value <= hi + 1e-9; value += step) {
      if (packOf(value) === target) return value / 100;
    }
  }
  return Math.round(target / packPerBasis) / 100;
}

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
