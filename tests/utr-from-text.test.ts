import { test } from "node:test";
import assert from "node:assert/strict";
import { utrFromText } from "../src/lib/upi-pay.ts";

test("PhonePe receipt (the owner's Rs 1 test, 6 Nov 2026): the UTR, not PhonePe's transaction ID", () => {
  const shared = "Paid to SHAMI BUSINESS VENTURES PRIVATE LIMITED ₹1\nMessage: Grain Bazar TEST-1\nPhonePe Transaction ID: T2611061751454033114368\nDebited from UPI Lite\nUTR: 447464171140";
  assert.equal(utrFromText(shared), "447464171140");
});

test("Google Pay and Paytm wording, spaces in the number", () => {
  assert.equal(utrFromText("UPI transaction ID\n6123 4567 8901\nTo: Shami Business Ventures"), "612345678901");
  assert.equal(utrFromText("Paytm: Ref No: 412345678901. Money sent"), "412345678901");
  assert.equal(utrFromText("UPI Ref No 345678901234"), "345678901234");
});

test("just the number, typed or pasted", () => {
  assert.equal(utrFromText("447464171140"), "447464171140");
  assert.equal(utrFromText(" 4474 6417 1140 "), "447464171140");
});

test("unsure means nothing: two different 12-digit numbers, a phone number, or none", () => {
  assert.equal(utrFromText("123456789012 and 210987654321"), null);
  assert.equal(utrFromText("Call 9876543210"), null);
  assert.equal(utrFromText("T2611061751454033114368"), null);
  assert.equal(utrFromText(""), null);
});
