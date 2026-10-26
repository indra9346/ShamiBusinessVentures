import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenReason, shownOnStorefront, storefrontPatch } from "../src/lib/storefront-visibility.ts";

test("shown only when approved, switched on and not a Zoho copy", () => {
  assert.equal(shownOnStorefront({ status: "approved", active: true, vendorId: "VENDOR-001" }), true);
  assert.equal(shownOnStorefront({ status: "approved", vendorId: "VENDOR-001" }), true);
  assert.equal(shownOnStorefront({ status: "approved", active: false, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "rejected", active: true, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "pending", active: true, vendorId: "VENDOR-001" }), false);
  assert.equal(shownOnStorefront({ status: "approved", active: true, vendorId: "zoho:60066526172" }), false);
});

test("showing a rejected, switched-off product approves it and switches it on", () => {
  // The live case: S1 Sugar Retail Pack 1kg was Rejected + Inactive, and switching Active on alone left it hidden.
  const product = { status: "rejected" as const, active: false, vendorId: "VENDOR-001" };
  const patch = storefrontPatch(product, true);
  assert.deepEqual(patch, { status: "approved", active: true });
  assert.equal(shownOnStorefront({ ...product, ...patch }), true);
  assert.deepEqual(storefrontPatch({ status: "pending", active: true }, true), { status: "approved" });
  assert.equal(storefrontPatch({ status: "approved", active: true }, true), null);
});

test("hiding only switches it off and keeps the approval", () => {
  const product = { status: "approved" as const, active: true, vendorId: "VENDOR-001" };
  const patch = storefrontPatch(product, false);
  assert.deepEqual(patch, { active: false });
  assert.equal(shownOnStorefront({ ...product, ...patch }), false);
  assert.equal(storefrontPatch({ status: "approved", active: false }, false), null);
  // Shown again later: approval was kept, so only the switch changes.
  assert.deepEqual(storefrontPatch({ ...product, ...patch }, true), { active: true });
});

test("the reason a product is hidden", () => {
  assert.equal(hiddenReason({ status: "approved", active: true }), null);
  assert.equal(hiddenReason({ status: "approved", active: false }), "Switched off");
  assert.equal(hiddenReason({ status: "rejected", active: true }), "Rejected");
  assert.equal(hiddenReason({ status: "pending", active: true }), "Awaiting approval");
  assert.equal(hiddenReason({ status: "approved", active: true, vendorId: "zoho:1" }), "Zoho copy");
});
