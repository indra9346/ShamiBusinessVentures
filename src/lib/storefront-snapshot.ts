/*
 * The public storefront data (catalogue, categories, godowns with their stock and prices, the public
 * settings and the live ad banners), read on the server and sent inside the page itself. The first
 * paint then shows the real products, categories and banners, and their pictures start downloading
 * with the page, instead of after the scripts have started and made their own database calls.
 * The browser keeps everything live with the realtime updates as before; when the copy in the page
 * was not fresh it reads the data again, once the page has finished loading.
 */
import { createContext, useContext } from "react";
import type { Json } from "@/integrations/supabase/types";
import type { AdBannerRow } from "@/lib/ad-banner-rules";

export type StorefrontSnapshot = {
  /** When the server read the data, and when it sent this page (server clock, ms). */
  fetchedAt: number;
  servedAt: number;
  /** catalog_products.payload */
  products: Json[];
  /** store_categories.payload, in their order */
  categories: Json[];
  branches: { [column: string]: Json }[];
  branchStock: { branch_id: string; product_id: string; stock: number }[];
  branchPrices: { branch_id: string; product_id: string; price: number; listed: boolean | null; pending: boolean | null }[];
  vendorPoints: { vendor_id: string; branch_id: string }[];
  /** The public settings rows the storefront reads, by key. */
  settings: { [key: string]: Json };
  adBanners: AdBannerRow[];
  /** Ratings of published product reviews, for the product pages' Google rating (empty if unreadable). */
  publishedRatings?: { product_id: string; rating: number }[];
};

/** A copy older than this when the page was sent is read again in the browser after the page loads. */
export const SNAPSHOT_FRESH_MS = 30_000;

export const StorefrontSnapshotContext = createContext<StorefrontSnapshot | null>(null);

/** The storefront data that came with the page (null in the static demo or when the server could not read it). */
export const useStorefrontSnapshot = () => useContext(StorefrontSnapshotContext);

export const snapshotIsFresh = (snapshot: StorefrontSnapshot | null) =>
  !!snapshot && snapshot.servedAt - snapshot.fetchedAt <= SNAPSHOT_FRESH_MS;

/**
 * Runs `task` once the page has loaded and the browser is idle, so a background re-read never
 * competes with the first paint or the pictures. Returns a function that cancels it.
 */
export function afterPageLoad(task: () => void): () => void {
  let cancelled = false;
  let idleId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") idleId = window.requestIdleCallback(() => { if (!cancelled) task(); }, { timeout: 3000 });
    else timer = setTimeout(() => { if (!cancelled) task(); }, 300);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", run);
    if (idleId !== undefined) window.cancelIdleCallback?.(idleId);
    if (timer) clearTimeout(timer);
  };
}
