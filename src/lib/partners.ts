/*
 * Channel Partner Commission Platform: rules shared by the admin pages, the partner panel and the
 * tests. The database applies the same rules (migration 20261026160000_channel_partners).
 * Kept free of app imports so the node tests can load it.
 */

export type CommissionKind = "per_unit" | "percent";
export type CommissionStatus = "pending" | "earned" | "cancelled";

/** Commission on one order line: rupees per unit, or a percentage of the line (excl. GST), to the paisa. */
export function commissionAmount(kind: CommissionKind, rate: number, qty: number, lineTotal: number) {
  const raw = kind === "percent" ? (Number(lineTotal) || 0) * rate / 100 : rate * (Number(qty) || 0);
  return Math.round((raw + Number.EPSILON) * 100) / 100;
}

/** Same rule as the database: Cancelled -> cancelled; Delivered and fully Paid -> earned; else pending. */
export function commissionStatus(orderStatus: string, paymentStatus: string): CommissionStatus {
  if (orderStatus === "Cancelled") return "cancelled";
  if (orderStatus === "Delivered" && paymentStatus === "Paid") return "earned";
  return "pending";
}

/** "₹2.50 per unit" / "1.5% of price". */
export function describeRate(kind: CommissionKind, rate: number) {
  return kind === "percent" ? `${rate}% of price` : `₹${rate.toLocaleString("en-IN", { minimumFractionDigits: rate % 1 ? 2 : 0, maximumFractionDigits: 2 })} per unit`;
}

/** The first day of a month (India), as yyyy-mm-01. */
export function monthStart(date = new Date()) {
  const india = new Date(date.getTime() + 330 * 60_000);
  return `${india.getUTCFullYear()}-${String(india.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** "October 2026" for yyyy-mm-01. */
export function monthLabel(month: string) {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, (mon ?? 1) - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Percentage of the target reached (one decimal), or null when no target is set. */
export function targetProgress(sales: number, target: number) {
  return target > 0 ? Math.round((sales * 1000) / target) / 10 : null;
}

/** Why a partner password is not acceptable, or null. At least 8 characters with a letter and a digit. */
export function partnerPasswordProblem(password: string) {
  if (password.length < 8) return "Use at least 8 characters";
  if (password.length > 72) return "Use at most 72 characters";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Use letters and at least one number";
  return null;
}

/** A strong password suggestion for a new partner login (no look-alike characters). */
export function suggestPartnerPassword(random: () => number = Math.random) {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (set: string) => set[Math.floor(random() * set.length)]!;
  let word = "";
  for (let i = 0; i < 8; i += 1) word += pick(letters);
  return `${word}-${pick(digits)}${pick(digits)}${pick(digits)}`;
}
