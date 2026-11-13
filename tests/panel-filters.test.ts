import { test } from "node:test";
import assert from "node:assert/strict";
import { adminActivityKey, clearAdminIdleClock, startAdminIdleClock } from "../src/lib/admin-idle.ts";
import {
  APPROVED_VENDORS, inOrderRange, isLossLine, isOpenOrder, isUnpaid, matchesBatchStatus, matchesBranchView, matchesCommissionStatus, matchesCouponView,
  matchesOrderStatus, matchesPaymentFilter, matchesPayoutStatus, matchesReadFilter, matchesReviewCard, matchesStockBand, matchesStockFilter,
  matchesVendorProduct, matchesVendorStatus, matchesVendorStock, MONEY_RECEIVED, NEEDS_RESTOCK, OPEN_ORDERS, OPEN_PAYOUTS, orderListSearch,
  orderStatusFilter, orderTimestamp, paymentFilterOf, stockFilterOf, UNPAID, vendorStatusFilter,
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

test("the Products page's stock cards: low is 1 to 29, out is exactly none", () => {
  const stocks = [-1, 0, 1, 29, 30];
  assert.deepEqual(stocks.filter((stock) => matchesStockBand(stock, "low")), [1, 29]);
  assert.deepEqual(stocks.filter((stock) => matchesStockBand(stock, "out")), [0]);
  assert.equal(stocks.filter((stock) => matchesStockBand(stock, "all")).length, 5);
});

test("a vendor's stock cards: low includes out of stock, healthy is at or above its own minimum", () => {
  const products = [{ stock: 0, minimum: 10 }, { stock: 5, minimum: 10 }, { stock: 10, minimum: 10 }, { stock: 40, minimum: 50 }];
  const stocks = (view: string) => products.filter((p) => matchesVendorStock(p.stock, p.minimum, view)).map((p) => p.stock);
  assert.deepEqual(stocks("low"), [0, 5, 40]);
  assert.deepEqual(stocks("healthy"), [10]);
  assert.deepEqual(stocks("out"), [0]);
  assert.equal(stocks("all").length, 4);
  // Every product is either healthy or low.
  assert.equal(stocks("low").length + stocks("healthy").length, products.length);
});

test("a vendor's product list: the review status, or the Active and Out of Stock cards", () => {
  const live = { active: true, stock: 5, status: "approved" };
  const off = { active: false, stock: 0, status: "pending" };
  assert.equal(matchesVendorProduct(live, "on-sale"), true);
  assert.equal(matchesVendorProduct(off, "on-sale"), false);
  assert.equal(matchesVendorProduct(off, "out"), true);
  assert.equal(matchesVendorProduct(live, "out"), false);
  assert.equal(matchesVendorProduct(off, "pending"), true);
  assert.equal(matchesVendorProduct(live, "pending"), false);
  assert.equal(matchesVendorProduct(off, "all"), true);
});

test("the Approved vendors card counts approved and active; a link's status: a known one, else all", () => {
  assert.equal(matchesVendorStatus("approved", APPROVED_VENDORS), true);
  assert.equal(matchesVendorStatus("active", APPROVED_VENDORS), true);
  assert.equal(matchesVendorStatus("pending", APPROVED_VENDORS), false);
  assert.equal(matchesVendorStatus("suspended", "suspended"), true);
  assert.equal(matchesVendorStatus("suspended", "all"), true);
  assert.equal(vendorStatusFilter(APPROVED_VENDORS), APPROVED_VENDORS);
  assert.equal(vendorStatusFilter("pending"), "pending");
  assert.equal(vendorStatusFilter("nonsense"), "all");
  assert.equal(vendorStatusFilter(undefined), "all");
});

test("the payment cards: each card's figure comes from the rows it opens", () => {
  const txns = [
    { status: "Successful", payment: "Paid", amount: 100, paid: 100 },
    { status: "Partially Paid", payment: "Partially Paid", amount: 100, paid: 30 },
    { status: "Pending", payment: "Pending", amount: 50, paid: 0 },
    { status: "Overdue", payment: "Pending", amount: 20, paid: 0 },
    { status: "Failed", payment: "Failed", amount: 10, paid: 0 },
    { status: "Refunded", payment: "Refunded", amount: 40, paid: 0 },
  ];
  const shown = (filter: string) => txns.filter((t) => matchesPaymentFilter(t, filter));
  assert.equal(shown(MONEY_RECEIVED).reduce((sum, t) => sum + t.paid, 0), txns.reduce((sum, t) => sum + t.paid, 0));
  assert.equal(shown(MONEY_RECEIVED).length, 2);
  // Unpaid: the three open orders, and what is still due on them.
  assert.deepEqual(shown(UNPAID).map((t) => t.status), ["Partially Paid", "Pending", "Overdue"]);
  assert.equal(shown(UNPAID).reduce((sum, t) => sum + t.amount - t.paid, 0), 140);
  assert.equal(shown("Overdue").length, 1);
  assert.equal(shown("All").length, 6);
  assert.equal(isUnpaid("COD"), true);
  assert.equal(isUnpaid("Failed"), false);
  assert.equal(paymentFilterOf("Successful"), "Successful");
  assert.equal(paymentFilterOf(MONEY_RECEIVED), MONEY_RECEIVED);
  assert.equal(paymentFilterOf("nonsense"), "All");
  assert.equal(paymentFilterOf(undefined), "All");
});

test("the open payouts card leaves out paid and rejected requests", () => {
  const statuses = ["Pending", "Processing", "Paid", "Rejected"];
  assert.deepEqual(statuses.filter((status) => matchesPayoutStatus(status, OPEN_PAYOUTS)), ["Pending", "Processing"]);
  assert.deepEqual(statuses.filter((status) => matchesPayoutStatus(status, "Paid")), ["Paid"]);
  assert.equal(statuses.filter((status) => matchesPayoutStatus(status, "All")).length, 4);
});

test("commission lines: the same split as the commission cards", () => {
  const statuses = ["earned", "pending", "held", "cancelled"];
  const shown = (filter: string) => statuses.filter((status) => matchesCommissionStatus(status, filter));
  assert.deepEqual(shown("earned"), ["earned"]);
  assert.deepEqual(shown("pending"), ["pending", "held"]);
  assert.deepEqual(shown("sales"), ["earned", "pending", "held"]);
  assert.equal(shown("all").length, 4);
});

test("the vendor review cards count published reviews only", () => {
  const reviews = [
    { status: "Published", rating: 5 }, { status: "Published", rating: 3 }, { status: "Published", rating: 2 },
    { status: "Pending", rating: 5 }, { status: "Rejected", rating: 1 },
  ];
  const count = (card: string) => reviews.filter((review) => matchesReviewCard(review, card)).length;
  assert.equal(count("all"), 5);
  assert.equal(count("published"), 3);
  assert.equal(count("five"), 1);
  assert.equal(count("low"), 1);
});

test("the coupon, read and batch views", () => {
  const coupons = [{ status: "Active", used: 3 }, { status: "Scheduled", used: 0 }, { status: "Expired", used: 1 }];
  assert.equal(coupons.filter((coupon) => matchesCouponView(coupon, "all")).length, 3);
  assert.equal(coupons.filter((coupon) => matchesCouponView(coupon, "used")).length, 2);
  assert.equal(coupons.filter((coupon) => matchesCouponView(coupon, "Scheduled")).length, 1);
  assert.equal(matchesReadFilter(false, "unread"), true);
  assert.equal(matchesReadFilter(true, "unread"), false);
  assert.equal(matchesReadFilter(true, "read"), true);
  assert.equal(matchesReadFilter(false, "read"), false);
  assert.equal(matchesReadFilter(false, "all"), true);
  const batches = [{ available: 5, lost: 0 }, { available: 0, lost: 2 }];
  assert.equal(matchesBatchStatus(batches[0]!, "stock"), true);
  assert.equal(matchesBatchStatus(batches[1]!, "stock"), false);
  assert.equal(matchesBatchStatus(batches[1]!, "soldout"), true);
  assert.equal(matchesBatchStatus(batches[0]!, "lost"), false);
  assert.equal(matchesBatchStatus(batches[1]!, "lost"), true);
  assert.equal(matchesBatchStatus(batches[0]!, "all"), true);
});

test("the branch cards: delivery counts active branches only", () => {
  const base = { active: true, deliveryEnabled: true, isDefault: false };
  assert.equal(matchesBranchView(base, "delivery"), true);
  assert.equal(matchesBranchView({ ...base, active: false }, "delivery"), false);
  assert.equal(matchesBranchView({ ...base, active: false }, "active"), false);
  assert.equal(matchesBranchView(base, "default"), false);
  assert.equal(matchesBranchView({ ...base, isDefault: true }, "default"), true);
  assert.equal(matchesBranchView({ ...base, active: false }, "all"), true);
});

test("a loss line: sold below cost, cancelled or refunded; a line with no cost is not a loss", () => {
  const line = { margin: 10 as number | null, orderStatus: "Placed", paymentStatus: "Paid" };
  assert.equal(isLossLine(line), false);
  assert.equal(isLossLine({ ...line, margin: -1 }), true);
  assert.equal(isLossLine({ ...line, margin: null }), false);
  assert.equal(isLossLine({ ...line, orderStatus: "Cancelled" }), true);
  assert.equal(isLossLine({ ...line, paymentStatus: "Refunded" }), true);
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

// Kept in its own file; run from here so package.json, which every open PR edits, stays out of this change.
import "./customer-data.test.ts";

test("13 Nov: Newest First sorts orders by when they were placed, not by the order number as text", async () => {
  const { compareOrdersByDate } = await import("../src/lib/panel-filters.ts");
  // The owner's screenshot: by number as text these came 17, 16, 20, 17, 26, 17 Oct.
  const orders = [
    { id: "ORD-28698", createdAt: "2026-10-17T10:00:00Z", date: "17 Oct 2026" },
    { id: "ORD-27818", createdAt: "2026-10-16T09:00:00Z", date: "16 Oct 2026" },
    { id: "ORD-27757", createdAt: "2026-10-20T08:00:00Z", date: "20 Oct 2026" },
    { id: "ORD-26889", createdAt: "2026-10-17T07:00:00Z", date: "17 Oct 2026" },
    { id: "ORD-26102615297", createdAt: "2026-10-26T06:00:00Z", date: "26 Oct 2026" },
    { id: "CLK-577522-131126-164242", createdAt: "2026-11-13T11:12:42Z", date: "13 Nov 2026" },
    { id: "OLD-NO-TIME", date: "" },
  ];
  assert.deepEqual([...orders].sort((a, b) => compareOrdersByDate(a, b, true)).map((o) => o.id),
    ["CLK-577522-131126-164242", "ORD-26102615297", "ORD-27757", "ORD-28698", "ORD-26889", "ORD-27818", "OLD-NO-TIME"]);
  assert.deepEqual([...orders].sort((a, b) => compareOrdersByDate(a, b, false)).map((o) => o.id),
    ["ORD-27818", "ORD-26889", "ORD-28698", "ORD-27757", "ORD-26102615297", "CLK-577522-131126-164242", "OLD-NO-TIME"]);
  // Only the shown date (older rows): still by day.
  assert.ok(compareOrdersByDate({ id: "A", date: "17 Oct 2026" }, { id: "B", date: "26 Oct 2026" }) > 0);
});
