import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOUSE_SELLER_NAME, HOUSE_SELLER_ID, houseSellerName, sellerChoices } from "../src/lib/house-seller.ts";

test("the company is always the first seller, even with no vendor account at all", () => {
  assert.deepEqual(sellerChoices([], []), [{ id: HOUSE_SELLER_ID, business: DEFAULT_HOUSE_SELLER_NAME }]);
});

test("the company's name comes from its products, then the default", () => {
  const products = [
    { vendorId: "zoho:60066526172", vendor: "Zoho Commerce" },
    { vendorId: HOUSE_SELLER_ID, vendor: "  Shami Business Ventures Private Limited " },
  ];
  assert.equal(houseSellerName(products), "Shami Business Ventures Private Limited");
  assert.equal(houseSellerName([{ vendorId: HOUSE_SELLER_ID, vendor: " " }]), DEFAULT_HOUSE_SELLER_NAME);
});

test("vendor accounts follow the company, and a login on the company's code is never listed twice", () => {
  const vendors = [
    { id: HOUSE_SELLER_ID, business: "i-developmentworks" },
    { id: "VND-AB12CD34EF", business: "TEST Seller Co" },
    { id: "", business: "No code yet" },
  ];
  assert.deepEqual(sellerChoices(vendors, []), [
    { id: HOUSE_SELLER_ID, business: DEFAULT_HOUSE_SELLER_NAME },
    { id: "VND-AB12CD34EF", business: "TEST Seller Co" },
  ]);
});
