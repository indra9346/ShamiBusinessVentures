import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ZOHO_COMMERCE_SCOPES, ZOHO_CORE_SCOPES, zohoCommerceModeFrom, zohoOAuthScopes,
} from "../src/lib/zoho-commerce-mode.ts";

// The permission line before the Zoho Commerce switch (10 Nov 2026), word for word.
const BEFORE =
  "ZohoCommerce.items.READ,ZohoCommerce.items.CREATE,ZohoCommerce.items.UPDATE,ZohoCommerce.coupons.READ,ZohoCommerce.coupons.CREATE,ZohoCommerce.coupons.UPDATE,ZohoCommerce.salesorders.READ,ZohoCommerce.salesorders.CREATE,ZohoCommerce.salesorders.UPDATE,ZohoCommerce.settings.READ,ZohoCommerce.settings.UPDATE,ZohoCommerce.sitesIndex.READ,ZohoCommerce.webhooks.READ,ZohoCommerce.webhooks.CREATE,ZohoInventory.contacts.READ,ZohoInventory.contacts.CREATE,ZohoInventory.contacts.UPDATE,ZohoInventory.items.READ,ZohoInventory.items.CREATE,ZohoInventory.items.UPDATE,ZohoInventory.salesorders.READ,ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE,ZohoInventory.inventoryadjustments.READ,ZohoInventory.inventoryadjustments.CREATE,ZohoInventory.settings.READ,ZohoInventory.settings.UPDATE,ZohoBooks.salesorders.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.customerpayments.READ,ZohoBooks.customerpayments.CREATE,ZohoBooks.customerpayments.DELETE,ZohoInventory.packages.READ,ZohoInventory.packages.CREATE,ZohoInventory.shipmentorders.READ,ZohoInventory.shipmentorders.CREATE,ZohoInventory.shipmentorders.UPDATE,ZohoInventory.purchaseorders.READ,ZohoInventory.purchaseorders.CREATE,ZohoInventory.bills.READ,ZohoBooks.invoices.UPDATE,ZohoBooks.banking.READ";

test("no setting, a damaged one or anything but an explicit false means Zoho Commerce is in use", () => {
  for (const value of [undefined, null, "off", [], {}, { inUse: "false" }, { inUse: 0 }, { inUse: true }])
    assert.equal(zohoCommerceModeFrom(value).inUse, true, JSON.stringify(value));
  assert.deepEqual(zohoCommerceModeFrom({ inUse: false, changedAt: "2026-11-10T09:00:00.000Z" }), { inUse: false, changedAt: "2026-11-10T09:00:00.000Z" });
  assert.equal(zohoCommerceModeFrom({ inUse: false, changedAt: 5 }).changedAt, null);
});

test("with Zoho Commerce in use the permission line is the old one plus the Books sales order update and transfer orders", () => {
  // Transfer orders (10 Nov 2026): a bill unloaded at another godown, a batch sent to other godowns.
  assert.equal(zohoOAuthScopes(true),
    `${BEFORE},ZohoBooks.salesorders.UPDATE,ZohoInventory.transferorders.READ,ZohoInventory.transferorders.CREATE,ZohoInventory.transferorders.UPDATE`);
});

test("with Zoho Commerce off no Zoho Commerce permission is asked for, and every other one still is", () => {
  const off = zohoOAuthScopes(false).split(",");
  assert.equal(off.some((scope) => scope.startsWith("ZohoCommerce.")), false);
  for (const scope of BEFORE.split(",").filter((s) => !s.startsWith("ZohoCommerce."))) assert.ok(off.includes(scope), scope);
  assert.ok(off.includes("ZohoBooks.salesorders.UPDATE"));
  assert.equal(new Set(off).size, off.length, "no permission twice");
  assert.equal(ZOHO_COMMERCE_SCOPES.every((s) => s.startsWith("ZohoCommerce.")), true);
  assert.equal(ZOHO_CORE_SCOPES.some((s) => s.startsWith("ZohoCommerce.")), false);
});

test("every Zoho Commerce call in the Zoho functions sits behind the switch", () => {
  const source = readFileSync(new URL("../src/lib/zoho-commerce.functions.ts", import.meta.url), "utf8");
  // Split the file into its top-level functions / server functions and check each one that calls Commerce.
  const blocks = source.split(/\n(?=(?:export )?(?:async function|function|const) )/);
  const callsCommerce = (block: string) => /\bcommerceRequest(?:<[^>]*>)?\(|REGIONS\[region\]\[1\]|"\/store\/api\/v1|syncZohoCoupons\(/.test(block);
  const offenders = blocks
    .filter((block) => callsCommerce(block))
    .map((block) => block.slice(0, block.indexOf("(")).replace(/^(export )?(async )?(function|const) /, "").replace(/<.*$/, "").trim())
    // The helpers themselves, and the coupon import that only syncZohoProducts (checked) runs.
    .filter((name) => !["commerceRequest", "fetchZohoPages", "syncZohoCoupons", "REGIONS"].includes(name))
    .filter((name) => {
      const block = blocks.find((b) => b.slice(0, b.indexOf("(")).includes(name)) ?? "";
      return !/zohoCommerceInUse\(/.test(block);
    });
  assert.deepEqual(offenders, []);
  // syncZohoCoupons is only ever run from syncZohoProducts.
  assert.equal(source.match(/syncZohoCoupons\(/g)?.length, 2);
});
