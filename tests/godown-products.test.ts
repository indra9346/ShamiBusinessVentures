import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GODOWN_PRODUCT_GROUPS, godownPricesNote, godownProductOptions, godownProductTag, godownRateWarning,
  groupGodownProducts, onGodownPriceList, shopState, type GodownPriceBook,
} from "../src/lib/godown-products.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// The live catalogue on 6 Nov 2026, in short: a product on the shop, five hidden older ones, a Zoho
// copy of "Sugar S1", and an imported item waiting for approval.
const products = [
  { id: "P-BELGAUM", name: "Belgaum Sugars 50 kg", vendorId: "VENDOR-001", status: "approved", active: true },
  { id: "P001", name: "S1 Refined Sugar 50kg Bag", vendorId: "VENDOR-001", status: "approved", active: false },
  { id: "P019", name: "Sunflower Oil 15L Tin", vendorId: "VENDOR-001", status: "approved", active: false },
  { id: "zoho-3579709000000834001", name: "Sugar S1", vendorId: "zoho:60066526172", status: "approved", active: true },
  { id: "ZI-3579709000000834002", name: "Sugar S1", vendorId: "VENDOR-001", status: "pending", active: false },
  { id: "P-REJ", name: "Rejected rice", vendorId: "VENDOR-002", status: "rejected", active: true },
];
const challakere = { id: "BR-CLK", zohoPricebookId: "" };
const hubli = { id: "BR-HBL", zohoPricebookId: "3579709000003192005" };
const prices: GodownPriceBook = new Map([
  ["P001", new Map([["BR-HBL", { price: 2617.13, listed: true }]])],
  ["P019", new Map([["BR-HBL", { price: 2049, listed: false }]])],
]);

test("where a product stands follows the storefront rule", () => {
  assert.equal(shopState({ status: "approved", active: true }), "on_shop");
  assert.equal(shopState({ status: "approved", active: false }), "hidden");
  assert.equal(shopState({ status: "pending", active: true }), "pending");
  assert.equal(shopState({ status: "rejected", active: true }), "rejected");
  assert.equal(shopState({ status: null, active: true }), "pending");
});

test("hidden products are offered for a godown, Zoho copies never are", () => {
  const ids = godownProductOptions(products, challakere).map((option) => option.product.id);
  assert.ok(ids.includes("P001"), "the hidden S1 can be chosen at Challakere");
  assert.ok(ids.includes("ZI-3579709000000834002"), "an imported item waiting for approval can be chosen");
  assert.ok(!ids.includes("zoho-3579709000000834001"), "a Zoho copy is not a product");
  assert.equal(ids.length, 5);
});

test("what a godown's customers can buy comes first", () => {
  const options = godownProductOptions(products, challakere);
  assert.equal(options[0]!.product.id, "P-BELGAUM");
  assert.equal(options[0]!.soldHere, true);
  assert.deepEqual(options.slice(1).map((option) => option.state), ["pending", "hidden", "hidden", "rejected"]);
});

test("a godown with a price list sells only its listed items with a price", () => {
  assert.equal(onGodownPriceList("P-BELGAUM", challakere, prices), true);
  assert.equal(onGodownPriceList("P-BELGAUM", hubli, prices), false);
  assert.equal(onGodownPriceList("P001", hubli, prices), true);
  assert.equal(onGodownPriceList("P019", hubli, prices), false, "switched off in the price list");
  assert.equal(onGodownPriceList("P001", null, prices), true);
});

test("options are grouped under fixed headings, empty ones left out", () => {
  const atHubli = groupGodownProducts(godownProductOptions(products, hubli, prices));
  assert.deepEqual(atHubli.map((group) => group.label), [
    GODOWN_PRODUCT_GROUPS.notOnList, GODOWN_PRODUCT_GROUPS.pending, GODOWN_PRODUCT_GROUPS.hidden, GODOWN_PRODUCT_GROUPS.rejected,
  ]);
  const atChallakere = groupGodownProducts(godownProductOptions(products, challakere));
  assert.equal(atChallakere[0]!.label, GODOWN_PRODUCT_GROUPS.soldHere);
  assert.deepEqual(atChallakere.find((group) => group.label === GODOWN_PRODUCT_GROUPS.hidden)!.options.map((o) => o.product.id), ["P001", "P019"]);
});

test("tags say why a product can't be bought at the godown", () => {
  const tags = Object.fromEntries(godownProductOptions(products, hubli, prices).map((option) => [option.product.id, godownProductTag(option)]));
  assert.equal(tags["P-BELGAUM"], "Not on this godown's price list");
  assert.equal(tags["P001"], "Hidden on the shop");
  assert.equal(tags["ZI-3579709000000834002"], "Waiting for approval");
  assert.equal(tags["P-REJ"], "Rejected");
  assert.equal(godownProductTag({ state: "on_shop", onPriceList: true }), null);
});

test("a saved rate warns when it can earn nothing, and the default rate never does", () => {
  assert.equal(godownRateWarning(null, products, hubli, prices), null);
  assert.equal(godownRateWarning("P-BELGAUM", products, challakere, prices), null);
  assert.match(godownRateWarning("P001", products, hubli, prices)!, /^Hidden on the shop/);
  assert.match(godownRateWarning("P019", products, hubli, prices)!, /^Hidden on the shop/);
  assert.match(godownRateWarning("P-BELGAUM", products, hubli, prices)!, /^Not on this godown's price list/);
  assert.match(godownRateWarning("P-GONE", products, hubli, prices)!, /no longer on the website/);
  assert.match(godownRateWarning("zoho-3579709000000834001", products, hubli, prices)!, /no longer on the website/);
});

test("a product's godown prices say when it is hidden", () => {
  assert.equal(godownPricesNote({ status: "approved", active: true }), null);
  assert.match(godownPricesNote({ status: "approved", active: false })!, /^Hidden on the shop/);
  assert.match(godownPricesNote({ status: "pending", active: false })!, /^Waiting for approval/);
  assert.match(godownPricesNote({ status: "rejected", active: false })!, /^Rejected/);
});

test("every heading, tag and warning reads in Kannada", () => {
  const english = [
    ...Object.values(GODOWN_PRODUCT_GROUPS),
    "Waiting for approval", "Rejected", "Hidden on the shop", "Not on this godown's price list",
    godownRateWarning("P001", products, hubli, prices)!, godownRateWarning("P-BELGAUM", products, hubli, prices)!,
    godownRateWarning("P-GONE", products, hubli, prices)!,
    godownPricesNote({ status: "approved", active: false })!, godownPricesNote({ status: "pending", active: false })!,
    godownPricesNote({ status: "rejected", active: false })!,
  ];
  for (const text of english) assert.ok(kn[text], `missing Kannada for "${text}"`);
});
