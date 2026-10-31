/*
 * Advertising banners on the storefront home page. Admins manage them in Admin > Ad Banners
 * (table public.ad_banners, media in the "ad-media" bucket); shoppers see the ones that are on
 * and inside their dates. The last set shown is kept on the device so a returning shopper sees
 * the banners at once instead of an empty band.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { afterPageLoad, snapshotIsFresh, useStorefrontSnapshot, type StorefrontSnapshot } from "@/lib/storefront-snapshot";

import {
  AD_IMAGE_TYPES, AD_MEDIA_MAX_BYTES, AD_VIDEO_TYPES, adMediaProblem, bannerFromRow, bannerStatus, bannerToRow, bannersByPlacement, isBannerLive, normaliseBannerLink, sortBanners,
  type AdBanner, type AdBannerRow, type AdPlacement,
} from "@/lib/ad-banner-rules";

export {
  AD_IMAGE_TYPES, AD_MEDIA_MAX_BYTES, AD_VIDEO_TYPES, adMediaProblem, bannerFromRow, bannerStatus, bannerToRow, bannersByPlacement, isBannerLive, normaliseBannerLink, sortBanners,
  type AdBanner, type AdPlacement,
};

/* ------------------------------------------------------------------------- */
/* Storage of banners: Supabase in production, this browser in the demo.      */
/* ------------------------------------------------------------------------- */
const CACHE_KEY = "gb-ad-banners-v1";
const DEMO_KEY = "gb-demo-ad-banners";

function readList(key: string): AdBanner[] | null {
  try {
    const list = JSON.parse(window.localStorage.getItem(key) ?? "null") as AdBanner[] | null;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}
function writeList(key: string, list: AdBanner[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage full or blocked: banners load from the network next time.
  }
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Every banner (admins), or the live ones (everyone else, as the database policy allows). */
export async function loadAdBanners(): Promise<AdBanner[]> {
  if (STATIC_DATA_MODE) return readList(DEMO_KEY) ?? [];
  const { data, error } = await supabase.from("ad_banners").select("*").order("sort_order").order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => bannerFromRow(row as AdBannerRow));
}

export async function saveAdBanner(banner: AdBanner | (Omit<AdBanner, "id"> & { id?: undefined })): Promise<AdBanner> {
  if (STATIC_DATA_MODE) {
    const list = readList(DEMO_KEY) ?? [];
    const saved: AdBanner = { ...banner, id: banner.id ?? crypto.randomUUID(), linkUrl: normaliseBannerLink(banner.linkUrl) };
    writeList(DEMO_KEY, banner.id ? list.map((b) => (b.id === banner.id ? saved : b)) : [...list, saved]);
    notify();
    return saved;
  }
  const row = bannerToRow(banner);
  const query = banner.id
    ? supabase.from("ad_banners").update(row).eq("id", banner.id).select("*").single()
    : supabase.from("ad_banners").insert(row).select("*").single();
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  notify();
  return bannerFromRow(data as AdBannerRow);
}

export async function deleteAdBanner(id: string) {
  if (STATIC_DATA_MODE) {
    writeList(DEMO_KEY, (readList(DEMO_KEY) ?? []).filter((b) => b.id !== id));
    notify();
    return;
  }
  const { error } = await supabase.from("ad_banners").delete().eq("id", id);
  if (error) throw new Error(error.message);
  notify();
}

/** Uploads a banner picture or video and returns its public address. */
export async function uploadAdMedia(file: File): Promise<string> {
  const problem = adMediaProblem(file);
  if (problem) throw new Error(problem);
  if (STATIC_DATA_MODE) {
    // The demo keeps small files in this browser; large ones last for this visit only.
    if (file.size > 3 * 1024 * 1024) return URL.createObjectURL(file);
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the file"));
      reader.readAsDataURL(file);
    });
  }
  const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `banners/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("ad-media").upload(path, file, {
    cacheControl: "31536000",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from("ad-media").getPublicUrl(path).data.publicUrl;
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// The banners sent with the page, converted once per page (the server and the browser start from the same).
const snapshotBanners = new WeakMap<StorefrontSnapshot, AdBanner[]>();
function liveSnapshotBanners(snapshot: StorefrontSnapshot) {
  let list = snapshotBanners.get(snapshot);
  if (!list) {
    list = snapshot.adBanners.map(bannerFromRow).filter((banner) => isBannerLive(banner, snapshot.servedAt));
    snapshotBanners.set(snapshot, list);
  }
  return list;
}

/**
 * The banners to show on the home page: the ones sent with the page (or last visit's), at once,
 * then the live set.
 */
export function useLiveAdBanners() {
  const snapshot = useStorefrontSnapshot();
  const [banners, setBanners] = useState<AdBanner[]>(() => (snapshot ? liveSnapshotBanners(snapshot) : []));
  const [ready, setReady] = useState(!!snapshot);
  useIsomorphicLayoutEffect(() => {
    if (snapshot) return;
    const cached = readList(STATIC_DATA_MODE ? DEMO_KEY : CACHE_KEY);
    if (cached?.length) setBanners(cached);
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      loadAdBanners()
        .then((list) => {
          if (!active) return;
          const live = list.filter((b) => isBannerLive(b));
          setBanners(live);
          if (!STATIC_DATA_MODE) writeList(CACHE_KEY, live);
        })
        .catch((cause) => console.warn("Ad banners could not be loaded:", cause instanceof Error ? cause.message : cause))
        .finally(() => { if (active) setReady(true); });
    };
    let cancelDeferred: (() => void) | undefined;
    if (snapshot) {
      writeList(CACHE_KEY, liveSnapshotBanners(snapshot));
      if (!snapshotIsFresh(snapshot)) cancelDeferred = afterPageLoad(refresh);
    } else {
      refresh();
    }
    listeners.add(refresh);
    return () => { active = false; cancelDeferred?.(); listeners.delete(refresh); };
  }, []);
  // Banners that came with the page are placed by the page's time, as the server did.
  return { ...bannersByPlacement(banners, snapshot && banners === snapshotBanners.get(snapshot) ? snapshot.servedAt : Date.now()), ready };
}
