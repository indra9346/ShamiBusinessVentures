import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGodownReport, godownReportSheets, istHour, istRange, istStamp, istToday, NO_GODOWN, profitOrLoss, type ReportOrder } from "../src/lib/godown-report.ts";

const order = (id: string, extra: Partial<ReportOrder> = {}): ReportOrder => ({
  id, order_no: `CLK-577522-271026-10000${id}`, branch_id: "BR-CLK", created_at: "2026-10-27T05:00:00Z", // 10:30 IST
  order_status: "Placed", payment_status: "Paid", customer_name: "Kiran", subtotal: 0, discount: 0, gst_amount: 0,
  shipping: 0, total: 0, paid_amount: 0, zoho_salesorder_id: "z" + id, invoice_number: null, ...extra,
});

test("India days: ranges, hour of sale and today", () => {
  assert.deepEqual(istRange("2026-10-27", "2026-10-27"), { fromIso: "2026-10-26T18:30:00.000Z", toIso: "2026-10-27T18:30:00.000Z" });
  assert.equal(istHour("2026-10-27T05:00:00Z"), 10);
  assert.equal(istHour("2026-10-26T18:45:00Z"), 0); // 00:15 IST on the 27th
  assert.equal(istToday(new Date("2026-10-26T19:00:00Z")), "2026-10-27");
});

test("per godown: sales, cost, profit, partner commission and loss below cost", () => {
  const report = buildGodownReport({
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    orders: [
      // Challakere: 2 bags of sugar at 2,399 (cost 2,200) + 5% GST, paid; and a cancelled order.
      order("1", { subtotal: 4798, gst_amount: 239.9, total: 5037.9, paid_amount: 5037.9 }),
      order("2", { order_status: "Cancelled", subtotal: 1000, total: 1050 }),
      // Hubli: rice sold below cost, ₹100 discount, ₹50 delivery, unpaid, at 14:10 IST.
      order("3", { branch_id: "BR-HBL", created_at: "2026-10-27T08:40:00Z", subtotal: 1500, discount: 100, gst_amount: 70, shipping: 50, total: 1520, paid_amount: 0, payment_status: "Pending" }),
    ],
    items: [
      { id: "i1", order_id: "1", product_id: "P001", product_name: "S1 Sugar 50kg", qty: 2, unit_price: 2399, line_total: 4798 },
      { id: "i2", order_id: "2", product_id: "P001", product_name: "S1 Sugar 50kg", qty: 1, unit_price: 1000, line_total: 1000 },
      { id: "i3", order_id: "3", product_id: "P009", product_name: "Raw Rice 25kg", qty: 1, unit_price: 1500, line_total: 1500 },
    ],
    costs: { P001: 2200, P009: 1600 },
    commissions: { i1: 20, i2: 10, i3: 10 },
  });
  const clk = report.godowns.find((row) => row.godownId === "BR-CLK")!;
  assert.equal(clk.orders, 1);
  assert.equal(clk.cancelledOrders, 1);
  assert.equal(clk.cancelledValue, 1000);
  assert.equal(clk.sales, 4798);
  assert.equal(clk.cost, 4400);
  assert.equal(clk.grossProfit, 398);
  assert.equal(clk.commission, 20); // the cancelled line's commission is not counted
  assert.equal(clk.netProfit, 378);
  assert.equal(clk.lossBelowCost, 0);
  assert.equal(clk.due, 0);
  assert.equal(clk.hourly[10], 4798);

  const hbl = report.godowns.find((row) => row.godownId === "BR-HBL")!;
  assert.equal(hbl.netSales, 1400);
  assert.equal(hbl.grossProfit, -200);
  assert.equal(hbl.lossBelowCost, 100); // sold at 1,500 against a 1,600 purchase rate
  assert.equal(hbl.netProfit, -160); // -200 + 50 delivery - 10 commission
  assert.equal(profitOrLoss(hbl.netProfit), "Loss");
  assert.equal(hbl.due, 1520);
  assert.equal(hbl.hourly[14], 1500);

  assert.equal(report.all.sales, 6298);
  assert.equal(report.all.netProfit, 218);
  assert.equal(report.lines.length, 3);
  assert.equal(report.lines[2]!.margin, -100);
});

test("unknown purchase rate is flagged, not counted as zero cost; orders without a godown are listed", () => {
  const report = buildGodownReport({
    godowns: [{ id: "BR-CLK", name: "Challakere" }],
    orders: [order("1", { branch_id: null, subtotal: 500, total: 525 })],
    items: [{ id: "i1", order_id: "1", product_id: "P050", product_name: "New oil", qty: 1, unit_price: 500, line_total: 500 }],
    costs: {},
    commissions: { i1: 2.5 },
  });
  const direct = report.godowns.find((row) => row.godownId === NO_GODOWN)!;
  assert.equal(direct.linesWithoutCost, 1);
  assert.equal(direct.salesWithoutCost, 500);
  assert.equal(direct.cost, 0);
  assert.equal(direct.grossProfit, 0); // not ₹500 of "profit"
  assert.equal(direct.commission, 2.5); // shown as commission
  assert.equal(direct.netProfit, 0); // but not as a ₹2.50 "loss" on a line whose profit is unknown
  assert.equal(report.lines[0]!.margin, null);
  // A godown with no sales that day is still in the report.
  assert.equal(report.godowns.find((row) => row.godownId === "BR-CLK")!.sales, 0);
});

test("refunds, delivered orders, vendor pickup points and the Excel sheets", () => {
  const report = buildGodownReport({
    godowns: [{ id: "BR-CLK", name: "Challakere" }],
    orders: [
      order("1", { order_status: "Delivered", subtotal: 1000, total: 1050, paid_amount: 1050 }),
      // Paid, then refunded and not cancelled (a return): neither collected nor due.
      order("2", { payment_status: "Refunded", subtotal: 500, total: 525, paid_amount: 0 }),
      // Part paid.
      order("3", { payment_status: "Partially Paid", subtotal: 2000, total: 2100, paid_amount: 1000 }),
      // A vendor pickup point keeps its own name.
      order("4", { branch_id: "VP-7", subtotal: 100, total: 105, paid_amount: 105 }),
    ],
    items: [
      { id: "i1", order_id: "1", product_id: "P1", product_name: "Rice", qty: 1, unit_price: 1000, line_total: 1000 },
      { id: "i2", order_id: "2", product_id: "P1", product_name: "Rice", qty: 1, unit_price: 500, line_total: 500 },
      { id: "i3", order_id: "3", product_id: "P1", product_name: "Rice", qty: 2, unit_price: 1000, line_total: 2000 },
      { id: "i4", order_id: "4", product_id: "P1", product_name: "Rice", qty: 1, unit_price: 100, line_total: 100 },
    ],
    costs: { P1: 400 },
    commissions: {},
    branchNames: { "VP-7": "Vendor point Hosur" },
  });
  const clk = report.godowns.find((row) => row.godownId === "BR-CLK")!;
  assert.equal(clk.deliveredOrders, 1);
  assert.equal(clk.refundedOrders, 1);
  assert.equal(clk.refunded, 525);
  assert.equal(clk.collected, 2050);
  assert.equal(clk.due, 1100); // only the part-paid order
  assert.equal(report.godowns.find((row) => row.godownId === "VP-7")!.godown, "Vendor point Hosur");

  const meta = { period: "27 Oct 2026", generatedAt: "2026-10-27T06:30:00Z" };
  const sheets = godownReportSheets(report, meta);
  assert.deepEqual(sheets.map((s) => s.name), ["Summary", "Challakere", "Vendor point Hosur", "All sales"]);
  assert.equal(sheets[0]!.rows[4]![0], "Godown");
  assert.equal(sheets[0]!.rows.at(-1)![0], "Total");
  assert.equal(sheets[3]!.rows.length, 1 + 4);
  // The godown sheet's net profit line is the bold one.
  const challakere = sheets[1]!;
  assert.equal(challakere.rows[challakere.boldRows![1]!]![0], "Net profit / loss (₹)");
  assert.equal(challakere.rows[challakere.boldRows![2]!]![0], "Sales by hour (IST)");
  assert.equal(challakere.rows[challakere.boldRows![3]!]![0], "Date & time (IST)");
  // One godown only: its summary and its own sheet, no other godown's sales.
  const one = godownReportSheets(report, meta, "BR-CLK");
  assert.deepEqual(one.map((s) => s.name), ["Summary", "Challakere"]);
  assert.ok(one[1]!.rows.every((row) => row[1] !== "Vendor point Hosur"));
  assert.equal(istStamp("2026-10-27T05:40:04Z"), "27-10-2026 11:10");
});
