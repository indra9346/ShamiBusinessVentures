import { test } from "node:test";
import assert from "node:assert/strict";
import { moneyReceived, netMoneyReceived } from "../src/lib/net-receipts.ts";

test("a paid order that was cancelled and refunded nets to zero, not minus its amount (live, 6 Nov 2026)", () => {
  const refunded = { amount: 2151.45, payment: "Refunded", status: "Cancelled" };
  assert.deepEqual(netMoneyReceived([refunded], []), { paid: 2151.45, refunded: 2151.45, toSellers: 0, net: 0 });
  // The same order with its paid amount still on record.
  assert.equal(netMoneyReceived([{ ...refunded, paidAmount: 2151.45 }], []).net, 0);
});

test("paid, part-paid, unpaid and cancelled-but-paid orders", () => {
  assert.equal(moneyReceived({ amount: 1000, payment: "Paid" }), 1000);
  assert.equal(moneyReceived({ amount: 1000, paidAmount: 300, payment: "Partially Paid" }), 300);
  assert.equal(moneyReceived({ amount: 1000, payment: "Pending" }), 0);
  // Cancelled after payment and not refunded yet: the money is still with the company.
  assert.equal(moneyReceived({ amount: 800, payment: "Paid" }), 800);
});

test("seller payouts are taken off once, and only when paid", () => {
  const result = netMoneyReceived(
    [{ amount: 5000, payment: "Paid" }, { amount: 2000, payment: "Refunded" }],
    [{ amount: 700, status: "Paid" }, { amount: 900, status: "Requested" }],
  );
  assert.deepEqual(result, { paid: 7000, refunded: 2000, toSellers: 700, net: 4300 });
});
