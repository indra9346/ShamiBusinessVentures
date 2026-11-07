import { test } from "node:test";
import assert from "node:assert/strict";
import {
  depositAccountFor, depositAccountHint, depositAccountState, godownOfPayment, parseDepositAccounts, withDepositAccount,
  zohoCustomerPaymentBody, zohoDepositAccountOptions, type DepositAccount,
} from "../src/lib/deposit-accounts.ts";
import { loadKannada, translateText } from "../src/lib/i18n-core.ts";

await loadKannada();

// Shapes as Zoho Books returned them for organisation 60066526172 (GET /bankaccounts, 7 Nov 2026), trimmed.
const zohoList = [
  { account_id: "3579709000001644071", account_name: "IDFC - 50000000905", account_type: "bank", is_active: true, bank_name: "IDFC First Bank" },
  { account_id: "3579709000001644077", account_name: "IDFC-CLK - 60000000900", account_type: "bank", is_active: true, bank_name: "IDFC First Bank" },
  { account_id: "3579709000000000459", account_name: "Petty Cash", account_type: "cash", is_active: true, bank_name: "" },
  { account_id: "3579709000001912068", account_name: "SBI CLK - 50573", account_type: "bank", is_active: true, bank_name: "" },
  { account_id: "3579709000000000456", account_name: "Undeposited Funds", account_type: "cash", is_active: true, bank_name: "" },
  { account_id: "3579709000000133095", account_name: "Zoho Payments Clearing", account_type: "payment_clearing", is_active: true },
  { account_id: "3579709000000999001", account_name: "Old HDFC - 1234", account_type: "bank", is_active: false },
  { account_id: "3579709000000999002", account_name: "Company card", account_type: "credit_card", is_active: true },
];

const idfcClk: DepositAccount = { accountId: "3579709000001644077", accountName: "IDFC-CLK - 60000000900", setAt: "2026-11-07T12:00:00.000Z", setBy: "admin-1" };

test("only active bank and cash accounts can be chosen, banks first; Undeposited Funds, clearing and cards are left out", () => {
  const options = zohoDepositAccountOptions(zohoList);
  assert.deepEqual(options.map((option) => option.name), ["IDFC - 50000000905", "IDFC-CLK - 60000000900", "SBI CLK - 50573", "Petty Cash"]);
  assert.deepEqual(options.map((option) => option.type), ["bank", "bank", "bank", "cash"]);
  assert.deepEqual(zohoDepositAccountOptions([null, "x", { account_id: "abc", account_name: "Bad id", account_type: "bank" }]), []);
});

test("saved choices: malformed entries are dropped so a wrong account id is never sent", () => {
  assert.deepEqual(parseDepositAccounts(null), {});
  assert.deepEqual(parseDepositAccounts({ godowns: [] }), {});
  const parsed = parseDepositAccounts({
    godowns: {
      "BR-CLK": { accountId: "3579709000001644077", accountName: "IDFC-CLK - 60000000900", setAt: "2026-11-07T12:00:00.000Z", setBy: "admin-1" },
      "BR-HBL": { accountId: "IDFC-HBL", accountName: "typed by hand" },
      "BR-X": "3579709000001644077",
    },
  });
  assert.deepEqual(Object.keys(parsed), ["BR-CLK"]);
  assert.deepEqual(parsed["BR-CLK"], idfcClk);
});

test("choosing, changing and clearing a godown's account keeps the other godowns", () => {
  const sbi: DepositAccount = { accountId: "3579709000001912068", accountName: "SBI CLK - 50573", setAt: "t", setBy: "a" };
  const one = withDepositAccount({}, "BR-CLK", idfcClk);
  const two = withDepositAccount(parseDepositAccounts(one), "BR-HBL", sbi);
  assert.deepEqual(Object.keys(two.godowns).sort(), ["BR-CLK", "BR-HBL"]);
  const cleared = withDepositAccount(parseDepositAccounts(two), "BR-CLK", null);
  assert.deepEqual(Object.keys(cleared.godowns), ["BR-HBL"]);
  assert.equal(depositAccountFor(parseDepositAccounts(cleared), "BR-CLK"), null);
  assert.equal(depositAccountFor(parseDepositAccounts(cleared), "BR-HBL")?.accountName, "SBI CLK - 50573");
});

test("a payment belongs to the order's godown, else the one godown on its Zoho location", () => {
  const godowns = [{ id: "BR-CLK", zohoLocationId: "3579709000002947001" }, { id: "BR-HBL", zohoLocationId: "3579709000003110061" }];
  assert.equal(godownOfPayment("BR-HBL", "3579709000002947001", godowns), "BR-HBL");
  assert.equal(godownOfPayment(null, "3579709000002947001", godowns), "BR-CLK");
  assert.equal(godownOfPayment(null, "", godowns), null);
  assert.equal(godownOfPayment(null, "999", godowns), null);
  assert.equal(godownOfPayment(null, "1", [{ id: "A", zohoLocationId: "1" }, { id: "B", zohoLocationId: "1" }]), null);
  assert.equal(depositAccountFor({ "BR-CLK": idfcClk }, null), null);
});

const payment = { amount: 130, reference: "667714059208", date: "2026-11-07", mode: "Bank Transfer", method: "UPI" };
const ids = { customerId: "3579709000003400001", invoiceId: "3579709000003586001", orderNo: "CLK-577522-071126-161234" };

test("a godown with an account: the Zoho payment names it as Deposit To", () => {
  const body = zohoCustomerPaymentBody(payment, ids, idfcClk);
  assert.equal(body["account_id"], "3579709000001644077");
  assert.equal(body["amount"], 130);
  assert.equal(body["reference_number"], "667714059208");
  assert.deepEqual(body["invoices"], [{ invoice_id: ids.invoiceId, amount_applied: 130 }]);
});

test("a godown with no account: the payment is exactly as before, so Zoho uses Undeposited Funds", () => {
  assert.deepEqual(zohoCustomerPaymentBody(payment, ids, null), {
    customer_id: ids.customerId,
    payment_mode: "Bank Transfer",
    amount: 130,
    date: "2026-11-07",
    reference_number: "667714059208",
    description: "Grain Bazar order CLK-577522-071126-161234 · UPI · UTR 667714059208",
    invoices: [{ invoice_id: ids.invoiceId, amount_applied: 130 }],
  });
});

test("the panel warns when the chosen account is gone from Zoho", () => {
  const options = zohoDepositAccountOptions(zohoList);
  assert.equal(depositAccountState(idfcClk, options), "ok");
  assert.equal(depositAccountState({ ...idfcClk, accountId: "3579709000000999001" }, options), "gone");
  assert.equal(depositAccountState(null, options), "none");
  assert.equal(depositAccountState(idfcClk, null), "unknown");
});

test("a refusal about the account points the office to the setting; other refusals don't", () => {
  assert.match(depositAccountHint("Invalid value passed for account_id", idfcClk), /IDFC-CLK - 60000000900.*Payments & Matching/);
  assert.equal(depositAccountHint("Zoho Books customerpayments could not be reached", idfcClk), "");
  assert.equal(depositAccountHint("Invalid value passed for account_id", null), "");
});

test("the deposit-account panel reads in Kannada, account names kept as Zoho writes them", () => {
  assert.equal(translateText("Payments deposited to:", "kn"), "ಪಾವತಿಗಳು ಜಮೆಯಾಗುವ ಖಾತೆ:");
  assert.equal(translateText("Undeposited Funds (Zoho's default)", "kn"), "Undeposited Funds (Zoho ನ ಡೀಫಾಲ್ಟ್)");
  assert.match(translateText("IDFC-CLK - 60000000900 (no longer active in Zoho)", "kn"), /^IDFC-CLK - 60000000900 \(Zoho ನಲ್ಲಿ/);
  assert.match(translateText("New payments go to IDFC-CLK - 60000000900", "kn"), /^ಹೊಸ ಪಾವತಿಗಳು IDFC-CLK - 60000000900 ಗೆ/);
  assert.equal(translateText("Payments deposited to:", "en"), "Payments deposited to:");
});
