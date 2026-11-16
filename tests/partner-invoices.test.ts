import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { invoiceReady, partnerInvoiceOrder, partnerInvoiceRows, paymentLabel } from "../src/lib/partner-invoices.ts";
import { invoiceLines } from "../src/lib/invoice-lines.ts";
import { godownSignatureObject, partnerSignatureObject } from "../src/lib/godown-signature.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// What partner_invoice_order hands over for one order (numerics come back from Postgres as text).
const sample = {
  order: {
    order_no: "GB-1042", created_at: "2026-11-09T05:30:00Z", order_status: "Delivered", payment_status: "Paid", payment_method: "UPI",
    customer_name: "Ravi Kumar", customer_email: "ravi@example.com", customer_phone: "9000000009", customer_gstin: null,
    business_legal_name: null, is_b2b: false, shipping_address: { line: "2nd Cross, Gandhi Nagar", city: "Challakere", state: "Karnataka", pin: "577522" },
    shipping_method: "Pickup", branch_id: "BR-CLK", coupon: null, subtotal: "238.10", discount: "0", gst_amount: "11.90", shipping: "0",
    total: "250.00", paid_amount: "250.00", prices_include_gst: true,
  },
  items: [
    { id: "i1", product_id: "P1", product_name: "Sona Masoori 25 kg", sku: "RS01", qty: "1", unit_price: "250.00", gst_rate: "5", capacity: "25 kg", coupon_share: "0", hsn: "1006", unit: "bag", weight: "25 kg" },
  ],
  zoho: { invoice_number: "INV-000123", status: "sent", invoice_date: "2026-11-09" },
  payments: [
    { amount: "250.00", method: "UPI", status: "Paid", txn_ref: "531234567890", created_at: "2026-11-09T05:31:00Z" },
    { amount: "250.00", method: "UPI", status: "Failed", txn_ref: "000000000000", created_at: "2026-11-09T05:30:30Z" },
  ],
};

test("the list rows turn Postgres numerics into numbers and drop rows without an order number", () => {
  const rows = partnerInvoiceRows([
    { order_no: "GB-1042", placed_at: "2026-11-09T05:30:00Z", order_status: "Delivered", payment_status: "Paid", customer_name: "Ravi", total: "250.00", gst_amount: "11.90", invoice_number: "INV-000123" },
    { order_no: "GB-1043", placed_at: "2026-11-09T06:00:00Z", order_status: "Placed", payment_status: "Pending", customer_name: "Asha", total: 99.5, gst_amount: 4.74, invoice_number: null },
    { order_no: "", total: "1" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.total, 250);
  assert.equal(rows[0]!.gst_amount, 11.9);
  assert.equal(rows[1]!.invoice_number, null);
  assert.deepEqual(partnerInvoiceRows(null), []);
});

test("an invoice opens only once the order is fully paid, as on the customer's Invoices page", () => {
  assert.equal(invoiceReady("Paid"), true);
  assert.equal(invoiceReady("paid"), true);
  assert.equal(invoiceReady("Partially Paid"), false);
  assert.equal(invoiceReady("Pending"), false);
  assert.equal(paymentLabel("partially paid"), "Partially Paid");
  assert.equal(paymentLabel("refunded"), "Refunded");
});

test("the partner's copy is the customer's order: address, delivery, UTR and GST lines, never a vendor", () => {
  const { order, facts } = partnerInvoiceOrder(sample);
  assert.equal(order.id, "GB-1042");
  assert.equal(order.customer, "Ravi Kumar");
  assert.equal(order.customerId, "", "the customer's account id is not handed out");
  assert.equal(order.address, "2nd Cross, Gandhi Nagar");
  assert.equal(order.pin, "577522");
  assert.equal(order.delivery, "Pickup from godown");
  assert.equal(order.branchId, "BR-CLK");
  assert.equal(order.amount, 250);
  assert.equal(order.payment, "Paid");
  assert.equal(order.utr, "531234567890", "the latest payment's reference");
  assert.equal(order.pricesIncludeGst, true);
  for (const item of order.items) {
    assert.equal(item.vendor, "");
    assert.equal(item.vendorId, "");
    assert.equal(item.product.purchasePrice, undefined);
  }
  const lines = invoiceLines(order, [], { intraState: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.hsn, "1006", "HSN printed even without the page's catalogue");
  assert.equal(lines[0]!.unit, "bag");
  assert.equal(Math.round((lines[0]!.taxable + lines[0]!.tax) * 100) / 100, 250, "GST inside the price");
  assert.equal(facts.zoho?.invoice_number, "INV-000123");
  assert.equal(facts.paid, 250);
  assert.deepEqual(facts.payments.map((p) => p.reference), ["531234567890"], "only paid payments are listed");
});

test("an order Zoho has not invoiced yet has no Zoho facts", () => {
  const { facts, order } = partnerInvoiceOrder({ ...sample, zoho: null, payments: [] });
  assert.equal(facts.zoho, null);
  assert.deepEqual(facts.payments, []);
  assert.equal(order.utr, undefined);
});

test("signatures get a fresh file name each time, partners in their own folder", () => {
  const a = partnerSignatureObject("6f1c2d3e-0000-4000-8000-000000000001");
  const b = partnerSignatureObject("6f1c2d3e-0000-4000-8000-000000000001");
  assert.match(a, /^partners\/6f1c2d3e-0000-4000-8000-000000000001\/[0-9a-f-]{36}\.png$/);
  assert.notEqual(a, b);
  assert.match(godownSignatureObject("BR-CLK"), /^BR-CLK\/[0-9a-f-]{36}\.png$/);
  assert.match(partnerSignatureObject("../x"), /^partners\/x\//, "no folder tricks");
});

test("the invoice asks for the partner's signature first and falls back to the godown's", () => {
  const source = read("src/lib/invoice.ts");
  const at = source.indexOf("async function loadOrderSignature");
  assert.ok(at > 0);
  const body = source.slice(at, source.indexOf("\n}\n", at));
  assert.match(body, /rpc\("invoice_partner_signature", \{ _order_no: orderNo \}\)/);
  assert.match(body, /\?\? await loadSignature\(godownPath\)/);
  assert.match(source, /const signature = await loadOrderSignature\(order\.id,/);
});

test("the migration hands partners only customer-copy fields and keeps its helpers private", () => {
  const sql = read("supabase/migrations/20261110200000_partner_invoice_signatures.sql");
  const detail = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.partner_invoice_order"), sql.indexOf("REVOKE ALL ON FUNCTION public.partner_invoice_order"));
  for (const secret of ["unit_cost", "purchase", "vendor", "commission", "batch", "user_id", "raw"]) {
    assert.ok(!new RegExp(`'${secret}`).test(detail), `partner_invoice_order must not hand out ${secret}`);
  }
  for (const fn of ["private.godown_partner_at(text, timestamptz)", "private.order_signing_partner(uuid)", "private.active_partner_or_refuse()"]) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`), `${fn} is not callable from the site`);
  }
  for (const fn of ["public.invoice_partner_signature(text)", "public.partner_invoice_orders(date, date)", "public.partner_invoice_order(text)"]) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon;`), `${fn} is not open to the public`);
  }
  assert.ok(!/storage\.buckets/.test(sql) && !/public\s*=\s*true/.test(sql), "the signature bucket stays private and untouched");
});

test("the partner page keeps working on a database without the signature column yet", () => {
  // The sign-in check is in the partner's side menu since 16 Nov 2026; the invoices are their own page.
  const page = read("src/components/partners/PartnerLayout.tsx");
  assert.match(page, /select\("id,name,branch_id,status"\)/, "the sign-in check does not ask for signature_path");
  assert.match(page, /select\("signature_path"\)/);
  assert.match(read("src/routes/partner.invoices.tsx"), /<PartnerInvoices signaturePath=\{me\.signaturePath\} \/>/);
});
