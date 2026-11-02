/*
 * List filters shared by the dashboards' data cards and the pages they open, so a card's number and
 * the list behind it count the same things. Pure, so the node tests load it.
 */

/** Order filter: every order still in progress (what the dashboards count as pending). */
export const OPEN_ORDERS = "open";

export const isOpenOrder = (status: string) => status !== "Delivered" && status !== "Cancelled";

export const matchesOrderStatus = (status: string, filter: string) =>
  filter === "all" || (filter === OPEN_ORDERS ? isOpenOrder(status) : status === filter);

/** The status filter a link asked for, or "all" when it is not one this list offers. */
export const orderStatusFilter = (value: string | undefined, stages: readonly string[]) =>
  value && (value === OPEN_ORDERS || stages.includes(value)) ? value : "all";

function parseDate(dateStr: string): Date {
  // Date-only values should be interpreted in local time, matching the date inputs.
  const isoDate = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  const m = dateStr.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const day = parseInt(m[1]!, 10);
    const mon = months[m[2]!.toLowerCase()];
    const year = parseInt(m[3]!, 10);
    if (mon !== undefined) {
      return new Date(year, mon, day);
    }
  }
  return new Date(Number.NaN);
}

export function orderTimestamp(order: { createdAt?: string; date: string }): Date {
  return parseDate(order.createdAt || order.date);
}

/** Was the order placed in the range (ISO times, both ends included)? No range: every order. */
export function inOrderRange(order: { createdAt?: string; date: string }, from?: string, to?: string) {
  if (!from || !to) return true;
  const at = orderTimestamp(order).getTime();
  return at >= Date.parse(from) && at <= Date.parse(to);
}

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** What a link may ask an order list to show: ?status=open&from=<ISO>&to=<ISO>. A range needs both ends. */
export function orderListSearch(search: Record<string, unknown>) {
  return {
    ...(typeof search["status"] === "string" ? { status: search["status"] } : {}),
    ...(isTime(search["from"]) && isTime(search["to"]) ? { from: search["from"], to: search["to"] } : {}),
  };
}

/** Stock filter: low or out of stock (what the dashboards count as low stock). */
export const NEEDS_RESTOCK = "Needs Restock";

export const STOCK_FILTERS = ["All", "In Stock", "Low Stock", "Out of Stock", NEEDS_RESTOCK] as const;

/** The stock filter a link asked for, or "All" when it is not one the list offers. */
export const stockFilterOf = (value: unknown): string =>
  typeof value === "string" && (STOCK_FILTERS as readonly string[]).includes(value) ? value : "All";

export const matchesStockFilter = (status: string, filter: string) =>
  filter === "All" || (filter === NEEDS_RESTOCK ? status !== "In Stock" : status === filter);
