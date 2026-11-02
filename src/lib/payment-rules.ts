/*
 * How a customer may pay, by the order's value (client's note, 2 Nov 2026). The amount is the order's
 * total: what the customer pays, with GST and delivery, after any coupon.
 *   Below Rs 1,00,000:             UPI or NEFT.
 *   Rs 1,00,000 to Rs 1,99,999.99: NEFT.
 *   Rs 2,00,000 and above:         NEFT or RTGS.
 * The database has the same rule (private.allowed_payment_methods) and decides on the final total; this
 * copy is for showing the choices. NEFT and RTGS: the customer transfers to the company's bank account,
 * enters the UTR within 1 hour, and an admin checks it. Pure, so the node tests can load it.
 */

export type PayMethod = "UPI" | "NEFT" | "RTGS";

/** Below this, UPI is allowed. */
export const UPI_BELOW = 100_000;
/** From this, RTGS is allowed. */
export const RTGS_FROM = 200_000;

export function allowedMethods(total: number): PayMethod[] {
  if (total < UPI_BELOW) return ["UPI", "NEFT"];
  if (total < RTGS_FROM) return ["NEFT"];
  return ["NEFT", "RTGS"];
}

export const isBankMethod = (method: string | null | undefined) => method === "NEFT" || method === "RTGS";

/** The allowed methods that are ready to take money (UPI switched on, bank details entered). */
export function availableMethods(total: number, ready: { upi: boolean; bank: boolean }): PayMethod[] {
  return allowedMethods(total).filter((method) => (method === "UPI" ? ready.upi : ready.bank));
}

/**
 * What a checkout can offer. A cart can split into several orders and the database checks each one's own
 * total, so only what every order allows is offered.
 */
export function methodsForOrders(totals: number[], ready: { upi: boolean; bank: boolean }): PayMethod[] {
  return totals.map((total) => availableMethods(total, ready)).reduce((common, next) => common.filter((method) => next.includes(method)));
}

/** The customer's choice while it is still on offer, else the first on offer (a coupon can change the total). */
export function pickMethod(chosen: PayMethod | null, offered: PayMethod[]): PayMethod | null {
  return chosen && offered.includes(chosen) ? chosen : offered[0] ?? null;
}

/** Why a checkout with a UTR ended, when nobody checked it in time (the database writes the same text). */
export const UNCHECKED_UTR_NOTE = "we could not check your UTR in time";
/** An admin refunded such a transfer: that UTR pays for nothing any more. */
export const REFUNDED_UTR_NOTE = "refunded by our team";
/** Such a UTR went on to pay a new order. */
export const REUSED_UTR_NOTE = /^Placed again as /;

/**
 * This customer's transfer whose checkout lapsed unchecked and which has not been used since: they have
 * already paid, so a new checkout must not ask them to pay again.
 */
export function lapsedTransfer<T extends { utr: string; amount: number; status: string; note?: string | undefined; reviewedAt?: string | undefined }>(submissions: T[], now: number): T | undefined {
  return submissions.find((row) => row.status === "rejected" && row.note === UNCHECKED_UTR_NOTE
    && now - Date.parse(row.reviewedAt ?? "") < 7 * 86_400_000
    && !submissions.some((other) => other !== row && other.utr === row.utr && other.status !== "rejected"));
}

export const methodLabel = (method: string) => (method === "NEFT" ? "Online payment (NEFT)" : method);

/** A NEFT or RTGS UTR: 12 to 22 letters and numbers, stored in capitals (NEFT is usually 16, RTGS 22). */
export const normaliseBankUtr = (text: string) => text.replace(/\s+/g, "").toUpperCase();
export function bankUtrProblem(text: string): string | null {
  const utr = normaliseBankUtr(text);
  if (!utr) return "Enter the UTR from your bank";
  if (!/^[0-9A-Z]+$/.test(utr)) return "The UTR has only letters and numbers";
  if (utr.length < 12 || utr.length > 22) return `The UTR has 12 to 22 letters and numbers (you entered ${utr.length})`;
  return null;
}

/** The company's account customers transfer to. Kept in settings.bank_transfer, not public. */
export type BankDetails = { accountName: string; accountNumber: string; ifsc: string; bankName: string; branch: string };
export const BANK_SETTINGS_KEY = "bank_transfer";
export const EMPTY_BANK_DETAILS: BankDetails = { accountName: "", accountNumber: "", ifsc: "", bankName: "", branch: "" };

export const cleanBankDetails = (details: BankDetails): BankDetails => ({
  accountName: details.accountName.trim(),
  accountNumber: details.accountNumber.replace(/\s+/g, "").toUpperCase(),
  ifsc: details.ifsc.replace(/\s+/g, "").toUpperCase(),
  bankName: details.bankName.trim(),
  branch: details.branch.trim(),
});

export function bankDetailsProblem(details: BankDetails): string | null {
  const clean = cleanBankDetails(details);
  if (!clean.accountName) return "Enter the account name, exactly as the bank has it";
  if (!/^[0-9A-Z]{6,34}$/.test(clean.accountNumber)) return "Enter the account number: 6 to 34 letters and numbers";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(clean.ifsc)) return "Enter the 11-character IFSC, like HDFC0001234";
  if (!clean.bankName) return "Enter the bank's name";
  return null;
}

/** What changed between two versions of the bank details, for the change log. */
export function bankDetailChanges(before: Partial<BankDetails> | null, after: Partial<BankDetails> | null) {
  const fields: [keyof BankDetails, string][] = [["accountName", "Account name"], ["accountNumber", "Account number"], ["ifsc", "IFSC"], ["bankName", "Bank"], ["branch", "Branch"]];
  return fields
    .map(([key, label]) => ({ label, from: before?.[key] ?? "", to: after?.[key] ?? "" }))
    .filter((field) => field.from !== field.to);
}

export type ReorderLine = { productId: string; qty: number; name?: string | undefined };
export type ReorderPlan = {
  /** What goes in the cart. */
  items: { productId: string; qty: number; available?: number }[];
  /** In the cart, but fewer than before: only this many are available now. */
  reduced: { name: string; wanted: number; qty: number }[];
  /** Left out: not sold here any more, or out of stock. */
  unavailable: string[];
};

/**
 * What an unpaid checkout's items become today. `current` is null for a product no longer on sale to this
 * shopper. The cart then gets prices and stock as they are now: a reorder is a new order.
 */
export function reorderPlan(lines: ReorderLine[], current: (productId: string) => { name: string; available: number } | null): ReorderPlan {
  const plan: ReorderPlan = { items: [], reduced: [], unavailable: [] };
  const wantedById = new Map<string, ReorderLine>();
  for (const line of lines) {
    const seen = wantedById.get(line.productId);
    wantedById.set(line.productId, seen ? { ...seen, qty: seen.qty + line.qty } : line);
  }
  for (const line of wantedById.values()) {
    const product = current(line.productId);
    if (!product || product.available <= 0) {
      plan.unavailable.push(product?.name ?? line.name ?? line.productId);
      continue;
    }
    const qty = Math.min(line.qty, product.available);
    plan.items.push({ productId: line.productId, qty, available: product.available });
    if (qty < line.qty) plan.reduced.push({ name: product.name, wanted: line.qty, qty });
  }
  return plan;
}

/** A reorder sets the quantity rather than adding to it, so pressing it twice does not double the cart. */
export function mergeIntoCart<T extends { id: string; qty: number }>(cart: T[], items: { productId: string; qty: number; available?: number | undefined }[]): (T | { id: string; qty: number })[] {
  const merged: (T | { id: string; qty: number })[] = cart.map((line) => {
    const item = items.find((candidate) => candidate.productId === line.id);
    // Never above what is available, even if the cart already held more.
    return item ? { ...line, qty: Math.min(Math.max(line.qty, item.qty), item.available ?? Infinity) } : line;
  });
  for (const item of items) if (!cart.some((line) => line.id === item.productId)) merged.push({ id: item.productId, qty: item.qty });
  return merged;
}

/** Where a payment notification takes an admin (these checkouts are not on the order pages). */
export function paymentNoticeTarget(title: string): string | null {
  const text = title.toLowerCase();
  const isPaymentCheck = text.includes("to check") || text.includes("needs you") || text.includes("not checked") || text.includes("settings changed") || text.includes("bank details changed");
  return isPaymentCheck && (text.includes("upi") || text.includes("bank") || text.includes("payment")) ? "/admin/upi-payments" : null;
}
