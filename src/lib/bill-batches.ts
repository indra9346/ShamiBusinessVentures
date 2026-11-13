/*
 * Batches from Zoho bills (client request, 5 Nov 2026). Stock comes in only through Zoho bills; a
 * batch records where a bill's units came from and what they cost, and never changes stock on
 * either side. Pure rules shared by the server functions, the admin Batches screen and the tests,
 * so they hold no app imports.
 *
 *   * One bill line = one batch, at most once (the database refuses a second batch for a line).
 *   * Unit cost comes from the line alone: taxable amount (qty x rate less the line's own discount)
 *     / qty, without GST, or with the line's GST added. A discount or a round-off on the whole
 *     bill is shown apart and kept out of unit cost, with a warning, never spread over the lines.
 *   * Both costs are stored on the batch, with the one the admin chose for that bill
 *     ("cost_basis"); profit uses the chosen one and says which.
 */

export type CostBasis = "ex_gst" | "inc_gst";
export const COST_BASES: CostBasis[] = ["ex_gst", "inc_gst"];
export const costBasisLabel = (basis: string) => (basis === "inc_gst" ? "Cost with GST" : "Cost without GST");
export const isCostBasis = (value: unknown): value is CostBasis => value === "ex_gst" || value === "inc_gst";

const paise = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const qtyRound = (value: number) => Math.round(value * 1000) / 1000;
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(/[,%\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

export type BillLine = {
  lineId: string;
  itemId: string;
  name: string;
  hsn: string;
  unit: string;
  /** "inventory" for stock items; anything else (e.g. "sales_and_purchases") holds no stock. Blank: Zoho did not say. */
  itemType: string;
  qty: number;
  /** Rate per unit before GST and before the line discount. */
  rate: number;
  /** qty x rate. */
  gross: number;
  /** The line's own discount in rupees, and how Zoho wrote it ("₹35.00" or "10%"). */
  discount: number;
  discountLabel: string;
  /** gross less the line discount: what GST is charged on. */
  taxable: number;
  gstPct: number;
  interState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  /** taxable + GST. */
  lineTotal: number;
  unitExGst: number;
  unitIncGst: number;
};

export type BillPlan = {
  billId: string;
  billNumber: string;
  vendorName: string;
  date: string;
  locationId: string;
  /** The Zoho location's name, when Zoho gives it. */
  locationName: string;
  status: string;
  modifiedAt: string;
  subTotal: number;
  taxTotal: number;
  total: number;
  /** Discount on the whole bill (not on a line): shown apart, never in unit cost. */
  billDiscount: number;
  /** Adjustment / round-off on the whole bill: shown apart, never in unit cost. */
  adjustment: number;
  interState: boolean;
  lines: BillLine[];
  warnings: string[];
};

/** Zoho says intra- or inter-state on the bill; failing that an IGST tax name on a line means inter-state. */
function billIsInterState(bill: Record<string, unknown>, lines: Record<string, unknown>[]) {
  const spec = text(bill["tax_specification"]).toLowerCase();
  if (spec === "inter") return true;
  if (spec === "intra") return false;
  return lines.some((line) => /^igst/i.test(text(line["tax_name"])));
}

/** One bill line with its price breakup and unit costs. */
export function billLinePlan(line: Record<string, unknown>, interState: boolean): BillLine {
  const qty = qtyRound(num(line["quantity"]));
  const rate = num(line["rate"]);
  const gross = paise(qty * rate);
  const rawDiscount = text(line["discount"]).trim();
  const isPercent = rawDiscount.endsWith("%");
  // Zoho's item_total is the line after its own discount, before GST: trust it over our own arithmetic.
  const discountFromZoho = line["discount_amount"] !== undefined && line["discount_amount"] !== "" ? num(line["discount_amount"])
    : isPercent ? paise(gross * num(rawDiscount) / 100) : num(rawDiscount);
  const taxable = line["item_total"] !== undefined && line["item_total"] !== "" ? paise(num(line["item_total"])) : paise(gross - discountFromZoho);
  const discount = paise(gross - taxable);
  const gstPct = num(line["tax_percentage"]);
  const gst = paise(taxable * gstPct / 100);
  const half = paise(gst / 2);
  return {
    lineId: text(line["line_item_id"]),
    itemId: text(line["item_id"]),
    name: text(line["name"]) || text(line["item_name"]),
    hsn: text(line["hsn_or_sac"]),
    unit: text(line["unit"]),
    itemType: text(line["item_type"]),
    qty, rate, gross, discount,
    discountLabel: discount === 0 ? "" : isPercent ? rawDiscount : `₹${discount.toFixed(2)}`,
    taxable, gstPct, interState,
    cgst: interState ? 0 : half,
    sgst: interState ? 0 : paise(gst - half),
    igst: interState ? gst : 0,
    gst,
    lineTotal: paise(taxable + gst),
    unitExGst: qty > 0 ? paise(taxable / qty) : 0,
    unitIncGst: qty > 0 ? paise((taxable + gst) / qty) : 0,
  };
}

/** A Zoho bill (GET /bills/:id) as the Receive purchase screen shows it, with what needs the admin's eye. */
export function billPlan(raw: Record<string, unknown>): BillPlan {
  const rawLines = Array.isArray(raw["line_items"]) ? raw["line_items"] as Record<string, unknown>[] : [];
  const interState = billIsInterState(raw, rawLines);
  const lines = rawLines.map((line) => billLinePlan(line, interState));
  const entityLevel = text(raw["discount_type"]) !== "item_level";
  // With line-level discounts Zoho may also report their sum on the bill: that is not a second discount.
  const billDiscount = entityLevel ? paise(num(raw["discount_amount"] ?? raw["discount"])) : 0;
  const adjustment = paise(num(raw["adjustment"]));
  const total = paise(num(raw["total"]));
  const warnings: string[] = [];
  if (billDiscount !== 0)
    warnings.push(`This bill has a discount of ₹${billDiscount.toFixed(2)} on the whole bill, not on a line. It is not in the unit costs below. Ask for it to be put on the right line in Zoho, or accept the costs as they are.`);
  if (adjustment !== 0)
    warnings.push(`Round-off / adjustment of ₹${adjustment.toFixed(2)} on the whole bill is kept out of the unit costs.`);
  const linesTotal = paise(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  if (total && Math.abs(paise(linesTotal - billDiscount + adjustment) - total) > 1)
    warnings.push(`The lines add up to ₹${linesTotal.toFixed(2)}, but the bill total is ₹${total.toFixed(2)}. Check the bill in Zoho before creating batches.`);
  const status = text(raw["status"]).toLowerCase();
  if (status === "void") warnings.push("This bill is void in Zoho. Batches cannot be made from it.");
  return {
    billId: text(raw["bill_id"]),
    billNumber: text(raw["bill_number"]),
    vendorName: text(raw["vendor_name"]),
    date: text(raw["date"]).slice(0, 10),
    locationId: text(raw["location_id"] ?? raw["branch_id"]),
    locationName: text(raw["location_name"] ?? raw["branch_name"]),
    status,
    modifiedAt: text(raw["last_modified_time"]),
    subTotal: paise(num(raw["sub_total"])),
    taxTotal: paise(num(raw["tax_total"])),
    total, billDiscount, adjustment, interState, lines, warnings,
  };
}

export const costOf = (line: Pick<BillLine, "unitExGst" | "unitIncGst">, basis: CostBasis) => (basis === "inc_gst" ? line.unitIncGst : line.unitExGst);

/** Why a bill line cannot become a batch, or "" when it can. */
export function lineBlocker(line: BillLine, info: { productId: string; zohoTracksBatches: boolean; batchCode: string }) {
  if (info.batchCode) return `Done: batch ${info.batchCode}`;
  if (!line.itemId || !info.productId) return "This Zoho item is not a website product";
  if (line.itemType && line.itemType !== "inventory") return "No batch: not a stock item in Zoho";
  if (info.zohoTracksBatches) return "Zoho tracks batches for this item: its batch comes in from Zoho";
  if (!(line.qty > 0)) return "No quantity on this line";
  return "";
}

/** A bill in the recent-bills list (GET /bills): only what the list shows. */
export type BillSummary = { billId: string; billNumber: string; vendorName: string; date: string; total: number; status: string; locationId: string; locationName: string; modifiedAt: string };
export function billSummary(raw: Record<string, unknown>): BillSummary {
  return {
    billId: text(raw["bill_id"]), billNumber: text(raw["bill_number"]), vendorName: text(raw["vendor_name"]),
    date: text(raw["date"]).slice(0, 10), total: paise(num(raw["total"])), status: text(raw["status"]).toLowerCase(),
    locationId: text(raw["location_id"] ?? raw["branch_id"]), locationName: text(raw["location_name"] ?? raw["branch_name"]),
    modifiedAt: text(raw["last_modified_time"]),
  };
}

/**
 * What changed about a bill since its batches were made, for the flag on those batches:
 * "" when nothing did. `now` = the bill as Zoho has it, or null when Zoho no longer has it.
 */
export function billChange(stored: { modifiedAt: string; total: number }, now: { status: string; modifiedAt: string; total: number } | null) {
  if (!now) return "Bill deleted in Zoho";
  if (now.status === "void") return "Bill voided in Zoho";
  if (stored.total && Math.abs(now.total - stored.total) > 0.004) return `Bill total changed in Zoho (₹${stored.total.toFixed(2)} → ₹${now.total.toFixed(2)})`;
  if (stored.modifiedAt && now.modifiedAt && now.modifiedAt !== stored.modifiedAt) return BILL_EDITED;
  return "";
}

/** A flag billLinesChange gave: one of the batches' own bill lines changed in Zoho. */
export const isBillLineFlag = (flag: string) => /^Bill (line|quantity|cost) (of|for) batch /.test(flag);

/** billChange's answer when only Zoho's edit time moved: the server then compares the batch lines (billLinesChange). */
export const BILL_EDITED = "Bill edited in Zoho after its batches were made";

/**
 * A bill whose edit time moved, read in full: whether the lines its batches were made from are still as they were
 * (13 Nov 2026). A purchase receive, a payment or a note touches the bill's edit time too; that is not a change to
 * the batch. "" = the batch lines are unchanged, else what changed.
 */
export function billLinesChange(
  batches: { batchCode: string; lineId: string; itemId: string; quantity: number; unitExGst: number | null }[],
  bill: Pick<BillPlan, "lines">,
) {
  const lines = new Map(bill.lines.map((line) => [line.lineId, line]));
  for (const batch of batches) {
    const line = lines.get(batch.lineId);
    if (!line) return `Bill line of batch ${batch.batchCode} was removed in Zoho`;
    if (batch.itemId && line.itemId && line.itemId !== batch.itemId) return `Bill line of batch ${batch.batchCode} now has another item in Zoho`;
    // The batch keeps its quantity to 2 decimals (numeric(14,2)); Zoho's line may have 3.
    if (Math.abs(Math.round(line.qty * 100) / 100 - batch.quantity) > 0.0005) return `Bill quantity for batch ${batch.batchCode} changed in Zoho (${batch.quantity} → ${line.qty})`;
    if (batch.unitExGst !== null && Math.abs(line.unitExGst - batch.unitExGst) > 0.004)
      return `Bill cost for batch ${batch.batchCode} changed in Zoho (₹${batch.unitExGst.toFixed(2)} → ₹${line.unitExGst.toFixed(2)} before GST)`;
  }
  return "";
}

/** Why a batch cannot be deleted, or "" when it can. Mirrors admin_delete_batch in the database. */
export function batchDeleteBlocker<A extends { reserved_quantity: number; released_quantity: number }>(batch: { quantity: number; remaining_quantity: number }, allocations: A[], adjustments: number,
  orderOf?: (allocation: A) => { order_status: string; payment_status: string } | undefined, inTransfer = false) {
  // Its units are at a godown in Zoho because of a transfer: deleting it would lose them here (10 Nov 2026).
  if (inTransfer) return "This batch is part of a transfer between godowns, so it is kept for the record.";
  const held = allocations.reduce((sum, a) => sum + Math.max(0, a.reserved_quantity - a.released_quantity), 0);
  if (held > 0) return "Orders have taken stock from this batch, so it can't be deleted.";
  // Allowed when every order that used it was cancelled or expired with nothing paid (the database checks money too).
  const closed = (order: { order_status: string; payment_status: string } | undefined) =>
    Boolean(order && ["Cancelled", "Payment Expired"].includes(order.order_status) && !["Paid", "Partially Paid", "Refunded"].includes(order.payment_status));
  if (allocations.length > 0 && !(orderOf && allocations.every((a) => closed(orderOf(a))))) return "Orders have used this batch before, so it is kept for their records.";
  if (adjustments > 0) return "Stock counts have changed this batch, so it is kept for their records.";
  if (Math.abs(batch.quantity - batch.remaining_quantity) > 0.0005) return "This batch's units have moved, so it can't be deleted.";
  return "";
}
