import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  DEFAULT_UPI_SETTINGS, UPI_SETTINGS_KEY, reviewSubmission, upsertSubmission,
  type UpiSettings, type UpiSubmission,
} from "@/lib/upi-pay";

/*
 * Where the direct-UPI settings and the customers' UTR submissions are kept.
 * MOCK: in the static demo both live in this browser (localStorage), so the whole flow can be
 * shown without touching the live database. On the live site the settings are read from
 * settings.upi_direct (off until the admin switches it on); live UTR submissions need their own
 * database table, which comes with the real integration, so they are refused here for now.
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
  window.dispatchEvent(new Event(CHANGED));
};

export async function loadUpiSettings(): Promise<UpiSettings> {
  if (STATIC_DATA_MODE) return { ...DEFAULT_UPI_SETTINGS, ...readJson<Partial<UpiSettings>>(DEMO_SETTINGS, {}) };
  const { data } = await supabase.from("settings").select("value").eq("key", UPI_SETTINGS_KEY).maybeSingle();
  return { ...DEFAULT_UPI_SETTINGS, ...((data?.value ?? {}) as Partial<UpiSettings>) };
}

export async function saveUpiSettings(settings: UpiSettings) {
  if (STATIC_DATA_MODE) { writeJson(DEMO_SETTINGS, settings); return; }
  // Public: the UPI ID and name are shown to every customer at checkout anyway.
  const { error } = await supabase.from("settings").upsert({
    key: UPI_SETTINGS_KEY, value: settings as unknown as Json, is_public: true, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  window.dispatchEvent(new Event(CHANGED));
}

export function loadUpiSubmissions(): UpiSubmission[] {
  return STATIC_DATA_MODE ? readJson<UpiSubmission[]>(DEMO_SUBMISSIONS, []) : [];
}

export function submitUpiPayment(submission: Omit<UpiSubmission, "status" | "submittedAt">) {
  if (!STATIC_DATA_MODE) throw new Error("Direct UPI is in testing; it is not taking real payments yet");
  writeJson(DEMO_SUBMISSIONS, upsertSubmission(loadUpiSubmissions(), { ...submission, status: "submitted", submittedAt: new Date().toISOString() }));
}

export function reviewUpiPayment(orderNo: string, status: "confirmed" | "rejected", note?: string) {
  if (!STATIC_DATA_MODE) throw new Error("Direct UPI is in testing; it is not taking real payments yet");
  writeJson(DEMO_SUBMISSIONS, reviewSubmission(loadUpiSubmissions(), orderNo, status, new Date().toISOString(), note));
}

/** Settings and submissions, kept current across tabs and components. */
export function useUpiPayments() {
  const [settings, setSettings] = useState<UpiSettings | null>(null);
  const [submissions, setSubmissions] = useState<UpiSubmission[]>([]);
  const refresh = useCallback(async () => {
    setSettings(await loadUpiSettings());
    setSubmissions(loadUpiSubmissions());
  }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(CHANGED, onChange);
    window.addEventListener("storage", onChange);
    return () => { window.removeEventListener(CHANGED, onChange); window.removeEventListener("storage", onChange); };
  }, [refresh]);
  return { settings, submissions, refresh };
}
