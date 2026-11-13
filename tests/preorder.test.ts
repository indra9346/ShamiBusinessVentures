import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, applyReading, arrivalState, billCheckCandidates, billCheckSince, billRowLite, cachedBillLines, closeBlocker, dayLabel, defaultLineAction,
  deriveSplit, holdStep, incomingDraftProblem, incomingPreview, incomingView, istToday, lotAccepting, lotBadges, lotLabel, lotOverdue, lotSellable,
  matchCandidates, matchCostChange, matchPlan, openPurchaseOrders, openingHold, pairTotal, parsePreorderSettings, pastWindow, poLineOpen,
  preorderGoodsNote, preorderText, purchaseOrderLine, readyAfterOpening, roundTo, takeLine, trimDetail, unitsThatMove, unmatchBlocker, unreceivedLines,
  type CandidateLot, type Lot, type PreorderClock,
} from "../src/lib/preorder.ts";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";
import { kn } from "../src/lib/i18n-kn.ts";

const TODAY = "2026-11-14";
const ON: PreorderClock = { todayIst: TODAY, graceDays: 0, on: true };
const lot = (over: Partial<Lot> = {}): Lot => ({
  id: "L1", code: "CLK-141126-01", stage: "incoming", quantity: 360, remaining: 360, holdBack: 0, expectedDate: "2026-11-20", paused: false, createdAt: "2026-11-14T05:00:00Z", ...over,
});

test("settings: off by default, damaged values fall back, grace 0..14", () => {
  assert.deepEqual(parsePreorderSettings(undefined), { enabled: false, graceDays: 0, requireAck: true });
  assert.deepEqual(parsePreorderSettings({ enabled: true, graceDays: 3, requireAck: false }), { enabled: true, graceDays: 3, requireAck: false });
  assert.deepEqual(parsePreorderSettings({ enabled: "true", graceDays: 40 }), { enabled: true, graceDays: 14, requireAck: true });
  assert.equal(parsePreorderSettings({ graceDays: 2.5 }).graceDays, 0);
});

test("round like Postgres: half away from zero", () => {
  assert.equal(roundTo(2.345, 2), 2.35);
  assert.equal(roundTo(-2.345, 2), -2.35);
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.equal(roundTo(-0.0001, 2), 0);
});

test("India dates: today flips at IST midnight, labels and day sums", () => {
  assert.equal(istToday(Date.parse("2026-11-13T18:29:59Z")), "2026-11-13");
  assert.equal(istToday(Date.parse("2026-11-13T18:30:00Z")), "2026-11-14");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(dayLabel("2026-11-20", { todayIst: TODAY }), "20 Nov");
  assert.equal(dayLabel("2027-01-05", { todayIst: TODAY }), "05 Jan 2027");
  assert.equal(dayLabel("2026-11-20", { full: true }), "20 Nov 2026");
  assert.equal(dayLabel("", {}), "");
});

test("hold step: a rise is held, falls never reduce held, explained units take it off, left is never credit", () => {
  // The bill (360) typed in Zoho: held.
  assert.deepEqual(holdStep({ zohoLast: 50, held: 0, reading: 410, explained: 0 }), { rise: 360, left: 0, held: 360, zohoLast: 410 });
  // A Zoho counter sale of 10 after it: a fall; held stays.
  assert.deepEqual(holdStep({ zohoLast: 410, held: 360, reading: 400, explained: 0 }), { rise: 0, left: 0, held: 360, zohoLast: 400 });
  // The match explains the 360.
  assert.deepEqual(holdStep({ zohoLast: 400, held: 360, reading: 400, explained: 360 }), { rise: 0, left: 0, held: 0, zohoLast: 400 });
  // Explained units Zoho does not show: dropped (left), never carried.
  assert.deepEqual(holdStep({ zohoLast: 50, held: 0, reading: 250, explained: 360 }), { rise: 200, left: 160, held: 0, zohoLast: 250 });
  // A measured rise wins over Zoho's own change (apply_reading measures against the website's total).
  assert.equal(holdStep({ zohoLast: 50, held: 0, reading: 400, explained: 0, rise: 360 }).held, 360);
  assert.equal(pairTotal({ reading: 410, held: 360, waiting: 70, unbilled: 360 }), 340);
  assert.equal(pairTotal({ reading: 410, held: 0, waiting: 70, unbilled: 0, pendingDelta: -5 }), 335);
});

test("opening a watch holds a rise since the last pull and takes a fall", () => {
  assert.equal(openingHold({ reading: 50, totalBefore: 50, waiting: 0 }), 0);
  assert.equal(openingHold({ reading: 410, totalBefore: 50, waiting: 0 }), 360, "a bill typed after the last pull");
  assert.equal(openingHold({ reading: 40, totalBefore: 50, waiting: 0 }), 0, "a fall is no hold");
  assert.equal(readyAfterOpening({ reading: 410, totalBefore: 50, waiting: 0 }), 50);
  assert.equal(readyAfterOpening({ reading: 40, totalBefore: 50, waiting: 5 }), 35);
});

test("worked example 2.7, step by step (Sugar S1 at CLK)", () => {
  const split = (total: number, lots: Lot[]) => deriveSplit({ total, lots, ...ON });
  // Today, no lot.
  assert.deepEqual(split(50, []), { ready: 50, incoming: 0, detail: [], raw: 50, unbilled: 0, arriving: 0 });
  // The lot: 360 by 20 Nov. T = Z - held - W + U = 50 - 0 - 0 + 360.
  let L = lot();
  let T = pairTotal({ reading: 50, held: 0, waiting: 0, unbilled: 360 });
  assert.equal(T, 410);
  assert.deepEqual(split(T, [L]), { ready: 50, incoming: 360, detail: [{ by: "2026-11-20", qty: 360 }], raw: 50, unbilled: 360, arriving: 360 });
  // A customer pays for 70: 50 ready + 20 arriving.
  const take = takeLine({ qty: 70, ready: 50, total: T, lots: [L], allowed: 70, clock: ON });
  assert.deepEqual(take, { ok: true, ready: 50, preorder: 20, by: "2026-11-20", takes: [{ lotId: "L1", qty: 20 }] });
  T -= 70; L = { ...L, remaining: 340 };
  assert.deepEqual([split(T, [L]).ready, split(T, [L]).incoming], [0, 340]);
  // The bill (360) typed in Zoho; hourly pull: held 360, nothing changes for the shop.
  let watch = { zohoLast: 50, held: 0 };
  let r = applyReading({ watch, reading: 410, waiting: 70, unbilled: 360, total: T });
  assert.deepEqual([r.held, r.total], [360, 340]);
  watch = { zohoLast: r.zohoLast, held: r.held };
  // Variant: a Zoho counter sale of 10 after it: 330, held kept.
  const v = applyReading({ watch, reading: 400, waiting: 70, unbilled: 360, total: T });
  assert.deepEqual([v.held, v.total, split(v.total, [L]).ready, split(v.total, [L]).incoming], [360, 330, 0, 330]);
  // The match (e = 360): U goes, the website moves its own total first, then the reading.
  T += -360;
  r = applyReading({ watch, reading: 410, waiting: 70, unbilled: 0, total: T, explained: 360 });
  assert.deepEqual([r.held, r.total, split(r.total, []).ready], [0, 340, 340]);
  // The order is invoiced in Zoho: Z 340, W 0.
  const after = applyReading({ watch: { zohoLast: 410, held: 0 }, reading: 340, waiting: 0, unbilled: 0, total: r.total });
  assert.deepEqual([after.held, after.total], [0, 340]);
});

test("worked example 2.7, partial bill of 200 with the rest still coming: ready 180, arriving 160", () => {
  let T = 340;
  const watch0 = { zohoLast: 50, held: 0 };
  const pulled = applyReading({ watch: watch0, reading: 250, waiting: 70, unbilled: 360, total: T });
  assert.deepEqual([pulled.held, pulled.total], [200, 340]);
  const plan = matchPlan({ Q: 360, S: 20, Qb: 200, rest: "coming" });
  assert.deepEqual(plan, { ok: true, case: "short_coming", quantity: 200, remaining: 180, move: 0, remainder: { quantity: 160, remaining: 160 } });
  T += 160 - 360;
  const r = applyReading({ watch: { zohoLast: 250, held: 200 }, reading: 250, waiting: 70, unbilled: 160, total: T, explained: 200 });
  const s = deriveSplit({ total: r.total, lots: [lot({ id: "R1", code: "CLK-141126-01-R1", quantity: 160, remaining: 160 })], ...ON });
  assert.deepEqual([r.total, s.arriving, s.ready, s.incoming], [340, 160, 180, 160]);
});

test("ready and arriving: overdue at IST midnight, paused, hold back, oversold, two lots by date", () => {
  const due = lot({ expectedDate: "2026-11-13" });
  assert.equal(lotAccepting(due, ON), false, "yesterday's date stops pre-orders (grace 0)");
  assert.equal(lotAccepting(due, { ...ON, graceDays: 1 }), true);
  assert.equal(lotAccepting(lot({ expectedDate: TODAY }), ON), true, "today's date still sells");
  assert.equal(lotOverdue(due, ON), true);
  assert.equal(lotSellable(lot({ paused: true }), ON), 0);
  assert.equal(lotSellable(lot({ holdBack: 100 }), ON), 260);
  assert.equal(lotSellable(lot(), { ...ON, on: false }), 0, "switched off: nothing arriving is offered");
  // Hold back = quantity (the dry run): nothing for sale, T = old + Q, ready unchanged.
  const dry = deriveSplit({ total: 60, lots: [lot({ quantity: 10, remaining: 10, holdBack: 10 })], ...ON });
  assert.deepEqual([dry.ready, dry.incoming], [50, 0]);
  // T < I: promised units neither in stock nor on the way.
  const over = deriveSplit({ total: 330, lots: [lot({ remaining: 340 })], ...ON });
  assert.deepEqual([over.ready, over.incoming, over.raw], [0, 330, -10]);
  // Two lots: earliest date first, detail trimmed to what is offered.
  const two = deriveSplit({ total: 100, lots: [lot({ id: "B", code: "B", expectedDate: "2026-11-25", quantity: 60, remaining: 60 }), lot({ id: "A", code: "A", quantity: 80, remaining: 80 })], ...ON });
  assert.deepEqual(two.detail, [{ by: "2026-11-20", qty: 80 }, { by: "2026-11-25", qty: 20 }]);
  assert.deepEqual(trimDetail([{ by: "x", qty: 5 }, { by: "y", qty: 5 }], 7), [{ by: "x", qty: 5 }, { by: "y", qty: 2 }]);
});

test("taking an order line: ready first, the tick, a changed lot, switched off", () => {
  assert.deepEqual(takeLine({ qty: 5, ready: 50, total: 410, lots: [lot()], allowed: 0, clock: ON }), { ok: true, ready: 5, preorder: 0, by: null, takes: [] });
  assert.deepEqual(takeLine({ qty: 70, ready: 50, total: 410, lots: [lot()], allowed: 0, clock: ON }), { ok: false, reason: "needs_ack", by: "2026-11-20" });
  assert.deepEqual(takeLine({ qty: 70, ready: 50.5, total: 410, lots: [lot({ remaining: 10 })], allowed: 70, clock: ON }), { ok: false, reason: "changed", by: "2026-11-20" });
  assert.deepEqual(takeLine({ qty: 70, ready: 50, total: 410, lots: [lot()], allowed: 70, clock: { ...ON, on: false } }), { ok: false, reason: "not_enough", by: null });
  assert.deepEqual(takeLine({ qty: 70, ready: 50, total: 410, lots: [lot()], allowed: 70, clock: ON, routingOn: false }), { ok: false, reason: "not_enough", by: null });
  // Oversold godown: arriving is capped by the total, not only by the lots.
  assert.equal(takeLine({ qty: 30, ready: 0, total: 20, lots: [lot()], allowed: 30, clock: ON }).ok, false);
  // Spread over two lots, earliest first; by = the last date taken.
  const t = takeLine({ qty: 90, ready: 0, total: 500, lots: [lot({ id: "B", code: "B", expectedDate: "2026-11-25" }), lot({ id: "A", code: "A", remaining: 80 })], allowed: 90, clock: ON });
  assert.deepEqual(t, { ok: true, ready: 0, preorder: 90, by: "2026-11-25", takes: [{ lotId: "A", qty: 80 }, { lotId: "B", qty: 10 }] });
});

test("matching: the five quantity cases", () => {
  assert.deepEqual(matchPlan({ Q: 360, S: 20, Qb: 360, rest: "none" }), { ok: true, case: "exact", quantity: 360, remaining: 340, move: 0, remainder: null });
  assert.deepEqual(matchPlan({ Q: 360, S: 20, Qb: 400, rest: "coming" }), { ok: true, case: "over", quantity: 400, remaining: 380, move: 0, remainder: null }, "more than expected: the rest is ignored");
  assert.deepEqual(matchPlan({ Q: 360, S: 20, Qb: 300, rest: "none" }), { ok: true, case: "short_none", quantity: 300, remaining: 280, move: 0, remainder: null });
  assert.deepEqual(matchPlan({ Q: 360, S: 250, Qb: 200, rest: "coming" }), { ok: true, case: "short_coming", quantity: 200, remaining: 0, move: 50, remainder: { quantity: 160, remaining: 110 } });
  assert.deepEqual(matchPlan({ Q: 360, S: 250, Qb: 200, rest: "none" }), { ok: false, case: "refused", short: 50 });
});

test("units sold beyond a short bill move: orders awaiting payment first, then the newest", () => {
  const allocations = [
    { orderNo: "O-1", qty: 20, awaitingPayment: false, createdAt: "2026-11-14T06:00:00Z" },
    { orderNo: "O-2", qty: 30, awaitingPayment: false, createdAt: "2026-11-14T07:00:00Z" },
    { orderNo: "O-3", qty: 15, awaitingPayment: true, createdAt: "2026-11-14T05:00:00Z" },
  ];
  assert.deepEqual(unitsThatMove(allocations, 40), [{ orderNo: "O-3", qty: 15 }, { orderNo: "O-2", qty: 25 }]);
  assert.deepEqual(unitsThatMove(allocations, 0), []);
});

test("the cost line of a match: Sugar S1 at ₹2,527.50 against ₹2,500.00 on 18 sold", () => {
  assert.deepEqual(matchCostChange({ estimate: 2500, bill: 2527.5, sold: 18 }), { perUnit: 27.5, profit: -495, sold: 18 });
  assert.deepEqual(matchCostChange({ estimate: 2500, bill: 2527.5, sold: 20 }).profit, -550);
});

test("candidates for a bill line: here first, then PO, quantity, supplier, earliest date", () => {
  const base: CandidateLot = { id: "x", code: "x", productId: "P", branchId: "BR-CLK", branchName: "Challakere", quantity: 360, remaining: 340, expectedDate: "2026-11-20", supplier: "SRI SUGARS", poId: "", stage: "incoming" };
  const lots: CandidateLot[] = [
    { ...base, id: "late", code: "CLK-01", expectedDate: "2026-11-25", quantity: 100 },
    { ...base, id: "hubli", code: "HBL-01", branchId: "BR-HBL", branchName: "Hubli", quantity: 200 },
    { ...base, id: "po", code: "CLK-02", poId: "PO-9", quantity: 500, supplier: "Other" },
    { ...base, id: "qty", code: "CLK-03", quantity: 200, supplier: "Other", expectedDate: "2026-11-30" },
    { ...base, id: "other", code: "CLK-04", productId: "Q" },
    { ...base, id: "done", code: "CLK-05", stage: "received" },
  ];
  const ranked = matchCandidates({ productId: "P", qty: 200 }, { vendorName: "sri sugars", poIds: ["PO-9"] }, lots, "BR-CLK");
  assert.deepEqual(ranked.map((c) => c.id), ["po", "qty", "late", "hubli"]);
  assert.equal(ranked.at(-1)!.note, "at Hubli: choose Hubli as the unloading godown");
  assert.deepEqual(defaultLineAction(ranked), { action: "match", matchBatchId: "po" });
  assert.deepEqual(defaultLineAction(matchCandidates({ productId: "P", qty: 1 }, { vendorName: "" }, [lots[1]!], "BR-CLK")), { action: "new", matchBatchId: "" });
});

test("cancel and unmatch blockers, as the database says them", () => {
  assert.equal(closeBlocker({ stage: "incoming", code: "CLK-01" }, { waiting: 0, tagged: false }), "");
  assert.match(closeBlocker({ stage: "incoming", code: "CLK-01" }, { waiting: 20, tagged: false }), /^Orders still wait for 20 units of batch CLK-01/);
  assert.match(closeBlocker({ stage: "incoming", code: "CLK-01" }, { waiting: 0, tagged: true }), /Expenses are tagged/);
  assert.match(closeBlocker({ stage: "received", code: "CLK-01" }, { waiting: 0, tagged: false }), /not waiting for its bill/);
  const now = Date.parse("2026-11-14T10:00:00Z");
  const ok = { matched: true, matchedAt: "2026-11-13T10:00:00Z", nowMs: now, newOrders: false, movedOnInZoho: false, countedOrSent: false, viaTransfer: false, billFlag: "", remainderMovedOn: false };
  assert.equal(unmatchBlocker(ok), "");
  assert.equal(unmatchBlocker({ ...ok, matchedAt: "2026-11-07T09:00:00Z" }), "matched more than 7 days ago");
  assert.equal(unmatchBlocker({ ...ok, newOrders: true }), "new orders took from it");
  assert.equal(unmatchBlocker({ ...ok, movedOnInZoho: true }), "an order on it went on to Zoho or got a delivery note");
  assert.equal(unmatchBlocker({ ...ok, billFlag: "Bill deleted in Zoho" }), "its bill is flagged");
  assert.equal(unmatchBlocker({ ...ok, matched: false }), "it is not a matched pre-order batch");
});

test("badges and the list label of a lot", () => {
  assert.deepEqual(lotBadges(lot({ remaining: 230 }), ON), ["Selling", "Estimated cost"]);
  assert.deepEqual(lotBadges(lot({ paused: true, pausedReason: "receiving", remaining: 0 }), ON, { held: 5 }),
    ["Paused while receiving", "Fully pre-sold", "Zoho rise held at this godown", "Estimated cost"]);
  assert.deepEqual(lotBadges(lot({ expectedDate: "2026-11-01" }), ON), ["Overdue", "Estimated cost"]);
  assert.equal(lotLabel(lot({ remaining: 230 }), TODAY), "Pre-order · by 20 Nov · 130/360 sold");
});

test("the shop's view: ready, arriving and the date (the earliest not passed)", () => {
  const row = { stock: 0, incoming: 340, incoming_detail: [{ by: "2026-11-25", qty: 40 }, { by: "2026-11-20", qty: 300 }] };
  assert.deepEqual(incomingView(row, TODAY), { ready: 0, arriving: 340, by: "2026-11-20" });
  assert.deepEqual(incomingView(row, "2026-11-21"), { ready: 0, arriving: 340, by: "2026-11-25" });
  assert.deepEqual(incomingView(row, TODAY, false), { ready: 0, arriving: 0, by: null }, "switched off: nothing arriving");
  assert.deepEqual(incomingView({ stock: "12" }, TODAY), { ready: 12, arriving: 0, by: null }, "an old row without the new columns");
  assert.deepEqual(incomingView(null, TODAY), { ready: 0, arriving: 0, by: null });
});

test("an order line's arrival state", () => {
  assert.deepEqual(arrivalState({ waiting: 20, expected_date: "2026-11-20", arrived_on: null }, TODAY), { state: "waiting", text: "Waiting for goods · arriving by 20 Nov" });
  assert.equal(arrivalState({ waiting: 20, expected_date: "2026-11-10", arrived_on: null }, TODAY).state, "late");
  assert.deepEqual(arrivalState({ waiting: 0, expected_date: "2026-11-20", arrived_on: "2026-11-19" }, TODAY), { state: "arrived", text: "Arrived on 19 Nov · ready to collect" });
});

test("the bill check: window, candidates, cache lines and unreceived lines", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  assert.equal(billCheckSince(now), "2026-11-04T10:00:00.000Z", "creation: the last 10 days");
  assert.equal(billCheckSince(now, ["2026-11-13T10:00:00Z", "2026-11-12T10:00:00Z"]), "2026-11-12T08:00:00.000Z", "2 hours before the first watch opened");
  const rows = [
    { bill_id: "B1", bill_number: "SS1", status: "open", location_id: "LOC-CLK", last_modified_time: "2026-11-14T15:00:00+0530", vendor_name: "V", date: "2026-11-14" },
    { bill_id: "B2", bill_number: "SS2", status: "draft", location_id: "LOC-CLK", last_modified_time: "2026-11-14T15:00:00+0530" },
    { bill_id: "B3", bill_number: "SS3", status: "paid", location_id: "LOC-HBL", last_modified_time: "2026-11-14T15:00:00+0530" },
    { bill_id: "B4", bill_number: "SS4", status: "paid", last_modified_time: "2026-11-13T15:00:00+0530" },
    { bill_id: "B5", bill_number: "SS5", status: "paid", location_id: "LOC-CLK", last_modified_time: "2026-11-01T15:00:00+0530" },
  ].map(billRowLite);
  const since = billCheckSince(now);
  assert.deepEqual(billCheckCandidates(rows, { locationId: "LOC-CLK", sinceIso: since }).map((b) => b.billId), ["B1", "B4"]);
  assert.equal(pastWindow(rows, since), true);
  assert.equal(pastWindow(rows.slice(0, 4), since), false);
  const raw = { line_items: [
    { line_item_id: "LN1", item_id: "I-SUGAR", quantity: 360, item_total: 900000, tax_percentage: 5, item_type: "inventory", account_name: "Inventory Asset" },
    { line_item_id: "LN2", item_id: "", quantity: 1, item_total: 9000, tax_percentage: 0, account_name: "Freight" },
  ] };
  const lines = cachedBillLines(raw);
  assert.deepEqual(lines[0], { line_id: "LN1", item_id: "I-SUGAR", qty: 360, location_id: "", item_type: "inventory", account_name: "Inventory Asset", taxable: 900000, gst: 45000 });
  const bills = [
    { bill_id: "B1", modified: "m", bill_number: "SS1", bill_date: "2026-11-14", created_time: "2026-11-14T15:00:00+0530", status: "open", location_id: "LOC-CLK", vendor_name: "V", lines },
    { bill_id: "B6", modified: "m", bill_number: "SS6", bill_date: "2026-11-14", created_time: "", status: "open", location_id: "LOC-HBL", vendor_name: "V", lines },
  ];
  assert.deepEqual(unreceivedLines(bills, { itemId: "I-SUGAR", locationId: "LOC-CLK", batchedLines: new Set() }).map((l) => [l.billNumber, l.lineId, l.qty]), [["SS1", "LN1", 360]]);
  assert.deepEqual(unreceivedLines(bills, { itemId: "I-SUGAR", locationId: "LOC-CLK", batchedLines: new Set(["B1|LN1"]) }), []);
  assert.equal(preorderGoodsNote(bills[0], new Map([["I-SUGAR", { productName: "Sugar S1", codes: ["CLK-141126-01"] }]])), "Has pre-order goods: Sugar S1 → CLK-141126-01");
  assert.equal(preorderGoodsNote(undefined, new Map()), "");
});

test("purchase orders: open ones only, this godown first; line rates before GST", () => {
  const list = [
    { purchaseorder_id: "1", purchaseorder_number: "PO-1", status: "open", location_id: "LOC-HBL", date: "2026-11-12" },
    { purchaseorder_id: "2", purchaseorder_number: "PO-2", status: "billed", location_id: "LOC-CLK", date: "2026-11-13" },
    { purchaseorder_id: "3", purchaseorder_number: "PO-3", status: "issued", location_id: "LOC-CLK", date: "2026-11-10", delivery_date: "2026-11-20" },
    { purchaseorder_id: "4", purchaseorder_number: "PO-4", status: "cancelled", location_id: "LOC-CLK", date: "2026-11-14" },
  ];
  const open = openPurchaseOrders(list, "LOC-CLK");
  assert.deepEqual(open.map((po) => [po.number, po.here]), [["PO-3", true], ["PO-1", false]]);
  assert.equal(open[0]!.expectedDate, "2026-11-20");
  const exclusive = purchaseOrderLine({ line_item_id: "a", item_id: "I", quantity: 360, rate: 2500, item_total: 900000, tax_percentage: 5 }, false);
  assert.deepEqual([exclusive.rateExGst, exclusive.billedQty], [2500, null]);
  const inclusive = purchaseOrderLine({ line_item_id: "a", item_id: "I", quantity: 10, rate: 2741, item_total: 27410, tax_percentage: 5, quantity_billed: 4 }, true);
  assert.deepEqual([inclusive.rateExGst, inclusive.billedQty], [2610.48, 4]);
  assert.equal(poLineOpen(inclusive, 3), 3);
  assert.equal(poLineOpen(exclusive, 400), 0);
});

test("the new pre-order form's checks and preview", () => {
  const d = { quantity: 360, holdBack: 0, unitCostExGst: 2500, expectedDate: "2026-11-20", unit: "bag" };
  assert.equal(incomingDraftProblem(d, TODAY), "");
  assert.match(incomingDraftProblem({ ...d, quantity: 2.5 }, TODAY), /whole units/);
  assert.equal(incomingDraftProblem({ ...d, quantity: 2.5, unit: "kg" }, TODAY), "");
  assert.match(incomingDraftProblem({ ...d, holdBack: 400 }, TODAY), /Hold back/);
  assert.match(incomingDraftProblem({ ...d, unitCostExGst: 0 }, TODAY), /cost per unit/);
  assert.match(incomingDraftProblem({ ...d, expectedDate: "2026-11-13" }, TODAY), /between today and 180 days/);
  assert.match(incomingDraftProblem({ ...d, expectedDate: addDays(TODAY, 181) }, TODAY), /between today and 180 days/);
  assert.equal(incomingPreview({ zohoNow: 50, godown: "CLK", ready: 50, readyAfter: 50, quantity: 360, holdBack: 0, expectedDate: "2026-11-20", todayIst: TODAY }),
    "Zoho now: 50 at CLK · Ready: 50 · After this: 50 ready + 360 arriving by 20 Nov");
});

test("every shopper text has Kannada", async () => {
  await loadKannada();
  const latin = /[A-Za-z]{3,}/;
  const samples = [
    preorderText.word, preorderText.badge("20 Nov"), preorderText.productLotOnly("20 Nov"), preorderText.arrivingBy("20 Nov"),
    preorderText.arrivingByCount("20 Nov", 30), preorderText.plusArriving(40), preorderText.readyAndArriving(5, 40, "20 Nov"),
    preorderText.explanation("Challakere"), preorderText.cartSplit(5, 10, "20 Nov"), preorderText.allArriving(10, "20 Nov"),
    preorderText.limit("Sugar S1", 50, "Challakere", 10, 40, 60), preorderText.ack(10, "Challakere", "20 Nov"),
    preorderText.needsTick("Sugar S1", "20 Nov 2026"), preorderText.changed("Sugar S1"), preorderText.orderPart("Challakere", "20 Nov"),
    preorderText.waiting("20 Nov"), preorderText.arrivedOn("19 Nov"), preorderText.late, preorderText.invoiceLater("2,741.00"),
    preorderText.someArrive(10, "20 Nov"), preorderText.notArrived("CLK-141126-01", "20 Nov 2026"), preorderText.comingTitle,
    preorderText.comingLine(360, "20 Nov", 130), preorderText.countRefused("Sugar S1", "CLK-141126-01"), preorderText.partnerInvoiceLater,
  ];
  // Names, codes and dates pass through untranslated; everything around them is Kannada.
  const strip = (value: string) => value.replace(/Sugar S1|Challakere|CLK-[0-9-]+|\b(Nov|Jan)\b/g, "");
  for (const english of samples) {
    const out = translateText(english, "kn");
    assert.notEqual(out, english, `no Kannada for "${english}"`);
    assert.ok(!latin.test(strip(out)), `English left in "${out}"`);
  }
  for (const key of ["Your goods have arrived", "Your goods are ready", "Arrival date changed", "Part of your order comes later",
    "{0}: {1} has arrived at the {2} godown. Your invoice and pickup QR follow shortly.", "{0}: {1} is now expected by {2}.",
    "{0}: {1} of {2} came now; the other {3} come with the next delivery, expected by {4}.", "New pre-order", "Pre-orders",
    "Match to pre-order batch {0}", "Match now", "Arriving", "Held", "Estimated"])
    assert.ok(kn[key], `Kannada missing for "${key}"`);
});

test("Zoho: an order waiting for pre-order goods keeps a draft sales order, no invoice; the job ends done with a note", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/lib/zoho-commerce.functions.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const sync = source.slice(source.indexOf("async function syncLinkedZohoOrder("), source.indexOf("async function copyZohoAddressToInvoice("));
  // The confirm is skipped while lot units wait; the invoice, delivery note and packages already skip a draft.
  assert.match(sync, /const goods = await orderWaitingGoods\(db, order\.id\);/);
  assert.match(sync, /if \(confirmedInApp && zohoStatus\(\) === "draft" && goods\.waiting > 0\) \{\n\s+\/\/[^\n]*\n\s+zohoOrderNotes\.set\(order\.id, `Waiting for incoming batch/);
  assert.match(sync, /\} else if \(confirmedInApp && zohoStatus\(\) === "draft"\) \{\n\s+await inventoryRequest\(region, organizationId, token, `\$\{path\}\/status\/confirmed`, "POST"\);/);
  assert.match(sync, /if \(orderNeedsZohoInvoice\(order\.order_status\) && !\["draft", \.\.\.ZOHO_CLOSED_ORDER_STATES\]\.includes\(zohoStatus\(\)\)\)/);
  assert.match(sync, /if \(!\["draft", \.\.\.ZOHO_CLOSED_ORDER_STATES\]\.includes\(zohoStatus\(\)\)\) \{\n\s+zoho = await pushZohoFulfilment/);
  // Finished as "complete", the note kept on the job.
  assert.match(source, /_error: errorMessage \?\? \(status === "complete" \? note \?\? null : null\)/);
  // Every reading path takes the waiting order lines before it reads Zoho (spec 2.5).
  const stock = source.slice(source.indexOf("async function syncZohoGodownStock("), source.indexOf("async function syncPreorderPair("));
  assert.ok(stock.indexOf("preorderSnapshot(") < stock.indexOf("`items/${encodeURIComponent(link.zoho_item_id)}`"), "snapshot before the item reads");
  const count = source.slice(source.indexOf("export const submitStockCount"), source.indexOf("export const listZohoPriceLists"));
  assert.ok(count.indexOf("pendingWebsiteOrderQty(") < count.indexOf("`items/${encodeURIComponent(link.zoho_item_id)}`"), "pending orders before the item read");
  assert.ok(count.indexOf("preorderSnapshot(") < count.indexOf("`items/${encodeURIComponent(link.zoho_item_id)}`"));
});
