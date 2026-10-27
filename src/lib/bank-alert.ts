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
const UTR_AFTER_LABEL = /(?:utr|rrn|ref(?:erence)?\.?\s*(?:no|number)?|refno|upi\s*ref(?:\s*no)?|upi|txn\s*(?:id|no)?|transaction\s*(?:id|no))\s*[.:#\-/]*\s*(?:no\.?\s*)?[:\-]?\s*([0-9]{12})(?![0-9])/i;
const LONE_12_DIGITS = /(?<![0-9])([0-9]{12})(?![0-9])/g;
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
  const slashed = /\bupi\/(?:[a-z0-9]+\/)?([0-9]{12})(?![0-9])/i.exec(sms);
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
