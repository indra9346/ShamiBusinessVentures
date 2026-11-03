import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
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
  const { error } = await supabase.rpc("submit_upi_utr", { _order_no: submission.orderNo, _utr: normaliseUtr(submission.utr) });
  if (error) throw new Error(error.message);
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

/** Admin: ends a checkout waiting for payment, UTR or not. Its stock goes back and the customer is told. */
export async function endPaymentHold(orderNo: string) {
  const { error } = await supabase.rpc("admin_end_payment_hold", { _order_no: orderNo });
  if (error) throw new Error(error.message);
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

/** Settings, submissions and bank alerts, kept current: after every change here, across tabs, and live from the database. */
export function useUpiPayments() {
  const [settings, setSettings] = useState<UpiSettings | null>(null);
  const [submissions, setSubmissions] = useState<UpiSubmission[]>([]);
  const [credits, setCredits] = useState<BankCredit[]>([]);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (retry.current) clearTimeout(retry.current);
    const [nextSettings, nextSubmissions, nextCredits] = await Promise.allSettled([loadUpiSettings(), loadUpiSubmissions(), loadBankCredits()]);
    // A failed read keeps what is on screen, and is tried again in a few seconds.
    if (nextSettings.status === "fulfilled") setSettings(nextSettings.value);
    if (nextSubmissions.status === "fulfilled") setSubmissions(nextSubmissions.value);
    if (nextCredits.status === "fulfilled") setCredits(nextCredits.value);
    if ([nextSettings, nextSubmissions, nextCredits].some((result) => result.status === "rejected")) retry.current = setTimeout(() => void refresh(), 5000);
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
      .subscribe();
    return () => {
      window.removeEventListener(CHANGED, onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("focus", onChange);
      if (retry.current) clearTimeout(retry.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [refresh]);
  return { settings, submissions, credits, refresh };
}
