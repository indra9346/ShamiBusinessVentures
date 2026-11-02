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

/** The Products page's stock cards: low is 1 to 29 units, out is exactly none. */
export const matchesStockBand = (stock: number, band: string) =>
  band === "low" ? stock > 0 && stock < 30 : band === "out" ? stock === 0 : true;

/** A vendor's own inventory cards. Low includes out of stock, as its reorder alerts do. */
export const matchesVendorStock = (stock: number, minimum: number, view: string) =>
  view === "healthy" ? stock > 0 && stock >= minimum
    : view === "low" ? stock <= 0 || stock < minimum
      : view === "out" ? stock === 0
        : true;

/** A vendor's product list: its review status, or the Active and Out of Stock cards. */
export const matchesVendorProduct = (product: { active: boolean; stock: number; status: string }, filter: string) =>
  filter === "all" || (filter === "on-sale" ? product.active : filter === "out" ? product.stock === 0 : product.status === filter);

/** Vendor filter: approved or active (what the Approved cards count). */
export const APPROVED_VENDORS = "approved-or-active";

const VENDOR_STATUSES = [APPROVED_VENDORS, "approved", "active", "pending", "suspended"];

/** The vendor status a link asked for, or "all" when it is not one the list offers. */
export const vendorStatusFilter = (value: unknown): string =>
  typeof value === "string" && VENDOR_STATUSES.includes(value) ? value : "all";

export const matchesVendorStatus = (status: string, filter: string) =>
  filter === "all" || (filter === APPROVED_VENDORS ? status === "approved" || status === "active" : status === filter);

/** Payment filter: every transaction with money in (what Total Collected adds up). */
export const MONEY_RECEIVED = "Money received";
/** Payment filter: every order with money still to come (what the Pending card adds up). */
export const UNPAID = "Unpaid";

const PAYMENT_FILTERS = ["Successful", "Pending", "Overdue", "Partially Paid", "Failed", "Refunded", MONEY_RECEIVED, UNPAID];

/** The payment filter a link asked for, or "All" when it is not one the list offers. */
export const paymentFilterOf = (value: unknown): string =>
  typeof value === "string" && PAYMENT_FILTERS.includes(value) ? value : "All";

export const isUnpaid = (payment: string) => payment !== "Paid" && payment !== "Refunded" && payment !== "Failed";

export const matchesPaymentFilter = (txn: { status: string; payment: string; paid: number }, filter: string) =>
  filter === "All"
    || (filter === MONEY_RECEIVED ? txn.paid > 0 : filter === UNPAID ? isUnpaid(txn.payment) : txn.status === filter);

/** Payout filter: requests still open, neither paid nor rejected. */
export const OPEN_PAYOUTS = "Open";

export const matchesPayoutStatus = (status: string, filter: string) =>
  filter === "All" || (filter === OPEN_PAYOUTS ? status !== "Paid" && status !== "Rejected" : status === filter);

/** Commission lines: "sales" is every line the sales card adds up; pending is anything not earned or cancelled. */
export const matchesCommissionStatus = (status: string, filter: string) =>
  filter === "sales" ? status !== "cancelled"
    : filter === "earned" ? status === "earned"
      : filter === "pending" ? status !== "earned" && status !== "cancelled"
        : true;

/** The vendor review cards, which count published reviews only. */
export const matchesReviewCard = (review: { status: string; rating: number }, card: string) =>
  card === "all" || (review.status === "Published"
    && (card === "five" ? review.rating === 5 : card === "low" ? review.rating <= 2 : true));

export const matchesCouponView = (coupon: { status: string; used: number }, view: string) =>
  view === "all" || (view === "used" ? coupon.used > 0 : coupon.status === view);

export const matchesReadFilter = (read: boolean, view: string) =>
  view === "unread" ? !read : view === "read" ? read : true;

export type BatchStatus = "all" | "stock" | "soldout" | "lost";

export const matchesBatchStatus = (row: { available: number; lost: number }, status: BatchStatus) =>
  status === "stock" ? row.available > 0 : status === "soldout" ? row.available <= 0 : status === "lost" ? row.lost > 0 : true;

export const matchesBranchView = (branch: { active: boolean; deliveryEnabled: boolean; isDefault: boolean }, view: string) =>
  view === "active" ? branch.active : view === "delivery" ? branch.active && branch.deliveryEnabled : view === "default" ? branch.isDefault : true;

/** A sale line behind the Losses card: sold below cost, cancelled or refunded. */
export const isLossLine = (line: { margin: number | null; orderStatus: string; paymentStatus: string }) =>
  (line.margin !== null && line.margin < 0) || line.orderStatus === "Cancelled" || /refunded/i.test(line.paymentStatus);
