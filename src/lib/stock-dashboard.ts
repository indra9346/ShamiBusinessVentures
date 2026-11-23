/**
 * Daily stock dashboard (client's sheet, 23 Nov 2026: Batch No | Lot No | Opening stock | Sales | Undelivered | Physical
 * stock; owner: Zoho's on-hand is the master figure, our own expected balance is shown beside it with the variance, and
 * nothing is guessed when Zoho can't be read). Pure: the server reads the rows, this works out one day.
 *
 * Expected balance (what should be on the godown floor at the end of the day) =
 *   opening + receipts and returns − sent to other godowns ± adjustments − handed over.
 * Sold but not handed over yet is still on the floor (it is the "Undelivered" column).
 */

export type DashBatch = { id: string; code: string; lotNo: string; productId: string; productName: string };
export type DashMove = {
  batchId: string;
  /** When it happened (ISO). */
  at: string;
  kind: "receipt" | "return" | "sent" | "adjustment" | "sale" | "handover";
  /** Units: receipts, returns, sales and hand-overs positive; sent positive (taken off); adjustments signed. */
  qty: number;
};

export type DashRow = DashBatch & {
  opening: number; receipts: number; sent: number; adjustments: number; sales: number; handedOver: number;
  /** Sold up to the end of the day and not handed over by then. */
  undelivered: number;
  /** opening + receipts − sent ± adjustments − handed over. */
  expected: number;
};

export type DashProduct = {
  productId: string; productName: string; rows: DashRow[];
  totals: Omit<DashRow, keyof DashBatch>;
  /** Zoho's on-hand at this godown now (today only), null when it could not be read or is not today. */
  zohoOnHand: number | null;
  /** zohoOnHand − expected, null without a Zoho figure. */
  variance: number | null;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The day (YYYY-MM-DD) an ISO time falls on in India. */
export function istDay(iso: string) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10) : "";
}

/** One day's figures per batch, grouped by product. Batches with nothing at all on or before the day are left out. */
export function stockDay(batches: DashBatch[], moves: DashMove[], day: string): DashProduct[] {
  const byBatch = new Map<string, DashRow>();
  const row = (b: DashBatch) => {
    let r = byBatch.get(b.id);
    if (!r) {
      r = { ...b, opening: 0, receipts: 0, sent: 0, adjustments: 0, sales: 0, handedOver: 0, undelivered: 0, expected: 0 };
      byBatch.set(b.id, r);
    }
    return r;
  };
  const batchOf = new Map(batches.map((b) => [b.id, b]));
  const soldToDate = new Map<string, number>();
  const handedToDate = new Map<string, number>();
  for (const m of moves) {
    const b = batchOf.get(m.batchId);
    if (!b) continue;
    const d = istDay(m.at);
    if (!d || d > day) continue;
    const r = row(b);
    const before = d < day;
    const floor = m.kind === "receipt" || m.kind === "return" ? m.qty
      : m.kind === "sent" ? -m.qty
      : m.kind === "adjustment" ? m.qty
      : m.kind === "handover" ? -m.qty
      : 0;
    if (m.kind === "sale") soldToDate.set(b.id, (soldToDate.get(b.id) ?? 0) + m.qty);
    if (m.kind === "handover") handedToDate.set(b.id, (handedToDate.get(b.id) ?? 0) + m.qty);
    if (before) { r.opening += floor; continue; }
    if (m.kind === "receipt" || m.kind === "return") r.receipts += m.qty;
    else if (m.kind === "sent") r.sent += m.qty;
    else if (m.kind === "adjustment") r.adjustments += m.qty;
    else if (m.kind === "sale") r.sales += m.qty;
    else if (m.kind === "handover") r.handedOver += m.qty;
  }
  const products = new Map<string, DashProduct>();
  for (const r of byBatch.values()) {
    r.undelivered = r3(Math.max(0, (soldToDate.get(r.id) ?? 0) - (handedToDate.get(r.id) ?? 0)));
    r.expected = r3(r.opening + r.receipts - r.sent + r.adjustments - r.handedOver);
    for (const key of ["opening", "receipts", "sent", "adjustments", "sales", "handedOver"] as const) r[key] = r3(r[key]);
    // A batch long finished and untouched that day: nothing to show.
    if (r.opening === 0 && r.receipts === 0 && r.sent === 0 && r.adjustments === 0 && r.sales === 0 && r.handedOver === 0 && r.undelivered === 0 && r.expected === 0) continue;
    let p = products.get(r.productId);
    if (!p) {
      p = { productId: r.productId, productName: r.productName, rows: [], totals: { opening: 0, receipts: 0, sent: 0, adjustments: 0, sales: 0, handedOver: 0, undelivered: 0, expected: 0 }, zohoOnHand: null, variance: null };
      products.set(r.productId, p);
    }
    p.rows.push(r);
    for (const key of Object.keys(p.totals) as (keyof DashProduct["totals"])[]) p.totals[key] = r3(p.totals[key] + r[key]);
  }
  return [...products.values()]
    .map((p) => ({ ...p, rows: p.rows.sort((a, b) => a.code.localeCompare(b.code)) }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Zoho's on-hand beside the expected balance; only for today, and never a guess when Zoho gave nothing. */
export function withZoho(products: DashProduct[], onHand: Map<string, number>, isToday: boolean): DashProduct[] {
  return products.map((p) => {
    const zoho = isToday && onHand.has(p.productId) ? onHand.get(p.productId)! : null;
    return { ...p, zohoOnHand: zoho, variance: zoho === null ? null : r3(zoho - p.totals.expected) };
  });
}
