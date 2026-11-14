import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressLine, batchAdjustmentSheet, batchLineText, batchReportSheets, buildBatchReport, costBasesOf, costBeforeGst, costCopyBeforeGst, costWithGst, daysBetween, formatBatchCode, godownCodeOf, isBatchCode,
  batchGainOf, godownStockChecks, normalizeBatchCode, packageLinesWithBatches, planBatchGain, planBatchLoss, planZohoBatchIn, planZohoBatchOut, searchBatchReport, sumTotals,
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
  assert.deepEqual(sheets.map((s) => s.name), ["Dashboard", "Batches", "Sales per batch", "Customers per batch", "Expenses", "Pre-orders"]);
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

test("GST is not a loss: a batch costed with GST from a bill compares its cost without GST with sales without GST", () => {
  // Live on 10 Nov 2026: Ekadantha OIL 850ML, bill VS903, ₹130 with GST (₹123.81 without), 12 bought, 1 sold at ₹130
  // with GST. The page said Sales ₹123.81, Cost of sold (with GST) ₹130, Loss ₹-6.19.
  const ekadantha = batch({
    id: "e1", batch_code: "CLK-031126-08", product_id: "ZI-3579709000003476321", product_name: "Ekadantha OIL 850ML", quantity: 12, remaining_quantity: 11,
    unit_cost: 130, unit_cost_ex_gst: 123.81, unit_cost_inc_gst: 130, cost_basis: "inc_gst", status: "Active", depleted_at: null,
    purchase_date: "2026-11-03", supplier: "SHAKTHIDHARA ENTERPRISES", purchase_ref: "VS903", zoho_bill_number: "VS903",
  });
  const sale = (over: Partial<BatchOrder> = {}) => order("o1", "Payment Confirmed", { subtotal: 123.81, gst_amount: 6.19, prices_include_gst: true, discount: 0, ...over });
  const report = (adjustments: Parameters<typeof buildBatchReport>[0]["adjustments"] = [], extra: BatchRecord[] = []) => buildBatchReport({
    batches: [ekadantha, ...extra],
    allocations: [{ id: "a1", order_item_id: "i1", batch_id: "e1", reserved_quantity: 1, released_quantity: 0, unit_cost: 130, created_at: "" }],
    items: [{ id: "i1", order_id: "o1", product_id: ekadantha.product_id, product_name: ekadantha.product_name, qty: 1, unit_price: 130, gst_rate: 5 }],
    orders: [sale()],
    adjustments,
    godowns: [{ id: "BR-CLK", name: "Grain Bazar Challakere Godown" }],
    today: "2026-11-10",
  });
  const row = report().rows[0]!;
  assert.equal(row.sales, 123.81);
  assert.equal(row.costOfSold, 123.81, "the cost of the sold unit is its cost without GST");
  assert.equal(row.profit, 0, "no loss");
  assert.equal(row.purchaseValue, 1485.72);
  assert.equal(row.stockValue, 1361.91);
  assert.equal(report().sales[0]!.cost, 123.81);
  assert.equal(report().sales[0]!.profit, 0);

  // A unit lost at a stock count copied the cost with GST too: it is valued without GST.
  const lost = report([{ id: "x1", batch_id: "e1", qty: -1, reason: "damaged", note: "", unit_cost: 130, created_at: "2026-11-08T10:00:00Z", created_by_name: "Manju" }]).rows[0]!;
  assert.equal(lost.lossValue, 123.81);
  assert.equal(lost.profit, -123.81);

  // Copies of either cost, or a cost edited by hand (taken as with GST), all end up before GST.
  assert.equal(costCopyBeforeGst(ekadantha, 130), 123.81);
  assert.equal(costCopyBeforeGst(ekadantha, 123.81), 123.81);
  assert.equal(Math.round(costCopyBeforeGst(ekadantha, 136.5) * 100) / 100, 130);
  assert.equal(costBeforeGst(ekadantha), 123.81);
  assert.equal(costWithGst(ekadantha), 130);
  // A bill batch stored without GST, and a cost typed in by hand, are used as they are.
  const exBatch = batch({ unit_cost: 123.81, unit_cost_ex_gst: 123.81, unit_cost_inc_gst: 130, cost_basis: "ex_gst" });
  assert.equal(costCopyBeforeGst(exBatch, 123.81), 123.81);
  assert.equal(costBeforeGst(batch({ unit_cost: 800 })), 800);
  assert.equal(costWithGst(batch({ unit_cost: 800 })), null);
  // A bill batch missing one of its costs can't be corrected and is used as stored.
  assert.equal(costCopyBeforeGst(batch({ unit_cost: 130, unit_cost_inc_gst: 130, unit_cost_ex_gst: null, cost_basis: "inc_gst" }), 130), 130);

  // Only a cost typed in by hand needs a warning now.
  assert.deepEqual(costBasesOf([{ batch: ekadantha }, { batch: exBatch }]), ["bill"]);
  assert.deepEqual(costBasesOf([{ batch: ekadantha }, { batch: batch({}) }]), ["bill", "typed"]);

  // Excel: both costs per unit, every money column before GST, and the loss sheet without GST.
  const sheets = batchReportSheets(report(), { generatedAt: "2026-11-10T10:00:00Z", scope: "All godowns" });
  const head = sheets[1]!.rows[0]!;
  const cell = (label: string) => sheets[1]!.rows[1]![head.indexOf(label)];
  assert.equal(cell("Cost per unit excl. GST (₹)"), 123.81);
  assert.equal(cell("Cost per unit incl. GST (₹)"), 130);
  assert.equal(cell("Cost of sold excl. GST (₹)"), 123.81);
  assert.equal(cell("Profit after expenses (₹)"), 0);
  assert.match(String(sheets[0]!.rows[2]![0]), /all before GST/);
  const losses = batchAdjustmentSheet(
    [{ id: "x1", batch_id: "e1", qty: -1, reason: "damaged", note: "", unit_cost: 130, created_at: "2026-11-08T10:00:00Z", created_by_name: "Manju" }],
    new Map([["e1", { code: "CLK-031126-08", product: "Ekadantha OIL 850ML", godown: "Challakere", batch: ekadantha }]]),
  );
  assert.equal(losses.rows[0]![7], "Value at cost excl. GST (₹)");
  assert.equal(losses.rows[1]![7], -123.81);
});

test("address line from a saved address", () => {
  assert.equal(addressLine({ line1: "12, 2nd Cross", landmark: "Near temple", city: "Hubli", state: "Karnataka", pin: "580020" }), "12, 2nd Cross, Near temple, Hubli, Karnataka, 580020");
  assert.equal(addressLine(null), "");
});

test("batch number as text on Zoho lines and packages", () => {
  assert.equal(batchLineText([{ code: "CLK-311026-01", qty: 2 }], 2), "Batch CLK-311026-01");
  assert.equal(batchLineText([{ code: "CLK-301026-01", qty: 2 }, { code: "CLK-311026-01", qty: 1 }], 3), "Batches CLK-301026-01 x2, CLK-311026-01 x1");
  // part of the line came from stock without a batch
  assert.equal(batchLineText([{ code: "CLK-311026-01", qty: 1 }], 3), "Batch CLK-311026-01 x1");
  assert.equal(batchLineText([], 3), "");
  assert.equal(batchLineText([{ code: "CLK-311026-01", qty: 0 }], 3), "");
});

test("review fixes: saved-address 'line', one sale per order line and batch, totals of a filter", () => {
  assert.equal(addressLine({ line: "Market Road", city: "Challakere", state: "Karnataka", pin: "577522" }), "Market Road, Challakere, Karnataka, 577522");
  const report = buildBatchReport({
    batches: [
      batch({ remaining_quantity: 45, status: "Active", depleted_at: null }),
      batch({ id: "b9", batch_code: "HBL-311026-01", branch_id: "BR-HBL", quantity: 5, remaining_quantity: 5, status: "Active", depleted_at: null }),
    ],
    allocations: [
      // the admin raised the line from 3 to 5: a second allocation on the same batch
      { id: "a1", order_item_id: "i1", batch_id: "b1", reserved_quantity: 3, released_quantity: 0, unit_cost: 800, created_at: "" },
      { id: "a2", order_item_id: "i1", batch_id: "b1", reserved_quantity: 2, released_quantity: 0, unit_cost: 800, created_at: "" },
    ],
    items: [{ id: "i1", order_id: "o1", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 5, unit_price: 949, gst_rate: 5 }],
    orders: [order("o1", "Delivered", { shipping_address: { line: "Market Road", city: "Challakere", pin: "577522" } })],
    adjustments: [],
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    today: "2026-11-01",
  });
  assert.equal(report.sales.length, 1);
  assert.deepEqual([report.sales[0]!.qty, report.sales[0]!.orderItemId, report.sales[0]!.customerAddress], [5, "i1", "Market Road, Challakere, 577522"]);
  assert.equal(report.rows.find((r) => r.batch.id === "b1")!.sold, 5);
  // One godown's totals, not the company's
  const hubli = sumTotals(report.rows.filter((r) => r.batch.branch_id === "BR-HBL"));
  assert.deepEqual([hubli.purchased, hubli.sold, hubli.available], [5, 0, 5]);
  assert.deepEqual([report.all.purchased, report.all.sold], [55, 5]);
});

test("13 Nov: a bill's batch reaching the godown's stock is not a gain; only stock beyond the batches is", () => {
  // Live: CLK-131126-02, Sugar S1, 360 from a bill; Challakere's stock 0 until it was set to 360 by hand.
  const sugar = [stock("sugar", "2026-11-13", 360)];
  assert.equal(batchGainOf(sugar, 360, 360), 0);
  // Part of it there already (Zoho receive synced 100): raising to 360 is still the batch arriving.
  assert.equal(batchGainOf(sugar, 360, 260), 0);
  // 365 counted: 5 more than any batch holds is found stock.
  assert.equal(batchGainOf(sugar, 365, 365), 5);
  // Batches already counted in full (stock 360, batch 360): every unit of a rise is a gain, as before.
  assert.equal(batchGainOf(sugar, 370, 10), 10);
  // No batches: everything beyond them is a gain (planBatchGain then has nothing to attach it to).
  assert.equal(batchGainOf([], 12, 12), 12);
  // Emptied batches hold nothing.
  assert.equal(batchGainOf([stock("old", "2026-10-01", 0), stock("new", "2026-11-01", 4)], 10, 10), 6);
  // The live sequence +360, −360, +360 ends with the batch at 360 and no gain or loss left over.
  let remaining = 360;
  const gain1 = batchGainOf([{ remaining }], 360, 360);
  remaining += gain1;
  const loss = planBatchLoss([stock("sugar", "2026-11-13", remaining)], 360).shares.reduce((s, x) => s + x.qty, 0);
  remaining += loss;
  const gain2 = batchGainOf([{ remaining }], 360, 360);
  remaining += gain2;
  assert.deepEqual([gain1, loss, gain2, remaining], [0, -360, 360, 360]);
});

test("13 Nov: stock check puts each product's batches next to its godown's stock", () => {
  const report = buildBatchReport({
    batches: [
      batch({ id: "s1", batch_code: "CLK-131126-02", product_id: "SUGAR", product_name: "Sugar S1", quantity: 360, remaining_quantity: 360, status: "Active", depleted_at: null }),
      batch({ id: "o1", batch_code: "CLK-031126-08", product_id: "OIL", product_name: "Ekadantha OIL", quantity: 12, remaining_quantity: 9, status: "Active", depleted_at: null }),
      batch({ id: "o2", batch_code: "CLK-051126-01", product_id: "OIL", product_name: "Ekadantha OIL", quantity: 3, remaining_quantity: 3, status: "Active", depleted_at: null }),
      batch({ id: "h1", batch_code: "HBL-061126-01", branch_id: "BR-HBL", product_id: "OIL", product_name: "Ekadantha OIL", quantity: 5, remaining_quantity: 5, status: "Active", depleted_at: null }),
    ],
    allocations: [], items: [], orders: [], adjustments: [],
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    today: "2026-11-13",
  });
  const stockAt: Record<string, number> = { "SUGAR|BR-CLK": 0, "OIL|BR-CLK": 14, "OIL|BR-HBL": 5 };
  const checks = godownStockChecks(report.rows, (product, godown) => stockAt[`${product}|${godown}`] ?? 0);
  assert.deepEqual(checks.map((c) => [c.godown, c.productName, c.inBatches, c.godownStock, c.difference]), [
    ["Challakere", "Ekadantha OIL", 12, 14, 2],   // 2 units without a batch
    ["Challakere", "Sugar S1", 360, 0, -360],     // the bill's units not in the godown's stock yet
    ["Hubli", "Ekadantha OIL", 5, 5, 0],
  ]);
});

// ------------------------------------------------------------------ 14 Nov 2026: expenses, landed cost, pre-orders (spec 9)

const sugarOrder = (id: string, status = "Payment Confirmed", qty = 20) => ({
  order: order(id, status, { subtotal: Math.round(qty * 2741 * 100 / 105 * 100) / 100, gst_amount: Math.round(qty * 2741 * 5 / 105 * 100) / 100, prices_include_gst: true, discount: 0 }),
  item: { id: `i-${id}`, order_id: id, product_id: "SUGAR", product_name: "Sugar S1", qty, unit_price: 2741, gst_rate: 5 },
});
const costDoc = (id: number, cost: number, over: Record<string, unknown> = {}) => ({
  id, source: "expense", zoho_id: `E-${id}`, zoho_line_id: "", doc_number: `EXP-${id}`, doc_date: "2026-11-14", account_id: "", account_name: "Freight",
  vendor_name: "", description: "", amount_before_gst: cost, gst_amount: 0, gst_claimable: true, gst_override: null, reverse_charge: false, rebilled: false,
  cost_amount: cost, accepted_cost_amount: cost, zoho_status: "nonbillable", zoho_modified: "", flag: "", flag_at: null, gone_at: null, checked_at: null, ...over,
});
const costTag = (id: number, documentId: number, batchId: string, amount: number) =>
  ({ id, document_id: documentId, batch_id: batchId, amount, method: "bags", weight: 0, note: "", tagged_by_name: "Admin", tagged_at: "2026-11-14T05:00:00Z" });

test("a pre-order batch: nothing bought yet, sales costed with the estimate, the ledger and the cost check agree", () => {
  const lot = batch({
    id: "lot", batch_code: "CLK-141126-01", product_id: "SUGAR", product_name: "Sugar S1", quantity: 360, remaining_quantity: 340, unit_cost: 2500,
    unit_cost_ex_gst: 2500, cost_basis: "ex_gst", stage: "incoming", expected_quantity: 360, expected_date: "2026-11-20", est_unit_cost_ex_gst: 2500,
    status: "Active", depleted_at: null, purchase_date: "2026-11-14",
  });
  const a = sugarOrder("o1");
  const report = buildBatchReport({
    batches: [lot], allocations: [{ id: "a1", order_item_id: a.item.id, batch_id: "lot", reserved_quantity: 20, released_quantity: 0, unit_cost: 2500, created_at: "" }],
    items: [a.item], orders: [a.order], adjustments: [], godowns: [{ id: "BR-CLK", name: "Challakere" }], today: "2026-11-14",
    costDocuments: [costDoc(1, 1000.01)], costTags: [costTag(10, 1, "lot", 1000.01)],
  });
  const row = report.rows[0]!;
  assert.deepEqual([row.purchased, row.expected, row.sold, row.available, row.purchaseValue, row.stockValue], [0, 360, 20, 340, 0, 0]);
  assert.deepEqual([row.costOfSold, row.estimatedCostValue, row.costStatus, row.ledgerGap, row.costCheckGap, row.waitingOrders], [50000, 50000, "estimated", 0, 0, 1]);
  // Freight paid before the bill sits on the lot: by units, the sold ones carry their share.
  assert.deepEqual([row.expenseOnSoldValue, row.expenseInStockValue, row.expensePerUnit], [55.56, 944.45, 2.78]);
  assert.equal(row.sellThrough, 5.6);
  // It is not at the godown: the stock check leaves it out.
  assert.deepEqual(godownStockChecks(report.rows, () => 0), []);
  const sheets = batchReportSheets(report, { generatedAt: "2026-11-14T05:00:00Z", scope: "All godowns" });
  const head = sheets[1]!.rows[0]!;
  const cell = (label: string) => sheets[1]!.rows[1]![head.indexOf(label)];
  assert.deepEqual([cell("Stage"), cell("Cost status"), cell("Expected qty"), cell("Expected by"), cell("Status")], ["Pre-order (waiting for its bill)", "Estimated", 360, "20-11-2026", "Pre-order"]);
  const pre = sheets.find((s) => s.name === "Pre-orders")!;
  assert.deepEqual(pre.rows[1]!.slice(0, 9), ["CLK-141126-01", "Sugar S1", "Challakere", "Pre-order (waiting for its bill)", 360, 360, "20-11-2026", 20, 1]);
});

test("landed cost: the spec's Sugar S1 — ₹10,800 of freight and hamali on 360 bags is ₹30.00 a bag; profit after expenses", () => {
  // Matched to its bill at ₹2,527.50 before GST (estimate ₹2,500.00); 20 sold at ₹2,741 with 5% GST = ₹2,610.48 before GST.
  const sugar = batch({
    id: "s1", batch_code: "CLK-141126-01", product_id: "SUGAR", product_name: "Sugar S1", quantity: 360, remaining_quantity: 340, unit_cost: 2527.5,
    unit_cost_ex_gst: 2527.5, unit_cost_inc_gst: 2653.88, cost_basis: "ex_gst", stage: "received", expected_quantity: 360, est_unit_cost_ex_gst: 2500,
    matched_at: "2026-11-20T06:00:00Z", zoho_bill_number: "P1", status: "Active", depleted_at: null, purchase_date: "2026-11-20",
  });
  const a = sugarOrder("o1");
  const input = (docs: ReturnType<typeof costDoc>[]) => ({
    batches: [sugar], allocations: [{ id: "a1", order_item_id: a.item.id, batch_id: "s1", reserved_quantity: 20, released_quantity: 0, unit_cost: 2527.5, created_at: "" }],
    items: [a.item], orders: [a.order], adjustments: [], godowns: [{ id: "BR-CLK", name: "Challakere" }], today: "2026-11-20",
    // ₹9,000 freight (reverse charge, claimed: not a cost) and ₹1,800 hamali.
    costDocuments: docs, costTags: [costTag(10, 1, "s1", 9000), costTag(11, 2, "s1", 1800)],
  });
  const row = buildBatchReport(input([costDoc(1, 9000, { gst_amount: 450, reverse_charge: true }), costDoc(2, 1800, { account_name: "Hamali" })])).rows[0]!;
  assert.deepEqual([row.expenseValue, row.expensePerUnit, row.landedUnitCost], [10800, 30, 2557.5]);
  assert.equal(row.sales, 52209.52);
  assert.equal(row.costOfSold, 50550);
  assert.equal(row.profitBeforeExpenses, 1659.52);                // ₹82.98 a bag
  assert.deepEqual([row.expenseOnSoldValue, row.expenseInStockValue], [600, 10200]);
  assert.equal(row.profit, 1059.52);                              // ₹52.98 a bag
  assert.equal(Math.round(row.profit / 20 * 100) / 100, 52.98);
  assert.equal(row.costVarianceValue, 550, "20 sold × ₹27.50 more than the estimate");
  assert.equal(row.landedStockValue, 340 * 2527.5 + 10200);
  assert.deepEqual([row.costStatus, row.ledgerGap, row.costCheckGap], ["bill", 0, 0]);
  // Zoho now has the freight at ₹8,000: the P&L counts at most that (tags scaled), never the ₹9,000 tagged.
  const fell = buildBatchReport(input([costDoc(1, 8000, { accepted_cost_amount: 9000, flag: "Expense changed in Zoho: ₹9000.00 → ₹8000.00; re-confirm the split" }), costDoc(2, 1800)]));
  assert.equal(fell.rows[0]!.expenseValue, 9800);
  assert.deepEqual(fell.expenses.map((e) => [e.reference, e.tagged, e.effective]), [["EXP-1", 9000, 8000], ["EXP-2", 1800, 1800]]);
  // Deleted in Zoho: counts 0.
  assert.equal(buildBatchReport(input([costDoc(1, 9000, { gone_at: "2026-11-21T00:00:00Z" }), costDoc(2, 1800)])).rows[0]!.expenseValue, 1800);
  // Excel: the new columns and one Expenses row per tag.
  const sheets = batchReportSheets(buildBatchReport(input([costDoc(1, 9000, { gst_amount: 450 }), costDoc(2, 1800)])), { generatedAt: "2026-11-20T05:00:00Z", scope: "All godowns" });
  const head = sheets[1]!.rows[0]!;
  const cell = (label: string) => sheets[1]!.rows[1]![head.indexOf(label)];
  assert.deepEqual(["Expenses (₹)", "Expense per unit (₹)", "Landed cost per unit (₹)", "Expenses on sold (₹)", "Expenses in unsold stock (₹)", "Profit before expenses (₹)",
    "Profit after expenses (₹)", "Cost variance on sold (₹)", "Cost status", "Matched on"].map(cell), [10800, 30, 2557.5, 600, 10200, 1659.52, 1059.52, 550, "From bill", "20-11-2026"]);
  assert.ok(!head.includes("Profit (₹)"));
  const exp = sheets.find((s) => s.name === "Expenses")!;
  assert.equal(exp.rows.length, 3);
  assert.deepEqual(exp.rows[0], ["Date", "Account", "Reference", "From", "Before GST (₹)", "GST (₹)", "GST claimable", "Cost (₹)", "Batch no.", "Tagged (₹)", "Counted now (₹)", "Method", "Flag"]);
  assert.deepEqual(exp.rows[1]!.slice(2, 12), ["EXP-1", "Zoho Books expense", 9000, 450, "Yes", 9000, "CLK-141126-01", 9000, 9000, "By bags"]);
  assert.match(String(sheets[0]!.rows[2]![0]), /Profit after expenses/);
});

test("expenses follow units sent to other godowns, through two transfers, with the part still on the way kept apart", () => {
  // CLK bought 100, sold 10, sent 60 (40 arrived at HBL, 20 on the way); HBL sent 20 on (15 arrived, 5 on the way).
  const parent = batch({ id: "p", batch_code: "CLK-011126-01", quantity: 100, remaining_quantity: 30, sent_quantity: 60, status: "Active", depleted_at: null });
  const child = batch({ id: "c", batch_code: "HBL-031126-01", branch_id: "BR-HBL", parent_batch_id: "p", quantity: 40, remaining_quantity: 20, sent_quantity: 20, status: "Active", depleted_at: null });
  const grand = batch({ id: "g", batch_code: "DVG-051126-01", branch_id: "BR-DVG", parent_batch_id: "c", quantity: 15, remaining_quantity: 15, status: "Active", depleted_at: null });
  const a = sugarOrder("o1", "Delivered", 10);
  const report = buildBatchReport({
    batches: [grand, child, parent],
    allocations: [{ id: "a1", order_item_id: a.item.id, batch_id: "p", reserved_quantity: 10, released_quantity: 0, unit_cost: 800, created_at: "" }],
    items: [a.item], orders: [a.order], adjustments: [], godowns: [], today: "2026-11-14",
    costDocuments: [costDoc(1, 1000)], costTags: [costTag(10, 1, "p", 1000)],
  });
  const row = (id: string) => report.rows.find((r) => r.batch.id === id)!;
  assert.deepEqual([row("p").expenseOnSoldValue, row("p").expenseOnSentValue, row("p").expenseInStockValue, row("p").expenseInTransitValue], [100, 600, 300, 200]);
  assert.deepEqual([row("c").expenseValue, row("c").inheritedExpenseValue, row("c").expenseOnSentValue, row("c").expenseInStockValue, row("c").expenseInTransitValue], [0, 400, 200, 200, 50]);
  assert.deepEqual([row("g").inheritedExpenseValue, row("g").expenseInStockValue, row("g").expensePerUnit, row("g").landedUnitCost], [150, 150, 10, 810]);
  assert.equal(row("c").expensePerUnit, 10, "₹400 over the 40 received");
  for (const id of ["p", "c", "g"]) assert.deepEqual([row(id).ledgerGap, row(id).costCheckGap], [0, 0], id);
  // Totals count the money tagged once: in stock + sold + on the way = ₹1,000.
  const all = report.all;
  assert.equal(all.expenseValue, 1000);
  assert.equal(all.inheritedExpenseValue, 550);
  assert.equal(Math.round((all.expenseOnSoldValue + all.expenseInStockValue + all.expenseInTransitValue) * 100) / 100, 1000);
});

test("a batch with no units left keeps its expenses in stock; a ledger gap shows in the cost check; totals round money as money", () => {
  const emptied = batch({ id: "e", quantity: 0, remaining_quantity: 0 });
  const r1 = buildBatchReport({ batches: [emptied], allocations: [], items: [], orders: [], adjustments: [], godowns: [], today: "2026-11-14",
    costDocuments: [costDoc(1, 10)], costTags: [costTag(10, 1, "e", 10)] }).rows[0]!;
  assert.deepEqual([r1.expenseInStockValue, r1.expenseOnSoldValue, r1.expensePerUnit, r1.landedUnitCost], [10, 0, 0, 800]);
  // 5 units missing from the ledger: the cost check is off by 5 × ₹800.
  const gap = buildBatchReport({ batches: [batch({ id: "x", quantity: 50, remaining_quantity: 45 })], allocations: [], items: [], orders: [], adjustments: [], godowns: [], today: "2026-11-14" }).rows[0]!;
  assert.deepEqual([gap.ledgerGap, gap.costCheckGap], [-5, 4000]);
  const rows = [0.1, 0.2].map((v) => ({ ...r1, expenseValue: v, profitBeforeExpenses: v, profit: v, expected: v }));
  const total = sumTotals(rows);
  assert.deepEqual([total.expenseValue, total.profitBeforeExpenses, total.profit], [0.3, 0.3, 0.3]);
  // A received batch next to a pre-order of the same product: the stock check counts the received one only.
  const report = buildBatchReport({
    batches: [batch({ id: "r", product_id: "SUGAR", product_name: "Sugar S1", quantity: 50, remaining_quantity: 50, status: "Active", depleted_at: null }),
      batch({ id: "l", product_id: "SUGAR", product_name: "Sugar S1", quantity: 360, remaining_quantity: 360, stage: "incoming", expected_quantity: 360, status: "Active", depleted_at: null }),
      batch({ id: "z", product_id: "SUGAR", product_name: "Sugar S1", quantity: 0, remaining_quantity: 0, stage: "cancelled", expected_quantity: 10 })],
    allocations: [], items: [], orders: [], adjustments: [], godowns: [{ id: "BR-CLK", name: "Challakere" }], today: "2026-11-14",
  });
  assert.deepEqual(godownStockChecks(report.rows, () => 50).map((c) => [c.inBatches, c.difference]), [[50, 0]]);
  assert.deepEqual([report.all.purchased, report.all.expected, report.all.stockValue], [50, 360, 40000]);
});
