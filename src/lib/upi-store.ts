import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { EMPTY_UTR_CHECKS, type UtrChecks } from "@/lib/utr-checks";
import { BANK_SETTINGS_KEY, EMPTY_BANK_DETAILS, REFUNDED_UTR_NOTE, type BankDetails } from "@/lib/payment-rules";
import {
  DEFAULT_UPI_SETTINGS, UPI_SETTINGS_KEY, normaliseUtr, reviewSubmission, upsertSubmission,
  type UpiSettings, type UpiSubmission,
} from "@/lib/upi-pay";

/*
 * Where the direct-UPI settings and the customers' UTRs are kept.
 * Live: settings.upi_direct (public, admin-written; every UPI ID change is logged and every admin
 * notified by the database) and the upi_payment_submissions table, changed only through the
 * submit_upi_utr / review_upi_utr functions (the amount always comes from the order).
 * NEFT and RTGS bank details: settings.bank_transfer, not public. An admin reads and writes the row; a
 * signed-in customer reads them through bank_transfer_details(). Every change is logged and every admin told.
 * Static demo: the same flow kept in this browser, so it can be shown without a database.
 */

const DEMO_SETTINGS = "gb-demo-upi-settings";
const DEMO_SUBMISSIONS = "gb-demo-upi-submissions";
/** Demo: sample bank credits without a UTR, kept in this browser like the demo's UTRs. */
const DEMO_CREDITS_WITHOUT_UTR = "gb-demo-credits-without-utr";
/** Demo: sample UTR checks, kept in this browser. */
const DEMO_UTR_CHECKS = "gb-demo-utr-checks";
const DEMO_BANK = "gb-demo-bank-details";
const DEMO_BANK_DETAILS: BankDetails = { accountName: "Shami Business Ventures Pvt. Ltd.", accountNumber: "50100123456789", ifsc: "HDFC0001234", bankName: "HDFC Bank (demo)", branch: "Challakere" };
const CHANGED = "gb-upi-changed";

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the demo still works for this page view.
  }
};
const changed = () => window.dispatchEvent(new Event(CHANGED));
/** A table or function the live database does not have yet (code going live before its database change). */
export const isMissingInDatabase = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (["PGRST202", "PGRST205", "42P01", "42883"].includes(error.code ?? "") || /could not find the (function|table)|does not exist/i.test(error.message ?? ""));

type SubmissionRow = {
  order_no: string; amount: number | string; utr: string; customer_name: string; submitted_at: string;
  status: string; reviewed_at: string | null; note: string | null;
};
const fromRow = (row: SubmissionRow): UpiSubmission => ({
  orderNo: row.order_no, amount: Number(row.amount), utr: row.utr, customer: row.customer_name, submittedAt: row.submitted_at,
  status: row.status as UpiSubmission["status"], ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}), ...(row.note ? { note: row.note } : {}),
});

export async function loadUpiSettings(): Promise<UpiSettings> {
  if (STATIC_DATA_MODE) return { ...DEFAULT_UPI_SETTINGS, ...readJson<Partial<UpiSettings>>(DEMO_SETTINGS, {}) };
  const { data, error } = await supabase.from("settings").select("value").eq("key", UPI_SETTINGS_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return { ...DEFAULT_UPI_SETTINGS, ...((data?.value ?? {}) as Partial<UpiSettings>) };
}

export async function saveUpiSettings(settings: UpiSettings) {
  if (STATIC_DATA_MODE) { writeJson(DEMO_SETTINGS, settings); changed(); return; }
  // Public: the UPI ID and name are shown to every customer at checkout anyway.
  const { error } = await supabase.from("settings").upsert({
    key: UPI_SETTINGS_KEY, value: settings as unknown as Json, is_public: true, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: the bank details as saved, empty until entered. */
export async function loadBankSettings(): Promise<BankDetails> {
  if (STATIC_DATA_MODE) return readJson<BankDetails>(DEMO_BANK, DEMO_BANK_DETAILS);
  const { data, error } = await supabase.from("settings").select("value").eq("key", BANK_SETTINGS_KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return { ...EMPTY_BANK_DETAILS, ...((data?.value ?? {}) as Partial<BankDetails>) };
}

export async function saveBankDetails(details: BankDetails) {
  if (STATIC_DATA_MODE) { writeJson(DEMO_BANK, details); changed(); return; }
  const { error } = await supabase.from("settings").upsert({
    key: BANK_SETTINGS_KEY, value: details as unknown as Json, is_public: false, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  changed();
}

/** A signed-in customer: the account to transfer to, or null while none is set up. */
export async function loadBankDetails(): Promise<BankDetails | null> {
  if (STATIC_DATA_MODE) return readJson<BankDetails>(DEMO_BANK, DEMO_BANK_DETAILS);
  const { data, error } = await supabase.rpc("bank_transfer_details");
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { ...EMPTY_BANK_DETAILS, ...(data as Partial<BankDetails>) };
}

/**
 * The bank details for a customer, kept current. `key` (the signed-in user) reloads them after a sign-in.
 * `loaded`: we know the answer (details, or none set up). A failed read keeps what is on screen, is
 * tried again in a few seconds, and is never taken to mean "not set up".
 */
export function useBankDetails(enabled = true, key?: string) {
  const [details, setDetails] = useState<BankDetails | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (retry) clearTimeout(retry);
      void loadBankDetails().then(
        (next) => { if (active) { setDetails(next); setLoaded(true); setFailed(false); } },
        () => { if (active) { setFailed(true); retry = setTimeout(load, 5000); } },
      );
    };
    load();
    window.addEventListener(CHANGED, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      window.removeEventListener(CHANGED, load);
      window.removeEventListener("focus", load);
    };
  }, [enabled, key]);
  return { details, loaded, failed };
}

export type BankAuditRow = { changedAt: string; changedBy: string; oldValue: Partial<BankDetails> | null; newValue: Partial<BankDetails> | null };
/** Admin: the log of bank detail changes, newest first. */
export async function loadBankAudit(): Promise<BankAuditRow[]> {
  if (STATIC_DATA_MODE) return [];
  const { data } = await supabase.from("bank_settings_audit").select("changed_at,changed_by,old_value,new_value")
    .order("changed_at", { ascending: false }).limit(50);
  const ids = [...new Set((data ?? []).map((row) => row.changed_by).filter((id): id is string => Boolean(id)))];
  const { data: people } = ids.length ? await supabase.from("profiles").select("id,full_name").in("id", ids) : { data: [] };
  const nameOf = (id: string | null) => (people ?? []).find((person) => person.id === id)?.full_name || "Unknown";
  return (data ?? []).map((row) => ({ changedAt: row.changed_at, changedBy: nameOf(row.changed_by), oldValue: row.old_value as Partial<BankDetails> | null, newValue: row.new_value as Partial<BankDetails> | null }));
}

/** Admins get every submission; a customer only their own (row security in the database). */
export async function loadUpiSubmissions(): Promise<UpiSubmission[]> {
  if (STATIC_DATA_MODE) return readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []);
  const { data, error } = await supabase.from("upi_payment_submissions")
    .select("order_no,amount,utr,customer_name,submitted_at,status,reviewed_at,note")
    .order("submitted_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

export async function submitUpiPayment(submission: { orderNo: string; amount: number; utr: string; customer: string }) {
  if (STATIC_DATA_MODE) {
    writeJson(DEMO_SUBMISSIONS, upsertSubmission(readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []),
      { ...submission, utr: normaliseUtr(submission.utr), status: "submitted", submittedAt: new Date().toISOString() }));
    changed();
    return;
  }
  // Through send_payment_utr, which records every UTR sent (refused ones too) for the admin's UTR checks.
  const { data, error } = await supabase.rpc("send_payment_utr", { _order_no: submission.orderNo, _utr: normaliseUtr(submission.utr) });
  if (error && isMissingInDatabase(error)) {
    // The database change is not applied yet: the UTR still goes through, as it did before.
    const { error: oldError } = await supabase.rpc("submit_upi_utr", { _order_no: submission.orderNo, _utr: normaliseUtr(submission.utr) });
    if (oldError) throw new Error(oldError.message);
    changed();
    return;
  }
  if (error) throw new Error(error.message);
  const result = (data ?? {}) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error || "Could not send the UTR");
  changed();
}

/**
 * Admin decision on the UTR they looked at (the database refuses if the row has changed since). Confirming
 * records the payment in the same step. Returns how many times this order's UTR has now been rejected.
 */
export async function reviewUpiPayment(orderNo: string, decision: "confirmed" | "rejected", utr: string, note?: string): Promise<number> {
  if (STATIC_DATA_MODE) {
    writeJson(DEMO_SUBMISSIONS, reviewSubmission(readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []), orderNo, decision, new Date().toISOString(), note));
    changed();
    return 0;
  }
  const { data, error } = await supabase.rpc("review_upi_utr", { _order_no: orderNo, _decision: decision, _note: note ?? null, _expected_utr: utr });
  if (error) throw new Error(error.message);
  changed();
  return Number((data as { rejections?: number } | null)?.rejections ?? 0);
}

/** Admin: rejects the customer's UTR and ends the checkout at once (stock back on sale, the customer told). */
export async function rejectUtrAndEndCheckout(orderNo: string, utr: string, note?: string) {
  if (STATIC_DATA_MODE) {
    await reviewUpiPayment(orderNo, "rejected", utr, note);
    return;
  }
  const { error } = await supabase.rpc("admin_reject_utr_and_end_checkout", { _order_no: orderNo, _note: note ?? "", _expected_utr: utr });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: a UTR that was not checked in time has been refunded. It pays for nothing from now on. */
export async function markUtrRefunded(orderNo: string) {
  if (STATIC_DATA_MODE) {
    writeJson(DEMO_SUBMISSIONS, readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []).map((row) => (row.orderNo === orderNo ? { ...row, note: REFUNDED_UTR_NOTE } : row)));
    changed();
    return;
  }
  const { error } = await supabase.rpc("mark_utr_refunded", { _order_no: orderNo });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: ends a checkout waiting for payment, UTR or not, saying why. Its stock goes back and the customer is told. */
export async function endPaymentHold(orderNo: string, reason: string) {
  const { error } = await supabase.rpc("admin_end_payment_hold", { _order_no: orderNo, _reason: reason.trim() });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: deletes a customer's UTR record that was rejected or refunded, saying why. A copy stays in the Delete Log. */
export async function deleteUtrRecord(orderNo: string, reason: string) {
  if (STATIC_DATA_MODE) {
    writeJson(DEMO_SUBMISSIONS, readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []).filter((row) => row.orderNo !== orderNo));
    changed();
    return;
  }
  const { error } = await supabase.rpc("admin_delete_utr", { _order_no: orderNo, _reason: reason.trim() });
  if (error) throw new Error(error.message);
  changed();
}

/** Tell every open payments list to read again (after an order with UTRs was deleted elsewhere). */
export function upiRecordsChanged() {
  changed();
}

export type UpiAuditRow = { changedAt: string; oldVpa: string | null; newVpa: string | null; newEnabled: boolean | null; payeeName: string | null };
/** Admin: the log of UPI ID changes, newest first. */
export async function loadUpiAudit(): Promise<UpiAuditRow[]> {
  if (STATIC_DATA_MODE) return [];
  const { data } = await supabase.from("upi_settings_audit").select("changed_at,old_vpa,new_vpa,new_enabled,payee_name")
    .order("changed_at", { ascending: false }).limit(50);
  return (data ?? []).map((row) => ({ changedAt: row.changed_at, oldVpa: row.old_vpa, newVpa: row.new_vpa, newEnabled: row.new_enabled, payeeName: row.payee_name }));
}

export type BankCredit = {
  id: string; receivedAt: string; amount: number; utr: string; payer: string | null; sender: string | null;
  status: "matched" | "unmatched" | "ambiguous" | "mismatch" | "late" | "settled" | "balance"; orderNo: string | null; note: string | null; raw: string | null;
};
/** Admin: money-received SMS alerts from the company phone, newest first (customers see none). */
export async function loadBankCredits(): Promise<BankCredit[]> {
  if (STATIC_DATA_MODE) return [];
  const { data, error } = await supabase.from("bank_credits").select("id,received_at,amount,utr,payer,sender,status,order_no,note,raw")
    .order("received_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id, receivedAt: row.received_at, amount: Number(row.amount), utr: row.utr, payer: row.payer, sender: row.sender,
    status: row.status as BankCredit["status"], orderNo: row.order_no, note: row.note, raw: row.raw,
  }));
}

/** Admin: a credit that needed a person was dealt with (refunded, order placed by hand, not for the shop). */
export async function settleBankCredit(id: string, note: string) {
  const { error } = await supabase.rpc("settle_bank_credit", { _credit_id: id, _note: note });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: an alert settled by mistake goes back to needing a person. A settled alert can pay for nothing. */
export async function reopenBankCredit(id: string) {
  const { error } = await supabase.rpc("reopen_bank_credit", { _credit_id: id });
  if (error) throw new Error(error.message);
  changed();
}

export type CreditWithoutUtr = {
  id: string; receivedAt: string; creditedAt: string | null; amount: number; accountEnding: string; balance: number | null;
  sender: string | null; raw: string; status: "new" | "used" | "dismissed"; orderNo: string | null; decidedAt: string | null; note: string | null;
  /** The only checkout waiting for this amount when it came: kept for it until an admin decides. */
  suggestedOrderNo: string | null;
};
/** Admin: bank credits whose SMS has no UTR (IDFC FIRST), for the company's account only, newest first. */
export async function loadCreditsWithoutUtr(): Promise<CreditWithoutUtr[]> {
  if (STATIC_DATA_MODE) return readJson<CreditWithoutUtr[]>(DEMO_CREDITS_WITHOUT_UTR, []);
  const { data, error } = await supabase.from("bank_credits_without_reference")
    .select("id,received_at,credited_at,amount,account_ending,balance,sender,raw,status,order_no,decided_at,note,suggested_order_no")
    .order("received_at", { ascending: false }).limit(100);
  // Not set up in the database yet: nothing to show, and nothing to retry every few seconds.
  if (error && isMissingInDatabase(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id, receivedAt: row.received_at, creditedAt: row.credited_at, amount: Number(row.amount), accountEnding: row.account_ending,
    balance: row.balance === null ? null : Number(row.balance), sender: row.sender, raw: row.raw, status: row.status as CreditWithoutUtr["status"],
    orderNo: row.order_no, decidedAt: row.decided_at, note: row.note, suggestedOrderNo: row.suggested_order_no ?? null,
  }));
}

/**
 * Admin: pays an order with a bank credit that has no UTR: through the customer's UTR and the usual check when one waits
 * (pass it, so a UTR changed meanwhile is refused), else the credit itself is the payment (utr null).
 */
export async function confirmOrderWithCredit(creditId: string, orderNo: string, utr: string | null) {
  if (STATIC_DATA_MODE) throw new Error("Not in the demo");
  const { error } = await supabase.rpc("confirm_order_with_bank_credit", { _credit_id: creditId, _order_no: orderNo, _expected_utr: utr });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: a credit that is not a website payment (an office sale, say), with what it was. */
export async function dismissCreditWithoutUtr(creditId: string, note: string) {
  if (STATIC_DATA_MODE) throw new Error("Not in the demo");
  const { error } = await supabase.rpc("dismiss_bank_credit_without_reference", { _credit_id: creditId, _note: note });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: a credit dismissed by mistake can be matched again. */
export async function reopenCreditWithoutUtr(creditId: string) {
  if (STATIC_DATA_MODE) throw new Error("Not in the demo");
  const { error } = await supabase.rpc("reopen_bank_credit_without_reference", { _credit_id: creditId });
  if (error) throw new Error(error.message);
  changed();
}

/** Admin: transfers on more than one order or account, accounts with refused UTRs, and the latest refused tries. */
export async function loadUtrChecks(): Promise<UtrChecks> {
  if (STATIC_DATA_MODE) return readJson<UtrChecks>(DEMO_UTR_CHECKS, EMPTY_UTR_CHECKS);
  const { data, error } = await supabase.rpc("admin_utr_conflicts", { _days: 90 });
  if (error) throw new Error(error.message);
  const value = (data ?? {}) as Partial<UtrChecks>;
  return { groups: value.groups ?? [], accounts: value.accounts ?? [], tries: value.tries ?? [], since: value.since ?? "" };
}

/** Admin: says what was found or done about a group; anything newer brings it back. */
export async function reviewUtrConflict(key: string, note: string) {
  if (STATIC_DATA_MODE) throw new Error("Not in the demo");
  const { error } = await supabase.rpc("review_utr_conflict", { _key: key, _note: note });
  if (error) throw new Error(error.message);
  changed();
}

/** Settings, submissions and bank alerts, kept current: after every change here, across tabs, and live from the database. */
export function useUpiPayments() {
  const [settings, setSettings] = useState<UpiSettings | null>(null);
  const [submissions, setSubmissions] = useState<UpiSubmission[]>([]);
  const [credits, setCredits] = useState<BankCredit[]>([]);
  const [creditsWithoutUtr, setCreditsWithoutUtr] = useState<CreditWithoutUtr[]>([]);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (retry.current) clearTimeout(retry.current);
    const [nextSettings, nextSubmissions, nextCredits, nextPlain] = await Promise.allSettled([loadUpiSettings(), loadUpiSubmissions(), loadBankCredits(), loadCreditsWithoutUtr()]);
    // A failed read keeps what is on screen, and is tried again in a few seconds.
    if (nextSettings.status === "fulfilled") setSettings(nextSettings.value);
    if (nextSubmissions.status === "fulfilled") setSubmissions(nextSubmissions.value);
    if (nextCredits.status === "fulfilled") setCredits(nextCredits.value);
    if (nextPlain.status === "fulfilled") setCreditsWithoutUtr(nextPlain.value);
    if ([nextSettings, nextSubmissions, nextCredits, nextPlain].some((result) => result.status === "rejected")) retry.current = setTimeout(() => void refresh(), 5000);
  }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(CHANGED, onChange);
    window.addEventListener("storage", onChange);
    window.addEventListener("focus", onChange);
    const channel = STATIC_DATA_MODE ? null : supabase.channel(`upi-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "upi_payment_submissions" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "bank_credits" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "bank_credits_without_reference" }, onChange)
      .subscribe();
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("focus", onChange);
      if (retry.current) clearTimeout(retry.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [refresh]);
  return { settings, submissions, credits, creditsWithoutUtr, refresh };
}
