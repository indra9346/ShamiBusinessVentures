import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PAY_RETURN_KEY,
  parsePayParam,
  payPanelId,
  payParam,
  rememberPayReturn,
  restorablePlaced,
  takePayReturn,
} from "../src/lib/upi-return.ts";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
};

test("tapping a UPI app remembers the pay panel, and coming back finds it once", () => {
  const store = memory();
  rememberPayReturn(payPanelId("CLK-577522-071126-160000"), 1_000, store);
  assert.ok(store.map.has(PAY_RETURN_KEY));
  assert.equal(takePayReturn(61_000, store), "pay-CLK-577522-071126-160000");
  assert.equal(takePayReturn(62_000, store), null, "taken once");
});

test("an old or broken note is ignored", () => {
  const store = memory();
  rememberPayReturn("pay-X1", 0, store);
  assert.equal(takePayReturn(31 * 60_000, store), null, "older than 30 minutes");
  store.setItem(PAY_RETURN_KEY, "not json");
  assert.equal(takePayReturn(1, store), null);
  assert.equal(takePayReturn(1, null), null, "no storage at all");
  rememberPayReturn("pay-X2", 5_000, null);
});

test("checkout's ?pay= value carries the held order numbers", () => {
  assert.equal(
    payParam(["CLK-577522-071126-160000", "HBL-580020-071126-160001"]),
    "CLK-577522-071126-160000,HBL-580020-071126-160001",
  );
  assert.deepEqual(
    parsePayParam("CLK-577522-071126-160000, HBL-580020-071126-160001,CLK-577522-071126-160000"),
    ["CLK-577522-071126-160000", "HBL-580020-071126-160001"],
  );
  assert.deepEqual(parsePayParam("<script>,ok-1,  ,a"), ["ok-1"]);
  assert.deepEqual(parsePayParam(undefined), []);
  assert.equal(parsePayParam("A1-1,A1-2,A1-3,A1-4,A1-5,A1-6").length, 5);
});

test("a reloaded checkout reopens only the customer's own payable checkouts", () => {
  const holds = [
    {
      orderNo: "CLK-1",
      amount: 130,
      holdUntil: "2026-11-07T10:40:00Z",
      status: "Awaiting Payment",
      method: "UPI",
    },
    {
      orderNo: "CLK-2",
      amount: 150000,
      holdUntil: "2026-11-07T11:30:00Z",
      status: "Awaiting Payment",
      method: "NEFT",
    },
    { orderNo: "CLK-3", amount: 99, holdUntil: null, status: "Payment Expired", method: "UPI" },
    { orderNo: "CLK-4", amount: 2700, holdUntil: null, status: "Payment Confirmed" },
  ];
  assert.deepEqual(restorablePlaced(holds, ["CLK-2", "CLK-1", "CLK-3", "CLK-4", "SOMEONE-ELSES"]), [
    { id: "CLK-2", amount: 150000, holdUntil: "2026-11-07T11:30:00Z", method: "NEFT" },
    { id: "CLK-1", amount: 130, holdUntil: "2026-11-07T10:40:00Z", method: "UPI" },
    { id: "CLK-4", amount: 2700, holdUntil: null, method: "UPI" },
  ]);
});

test("the pay panels, the UPI buttons and checkout are wired to come back", () => {
  const buttons = readFileSync("src/components/site/UpiAppButtons.tsx", "utf8");
  assert.match(buttons, /rememberPayReturn\(returnTo\)/);
  assert.match(buttons, /visibilitychange/);
  assert.match(buttons, /pageshow/);
  for (const file of [
    "src/components/site/HeldCheckoutPay.tsx",
    "src/components/site/UpiPayPanel.tsx",
  ]) {
    const panel = readFileSync(file, "utf8");
    assert.match(panel, /id=\{payPanelId\(orderNo\)\}/, file);
    assert.match(panel, /<UpiAppButtons uri=\{uri\} returnTo=\{payPanelId\(orderNo\)\} \/>/, file);
  }
  const checkout = readFileSync("src/routes/checkout.tsx", "utf8");
  assert.match(checkout, /pay: z\.string\(\)\.optional\(\)/);
  assert.match(checkout, /search: \(prev\) => \(\{ \.\.\.prev, pay: payParam\(/);
  assert.match(checkout, /restorablePlaced\(paymentHolds, parsePayParam\(pay\)\)/);
});

test("back from the UPI app, the pay panel asks for the UTR and keeps the order 10 more minutes", () => {
  const panel = readFileSync("src/components/site/HeldCheckoutPay.tsx", "utf8");
  assert.match(panel, /window\.addEventListener\(PAY_RETURNED_EVENT, onBack\)/);
  assert.match(panel, /supabase\.rpc\("extend_my_payment_hold", \{ _order_no: orderNo \}\)/);
  assert.match(panel, /Payment done\? Enter its UPI Ref No\. now/);
  // It no longer tells the customer to wait for the bank: until the SMS reaches the site, the UTR is how we know.
  assert.doesNotMatch(panel, /Stay on this page: it shows when your payment reaches our bank/);
  const buttons = readFileSync("src/components/site/UpiAppButtons.tsx", "utf8");
  assert.match(buttons, /new CustomEvent\(PAY_RETURNED_EVENT, \{ detail: target \}\)/);
  const sql = readFileSync(
    "supabase/migrations/20261107180000_payment_hold_back_from_app.sql",
    "utf8",
  );
  assert.match(sql, /payment_hold_until \+ interval '10 minutes'/);
  assert.match(sql, /OR o\.payment_hold_extended_at IS NOT NULL THEN/);
});

test("the new lines have their Kannada", async () => {
  const { kn } = await import("../src/lib/i18n-kn.ts");
  for (const key of [
    "Come back here and enter the 12-digit UPI Ref No. (UTR) from the payment receipt. Our team confirms it with our bank and your order is placed.",
    "Payment done? Enter its UPI Ref No. now",
    "It is the 12-digit number on the receipt in your UPI app (UPI Ref No., UPI transaction ID or UTR). Your order is kept for you while you enter it.",
    "Paid? Enter the 12-digit UPI Ref No. (UTR) from your UPI app",
  ])
    assert.ok(kn[key], key);
});
