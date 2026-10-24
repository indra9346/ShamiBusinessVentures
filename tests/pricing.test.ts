import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLotTotals, rateForPackPrice, type PriceLotInput } from "../src/lib/pricing.ts";

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

// The rate shown beside a pack price ("₹5,234.25/QTL") must match the sheet, not 2 x the rounded bag price.
test("per-QTL rate for the Hubli bag price is the sheet's 5,234.25", () => {
  assert.equal(rateForPackPrice(2617.13, 0.5), 5234.25);
});

test("per-QTL / per-litre rates of the live prices stay as they were", () => {
  assert.equal(rateForPackPrice(2399, 0.5), 4798);
  assert.equal(rateForPackPrice(2650, 0.5), 5300);
  assert.equal(rateForPackPrice(615, 0.05), 12300);
  assert.equal(rateForPackPrice(2049, 15), 136.6);
  assert.equal(rateForPackPrice(949, 5), 189.8);
  assert.equal(rateForPackPrice(142, 1), 142);
});

test("every sheet row's selling price per QTL comes back from its bag price", () => {
  for (const [bag, qntl] of [[3192.5, 6385], [3371, 6742], [2423.75, 4847.5], [2617.13, 5234.25]]) {
    assert.equal(rateForPackPrice(bag, 0.5), qntl);
  }
});

// Packs up to one rate unit can always be matched exactly; bigger packs (a 15 L tin per litre)
// sometimes cannot (₹1,000 / 15 L), and then the nearest rate is shown.
test("the shown rate reproduces the exact pack price whenever one can", () => {
  for (let paise = 100000; paise < 100400; paise += 7) {
    for (const per of [0.25, 0.5, 0.05, 15, 1, 0.3]) {
      const rate = rateForPackPrice(paise / 100, per);
      if (per <= 1) assert.equal(Math.round(Math.round(rate * 100) * per + 1e-7), paise, `${paise / 100} at ${per}`);
      else assert.ok(Math.abs(rate * 100 * per - paise) <= per / 2 + 1e-6, `${paise / 100} at ${per}`);
    }
  }
});
