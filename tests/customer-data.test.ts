import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOMER_DATA_SECTIONS, customerDataCell, customerDataFileName, customerDataSheets, deletionBlockerText, flattenCustomerRow, keptLines, removedLines, type CustomerDataFile, type DeletionPlan } from "../src/lib/customer-data.ts";
import { buildXlsx, xlsxParts } from "../src/lib/xlsx.ts";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";

const file = (extra: Record<string, unknown> = {}): CustomerDataFile => ({
  customer_id: "6f1c2d3e-0000-4000-8000-000000000001",
  generated_at: "2026-11-03T08:15:00.123456+00:00",
  generated_by: "Asha Admin",
  label: "R.K. ··2345",
  account: { email: "r@example.invalid", phone: "919000012345", details: { full_name: "Ramya" } },
  profile: { id: "6f1c2d3e", full_name: "Ramya Kannan", gstin: null },
  zoho_contacts: [{ contact_type: "customer", zoho_contact_id: "ZC-1" }],
  addresses: [{ id: "a1", line: "1 Test Road", latitude: 12.97, longitude: 77.55, is_default: true }],
  orders: [{ id: "o1", order_no: "GB-1", total: 1000, shipping_address: { line: "1 Test Road", pin: "560040" } }],
  ...extra,
});

const sheet = (name: string, data = file()) => {
  const found = customerDataSheets(data).find((item) => item.name === name);
  assert.ok(found, `sheet ${name}`);
  return found;
};

test("the file has a read-me sheet and one sheet for every kind of record", () => {
  const names = customerDataSheets(file()).map((item) => item.name);
  assert.deepEqual(names, ["Read me", ...CUSTOMER_DATA_SECTIONS.map((section) => section.title)]);
});

test("a saved address keeps its map position in the file", () => {
  const { rows } = sheet("Saved addresses");
  assert.deepEqual(rows[0], ["Line", "Latitude", "Longitude", "Is Default"]);
  assert.deepEqual(rows[1], ["1 Test Road", "12.97", "77.55", "Yes"], "as text, so Excel doesn't round a map position");
});

test("an order's address becomes its own columns, and row ids stay out", () => {
  const { rows } = sheet("Orders");
  assert.deepEqual(rows[0], ["Order No", "Total", "Shipping Address Line", "Shipping Address Pin"]);
  assert.deepEqual(rows[1], ["GB-1", 1000, "1 Test Road", "560040"]);
  assert.deepEqual(flattenCustomerRow({ id: "x", order_id: "y", order_no: "GB-1" }), { order_no: "GB-1" });
});

test("the columns a person looks for come first, whatever order the database returns", () => {
  const { rows } = sheet("Saved addresses", file({ addresses: [{ pin: "560040", city: "Bengaluru", latitude: 12.97, line: "1 Test Road" }] }));
  assert.deepEqual(rows[0], ["Line", "City", "Pin", "Latitude"]);
});

test("a kind of record with nothing in it still has its sheet, saying so", () => {
  assert.deepEqual(sheet("Reviews").rows, [["Nothing held"]]);
  assert.deepEqual(sheet("Profile", file({ profile: null })).rows, [["Nothing held"]]);
});

test("the read-me counts each kind of record and points to the Zoho copy", () => {
  const { rows, boldRows } = sheet("Read me");
  const count = (title: string) => rows.find((row) => row[0] === title)?.[1];
  assert.equal(count("Orders"), 1);
  assert.equal(count("Reviews"), 0);
  assert.equal(count("Profile"), 1);
  assert.ok(rows.some((row) => String(row[0]).includes("Zoho contact ZC-1")));
  for (const row of boldRows!) assert.ok(rows[row]?.[0], `bold row ${row} is a heading`);
  assert.equal(rows[boldRows![2]!]![0], "What this file does not hold");
  assert.equal(rows[boldRows![3]!]![0], "Before sending this file to the customer");
});

test("the read-me says how many enquiries were left out, only when some were", () => {
  const mentions = (data: CustomerDataFile) => sheet("Read me", data).rows.some((row) => /other enquiries/i.test(String(row[0])));
  assert.equal(mentions(file()), false);
  assert.equal(mentions(file({ unproved_enquiries: 2 })), true);
  const { rows, boldRows } = sheet("Read me", file({ unproved_enquiries: 2 }));
  assert.equal(rows[boldRows![3]!]![0], "Before sending this file to the customer", "headings stay bold when a line is added");
});

test("values read as a person expects", () => {
  assert.equal(customerDataCell(null), "");
  assert.equal(customerDataCell(false), "No");
  assert.equal(customerDataCell(12.5), 12.5);
  assert.equal(customerDataCell(["terms", "privacy"]), "terms, privacy");
  assert.equal(customerDataCell({ a: { b: 1 } }), '{"a":{"b":1}}');
  assert.equal(customerDataCell("9000012345"), "9000012345", "a phone stays text");
  assert.equal(customerDataCell("2026-11-03T08:15:00.123456+00:00"), "3 Nov 2026, 1:45 pm IST");
  assert.equal(customerDataCell("2026-13-99T99:99:00"), "2026-13-99T99:99:00", "a bad date is left as it is");
});

test("the file name has no name or phone in it", () => {
  assert.equal(customerDataFileName(file()), "Customer_data_6f1c2d3e_2026-11-03.xlsx");
  assert.equal(customerDataFileName(file({ generated_at: "2026-11-03T20:30:00+00:00" })), "Customer_data_6f1c2d3e_2026-11-04.xlsx", "the Indian date, as the file says inside");
});

test("the workbook builds, and text from a customer cannot run as a formula or break the file", () => {
  const data = file({ reviews: [{ title: '=HYPERLINK("http://x","<click> & win")' }] });
  const sheets = customerDataSheets(data);
  assert.ok(buildXlsx(sheets).length > 1000);
  const parts = xlsxParts(sheets);
  const xml = parts.map(([, text]) => text).find((text) => text.includes("HYPERLINK"))!;
  assert.ok(xml.includes('t="inlineStr"') && !xml.includes("<f>"), "stored as text, never as a formula");
  assert.ok(xml.includes("&lt;click&gt; &amp; win"));
});

test("every reason the database gives for refusing a delete has its own wording", () => {
  const fallback = deletionBlockerText("something new");
  assert.equal(fallback, "This customer cannot be deleted yet.");
  for (const code of ["other_login", "open_order", "unpaid_delivery", "money_not_refunded", "open_return", "unconfirmed_payment", "open_bank_money", "waiting_for_zoho", "zoho_busy", "not_in_zoho"]) {
    assert.notEqual(deletionBlockerText(code), fallback, code);
  }
});

test("the confirmation lists only what this customer has", () => {
  const plan: DeletionPlan = {
    removed: { addresses: 2, preferences: 0, reviews: 1, enquiries_by_phone: 1, orders_cleared: 3 },
    kept: { orders: 1, invoices: 0, returns: 2 },
    kept_orders: ["GB-1"], cleared_orders: [], zoho_contacts: [], unproved_enquiries: 0,
  };
  assert.deepEqual(removedLines(plan).map((line) => line.count), [2, 1, 3]);
  assert.ok(removedLines(plan).every((line) => !/by_phone/.test(line.text)), "the phone count is a note, not a line of its own");
  assert.deepEqual(keptLines(plan).map((line) => [line.text, line.count]), [
    ["Paid, delivered or refunded orders, with name, address and GSTIN", 1],
    ["Returns", 2],
  ]);
});

test("the panel, its confirmation and every reason read in Kannada", async () => {
  await loadKannada();
  const plan: DeletionPlan = {
    removed: { addresses: 1, preferences: 1, reviews: 1, enquiries: 1, notifications: 1, admin_notes: 1, seller_applications: 1, seller_documents: 1, orders_cleared: 1 },
    kept: { orders: 1, invoices: 1, payments: 1, payment_references: 1, returns: 1, bank_receipts: 1, zoho_invoices: 1, terms_accepted: 1, partner_commissions: 1, delivery_notes: 1 },
    kept_orders: [], cleared_orders: [], zoho_contacts: [], unproved_enquiries: 0,
  };
  const screen = [
    "Information Requests",
    "Use this when a customer asks to see or delete the information we hold on them.",
    "Download all their information",
    "Preparing the file…",
    "Delete their information",
    "The Excel file holds their profile, saved addresses with map positions, orders, payments, enquiries, reviews, returns and notifications.",
    "Zoho is not changed.",
    "Zoho keeps its own copy of any contact, sales orders and invoices it has for this customer, and the admin panel's Zoho sales order list shows them again when it next refreshes.",
    "Zoho contact:",
    "This customer's information has been deleted, but their login could not be removed.",
    "Try removing the login again",
    "Removing…",
    "The file has been downloaded",
    "Could not download the information",
    "The customer's login has been removed",
    "Their login could not be removed",
    "By",
    "No information requests yet",
    "Information downloaded",
    "Information deleted",
    "Information deleted, login still to remove",
    "The record of information requests could not be loaded.",
    "Delete this customer's information?",
    "Checking what can be deleted…",
    "Could not check this customer:",
    "This cannot be deleted yet",
    "This customer cannot be deleted yet.",
    "This person also has a seller, partner, staff or admin login. Those have their own records, so they cannot be deleted from here.",
    "These orders are still open. Finish or cancel them first.",
    "These orders were delivered but are not fully paid. Record the payment first.",
    "These orders were cancelled with money not refunded. Refund it first.",
    "These orders have a return or refund still open. Close it first.",
    "These orders have a payment reference still open. Close it in UPI & Bank Payments first.",
    "These orders have money in the bank account still to be sorted out. Refund it or place the order, then mark it settled.",
    "This customer is being sent to Zoho right now. Try again in a minute.",
    "These orders are still going to Zoho or need a review in Zoho Sync. Clear that first.",
    "These delivered orders have not reached Zoho yet. Send them first, so the sales records are complete.",
    "Removed for good",
    "Kept",
    "Login and profile",
    "Saved addresses and map positions",
    "Preferences",
    "Messages sent to them",
    "Admin notes about them",
    "Seller applications",
    "Uploaded seller documents",
    "Unpaid orders: name, phone, GSTIN and address cleared",
    "Paid, delivered or refunded orders, with name, address and GSTIN",
    "Payment references (UTR)",
    "Partner commissions",
    "No sales records to keep.",
    "Sales records may have to be kept by law. Phone and email come off them. They stay until the owner sets an end date.",
    "This cannot be undone. If the customer asked for a copy, download it first.",
    "Type DELETE to confirm",
    "Deleting…",
    "The customer's information has been deleted",
    ...["other_login", "open_order", "unpaid_delivery", "money_not_refunded", "open_return", "unconfirmed_payment", "open_bank_money", "waiting_for_zoho", "zoho_busy", "not_in_zoho", "new"].map(deletionBlockerText),
    ...removedLines(plan).map((line) => line.text),
    ...keptLines(plan).map((line) => line.text),
  ];
  const brandWords = /\b(Zoho Sync|Zoho|Excel|GSTIN|UTR|UPI|DELETE)\b/g;
  for (const text of screen) {
    const out = translateText(text, "kn").replace(brandWords, "");
    assert.ok(!/[A-Za-z]/.test(out), `no Kannada for "${text}": ${out}`);
  }
  const left = translateText("Other enquiries that use a phone or email from their profile or orders: 2. We can't tell they are theirs, so they stay. Check them in Admin > Enquiries.", "kn");
  assert.ok(left.includes("2") && !/[A-Za-z]/.test(left), left);
});
