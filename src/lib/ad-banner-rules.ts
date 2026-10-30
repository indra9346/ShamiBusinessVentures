/*
 * Rules for the home page advertising banners (no browser or database code, so they can be
 * unit-tested): row <-> banner mapping, safe links, what is live now, and upload checks.
 */

export type AdPlacement = "main" | "side";
export type AdBanner = {
  id: string;
  title: string;
  subtitle: string;
  mediaKind: "image" | "video";
  mediaUrl: string;
  mobileMediaUrl: string | null;
  fit: "cover" | "contain";
  background: string;
  linkUrl: string | null;
  ctaLabel: string;
  placement: AdPlacement;
  sortOrder: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

export type AdBannerRow = {
  id: string; title: string; subtitle: string; media_kind: string; media_url: string; mobile_media_url: string | null;
  fit: string; background: string; link_url: string | null; cta_label: string; placement: string; sort_order: number;
  active: boolean; starts_at: string | null; ends_at: string | null;
};

export const AD_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const AD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
export const AD_VIDEO_TYPES = ["video/mp4", "video/webm"];

export function bannerFromRow(row: AdBannerRow): AdBanner {
  return {
    id: row.id,
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    mediaKind: row.media_kind === "video" ? "video" : "image",
    mediaUrl: row.media_url,
    mobileMediaUrl: row.mobile_media_url,
    fit: row.fit === "contain" ? "contain" : "cover",
    background: /^#[0-9a-f]{6}$/i.test(row.background) ? row.background : "#1f3d2f",
    linkUrl: row.link_url,
    ctaLabel: row.cta_label ?? "",
    placement: row.placement === "side" ? "side" : "main",
    sortOrder: Number(row.sort_order) || 0,
    active: !!row.active,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export function bannerToRow(banner: Omit<AdBanner, "id">) {
  return {
    title: banner.title.trim().slice(0, 120),
    subtitle: banner.subtitle.trim().slice(0, 200),
    media_kind: banner.mediaKind,
    media_url: banner.mediaUrl,
    mobile_media_url: banner.mobileMediaUrl || null,
    fit: banner.fit,
    background: banner.background,
    link_url: normaliseBannerLink(banner.linkUrl),
    cta_label: banner.ctaLabel.trim().slice(0, 40),
    placement: banner.placement,
    sort_order: banner.sortOrder,
    active: banner.active,
    starts_at: banner.startsAt || null,
    ends_at: banner.endsAt || null,
  };
}

/** A link a banner may open: a page on this site ("/shop") or an https address; anything else is dropped. */
export function normaliseBannerLink(raw: string | null | undefined): string | null {
  const link = (raw ?? "").trim();
  if (!link) return null;
  if (link.startsWith("/") && !link.startsWith("//")) return link;
  if (/^https:\/\/[^\s]+$/i.test(link)) return link;
  return null;
}

/** On now: switched on and inside its start / end dates. */
export function isBannerLive(banner: AdBanner, now = Date.now()) {
  if (!banner.active) return false;
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return false;
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return false;
  return true;
}

/** "Live", "Scheduled", "Ended" or "Off", for the admin list. */
export function bannerStatus(banner: AdBanner, now = Date.now()): "Live" | "Scheduled" | "Ended" | "Off" {
  if (!banner.active) return "Off";
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return "Ended";
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return "Scheduled";
  return "Live";
}

export function sortBanners(list: AdBanner[]) {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** The live banners for each place on the home page, in order. */
export function bannersByPlacement(list: AdBanner[], now = Date.now()) {
  const live = sortBanners(list.filter((banner) => isBannerLive(banner, now)));
  return { main: live.filter((b) => b.placement === "main"), side: live.filter((b) => b.placement === "side") };
}

export function adMediaProblem(file: File): string | null {
  if (![...AD_IMAGE_TYPES, ...AD_VIDEO_TYPES].includes(file.type)) return "Choose a JPG, PNG, WebP, GIF or AVIF picture, or an MP4 / WebM video";
  if (file.size > AD_MEDIA_MAX_BYTES) return "The file must be 50 MB or smaller";
  return null;
}
