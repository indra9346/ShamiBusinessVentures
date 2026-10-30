/*
 * Rules for the seasonal festival theme on the storefront (no browser or database code, so they can be
 * unit-tested). The theme shows only inside its festival dates, and only while the admin switch in
 * Admin > Ad Banners is on (on by default). After the dates it disappears by itself.
 */

export const FESTIVE_SETTING_KEY = "festive_theme";

export type FestiveSetting = {
  /** The admin switch. Off hides every festival decoration at once. */
  enabled: boolean;
};

export type FestiveWindow = { theme: "diwali"; label: string; from: string; until: string };

/** Deepavali 2026 (Lakshmi Puja on Sunday 8 November): 30 October to 15 November, India time. */
export const DIWALI_2026: FestiveWindow = {
  theme: "diwali",
  label: "Deepavali 2026",
  from: "2026-10-29T18:30:00.000Z", // 30 Oct 2026 00:00 IST
  until: "2026-11-15T18:30:00.000Z", // 16 Nov 2026 00:00 IST (shows through 15 Nov)
};

export const defaultFestiveSetting: FestiveSetting = { enabled: true };

/** The stored value, with anything missing or malformed read as the default (on). */
export function parseFestiveSetting(value: unknown): FestiveSetting {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { enabled: v["enabled"] !== false };
}

export function isInFestiveWindow(now = Date.now(), window: FestiveWindow = DIWALI_2026) {
  return now >= Date.parse(window.from) && now < Date.parse(window.until);
}

/** Whether shoppers see the festival theme now. */
export function festiveThemeOn(setting: FestiveSetting, now = Date.now(), window: FestiveWindow = DIWALI_2026) {
  return setting.enabled && isInFestiveWindow(now, window);
}

/** "Showing now", "Starts 30 Oct", "Ended 15 Nov" or "Switched off", for the admin panel. */
export function festiveStatus(setting: FestiveSetting, now = Date.now(), window: FestiveWindow = DIWALI_2026) {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  if (!setting.enabled) return "Switched off";
  if (now < Date.parse(window.from)) return `Starts ${fmt(window.from)}`;
  if (now >= Date.parse(window.until)) return `Ended ${fmt(new Date(Date.parse(window.until) - 1).toISOString())}`;
  return "Showing now";
}
