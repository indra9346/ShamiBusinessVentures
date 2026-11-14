/*
 * Batch / stock-number tracking (client request, 31 Oct 2026). Rules shared by the server
 * functions, the admin Batches pages, the Excel download and the tests. Kept free of app imports
 * so the node tests can load it.
 *
 *   * A purchase received at a godown is one batch with a fixed number: CLK-311026-01 = godown
 *     code, purchase date (DDMMYY), running number that day. Admin may type their own instead.
 *   * Orders take stock from the oldest batch at the order's godown first (FIFO, in the database:
 *     private.allocate_order_item_batches); stock without a batch stays unbatched.
 *   * Stock-count losses and gains are recorded per batch (oldest batch loses first, the newest
 *     batch takes a gain), so each batch shows purchased, sold, available, lost, sales, profit and
 *     the days it took to sell out. A rise in the godown's stock is a gain only beyond what its
 *     batches already hold (batchGainOf, 13 Nov 2026): a bill's batch reaching the count is not.
 *   * Zoho: for items with "Track batches" ticked in Zoho, receipts, packages and adjustments name
 *     the Zoho batch (Zoho refuses them otherwise); batches made in Zoho are imported.
 *
 * Money (₹, paise), every amount before GST so that like is compared with like:
 *   Sales = qty × the order line's rate before GST, less the order's discount in proportion.
 *   Cost = qty × the batch's purchase cost before GST (costBeforeGst). Profit = Sales − Cost of the
 *   sold units − value of stock lost (count losses less gains, at that cost).
 * A batch made from a Zoho bill can store its cost with GST ("Cost with GST", 5 Nov 2026), and its
 * order lines and stock counts copy that cost. Until 10 Nov 2026 profit took it as it was, so the
 * GST showed as a loss: Ekadantha oil bought at ₹130 with GST (₹123.81 without) and sold at ₹130
 * with GST (₹123.81 without) showed a ₹6.19 loss. The GST paid is claimed back, so it is not a cost.
 *
 * Expenses and landed cost (14 Nov 2026, spec section 9): Zoho Books expenses and bill charges tagged to a batch
 * (src/lib/batch-costs.ts) are spread over its units in paise — sold, awaiting payment, sent to other godowns, lost and
 * still in stock. Profit after expenses = sales − cost of the sold units − the expense share of the sold units − stock
 * lost (with its expense share). Expenses on unsold bags stay with the unsold stock; units sent to another godown take
 * their share with them. A pre-order batch (stage 'incoming') has bought nothing yet: its sales are costed with the
 * estimate and marked "Estimated" until its bill is matched, after which the change shows as cost variance.
 */
import type { XlsxSheet } from "./xlsx.ts";
import { apportionPaise, effectiveTagsById, type StoredCostDoc, type StoredCostTag } from "./batch-costs.ts";

export const BATCH_CODE_RE = /^[A-Z0-9][A-Z0-9/_.-]{1,39}$/;
export const normalizeBatchCode = (code: string) => code.trim().toUpperCase();
export const isBatchCode = (code: string) => BATCH_CODE_RE.test(normalizeBatchCode(code));

/** CLK-311026-01 for godown code CLK, purchase date 2026-10-31, number 1. */
export function formatBatchCode(godownCode: string, isoDate: string, n: number) {
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${godownCode.toUpperCase()}-${d}${m}${(y ?? "").slice(2)}-${String(n).padStart(2, "0")}`;
}

/** The godown code used in batch numbers: branches.code, else the id without "BR-". */
export const godownCodeOf = (branch: { id: string; code?: string | null }) =>
  (branch.code?.trim() || branch.id.replace(/^BR-/, "")).toUpperCase();

const IST_MS = 5.5 * 3600 * 1000;
export const istDate = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86_400_000);
/** Whole days from one date (YYYY-MM-DD) to another. */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

const paise = (value: number) => Math.round(value * 100) / 100;
const qty = (value: number) => Math.round(value * 1000) / 1000;
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

// ------------------------------------------------------------------ FIFO plans

export type StockBatch = { id: string; batchCode: string; purchaseDate: string | null; createdAt: string; remaining: number; zohoBatchId?: string };
export type BatchShare = { batchId: string; qty: number };

const oldestFirst = (a: StockBatch, b: StockBatch) =>
  (a.purchaseDate ?? "9999").localeCompare(b.purchaseDate ?? "9999") || a.createdAt.localeCompare(b.createdAt) || a.batchCode.localeCompare(b.batchCode);

/** A loss of `amount` units: the oldest batches with stock lose first. `rest` = units no batch holds. */
export function planBatchLoss(batches: StockBatch[], amount: number): { shares: BatchShare[]; rest: number } {
  let need = qty(Math.max(0, amount));
  const shares: BatchShare[] = [];
  for (const batch of [...batches].filter((b) => b.remaining > 0).sort(oldestFirst)) {
    if (need <= 0) break;
    const take = qty(Math.min(need, batch.remaining));
    shares.push({ batchId: batch.id, qty: -take });
    need = qty(need - take);
  }
  return { shares, rest: need };
}

/** A gain of `amount` units goes to the newest batch (none: nothing to attach it to). */
export function planBatchGain(batches: StockBatch[], amount: number): { shares: BatchShare[]; rest: number } {
  const newest = [...batches].sort(oldestFirst).at(-1);
  if (!newest || amount <= 0) return { shares: [], rest: qty(Math.max(0, amount)) };
  return { shares: [{ batchId: newest.id, qty: qty(amount) }], rest: 0 };
}

/**
 * How much of a rise in a godown's stock is a real gain for its batches (13 Nov 2026). A batch made from a Zoho bill
 * holds its units before the godown's stock shows them (Zoho's purchase receive reaches the website later, or
 * someone enters it), so a rise first covers those batch units; only what the stock holds beyond its batches is a
 * gain. Same rule as private.record_batch_stock_change in the database. `stockAfter` = the godown's stock after the
 * rise, `batches` = its batches before it.
 */
export function batchGainOf(batches: Pick<StockBatch, "remaining">[], stockAfter: number, increase: number) {
  const inBatches = batches.reduce((sum, batch) => sum + Math.max(0, num(batch.remaining)), 0);
  return qty(Math.max(0, Math.min(num(increase), num(stockAfter) - inBatches)));
}

// ------------------------------------------------------------------ Zoho batches

export type ZohoBatch = { batchId: string; batchNumber: string; balance: number; inQuantity: number; manufacturedDate: string; expiryDate: string };

/**
 * Batches of one item at one Zoho location, from GET /items/batches?item_id=…: the per-location
 * balance comes from associated_locations when present. Oldest first (Zoho ids grow over time).
 */
export function zohoBatchesAtLocation(list: unknown, locationId: string): ZohoBatch[] {
  const rows = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  const out: ZohoBatch[] = [];
  for (const row of rows) {
    const batchId = text(row["batch_id"]);
    const batchNumber = text(row["batch_number"]);
    if (!batchId || !batchNumber || text(row["status"]) === "inactive") continue;
    const locations = Array.isArray(row["associated_locations"]) ? row["associated_locations"] as Record<string, unknown>[] : [];
    const at = locations.find((loc) => text(loc["location_id"]) === locationId);
    let balance: number, inQuantity: number;
    if (at) {
      balance = num(at["balance_quantity"]);
      inQuantity = num(at["in_quantity"]);
    } else if (!locations.length && (text(row["location_id"]) === locationId || (!text(row["location_id"]) && !locationId))) {
      balance = num(row["balance_quantity"]);
      inQuantity = num(row["in_quantity"]);
    } else continue;
    out.push({
      batchId, batchNumber, balance: qty(balance), inQuantity: qty(inQuantity),
      manufacturedDate: text(row["manufactured_date"] ?? row["manufacturer_date"]), expiryDate: text(row["expiry_date"]),
    });
  }
  return out.sort((a, b) => (a.batchId.length - b.batchId.length) || a.batchId.localeCompare(b.batchId));
}

/**
 * Zoho batches for an outward movement (package, negative adjustment) of `amount` units: the
 * batches the website reserved first (as far as Zoho still holds them), then Zoho's oldest.
 * `short` > 0 means Zoho has too little batch stock at that location.
 */
export function planZohoBatchOut(zohoBatches: ZohoBatch[], amount: number, preferred: { zohoBatchId: string; qty: number }[] = []) {
  const left = new Map(zohoBatches.map((b) => [b.batchId, b.balance]));
  const lines: { batch_id: string; out_quantity: number }[] = [];
  let need = qty(Math.max(0, amount));
  const take = (batchId: string, max: number) => {
    const have = left.get(batchId) ?? 0;
    const used = qty(Math.min(need, max, have));
    if (used <= 0) return;
    left.set(batchId, qty(have - used));
    const line = lines.find((l) => l.batch_id === batchId);
    if (line) line.out_quantity = qty(line.out_quantity + used);
    else lines.push({ batch_id: batchId, out_quantity: used });
    need = qty(need - used);
  };
  for (const pref of preferred) if (need > 0) take(pref.zohoBatchId, pref.qty);
  for (const batch of zohoBatches) if (need > 0) take(batch.batchId, Infinity);
  return { lines, short: need };
}

/** Zoho batches for an inward adjustment: the newest batch at the location, else a new batch number. */
export function planZohoBatchIn(zohoBatches: ZohoBatch[], amount: number, newBatchNumber: string) {
  const newest = zohoBatches.at(-1);
  return newest
    ? [{ batch_id: newest.batchId, in_quantity: qty(amount) }]
    : [{ batch_number: newBatchNumber, in_quantity: qty(amount) }];
}

/**
 * The batch number(s) as text on a Zoho order line (copied to the invoice) or package, for items
 * Zoho does not batch-track: "Batch CLK-311026-01", or "Batches CLK-301026-01 x2, CLK-311026-01 x1".
 */
export function batchLineText(batches: { code: string; qty: number }[], lineQty: number) {
  const list = batches.filter((b) => b.code && b.qty > 0);
  if (!list.length) return "";
  if (list.length === 1 && list[0]!.qty >= lineQty) return `Batch ${list[0]!.code}`;
  return `${list.length === 1 ? "Batch" : "Batches"} ${list.map((b) => `${b.code} x${qty(b.qty)}`).join(", ")}`;
}

/** Zoho's item flag for "Track batches". */
export const zohoTracksBatches = (item: Record<string, unknown> | undefined | null) => item?.["track_batch_number"] === true;

/**
 * Package lines for a Zoho sales order: each line of a batch-tracked item names its batches —
 * the ones the website order took (by Zoho batch id), then Zoho's oldest at the order's location.
 */
export function packageLinesWithBatches(
  soLines: Record<string, unknown>[],
  reserved: Map<string, { zohoBatchId: string; qty: number }[]>,
  zohoBatchesByItem: Map<string, ZohoBatch[]>,
) {
  const used = new Map<string, number>();
  const lines: Record<string, unknown>[] = [];
  const problems: string[] = [];
  for (const line of soLines) {
    const lineId = text(line["line_item_id"]);
    const amount = num(line["quantity"]);
    if (!lineId || amount <= 0) continue;
    const itemId = text(line["item_id"]);
    if (line["track_batch_number"] !== true) {
      lines.push({ so_line_item_id: lineId, quantity: amount });
      continue;
    }
    // Two lines of the same item share the item's batches: take what earlier lines left.
    const available = (zohoBatchesByItem.get(itemId) ?? []).map((b) => ({ ...b, balance: qty(b.balance - (used.get(b.batchId) ?? 0)) }));
    const plan = planZohoBatchOut(available, amount, reserved.get(itemId) ?? []);
    for (const l of plan.lines) used.set(l.batch_id, qty((used.get(l.batch_id) ?? 0) + l.out_quantity));
    if (plan.short > 0) problems.push(`${text(line["name"]) || itemId}: Zoho has ${qty(amount - plan.short)} of ${amount} in batches at this godown`);
    lines.push({ so_line_item_id: lineId, quantity: amount, batches: plan.lines });
  }
  return { lines, problems };
}

// ------------------------------------------------------------------ report

export type BatchRecord = {
  id: string;
  batch_code: string;
  product_id: string;
  product_name: string;
  branch_id: string | null;
  quantity: number;
  remaining_quantity: number;
  unit: string;
  unit_cost: number;
  purchase_date: string | null;
  mfg_date: string | null;
  expiry_date: string | null;
  status: string;
  source: string;
  supplier: string;
  purchase_ref: string;
  notes: string;
  received_by_name: string;
  zoho_batch_id: string;
  zoho_adjustment_id: string;
  zoho_balance: number | null;
  zoho_checked_at: string | null;
  depleted_at: string | null;
  created_at: string;
  /** Batches from a Zoho bill (5 Nov 2026): both costs from the bill line, and the one chosen for unit_cost. */
  unit_cost_ex_gst?: number | null;
  unit_cost_inc_gst?: number | null;
  cost_basis?: string | null;
  zoho_bill_id?: string;
  zoho_bill_number?: string;
  bill_flag?: string;
  bill_flag_at?: string | null;
  /** A batch made by sending units from another batch (the super batch) to this godown, and that transfer. */
  parent_batch_id?: string | null;
  transfer_id?: number | null;
  /** Units this batch sent to other godowns (on the way or arrived), kept on the batch row itself. */
  sent_quantity?: number | null;
  /**
   * Pre-order batches (14 Nov 2026, src/lib/preorder.ts): stage 'incoming' = waiting for its bill (a lot), 'received' =
   * any bill batch (a matched lot too), 'cancelled' = a lot called off. expected_quantity is set on every batch that was
   * a pre-order; its first cost was the estimate (est_unit_cost_ex_gst).
   */
  stage?: string;
  expected_quantity?: number | null;
  expected_date?: string | null;
  hold_back?: number;
  selling_paused?: boolean;
  paused_reason?: string;
  est_unit_cost_ex_gst?: number | null;
  est_unit_cost_inc_gst?: number | null;
  zoho_po_id?: string;
  zoho_po_number?: string;
  zoho_po_line_id?: string;
  split_from_batch_id?: string | null;
  matched_at?: string | null;
  matched_by_name?: string;
  closed_at?: string | null;
  closed_note?: string;
  not_preorder_note?: string;
};

/** A transfer between godowns, as far as the report needs it (public.batch_transfers). */
export type BatchTransferRow = { kind: string; status: string; parent_batch_id: string | null; quantity: number | null };
export type BatchAllocation = { id: string; order_item_id: string; batch_id: string; reserved_quantity: number; released_quantity: number; unit_cost: number; created_at: string };
export type BatchOrderItem = { id: string; order_id: string; product_id: string | null; product_name: string; qty: number; unit_price: number; gst_rate: number };
/** JSON as stored (orders.shipping_address). */
export type JsonLike = string | number | boolean | null | { [key: string]: JsonLike | undefined } | JsonLike[];
export type BatchOrder = {
  id: string; order_no: string; created_at: string; order_status: string; payment_status: string; branch_id: string | null;
  user_id: string | null; customer_name: string | null; customer_email: string | null; customer_phone: string | null;
  shipping_address: JsonLike; subtotal: number; discount: number;
  /** From 7 Nov 2026 item prices include GST: the rate before GST is worked out of unit_price, and the discount came off the price with GST. */
  prices_include_gst?: boolean | null; gst_amount?: number | null;
  /** A held checkout: until when its stock stays put aside. */
  payment_hold_until?: string | null;
};
export type BatchAdjustment = { id: string; batch_id: string; qty: number; reason: string; note: string; unit_cost: number; created_at: string; created_by_name: string };
export type BatchGodown = { id: string; name: string; code?: string | null };

/** Orders whose units no longer count: nothing was sold. */
const VOID_STATUSES = ["Cancelled", "Payment Expired"];
/** Unpaid held requests: the units are put aside, not sold yet. */
const HELD_STATUSES = ["Awaiting Payment"];
/** Not packed yet, so Zoho's batch balance still includes these units. */
const UNPACKED_STATUSES = ["Awaiting Payment", "Placed", "Payment Confirmed", "Accepted"];

export type BatchSale = {
  batchId: string; batchCode: string; orderItemId: string; orderId: string; orderNo: string; orderDate: string; orderStatus: string; held: boolean;
  customerKey: string; customerName: string; customerPhone: string; customerEmail: string; customerAddress: string;
  productName: string; qty: number; rate: number; value: number; cost: number; profit: number;
  /** Held (awaiting payment): when the hold ends, if known. */
  holdUntil?: string | null;
};

export type BatchTotals = {
  /** received: units that came from another godown's batch (not a purchase); sent: units sent from this batch to other godowns. */
  purchased: number; received: number; sent: number; sold: number; delivered: number; held: number; lost: number; gained: number; available: number;
  /** A pre-order batch's units still to come (its quantity while it waits for its bill); 0 for every other batch. */
  expected: number;
  purchaseValue: number; sales: number; costOfSold: number; lossValue: number; stockValue: number;
  /** sales − cost of sold − stock lost: the profit before any expense. */
  profitBeforeExpenses: number;
  /** Profit after expenses: profitBeforeExpenses − expenses on the sold units − expenses on the units lost. */
  profit: number;
  /** Expenses tagged to this batch itself (the totals add only these: the money tagged). */
  expenseValue: number;
  /** Expenses that came with units sent here from another godown's batch. */
  inheritedExpenseValue: number;
  /** The batch's expenses (own + inherited) spread over its units, to the paisa. */
  expenseOnSoldValue: number; expenseOnHeldValue: number; expenseOnSentValue: number; expenseOnLostValue: number; expenseInStockValue: number;
  /** Of the expenses on units sent on: the part on units still on the way (no batch at the other godown yet). */
  expenseInTransitValue: number;
  /** Unsold stock at landed cost: stock value + the expenses on it. */
  landedStockValue: number;
  /** A matched pre-order: sold × (bill cost − estimate), before GST. Above 0 = the bill cost more than estimated. */
  costVarianceValue: number;
  /** A pre-order still waiting for its bill: the cost of its sold units at the estimate. */
  estimatedCostValue: number;
};

/** Where a batch's cost comes from: its estimate (a pre-order waiting for its bill), a Zoho bill, or typed in. */
export type BatchCostStatus = "estimated" | "bill" | "typed";

export type BatchReportRow = BatchTotals & {
  batch: BatchRecord;
  godown: string;
  orders: number;
  customers: number;
  firstSale: string | null;
  lastSale: string | null;
  ageDays: number | null;
  daysToSellOut: number | null;
  sellThrough: number;
  /** Website units minus what the ledger adds up to (should be 0). */
  ledgerGap: number;
  /** Zoho balance minus what Zoho should hold (website available + units on unpacked orders); null = not in Zoho. */
  zohoGap: number | null;
  costStatus: BatchCostStatus;
  /** The units the expenses are spread over per unit: expected (pre-order), received (sent here) or purchased. */
  unitBase: number;
  /** (own + inherited expenses) / unitBase, and the cost per unit before GST plus that. */
  expensePerUnit: number;
  landedUnitCost: number;
  /** Orders holding units of a pre-order batch (counts only). */
  waitingOrders: number;
  /** Money in (purchase, received, expected, expenses) minus money out (sold, held, sent, lost, stock, expenses): 0 when the ledger agrees. */
  costCheckGap: number;
};

/** One expense tag with its document, for the Expenses sheet and screens. */
export type BatchExpenseRow = {
  tagId: number; documentId: number; batchId: string; batchCode: string; source: string; date: string; account: string; reference: string;
  description: string; beforeGst: number; gst: number; claimable: boolean; cost: number; tagged: number; effective: number; method: string; flag: string; gone: boolean;
};

export type BatchCustomer = {
  key: string; name: string; phone: string; email: string; address: string;
  orders: string[]; batches: string[]; qty: number; value: number; lastOrder: string;
};

const emptyTotals = (): BatchTotals => ({
  purchased: 0, received: 0, sent: 0, sold: 0, delivered: 0, held: 0, lost: 0, gained: 0, available: 0, expected: 0,
  purchaseValue: 0, sales: 0, costOfSold: 0, lossValue: 0, stockValue: 0, profitBeforeExpenses: 0, profit: 0,
  expenseValue: 0, inheritedExpenseValue: 0, expenseOnSoldValue: 0, expenseOnHeldValue: 0, expenseOnSentValue: 0, expenseOnLostValue: 0,
  expenseInStockValue: 0, expenseInTransitValue: 0, landedStockValue: 0, costVarianceValue: 0, estimatedCostValue: 0,
});

/** Money keys that are not named …Value: summed and rounded as money, not as quantities. */
const MONEY_KEYS = ["sales", "costOfSold", "profit", "profitBeforeExpenses"];
export const isMoneyKey = (key: string) => key.endsWith("Value") || MONEY_KEYS.includes(key);

export function addressLine(address: unknown) {
  if (!address || typeof address !== "object") return "";
  const a = address as Record<string, unknown>;
  // Saved addresses and orders.shipping_address use "line"; older shapes "line1" / "address".
  return [a["line"] ?? a["line1"] ?? a["address"] ?? a["street"], a["line2"], a["landmark"], a["city"], a["district"], a["state"], a["pin"] ?? a["pincode"]]
    .map(text).map((part) => part.trim()).filter(Boolean).join(", ");
}

/** Totals of a set of batch rows (a godown, a filter, everything). */
export function sumTotals(list: BatchReportRow[]) {
  const total = emptyTotals();
  for (const row of list)
    for (const key of Object.keys(total) as (keyof BatchTotals)[])
      total[key] = isMoneyKey(key) ? paise(total[key] + row[key]) : qty(total[key] + row[key]);
  return total;
}

export const customerKeyOf = (order: BatchOrder) =>
  order.user_id || (order.customer_phone ?? "").replace(/\D/g, "").slice(-10) || (order.customer_name ?? "").trim().toLowerCase() || order.id;

export function buildBatchReport(input: {
  batches: BatchRecord[];
  allocations: BatchAllocation[];
  items: BatchOrderItem[];
  orders: BatchOrder[];
  adjustments: BatchAdjustment[];
  godowns: BatchGodown[];
  today: string;
  /** Transfers between godowns (10 Nov 2026); without them every batch is a purchase. */
  transfers?: BatchTransferRow[];
  /** Zoho expenses and bill charges (14 Nov 2026) and their tags to batches; without them no batch has expenses. */
  costDocuments?: StoredCostDoc[];
  costTags?: StoredCostTag[];
}) {
  const godownName = new Map(input.godowns.map((g) => [g.id, g.name]));
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const orderById = new Map(input.orders.map((order) => [order.id, order]));
  const sales: BatchSale[] = [];
  const rows: BatchReportRow[] = [];
  const unpackedByBatch = new Map<string, number>();
  const heldCostByBatch = new Map<string, number>();
  const waitingByBatch = new Map<string, Set<string>>();

  // Units each super batch sent to other godowns: done, or kept aside while Zoho is asked. A cancelled one came back.
  const sentFrom = new Map<string, number>();
  for (const transfer of input.transfers ?? [])
    if (transfer.kind === "split" && transfer.parent_batch_id && transfer.status !== "cancelled")
      sentFrom.set(transfer.parent_batch_id, qty((sentFrom.get(transfer.parent_batch_id) ?? 0) + num(transfer.quantity)));

  for (const batch of input.batches) {
    const t = emptyTotals();
    // A batch sent from another godown's batch received its units: the purchase is counted once, on the super batch.
    // Order lines and stock counts copied the batch's stored cost; costCopyBeforeGst takes any GST back out of it.
    const fromTransfer = Boolean(batch.parent_batch_id);
    // A pre-order batch has bought nothing yet: its units are expected, and it holds no stock value until its bill.
    const isLot = (batch.stage ?? "received") === "incoming";
    t.purchased = fromTransfer || isLot ? 0 : num(batch.quantity);
    t.expected = isLot ? num(batch.quantity) : 0;
    t.received = fromTransfer ? num(batch.quantity) : 0;
    // From the batch row when it has it: the same row as remaining_quantity, so a transfer made or cancelled while the
    // page loads can't show as a gap. Summed from the transfers otherwise.
    t.sent = batch.sent_quantity !== undefined && batch.sent_quantity !== null ? qty(num(batch.sent_quantity)) : sentFrom.get(batch.id) ?? 0;
    t.available = num(batch.remaining_quantity);
    t.purchaseValue = paise(t.purchased * costBeforeGst(batch));
    t.stockValue = isLot ? 0 : paise(t.available * costBeforeGst(batch));
    const orderIds = new Set<string>();
    const customers = new Set<string>();
    let firstSale: string | null = null, lastSale: string | null = null;

    // One sale per order line and batch: an order line that took the same batch twice (its
    // quantity was raised later) is added up into one row.
    const perLine = new Map<string, BatchAllocation>();
    for (const a of input.allocations.filter((x) => x.batch_id === batch.id)) {
      const seen = perLine.get(a.order_item_id);
      perLine.set(a.order_item_id, seen
        ? { ...seen, reserved_quantity: num(seen.reserved_quantity) + num(a.reserved_quantity), released_quantity: num(seen.released_quantity) + num(a.released_quantity) }
        : a);
    }
    for (const allocation of perLine.values()) {
      const net = qty(num(allocation.reserved_quantity) - num(allocation.released_quantity));
      if (net <= 0) continue;
      const item = itemById.get(allocation.order_item_id);
      const order = item ? orderById.get(item.order_id) : undefined;
      if (!item || !order || VOID_STATUSES.includes(order.order_status)) continue;
      if (UNPACKED_STATUSES.includes(order.order_status)) unpackedByBatch.set(batch.id, qty((unpackedByBatch.get(batch.id) ?? 0) + net));
      const held = HELD_STATUSES.includes(order.order_status);
      const inclusive = Boolean(order.prices_include_gst);
      const goods = inclusive ? num(order.subtotal) + num(order.gst_amount) : num(order.subtotal);
      const share = goods > 0 ? Math.max(0, 1 - num(order.discount) / goods) : 1;
      const rateBeforeGst = inclusive ? (num(item.unit_price) * 100) / (100 + num(item.gst_rate)) : num(item.unit_price);
      const value = paise(net * rateBeforeGst * share);
      const cost = paise(net * costCopyBeforeGst(batch, allocation.unit_cost));
      const key = customerKeyOf(order);
      sales.push({
        batchId: batch.id, batchCode: batch.batch_code, orderItemId: item.id, orderId: order.id, orderNo: order.order_no, orderDate: order.created_at,
        orderStatus: order.order_status, held, customerKey: key, customerName: order.customer_name ?? "",
        customerPhone: order.customer_phone ?? "", customerEmail: order.customer_email ?? "", customerAddress: addressLine(order.shipping_address),
        productName: item.product_name || batch.product_name, qty: net, rate: paise(rateBeforeGst * share), value, cost,
        profit: held ? 0 : paise(value - cost),
        holdUntil: held ? order.payment_hold_until ?? null : null,
      });
      if (isLot) waitingByBatch.set(batch.id, (waitingByBatch.get(batch.id) ?? new Set<string>()).add(order.id));
      if (held) {
        t.held = qty(t.held + net);
        heldCostByBatch.set(batch.id, paise((heldCostByBatch.get(batch.id) ?? 0) + cost));
        continue;
      }
      t.sold = qty(t.sold + net);
      if (order.order_status === "Delivered") t.delivered = qty(t.delivered + net);
      t.sales = paise(t.sales + value);
      t.costOfSold = paise(t.costOfSold + cost);
      orderIds.add(order.id);
      customers.add(key);
      if (!firstSale || order.created_at < firstSale) firstSale = order.created_at;
      if (!lastSale || order.created_at > lastSale) lastSale = order.created_at;
    }
    for (const adjustment of input.adjustments.filter((a) => a.batch_id === batch.id)) {
      const change = num(adjustment.qty);
      if (change < 0) t.lost = qty(t.lost - change);
      else t.gained = qty(t.gained + change);
      t.lossValue = paise(t.lossValue - change * costCopyBeforeGst(batch, adjustment.unit_cost));
    }
    t.profitBeforeExpenses = paise(t.sales - t.costOfSold - t.lossValue);
    t.profit = t.profitBeforeExpenses;
    if (isLot) t.estimatedCostValue = t.costOfSold;
    // A matched pre-order: the units sold before its bill was matched were costed with the estimate, and take the bill's
    // cost now; the difference on those is the cost variance (spec 2.7). Units sold after the match never had an estimate
    // (review fix: they were counted too).
    if (!isLot && batch.expected_quantity !== null && batch.expected_quantity !== undefined && batch.matched_at
      && batch.est_unit_cost_ex_gst !== null && batch.est_unit_cost_ex_gst !== undefined) {
      const matchedAt = Date.parse(batch.matched_at);
      let preMatch = 0;
      for (const a of input.allocations) {
        if (a.batch_id !== batch.id || !(Date.parse(a.created_at) <= matchedAt)) continue;
        const net = qty(num(a.reserved_quantity) - num(a.released_quantity));
        const item = itemById.get(a.order_item_id);
        const order = item ? orderById.get(item.order_id) : undefined;
        if (net <= 0 || !order || VOID_STATUSES.includes(order.order_status) || HELD_STATUSES.includes(order.order_status)) continue;
        preMatch = qty(preMatch + net);
      }
      t.costVarianceValue = paise(Math.min(preMatch, t.sold) * (costBeforeGst(batch) - num(batch.est_unit_cost_ex_gst)));
    }
    const purchaseDate = batch.purchase_date ?? istDate(batch.created_at);
    const ledger = qty(t.purchased + t.expected + t.received - t.sent - t.sold - t.held - t.lost + t.gained);
    const handled = t.purchased + t.expected + t.received - t.sent;
    // Sold out means the units it kept were sold: a batch emptied by sending everything to other godowns is not.
    const soldOut = batch.depleted_at && handled > 0.0005 && !isLot ? istDate(batch.depleted_at) : null;
    const unitBase = isLot ? t.expected : fromTransfer ? t.received : t.purchased;
    rows.push({
      ...t,
      costStatus: isLot || batch.stage === "cancelled" ? "estimated" : batchCostBasis(batch) === "typed" ? "typed" : "bill",
      unitBase,
      expensePerUnit: 0,
      landedUnitCost: paise(costBeforeGst(batch)),
      waitingOrders: waitingByBatch.get(batch.id)?.size ?? 0,
      costCheckGap: 0,
      batch,
      godown: godownName.get(batch.branch_id ?? "") ?? (batch.branch_id || "No godown"),
      orders: orderIds.size,
      customers: customers.size,
      firstSale,
      lastSale,
      ageDays: Math.max(0, daysBetween(purchaseDate, soldOut ?? input.today)),
      daysToSellOut: soldOut ? Math.max(0, daysBetween(purchaseDate, soldOut)) : null,
      sellThrough: handled > 0 ? Math.round((t.sold / handled) * 1000) / 10 : 0,
      ledgerGap: qty(t.available - ledger),
      zohoGap: batch.zoho_batch_id && batch.zoho_balance !== null && batch.zoho_balance !== undefined
        ? qty(num(batch.zoho_balance) - (t.available + (unpackedByBatch.get(batch.id) ?? 0)))
        : null,
    });
  }
  const expenses = spreadExpenses(rows, input.costDocuments ?? [], input.costTags ?? [], heldCostByBatch);
  rows.sort((a, b) => (b.batch.purchase_date ?? "").localeCompare(a.batch.purchase_date ?? "") || b.batch.batch_code.localeCompare(a.batch.batch_code));
  sales.sort((a, b) => b.orderDate.localeCompare(a.orderDate));

  const godowns = input.godowns.map((g) => {
    const list = rows.filter((row) => row.batch.branch_id === g.id);
    const soldOut = list.filter((row) => row.daysToSellOut !== null);
    return {
      godownId: g.id, godown: g.name, batches: list.length, active: list.filter((row) => row.available > 0).length,
      averageDaysToSellOut: soldOut.length ? Math.round((soldOut.reduce((s, row) => s + (row.daysToSellOut ?? 0), 0) / soldOut.length) * 10) / 10 : null,
      ...sumTotals(list),
    };
  });

  const customerMap = new Map<string, BatchCustomer>();
  for (const sale of sales) {
    const c = customerMap.get(sale.customerKey) ?? {
      key: sale.customerKey, name: sale.customerName, phone: sale.customerPhone, email: sale.customerEmail, address: sale.customerAddress,
      orders: [], batches: [], qty: 0, value: 0, lastOrder: sale.orderDate,
    };
    if (!c.orders.includes(sale.orderNo)) c.orders.push(sale.orderNo);
    if (!c.batches.includes(sale.batchCode)) c.batches.push(sale.batchCode);
    if (!sale.held) {
      c.qty = qty(c.qty + sale.qty);
      c.value = paise(c.value + sale.value);
    }
    if (sale.orderDate > c.lastOrder) c.lastOrder = sale.orderDate;
    customerMap.set(sale.customerKey, c);
  }
  return {
    rows,
    sales,
    godowns,
    expenses,
    all: sumTotals(rows),
    customers: [...customerMap.values()].sort((a, b) => b.lastOrder.localeCompare(a.lastOrder)),
  };
}

/**
 * Each batch's expenses spread over its units (spec 9.2), and its profit after expenses, landed cost and cost check
 * (9.3). A batch's own tags (at most Zoho's current amount, effectiveTagAmounts) plus what came with units sent to it
 * are split in paise over [sold, awaiting payment, sent on, lost, in stock]; with no units at all it all stays in stock.
 * The part on units sent on goes to the batches made from them by units received, and the rest is in transit. Parents
 * are done before the batches they sent to. Fills in the rows; returns one row per tag.
 */
function spreadExpenses(rows: BatchReportRow[], docs: StoredCostDoc[], tags: StoredCostTag[], heldCost: Map<string, number>): BatchExpenseRow[] {
  const byId = new Map(rows.map((row) => [row.batch.id, row]));
  const effective = effectiveTagsById(docs, tags);
  const own = new Map<string, number>();
  for (const tag of tags)
    if (byId.has(tag.batch_id)) own.set(tag.batch_id, paise((own.get(tag.batch_id) ?? 0) + (effective.get(tag.id) ?? 0)));
  const children = new Map<string, BatchReportRow[]>();
  for (const row of rows) {
    const parent = row.batch.parent_batch_id;
    if (parent && byId.has(parent)) children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const inherited = new Map<string, number>();
  const done = new Set<string>();
  const visit = (row: BatchReportRow) => {
    if (done.has(row.batch.id)) return;
    done.add(row.batch.id);
    const c = costBeforeGst(row.batch);
    row.expenseValue = own.get(row.batch.id) ?? 0;
    row.inheritedExpenseValue = inherited.get(row.batch.id) ?? 0;
    const total = paise(row.expenseValue + row.inheritedExpenseValue);
    const weights = [row.sold, row.held, row.sent, row.lost, row.available].map((w) => Math.max(0, w));
    const [onSold = 0, onHeld = 0, onSent = 0, onLost = 0, inStock = 0] = total === 0 ? [0, 0, 0, 0, 0]
      : weights.every((w) => w === 0) ? [0, 0, 0, 0, total] : apportionPaise(total, weights);
    row.expenseOnSoldValue = onSold;
    row.expenseOnHeldValue = onHeld;
    row.expenseOnSentValue = onSent;
    row.expenseOnLostValue = onLost;
    row.expenseInStockValue = inStock;
    const kids = children.get(row.batch.id) ?? [];
    if (onSent !== 0) {
      const inTransit = Math.max(0, qty(row.sent - kids.reduce((sum, kid) => sum + kid.received, 0)));
      const parts = apportionPaise(onSent, [...kids.map((kid) => kid.received), inTransit]);
      kids.forEach((kid, i) => inherited.set(kid.batch.id, paise((inherited.get(kid.batch.id) ?? 0) + parts[i]!)));
      row.expenseInTransitValue = parts[kids.length] ?? 0;
    }
    row.profit = paise(row.profitBeforeExpenses - onSold - onLost);
    row.landedStockValue = paise(row.stockValue + inStock);
    // Per unit the expense is actually spread over (sold, held, sent, lost and in stock: units found in a count too), so
    // unsold stock at landed cost = available × landed cost (review fix: it divided by the units bought).
    const spreadOver = weights.reduce((sum, w) => sum + w, 0);
    const perUnitBase = spreadOver > 0 ? spreadOver : row.unitBase;
    row.expensePerUnit = perUnitBase > 0 ? paise(total / perUnitBase) : 0;
    row.landedUnitCost = paise(c + (perUnitBase > 0 ? total / perUnitBase : 0));
    // Money in = money out when every unit is accounted for: the difference is the ledger gap at cost.
    const isLot = (row.batch.stage ?? "received") === "incoming";
    const moneyIn = row.purchaseValue + paise(row.received * c) + paise(row.expected * c) + total;
    const moneyOut = row.costOfSold + (heldCost.get(row.batch.id) ?? 0) + paise(row.sent * c) + row.lossValue
      + (isLot ? paise(row.available * c) : row.stockValue) + onSold + onHeld + onSent + onLost + inStock;
    row.costCheckGap = paise(moneyIn - moneyOut);
    for (const kid of kids) visit(kid);
  };
  for (const row of rows) if (!row.batch.parent_batch_id || !byId.has(row.batch.parent_batch_id)) visit(row);
  for (const row of rows) visit(row);

  const docOf = new Map(docs.map((d) => [d.id, d]));
  const out: BatchExpenseRow[] = [];
  for (const tag of tags) {
    const row = byId.get(tag.batch_id);
    const doc = docOf.get(tag.document_id);
    if (!row || !doc) continue;
    out.push({
      tagId: tag.id, documentId: doc.id, batchId: row.batch.id, batchCode: row.batch.batch_code, source: doc.source, date: doc.doc_date,
      account: doc.account_name, reference: doc.doc_number, description: doc.description, beforeGst: num(doc.amount_before_gst), gst: num(doc.gst_amount),
      claimable: doc.gst_override ?? doc.gst_claimable, cost: num(doc.cost_amount), tagged: num(tag.amount), effective: effective.get(tag.id) ?? 0,
      method: tag.method, flag: doc.flag, gone: Boolean(doc.gone_at),
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.documentId - b.documentId || a.batchCode.localeCompare(b.batchCode));
}

export type BatchReport = ReturnType<typeof buildBatchReport>;

/** One product at one godown: the units its batches hold next to the godown's stock on the website. */
export type GodownStockCheck = {
  godownId: string; godown: string; productId: string; productName: string;
  inBatches: number; godownStock: number;
  /** godownStock − inBatches: below 0 = batch units the godown's stock does not show; above 0 = units without a batch. */
  difference: number;
};

/**
 * The live check behind the Batches page (13 Nov 2026): for every product with batches at a godown, whether the
 * godown's stock and its batches agree. They differ while a bill's units have not reached the godown's stock yet
 * (Zoho's purchase receive not synced), after stock was taken out in Zoho, or when stock has no batch.
 */
export function godownStockChecks(rows: BatchReportRow[], stockOf: (productId: string, godownId: string) => number): GodownStockCheck[] {
  const groups = new Map<string, GodownStockCheck>();
  for (const row of rows) {
    const godownId = row.batch.branch_id ?? "";
    // Received batches only (14 Nov 2026): a pre-order batch's bags are not at the godown yet, and a cancelled one has none.
    if (!godownId || (row.batch.stage ?? "received") !== "received") continue;
    const key = `${godownId}|${row.batch.product_id}`;
    const seen = groups.get(key) ?? {
      godownId, godown: row.godown, productId: row.batch.product_id, productName: row.batch.product_name,
      inBatches: 0, godownStock: qty(num(stockOf(row.batch.product_id, godownId))), difference: 0,
    };
    seen.inBatches = qty(seen.inBatches + row.available);
    groups.set(key, seen);
  }
  return [...groups.values()]
    .map((check) => ({ ...check, difference: qty(check.godownStock - check.inBatches) }))
    .sort((a, b) => a.godown.localeCompare(b.godown) || a.productName.localeCompare(b.productName));
}

// ------------------------------------------------------------------ which cost a batch's profit uses

/** "ex_gst" / "inc_gst" for a batch made from a bill; "typed" for one whose cost was typed in (before 5 Nov 2026). */
export type BatchCostBasis = "ex_gst" | "inc_gst" | "typed";
export const batchCostBasis = (batch: Pick<BatchRecord, "cost_basis">): BatchCostBasis =>
  batch.cost_basis === "inc_gst" ? "inc_gst" : batch.cost_basis === "ex_gst" ? "ex_gst" : "typed";
export const costBasisName = (batch: Pick<BatchRecord, "cost_basis">) =>
  ({ ex_gst: "Cost without GST", inc_gst: "Cost with GST", typed: "Cost typed in" } as const)[batchCostBasis(batch)];

type CostFields = Pick<BatchRecord, "cost_basis" | "unit_cost" | "unit_cost_ex_gst" | "unit_cost_inc_gst">;

/**
 * A cost an order line or a stock count copied from the batch, before GST. Only a bill batch stored "with GST"
 * has GST in it: a copy of its cost with GST (or without) is its cost without GST (₹130 or ₹123.81 → ₹123.81),
 * and any other figure (a cost edited by hand) is taken as with GST and scaled the same way (× 123.81 / 130).
 * Every other batch's cost is already before GST, or was typed in and is taken as it is.
 */
export function costCopyBeforeGst(batch: CostFields, copied: number | string | null | undefined) {
  const cost = num(copied);
  if (batchCostBasis(batch) !== "inc_gst") return cost;
  const ex = num(batch.unit_cost_ex_gst), inc = num(batch.unit_cost_inc_gst);
  if (!(ex > 0 && inc > 0)) return cost;
  if (Math.abs(cost - ex) < 0.005 || Math.abs(cost - inc) < 0.005) return ex;
  return cost * (ex / inc);
}

/** The batch's purchase cost per unit before GST: what its profit is worked out with. */
export const costBeforeGst = (batch: CostFields) => costCopyBeforeGst(batch, batch.unit_cost);

/** The batch's purchase cost per unit with GST, when the bill gave it (null for a cost typed in). */
export const costWithGst = (batch: CostFields) => (num(batch.unit_cost_inc_gst) > 0 ? num(batch.unit_cost_inc_gst) : null);

/**
 * The cost bases among some batches. Bill batches are all costed before GST for profit whichever cost they
 * show, so only a cost typed in by hand (before 5 Nov 2026, with or without GST, nobody can tell) needs saying.
 */
export function costBasesOf(rows: { batch: Pick<BatchRecord, "cost_basis"> }[]) {
  return [...new Set(rows.map((row) => (batchCostBasis(row.batch) === "typed" ? "typed" : "bill")))].sort();
}

/** Batches, orders and customers matching a search: batch number, product, order number, customer name / phone / email. */
export function searchBatchReport(report: BatchReport, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return { rows: report.rows, sales: report.sales, customers: report.customers };
  const digits = q.replace(/\D/g, "");
  const saleHit = (s: BatchSale) =>
    s.orderNo.toLowerCase().includes(q) || s.customerName.toLowerCase().includes(q) || s.customerEmail.toLowerCase().includes(q) ||
    (digits.length >= 4 && s.customerPhone.replace(/\D/g, "").includes(digits));
  const sales = report.sales.filter((s) => saleHit(s) || s.batchCode.toLowerCase().includes(q));
  const batchIds = new Set(sales.map((s) => s.batchId));
  const rows = report.rows.filter((row) => batchIds.has(row.batch.id) || row.batch.batch_code.toLowerCase().includes(q)
    || row.batch.product_name.toLowerCase().includes(q) || row.batch.supplier.toLowerCase().includes(q) || row.batch.purchase_ref.toLowerCase().includes(q));
  const keys = new Set(report.sales.filter(saleHit).map((s) => s.customerKey));
  return { rows, sales, customers: report.customers.filter((c) => keys.has(c.key)) };
}

// ------------------------------------------------------------------ Excel

const istStamp = (iso: string) => {
  const d = new Date(Date.parse(iso) + IST_MS);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};
const dmy = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("-") : "");

const STAGE_NAMES: Record<string, string> = { incoming: "Pre-order (waiting for its bill)", received: "Received", cancelled: "Cancelled pre-order" };
export const COST_STATUS_NAMES: Record<BatchCostStatus, string> = { estimated: "Estimated", bill: "From bill", typed: "Typed" };
const METHOD_NAMES: Record<string, string> = { amount: "Typed amount", percent: "Percent", bags: "By bags", value: "By value", weight: "By weight", split: "Split at match" };
export const costMethodName = (method: string) => METHOD_NAMES[method] ?? method;

export const BATCH_COLUMNS: [string, (row: BatchReportRow) => string | number | null][] = [
  ["Batch no.", (r) => r.batch.batch_code],
  ["Product", (r) => r.batch.product_name],
  ["Godown", (r) => r.godown],
  ["Purchased on", (r) => dmy(r.batch.purchase_date)],
  ["Supplier", (r) => r.batch.supplier],
  ["Bill / PO no.", (r) => r.batch.purchase_ref],
  ["Cost per unit excl. GST (₹)", (r) => costBeforeGst(r.batch)],
  ["Cost per unit incl. GST (₹)", (r) => costWithGst(r.batch)],
  ["Cost shown on the batch", (r) => costBasisName(r.batch)],
  ["Stage", (r) => STAGE_NAMES[r.batch.stage ?? "received"] ?? r.batch.stage ?? ""],
  ["Expected qty", (r) => (r.batch.expected_quantity === null || r.batch.expected_quantity === undefined ? null : num(r.batch.expected_quantity))],
  ["Expected by", (r) => dmy(r.batch.expected_date ?? null)],
  ["Matched on", (r) => dmy(r.batch.matched_at ? istDate(r.batch.matched_at) : null)],
  ["Est. cost/unit excl. GST (₹)", (r) => (r.batch.est_unit_cost_ex_gst === null || r.batch.est_unit_cost_ex_gst === undefined ? null : num(r.batch.est_unit_cost_ex_gst))],
  ["Cost status", (r) => COST_STATUS_NAMES[r.costStatus]],
  ["Purchased", (r) => r.purchased],
  ["Expected (pre-order)", (r) => r.expected],
  ["Received from another godown", (r) => r.received],
  ["Sent to other godowns", (r) => r.sent],
  ["Sold", (r) => r.sold],
  ["Delivered", (r) => r.delivered],
  ["Awaiting payment", (r) => r.held],
  ["Lost", (r) => r.lost],
  ["Found (count gains)", (r) => r.gained],
  ["Available", (r) => r.available],
  ["Sell-through %", (r) => r.sellThrough],
  ["Purchase value excl. GST (₹)", (r) => r.purchaseValue],
  ["Sales excl. GST (₹)", (r) => r.sales],
  ["Cost of sold excl. GST (₹)", (r) => r.costOfSold],
  ["Loss value excl. GST (₹)", (r) => r.lossValue],
  ["Profit before expenses (₹)", (r) => r.profitBeforeExpenses],
  // Two columns, so each adds up across batches (review fix: own + inherited counted a sent unit's expense twice).
  ["Expenses tagged here (₹)", (r) => r.expenseValue],
  ["Expenses with units received (₹)", (r) => r.inheritedExpenseValue],
  ["Expense per unit (₹)", (r) => r.expensePerUnit],
  ["Landed cost per unit (₹)", (r) => r.landedUnitCost],
  ["Expenses on sold (₹)", (r) => r.expenseOnSoldValue],
  ["Expenses on lost (₹)", (r) => r.expenseOnLostValue],
  ["Expenses in unsold stock (₹)", (r) => r.expenseInStockValue],
  ["Profit after expenses (₹)", (r) => r.profit],
  ["Stock value excl. GST (₹)", (r) => r.stockValue],
  ["Unsold stock at landed cost (₹)", (r) => r.landedStockValue],
  ["Cost variance on sold (₹)", (r) => r.costVarianceValue],
  ["Orders", (r) => r.orders],
  ["Customers", (r) => r.customers],
  ["First sale", (r) => dmy(r.firstSale ? istDate(r.firstSale) : null)],
  ["Last sale", (r) => dmy(r.lastSale ? istDate(r.lastSale) : null)],
  ["Sold out on", (r) => dmy(r.batch.depleted_at && r.daysToSellOut !== null ? istDate(r.batch.depleted_at) : null)],
  ["Days to sell out", (r) => r.daysToSellOut],
  ["Age (days)", (r) => r.ageDays],
  ["Status", (r) => (r.batch.stage === "incoming" ? "Pre-order" : r.batch.stage === "cancelled" ? "Cancelled" : r.available > 0 ? "In stock" : "Sold out")],
  ["Made in", (r) => (r.batch.source === "zoho" ? "Zoho" : "Website")],
  ["Zoho batch", (r) => (r.batch.zoho_batch_id ? "Linked" : "Website only")],
  ["Zoho balance", (r) => r.batch.zoho_balance],
];

const SALE_HEADER = ["Batch no.", "Product", "Order no.", "Order date (IST)", "Order status", "Customer", "Phone", "Email", "Address", "Qty", "Rate excl. GST (₹)", "Sales excl. GST (₹)", "Cost excl. GST (₹)", "Profit (₹)"];

export function batchReportSheets(report: BatchReport, meta: { generatedAt: string; scope: string }): XlsxSheet[] {
  const intro = (title: string) => [
    [title],
    [`${meta.scope}`, null, null, `Generated: ${istStamp(meta.generatedAt)} IST`],
    ["Amounts in ₹, all before GST. Sales less discounts. Profit after expenses = sales − cost of the sold units (the bill's cost without GST; GST paid on purchases is claimed back) − the expenses on the sold units − value of stock lost with its expenses. Expenses tagged from Zoho Books and supplier bills are spread over each batch's units: those on unsold units stay with the unsold stock. A pre-order batch's sales are costed with its estimate until its bill is matched."],
    [],
  ];
  const dashHead = intro("Batch report · dashboard");
  const dashCols: [string, (r: BatchTotals & { batches?: number; active?: number; averageDaysToSellOut?: number | null }) => string | number | null][] = [
    ["Batches", (r) => r.batches ?? null], ["In stock", (r) => r.active ?? null], ["Purchased", (r) => r.purchased], ["Expected (pre-order)", (r) => r.expected], ["Sold", (r) => r.sold],
    ["Delivered", (r) => r.delivered], ["Awaiting payment", (r) => r.held], ["Lost", (r) => r.lost], ["Available", (r) => r.available],
    ["Purchase value excl. GST (₹)", (r) => r.purchaseValue], ["Sales excl. GST (₹)", (r) => r.sales], ["Cost of sold excl. GST (₹)", (r) => r.costOfSold],
    ["Loss value excl. GST (₹)", (r) => r.lossValue], ["Profit before expenses (₹)", (r) => r.profitBeforeExpenses],
    ["Expenses tagged (₹)", (r) => r.expenseValue], ["Expenses on sold (₹)", (r) => r.expenseOnSoldValue], ["Expenses in unsold stock (₹)", (r) => r.expenseInStockValue],
    ["Profit after expenses (₹)", (r) => r.profit], ["Stock value excl. GST (₹)", (r) => r.stockValue], ["Unsold stock at landed cost (₹)", (r) => r.landedStockValue],
    ["Cost variance on sold (₹)", (r) => r.costVarianceValue],
    ["Avg. days to sell out", (r) => r.averageDaysToSellOut ?? null],
  ];
  const dashboard: XlsxSheet = {
    name: "Dashboard",
    rows: [
      ...dashHead,
      ["Godown", ...dashCols.map(([label]) => label)],
      ...report.godowns.map((g) => [g.godown, ...dashCols.map(([, value]) => value(g))]),
      ["All godowns", ...dashCols.map(([, value]) => value({ ...report.all, batches: report.rows.length, active: report.rows.filter((r) => r.available > 0).length }))],
    ],
    boldRows: [0, dashHead.length, dashHead.length + report.godowns.length + 1],
    widths: [26, ...dashCols.map(([label]) => Math.max(10, Math.min(20, label.length + 2)))],
  };
  const batches: XlsxSheet = {
    name: "Batches",
    rows: [BATCH_COLUMNS.map(([label]) => label), ...report.rows.map((row) => BATCH_COLUMNS.map(([, value]) => value(row)))],
    boldRows: [0],
    widths: BATCH_COLUMNS.map(([label], i) => (i === 1 ? 40 : Math.max(10, Math.min(22, label.length + 2)))),
  };
  const salesSheet: XlsxSheet = {
    name: "Sales per batch",
    rows: [SALE_HEADER, ...report.sales.map((s) => [
      s.batchCode, s.productName, s.orderNo, istStamp(s.orderDate), s.held ? "Awaiting payment (not sold yet)" : s.orderStatus,
      s.customerName, s.customerPhone, s.customerEmail, s.customerAddress, s.qty, s.rate, s.value, s.cost, s.profit,
    ])],
    boldRows: [0],
    widths: [16, 36, 26, 17, 16, 22, 14, 26, 48, 7, 12, 12, 12, 12],
  };
  const perBatchCustomers = new Map<string, { batch: string; product: string; name: string; phone: string; email: string; address: string; orders: Set<string>; qty: number; value: number }>();
  for (const s of report.sales) {
    if (s.held) continue;
    const key = `${s.batchCode}|${s.customerKey}`;
    const c = perBatchCustomers.get(key) ?? { batch: s.batchCode, product: s.productName, name: s.customerName, phone: s.customerPhone, email: s.customerEmail, address: s.customerAddress, orders: new Set<string>(), qty: 0, value: 0 };
    c.orders.add(s.orderNo);
    c.qty = qty(c.qty + s.qty);
    c.value = paise(c.value + s.value);
    perBatchCustomers.set(key, c);
  }
  const customers: XlsxSheet = {
    name: "Customers per batch",
    rows: [["Batch no.", "Product", "Customer", "Phone", "Email", "Address", "Orders", "Qty", "Sales (₹)"],
      ...[...perBatchCustomers.values()].sort((a, b) => a.batch.localeCompare(b.batch) || a.name.localeCompare(b.name))
        .map((c) => [c.batch, c.product, c.name, c.phone, c.email, c.address, [...c.orders].join(", "), c.qty, c.value])],
    boldRows: [0],
    widths: [16, 36, 22, 14, 26, 48, 30, 7, 12],
  };
  // One row per tag (spec 9.4): the Zoho document, the batch, what was tagged and what it counts for now.
  const codes = new Set(report.rows.map((r) => r.batch.id));
  const expenses: XlsxSheet = {
    name: "Expenses",
    // The document's own amounts on its first row only, so a column adds up to what was spent (review fix).
    rows: [["Date", "Account", "Reference", "From", "Before GST (₹)", "GST (₹)", "GST claimable", "Document cost (₹)", "Batch no.", "Tagged (₹)", "Counted now (₹)", "Method", "Flag"],
      ...report.expenses.filter((e) => codes.has(e.batchId)).map((e, i, all) => {
        const first = all.findIndex((x) => x.documentId === e.documentId) === i;
        return [
          dmy(e.date), e.account, e.reference, e.source === "bill" ? "Supplier bill" : "Zoho Books expense", first ? e.beforeGst : null, first ? e.gst : null,
          e.claimable ? "Yes" : "No", first ? (e.gone ? 0 : e.cost) : null, e.batchCode, e.tagged, e.effective, costMethodName(e.method),
          e.flag || (e.gone ? "Deleted in Zoho" : ""),
        ];
      })],
    boldRows: [0],
    widths: [11, 28, 16, 18, 12, 10, 10, 12, 16, 12, 12, 14, 40],
  };
  // Pre-order batches and their remainders (spec 9.4): counts of waiting orders only, no customer details.
  const lots = report.rows.filter((r) => r.batch.expected_quantity !== null && r.batch.expected_quantity !== undefined)
    .sort((a, b) => (a.batch.expected_date ?? "").localeCompare(b.batch.expected_date ?? "") || a.batch.batch_code.localeCompare(b.batch.batch_code));
  const codeOf = new Map(report.rows.map((r) => [r.batch.id, r.batch.batch_code]));
  const preorders: XlsxSheet = {
    name: "Pre-orders",
    rows: [["Batch no.", "Product", "Godown", "Stage", "First expected qty", "Quantity now", "Expected by", "Sold ahead", "Waiting orders", "Est. cost/unit excl. GST (₹)",
      "Bill cost/unit excl. GST (₹)", "Matched on", "Bill no.", "Remainder of", "Cost variance on sold (₹)"],
      ...lots.map((r) => {
        const b = r.batch;
        const lot = b.stage === "incoming";
        return [b.batch_code, b.product_name, r.godown, STAGE_NAMES[b.stage ?? "received"] ?? b.stage ?? "", num(b.expected_quantity), num(b.quantity), dmy(b.expected_date ?? null),
          lot ? qty(num(b.quantity) - num(b.remaining_quantity)) : r.sold, r.waitingOrders,
          b.est_unit_cost_ex_gst === null || b.est_unit_cost_ex_gst === undefined ? null : num(b.est_unit_cost_ex_gst),
          lot || b.stage === "cancelled" ? null : costBeforeGst(b), dmy(b.matched_at ? istDate(b.matched_at) : null),
          lot ? "" : b.zoho_bill_number || "", b.split_from_batch_id ? codeOf.get(b.split_from_batch_id) ?? "" : "", r.costVarianceValue];
      })],
    boldRows: [0],
    widths: [18, 36, 22, 22, 10, 10, 12, 10, 10, 12, 12, 12, 14, 18, 12],
  };
  return [dashboard, batches, salesSheet, customers, expenses, preorders];
}

/** Losses / gains sheet (the server adds it: it needs the adjustment rows). */
export function batchAdjustmentSheet(adjustments: BatchAdjustment[], codes: Map<string, { code: string; product: string; godown: string; batch?: CostFields }>): XlsxSheet {
  return {
    name: "Losses and gains",
    rows: [["Date (IST)", "Batch no.", "Product", "Godown", "Change", "Reason", "Note", "Value at cost excl. GST (₹)", "By"],
      ...[...adjustments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => {
        const b = codes.get(a.batch_id);
        // The stock count copied the batch's stored cost; costCopyBeforeGst takes any GST out of it.
        return [istStamp(a.created_at), b?.code ?? "", b?.product ?? "", b?.godown ?? "", num(a.qty), adjustmentReasonLabel(a.reason), a.note,
          paise(num(a.qty) * (b?.batch ? costCopyBeforeGst(b.batch, a.unit_cost) : num(a.unit_cost))), a.created_by_name];
      })],
    boldRows: [0],
    widths: [17, 16, 36, 18, 8, 18, 30, 14, 18],
  };
}

export const ADJUSTMENT_REASONS: Record<string, string> = {
  stock_count: "Stock count", damaged: "Damaged / spoiled", correction: "Correction", zoho_sync: "Zoho correction", return: "Customer return",
};
export const adjustmentReasonLabel = (reason: string) => ADJUSTMENT_REASONS[reason] ?? reason;
