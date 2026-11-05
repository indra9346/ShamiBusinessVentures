import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awaitingImportApproval,
  zohoItemAsHiddenProduct,
  zohoItemGstPercent,
  zohoItemImportable,
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
