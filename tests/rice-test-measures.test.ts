import { test } from "node:test";
import assert from "node:assert/strict";
import { glazingChoices, NO_MEASURE_FILTER, parseMoisture, testMatchesMeasures } from "../src/lib/rice-samples.ts";

const reading = (moisture_percent: number | null, glazing = "") => ({ moisture_percent, glazing });

test("moisture: blank is allowed, and only 0 to 100 counts", () => {
  assert.equal(parseMoisture(""), null);
  assert.equal(parseMoisture(" 12.5 "), 12.5);
  assert.equal(parseMoisture("0"), 0);
  assert.equal(parseMoisture("101"), "bad");
  assert.equal(parseMoisture("-1"), "bad");
  assert.equal(parseMoisture("wet"), "bad");
});

test("no filter shows every sample, tested or not", () => {
  assert.equal(testMatchesMeasures(null, NO_MEASURE_FILTER), true);
  assert.equal(testMatchesMeasures(reading(null), NO_MEASURE_FILTER), true);
});

test("moisture range includes both ends, and zero is a real reading", () => {
  const range = { ...NO_MEASURE_FILTER, moistureFrom: "10", moistureTo: "14" };
  assert.equal(testMatchesMeasures(reading(10), range), true);
  assert.equal(testMatchesMeasures(reading(14), range), true);
  assert.equal(testMatchesMeasures(reading(14.01), range), false);
  assert.equal(testMatchesMeasures(reading(9.99), range), false);
  assert.equal(testMatchesMeasures(reading(0), { ...NO_MEASURE_FILTER, moistureTo: "5" }), true);
});

test("a sample with no reading doesn't match a filter that asks for one", () => {
  assert.equal(testMatchesMeasures(reading(null), { ...NO_MEASURE_FILTER, moistureTo: "14" }), false);
  assert.equal(testMatchesMeasures(null, { ...NO_MEASURE_FILTER, glazing: "Silky" }), false);
});

test("glazing matches whatever the capitals, and both filters must hold", () => {
  const filter = { ...NO_MEASURE_FILTER, moistureTo: "14", glazing: "silky" };
  assert.equal(testMatchesMeasures(reading(12, " Silky "), filter), true);
  assert.equal(testMatchesMeasures(reading(15, "Silky"), filter), false);
  assert.equal(testMatchesMeasures(reading(12, "Double"), filter), false);
});

test("glazing choices are unique, sorted, and skip blanks", () => {
  assert.deepEqual(glazingChoices([{ glazing: "silky" }, { glazing: "Double" }, { glazing: "SILKY" }, { glazing: " " }]), ["Double", "silky"]);
});
