import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adMediaProblem, bannerFromRow, bannerStatus, bannerToRow, bannersByPlacement, isBannerLive, normaliseBannerLink,
  type AdBanner,
} from "../src/lib/ad-banner-rules.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const banner = (over: Partial<AdBanner> = {}): AdBanner => ({
  id: "b1", title: "Diwali offer", subtitle: "", mediaKind: "image", mediaUrl: "https://x.supabase.co/a.jpg",
  mobileMediaUrl: null, fit: "cover", background: "#1f3d2f", linkUrl: "/shop", ctaLabel: "Shop now",
  placement: "main", sortOrder: 0, active: true, startsAt: null, endsAt: null, ...over,
});

test("ad banners: links stay on this site or https only", () => {
  assert.equal(normaliseBannerLink("/shop?category=Rice"), "/shop?category=Rice");
  assert.equal(normaliseBannerLink("  https://grainbazar.com/offers "), "https://grainbazar.com/offers");
  for (const bad of ["//evil.example", "javascript:alert(1)", "http://plain.example", "shop", "data:text/html,x"]) {
    assert.equal(normaliseBannerLink(bad), null, bad);
  }
  assert.equal(normaliseBannerLink(""), null);
});

test("ad banners: live only when switched on and inside the dates", () => {
  assert.equal(isBannerLive(banner(), NOW), true);
  assert.equal(isBannerLive(banner({ active: false }), NOW), false);
  assert.equal(isBannerLive(banner({ startsAt: "2026-10-31T00:00:00Z" }), NOW), false);
  assert.equal(isBannerLive(banner({ endsAt: "2026-10-30T12:00:00Z" }), NOW), false);
  assert.equal(isBannerLive(banner({ startsAt: "2026-10-29T00:00:00Z", endsAt: "2026-11-05T00:00:00Z" }), NOW), true);
  assert.equal(bannerStatus(banner({ startsAt: "2026-11-01T00:00:00Z" }), NOW), "Scheduled");
  assert.equal(bannerStatus(banner({ endsAt: "2026-10-01T00:00:00Z" }), NOW), "Ended");
  assert.equal(bannerStatus(banner({ active: false }), NOW), "Off");
  assert.equal(bannerStatus(banner(), NOW), "Live");
});

test("ad banners: split by place and kept in the admin's order", () => {
  const list = [
    banner({ id: "c", sortOrder: 20 }),
    banner({ id: "a", sortOrder: 0 }),
    banner({ id: "s", placement: "side" }),
    banner({ id: "off", sortOrder: 5, active: false }),
    banner({ id: "b", sortOrder: 10 }),
  ];
  const { main, side } = bannersByPlacement(list, NOW);
  assert.deepEqual(main.map((b) => b.id), ["a", "b", "c"]);
  assert.deepEqual(side.map((b) => b.id), ["s"]);
});

test("ad banners: database rows map both ways with safe defaults", () => {
  const mapped = bannerFromRow({
    id: "r1", title: "T", subtitle: "S", media_kind: "video", media_url: "https://x/v.mp4", mobile_media_url: null,
    fit: "weird", background: "red", link_url: "/shop", cta_label: "Go", placement: "other", sort_order: 3,
    active: true, starts_at: null, ends_at: null,
  });
  assert.equal(mapped.mediaKind, "video");
  assert.equal(mapped.fit, "cover");
  assert.equal(mapped.background, "#1f3d2f");
  assert.equal(mapped.placement, "main");
  const row = bannerToRow({ ...banner({ title: "  Hot deal  ", linkUrl: "javascript:x" }), id: undefined } as Omit<AdBanner, "id">);
  assert.equal(row.title, "Hot deal");
  assert.equal(row.link_url, null);
});

test("ad banners: only pictures and short videos can be uploaded", () => {
  const file = (type: string, size: number) => ({ type, size }) as File;
  assert.equal(adMediaProblem(file("image/webp", 800_000)), null);
  assert.equal(adMediaProblem(file("video/mp4", 30 * 1024 * 1024)), null);
  assert.match(adMediaProblem(file("image/svg+xml", 1000))!, /Choose a JPG/);
  assert.match(adMediaProblem(file("video/mp4", 51 * 1024 * 1024))!, /50 MB/);
});
