/*
 * Admin > UPI & Bank Payments > Match with a bank statement (12 Nov 2026, owner): the admin uploads the company bank
 * statement (CSV, or Excel .xlsx read by xlsx-read.ts), the website reads every credit's UTR and amount and matches them
 * with the UTRs customers and partners sent, and with checkouts of the same amount. It only suggests: each payment is
 * confirmed by the admin pressing Confirm (the existing confirm and place-again steps, with all their checks).
 * No framework imports, so the node tests run this file as it is.
 */

export type StatementCredit = { row: number; date: string; text: string; amount: number; refs: string[]; method: string | null };

/** CSV with quotes, any of , ; or tab as the separator (whichever the first lines use most). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const sample = clean.split(/\r?\n/).slice(0, 10).join("\n");
  const sep = [",", ";", "\t"].map((s) => ({ s, n: sample.split(s).length })).sort((a, b) => b.n - a.n)[0]!.s;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

const key = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");

/** An amount as banks write it: 1,23,456.78, ₹ 500, 500.00 Cr. Not a number gives NaN. */
export function parseAmount(text: string) {
  const cleaned = String(text ?? "").replace(/[₹,\s]|INR|Rs\.?/gi, "").replace(/(cr|dr)$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100) / 100;
}

/** An Excel date serial (days since 1899-12-30) as yyyy-mm-dd; anything else as written. */
export function statementDate(text: string) {
  const n = Number(text);
  if (/^\d{5}(\.\d+)?$/.test(text) && n > 20000 && n < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
  }
  return text;
}

/**
 * The references in a line of the statement: a 12-digit number standing alone (UPI and IMPS: the UTR or RRN), or a run of
 * 12 to 22 letters and digits with at least 8 digits and a letter (NEFT and RTGS UTRs such as HDFCN52026111212345).
 */
export function extractRefs(text: string) {
  const found: string[] = [];
  for (const token of String(text ?? "").toUpperCase().match(/[A-Z0-9]+/g) ?? []) {
    const digits = token.replace(/\D/g, "").length;
    if (/^\d{12}$/.test(token) || (/^[A-Z0-9]{12,22}$/.test(token) && /[A-Z]/.test(token) && digits >= 8)) {
      if (!found.includes(token)) found.push(token);
    }
  }
  return found;
}

/** How the money came, as the statement line says it. */
export function statementMethod(text: string) {
  const upper = String(text ?? "").toUpperCase();
  for (const method of ["UPI", "NEFT", "RTGS", "IMPS"]) if (new RegExp(`(^|[^A-Z])${method}([^A-Z]|$)`).test(upper)) return method;
  return null;
}

/** The same transfer: the same letters and digits, or a 12-digit UTR that the other ends in. */
export function sameRef(a: string, b: string) {
  const x = String(a ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const y = String(b ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  return (/^\d{12}$/.test(x) && y.endsWith(x)) || (/^\d{12}$/.test(y) && x.endsWith(y));
}

/** The credits in a statement: finds the heading row (date, description, credit or amount with Cr/Dr), then every credit. */
export function statementCredits(rows: string[][]): { credits: StatementCredit[]; problem: string | null } {
  for (let h = 0; h < Math.min(rows.length, 40); h += 1) {
    const head = rows[h]!.map(key);
    const dateCol = head.findIndex((c) => c.includes("date"));
    let textCol = head.findIndex((c) => /narration|description|particular|remark|details/.test(c));
    if (textCol < 0) textCol = head.findIndex((c) => c.includes("transaction") && !/date|id|type|amount/.test(c));
    const creditCol = head.findIndex((c) => (c.includes("credit") || c.includes("deposit") || c === "cr" || c === "cramount") && !c.includes("debit") && !c.includes("date"));
    const amountCol = head.findIndex((c) => c.includes("amount") && !c.includes("debit") && !c.includes("balance"));
    const typeCol = head.findIndex((c) => ["drcr", "crdr", "type", "transactiontype", "crdrindicator", "debitcredit"].includes(c));
    const refCols = head.map((c, i) => (/ref|cheque|chq|utr|rrn/.test(c) && !c.includes("date") ? i : -1)).filter((i) => i >= 0);
    if (dateCol < 0 || textCol < 0 || (creditCol < 0 && !(amountCol >= 0 && typeCol >= 0))) continue;
    const credits: StatementCredit[] = [];
    for (let r = h + 1; r < rows.length; r += 1) {
      const row = rows[r]!;
      let amount = Number.NaN;
      if (creditCol >= 0) amount = parseAmount(row[creditCol] ?? "");
      else if (/^(cr|c|credit)$/i.test((row[typeCol] ?? "").trim())) amount = parseAmount(row[amountCol] ?? "");
      if (!(amount > 0)) continue;
      const text = row[textCol] ?? "";
      const refText = [text, ...refCols.map((i) => row[i] ?? "")].join(" ");
      credits.push({ row: r + 1, date: statementDate(row[dateCol] ?? ""), text, amount, refs: extractRefs(refText), method: statementMethod(text) });
    }
    return { credits, problem: credits.length ? null : "The statement has no credits (money received) in it." };
  }
  return { credits: [], problem: "Could not find the columns. Use the statement with Date, Narration (or Description) and Credit columns, as Excel (.xlsx) or CSV." };
}

export type SentUtr = { orderNo: string; utr: string; amount: number; status: string; late?: boolean | undefined };
export type OpenCheckout = { orderNo: string; amount: number; status: string; createdAt: string; method: string; hasUtr: boolean };
export type StatementMatch =
  | { kind: "utr"; credit: StatementCredit; orderNo: string; utr: string; late: boolean }
  | { kind: "amount_differs"; credit: StatementCredit; orderNo: string; utr: string; expected: number }
  | { kind: "amount"; credit: StatementCredit; orderNo: string; ref: string; late: boolean; method: string }
  | { kind: "several"; credit: StatementCredit; orderNos: string[] }
  | { kind: "already"; credit: StatementCredit }
  | { kind: "none"; credit: StatementCredit };

const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Each credit, matched once:
 *   utr            a UTR waiting for a check with the same reference and amount: Confirm (or place again when it came late);
 *   amount_differs the same reference, another amount: a person looks;
 *   amount         no UTR sent, and exactly one checkout of this amount (waiting, or ended within 15 days): suggested;
 *   several        more than one checkout of this amount: a person chooses;
 *   already        the reference is already recorded as a payment;
 *   none           nothing to match.
 */
export function matchStatement(credits: StatementCredit[], sent: SentUtr[], checkouts: OpenCheckout[], recordedRefs: string[], now = Date.now()): StatementMatch[] {
  const usedOrders = new Set<string>();
  const waiting = sent.filter((s) => s.status === "submitted");
  return credits.map((credit): StatementMatch => {
    if (credit.refs.some((ref) => recordedRefs.some((done) => sameRef(ref, done)))) return { kind: "already", credit };
    const byRef = waiting.find((s) => !usedOrders.has(s.orderNo) && credit.refs.some((ref) => sameRef(ref, s.utr)));
    if (byRef) {
      usedOrders.add(byRef.orderNo);
      return same(byRef.amount, credit.amount)
        ? { kind: "utr", credit, orderNo: byRef.orderNo, utr: byRef.utr, late: Boolean(byRef.late) }
        : { kind: "amount_differs", credit, orderNo: byRef.orderNo, utr: byRef.utr, expected: byRef.amount };
    }
    const recent = (c: OpenCheckout) => c.status === "Awaiting Payment" || (c.status === "Payment Expired" && now - Date.parse(c.createdAt) < 15 * 86_400_000);
    const candidates = checkouts.filter((c) => !c.hasUtr && !usedOrders.has(c.orderNo) && recent(c) && same(c.amount, credit.amount));
    if (candidates.length === 1 && credit.refs.length) {
      const only = candidates[0]!;
      usedOrders.add(only.orderNo);
      return { kind: "amount", credit, orderNo: only.orderNo, ref: credit.refs[0]!, late: only.status === "Payment Expired", method: credit.method ?? only.method };
    }
    if (candidates.length > 1) return { kind: "several", credit, orderNos: candidates.map((c) => c.orderNo) };
    return { kind: "none", credit };
  });
}
