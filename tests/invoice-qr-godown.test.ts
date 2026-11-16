import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CUSTOMER_SCAN_WORDS, invoiceScanWords, isInvoiceScan, personWords, releasedFact, releasedHowLabel, releasedPaperWarnings, releasedWords, roleTitle,
  ROLE_TITLES, SCAN_RESULT_LABELS, scanIsRefusal, scannedPaperLabel, scanResultLabel,
  type InvoiceScan, type InvoiceScanResult,
} from "../src/lib/delivery-papers.ts";
import type { DeliveryGateCode } from "../src/lib/delivery-notes.ts";
import { privacyPolicyText } from "../src/lib/privacy-policy.ts";

/*
 * 12 Nov 2026 (owner, 11 Nov): one delivery QR on the invoice, the note released automatically once the payment is
 * confirmed, the godown in-charge scans and hands over, staff and the channel partner do what the admin allows. The
 * answers come from the database (tests/db/invoice-delivery-qr.db-test.mjs); these tests hold the godown's words and
 * the wiring to them.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("supabase/migrations/20261112120000_invoice_delivery_qr.sql");
const KANNADA = /[ಀ-೿]/;

const scan = (result: InvoiceScanResult, over: Partial<InvoiceScan> = {}): InvoiceScan => ({
  kind: "invoice", result, action: "check", scan_id: 1, scanned_at: "2026-11-12T05:02:15Z", by: "Ravi", role: "incharge",
  godown: "Challakere Godown", order_godown: "Challakere Godown", device: { registered: false, label: "" },
  can: { print_note: true, print_slips: true, handover: true },
  invoice: { order_no: "GB-1", generation: 1 },
  released_now: false,
  note: {
    note_no: "DN-000009", order_no: "GB-1", invoice_number: "CLKINV-1", customer: "TEST Traders", phone_end: "0001",
    godown: "Challakere Godown", shipping_method: "Pickup", generated_at: "2026-11-12T04:00:00Z", generated_how: "auto", generated_by_name: "Automatic (payment confirmed)",
  },
  lines: [
    { line: 1, name: "TEST Rice 25 kg", qty: 2, pack_size: "25 kg", stock_no: "", handover: null },
    { line: 2, name: "TEST Dal 30 kg", qty: 1, pack_size: "30 kg", stock_no: "", handover: null },
  ],
  asked: [], handed_now: [], order_delivered: false, print: null,
  gate: { code: "paid", source: "zoho_now", stop_reason: null, items_changed: false, invoice_changed: false, invoice_number: "CLKINV-1", zoho_void: false },
  ...over,
});
const handover = (by: string, role: "incharge" | "staff" | "partner" | "admin" = "incharge") => ({ at: "2026-11-12T05:00:00Z", by, role, godown: "Challakere Godown", registered_phone: false });
const en = (words: { lines: Array<{ en: string }> }) => words.lines.map((line) => line.en);

/** The answers public.delivery_invoice_scan can give, read from the migration. */
function invoiceResults() {
  const body = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.delivery_invoice_scan"), MIGRATION.indexOf("FUNCTION public.delivery_admin_release_print"));
  return [...new Set([...body.matchAll(/result := '([a-z_]+)'/g)].map((match) => match[1]!))].sort();
}

test("every answer to an invoice QR has its own words in both languages, and only a recorded handover is green", () => {
  const results = invoiceResults();
  assert.deepEqual(results, ["already_handed_over", "handed_over", "not_allowed", "not_released", "order_problem", "other_godown", "partly_handed_over", "printed", "released", "replaced"]);
  const headlines = new Set<string>();
  for (const result of results) {
    const words = invoiceScanWords(scan(result as InvoiceScanResult, { handed_now: result === "handed_over" ? [1] : [], action: result === "not_allowed" ? "handover" : "check" }));
    assert.ok(words.headline.en && words.lines.length > 0, result);
    assert.match(words.headline.kn, KANNADA, `${result} headline has Kannada`);
    for (const line of words.lines) assert.ok(line.en && line.kn, `${result}: a line without one of its languages`);
    assert.equal(words.tone === "green", result === "handed_over", `${result} is ${words.tone}`);
    assert.ok(SCAN_RESULT_LABELS[result as InvoiceScanResult], `${result} has a history label`);
    headlines.add(words.headline.en);
  }
  assert.equal(headlines.size, results.length, "each answer reads differently");
  assert.equal(invoiceScanWords(scan("something_new" as InvoiceScanResult)).tone, "red", "an answer nobody planned for is never green");
});

test("released is blue: who the customer is, how the note was released, and what to do next by permission", () => {
  const words = invoiceScanWords(scan("released"));
  assert.equal(words.tone, "ready");
  assert.equal(words.lines[0]!.en, "Delivery note DN-000009 for order GB-1. Paid in full.");
  assert.equal(words.lines[1]!.en, "Released automatically when the payment was confirmed, 12 Nov 2026, 09:30:00 AM IST.");
  assert.ok(en(words).some((line) => /^Tick the items being handed over/.test(line)));
  const viewOnly = invoiceScanWords(scan("released", { role: "partner", can: { print_note: false, print_slips: false, handover: false } }));
  assert.ok(en(viewOnly).includes("Handing over is not switched on for you. The godown in-charge hands these goods over."));
  assert.ok(!en(viewOnly).some((line) => /^Tick the items/.test(line)));
  const now = invoiceScanWords(scan("released", { released_now: true }));
  assert.match(now.lines[1]!.en, /^Released just now by your scan/);
});

test("how a note was released, in both languages", () => {
  const at = "2026-11-12T04:00:00Z";
  assert.deepEqual(releasedWords({ generated_at: at, generated_how: "scan", generated_by_name: "Ravi" }),
    { en: "Released 12 Nov 2026, 09:30:00 AM IST by Ravi's scan of the invoice QR.", kn: "12 Nov 2026, 09:30:00 AM IST ರಂದು Ravi ಇನ್‌ವಾಯ್ಸ್ QR ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ಬಿಡುಗಡೆ ಮಾಡಿದ್ದಾರೆ." });
  assert.equal(releasedWords({ generated_at: at, generated_how: "admin", generated_by_name: "Indra" }).en, "Released 12 Nov 2026, 09:30:00 AM IST by Indra (office).");
  assert.equal(releasedWords({ generated_at: at }).en, "Released 12 Nov 2026, 09:30:00 AM IST by the office (office).");
  assert.equal(releasedFact({ generated_at: at, generated_how: "auto" }), "12 Nov 2026, 09:30:00 AM IST, automatically when the payment was confirmed");
  assert.equal(releasedFact({ generated_at: at, generated_how: "scan", generated_by_name: "Ravi" }), "12 Nov 2026, 09:30:00 AM IST by Ravi (scan of the invoice QR)");
  assert.equal(releasedHowLabel("auto").en, "Automatically (payment confirmed)");
  assert.equal(releasedHowLabel("scan").en, "By the godown in-charge's scan");
  assert.equal(releasedHowLabel("admin", "Indra").en, "By Indra");
  for (const how of ["auto", "scan", "admin"]) assert.match(releasedHowLabel(how).kn, KANNADA);
});

test("green says what to give now, what is still to go, and when the order closed", () => {
  const words = invoiceScanWords(scan("handed_over", {
    action: "handover", handed_now: [1], lines: [
      { line: 1, name: "TEST Rice 25 kg", qty: 2, pack_size: "", stock_no: "", handover: handover("Ravi") },
      { line: 2, name: "TEST Dal 30 kg", qty: 1, pack_size: "", stock_no: "", handover: null },
    ],
  }));
  assert.equal(words.tone, "green");
  assert.equal(words.lines[0]!.en, "Give only item 1 now. Recorded 12 Nov 2026, 10:32:15 AM IST by Ravi (godown in-charge, Challakere Godown, own phone).");
  assert.ok(en(words).includes("Still to go: item 2."));
  assert.ok(en(words).includes("These items can't be handed over again on this invoice."));
  const closed = invoiceScanWords(scan("handed_over", { handed_now: [1, 2], order_delivered: true, lines: [], gate: { ...scan("released").gate!, source: "last_reading" } }));
  assert.ok(en(closed).includes("Everything on DN-000009 is handed over: the order is now marked Delivered."));
  assert.ok(en(closed).some((line) => /Zoho Books could not be read just now/.test(line)));
});

test("printed lists the copies recorded and says printing hands nothing over", () => {
  const print = {
    printed_at: "2026-11-12T05:10:00Z", note_copy: 2, slip_copies: { "2": 1, "1": 3 }, printed_by: "Ravi", printed_role: "incharge" as const,
    note: { note_no: "DN-000009", order_no: "GB-1", invoice_number: "CLKINV-1", snapshot: {} as never, generated_at: "2026-11-12T04:00:00Z", generated_by_name: "", generated_how: "auto" },
  };
  const words = invoiceScanWords(scan("printed", { action: "print_slips", print }));
  assert.equal(words.tone, "ready");
  assert.equal(words.lines[0]!.en, "Delivery note DN-000009: copy 2, recorded 12 Nov 2026, 10:40:00 AM IST by Ravi (godown in-charge, Challakere Godown, own phone).");
  assert.match(words.lines[1]!.en, /^Slips 1 \(copy 3\), 2 \(copy 1\): recorded/);
  assert.ok(en(words).some((line) => /^Printing does not hand anything over/.test(line)));
});

test("refusals: not released, not allowed, already handed over, another godown, a replaced QR, an order problem", () => {
  const waiting = invoiceScanWords(scan("not_released", { role: "staff", note: null, lines: [] }));
  assert.equal(waiting.tone, "amber");
  assert.ok(en(waiting).includes("The godown in-charge's scan or the office releases it."));
  const unpaid = invoiceScanWords(scan("not_released", { note: null, lines: [], gate: { ...scan("released").gate!, code: "partly_paid" } }));
  assert.ok(en(unpaid).includes("NOT FULLY PAID. DO NOT DELIVER."));
  const zohoDown = invoiceScanWords(scan("not_released", { note: null, lines: [], gate: { ...scan("released").gate!, source: "last_reading" } }));
  assert.ok(en(zohoDown).some((line) => /Scan again in a minute/.test(line)));

  const refused = invoiceScanWords(scan("not_allowed", { role: "partner", action: "print_note" }));
  assert.equal(refused.tone, "amber");
  assert.equal(refused.lines[0]!.en, "Printing the delivery note is switched off for the channel partner.");
  assert.match(refused.lines[0]!.kn, /ಚಾನೆಲ್ ಪಾಲುದಾರ/);
  assert.equal(invoiceScanWords(scan("not_allowed", { role: "staff", action: "handover" })).lines[0]!.en, "Handing over goods is switched off for the staff.");

  const again = invoiceScanWords(scan("already_handed_over", { lines: [{ line: 1, name: "Rice", qty: 1, pack_size: "", stock_no: "", handover: handover("Suma", "staff") }] }));
  assert.equal(again.tone, "red");
  assert.match(again.lines[0]!.en, /^Item 1 \(Rice\): handed over 12 Nov 2026, 10:30:00 AM IST by Suma \(staff, Challakere Godown, own phone\)/);

  const elsewhere = invoiceScanWords(scan("other_godown", { godown: "Hubli Godown", note: null, lines: [] }));
  assert.equal(elsewhere.tone, "amber");
  assert.equal(elsewhere.lines[0]!.en, "Order GB-1 is for Challakere Godown. You are signed in at Hubli Godown.");

  const replaced = invoiceScanWords(scan("replaced", { note: null, invoice: { order_no: "GB-1", generation: 1, revoked_at: "2026-11-12T06:00:00Z", revoked_by: "Indra", revoke_reason: "Invoice lost" } }));
  assert.equal(replaced.tone, "red");
  assert.equal(replaced.lines[0]!.en, "This QR on the invoice of order GB-1 was replaced 12 Nov 2026, 11:30:00 AM IST by Indra: Invoice lost. It no longer works.");
  assert.ok(en(replaced).some((line) => /downloads the invoice again/.test(line)));

  for (const code of ["cancelled", "refunded", "stopped"] as DeliveryGateCode[]) {
    assert.equal(invoiceScanWords(scan("order_problem", { gate: { ...scan("released").gate!, code } })).tone, "red", code);
  }
  assert.equal(invoiceScanWords(scan("order_problem", { gate: { ...scan("released").gate!, items_changed: true } })).tone, "amber");
});

test("roles, labels and the customer's own scan", () => {
  assert.deepEqual(ROLE_TITLES.incharge, { en: "Godown in-charge", kn: "ಗೋದಾಮು ಉಸ್ತುವಾರಿ" });
  assert.deepEqual([roleTitle("admin").en, roleTitle("staff").en, roleTitle("partner").en], ["Admin", "Godown staff", "Channel partner"]);
  assert.equal(personWords("Ravi", "incharge", "Challakere Godown", true).en, "Ravi (godown in-charge, Challakere Godown, godown's registered phone)");
  assert.equal(scannedPaperLabel({ doc: "invoice", slip_line: null, paper_kind: null, duplicate_no: null, code_hint: "abc" }), "Invoice QR");
  for (const result of ["released", "printed", "handed_over", "ready"]) assert.equal(scanIsRefusal(result), false, result);
  for (const result of ["not_released", "not_allowed", "replaced", "other_godown", "unknown"]) assert.equal(scanIsRefusal(result), true, result);
  assert.equal(scanResultLabel("not_released"), "Refused: note not released yet");
  assert.equal(isInvoiceScan(scan("released")), true);
  assert.equal(isInvoiceScan({ result: "ready" }), false);
  assert.equal(CUSTOMER_SCAN_WORDS.en, "Show this QR at the godown counter; the godown in-charge scans it.");
  assert.match(CUSTOMER_SCAN_WORDS.kn, KANNADA);
});

test("the papers' warnings name the items already handed over", () => {
  const out = releasedPaperWarnings(["PAYMENT REFUNDED. DO NOT DELIVER."], [1, 2, 3], { "2": handover("Ravi"), "3": handover("Ravi") });
  assert.deepEqual(out.noteWarnings, ["PAYMENT REFUNDED. DO NOT DELIVER.", "ITEMS 2, 3 ALREADY HANDED OVER. DELIVER ONLY THE REST."]);
  assert.deepEqual(out.slipWarnings["1"], ["PAYMENT REFUNDED. DO NOT DELIVER."]);
  assert.equal(out.slipWarnings["2"]!.length, 2);
  assert.deepEqual(releasedPaperWarnings([], [1], {}).noteWarnings, []);
});

test("the server: an invoice code first, then the printed papers; one Zoho push; the office's print; the automatic release", () => {
  const server = read("src/lib/delivery-notes.functions.ts");
  const handler = server.slice(server.indexOf("export const scanDeliveryPaper"), server.indexOf("export const reopenDeliveryHandover"));
  assert.ok(handler.indexOf('db.rpc("delivery_invoice_order_no"') < handler.indexOf('db.rpc("delivery_invoice_scan"'));
  assert.ok(handler.indexOf('db.rpc("delivery_invoice_scan"') < handler.indexOf('db.rpc("delivery_paper_scan"'), "the old papers keep their own scan");
  assert.match(handler, /action: z\.enum\(\["check", "handover", "print_note", "print_slips"\]\)\.optional\(\)|\.validator\(scanInput\)/);
  assert.match(server, /handover: z\.boolean\(\)\.optional\(\)/, "old callers still send handover");
  assert.match(handler, /const action = data\.action \?\? \(data\.handover \? "handover" : "check"\);/);
  // A look reads Zoho only when it may release the note; a handover or print always does.
  assert.match(handler, /if \(action !== "check" \|\| release\) zoho = await zohoReading\(orderNo\)/);
  assert.equal([...server.matchAll(/pushOrderToZohoFromServer\(/g)].length, 1);
  const print = server.slice(server.indexOf("export const printReleasedPapers"), server.indexOf("export async function raiseDeliveryNoteAutomatically"));
  assert.match(print, /await ensureAdmin\(context\.supabase, context\.userId\);/);
  assert.match(print, /db\.rpc\("delivery_admin_release_print", \{\s*_order_no: data\.orderNo, _note: data\.note, _slip_lines: data\.slipLines, _zoho: zoho, _actor: context\.userId,/);
  const raise = server.slice(server.indexOf("export async function raiseDeliveryNoteAutomatically"), server.indexOf("/** An administrator, an active godown employee"));
  assert.match(raise, /db\.rpc\("issue_delivery_note_auto", \{ _order_no: orderNo, _zoho: zoho, _how: "auto" \}\)/);
  assert.ok(raise.indexOf('from("delivery_notes")') < raise.indexOf("zohoReading("), "an order with its note costs no Zoho read");
  assert.match(raise, /\} catch \(cause\) \{[\s\S]*return \{ issued: false/, "never throws into the Zoho sync");

  const zoho = read("src/lib/zoho-commerce.functions.ts");
  assert.doesNotMatch(zoho, /^import[^;]*delivery-notes\.functions/m, "loaded only when needed: no import cycle");
  assert.match(zoho, /await import\("@\/lib\/delivery-notes\.functions"\)/);
  const sync = zoho.slice(zoho.indexOf("await syncZohoOrderInvoice(db, region"), zoho.indexOf("// Packed / Dispatched / Out for Delivery / Delivered on the website"));
  assert.match(sync, /if \(!moneyIssues\.review\.length && !moneyIssues\.retry\.length && order\.payment_status === "Paid"\) await releaseDeliveryNoteAfterInvoice\(order\.order_no\);/);
  const hook = zoho.slice(zoho.indexOf("async function releaseDeliveryNoteAfterInvoice"), zoho.indexOf("type InvoiceRow ="));
  assert.match(hook, /try \{[\s\S]*\} catch \(cause\) \{\s*console\.warn/);
});

test("the screens: the scan shows the buttons by permission and makes the PDF; the admin's switches and the in-charge", () => {
  const slip = read("src/routes/slip.tsx");
  assert.match(slip, /supabase\.rpc\("my_delivery_role"\)/);
  assert.match(slip, /invoice\.can\?\.print_note && \(/);
  assert.match(slip, /invoice\.can\?\.print_slips && \(/);
  assert.match(slip, /invoice\.can\?\.handover && TICKABLE\.includes\(invoice\.result\)/);
  assert.match(slip, /run\(code, "print_note"\)/);
  assert.match(slip, /run\(code, "print_slips"\)/);
  assert.match(slip, /run\(code, "handover", sortedTicks\)/);
  assert.match(slip, /releasedPdfInput\(print, \{/);
  assert.match(slip, /pdf\.save\(fileName\)/);
  assert.match(slip, /CUSTOMER_SCAN_WORDS/);
  // The PDF kit is loaded before the print is recorded, so a recorded copy always gets its file.
  assert.ok(slip.indexOf('import("jspdf")') < slip.indexOf("await scanDeliveryPaper("));

  const rules = read("src/routes/admin.delivery-notes.tsx");
  const keys = [...MIGRATION.slice(MIGRATION.indexOf("FUNCTION private.delivery_qr_rules"), MIGRATION.indexOf("FUNCTION public.delivery_qr_rules")).matchAll(/'((?:staff|partner)_[a-z_]+)'/g)].map((m) => m[1]!);
  assert.equal(new Set(keys).size, 6);
  for (const key of new Set(keys)) assert.match(rules, new RegExp(`key: "${key}"`), key);
  assert.match(rules, /supabase\.rpc\("delivery_qr_rules"\)/);
  assert.match(rules, /supabase\.rpc\("admin_set_delivery_qr_rules", \{ _rules: \{ \[key\]: on \} \}\)/);
  assert.doesNotMatch(rules, /A note is generated on the order page/);

  const staff = read("src/components/attendance/AttendanceManager.tsx");
  assert.match(staff, /supabase\.rpc\("admin_set_staff_incharge", \{ _employee_id: employee\.id, _on: on \}\)/);
  assert.match(staff, /"Remove in-charge" : "Make in-charge"/);

  const panel = read("src/components/panel/DeliveryNotePanel.tsx");
  assert.doesNotMatch(panel, /Generate delivery note/);
  assert.match(panel, /Release now/);
  assert.match(panel, /supabase\.rpc\("admin_replace_invoice_delivery_code", \{ _order_no: orderNo, _reason: reason\.trim\(\) \}\)/);
  assert.match(panel, /supabase\.rpc\("godown_released_notes"\)/);
  for (const page of ["src/routes/staff.index.tsx", "src/routes/partner.delivery-notes.tsx"]) {
    // The partner's scan card is its own component since the side menu (16 Nov 2026).
    const source = read(page) + (page.includes("partner") ? read("src/components/partners/ScanQrCard.tsx") : "");
    assert.match(source, /Scan the QR on the customer's invoice/, page);
    assert.match(source, /<ReleasedDeliveryNotes \/>/, page);
  }
  assert.match(read("src/routes/staff.index.tsx"), /me\.is_incharge && <p[^>]*>.*Godown in-charge<\/p>/);
});

test("released delivery notes: the customer's shop name, name, phone and address behind a button (owner, 14 Nov 2026)", () => {
  const sql = read("supabase/migrations/20261114120000_released_notes_customer_details.sql");
  // The same rule as printing the full delivery note (delivery_invoice_scan's can_note).
  assert.match(sql, /details := who->>'role' IN \('admin', 'incharge'\)\n\s+OR \(who->>'role' = 'staff' AND COALESCE\(\(rules->>'staff_print_note'\)::boolean, false\)\)\n\s+OR \(who->>'role' = 'partner' AND COALESCE\(\(rules->>'partner_print_note'\)::boolean, false\)\);/);
  for (const column of ["shop", "contact", "phone", "address"]) assert.match(sql, new RegExp(`${column} text`), column);
  assert.equal((sql.match(/CASE WHEN details THEN/g) ?? []).length, 4, "every detail is empty for anyone else");
  // Own godown only (admins every godown), as before; anon cannot call it.
  assert.match(sql, /AND \(who->>'role' = 'admin' OR NULLIF\(n\.snapshot->'godown'->>'id', ''\) = who->>'branch_id'\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.godown_released_notes\(\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public\.godown_released_notes\(\) TO authenticated;/);

  const button = read("src/components/panel/ReleasedNoteCustomer.tsx");
  assert.match(button, /if \(!shop && !contact && !phone && !address\) return null;/, "no button when the database sent nothing");
  assert.match(button, /\{open \? "Hide customer details" : "Customer details"\}/);
  assert.match(button, /<dt className="text-slate">Shop name<\/dt>/);
  assert.match(button, /href=\{`tel:\$\{dial\}`\}/, "the phone can be tapped to call");
  const panel = read("src/components/panel/DeliveryNotePanel.tsx");
  assert.match(panel, /import \{ ReleasedNoteCustomer \} from "@\/components\/panel\/ReleasedNoteCustomer";/);
  assert.match(panel, /<ReleasedNoteCustomer row=\{row\} \/>/);
  assert.match(panel, /matchesSearch\(\[row\.order_no, row\.customer, row\.note_no, row\.godown, row\.shop \?\? "", row\.contact \?\? "", row\.phone \?\? ""\], query\)/);
  const types = read("src/integrations/supabase/types.ts");
  assert.match(types, /godown_released_notes: \{ Args: Record<string, never>; Returns: \{ [^}]*godown: string; shop: string; contact: string; phone: string; address: string \}\[\] \}/);
  // The privacy policy says it.
  assert.ok(privacyPolicyText().some((line) => line.includes("your phone number and address also show to them in their list of released orders")));
});

test("the privacy policy says who scans the invoice QR and what they see", () => {
  const text = privacyPolicyText().join(" ");
  assert.match(text, /godown in-charge/);
  assert.match(text, /the last 4 digits of your phone number and the items/);
  assert.doesNotMatch(text, /When a delivery slip is scanned/);
});
