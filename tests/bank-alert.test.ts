import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBankCredit, smsFromPayload } from "../src/lib/bank-alert.ts";

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
