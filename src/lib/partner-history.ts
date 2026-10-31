/*
 * Channel partner history: who ran each godown from when to when, and what they sold and earned
 * in that time. Built from the partner change log (channel_partner_events: added, suspended,
 * reactivated, moved), the commission lines (which always keep the partner who was active when the
 * order was placed) and the godown's orders: a period's orders and sales are every order of the
 * godown in it, before GST, like the Godown Report. Gaps (a godown with no active partner) show the
 * sales made then, which carry no commission. Pure, so the node tests load it.
 */
import type { XlsxSheet } from "./xlsx.ts";

export type HistoryPartner = {
  id: string; name: string; email: string; phone: string; branchId: string; status: string; createdAt: string; updatedAt: string;
};
export type HistoryEvent = {
  partner_id: string; branch_id: string; event: string; at: string; by_name: string; backfilled: boolean;
};
export type HistoryCommission = {
  partner_id: string; order_id: string; line_total: number; amount: number; status: string; placed_at: string;
};
export type HistoryOrder = { id: string; branch_id: string | null; created_at: string; order_status: string; subtotal: number; discount: number };
export type HistoryGodown = { id: string; name: string };

export type HistoryPeriod = {
  kind: "partner" | "gap";
  godownId: string;
  godown: string;
  partner: HistoryPartner | null;
  from: string;
  /** null = still running */
  to: string | null;
  days: number;
  current: boolean;
  /** Start or end time reconstructed from records made before the log existed. */
  approximate: boolean;
  startedBy: string;
  endedBy: string;
  orders: number;
  sales: number;
  earned: number;
  pending: number;
  cancelled: number;
};

const rupees = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const ms = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;
/** A godown without a partner for longer than this is shown as a gap. */
export const GAP_SHOWN_AFTER_MS = 10 * 60_000;
/** Unpaid checkout requests (pay first): not orders yet, or never. */
const HELD = ["Awaiting Payment", "Payment Expired"];
/** Orders not counted as sales: cancelled ones and unpaid checkout requests. */
const NOT_SALES = ["Cancelled", ...HELD];

type Open = { godownId: string; from: string; startedBy: string; approximate: boolean };

/** A partner's periods as the active partner of a godown, from their log (oldest first). */
export function partnerPeriods(partner: HistoryPartner, events: HistoryEvent[]) {
  const mine = events.filter((e) => e.partner_id === partner.id)
    .sort((a, b) => ms(a.at) - ms(b.at) || order(a.event) - order(b.event));
  const periods: { godownId: string; from: string; to: string | null; startedBy: string; endedBy: string; approximate: boolean }[] = [];
  if (!mine.length) {
    // No log at all (should not happen after the backfill): the record's own dates.
    periods.push({ godownId: partner.branchId, from: partner.createdAt, to: partner.status === "active" ? null : partner.updatedAt,
      startedBy: "", endedBy: "", approximate: true });
    return periods;
  }
  let open: Open | null = null;
  let godown = partner.branchId;
  const close = (e: HistoryEvent) => {
    if (!open) return;
    periods.push({ ...open, to: e.at, endedBy: e.by_name, approximate: open.approximate || e.backfilled });
    open = null;
  };
  for (const e of mine) {
    if (e.event === "added" || e.event === "reactivated") {
      godown = e.branch_id;
      // A backfilled "added" is the record's own creation time (exact); other backfilled times are not.
      if (!open) open = { godownId: godown, from: e.at, startedBy: e.by_name, approximate: e.backfilled && e.event !== "added" };
    } else if (e.event === "suspended") {
      close(e);
    } else if (e.event === "moved") {
      const wasOpen = open !== null;
      close(e);
      godown = e.branch_id;
      if (wasOpen) open = { godownId: godown, from: e.at, startedBy: e.by_name, approximate: e.backfilled };
    }
  }
  if (open) {
    const still = open as Open;
    periods.push({ ...still, to: partner.status === "active" ? null : partner.updatedAt, endedBy: "", approximate: still.approximate || partner.status !== "active" });
  }
  return periods;
}
const order = (event: string) => ({ added: 0, moved: 1, reactivated: 2, suspended: 3 }[event] ?? 4);

export function buildPartnerHistory(input: {
  godowns: HistoryGodown[];
  partners: HistoryPartner[];
  events: HistoryEvent[];
  commissions: HistoryCommission[];
  orders: HistoryOrder[];
  now: string;
}) {
  const nowMs = ms(input.now);
  const godownName = new Map(input.godowns.map((g) => [g.id, g.name]));
  const periods: HistoryPeriod[] = [];
  const byPartner = new Map<string, HistoryPeriod[]>();
  for (const partner of input.partners) {
    for (const p of partnerPeriods(partner, input.events)) {
      const end = p.to ? ms(p.to) : nowMs;
      const row: HistoryPeriod = {
        kind: "partner", godownId: p.godownId, godown: godownName.get(p.godownId) ?? p.godownId, partner, from: p.from, to: p.to,
        days: Math.max(0, Math.ceil((end - ms(p.from)) / DAY)), current: p.to === null, approximate: p.approximate,
        startedBy: p.startedBy, endedBy: p.endedBy, orders: 0, sales: 0, earned: 0, pending: 0, cancelled: 0,
      };
      periods.push(row);
      byPartner.set(partner.id, [...(byPartner.get(partner.id) ?? []), row]);
    }
  }

  /** The period of a list that contains a moment, else the nearest earlier one, else the first. */
  const periodAt = (list: HistoryPeriod[], at: number) =>
    list.find((p) => at >= ms(p.from) && (p.to === null || at < ms(p.to)))
      ?? [...list].filter((p) => ms(p.from) <= at).sort((a, b) => ms(b.from) - ms(a.from))[0]
      ?? list[0];
  const statusOf = new Map(input.orders.map((o) => [o.id, o.order_status]));

  // Commission: from the lines, in the period of the partner who carries them (an unpaid checkout
  // request is not an order, so its line is left out).
  const commissionPartner = new Map<string, string>();
  for (const line of input.commissions) {
    if (HELD.includes(statusOf.get(line.order_id) ?? "")) continue;
    commissionPartner.set(line.order_id, line.partner_id);
    const target = periodAt(byPartner.get(line.partner_id) ?? [], ms(line.placed_at));
    if (!target) continue;
    const amount = Number(line.amount) || 0;
    if (line.status === "cancelled") target.cancelled = rupees(target.cancelled + amount);
    else if (line.status === "earned") target.earned = rupees(target.earned + amount);
    else target.pending = rupees(target.pending + amount);
  }

  // Orders and sales: every order of the godown in the period, like the Godown Report (sales before
  // GST; cancelled orders and unpaid checkout requests left out), whether or not it carries a rate.
  const counted = new Set<string>();
  for (const order of input.orders) {
    if (!order.branch_id || NOT_SALES.includes(order.order_status)) continue;
    const at = ms(order.created_at);
    const viaCommission = commissionPartner.get(order.id);
    const target = (viaCommission ? periodAt(byPartner.get(viaCommission) ?? [], at) : undefined)
      ?? periods.find((p) => p.kind === "partner" && p.godownId === order.branch_id && at >= ms(p.from) && (p.to === null || at < ms(p.to)));
    if (!target) continue;  // no partner then: counted in the gap below
    target.orders += 1;
    target.sales = rupees(target.sales + (Number(order.subtotal) || 0));
    counted.add(order.id);
  }

  // Gaps: times a godown that once had a partner had none (orders then carry no commission).
  for (const g of input.godowns) {
    const runs = periods.filter((p) => p.kind === "partner" && p.godownId === g.id).sort((a, b) => ms(a.from) - ms(b.from));
    let reachedUntil: number | null = null;
    let lastEnd: HistoryPeriod | null = null;
    const gaps: HistoryPeriod[] = [];
    const gap = (from: number, to: number | null, startedFrom: HistoryPeriod | null, approximate: boolean): HistoryPeriod => ({
      kind: "gap", godownId: g.id, godown: g.name, partner: null, from: new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString(),
      days: Math.max(0, Math.ceil(((to ?? nowMs) - from) / DAY)), current: to === null, approximate,
      startedBy: "", endedBy: "", orders: 0, sales: 0, earned: 0, pending: 0, cancelled: 0,
    });
    for (const run of runs) {
      const start = ms(run.from);
      if (reachedUntil !== null && start > reachedUntil) gaps.push(gap(reachedUntil, start, lastEnd, Boolean(lastEnd?.approximate)));
      const end = run.to === null ? Number.POSITIVE_INFINITY : ms(run.to);
      if (reachedUntil === null || end > reachedUntil) { reachedUntil = end; lastEnd = run; }
    }
    if (reachedUntil !== null && Number.isFinite(reachedUntil) && nowMs > reachedUntil)
      gaps.push(gap(reachedUntil, null, lastEnd, Boolean(lastEnd?.approximate)));
    for (const row of gaps) {
      const from = ms(row.from), to = row.to === null ? nowMs + 1 : ms(row.to);
      const sold = input.orders.filter((o) => o.branch_id === g.id && !counted.has(o.id) && !NOT_SALES.includes(o.order_status)
        && ms(o.created_at) >= from && ms(o.created_at) < to);
      row.orders = sold.length;
      row.sales = rupees(sold.reduce((s, o) => s + (Number(o.subtotal) || 0), 0));
    }
    // A handover of a few minutes is not a gap worth showing, unless an order came in meanwhile.
    periods.push(...gaps.filter((row) => row.orders > 0 || row.current || (ms(row.to!) - ms(row.from)) > GAP_SHOWN_AFTER_MS));
  }

  const sorted = periods.sort((a, b) => a.godown.localeCompare(b.godown) || ms(b.from) - ms(a.from) || (a.kind === "gap" ? 1 : -1));
  return {
    periods: sorted,
    godowns: input.godowns.map((g) => ({
      godownId: g.id, godown: g.name,
      current: sorted.find((p) => p.godownId === g.id && p.kind === "partner" && p.current)?.partner ?? null,
      partnersSoFar: new Set(sorted.filter((p) => p.godownId === g.id && p.partner).map((p) => p.partner!.id)).size,
    })),
  };
}

export type PartnerHistory = ReturnType<typeof buildPartnerHistory>;

const IST_MS = 5.5 * 3600 * 1000;
export const istDateTime = (iso: string) => {
  const d = new Date(ms(iso) + IST_MS).toISOString();
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)} ${d.slice(11, 16)}`;
};

export function partnerHistorySheet(history: PartnerHistory, meta: { generatedAt: string; godownId?: string }): XlsxSheet {
  const rows = history.periods.filter((p) => !meta.godownId || p.godownId === meta.godownId);
  const header = ["Godown", "Channel partner", "Email", "Phone", "From (IST)", "To (IST)", "Days", "Orders", "Sales excl. GST (₹)",
    "Commission earned (₹)", "Commission pending (₹)", "Commission cancelled (₹)", "Started by", "Ended by", "Note"];
  return {
    name: "Partner history",
    rows: [
      ["Channel partner history"],
      [`Generated: ${istDateTime(meta.generatedAt)} IST`],
      ["Each order's commission stays with the partner who was active when it was placed. 'No partner' rows: sales then earned no commission."],
      [],
      header,
      ...rows.map((p) => [
        p.godown, p.partner ? p.partner.name : "No partner", p.partner?.email ?? "", p.partner?.phone ?? "",
        istDateTime(p.from), p.to ? istDateTime(p.to) : (p.current ? "Now" : ""), p.days, p.orders, p.sales,
        p.kind === "partner" ? p.earned : null, p.kind === "partner" ? p.pending : null, p.kind === "partner" ? p.cancelled : null,
        p.startedBy, p.endedBy,
        [p.current && p.kind === "partner" ? "Current partner" : "", p.approximate ? "Time taken from older records (approximate)" : ""].filter(Boolean).join("; "),
      ]),
    ],
    boldRows: [0, 4],
    widths: [26, 24, 26, 14, 17, 17, 7, 8, 14, 14, 14, 14, 16, 16, 34],
  };
}
