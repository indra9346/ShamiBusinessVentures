/*
 * Channel partner payouts: rules shared by the admin page, the partner's dashboard and the tests. The database decides
 * what may be paid (migration 20261108100000); this only shapes what the screens show, and warns before it refuses.
 * Kept free of app imports so the node tests can load it.
 */
import type { XlsxSheet } from "./xlsx.ts";

export const PAYOUT_MODES = ["UPI", "NEFT", "RTGS", "IMPS", "Cash", "Cheque"] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export type SettlementLine = {
  order_item_id: string;
  partner_id: string;
  partner_name: string;
  order_no: string;
  placed_at: string;
  earned_at: string | null;
  order_status: string;
  payment_status: string;
  customer_name: string;
  pin: string;
  product_name: string;
  qty: number;
  line_total: number;
  kind: string;
  rate: number;
  amount: number;
  status: string;
  payable: number;
  paid_amount: number;
  due_amount: number;
  payout_nos: string[];
};

export type PartnerPosition = {
  partner_id: string;
  partner_name: string;
  godown: string;
  partner_status: string;
  earned: number;
  pending: number;
  cancelled: number;
  paid: number;
  due: number;
  owed_back: number;
  payouts: number;
  last_paid_on: string | null;
};

export type PayoutRow = {
  id: string;
  payout_no: string;
  partner_id: string;
  branch_id: string;
  paid_on: string;
  amount: number;
  lines_total: number;
  recovered_total: number;
  mode: string;
  reference: string;
  note: string;
  status: string;
  created_by_name: string;
  created_at: string;
  voided_at: string | null;
  voided_by_name: string;
  void_reason: string;
};

export const rupees = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const IST_MS = 330 * 60_000;
/** The day (India time) of a moment, as yyyy-mm-dd. */
export const istDay = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
export const istToday = (now = Date.now()) => new Date(now + IST_MS).toISOString().slice(0, 10);
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** "07 Nov 2026". */
export const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

/** Where a line stands, in the words the screens use. */
export function lineState(line: Pick<SettlementLine, "status" | "payable" | "paid_amount" | "due_amount">) {
  if (line.due_amount < 0) return "To take back";
  if (line.status === "cancelled" && line.due_amount === 0) return "Cancelled";
  if (line.status === "pending") return "Waiting";
  if (line.due_amount === 0 && line.payable > 0) return "Paid";
  if (line.paid_amount > 0 && line.due_amount > 0) return "Part paid";
  if (line.due_amount > 0) return "To pay";
  return "Cancelled";
}

/** Why a line cannot be paid yet (the rule on the Earned card: delivered and fully paid), or "" when it can. */
export function waitingReason(line: Pick<SettlementLine, "status" | "order_status" | "payment_status" | "due_amount">) {
  if (line.status !== "pending") return "";
  const delivered = line.order_status === "Delivered";
  const paid = line.payment_status === "Paid";
  if (!delivered && !paid) return "Waiting for delivery and full payment";
  if (!delivered) return "Waiting for delivery";
  if (!paid) return "Waiting for full payment";
  return "";
}

export type DayGroup = { day: string; lines: SettlementLine[]; due: number; waiting: number };

/** Lines by the day the order was placed, oldest day first. */
export function groupByDay(lines: SettlementLine[]): DayGroup[] {
  const byDay = new Map<string, SettlementLine[]>();
  for (const line of lines) {
    const day = istDay(line.placed_at);
    byDay.set(day, [...(byDay.get(day) ?? []), line]);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) => ({
    day, lines: rows,
    due: rupees(rows.reduce((sum, line) => sum + Math.max(0, line.due_amount), 0)),
    waiting: rupees(rows.reduce((sum, line) => sum + (line.status === "pending" ? line.amount : 0), 0)),
  }));
}

/** What the ticked lines come to: the database takes earlier overpayments off first. */
export function selectionTotals(lines: Pick<SettlementLine, "order_item_id" | "due_amount">[], picked: ReadonlySet<string>, owedBack: number) {
  const gross = rupees(lines.filter((line) => picked.has(line.order_item_id) && line.due_amount > 0).reduce((sum, line) => sum + line.due_amount, 0));
  const recovered = rupees(Math.min(gross, Math.max(0, owedBack)));
  return { gross, recovered, most: rupees(gross - recovered) };
}

/** Why this payout should not be sent yet, or "". The database checks the same again. */
export function payoutProblem(input: { amount: number; most: number; recovered: number; mode: string; reference: string; paidOn: string; today: string }) {
  if (!input.paidOn || input.paidOn > input.today) return "Enter the date the money was paid (not in the future)";
  if (!Number.isFinite(input.amount) || input.amount < 0) return "Enter the amount paid";
  if (rupees(input.amount) > input.most) return `The most this payout can be is ₹${input.most.toFixed(2)}`;
  if (input.amount === 0 && input.recovered === 0) return "Enter the amount paid";
  if (input.amount > 0 && input.mode !== "Cash" && input.reference.replace(/\s/g, "").length < 4) return "Enter the UTR or reference of this payment";
  return "";
}

/** A payout's lines (plus = paid for that line, minus = taken back) always add up to the money sent. */
export const payoutStatusLabel = (status: string) => (status === "voided" ? "Undone" : "Paid");

const statusForSheet = (row: PayoutRow) => (row.status === "voided" ? `Undone: ${row.void_reason}` : "Paid");

/** Excel: every payout, the same list the screen shows. Undone payouts are listed but not added up. */
export function payoutsSheet(payouts: PayoutRow[], partnerName: (id: string) => string, meta: { title: string; generatedAt: string }): XlsxSheet {
  const header = ["Payout no.", "Paid on", "Partner", "Money paid (₹)", "Commission settled (₹)", "Taken back (₹)", "Mode", "UTR / reference", "Note", "Status", "Recorded by", "Recorded at (IST)"];
  const paid = payouts.filter((row) => row.status === "paid");
  const total = rupees(paid.reduce((sum, row) => sum + row.amount, 0));
  const stamp = (iso: string) => {
    const d = new Date(Date.parse(iso) + IST_MS).toISOString();
    return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)} ${d.slice(11, 16)}`;
  };
  return {
    name: "Payouts",
    rows: [
      [meta.title],
      [`Generated: ${stamp(meta.generatedAt)} IST`],
      [],
      header,
      ...payouts.map((row) => [row.payout_no, row.paid_on, partnerName(row.partner_id), row.amount, row.lines_total, row.recovered_total, row.mode, row.reference, row.note, statusForSheet(row), row.created_by_name, stamp(row.created_at)]),
      ["Total paid", null, null, total],
    ],
    boldRows: [0, 3, 4 + payouts.length],
    widths: [13, 12, 24, 14, 14, 12, 11, 22, 26, 26, 18, 17],
  };
}
