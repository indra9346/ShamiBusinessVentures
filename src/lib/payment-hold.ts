/*
 * Pay first, then the order is placed. A checkout is a held request ("Awaiting Payment") until the
 * full UPI payment is matched; one not paid in time becomes "Payment Expired". Neither is an order:
 * order lists, reports, dashboards and Zoho leave them out.
 */

export const AWAITING_PAYMENT = "Awaiting Payment";
export const PAYMENT_EXPIRED = "Payment Expired";
export const HELD_STATUSES = [AWAITING_PAYMENT, PAYMENT_EXPIRED] as const;

/** PostgREST filter value: `.not("order_status", "in", NOT_HELD)` keeps only real orders. */
export const HELD_STATUS_FILTER = `(${HELD_STATUSES.map((status) => `"${status}"`).join(",")})`;

export function isHeldStatus(status: string | null | undefined): boolean {
  return (HELD_STATUSES as readonly string[]).includes(status ?? "");
}

/** Whole seconds until the hold ends (0 when over or unknown). */
export function holdSecondsLeft(holdUntil: string | null | undefined, now = Date.now()): number {
  if (!holdUntil) return 0;
  const end = Date.parse(holdUntil);
  return Number.isFinite(end) ? Math.max(0, Math.ceil((end - now) / 1000)) : 0;
}

/** "14:05" for a countdown. */
export function clockText(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export type PaymentHold = {
  orderNo: string;
  amount: number;
  status: typeof AWAITING_PAYMENT | typeof PAYMENT_EXPIRED | "Payment Confirmed";
  holdUntil: string | null;
  createdAt: string;
  outcome?: "expired" | "dropped" | null | undefined;
  /** Product ids and quantities, to put the items back in the cart if it is not paid. */
  lines: { productId: string; qty: number }[];
};

/** What the customer should see for a held request right now. */
export function holdView(hold: Pick<PaymentHold, "status" | "holdUntil" | "outcome">, utrSent: boolean, now = Date.now()) {
  if (hold.status === "Payment Confirmed") return "confirmed" as const;
  if (hold.status === PAYMENT_EXPIRED) return hold.outcome === "dropped" ? ("dropped" as const) : ("expired" as const);
  if (utrSent) return "verifying" as const;
  return holdSecondsLeft(hold.holdUntil, now) > 0 ? ("pay" as const) : ("closing" as const);
}
