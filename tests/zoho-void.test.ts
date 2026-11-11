import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isVoidInZoho, zohoVoidNotice } from "../src/lib/zoho-void.ts";
import { kn } from "../src/lib/i18n-kn.ts";

const order = (extra: Record<string, unknown> = {}) => ({
  status: "Delivered",
  payment: "Pending",
  paidAmount: 0,
  zohoSalesOrderId: "3579709000002994064",
  zohoOrderStatus: "void",
  ...extra,
});

test("void or cancelled in Zoho, with a sales order, counts; anything else does not", () => {
  assert.equal(isVoidInZoho(order()), true);
  assert.equal(isVoidInZoho(order({ zohoOrderStatus: "cancelled" })), true);
  assert.equal(isVoidInZoho(order({ zohoOrderStatus: " VOID " })), true);
  for (const status of ["confirmed", "fulfilled", "closed", "draft", "", null, undefined]) {
    assert.equal(isVoidInZoho(order({ zohoOrderStatus: status })), false, String(status));
  }
  assert.equal(
    isVoidInZoho(order({ zohoSalesOrderId: null })),
    false,
    "no sales order, nothing in Zoho to follow",
  );
});

test("the page's notice: closed, waiting for a refund, or being closed", () => {
  assert.equal(zohoVoidNotice(order({ zohoOrderStatus: "confirmed" })), null);
  const closed = zohoVoidNotice(order({ status: "Cancelled" }))!;
  assert.equal(closed.tone, "closed");
  assert.match(closed.detail, /closed here and nothing on it can be changed/);
  assert.match(closed.detail, /Delete order/);
  const refund = zohoVoidNotice(order({ payment: "Paid", paidAmount: 2518.95 }))!;
  assert.equal(refund.tone, "refund");
  assert.match(refund.detail, /until the customer is refunded/);
  assert.equal(zohoVoidNotice(order({ payment: "Partially Paid", paidAmount: 0 }))!.tone, "refund");
  const closing = zohoVoidNotice(order())!;
  assert.equal(closing.tone, "closing");
  assert.match(closing.detail, /still shows Delivered/);
  assert.match(
    zohoVoidNotice(order({ zohoOrderStatus: "cancelled", status: "Cancelled" }))!.title,
    /cancelled in Zoho/,
  );
});

test("the order page offers nothing to change once the sales order is void in Zoho", () => {
  const page = readFileSync("src/routes/admin.orders.$id.tsx", "utf8");
  assert.match(page, /const voidInZoho = isVoidInZoho\(/);
  // Each control that changes the order or Zoho is behind the lock.
  // Both Re-sync buttons, the status picker and Cancel Order.
  assert.equal(
    (page.match(/!voidInZoho && \(\s*<Button[\s\S]{0,900}?"Re-sync to Zoho"/g) ?? []).length,
    2,
  );
  for (const guard of [
    /!voidInZoho && \(\s*<Select/,
    // Changed 11 Nov 2026: cancel stays open when Zoho voided it but money was received here, to record the refund.
    /!isCancelled && \(!voidInZoho \|\| hasUnrefundedPayment\) && <CancelOrderButton/,
    /!isCancelled && !voidInZoho && order\.status !== "Delivered"/,
    /<ZohoInvoiceStatus[^>]*readOnly=\{voidInZoho\}/,
    /<DeliveryNotePanel[^>]*readOnly=\{voidInZoho\}/,
  ]) {
    assert.match(page, guard);
  }
  const invoice = readFileSync("src/components/panel/ZohoInvoiceStatus.tsx", "utf8");
  assert.match(
    invoice,
    /isAdmin && !readOnly && \(/,
    "no approve or refresh buttons when read-only",
  );
  const note = readFileSync("src/components/panel/DeliveryNotePanel.tsx", "utf8");
  assert.match(note, /if \(readOnly && !note\) return null;/);
});

test("every new line has its Kannada", () => {
  for (const zohoOrderStatus of ["void", "cancelled"]) {
    for (const extra of [{ status: "Cancelled" }, { payment: "Paid", paidAmount: 10 }]) {
      const notice = zohoVoidNotice(order({ zohoOrderStatus, ...extra }))!;
      assert.ok(kn[notice.title], notice.title);
      assert.ok(kn[notice.detail], notice.detail);
    }
    const closing = zohoVoidNotice(order({ zohoOrderStatus }))!;
    assert.ok(kn[closing.title], closing.title);
    assert.ok(kn[closing.detail.replace("Delivered", "{0}")], closing.detail);
    assert.ok(
      kn[
        `Sales Order {0}, in {1}, is ${zohoOrderStatus} in Zoho. Nothing more is sent to Zoho for this order.`
      ],
    );
  }
  for (const key of [
    "Void in Zoho: {0}",
    "Cancelled in Zoho: {0}",
    "The sales order is void in Zoho, so no new invoice is made.",
    "Its sales order is void in Zoho and nothing was paid here. Deleting removes the order and its items from this website for good. The void sales order stays in Zoho on record, stock is not touched, and a record of who deleted it is kept.",
  ])
    assert.ok(kn[key], key);
  // The database's reasons an order stays, word for word.
  const sql = readFileSync("supabase/migrations/20261107140000_zoho_void_closes_order.sql", "utf8");
  for (const reason of sql.match(/RETURN '([^']|'')+';/g) ?? []) {
    const text = reason.slice(8, -2).replace(/''/g, "'");
    if (text.includes(" ")) assert.ok(kn[text], text);
  }
});

test("a Zoho void closes the order on every route that reads the sales order", () => {
  const server = readFileSync("src/lib/zoho-commerce.functions.ts", "utf8");
  // The webhook / catch-up check, the order's own sync, and opening the order page.
  assert.equal((server.match(/await closeOrderVoidedInZoho\(db, order,/g) ?? []).length, 3);
  assert.doesNotMatch(server, /Cancel it in Grain Bazar or create a new Zoho order/);
});
