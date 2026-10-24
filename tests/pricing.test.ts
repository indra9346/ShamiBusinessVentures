import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLotTotals, type PriceLotInput } from "../src/lib/pricing.ts";

const lot = (over: Partial<PriceLotInput>): PriceLotInput => ({
  price: 0, commission: 0, gstRate: 5, transport: 0, amaliTransport: 0, amaliShami: 0,
  driverTips: 0, unloading: 0, margin: 0, bagKg: 50, ...over,
});

// The four rows of Shami's "Shami Summary" sheet (white inputs -> green results).
test("matches the sheet: 20-08-2026 Inamdar Sugars S1", () => {
  assert.deepEqual(
    priceLotTotals(lot({ price: 5900, transport: 150, amaliTransport: -7, amaliShami: 10, unloading: 7, margin: 30 })),
    { gst: 295, landing: 6355, sellingQntl: 6385, sellingBag: 3192.5 },
  );
});

test("matches the sheet: 21-08-2026 Belgaum Sugars S1", () => {
  assert.deepEqual(
    priceLotTotals(lot({ price: 6240, transport: 150, amaliTransport: -7, amaliShami: 10, unloading: 7, margin: 30 })),
    { gst: 312, landing: 6712, sellingQntl: 6742, sellingBag: 3371 },
  );
});

test("matches the sheet: 26-08-2026 Belgaum Sugars S1 (landing 4,817.50 shown as 4,818)", () => {
  assert.deepEqual(
    priceLotTotals(lot({ price: 4450, transport: 135, amaliTransport: -7, amaliShami: 10, unloading: 7, margin: 30 })),
    { gst: 222.5, landing: 4817.5, sellingQntl: 4847.5, sellingBag: 2423.75 },
  );
});

test("matches the sheet: latest row with commission (Hubli price)", () => {
  assert.deepEqual(
    priceLotTotals(lot({ price: 4880, commission: 5, transport: 100, amaliTransport: -7, unloading: 7, margin: 5 })),
    { gst: 244.25, landing: 5229.25, sellingQntl: 5234.25, sellingBag: 2617.13 },
  );
});

test("blank or invalid inputs count as zero; bag size scales the bag price", () => {
  assert.deepEqual(priceLotTotals(lot({ price: Number.NaN })), { gst: 0, landing: 0, sellingQntl: 0, sellingBag: 0 });
  assert.equal(priceLotTotals(lot({ price: 1000, gstRate: 0, bagKg: 25 })).sellingBag, 250);
});
