/*
 * Reads a bank's "money received" SMS (forwarded by the company phone to /api/payments/bank-alert)
 * into the amount and the 12-digit UPI reference (UTR / RRN). Pure: no I/O, so it is unit-tested
 * against the wording of the big Indian banks. Anything that is not clearly a credit with both an
 * amount and a UTR is ignored, never guessed.
 */

export type BankCredit = { amount: number; utr: string; payer: string | null };

const DEBIT = /\b(debited|debit(?:ed)? for|sent|withdrawn|spent|paid to|transferred to|purchase)\b/i;
const CREDIT = /\b(credited|received|deposited|credit(?:ed)? to|cr\.?\s*(?:to|in)\b|money received|has been added)\b/i;
const AMOUNT = /(?:(?:rs|inr)\.?:?\s*|₹\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const BARE_AMOUNT = /\bcredit(?:ed)?\s+(?:by|with|for)\s+(?:(?:rs|inr)\.?:?\s*|₹\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const BALANCE_BEFORE = /(bal(?:ance)?|avl|avail(?:able)?)[^0-9]{0,18}$/i;
// A reference stands on its own: digits inside a longer token (NEFT UTR SBIN422215123456, an account number) are not one.
const UTR_AFTER_LABEL = /(?:utr|rrn|ref(?:erence)?\.?\s*(?:no|number)?|refno|upi\s*ref(?:\s*no)?|upi|imps|txn\s*(?:id|no)?|transaction\s*(?:id|no))\s*[.:#\-/]*\s*(?:no\.?\s*)?[:\-]?\s*([0-9]{12})(?![0-9A-Za-z])/i;
const LONE_12_DIGITS = /(?<![0-9A-Za-z])([0-9]{12})(?![0-9A-Za-z])/g;
const VPA = /\b([a-z0-9._-]{2,64}@[a-z]{2,32})\b/i;

/** "2,518.95" → 2518.95 (paise kept exactly). */
function toAmount(text: string): number | null {
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

/** The credited amount: the first rupee figure that is not an account balance. */
function creditedAmount(sms: string): number | null {
  const bare = BARE_AMOUNT.exec(sms);
  if (bare?.[1]) return toAmount(bare[1]);
  for (const match of sms.matchAll(AMOUNT)) {
    const before = sms.slice(0, match.index ?? 0);
    if (BALANCE_BEFORE.test(before)) continue;
    const amount = toAmount(match[1] ?? "");
    if (amount !== null) return amount;
  }
  return null;
}

/** The UPI reference: one labelled as UTR / Ref / RRN / UPI, or else the only 12-digit number in the message. */
function upiReference(sms: string): string | null {
  const labelled = UTR_AFTER_LABEL.exec(sms);
  if (labelled?.[1]) return labelled[1];
  // UPI/P2A/612345678901/NAME style.
  const slashed = /\bupi\/(?:[a-z0-9]+\/)?([0-9]{12})(?![0-9A-Za-z])/i.exec(sms);
  if (slashed?.[1]) return slashed[1];
  const all = [...sms.matchAll(LONE_12_DIGITS)].map((match) => match[1]!);
  const unique = [...new Set(all)];
  return unique.length === 1 ? unique[0]! : null;
}

export function parseBankCredit(raw: string): BankCredit | null {
  const sms = raw.replace(/\s+/g, " ").trim();
  if (!sms || !CREDIT.test(sms)) return null;
  // A debit alert often names the other side as "credited"; any debit wording means it is not ours.
  if (DEBIT.test(sms)) return null;
  const amount = creditedAmount(sms);
  const utr = upiReference(sms);
  if (amount === null || !utr) return null;
  return { amount, utr, payer: VPA.exec(sms)?.[1] ?? null };
}

export type CreditWithoutReference = {
  amount: number;
  /** The last digits of the account the bank names ("A/C XXXXX000900" → "000900"). */
  accountEnding: string;
  /** The bank's time from the SMS, as an ISO time in India, or null when it gives none. */
  creditedAt: string | null;
  balance: number | null;
};

// A masked account number: "A/C XXXXX000900", "A/c no. XX0905", "Account **4521".
const MASKED_ACCOUNT = /\ba\/?c(?:count)?\.?(?:\s*no\.?)?\s*[:\-]?\s*[x*]{2,}\s*([0-9]{3,6})(?![0-9])/i;
// "on 06/11/26 14:21" or "on 06-11-2026 at 2:21": the bank's date and time.
const CREDIT_TIME = /\bon\s+([0-3]?[0-9])[/-]([01]?[0-9])[/-]([0-9]{4}|[0-9]{2})(?![0-9])(?:\s+(?:at\s+)?([0-2]?[0-9]):([0-5][0-9]))?/i;
const BALANCE = /\b(?:new\s+|avl\.?\s+|available\s+)?bal(?:ance)?\.?\s*(?:is\s*)?[:\-]?\s*(?:(?:rs|inr)\.?:?\s*|₹\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;

function creditTime(sms: string): string | null {
  const match = CREDIT_TIME.exec(sms);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = match[4] !== undefined ? `${pad(Number(match[4]))}:${match[5]}` : "00:00";
  if (Number(time.slice(0, 2)) > 23) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}T${time}:00+05:30`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * A "money received" SMS that names the account but carries no UTR, such as IDFC FIRST Bank's "Your A/C XXXXX000900 is
 * credited with INR 2,484.00 on 06/11/26 14:21. Your new balance is INR 4,51,961.38". It can't confirm a payment by
 * itself: the server keeps it only for the company's own account, for an admin to match to an order. Null for a debit,
 * an SMS with a UTR (parseBankCredit takes those), or one without an amount or a masked account number.
 */
export function parseCreditWithoutReference(raw: string): CreditWithoutReference | null {
  const sms = raw.replace(/\s+/g, " ").trim();
  if (!sms || !CREDIT.test(sms) || DEBIT.test(sms)) return null;
  if (upiReference(sms)) return null;
  const account = MASKED_ACCOUNT.exec(sms)?.[1];
  const amount = creditedAmount(sms);
  if (!account || amount === null) return null;
  const balanceText = BALANCE.exec(sms)?.[1];
  return { amount, accountEnding: account, creditedAt: creditTime(sms), balance: balanceText ? toAmount(balanceText) : null };
}

/**
 * The text of a forwarded SMS from whatever the forwarding app sends: JSON with a message-like
 * field (text, message, body, sms, msg, content), form data with one, or the plain body.
 */
export function smsFromPayload(body: string): { text: string; sender: string | null } {
  const pick = (record: Record<string, unknown>) => {
    const field = (names: string[]) => {
      for (const name of names) {
        const value = record[name];
        if (typeof value === "string" && value.trim()) return value;
      }
      return null;
    };
    return { text: field(["text", "message", "body", "sms", "msg", "content"]), sender: field(["from", "sender", "address", "phone", "number"]) };
  };
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const { text, sender } = pick(parsed as Record<string, unknown>);
      if (text) return { text, sender };
    }
  } catch {
    // not JSON
  }
  if (/^[^\s=&]+=/.test(body)) {
    const { text, sender } = pick(Object.fromEntries(new URLSearchParams(body).entries()));
    if (text) return { text, sender };
  }
  return { text: body, sender: null };
}
