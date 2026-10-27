/*
 * Log of the Zoho API calls this website makes: what for (purpose), which Zoho API and endpoint,
 * how many, how many failed, and when. Zoho's own API Usage page counts calls per module; this
 * says why each one was made. Pure, so the node tests can load it; the server keeps it in
 * settings.zoho_api_calls (the last 7 India days).
 */

export const ZOHO_CALL_LOG_SETTING = "zoho_api_calls";
export const ZOHO_CALL_LOG_DAYS = 7;
export const ZOHO_CALL_DEFAULT_PURPOSE = "Admin page / other";

export type ZohoCall = { at: string; purpose: string; api: string; method: string; endpoint: string; ok: boolean };
export type ZohoCallRow = { purpose: string; api: string; method: string; endpoint: string; count: number; errors: number; last: string };
export type ZohoCallDay = { total: number; errors: number; hours: number[]; rows: Record<string, ZohoCallRow> };
export type ZohoCallLog = { days: Record<string, ZohoCallDay> };

const IST_MS = 330 * 60_000;
const istDay = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
const istHour = (iso: string) => new Date(Date.parse(iso) + IST_MS).getUTCHours();

/**
 * Which Zoho API a request goes to and its endpoint with record IDs taken out
 * ("salesorders/:id/status/confirmed"). Null for sign-in (token) requests, which Zoho does
 * not count against the API limit, and for anything that is not a Zoho API.
 */
export function describeZohoCall(url: string): { api: string; endpoint: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (!/zoho(apis|cloud)?\./.test(host) || host.startsWith("accounts.")) return null;
  const path = parsed.pathname;
  const rules: [RegExp, string][] = [
    [/^\/inventory\/v1\//, "Inventory"],
    [/^\/books\/v3\//, "Books"],
    [/^\/store\/api\/v1\//, "Commerce"],
    [/^\/storefront\/api\/v1\//, "Commerce storefront"],
    [/^\/zs-site\/api\/v1\//, "Commerce site"],
  ];
  for (const [prefix, api] of rules) {
    if (!prefix.test(path)) continue;
    const endpoint = path.replace(prefix, "").split("/").filter(Boolean)
      .map((part) => (/^\d{6,}$/.test(part) || /^[0-9a-f-]{24,}$/i.test(part) ? ":id" : decodeURIComponent(part)))
      .join("/");
    return { api, endpoint: endpoint || "/" };
  }
  return { api: "Other Zoho", endpoint: path };
}

const emptyDay = (): ZohoCallDay => ({ total: 0, errors: 0, hours: Array.from({ length: 24 }, () => 0), rows: {} });

/** Adds calls to the log and keeps only the last `keepDays` India days. */
export function mergeZohoCalls(log: ZohoCallLog | null | undefined, calls: ZohoCall[], keepDays = ZOHO_CALL_LOG_DAYS): ZohoCallLog {
  const days: Record<string, ZohoCallDay> = {};
  for (const [day, value] of Object.entries(log?.days ?? {})) {
    days[day] = { ...emptyDay(), ...value, hours: [...(value.hours ?? emptyDay().hours)], rows: { ...(value.rows ?? {}) } };
  }
  for (const call of calls) {
    const day = (days[istDay(call.at)] ??= emptyDay());
    day.total += 1;
    if (!call.ok) day.errors += 1;
    day.hours[istHour(call.at)]! += 1;
    const key = `${call.purpose}|${call.api}|${call.method}|${call.endpoint}`;
    const row = (day.rows[key] ??= { purpose: call.purpose, api: call.api, method: call.method, endpoint: call.endpoint, count: 0, errors: 0, last: call.at });
    row.count += 1;
    if (!call.ok) row.errors += 1;
    if (call.at > row.last) row.last = call.at;
  }
  const kept = Object.keys(days).sort().slice(-keepDays);
  return { days: Object.fromEntries(kept.map((day) => [day, days[day]!])) };
}

/** One day's calls added up per purpose, busiest first. */
export function callsByPurpose(day: ZohoCallDay | undefined) {
  const totals = new Map<string, { purpose: string; count: number; errors: number }>();
  for (const row of Object.values(day?.rows ?? {})) {
    const entry = totals.get(row.purpose) ?? { purpose: row.purpose, count: 0, errors: 0 };
    entry.count += row.count;
    entry.errors += row.errors;
    totals.set(row.purpose, entry);
  }
  return [...totals.values()].sort((a, b) => b.count - a.count);
}
