import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  columnWidthsKey,
  draggedWidth,
  parseSavedWidths,
  tableWidthFor,
} from "../src/lib/column-widths.ts";

test("dragging a header edge widens or narrows the column by the pointer movement", () => {
  assert.equal(draggedWidth(150, 400, 460), 210);
  assert.equal(draggedWidth(150, 400, 370), 120);
});

test("a column never gets narrower than the minimum or wider than the maximum", () => {
  assert.equal(draggedWidth(150, 400, 0), MIN_COLUMN_WIDTH);
  assert.equal(draggedWidth(150, 0, 5000), MAX_COLUMN_WIDTH);
  assert.equal(clampColumnWidth(Number.NaN), MIN_COLUMN_WIDTH);
  assert.equal(clampColumnWidth(120.6), 121);
});

test("saved widths are restored only when they fit the table's columns", () => {
  assert.deepEqual(parseSavedWidths("[120,200,90]", 3), [120, 200, 90]);
  assert.equal(parseSavedWidths("[120,200]", 3), null); // a column was added since
  assert.equal(parseSavedWidths(null, 3), null);
  assert.equal(parseSavedWidths("not json", 3), null);
  assert.equal(parseSavedWidths('["a",1,2]', 3), null);
  assert.equal(parseSavedWidths("[1,-5,2]", 3), null);
  assert.deepEqual(parseSavedWidths("[10,0,5000]", 3), [MIN_COLUMN_WIDTH, 0, MAX_COLUMN_WIDTH]);
});

test("the table grows to the sum of its columns, so widening one never squeezes the others", () => {
  assert.equal(tableWidthFor([120, 200, 90]), 410);
});

test("each table keeps its own widths", () => {
  assert.notEqual(columnWidthsKey("admin-price-lots"), columnWidthsKey("admin-enquiries"));
});
