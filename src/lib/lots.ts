// Lot numbers, lot-wise P&L and the average price of the stock left (client's note, 17 Nov 2026):
//   "Now batches is done but lot No is pending. For example we purchased Satish Sugars S1 Grade 340 bags, give that lot No
//    SS/S1/340/003 (Satish Sugars / Grade S1 / No. of bags purchased / PO No). Similarly we need P&L lot wise."
//   "One more menu option where average price calculation for available stock. It will show arrival price, average
//    sales/day, amount received, amount yet to recover in that lot."
// A lot is one purchase: the batch made from the bill line, with the batches sent on from it to other godowns (they carry
// its lot number). No app imports beyond the batch report's types, so the tests load it directly.
import { sumTotals, type BatchReportRow, type BatchSale, type BatchTotals } from "./batches.ts";

const r2 = (n: number) => Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------ the lot number

export type LotParts = { mill: string; grade: string; bags: string; po: string };

/** Letters, digits and . - _ only in each part (the parts are joined with "/"). */
const cleanPart = (value: string) => value.toUpperCase().replace(/[^A-Z0-9.\-_]/g, "").slice(0, 16);

/** SS/S1/340/003: the parts in order, empty ones left out. */
export function composeLotNo(parts: LotParts) {
  return [parts.mill, parts.grade, parts.bags, parts.po].map(cleanPart).filter(Boolean).join("/");
}

/** A lot number as stored: letters, digits, / . - _ and spaces, up to 60; '' clears it. Mirrors admin_set_batch_lot_no. */
export const LOT_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/ ._-]{0,59}$/;
export function lotNoProblem(lotNo: string) {
  const value = lotNo.trim();
  if (!value) return "";
  return LOT_NO_PATTERN.test(value) ? "" : "Use letters, digits and / . - _ only (up to 60)";
}

const COMPANY_WORDS = /^(pvt|private|ltd|limited|llp|co|company|and|&|the|m\/s|ms|enterprises?|traders?|agencies|agency)$/i;

/** The first letter of each word of a mill's or supplier's name: SATISH SUGARS → SS (company words left out). */
export function millCode(name: string) {
  const words = name.replace(/[^A-Za-z0-9& ]/g, " ").split(/\s+/).filter((w) => w && !COMPANY_WORDS.test(w));
  return words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 6);
}

/** The grade in a product's name: the last short code with a digit ("Sugar S1" → S1, "Rice M30 25kg" → M30). */
export function gradeOf(productName: string) {
  const codes = productName.split(/\s+/).filter((w) => /^[A-Za-z]{1,3}\d{1,3}$/.test(w));
  return (codes[codes.length - 1] ?? "").toUpperCase();
}

/** A PO number's own digits, at least three: PO-00003 → 003, 12 → 012. */
export function poDigits(poNumber: string) {
  const digits = (poNumber.match(/\d+/g) ?? []).join("").replace(/^0+(?=\d)/, "");
  return digits ? digits.padStart(3, "0") : "";
}

/**
 * What the lot number most likely is, for the admin to check: the mill from the batch's note when it starts with one
 * ("SATISH SUGARS · …", written when the bill was entered again), else from the supplier; the grade from the product;
 * the bags bought; the PO number when the batch has one (else typed by the admin).
 */
export function suggestLotParts(batch: { supplier?: string | null; notes?: string | null; product_name: string; quantity: number; zoho_po_number?: string | null }): LotParts {
  const first = (batch.notes ?? "").split("·")[0]!.trim();
  const noteMill = /^[A-Z][A-Z .&]{2,40}$/.test(first) ? first : "";
  const bags = Number.isFinite(batch.quantity) && batch.quantity > 0 ? String(Math.round(batch.quantity * 100) / 100) : "";
  return { mill: millCode(noteMill || batch.supplier || ""), grade: gradeOf(batch.product_name), bags, po: poDigits(batch.zoho_po_number ?? "") };
}

/** A stored lot number back into its parts (for editing); anything else goes into the mill box whole. */
export function splitLotNo(lotNo: string): LotParts {
  const parts = lotNo.split("/");
  if (parts.length === 4) return { mill: parts[0]!, grade: parts[1]!, bags: parts[2]!, po: parts[3]! };
  return { mill: lotNo, grade: "", bags: "", po: "" };
}

// ------------------------------------------------------------------ lots

/** The purchase batch a batch's units came from (itself when it is one): its lot number is the lot's. */
export function purchaseBatchOf<T extends { id: string; parent_batch_id?: string | null }>(batch: T, batches: T[]): T {
  const byId = new Map(batches.map((b) => [b.id, b]));
  let at = batch;
  for (let i = 0; i < 20 && at.parent_batch_id && byId.has(at.parent_batch_id); i += 1) at = byId.get(at.parent_batch_id)!;
  return at;
}

/** The batch a batch's units came from first (the purchase), following sent-on batches back. */
function rootOf(row: BatchReportRow, byId: Map<string, BatchReportRow>) {
  let at = row;
  for (let i = 0; i < 20 && at.batch.parent_batch_id && byId.has(at.batch.parent_batch_id); i += 1) at = byId.get(at.batch.parent_batch_id)!;
  return at;
}

export type Lot = BatchTotals & {
  /** The lot number, or the purchase batch's number while none is set. */
  key: string; lotNo: string; rootBatchId: string; rootCode: string; productId: string; productName: string; godowns: string[]; batchCodes: string[];
  /** Every batch of the lot (the purchase and those sent on from it). */
  batchIds: string[];
  purchaseDate: string | null; firstSale: string | null; lastSale: string | null; days: number;
  /** Units sold per day since the purchase arrived. */
  salesPerDay: number;
  /** Arrival price per unit: the bill's cost plus the lot's expenses, over the units bought (landed cost). */
  arrivalPrice: number; arrivalPriceWithGst: number;
  /** Average selling price per unit sold, before GST and with GST. */
  avgSellingPrice: number; avgSellingPriceWithGst: number;
  /** The lot's whole cost (purchase + its expenses), what has come in from paid sales, and what is still to come back. */
  totalCost: number; totalCostWithGst: number; yetToRecover: number; yetToRecoverWithGst: number;
  /** Days until the rest comes back at the money received per day so far; null when nothing came in yet or all is back. */
  daysToRecover: number | null;
};

const dayMs = 86_400_000;
const daysFrom = (from: string, to: string) => Math.max(1, Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / dayMs) + 1);

/**
 * Every lot: the purchase batch and the batches sent on from it, added up (grouped by lot number when one is set, so a
 * purchase entered on two bill lines with the same lot number is one lot). Pre-order batches waiting for their bill and
 * cancelled ones are left out: nothing has arrived.
 */
export function buildLots(rows: BatchReportRow[], today: string): Lot[] {
  const byId = new Map(rows.map((row) => [row.batch.id, row]));
  const groups = new Map<string, { root: BatchReportRow; rows: BatchReportRow[] }>();
  for (const row of rows) {
    const root = rootOf(row, byId);
    if ((root.batch.stage ?? "received") !== "received") continue;
    const lotNo = (root.batch.lot_no ?? "").trim();
    const key = lotNo ? `lot:${lotNo.toUpperCase()}` : `batch:${root.batch.id}`;
    const group = groups.get(key) ?? { root, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const lots: Lot[] = [];
  for (const [key, group] of groups) {
    const totals = sumTotals(group.rows);
    // Inherited expenses are the same money as the purchase batch's own: counted once.
    totals.inheritedExpenseValue = 0;
    const roots = group.rows.filter((row) => !row.batch.parent_batch_id || !byId.has(row.batch.parent_batch_id));
    const purchaseDate = roots.map((row) => row.batch.purchase_date ?? row.batch.created_at.slice(0, 10)).sort()[0] ?? null;
    const days = purchaseDate ? daysFrom(purchaseDate, today) : 1;
    const bought = totals.purchased;
    // 18 Nov 2026 (client's sheet): the bag cost is the bill plus the cost-of-goods expenses (transport, amali, driver
    // incentive); operating expenses are not in it. Yet to recover counts every expense.
    const goodsCost = r2(totals.purchaseValue + totals.expenseCogsValue);
    const goodsCostWithGst = r2(totals.purchaseWithGstValue + totals.expenseCogsWithGstValue);
    const totalCost = r2(totals.purchaseValue + totals.expenseValue);
    const totalCostWithGst = r2(totals.purchaseWithGstValue + totals.expenseWithGstValue);
    const perDayIn = totals.receivedWithGstValue / days;
    const yetWithGst = r2(Math.max(0, totalCostWithGst - totals.receivedWithGstValue));
    const sales = group.rows.map((row) => [row.firstSale, row.lastSale] as const);
    lots.push({
      ...totals,
      key, lotNo: (group.root.batch.lot_no ?? "").trim(), rootBatchId: group.root.batch.id, rootCode: group.root.batch.batch_code,
      productId: group.root.batch.product_id, batchIds: group.rows.map((row) => row.batch.id),
      productName: group.root.batch.product_name, godowns: [...new Set(group.rows.map((row) => row.godown))],
      batchCodes: group.rows.map((row) => row.batch.batch_code),
      purchaseDate, days,
      firstSale: sales.map(([first]) => first).filter((x): x is string => Boolean(x)).sort()[0] ?? null,
      lastSale: sales.map(([, last]) => last).filter((x): x is string => Boolean(x)).sort().pop() ?? null,
      salesPerDay: r1(totals.sold / days),
      arrivalPrice: bought > 0 ? r2(goodsCost / bought) : 0,
      arrivalPriceWithGst: bought > 0 ? r2(goodsCostWithGst / bought) : 0,
      avgSellingPrice: totals.sold > 0 ? r2(totals.sales / totals.sold) : 0,
      avgSellingPriceWithGst: totals.sold > 0 ? r2(totals.salesWithGstValue / totals.sold) : 0,
      totalCost, totalCostWithGst,
      yetToRecover: r2(Math.max(0, totalCost - totals.receivedValue)),
      yetToRecoverWithGst: yetWithGst,
      daysToRecover: yetWithGst > 0 && perDayIn > 0 ? Math.ceil(yetWithGst / perDayIn) : null,
    });
  }
  return lots.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? "") || a.key.localeCompare(b.key));
}

/** Per product: the stock left and its average arrival price (each lot's arrival price weighted by its units left). */
export type StockAverage = { productName: string; available: number; lots: number; avgArrivalPrice: number; avgArrivalPriceWithGst: number; stockValue: number; stockValueWithGst: number };
export function stockAverages(lots: Lot[]): StockAverage[] {
  const byProduct = new Map<string, StockAverage>();
  for (const lot of lots) {
    if (lot.available <= 0) continue;
    const seen = byProduct.get(lot.productName) ?? { productName: lot.productName, available: 0, lots: 0, avgArrivalPrice: 0, avgArrivalPriceWithGst: 0, stockValue: 0, stockValueWithGst: 0 };
    seen.available = Math.round((seen.available + lot.available) * 1000) / 1000;
    seen.lots += 1;
    seen.stockValue = r2(seen.stockValue + lot.available * lot.arrivalPrice);
    seen.stockValueWithGst = r2(seen.stockValueWithGst + lot.available * lot.arrivalPriceWithGst);
    byProduct.set(lot.productName, seen);
  }
  return [...byProduct.values()].map((s) => ({ ...s, avgArrivalPrice: r2(s.stockValue / s.available), avgArrivalPriceWithGst: r2(s.stockValueWithGst / s.available) }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// ------------------------------------------------------------------ outlook at today's market price (client, 19 Nov 2026)
//   "In average price and lots option make it show if we sell at current market price how much will be total loss for
//    that lot no and calculate average sales from today and goes on from here averaging continues and it should show in
//    how many days that stock would finish and how much would be profit or loss."
//   "Give averaging option manually to consider from which date we want to average and exclude select days and
//    customizable average, apart from normal averaging which is already there."

/** How sales per day are averaged: since the lot arrived (normal), or from a chosen day with some days left out. */
export type AverageMode = { kind: "normal" } | { kind: "custom"; from: string; exclude: string[] };

const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Units the lot sold on each day (India time); orders awaiting payment are not sales yet. */
export function lotDailySales(lot: Pick<Lot, "batchIds">, sales: Pick<BatchSale, "batchId" | "orderDate" | "qty" | "held">[]) {
  const ids = new Set(lot.batchIds);
  const days = new Map<string, number>();
  for (const sale of sales) {
    if (!ids.has(sale.batchId) || sale.held) continue;
    const day = istDay(sale.orderDate);
    days.set(day, Math.round(((days.get(day) ?? 0) + sale.qty) * 1000) / 1000);
  }
  return days;
}

/**
 * The average units sold a day: normal = every day since the lot arrived (today included); custom = from the chosen
 * day to today, leaving out the chosen days. Days and units counted are returned too.
 */
export function averagePerDay(daily: Map<string, number>, mode: AverageMode, purchaseDate: string | null, today: string) {
  const from = mode.kind === "custom" && /^\d{4}-\d{2}-\d{2}$/.test(mode.from) ? mode.from : (purchaseDate ?? today).slice(0, 10);
  const skip = new Set(mode.kind === "custom" ? mode.exclude : []);
  let days = 0;
  let units = 0;
  for (let day = from; day <= today && days < 3700; day = addDays(day, 1)) {
    if (skip.has(day)) continue;
    days += 1;
    units += daily.get(day) ?? 0;
  }
  return { from, days, units: Math.round(units * 1000) / 1000, perDay: days > 0 ? Math.round((units / days) * 100) / 100 : 0 };
}

/**
 * If the rest of the lot sells at today's market price: the stock left (with the units awaiting payment) at that price,
 * and the lot's whole profit or loss then = sales so far + the rest at market − purchase − every expense − nothing more,
 * before GST and with GST; and when the stock runs out at the average per day.
 */
export function marketOutlook(lot: Lot, priceWithGst: number, gstRate: number, perDay: number, today: string) {
  const r2v = (n: number) => Math.round(n * 100) / 100;
  const units = Math.max(0, lot.available + lot.held);
  const priceBefore = gstRate > 0 ? priceWithGst / (1 + gstRate / 100) : priceWithGst;
  const stockValue = r2v(units * priceBefore);
  const stockValueWithGst = r2v(units * priceWithGst);
  const daysToFinish = units <= 0 ? 0 : perDay > 0 ? Math.ceil(units / perDay) : null;
  return {
    units, priceBefore: r2v(priceBefore), stockValue, stockValueWithGst,
    // Losses and stock found are in the totals' cost already (lossValue), so only sales and costs count here.
    profit: r2v(lot.sales + stockValue - lot.totalCost),
    profitWithGst: r2v(lot.salesWithGstValue + stockValueWithGst - lot.totalCostWithGst),
    /** The price a bag must fetch for the lot to break even (no profit, no loss), with GST. */
    breakEvenWithGst: units > 0 ? r2v((lot.totalCostWithGst - lot.salesWithGstValue) / units) : 0,
    daysToFinish,
    finishDate: daysToFinish === null ? null : addDays(today, daysToFinish),
  };
}

/** A typed custom average, checked: a real day, no later than today, days left out sorted and unique. */
export function cleanAverageMode(value: unknown, today: string): AverageMode {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (v["kind"] !== "custom") return { kind: "normal" };
  const day = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && x <= today ? x : "");
  const from = day(v["from"]) || today;
  const exclude = Array.isArray(v["exclude"]) ? [...new Set(v["exclude"].map(day).filter((x) => x && x >= from))].sort().slice(0, 366) : [];
  return { kind: "custom", from, exclude };
}

/**
 * "Enter a new purchase quantity and at what price, and show stock finishes in average days, break-even, profit or loss
 * where I will end" (Sandesh, 23 Nov 2026): a product's lots with stock plus a purchase not made yet, all sold at the
 * market price. A plan only: nothing is bought or saved.
 */
export function plannedPurchaseOutlook(
  lots: { lot: Pick<Lot, "salesWithGstValue" | "totalCostWithGst" | "sales" | "totalCost">; out: ReturnType<typeof marketOutlook>; perDay: number }[],
  plan: { bags: number; priceWithGst: number },
  marketPriceWithGst: number,
  gstRate: number,
  today: string,
) {
  const r2v = (n: number) => Math.round(n * 100) / 100;
  const bags = Math.max(0, plan.bags);
  const before = (withGst: number) => (gstRate > 0 ? withGst / (1 + gstRate / 100) : withGst);
  const units = lots.reduce((sum, row) => sum + row.out.units, 0) + bags;
  const perDay = lots.reduce((sum, row) => sum + row.perDay, 0);
  const daysToFinish = units <= 0 ? 0 : perDay > 0 ? Math.ceil(units / perDay) : null;
  const newMargin = bags * (marketPriceWithGst - plan.priceWithGst);
  const profitWithGst = lots.reduce((sum, row) => sum + row.out.profitWithGst, 0) + newMargin;
  const profit = lots.reduce((sum, row) => sum + row.out.profit, 0) + bags * (before(marketPriceWithGst) - before(plan.priceWithGst));
  // What every bag left (old and new) must fetch, with GST, for no profit and no loss on all of them together.
  const stillToRecover = lots.reduce((sum, row) => sum + row.lot.totalCostWithGst - row.lot.salesWithGstValue, 0) + bags * plan.priceWithGst;
  return {
    units, bags, perDay: r2v(perDay), daysToFinish,
    finishDate: daysToFinish === null ? null : addDays(today, daysToFinish),
    purchaseValueWithGst: r2v(bags * plan.priceWithGst),
    breakEvenWithGst: units > 0 ? r2v(stillToRecover / units) : 0,
    profit: r2v(profit), profitWithGst: r2v(profitWithGst),
  };
}
