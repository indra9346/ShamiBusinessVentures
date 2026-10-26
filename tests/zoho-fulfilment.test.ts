import { test } from "node:test";
import assert from "node:assert/strict";
import { nextZohoFulfilmentStep, zohoFulfilmentStatus, zohoPackagesOf, zohoStatusMovesForward } from "../src/lib/zoho-sync-core.ts";

const pkg = (over: Partial<{ packageId: string; status: string; shipmentId: string; shipmentStatus: string }> = {}) =>
  ({ packageId: "P1", status: "not_shipped", shipmentId: "", shipmentStatus: "", ...over });

test("website Packed creates a Zoho package once", () => {
  assert.deepEqual(nextZohoFulfilmentStep("Packed", []), { step: "package" });
  assert.equal(nextZohoFulfilmentStep("Packed", [pkg()]), null);
});

test("website Dispatched / Out for Delivery creates the package, then its shipment", () => {
  for (const status of ["Dispatched", "Out for Delivery"]) {
    assert.deepEqual(nextZohoFulfilmentStep(status, []), { step: "package" });
    assert.deepEqual(nextZohoFulfilmentStep(status, [pkg()]), { step: "shipment", packageId: "P1" });
    assert.equal(nextZohoFulfilmentStep(status, [pkg({ status: "shipped", shipmentId: "S1", shipmentStatus: "shipped" })]), null);
  }
});

test("website Delivered goes package -> shipment -> delivered, then stops", () => {
  assert.deepEqual(nextZohoFulfilmentStep("Delivered", []), { step: "package" });
  assert.deepEqual(nextZohoFulfilmentStep("Delivered", [pkg()]), { step: "shipment", packageId: "P1" });
  assert.deepEqual(nextZohoFulfilmentStep("Delivered", [pkg({ status: "shipped", shipmentId: "S1", shipmentStatus: "shipped" })]), { step: "delivered", shipmentId: "S1" });
  assert.equal(nextZohoFulfilmentStep("Delivered", [pkg({ status: "delivered", shipmentId: "S1", shipmentStatus: "delivered" })]), null);
});

test("nothing is pushed before packing, or for cancelled orders", () => {
  for (const status of ["Placed", "Awaiting Payment", "Payment Confirmed", "Accepted", "Cancelled"])
    assert.equal(nextZohoFulfilmentStep(status, []), null, status);
});

test("Zoho packages and shipments are read from the sales order (void packages ignored)", () => {
  const packages = zohoPackagesOf({ packages: [
    { package_id: "P1", status: "shipped", shipment_order: { shipment_id: "S1", status: "shipped" } },
    { package_id: "P2", status: "void" },
    { package_id: "P3", status: "not_shipped" },
  ] });
  assert.deepEqual(packages, [
    { packageId: "P1", status: "shipped", shipmentId: "S1", shipmentStatus: "shipped" },
    { packageId: "P3", status: "not_shipped", shipmentId: "", shipmentStatus: "" },
  ]);
  assert.deepEqual(zohoPackagesOf({}), []);
});

test("Zoho progress maps to the website status", () => {
  assert.equal(zohoFulfilmentStatus([]), null);
  assert.equal(zohoFulfilmentStatus([pkg()]), "Packed");
  assert.equal(zohoFulfilmentStatus([pkg({ status: "shipped", shipmentId: "S1", shipmentStatus: "shipped" })]), "Dispatched");
  assert.equal(zohoFulfilmentStatus([pkg({ status: "delivered", shipmentId: "S1", shipmentStatus: "delivered" })]), "Delivered");
  assert.equal(zohoFulfilmentStatus([], "shipped"), "Dispatched");
});

test("a Zoho status only moves the website order forward", () => {
  assert.equal(zohoStatusMovesForward("Payment Confirmed", "Packed"), true);
  assert.equal(zohoStatusMovesForward("Packed", "Dispatched"), true);
  assert.equal(zohoStatusMovesForward("Out for Delivery", "Dispatched"), false);
  assert.equal(zohoStatusMovesForward("Dispatched", "Packed"), false);
  assert.equal(zohoStatusMovesForward("Delivered", "Delivered"), false);
  assert.equal(zohoStatusMovesForward("Cancelled", "Delivered"), false);
});
