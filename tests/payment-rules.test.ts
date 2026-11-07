import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedMethods, bankDetailChanges, lapsedTransfer, methodsForOrders, availableMethods, bankDetailsProblem, bankUtrProblem, cleanBankDetails, isBankMethod, mergeIntoCart, methodLabel,
  normaliseBankUtr, paymentNoticeTarget, pickMethod, reorderPlan,
} from "../src/lib/payment-rules.ts";
import { lineGstInside, toPaise } from "../src/lib/pricing.ts";
import { holdView } from "../src/lib/payment-hold.ts";

test("the method follows the client's note, at every boundary", () => {
  assert.deepEqual(allowedMethods(1), ["UPI", "NEFT"]);
  assert.deepEqual(allowedMethods(99_999.99), ["UPI", "NEFT"]);
  assert.deepEqual(allowedMethods(100_000), ["NEFT"]);
  assert.deepEqual(allowedMethods(100_000.01), ["NEFT"]);
  assert.deepEqual(allowedMethods(199_999.99), ["NEFT"]);
  assert.deepEqual(allowedMethods(200_000), ["NEFT", "RTGS"]);
  assert.deepEqual(allowedMethods(500_000), ["NEFT", "RTGS"]);
});

test("only methods that can take money are offered", () => {
  const all = { upi: true, bank: true };
  assert.deepEqual(availableMethods(50_000, all), ["UPI", "NEFT"]);
  assert.deepEqual(availableMethods(50_000, { upi: true, bank: false }), ["UPI"]);
  assert.deepEqual(availableMethods(50_000, { upi: false, bank: true }), ["NEFT"]);
  assert.deepEqual(availableMethods(150_000, { upi: true, bank: false }), [], "no bank details: nothing to pay with");
  assert.deepEqual(availableMethods(250_000, all), ["NEFT", "RTGS"]);
});

test("the choice survives while on offer; a coupon or delivery change can move it", () => {
  assert.equal(pickMethod(null, ["UPI", "NEFT"]), "UPI");
  assert.equal(pickMethod("NEFT", ["UPI", "NEFT"]), "NEFT");
  assert.equal(pickMethod("UPI", ["NEFT"]), "NEFT");
  assert.equal(pickMethod("RTGS", ["NEFT"]), "NEFT");
  assert.equal(pickMethod("RTGS", ["NEFT", "RTGS"]), "RTGS");
  assert.equal(pickMethod("UPI", []), null);
});

test("names", () => {
  assert.equal(isBankMethod("NEFT"), true);
  assert.equal(isBankMethod("RTGS"), true);
  assert.equal(isBankMethod("UPI"), false);
  assert.equal(isBankMethod(null), false);
  assert.equal(isBankMethod("Net Banking"), false);
  assert.equal(methodLabel("NEFT"), "Online payment (NEFT)");
  assert.equal(methodLabel("RTGS"), "RTGS");
  assert.equal(methodLabel("UPI"), "UPI");
});

test("a NEFT or RTGS UTR: letters allowed, capitals stored, 12 to 22 long", () => {
  assert.equal(normaliseBankUtr(" hdfc n2611 0212345 "), "HDFCN26110212345");
  assert.equal(bankUtrProblem("HDFCN26110212345"), null);
  assert.equal(bankUtrProblem("hdfcr52026110212345678"), null);
  assert.equal(bankUtrProblem("612345678901"), null, "IMPS-style 12 digits");
  assert.match(bankUtrProblem("") ?? "", /Enter the UTR/);
  assert.match(bankUtrProblem("SBIN-123456789") ?? "", /only letters and numbers/);
  assert.match(bankUtrProblem("SHORT") ?? "", /you entered 5/);
  assert.match(bankUtrProblem("A".repeat(23)) ?? "", /you entered 23/);
});

test("bank details must be complete and valid before customers see them", () => {
  const good = { accountName: "Shami Business Ventures", accountNumber: "5010 0123 456789", ifsc: "hdfc0001234", bankName: "HDFC Bank", branch: "" };
  assert.equal(bankDetailsProblem(good), null);
  assert.deepEqual(cleanBankDetails(good), { accountName: "Shami Business Ventures", accountNumber: "50100123456789", ifsc: "HDFC0001234", bankName: "HDFC Bank", branch: "" });
  assert.match(bankDetailsProblem({ ...good, accountName: " " }) ?? "", /account name/);
  assert.match(bankDetailsProblem({ ...good, accountNumber: "123" }) ?? "", /account number/);
  assert.match(bankDetailsProblem({ ...good, ifsc: "HDFC1001234" }) ?? "", /IFSC/, "the 5th character is always 0");
  assert.match(bankDetailsProblem({ ...good, ifsc: "HDFC00012345" }) ?? "", /IFSC/);
  assert.match(bankDetailsProblem({ ...good, bankName: "" }) ?? "", /bank/);
});

test("reorder: the same items, as far as they are still on sale", () => {
  const current = (id: string) => ({
    RICE: { name: "Rice 25kg", available: 50 },
    OIL: { name: "Oil 15L", available: 2 },
    SUGAR: { name: "Sugar 50kg", available: 0 },
  } as Record<string, { name: string; available: number }>)[id] ?? null;
  const plan = reorderPlan([
    { productId: "RICE", qty: 10, name: "Rice 25kg" },
    { productId: "OIL", qty: 5, name: "Oil 15L" },
    { productId: "SUGAR", qty: 1, name: "Sugar 50kg" },
    { productId: "GONE", qty: 1, name: "Old product" },
  ], current);
  assert.deepEqual(plan.items, [{ productId: "RICE", qty: 10, available: 50 }, { productId: "OIL", qty: 2, available: 2 }]);
  assert.deepEqual(plan.reduced, [{ name: "Oil 15L", wanted: 5, qty: 2 }]);
  assert.deepEqual(plan.unavailable, ["Sugar 50kg", "Old product"]);
  // A product on two lines is one item.
  assert.deepEqual(reorderPlan([{ productId: "RICE", qty: 2 }, { productId: "RICE", qty: 3 }], current).items, [{ productId: "RICE", qty: 5, available: 50 }]);
  // Nothing left, and no name saved: the id still tells the customer something.
  assert.deepEqual(reorderPlan([{ productId: "GONE", qty: 1 }], current).unavailable, ["GONE"]);
});

test("pressing reorder twice does not double the cart, and other items stay", () => {
  const items = [{ productId: "RICE", qty: 10 }, { productId: "OIL", qty: 2 }];
  const once = mergeIntoCart([{ id: "TEA", qty: 1 }], items);
  assert.deepEqual(once, [{ id: "TEA", qty: 1 }, { id: "RICE", qty: 10 }, { id: "OIL", qty: 2 }]);
  assert.deepEqual(mergeIntoCart(once, items), once);
  // A bigger quantity already in the cart is kept.
  assert.deepEqual(mergeIntoCart([{ id: "RICE", qty: 12 }], [{ productId: "RICE", qty: 10 }]), [{ id: "RICE", qty: 12 }]);
});

test("payment notifications take an admin to the page that has them", () => {
  for (const title of ["Bank transfer to check", "UPI payment to check", "UPI payment needs you", "UPI payment settings changed", "Bank details changed"]) {
    assert.equal(paymentNoticeTarget(title), "/admin/upi-payments", title);
  }
  for (const title of ["Payment received", "New order received", "Order status updated", "Low stock alert"]) {
    assert.equal(paymentNoticeTarget(title), null, title);
  }
});

test("a split cart offers only what every order allows", () => {
  const all = { upi: true, bank: true };
  assert.deepEqual(methodsForOrders([70_000, 40_000], all), ["UPI", "NEFT"], "both under Rs 1 lakh: UPI is fine");
  assert.deepEqual(methodsForOrders([70_000, 40_000], { upi: true, bank: false }), ["UPI"]);
  assert.deepEqual(methodsForOrders([150_000, 40_000], all), ["NEFT"]);
  assert.deepEqual(methodsForOrders([250_000, 40_000], all), ["NEFT"], "RTGS needs every order at Rs 2 lakh or more");
  assert.deepEqual(methodsForOrders([250_000, 210_000], all), ["NEFT", "RTGS"]);
});

test("the screen's total lands on the same side of a boundary as the database's", () => {
  // Float noise: these carts are exactly Rs 1 lakh and Rs 2 lakh. Prices include GST, so the cart is just the prices.
  const noisy = 1037.37 * 5 + 18962.63 * 5;
  assert.notEqual(noisy, 100_000);
  assert.deepEqual(allowedMethods(toPaise(noisy)), ["NEFT"]);
  assert.deepEqual(allowedMethods(toPaise(792.4 * 17 + 5652.4 * 33)), ["NEFT", "RTGS"]);
  // The GST inside a line, per line to paise, as the database works it out (price x qty x rate / (100 + rate)).
  assert.equal(lineGstInside(130, 1, 5), 6.19);
  assert.equal(lineGstInside(130, 3, 5), 18.57);
  assert.equal(lineGstInside(2700, 2, 5), 257.14);
  assert.equal(lineGstInside(112, 1, 12), 12);
  assert.equal(lineGstInside(50, 2, 0), 0);
  assert.equal(toPaise(1.005), 1.01);
  assert.equal(toPaise(99_999.995), 100_000);
  assert.equal(toPaise(2518.95), 2518.95);
});

test("reorder never leaves more in the cart than is available", () => {
  const plan = reorderPlan([{ productId: "A", qty: 10 }], () => ({ name: "Rice", available: 5 }));
  assert.deepEqual(mergeIntoCart([{ id: "A", qty: 8 }], plan.items), [{ id: "A", qty: 5 }]);
});

test("the bank details log names each field that changed", () => {
  const before = { accountName: "Shami", accountNumber: "111111", ifsc: "HDFC0001234", bankName: "HDFC", branch: "" };
  assert.deepEqual(bankDetailChanges(before, { ...before, ifsc: "ICIC0004321" }), [{ label: "IFSC", from: "HDFC0001234", to: "ICIC0004321" }]);
  assert.deepEqual(bankDetailChanges(before, before), []);
  assert.equal(bankDetailChanges(null, before).length, 4);
  assert.equal(bankDetailChanges(before, null).length, 4);
});

test("new payment notices also open the payments page", () => {
  for (const title of ["Payment needs you", "Payment not checked in time", "Bank transfer still to check"]) assert.equal(paymentNoticeTarget(title), "/admin/upi-payments");
  assert.equal(paymentNoticeTarget("Please check your bank transfer"), null, "that one is for the customer");
});

test("a hold that moved on after payment shows as paid, not as time up", () => {
  for (const status of ["Payment Confirmed", "Accepted", "Packed", "Delivered"]) {
    assert.equal(holdView({ status: status as "Payment Confirmed", holdUntil: null }, false), "confirmed");
  }
  assert.equal(holdView({ status: "Payment Expired", holdUntil: null, outcome: "dropped" }, false), "dropped");
  assert.equal(holdView({ status: "Payment Expired", holdUntil: null, outcome: "expired" }, true), "expired");
  assert.equal(holdView({ status: "Awaiting Payment", holdUntil: null }, true), "verifying");
  assert.equal(holdView({ status: "Awaiting Payment", holdUntil: null }, false), "closing");
});

test("an earlier transfer nobody checked is remembered, until its UTR is used", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const lapsed = { utr: "SBIN123456789012", amount: 150000, status: "rejected", note: "we could not check your UTR in time", reviewedAt: "2026-11-02T10:00:00Z" };
  assert.equal(lapsedTransfer([lapsed], now), lapsed);
  assert.equal(lapsedTransfer([lapsed, { ...lapsed, status: "submitted", note: undefined }], now), undefined, "already sent again");
  assert.equal(lapsedTransfer([{ ...lapsed, note: "refunded by our team" }], now), undefined);
  assert.equal(lapsedTransfer([{ ...lapsed, note: "No such credit" }], now), undefined, "an admin rejected it");
  assert.equal(lapsedTransfer([{ ...lapsed, reviewedAt: "2026-10-20T10:00:00Z" }], now), undefined, "too old to assume");
});
