/*
 * Pre-order batches (client, "Approved", 14 Nov 2026): goods ordered from a supplier but not yet at the godown are sold
 * under a batch made in advance (a "lot", batches.stage = 'incoming'); when the bill and the bags arrive the bill line is
 * matched to the lot. These are the database's rules (supabase/migrations/20261114110000_preorder_batches.sql) as pure
 * functions, for the screens and the tests. No app imports, so the node tests load this file directly.
 *
 * The stock model per godown G and product P (spec section 2):
 *   Z  Zoho's available stock at G's location (read fresh, not floored)
 *   W  units of website orders at G that Zoho does not hold yet (no sales order beyond a draft, or holding lot units
 *      without a live invoice), united with the server's snapshot taken before it read Zoho
 *   U  units of P's lots at G still to come (their quantity)
 *   I  arriving units not sold or held (the lots' remaining)
 *   T  everything at G that may be promised (branch_stock.free_total)
 *   held  a rise in Zoho the website has not explained (a bill typed in Zoho before its match): never sold as ready
 * At a Zoho reading: hold step, then T = Z - held - W + U. Ready (branch_stock.stock) = max(0, T - I); arriving
 * (branch_stock.incoming) = min(sellable lot units, T). Profit is always before GST (not here: src/lib/batches.ts).
 */

export const PREORDER_SETTING_KEY = "preorder";
export type PreorderSettings = { enabled: boolean; graceDays: number; requireAck: boolean };
export const DEFAULT_PREORDER_SETTINGS: PreorderSettings = { enabled: false, graceDays: 0, requireAck: true };

/** The public "preorder" setting, read defensively (as private.preorder_on / preorder_grace / preorder_require_ack). */
export function parsePreorderSettings(value: unknown): PreorderSettings {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const grace = Number(row["graceDays"]);
  return {
    enabled: row["enabled"] === true || String(row["enabled"]).toLowerCase() === "true",
    graceDays: Number.isInteger(grace) ? Math.min(14, Math.max(0, grace)) : 0,
    requireAck: !(row["requireAck"] === false || String(row["requireAck"]).toLowerCase() === "false"),
  };
}

/** Postgres round(): half away from zero. */
export function roundTo(value: number, places: number) {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** places;
  const out = Math.sign(value) * Math.round(Math.abs(value) * f + 1e-7) / f;
  return out === 0 ? 0 : out;
}
const r2 = (value: number) => roundTo(value, 2);
const r3 = (value: number) => roundTo(value, 3);
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));

// ------------------------------------------------------------------ dates (always India time, as private.ist_today)

const IST_OFFSET_MS = 330 * 60_000;
/** Today's date in India (YYYY-MM-DD). */
export const istToday = (nowMs: number = Date.now()) => new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** YYYY-MM-DD plus whole days. */
export function addDays(iso: string, days: number) {
  if (!isIsoDate(iso)) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Nov" (this year) or "20 Nov 2027"; "20 Nov 2026" with full = true (the database's 'DD Mon YYYY'). */
export function dayLabel(iso: string | null | undefined, options: { full?: boolean | undefined; todayIst?: string | undefined } = {}) {
  const value = text(iso).slice(0, 10);
  if (!isIsoDate(value)) return "";
  const [y, m, d] = value.split("-");
  const month = MONTHS[Number(m) - 1] ?? m;
  const sameYear = !options.full && (options.todayIst ?? istToday()).slice(0, 4) === y;
  return sameYear ? `${Number(d)} ${month}` : `${d} ${month} ${y}`;
}

// ------------------------------------------------------------------ the hold step and the total

export type HoldStepInput = { zohoLast: number; held: number; reading: number; explained: number; rise?: number | undefined };
export type HoldStep = { rise: number; left: number; held: number; zohoLast: number };

/**
 * The hold step (spec 2.4, private.watch_step): a rise Zoho shows that this action did not bring (explained) is held;
 * falls never reduce held. left = explained units Zoho does not show (dropped and logged, never carried as credit).
 * rise: the rise to hold as apply_reading measures it; by default Zoho's own change since the last reading.
 */
export function holdStep({ zohoLast, held, reading, explained, rise }: HoldStepInput): HoldStep {
  const z = r3(reading);
  const e = Math.max(0, r3(explained));
  const up = Math.max(0, r3(rise ?? z - zohoLast));
  return { rise: up, left: Math.max(0, r3(e - (held + up))), held: Math.max(0, r3(held + up - e)), zohoLast: z };
}

/** T at a reading (spec 2.3): Z - held - W + U, plus a website edit still waiting to go to Zoho. Not floored. */
export function pairTotal({ reading, held, waiting, unbilled, pendingDelta = 0 }: { reading: number; held: number; waiting: number; unbilled: number; pendingDelta?: number }) {
  return r2(r3(reading) - held - waiting + unbilled + pendingDelta);
}

/**
 * The rise a reading holds, measured against the website's own total (the database's change to spec 2.4, never above
 * the spec's total): (Z - held - W + U) - (T now - a waiting website edit). Every website-side change already moved T,
 * so what is left is Zoho's own change.
 */
export function readingRise({ reading, held, waiting, unbilled, total, pendingDelta = 0 }: { reading: number; held: number; waiting: number; unbilled: number; total: number; pendingDelta?: number }) {
  return r3(r3(reading) - held - waiting + unbilled - (total - pendingDelta));
}

export type WatchState = { zohoLast: number; held: number };
/** One Zoho reading of a watched pair (private.apply_reading): hold step, then T. */
export function applyReading({ watch, reading, waiting, unbilled, total, pendingDelta = 0, explained = 0 }: {
  watch: WatchState; reading: number; waiting: number; unbilled: number; total: number; pendingDelta?: number; explained?: number;
}) {
  const rise = readingRise({ reading, held: watch.held, waiting, unbilled, total, pendingDelta });
  const step = holdStep({ zohoLast: watch.zohoLast, held: watch.held, reading, explained, rise });
  return { ...step, total: pairTotal({ reading, held: step.held, waiting, unbilled, pendingDelta }) };
}

/** The hold a new watch row starts with (watch_open): any rise in Zoho since the website's last pull. */
export const openingHold = ({ reading, totalBefore, waiting }: { reading: number; totalBefore: number; waiting: number }) =>
  Math.max(0, r3(reading - (totalBefore + waiting)));

// ------------------------------------------------------------------ lots: selling, ready and arriving

export type LotStage = "incoming" | "received" | "cancelled";
export type Lot = {
  id: string;
  code: string;
  stage: LotStage | string;
  quantity: number;
  remaining: number;
  holdBack: number;
  expectedDate: string;
  paused: boolean;
  pausedReason?: string | undefined;
  createdAt?: string | undefined;
};
export type PreorderClock = { todayIst: string; graceDays: number; on: boolean };

/** private.lot_accepting: a lot takes new pre-orders while incoming, not paused, not past its date (+ grace), feature on. */
export function lotAccepting(lot: Lot, clock: PreorderClock) {
  return lot.stage === "incoming" && !lot.paused && isIsoDate(lot.expectedDate)
    && addDays(lot.expectedDate, clock.graceDays) >= clock.todayIst && clock.on;
}

/** private.lot_sellable: arriving units still open to pre-order. */
export const lotSellable = (lot: Lot, clock: PreorderClock) => (lotAccepting(lot, clock) ? Math.max(0, r2(lot.remaining - lot.holdBack)) : 0);

/** A lot past its expected date (+ grace) with no bill: new pre-orders stopped, customers see "Running late". */
export const lotOverdue = (lot: Pick<Lot, "stage" | "expectedDate">, clock: Pick<PreorderClock, "todayIst" | "graceDays">) =>
  lot.stage === "incoming" && isIsoDate(lot.expectedDate) && addDays(lot.expectedDate, clock.graceDays) < clock.todayIst;

const byLotOrder = (a: Lot, b: Lot) =>
  a.expectedDate.localeCompare(b.expectedDate) || text(a.createdAt).localeCompare(text(b.createdAt)) || a.code.localeCompare(b.code);

export type ArrivingDetail = { by: string; qty: number };

/**
 * Ready and arriving from the total and the pair's lots (private.branch_stock_derive):
 *   ready = max(0, T - I), arriving = max(0, min(sellable, T)), detail by expected date trimmed to arriving,
 *   raw = T - I (below 0: promised units neither in stock nor on the way, "oversold").
 * With no lot the total is the ready stock, as before pre-orders.
 */
export function deriveSplit({ total, lots, todayIst, graceDays, on }: { total: number; lots: Lot[] } & PreorderClock) {
  const open = lots.filter((lot) => lot.stage === "incoming");
  const t = r2(total);
  if (open.length === 0) return { ready: Math.max(0, t), incoming: 0, detail: [] as ArrivingDetail[], raw: t, unbilled: 0, arriving: 0 };
  const clock = { todayIst, graceDays, on };
  const unbilled = r2(open.reduce((sum, lot) => sum + lot.quantity, 0));
  const arriving = r2(open.reduce((sum, lot) => sum + lot.remaining, 0));
  const byDate = new Map<string, number>();
  for (const lot of [...open].sort(byLotOrder)) {
    const s = lotSellable(lot, clock);
    if (s > 0) byDate.set(lot.expectedDate, r2((byDate.get(lot.expectedDate) ?? 0) + s));
  }
  const sellable = r2([...byDate.values()].reduce((sum, qty) => sum + qty, 0));
  const incoming = Math.max(0, Math.min(sellable, t));
  return { ready: Math.max(0, r2(t - arriving)), incoming, detail: trimDetail([...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([by, qty]) => ({ by, qty })), incoming), raw: r2(t - arriving), unbilled, arriving };
}

/** [{by, qty}] trimmed, earliest first, so the quantities add up to total (private.trim_detail). */
export function trimDetail(detail: ArrivingDetail[], total: number) {
  let left = Math.max(0, total);
  const out: ArrivingDetail[] = [];
  for (const entry of detail) {
    if (left <= 0) break;
    const qty = Math.min(left, entry.qty);
    if (qty <= 0) continue;
    out.push({ by: entry.by, qty });
    left = r2(left - qty);
  }
  return out;
}

export type TakeLineResult =
  | { ok: true; ready: number; preorder: number; by: string | null; takes: { lotId: string; qty: number }[] }
  | { ok: false; reason: "not_enough" | "needs_ack" | "changed"; by: string | null };

/**
 * What one order line takes (private.take_order_line): ready units first (whole units), the rest from the lots that
 * accept pre-orders, earliest expected first. allowed = the pre-order units the customer agreed to (their tick).
 */
export function takeLine({ qty, ready, total, lots, allowed, clock, routingOn = true }: {
  qty: number; ready: number; total: number; lots: Lot[]; allowed: number; clock: PreorderClock; routingOn?: boolean;
}): TakeLineResult {
  const readyPart = Math.min(qty, Math.max(0, Math.floor(ready)));
  const pre = r2(qty - readyPart);
  if (pre <= 0) return { ok: true, ready: readyPart, preorder: 0, by: null, takes: [] };
  const open = lots.filter((lot) => lot.stage === "incoming").sort(byLotOrder);
  const sellable = r2(open.reduce((sum, lot) => sum + lotSellable(lot, clock), 0));
  const firstBy = open.find((lot) => lotSellable(lot, clock) > 0)?.expectedDate ?? null;
  if (!clock.on || !routingOn) return { ok: false, reason: "not_enough", by: null };
  if (pre > Math.max(0, allowed)) return { ok: false, reason: sellable > 0 ? "needs_ack" : "not_enough", by: firstBy };
  if (pre > Math.min(sellable, Math.max(0, total - readyPart))) return { ok: false, reason: "changed", by: firstBy };
  let need = pre;
  let lastBy = null as string | null;
  const takes: { lotId: string; qty: number }[] = [];
  for (const lot of open) {
    if (need <= 0) break;
    const take = Math.min(need, lotSellable(lot, clock));
    if (take <= 0) continue;
    takes.push({ lotId: lot.id, qty: take });
    need = r2(need - take);
    lastBy = !lastBy || lot.expectedDate > lastBy ? lot.expectedDate : lastBy;
  }
  if (need > 0) return { ok: false, reason: "changed", by: firstBy };
  return { ok: true, ready: readyPart, preorder: pre, by: lastBy, takes };
}

// ------------------------------------------------------------------ matching a bill line to a lot (spec 6)

export type MatchRest = "coming" | "none";
export type MatchCase = "exact" | "over" | "short_none" | "short_coming" | "refused";
export type MatchPlan =
  | { ok: true; case: MatchCase; quantity: number; remaining: number; move: number; remainder: { quantity: number; remaining: number } | null }
  | { ok: false; case: "refused"; short: number };

/**
 * A bill line of Qb units matched to a lot of Q with S sold or held on it (private.match_incoming_line):
 *   Qb = Q: plain match.  Qb > Q: the batch grows; the extra units are ready stock.
 *   S <= Qb < Q, nothing more coming: the batch shrinks to Qb.
 *   Qb < Q, the rest still coming: a remainder lot of Q - Qb; units sold beyond Qb move to it.
 *   Qb < S, nothing more coming: refused (the orders short of S - Qb).
 */
export function matchPlan({ Q, S, Qb, rest }: { Q: number; S: number; Qb: number; rest: MatchRest }): MatchPlan {
  const restNow: MatchRest = Qb >= Q ? "none" : rest;
  if (Qb < Q && restNow === "none" && Qb < S) return { ok: false, case: "refused", short: r2(S - Qb) };
  if (restNow === "coming") {
    const move = Math.max(0, r2(S - Qb));
    return { ok: true, case: "short_coming", quantity: Qb, remaining: r2(Qb - (S - move)), move, remainder: { quantity: r2(Q - Qb), remaining: r2(Q - Qb - move) } };
  }
  return { ok: true, case: Qb === Q ? "exact" : Qb > Q ? "over" : "short_none", quantity: Qb, remaining: r2(Qb - S), move: 0, remainder: null };
}

/**
 * The cost line of a match (spec 10, Receive purchase): the bill's cost before GST against the lot's estimate, and what
 * it does to the profit on the units already sold. Before GST on both sides, to the paisa.
 */
export function matchCostChange({ estimate, bill, sold }: { estimate: number; bill: number; sold: number }) {
  const perUnit = r2(bill - estimate);
  const profit = r2(-perUnit * sold);
  return { perUnit, profit, sold };
}

export type LotAllocation = { orderNo: string; qty: number; awaitingPayment: boolean; createdAt: string; id?: string };
/**
 * Which orders' units move to the remainder when a short bill leaves "the rest still coming" (move_lot_allocations):
 * orders still awaiting payment first, then the newest. Returns [{orderNo, qty}] in that order.
 */
export function unitsThatMove(allocations: LotAllocation[], move: number) {
  let need = move;
  const out: { orderNo: string; qty: number }[] = [];
  const ordered = [...allocations].sort((a, b) => Number(b.awaitingPayment) - Number(a.awaitingPayment)
    || b.createdAt.localeCompare(a.createdAt) || text(b.id).localeCompare(text(a.id)));
  for (const a of ordered) {
    if (need <= 0) break;
    const m = Math.min(need, a.qty);
    if (m <= 0) continue;
    const same = out.find((row) => row.orderNo === a.orderNo);
    if (same) same.qty = r2(same.qty + m); else out.push({ orderNo: a.orderNo, qty: m });
    need = r2(need - m);
  }
  return out;
}

export type CandidateLot = {
  id: string; code: string; productId: string; branchId: string; branchName?: string | undefined; quantity: number; remaining: number;
  expectedDate: string; supplier: string; poId: string; poNumber?: string | undefined; stage: string; pausedReason?: string | undefined;
  createdAt?: string | undefined; estUnitCostExGst?: number | null | undefined; holdBack?: number | undefined;
};
export type MatchCandidate = CandidateLot & { here: boolean; poMatch: boolean; qtyMatch: boolean; vendorMatch: boolean; sold: number; rank: number; note: string };

/**
 * The pre-order lots a bill line may be matched to, best first (spec 6.2): same product, waiting for a bill; the lot's
 * PO is the bill's, then the same quantity, then the same supplier, then the earliest expected date. Only lots at the
 * unloading godown can be matched there; the others are listed with where to unload instead.
 */
export function matchCandidates(line: { productId: string; qty: number; poId?: string | undefined },
  bill: { vendorName: string; poIds?: string[] | undefined }, lots: CandidateLot[], godownId: string): MatchCandidate[] {
  const pos = new Set([...(bill.poIds ?? []), ...(line.poId ? [line.poId] : [])].filter(Boolean));
  const vendor = bill.vendorName.trim().toLowerCase();
  const list = lots.filter((lot) => lot.stage === "incoming" && lot.productId === line.productId).map((lot) => {
    const here = lot.branchId === godownId;
    const poMatch = Boolean(lot.poId) && pos.has(lot.poId);
    const qtyMatch = Math.abs(lot.quantity - roundTo(line.qty, 2)) < 0.005;
    const vendorMatch = Boolean(vendor) && lot.supplier.trim().toLowerCase() === vendor;
    const note = !here ? `at ${lot.branchName || lot.branchId}: choose ${lot.branchName || "that godown"} as the unloading godown`
      : lot.pausedReason === "receiving" ? "being received from another bill" : "";
    return { ...lot, here, poMatch, qtyMatch, vendorMatch, sold: r2(lot.quantity - lot.remaining), rank: 0, note };
  });
  list.sort((a, b) => Number(b.here) - Number(a.here) || Number(b.poMatch) - Number(a.poMatch) || Number(b.qtyMatch) - Number(a.qtyMatch)
    || Number(b.vendorMatch) - Number(a.vendorMatch) || a.expectedDate.localeCompare(b.expectedDate) || text(a.createdAt).localeCompare(text(b.createdAt))
    || a.code.localeCompare(b.code));
  return list.map((lot, index) => ({ ...lot, rank: index + 1 }));
}

/** What a bill line does by default: match the top candidate at the unloading godown, else make a new batch. */
export function defaultLineAction(candidates: MatchCandidate[]) {
  const top = candidates.find((c) => c.here && c.pausedReason !== "receiving");
  return top ? { action: "match" as const, matchBatchId: top.id } : { action: "new" as const, matchBatchId: "" };
}

/** Why a lot can't be cancelled, or "" (admin_cancel_incoming_batch). */
export function closeBlocker(lot: Pick<Lot, "stage" | "code" | "pausedReason">, facts: { waiting: number; tagged: boolean }) {
  if (lot.stage !== "incoming") return `Batch ${lot.code} is not waiting for its bill`;
  if (lot.pausedReason === "receiving") return `Batch ${lot.code} is being received from a bill; wait for that to finish`;
  if (facts.waiting > 0) return `Orders still wait for ${qtyText(facts.waiting)} units of batch ${lot.code}. Cancel and refund them, or move them to ready stock, first.`;
  if (facts.tagged) return `Expenses are tagged to batch ${lot.code}; move or remove them first`;
  return "";
}

export type UnmatchFacts = {
  /** A received batch that was a pre-order and was matched (matched_at set). */
  matched: boolean;
  matchedAt: string | null;
  nowMs: number;
  /** Orders that took from it (or its remainder) after the match, not moved by the match itself. */
  newOrders: boolean;
  /** An order on it has a confirmed sales order, a live invoice or a delivery note. */
  movedOnInZoho: boolean;
  /** Counted, adjusted or sent on to another godown. */
  countedOrSent: boolean;
  viaTransfer: boolean;
  billFlag: string;
  /** Its remainder was matched, cancelled or is being received. */
  remainderMovedOn: boolean;
};
/** Why a match can't be undone, or "" (unmatch_incoming_batch, same order of reasons). */
export function unmatchBlocker(facts: UnmatchFacts) {
  if (!facts.matched || !facts.matchedAt) return "it is not a matched pre-order batch";
  if (Date.parse(facts.matchedAt) <= facts.nowMs - 7 * 86_400_000) return "matched more than 7 days ago";
  if (facts.newOrders) return "new orders took from it";
  if (facts.movedOnInZoho) return "an order on it went on to Zoho or got a delivery note";
  if (facts.countedOrSent) return "it was counted or sent on";
  if (facts.viaTransfer) return "it was received through a transfer";
  if (facts.billFlag) return "its bill is flagged";
  if (facts.remainderMovedOn) return "its remainder has moved on";
  return "";
}

/** Badges of a lot on Admin › Batches (spec 3). */
export function lotBadges(lot: Lot & { estimated?: boolean }, clock: PreorderClock, facts: { held?: number } = {}) {
  const badges: string[] = [];
  if (lot.stage !== "incoming") return badges;
  if (lot.pausedReason === "receiving") badges.push("Paused while receiving");
  else if (lot.paused) badges.push("Paused by admin");
  else if (lotOverdue(lot, clock)) badges.push("Overdue");
  else if (lotSellable(lot, clock) > 0) badges.push("Selling");
  if (lot.remaining <= 0) badges.push("Fully pre-sold");
  if ((facts.held ?? 0) > 0) badges.push("Zoho rise held at this godown");
  if (lot.estimated !== false) badges.push("Estimated cost");
  return badges;
}

/** "Pre-order · by 20 Nov · 130/360 sold". */
export const lotLabel = (lot: Pick<Lot, "quantity" | "remaining" | "expectedDate">, todayIst?: string) =>
  `Pre-order · by ${dayLabel(lot.expectedDate, { todayIst })} · ${qtyText(r2(lot.quantity - lot.remaining))}/${qtyText(lot.quantity)} sold`;

/** Quantities in text: 50 -> "50", 2.5 -> "2.5" (private.qty_text). */
export const qtyText = (qty: number) => String(roundTo(qty, 3));

// ------------------------------------------------------------------ the shop's view of a godown's stock

export type StockRowLike = { stock: number | string; incoming?: number | string | null; incoming_detail?: unknown };
/** The arriving dates in branch_stock.incoming_detail ([{by, qty}]). */
export function arrivingDetail(value: unknown): ArrivingDetail[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { by: text(row["by"]).slice(0, 10), qty: num(row["qty"]) };
  }).filter((entry) => isIsoDate(entry.by) && entry.qty > 0).sort((a, b) => a.by.localeCompare(b.by));
}

/**
 * What a shopper sees for a product at their godown: ready to collect, arriving (pre-order) and by when (the earliest
 * date whose day has not passed in India; within grace days after it, the latest date given). Arriving is 0 while
 * pre-orders are off.
 */
export function incomingView(row: StockRowLike | null | undefined, todayIst: string, on = true) {
  const ready = Math.max(0, num(row?.stock));
  const detail = arrivingDetail(row?.incoming_detail);
  const arriving = on ? Math.max(0, num(row?.incoming)) : 0;
  if (arriving <= 0) return { ready, arriving: 0, by: null as string | null };
  const by = detail.find((entry) => entry.by >= todayIst)?.by ?? detail[detail.length - 1]?.by ?? null;
  return { ready, arriving, by };
}

/**
 * How many of a cart line come from ready stock and how many arrive later (ready units first, whole units, as
 * take_order_line splits it).
 */
export function cartLineSplit(qty: number, ready: number) {
  const readyPart = Math.min(qty, Math.max(0, Math.floor(ready)));
  return { ready: readyPart, preorder: Math.max(0, qty - readyPart) };
}

/**
 * The words a shopper reads (spec 11), exactly as src/lib/i18n-kn.ts has them (the keys are the English as rendered;
 * {0}, {1}… stand for these values). Dates come in already formatted ("20 Nov").
 */
export const preorderText = {
  word: "Pre-order",
  badge: (by: string) => `Pre-order · arriving by ${by}`,
  productLotOnly: (by: string) => `Pre-order — arriving by ${by}`,
  arrivingBy: (by: string) => `Arriving by ${by}`,
  arrivingByCount: (by: string, qty: number) => `Arriving by ${by} (${qtyText(qty)})`,
  plusArriving: (qty: number) => `+${qtyText(qty)} arriving`,
  readyAndArriving: (ready: number, arriving: number, by: string) => `${qtyText(ready)} ready to collect · ${qtyText(arriving)} arriving by ${by}`,
  explanation: (godown: string) => `Order and pay now, and collect at the ${godown} godown after the goods arrive. We will tell you when they are ready.`,
  cartSplit: (ready: number, arriving: number, by: string) => `${qtyText(ready)} ready now · ${qtyText(arriving)} arriving by ${by}`,
  allArriving: (qty: number, by: string) => `All ${qtyText(qty)} arriving by ${by}`,
  limit: (name: string, can: number, godown: string, ready: number, pre: number, have: number) =>
    `${name}: only ${qtyText(can)} can be ordered at the ${godown} godown (${qtyText(ready)} ready, ${qtyText(pre)} on pre-order), you have ${qtyText(have)}`,
  ack: (qty: number, godown: string, by: string) =>
    `I understand that ${qtyText(qty)} of these reach the ${godown} godown by ${by}, that I collect the whole order after they arrive, and that I get a full refund if they do not come.`,
  needsTick: (name: string, by: string) => `${name} is partly arriving later (by ${by}). Tick the pre-order box to continue.`,
  changed: (name: string) => `Arriving stock of ${name} changed while you were ordering. Refresh and try again.`,
  orderPart: (godown: string, by: string) => `Part of this order is on pre-order. It reaches the ${godown} godown by ${by}. Your pickup QR appears when everything has arrived; we will tell you.`,
  waiting: (by: string) => `Waiting for goods · arriving by ${by}`,
  arrivedOn: (on: string) => `Arrived on ${on} · ready to collect`,
  late: "Running late — we will tell you when it arrives",
  invoiceLater: (amount: string) => `Your tax invoice and pickup QR are made when your goods arrive. We have received your payment of ₹${amount}.`,
  someArrive: (qty: number, by: string) => `${qtyText(qty)} of them arrive by ${by}.`,
  notArrived: (codes: string, by: string) => `Goods not arrived yet. Batch ${codes} is expected by ${by}. Do not hand over until head office receives its bill.`,
  comingTitle: "Coming to your godown",
  comingLine: (qty: number, by: string, sold: number) => `${qtyText(qty)} expected by ${by} · ${qtyText(sold)} already sold`,
  countRefused: (name: string, code: string) => `${name} has incoming batch ${code} on its way to this godown. If the lorry has come, ask head office to receive its bill; count again after that.`,
  partnerInvoiceLater: "Invoice comes when the goods arrive",
} as const;

/** Where an order line stands (order_item_arrivals): waiting, arrived, or late. */
export function arrivalState(row: { waiting: number; expected_date: string | null; arrived_on: string | null }, todayIst: string) {
  if (row.waiting > 0) {
    if (row.expected_date && row.expected_date < todayIst) return { state: "late" as const, text: preorderText.late };
    return { state: "waiting" as const, text: preorderText.waiting(dayLabel(row.expected_date, { todayIst })) };
  }
  if (row.arrived_on) return { state: "arrived" as const, text: preorderText.arrivedOn(dayLabel(row.arrived_on, { todayIst })) };
  return { state: "none" as const, text: "" };
}

// ------------------------------------------------------------------ the bill check (spec 7.3)

/** Bills read when a pre-order is made or matched: modified in the window, at most 3 list pages, 15 bill reads. */
export const BILL_CHECK_PAGES = 3;
export const BILL_CHECK_READS = 15;
export const BILL_CHECK_DAYS = 10;

/** The window's start: bills modified since max(earliest watch opening - 2 hours, now - 10 days). */
export function billCheckSince(nowMs: number, openedAt: (string | null | undefined)[] = []) {
  const floor = nowMs - BILL_CHECK_DAYS * 86_400_000;
  const opened = openedAt.map((at) => Date.parse(text(at))).filter(Number.isFinite);
  const since = opened.length ? Math.max(floor, Math.min(...opened) - 2 * 3_600_000) : floor;
  return new Date(since).toISOString();
}

/** A Zoho time ("2026-11-13T14:00:15+0530") in ms, or NaN (private.zoho_time). */
export const zohoTimeMs = (value: unknown) => {
  const raw = text(value).trim();
  if (!raw) return NaN;
  return Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
};

export type BillRowLite = { billId: string; billNumber: string; vendorName: string; date: string; status: string; locationId: string; modifiedAt: string; createdTime: string };
/** A row of GET /bills, as the bill check reads it. */
export function billRowLite(raw: Record<string, unknown>): BillRowLite {
  return {
    billId: text(raw["bill_id"]), billNumber: text(raw["bill_number"]), vendorName: text(raw["vendor_name"]),
    date: text(raw["date"]).slice(0, 10), status: text(raw["status"]).toLowerCase(),
    locationId: text(raw["location_id"] ?? raw["branch_id"]), modifiedAt: text(raw["last_modified_time"]), createdTime: text(raw["created_time"]),
  };
}

/** Bills worth reading: not a draft or void, at this location (or Zoho does not say), modified in the window. */
export function billCheckCandidates(rows: BillRowLite[], { locationId, sinceIso }: { locationId: string; sinceIso: string }) {
  const since = Date.parse(sinceIso);
  return rows.filter((row) => row.billId && row.status !== "draft" && row.status !== "void"
    && (!row.locationId || !locationId || row.locationId === locationId)
    && (!Number.isFinite(since) || !Number.isFinite(zohoTimeMs(row.modifiedAt)) || zohoTimeMs(row.modifiedAt) >= since));
}

/** Whether the list has gone past the window (sorted newest change first): no more pages needed. */
export function pastWindow(rows: BillRowLite[], sinceIso: string) {
  const since = Date.parse(sinceIso);
  const last = rows[rows.length - 1];
  return Boolean(last && Number.isFinite(since) && Number.isFinite(zohoTimeMs(last.modifiedAt)) && zohoTimeMs(last.modifiedAt) < since);
}

export type CachedBillLine = { line_id: string; item_id: string; qty: number; location_id: string; item_type: string; account_name: string; taxable: number; gst: number };
/** A bill's lines as zoho_bill_line_cache keeps them. */
export function cachedBillLines(raw: Record<string, unknown>): CachedBillLine[] {
  const lines = Array.isArray(raw["line_items"]) ? raw["line_items"] as Record<string, unknown>[] : [];
  return lines.map((line) => {
    const taxable = num(line["item_total"]);
    return {
      line_id: text(line["line_item_id"]), item_id: text(line["item_id"]), qty: roundTo(num(line["quantity"]), 3),
      location_id: text(line["location_id"]), item_type: text(line["item_type"]), account_name: text(line["account_name"]),
      taxable: r2(taxable), gst: r2(taxable * num(line["tax_percentage"]) / 100),
    };
  });
}

export type CachedBill = { bill_id: string; modified: string; bill_number: string; bill_date: string | null; created_time: string; status: string; location_id: string; vendor_name: string; lines: CachedBillLine[] };
export type UnreceivedLine = { billId: string; billNumber: string; vendorName: string; date: string; createdTime: string; lineId: string; itemId: string; qty: number; locationId: string };

/**
 * Bill lines of an item at a location that no batch has yet (spec 7.3): the line's own location, else the bill's.
 * batchedLines: "billId|lineId" of lines already a batch.
 */
export function unreceivedLines(bills: CachedBill[], { itemId, locationId, batchedLines }: { itemId: string; locationId: string; batchedLines: Set<string> }): UnreceivedLine[] {
  const out: UnreceivedLine[] = [];
  for (const bill of bills) {
    if (bill.status === "draft" || bill.status === "void") continue;
    for (const line of bill.lines) {
      if (line.item_id !== itemId || !(line.qty > 0)) continue;
      const at = line.location_id || bill.location_id;
      if (at && locationId && at !== locationId) continue;
      if (batchedLines.has(`${bill.bill_id}|${line.line_id}`)) continue;
      out.push({ billId: bill.bill_id, billNumber: bill.bill_number, vendorName: bill.vendor_name, date: bill.bill_date ?? "", createdTime: bill.created_time,
        lineId: line.line_id, itemId: line.item_id, qty: line.qty, locationId: at });
    }
  }
  return out;
}

/** Bills that, by the cache, contain a product with an open lot: "Has pre-order goods: Sugar S1 → CLK-141126-01". */
export function preorderGoodsNote(bill: Pick<CachedBill, "lines"> | undefined, lotsByItem: Map<string, { productName: string; codes: string[] }>) {
  if (!bill) return "";
  const parts: string[] = [];
  for (const line of bill.lines) {
    const lot = lotsByItem.get(line.item_id);
    if (lot && !parts.some((p) => p.startsWith(`${lot.productName} →`))) parts.push(`${lot.productName} → ${lot.codes.join(", ")}`);
  }
  return parts.length ? `Has pre-order goods: ${parts.join("; ")}` : "";
}

// ------------------------------------------------------------------ purchase orders (a lot can start from a Zoho PO)

export type PurchaseOrderRow = { poId: string; number: string; vendorName: string; date: string; expectedDate: string; status: string; locationId: string; locationName: string; total: number; here: boolean };
const PO_CLOSED = new Set(["cancelled", "closed", "billed", "void", "draft_cancelled"]);
/** Open purchase orders (not cancelled, closed or billed), the godown's own location first, newest first. */
export function openPurchaseOrders(list: Record<string, unknown>[], locationId: string): PurchaseOrderRow[] {
  return list.map((raw) => ({
    poId: text(raw["purchaseorder_id"]), number: text(raw["purchaseorder_number"]), vendorName: text(raw["vendor_name"]),
    date: text(raw["date"]).slice(0, 10), expectedDate: text(raw["delivery_date"] ?? raw["expected_delivery_date"]).slice(0, 10),
    status: text(raw["status"]).toLowerCase(), locationId: text(raw["location_id"] ?? raw["branch_id"]),
    locationName: text(raw["location_name"] ?? raw["branch_name"]), total: r2(num(raw["total"])), here: false,
  })).filter((po) => po.poId && !PO_CLOSED.has(po.status))
    .map((po) => ({ ...po, here: Boolean(locationId) && po.locationId === locationId }))
    .sort((a, b) => Number(b.here) - Number(a.here) || b.date.localeCompare(a.date));
}

export type PurchaseOrderLine = { lineId: string; itemId: string; name: string; qty: number; billedQty: number | null; rateExGst: number; gstPct: number; unit: string };
/** A PO line with its rate before GST (an inclusive-tax PO's rate converted). Billed quantity when Zoho gives it. */
export function purchaseOrderLine(raw: Record<string, unknown>, inclusive: boolean): PurchaseOrderLine {
  const gstPct = num(raw["tax_percentage"]);
  const qty = roundTo(num(raw["quantity"]), 2);
  const rate = num(raw["rate"]);
  const discount = num(raw["discount_amount"]);
  const itemTotal = raw["item_total"] !== undefined && raw["item_total"] !== "" ? num(raw["item_total"]) : rate * qty - discount;
  const perUnit = qty > 0 ? itemTotal / qty : rate;
  const billed = raw["quantity_billed"] ?? raw["billed_quantity"];
  return {
    lineId: text(raw["line_item_id"]), itemId: text(raw["item_id"]), name: text(raw["name"] ?? raw["item_name"]), qty,
    billedQty: billed === undefined || billed === null || billed === "" ? null : roundTo(num(billed), 2),
    rateExGst: r2(inclusive && gstPct > 0 ? perUnit / (1 + gstPct / 100) : perUnit), gstPct, unit: text(raw["unit"]),
  };
}

/** Units of a PO line still open for a new pre-order: ordered - billed (when Zoho says) - already in live lots. */
export const poLineOpen = (line: Pick<PurchaseOrderLine, "qty" | "billedQty">, inLots: number) =>
  Math.max(0, r2(line.qty - (line.billedQty ?? 0) - inLots));

// ------------------------------------------------------------------ the new pre-order form

export type IncomingDraft = { quantity: number; holdBack: number; unitCostExGst: number; expectedDate: string; unit: string };
const WHOLE_UNITS = new Set(["", "pcs", "pack", "bag", "bags", "pc", "packs"]);
/** The form's checks, the same as create_incoming_batch's (the database checks again). "" when fine. */
export function incomingDraftProblem(d: IncomingDraft, todayIst: string) {
  const whole = WHOLE_UNITS.has(d.unit.trim().toLowerCase());
  if (!(d.quantity > 0) || d.quantity > 1_000_000 || (whole && !Number.isInteger(d.quantity)) || roundTo(d.quantity, 2) !== d.quantity)
    return "Enter the expected quantity in whole units (1 to 10,00,000)";
  if (d.holdBack < 0 || d.holdBack > d.quantity || (whole && !Number.isInteger(d.holdBack)) || roundTo(d.holdBack, 2) !== d.holdBack)
    return "Hold back must be between 0 and the expected quantity";
  if (!(d.unitCostExGst > 0) || d.unitCostExGst > 100_000_000) return "Enter the expected cost per unit before GST";
  if (!isIsoDate(d.expectedDate) || d.expectedDate < todayIst || d.expectedDate > addDays(todayIst, 180))
    return "The expected date must be between today and 180 days ahead";
  return "";
}

/**
 * "Zoho now: 50 at CLK · Ready: 50 · After this: 50 ready + 360 arriving by 20 Nov". readyAfter: the ready stock once
 * the watch opens (watch_open holds any rise since the last pull, and takes off a fall): min(ready, Zoho - waiting).
 */
export function incomingPreview({ zohoNow, godown, ready, readyAfter, quantity, holdBack, expectedDate, todayIst }: {
  zohoNow: number; godown: string; ready: number; readyAfter: number; quantity: number; holdBack: number; expectedDate: string; todayIst: string;
}) {
  const sell = Math.max(0, r2(quantity - holdBack));
  return [`Zoho now: ${qtyText(zohoNow)} at ${godown}`, `Ready: ${qtyText(ready)}`,
    `After this: ${qtyText(Math.max(0, readyAfter))} ready + ${qtyText(sell)} arriving by ${dayLabel(expectedDate, { todayIst })}`].join(" · ");
}

/** Ready stock once a godown's watch opens (no lot there yet): min(T before, Z - W), never below 0. */
export const readyAfterOpening = ({ reading, totalBefore, waiting }: { reading: number; totalBefore: number; waiting: number }) =>
  Math.max(0, r2(r3(reading) - openingHold({ reading, totalBefore, waiting }) - waiting));
