/*
 * Channel Partner Commission Platform: rules shared by the admin pages, the partner panel and the
 * tests. The database applies the same rules (migration 20261026160000_channel_partners).
 * Kept free of app imports so the node tests can load it.
 */

export type CommissionKind = "per_unit" | "percent" | "net_profit";
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

/** "₹2.50 per unit" / "1.5% of price" / "Monthly profit share" (a line on a godown paid by the month carries no amount of its own). */
export function describeRate(kind: CommissionKind, rate: number) {
  if (kind === "net_profit") return "Monthly profit share";
  return kind === "percent" ? `${rate}% of price` : `₹${rate.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per unit`;
}

export type OrderCommissionLine = {
  order_no: string; placed_at: string; order_status: string; payment_status: string; customer_name: string; pin: string;
  line_total: number; amount: number; paid_amount: number; due_amount: number; status: string;
};
export type OrderCommissions<T> = {
  orderNo: string; placedAt: string; orderStatus: string; paymentStatus: string; customerName: string; pin: string;
  sale: number; commission: number; paid: number; balance: number; status: string; lines: T[];
};
const paise = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Commission lines as one row per order, newest order first. An order is cancelled only when all of its lines are. */
export function commissionsByOrder<T extends OrderCommissionLine>(lines: T[]): OrderCommissions<T>[] {
  const orders = new Map<string, T[]>();
  for (const line of lines) orders.set(line.order_no, [...(orders.get(line.order_no) ?? []), line]);
  return [...orders.entries()].map(([orderNo, rows]) => {
    const live = rows.filter((row) => row.status !== "cancelled");
    const sum = (pick: (row: T) => number) => paise(rows.reduce((total, row) => total + Number(pick(row)), 0));
    return {
      orderNo, placedAt: rows[0]!.placed_at, orderStatus: rows[0]!.order_status, paymentStatus: rows[0]!.payment_status,
      customerName: rows[0]!.customer_name, pin: rows[0]!.pin, lines: rows,
      sale: sum((row) => row.line_total), commission: sum((row) => row.amount), paid: sum((row) => row.paid_amount), balance: sum((row) => row.due_amount),
      status: live.length ? (live.some((row) => row.status === "pending") ? "pending" : "earned") : "cancelled",
    };
  }).sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt));
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

/** Why a login email will not do, or null. */
export function partnerEmailProblem(email: string) {
  const value = email.trim().toLowerCase();
  if (value.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return "Enter a valid email";
  return null;
}

/** Who already signs in with an email (the database's login_email_owner, 13 Nov 2026). */
export type LoginEmailOwner = { user_id: string; name: string; kind: "channel_partner" | "admin" | "staff" | "vendor" | "customer"; partner_status: string | null };

/**
 * Supabase's own words when an email belongs to another login. Its admin "update user" does not check first: the database
 * refuses the duplicate and Supabase answers only "Error updating user" (seen on live 12 Nov 2026, users_email_partial_key).
 */
export function isEmailTakenError(message: string) {
  return /already been registered|already exists|already registered|email_exists|duplicate key|users_email_partial_key/i.test(message);
}

/** The message the admin sees when the email is already another account's sign-in. */
export function emailTakenMessage(owner: LoginEmailOwner | null) {
  const name = owner?.name?.trim() ? ` (${owner.name.trim()})` : "";
  const who = !owner ? "Another Grain Bazar login"
    : owner.kind === "channel_partner" ? `Another channel partner's login${name}${owner.partner_status === "suspended" ? ", now suspended," : ""}`
    : owner.kind === "admin" ? `An admin login${name}`
    : owner.kind === "staff" ? `A godown employee's login${name}`
    : owner.kind === "vendor" ? `A seller (vendor) login${name}`
    : `A customer's shopping login${name}`;
  return `${who} already uses this email. One email can sign in to only one account, so nothing was changed. Use a different email for the partner's login.`;
}

/** A 10-digit Indian mobile number, or blank (the godown's own phone is printed on invoices then). Spaces and +91 are dropped. */
export function normalisePartnerPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

export function partnerPhoneProblem(phone: string) {
  const value = normalisePartnerPhone(phone);
  return value === "" || /^[6-9]\d{9}$/.test(value) ? null : "Enter a 10-digit mobile number";
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
