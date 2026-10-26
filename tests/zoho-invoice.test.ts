import { test } from "node:test";
import assert from "node:assert/strict";
import { indiaDate, orderNeedsZohoInvoice, paymentsToRecord, zohoPaymentMode } from "../src/lib/zoho-sync-core.ts";

test("only admin-confirmed, live orders get a Zoho Books invoice", () => {
  for (const status of ["Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"])
    assert.equal(orderNeedsZohoInvoice(status), true, status);
  for (const status of ["Placed", "Awaiting Payment", "Cancelled"])
    assert.equal(orderNeedsZohoInvoice(status), false, status);
});

test("website payment methods map to Books payment modes", () => {
  assert.equal(zohoPaymentMode("UPI"), "Bank Transfer");
  assert.equal(zohoPaymentMode("Manual Bank Transfer"), "Bank Transfer");
  assert.equal(zohoPaymentMode("Net Banking"), "Bank Transfer");
  assert.equal(zohoPaymentMode("Credit Card"), "Credit Card");
  assert.equal(zohoPaymentMode("Cash"), "Cash");
  assert.equal(zohoPaymentMode(null), "Bank Transfer");
});

test("payment dates are India dates", () => {
  assert.equal(indiaDate("2026-10-24T20:00:00Z"), "2026-10-25"); // 1:30 am IST next day
  assert.equal(indiaDate("2026-10-24T10:00:00Z"), "2026-10-24");
});

const paid = (amount: number, txnRef: string, paidAt: string, method = "UPI") => ({ amount, txnRef, method, paidAt });

test("a fully paid order records its one payment for the invoice total", () => {
  assert.deepEqual(paymentsToRecord([paid(2747.99, "UTR123456", "2026-10-24T10:00:00Z")], [], 2747.99), [
    { amount: 2747.99, reference: "UTR123456", date: "2026-10-24", mode: "Bank Transfer", method: "UPI" },
  ]);
});

test("advance and balance payments are both recorded, oldest first", () => {
  const result = paymentsToRecord([
    paid(7000, "BAL-2", "2026-10-25T10:00:00Z"),
    paid(3000, "ADV-1", "2026-10-24T10:00:00Z"),
  ], [], 10000);
  assert.deepEqual(result.map((p) => [p.reference, p.amount]), [["ADV-1", 3000], ["BAL-2", 7000]]);
});

test("a retry never records a UTR already on the invoice (any case)", () => {
  const result = paymentsToRecord([paid(3000, "adv-1", "2026-10-24T10:00:00Z"), paid(7000, "BAL-2", "2026-10-25T10:00:00Z")], ["ADV-1"], 7000);
  assert.deepEqual(result.map((p) => p.reference), ["BAL-2"]);
  assert.deepEqual(paymentsToRecord([paid(100, "X1234", "2026-10-24T10:00:00Z")], ["x1234"], 100), []);
});

test("never more than the invoice balance, and nothing when it is already paid", () => {
  assert.deepEqual(paymentsToRecord([paid(5000, "U1", "2026-10-24T10:00:00Z")], [], 4999.5).map((p) => p.amount), [4999.5]);
  assert.deepEqual(paymentsToRecord([paid(5000, "U1", "2026-10-24T10:00:00Z")], [], 0), []);
});

test("payments without a UTR or amount are skipped", () => {
  assert.deepEqual(paymentsToRecord([paid(100, "  ", "2026-10-24T10:00:00Z"), paid(0, "U2", "2026-10-24T10:00:00Z")], [], 500), []);
});
