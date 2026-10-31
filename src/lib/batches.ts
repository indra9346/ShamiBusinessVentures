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
 *     the days it took to sell out.
 *   * Zoho: for items with "Track batches" ticked in Zoho, receipts, packages and adjustments name
 *     the Zoho batch (Zoho refuses them otherwise); batches made in Zoho are imported.
 *
 * Money (₹, paise): Sales = qty × the order line's rate before GST, less the order's discount in
 * proportion. Cost = qty × the batch's purchase cost. Profit = Sales − Cost of the sold units −
 * value of stock lost (count losses less gains, at cost).
 */
import type { XlsxSheet } from "./xlsx.ts";

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
};
export type BatchAllocation = { id: string; order_item_id: string; batch_id: string; reserved_quantity: number; released_quantity: number; unit_cost: number; created_at: string };
export type BatchOrderItem = { id: string; order_id: string; product_id: string | null; product_name: string; qty: number; unit_price: number; gst_rate: number };
/** JSON as stored (orders.shipping_address). */
export type JsonLike = string | number | boolean | null | { [key: string]: JsonLike | undefined } | JsonLike[];
export type BatchOrder = {
  id: string; order_no: string; created_at: string; order_status: string; payment_status: string; branch_id: string | null;
  user_id: string | null; customer_name: string | null; customer_email: string | null; customer_phone: string | null;
  shipping_address: JsonLike; subtotal: number; discount: number;
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
};

export type BatchTotals = {
  purchased: number; sold: number; delivered: number; held: number; lost: number; gained: number; available: number;
  purchaseValue: number; sales: number; costOfSold: number; lossValue: number; profit: number; stockValue: number;
};

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
};

export type BatchCustomer = {
  key: string; name: string; phone: string; email: string; address: string;
  orders: string[]; batches: string[]; qty: number; value: number; lastOrder: string;
};

const emptyTotals = (): BatchTotals => ({
  purchased: 0, sold: 0, delivered: 0, held: 0, lost: 0, gained: 0, available: 0,
  purchaseValue: 0, sales: 0, costOfSold: 0, lossValue: 0, profit: 0, stockValue: 0,
});

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
      total[key] = key.endsWith("Value") || ["sales", "costOfSold", "profit"].includes(key) ? paise(total[key] + row[key]) : qty(total[key] + row[key]);
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
}) {
  const godownName = new Map(input.godowns.map((g) => [g.id, g.name]));
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const orderById = new Map(input.orders.map((order) => [order.id, order]));
  const sales: BatchSale[] = [];
  const rows: BatchReportRow[] = [];
  const unpackedByBatch = new Map<string, number>();

  for (const batch of input.batches) {
    const t = emptyTotals();
    t.purchased = num(batch.quantity);
    t.available = num(batch.remaining_quantity);
    t.purchaseValue = paise(t.purchased * num(batch.unit_cost));
    t.stockValue = paise(t.available * num(batch.unit_cost));
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
      const share = num(order.subtotal) > 0 ? Math.max(0, 1 - num(order.discount) / num(order.subtotal)) : 1;
      const value = paise(net * num(item.unit_price) * share);
      const cost = paise(net * num(allocation.unit_cost));
      const key = customerKeyOf(order);
      sales.push({
        batchId: batch.id, batchCode: batch.batch_code, orderItemId: item.id, orderId: order.id, orderNo: order.order_no, orderDate: order.created_at,
        orderStatus: order.order_status, held, customerKey: key, customerName: order.customer_name ?? "",
        customerPhone: order.customer_phone ?? "", customerEmail: order.customer_email ?? "", customerAddress: addressLine(order.shipping_address),
        productName: item.product_name || batch.product_name, qty: net, rate: paise(num(item.unit_price) * share), value, cost,
        profit: held ? 0 : paise(value - cost),
      });
      if (held) {
        t.held = qty(t.held + net);
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
      t.lossValue = paise(t.lossValue - change * num(adjustment.unit_cost));
    }
    t.profit = paise(t.sales - t.costOfSold - t.lossValue);
    const purchaseDate = batch.purchase_date ?? istDate(batch.created_at);
    const soldOut = batch.depleted_at ? istDate(batch.depleted_at) : null;
    const ledger = qty(t.purchased - t.sold - t.held - t.lost + t.gained);
    rows.push({
      ...t,
      batch,
      godown: godownName.get(batch.branch_id ?? "") ?? (batch.branch_id || "No godown"),
      orders: orderIds.size,
      customers: customers.size,
      firstSale,
      lastSale,
      ageDays: Math.max(0, daysBetween(purchaseDate, soldOut ?? input.today)),
      daysToSellOut: soldOut ? Math.max(0, daysBetween(purchaseDate, soldOut)) : null,
      sellThrough: t.purchased > 0 ? Math.round((t.sold / t.purchased) * 1000) / 10 : 0,
      ledgerGap: qty(t.available - ledger),
      zohoGap: batch.zoho_batch_id && batch.zoho_balance !== null && batch.zoho_balance !== undefined
        ? qty(num(batch.zoho_balance) - (t.available + (unpackedByBatch.get(batch.id) ?? 0)))
        : null,
    });
  }
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
    all: sumTotals(rows),
    customers: [...customerMap.values()].sort((a, b) => b.lastOrder.localeCompare(a.lastOrder)),
  };
}

export type BatchReport = ReturnType<typeof buildBatchReport>;

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

export const BATCH_COLUMNS: [string, (row: BatchReportRow) => string | number | null][] = [
  ["Batch no.", (r) => r.batch.batch_code],
  ["Product", (r) => r.batch.product_name],
  ["Godown", (r) => r.godown],
  ["Purchased on", (r) => dmy(r.batch.purchase_date)],
  ["Supplier", (r) => r.batch.supplier],
  ["Bill / PO no.", (r) => r.batch.purchase_ref],
  ["Cost per unit (₹)", (r) => r.batch.unit_cost],
  ["Purchased", (r) => r.purchased],
  ["Sold", (r) => r.sold],
  ["Delivered", (r) => r.delivered],
  ["Awaiting payment", (r) => r.held],
  ["Lost", (r) => r.lost],
  ["Found (count gains)", (r) => r.gained],
  ["Available", (r) => r.available],
  ["Sell-through %", (r) => r.sellThrough],
  ["Purchase value (₹)", (r) => r.purchaseValue],
  ["Sales excl. GST (₹)", (r) => r.sales],
  ["Cost of sold (₹)", (r) => r.costOfSold],
  ["Loss value (₹)", (r) => r.lossValue],
  ["Profit (₹)", (r) => r.profit],
  ["Stock value (₹)", (r) => r.stockValue],
  ["Orders", (r) => r.orders],
  ["Customers", (r) => r.customers],
  ["First sale", (r) => dmy(r.firstSale ? istDate(r.firstSale) : null)],
  ["Last sale", (r) => dmy(r.lastSale ? istDate(r.lastSale) : null)],
  ["Sold out on", (r) => dmy(r.batch.depleted_at ? istDate(r.batch.depleted_at) : null)],
  ["Days to sell out", (r) => r.daysToSellOut],
  ["Age (days)", (r) => r.ageDays],
  ["Status", (r) => (r.available > 0 ? "In stock" : "Sold out")],
  ["Made in", (r) => (r.batch.source === "zoho" ? "Zoho" : "Website")],
  ["Zoho batch", (r) => (r.batch.zoho_batch_id ? "Linked" : "Website only")],
  ["Zoho balance", (r) => r.batch.zoho_balance],
];

const SALE_HEADER = ["Batch no.", "Product", "Order no.", "Order date (IST)", "Order status", "Customer", "Phone", "Email", "Address", "Qty", "Rate excl. GST (₹)", "Sales (₹)", "Cost (₹)", "Profit (₹)"];

export function batchReportSheets(report: BatchReport, meta: { generatedAt: string; scope: string }): XlsxSheet[] {
  const intro = (title: string) => [
    [title],
    [`${meta.scope}`, null, null, `Generated: ${istStamp(meta.generatedAt)} IST`],
    ["Amounts in ₹. Sales before GST, less discounts. Profit = sales − cost of the sold units − value of stock lost (at the batch's cost)."],
    [],
  ];
  const dashHead = intro("Batch report · dashboard");
  const dashCols: [string, (r: BatchTotals & { batches?: number; active?: number; averageDaysToSellOut?: number | null }) => string | number | null][] = [
    ["Batches", (r) => r.batches ?? null], ["In stock", (r) => r.active ?? null], ["Purchased", (r) => r.purchased], ["Sold", (r) => r.sold],
    ["Delivered", (r) => r.delivered], ["Awaiting payment", (r) => r.held], ["Lost", (r) => r.lost], ["Available", (r) => r.available],
    ["Purchase value (₹)", (r) => r.purchaseValue], ["Sales (₹)", (r) => r.sales], ["Cost of sold (₹)", (r) => r.costOfSold],
    ["Loss value (₹)", (r) => r.lossValue], ["Profit (₹)", (r) => r.profit], ["Stock value (₹)", (r) => r.stockValue],
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
  return [dashboard, batches, salesSheet, customers];
}

/** Losses / gains sheet (the server adds it: it needs the adjustment rows). */
export function batchAdjustmentSheet(adjustments: BatchAdjustment[], codes: Map<string, { code: string; product: string; godown: string }>): XlsxSheet {
  return {
    name: "Losses and gains",
    rows: [["Date (IST)", "Batch no.", "Product", "Godown", "Change", "Reason", "Note", "Value at cost (₹)", "By"],
      ...[...adjustments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => {
        const b = codes.get(a.batch_id);
        return [istStamp(a.created_at), b?.code ?? "", b?.product ?? "", b?.godown ?? "", num(a.qty), adjustmentReasonLabel(a.reason), a.note,
          paise(num(a.qty) * num(a.unit_cost)), a.created_by_name];
      })],
    boldRows: [0],
    widths: [17, 16, 36, 18, 8, 18, 30, 14, 18],
  };
}

export const ADJUSTMENT_REASONS: Record<string, string> = {
  stock_count: "Stock count", damaged: "Damaged / spoiled", correction: "Correction", zoho_sync: "Zoho correction", return: "Customer return",
};
export const adjustmentReasonLabel = (reason: string) => ADJUSTMENT_REASONS[reason] ?? reason;
