import { test } from "node:test";
import assert from "node:assert/strict";
import { callsByPurpose, describeZohoCall, mergeZohoCalls, type ZohoCall } from "../src/lib/zoho-call-log.ts";

test("Zoho call: API and endpoint with record IDs taken out; token requests are not API calls", () => {
  assert.deepEqual(describeZohoCall("https://www.zohoapis.in/inventory/v1/salesorders/3579709000003272013?organization_id=1"), { api: "Inventory", endpoint: "salesorders/:id" });
  assert.deepEqual(describeZohoCall("https://www.zohoapis.in/inventory/v1/items?organization_id=1&page=2"), { api: "Inventory", endpoint: "items" });
  assert.deepEqual(describeZohoCall("https://www.zohoapis.in/books/v3/invoices/3579709000003228051/status/void?organization_id=1"), { api: "Books", endpoint: "invoices/:id/status/void" });
  assert.deepEqual(describeZohoCall("https://commerce.zoho.in/store/api/v1/salesorders/3579709000003272013"), { api: "Commerce", endpoint: "salesorders/:id" });
  assert.equal(describeZohoCall("https://accounts.zoho.in/oauth/v2/token"), null);
  assert.equal(describeZohoCall("https://ppziinqjxqpxpmudinfd.supabase.co/storage/v1/object/public/x.png"), null);
  assert.equal(describeZohoCall("not a url"), null);
});

test("call log: per India day, per hour, per purpose and endpoint, last 7 days kept", () => {
  const call = (at: string, purpose: string, endpoint = "salesorders", ok = true): ZohoCall => ({ at, purpose, api: "Inventory", method: "GET", endpoint, ok });
  let log = mergeZohoCalls(null, [
    call("2026-10-27T04:35:00Z", "Hourly check: orders"), // 10:05 IST
    call("2026-10-27T04:36:00Z", "Hourly check: orders"),
    call("2026-10-27T04:37:00Z", "Hourly check: orders", "salesorders/:id", false),
    call("2026-10-27T05:40:00Z", "Website → Zoho: order", "salesorders"), // 11:10 IST
    call("2026-10-26T18:40:00Z", "Hourly check: products", "items"), // 00:10 IST on the 27th
  ]);
  const day = log.days["2026-10-27"]!;
  assert.equal(day.total, 5);
  assert.equal(day.errors, 1);
  assert.equal(day.hours[10], 3);
  assert.equal(day.hours[11], 1);
  assert.equal(day.hours[0], 1);
  assert.equal(day.rows["Hourly check: orders|Inventory|GET|salesorders"]!.count, 2);
  assert.equal(day.rows["Hourly check: orders|Inventory|GET|salesorders/:id"]!.errors, 1);
  assert.deepEqual(callsByPurpose(day)[0], { purpose: "Hourly check: orders", count: 3, errors: 1 });

  // Merging again adds to the same rows; older days drop off after 7.
  log = mergeZohoCalls(log, [call("2026-10-27T06:00:00Z", "Hourly check: orders")]);
  assert.equal(log.days["2026-10-27"]!.rows["Hourly check: orders|Inventory|GET|salesorders"]!.count, 3);
  for (let d = 1; d <= 8; d += 1) log = mergeZohoCalls(log, [call(`2026-11-0${Math.min(d, 9)}T06:00:00Z`.replace("11-09", "11-09"), "x")]);
  assert.equal(Object.keys(log.days).length, 7);
  assert.equal(log.days["2026-10-27"], undefined);
});
