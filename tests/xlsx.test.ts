import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 as nodeCrc32 } from "node:zlib";
import { buildXlsx, crc32, safeSheetNames } from "../src/lib/xlsx.ts";

/** Reads the stored entries of a zip (no compression), checking each CRC. */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  return files;
}

test("crc32 matches zlib", () => {
  const data = new TextEncoder().encode("Grain Bazar ₹2,700 · Challakere");
  assert.equal(crc32(data), nodeCrc32(data));
});

test("sheet names follow Excel's rules and stay unique", () => {
  assert.deepEqual(safeSheetNames(["Summary", "Grain Bazar Challakere Godown / Main", "summary", "x".repeat(40)]),
    ["Summary", "Grain Bazar Challakere Godown M", "summary 2", "x".repeat(31)]);
});

test("workbook: one sheet per entry, numbers as numbers, text escaped, bold rows", () => {
  const files = readZip(buildXlsx([
    { name: "Summary", rows: [["Godown", "Sales (₹)"], ["A & B <Hubli>", 2700.5], ["Total", 2700.5]], boldRows: [0, 2], widths: [30, 12] },
    { name: "Challakere", rows: [["Order", "Qty"], ["CLK-577522-271026-111004", 1]] },
  ]));
  assert.ok(files.has("[Content_Types].xml") && files.has("xl/workbook.xml") && files.has("xl/styles.xml"));
  assert.match(files.get("xl/workbook.xml")!, /<sheet name="Summary" sheetId="1" r:id="rId1"\/><sheet name="Challakere" sheetId="2" r:id="rId2"\/>/);
  const sheet1 = files.get("xl/worksheets/sheet1.xml")!;
  assert.match(sheet1, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">A &amp; B &lt;Hubli&gt;<\/t><\/is><\/c>/);
  assert.match(sheet1, /<c r="B2" s="2"><v>2700.5<\/v><\/c>/); // number, 2 decimals
  assert.match(sheet1, /<c r="B3" s="3"><v>2700.5<\/v><\/c>/); // bold total
  assert.match(sheet1, /<col min="1" max="1" width="30" customWidth="1"\/>/);
  assert.match(files.get("xl/worksheets/sheet2.xml")!, /<c r="B2"><v>1<\/v><\/c>/);
});
