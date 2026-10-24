import { test } from "node:test";
import assert from "node:assert/strict";
import {
  godownPricesFromPricebook,
  godownStockFromZohoItem,
  mergeGodownPrices,
  sameGodownPrices,
  zohoPricebookItemsFor,
} from "../src/lib/zoho-sync-core.ts";

const productByZohoItem = new Map([["Z1", "P1"], ["Z2", "P2"]]);
const zohoItemByProduct = new Map([["P1", "Z1"], ["P2", "Z2"]]);
const basePrice = new Map([["P1", 2000], ["P2", 1000]]);

test("per-item price list: only linked items with a positive price", () => {
  const prices = godownPricesFromPricebook({
    pricebook_type: "per_item",
    pricebook_items: [
      { item_id: "Z1", pricebook_rate: 2150.5 },
      { item_id: "ZX", pricebook_rate: 99 },
      { item_id: "Z2", pricebook_rate: 0 },
    ],
  }, productByZohoItem, basePrice);
  assert.deepEqual(prices, { P1: 2150.5 });
});

test("percentage price list marks every linked item up or down", () => {
  assert.deepEqual(
    godownPricesFromPricebook({ pricebook_type: "fixed_percentage", percentage: 10, is_increase: true }, productByZohoItem, basePrice),
    { P1: 2200, P2: 1100 },
  );
  assert.deepEqual(
    godownPricesFromPricebook({ pricebook_type: "fixed_percentage", percentage: 5, is_increase: false }, productByZohoItem, basePrice),
    { P1: 1900, P2: 950 },
  );
});

test("website edits waiting for Zoho win over Zoho's list", () => {
  const zoho = { P1: 2150 };
  const merged = mergeGodownPrices(zoho, [
    { product_id: "P1", price: "2199", listed: true, pending: true },
    { product_id: "P2", price: 1050, listed: true, pending: true },
    { product_id: "P3", price: 10, listed: true, pending: false },
  ]);
  assert.deepEqual(merged, { P1: 2199, P2: 1050 });
  assert.deepEqual(mergeGodownPrices(zoho, [{ product_id: "P1", price: 2150, listed: false, pending: true }]), {});
  assert.equal(sameGodownPrices({ P1: 1 }, { P1: 1 }), true);
  assert.equal(sameGodownPrices({ P1: 1 }, { P1: 2 }), false);
  assert.equal(sameGodownPrices({ P1: 1 }, { P1: 1, P2: 2 }), false);
});

test("sending a price list back keeps Zoho-only items and brackets", () => {
  const items = zohoPricebookItemsFor(
    [
      { item_id: "Z1", pricebook_rate: 2150, pricebook_item_id: "PI1", price_brackets: [{ start_quantity: 10, pricebook_rate: 2100 }] },
      { item_id: "ZONLY", pricebook_rate: 55, pricebook_item_id: "PI9" },
      { item_id: "Z2", pricebook_rate: 1000, pricebook_item_id: "PI2" },
    ],
    { P1: 2199 },
    productByZohoItem,
    zohoItemByProduct,
  );
  assert.deepEqual(items, [
    { item_id: "Z1", pricebook_rate: 2199, pricebook_item_id: "PI1", price_brackets: [{ start_quantity: 10, pricebook_rate: 2100 }] },
    { item_id: "ZONLY", pricebook_rate: 55, pricebook_item_id: "PI9" },
  ]);
  const added = zohoPricebookItemsFor([], { P2: 1050 }, productByZohoItem, zohoItemByProduct);
  assert.deepEqual(added, [{ item_id: "Z2", pricebook_rate: 1050 }]);
});

test("godown stock from a Zoho location, less website orders Zoho does not hold yet", () => {
  const item = {
    locations: [
      { location_id: "L1", location_stock_on_hand: "40", location_available_stock: "38" },
      { location_id: "L2", location_stock_on_hand: "5" },
    ],
  };
  assert.equal(godownStockFromZohoItem(item, "L1"), 38);
  assert.equal(godownStockFromZohoItem(item, "L1", 3), 35);
  assert.equal(godownStockFromZohoItem(item, "L2", 9), 0);
  assert.equal(godownStockFromZohoItem(item, "L3"), null);
  assert.equal(godownStockFromZohoItem({}, "L1"), null);
});

test("only orders since Zoho became the stock master, not yet held by Zoho, are pending", async () => {
  const { pendingOrderQty } = await import("../src/lib/zoho-sync-core.ts");
  const since = "2026-10-24T12:00:00Z";
  const order = (over: Record<string, unknown>) => ({
    branch_id: "BR-HBL", order_status: "Placed", zoho_salesorder_id: null, zoho_order_status: null,
    created_at: "2026-10-24T13:00:00Z", items: [{ product_id: "P001", qty: 2 }], ...over,
  });
  const pending = pendingOrderQty([
    order({}),
    order({ zoho_salesorder_id: "SO1", zoho_order_status: "draft" }),
    order({ zoho_salesorder_id: "SO2", zoho_order_status: "confirmed" }),
    order({ order_status: "Cancelled" }),
    order({ created_at: "2026-10-17T10:00:00Z" }),
    order({ branch_id: null }),
  ] as never, since, "BR-CLK");
  assert.equal(pending.get("BR-HBL")?.get("P001"), 4, "no SO + draft SO; not confirmed, cancelled or older orders");
  assert.equal(pending.get("BR-CLK")?.get("P001"), 2, "orders without a godown belong to the default one");
});
