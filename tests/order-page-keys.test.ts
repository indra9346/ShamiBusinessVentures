import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 11 Nov 2026, the owner: the admin order page showed "Delivery note and slips" again and again. Three panels that
// re-read after a cancel or refund shared the key `${order.status}-${order.payment}`; two of them are siblings, and
// React draws siblings with the same key more than once. Each panel keeps its own key.

test("the admin order page gives every re-reading panel its own key", () => {
  const page = readFileSync("src/routes/admin.orders.$id.tsx", "utf8");
  const keys = [...page.matchAll(/key=\{`([^`]*\$\{order\.[^`]*)`\}/g)].map((m) => m[1]!);
  assert.ok(keys.length >= 3, "the delivery note, payments and Zoho invoice panels re-read after a change");
  assert.equal(new Set(keys).size, keys.length, `keys repeat: ${keys.join(", ")}`);
  for (const key of keys) assert.match(key, /^[a-z][a-z-]*-\$\{/, `a panel key starts with its own name: ${key}`);
});
