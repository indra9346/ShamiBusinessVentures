import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  codeFromHash, handedOverWarning, paperKindWords, paperLink, paperName, paperStamp, personWords, qrCaption, readScannedText, SCAN_RESULT_LABELS, scanIsRefusal,
  scannedPaperLabel, scannedTextWords, scannerLabel, scanWords,
  type PaperScan, type PaperScanResult,
} from "../src/lib/delivery-papers.ts";
import type { DeliveryGateCode } from "../src/lib/delivery-notes.ts";

/* The answers come from the database (tests/db/delivery-paper-qr.db-test.mjs). These tests hold the words to them. */
const MIGRATION = readFileSync(new URL("../supabase/migrations/20261110120000_delivery_paper_qr.sql", import.meta.url), "utf8");
const CODE = "Ab3_-xYz0123456789AbCd";
const KANNADA = /[ಀ-೿]/;

const paper = (over: Partial<NonNullable<PaperScan["paper"]>> = {}): NonNullable<PaperScan["paper"]> => ({
  doc: "slip", slip_line: 2, slips: 3, copy_no: 1, kind: "original", duplicate_no: null, printed_at: "2026-11-10T04:00:00Z", printed_by: "Office Admin",
  original_kind: "original", original_printed_at: "2026-11-10T04:00:00Z", original_printed_by: "Office Admin", replaced_at: null, replaced_by: null, replaced_reason: null,
  ...over,
});
const scan = (result: PaperScanResult, over: Partial<PaperScan> = {}): PaperScan => ({
  result, action: "check", scan_id: 1, scanned_at: "2026-11-10T05:02:15Z", by: "Ravi", role: "staff", godown: "Challakere Godown",
  device: { registered: false, label: "" },
  paper: paper(),
  note: { note_no: "DN-000001", order_no: "GB-1", invoice_number: "CLKINV-1", customer: "TEST Traders", godown: "Challakere Godown", shipping_method: "Standard", generated_at: "2026-11-10T03:00:00Z" },
  lines: [{ line: 2, name: "TEST Rice 25 kg", qty: 2, pack_size: "25 kg", stock_no: "", handover: null }],
  asked: [],
  handed_now: [],
  order_delivered: false,
  gate: { code: "paid", source: "last_reading", stop_reason: null, items_changed: false, invoice_changed: false, invoice_number: "CLKINV-1", zoho_void: false },
  ...over,
});
const gate = (code: DeliveryGateCode, over: Partial<NonNullable<PaperScan["gate"]>> = {}) =>
  ({ code, source: "zoho_now" as const, stop_reason: null, items_changed: false, invoice_changed: false, invoice_number: "CLKINV-1", zoho_void: false, ...over });
const handover = (by: string, at = "2026-11-10T05:02:15Z", role: "staff" | "partner" | "admin" = "staff", godown = "Challakere Godown", registered = false) =>
  ({ at, by, role, godown, registered_phone: registered });
const note3 = (handed: Array<[number, ReturnType<typeof handover> | null]>) => handed.map(([line, item]) => ({ line, name: `Item ${line} name`, qty: line, pack_size: "", stock_no: "", handover: item }));
const en = (words: { lines: Array<{ en: string }> }) => words.lines.map((line) => line.en);

test("every answer the database can give has its own words in both languages, and only a recorded handover is green", () => {
  const listed = MIGRATION.match(/result text NOT NULL CHECK \(result IN \(([^)]+)\)\)/)![1]!.match(/'([a-z_]+)'/g)!.map((value) => value.slice(1, -1));
  const assigned = [...MIGRATION.matchAll(/result := '([a-z_]+)'/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(assigned)].sort(), [...listed].filter((value) => value !== "unknown").sort(), "the function gives every listed answer but unknown in its main branch");
  assert.ok(MIGRATION.includes("'unknown', _actor"), "unknown codes are kept");
  const headlines = new Set<string>();
  for (const result of listed) {
    const words = scanWords(scan(result as PaperScanResult, result === "duplicate" ? { paper: paper({ kind: "duplicate", duplicate_no: 1 }) } : {}));
    assert.ok(words.headline.en && words.lines.length > 0, result);
    assert.match(words.headline.kn, KANNADA, `${result} headline has Kannada`);
    for (const line of words.lines) assert.ok(line.en && line.kn, `${result}: a line without one of its languages`);
    headlines.add(words.headline.en);
    assert.equal(words.tone === "green", result === "handed_over", `${result} is ${words.tone}`);
    assert.ok(SCAN_RESULT_LABELS[result as PaperScanResult], `${result} has a history label`);
  }
  assert.equal(headlines.size, listed.length, "each answer reads differently");
});

test("an answer nobody planned for is red, never green", () => {
  assert.equal(scanWords(scan("something_new" as PaperScanResult)).tone, "red");
  assert.equal(scanIsRefusal("something_new"), true);
});

test("ready is genuine but not green: a slip waits for the button, a note for ticks", () => {
  const words = scanWords(scan("ready"));
  assert.equal(words.tone, "ready");
  assert.equal(words.headline.en, "Genuine · not handed over yet");
  assert.equal(words.headline.kn, "ಅಸಲಿ · ಇನ್ನೂ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ");
  assert.equal(words.lines[0]!.en, "Slip 2 of 3 of DN-000001: the original. Paid in full.");
  assert.ok(en(words).some((line) => /only when the screen turns green/.test(line)));
  const onNote = scanWords(scan("ready", { paper: paper({ doc: "note", slip_line: null }), lines: note3([[1, handover("Suma")], [2, null], [3, null]]) }));
  assert.ok(en(onNote).some((line) => /^Tick the items being handed over/.test(line)));
  assert.ok(en(onNote).some((line) => /^Item 1 \(Item 1 name\): handed over 10 Nov 2026, 10:32:15 AM IST by Suma \(staff, Challakere Godown, own phone\)/.test(line)));
  const replacement = scanWords(scan("ready", { paper: paper({ kind: "replacement" }) }));
  assert.match(replacement.lines[0]!.en, /the replacement original\. Paid in full/);
  assert.match(replacement.lines[0]!.kn, /ಬದಲಿ ಮೂಲ ಪ್ರತಿ/);
});

test("green says what to give, who recorded it, on which phone, and when the order closed", () => {
  const words = scanWords(scan("handed_over", { action: "handover", handed_now: [2], device: { registered: true, label: "CLK phone" }, gate: gate("paid") }));
  assert.equal(words.tone, "green");
  assert.equal(words.headline.en, "Hand over the goods");
  assert.equal(words.headline.kn, "ಸರಕು ಹಸ್ತಾಂತರಿಸಿ");
  assert.equal(words.lines[0]!.en, "Genuine original. Handover recorded 10 Nov 2026, 10:32:15 AM IST by Ravi (staff, Challakere Godown, godown's registered phone).");
  assert.ok(en(words).some((line) => /can't be handed over again on this paper/.test(line)));
  assert.ok(!en(words).some((line) => /Delivered/.test(line)));
  assert.ok(!en(words).some((line) => /last reading/.test(line)), "Zoho was read");
  const closed = scanWords(scan("handed_over", { handed_now: [2], order_delivered: true, gate: gate("paid", { source: "last_reading" }) }));
  assert.ok(en(closed).includes("Everything on DN-000001 is handed over: the order is now marked Delivered."));
  assert.ok(en(closed).some((line) => /Zoho Books could not be read just now/.test(line)));
});

test("a note handed over in parts says what to give now, what went before and what is still to go", () => {
  const words = scanWords(scan("handed_over", {
    role: "partner", by: "Partner CLK",
    paper: paper({ doc: "note", slip_line: null }),
    lines: note3([[1, handover("Suma", "2026-11-10T04:30:00Z")], [2, handover("Partner CLK", "2026-11-10T05:02:15Z", "partner")], [3, null]]),
    handed_now: [2],
  }));
  assert.equal(words.lines[0]!.en, "Give only item 2 now. Recorded 10 Nov 2026, 10:32:15 AM IST by Partner CLK (channel partner, Challakere Godown, own phone).");
  assert.match(words.lines[0]!.kn, /ಈಗ ಸರಕು 2 ಮಾತ್ರ ಕೊಡಿ/);
  assert.ok(en(words).some((line) => /^Before this: Item 1 \(Item 1 name\): handed over 10 Nov 2026, 10:00:00 AM IST by Suma/.test(line)));
  assert.ok(en(words).includes("Still to go: item 3."));
});

test("already handed over is red and names who, as what, when and where; your own handover says so", () => {
  const words = scanWords(scan("already_handed_over", { lines: note3([[2, handover("Suma")]]) }));
  assert.equal(words.tone, "red");
  assert.equal(words.headline.en, "Already handed over · do not give again");
  assert.equal(words.lines[0]!.en, "Handed over 10 Nov 2026, 10:32:15 AM IST by Suma (staff, Challakere Godown, own phone).");
  assert.ok(en(words).some((line) => /it is a duplicate/.test(line)));
  assert.ok(!en(words).some((line) => /yourself/.test(line)));
  assert.ok(en(scanWords(scan("already_handed_over", { lines: note3([[2, handover("Ravi")]]) }))).some((line) => /You recorded this handover yourself/.test(line)));
  const office = scanWords(scan("already_handed_over", { lines: note3([[2, handover("Office Admin", undefined, "admin", "")]]) }));
  assert.match(office.lines[0]!.en, /by Office Admin \(office, own phone\)/);
  const onDuplicate = scanWords(scan("already_handed_over", { paper: paper({ kind: "duplicate", duplicate_no: 3 }), lines: note3([[2, handover("Suma")]]) }));
  assert.ok(en(onDuplicate).includes("This paper is also only duplicate copy 3."));
});

test("a duplicate is red, says which copy, who printed it, and that only the original works", () => {
  const words = scanWords(scan("duplicate", { paper: paper({ kind: "duplicate", duplicate_no: 2, printed_at: "2026-11-10T06:00:00Z", printed_by: "Office Admin" }) }));
  assert.equal(words.tone, "red");
  assert.equal(words.headline.en, "Duplicate copy 2 · do not hand over");
  assert.equal(words.headline.kn, "ನಕಲು ಪ್ರತಿ 2 · ಹಸ್ತಾಂತರಿಸಬೇಡಿ");
  assert.equal(words.lines[0]!.en, "This is duplicate copy 2 of slip 2 of 3 on DN-000001, printed 10 Nov 2026, 11:30:00 AM IST by Office Admin. Only the original hands goods over.");
  assert.ok(en(words).some((line) => /replacement original/.test(line)));
});

test("a replaced original is red and gives the replacement's time, person and reason", () => {
  const words = scanWords(scan("replaced", { paper: paper({ replaced_at: "2026-11-10T06:00:00Z", replaced_by: "Office Admin", replaced_reason: "Jammed in the printer" }) }));
  assert.equal(words.tone, "red");
  assert.equal(words.headline.en, "Original replaced · cancelled");
  assert.equal(words.lines[0]!.en, "This slip 2 of 3 was replaced 10 Nov 2026, 11:30:00 AM IST by Office Admin: Jammed in the printer. Its QR no longer works.");
  assert.match(words.lines[0]!.kn, /Jammed in the printer/);
});

test("ticked items that went meanwhile: amber, nothing recorded, and which ones", () => {
  const words = scanWords(scan("partly_handed_over", {
    paper: paper({ doc: "note", slip_line: null }), asked: [1, 2],
    lines: note3([[1, handover("Suma")], [2, null], [3, null]]),
  }));
  assert.equal(words.tone, "amber");
  assert.match(words.lines[0]!.en, /^Item 1 \(Item 1 name\): handed over/);
  assert.ok(en(words).some((line) => /Nothing was recorded/.test(line)));
});

test("order problems: cancelled, refunded, stopped and void are red; record problems are amber; both languages", () => {
  for (const code of ["cancelled", "refunded", "stopped", "payment_expired", "return_refunded", "unpaid", "partly_paid"] as DeliveryGateCode[]) {
    const words = scanWords(scan("order_problem", { gate: gate(code) }));
    assert.equal(words.tone, "red", code);
    assert.equal(words.headline.en, "Do not hand over");
    for (const line of words.lines) assert.match(line.kn, KANNADA, `${code}: ${line.en}`);
  }
  assert.deepEqual(scanWords(scan("order_problem", { gate: gate("cancelled") })).lines[0], { en: "ORDER CANCELLED. DO NOT DELIVER.", kn: "ಆರ್ಡರ್ ರದ್ದಾಗಿದೆ. ತಲುಪಿಸಬೇಡಿ." });
  assert.ok(en(scanWords(scan("order_problem", { gate: gate("stopped", { stop_reason: "Refund asked" }) }))).includes("Reason given: Refund asked"));
  for (const code of ["zoho_behind", "no_invoice", "zoho_unreadable", "records_disagree"] as DeliveryGateCode[]) {
    assert.equal(scanWords(scan("order_problem", { gate: gate(code) })).tone, "amber", code);
  }
  const voided = scanWords(scan("order_problem", { gate: gate("paid", { zoho_void: true }) }));
  assert.equal(voided.tone, "red");
  assert.equal(voided.lines[0]!.en, "ORDER IS VOID IN ZOHO BOOKS. DO NOT DELIVER.");
  const changed = scanWords(scan("order_problem", { gate: gate("paid", { items_changed: true }) }));
  assert.equal(changed.tone, "amber");
  assert.ok(en(changed).some((line) => /ORDER ITEMS CHANGED/.test(line)));
  assert.ok(!en(changed).some((line) => /^PAYMENT/.test(line)), "paid is not called a payment problem");
});

test("another godown's paper is amber and names both godowns", () => {
  const words = scanWords(scan("other_godown", { godown: "Hubli Godown", role: "partner" }));
  assert.equal(words.tone, "amber");
  assert.equal(words.lines[0]!.en, "This slip 2 of 3 is for Challakere Godown. You are signed in at Hubli Godown.");
});

test("an unknown code is red and gives nothing away", () => {
  const words = scanWords({ result: "unknown", action: "check", scan_id: 9, scanned_at: "2026-11-10T05:00:00Z", by: "Ravi", role: "staff", godown: "Challakere Godown" });
  assert.equal(words.tone, "red");
  assert.equal(words.headline.en, "Not a genuine paper");
  assert.ok(en(words).some((line) => /forged/.test(line)));
  assert.equal(scannedTextWords({ problem: "other_site", host: "grainbazar-check.com" }).tone, "red");
  assert.match(scannedTextWords({ problem: "other_site", host: "grainbazar-check.com" }).lines[0]!.en, /another website \(grainbazar-check\.com\)/);
  assert.equal(scannedTextWords({ problem: "not_a_paper" }).headline.en, "Not a delivery paper QR");
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

test("the paper: an original has no stamp; a duplicate and a replacement are stamped in both languages", () => {
  assert.equal(paperStamp({ kind: "original", duplicate_no: null }), null);
  assert.equal(paperStamp(null), null);
  const duplicate = paperStamp({ kind: "duplicate", duplicate_no: 2 })!;
  assert.deepEqual(duplicate.title, { en: "DUPLICATE COPY 2", kn: "ನಕಲು ಪ್ರತಿ 2" });
  assert.match(duplicate.detail.en, /FOR RECORDS ONLY/);
  assert.match(duplicate.detail.kn, /ದಾಖಲೆಗೆ ಮಾತ್ರ/);
  const replacement = paperStamp({ kind: "replacement", duplicate_no: null, reason: "Print screen cancelled", replaces: { kind: "original", printed_at: "2026-11-10T04:00:00Z", printed_by: "Office Admin" } })!;
  assert.deepEqual(replacement.title, { en: "REPLACEMENT ORIGINAL", kn: "ಬದಲಿ ಮೂಲ ಪ್ರತಿ" });
  assert.equal(replacement.detail.en, "Replaces the original printed 10 Nov 2026, 09:30:00 AM IST, which no longer works. Reason: Print screen cancelled");
  assert.deepEqual(qrCaption("original"), { en: "Godown: scan before handing over. Only this original works, once per item.", kn: "ಗೋದಾಮು: ಹಸ್ತಾಂತರಿಸುವ ಮೊದಲು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ. ಈ ಮೂಲ ಪ್ರತಿ ಮಾತ್ರ, ಪ್ರತಿ ಸರಕಿಗೆ ಒಮ್ಮೆ." });
  assert.match(qrCaption("replacement").en, /Only this replacement original works/);
  assert.deepEqual(qrCaption("duplicate", 1), { en: "Duplicate copy 1: scans red. Records only.", kn: "ನಕಲು ಪ್ರತಿ 1: ಸ್ಕ್ಯಾನ್ ಮಾಡಿದರೆ ಕೆಂಪು. ದಾಖಲೆಗೆ ಮಾತ್ರ." });
  assert.match(handedOverWarning(handover("Ravi")), /^ALREADY HANDED OVER 10 NOV 2026, 10:32:15 AM IST BY RAVI\. FOR RECORDS ONLY\. DO NOT DELIVER AGAIN\.$/);
  assert.equal(handedOverWarning(null), "");
});

test("names, people and history labels", () => {
  assert.deepEqual(paperName(paper()), { en: "Slip 2 of 3", kn: "ಸ್ಲಿಪ್ 2 / 3" });
  assert.equal(paperName(paper({ doc: "note", slip_line: null })).en, "Delivery note");
  assert.deepEqual(paperKindWords("duplicate", 4), { en: "Duplicate copy 4", kn: "ನಕಲು ಪ್ರತಿ 4" });
  assert.equal(paperKindWords("original").en, "Original");
  assert.equal(paperKindWords("replacement").en, "Replacement original");
  assert.deepEqual(personWords("Partner CLK", "partner", "Challakere Godown", true),
    { en: "Partner CLK (channel partner, Challakere Godown, godown's registered phone)", kn: "Partner CLK (ಚಾನೆಲ್ ಪಾಲುದಾರ, Challakere Godown, ಗೋದಾಮಿನ ನೋಂದಾಯಿತ ಫೋನ್)" });
  assert.equal(personWords("Office Admin", "admin", "").en, "Office Admin (office)");
  assert.equal(scannedPaperLabel({ doc: "slip", slip_line: 2, paper_kind: "duplicate", duplicate_no: 3, code_hint: "abc" }), "Slip 2, duplicate copy 3");
  assert.equal(scannedPaperLabel({ doc: "note", slip_line: null, paper_kind: "original", duplicate_no: null, code_hint: "abc" }), "Note, original");
  assert.equal(scannedPaperLabel({ doc: null, slip_line: null, paper_kind: null, duplicate_no: null, code_hint: "1a2b3c4d5e6f" }), "Unknown code 1a2b3c");
  assert.equal(scannerLabel({ actor_name: "Ravi", actor_role: "staff", branch_name: "Challakere Godown", device_registered: true, device_label: "CLK phone" }),
    "Ravi (staff, Challakere Godown, godown's registered phone: CLK phone)");
  assert.equal(scannerLabel({ actor_name: "Hanu", actor_role: "partner", branch_name: "Hubli Godown", device_registered: false, device_label: "" }),
    "Hanu (channel partner, Hubli Godown, own phone)");
  assert.equal(scanIsRefusal("ready"), false);
  assert.equal(scanIsRefusal("handed_over"), false);
  assert.equal(scanIsRefusal("duplicate"), true);
});

test("the migration: hashes only, the first print stays the original, one handover per item and round, the guard's one exception", () => {
  assert.match(MIGRATION, /code_hash text NOT NULL UNIQUE CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  const inserts = [...MIGRATION.matchAll(/INSERT INTO public\.delivery_paper_codes[^;]+;/g)].map((match) => match[0]);
  assert.equal(inserts.length, 1, "papers are filed in one place");
  assert.match(inserts[0]!, /private\.delivery_code_hash\(_code\)/);
  assert.match(MIGRATION, /delivery_paper_codes_original_idx[\s\S]+WHERE kind = 'original'/, "one first original per paper");
  assert.match(MIGRATION, /UNIQUE \(note_id, slip_line, round\)/, "one handover per item and round");
  assert.match(MIGRATION, /FROM public\.delivery_notes WHERE id = c\.note_id FOR NO KEY UPDATE/, "the scan locks the note");
  assert.match(MIGRATION, /DROP FUNCTION IF EXISTS public\.record_delivery_print\(uuid, boolean, integer\[\], jsonb, uuid, text\);/);
  assert.match(MIGRATION, /_replace_reason text DEFAULT NULL/, "the code live before the migration still calls the print");
  const flag = MIGRATION.match(/IF current_setting\('app\.delivery_handover', true\) = 'on'[\s\S]+?END IF;/)![0];
  assert.match(flag, /NEW\.order_status = 'Delivered'/);
  assert.match(flag, /- ARRAY\['order_status','updated_at'\]\) IS NOT DISTINCT FROM/);
  // Placed after the cancelled/expired refusals, so the flag can never reopen those.
  assert.ok(MIGRATION.indexOf("app.delivery_handover', true) = 'on'") > MIGRATION.indexOf("'Cancelled orders cannot be reopened'"));
});
