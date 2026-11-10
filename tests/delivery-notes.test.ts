import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addressLines, companyHeading, copyLabel, deliveryMethodLabel, gateWords, isPickup, isReprint, istDateTime, orderPaymentNotice, paperWarnings, slipPages,
  type DeliveryGate, type DeliveryGateCode, type DeliveryNoteLine,
} from "../src/lib/delivery-notes.ts";
import { zohoInvoiceFacts, zohoInvoicesOf, type ZohoInvoiceRef } from "../src/lib/zoho-sync-core.ts";

const gate = (code: DeliveryGateCode, over: Partial<DeliveryGate> = {}): DeliveryGate =>
  ({ allowed: code === "paid", code, order_total: 2500, paid: 1000, balance: 1500, receipts: 1000, invoice_number: "CLKINV1", invoice_total: 2500, invoice_balance: 1500, ...over });

/* The gate itself is tested on a real database (see docs/delivery-notes.md). These tests hold the words to it. */
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261103090000_delivery_notes.sql", import.meta.url), "utf8");
const gateCodes = () => {
  const body = MIGRATION.slice(MIGRATION.indexOf("FUNCTION private.delivery_note_gate"), MIGRATION.indexOf("The order's lines as the paper shows them"));
  return [...new Set([...body.matchAll(/(?:code := |THEN |ELSE |WHEN '\w+' THEN |'code', )'([a-z_]+)'/g)].map((match) => match[1]!))]
    // What the website's records say, and where a Zoho reading came from: not answers.
    .filter((code) => !["full", "partly", "broken", "last_reading", "zoho_now"].includes(code));
};

test("every answer the database can give has its own plain words", () => {
  const codes = gateCodes();
  assert.ok(codes.length >= 20, `found ${codes.length} codes`);
  for (const code of codes) {
    const words = gateWords(gate(code as DeliveryGateCode));
    assert.notEqual(words.title, "Cannot be checked", `${code} has no words of its own`);
    assert.ok(words.detail.length > 10, code);
  }
});

test("an unknown answer never reads as paid", () => {
  const unknown = gate("something_new" as DeliveryGateCode, { allowed: false });
  assert.equal(gateWords(unknown).tone, "stop");
  assert.ok(paperWarnings(unknown).length > 0);
});

test("partly paid says what was paid, what is due, and to complete it", () => {
  const { title, detail } = gateWords(gate("partly_paid"));
  assert.match(title, /Partly paid: do not generate/);
  assert.match(detail, /₹1,000\.00 paid of ₹2,500\.00/);
  assert.match(detail, /₹1,500\.00 is still due/);
  assert.match(detail, /complete the payment/);
});

test("amounts use rupees and paise with Indian grouping", () => {
  assert.match(gateWords(gate("partly_paid", { paid: 123456.5, order_total: 200000, balance: 76543.5 })).detail, /₹1,23,456\.50 paid of ₹2,00,000\.00/);
});

test("a Zoho problem says so and passes on Zoho's reason", () => {
  assert.match(gateWords(gate("zoho_unreadable", { zoho_error: "Zoho timed out" })).detail, /Zoho timed out/);
});

test("overpaid goes through but the admin is told", () => {
  const words = gateWords(gate("paid", { overpaid: 100 }));
  assert.equal(words.tone, "ok");
  assert.match(words.detail, /₹100\.00 more than the order total/);
  assert.doesNotMatch(gateWords(gate("paid", { overpaid: 0 })).detail, /more than/);
});

test("missing Zoho figures are named as missing, not shown as zero", () => {
  assert.match(gateWords(gate("zoho_inconsistent", { invoice_balance: null })).detail, /balance missing/);
  assert.match(gateWords(gate("zoho_inconsistent", { invoice_total: null })).detail, /total missing/);
});

test("the paper prints clean only when the check is clean", () => {
  assert.deepEqual(paperWarnings(gate("paid")), []);
  assert.deepEqual(paperWarnings(gate("cancelled")), ["ORDER CANCELLED. DO NOT DELIVER."]);
  assert.deepEqual(paperWarnings(gate("refunded")), ["PAYMENT REFUNDED. DO NOT DELIVER."]);
  assert.deepEqual(paperWarnings(gate("partly_paid")), ["NOT FULLY PAID. DO NOT DELIVER."]);
  assert.deepEqual(paperWarnings(gate("unpaid")), ["NOT FULLY PAID. DO NOT DELIVER."]);
  assert.match(paperWarnings(gate("zoho_unreadable"))[0]!, /COULD NOT BE RE-CHECKED/);
  assert.deepEqual(paperWarnings(gate("stopped")), ["DELIVERY STOPPED BY THE OFFICE. DO NOT DELIVER."]);
  for (const code of ["zoho_behind", "website_behind", "no_invoice", "records_disagree", "totals_differ", "zoho_not_money", "utr_reused", "bank_credit_short", "invoice_used"] as const)
    assert.match(paperWarnings(gate(code))[0]!, /CHECK WITH THE OFFICE/, code);
});

test("changes after the note show on the paper even when payment is fine", () => {
  assert.match(paperWarnings(gate("paid", { items_changed: true }))[0]!, /ITEMS CHANGED/);
  assert.match(paperWarnings(gate("paid", { invoice_changed: true, invoice_number: "CLKINV2" }))[0]!, /NOW CLKINV2/);
  assert.equal(paperWarnings(gate("cancelled", { items_changed: true, invoice_changed: true })).length, 3);
});

test("the time on the paper is exact, in India time, whatever the device's zone", () => {
  assert.equal(istDateTime("2026-11-02T18:35:07Z"), "03 Nov 2026, 12:05:07 AM IST");
  assert.equal(istDateTime("2026-11-02T06:30:59Z"), "02 Nov 2026, 12:00:59 PM IST");
  assert.equal(istDateTime(Date.UTC(2026, 0, 1, 0, 0, 0)), "01 Jan 2026, 05:30:00 AM IST");
  assert.equal(istDateTime("not a date"), "");
});

test("copy 1 is the original, every later copy is marked a reprint", () => {
  assert.equal(copyLabel(1), "Original");
  assert.equal(copyLabel(2), "Reprint, copy 2");
  assert.equal(copyLabel(7), "Reprint, copy 7");
  assert.equal(isReprint(1), false);
  assert.equal(isReprint(2), true);
  assert.equal(isReprint(null), false);
});

const line = (n: number, name = `Item ${n}`): DeliveryNoteLine => ({ line: n, order_item_id: `i${n}`, product_id: `p${n}`, name, sku: "", qty: n, pack_size: "25 kg", stock_no: "" });

test("one slip per item line, numbered x of y in line order", () => {
  const pages = slipPages({ items: [line(3), line(1), line(2)] });
  assert.deepEqual(pages.map((page) => [page.slip, page.of, page.name]), [[1, 3, "Item 1"], [2, 3, "Item 2"], [3, 3, "Item 3"]]);
  assert.deepEqual(slipPages({ items: [] }), []);
});

test("pickup and delivery read differently on the paper", () => {
  assert.equal(isPickup({ shipping_method: "Pickup" }), true);
  assert.equal(isPickup({ shipping_method: "Standard" }), false);
  assert.equal(deliveryMethodLabel("Pickup"), "Pickup from godown");
  assert.equal(deliveryMethodLabel("Express"), "Express delivery");
  assert.equal(deliveryMethodLabel("Standard"), "Standard delivery");
});

test("addresses print as lines and skip what is blank", () => {
  assert.deepEqual(addressLines({ line: "1 Sample Road", city: "Challakere", state: "Karnataka", pin: "577522" }), ["1 Sample Road", "Challakere, Karnataka 577522"]);
  assert.deepEqual(addressLines({ address: "Godown Road", city: "", state: "Karnataka", pincode: "577522" }), ["Godown Road", "Karnataka 577522"]);
  assert.deepEqual(addressLines({}), []);
});

test("the company block comes from Settings as saved", () => {
  assert.deepEqual(companyHeading({ legal_name: "Sample Pvt Ltd", name: "Sample", address: "Line 1\nLine 2", gstin: "29AAAAA0000A1Z5", phone: "99" }),
    { name: "Sample Pvt Ltd", addressLines: ["Line 1", "Line 2"], gstin: "29AAAAA0000A1Z5", phone: "99" });
  assert.deepEqual(companyHeading({}), { name: "", addressLines: [], gstin: "", phone: "" });
});

const customer = (over: Partial<Parameters<typeof orderPaymentNotice>[0]> = {}) => orderPaymentNotice({ total: 2500, paid: 1000, paymentStatus: "Partially Paid", orderStatus: "Payment Confirmed", invoice: null, ...over });

test("the customer sees amount paid and balance on a part-paid order", () => {
  assert.deepEqual(customer(), { kind: "part", paid: 1000, total: 2500, balance: 1500 });
  assert.deepEqual(customer({ invoice: { status: "sent", total: 2500, balance: 2500 } }), { kind: "part", paid: 1000, total: 2500, balance: 1500 });
  assert.deepEqual(customer({ invoice: { status: "partially_paid", total: 2500, balance: 1500 } }), { kind: "part", paid: 1000, total: 2500, balance: 1500 });
});

test("when records disagree the customer is told to call, not shown an amount to pay", () => {
  assert.deepEqual(customer({ invoice: { status: "partially_paid", total: 2500, balance: 500 } }), { kind: "check" });
  assert.deepEqual(customer({ invoice: { status: "paid", total: 2500, balance: 0 } }), { kind: "check" });
  assert.deepEqual(customer({ paid: 0, paymentStatus: "Pending", invoice: { status: "partially_paid", total: 2500, balance: 1000 } }), { kind: "check" });
  assert.deepEqual(customer({ paid: 0, paymentStatus: "Pending", invoice: { status: "paid", total: 2500, balance: 0 } }), { kind: "check" });
});

test("nothing extra for an order that is paid, unpaid as usual, or finished", () => {
  assert.equal(customer({ paid: 2500, paymentStatus: "Paid" }), null);
  assert.equal(customer({ paid: 3000, paymentStatus: "Paid" }), null);
  assert.equal(customer({ paid: 0, paymentStatus: "Pending" }), null);
  assert.equal(customer({ paid: 0, paymentStatus: "Pending", invoice: { status: "sent", total: 2500, balance: 2500 } }), null);
  for (const orderStatus of ["Cancelled", "Payment Expired", "Awaiting Payment"]) assert.equal(customer({ orderStatus }), null, orderStatus);
  assert.equal(customer({ paymentStatus: "Refunded" }), null);
});

const listed = (status = "paid", invoiceId = "Z1"): ZohoInvoiceRef => ({ invoiceId, number: "CLKINV1", status, total: 100, balance: 0 });

test("Zoho's reading: one live invoice comes from Books' own record, with what paid it", () => {
  assert.deepEqual(zohoInvoiceFacts([listed()], { invoice_id: "Z1", invoice_number: "CLKINV9", status: "Paid", total: 100.5, balance: "0.00", payment_made: 100, credits_applied: 0.5, write_off_amount: 0 }),
    { read: true, live_invoices: 1, invoice_id: "Z1", invoice_number: "CLKINV9", status: "paid", total: 100.5, balance: 0, payment_made: 100, credits_applied: 0.5, write_off_amount: 0 });
  const missing = zohoInvoiceFacts([listed()], { invoice_id: "Z1", status: "paid", total: 100, balance: 0 });
  assert.equal(missing.read && missing.payment_made, null);
});

test("Zoho's reading: an amount left out stays missing and never reads as zero", () => {
  const facts = zohoInvoiceFacts([listed()], { invoice_id: "Z1", status: "paid", total: 100 });
  assert.equal(facts.read && facts.balance, null);
  const blank = zohoInvoiceFacts([listed()], { invoice_id: "Z1", status: "paid", total: "", balance: "  " });
  assert.equal(blank.read && blank.total, null);
  assert.equal(blank.read && blank.balance, null);
  const nulls = zohoInvoiceFacts([listed()], { invoice_id: "Z1", status: "paid", total: null, balance: null });
  assert.equal(nulls.read && nulls.balance, null);
});

test("Zoho's reading: void invoices do not count, several or none are reported as such", () => {
  assert.deepEqual(zohoInvoiceFacts([], null), { read: true, live_invoices: 0 });
  assert.deepEqual(zohoInvoiceFacts([listed("void")], null), { read: true, live_invoices: 0 });
  assert.deepEqual(zohoInvoiceFacts([listed("sent"), listed("paid", "Z2")], null), { read: true, live_invoices: 2 });
  assert.equal(zohoInvoiceFacts([listed("void"), listed("paid", "Z2")], { invoice_id: "Z2", status: "paid", total: 1, balance: 0 }).read, true);
});

test("Zoho's reading: a missing or different Books record is not a reading", () => {
  assert.equal(zohoInvoiceFacts([listed()], null).read, false);
  assert.equal(zohoInvoiceFacts([listed()], { invoice_id: "OTHER", status: "paid", total: 100, balance: 0 }).read, false);
});

test("a sales order that does not list invoices stays unknown, never 'no invoice'", () => {
  assert.equal(zohoInvoicesOf({}), null);
  assert.deepEqual(zohoInvoicesOf({ invoices: [] }), []);
});

test("the server functions and the Zoho read add no Zoho writes, but one: an order the godown's handover delivered", () => {
  const source = readFileSync(new URL("../src/lib/zoho-commerce.functions.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("export async function readOrderInvoiceFacts");
  const body = source.slice(start, source.indexOf("/** Pushes products to Zoho now", start));
  assert.ok(start > 0 && body.length > 200);
  assert.doesNotMatch(body, /"(POST|PUT|DELETE)"/);
  const server = readFileSync(new URL("../src/lib/delivery-notes.functions.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // Client, 10 Nov 2026: when every item is handed over the order is marked Delivered, which Zoho hears of like an
  // admin's change. That push is the only one, and only after the database said it delivered the order.
  const pushes = [...server.matchAll(/pushOrderToZohoFromServer\(/g)];
  assert.equal(pushes.length, 1);
  const before = server.slice(0, pushes[0]!.index);
  assert.match(before.slice(before.lastIndexOf("if (")), /^if \(scan\.order_delivered && orderNo\)/);
  assert.doesNotMatch(server.replace(/pushOrderToZohoFromServer/g, ""), /syncSingleOrderToZoho|pushOrder|inventoryRequest|booksRequest|zoho_sync_outbox/);
});

test("the migration keeps every table away from anon and customers and every call on the server", () => {
  const sql = MIGRATION;
  assert.match(sql, /REVOKE ALL ON public\.delivery_note_counter, public\.delivery_notes, public\.delivery_note_events, public\.delivery_stops FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /REVOKE ALL ON SEQUENCE public\.delivery_note_events_id_seq, public\.delivery_stops_id_seq FROM PUBLIC, anon, authenticated, service_role/);
  for (const table of ["delivery_note_counter", "delivery_notes", "delivery_note_events", "delivery_stops"]) assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  for (const fn of ["delivery_note_check", "issue_delivery_note", "record_delivery_print", "delivery_note_register", "set_delivery_stop"]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`), fn);
    assert.doesNotMatch(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`), fn);
  }
});
