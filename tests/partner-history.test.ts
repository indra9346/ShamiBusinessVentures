import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartnerHistory, istDateTime, partnerHistorySheet, partnerPeriods, type HistoryEvent, type HistoryPartner } from "../src/lib/partner-history.ts";
import { buildXlsx } from "../src/lib/xlsx.ts";

const partner = (over: Partial<HistoryPartner>): HistoryPartner => ({
  id: "p1", name: "Testing Channel Partner", email: "old@example.com", phone: "", branchId: "BR-CLK", status: "suspended",
  createdAt: "2026-10-26T12:39:00Z", updatedAt: "2026-10-31T15:23:00Z", ...over,
});
const ev = (partner_id: string, event: string, at: string, over: Partial<HistoryEvent> = {}): HistoryEvent =>
  ({ partner_id, branch_id: "BR-CLK", event, at, by_name: "Sandesh", backfilled: false, ...over });

// The live Challakere case on 31 Oct 2026: the test partner suspended at 20:53 IST, Vamshi added at 20:54.
const old = partner({});
const vamshi = partner({ id: "p2", name: "Vamshi", email: "vamshi@example.com", status: "active", createdAt: "2026-10-31T15:24:00Z", updatedAt: "2026-10-31T15:24:00Z" });
const hubli = partner({ id: "p3", name: "Test Mallikarjun", branchId: "BR-HBL", status: "active", createdAt: "2026-10-26T12:49:00Z" });
const events: HistoryEvent[] = [
  ev("p1", "added", "2026-10-26T12:39:00Z", { by_name: "Indra Kumar", backfilled: true }),
  ev("p1", "suspended", "2026-10-31T15:23:00Z", { by_name: "", backfilled: true }),
  ev("p2", "added", "2026-10-31T15:24:00Z"),
  ev("p3", "added", "2026-10-26T12:49:00Z", { branch_id: "BR-HBL", by_name: "" }),
];

test("a partner's periods from the change log: added, suspended, reactivated, moved", () => {
  assert.deepEqual(partnerPeriods(old, events).map((p) => [p.godownId, p.from, p.to, p.approximate]),
    [["BR-CLK", "2026-10-26T12:39:00Z", "2026-10-31T15:23:00Z", true]]);
  assert.deepEqual(partnerPeriods(vamshi, events).map((p) => [p.from, p.to, p.startedBy, p.approximate]), [["2026-10-31T15:24:00Z", null, "Sandesh", false]]);
  // Suspended, reactivated, then moved to Hubli while active: three periods.
  const moving = partner({ id: "p9", status: "active" });
  const log = [
    ev("p9", "added", "2026-10-01T00:00:00Z"), ev("p9", "suspended", "2026-10-05T00:00:00Z"),
    ev("p9", "reactivated", "2026-10-10T00:00:00Z"), ev("p9", "moved", "2026-10-20T00:00:00Z", { branch_id: "BR-HBL" }),
  ];
  assert.deepEqual(partnerPeriods(moving, log).map((p) => [p.godownId, p.from.slice(0, 10), p.to?.slice(0, 10) ?? null]),
    [["BR-CLK", "2026-10-01", "2026-10-05"], ["BR-CLK", "2026-10-10", "2026-10-20"], ["BR-HBL", "2026-10-20", null]]);
  // No log at all: the record's own dates, marked approximate.
  assert.deepEqual(partnerPeriods(partner({ id: "px" }), []).map((p) => [p.from, p.to, p.approximate]), [["2026-10-26T12:39:00Z", "2026-10-31T15:23:00Z", true]]);
});

test("history: commissions stay with the partner of the order time; gaps show sales without commission", () => {
  const history = buildPartnerHistory({
    godowns: [{ id: "BR-CLK", name: "Challakere" }, { id: "BR-HBL", name: "Hubli" }],
    partners: [old, vamshi, hubli],
    events,
    commissions: [
      // placed under the old partner, delivered and paid after the change: still his
      { partner_id: "p1", order_id: "o1", line_total: 2400, amount: 2.5, status: "earned", placed_at: "2026-10-30T05:00:00Z" },
      { partner_id: "p1", order_id: "o1", line_total: 600, amount: 30, status: "earned", placed_at: "2026-10-30T05:00:00Z" },
      { partner_id: "p1", order_id: "o2", line_total: 1000, amount: 50, status: "pending", placed_at: "2026-10-31T04:00:00Z" },
      { partner_id: "p1", order_id: "o3", line_total: 999, amount: 9, status: "cancelled", placed_at: "2026-10-31T05:00:00Z" },
      { partner_id: "p2", order_id: "o4", line_total: 2700, amount: 2.5, status: "pending", placed_at: "2026-10-31T16:00:00Z" },
      // an unpaid checkout request (pay first) is not an order: its line counts nowhere
      { partner_id: "p1", order_id: "o8", line_total: 800, amount: 7, status: "pending", placed_at: "2026-10-31T06:00:00Z" },
    ],
    orders: [
      { id: "o1", branch_id: "BR-CLK", created_at: "2026-10-30T05:00:00Z", order_status: "Delivered", subtotal: 3000, discount: 100 },
      { id: "o2", branch_id: "BR-CLK", created_at: "2026-10-31T04:00:00Z", order_status: "Placed", subtotal: 1000, discount: 0 },
      { id: "o3", branch_id: "BR-CLK", created_at: "2026-10-31T05:00:00Z", order_status: "Cancelled", subtotal: 999, discount: 0 },
      { id: "o4", branch_id: "BR-CLK", created_at: "2026-10-31T16:00:00Z", order_status: "Placed", subtotal: 2700, discount: 0 },
      { id: "o5", branch_id: "BR-CLK", created_at: "2026-10-31T15:23:30Z", order_status: "Placed", subtotal: 949, discount: 0 },
      { id: "o6", branch_id: "BR-CLK", created_at: "2026-10-31T15:23:40Z", order_status: "Cancelled", subtotal: 500, discount: 0 },
      // a product without a commission rate: still an order and a sale of the partner's time
      { id: "o7", branch_id: "BR-CLK", created_at: "2026-10-30T06:00:00Z", order_status: "Packed", subtotal: 500, discount: 0 },
      { id: "o8", branch_id: "BR-CLK", created_at: "2026-10-31T06:00:00Z", order_status: "Awaiting Payment", subtotal: 800, discount: 0 },
    ],
    now: "2026-10-31T17:00:00Z",
  });
  const clk = history.periods.filter((p) => p.godownId === "BR-CLK");
  // newest first: Vamshi (current), the 1-minute gap, the old partner
  assert.deepEqual(clk.map((p) => [p.kind, p.partner?.name ?? "-", p.current]), [
    ["partner", "Vamshi", true], ["gap", "-", false], ["partner", "Testing Channel Partner", false],
  ]);
  const [current, gap, past] = clk;
  // sales before GST like the Godown Report: o1 + o2 + o7 (o3 cancelled, o8 unpaid)
  assert.deepEqual([past!.orders, past!.sales, past!.earned, past!.pending, past!.cancelled, past!.days, past!.approximate], [3, 4500, 32.5, 50, 9, 6, true]);
  assert.deepEqual([current!.orders, current!.sales, current!.pending, current!.days], [1, 2700, 2.5, 1]);
  assert.deepEqual([gap!.from, gap!.to, gap!.orders, gap!.sales, gap!.startedBy, gap!.endedBy],
    ["2026-10-31T15:23:00.000Z", "2026-10-31T15:24:00.000Z", 1, 949, "", ""]);
  assert.equal(history.periods.filter((p) => p.godownId === "BR-HBL").length, 1);
  assert.deepEqual(history.godowns.map((g) => [g.godown, g.current?.name ?? null, g.partnersSoFar]), [["Challakere", "Vamshi", 2], ["Hubli", "Test Mallikarjun", 1]]);

  // A godown whose partner was suspended and not replaced: an open gap up to now.
  const open = buildPartnerHistory({
    godowns: [{ id: "BR-CLK", name: "Challakere" }], partners: [old], events: events.filter((e) => e.partner_id === "p1"),
    commissions: [], orders: [], now: "2026-11-02T15:23:00Z",
  });
  assert.deepEqual(open.periods.map((p) => [p.kind, p.current, p.days]), [["gap", true, 2], ["partner", false, 6]]);

  // Excel
  const sheet = partnerHistorySheet(history, { generatedAt: "2026-10-31T17:00:00Z", godownId: "BR-CLK" });
  assert.equal(sheet.rows.length, 5 + 3);
  assert.deepEqual(sheet.rows[5]!.slice(0, 7), ["Challakere", "Vamshi", "vamshi@example.com", "", "31-10-2026 20:54", "Now", 1]);
  assert.equal(sheet.rows[6]![1], "No partner");
  assert.equal(sheet.rows[6]![9], null);
  assert.match(String(sheet.rows[7]![14]), /approximate/);
  assert.equal(istDateTime("2026-10-26T12:39:00Z"), "26-10-2026 18:09");
  assert.equal(String.fromCharCode(...buildXlsx([sheet]).slice(0, 2)), "PK");
});

test("a quick handover (minutes, no orders) is not shown as a gap", () => {
  const history = buildPartnerHistory({
    godowns: [{ id: "BR-CLK", name: "Challakere" }], partners: [old, vamshi], events: events.filter((e) => e.partner_id !== "p3"),
    commissions: [], orders: [], now: "2026-10-31T17:00:00Z",
  });
  assert.deepEqual(history.periods.map((p) => p.kind), ["partner", "partner"]);
});

test("only reconstructed suspension times are approximate; a backfilled start is the record's own time", () => {
  const [hubliPeriod] = partnerPeriods(hubli, events);
  assert.equal(hubliPeriod!.approximate, false);
  const [oldPeriod] = partnerPeriods(old, events);
  assert.equal(oldPeriod!.approximate, true);
});
