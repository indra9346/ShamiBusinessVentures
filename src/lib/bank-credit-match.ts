/*
 * Which waiting payments a bank credit without a UTR could be (IDFC FIRST's credit SMS has none): a UTR sent by a
 * customer and not yet checked, for exactly the credited amount, within a day of the credit. Only a suggestion: an
 * admin confirms it (confirm_order_with_bank_credit), never the website by itself. Same rule as the database's
 * record_bank_credit_without_reference, which tells the admins when one comes in. No "@/" imports, for the tests.
 */

export const MATCH_WINDOW_HOURS = 24;

export type CreditToMatch = { amount: number; creditedAt: string | null; receivedAt: string };
export type PaymentToMatch = { orderNo: string; amount: number; utr: string; status: string; submittedAt: string };

const cents = (value: number) => Math.round(value * 100);

/** The UTRs waiting for a check that this credit could pay, the closest in time first. */
export function suggestPaymentsForCredit<T extends PaymentToMatch>(credit: CreditToMatch, payments: readonly T[]): T[] {
  const at = Date.parse(credit.creditedAt ?? credit.receivedAt);
  if (!Number.isFinite(at)) return [];
  const window = MATCH_WINDOW_HOURS * 60 * 60 * 1000;
  return payments
    .filter((payment) => payment.status === "submitted" && cents(payment.amount) === cents(credit.amount))
    .map((payment) => ({ payment, gap: Math.abs(Date.parse(payment.submittedAt) - at) }))
    .filter(({ gap }) => Number.isFinite(gap) && gap <= window)
    .sort((a, b) => a.gap - b.gap)
    .map(({ payment }) => payment);
}

export type CheckoutToMatch = {
  orderNo: string; amount: number; status: string; method?: string | undefined; createdAt: string;
  /** Set when a bank credit is already kept for it: then it is no choice for another credit. */
  moneySeenAt?: string | null | undefined;
};

/**
 * UPI checkouts still waiting for exactly this amount, with no UTR sent, made within a day before the credit (or after
 * it, for a customer who pressed Reorder after paying for a checkout that ended): the closest in time first. The
 * database keeps a credit for the checkout by itself only when exactly one was open when the money came.
 */
export function suggestCheckoutsForCredit<T extends CheckoutToMatch>(
  credit: CreditToMatch, checkouts: readonly T[], utrSentFor: ReadonlySet<string> = new Set(),
): T[] {
  const at = Date.parse(credit.creditedAt ?? credit.receivedAt);
  if (!Number.isFinite(at)) return [];
  const window = MATCH_WINDOW_HOURS * 60 * 60 * 1000;
  return checkouts
    .filter((checkout) => checkout.status === "Awaiting Payment" && !checkout.moneySeenAt && !["NEFT", "RTGS"].includes(checkout.method ?? "UPI")
      && !utrSentFor.has(checkout.orderNo) && cents(checkout.amount) === cents(credit.amount))
    .map((checkout) => ({ checkout, gap: Math.abs(Date.parse(checkout.createdAt) - at) }))
    .filter(({ gap }) => Number.isFinite(gap) && gap <= window)
    .sort((a, b) => a.gap - b.gap)
    .map(({ checkout }) => checkout);
}

/** True when the checkout was made after the money came in (fine after a Reorder, but worth a second look). */
export function madeAfterCredit(credit: CreditToMatch, checkout: { createdAt: string }) {
  const at = Date.parse(credit.creditedAt ?? credit.receivedAt);
  const made = Date.parse(checkout.createdAt);
  // The SMS time is to the minute.
  return Number.isFinite(at) && Number.isFinite(made) && made - at >= 60_000;
}
