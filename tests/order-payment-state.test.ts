import { test } from "node:test";
import assert from "node:assert/strict";
import { closedPaymentLabel, endedOutcomeLabel, paymentClosed } from "../src/lib/order-payment-state.ts";
import { matchesPaymentFilter, UNPAID } from "../src/lib/panel-filters.ts";

test("a cancelled or expired order with nothing paid owes nothing", () => {
  assert.equal(paymentClosed({ status: "Cancelled", paidAmount: 0, payment: "Pending" }), true);
  assert.equal(paymentClosed({ status: "Payment Expired", paidAmount: null, payment: "Pending" }), true);
});

test("an open order, or one with money on it, is not closed", () => {
  assert.equal(paymentClosed({ status: "Placed", paidAmount: 0, payment: "Pending" }), false);
  assert.equal(paymentClosed({ status: "Delivered", paidAmount: 0, payment: "Pending" }), false);
  assert.equal(paymentClosed({ status: "Cancelled", paidAmount: 100, payment: "Partially Paid" }), false);
  assert.equal(paymentClosed({ status: "Cancelled", paidAmount: 0, payment: "Paid" }), false);
});

test("the words an admin reads", () => {
  assert.equal(closedPaymentLabel("Payment Expired"), "Payment expired, cancelled");
  assert.equal(closedPaymentLabel("Cancelled"), "Cancelled, not paid");
  assert.equal(endedOutcomeLabel("expired"), "Time ran out");
  assert.equal(endedOutcomeLabel("dropped"), "Customer left the checkout");
  assert.equal(endedOutcomeLabel("ended"), "Ended by an admin");
  assert.equal(endedOutcomeLabel(null), "Time ran out");
});

test("the Unpaid filter leaves out cancelled orders, and the Cancelled filter finds them", () => {
  const cancelled = { status: "Cancelled", payment: "Pending", paid: 0 };
  const open = { status: "Pending", payment: "Pending", paid: 0 };
  assert.equal(matchesPaymentFilter(cancelled, UNPAID), false);
  assert.equal(matchesPaymentFilter(open, UNPAID), true);
  assert.equal(matchesPaymentFilter(cancelled, "Cancelled"), true);
  assert.equal(matchesPaymentFilter(open, "Cancelled"), false);
  assert.equal(matchesPaymentFilter(cancelled, "All"), true);
});
