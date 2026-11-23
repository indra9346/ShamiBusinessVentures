import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { godownDetails, godownLine, handoverDetails, handoverTime, handoverWords, invoiceDelivery } from "../src/lib/invoice-lines.ts";
import { handoverWho, personWords, scannerLabel } from "../src/lib/delivery-papers.ts";
import { privacyPolicyText } from "../src/lib/privacy-policy.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// 11 Nov 2026, the owner: "during marking handover or delivered their name and details including other data of them
// should be displayed accurately & later those details should be pushed to invoice below QR code it should mention who
// handed over goods and time and accordingly godown details" ... "and there is channel partner also".

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const CODE = "AbCdEfGhIjKlMnOpQrSt_-";

const ANSWER = {
  code: CODE, why: "paid", note_no: "DN-CLK-0007", released_at: "2026-11-11T14:30:00Z", items: 3,
  godown: {
    id: "BR-CLK", name: "Grain Bazar Challakere Godown", address: "Pavagada Road", city: "Challakere", state: "Karnataka",
    pincode: "577522", phone: "9900000001", gstin: "29ABCDE1234F1Z5", partner_name: "Vamshi", partner_phone: "9900000002",
  },
  handovers: [
    { line: 2, item: "Sugar 50 kg", qty: 1, at: "2026-11-11T14:50:20Z", by: "Vamshi", role: "partner", phone: "9900000002", godown: "Grain Bazar Challakere Godown" },
    { line: 1, item: "Rice 25 kg", qty: 2, at: "2026-11-11T14:50:15Z", by: "Vamshi", role: "partner", phone: "9900000002", godown: "Grain Bazar Challakere Godown" },
    { line: 3, item: "Oil 1 L", qty: 6, at: "2026-11-12T04:05:00Z", by: "Ravi", role: "staff", phone: "9900000003", godown: "Grain Bazar Challakere Godown" },
  ],
};

test("the invoice's delivery answer keeps the hand-overs, the godown and its channel partner", () => {
  const delivery = invoiceDelivery(ANSWER)!;
  assert.equal(delivery.code, CODE);
  assert.equal(delivery.items, 3);
  assert.equal(delivery.handovers.length, 3);
  assert.deepEqual(delivery.handovers[0], ANSWER.handovers[0]);
  assert.equal(delivery.godown?.partnerName, "Vamshi");
  assert.equal(delivery.godown?.partnerPhone, "9900000002");
  // Before the database update the answer has none of these: still a working answer.
  const before = invoiceDelivery({ code: CODE, why: "paid", note_no: null, released_at: null })!;
  assert.deepEqual([before.handovers, before.godown, before.items, before.reopened], [[], null, 0, 0]);
  assert.equal(invoiceDelivery({ ...ANSWER, reopened: 2 })!.reopened, 2);
  // Rubbish is dropped, not shown.
  const odd = invoiceDelivery({ code: CODE, handovers: [null, 3, { line: 0, at: "x" }, { line: 1, at: "" }], godown: { name: "" } })!;
  assert.deepEqual([odd.handovers, odd.godown], [[], null]);
  assert.equal(godownDetails(["x"]), null);
});

test("the time is India's, to the second", () => {
  assert.equal(handoverTime("2026-11-11T14:50:15Z"), "11 Nov 2026, 08:20:15 PM IST");
  assert.equal(handoverTime("2026-11-12T04:05:00Z"), "12 Nov 2026, 09:35:00 AM IST");
  assert.equal(handoverTime("not a time"), "");
});

test("one sentence per person and moment: who, role, mobile, godown, items, in English and Kannada", () => {
  const words = handoverWords(invoiceDelivery(ANSWER));
  assert.equal(words.done, true);
  assert.equal(words.all, true);
  assert.deepEqual(words.lines.map((line) => line.en), [
    "Handed over 11 Nov 2026, 08:20:15 PM IST by Vamshi (channel partner, mobile 9900000002) at Grain Bazar Challakere Godown: 1. Rice 25 kg x2, 2. Sugar 50 kg x1.",
    "Handed over 12 Nov 2026, 09:35:00 AM IST by Ravi (godown staff, mobile 9900000003) at Grain Bazar Challakere Godown: 3. Oil 1 L x6.",
  ]);
  assert.match(words.lines[0]!.kn, /^11 Nov 2026, 08:20:15 PM IST ರಂದು Grain Bazar Challakere Godown ನಲ್ಲಿ Vamshi \(ಚಾನೆಲ್ ಪಾಲುದಾರ, ಮೊಬೈಲ್ 9900000002\) ಹಸ್ತಾಂತರಿಸಿದ್ದಾರೆ: 1\. Rice 25 kg x2, 2\. Sugar 50 kg x1\.$/);
  // Part handed over: not all.
  const part = handoverWords({ ...invoiceDelivery(ANSWER)!, handovers: invoiceDelivery(ANSWER)!.handovers.slice(0, 1) });
  assert.deepEqual([part.done, part.all], [true, false]);
});

test("hand-over details: labelled rows, one block per person and moment (Sandesh, 21 Nov 2026)", () => {
  const blocks = handoverDetails(invoiceDelivery(ANSWER));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0]!.map((field) => [field.en, field.value]), [
    ["Handed over", "1. Rice 25 kg x2, 2. Sugar 50 kg x1"],
    ["Delivery time", "11 Nov 2026, 08:20:15 PM IST"],
    ["Handed over by", "Vamshi (channel partner)"],
    ["Mobile number", "9900000002"],
    ["Location", "Grain Bazar Challakere Godown"],
  ]);
  assert.ok(blocks[0]!.every((field) => field.kn));
  assert.deepEqual(handoverDetails(null), []);
  // No mobile, no godown (an office hand-over): no empty mobile row, location "Office".
  const office = handoverDetails({ handovers: [{ line: 1, item: "Rice", qty: 1, at: "2026-11-11T14:50:15Z", by: "Indra", role: "admin", phone: "", godown: "" }] });
  assert.deepEqual(office[0]!.map((field) => field.en), ["Handed over", "Delivery time", "Handed over by", "Location"]);
  assert.equal(office[0]!.at(-1)!.value, "Office");
});

test("before any hand-over the invoice says so; an office-marked delivery says that instead", () => {
  assert.deepEqual(handoverWords(null).lines, [{ en: "Not handed over yet.", kn: "ಇನ್ನೂ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ." }]);
  assert.deepEqual(handoverWords({ handovers: [], items: 2 }, "Packed").lines[0]!.en, "Not handed over yet.");
  const office = handoverWords({ handovers: [], items: 2 }, "Delivered");
  assert.equal(office.done, true);
  assert.match(office.lines[0]!.en, /^Marked delivered by the office; no godown hand-over was recorded\.$/);
  // The office reopened the only hand-over (the order stays Delivered): not "marked delivered by the office".
  const reopened = handoverWords({ handovers: [], items: 1, reopened: 1 }, "Delivered");
  assert.deepEqual([reopened.done, reopened.lines[0]!.en], [false, "Reopened by the office; not handed over again yet."]);
  assert.match(reopened.lines[0]!.kn, /ಮರುತೆರೆದಿದೆ/);
  // An office hand-over has no godown of its own: no empty "at".
  const admin = handoverWords({ items: 1, handovers: [{ line: 1, item: "Rice", qty: 1, at: "2026-11-11T14:50:15Z", by: "Indra", role: "admin", phone: "", godown: "" }] });
  assert.equal(admin.lines[0]!.en, "Handed over 11 Nov 2026, 08:20:15 PM IST by Indra (office): 1. Rice x1.");
});

test("the godown line names the place, phone, GSTIN and its channel partner with mobile", () => {
  assert.equal(godownLine(invoiceDelivery(ANSWER)!.godown),
    "Grain Bazar Challakere Godown, Pavagada Road, Challakere, Karnataka 577522  ·  Phone 9900000001  ·  GSTIN 29ABCDE1234F1Z5  ·  Channel partner Vamshi (mobile 9900000002)");
  assert.equal(godownLine(godownDetails({ name: "Hubli Godown", partner_name: "" })), "Hubli Godown");
  assert.equal(godownLine(invoiceDelivery(ANSWER)!.godown, "kn"),
    "Grain Bazar Challakere Godown, Pavagada Road, Challakere, Karnataka 577522  ·  ಫೋನ್ 9900000001  ·  GSTIN 29ABCDE1234F1Z5  ·  ಚಾನೆಲ್ ಪಾಲುದಾರ Vamshi (ಮೊಬೈಲ್ 9900000002)");
  assert.equal(godownLine(null), "");
  // An address that already names the town and PIN does not repeat them.
  assert.equal(godownLine(godownDetails({ name: "Challakere Godown", address: "Pavagada Road, Challakere 577522", city: "Challakere", state: "Karnataka", pincode: "577522" })),
    "Challakere Godown, Pavagada Road, Challakere 577522, Karnataka");
});

test("the scan screen and admin history name the person with their mobile", () => {
  assert.equal(personWords("Ravi", "staff", "Challakere Godown", false, "9900000003").en, "Ravi (staff, mobile 9900000003, Challakere Godown, own phone)");
  assert.equal(personWords("Ravi", "staff", "Challakere Godown", false, "9900000003").kn, "Ravi (ಸಿಬ್ಬಂದಿ, ಮೊಬೈಲ್ 9900000003, Challakere Godown, ಸ್ವಂತ ಫೋನ್)");
  // Older hand-overs have no mobile: the words stay as before.
  assert.equal(personWords("Ravi", "staff", "Challakere Godown", false).en, "Ravi (staff, Challakere Godown, own phone)");
  assert.equal(handoverWho({ at: "x", by: "Vamshi", role: "partner", godown: "Challakere", phone: "9900000002" }).en, "Vamshi (channel partner, mobile 9900000002, Challakere)");
  assert.equal(scannerLabel({ actor_name: "Vamshi", actor_role: "partner", branch_name: "Challakere", device_registered: true, device_label: "Counter", actor_phone: "9900000002" }),
    "Vamshi (channel partner, mobile 9900000002, Challakere, godown's registered phone: Counter)");
});

test("the invoice prints the godown beside the QR and the hand-overs under it, measured together so they stay together", () => {
  const invoice = read("src/lib/invoice.ts");
  assert.match(invoice, /const handoverBlock = \(facts: InvoiceDelivery \| null\)/);
  // The godown with its channel partner beside the QR, in the band's text column.
  assert.match(invoice, /const godown = godownLine\(facts\?\.godown\);/);
  assert.match(invoice, /pdf\.splitTextToSize\(`Godown: \$\{godown\}`, textW\)/);
  assert.match(invoice, /band\.godownLines\.forEach\(\(line, index\) => pdf\.text\(line, tx, at \+ 2\.3 \+ index \* 2\.9\)\)/);
  assert.match(invoice, /const words = handoverWords\(facts, order\.status\);\n\s+const details = words\.done \? handoverDetails\(facts\) : \[\];/,
    "before any hand-over nothing is printed under the QR");
  // A long list carries on onto the next page instead of running over the footer.
  assert.match(invoice, /if \(at \+ rowHeight\(row\) > H - 17\) \{\n\s+newPage\(false\);\n\s+at = y \+ 0\.8;\n\s+title\(true\);/);
  assert.match(invoice, /if \(qrCode\) \{\s*y \+= 27\.5;\s*(?:\/\/[^\n]*\s*)*const band = qrBandText\(delivery\);\s*const below = handoverBlock\(delivery\);\s*(?:\/\/[^\n]*\s*)*if \(y \+ band\.height \+ below\.height > H - 17\) newPage\(false\);\s*y = deliveryQrBlock\(qrCode, y, band\);\s*y = below\.draw\(y\);/);
  assert.ok(!invoice.includes("QR_BLOCK_H"), "the band's height is measured, not a fixed number");
  // Labelled rows with the Kannada label beside each English one; an office-marked delivery keeps its Kannada sentence.
  assert.match(invoice, /label: field\.en, labelKn: labelImage\(field\.kn, field\.en\)/);
  assert.match(invoice, /canvasTextImage\(line\.kn, \{ sizePt: 7, maxWidthMm: textW, color: ink \}\)/);
});

test("the database keeps the mobile and hands out the hand-overs and godown with its channel partner", () => {
  const sql = read("supabase/migrations/20261112150000_handover_details.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS actor_phone text NOT NULL DEFAULT ''/);
  assert.match(sql, /'partner_name', COALESCE\(\(SELECT p\.name FROM public\.channel_partners p WHERE p\.branch_id = b\.id AND p\.status = 'active'/);
  assert.match(sql, /'handovers', CASE WHEN n\.id IS NULL THEN '\[\]'::jsonb/);
  assert.match(sql, /COALESCE\(who->>'phone', ''\), who_branch, who_branch_name/);
  assert.match(sql, /REVOKE ALL ON FUNCTION private\.delivery_godown_details\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /CREATE TRIGGER delivery_handovers_fill_phone BEFORE INSERT ON public\.delivery_handovers/);
  assert.match(sql, /NEW\.actor_phone := COALESCE\(private\.delivery_scanner\(NEW\.actor_id\)->>'phone', ''\);/);
  assert.match(sql, /FROM public\.channel_partners p WHERE p\.id = private\.order_signing_partner\(o\.id\)\),/);
  assert.match(sql, /'reopened', CASE WHEN n\.id IS NULL THEN 0 ELSE/);
  // Reopened hand-overs are not printed as handed over.
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.delivery_handover_reopens r WHERE r\.handover_id = h\.id\)\) END/);
});

test("the pages show it: scan screen, customer's order page, admin panel", () => {
  const slip = read("src/routes/slip.tsx");
  assert.match(slip, /Handed over \{istDateTime\(line\.handover\.at\)\} by \{handoverWho\(line\.handover\)\.en\}/);
  assert.match(slip, /godownLine\(godownDetails\(scan\.godown_details\)\)/);
  assert.match(slip, /mobile \$\{scan\.by_phone\}/);
  assert.match(slip, /\{scan\.godown \? `, \$\{scan\.godown\}` : ""\}, \{phoneWords\(/, "a space before the phone words");
  assert.match(read("src/routes/admin.delivery-note.$orderNo.tsx"), /\.\.\.\(row\.actor_phone \? \{ phone: row\.actor_phone \} : \{\}\)/);
  assert.match(read("src/routes/account.orders.$id.tsx"), /godownLine\(delivery\.godown, language === "kn" \? "kn" : "en"\)/);
  const account = read("src/routes/account.orders.$id.tsx");
  assert.match(account, /<HandoverFacts delivery=\{facts\.delivery\} status=\{order\.status\} \/>/);
  assert.match(account, /key=\{`handover-\$\{index\}`\}/);
  assert.match(read("src/lib/delivery-notes.functions.ts"), /actor_name,actor_role,actor_phone,branch_name/);
  assert.match(read("src/components/panel/DeliveryNotePanel.tsx"), /actor_phone: row\.actor_phone/);
});

test("staff and channel partners are told on the privacy page, in English and Kannada", () => {
  const strings = privacyPolicyText();
  const staff = strings.find((text) => text.includes("After you hand over goods, your name, role, mobile number"));
  const partner = strings.find((text) => text.includes("Your name and mobile number are printed with your godown's details"));
  assert.ok(staff && partner);
  assert.match(kn[staff]!, /ಮೊಬೈಲ್ ಸಂಖ್ಯೆ, ಸಮಯ ಮತ್ತು ಗೋದಾಮು/);
  assert.match(kn[partner]!, /ಡೆಲಿವರಿ QR ಕೆಳಗೆ/);
});
