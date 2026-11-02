import { test } from "node:test";
import assert from "node:assert/strict";
import { adminActivityKey, clearAdminIdleClock, startAdminIdleClock } from "../src/lib/admin-idle.ts";
import {
  inOrderRange, isOpenOrder, matchesOrderStatus, matchesStockFilter, NEEDS_RESTOCK, OPEN_ORDERS, orderListSearch,
  orderStatusFilter, orderTimestamp, stockFilterOf,
} from "../src/lib/panel-filters.ts";

const stages = ["Placed", "Packed", "Delivered", "Cancelled"];

test("a dashboard's pending orders and the order list's filter count the same orders", () => {
  const orders = ["Placed", "Packed", "Delivered", "Cancelled", "Placed"];
  const pendingOnCard = orders.filter(isOpenOrder).length;
  assert.equal(orders.filter((status) => matchesOrderStatus(status, OPEN_ORDERS)).length, pendingOnCard);
  assert.equal(pendingOnCard, 3);
  assert.equal(orders.filter((status) => matchesOrderStatus(status, "all")).length, 5);
  assert.equal(orders.filter((status) => matchesOrderStatus(status, "Delivered")).length, 1);
});

test("a link's order status: a known one, else all", () => {
  assert.equal(orderStatusFilter(OPEN_ORDERS, stages), OPEN_ORDERS);
  assert.equal(orderStatusFilter("Packed", stages), "Packed");
  assert.equal(orderStatusFilter("nonsense", stages), "all");
  assert.equal(orderStatusFilter(undefined, stages), "all");
});

test("the date range matches the dashboard's order time, both ends included", () => {
  const from = new Date(2026, 10, 1).toISOString();
  const to = new Date(2026, 10, 30, 23, 59, 59, 999).toISOString();
  const at = (createdAt: string) => ({ createdAt, date: "ignored" });
  assert.equal(inOrderRange(at(from), from, to), true);
  assert.equal(inOrderRange(at(to), from, to), true);
  assert.equal(inOrderRange(at(new Date(2026, 9, 31, 23, 59).toISOString()), from, to), false);
  assert.equal(inOrderRange(at(new Date(2026, 11, 1).toISOString()), from, to), false);
  // An order with only a display date, in local time.
  assert.equal(inOrderRange({ date: "2 Nov 2026" }, from, to), true);
  assert.equal(orderTimestamp({ date: "2026-11-02" }).getDate(), 2);
  // No range, or half a range: every order.
  assert.equal(inOrderRange(at(from)), true);
  assert.equal(inOrderRange(at(from), from), true);
});

test("a link's search: bad values are dropped, a range needs both ends", () => {
  const from = "2026-11-01T00:00:00.000Z", to = "2026-11-30T00:00:00.000Z";
  assert.deepEqual(orderListSearch({ status: "open", from, to }), { status: "open", from, to });
  assert.deepEqual(orderListSearch({ from }), {});
  assert.deepEqual(orderListSearch({ from: "not a date", to }), {});
  assert.deepEqual(orderListSearch({ status: 5 }), {});
  assert.deepEqual(orderListSearch({}), {});
  // What a page re-checks: the router keeps raw values, so a cut-off link shows the plain list.
  assert.deepEqual(orderListSearch({ from, to: "2026-11-30T18" }), {});
  assert.deepEqual(orderListSearch({ from: 5, to: 6 }), {});
  assert.deepEqual(orderListSearch({ from: "garbage", to: "garbage" }), {});
});

test("the stock filter: restock means low or out, as the dashboard counts it", () => {
  const stocks = ["In Stock", "Low Stock", "Out of Stock"];
  assert.deepEqual(stocks.filter((status) => matchesStockFilter(status, NEEDS_RESTOCK)), ["Low Stock", "Out of Stock"]);
  assert.deepEqual(stocks.filter((status) => matchesStockFilter(status, "Low Stock")), ["Low Stock"]);
  assert.equal(stocks.filter((status) => matchesStockFilter(status, "All")).length, 3);
  assert.equal(stockFilterOf(NEEDS_RESTOCK), NEEDS_RESTOCK);
  assert.equal(stockFilterOf("nonsense"), "All");
  assert.equal(stockFilterOf(undefined), "All");
});

test("a new admin sign-in replaces the idle clock left by an earlier session", () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
  try {
    const key = adminActivityKey("admin-1");
    assert.equal(key, "shami-admin-last-activity:admin-1");
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    store.set(key, String(twoDaysAgo));
    startAdminIdleClock("admin-1");
    assert.ok(Date.now() - Number(store.get(key)) < 5_000);
    clearAdminIdleClock("admin-1");
    assert.equal(store.has(key), false);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
  }
});
