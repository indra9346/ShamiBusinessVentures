/*
 * Godown report: sales, cost, profit and loss for every godown over a day (or any period), with
 * each sale at the time it happened. Pure: the server function reads the rows, this adds them up.
 * Kept free of app imports so the node tests can load it.
 *
 * Money (all ₹, rounded to paise):
 *   Sales            line totals before GST, cancelled orders excluded
 *   Discount         coupon / order discounts
 *   Net sales        Sales − Discount
 *   Cost of goods    qty × the product's purchase rate (Zoho item purchase rate)
 *   Gross profit     Net sales − Cost of goods, over lines whose purchase rate is known (a line
 *                    without one is flagged, never counted as pure profit); the discount is
 *                    shared in proportion
 *   Partner commission  the godown channel partner's commission on those lines
 *   Net profit       Gross profit + Delivery charges − Partner commission on those same lines
 *                    (negative = loss); like gross profit it leaves out lines without a rate
 *   Loss (below cost)   what was lost on lines sold under their purchase rate
 *   Cancelled        value of cancelled orders (sales that did not happen)
 *   Refunded         orders whose payment was refunded (not counted as collected or due)
 *   Due              per order: total − paid, for open orders that were not refunded
 * Cost is each product's purchase rate now (Zoho item purchase rate); it is not a snapshot of the
 * rate on the day of the sale.
 */
import type { XlsxSheet } from "./xlsx.ts";

export type ReportOrder = {
  id: string;
  order_no: string;
  branch_id: string | null;
  created_at: string;
  order_status: string;
  payment_status: string;
  customer_name: string | null;
  subtotal: number;
  discount: number;
  gst_amount: number;
  shipping: number;
  total: number;
  paid_amount: number;
  zoho_salesorder_id?: string | null;
  invoice_number?: string | null;
};

export type ReportItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
};

export type ReportGodown = { id: string; name: string; code?: string | null };

export type GodownTotals = {
  godownId: string;
  godown: string;
  orders: number;
  cancelledOrders: number;
  unitsSold: number;
  sales: number;
  discount: number;
  netSales: number;
  gst: number;
  delivery: number;
  billed: number;
  collected: number;
  due: number;
  cost: number;
  linesWithoutCost: number;
  /** Sales of lines without a purchase rate (left out of profit). */
  salesWithoutCost: number;
  /** Partner commission on lines whose purchase rate is known (the part net profit deducts). */
  costedCommission: number;
  grossProfit: number;
  commission: number;
  netProfit: number;
  lossBelowCost: number;
  cancelledValue: number;
  deliveredOrders: number;
  refundedOrders: number;
  refunded: number;
  /** Sales (before GST) per IST hour, 0-23. */
  hourly: number[];
};

export type SaleLine = {
  /** The order item (links the line to its partner commission). */
  itemId: string;
  time: string;
  godownId: string;
  godown: string;
  orderNo: string;
  customer: string;
  product: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  unitCost: number | null;
  cost: number | null;
  margin: number | null;
  commission: number;
  orderStatus: string;
  paymentStatus: string;
  inZoho: boolean;
  invoice: string;
};

export const NO_GODOWN = "none";
const rupees = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const IST_MS = 330 * 60_000;

/** The IST hour (0-23) of a timestamp. */
export const istHour = (iso: string) => new Date(Date.parse(iso) + IST_MS).getUTCHours();

/** Today's date in India as YYYY-MM-DD. */
export const istToday = (now = new Date()) => new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);

/** The UTC instants that bound India days from..to (inclusive), for the database query. */
export function istRange(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`) - IST_MS;
  const end = Date.parse(`${to}T00:00:00Z`) + 24 * 60 * 60_000 - IST_MS;
  return { fromIso: new Date(start).toISOString(), toIso: new Date(end).toISOString() };
}

const emptyTotals = (godownId: string, godown: string): GodownTotals => ({
  godownId, godown, orders: 0, cancelledOrders: 0, unitsSold: 0, sales: 0, discount: 0, netSales: 0, gst: 0,
  delivery: 0, billed: 0, collected: 0, due: 0, cost: 0, linesWithoutCost: 0, salesWithoutCost: 0, costedCommission: 0, grossProfit: 0, commission: 0,
  netProfit: 0, lossBelowCost: 0, cancelledValue: 0, deliveredOrders: 0, refundedOrders: 0, refunded: 0, hourly: Array.from({ length: 24 }, () => 0),
});

export function buildGodownReport(input: {
  godowns: ReportGodown[];
  orders: ReportOrder[];
  items: ReportItem[];
  /** Purchase rate per product id (missing = unknown cost). */
  costs: Record<string, number | null | undefined>;
  /** Partner commission per order item id (cancelled ones left out by the caller or here). */
  commissions: Record<string, number | undefined>;
  /** Names of every branch (godowns and vendor pickup points), for orders outside the godown list. */
  branchNames?: Record<string, string>;
}) {
  const names = new Map([...Object.entries(input.branchNames ?? {}), ...input.godowns.map((g): [string, string] => [g.id, g.name])]);
  const totals = new Map<string, GodownTotals>();
  // Every godown is listed, even on a day with no sales.
  for (const g of input.godowns) totals.set(g.id, emptyTotals(g.id, g.name));
  const totalsFor = (id: string) => {
    let row = totals.get(id);
    if (!row) {
      row = emptyTotals(id, id === NO_GODOWN ? "No godown (direct)" : names.get(id) ?? id);
      totals.set(id, row);
    }
    return row;
  };

  const itemsByOrder = new Map<string, ReportItem[]>();
  for (const item of input.items) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const lines: SaleLine[] = [];
  const orders = [...input.orders].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const order of orders) {
    const godownId = order.branch_id || NO_GODOWN;
    const row = totalsFor(godownId);
    const cancelled = order.order_status === "Cancelled";
    const refunded = /refunded/i.test(order.payment_status);
    const orderItems = itemsByOrder.get(order.id) ?? [];
    if (refunded) {
      row.refundedOrders += 1;
      row.refunded += Number(order.total);
    }
    if (cancelled) {
      row.cancelledOrders += 1;
      row.cancelledValue += Number(order.subtotal) - Number(order.discount);
    } else {
      row.orders += 1;
      if (order.order_status === "Delivered") row.deliveredOrders += 1;
      row.discount += Number(order.discount);
      row.gst += Number(order.gst_amount);
      row.delivery += Number(order.shipping);
      row.billed += Number(order.total);
      if (!refunded) {
        row.collected += Number(order.paid_amount);
        row.due += Math.max(0, Number(order.total) - Number(order.paid_amount));
      }
    }
    for (const item of orderItems) {
      const unitCost = item.product_id != null ? input.costs[item.product_id] : undefined;
      const known = typeof unitCost === "number" && Number.isFinite(unitCost) && unitCost >= 0;
      const cost = known ? rupees(unitCost * item.qty) : null;
      const margin = cost === null ? null : rupees(Number(item.line_total) - cost);
      const commission = cancelled ? 0 : Number(input.commissions[item.id] ?? 0);
      if (!cancelled) {
        row.unitsSold += item.qty;
        row.sales += Number(item.line_total);
        row.hourly[istHour(order.created_at)]! += Number(item.line_total);
        row.commission += commission;
        if (cost === null) {
          row.linesWithoutCost += 1;
          row.salesWithoutCost += Number(item.line_total);
        } else {
          row.cost += cost;
          row.costedCommission += commission;
          if (margin! < 0) row.lossBelowCost += -margin!;
        }
      }
      lines.push({
        itemId: item.id,
        time: order.created_at,
        godownId,
        godown: row.godown,
        orderNo: order.order_no,
        customer: order.customer_name ?? "",
        product: item.product_name,
        qty: item.qty,
        unitPrice: Number(item.unit_price),
        lineTotal: Number(item.line_total),
        unitCost: known ? unitCost : null,
        cost,
        margin,
        commission,
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        inZoho: !!order.zoho_salesorder_id,
        invoice: order.invoice_number ?? "",
      });
    }
  }

  const finish = (row: GodownTotals): GodownTotals => {
    const sales = rupees(row.sales);
    const discount = rupees(row.discount);
    const netSales = rupees(sales - discount);
    const cost = rupees(row.cost);
    const salesWithoutCost = rupees(row.salesWithoutCost);
    const costedSales = sales - salesWithoutCost;
    const costedDiscount = sales > 0 ? discount * (costedSales / sales) : 0;
    const grossProfit = rupees(costedSales - costedDiscount - cost);
    const commission = rupees(row.commission);
    const delivery = rupees(row.delivery);
    const billed = rupees(row.billed);
    const collected = rupees(row.collected);
    return {
      ...row, sales, discount, netSales, cost, salesWithoutCost, grossProfit, commission, delivery, billed, collected,
      gst: rupees(row.gst),
      due: rupees(row.due),
      refunded: rupees(row.refunded),
      costedCommission: rupees(row.costedCommission),
      netProfit: rupees(grossProfit + delivery - row.costedCommission),
      lossBelowCost: rupees(row.lossBelowCost),
      cancelledValue: rupees(row.cancelledValue),
      hourly: row.hourly.map(rupees),
    };
  };

  const godowns = [...totals.values()].map(finish)
    .sort((a, b) => b.sales - a.sales || a.godown.localeCompare(b.godown));
  const all = godowns.reduce((sum, row) => {
    const next = { ...sum };
    for (const key of ["orders", "cancelledOrders", "unitsSold", "sales", "discount", "netSales", "gst", "delivery", "billed",
      "collected", "due", "cost", "linesWithoutCost", "salesWithoutCost", "costedCommission", "grossProfit", "commission", "netProfit", "lossBelowCost", "cancelledValue", "deliveredOrders", "refundedOrders", "refunded"] as const)
      next[key] = rupees(sum[key] + row[key]);
    next.hourly = sum.hourly.map((value, hour) => rupees(value + row.hourly[hour]!));
    return next;
  }, emptyTotals("all", "All godowns"));
  return { godowns, all, lines };
}

/** "Profit" or "Loss" for a net amount. */
export const profitOrLoss = (net: number) => (net < 0 ? "Loss" : "Profit");

/** "27-10-2026 11:10" in India time. */
export function istStamp(iso: string) {
  const d = new Date(Date.parse(iso) + IST_MS);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}-${two(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** The summary columns, in report order (label, value). */
export const SUMMARY_COLUMNS: [string, (row: GodownTotals) => number | string][] = [
  ["Orders", (r) => r.orders],
  ["Delivered orders", (r) => r.deliveredOrders],
  ["Cancelled orders", (r) => r.cancelledOrders],
  ["Units sold", (r) => r.unitsSold],
  ["Sales excl. GST (₹)", (r) => r.sales],
  ["Discount (₹)", (r) => r.discount],
  ["Net sales (₹)", (r) => r.netSales],
  ["Cost of goods (₹)", (r) => r.cost],
  ["Sales without purchase rate (₹)", (r) => r.salesWithoutCost],
  ["Gross profit (₹)", (r) => r.grossProfit],
  ["Delivery charges (₹)", (r) => r.delivery],
  ["Partner commission (₹)", (r) => r.commission],
  ["Net profit / loss (₹)", (r) => r.netProfit],
  ["Result", (r) => profitOrLoss(r.netProfit)],
  ["Loss on items sold below cost (₹)", (r) => r.lossBelowCost],
  ["Cancelled sales (₹)", (r) => r.cancelledValue],
  ["Refunded (₹)", (r) => r.refunded],
  ["GST collected (₹)", (r) => r.gst],
  ["Billed incl. GST (₹)", (r) => r.billed],
  ["Collected (₹)", (r) => r.collected],
  ["Due (₹)", (r) => r.due],
];

const SALES_HEADER = ["Date & time (IST)", "Godown", "Order", "Customer", "Product", "Qty", "Rate (₹)", "Sale excl. GST (₹)",
  "Purchase rate (₹)", "Cost (₹)", "Profit / loss (₹)", "Partner commission (₹)", "Order status", "Payment", "In Zoho", "Zoho invoice"];
const saleRow = (line: SaleLine) => [istStamp(line.time), line.godown, line.orderNo, line.customer, line.product, line.qty, line.unitPrice,
  line.lineTotal, line.unitCost, line.cost, line.margin, line.commission, line.orderStatus, line.paymentStatus, line.inZoho ? "Yes" : "No", line.invoice];
const SALES_WIDTHS = [18, 26, 28, 18, 40, 6, 11, 14, 12, 12, 13, 12, 16, 12, 8, 26];

type Report = ReturnType<typeof buildGodownReport>;

/**
 * The report as Excel sheets: a Summary sheet (every godown and the total), one sheet per godown
 * (its figures, sales by hour and every sale) and All sales. With `godownId`, only that godown.
 */
export function godownReportSheets(report: Report, meta: { period: string; generatedAt: string }, godownId?: string): XlsxSheet[] {
  const rows = godownId ? report.godowns.filter((row) => row.godownId === godownId) : report.godowns;
  const intro = (title: string) => [
    [title],
    [`Period: ${meta.period}`, null, null, `Generated: ${istStamp(meta.generatedAt)} IST`],
    ["Amounts in ₹. Sales before GST. Cost = purchase rate of each item (Zoho item purchase rate). Lines without a purchase rate are left out of profit."],
    [],
  ];
  const summaryHead = intro(godownId ? `Godown report · ${rows[0]?.godown ?? godownId}` : "Godown report · all godowns");
  const summary: XlsxSheet = {
    name: "Summary",
    rows: [
      ...summaryHead,
      ["Godown", ...SUMMARY_COLUMNS.map(([label]) => label)],
      ...rows.map((row) => [row.godown, ...SUMMARY_COLUMNS.map(([, value]) => value(row))]),
      ...(godownId ? [] : [["Total", ...SUMMARY_COLUMNS.map(([, value]) => value(report.all))]]),
    ],
    boldRows: [0, summaryHead.length, ...(godownId ? [] : [summaryHead.length + rows.length + 1])],
    widths: [30, ...SUMMARY_COLUMNS.map(([label]) => Math.max(10, Math.min(22, label.length + 2)))],
  };
  const perGodown = rows.map((row): XlsxSheet => {
    const lines = report.lines.filter((line) => line.godownId === row.godownId);
    const head = intro(`${row.godown} · godown report`);
    const figures = SUMMARY_COLUMNS.map(([label, value]) => [label, value(row)]);
    const hours = row.hourly.map((sales, hour) => ({ hour, sales })).filter((h) => h.sales > 0);
    const hourStart = head.length + figures.length + 1;
    const salesStart = hourStart + hours.length + 2;
    return {
      name: row.godown,
      rows: [
        ...head,
        ...figures,
        [],
        ["Sales by hour (IST)", "Sales excl. GST (₹)"],
        ...hours.map((h) => [`${String(h.hour).padStart(2, "0")}:00–${String(h.hour + 1).padStart(2, "0")}:00`, h.sales]),
        [],
        SALES_HEADER,
        ...(lines.length ? lines.map(saleRow) : [["No sales in this period"]]),
      ],
      // Title, the net profit / loss line, and the two table headers.
      boldRows: [0, head.length + 12, hourStart, salesStart],
      widths: SALES_WIDTHS,
    };
  });
  const allSales: XlsxSheet = {
    name: "All sales",
    rows: [SALES_HEADER, ...report.lines.filter((line) => !godownId || line.godownId === godownId).map(saleRow)],
    boldRows: [0],
    widths: SALES_WIDTHS,
  };
  return godownId ? [summary, ...perGodown] : [summary, ...perGodown, allSales];
}
