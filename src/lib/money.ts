/**
 * Rupees for display, always with 2 decimals: ₹2,650.00, ₹98.04, -₹8,405.79, ₹0.00.
 * 17 Nov 2026 (owner): this used to round to whole rupees, so a ₹98.04 product read "₹98" while the pay step asked for
 * ₹98.04. 19 Nov 2026 (owner: "Numbers decimals are not standard. Please make all the numbers show 2 digits decimals"):
 * every amount now shows exactly 2 decimals, a minus sits before the ₹, and a zero never reads "₹-0". The value itself is
 * never changed by formatting.
 */
export const inr = (n: number) => {
  const paise = Math.round(Number(n) * 100);
  if (!Number.isFinite(paise)) return "₹0.00";
  const text = (Math.abs(paise) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return paise < 0 ? `-₹${text}` : `₹${text}`;
};

/** Same as inr (kept for the many places that use it): ₹2,650.00 and ₹43.50. */
export const inrPrecise = inr;

/**
 * Shop pages (25 Nov 2026, client): whole rupees without ".00" (₹2,694, ₹45), paise kept when there are any
 * (₹98.04), so the shown price always equals what is charged. Admin, invoices, PDFs, SMS and Zoho keep inr().
 */
export const inrShop = (n: number) => {
  const paise = Math.round(Number(n) * 100);
  if (!Number.isFinite(paise)) return "₹0";
  if (paise % 100 !== 0) return inr(n);
  const text = (Math.abs(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return paise < 0 ? `-₹${text}` : `₹${text}`;
};
