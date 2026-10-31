/*
 * Godown stock counts by godown staff (the staff app at /staff). Rules shared by the server function
 * (submitStockCount), the staff, admin and partner pages, and the tests. Kept free of app imports so
 * the node tests can load it.
 *
 *   * The employee counts the bags on the godown floor and enters that number.
 *   * Zoho is the stock master: Zoho's PHYSICAL stock at the godown's location (stock based on
 *     shipments and receives) is brought to the count with one inventory adjustment. An adjustment
 *     moves Zoho's accounting stock by the same amount, so both stay right.
 *   * The website then takes the godown stock the regular Zoho sync would give it: Zoho's stock at
 *     the location less website orders Zoho does not hold yet (godownStockFromZohoItem).
 *   * A count that differs from Zoho's physical stock by more than 20% is flagged for head office.
 */

export type StockCountReason = "daily_count" | "received" | "damaged" | "correction";

export const STOCK_COUNT_REASONS: { value: StockCountReason; label: string }[] = [
  { value: "daily_count", label: "Daily stock count" },
  { value: "received", label: "Stock received" },
  { value: "damaged", label: "Damaged / spoiled" },
  { value: "correction", label: "Correction" },
];

export const stockCountReasonLabel = (reason: string) =>
  STOCK_COUNT_REASONS.find((option) => option.value === reason)?.label ?? reason;

/** A count differing from Zoho's physical stock by more than this share is flagged. */
export const BIG_CHANGE_SHARE = 0.2;
export const MAX_COUNT = 1_000_000;

const finite = (value: unknown) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Zoho's stock for one item at one location (from GET items/{id}): physical = based on shipments
 * and receives (what is on the floor), accounting = based on invoices and bills (what the website
 * sync reads). Null when the item has no record at that location.
 */
export function zohoLocationStock(item: Record<string, unknown>, zohoLocationId: string) {
  const locations = Array.isArray(item["locations"]) ? (item["locations"] as Record<string, unknown>[]) : [];
  const location = locations.find((entry) => String(entry["location_id"] ?? "") === zohoLocationId);
  if (!location) return null;
  const onHand = finite(location["location_stock_on_hand"]);
  const physical = finite(location["location_actual_available_stock"]) ?? onHand;
  const accounting = finite(location["location_available_stock"]) ?? onHand;
  if (physical === null || accounting === null) return null;
  return { physical, accounting };
}

/**
 * What a count does: the Zoho adjustment (count − Zoho physical) and the website's godown stock
 * afterwards (Zoho accounting after the adjustment, less website orders Zoho does not hold yet;
 * never below 0, to the paisa like godownStockFromZohoItem).
 */
export function planStockCount({ counted, physical, accounting, pendingOrders }: { counted: number; physical: number; accounting: number; pendingOrders: number }) {
  const delta = round(counted - physical);
  const siteAfter = Math.max(0, Math.round((accounting + delta - Math.max(0, pendingOrders)) * 100) / 100);
  return { delta, siteAfter };
}

/** More than 20% away from Zoho's physical stock (any count when Zoho had none). */
export function isBigChange(before: number, counted: number) {
  if (before <= 0) return counted > 0;
  return Math.abs(counted - before) / before > BIG_CHANGE_SHARE;
}

/** Why a counted quantity can't be saved, or null. Whole packs (bags, tins, cartons) only. */
export function stockCountProblem(counted: number) {
  if (!Number.isFinite(counted)) return "Enter the counted quantity";
  if (!Number.isInteger(counted)) return "Enter whole bags / packs";
  if (counted < 0) return "The count can't be negative";
  if (counted > MAX_COUNT) return "That count is too large";
  return null;
}

/** The Zoho adjustment's description, so Zoho shows who counted what and why. */
export function stockCountDescription({ godown, employee, counted, physical, reason, note }: {
  godown: string; employee: string; counted: number; physical: number; reason: string; note: string;
}) {
  const text = `${stockCountReasonLabel(reason)} at ${godown} by ${employee} (Grain Bazar staff app): counted ${counted}, Zoho had ${physical}`;
  return (note.trim() ? `${text}. ${note.trim()}` : text).slice(0, 500);
}
