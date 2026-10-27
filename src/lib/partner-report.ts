/*
 * Channel partner report: the godown report seen per channel partner. A partner is answerable for
 * the sales of their godown from the day their login was created; a sale that carries a partner
 * commission always belongs to that partner. Figures per partner: orders, sales, cost, profit,
 * losses, commission (earned / pending / cancelled), monthly target and how much of it is reached,
 * and every sale at the time it happened. Pure, like godown-report.ts, so the node tests load it.
 *
 * Target progress uses the same sales as the partner leaderboard: lines that carry a commission
 * rate. "Godown sales" is everything sold at the godown in the partner's time.
 */
import {
  buildGodownReport, istStamp, profitOrLoss, type GodownTotals, type ReportItem, type ReportOrder, type SaleLine,
} from "./godown-report.ts";
import type { XlsxSheet } from "./xlsx.ts";

export type ReportPartner = {
  id: string;
  name: string;
  email: string;
  phone: string;
  branchId: string;
  godown: string;
  status: string;
  createdAt: string;
};
export type PartnerCommissionRow = {
  order_item_id: string;
  order_id: string;
  partner_id: string;
  amount: number;
  status: string;
  kind: string;
  rate: number;
  line_total: number;
};
export type PartnerTargetRow = { partner_id: string; month: string; target_sales: number };

export type PartnerTotals = GodownTotals & {
  partner: ReportPartner;
  commissionEarned: number;
  commissionPending: number;
  commissionCancelled: number;
  /** Sales of lines with a commission rate (what the target counts). */
  eligibleSales: number;
  target: number;
  achievedPercent: number | null;
  rank: number;
};
export type PartnerLine = SaleLine & { partnerId: string; commissionStatus: string; rate: string };

const rupees = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

/** Which partner answers for each order: its commission's partner, else the godown's partner at the time. */
export function attributeOrders(orders: ReportOrder[], partners: ReportPartner[], commissionRows: PartnerCommissionRow[]) {
  const byCommission = new Map(commissionRows.map((row) => [row.order_id, row.partner_id]));
  const result = new Map<string, string>();
  for (const order of orders) {
    const fromCommission = byCommission.get(order.id);
    if (fromCommission) { result.set(order.id, fromCommission); continue; }
    if (!order.branch_id) continue;
    const at = Date.parse(order.created_at);
    const partner = partners
      .filter((p) => p.branchId === order.branch_id && Date.parse(p.createdAt) <= at)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (partner) result.set(order.id, partner.id);
  }
  return result;
}

/** Sum of the monthly targets for the months the period touches. */
export function targetForPeriod(targets: PartnerTargetRow[], partnerId: string, from: string, to: string) {
  const first = monthOf(from);
  const last = monthOf(to);
  return rupees(targets.filter((t) => t.partner_id === partnerId && t.month >= first && t.month <= last)
    .reduce((sum, t) => sum + Number(t.target_sales), 0));
}

export function buildPartnerReport(input: {
  partners: ReportPartner[];
  orders: ReportOrder[];
  items: ReportItem[];
  costs: Record<string, number | null | undefined>;
  commissionRows: PartnerCommissionRow[];
  targets: PartnerTargetRow[];
  from: string;
  to: string;
}) {
  const owner = attributeOrders(input.orders, input.partners, input.commissionRows);
  const orders = input.orders.filter((order) => owner.has(order.id)).map((order) => ({ ...order, branch_id: owner.get(order.id)! }));
  const orderIds = new Set(orders.map((order) => order.id));
  const commissionByItem = new Map(input.commissionRows.map((row) => [row.order_item_id, row]));
  const base = buildGodownReport({
    godowns: input.partners.map((p) => ({ id: p.id, name: p.name })),
    orders,
    items: input.items.filter((item) => orderIds.has(item.order_id)),
    costs: input.costs,
    commissions: Object.fromEntries(input.commissionRows.filter((row) => row.status !== "cancelled").map((row) => [row.order_item_id, Number(row.amount)])),
  });
  const partnerById = new Map(input.partners.map((p) => [p.id, p]));
  const rows: PartnerTotals[] = base.godowns.filter((row) => partnerById.has(row.godownId)).map((row) => {
    const partner = partnerById.get(row.godownId)!;
    const mine = input.commissionRows.filter((c) => c.partner_id === partner.id && orderIds.has(c.order_id));
    const sum = (status: string) => rupees(mine.filter((c) => c.status === status).reduce((s, c) => s + Number(c.amount), 0));
    const eligibleSales = rupees(mine.filter((c) => c.status !== "cancelled").reduce((s, c) => s + Number(c.line_total), 0));
    const target = targetForPeriod(input.targets, partner.id, input.from, input.to);
    return {
      ...row,
      godown: partner.name,
      partner,
      commissionEarned: sum("earned"),
      commissionPending: sum("pending"),
      commissionCancelled: sum("cancelled"),
      eligibleSales,
      target,
      achievedPercent: target > 0 ? Math.round((eligibleSales * 1000) / target) / 10 : null,
      rank: 0,
    };
  });
  // Ranked like the leaderboard: share of target, then sales.
  rows.sort((a, b) => (b.achievedPercent ?? -1) - (a.achievedPercent ?? -1) || b.eligibleSales - a.eligibleSales || b.sales - a.sales || a.partner.name.localeCompare(b.partner.name));
  rows.forEach((row, index) => { row.rank = index + 1; });

  const lines: PartnerLine[] = base.lines.map((line) => {
    const commission = commissionByItem.get(line.itemId);
    const partner = partnerById.get(line.godownId);
    return {
      ...line,
      godown: partner?.godown ?? line.godown,
      partnerId: line.godownId,
      commissionStatus: commission?.status ?? "no rate",
      rate: commission ? (commission.kind === "percent" ? `${Number(commission.rate)}%` : `₹${Number(commission.rate)} per unit`) : "—",
    };
  });
  const total = rows.reduce((acc, row) => ({
    ...acc,
    commissionEarned: rupees(acc.commissionEarned + row.commissionEarned),
    commissionPending: rupees(acc.commissionPending + row.commissionPending),
    commissionCancelled: rupees(acc.commissionCancelled + row.commissionCancelled),
    eligibleSales: rupees(acc.eligibleSales + row.eligibleSales),
    target: rupees(acc.target + row.target),
  }), { commissionEarned: 0, commissionPending: 0, commissionCancelled: 0, eligibleSales: 0, target: 0 });
  return {
    partners: rows,
    all: { ...base.all, ...total, achievedPercent: total.target > 0 ? Math.round((total.eligibleSales * 1000) / total.target) / 10 : null },
    lines,
  };
}

export type PartnerReport = ReturnType<typeof buildPartnerReport>;

type Column = [string, (row: PartnerTotals | PartnerReport["all"]) => number | string | null];

/** Columns a partner sees about their own work (no company cost or profit). */
export const PARTNER_COLUMNS: Column[] = [
  ["Orders", (r) => r.orders],
  ["Delivered orders", (r) => r.deliveredOrders],
  ["Cancelled orders", (r) => r.cancelledOrders],
  ["Units sold", (r) => r.unitsSold],
  ["Godown sales excl. GST (₹)", (r) => r.sales],
  ["Discount (₹)", (r) => r.discount],
  ["Net sales (₹)", (r) => r.netSales],
  ["Sales with a commission rate (₹)", (r) => r.eligibleSales],
  ["Target (₹)", (r) => r.target],
  ["Target reached (%)", (r) => r.achievedPercent],
  ["Commission earned (₹)", (r) => r.commissionEarned],
  ["Commission pending (₹)", (r) => r.commissionPending],
  ["Commission cancelled (₹)", (r) => r.commissionCancelled],
  ["Cancelled sales (₹)", (r) => r.cancelledValue],
  ["Refunded (₹)", (r) => r.refunded],
  ["GST (₹)", (r) => r.gst],
  ["Billed incl. GST (₹)", (r) => r.billed],
  ["Collected (₹)", (r) => r.collected],
  ["Due (₹)", (r) => r.due],
];
/** The admin also sees what each partner's sales earned the company. */
export const ADMIN_PARTNER_COLUMNS: Column[] = [
  ...PARTNER_COLUMNS.slice(0, 7),
  ["Cost of goods (₹)", (r) => r.cost],
  ["Sales without purchase rate (₹)", (r) => r.salesWithoutCost],
  ["Gross profit (₹)", (r) => r.grossProfit],
  ["Delivery charges (₹)", (r) => r.delivery],
  ["Net profit / loss after commission (₹)", (r) => r.netProfit],
  ["Result", (r) => profitOrLoss(r.netProfit)],
  ["Loss on items sold below cost (₹)", (r) => r.lossBelowCost],
  ...PARTNER_COLUMNS.slice(7),
];

const LINE_HEADER_PARTNER = ["Date & time (IST)", "Godown", "Order", "Customer", "Product", "Qty", "Rate (₹)", "Sale excl. GST (₹)",
  "Commission rate", "Commission (₹)", "Commission status", "Order status", "Payment"];
const LINE_HEADER_ADMIN = [...LINE_HEADER_PARTNER.slice(0, 8), "Purchase rate (₹)", "Cost (₹)", "Profit / loss (₹)", ...LINE_HEADER_PARTNER.slice(8), "Zoho invoice"];
const lineRow = (line: PartnerLine, admin: boolean) => admin
  ? [istStamp(line.time), line.godown, line.orderNo, line.customer, line.product, line.qty, line.unitPrice, line.lineTotal,
    line.unitCost, line.cost, line.margin, line.rate, line.commission, line.commissionStatus, line.orderStatus, line.paymentStatus, line.invoice]
  : [istStamp(line.time), line.godown, line.orderNo, line.customer, line.product, line.qty, line.unitPrice, line.lineTotal,
    line.rate, line.commission, line.commissionStatus, line.orderStatus, line.paymentStatus];

/**
 * Excel sheets: Summary (every partner and the total) and one sheet per partner (their figures,
 * sales by hour and every sale). `audience` "partner" leaves out the company's cost and profit.
 */
export function partnerReportSheets(report: PartnerReport, meta: { period: string; generatedAt: string },
  options: { partnerId?: string; audience: "admin" | "partner" }): XlsxSheet[] {
  const admin = options.audience === "admin";
  const columns = admin ? ADMIN_PARTNER_COLUMNS : PARTNER_COLUMNS;
  const rows = options.partnerId ? report.partners.filter((row) => row.partner.id === options.partnerId) : report.partners;
  const intro = (title: string) => [
    [title],
    [`Period: ${meta.period}`, null, null, `Generated: ${istStamp(meta.generatedAt)} IST`],
    [admin
      ? "Amounts in ₹. Sales before GST. Cost = purchase rate of each item (Zoho item purchase rate). Target counts sales with a commission rate."
      : "Amounts in ₹. Sales before GST. Commission is earned when an order is delivered and fully paid. Target counts sales with a commission rate."],
    [],
  ];
  const head = intro(options.partnerId ? `Channel partner report · ${rows[0]?.partner.name ?? ""}` : "Channel partner report · all partners");
  const summary: XlsxSheet = {
    name: "Summary",
    rows: [
      ...head,
      ["Rank", "Partner", "Godown", "Email", "Phone", ...columns.map(([label]) => label)],
      ...rows.map((row) => [row.rank, row.partner.name, row.partner.godown, row.partner.email, row.partner.phone, ...columns.map(([, value]) => value(row))]),
      ...(options.partnerId ? [] : [[null, "Total", null, null, null, ...columns.map(([, value]) => value(report.all))]]),
    ],
    boldRows: [0, head.length, ...(options.partnerId ? [] : [head.length + rows.length + 1])],
    widths: [6, 24, 28, 26, 14, ...columns.map(([label]) => Math.max(10, Math.min(24, label.length + 2)))],
  };
  const perPartner = rows.map((row): XlsxSheet => {
    const lines = report.lines.filter((line) => line.partnerId === row.partner.id);
    const top = intro(`${row.partner.name} · ${row.partner.godown}`);
    const details = [["Partner", row.partner.name], ["Godown", row.partner.godown], ["Email", row.partner.email], ["Phone", row.partner.phone], ["Rank", row.rank]];
    const figures = columns.map(([label, value]) => [label, value(row)]);
    const hours = row.hourly.map((sales, hour) => ({ hour, sales })).filter((h) => h.sales > 0);
    const hourStart = top.length + details.length + figures.length + 1;
    const salesStart = hourStart + hours.length + 2;
    return {
      name: row.partner.name,
      rows: [
        ...top,
        ...details,
        ...figures,
        [],
        ["Sales by hour (IST)", "Sales excl. GST (₹)"],
        ...hours.map((h) => [`${String(h.hour).padStart(2, "0")}:00–${String(h.hour + 1).padStart(2, "0")}:00`, h.sales]),
        [],
        admin ? LINE_HEADER_ADMIN : LINE_HEADER_PARTNER,
        ...(lines.length ? lines.map((line) => lineRow(line, admin)) : [["No sales in this period"]]),
      ],
      boldRows: [0, hourStart, salesStart],
      widths: [18, 26, 28, 18, 40, 6, 11, 14, 12, 12, 13, 16, 12, 14, 16, 12, 26],
    };
  });
  return [summary, ...perPartner];
}

/** The report without the company's cost and profit, for a partner's own view. */
export function partnerSafeReport(report: PartnerReport): PartnerReport {
  const hide = <T extends GodownTotals>(row: T): T => ({
    ...row, cost: 0, salesWithoutCost: 0, linesWithoutCost: 0, grossProfit: 0, netProfit: 0, lossBelowCost: 0, costedCommission: 0,
  });
  return {
    partners: report.partners.map(hide),
    all: hide(report.all),
    lines: report.lines.map((line) => ({ ...line, unitCost: null, cost: null, margin: null })),
  };
}
