// Batch = stock number = one purchase bill; each item on it = a lot (client's note, 19 Nov 2026):
//   "Batch No means whatever we receive in 1 bill; there will be multiple items. Example there will be S1, S2, M1 grade
//    sugars, so make S1, S2 & these as separate lot Nos. Profit & loss should show batch wise & according to lots also.
//    Batch No is Stock No."
// Each bill line is already its own record (its lot, with its own lot number and line code); this groups them by bill.
// The stock number of a bill is the first line code it was given (e.g. CLK-031126-04 for bill SS4463's four lines).
// Units sent on to another godown stay in their bill's batch. Nothing stored changes. No app imports beyond types, so the
// tests load it directly.
import { sumTotals, type BatchRecord, type BatchReportRow, type BatchTotals } from "./batches.ts";
import { purchaseBatchOf } from "./lots.ts";

export type StockBatch = {
  /** bill:<zoho bill id>, po:<zoho PO id> (a pre-order before its bill) or lot:<batch id> (no bill). */
  key: string;
  stockNo: string;
  billNumber: string;
  poNumber: string;
  supplier: string;
  purchaseDate: string | null;
  /** The bill's lines (lots), in line-code order, each with the batches sent on from it in the scope given. */
  lots: BatchReportRow[];
  /** Sum of the lots (before and with GST). */
  totals: BatchTotals;
  /** Distinct products on the bill. */
  products: number;
};

type Batchish = Pick<BatchRecord, "id" | "batch_code" | "zoho_bill_id" | "zoho_bill_number" | "supplier" | "purchase_date"> & {
  parent_batch_id?: string | null; zoho_po_id?: string | null; zoho_po_number?: string | null;
};

/** The batch (bill) a record belongs to: its purchase batch's bill, else its PO, else the purchase batch itself. */
export function stockKeyOf<T extends Batchish>(batch: T, all: T[]) {
  const p = purchaseBatchOf(batch, all);
  if (p.zoho_bill_id) return `bill:${p.zoho_bill_id}`;
  if (p.zoho_po_id) return `po:${p.zoho_po_id}`;
  return `lot:${p.id}`;
}

const byCode = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * The batches (bills) of the rows given, newest purchase first. The stock number comes from all the bill's purchase
 * lines (not only the rows shown), so it is the same in every godown and filter.
 */
export function stockBatches(rows: BatchReportRow[], all: BatchRecord[]): StockBatch[] {
  const groups = new Map<string, BatchReportRow[]>();
  for (const row of rows) {
    const key = stockKeyOf(row.batch, all);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const purchases = new Map<string, BatchRecord[]>();
  for (const b of all) {
    if (b.parent_batch_id) continue;
    const key = stockKeyOf(b, all);
    purchases.set(key, [...(purchases.get(key) ?? []), b]);
  }
  const out: StockBatch[] = [];
  for (const [key, list] of groups) {
    const lines = (purchases.get(key) ?? list.map((r) => purchaseBatchOf(r.batch, all))).slice().sort((a, b) => byCode(a.batch_code, b.batch_code));
    const first = lines[0] ?? list[0]!.batch;
    const lots = list.slice().sort((a, b) => byCode(purchaseBatchOf(a.batch, all).batch_code, purchaseBatchOf(b.batch, all).batch_code) || byCode(a.batch.batch_code, b.batch.batch_code));
    out.push({
      key,
      stockNo: first.batch_code,
      billNumber: first.zoho_bill_number ?? "",
      poNumber: (first as Batchish).zoho_po_number ?? "",
      supplier: first.supplier ?? "",
      purchaseDate: first.purchase_date ?? null,
      lots,
      totals: sumTotals(lots),
      products: new Set(lots.map((r) => r.batch.product_id)).size,
    });
  }
  return out.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? "") || byCode(b.stockNo, a.stockNo));
}

/** The batch (bill) a lot belongs to, with all its lots in every godown. */
export function stockBatchOf(row: BatchReportRow, rows: BatchReportRow[], all: BatchRecord[]) {
  const key = stockKeyOf(row.batch, all);
  return stockBatches(rows.filter((r) => stockKeyOf(r.batch, all) === key), all)[0]!;
}

/** Gross and net profit of a set of totals, before GST and with GST (as the batch P&L shows them). */
export function profitLines(t: BatchTotals) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    sales: t.sales,
    costOfGoodsSold: r2(t.costOfSold + t.expenseOnSoldCogsValue),
    grossProfit: r2(t.profitBeforeExpenses - t.expenseOnSoldCogsValue),
    netProfit: t.profit,
    salesWithGst: t.salesWithGstValue,
    costOfGoodsSoldWithGst: r2(t.costOfSoldWithGstValue + t.expenseOnSoldCogsWithGstValue),
    grossProfitWithGst: r2(t.salesWithGstValue - t.costOfSoldWithGstValue - t.lossWithGstValue - t.expenseOnSoldCogsWithGstValue),
    netProfitWithGst: t.profitWithGstValue,
  };
}
