import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyIndentLine, filledIndentLines, filterIndents, indentCounts, indentDraftProblem, indentLinesPayload, indentQuantityText,
  indentStatusLabel, indentWorkbook, isOpenIndent, partnerCanCancel, type Indent, type IndentLineDraft,
} from "../src/lib/indents.ts";

const line = (over: Partial<IndentLineDraft> = {}): IndentLineDraft => ({ ...emptyIndentLine(), productName: "Sona Masoori 26 kg", quantity: "40", ...over });
const today = "2026-11-13";

test("a request needs at least one filled line; empty lines are dropped, not refused", () => {
  assert.equal(indentDraftProblem([emptyIndentLine()], "", "", today), "Add at least one product");
  assert.equal(indentDraftProblem([line(), emptyIndentLine()], "", "", today), null);
  assert.equal(filledIndentLines([line(), emptyIndentLine(), line({ productName: "Oil" })]).length, 2);
});

test("each line is checked like the database does", () => {
  assert.equal(indentDraftProblem([line({ productName: " " })], "", "", today), "Line 1: choose or type the product");
  assert.equal(indentDraftProblem([line(), line({ quantity: "" })], "", "", today), "Line 2: enter the quantity");
  assert.equal(indentDraftProblem([line({ quantity: "ten" })], "", "", today), "Line 1: enter the quantity as a number");
  assert.equal(indentDraftProblem([line({ quantity: "0" })], "", "", today), "Line 1: the quantity must be more than 0");
  assert.equal(indentDraftProblem([line({ quantity: "100001" })], "", "", today), "Line 1: the quantity is too large");
  assert.equal(indentDraftProblem([line({ unit: "kg" as never })], "", "", today), "Line 1: choose bags or units");
  assert.equal(indentDraftProblem([line({ remarks: "r".repeat(301) })], "", "", today), "Line 1: keep the remarks under 300 characters");
  assert.equal(indentDraftProblem([line({ grade: "g".repeat(61) })], "", "", today), "Line 1: the grade is too long");
  assert.equal(indentDraftProblem(Array.from({ length: 31 }, () => line()), "", "", today), "At most 30 products in one requirement");
  assert.equal(indentDraftProblem([line()], "n".repeat(1001), "", today), "Keep the notes under 1,000 characters");
});

test("the needed-by date runs from today to a year ahead", () => {
  assert.equal(indentDraftProblem([line()], "", "2026-11-13", today), null);
  assert.equal(indentDraftProblem([line()], "", "2027-11-14", today), null);
  assert.match(indentDraftProblem([line()], "", "2026-11-12", today) ?? "", /needed by/);
  assert.match(indentDraftProblem([line()], "", "2027-11-15", today) ?? "", /needed by/);
});

test("the payload trims text and rounds the quantity to paise-like 2 places", () => {
  assert.deepEqual(indentLinesPayload([line({ productId: "P001", quantity: " 12.345 ", unit: "units", grade: " A1 ", remarks: " same lot " }), emptyIndentLine()]), [
    { product_id: "P001", product_name: "Sona Masoori 26 kg", quantity: 12.35, unit: "units", grade: "A1", remarks: "same lot" },
  ]);
});

test("quantities read naturally", () => {
  assert.equal(indentQuantityText(40, "bags"), "40 bags");
  assert.equal(indentQuantityText(1, "bags"), "1 bag");
  assert.equal(indentQuantityText(1, "units"), "1 unit");
  assert.equal(indentQuantityText(12.5, "units"), "12.5 units");
  assert.equal(indentQuantityText(12.25, "units"), "12.25 units");
});

test("statuses: who can cancel, what is open", () => {
  assert.deepEqual(["new", "seen", "arranged", "cancelled"].map((s) => indentStatusLabel(s)), ["New", "Seen", "Arranged", "Cancelled"]);
  assert.deepEqual((["new", "seen", "arranged", "cancelled"] as const).map(partnerCanCancel), [true, false, false, false]);
  assert.deepEqual((["new", "seen", "arranged", "cancelled"] as const).map(isOpenIndent), [true, true, false, false]);
});

const indent = (over: Partial<Indent>): Indent => ({
  id: "x", indentNo: "IND-261113-0001", branchId: "BR-CLK", godown: "Challakere Godown", partnerName: "Partner A", neededBy: null, notes: "",
  status: "new", statusNote: "", statusChangedAt: null, statusChangedByName: "", createdAt: "2026-11-13T05:00:00Z",
  lines: [{ lineNo: 1, productId: null, productName: "Sona Masoori 26 kg", quantity: 40, unit: "bags", grade: "Steam", remarks: "" }], events: [], ...over,
});
const book = [
  indent({}),
  indent({ indentNo: "IND-261113-0002", status: "seen", lines: [{ lineNo: 1, productId: null, productName: "sona masoori 26 kg ", quantity: 10, unit: "bags", grade: "", remarks: "" }, { lineNo: 2, productId: null, productName: "Sunflower oil 1 L", quantity: 12, unit: "units", grade: "", remarks: "urgent" }] }),
  indent({ indentNo: "IND-261113-0003", branchId: "BR-HBL", godown: "Hubli Godown", partnerName: "Partner H", status: "arranged", notes: "Diwali" }),
  indent({ indentNo: "IND-261113-0004", status: "cancelled" }),
];

test("filters by status, godown and words in any field", () => {
  const ids = (list: Indent[]) => list.map((i) => i.indentNo.slice(-1));
  assert.deepEqual(ids(filterIndents(book, { status: "open", branchId: "all", search: "" })), ["1", "2"]);
  assert.deepEqual(ids(filterIndents(book, { status: "all", branchId: "BR-HBL", search: "" })), ["3"]);
  assert.deepEqual(ids(filterIndents(book, { status: "all", branchId: "all", search: "oil URGENT" })), ["2"]);
  assert.deepEqual(ids(filterIndents(book, { status: "cancelled", branchId: "all", search: "" })), ["4"]);
  assert.deepEqual(indentCounts(book), { new: 1, seen: 1, arranged: 1, cancelled: 1 });
});

test("the Excel book has every line, and open totals per godown and product", () => {
  const [requests, open] = indentWorkbook(book);
  assert.equal(requests!.rows.length, 1 + 5);
  assert.deepEqual(requests!.rows[2]!.slice(0, 1).concat(requests!.rows[2]!.slice(6, 10)), ["IND-261113-0002", 1, "sona masoori 26 kg ", 10, "Bags"]);
  // Open = New and Seen only; the same product typed in another case adds up.
  assert.deepEqual(open!.rows.slice(1), [
    ["Challakere Godown", "Sona Masoori 26 kg", 50, "Bags", "IND-261113-0001, IND-261113-0002"],
    ["Challakere Godown", "Sunflower oil 1 L", 12, "Units", "IND-261113-0002"],
  ]);
});
