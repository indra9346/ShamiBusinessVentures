import { test } from "node:test";
import assert from "node:assert/strict";
import { godownOfferOf, orderGodownFor, zohoLocationLabel } from "../src/lib/godown-rules.ts";
import type { Branch, BranchState, GodownPrice } from "../src/lib/branches.ts";

const branch = (over: Partial<Branch>): Branch => ({
  id: "", code: "", name: "", address: "", city: "", state: "", stateCode: "", pincode: "", phone: "",
  email: "", mapUrl: "", instructions: "", gstin: "", zohoLocationId: "", zohoLocationName: "",
  zohoPricebookId: "", zohoPricebookName: "", servesPincodes: [], pickupEnabled: true, deliveryEnabled: true,
  deliveryFee: 0, freeDeliveryAbove: null, isDefault: false, active: true, sortOrder: 0, vendorId: null, ...over,
});

// As on the live site: Challakere (default, no price list) and Hubli (its own Zoho price list).
const challakere = branch({ id: "BR-CLK", name: "Grain Bazar Challakere Godown", isDefault: true, servesPincodes: ["577522"], zohoLocationId: "L1", zohoLocationName: "CLK Shami Business Ventures" });
const hubli = branch({ id: "BR-HBL", name: "Grain Bazar Hubli Godown", servesPincodes: ["580020", "580021"], zohoLocationId: "L2", zohoLocationName: "Hubli", zohoPricebookId: "PB1" });

const state = (routing: boolean): Pick<BranchState, "branches" | "features" | "prices" | "stock"> => ({
  branches: [challakere, hubli],
  features: { branchRouting: routing, marketplaceVendors: false },
  prices: new Map([["P001", new Map<string, GodownPrice>([["BR-HBL", { price: 2617.13, listed: true, pending: false }]])]]),
  stock: new Map([
    ["P001", new Map([["BR-CLK", 174], ["BR-HBL", 2]])],
    ["P019", new Map([["BR-CLK", 85], ["BR-HBL", 0]])],
  ]),
});
const sugar = { id: "P001", price: 2399, stock: 176 };
const oil = { id: "P019", price: 2049, stock: 85 };

test("a Hubli address orders from Hubli at its price-list price and stock", () => {
  const s = state(true);
  const godown = orderGodownFor(s, "580020");
  assert.equal(godown?.id, "BR-HBL");
  assert.deepEqual(godownOfferOf(s, godown, sugar), { price: 2617.13, stock: 2 });
});

test("an item missing from Hubli's price list is not sold there", () => {
  const s = state(true);
  assert.deepEqual(godownOfferOf(s, orderGodownFor(s, "580020"), oil), { price: null, stock: 0 });
});

test("a Challakere or unknown PIN orders from Challakere at the base price and its stock", () => {
  const s = state(true);
  for (const pin of ["577522", "560001", "", undefined]) {
    const godown = orderGodownFor(s, pin);
    assert.equal(godown?.id, "BR-CLK");
    assert.deepEqual(godownOfferOf(s, godown, sugar), { price: 2399, stock: 174 });
  }
});

test("with PIN matching off every order uses the default godown and the product's own price and stock", () => {
  const s = state(false);
  const godown = orderGodownFor(s, "580020");
  assert.equal(godown?.id, "BR-CLK");
  assert.deepEqual(godownOfferOf(s, godown, sugar), { price: 2399, stock: 176 });
  assert.deepEqual(godownOfferOf(s, godown, oil), { price: 2049, stock: 85 });
});

test("the order page names the order's Zoho location, not Head Office", () => {
  assert.equal(zohoLocationLabel(hubli), 'the Zoho location "Hubli"');
  assert.equal(zohoLocationLabel(challakere), 'the Zoho location "CLK Shami Business Ventures"');
  assert.equal(zohoLocationLabel(branch({ name: "New godown" })), "the primary Zoho location");
  assert.equal(zohoLocationLabel(null), "the primary Zoho location");
});
