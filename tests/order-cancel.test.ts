import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminCancelPlan, cancelFormProblem, cancelSteps, deletedPaymentKind, refundArgument, REFUND_MODES, type CancelForm } from "../src/lib/order-cancel.ts";
import {
  liveZohoInvoices, matchRefundPayments, refundAlreadyInZoho, zohoOrderPapers, zohoRefundBody, zohoRefundMode, zohoRefundProblem, zohoVoidRefusedReview,
  type WebsiteRefund,
} from "../src/lib/zoho-cancel.ts";
import { kn } from "../src/lib/i18n-kn.ts";

const TODAY = "2026-11-11";
const order = (extra: Record<string, unknown> = {}) => ({ status: "Packed", payment: "Pending", paidAmount: 0, amount: 2835, ...extra });
const form = (extra: Partial<CancelForm> = {}): CancelForm => ({ reason: "Customer phoned", goodsBack: null, refundMode: "", refundReference: "", refundedOn: TODAY, ...extra });

test("a cancel asks only what the order's step needs", () => {
  const unpaid = adminCancelPlan(order());
  assert.deepEqual(unpaid, { allowed: true, afterDispatch: false, needsRefund: false, refundAmount: 0 });
  const paid = adminCancelPlan(order({ payment: "Paid", paidAmount: 2835 }));
  assert.equal(paid.needsRefund, true); assert.equal(paid.refundAmount, 2835);
  assert.equal(adminCancelPlan(order({ status: "Delivered" })).afterDispatch, true);
  assert.equal(adminCancelPlan(order({ status: "Packed", vendorStatuses: [{ status: "Dispatched" }] })).afterDispatch, true, "a vendor that sent it counts");
  for (const status of ["Cancelled", "Awaiting Payment", "Payment Expired"]) assert.equal(adminCancelPlan(order({ status })).allowed, false, status);
  for (const status of ["Placed", "Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"])
    assert.equal(adminCancelPlan(order({ status })).allowed, true, `every step can be cancelled: ${status}`);
});

test("the dialog says what is missing, in the database's words", () => {
  assert.equal(cancelFormProblem(order(), form(), TODAY), null);
  assert.equal(cancelFormProblem(order(), form({ reason: " ab " }), TODAY), "Say why this order is being cancelled");
  assert.equal(cancelFormProblem(order({ status: "Delivered" }), form(), TODAY), "Say whether the goods came back to the godown.");
  assert.equal(cancelFormProblem(order({ status: "Delivered" }), form({ goodsBack: false }), TODAY), null);
  const paid = order({ payment: "Paid", paidAmount: 2835 });
  assert.equal(cancelFormProblem(paid, form(), TODAY), "Choose how the money was paid back");
  assert.equal(cancelFormProblem(paid, form({ refundMode: "NEFT" }), TODAY), "Enter the UTR or reference of the refund");
  assert.equal(cancelFormProblem(paid, form({ refundMode: "Cash" }), TODAY), null, "cash needs no reference");
  assert.equal(cancelFormProblem(paid, form({ refundMode: "UPI", refundReference: "123456789012", refundedOn: "2026-11-12" }), TODAY), "The refund date cannot be in the future");
  assert.equal(cancelFormProblem(paid, form({ refundMode: "UPI", refundReference: "123456789012", refundedOn: "" }), TODAY), "Enter the date the money was paid back");
  assert.deepEqual(refundArgument(paid, form({ refundMode: "UPI", refundReference: " 123456789012 " })), { mode: "UPI", reference: "123456789012", refunded_on: TODAY });
  assert.equal(refundArgument(order(), form({ refundMode: "UPI" })), null, "nothing paid, nothing to refund");
  assert.deepEqual([...REFUND_MODES], ["UPI", "NEFT", "RTGS", "IMPS", "Cash", "Cheque"]);
});

test("the dialog lists what cancelling does", () => {
  assert.ok(cancelSteps(order(), null).includes("Its stock goes back to the godown."));
  assert.ok(cancelSteps(order({ status: "Delivered" }), false).includes("The goods did not come back, so the stock stays as it is."));
  assert.ok(cancelSteps(order({ status: "Delivered" }), true).includes("The goods are back, so the stock goes back to the godown."));
  assert.match(cancelSteps(order({ payment: "Paid", paidAmount: 10 }), null)[0]!, /marked Refunded/);
});

const refund = (extra: Partial<WebsiteRefund> = {}): WebsiteRefund => ({
  id: "r1", amount: 2835, mode: "NEFT", reference: "REFUND999988887777", refundedOn: TODAY, paidRef: "VAMSHIUTR000000001", zohoPaymentId: "ZP1", ...extra,
});

test("Zoho Books gets one refund per website refund, never two", () => {
  assert.deepEqual(zohoRefundBody(refund(), "CLK-1", "ACC-IDFC"), {
    date: TODAY, amount: 2835, refund_mode: "Bank Transfer", reference_number: "REFUND999988887777", from_account_id: "ACC-IDFC",
    description: "Refund by NEFT for Grain Bazar order CLK-1, cancelled on the website.",
  });
  assert.equal("reference_number" in zohoRefundBody(refund({ mode: "Cash", reference: "" }), "CLK-1", "ACC"), false);
  assert.equal(zohoRefundMode("Cash"), "Cash"); assert.equal(zohoRefundMode("Cheque"), "Check"); assert.equal(zohoRefundMode("UPI"), "Bank Transfer");
  // A lost answer: the refund is already there, by reference, or for cash by amount, date and order.
  assert.equal(refundAlreadyInZoho([{ payment_refund_id: "PR9", reference_number: "refund 9999-8888-7777", amount: 2835 }], refund(), "CLK-1"), "PR9");
  assert.equal(refundAlreadyInZoho([{ payment_refund_id: "PR9", reference_number: "REFUND999988887777", amount: 2834 }], refund(), "CLK-1"), null, "another amount is another refund");
  assert.equal(refundAlreadyInZoho([{ payment_refund_id: "PR3", amount: 2835, date: TODAY, description: "Refund by Cash for Grain Bazar order CLK-1, cancelled on the website." }], refund({ mode: "Cash", reference: "" }), "CLK-1"), "PR3");
  assert.equal(refundAlreadyInZoho([{ payment_refund_id: "PR3", amount: 2835, date: TODAY, description: "Refund for CLK-2" }], refund({ mode: "Cash", reference: "" }), "CLK-1"), null);
});

test("only invoices that still count are voided, and a lost payment id is found by its UTR", () => {
  const so = { invoices: [{ invoice_id: "I1", invoice_number: "CLKINV1", status: "paid" }, { invoice_id: "I2", status: "void" }, { invoice_number: "no id" }] };
  assert.deepEqual(liveZohoInvoices(so), [{ id: "I1", number: "CLKINV1", status: "paid" }]);
  assert.deepEqual(liveZohoInvoices({}), []);
  const found = matchRefundPayments(
    [refund({ id: "a", zohoPaymentId: null }), refund({ id: "b", zohoPaymentId: null, paidRef: "OTHER0000000000001", amount: 100 }), refund({ id: "c" })],
    [{ paymentId: "P1", reference: "vamshiutr000000001", amount: 2835 }, { paymentId: "ZP1", reference: "VAMSHIUTR000000001", amount: 2835 }],
  );
  assert.deepEqual([...found], [["a", "P1"]], "the payment another refund already has is not given twice; no match, no guess");
});

test("when Zoho will not void, the person is told what to do there", () => {
  const so = { packages: [{ package_number: "PKG-00347", shipment_number: "SH-00012" }] };
  assert.deepEqual(zohoOrderPapers(so), ["package PKG-00347", "shipment SH-00012"]);
  assert.match(zohoVoidRefusedReview("CLK-1", "CLK-SO-1", "Sales order has shipments", so, true), /It has package PKG-00347, shipment SH-00012\. If the goods came back, delete the shipment and then the package in Zoho Inventory, then Retry\./);
  assert.match(zohoVoidRefusedReview("CLK-1", "CLK-SO-1", "x", so, false), /did not come back to the godown: ask your accountant/);
  assert.match(zohoVoidRefusedReview("CLK-1", "CLK-SO-1", "x", {}, null), /Void it in Zoho Inventory, then Retry\.$/);
  assert.match(zohoRefundProblem("CLK-1", 2835, "no"), /refund of ₹2835\.00 for cancelled Grain Bazar order CLK-1: no\. Record it in Zoho Books/);
});

test("the admin pages cancel only through the new dialog", () => {
  for (const page of ["src/routes/admin.orders.$id.tsx", "src/routes/admin.orders.tsx"]) {
    const source = readFileSync(page, "utf8");
    assert.match(source, /<CancelOrderButton /, page);
    assert.doesNotMatch(source, /updateOrderStatus\([^)]*"Cancelled"\)/, `${page} no longer cancels without a reason`);
    assert.doesNotMatch(source, /Refund processing is not configured yet/, page);
  }
  assert.match(readFileSync("src/lib/panel-nav.ts", "utf8"), /"\/admin\/delete-log"/);
  assert.match(readFileSync("src/lib/panel-menu.ts", "utf8"), /"\/admin\/delete-log"/);
  assert.match(readFileSync("src/components/panel/EndedCheckouts.tsx", "utf8"), /DeleteAllDetailsDialog/);
  assert.match(readFileSync("src/lib/zoho-commerce.functions.ts", "utf8"), /await settleZohoBooksForCancelledOrder\(db, region, organizationId, token, order, zoho, moneyIssues\);/);
});

test("every new line has its Kannada", () => {
  const keys = new Set<string>([
    ...cancelSteps(order(), null), ...cancelSteps(order({ status: "Delivered", payment: "Paid", paidAmount: 1 }), true), ...cancelSteps(order({ status: "Delivered" }), false),
    deletedPaymentKind("utr"),
  ]);
  const paid = order({ payment: "Paid", paidAmount: 2835 });
  for (const f of [form({ reason: "" }), form({ refundMode: "NEFT" }), form({ refundMode: "UPI", refundReference: "1234", refundedOn: "2099-01-01" }), form({ refundMode: "UPI", refundReference: "1234", refundedOn: "" }), form()]) {
    const problem = cancelFormProblem(paid, f, TODAY);
    if (problem) keys.add(problem);
  }
  keys.add(cancelFormProblem(order({ status: "Delivered" }), form(), TODAY)!);
  keys.add(cancelFormProblem(order({ status: "Cancelled" }), form(), TODAY)!);
  for (const key of keys) assert.ok(kn[key], key);
  // The database's own words: what it refuses with, why an order stays, and the notes before a delete.
  const sql = readFileSync("supabase/migrations/20261111200000_cancel_refund_delete_any_step.sql", "utf8");
  const said = [
    ...[...sql.matchAll(/RAISE EXCEPTION '((?:[^']|'')+)'/g)].map((m) => m[1]!),
    ...[...sql.matchAll(/RETURN '((?:[^']|'')+)';/g)].map((m) => m[1]!),
    ...[...sql.matchAll(/notes := notes \|\| (?:format\()?'((?:[^']|'')+)'/g)].map((m) => m[1]!),
  ];
  assert.ok(said.length > 30, String(said.length));
  for (const raw of said) {
    let slot = 0;
    const text = raw.replace(/''/g, "'").replace(/%s|%/g, () => `{${slot++}}`).replace(/Rs \{(\d)\}\.00/g, "Rs {$1}");
    if (!text.includes(" ") || text.startsWith("{")) continue;
    assert.ok(kn[text], text);
  }
  for (const key of [
    "Cancel and record refund", "Did the goods come back to the godown?", "Yes, they are back", "No, they did not come back", "Refund {0} first",
    "{0} was paid on this order. Pay it back to the customer, then record how:", "UTR or reference of the refund", "Date paid back", "Why is it being cancelled?",
    "Keep the order", "It has already left the godown ({0}).", "It is at {0} and has not left the godown.", "Refund of {0} recorded.", "Could not cancel the order",
    "Refunds", "Reference: {0}", "website only", "recorded in Zoho Books", "Zoho Books: not recorded yet, see the Zoho sync", "Zoho Books: waiting for the sync",
    "Recorded by {0}", "Cancelled at {0} on {1}", "Cancelled at {0}", "Cancelled by {0}", "Deleted by {0}", "Removed by {0}", "Reason: {0}", "No reason given",
    "The goods came back to the godown.", "The goods did not come back.", "A full copy is kept in the Delete Log.", "Delete everything on {0}?",
    "The order, its items, refund records and UTRs are removed from this website for good. A full copy stays in the Delete Log with your reason, its number is never used again, and nothing changes in Zoho.",
    "Ordinary delete keeps it:", "End checkout {0}?", "Its stock goes back on sale and the customer is told it was not placed.", "Why is it being ended?", "Ending…",
    "Delete UTR {0}?", "Delete UTR record", "UTR {0} deleted", "A copy is kept in the Delete Log.", "Could not delete the UTR record", "Remove on order",
    "The record that this UTR for {0} was refunded goes from this list. The transfer still cannot pay for anything, and a copy stays in the Delete Log with your reason.",
    "The rejected UTR for {0} goes from this list. Nothing else changes, and a copy stays in the Delete Log with your reason.",
    "Delete Log", "Orders deleted", "Payments and UTRs removed", "Cancelled by an admin", "Newest first, the last 200 of each.", "UTRs sent: {0}", "Refunded {0}",
    "1 item", "{0} items", "Some of the log could not be read. Open the page again.",
    "Orders deleted, payments and UTRs removed, and orders cancelled by an admin: who, when and why",
    "A full copy of each order, with its items, payments, refunds and UTRs, is kept in the database. Its number is never used again.",
    "A refunded transfer stays unable to pay for anything after its record is removed.",
    "Every cancel and every ended checkout, at the step it was at. An order deleted since keeps this in its copy.",
    "Order {0} was cancelled. Rs {1} was paid back to you by {2} on {3}.", "Order {0} was cancelled. Rs {1} was paid back to you by {2} on {3}. Reference: {4}.",
    "Refunded by {0} on {1} (order {2} cancelled)",
  ]) assert.ok(kn[key], key);
});
