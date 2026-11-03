import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adMediaProblem, bannerFromRow, bannerStatus, bannerToRow, bannersByPlacement, flickStep, isBannerLive, normaliseBannerLink, stripCopies, wrapStrip,
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

test("phone strip: enough copies to fill the strip anywhere in the loop", () => {
  assert.equal(stripCopies(343, 922.5), 2); // 5 tiles on a phone
  assert.equal(stripCopies(343, 369), 2); // 2 tiles on a phone
  assert.equal(stripCopies(975, 536), 3); // 2 tiles on a wide tablet
  assert.equal(stripCopies(536, 536), 2); // exactly one loop wide
  for (const [strip, loop] of [[320, 120], [975, 268], [343, 369]] as const) {
    // At the end of the loop the next tile starts at or beyond the strip's right edge.
    assert.ok(stripCopies(strip, loop) * loop - loop >= strip, `${strip}/${loop}`);
  }
});

test("phone strip: a position stays inside the loop either way", () => {
  assert.equal(wrapStrip(0, 100), 0);
  assert.equal(wrapStrip(100, 100), 0);
  assert.equal(wrapStrip(130, 100), 30);
  assert.equal(wrapStrip(-30, 100), 70);
  assert.equal(wrapStrip(-230, 100), 70);
});

test("phone strip: a flick slows down and goes as far at any frame rate", () => {
  const travel = (frameMs: number) => {
    let velocity = 2;
    let distance = 0;
    for (let t = 0; t < 2000; t += frameMs) {
      const step = flickStep(velocity, frameMs, 325);
      distance += step.distance;
      assert.ok(Math.abs(step.velocity) < Math.abs(velocity));
      velocity = step.velocity;
    }
    return distance;
  };
  assert.ok(Math.abs(travel(1000 / 60) - travel(1000 / 120)) < 1);
  assert.ok(Math.abs(travel(100) - travel(1000 / 120)) < 1); // a stalled frame does not overshoot
  assert.ok(travel(1000 / 60) > 600 && travel(1000 / 60) < 650); // 2 px/ms carries about 650 px
  assert.ok(flickStep(-2, 16, 325).distance < 0); // the other way
  assert.deepEqual(flickStep(2, -5, 325), { distance: 0, velocity: 2 }); // a frame stamped before the flick began
});
