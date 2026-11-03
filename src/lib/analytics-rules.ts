/*
 * What Google Analytics may see on the storefront (no browser code, so these rules can be unit-tested).
 * It counts shoppers on the live address only: never the staff panels, never a customer's private pages,
 * and never an address that could carry a name, phone, email, order number or sign-in code.
 */

const LIVE_HOSTS = ["grainbazar.com", "www.grainbazar.com"];

/** Staff panels. Never counted, and a browser that has opened one is not counted on the storefront either. */
const PANEL_PATHS = ["/admin", "/vendor", "/partner", "/staff"];

/** A customer's own pages: their addresses hold order numbers and one-time sign-in codes. */
const PRIVATE_PATHS = ["/account", "/reset-password"];

/** Says where a visitor came from (Instagram, an ad) and holds nothing about the person. */
const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
];

const isUnder = (pathname: string, roots: string[]) => {
  // The router matches addresses in any letter case, so /ADMIN opens the same panel as /admin.
  const path = pathname.toLowerCase();
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
};

export const isLiveHost = (hostname: string) => LIVE_HOSTS.includes(hostname);
export const isPanelPath = (pathname: string) => isUnder(pathname, PANEL_PATHS);
export const isUntrackedPath = (pathname: string) =>
  isUnder(pathname, [...PANEL_PATHS, ...PRIVATE_PATHS]);

/** The ID from the build settings, or null when it is blank or isn't a GA4 Measurement ID (analytics stays off). */
export function validMeasurementId(value: unknown): string | null {
  return typeof value === "string" && /^G-[A-Z0-9]{4,20}$/.test(value.trim()) ? value.trim() : null;
}

/** The address to report: everything after the path is dropped except the campaign tags. */
export function cleanPageUrl(href: string): string {
  try {
    const url = new URL(href);
    const kept = new URLSearchParams();
    for (const key of CAMPAIGN_PARAMS) {
      const value = url.searchParams.get(key);
      if (value) kept.set(key, value);
    }
    const query = kept.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}
