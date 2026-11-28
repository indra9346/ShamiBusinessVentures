import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";

/*
 * Admin screen limit (owner, 23 Nov 2026): how many screens (browsers or devices) may use the admin portal at the same
 * time with the same login. Set in Settings > Security (settings key "admin_screens", {"max_screens": N}, 0 = no limit).
 * Each open admin screen checks in every minute (admin_screen_checkin, migration 20261123180000_admin_screen_limit.sql);
 * the database decides who is in, and refuses admin rights to a held or signed-out screen.
 */

export const ADMIN_SCREENS_KEY = "admin_screens";
export const ADMIN_SCREENS_MAX = 9999;
const CHECK_EVERY_MS = 60_000;

export type AdminScreen = {
  session_id: string;
  email: string | null;
  device: string;
  started_at: string;
  last_seen: string;
  held: boolean;
  this_screen: boolean;
};

export type AdminScreenCheck = {
  ok: boolean;
  reason?: "limit" | "signed_out";
  limit: number;
  screens?: AdminScreen[];
};

/** The limit typed in Settings: a whole number from 0 (no limit) to 9999, or null when it is not one. */
export function parseScreenLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= ADMIN_SCREENS_MAX ? value : null;
}

/** "Chrome on Windows", "Safari on iPhone": enough to tell screens apart in the list. */
export function deviceLabel(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent) {
  const ua = userAgent || "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "unknown device";
  return `${browser} on ${system}`;
}

type Rpc = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc: Rpc = (name, args) => (supabase.rpc as unknown as Rpc).call(supabase, name, args ?? {});

/** This screen's check-in. Null when it could not be checked (offline, or the SQL not run yet): never lock anyone out then. */
export async function checkInAdminScreen(takeOver = false): Promise<AdminScreenCheck | null> {
  if (STATIC_DATA_MODE) return null;
  try {
    const { data, error } = await rpc("admin_screen_checkin", { _device: deviceLabel(), _take_over: takeOver });
    if (error || !data || typeof data !== "object") return null;
    return data as AdminScreenCheck;
  } catch {
    return null;
  }
}

/** Log out frees this screen's place at once (otherwise it frees 3 minutes after the screen closes). */
export async function leaveAdminScreen() {
  if (STATIC_DATA_MODE) return;
  try { await rpc("admin_screen_leave"); } catch { /* the place frees itself in 3 minutes */ }
}

export async function openAdminScreens(): Promise<{ limit: number; screens: AdminScreen[] }> {
  const { data, error } = await rpc("admin_screens_open");
  if (error) throw new Error(error.message);
  const value = (data ?? {}) as { limit?: number; screens?: AdminScreen[] };
  return { limit: Number(value.limit ?? 0), screens: value.screens ?? [] };
}

export async function signOutAdminScreen(sessionId: string) {
  const { error } = await rpc("admin_screen_sign_out", { _session_id: sessionId });
  if (error) throw new Error(error.message);
}

/**
 * Checks this admin screen in now, every minute and when it comes back into view. `held` is set while the limit keeps
 * this screen out; `onSignedOut` runs when an admin signed this screen out (or another screen took its place).
 */
export function useAdminScreenCheck(enabled: boolean, onSignedOut: () => void) {
  const [held, setHeld] = useState<AdminScreenCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  const check = useCallback(async (takeOver = false) => {
    const result = await checkInAdminScreen(takeOver);
    if (!result) return;
    if (result.ok) { setHeld(null); return; }
    if (result.reason === "signed_out") { setHeld(null); signedOut.current(); return; }
    setHeld(result);
  }, []);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    void check();
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, check]);
  const run = async (takeOver: boolean) => {
    setBusy(true);
    try { await check(takeOver); } finally { setBusy(false); }
  };
  return { held, busy, retry: () => run(false), takeOver: () => run(true) };
}
