// Why a channel partner rejects a customer's UTR (19 Nov 2026). No app imports, so the tests load it directly.

export const PARTNER_REJECT_REASONS = [
  "Money has not come into the bank",
  "A different amount came in",
  "This UTR is wrong or not found",
  "Other",
] as const;

/** The reason as saved and told to the customer: the choice, with the partner's note; "" when not enough is given. */
export function partnerRejectReason(choice: string, detail: string) {
  const note = detail.trim().replace(/\s+/g, " ").slice(0, 100);
  if (!(PARTNER_REJECT_REASONS as readonly string[]).includes(choice)) return "";
  if (choice === "Other") return note.length >= 3 ? note : "";
  return note ? `${choice}: ${note}` : choice;
}
