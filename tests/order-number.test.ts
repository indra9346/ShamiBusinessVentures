import { test } from "node:test";
import assert from "node:assert/strict";
import { orderNumberIn, parseOrderNumber } from "../src/lib/order-number.ts";

test("a godown order number reads back as godown, PIN and India time", () => {
  const parts = parseOrderNumber("CLK-577522-261026-143215");
  assert.deepEqual(parts && { ...parts, placedAt: parts.placedAt.toISOString() },
    { godown: "CLK", pin: "577522", placedAt: "2026-10-26T09:02:15.000Z", sequence: 1 });
  assert.equal(parseOrderNumber("HBL-580020-271026-001500-2")?.sequence, 2);
  assert.equal(parseOrderNumber("HBL-580020-271026-001500-2")?.placedAt.toISOString(), "2026-10-26T18:45:00.000Z");
});

test("old ORD- numbers and junk are not godown numbers", () => {
  assert.equal(parseOrderNumber("ORD-26102615297"), null);
  assert.equal(parseOrderNumber("CLK-57752-261026-143215"), null);
  assert.equal(parseOrderNumber(""), null);
});

test("notifications find both new and old order numbers", () => {
  assert.equal(orderNumberIn("Order CLK-577522-261026-143215 is now Packed."), "CLK-577522-261026-143215");
  assert.equal(orderNumberIn("Invoice CLKINV2610260358 for order HBL-580020-261026-090501-3 was issued."), "HBL-580020-261026-090501-3");
  assert.equal(orderNumberIn("Order ORD-25649 is now Accepted."), "ORD-25649");
  assert.equal(orderNumberIn("Invoice CLKINV2610260358 issued."), undefined);
});
