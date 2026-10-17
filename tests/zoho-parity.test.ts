import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  cleanEmailList,
  newOrderEmail,
  reconcileCatalog,
  reconcileCustomers,
  verifyZohoSignature,
  zohoSignatureBaseString,
  type AppProductForParity,
  type ZohoItemForParity,
} from "../src/lib/zoho-sync-core.ts";

// Zoho Books Help > Webhooks > "Validate Webhooks", example 1 (Default Payload).
test("signature base string: Zoho's default-payload example", () => {
  const body = '{"created_date":"2019-03-06","event_id":"5675"}';
  assert.equal(
    zohoSignatureBaseString([["subscription_id", "90343"], ["name", "basic"]], body, "application/json;charset=UTF-8"),
    'namebasicsubscription_id90343{"created_date":"2019-03-06","event_id":"5675"}',
  );
});

// Example 2 (x-www-form-urlencoded): pairs merged with the query, sorted, decoded, spaces kept.
test("signature base string: Zoho's form example", () => {
  assert.equal(
    zohoSignatureBaseString(
      [["customer_name", "Brandon"], ["status", "active"]],
      "addon_description=Monthly%20addon&quantity=1",
      "application/x-www-form-urlencoded",
    ),
    "addon_descriptionMonthly addoncustomer_nameBrandonquantity1statusactive",
  );
});

test("signature base string: no query + JSON is just the raw body (what live calls use)", () => {
  assert.equal(zohoSignatureBaseString([], '{"salesorder":{}}', "application/json"), '{"salesorder":{}}');
});

test("signature check covers query parameters, base64 and hex", async () => {
  const secret = "testsecret12345";
  const body = '{"salesorder":{"salesorder_id":"9"}}';
  const signed = 'keyabc' + body;
  const b64 = createHmac("sha256", secret).update(signed).digest("base64");
  const hex = createHmac("sha256", secret).update(signed).digest("hex");
  const opts = { query: [["key", "abc"]] as Array<[string, string]>, contentType: "application/json" };
  assert.equal(await verifyZohoSignature(body, b64, secret, opts), "base64");
  assert.equal(await verifyZohoSignature(body, hex, secret, opts), "hex");
  // Without the query parameter the signed string differs, so it must not verify.
  assert.equal(await verifyZohoSignature(body, b64, secret), null);
});

const product = (id: string, extra: Partial<AppProductForParity> = {}): AppProductForParity => ({
  id, name: `Product ${id}`, sku: `SKU-${id}`, price: 100, stock: 10, active: true, ...extra,
});
const item = (id: string, extra: Partial<ZohoItemForParity> = {}): ZohoItemForParity => ({
  item_id: `z${id}`, sku: `SKU-${id}`, name: `Product ${id}`, rate: 100, available: 10, status: "active", ...extra,
});

test("catalog parity: classifies every case", () => {
  const links = new Map([["1", "z1"], ["2", "z2"], ["3", "z3"], ["4", "z4"], ["5", "z5"], ["6", "z6"], ["8", "zMissing"]]);
  const report = reconcileCatalog(
    [product("1"), product("2"), product("3"), product("4"), product("5"), product("6", { stock: 5 }), product("7"), product("8")],
    links,
    [
      item("1"),
      item("2", { sku: "OTHER" }),
      item("3", { rate: 120 }),
      item("4", { available: 7 }),
      item("5", { status: "inactive" }),
      item("6", { available: null }), // stock not read: not compared
      item("99"), // Zoho-only item
    ],
  );
  const issues = (id: string) => report.issues.filter((row) => row.productId === id).map((row) => row.issue);
  assert.equal(report.checked, 8);
  assert.equal(report.inSync, 2); // 1 and 6
  assert.deepEqual(issues("1"), []);
  assert.deepEqual(issues("2"), ["sku_mismatch"]);
  assert.deepEqual(issues("3"), ["price_mismatch"]);
  assert.deepEqual(issues("4"), ["stock_mismatch"]);
  assert.deepEqual(issues("5"), ["inactive_in_zoho"]);
  assert.deepEqual(issues("6"), []);
  assert.deepEqual(issues("7"), ["not_linked"]);
  assert.deepEqual(issues("8"), ["missing_in_zoho"]);
  assert.equal(report.zohoOnly, 1);
});

test("customer parity: only customers with orders need a link; missing contacts flagged", () => {
  const report = reconcileCustomers(
    [
      { id: "a", name: "A", hasOrders: true },
      { id: "b", name: "B", hasOrders: true },
      { id: "c", name: "C", hasOrders: false },
      { id: "d", name: "D", hasOrders: true },
    ],
    new Map([["a", "za"], ["d", "zGone"]]),
    new Set(["za"]),
  );
  assert.equal(report.linked, 2);
  assert.equal(report.notLinkedNoOrders, 1);
  assert.deepEqual(report.issues.map((row) => [row.userId, row.issue]), [["b", "not_linked_with_orders"], ["d", "contact_missing_in_zoho"]]);
  // Contact list not readable: existence is not judged.
  assert.equal(reconcileCustomers([{ id: "d", name: "D", hasOrders: true }], new Map([["d", "zGone"]]), null).issues.length, 0);
});

test("email list: valid, lower-cased, de-duplicated, capped", () => {
  assert.deepEqual(cleanEmailList([" Owner@Example.com ", "owner@example.com", "bad", "x@y", "two@shop.in"]), ["owner@example.com", "two@shop.in"]);
  assert.equal(cleanEmailList(Array.from({ length: 9 }, (_, i) => `u${i}@a.in`)).length, 5);
});

test("new order email: subject and body carry the order basics", () => {
  const email = newOrderEmail({ number: "GB-ORD-1", customer: "Kumar", total: 2518.95, delivery: "Pickup" });
  assert.equal(email.subject, "New Grain Bazar order GB-ORD-1");
  assert.match(email.body, /GB-ORD-1/);
  assert.match(email.body, /2518\.95/);
  assert.match(email.body, /Kumar/);
});

test("catalog parity: two products with one SKU are flagged, not compared", () => {
  const report = reconcileCatalog(
    [product("1", { sku: "DUP-1" }), product("2", { sku: "dup-1 " }), product("3")],
    new Map([["1", "z1"], ["2", "z1"], ["3", "z3"]]),
    [item("1", { sku: "DUP-1" }), item("3")],
  );
  assert.deepEqual(report.issues.map((row) => [row.productId, row.issue]), [["1", "duplicate_sku"], ["2", "duplicate_sku"]]);
  assert.equal(report.inSync, 1);
});
