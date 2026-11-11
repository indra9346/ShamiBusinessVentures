import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kn } from "../src/lib/i18n-kn.ts";

// 11 Nov 2026, the owner: a customer's Paytm refused the payment link ("UPI risk policy", no money taken). Every pay
// screen now also shows our UPI ID to copy and pay from any UPI app by hand, and the UTR can be sent from My Orders too.

test("every UPI pay screen offers our UPI ID to copy, and the UTR box", () => {
  const box = readFileSync("src/components/site/UpiIdPay.tsx", "utf8");
  assert.match(box, /export function UpiIdPay\(/);
  assert.match(box, /export function UpiUtrForm\(/);
  // Copying the UPI ID keeps a waiting checkout 10 more minutes, once, like coming back from a UPI app.
  assert.match(box, /supabase\.rpc\("extend_my_payment_hold", \{ _order_no: orderNo \}\)/);
  // Works where the clipboard API is missing (older phone browsers).
  assert.match(box, /document\.execCommand\("copy"\)/);
  // The pasted receipt text still gives the UTR, and the box keeps the id the back-from-app focus looks for.
  assert.match(box, /utrFromText\(e\.clipboardData\.getData\("text"\)\)/);
  assert.match(box, /id=\{`utr-\$\{orderNo\}`\}/);

  const held = readFileSync("src/components/site/HeldCheckoutPay.tsx", "utf8");
  assert.match(held, /<UpiIdPay orderNo=\{orderNo\} vpa=\{settings\.vpa\}/);
  assert.match(held, /<UpiUtrForm orderNo=\{orderNo\} amount=\{amount\} customer=\{customer\} submission=\{submission\} \/>/);
  const older = readFileSync("src/components/site/UpiPayPanel.tsx", "utf8");
  assert.match(older, /<UpiIdPay [^>]*keepCheckout=\{false\} \/>/, "a placed order has no checkout to keep");

  const mine = readFileSync("src/routes/account.orders.tsx", "utf8");
  assert.match(mine, /<UpiIdPay orderNo=\{hold\.orderNo\}/);
  assert.match(mine, /<UpiUtrForm orderNo=\{hold\.orderNo\}/);
  assert.match(mine, /<BankUtrForm orderNo=\{hold\.orderNo\}/);
  assert.match(mine, /\{!utrSent && !moneyCame && left > 0 && \(/, "only while it can still be paid");
});

test("the new lines have their Kannada", () => {
  for (const key of [
    "Or pay from your UPI app by our UPI ID",
    "Use this if the QR or the app button does not work for you.",
    "Copy our UPI ID:",
    "Copy UPI ID",
    "Copied",
    "Open any UPI app (Google Pay, PhonePe, Paytm, BHIM…), choose Pay to UPI ID and paste it. Check that the name shows {0}.",
    "Pay exactly this amount:",
    "Copy amount",
    "Come back here and enter the 12-digit UPI Ref No. (UTR) from the receipt below.",
    "If your UPI app says the payment failed or was declined, no money was taken. Try paying this way, or with another UPI app.",
    "UPI ID copied",
    "Amount copied",
    "Could not copy. Please type it in your UPI app.",
    "Paid? Enter the 12-digit UPI Ref No. (UTR) from your UPI app",
  ])
    assert.ok(kn[key], key);
});
