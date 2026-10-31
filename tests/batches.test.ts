import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressLine, batchAdjustmentSheet, batchReportSheets, buildBatchReport, daysBetween, formatBatchCode, godownCodeOf, isBatchCode,
  normalizeBatchCode, packageLinesWithBatches, planBatchGain, planBatchLoss, planZohoBatchIn, planZohoBatchOut, searchBatchReport,
  zohoBatchesAtLocation, zohoTracksBatches, type BatchOrder, type BatchRecord,
} from "../src/lib/batches.ts";
import { buildXlsx } from "../src/lib/xlsx.ts";

const CLK = "3579709000000848001", HBL = "3579709000003110061";

test("batch numbers: godown code, purchase date DDMMYY, running number", () => {
  assert.equal(formatBatchCode("clk", "2026-10-31", 1), "CLK-311026-01");
  assert.equal(formatBatchCode("HBL", "2026-11-05T10:00:00Z", 12), "HBL-051126-12");
  assert.equal(godownCodeOf({ id: "BR-CLK", code: "CLK" }), "CLK");
  assert.equal(godownCodeOf({ id: "BR-HBL", code: "" }), "HBL");
  assert.equal(normalizeBatchCode("  clk-311026-01 "), "CLK-311026-01");
  assert.ok(isBatchCode("clk-311026-01"));
  assert.ok(isBatchCode("SUP/LOT.7_A"));
  assert.ok(!isBatchCode("X"));
  assert.ok(!isBatchCode("CLK 311026"));
  assert.ok(!isBatchCode("-CLK"));
  assert.equal(daysBetween("2026-10-20", "2026-10-29"), 9);
  assert.equal(daysBetween("2026-10-31", "2026-11-01"), 1);
});

const stock = (id: string, date: string, remaining: number, zohoBatchId = "") =>
  ({ id, batchCode: id.toUpperCase(), purchaseDate: date, createdAt: `${date}T05:00:00Z`, remaining, zohoBatchId });

test("a loss comes out of the oldest batch first; a gain goes to the newest", () => {
  const batches = [stock("b2", "2026-10-30", 5), stock("b1", "2026-10-20", 2), stock("b0", "2026-10-10", 0)];
  assert.deepEqual(planBatchLoss(batches, 3), { shares: [{ batchId: "b1", qty: -2 }, { batchId: "b2", qty: -1 }], rest: 0 });
  // More than the batches hold: the rest is stock without a batch.
  assert.deepEqual(planBatchLoss(batches, 9), { shares: [{ batchId: "b1", qty: -2 }, { batchId: "b2", qty: -5 }], rest: 2 });
  assert.deepEqual(planBatchLoss([], 1), { shares: [], rest: 1 });
  assert.deepEqual(planBatchGain(batches, 4), { shares: [{ batchId: "b2", qty: 4 }], rest: 0 });
  assert.deepEqual(planBatchGain([], 4), { shares: [], rest: 4 });
});

// GET /items/batches?item_id=… (Zoho Inventory API v1 docs, list response), trimmed.
const zohoList = [
  { batch_id: "3579709000004000003", batch_number: "CLK-301026-01", status: "active", manufactured_date: "2026-10-01", expiry_date: "2027-04-01",
    associated_locations: [{ location_id: CLK, in_quantity: 50, balance_quantity: 30 }, { location_id: HBL, in_quantity: 5, balance_quantity: 5 }] },
  { batch_id: "3579709000004000001", batch_number: "CLK-201026-01", status: "active",
    associated_locations: [{ location_id: CLK, in_quantity: 50, balance_quantity: 2 }] },
  { batch_id: "3579709000004000009", batch_number: "OLD", status: "inactive", associated_locations: [{ location_id: CLK, balance_quantity: 9 }] },
  { batch_id: "3579709000004000010", batch_number: "SINGLE", location_id: HBL, in_quantity: 4, balance_quantity: 4 },
];

test("Zoho batches at a location: per-location balance, oldest first, inactive left out", () => {
  const clk = zohoBatchesAtLocation(zohoList, CLK);
  assert.deepEqual(clk.map((b) => [b.batchNumber, b.balance, b.inQuantity]), [["CLK-201026-01", 2, 50], ["CLK-301026-01", 30, 50]]);
  assert.equal(clk[1]!.manufacturedDate, "2026-10-01");
  assert.deepEqual(zohoBatchesAtLocation(zohoList, HBL).map((b) => [b.batchNumber, b.balance]), [["CLK-301026-01", 5], ["SINGLE", 4]]);
  assert.deepEqual(zohoBatchesAtLocation(undefined, CLK), []);
  assert.equal(zohoTracksBatches({ track_batch_number: true }), true);
  assert.equal(zohoTracksBatches({ track_batch_number: false }), false);
  assert.equal(zohoTracksBatches(undefined), false);
});

test("Zoho out: the website's reserved batches first, then Zoho's oldest; short when Zoho lacks stock", () => {
  const clk = zohoBatchesAtLocation(zohoList, CLK);
  assert.deepEqual(planZohoBatchOut(clk, 3), { lines: [{ batch_id: "3579709000004000001", out_quantity: 2 }, { batch_id: "3579709000004000003", out_quantity: 1 }], short: 0 });
  // The order took 3 from the newer batch: Zoho is told exactly that.
  assert.deepEqual(planZohoBatchOut(clk, 3, [{ zohoBatchId: "3579709000004000003", qty: 3 }]).lines, [{ batch_id: "3579709000004000003", out_quantity: 3 }]);
  // A reserved batch Zoho no longer holds enough of: the rest from the oldest.
  assert.deepEqual(planZohoBatchOut(clk, 4, [{ zohoBatchId: "3579709000004000001", qty: 4 }]).lines,
    [{ batch_id: "3579709000004000001", out_quantity: 2 }, { batch_id: "3579709000004000003", out_quantity: 2 }]);
  assert.equal(planZohoBatchOut(clk, 40).short, 8);
  assert.deepEqual(planZohoBatchIn(clk, 5, "CLK-311026-01"), [{ batch_id: "3579709000004000003", in_quantity: 5 }]);
  assert.deepEqual(planZohoBatchIn([], 5, "CLK-311026-01"), [{ batch_number: "CLK-311026-01", in_quantity: 5 }]);
});

test("package lines name batches only for batch-tracked items", () => {
  const soLines = [
    { line_item_id: "L1", item_id: "OIL", name: "Groundnut Oil 5L Can", quantity: 3, track_batch_number: true },
    { line_item_id: "L2", item_id: "SUGAR", name: "S1 Sugar", quantity: 2, track_batch_number: false },
    { line_item_id: "L3", item_id: "OIL", name: "Groundnut Oil 5L Can", quantity: 1, track_batch_number: true },
    { line_item_id: "L4", item_id: "OIL", quantity: 0, track_batch_number: true },
  ];
  const zoho = new Map([["OIL", zohoBatchesAtLocation(zohoList, CLK)]]);
  const reserved = new Map([["OIL", [{ zohoBatchId: "3579709000004000003", qty: 3 }]]]);
  const { lines, problems } = packageLinesWithBatches(soLines, reserved, zoho);
  assert.deepEqual(problems, []);
  assert.deepEqual(lines, [
    { so_line_item_id: "L1", quantity: 3, batches: [{ batch_id: "3579709000004000003", out_quantity: 3 }] },
    { so_line_item_id: "L2", quantity: 2 },
    // The second line of the same item shares what the first left: the reserved batch again first.
    { so_line_item_id: "L3", quantity: 1, batches: [{ batch_id: "3579709000004000003", out_quantity: 1 }] },
  ]);
  const short = packageLinesWithBatches([{ line_item_id: "L1", item_id: "OIL", name: "Oil", quantity: 50, track_batch_number: true }], new Map(), zoho);
  assert.deepEqual(short.problems, ["Oil: Zoho has 32 of 50 in batches at this godown"]);
});

const batch = (over: Partial<BatchRecord>): BatchRecord => ({
  id: "b1", batch_code: "CLK-201026-01", product_id: "P023", product_name: "Groundnut Oil 5L Can", branch_id: "BR-CLK",
  quantity: 50, remaining_quantity: 0, unit: "pack", unit_cost: 800, purchase_date: "2026-10-20", mfg_date: null, expiry_date: null,
  status: "Depleted", source: "website", supplier: "Sri Oils", purchase_ref: "BILL-1", notes: "", received_by_name: "Admin",
  zoho_batch_id: "", zoho_adjustment_id: "", zoho_balance: null, zoho_checked_at: null, depleted_at: "2026-10-29T08:00:00Z",
  created_at: "2026-10-20T05:00:00Z", ...over,
});
const order = (id: string, status: string, over: Partial<BatchOrder> = {}): BatchOrder => ({
  id, order_no: `CLK-${id}`, created_at: "2026-10-25T04:45:00Z", order_status: status, payment_status: "Paid", branch_id: "BR-CLK",
  user_id: `u-${id}`, customer_name: `Customer ${id}`, customer_email: `${id}@example.com`, customer_phone: "9876500011",
  shipping_address: { line1: "Main Road", city: "Challakere", pin: "577522" }, subtotal: 10000, discount: 0, ...over,
});

test("batch report: sold, delivered, held, cancelled, lost, sales, profit, days to sell out", () => {
  const report = buildBatchReport({
    batches: [
      batch({}),
      batch({ id: "b2", batch_code: "CLK-301026-01", quantity: 20, remaining_quantity: 9, unit_cost: 820, purchase_date: "2026-10-30", status: "Active", depleted_at: null,
        zoho_batch_id: "Z2", zoho_balance: 12, created_at: "2026-10-30T05:00:00Z" }),
      batch({ id: "b3", batch_code: "HBL-251026-01", branch_id: "BR-HBL", quantity: 10, remaining_quantity: 10, purchase_date: "2026-10-25", status: "Active", depleted_at: null }),
    ],
    allocations: [
      { id: "a1", order_item_id: "i1", batch_id: "b1", reserved_quantity: 30, released_quantity: 0, unit_cost: 800, created_at: "" },
      { id: "a2", order_item_id: "i2", batch_id: "b1", reserved_quantity: 18, released_quantity: 0, unit_cost: 800, created_at: "" },
      { id: "a3", order_item_id: "i3", batch_id: "b1", reserved_quantity: 5, released_quantity: 5, unit_cost: 800, created_at: "" },
      { id: "a4", order_item_id: "i4", batch_id: "b2", reserved_quantity: 2, released_quantity: 0, unit_cost: 820, created_at: "" },
      { id: "a5", order_item_id: "i5", batch_id: "b2", reserved_quantity: 1, released_quantity: 0, unit_cost: 820, created_at: "" },
      { id: "a6", order_item_id: "i6", batch_id: "b2", reserved_quantity: 7, released_quantity: 0, unit_cost: 820, created_at: "" },
    ],
    items: [
      { id: "i1", order_id: "o1", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 30, unit_price: 949, gst_rate: 5 },
      { id: "i2", order_id: "o2", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 18, unit_price: 1000, gst_rate: 5 },
      { id: "i3", order_id: "o3", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 5, unit_price: 949, gst_rate: 5 },
      { id: "i4", order_id: "o4", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 2, unit_price: 949, gst_rate: 5 },
      { id: "i5", order_id: "o5", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 1, unit_price: 949, gst_rate: 5 },
      { id: "i6", order_id: "o6", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 7, unit_price: 949, gst_rate: 5 },
    ],
    orders: [
      order("o1", "Delivered"),
      // a 10% coupon: the batch's sales are net of it
      order("o2", "Packed", { subtotal: 18000, discount: 1800, user_id: "u-o1", customer_phone: "98765 00011" }),
      order("o3", "Cancelled"),
      order("o4", "Awaiting Payment", { created_at: "2026-10-31T06:00:00Z" }),
      order("o5", "Placed", { created_at: "2026-10-31T07:00:00Z" }),
      order("o6", "Delivered", { created_at: "2026-10-31T08:00:00Z" }),
    ],
    adjustments: [
      { id: "x1", batch_id: "b1", qty: -2, reason: "damaged", note: "leak", unit_cost: 800, created_at: "2026-10-27T10:00:00Z", created_by_name: "Manju" },
      { id: "x2", batch_id: "b2", qty: -1, reason: "stock_count", note: "", unit_cost: 820, created_at: "2026-10-31T10:00:00Z", created_by_name: "Manju" },
    ],
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    today: "2026-11-01",
  });
  const b1 = report.rows.find((r) => r.batch.id === "b1")!;
  assert.deepEqual([b1.purchased, b1.sold, b1.delivered, b1.held, b1.lost, b1.available], [50, 48, 30, 0, 2, 0]);
  assert.equal(b1.sales, 30 * 949 + 18 * 900);          // 28,470 + 16,200 (coupon shared)
  assert.equal(b1.costOfSold, 48 * 800);
  assert.equal(b1.lossValue, 1600);
  assert.equal(b1.profit, 44670 - 38400 - 1600);
  assert.equal(b1.daysToSellOut, 9);
  assert.equal(b1.orders, 2);
  assert.equal(b1.customers, 1);                         // the same customer twice (o2 is u-o1)
  assert.equal(b1.ledgerGap, 0);
  assert.equal(b1.sellThrough, 96);
  const b2 = report.rows.find((r) => r.batch.id === "b2")!;
  assert.deepEqual([b2.sold, b2.held, b2.lost, b2.available, b2.daysToSellOut, b2.ageDays], [8, 2, 1, 9, null, 2]);
  assert.equal(b2.ledgerGap, 0);
  // Zoho holds available 9 + units not packed yet (2 held + 1 placed) = 12: no difference.
  assert.equal(b2.zohoGap, 0);
  assert.equal(report.rows.find((r) => r.batch.id === "b3")!.zohoGap, null);
  // Godown totals
  const clk = report.godowns.find((g) => g.godownId === "BR-CLK")!;
  assert.deepEqual([clk.batches, clk.active, clk.sold, clk.available, clk.averageDaysToSellOut], [2, 1, 56, 9, 9]);
  assert.equal(report.godowns.find((g) => g.godownId === "BR-HBL")!.available, 10);
  assert.equal(report.all.purchased, 80);
  // Sales lines: newest first, held ones flagged, cancelled left out
  assert.deepEqual(report.sales.map((s) => [s.orderNo, s.held]), [["CLK-o6", false], ["CLK-o5", false], ["CLK-o4", true], ["CLK-o1", false], ["CLK-o2", false]]);
  assert.equal(report.sales.find((s) => s.orderNo === "CLK-o1")!.customerAddress, "Main Road, Challakere, 577522");
  // Back-tracking: customer u-o1 bought from b1 (two orders); held units don't count as bought
  const ravi = report.customers.find((c) => c.key === "u-o1")!;
  assert.deepEqual([ravi.orders.sort(), ravi.batches, ravi.qty], [["CLK-o1", "CLK-o2"], ["CLK-201026-01"], 48]);
  assert.equal(report.customers.find((c) => c.key === "u-o4")!.qty, 0);

  // Search: by phone, order number, batch number, product
  assert.deepEqual(searchBatchReport(report, "CLK-o6").rows.map((r) => r.batch.id), ["b2"]);
  assert.deepEqual(searchBatchReport(report, "hbl-25").rows.map((r) => r.batch.id), ["b3"]);
  assert.equal(searchBatchReport(report, "98765 00011").customers.length, 4);
  assert.equal(searchBatchReport(report, "").rows.length, 3);

  // Excel: dashboard, batches, sales per batch, customers per batch (+ losses)
  const sheets = batchReportSheets(report, { generatedAt: "2026-11-01T04:30:00Z", scope: "All godowns" });
  assert.deepEqual(sheets.map((s) => s.name), ["Dashboard", "Batches", "Sales per batch", "Customers per batch"]);
  assert.equal(sheets[1]!.rows.length, 4);
  assert.equal(sheets[1]!.rows[0]![0], "Batch no.");
  assert.equal(sheets[2]!.rows.length, 6);
  assert.match(String(sheets[0]!.rows[1]![3]), /2026-11-01 10:00 IST/);
  const losses = batchAdjustmentSheet([
    { id: "x1", batch_id: "b1", qty: -2, reason: "damaged", note: "leak", unit_cost: 800, created_at: "2026-10-27T10:00:00Z", created_by_name: "Manju" },
  ], new Map([["b1", { code: "CLK-201026-01", product: "Groundnut Oil 5L Can", godown: "Challakere" }]]));
  assert.deepEqual(losses.rows[1]!.slice(1, 8), ["CLK-201026-01", "Groundnut Oil 5L Can", "Challakere", -2, "Damaged / spoiled", "leak", -1600]);
  const file = buildXlsx([...sheets, losses]);
  assert.equal(String.fromCharCode(file[0]!, file[1]!), "PK");
});

test("address line from a saved address", () => {
  assert.equal(addressLine({ line1: "12, 2nd Cross", landmark: "Near temple", city: "Hubli", state: "Karnataka", pin: "580020" }), "12, 2nd Cross, Near temple, Hubli, Karnataka, 580020");
  assert.equal(addressLine(null), "");
});
