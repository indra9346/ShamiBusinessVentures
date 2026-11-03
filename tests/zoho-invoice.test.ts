import { test } from "node:test";
import assert from "node:assert/strict";
import { indiaDate, invoicePaymentReview, orderNeedsZohoInvoice, paymentsGoneFromInvoice, paymentsToNoteAsPushed, paymentsToRecord, roundingWriteOff, sameReference, zohoPaymentMode } from "../src/lib/zoho-sync-core.ts";

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

const pushed = (txnRef: string, invoice: string, zohoPaymentId: string | null = null) => ({ ...paid(2500, txnRef, "2026-11-03T10:00:00Z"), pushedToInvoice: invoice, zohoPaymentId });

test("a payment pushed once is never posted again, on any invoice", () => {
  const payment = pushed("849320392376", "INV1", "P1");
  assert.deepEqual(paymentsToRecord([payment], [], 2500), []);
  assert.deepEqual(paymentsGoneFromInvoice([payment], []), [payment]);
});

test("a payment still on the invoice is not gone, even when its reference was edited in Zoho", () => {
  const payment = pushed("849320392376", "INV1", "P1");
  assert.deepEqual(paymentsGoneFromInvoice([payment], [{ paymentId: "P1", reference: "edited" }]), []);
  assert.deepEqual(paymentsGoneFromInvoice([payment], [{ paymentId: "P9", reference: "SBIN849320392376" }]), [], "put back by hand with the UTR");
  assert.deepEqual(paymentsToRecord([payment], ["edited"], 2500), []);
});

test("a payment never pushed is posted as before, and is not gone", () => {
  const payment = paid(2500, "849320392376", "2026-11-03T10:00:00Z");
  assert.deepEqual(paymentsToRecord([payment], [], 2500).map((p) => p.amount), [2500]);
  assert.deepEqual(paymentsGoneFromInvoice([payment], []), []);
});

test("a payment Zoho shows but the website has no note of gets the note, with Zoho's id", () => {
  const payment = paid(2500, "UTR-1", "2026-11-03T10:00:00Z");
  assert.deepEqual(paymentsToNoteAsPushed([payment], [{ paymentId: "P7", reference: "utr-1" }], "INV1"), [{ payment, zohoPaymentId: "P7" }]);
  assert.deepEqual(paymentsToNoteAsPushed([payment], [{ paymentId: "P7", reference: "other" }], "INV1"), []);
  const moved = pushed("UTR-1", "INV1", "P1");
  assert.deepEqual(paymentsToNoteAsPushed([moved], [{ paymentId: "P2", reference: "UTR-1" }], "INV2"), [{ payment: moved, zohoPaymentId: "P2" }]);
  assert.deepEqual(paymentsToNoteAsPushed([moved], [{ paymentId: "P1", reference: "UTR-1" }], "INV1"), [], "already noted against this invoice");
  assert.deepEqual(paymentsToNoteAsPushed([moved], [{ paymentId: "P1", reference: "edited" }], "INV2"), [{ payment: moved, zohoPaymentId: "P1" }], "moved and edited keeps its id");
  assert.deepEqual(paymentsToNoteAsPushed([pushed("UTR-1", "INV1", "P1")], [{ paymentId: "", reference: "UTR-1" }], "INV2")[0]?.zohoPaymentId, "P1", "a list without ids keeps the one we have");
});

test("references are compared the way the database reads a UTR", () => {
  for (const [a, b] of [["849320392376", "SBIN849320392376"], ["8493-2039-2376", "849320392376"], ["8493 2039 2376", "849320392376"], ["UTR: 849320392376", "SBIN849320392376"], ["849320392376 RAHUL", "849320392376"], ["sbin849320392376", "SBIN849320392376"], ["SBINO49320392376", "SBIN049320392376"], ["rcpt 1", "RCPT1"]]) {
    assert.equal(sameReference(a!, b!), true, `${a} and ${b}`);
  }
  for (const [a, b] of [["RCPT1", "RCPTI"], ["RCPT0", "RCPTO"], ["SBIN849320392376", "HDFC849320392376"], ["849320392376", "849320392377"], ["", ""]]) {
    assert.equal(sameReference(a!, b!), false, `${a} and ${b}`);
  }
});

test("what a person must look at after the payments are on the invoice", () => {
  // Nothing wrong.
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2500, 0), null);
  assert.equal(invoicePaymentReview(0, 1000, 2500, 2500, 1500), null, "part paid, in step");
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2500.01, 0.01), null, "a paisa of GST rounding");
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2501, 1), null, "up to the write-off limit");
  // A pushed payment missing, and the money with it.
  assert.equal(invoicePaymentReview(1, 2500, 2500, 2500, 2500), "gone");
  assert.equal(invoicePaymentReview(1, 1000, 2500, 2500, 2500), "gone", "part paid");
  assert.equal(invoicePaymentReview(1, 1, 1, 1, 1), "gone", "even under the write-off limit");
  // Re-entered under the bank's own reference: the money is there.
  assert.equal(invoicePaymentReview(1, 2500, 2500, 2500, 0), null);
  // Put back for the wrong amount.
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2500, 2475), "short");
  // Zoho's total ₹1.01 to ₹2 above the website.
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2501.01, 1.01), "above");
  assert.equal(invoicePaymentReview(0, 2500, 2500, 2502, 2), "above");
  assert.equal(invoicePaymentReview(0, 1000, 2500, 2502, 1502), null, "not yet paid in full");
  // Nothing to compare.
  assert.equal(invoicePaymentReview(1, 2500, 2500, Number.NaN, Number.NaN), null);
});

test("a paisa left by Zoho's CGST/SGST rounding is written off when the order is paid in full", () => {
  // Live test 26 Oct: website ₹2,151.45 paid in full, Zoho invoice ₹2,151.46 → ₹0.01 left.
  assert.equal(roundingWriteOff(2151.45, 2151.45, 0.01), 0.01);
  assert.equal(roundingWriteOff(2151.45, 2151.45, 1), 1);
});

test("nothing is written off for a real shortfall, a partial payment or a paid invoice", () => {
  assert.equal(roundingWriteOff(2151.45, 2151.45, 1.01), 0);
  assert.equal(roundingWriteOff(10000, 3000, 0.5), 0);
  assert.equal(roundingWriteOff(2151.45, 2151.45, 0), 0);
});
