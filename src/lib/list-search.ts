// Search and filters for the order lists of the channel partner and the godown staff (owner's note, 11 Nov 2026:
// "give filter option in channel partner logins for orders & same in godown in-charge (staff)" and "give search option
// also in all the places"). No app imports, so the tests load it directly.
import { orderTone } from "./order-status-tone.ts";

const fold = (value: unknown) => String(value ?? "").toLowerCase().normalize("NFKC");

/**
 * True when every word typed is somewhere in the row's fields (any order, any case). Numbers also match with their
 * spaces and dashes left out, so "9876 543" finds 9876543210 and "clk 5775" finds CLK-577522-….
 */
export function matchesSearch(fields: ReadonlyArray<unknown>, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fields.map(fold).join(" \u0001 ");
  const squashed = text.replace(/[\s\-/]+/g, "");
  return words.every((word) => text.includes(word) || squashed.includes(word.replace(/[\s\-/]+/g, "")));
}

/** The order-status filters, in the portals' colours: waiting (yellow), confirmed (green), delivered, cancelled (red). */
export const ORDER_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Waiting" },
  { key: "confirmed", label: "Confirmed" },
  { key: "delivered", label: "Delivered" },
  { key: "closed", label: "Cancelled" },
] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number]["key"];

/** Whether an order with this status shows under the filter. "Confirmed" means confirmed and not yet delivered. */
export function matchesOrderFilter(status: string | null | undefined, filter: OrderFilter | string): boolean {
  if (filter === "all") return true;
  const delivered = String(status ?? "").trim().toLowerCase() === "delivered";
  if (filter === "delivered") return delivered;
  const tone = orderTone(status);
  if (filter === "confirmed") return tone === "confirmed" && !delivered;
  return tone === filter;
}

/** The payment filters. */
export const PAYMENT_FILTERS = [
  { key: "all", label: "Any payment" },
  { key: "paid", label: "Paid" },
  { key: "unpaid", label: "Not paid" },
] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number]["key"];

export function matchesPaymentFilter(payment: string | null | undefined, filter: PaymentFilter | string): boolean {
  if (filter === "all") return true;
  const paid = ["paid", "successful"].includes(String(payment ?? "").trim().toLowerCase());
  return filter === "paid" ? paid : !paid;
}

/** The released delivery notes' filters, for the godown: what is still to be handed over first. */
export const RELEASED_FILTERS = [
  { key: "all", label: "All" },
  { key: "to_go", label: "Goods to hand over" },
  { key: "handed", label: "All handed over" },
] as const;
export type ReleasedFilter = (typeof RELEASED_FILTERS)[number]["key"];

export function matchesReleasedFilter(row: { delivered: boolean; to_go: number }, filter: ReleasedFilter | string): boolean {
  if (filter === "all") return true;
  const open = !row.delivered && row.to_go > 0;
  return filter === "to_go" ? open : !open;
}

/** How many of each filter's rows there are, for the counts on the filter buttons. */
export function filterCounts<Row>(rows: ReadonlyArray<Row>, keys: ReadonlyArray<string>, matches: (row: Row, key: string) => boolean): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, rows.filter((row) => matches(row, key)).length]));
}
