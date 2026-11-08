import assert from "node:assert/strict";
import test from "node:test";
import { addDays, groupByDay, istDay, lineState, payoutProblem, payoutsSheet, selectionTotals, waitingReason, type PayoutRow, type SettlementLine } from "../src/lib/partner-payouts.ts";
import { couponShares, invoiceBalance, invoiceLines, invoicePayments, issuedZohoNumber } from "../src/lib/invoice-lines.ts";
import { adminNavGroups, groupOpenState, nextGroupOpenState, type MenuGroup } from "../src/lib/panel-menu.ts";

const base: SettlementLine = {
  order_item_id: "a", partner_id: "p", partner_name: "P", order_no: "X", placed_at: "2026-11-07T11:14:55Z", earned_at: null, order_status: "Delivered", payment_status: "Paid",
  customer_name: "C", pin: "1", product_name: "Oil", qty: 1, line_total: 100, kind: "per_unit", rate: 1, amount: 10, status: "earned", payable: 10, paid_amount: 0, due_amount: 10, payout_nos: [],
};

test("a day is the India day of the order", () => {
  assert.equal(istDay("2026-11-07T18:29:59Z"), "2026-11-07");
  assert.equal(istDay("2026-11-07T18:30:00Z"), "2026-11-08");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
});

test("each line says where it stands", () => {
  assert.equal(lineState(base), "To pay");
  assert.equal(lineState({ ...base, paid_amount: 4, due_amount: 6 }), "Part paid");
  assert.equal(lineState({ ...base, paid_amount: 10, due_amount: 0 }), "Paid");
  assert.equal(lineState({ ...base, status: "pending", payable: 0, due_amount: 0 }), "Waiting");
  assert.equal(lineState({ ...base, status: "cancelled", payable: 0, due_amount: 0 }), "Cancelled");
  assert.equal(lineState({ ...base, status: "cancelled", payable: 0, paid_amount: 10, due_amount: -10 }), "To take back");
});

test("the screen says why a commission waits", () => {
  const waiting = { ...base, status: "pending" };
  assert.equal(waitingReason({ ...waiting, order_status: "Payment Confirmed", payment_status: "Paid" }), "Waiting for delivery");
  assert.equal(waitingReason({ ...waiting, order_status: "Delivered", payment_status: "Partially Paid" }), "Waiting for full payment");
  assert.equal(waitingReason({ ...waiting, order_status: "Packed", payment_status: "Pending" }), "Waiting for delivery and full payment");
  assert.equal(waitingReason(base), "");
});

test("lines group by day, oldest first, with totals", () => {
  const days = groupByDay([
    { ...base, order_item_id: "b", placed_at: "2026-11-08T05:00:00Z", due_amount: 5 },
    base,
    { ...base, order_item_id: "c", status: "pending", amount: 7, due_amount: 0, payable: 0 },
  ]);
  assert.deepEqual(days.map((day) => day.day), ["2026-11-07", "2026-11-08"]);
  assert.equal(days[0]!.due, 10); assert.equal(days[0]!.waiting, 7);
});

test("what was paid too much comes off, never below zero", () => {
  const lines = [{ order_item_id: "a", due_amount: 10 }, { order_item_id: "b", due_amount: 20 }, { order_item_id: "c", due_amount: 0 }];
  assert.deepEqual(selectionTotals(lines, new Set(["a", "b", "c"]), 0), { gross: 30, recovered: 0, most: 30 });
  assert.deepEqual(selectionTotals(lines, new Set(["a", "b"]), 12.5), { gross: 30, recovered: 12.5, most: 17.5 });
  assert.deepEqual(selectionTotals(lines, new Set(["a"]), 50), { gross: 10, recovered: 10, most: 0 });
});

test("a payout is checked before it is sent", () => {
  const ok = { amount: 10, most: 10, recovered: 0, mode: "UPI", reference: "UTR12345", paidOn: "2026-11-08", today: "2026-11-08" };
  assert.equal(payoutProblem(ok), "");
  assert.match(payoutProblem({ ...ok, paidOn: "2026-11-09" }), /future/);
  assert.match(payoutProblem({ ...ok, amount: 11 }), /most this payout/);
  assert.match(payoutProblem({ ...ok, reference: "12" }), /UTR/);
  assert.equal(payoutProblem({ ...ok, mode: "Cash", reference: "" }), "", "cash needs no reference");
  assert.match(payoutProblem({ ...ok, amount: 0 }), /amount/);
  assert.equal(payoutProblem({ ...ok, amount: 0, most: 0, recovered: 5, reference: "" }), "", "an adjustment moves no money");
});

test("the Excel total leaves out undone payouts", () => {
  const row: PayoutRow = { id: "1", payout_no: "PO-000001", partner_id: "p", branch_id: "B", paid_on: "2026-11-08", amount: 10, lines_total: 10, recovered_total: 0, mode: "UPI", reference: "R", note: "", status: "paid", created_by_name: "A", created_at: "2026-11-08T05:00:00Z", voided_at: null, voided_by_name: "", void_reason: "" };
  const sheet = payoutsSheet([row, { ...row, id: "2", payout_no: "PO-000002", status: "voided", void_reason: "bounced" }], () => "P", { title: "T", generatedAt: "2026-11-08T05:00:00Z" });
  assert.deepEqual(sheet.rows.at(-1), ["Total paid", null, null, 10]);
  assert.equal(sheet.rows[5]![9], "Undone: bounced");
});

const item = (price: number, gstRate = 5, couponShare = 0, qty = 1) => ({ product: { id: "x", name: "Oil", price, gst: gstRate }, qty, unitPrice: price, gstRate, couponShare });

test("the invoice splits GST like the Zoho invoice: ₹130 at 5% is 3.10 + 3.10 on 123.80", () => {
  const [line] = invoiceLines({ items: [item(130)], tax: 6.19, pricesIncludeGst: true }, []);
  assert.equal(line!.tax, 6.2); assert.equal(line!.taxable, 123.8);
  assert.equal(line!.taxable + line!.tax, 130);
});

test("IGST is one figure, rounded once", () => {
  const [line] = invoiceLines({ items: [item(130)], tax: 6.19, pricesIncludeGst: true }, [], { intraState: false });
  assert.equal(line!.tax, 6.19); assert.equal(line!.taxable, 123.81);
});

test("an older order keeps GST on top, reconciled to its own total", () => {
  const [line] = invoiceLines({ items: [item(100, 5)], tax: 5.01 }, []);
  assert.equal(line!.taxable, 100); assert.equal(line!.tax, 5.01);
});

test("a coupon takes each item and its GST down in proportion", () => {
  const lines = invoiceLines({ items: [item(130, 5, 13), item(95, 5, 9.5)], tax: 10, pricesIncludeGst: true, discount: 22.5 }, []);
  assert.equal(lines[0]!.taxable + lines[0]!.tax, 117, "₹130 less 10%");
  assert.equal(lines[1]!.taxable + lines[1]!.tax, 85.5);
  assert.equal(lines[0]!.tax, 5.58, "GST on what is left: 2 x 2.79");
});

test("coupon shares add up exactly and never exceed a line", () => {
  const shares = couponShares([33.33, 33.33, 33.34], 10);
  assert.equal(Math.round(shares.reduce((sum, share) => sum + share, 0) * 100), 1000);
  assert.deepEqual(couponShares([5, 100], 200), [5, 100]);
  assert.deepEqual(couponShares([], 10), []);
});

test("an order saved with no shares works them out", () => {
  const lines = invoiceLines({ items: [item(100), item(100)], tax: 0, pricesIncludeGst: true, discount: 20 }, []);
  assert.equal(lines[0]!.couponShare, 10); assert.equal(lines[1]!.couponShare, 10);
});

test("the invoice carries Zoho's number only once Zoho has a live invoice", () => {
  assert.equal(issuedZohoNumber({ invoice_number: "CLKINV0711260364", status: "paid" }), "CLKINV0711260364");
  assert.equal(issuedZohoNumber({ invoice_number: "CLKINV1", status: "sent" }), "CLKINV1");
  assert.equal(issuedZohoNumber({ invoice_number: "CLKINV1", status: "void" }), null);
  assert.equal(issuedZohoNumber({ invoice_number: "CLKINV1", status: "deleted" }), null);
  assert.equal(issuedZohoNumber({ invoice_number: null, status: "none" }), null);
  assert.equal(issuedZohoNumber(null), null);
});

test("the invoice lists each payment and works out the balance", () => {
  const rows = invoicePayments([
    { amount: 50, method: "UPI", status: "Paid", txn_ref: "UPI1", created_at: "2026-11-08T05:00:00Z" },
    { amount: 30, method: "NEFT", status: "Refunded", txn_ref: "N9", created_at: "2026-11-07T05:00:00Z" },
    { amount: 100, method: "NEFT", status: "Paid", txn_ref: "NEFT1", created_at: "2026-11-07T05:00:00Z" },
  ]);
  assert.deepEqual(rows.map((row) => row.reference), ["NEFT1", "UPI1"], "oldest first, refunded money left out");
  assert.deepEqual(invoiceBalance(200, 150), { paid: 150, balance: 50 });
  assert.deepEqual(invoiceBalance(200, 250), { paid: 200, balance: 0 });
});

test("the admin menu puts every page in one group", () => {
  const items = [{ to: "/admin/dashboard" }, { to: "/admin/orders" }, { to: "/admin/settings" }, { to: "/admin/new-thing" }];
  const groups: MenuGroup<{ to: string }>[] = adminNavGroups(items);
  const seen = groups.flatMap((group) => group.items.map((item) => item.to));
  assert.deepEqual([...seen].sort(), items.map((item) => item.to).sort());
  assert.equal(groups[0]!.key, "", "the dashboard stands alone");
  assert.equal(groups.at(-1)!.label, "More", "a page nobody grouped still shows");
});

test("groups: the page's own group opens; the admin's choice is kept", () => {
  assert.equal(groupOpenState("sales", {}, "sales"), true);
  assert.equal(groupOpenState("money", {}, "sales"), false);
  assert.equal(groupOpenState("money", { money: true }, "sales"), true);
  const closed = nextGroupOpenState({ sales: true }, "sales", false);
  assert.equal(closed["sales"], false);
});
