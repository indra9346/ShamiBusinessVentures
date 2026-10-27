import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UPI_SETTINGS, isValidVpa, reviewSubmission, secondsLeft, settingsProblem, upiAppLinks, upiPaymentUri, upsertSubmission, utrProblem,
  type UpiSubmission,
} from "../src/lib/upi-pay.ts";

test("UPI IDs", () => {
  assert.equal(isValidVpa("shamibusiness@icici"), true);
  assert.equal(isValidVpa("grain.bazar-77@okaxis"), true);
  assert.equal(isValidVpa("9346476951@ybl"), true);
  assert.equal(isValidVpa("no-at-sign"), false);
  assert.equal(isValidVpa("a@1bank"), false);
  assert.equal(isValidVpa("@icici"), false);
});

test("UTR: 12 digits, spaces ignored", () => {
  assert.equal(utrProblem("6123 4567 8901"), null);
  assert.match(utrProblem("")!, /12-digit/);
  assert.match(utrProblem("61234567890")!, /11/);
  assert.match(utrProblem("ABC123456789")!, /only digits/);
});

test("payment link: exact amount, order number as note and reference, %20 spaces", () => {
  const uri = upiPaymentUri({ vpa: "shamibusiness@icici", payeeName: "Shami Business Ventures" }, 2835, "CLK-577522-271026-111004");
  assert.equal(uri, "upi://pay?pa=shamibusiness%40icici&pn=Shami%20Business%20Ventures&am=2835.00&cu=INR&tn=Grain%20Bazar%20CLK-577522-271026-111004&tr=CLK-577522-271026-111004");
  assert.match(upiPaymentUri({ vpa: "x@icici", payeeName: "X" }, 2151.454, "ORD-1"), /am=2151\.45&/);
  const links = upiAppLinks(uri);
  assert.deepEqual(links.map((l) => l.app), ["Google Pay", "PhonePe", "Paytm", "Any UPI app"]);
  assert.ok(links[0]!.href.startsWith("tez://upi/pay?pa=shamibusiness%40icici&"));
  assert.equal(links[3]!.href, uri);
});

test("settings must be complete before switching on", () => {
  assert.equal(settingsProblem(DEFAULT_UPI_SETTINGS), null); // off: nothing to check
  assert.match(settingsProblem({ ...DEFAULT_UPI_SETTINGS, enabled: true })!, /UPI ID/);
  assert.equal(settingsProblem({ ...DEFAULT_UPI_SETTINGS, enabled: true, vpa: "shamibusiness@icici" }), null);
  assert.match(settingsProblem({ ...DEFAULT_UPI_SETTINGS, enabled: true, vpa: "shamibusiness@icici", payWindowMinutes: 2 })!, /5 to 60/);
});

test("pay window countdown", () => {
  assert.equal(secondsLeft(0, 15, 60_000), 840);
  assert.equal(secondsLeft(0, 15, 16 * 60_000), 0);
});

test("submissions: one per order, a UTR cannot pay two orders, confirmed ones are final", () => {
  const sub = (orderNo: string, utr: string): UpiSubmission => ({ orderNo, amount: 100, utr, customer: "Kiran", submittedAt: "2026-10-27T10:00:00Z", status: "submitted" });
  let list = upsertSubmission([], sub("A", "111111111111"));
  list = upsertSubmission(list, sub("A", "222222222222")); // customer corrects the UTR
  assert.equal(list.length, 1);
  assert.equal(list[0]!.utr, "222222222222");
  assert.throws(() => upsertSubmission(list, sub("B", "222222222222")), /already used for order A/);
  list = reviewSubmission(list, "A", "rejected", "2026-10-27T10:05:00Z", "No credit in bank");
  // Rejected: its UTR may be reused (a typo fixed on the right order) and the order can resubmit.
  list = upsertSubmission(list, sub("B", "222222222222"));
  list = reviewSubmission(list, "B", "confirmed", "2026-10-27T10:06:00Z");
  assert.throws(() => upsertSubmission(list, sub("B", "333333333333")), /already confirmed/);
  assert.equal(list.find((s) => s.orderNo === "A")!.note, "No credit in bank");
});
