import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as jspdf from "jspdf";
import {
  CONTACT_NUMBER_BATCH, CONTACT_NUMBER_LABELS, CONTACT_NUMBER_MAX, CONTACT_NUMBERS_OFF_HINT, EMPTY_CONTACT_NUMBER_FETCH, NO_CONTACT_NUMBERS,
  cleanContactNumber, contactNumberFetchLines, contactNumberLabel, contactNumberLine, contactNumberUpdate, contactNumbersFrom, vendorNumberOf,
  zohoContactNumberOf, type ContactNumberFetch,
} from "../src/lib/zoho-contact-numbers.ts";
import { buildDeliveryNotePdf, releasedPdfInput, type DeliveryPdfInput } from "../src/lib/delivery-note-pdf.ts";
import type { ReleasePrint } from "../src/lib/delivery-papers.ts";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// 12 Nov 2026, the owner: "Fetch Customer ID (customer number) & Vendor IDs (vendor number) from Zoho & show the same
// everywhere in customer details & order details & in invoices & delivery slips and wherever required."

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("Zoho's contact_number: there, empty, or not said at all", () => {
  // Zoho Books' contact object: "contact_number" (Customer Number / Vendor Number), at most 50 characters.
  assert.equal(zohoContactNumberOf({ contact_id: "1", contact_number: "CUS-00012" }), "CUS-00012");
  assert.equal(zohoContactNumberOf({ contact_number: "  VEN 007 \n" }), "VEN 007", "trimmed, inner spaces kept single");
  assert.equal(zohoContactNumberOf({ contact_number: 12 }), "12", "a bare number is text");
  assert.equal(zohoContactNumberOf({ contact_number: "" }), null, "numbers switched off: empty");
  assert.equal(zohoContactNumberOf({ contact_number: "   " }), null);
  assert.equal(zohoContactNumberOf({ contact_number: null }), null);
  assert.equal(zohoContactNumberOf({ contact_id: "1", contact_name: "TEST" }), undefined, "no field: Zoho said nothing");
  for (const nothing of [undefined, null, "CUS-1", 5, ["CUS-1"]]) assert.equal(zohoContactNumberOf(nothing), undefined);
  assert.equal(zohoContactNumberOf({ contact_number: "X".repeat(80) })?.length, CONTACT_NUMBER_MAX);
  assert.equal(cleanContactNumber({}), null);
});

test("what is saved after asking Zoho: an unsaid number keeps what was kept", () => {
  const at = "2026-11-12T10:00:00.000Z";
  assert.deepEqual(contactNumberUpdate("CUS-00012", at), { zoho_contact_number: "CUS-00012", zoho_contact_number_checked_at: at });
  assert.deepEqual(contactNumberUpdate(null, at), { zoho_contact_number: null, zoho_contact_number_checked_at: at }, "an empty number clears it");
  assert.deepEqual(contactNumberUpdate(undefined, at), { zoho_contact_number_checked_at: at });
});

test("the label wording, everywhere the same", () => {
  assert.deepEqual(CONTACT_NUMBER_LABELS, { customer: "Customer No.", vendor: "Vendor No." });
  assert.equal(contactNumberLabel("customer"), "Customer No.");
  assert.equal(contactNumberLabel("vendor"), "Vendor No.");
  assert.equal(contactNumberLine("customer", " CUS-00012 "), "Customer No. CUS-00012");
  assert.equal(contactNumberLine("vendor", "VEN-007"), "Vendor No. VEN-007");
  assert.equal(contactNumberLine("customer", null), "", "no number: the line is left out");
  assert.equal(contactNumberLine("customer", ""), "");
});

test("the numbers an account may see, as look-ups", () => {
  const numbers = contactNumbersFrom([
    { user_id: "u1", vendor_id: null, contact_type: "customer", contact_number: "CUS-1" },
    { user_id: "u2", vendor_id: "V9", contact_type: "vendor", contact_number: " VEN-9 " },
    { user_id: "u3", vendor_id: "", contact_type: "vendor", contact_number: "VEN-3" },
    { user_id: "u4", contact_type: "customer", contact_number: "" },
    { user_id: "", contact_type: "customer", contact_number: "CUS-X" },
    { user_id: "u5", contact_type: "partner", contact_number: "P-1" },
    null, "row",
  ]);
  assert.deepEqual([...numbers.customers], [["u1", "CUS-1"]]);
  assert.deepEqual([...numbers.vendorsByUser], [["u2", "VEN-9"], ["u3", "VEN-3"]]);
  assert.deepEqual([...numbers.vendorsByVendorId], [["V9", "VEN-9"]]);
  // The site's vendor id is the profile's vendor id, else the account id.
  assert.equal(vendorNumberOf(numbers, "V9"), "VEN-9");
  assert.equal(vendorNumberOf(numbers, "u3"), "VEN-3");
  assert.equal(vendorNumberOf(numbers, "V404"), null);
  assert.equal(vendorNumberOf(numbers, ""), null);
  for (const failed of [null, undefined, { message: "function does not exist" }, "x"]) assert.equal(contactNumbersFrom(failed), NO_CONTACT_NUMBERS);
});

const fetched = (over: Partial<ContactNumberFetch>): ContactNumberFetch => ({ ...EMPTY_CONTACT_NUMBER_FETCH, failed: [], ...over });

test("the admin's answer after a press", () => {
  assert.deepEqual(contactNumberFetchLines(fetched({ read: 20, found: 18, empty: 1, notSaid: 1, failed: ["4600001"], linked: 45, numbered: 30, remaining: 5 })), [
    "Contacts read from Zoho now: 20",
    "With a number in Zoho: 18",
    "Without a number in Zoho: 2",
    "Zoho could not be read for: 1",
    "Linked contacts with a number: 30 of 45",
    "Not asked yet: 5. Press the button again.",
  ]);
  const done = contactNumberFetchLines(fetched({ read: 3, found: 3, linked: 3, numbered: 3 }));
  assert.equal(done.at(-1), "Every linked contact has been asked. Pressing again reads the oldest ones again.");
  // Zoho sends none: the preference in Zoho Books, which only the owner may switch on (Zoho cannot switch it off again).
  const none = contactNumberFetchLines(fetched({ read: 20, empty: 20, linked: 45, remaining: 25 }));
  assert.equal(none.at(-1), CONTACT_NUMBERS_OFF_HINT);
  assert.match(CONTACT_NUMBERS_OFF_HINT, /Settings > Preferences > Customers and Vendors/);
  assert.match(CONTACT_NUMBERS_OFF_HINT, /cannot switch them off again/);
  assert.deepEqual(contactNumberFetchLines(fetched({ needsMigration: true })), ["The database does not have the customer and vendor number update yet. Nothing was asked of Zoho. Ask your developer to apply it."]);
  assert.deepEqual(contactNumberFetchLines(fetched({ pausedUntil: "2026-11-12T11:00:00Z" })), ["Zoho's daily API limit was reached, so nothing was asked. Try again after the pause ends."]);
  const halfway = contactNumberFetchLines(fetched({ pausedUntil: "2026-11-12T11:00:00Z", read: 4, found: 4, linked: 9, numbered: 4, remaining: 5 }));
  assert.equal(halfway[0], "Zoho's daily API limit was reached, so the rest were not asked. Try again after the pause ends.");
  assert.ok(halfway.includes("Contacts read from Zoho now: 4"));
  assert.ok(CONTACT_NUMBER_BATCH > 0 && CONTACT_NUMBER_BATCH <= 25, "a small batch per press");
});

test("every new line reads in Kannada", async () => {
  await loadKannada();
  const lines = [
    ...contactNumberFetchLines(fetched({ read: 20, found: 0, empty: 20, failed: ["1"], linked: 45, numbered: 30, remaining: 5 })),
    ...contactNumberFetchLines(fetched({ read: 3, found: 3, linked: 3, numbered: 3, pausedUntil: "x" })),
    ...contactNumberFetchLines(fetched({ needsMigration: true })),
    ...contactNumberFetchLines(fetched({ pausedUntil: "x" })),
    "Customer No.", "Vendor No.", "Customer No.:", "Vendor No.:", "Customer No. CUS-00012",
    "Search name, email, phone, customer no.", "Search business, owner, email, vendor no.", "Search order, customer, customer no. or phone",
    "Your number in our accounts. It is printed on your invoices.", "Your number in our accounts.",
    "Customer and vendor numbers", "Fetching numbers…", "Fetch customer and vendor numbers from Zoho", "Customer and vendor numbers fetched",
    "Zoho contact IDs not read:", "Could not read the Zoho contact links", `Each press reads up to ${CONTACT_NUMBER_BATCH} linked contacts from Zoho. Nothing is changed in Zoho.`,
    "Zoho Books gives each customer and vendor a number (Customer No. / Vendor No.). The website shows it on the customer and vendor pages, on orders, on invoices and on delivery notes and slips.",
  ];
  for (const line of lines) {
    const kannada = translateText(line, "kn");
    assert.notEqual(kannada, line, `no Kannada for "${line}"`);
    assert.ok(/[ಀ-೿]/.test(kannada), `"${line}" -> "${kannada}"`);
    assert.ok(!/\{\d\}/.test(kannada), `a placeholder left in "${kannada}"`);
  }
  assert.equal(translateText("Customer No. CUS-00012", "kn"), `${kn["Customer No."]} CUS-00012`);
  assert.equal(translateText("Linked contacts with a number: 30 of 45", "kn"), "ಸಂಖ್ಯೆ ಇರುವ ಜೋಡಿತ ಸಂಪರ್ಕಗಳು: 45 ರಲ್ಲಿ 30");
});

// ---------------------------------------------------------------- the delivery note and slips
function note() {
  return {
    id: "n1", seq: 1, note_no: "DN-000001", order_no: "CLK-577522-071126-164455", invoice_number: "CLKINV0711260364",
    invoice_total: 2000, order_total: 2000, paid_amount: 2000, generated_at: "2026-11-11T11:58:51Z", generated_by_name: "Indra Kumar",
    generated_how: "auto",
    snapshot: {
      order_placed_at: "2026-11-07T11:14:55Z", shipping_method: "Standard",
      customer: { name: "Sample Customer", phone: "9000000001", business_name: "", gstin: "" },
      address: { name: "Sample Customer", phone: "9000000001", line: "12 Market Road", city: "Challakere", state: "Karnataka", pin: "577522" },
      godown: { name: "Challakere Godown", address: "Pavagada Road", city: "Challakere", state: "Karnataka", pincode: "577522" },
      company: { legal_name: "Shami Business Ventures Pvt Ltd", address: "Bengaluru\nKarnataka 560001", gstin: "29AAACS1234A1Z1", phone: "+91 90000 00000" },
      items: [1, 2].map((line) => ({ line, order_item_id: `oi${line}`, product_id: `P${line}`, name: `Item ${line}`, sku: `SKU-${line}`, qty: 1, pack_size: "25 kg bag", stock_no: "" })),
    },
  } as unknown as DeliveryPdfInput["note"];
}
const print = (): ReleasePrint => ({
  note: note(), printed_at: "2026-11-12T10:00:00Z", printed_by: "Ravi", printed_role: "incharge", note_copy: 1, slip_copies: { 1: 1, 2: 1 },
}) as unknown as ReleasePrint;
const pdfText = (pdf: { internal: unknown }) => ((pdf.internal as { pages: (string[] | undefined)[] }).pages).flat().filter(Boolean).join("\n");
const papers = (customerNumber?: string | null) => releasedPdfInput(print(), {
  gate: { code: "paid" }, selection: { note: true, slips: [1, 2] }, handovers: {}, origin: "https://grainbazar.com",
  ...(customerNumber !== undefined ? { customerNumber } : {}),
});

test("the note and every slip carry the customer number, handed in when printing", () => {
  const input = papers(" CUS-00012 ");
  assert.equal(input.customerNumber, "CUS-00012");
  // The note's frozen snapshot is not touched.
  assert.ok(!JSON.stringify(input.note.snapshot).includes("CUS-00012"));
  const { pdf } = buildDeliveryNotePdf(input, { jspdf, logo: null, textImage: null });
  const out = pdfText(pdf);
  assert.ok(out.includes("Customer No. CUS-00012"), "on the note, under the customer");
  assert.equal(out.split("CUS-00012").length - 1, 3, "on the note and on each of the two slips");
  assert.ok(out.includes("Customer No."));
});

test("no number, no line: older notes and a database without the update print as before", () => {
  for (const input of [papers(), papers(null), papers("  ")]) {
    assert.equal("customerNumber" in input, false);
    const { pdf } = buildDeliveryNotePdf(input, { jspdf, logo: null, textImage: null });
    assert.ok(!pdfText(pdf).includes("Customer No."));
  }
});

// ---------------------------------------------------------------- source wiring
test("the migration: two columns, a length check, two read functions; nothing existing rewritten", () => {
  const sql = read("supabase/migrations/20261112160000_zoho_contact_numbers.sql");
  assert.match(sql, /ALTER TABLE public\.zoho_contact_links ADD COLUMN IF NOT EXISTS zoho_contact_number text;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS zoho_contact_number_checked_at timestamptz;/);
  assert.match(sql, /char_length\(zoho_contact_number\) BETWEEN 1 AND 50/);
  assert.match(sql, /FUNCTION public\.zoho_contact_numbers\(\)[\s\S]*SECURITY DEFINER[\s\S]*l\.user_id = auth\.uid\(\) OR public\.has_role\(auth\.uid\(\), 'admin'\)/);
  assert.match(sql, /FUNCTION public\.invoice_customer_number\(_order_no text\)[\s\S]*private\.order_signing_partner\(o\.id\)/);
  for (const fn of ["zoho_contact_numbers()", "invoice_customer_number(text)"]) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`), fn);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`), fn);
  }
  assert.ok(!/UPDATE public\.zoho_contact_links/i.test(sql), "no existing link is changed");
  assert.ok(!/GRANT[^;]*ON public\.zoho_contact_links/i.test(sql), "the table stays closed to signed-in accounts");
  const types = read("src/integrations/supabase/types.ts");
  assert.match(types, /zoho_contact_number: string \| null; zoho_contact_number_checked_at: string \| null/);
  assert.match(types, /invoice_customer_number: \{ Args: \{ _order_no: string \}; Returns: string \| null \}/);
  assert.match(types, /zoho_contact_numbers: \{ Args: Record<PropertyKey, never>; Returns: \{ user_id: string; vendor_id: string \| null; contact_type: string; contact_number: string \}\[\] \}/);
});

test("the number is kept whenever the website creates, updates or checks a Zoho contact", () => {
  const source = read("src/lib/zoho-commerce.functions.ts");
  const upsert = source.slice(source.indexOf("async function upsertZohoContact("), source.indexOf("class NeedsReviewError"));
  assert.match(upsert, /zohoContact = created\.contact;/);
  assert.match(upsert, /zohoContact = updated\.contact;/);
  assert.match(upsert, /await saveZohoContactNumber\(db, userId, contactType, zohoContactNumberOf\(zohoContact\)\);/);
  // The link itself is saved exactly as before: a database without the new column still links contacts.
  assert.match(upsert, /db\.from\("zoho_contact_links"\)\.upsert\(\{ user_id: userId, contact_type: contactType, zoho_contact_id: contactId, updated_at: new Date\(\)\.toISOString\(\), \.\.\.\(zohoModifiedAt/);
  assert.ok(!/upsert\(\{[^}]*zoho_contact_number/.test(upsert));
  const save = source.slice(source.indexOf("async function saveZohoContactNumber("), source.indexOf("const missingContactNumberColumn"));
  assert.match(save, /if \(number === undefined\) return;/);
  assert.match(save, /catch \{/);
  const poll = source.slice(source.indexOf("async function pollZohoContactChanges("), source.indexOf("async function pollZohoCatalogChanges("));
  assert.match(poll, /const number = zohoContactNumberOf\(contact\);/);
  assert.match(poll, /keptNumbers\.get\(`\$\{link\.user_id\}:\$\{link\.contact_type\}`\) !== number/);
  // The poll's own read of the links is unchanged, so it works before the migration.
  assert.match(poll, /\.select\("user_id,contact_type,zoho_contact_id,updated_at,last_polled_at,last_zoho_modified_at"\)/);
});

test("the admin action: small batches, the call log, the daily-limit pause, read-only in Zoho", () => {
  const source = read("src/lib/zoho-commerce.functions.ts");
  const action = source.slice(source.indexOf("export const fetchZohoContactNumbers"), source.indexOf("async function pollZohoContactChanges("));
  assert.match(action, /await ensureAdmin\(context\.supabase, context\.userId\);/);
  assert.match(action, /zohoPaused\(pausedUntil, Date\.now\(\)\)/);
  assert.match(action, /\.limit\(CONTACT_NUMBER_BATCH\)/);
  assert.match(action, /order\("zoho_contact_number_checked_at", \{ ascending: true, nullsFirst: true \}\)/);
  assert.match(action, /withZohoPurpose\("Admin: customer and vendor numbers"/);
  assert.match(action, /runPool\(batch, 3,/);
  assert.match(action, /`contacts\/\$\{encodeURIComponent\(link\.zoho_contact_id\)\}`, "GET"/);
  const zohoCalls = action.match(/(inventoryRequest|booksRequest|commerceRequest)[^;]*;/g) ?? [];
  assert.equal(zohoCalls.length, 1, "one Zoho call per contact");
  assert.ok(zohoCalls.every((call) => call.includes('"GET"') && !/"(PUT|POST|DELETE)"/.test(call)), "nothing is written to Zoho");
  assert.match(action, /await flushZohoCallLog\(\);/);
  assert.match(action, /if \(zohoDailyLimitHit\) await pauseZohoForDailyLimit\(db\);/);
  assert.match(action, /missingContactNumberColumn\(error\)\) return \{ \.\.\.EMPTY_CONTACT_NUMBER_FETCH, failed: \[\], needsMigration: true \}/);
  const panel = read("src/components/panel/ZohoContactNumbersPanel.tsx");
  assert.match(panel, /fetchZohoContactNumbers\(\)/);
  assert.match(panel, /Fetch customer and vendor numbers from Zoho/);
  assert.match(panel, /forgetZohoContactNumbers\(\)/);
  assert.match(read("src/routes/admin.zoho.tsx"), /<ZohoContactNumbersPanel connected=\{Boolean\(connection\)\} \/>/);
});

test("the pages read the numbers through the database function, and show nothing when it is not there", () => {
  const hook = read("src/hooks/use-zoho-contact-numbers.ts");
  assert.match(hook, /supabase\.rpc\("zoho_contact_numbers"\)/);
  assert.match(hook, /return error \? NO_CONTACT_NUMBERS : contactNumbersFrom\(data\);/);
  const pages: [string, RegExp[]][] = [
    ["src/routes/admin.customers.tsx", [/numbers\.customers\.get\(c\.id\)/, /<span>Customer No\.<\/span>/, /"Customer No\.",/]],
    ["src/routes/admin.customers.$id.tsx", [/Customer No\.:<\/span>/, /customers\.get\(id\)/]],
    ["src/routes/admin.orders.tsx", [/<span>Customer No\.<\/span>/, /"Customer No\.",/]],
    ["src/routes/admin.orders.$id.tsx", [/<dt className="text-slate">Customer No\.<\/dt>/, /Vendor No\.:<\/span>/, /vendorNumberOf\(contactNumbers, v\.id\)/]],
    ["src/routes/admin.vendors.tsx", [/<span>Vendor No\.<\/span>/, /"Vendor No\.",/]],
    ["src/routes/admin.vendors.$id.tsx", [/Vendor No\.:<\/span>/, /vendorNumberOf\(useZohoContactNumbers\(user\?\.id\), id\)/]],
    ["src/routes/vendor.profile.tsx", [/<Label>Vendor No\.<\/Label>/, /vendorNumberOf\(useZohoContactNumbers\(user\?\.id\), vendorId\)/]],
    ["src/routes/account.profile.tsx", [/<Label>Customer No\.<\/Label>/]],
    ["src/routes/account.orders.$id.tsx", [/<dt className="text-slate">Customer No\.<\/dt>/]],
  ];
  for (const [path, patterns] of pages) {
    const source = read(path);
    assert.match(source, /useZohoContactNumbers\(user\?\.id\)/, path);
    for (const pattern of patterns) assert.match(source, pattern, `${path}: ${pattern}`);
  }
});

test("the invoice prints the customer number under Bill to, for whoever may open the customer copy", () => {
  const invoice = read("src/lib/invoice.ts");
  assert.match(invoice, /supabase\.rpc\("invoice_customer_number", \{ _order_no: orderNo \}\)/);
  assert.match(invoice, /return error \? null : cleanContactNumber\(data\);/);
  // Read with the facts, or now when the caller's facts left it out (the channel partner's copy).
  assert.match(invoice, /facts\.customerNumber !== undefined \? Promise\.resolve\(facts\.customerNumber\) : loadCustomerNumber\(order\.id\)/);
  const billTo = invoice.slice(invoice.indexOf('title: "Bill to"'), invoice.indexOf("{ title: shipTitle"));
  assert.match(billTo, /contactNumberLine\("customer", customerNumber\)/);
  assert.match(read("src/lib/invoice-lines.ts"), /customerNumber\?: string \| null \| undefined;/);
  // The partner's copy leaves it out of its facts, so the invoice asks the database as the partner.
  assert.ok(!/customerNumber/.test(read("src/lib/partner-invoices.ts")));
});

test("the delivery papers get the number when printed, from the website's own read", () => {
  const server = read("src/lib/delivery-notes.functions.ts");
  assert.match(server, /async function customerNumberOfOrder\(/);
  assert.match(server, /select\("zoho_contact_number"\)/);
  assert.match(server, /customerNumber,\n?\s*\};/);
  assert.match(server, /if \(scan\.result === "printed" && scan\.print\) scan = \{ \.\.\.scan, customer_number: await customerNumberOfOrder\(db, orderNo\) \};/);
  assert.match(read("src/routes/slip.tsx"), /customerNumber: answer\.customer_number \?\? null/);
  const office = read("src/routes/admin.delivery-note.$orderNo.tsx");
  assert.match(office, /customerNumber: next\.customerNumber \?\? null/);
  assert.match(office, /<Fact label="Customer No\." value=\{customerNumber\} strong \/>/);
  assert.match(office, /<span>Customer No\.<\/span> <span data-no-translate>\{customerNumber\}<\/span>/);
});

test("the test runs with the Zoho tests", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  assert.ok(scripts["test:zoho"]!.trim().endsWith("tests/zoho-contact-numbers.test.ts"));
});
