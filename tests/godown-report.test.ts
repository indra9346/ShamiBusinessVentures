import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGodownReport, istHour, istRange, istToday, NO_GODOWN, profitOrLoss, type ReportOrder } from "../src/lib/godown-report.ts";

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
    commissions: {},
  });
  const direct = report.godowns.find((row) => row.godownId === NO_GODOWN)!;
  assert.equal(direct.linesWithoutCost, 1);
  assert.equal(direct.salesWithoutCost, 500);
  assert.equal(direct.cost, 0);
  assert.equal(direct.grossProfit, 0); // not ₹500 of "profit"
  assert.equal(report.lines[0]!.margin, null);
  // A godown with no sales that day is still in the report.
  assert.equal(report.godowns.find((row) => row.godownId === "BR-CLK")!.sales, 0);
});
