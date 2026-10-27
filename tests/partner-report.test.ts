import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportOrder } from "../src/lib/godown-report.ts";
import {
  attributeOrders, buildPartnerReport, partnerReportSheets, partnerSafeReport, targetForPeriod, type ReportPartner,
} from "../src/lib/partner-report.ts";

const partner = (id: string, branchId: string, createdAt: string, name = id): ReportPartner => ({
  id, name, email: `${id}@test.in`, phone: "", branchId, godown: branchId === "BR-CLK" ? "Challakere" : "Hubli", status: "active", createdAt,
});
const order = (id: string, branch: string | null, at: string, extra: Partial<ReportOrder> = {}): ReportOrder => ({
  id, order_no: `ORD-${id}`, branch_id: branch, created_at: at, order_status: "Placed", payment_status: "Pending", customer_name: "Kiran",
  subtotal: 1000, discount: 0, gst_amount: 50, shipping: 0, total: 1050, paid_amount: 0, ...extra,
});

test("orders belong to the godown's partner from the day the login was made; a commission decides first", () => {
  const partners = [partner("old", "BR-CLK", "2026-10-01T00:00:00Z"), partner("new", "BR-CLK", "2026-10-20T00:00:00Z"), partner("hbl", "BR-HBL", "2026-10-26T00:00:00Z")];
  const owner = attributeOrders([
    order("1", "BR-CLK", "2026-10-10T00:00:00Z"), // before "new" existed
    order("2", "BR-CLK", "2026-10-25T00:00:00Z"),
    order("3", "BR-HBL", "2026-10-25T00:00:00Z"), // before the Hubli partner existed: nobody's
    order("4", null, "2026-10-25T00:00:00Z"),
    order("5", "BR-CLK", "2026-10-25T00:00:00Z"),
  ], partners, [{ order_item_id: "i5", order_id: "5", partner_id: "old", amount: 1, status: "pending", kind: "per_unit", rate: 1, line_total: 1000 }]);
  assert.equal(owner.get("1"), "old");
  assert.equal(owner.get("2"), "new");
  assert.equal(owner.has("3"), false);
  assert.equal(owner.has("4"), false);
  assert.equal(owner.get("5"), "old");
});

test("targets add up over the months the period touches", () => {
  const targets = [{ partner_id: "p", month: "2026-10-01", target_sales: 50000 }, { partner_id: "p", month: "2026-11-01", target_sales: 60000 }, { partner_id: "x", month: "2026-10-01", target_sales: 1 }];
  assert.equal(targetForPeriod(targets, "p", "2026-10-27", "2026-10-27"), 50000);
  assert.equal(targetForPeriod(targets, "p", "2026-10-15", "2026-11-03"), 110000);
  assert.equal(targetForPeriod(targets, "p", "2026-12-01", "2026-12-31"), 0);
});

test("partner figures: sales, cost, profit, commission by status, target and rank", () => {
  const report = buildPartnerReport({
    partners: [partner("clk", "BR-CLK", "2026-10-01T00:00:00Z", "Sandesh"), partner("hbl", "BR-HBL", "2026-10-01T00:00:00Z", "Mallikarjun")],
    orders: [
      order("1", "BR-CLK", "2026-10-27T05:00:00Z", { order_status: "Delivered", payment_status: "Paid", paid_amount: 1050 }),
      order("2", "BR-CLK", "2026-10-27T06:00:00Z", { order_status: "Cancelled" }),
      order("3", "BR-HBL", "2026-10-27T07:00:00Z", { subtotal: 3000, total: 3150 }),
    ],
    items: [
      { id: "i1", order_id: "1", product_id: "SUGAR", product_name: "Sugar", qty: 1, unit_price: 1000, line_total: 1000 },
      { id: "i2", order_id: "2", product_id: "SUGAR", product_name: "Sugar", qty: 1, unit_price: 1000, line_total: 1000 },
      { id: "i3", order_id: "3", product_id: "RICE", product_name: "Rice", qty: 2, unit_price: 1500, line_total: 3000 },
    ],
    costs: { SUGAR: 900, RICE: 1600 },
    commissionRows: [
      { order_item_id: "i1", order_id: "1", partner_id: "clk", amount: 25, status: "earned", kind: "per_unit", rate: 25, line_total: 1000 },
      { order_item_id: "i2", order_id: "2", partner_id: "clk", amount: 25, status: "cancelled", kind: "per_unit", rate: 25, line_total: 1000 },
      { order_item_id: "i3", order_id: "3", partner_id: "hbl", amount: 30, status: "pending", kind: "per_unit", rate: 15, line_total: 3000 },
    ],
    targets: [{ partner_id: "clk", month: "2026-10-01", target_sales: 2000 }],
    from: "2026-10-27",
    to: "2026-10-27",
  });
  const clk = report.partners.find((row) => row.partner.id === "clk")!;
  assert.equal(clk.godown, "Sandesh");
  assert.equal(clk.partner.godown, "Challakere");
  assert.equal(clk.sales, 1000);
  assert.equal(clk.cost, 900);
  assert.equal(clk.grossProfit, 100);
  assert.equal(clk.commissionEarned, 25);
  assert.equal(clk.commissionCancelled, 25);
  assert.equal(clk.commission, 25); // the cancelled line's commission is not counted
  assert.equal(clk.netProfit, 75);
  assert.equal(clk.eligibleSales, 1000);
  assert.equal(clk.achievedPercent, 50);
  assert.equal(clk.rank, 1); // 50% of target beats no target

  const hbl = report.partners.find((row) => row.partner.id === "hbl")!;
  assert.equal(hbl.commissionPending, 30);
  assert.equal(hbl.lossBelowCost, 200);
  assert.equal(hbl.achievedPercent, null);
  assert.equal(hbl.rank, 2);

  assert.equal(report.all.sales, 4000);
  assert.equal(report.all.commissionEarned, 25);
  assert.equal(report.lines.find((line) => line.itemId === "i3")!.rate, "₹15 per unit");
  assert.equal(report.lines.find((line) => line.itemId === "i1")!.godown, "Challakere");

  // Sheets: Summary + one per partner; a partner's own copy has no cost or profit.
  const meta = { period: "27 Oct 2026", generatedAt: "2026-10-27T07:00:00Z" };
  const adminSheets = partnerReportSheets(report, meta, { audience: "admin" });
  assert.deepEqual(adminSheets.map((s) => s.name), ["Summary", "Sandesh", "Mallikarjun"]);
  assert.ok(adminSheets[0]!.rows[4]!.includes("Cost of goods (₹)"));
  const own = partnerReportSheets(partnerSafeReport(report), meta, { audience: "partner", partnerId: "hbl" });
  assert.deepEqual(own.map((s) => s.name), ["Summary", "Mallikarjun"]);
  const text = JSON.stringify(own);
  assert.ok(!text.includes("Cost of goods") && !text.includes("Gross profit") && !text.includes("Purchase rate"));
  assert.ok(!text.includes("Sandesh")); // never another partner's data
  assert.equal(partnerSafeReport(report).lines.every((line) => line.cost === null && line.margin === null), true);
});
