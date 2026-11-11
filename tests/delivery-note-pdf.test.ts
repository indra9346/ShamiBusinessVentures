import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as jspdf from "jspdf";
import {
  buildDeliveryNotePdf, deliveryPdfFileName, pdfSafe, releasedPdfInput, WATERMARK_OPACITY, type DeliveryPdfInput, type TextImageRenderer,
} from "../src/lib/delivery-note-pdf.ts";
import type { ReleasePrint } from "../src/lib/delivery-papers.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// 11 Nov 2026, the owner: a duplicate copy went to the godown and was refused, and the admin "not able to get the
// original one again"; "need both print + download options"; "make that delivery note professional ... with water mark".

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function sample(items = 3) {
  return {
    id: "n1", seq: 1, note_no: "DN-000001", order_no: "CLK-577522-071126-164455", invoice_number: "CLKINV0711260364",
    invoice_total: 2000, order_total: 2000, paid_amount: 2000, generated_at: "2026-11-11T11:58:51Z", generated_by_name: "Indra Kumar",
    snapshot: {
      order_placed_at: "2026-11-07T11:14:55Z", shipping_method: "Standard",
      customer: { name: "Sample Customer", phone: "9000000001", business_name: "Sample Traders", gstin: "29ABCDE1234F1Z5" },
      address: { name: "Sample Customer", phone: "9000000001", line: "12 Market Road", city: "Challakere", state: "Karnataka", pin: "577522" },
      godown: { name: "Challakere Godown", address: "Pavagada Road", city: "Challakere", state: "Karnataka", pincode: "577522" },
      company: { legal_name: "Shami Business Ventures Pvt Ltd", address: "Bengaluru\nKarnataka 560001", gstin: "29AAACS1234A1Z1", phone: "+91 90000 00000" },
      items: Array.from({ length: items }, (_, i) => ({ line: i + 1, order_item_id: `oi${i}`, product_id: `P${i}`, name: `Item ${i + 1} Sona Masuri Rice 25 kg`, sku: `SKU-${i + 1}`, qty: 1 + (i % 3), pack_size: "25 kg bag", stock_no: "" })),
    },
  } as unknown as DeliveryPdfInput["note"];
}

const paperOf = (kind: "original" | "duplicate" | "replacement", n: number | null = null) =>
  ({ kind, duplicate_no: n, ...(kind === "replacement" ? { reason: "duplicate sent by mistake", replaces: { kind: "original", printed_at: "2026-11-11T12:04:05Z", printed_by: "Indra" } } : {}) }) as never;

function input(note: DeliveryPdfInput["note"], kind: "original" | "duplicate" | "replacement", slips: number[], withNote = true): DeliveryPdfInput {
  const paper = paperOf(kind, kind === "duplicate" ? 2 : null);
  return {
    note, state: { code: "paid", allowed: true } as never, selection: { note: withNote, slips },
    record: { printedAt: "2026-11-11T12:10:00Z", noteCode: withNote ? "note-code-1234567890" : null, slipCodes: Object.fromEntries(slips.map((s) => [String(s), `slip-code-${s}`])), notePaper: withNote ? paper : null, slipPapers: Object.fromEntries(slips.map((s) => [String(s), paper])) },
    noteWarnings: [], slipWarnings: {}, origin: "https://grainbazar.com",
  };
}

// The file is compressed, so the tests read each page's drawing commands before compression.
const text = (pdf: { internal: unknown }) => ((pdf.internal as { pages: (string[] | undefined)[] }).pages).flat().filter(Boolean).join("\n");

test("the file is compressed", () => {
  const { pdf } = buildDeliveryNotePdf(input(sample(), "original", [1, 2, 3]), { jspdf, logo: PNG, textImage: null });
  assert.ok(Buffer.from(pdf.output("arraybuffer")).toString("latin1").includes("/FlateDecode"));
});

test("the PDF: a page for the note and one per slip, the paper's kind on each, a footer with its page count", () => {
  const { pdf, fileName } = buildDeliveryNotePdf(input(sample(), "duplicate", [1, 2, 3]), { jspdf, logo: null, textImage: null });
  assert.equal(pdf.getNumberOfPages(), 4);
  const out = text(pdf);
  for (const words of ["GRAIN BAZAR", "DELIVERY NOTE", "DELIVERY SLIP", "DUPLICATE COPY 2", "CLK-577522-071126-164455", "Page 1 of 1", "grainbazar.com"]) assert.ok(out.includes(words), words);
  assert.equal(fileName, "DN-000001_CLK-577522-071126-164455_note-and-slips_duplicate-2.pdf");
});

test("a long note runs onto more pages, each with the table heading and its page number", () => {
  const { pdf } = buildDeliveryNotePdf(input(sample(40), "original", [], true), { jspdf, logo: null, textImage: null });
  assert.ok(pdf.getNumberOfPages() >= 2, `pages: ${pdf.getNumberOfPages()}`);
  const out = text(pdf);
  assert.ok(out.includes(`Page 2 of ${pdf.getNumberOfPages()}`));
  // The PDF keeps "(" as "\(" in its text.
  assert.ok(out.includes("DELIVERY NOTE \\(contd.\\)"), "the heading says it continues");
});

test("Kannada lines are drawn by the browser as pictures; the logo is the letterhead and the watermark", () => {
  const seen: string[] = [];
  const textImage: TextImageRenderer = (words) => { seen.push(words); return { dataUrl: PNG, width: 20, height: 4 }; };
  const { pdf } = buildDeliveryNotePdf(input(sample(1), "replacement", [1]), { jspdf, logo: PNG, textImage });
  assert.ok(seen.some((words) => words.includes("ಬದಲಿ ಮೂಲ ಪ್ರತಿ")), "the replacement stamp in Kannada");
  assert.ok(seen.every((words) => /[^\x00-\xff]/.test(words)), "only text the PDF fonts can't draw");
  assert.ok(text(pdf).includes("REPLACEMENT ORIGINAL"));
});

test("file names and the characters the PDF fonts can't draw", () => {
  const note = sample();
  assert.equal(deliveryPdfFileName(note, input(note, "original", [], true)), "DN-000001_CLK-577522-071126-164455_note_original.pdf");
  assert.equal(deliveryPdfFileName(note, input(note, "replacement", [2], false)), "DN-000001_CLK-577522-071126-164455_slip-2_replacement-original.pdf");
  assert.equal(pdfSafe("A — B ‘x’ ₹130…"), "A - B 'x' Rs 130...");
});

// 12 Nov 2026 (owner, 11 Nov): the papers of a released note, printed from the godown's scan of the invoice QR or by
// the office, carry no QR of their own.
const releasePrint = (note = sample(3)): ReleasePrint => ({
  printed_at: "2026-11-12T05:00:00Z", note_copy: 2, slip_copies: { "1": 1, "3": 4 }, printed_by: "Ravi", printed_role: "incharge",
  note: {
    note_no: note.note_no, order_no: note.order_no, invoice_number: note.invoice_number, snapshot: note.snapshot,
    generated_at: "2026-11-12T04:00:00Z", generated_by_name: "Automatic (payment confirmed)", generated_how: "auto",
  },
});

test("a released note's papers: no QR code, RELEASED, the copy and who printed it, how it was released", () => {
  const released = releasedPdfInput(releasePrint(), { gate: { code: "paid" }, selection: { note: true, slips: [1, 3] }, handovers: {}, origin: "https://grainbazar.com" });
  assert.equal(released.record.noteCode, null);
  const { pdf, fileName } = buildDeliveryNotePdf(released, { jspdf, logo: null, textImage: null });
  assert.equal(pdf.getNumberOfPages(), 3);
  const out = text(pdf);
  for (const words of ["RELEASED", "Delivery note \\(released\\) | Copy 2", "Delivery slip 3 of 3 | Copy 4", "Copy 2 by Ravi \\(godown in-charge\\)", "automatically",
    "Goods are handed over only when the godown scans the QR on the customer's invoice."]) assert.ok(out.includes(words), words);
  for (const gone of ["ORIGINAL", "DUPLICATE", "Godown: scan before handing over", "QR code of the original"]) assert.ok(!out.includes(gone), gone);
  assert.equal(fileName, "DN-000001_CLK-577522-071126-164455_note-and-slips_released.pdf");
});

test("released papers warn of a payment problem and of the items already handed over", () => {
  const handover = { at: "2026-11-12T06:00:00Z", by: "Ravi", role: "incharge" as const, godown: "Challakere Godown" };
  const released = releasedPdfInput(releasePrint(), { gate: { code: "cancelled" }, selection: { note: true, slips: [1] }, handovers: { "1": handover, "2": null }, origin: "" });
  assert.deepEqual(released.noteWarnings, ["ORDER CANCELLED. DO NOT DELIVER.", "ITEM 1 ALREADY HANDED OVER. DELIVER ONLY THE REST."]);
  assert.match(released.slipWarnings["1"]!.at(-1)!, /^ALREADY HANDED OVER 12 NOV 2026, 11:30:00 AM IST BY RAVI\./);
  assert.deepEqual(released.slipWarnings["2"], ["ORDER CANCELLED. DO NOT DELIVER."]);
  const all = releasedPdfInput(releasePrint(sample(1)), { gate: { code: "paid" }, selection: { note: true, slips: [] }, handovers: { "1": handover }, origin: "" });
  assert.deepEqual(all.noteWarnings, ["ALL ITEMS ALREADY HANDED OVER. FOR RECORDS ONLY. DO NOT DELIVER AGAIN."]);
});

test("the GB watermark is a little darker and drawn over each page's content, before the footer", () => {
  assert.ok(WATERMARK_OPACITY > 0.06 && WATERMARK_OPACITY <= 0.1, String(WATERMARK_OPACITY));
  const { pdf } = buildDeliveryNotePdf(input(sample(3), "original", [1]), { jspdf, logo: PNG, textImage: null });
  assert.ok(Buffer.from(pdf.output("arraybuffer")).toString("latin1").includes(`/ca ${WATERMARK_OPACITY}`));
  const pages = (pdf.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  for (let page = 1; page <= pdf.getNumberOfPages(); page += 1) {
    const commands = pages[page]!.join("\n");
    const mark = commands.lastIndexOf(" Do");
    assert.ok(mark > commands.lastIndexOf("Name, signature, date and time"), `page ${page}: the watermark comes after the content`);
    assert.ok(mark < commands.indexOf("Page 1 of 1"), `page ${page}: and before the footer`);
  }
});

test("the office's print page prints the released papers: no QR, no original or duplicate, the GB watermark", () => {
  // 12 Nov 2026 (owner, 11 Nov): the one QR is on the invoice; the office prints the released note and slips.
  const page = readFileSync("src/routes/admin.delivery-note.$orderNo.tsx", "utf8");
  assert.match(page, /press\(pickSelection\(pick, allSlips\), "print"\)/);
  assert.match(page, /press\(pickSelection\(pick, allSlips\), "download"\)/);
  assert.match(page, /printReleasedPapers\(\{ data: \{ orderNo, note: selection\.note, slipLines: selection\.slips \} \}\)/);
  assert.match(page, /buildDeliveryNotePdf\(\s*releasedPdfInput\(print,/);
  assert.match(page, /<Watermark \/>/);
  assert.match(page, /opacity-\[0\.09\]/, "a little darker than the first papers' 6%");
  assert.match(page, /z-20[^"]*mix-blend-multiply/, "laid over the content, so filled rows can't hide it");
  for (const gone of [/Need the original again\?/, /recordDeliveryPrint/, /renderSVG/, /paperLink/, /replacement original/i, /Duplicate copy/]) assert.doesNotMatch(page, gone);
  const panel = readFileSync("src/components/panel/DeliveryNotePanel.tsx", "utf8");
  assert.match(panel, /Print or download/);
  assert.doesNotMatch(panel, /Need the original again\?/);
});

test("every line the print page still shows has its Kannada", () => {
  for (const key of [
    "What to print or download", "Note only", "All slips only", "Download PDF", "Making the PDF…", "Downloaded {0}",
    "The copy was recorded but the PDF could not be made", "Print or download",
  ]) assert.ok(kn[key], key);
});
