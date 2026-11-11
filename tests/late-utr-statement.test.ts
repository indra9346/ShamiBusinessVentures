import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractRefs, matchStatement, parseAmount, parseCsv, sameRef, statementCredits, statementDate, statementMethod } from "../src/lib/bank-statement.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// 12 Nov 2026, the owner: late UTRs, partner UTRs, and matching the company bank statement. The admin confirms everything.

const IDFC_LIKE = [
  "IDFC FIRST Bank,,,,,",
  "Account Statement for 1234XXXX5678,,,,,",
  "Transaction Date,Value Date,Particulars,Cheque No.,Debit,Credit,Balance",
  '11-Nov-2026,11-Nov-2026,"UPI/CR/612345678901/SAMPLE CUSTOMER/YESB/sample@ybl/Grain Bazar CLK",,,"1,300.00","1,51,300.00"',
  "11-Nov-2026,11-Nov-2026,NEFT-HDFCN52026111212345-SAMPLE TRADERS,,,2835.00,154135.00",
  "11-Nov-2026,11-Nov-2026,IMPS/P2A/731234567890/SAMPLE,,,1450.00,155585.00",
  "11-Nov-2026,11-Nov-2026,ATM WDL,,500.00,,155085.00",
  "11-Nov-2026,11-Nov-2026,UPI/CR/812345678901/SOMEONE/xyz,,,999.00,156084.00",
].join("\n");

test("a statement is read: the heading row is found, only credits, with their UTRs", () => {
  const { credits, problem } = statementCredits(parseCsv(IDFC_LIKE));
  assert.equal(problem, null);
  assert.equal(credits.length, 4, "the debit is skipped");
  assert.deepEqual(credits.map((c) => c.amount), [1300, 2835, 1450, 999]);
  assert.deepEqual(credits[0]!.refs, ["612345678901"]);
  assert.deepEqual(credits[1]!.refs, ["HDFCN52026111212345"]);
  assert.equal(credits[0]!.method, "UPI"); assert.equal(credits[1]!.method, "NEFT"); assert.equal(credits[2]!.method, "IMPS");
  assert.equal(credits[0]!.row, 4, "the spreadsheet row, for the admin to find it");
});

test("other statement shapes: Amount with Cr/Dr, semicolons, Excel dates, Indian amounts", () => {
  const rows = parseCsv("Date;Description;Amount;Dr/Cr;Ref No\n45972;UPI credit;250.50;CR;912345678901\n45972;Charges;20;DR;\n");
  const { credits } = statementCredits(rows);
  assert.equal(credits.length, 1);
  assert.equal(credits[0]!.amount, 250.5); assert.deepEqual(credits[0]!.refs, ["912345678901"]);
  assert.equal(credits[0]!.date, "2025-11-11", "Excel day 45972");
  assert.equal(statementDate("11-Nov-2026"), "11-Nov-2026");
  assert.equal(parseAmount("₹ 1,51,300.00"), 151300); assert.ok(Number.isNaN(parseAmount("abc")));
  assert.match(statementCredits([["Name", "Value"], ["a", "1"]]).problem!, /Could not find the columns/);
  assert.equal(statementMethod("RTGS/UTIBR52026111200012345"), "RTGS");
  assert.deepEqual(extractRefs("NEFT-SBINN52026111299887766-ABC 2026 12345"), ["SBINN52026111299887766"], "short numbers and words are not references");
  assert.equal(sameRef("612345678901", "UPI/612345678901"), true);
  assert.equal(sameRef("hdfcn52026111212345", "HDFCN52026111212345"), true);
  assert.equal(sameRef("612345678901", "612345678902"), false);
});

test("matching: UTR first, then a single checkout of the same amount; nothing is confirmed by it", () => {
  const { credits } = statementCredits(parseCsv(IDFC_LIKE));
  const now = Date.parse("2026-11-12T10:00:00+05:30");
  const sent = [
    { orderNo: "CLK-1", utr: "612345678901", amount: 1300, status: "submitted" },
    { orderNo: "CLK-2", utr: "HDFCN52026111212345", amount: 2835, status: "submitted", late: true },
    { orderNo: "CLK-9", utr: "000000000000", amount: 5, status: "confirmed" },
  ];
  const checkouts = [
    { orderNo: "CLK-1", amount: 1300, status: "Awaiting Payment", createdAt: "2026-11-12T09:00:00+05:30", method: "UPI", hasUtr: true },
    { orderNo: "CLK-3", amount: 1450, status: "Awaiting Payment", createdAt: "2026-11-12T09:00:00+05:30", method: "UPI", hasUtr: false },
    { orderNo: "CLK-4", amount: 999, status: "Awaiting Payment", createdAt: "2026-11-12T09:00:00+05:30", method: "UPI", hasUtr: false },
    { orderNo: "CLK-5", amount: 999, status: "Payment Expired", createdAt: "2026-11-11T09:00:00+05:30", method: "UPI", hasUtr: false },
    { orderNo: "CLK-OLD", amount: 1450, status: "Payment Expired", createdAt: "2026-10-01T09:00:00+05:30", method: "UPI", hasUtr: false },
  ];
  const result = matchStatement(credits, sent, checkouts, [], now);
  assert.deepEqual(result.map((m) => m.kind), ["utr", "utr", "amount", "several"]);
  assert.equal(result[0]!.kind === "utr" && result[0]!.orderNo, "CLK-1");
  assert.equal(result[1]!.kind === "utr" && result[1]!.late, true, "a late UTR: confirming places it again");
  assert.equal(result[2]!.kind === "amount" && result[2]!.orderNo, "CLK-3", "an ended checkout from October is too old");
  assert.equal(result[2]!.kind === "amount" && result[2]!.method, "IMPS");
  assert.deepEqual(result[3]!.kind === "several" && result[3]!.orderNos, ["CLK-4", "CLK-5"]);
  // Already recorded, or a different amount for the same UTR.
  assert.equal(matchStatement(credits.slice(0, 1), sent, checkouts, ["UTR 612345678901"], now)[0]!.kind, "already");
  const wrong = matchStatement(credits.slice(0, 1), [{ orderNo: "CLK-1", utr: "612345678901", amount: 1200, status: "submitted" }], [], [], now)[0]!;
  assert.equal(wrong.kind, "amount_differs");
});

test("the screens are wired", () => {
  const admin = readFileSync("src/routes/admin.upi-payments.tsx", "utf8");
  assert.match(admin, /<BankStatementPanel submissions=\{submissions\} \/>/);
  assert.match(admin, /if \(late\) \{\s*await placeEndedCheckout\(orderNo, utr, null, checkedNote\);/);
  assert.match(admin, /<EndedCheckouts submissions=\{submissions\} \/>/);
  const ended = readFileSync("src/components/panel/EndedCheckouts.tsx", "utf8");
  assert.match(ended, /<RecordLatePaymentDialog /);
  const held = readFileSync("src/components/site/HeldCheckoutPay.tsx", "utf8");
  assert.match(held, /<SendUtrForm className="mt-3" orderNo=\{orderNo\}/);
  const mine = readFileSync("src/routes/account.orders.tsx", "utf8");
  assert.match(mine, /<SendUtrForm className="mt-2" orderNo=\{hold\.orderNo\}/);
  const partner = readFileSync("src/routes/partner.index.tsx", "utf8");
  assert.match(partner, /<PartnerPaymentsPanel \/>/);
  const store = readFileSync("src/lib/upi-store.ts", "utf8");
  assert.match(store, /supabase\.rpc\("submit_utr_for_order"/);
  assert.match(store, /supabase\.rpc\("admin_place_ended_checkout"/);
  assert.match(store, /supabase\.rpc\("partner_payment_checkouts"\)/);
});

test("every new line has its Kannada", () => {
  const sql = readFileSync("supabase/migrations/20261112090000_late_and_partner_utrs.sql", "utf8");
  const said = [...sql.matchAll(/RAISE EXCEPTION '((?:[^']|'')+)'/g)].map((m) => m[1]!);
  assert.ok(said.length > 15);
  for (const raw of said) {
    let slot = 0;
    const text = raw.replace(/''/g, "'").replace(/%s|%/g, () => `{${slot++}}`);
    if (!text.includes(" ") || text.startsWith("{")) continue;
    assert.ok(kn[text], text);
  }
  const { problem } = statementCredits([["x"]]);
  for (const key of [
    problem!, "The statement has no credits (money received) in it.",
    "Paid already? Send the UTR", "Checking UTR {0} with our bank", "Record payment", "Record payment for {0}?", "Record payment and place order",
    "Confirm & place order", "Paid after the checkout ended: confirming places the order again if the stock is there", "Sent by the godown's channel partner",
    "Match with a bank statement", "Choose statement file", "{0} credits read from {1}", "Confirm all UTR matches ({0})", "UTR {0} sent for {1}{2}",
    "(after its time ran out: confirming places it again)", "Same amount as {0}, which has no UTR. Check the name before recording it.", "Record for {0}",
    "Customer payments", "Customer paid? Send the UTR", "UTR {0} is with our office for a check.", "Payment being checked",
    "This is not an .xlsx file. Open it in Excel and save it as .xlsx or CSV, or download the statement as CSV.",
    "This is an old Excel file (.xls). Open it in Excel and save it as .xlsx or CSV, or download the statement as CSV.",
  ]) assert.ok(kn[key], key);
});
