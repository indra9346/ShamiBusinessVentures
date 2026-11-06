import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBankCredit, smsFromPayload, parseCreditWithoutReference } from "../src/lib/bank-alert.ts";

const credit = (amount: number, utr: string) => ({ amount, utr });
const read = (sms: string) => {
  const parsed = parseBankCredit(sms);
  return parsed && { amount: parsed.amount, utr: parsed.utr };
};

test("credit alerts of the main Indian banks give the amount and the UTR", () => {
  const samples: Array<[string, string]> = [
    ["SBI", "Dear UPI user A/C X1234 credited by 2518.95 on date 27Oct26 trf to KIRAN K Refno 612345678901. If not u? call 1800111109. -SBI"],
    ["HDFC", "Money Received - INR 2,518.95 in your HDFC Bank A/c xx1234 on 27-10-26 from VPA kiran.k@okaxis (UPI 612345678901)"],
    ["HDFC old", "Rs.2518.95 credited to HDFC Bank A/c XX1234 on 27-10-26 from VPA kiran@ybl (UPI Ref No 612345678901)"],
    ["ICICI", "ICICI Bank Account XX123 credited:Rs. 2,518.95 on 27-Oct-26. Info UPI-612345678901-KIRAN K. Available Balance is Rs. 1,04,210.50."],
    ["Axis", "INR 2518.95 credited to A/c no. XX1234 on 27-10-26 at 14:32:11 IST. Info- UPI/P2A/612345678901/KIRAN K. Avl Bal INR 50,000.00 - Axis Bank"],
    ["Kotak", "Received Rs.2518.95 in your Kotak Bank A/c X1234 from kiran@okicici on 27-10-26.UPI Ref:612345678901."],
    ["Canara", "An amount of INR 2,518.95 has been CREDITED to your account XXX123 on 27/10/2026 towards UPI Ref 612345678901. Total Avail.bal INR 5,000.00 - Canara Bank"],
    ["Union", "A/c *1234 Credited for Rs:2518.95 on 27-10-2026 14:32:11 by Mob Bk ref no 612345678901 Avl Bal Rs:12500.00.Never Share OTP-Union Bank of India"],
    ["BoB", "Rs.2518.95 Credited to A/c ...1234 thru UPI/612345678901 by kiran@ybl. Total Bal:Rs.9000.00CR. Avlbl Amt:Rs.9000.00(27-10-2026 14:32:11) - Bank of Baroda"],
  ];
  for (const [bank, sms] of samples) assert.deepEqual(read(sms), credit(2518.95, "612345678901"), bank);
});

test("the payer's UPI ID is kept when the bank shows it", () => {
  assert.equal(parseBankCredit("Rs.2518.95 credited to HDFC Bank A/c XX1234 on 27-10-26 from VPA kiran@ybl (UPI 612345678901)")?.payer, "kiran@ybl");
});

test("debits, OTPs and promotions are ignored", () => {
  for (const sms of [
    "Dear UPI user A/C X1234 debited by 100.0 on date 27Oct26 trf to SHOP Refno 612345678902. If not u? call 1800111109. -SBI",
    "Sent Rs.100.00 From HDFC Bank A/C x1234 To shop@ybl On 27/10/26 Ref 612345678903 Not You? Call 18002586161",
    "ICICI Bank Acct XX123 debited for Rs 500.00 on 27-Oct-26; KIRAN credited. UPI:612345678904.",
    "123456 is your OTP for the transaction of Rs.2518.95. Do not share it with anyone.",
    "Get a pre-approved loan of Rs 5,00,000 today! Click the link.",
  ]) assert.equal(parseBankCredit(sms), null, sms);
});

test("a credit without a clear amount or UTR is not guessed", () => {
  assert.equal(parseBankCredit("Your a/c is credited. Ref 1234."), null);
  // Two different 12-digit numbers and no label: unclear which is the UTR.
  assert.equal(parseBankCredit("Rs 500 credited 111122223333 444455556666"), null);
});

test("the balance is never mistaken for the payment", () => {
  assert.equal(parseBankCredit("Avl Bal Rs 99,000.00. Rs 1,250.50 credited to your a/c. UPI Ref 612345678905")?.amount, 1250.5);
});

test("forwarded payloads: JSON, form data or the plain text", () => {
  const sms = "Rs.10 credited UPI Ref 612345678901";
  assert.deepEqual(smsFromPayload(JSON.stringify({ from: "AX-HDFCBK", text: sms })), { text: sms, sender: "AX-HDFCBK" });
  assert.deepEqual(smsFromPayload(JSON.stringify({ message: sms })), { text: sms, sender: null });
  assert.deepEqual(smsFromPayload(new URLSearchParams({ sender: "VM-SBIUPI", body: sms }).toString()), { text: sms, sender: "VM-SBIUPI" });
  assert.deepEqual(smsFromPayload(sms), { text: sms, sender: null });
});

test("digits inside a longer token are not a UPI reference", () => {
  assert.equal(parseBankCredit("INR 80,000.00 credited to your A/c XX1234 on 02/11/2026 through NEFT with UTR SBIN226306123456 by RAMESH"), null);
  assert.equal(parseBankCredit("Rs.80000.00 credited to a/c XX12 NEFT Ref SBIN322215123456"), null);
  assert.equal(parseBankCredit("NEFT Cr-SBIN0000123-RAMESH-SBIN422215123456 Rs 5,000 credited"), null);
  assert.equal(parseBankCredit("Rs 5,000 credited to A/c XX123456789012AB"), null);
});

test("a whole 12-digit reference still reads, also an IMPS one", () => {
  assert.equal(parseBankCredit("Rs 5,000 credited to A/c XX12 by IMPS Ref 330612345678")?.utr, "330612345678");
  assert.equal(parseBankCredit("Rs 5,000 credited to A/c XX12 IMPS330612345678")?.utr, "330612345678");
  assert.equal(parseBankCredit("Rs 5,000 received in A/c XX12. UPI/P2A/612345678901/RAMESH")?.utr, "612345678901");
});

// IDFC FIRST Bank's credit SMS, as received on the company phone on 6 Nov 2026: no UTR at all.
const idfc = {
  company: "Your A/C XXXXX000900 is credited with INR 2,484.00 on 06/11/26 14:21. Your new balance is INR 4,51,961.38. Team IDFC FIRST Bank",
  other: "Your A/C XXXXX354536 is credited with INR 600.00 on 06/11/26 15:19. Your new balance is INR 18,25,825.69. Team IDFC FIRST Bank",
  small: "Your A/C XXXXX692557 is credited with INR 64.00 on 06/11/26 15:10. Your new balance is INR 7,50,909.84. Team IDFC FIRST Bank",
};

test("an IDFC FIRST credit has no UTR, so it never confirms a payment by itself", () => {
  for (const sms of Object.values(idfc)) assert.equal(parseBankCredit(sms), null);
});

test("an IDFC FIRST credit is read for an admin to match: amount, account, bank time, balance", () => {
  assert.deepEqual(parseCreditWithoutReference(idfc.company), { amount: 2484, accountEnding: "000900", creditedAt: "2026-11-06T14:21:00+05:30", balance: 451961.38 });
  assert.deepEqual(parseCreditWithoutReference(idfc.other), { amount: 600, accountEnding: "354536", creditedAt: "2026-11-06T15:19:00+05:30", balance: 1825825.69 });
  assert.equal(parseCreditWithoutReference(idfc.small)?.amount, 64);
});

test("a debit, a credit with a UTR, or one with no account is not a credit without a reference", () => {
  assert.equal(parseCreditWithoutReference("Your A/C XXXXX354536 is debited with INR 236.00 on 06/11/26 12:39. Your new balance is INR 18,25,225.69. Team IDFC FIRST Bank"), null);
  assert.equal(parseCreditWithoutReference("Rs.2484.00 credited to A/c XX0900 by UPI Ref No 612345678901 on 06-11-26. -IDFC FIRST Bank"), null);
  assert.ok(parseBankCredit("Rs.2484.00 credited to A/c XX0900 by UPI Ref No 612345678901 on 06-11-26. -IDFC FIRST Bank"));
  assert.equal(parseCreditWithoutReference("INR 2,484.00 is credited to your account on 06/11/26. Team IDFC FIRST Bank"), null);
  assert.equal(parseCreditWithoutReference("Your A/C XXXXX000900 has a new statement. Team IDFC FIRST Bank"), null);
});

test("other banks' wording without a UTR is read too, the time only when the SMS gives one", () => {
  assert.deepEqual(parseCreditWithoutReference("Dear Customer, A/c no. XX4521 credited with Rs.1,000.50 on 07-11-2026. Avl Bal Rs.12,345.00"),
    { amount: 1000.5, accountEnding: "4521", creditedAt: "2026-11-07T00:00:00+05:30", balance: 12345 });
});
