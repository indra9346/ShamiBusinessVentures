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
