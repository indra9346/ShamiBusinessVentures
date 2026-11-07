/**
 * Which Zoho Books bank or cash account each godown's website payments are deposited to.
 *
 * Kept in the private setting `zoho_deposit_accounts` (admins only; never sent to shoppers, since account
 * names carry account numbers), as `{ godowns: { "BR-CLK": { accountId, accountName, setAt, setBy } } }`.
 * A godown with no account keeps Zoho's own choice: the payment is posted without `account_id` and
 * Zoho Books puts it in Undeposited Funds, as before. Only payments posted after a choice is saved
 * use it; payments already in Zoho are never moved.
 */
export const DEPOSIT_ACCOUNTS_KEY = "zoho_deposit_accounts";

export type DepositAccount = { accountId: string; accountName: string; setAt: string; setBy: string };
/** Godown (branch id) -> the account its payments are deposited to. */
export type DepositAccounts = Record<string, DepositAccount>;

/** A Zoho Books account a payment can be deposited to (from GET /books/v3/bankaccounts). */
export type ZohoDepositAccountOption = { id: string; name: string; type: "bank" | "cash"; bankName: string };

type Row = Record<string, unknown>;
const plain = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
/** Zoho ids are digits only; anything else is not an account id. */
const isZohoId = (value: string) => /^\d{6,30}$/.test(value);

/** The saved choices; anything malformed is left out, so it can never send a wrong account id. */
export function parseDepositAccounts(value: unknown): DepositAccounts {
  const godowns = plain(plain(value)["godowns"]);
  const accounts: DepositAccounts = {};
  for (const [branchId, raw] of Object.entries(godowns)) {
    const entry = plain(raw);
    const accountId = text(entry["accountId"]);
    if (!branchId || !isZohoId(accountId)) continue;
    accounts[branchId] = { accountId, accountName: text(entry["accountName"]) || accountId, setAt: text(entry["setAt"]), setBy: text(entry["setBy"]) };
  }
  return accounts;
}

/** The value to save after choosing `account` for a godown, or clearing it (null: back to Undeposited Funds). */
export function withDepositAccount(current: DepositAccounts, branchId: string, account: DepositAccount | null) {
  const godowns: DepositAccounts = { ...current };
  if (account) godowns[branchId] = account;
  else delete godowns[branchId];
  return { godowns };
}

/** The account for one godown's payments, or null to leave the choice to Zoho (Undeposited Funds). */
export function depositAccountFor(accounts: DepositAccounts, branchId: string | null | undefined): DepositAccount | null {
  return branchId ? accounts[branchId] ?? null : null;
}

/**
 * The godown an order's payment belongs to: the order's own godown, else the one godown linked to the
 * Zoho location of its sales order. Two godowns on one location, or none, give no answer (Zoho's default).
 */
export function godownOfPayment(
  orderBranchId: string | null | undefined,
  zohoLocationId: string,
  godowns: { id: string; zohoLocationId: string }[],
): string | null {
  if (orderBranchId) return orderBranchId;
  if (!zohoLocationId) return null;
  const matches = godowns.filter((godown) => godown.zohoLocationId === zohoLocationId);
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * Accounts a godown can deposit to: Zoho's active bank and cash accounts. Undeposited Funds is left out
 * (choosing nothing means that already), as are credit cards and payment-gateway clearing accounts.
 * Banks first, then by name.
 */
export function zohoDepositAccountOptions(rows: unknown[]): ZohoDepositAccountOption[] {
  const options: ZohoDepositAccountOption[] = [];
  for (const raw of rows) {
    const row = plain(raw);
    const id = text(row["account_id"]);
    const name = text(row["account_name"]);
    const type = text(row["account_type"]).toLowerCase();
    if (!isZohoId(id) || !name || row["is_active"] === false) continue;
    if (type !== "bank" && type !== "cash") continue;
    if (/^undeposited funds$/i.test(name)) continue;
    options.push({ id, name, type, bankName: text(row["bank_name"]) });
  }
  return options.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "bank" ? -1 : 1));
}

/** "ok": the chosen account is still an active Zoho account; "gone": closed, switched off or deleted in Zoho; "none": nothing chosen. */
export function depositAccountState(chosen: DepositAccount | null, options: ZohoDepositAccountOption[] | null): "ok" | "gone" | "none" | "unknown" {
  if (!chosen) return "none";
  if (!options) return "unknown";
  return options.some((option) => option.id === chosen.accountId) ? "ok" : "gone";
}

export type PaymentToPost = { amount: number; reference: string; date: string; mode: string; method: string };

/** The Zoho Books customer payment for one website payment; `account_id` only when the godown has an account. */
export function zohoCustomerPaymentBody(
  payment: PaymentToPost,
  input: { customerId: string; invoiceId: string; orderNo: string },
  account: DepositAccount | null,
): Record<string, unknown> {
  return {
    customer_id: input.customerId,
    payment_mode: payment.mode,
    amount: payment.amount,
    date: payment.date,
    reference_number: payment.reference,
    description: `Grain Bazar order ${input.orderNo} · ${payment.method || "website payment"} · UTR ${payment.reference}`,
    invoices: [{ invoice_id: input.invoiceId, amount_applied: payment.amount }],
    ...(account ? { account_id: account.accountId } : {}),
  };
}

/** What to tell the office when Zoho refuses a payment that named the godown's account. */
export function depositAccountHint(message: string, account: DepositAccount | null) {
  if (!account || !/account/i.test(message)) return "";
  return ` This godown's payments go to Zoho account "${account.accountName}". If that account was closed or switched off in Zoho Books, choose another in Admin > Payments & Matching, then Retry.`;
}
