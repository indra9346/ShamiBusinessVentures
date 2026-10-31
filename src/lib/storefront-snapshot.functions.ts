import { createServerFn } from "@tanstack/react-start";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { SITE_URL } from "@/lib/seo";
import type { StorefrontSnapshot } from "@/lib/storefront-snapshot";

/*
 * The server's copy of the public storefront data (see storefront-snapshot.ts). It is read with the
 * public key, so it holds only what any visitor's browser could read itself. Kept in memory: a page
 * is answered from the copy at once and the copy is refreshed in the background, so no page waits
 * for the database once the server is running.
 */

/** Pages are answered from a copy this young without reading again. */
const FRESH_MS = 15_000;
/** An older copy is still answered (and refreshed behind it) up to this age. */
const STALE_LIMIT_MS = 15 * 60_000;
/** With no copy yet (just after a restart), a page waits at most this long for one. */
const FIRST_READ_WAIT_MS = 2_500;
/**
 * Hostinger stops a Node app that has had no requests for a few minutes and starts it again on the
 * next visit, which then takes ~15 s. A request to the site every few minutes keeps it running.
 */
const KEEP_WARM_EVERY_MS = 4 * 60_000;

type Data = Omit<StorefrontSnapshot, "servedAt">;
type Row = StorefrontSnapshot["branches"][number];

// The build can include this file twice on the server (the server-function chunk and the server
// entry), so the copy lives on globalThis: one copy, one refresh and one keep-warm timer per process.
type State = { current: Data | null; reading: Promise<Data> | null; started: boolean };
const state: State = ((globalThis as { __grainBazarStorefront?: State }).__grainBazarStorefront ??= {
  current: null,
  reading: null,
  started: false,
});

function supabaseConfig() {
  const url = import.meta.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"] || "";
  return { url: url.replace(/\/+$/, ""), key };
}

async function rest<T>(path: string, init?: { method: "POST"; body: string }): Promise<T> {
  const { url, key } = supabaseConfig();
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  const headers: Record<string, string> = { apikey: key, Accept: "application/json" };
  // New publishable keys are not JWTs; legacy anon keys also go in Authorization.
  if (!key.startsWith("sb_")) headers["Authorization"] = `Bearer ${key}`;
  if (init) headers["Content-Type"] = "application/json";
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${path.split("?")[0]} answered ${response.status}`);
  return (await response.json()) as T;
}

/** The same reads the storefront makes in the browser for a signed-out visitor. */
async function readStorefront(): Promise<Data> {
  const [products, categories, branches, branchStock, branchPrices, settingRows, adBanners] = await Promise.all([
    rest<{ payload: StorefrontSnapshot["products"][number] }[]>("catalog_products?select=payload"),
    rest<{ payload: StorefrontSnapshot["categories"][number] }[]>("store_categories?select=payload&order=sort_order.asc"),
    rest<Row[]>("branches?select=*&order=sort_order.asc,name.asc"),
    rest<StorefrontSnapshot["branchStock"]>("branch_stock?select=branch_id,product_id,stock"),
    rest<StorefrontSnapshot["branchPrices"]>("branch_prices?select=branch_id,product_id,price,listed,pending"),
    rest<{ key: string; value: StorefrontSnapshot["settings"][string] }[]>(
      "settings?select=key,value&is_public=eq.true&key=in.(platform_features,storefront_display,festive_theme)",
    ),
    rest<StorefrontSnapshot["adBanners"]>("ad_banners?select=*&order=sort_order.asc,created_at.asc"),
  ]);
  const settings = Object.fromEntries(settingRows.map((row) => [row.key, row.value]));
  const features = settings["platform_features"];
  const marketplace = !!features && typeof features === "object" && !Array.isArray(features) && features["marketplace_vendors"] === true;
  const vendorPoints = marketplace
    ? await rest<StorefrontSnapshot["vendorPoints"]>("rpc/vendor_fulfilment_points", { method: "POST", body: "{}" }).catch(() => [])
    : [];
  return {
    fetchedAt: Date.now(),
    products: products.map((row) => row.payload),
    categories: categories.map((row) => row.payload),
    branches,
    branchStock,
    branchPrices,
    vendorPoints,
    settings,
    adBanners,
  };
}

function refresh(): Promise<Data> {
  state.reading ??= readStorefront()
    .then((data) => { state.current = data; return data; })
    .finally(() => { state.reading = null; });
  return state.reading;
}

const logFailure = (cause: unknown) =>
  console.warn("Storefront data could not be read:", cause instanceof Error ? cause.message : cause);

/** Reads the storefront data at server start and keeps the app awake (production only). */
export function startStorefrontBackgroundWork() {
  if (state.started || STATIC_DATA_MODE) return;
  state.started = true;
  void refresh().catch(logFailure);
  const keepWarm = (process.env["KEEP_WARM_URL"] ?? SITE_URL).replace(/\/+$/, "");
  if (!import.meta.env.PROD || !keepWarm || keepWarm === "off") return;
  const timer = setInterval(() => {
    void fetch(`${keepWarm}/`, { headers: { "User-Agent": "GrainBazar-keep-warm" }, signal: AbortSignal.timeout(30_000) })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }, KEEP_WARM_EVERY_MS);
  timer.unref?.();
}

async function storefrontSnapshot(): Promise<StorefrontSnapshot | null> {
  startStorefrontBackgroundWork();
  const { current } = state;
  const age = current ? Date.now() - current.fetchedAt : Infinity;
  if (current && age < FRESH_MS) return { ...current, servedAt: Date.now() };
  const next = refresh();
  if (current && age < STALE_LIMIT_MS) {
    next.catch(logFailure);
    return { ...current, servedAt: Date.now() };
  }
  const data = await Promise.race([
    next,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_READ_WAIT_MS)),
  ]).catch((cause: unknown) => { logFailure(cause); return null; });
  // No copy in time: the page loads the data in the browser, as before.
  return data ? { ...data, servedAt: Date.now() } : null;
}

export const getStorefrontSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<StorefrontSnapshot | null> => (STATIC_DATA_MODE ? null : storefrontSnapshot()),
);
