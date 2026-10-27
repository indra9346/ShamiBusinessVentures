import { test } from "node:test";
import assert from "node:assert/strict";
import { HELD_STATUS_FILTER, clockText, holdSecondsLeft, holdView, isHeldStatus } from "../src/lib/payment-hold.ts";
import { pendingOrderQty } from "../src/lib/zoho-sync-core.ts";

test("held checkouts are not orders", () => {
  assert.equal(isHeldStatus("Awaiting Payment"), true);
  assert.equal(isHeldStatus("Payment Expired"), true);
  for (const status of ["Placed", "Payment Confirmed", "Delivered", "Cancelled", "", null]) assert.equal(isHeldStatus(status), false);
  assert.equal(HELD_STATUS_FILTER, '("Awaiting Payment","Payment Expired")');
});

test("countdown", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  assert.equal(holdSecondsLeft("2026-10-27T10:14:05Z", now), 845);
  assert.equal(holdSecondsLeft("2026-10-27T09:59:00Z", now), 0);
  assert.equal(holdSecondsLeft(null, now), 0);
  assert.equal(clockText(845), "14:05");
  assert.equal(clockText(-3), "00:00");
});

test("what the customer sees", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  const open = { status: "Awaiting Payment" as const, holdUntil: "2026-10-27T10:10:00Z" };
  assert.equal(holdView(open, false, now), "pay");
  assert.equal(holdView(open, true, now), "verifying");
  assert.equal(holdView({ ...open, holdUntil: "2026-10-27T09:00:00Z" }, false, now), "closing");
  assert.equal(holdView({ status: "Payment Confirmed", holdUntil: null }, false, now), "confirmed");
  assert.equal(holdView({ status: "Payment Expired", holdUntil: null, outcome: "expired" }, false, now), "expired");
  assert.equal(holdView({ status: "Payment Expired", holdUntil: null, outcome: "dropped" }, false, now), "dropped");
});

test("Zoho stock import: a held checkout keeps its stock reserved, an expired one gave it back", () => {
  const order = (order_status: string) => ({
    branch_id: "CLK", order_status, zoho_salesorder_id: null, zoho_order_status: null, created_at: "2026-10-27T10:00:00Z",
    items: [{ product_id: "S1", qty: 2 }],
  });
  const pending = pendingOrderQty([order("Awaiting Payment"), order("Payment Expired"), order("Cancelled")], "2026-10-01T00:00:00Z", "CLK");
  assert.equal(pending.get("CLK")?.get("S1"), 2);
});
