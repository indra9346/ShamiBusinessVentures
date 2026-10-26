import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceDecision, websiteInvoiceStatus, zohoInvoicesOf, type InvoiceRecord } from "../src/lib/zoho-sync-core.ts";

const record = (over: Partial<InvoiceRecord> = {}): InvoiceRecord =>
  ({ zohoInvoiceId: null, invoiceNumber: null, status: "none", autoAttempts: 0, adminApproved: false, ...over });
const inv = (invoiceId: string, status = "sent", number = "CLKINV1") => ({ invoiceId, number, status, total: 2257.5, balance: 2257.5 });

test("first confirmation creates the invoice automatically", () => {
  assert.deepEqual(invoiceDecision(null, []), { action: "create", reason: "automatic" });
  assert.deepEqual(invoiceDecision(record(), []), { action: "create", reason: "automatic" });
});

test("a live Zoho invoice is tracked, never duplicated", () => {
  assert.deepEqual(invoiceDecision(null, [inv("I1")]), { action: "track", invoice: inv("I1") });
  assert.deepEqual(invoiceDecision(record({ zohoInvoiceId: "I1", autoAttempts: 1 }), [inv("I1", "paid")]).action, "track");
});

test("an invoice deleted in Zoho is recorded as deleted, not re-created", () => {
  const known = record({ zohoInvoiceId: "I1", invoiceNumber: "CLKINV1", status: "sent", autoAttempts: 1 });
  assert.deepEqual(invoiceDecision(known, []), { action: "lost", status: "deleted", number: "CLKINV1" });
});

test("an invoice voided in Zoho is recorded as void", () => {
  const known = record({ zohoInvoiceId: "I1", invoiceNumber: "CLKINV1", status: "paid", autoAttempts: 1 });
  assert.deepEqual(invoiceDecision(known, [inv("I1", "void")]), { action: "lost", status: "void", number: "CLKINV1" });
});

test("after a deleted / voided invoice, re-confirming never creates one automatically", () => {
  for (const status of ["deleted", "void", "awaiting_approval"])
    assert.deepEqual(invoiceDecision(record({ status, autoAttempts: 1 }), []), { action: "await_approval" }, status);
  // Existing confirmed orders (backfilled with one attempt) also wait for approval.
  assert.deepEqual(invoiceDecision(record({ autoAttempts: 1 }), []), { action: "await_approval" });
});

test("an admin approval creates the next invoice once", () => {
  assert.deepEqual(invoiceDecision(record({ status: "deleted", autoAttempts: 1, adminApproved: true }), []), { action: "create", reason: "approved" });
  // A void invoice in the list does not count as live.
  assert.deepEqual(invoiceDecision(record({ status: "void", autoAttempts: 1, adminApproved: true }), [inv("I1", "void")]), { action: "create", reason: "approved" });
});

test("Zoho invoice statuses as the website shows them", () => {
  assert.equal(websiteInvoiceStatus("Paid"), "paid");
  assert.equal(websiteInvoiceStatus("partially_paid"), "partially_paid");
  assert.equal(websiteInvoiceStatus("Partially Paid"), "partially_paid");
  assert.equal(websiteInvoiceStatus("overdue"), "overdue");
  assert.equal(websiteInvoiceStatus("void"), "void");
  assert.equal(websiteInvoiceStatus("sent"), "sent");
  assert.equal(websiteInvoiceStatus("draft"), "sent");
});

test("a sales order without its invoice list is never read as 'deleted'", () => {
  assert.equal(zohoInvoicesOf({ salesorder_id: "S1" }), null);
  assert.deepEqual(zohoInvoicesOf({ invoices: [] }), []);
  assert.deepEqual(zohoInvoicesOf({ invoices: [{ invoice_id: "I1", invoice_number: "CLKINV1", status: "Paid", total: "100.5", balance: 0 }] }),
    [{ invoiceId: "I1", number: "CLKINV1", status: "paid", total: 100.5, balance: 0 }]);
});
