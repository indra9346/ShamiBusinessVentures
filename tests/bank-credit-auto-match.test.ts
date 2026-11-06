import { test } from "node:test";
import assert from "node:assert/strict";
import { madeAfterCredit, suggestCheckoutsForCredit } from "../src/lib/bank-credit-match.ts";
import { holdView } from "../src/lib/payment-hold.ts";

const credit = { amount: 2484, creditedAt: "2026-11-06T17:51:00+05:30", receivedAt: "2026-11-06T17:51:20+05:30" };
const checkout = (orderNo: string, amount: number, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ orderNo, amount, status: "Awaiting Payment", method: "UPI", createdAt, ...extra });

test("waiting UPI checkouts for exactly the amount, closest first; no UTR sent, none kept by another credit, no bank transfers, not ended", () => {
  const list = [
    checkout("CLK-FAR", 2484, "2026-11-06T09:00:00+05:30"),
    checkout("CLK-NEAR", 2484, "2026-11-06T17:45:00+05:30"),
    checkout("CLK-PAISE", 2484.01, "2026-11-06T17:46:00+05:30"),
    checkout("CLK-UTR", 2484, "2026-11-06T17:47:00+05:30"),
    checkout("CLK-NEFT", 2484, "2026-11-06T17:48:00+05:30", { method: "NEFT" }),
    checkout("CLK-ENDED", 2484, "2026-11-06T17:49:00+05:30", { status: "Payment Expired" }),
    checkout("CLK-OLD", 2484, "2026-11-04T17:49:00+05:30"),
    checkout("CLK-KEPT", 2484, "2026-11-06T17:50:00+05:30", { moneySeenAt: "2026-11-06T17:50:00+05:30" }),
  ];
  assert.deepEqual(suggestCheckoutsForCredit(credit, list, new Set(["CLK-UTR"])).map((c) => c.orderNo), ["CLK-NEAR", "CLK-FAR"]);
});

test("a checkout made after the money came is flagged (a Reorder), the SMS minute is not", () => {
  assert.equal(madeAfterCredit(credit, { createdAt: "2026-11-06T17:51:40+05:30" }), false);
  assert.equal(madeAfterCredit(credit, { createdAt: "2026-11-06T18:05:00+05:30" }), true);
  assert.equal(madeAfterCredit(credit, { createdAt: "2026-11-06T17:40:00+05:30" }), false);
});

test("the customer's screen: money seen by the bank beats the countdown and the UTR check", () => {
  const now = Date.parse("2026-11-06T17:52:00+05:30");
  const hold = { status: "Awaiting Payment" as const, holdUntil: "2026-11-07T17:51:00+05:30", outcome: null };
  assert.equal(holdView(hold, false, now), "pay");
  assert.equal(holdView({ ...hold, moneySeenAt: "2026-11-06T17:51:00+05:30" }, false, now), "received");
  assert.equal(holdView({ ...hold, moneySeenAt: "2026-11-06T17:51:00+05:30" }, true, now), "received");
  // Paid or ended: those win.
  assert.equal(holdView({ ...hold, status: "Payment Confirmed", moneySeenAt: "x" }, false, now), "confirmed");
  assert.equal(holdView({ ...hold, status: "Payment Expired", moneySeenAt: "x" }, false, now), "expired");
});
