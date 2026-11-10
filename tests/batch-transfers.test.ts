import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATE_HOLD_MINUTES, createHoldUntil, findTransferByNumber, godownTransferLines, godownTransferResult, isTransferred, readCreateAnswer, readZohoTransfer,
  splitPlanProblem, TRANSFER_STATUS_WORDS, transferOrderBody, transferProgress, transferSummary, zohoSaysMissing,
  type BatchTransfer,
} from "../src/lib/batch-transfers.ts";
import { buildBatchReport, type BatchRecord } from "../src/lib/batches.ts";
import { batchDeleteBlocker } from "../src/lib/bill-batches.ts";
import { ZOHO_CORE_SCOPES } from "../src/lib/zoho-commerce-mode.ts";

/* The database decides what moves (tests/db/batch-transfers.db-test.mjs). These hold what goes to Zoho and back. */
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261110180000_batch_receive_and_split.sql", import.meta.url), "utf8");

const split: BatchTransfer = {
  id: 1, transfer_no: "GB-TR-000001", kind: "split", status: "pending", from_branch_id: "BR-CLK", from_location_id: "LOC-CLK",
  from_location_name: "Grain Bazar Challakere Godown", to_branch_id: "BR-HBL", to_location_id: "LOC-HBL", to_name: "Grain Bazar Hubli Godown",
  parent_batch_id: "b1", parent_batch_code: "CLK-031126-08", quantity: 5, bill_number: null,
  lines: [{ product_id: "P1", zoho_item_id: "3579709000003476321", name: "Ekadantha OIL 850ML", qty: 5, unit: "pcs" }],
  zoho_transfer_order_id: "", zoho_status: "", attempts: 0, last_error: "", result: null, created_at: "2026-11-10T10:00:00Z", created_by_name: "Office",
};

test("the transfer order carries our number, both locations and each item's units; a sent batch travels, a received bill doesn't", () => {
  const body = transferOrderBody(split, "2026-11-10");
  assert.deepEqual(body, {
    transfer_order_number: "GB-TR-000001", date: "2026-11-10",
    description: "Grain Bazar: batch CLK-031126-08 sent to Grain Bazar Hubli Godown",
    from_location_id: "LOC-CLK", to_location_id: "LOC-HBL", is_intransit_order: true,
    line_items: [{ item_id: "3579709000003476321", name: "Ekadantha OIL 850ML", quantity_transfer: 5, unit: "pcs" }],
  });
  const receive = transferOrderBody({ ...split, kind: "receive", bill_number: "SS4463", from_location_id: "LOC-HO", lines: [
    { product_id: "P2", zoho_item_id: "Z2", name: "M Sambar 17GM", qty: 6, unit: "pcs" }, { product_id: "P3", zoho_item_id: "Z3", name: "E Zandu", qty: 4, unit: "pcs" },
  ] }, "2026-11-10");
  assert.equal(receive.description, "Grain Bazar: bill SS4463 unloaded at Grain Bazar Hubli Godown");
  assert.equal(receive.from_location_id, "LOC-HO");
  assert.equal(receive.is_intransit_order, false, "a bill received at its unloading godown is already there");
  assert.equal(receive.line_items.length, 2);
  assert.equal(transferOrderBody({ ...split, parent_batch_code: "X".repeat(600) }, "2026-11-10").description.length, 500);
});

test("Zoho's answer to a create: made, number taken, refused, or no clear answer", () => {
  assert.deepEqual(readCreateAnswer(201, { code: 0, message: "Transfer Order added successfully.", transfer_order: { transfer_order_id: "T9", transfer_order_number: "GB-TR-000001", status: "in_transit" } }),
    { kind: "created", id: "T9", status: "in_transit" });
  assert.equal(readCreateAnswer(200, { code: 0, message: "ok" }).kind, "unknown", "a yes without a transfer order is not trusted");
  assert.deepEqual(readCreateAnswer(400, { code: 1001, message: "Transfer Order Number already exists." }), { kind: "exists" });
  assert.deepEqual(readCreateAnswer(400, { code: 4000, message: "This transfer order number has already been used" }), { kind: "exists" });
  assert.deepEqual(readCreateAnswer(400, { code: 9205, message: "Insufficient stock at the source location" }), { kind: "refused", message: "Insufficient stock at the source location" });
  assert.deepEqual(readCreateAnswer(401, { code: 57, message: "You are not authorized to perform this operation" }), { kind: "refused", message: "You are not authorized to perform this operation" });
  assert.equal(readCreateAnswer(429, { code: 44, message: "Too many requests" }).kind, "refused", "429: Zoho did nothing");
  assert.equal(readCreateAnswer(500, { code: 0 }).kind, "unknown");
  assert.equal(readCreateAnswer(502, null).kind, "unknown");
  assert.equal(readCreateAnswer(400, null).kind, "unknown", "no Zoho error body: can't be sure nothing was made");
});

test("finding our transfer in Zoho's list takes the exact number only", () => {
  const list = { code: 0, transfer_orders: [
    { transfer_order_id: "T1", transfer_order_number: "GB-TR-0000010", status: "transferred" },
    { transfer_order_id: "T2", transfer_order_number: "gb-tr-000001", status: "transferred" },
  ] };
  assert.deepEqual(findTransferByNumber(list, "GB-TR-000001"), { id: "T2", number: "gb-tr-000001", status: "transferred" });
  assert.equal(findTransferByNumber(list, "GB-TR-000002"), null);
  assert.equal(findTransferByNumber({ code: 0 }, "GB-TR-000001"), null);
  assert.equal(findTransferByNumber(null, "GB-TR-000001"), null);
  assert.equal(readZohoTransfer({ transfer_order_number: "x" }), null, "no id, no transfer");
  assert.equal(isTransferred("Transferred"), true);
  assert.equal(isTransferred("in_transit"), false);
});

test("a split plan: own godown, twice, too many and decimals are refused before asking", () => {
  assert.equal(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 5 }]), "");
  assert.equal(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 5 }, { branchId: "BR-DVG", qty: 7 }]), "");
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 5 }, { branchId: "BR-DVG", qty: 7.5 }]), /Only 12 left in this batch; 12.5 chosen/);
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-CLK", qty: 1 }]), /own godown/);
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 1 }, { branchId: "BR-HBL", qty: 1 }]), /Each godown once/);
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "", qty: 1 }]), /Choose a godown/);
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 0 }]), /how many/);
  assert.match(splitPlanProblem(12, "BR-CLK", [{ branchId: "BR-HBL", qty: 1.005 }]), /2 decimals/);
  assert.match(splitPlanProblem(12, "BR-CLK", []), /Choose a godown/);
  assert.equal(splitPlanProblem(0.3, "BR-CLK", [{ branchId: "BR-HBL", qty: 0.1 }, { branchId: "BR-DVG", qty: 0.2 }]), "", "0.1 + 0.2 is 0.3");
});

test("words for transfers", () => {
  assert.equal(transferSummary(split), "GB-TR-000001: 5 Ekadantha OIL 850ML of batch CLK-031126-08 from Grain Bazar Challakere Godown to Grain Bazar Hubli Godown");
  assert.equal(transferSummary({ ...split, kind: "receive", bill_number: "SS4463", from_location_name: "Head Office" }),
    "GB-TR-000001: bill SS4463 from Head Office to Grain Bazar Hubli Godown (5 Ekadantha OIL 850ML)");
  assert.deepEqual(Object.keys(TRANSFER_STATUS_WORDS).sort(), ["cancelled", "done", "in_transit", "pending"]);
  const statuses = MIGRATION.match(/status IN \('pending', 'in_transit', 'done', 'cancelled'\)/);
  assert.ok(statuses, "the words cover every status the database allows");
});

test("both ends see where it went: on the way, then who received it, where and when", () => {
  const onTheWay = transferProgress({ ...split, status: "in_transit", sent_at: "2026-11-10T08:30:00Z", created_by_name: "Office Admin" });
  assert.equal(onTheWay, "Sent 10 Nov 2026, 02:00 pm by Office Admin. On the way: waiting for Grain Bazar Hubli Godown to mark it received.");
  const received = transferProgress({ ...split, status: "done", sent_at: "2026-11-10T08:30:00Z", received_at: "2026-11-11T04:45:00Z", received_by_name: "Hanu", received_by_role: "staff" });
  assert.equal(received, "Sent 10 Nov 2026, 02:00 pm. Received at Grain Bazar Hubli Godown 11 Nov 2026, 10:15 am by Hanu (staff).");
  assert.match(transferProgress({ ...split, status: "done", received_at: "2026-11-11T04:45:00Z", received_by_name: "Hubli Partner", received_by_role: "partner" }), /by Hubli Partner \(channel partner\)/);
  assert.match(transferProgress({ ...split, status: "done", received_at: "2026-11-11T04:45:00Z", received_by_name: "x", received_by_role: "zoho" }), /marked received in Zoho/);
  assert.equal(transferProgress({ ...split, status: "pending" }), "");
});

test("the website asks Zoho for transfer orders, so the owner reauthorizes once", () => {
  for (const scope of ["ZohoInventory.transferorders.READ", "ZohoInventory.transferorders.CREATE", "ZohoInventory.transferorders.UPDATE"])
    assert.ok((ZOHO_CORE_SCOPES as readonly string[]).includes(scope), scope);
});

const batch = (over: Partial<BatchRecord>): BatchRecord => ({
  id: "b1", batch_code: "CLK-031126-08", product_id: "P1", product_name: "Ekadantha OIL 850ML", branch_id: "BR-CLK", quantity: 12, remaining_quantity: 12,
  unit: "pcs", unit_cost: 130, purchase_date: "2026-11-03", mfg_date: null, expiry_date: null, status: "Active", source: "website", supplier: "", purchase_ref: "VS903",
  notes: "", received_by_name: "", zoho_batch_id: "", zoho_adjustment_id: "", zoho_balance: null, zoho_checked_at: null, depleted_at: null, created_at: "2026-11-06T10:00:00Z",
  ...over,
});

test("the report counts a purchase once: the super batch sent units, the new batch received them", () => {
  const report = buildBatchReport({
    batches: [batch({ remaining_quantity: 6 }), batch({ id: "b2", batch_code: "CLK-031126-08-HBL1", branch_id: "BR-HBL", quantity: 5, remaining_quantity: 5, parent_batch_id: "b1", transfer_id: 1 })],
    allocations: [], items: [], orders: [], adjustments: [], godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }], today: "2026-11-10",
    transfers: [
      { kind: "split", status: "done", parent_batch_id: "b1", quantity: 5 },
      { kind: "split", status: "pending", parent_batch_id: "b1", quantity: 1 },
      { kind: "split", status: "cancelled", parent_batch_id: "b1", quantity: 4 },
      { kind: "receive", status: "done", parent_batch_id: null, quantity: null },
    ],
  });
  const superBatch = report.rows.find((r) => r.batch.id === "b1")!;
  const sent = report.rows.find((r) => r.batch.id === "b2")!;
  assert.equal(superBatch.purchased, 12);
  assert.equal(superBatch.sent, 6, "done and kept-aside units left it; the cancelled ones came back");
  assert.equal(superBatch.ledgerGap, 0, "12 purchased - 6 sent = 6 left");
  assert.equal(sent.purchased, 0);
  assert.equal(sent.received, 5);
  assert.equal(sent.ledgerGap, 0);
  assert.equal(report.all.purchased, 12, "the purchase is counted once");
  assert.equal(report.all.purchaseValue, 12 * 130);
  assert.equal(report.all.available, 11);
  // Without transfers (older pages and tests), every batch is a purchase as before.
  assert.equal(buildBatchReport({ batches: [batch({})], allocations: [], items: [], orders: [], adjustments: [], godowns: [], today: "2026-11-10" }).rows[0]!.purchased, 12);
});

test("a batch in a transfer is kept", () => {
  assert.match(batchDeleteBlocker({ quantity: 5, remaining_quantity: 5 }, [], 0, undefined, true), /part of a transfer/);
  assert.equal(batchDeleteBlocker({ quantity: 5, remaining_quantity: 5 }, [], 0), "");
});

test("after a create whose answer was lost, nothing is created again or cancelled for 10 minutes", () => {
  const sent = "2026-11-10T10:00:00Z";
  const at = (minutes: number) => Date.parse(sent) + minutes * 60_000;
  assert.equal(CREATE_HOLD_MINUTES, 10);
  assert.equal(createHoldUntil({ create_sent_at: null, zoho_transfer_order_id: "" }, at(1)), 0, "never sent: no wait");
  assert.equal(createHoldUntil({ create_sent_at: sent, zoho_transfer_order_id: "" }, at(3)), at(10), "sent 3 minutes ago: wait until 10");
  assert.equal(createHoldUntil({ create_sent_at: sent, zoho_transfer_order_id: "" }, at(10)), 0, "10 minutes on: look it up, then act");
  assert.equal(createHoldUntil({ create_sent_at: sent, zoho_transfer_order_id: "ZT-1" }, at(1)), 0, "Zoho's answer came: no wait");
});

test("Zoho saying a transfer order is gone is told apart from an error", () => {
  assert.equal(zohoSaysMissing(404, null), true);
  assert.equal(zohoSaysMissing(400, { code: 1002, message: "Transfer Order does not exist." }), true);
  assert.equal(zohoSaysMissing(400, { code: 5, message: "Transfer order not found" }), true);
  assert.equal(zohoSaysMissing(401, { code: 57, message: "You are not authorized to perform this operation" }), false, "no permission is not gone");
  assert.equal(zohoSaysMissing(429, { code: 44, message: "Too many requests" }), false);
  assert.equal(zohoSaysMissing(500, { code: 1002 }), false, "a server error is not gone");
  assert.equal(zohoSaysMissing(200, { code: 0 }), false);
});

test("the staff and partner apps get what moves and the new batch number, never costs or Zoho ids", () => {
  const lines = godownTransferLines([{ product_id: "P1", zoho_item_id: "3579709000003476321", name: "Ekadantha OIL 850ML", qty: 5, unit: "pcs", unit_ex_gst: 123.81, unit_inc_gst: 130, notes: "rate agreed" }]);
  assert.deepEqual(lines, [{ product_id: "P1", zoho_item_id: "", name: "Ekadantha OIL 850ML", qty: 5, unit: "pcs" }]);
  assert.deepEqual(godownTransferLines(null), []);
  assert.deepEqual(godownTransferResult([{ batch_id: "b2", batch_code: "CLK-031126-08-HBL1", qty: 5, line_id: "L1" }]), [{ batch_id: "", batch_code: "CLK-031126-08-HBL1", qty: 5 }]);
  assert.equal(godownTransferResult(null), null);
});

test("the report takes what a batch sent from the batch row itself, so a transfer made while the page loads shows no gap", () => {
  // The batch row (one snapshot) says 6 left and 6 sent; the transfers list, read a moment later, already has a 7th unit.
  const report = buildBatchReport({
    batches: [batch({ remaining_quantity: 6, sent_quantity: 6 })], allocations: [], items: [], orders: [], adjustments: [],
    godowns: [{ id: "BR-CLK", name: "Challakere" }], today: "2026-11-10",
    transfers: [{ kind: "split", status: "done", parent_batch_id: "b1", quantity: 6 }, { kind: "split", status: "pending", parent_batch_id: "b1", quantity: 1 }],
  });
  assert.equal(report.rows[0]!.sent, 6);
  assert.equal(report.rows[0]!.ledgerGap, 0);
});

test("the database keeps the transfer safety rules", () => {
  // Each one is exercised in tests/db/batch-transfers.db-test.mjs; these keep them from being dropped by an edit.
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.claim_batch_transfer/);
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION public\.receive_bill_here/);
  assert.match(MIGRATION, /sent_quantity numeric\(14,2\) NOT NULL DEFAULT 0/);
  assert.match(MIGRATION, /WHERE parent_batch_id = batch_row\.id\) THEN/, "a cancelled transfer still keeps its super batch");
  assert.doesNotMatch(MIGRATION, /on its way in Zoho: mark it received at the godown, or void it in Zoho first/, "a transfer on its way can be cancelled once Zoho voided it");
});
