/**
 * Sorting the channel partner's order lists (client, 16 Nov 2026: "in channel partner login sort by orders option enable that").
 */
export type SortKey = "newest" | "oldest" | "amount_high" | "amount_low" | "customer" | "order_no";

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  amount_high: "Amount: high to low",
  amount_low: "Amount: low to high",
  customer: "Customer name (A–Z)",
  order_no: "Order number",
};

export type SortFields = { when: string | null | undefined; amount?: number | null; customer?: string | null; orderNo: string };

const time = (value: string | null | undefined) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** A sorted copy of the rows; ties keep the newest first, then the order number, so the order never jumps. */
export function sortRows<T>(rows: readonly T[], key: SortKey, pick: (row: T) => SortFields): T[] {
  const text = (value: string | null | undefined) => (value ?? "").trim().toLocaleLowerCase("en-IN");
  return [...rows].sort((left, right) => {
    const a = pick(left);
    const b = pick(right);
    let by = 0;
    if (key === "oldest") by = time(a.when) - time(b.when);
    else if (key === "amount_high") by = Number(b.amount ?? 0) - Number(a.amount ?? 0);
    else if (key === "amount_low") by = Number(a.amount ?? 0) - Number(b.amount ?? 0);
    else if (key === "customer") by = text(a.customer).localeCompare(text(b.customer), "en-IN");
    else if (key === "order_no") by = a.orderNo.localeCompare(b.orderNo, "en-IN", { numeric: true });
    return by || time(b.when) - time(a.when) || a.orderNo.localeCompare(b.orderNo, "en-IN", { numeric: true });
  });
}

export const ALL_SORTS: readonly SortKey[] = ["newest", "oldest", "amount_high", "amount_low", "customer", "order_no"];
export const NO_AMOUNT_SORTS: readonly SortKey[] = ["newest", "oldest", "customer", "order_no"];
