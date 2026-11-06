import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awaitingImportApproval,
  zohoItemAsHiddenProduct,
  zohoItemGstPercent,
  zohoItemImportable,
  zohoItemSaleProblem,
  zohoItemsNotOnWebsite,
  zohoItemSku,
} from "../src/lib/zoho-item-import.ts";
import { shownOnStorefront } from "../src/lib/storefront-visibility.ts";

const ekadantha = {
  item_id: "3579709000003476321",
  name: "Ekadantha OIL 850ML",
  status: "active",
  can_be_sold: true,
  product_type: "goods",
  rate: 171.43,
  purchase_rate: 123.81,
  label_rate: 180,
  sku: "SBV-OI-1023",
  hsn_or_sac: "15081000",
  created_time: "2026-11-04T16:33:33+0530",
  available_for_sale_stock: 0,
  item_tax_preferences: [
    { tax_specification: "inter", tax_percentage: 5 },
    { tax_specification: "intra", tax_percentage: 5 },
  ],
};

test("a new active item for sale can come in", () => {
  assert.equal(zohoItemImportable(ekadantha), true);
});

test("items made before the import date stay out", () => {
  assert.equal(zohoItemImportable({ ...ekadantha, created_time: "2026-11-03T23:59:59+0530" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, created_time: "2026-11-04T00:00:00+0530" }), true);
});

test("inactive, not for sale, service, nameless or undated items stay out", () => {
  assert.equal(zohoItemImportable({ ...ekadantha, status: "inactive" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, can_be_sold: false }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, product_type: "service" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, name: "  " }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, created_time: "" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, rate: "" }), false);
});

test("an imported product is hidden from shoppers, whatever Zoho says about the item", () => {
  const row = zohoItemAsHiddenProduct(ekadantha, "VENDOR-001", "Shami");
  assert.equal(shownOnStorefront({ status: row.status, active: row.active, vendorId: row.vendor_id }), false);
  // Zoho's "active" status later sets active = true on the product. Pending must still hide it.
  assert.equal(shownOnStorefront({ status: row.status, active: true, vendorId: row.vendor_id }), false);
});

test("the product carries Zoho's price, MRP, GST, HSN and SKU", () => {
  const { id, payload } = zohoItemAsHiddenProduct(ekadantha, "VENDOR-001", "Shami");
  assert.equal(id, "ZI-3579709000003476321");
  assert.equal(payload.price, 171.43);
  assert.equal(payload.mrp, 180);
  assert.equal(payload.gst, 5);
  assert.equal(payload.hsn, "15081000");
  assert.equal(payload.sku, "SBV-OI-1023");
  assert.equal(payload.purchasePrice, 123.81);
  assert.equal(payload.stock, 0);
});

test("no MRP in Zoho falls back to the price, never to zero", () => {
  const { payload } = zohoItemAsHiddenProduct({ ...ekadantha, label_rate: "" }, "VENDOR-001", "Shami");
  assert.equal(payload.mrp, 171.43);
});

test("negative stock in Zoho never reaches the website as negative", () => {
  const { payload } = zohoItemAsHiddenProduct({ ...ekadantha, available_for_sale_stock: -3 }, "VENDOR-001", "Shami");
  assert.equal(payload.stock, 0);
});

test("GST prefers the within-state rate, and a missing rate reads as zero", () => {
  assert.equal(zohoItemGstPercent({ item_tax_preferences: [{ tax_specification: "inter", tax_percentage: 18 }, { tax_specification: "intra", tax_percentage: 5 }] }), 5);
  assert.equal(zohoItemGstPercent({ tax_percentage: 12 }), 12);
  assert.equal(zohoItemGstPercent({}), 0);
});

test("a missing SKU gets one in the website's style", () => {
  assert.equal(zohoItemSku({ ...ekadantha, sku: "" }, "Oil"), "SBV-OI-03476321");
  assert.equal(zohoItemSku({ ...ekadantha, sku: "" }, "Uncategorized"), "SBV-GN-03476321");
  assert.equal(zohoItemSku({ ...ekadantha, sku: "" }, "4"), "SBV-GN-03476321");
  assert.equal(zohoItemSku(ekadantha, "Oil"), "SBV-OI-1023");
});

test("only an imported product still pending is left alone in Zoho", () => {
  assert.equal(awaitingImportApproval("pending", { zohoImported: true }), true);
  assert.equal(awaitingImportApproval("approved", { zohoImported: true }), false);
  assert.equal(awaitingImportApproval("rejected", { zohoImported: true }), false);
  assert.equal(awaitingImportApproval("pending", {}), false);
  assert.equal(awaitingImportApproval("pending", null), false);
});

// Zoho's "Sugar S1", made on 27 Jun 2026, before new items came in by themselves (read live 6 Nov 2026).
const sugarS1 = {
  item_id: "3579709000000834002", name: "Sugar S1", status: "active", can_be_sold: true, product_type: "goods",
  rate: 2752, purchase_rate: 2491.226, label_rate: "", sku: "", unit: "pcs", hsn_or_sac: "17011490",
  created_time: "2026-06-27T13:48:14+0530", available_stock: 0, stock_on_hand: 0,
};

test("an older item stays out by itself but an admin can bring it in", () => {
  assert.equal(zohoItemImportable(sugarS1), false);
  assert.equal(zohoItemSaleProblem(sugarS1), null);
});

test("an admin can't bring in what Zoho won't sell", () => {
  assert.match(zohoItemSaleProblem({ ...sugarS1, status: "inactive" })!, /^Inactive in Zoho/);
  assert.match(zohoItemSaleProblem({ ...sugarS1, can_be_sold: false })!, /not for sale/);
  assert.match(zohoItemSaleProblem({ ...sugarS1, product_type: "service" })!, /service/);
  assert.match(zohoItemSaleProblem({ ...sugarS1, rate: "" })!, /no selling price/);
  assert.match(zohoItemSaleProblem({ ...sugarS1, name: " " })!, /without a name/);
});

test("the same checks still decide what comes in by itself", () => {
  assert.equal(zohoItemImportable({ ...ekadantha, status: "inactive" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, can_be_sold: false }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, product_type: "service" }), false);
  assert.equal(zohoItemImportable({ ...ekadantha, rate: -1 }), false);
});

test("the not-on-website list leaves out linked items and says what blocks the rest", () => {
  const items = [
    sugarS1,
    { ...ekadantha },
    { item_id: "3579709000000042119", name: "Sugar", status: "active", can_be_sold: true, product_type: "goods", rate: 4062, sku: "", unit: "qtl", created_time: "2026-03-04T12:59:01+0530", stock_on_hand: 0 },
    { item_id: "3579709000000858197", name: "payviaUPI", status: "inactive", can_be_sold: true, product_type: "goods", rate: 0, sku: "", created_time: "2026-06-28T18:12:19+0530" },
    { item_id: "999", name: "Copy of Belgaum", status: "active", can_be_sold: true, product_type: "goods", rate: 2700, sku: "SBV-SU-2EE9B743", created_time: "2026-11-05T10:00:00+0530" },
  ];
  const rows = zohoItemsNotOnWebsite(items, new Set(["3579709000003476321"]), new Set(["sbv-su-2ee9b743"]));
  assert.deepEqual(rows.map((row) => row.name), ["Sugar", "Sugar S1", "Copy of Belgaum", "payviaUPI"]);
  assert.equal(rows.find((row) => row.name === "Sugar S1")!.problem, null);
  assert.equal(rows.find((row) => row.name === "Sugar S1")!.rate, 2752);
  assert.match(rows.find((row) => row.name === "Copy of Belgaum")!.problem!, /already uses this SKU/);
  assert.match(rows.find((row) => row.name === "payviaUPI")!.problem!, /^Inactive in Zoho/);
  assert.equal(rows.find((row) => row.name === "payviaUPI")!.active, false);
});

test("an older item brought in by hand still comes in hidden, waiting for approval", () => {
  const row = zohoItemAsHiddenProduct(sugarS1, "VENDOR-001", "Shami Business Ventures");
  assert.equal(row.id, "ZI-3579709000000834002");
  assert.equal(row.status, "pending");
  assert.equal(row.active, false);
  assert.equal(row.payload.price, 2752);
  assert.equal(row.payload.sku, "SBV-GN-00834002");
  assert.equal(awaitingImportApproval(row.status, row.payload), true);
  assert.equal(shownOnStorefront({ status: row.status, active: row.active, vendorId: row.vendor_id }), false);
});

test("every reason an item can't come in reads in Kannada", async () => {
  const { kn } = await import("../src/lib/i18n-kn.ts");
  const reasons = [
    zohoItemSaleProblem({ ...sugarS1, name: "" }), zohoItemSaleProblem({ ...sugarS1, status: "inactive" }),
    zohoItemSaleProblem({ ...sugarS1, can_be_sold: false }), zohoItemSaleProblem({ ...sugarS1, product_type: "service" }),
    zohoItemSaleProblem({ ...sugarS1, rate: "" }), "A website product already uses this SKU",
  ];
  for (const reason of reasons) assert.ok(reason && kn[reason], `missing Kannada for "${reason}"`);
  assert.ok(kn["Made in Zoho on {0}"]?.includes("{0}"));
});
