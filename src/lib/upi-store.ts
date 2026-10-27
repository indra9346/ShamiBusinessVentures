import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  DEFAULT_UPI_SETTINGS, UPI_SETTINGS_KEY, normaliseUtr, reviewSubmission, upsertSubmission,
  type UpiSettings, type UpiSubmission,
} from "@/lib/upi-pay";

/*
 * Where the direct-UPI settings and the customers' UTRs are kept.
 * Live: settings.upi_direct (public, admin-written; every UPI ID change is logged and every admin
 * notified by the database) and the upi_payment_submissions table, changed only through the
 * submit_upi_utr / review_upi_utr functions (the amount always comes from the order).
 * Static demo: the same flow kept in this browser, so it can be shown without a database.
 */

const DEMO_SETTINGS = "gb-demo-upi-settings";
const DEMO_SUBMISSIONS = "gb-demo-upi-submissions";
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
  const { data } = await supabase.from("settings").select("value").eq("key", UPI_SETTINGS_KEY).maybeSingle();
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

/** Admins get every submission; a customer only their own (row security in the database). */
export async function loadUpiSubmissions(): Promise<UpiSubmission[]> {
  if (STATIC_DATA_MODE) return readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []);
  const { data, error } = await supabase.from("upi_payment_submissions")
    .select("order_no,amount,utr,customer_name,submitted_at,status,reviewed_at,note")
    .order("submitted_at", { ascending: false }).limit(500);
  if (error) return [];
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

/** Admin decision. Confirming records the payment (order paid, sent to Zoho Books) in the same step. */
export async function reviewUpiPayment(orderNo: string, decision: "confirmed" | "rejected", note?: string) {
  if (STATIC_DATA_MODE) {
    writeJson(DEMO_SUBMISSIONS, reviewSubmission(readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []), orderNo, decision, new Date().toISOString(), note));
    changed();
    return;
  }
  const { error } = await supabase.rpc("review_upi_utr", { _order_no: orderNo, _decision: decision, _note: note ?? null });
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
  status: "matched" | "unmatched" | "ambiguous" | "mismatch" | "late" | "settled"; orderNo: string | null; note: string | null; raw: string | null;
};
/** Admin: money-received SMS alerts from the company phone, newest first (customers see none). */
export async function loadBankCredits(): Promise<BankCredit[]> {
  if (STATIC_DATA_MODE) return [];
  const { data } = await supabase.from("bank_credits").select("id,received_at,amount,utr,payer,sender,status,order_no,note,raw")
    .order("received_at", { ascending: false }).limit(200);
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

/** Settings, submissions and bank alerts, kept current: after every change here, across tabs, and live from the database. */
export function useUpiPayments() {
  const [settings, setSettings] = useState<UpiSettings | null>(null);
  const [submissions, setSubmissions] = useState<UpiSubmission[]>([]);
  const [credits, setCredits] = useState<BankCredit[]>([]);
  const refresh = useCallback(async () => {
    const [nextSettings, nextSubmissions, nextCredits] = await Promise.all([loadUpiSettings(), loadUpiSubmissions(), loadBankCredits()]);
    setSettings(nextSettings);
    setSubmissions(nextSubmissions);
    setCredits(nextCredits);
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
      if (channel) void supabase.removeChannel(channel);
    };
  }, [refresh]);
  return { settings, submissions, credits, refresh };
}
