import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeFromHash, handedOverWarning, paperLink, paperName, qrCaption, readScannedText, SCAN_RESULT_LABELS, scanIsRefusal, scannedPaperLabel, scanWords,
  type PaperScan, type PaperScanResult,
} from "../src/lib/delivery-papers.ts";
import type { DeliveryGateCode } from "../src/lib/delivery-notes.ts";

/* The answers come from the database (tests/db/delivery-paper-qr.db-test.mjs). These tests hold the words to them. */
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261110120000_delivery_paper_qr.sql", import.meta.url), "utf8");
const CODE = "Ab3_-xYz0123456789AbCd";

const scan = (result: PaperScanResult, over: Partial<PaperScan> = {}): PaperScan => ({
  result, action: "check", scan_id: 1, scanned_at: "2026-11-10T05:02:15Z", by: "Ravi", role: "staff", godown: "Challakere Godown",
  paper: { doc: "slip", slip_line: 2, slips: 3, copy_no: 1, printed_at: "2026-11-10T04:00:00Z", latest_copy: 1, latest_printed_at: "2026-11-10T04:00:00Z", latest_printed_by: "Office Admin" },
  note: { note_no: "DN-000001", order_no: "GB-1", invoice_number: "CLKINV-1", customer: "TEST Traders", godown: "Challakere Godown", shipping_method: "Standard", generated_at: "2026-11-10T03:00:00Z" },
  lines: [{ line: 2, name: "TEST Rice 25 kg", qty: 2, pack_size: "25 kg", stock_no: "", handover: null }],
  handed_now: [],
  gate: { code: "paid", source: "last_reading", stop_reason: null, items_changed: false, invoice_changed: false, invoice_number: "CLKINV-1", zoho_void: false },
  ...over,
});
const gate = (code: DeliveryGateCode, over: Partial<NonNullable<PaperScan["gate"]>> = {}) =>
  ({ code, source: "zoho_now" as const, stop_reason: null, items_changed: false, invoice_changed: false, invoice_number: "CLKINV-1", zoho_void: false, ...over });

test("every answer the database can give has its own words, and only a recorded handover is green", () => {
  const listed = MIGRATION.match(/result text NOT NULL CHECK \(result IN \(([^)]+)\)\)/)![1]!.match(/'([a-z_]+)'/g)!.map((value) => value.slice(1, -1));
  const assigned = [...MIGRATION.matchAll(/result := '([a-z_]+)'/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(assigned)].sort(), [...listed].filter((value) => value !== "unknown").sort(), "the function gives every listed answer but unknown in its main branch");
  assert.ok(MIGRATION.includes("'unknown', _actor"), "unknown codes are kept");
  const headlines = new Set<string>();
  for (const result of listed) {
    const words = scanWords(scan(result as PaperScanResult));
    assert.ok(words.headline && words.lines.length > 0, result);
    headlines.add(words.headline);
    assert.equal(words.tone === "green", result === "handed_over", `${result} is ${words.tone}`);
    assert.ok(SCAN_RESULT_LABELS[result as PaperScanResult], `${result} has a history label`);
  }
  assert.equal(headlines.size, listed.length, "each answer reads differently");
});

test("an answer nobody planned for is red, never green", () => {
  assert.equal(scanWords(scan("something_new" as PaperScanResult)).tone, "red");
  assert.equal(scanIsRefusal("something_new"), true);
});

test("ready is genuine but not green: the goods wait for the recorded handover", () => {
  const words = scanWords(scan("ready"));
  assert.equal(words.tone, "ready");
  assert.match(words.headline, /Genuine · not handed over yet/);
  assert.ok(words.lines.some((line) => /only when the screen turns green/.test(line)));
  assert.match(words.lines[0]!, /Slip 2 of 3 of DN-000001, newest copy \(copy 1\)/);
});

test("green says who recorded it and when, and that the paper is now spent", () => {
  const words = scanWords(scan("handed_over", { action: "handover", handed_now: [2], gate: gate("paid") }));
  assert.equal(words.tone, "green");
  assert.match(words.headline, /Hand over the goods/);
  assert.match(words.lines[0]!, /10 Nov 2026, 10:32:15 AM IST by Ravi, Challakere Godown/);
  assert.ok(words.lines.some((line) => /can't be used again/.test(line)));
  assert.ok(!words.lines.some((line) => /last reading/.test(line)), "Zoho was read");
  const fallback = scanWords(scan("handed_over", { handed_now: [2], gate: gate("paid", { source: "last_reading" }) }));
  assert.ok(fallback.lines.some((line) => /Zoho Books could not be read just now/.test(line)));
});

test("a note handed over in parts says which items went before", () => {
  const lines = [
    { line: 1, name: "TEST Oil", qty: 4, pack_size: "1 L", stock_no: "", handover: { at: "2026-11-10T04:30:00Z", by: "Suma", role: "staff" as const, godown: "Challakere Godown" } },
    { line: 2, name: "TEST Rice", qty: 2, pack_size: "25 kg", stock_no: "", handover: { at: "2026-11-10T05:02:15Z", by: "Ravi", role: "staff" as const, godown: "Challakere Godown" } },
  ];
  const words = scanWords(scan("handed_over", { paper: { ...scan("ready").paper!, doc: "note", slip_line: null }, lines, handed_now: [2] }));
  assert.ok(words.lines.some((line) => /Before this: Item 1 \(TEST Oil\): handed over 10 Nov 2026, 10:00:00 AM IST by Suma/.test(line)), words.lines.join("\n"));
});

test("already handed over is red and names who, when and where; your own handover says so", () => {
  const handover = { at: "2026-11-10T05:02:15Z", by: "Suma", role: "staff" as const, godown: "Challakere Godown" };
  const words = scanWords(scan("already_handed_over", { lines: [{ ...scan("ready").lines![0]!, handover }] }));
  assert.equal(words.tone, "red");
  assert.match(words.headline, /Already handed over · do not give again/);
  assert.match(words.lines[0]!, /Handed over 10 Nov 2026, 10:32:15 AM IST by Suma, Challakere Godown/);
  assert.ok(words.lines.some((line) => /duplicate/.test(line)));
  assert.ok(!words.lines.some((line) => /yourself/.test(line)));
  const mine = scanWords(scan("already_handed_over", { lines: [{ ...scan("ready").lines![0]!, handover: { ...handover, by: "Ravi" } }] }));
  assert.equal(mine.tone, "red");
  assert.ok(mine.lines.some((line) => /You recorded this handover yourself/.test(line)));
  const office = scanWords(scan("already_handed_over", { lines: [{ ...scan("ready").lines![0]!, handover: { ...handover, by: "Office Admin", role: "admin", godown: "" } }] }));
  assert.match(office.lines[0]!, /by Office Admin \(office\)/);
  const old = scanWords(scan("already_handed_over", { paper: { ...scan("ready").paper!, copy_no: 1, latest_copy: 3 }, lines: [{ ...scan("ready").lines![0]!, handover }] }));
  assert.ok(old.lines.some((line) => /also an old copy \(copy 1 of 3\)/.test(line)));
});

test("an old copy is red and says which copy replaced it", () => {
  const words = scanWords(scan("replaced", { paper: { ...scan("ready").paper!, copy_no: 1, latest_copy: 2, latest_printed_at: "2026-11-10T06:00:00Z", latest_printed_by: "Office Admin" } }));
  assert.equal(words.tone, "red");
  assert.match(words.headline, /Old copy · cancelled/);
  assert.match(words.lines[0]!, /copy 1 of slip 2 of 3 on DN-000001\. Copy 2 was printed 10 Nov 2026, 11:30:00 AM IST by Office Admin/);
});

test("order problems: cancelled, refunded, stopped and void are red; record problems are amber", () => {
  for (const code of ["cancelled", "refunded", "stopped", "payment_expired", "return_refunded", "unpaid", "partly_paid"] as DeliveryGateCode[]) {
    const words = scanWords(scan("order_problem", { gate: gate(code) }));
    assert.equal(words.tone, "red", code);
    assert.match(words.headline, /Do not hand over/);
  }
  assert.ok(scanWords(scan("order_problem", { gate: gate("cancelled") })).lines.includes("ORDER CANCELLED. DO NOT DELIVER."));
  const stopped = scanWords(scan("order_problem", { gate: gate("stopped", { stop_reason: "Refund asked" }) }));
  assert.ok(stopped.lines.includes("Reason given: Refund asked"));
  for (const code of ["zoho_behind", "no_invoice", "zoho_unreadable", "records_disagree"] as DeliveryGateCode[]) {
    assert.equal(scanWords(scan("order_problem", { gate: gate(code) })).tone, "amber", code);
  }
  const voided = scanWords(scan("order_problem", { gate: gate("paid", { zoho_void: true }) }));
  assert.equal(voided.tone, "red");
  assert.equal(voided.lines[0], "ORDER IS VOID IN ZOHO BOOKS. DO NOT DELIVER.");
  const changed = scanWords(scan("order_problem", { gate: gate("paid", { items_changed: true }) }));
  assert.equal(changed.tone, "amber");
  assert.ok(changed.lines.some((line) => /ORDER ITEMS CHANGED/.test(line)));
  assert.ok(!changed.lines.some((line) => /^PAYMENT/.test(line)), "paid is not called a payment problem");
});

test("another godown's paper is amber and names both godowns", () => {
  const words = scanWords(scan("other_godown", { godown: "Hubli Godown" }));
  assert.equal(words.tone, "amber");
  assert.match(words.lines[0]!, /for Challakere Godown\. You are signed in at Hubli Godown/);
});

test("an unknown code is red and gives nothing away", () => {
  const words = scanWords({ result: "unknown", action: "check", scan_id: 9, scanned_at: "2026-11-10T05:00:00Z", by: "Ravi", role: "staff", godown: "Challakere Godown" });
  assert.equal(words.tone, "red");
  assert.match(words.headline, /Not a genuine paper/);
  assert.ok(words.lines.some((line) => /forged/.test(line)));
});

test("the QR is a link to this site's scan page with the code after #", () => {
  assert.equal(paperLink("https://grainbazar.com/", CODE), `https://grainbazar.com/slip#${CODE}`);
  assert.deepEqual(readScannedText(paperLink("https://grainbazar.com", CODE), "grainbazar.com"), { code: CODE });
  assert.equal(codeFromHash(`#${CODE}`), CODE);
  assert.equal(codeFromHash("#ORD-1"), "");
  assert.equal(codeFromHash(""), "");
});

test("reading a scanned QR: only our scan page or a bare code; a link elsewhere is called out", () => {
  assert.deepEqual(readScannedText(`https://www.grainbazar.com/slip#${CODE}`, "grainbazar.com"), { code: CODE }, "printed on www, scanned without");
  assert.deepEqual(readScannedText(`https://grainbazar.com/slip/#${CODE}`, "www.grainbazar.com"), { code: CODE });
  assert.deepEqual(readScannedText(`http://localhost:5236/slip#${CODE}`, "localhost:5236"), { code: CODE });
  assert.deepEqual(readScannedText(`  ${CODE}\n`, "grainbazar.com"), { code: CODE });
  assert.deepEqual(readScannedText(`https://grainbazar-check.com/slip#${CODE}`, "grainbazar.com"), { problem: "other_site", host: "grainbazar-check.com" });
  assert.deepEqual(readScannedText(`https://grainbazar.com.evil.in/slip#${CODE}`, "grainbazar.com"), { problem: "other_site", host: "grainbazar.com.evil.in" });
  assert.deepEqual(readScannedText(`http://localhost:5236/slip#${CODE}`, "grainbazar.com"), { problem: "other_site", host: "localhost:5236" });
  assert.deepEqual(readScannedText(`http://localhost:5999/slip#${CODE}`, "localhost:5236"), { problem: "other_site", host: "localhost:5999" });
  for (const text of [`https://grainbazar.com/shop#${CODE}`, `https://grainbazar.com/slip?c=${CODE}`, "https://grainbazar.com/slip#short", `javascript:alert(1)//${CODE}`, "upi://pay?pa=x@y", "GB-ORD-1", "DN-000001", ""]) {
    assert.deepEqual(readScannedText(text, "grainbazar.com"), { problem: "not_a_paper" }, text);
  }
});

test("the paper says which copy it is, that earlier copies are cancelled, and that it works once", () => {
  assert.equal(qrCaption(1), "Godown: scan before handing over. Works once.");
  assert.equal(qrCaption(2), "Copy 2: copy 1 is cancelled. Godown: scan before handing over. Works once.");
  assert.equal(qrCaption(3), "Copy 3: copies 1 to 2 are cancelled. Godown: scan before handing over. Works once.");
  assert.match(handedOverWarning({ at: "2026-11-10T05:02:15Z", by: "Ravi", role: "staff", godown: "Challakere Godown" }), /^ALREADY HANDED OVER 10 NOV 2026, 10:32:15 AM IST BY RAVI\. FOR RECORDS ONLY\. DO NOT DELIVER AGAIN\.$/);
  assert.equal(handedOverWarning(null), "");
});

test("names and history labels", () => {
  assert.equal(paperName(scan("ready").paper), "Slip 2 of 3");
  assert.equal(paperName({ ...scan("ready").paper!, doc: "note", slip_line: null }), "Delivery note");
  assert.equal(scannedPaperLabel({ doc: "slip", slip_line: 2, copy_no: 3, code_hint: "abc" }), "Slip 2, copy 3");
  assert.equal(scannedPaperLabel({ doc: null, slip_line: null, copy_no: null, code_hint: "1a2b3c4d5e6f" }), "Unknown code 1a2b3c");
  assert.equal(scanIsRefusal("ready"), false);
  assert.equal(scanIsRefusal("handed_over"), false);
  assert.equal(scanIsRefusal("replaced"), true);
});

test("the code is never stored: the migration keeps only sha256 hashes", () => {
  assert.match(MIGRATION, /code_hash text NOT NULL UNIQUE CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  const inserts = [...MIGRATION.matchAll(/INSERT INTO public\.delivery_paper_codes[^;]+;/g)].map((match) => match[0]);
  assert.equal(inserts.length, 2);
  for (const insert of inserts) assert.match(insert, /private\.delivery_code_hash\((note_code|paper_code)\)/);
  assert.match(MIGRATION, /UNIQUE \(note_id, slip_line\)/, "one handover per item line");
  assert.match(MIGRATION, /FROM public\.delivery_notes WHERE id = c\.note_id FOR NO KEY UPDATE/, "the scan locks the note");
});
