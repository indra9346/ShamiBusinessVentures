import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBigChange, planStockCount, stockCountDescription, stockCountProblem, stockCountReasonLabel, zohoLocationStock,
} from "../src/lib/stock-counts.ts";
import { godownStockFromZohoItem } from "../src/lib/zoho-sync-core.ts";

// The shape of GET items/{id} from the live Zoho organisation (31 Oct 2026), trimmed.
const CLK = "3579709000000848001", HBL = "3579709000003110061";
const item = (clk: Record<string, number>) => ({
  locations: [
    { location_id: "3579709000000032248", location_name: "Head Office", location_stock_on_hand: 0, location_available_stock: 0, location_actual_available_stock: 0 },
    { location_id: CLK, location_name: "CLK Shami Business Ventures", ...clk },
    { location_id: HBL, location_name: "Hubli", location_stock_on_hand: 0, location_available_stock: 0, location_actual_available_stock: 0 },
  ],
});

test("Zoho stock at a godown: physical (shipments/receives) and accounting (invoices/bills)", () => {
  assert.deepEqual(zohoLocationStock(item({ location_stock_on_hand: 100, location_available_stock: 100, location_actual_available_stock: 100 }), CLK), { physical: 100, accounting: 100 });
  // A package shipped but not yet invoiced: physical is lower than accounting.
  assert.deepEqual(zohoLocationStock(item({ location_stock_on_hand: 100, location_available_stock: 100, location_actual_available_stock: 90 }), CLK), { physical: 90, accounting: 100 });
  // Older payloads without the split fall back to stock on hand.
  assert.deepEqual(zohoLocationStock(item({ location_stock_on_hand: 40 }), CLK), { physical: 40, accounting: 40 });
  assert.equal(zohoLocationStock(item({ location_stock_on_hand: 40 }), "nope"), null);
  assert.equal(zohoLocationStock({}, CLK), null);
});

test("a count corrects Zoho's physical stock; the website takes what the next sync would", () => {
  // 100 cartons in Zoho, 95 on the floor, no website orders waiting: -5, website 95.
  assert.deepEqual(planStockCount({ counted: 95, physical: 100, accounting: 100, pendingOrders: 0 }), { delta: -5, siteAfter: 95 });
  // 2 website orders Zoho doesn't hold yet: the website keeps them off.
  assert.deepEqual(planStockCount({ counted: 95, physical: 100, accounting: 100, pendingOrders: 2 }), { delta: -5, siteAfter: 93 });
  // Shipped-not-invoiced: adjust against physical (88 - 90 = -2); accounting 100 - 2 = 98 until the invoice.
  assert.deepEqual(planStockCount({ counted: 88, physical: 90, accounting: 100, pendingOrders: 0 }), { delta: -2, siteAfter: 98 });
  // Count equal to Zoho: no adjustment.
  assert.deepEqual(planStockCount({ counted: 80, physical: 80, accounting: 80, pendingOrders: 0 }), { delta: 0, siteAfter: 80 });
  // New stock where Zoho had none.
  assert.deepEqual(planStockCount({ counted: 12, physical: 0, accounting: 0, pendingOrders: 0 }), { delta: 12, siteAfter: 12 });
  // Never below zero.
  assert.equal(planStockCount({ counted: 1, physical: 5, accounting: 5, pendingOrders: 3 }).siteAfter, 0);
});

test("the website stock after a count equals what the regular Zoho sync reads", () => {
  const before = item({ location_stock_on_hand: 100, location_available_stock: 100, location_actual_available_stock: 100 });
  const zoho = zohoLocationStock(before, CLK)!;
  const plan = planStockCount({ counted: 95, ...zoho, pendingOrders: 2 });
  const after = item({ location_stock_on_hand: 100 + plan.delta, location_available_stock: 100 + plan.delta, location_actual_available_stock: 100 + plan.delta });
  assert.equal(godownStockFromZohoItem(after, CLK, 2), plan.siteAfter);
});

test("big changes: more than 20% away from Zoho's physical stock", () => {
  assert.equal(isBigChange(100, 85), false);
  assert.equal(isBigChange(100, 80), false);
  assert.equal(isBigChange(100, 79), true);
  assert.equal(isBigChange(100, 121), true);
  assert.equal(isBigChange(0, 10), true);
  assert.equal(isBigChange(0, 0), false);
});

test("counts are whole packs", () => {
  assert.equal(stockCountProblem(95), null);
  assert.equal(stockCountProblem(0), null);
  assert.equal(stockCountProblem(Number.NaN), "Enter the counted quantity");
  assert.equal(stockCountProblem(9.5), "Enter whole bags / packs");
  assert.equal(stockCountProblem(-1), "The count can't be negative");
  assert.equal(stockCountProblem(2_000_000), "That count is too large");
});

test("Zoho adjustment description names the godown, the employee and the count", () => {
  assert.equal(stockCountReasonLabel("damaged"), "Damaged / spoiled");
  assert.equal(
    stockCountDescription({ godown: "Grain Bazar Challakere Godown", employee: "Manju", counted: 95, physical: 100, reason: "daily_count", note: " 5 torn " }),
    "Daily stock count at Grain Bazar Challakere Godown by Manju (Grain Bazar staff app): counted 95, Zoho had 100. 5 torn",
  );
});
