import test from "node:test";
import assert from "node:assert/strict";
import { istDay, stockDay, withZoho, type DashBatch, type DashMove } from "../src/lib/stock-dashboard.ts";

const b1: DashBatch = { id: "b1", code: "CLK-131126-02", lotNo: "SS/S1/340/003", productId: "p1", productName: "Sugar S1" };
const moves: DashMove[] = [
  { batchId: "b1", at: "2026-11-13T04:00:00Z", kind: "receipt", qty: 340 },
  { batchId: "b1", at: "2026-11-14T05:00:00Z", kind: "sale", qty: 10 },
  { batchId: "b1", at: "2026-11-14T09:00:00Z", kind: "handover", qty: 6 },
  { batchId: "b1", at: "2026-11-15T05:00:00Z", kind: "sale", qty: 5 },
  { batchId: "b1", at: "2026-11-15T06:00:00Z", kind: "handover", qty: 4 },
  { batchId: "b1", at: "2026-11-15T07:00:00Z", kind: "sent", qty: 20 },
  { batchId: "b1", at: "2026-11-15T08:00:00Z", kind: "adjustment", qty: -1 },
  { batchId: "b1", at: "2026-11-15T08:30:00Z", kind: "return", qty: 2 },
];

test("istDay uses India time", () => {
  assert.equal(istDay("2026-11-14T19:00:00Z"), "2026-11-15");
  assert.equal(istDay("bad"), "");
});

test("one day: opening, the day's movements, undelivered and expected balance", () => {
  const [p] = stockDay([b1], moves, "2026-11-15");
  const r = p!.rows[0]!;
  assert.equal(r.opening, 334); // 340 − 6 handed over on the 14th
  assert.equal(r.receipts, 2);
  assert.equal(r.sent, 20);
  assert.equal(r.adjustments, -1);
  assert.equal(r.sales, 5);
  assert.equal(r.handedOver, 4);
  assert.equal(r.undelivered, 5); // 15 sold − 10 handed over
  assert.equal(r.expected, 311); // 334 + 2 − 20 − 1 − 4
});

test("later movements don't count; Zoho only today, variance = Zoho − expected", () => {
  const [p] = stockDay([b1], moves, "2026-11-14");
  assert.equal(p!.totals.expected, 334);
  assert.equal(p!.totals.undelivered, 4);
  const [today] = withZoho([p!], new Map([["p1", 330]]), true);
  assert.equal(today!.variance, -4);
  const [past] = withZoho([p!], new Map([["p1", 330]]), false);
  assert.equal(past!.zohoOnHand, null);
  assert.equal(past!.variance, null);
  const [none] = withZoho([p!], new Map(), true);
  assert.equal(none!.zohoOnHand, null);
});
