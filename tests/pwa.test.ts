import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { showsInstallOffer } from "../src/lib/pwa.ts";

test("the install offer appears only while browsing", () => {
  for (const path of ["/", "/shop", "/categories", "/categories/sugar", "/product/abc", "/about", "/contact"]) assert.equal(showsInstallOffer(path), true, path);
  for (const path of ["/cart", "/checkout", "/login", "/register", "/account", "/account/orders", "/admin/dashboard", "/vendor/dashboard", "/partner", "/staff", "/slip", "/privacy", "/shopping", "/productx"]) {
    assert.equal(showsInstallOffer(path), false, path);
  }
});

test("the manifest meets what browsers ask for an install", () => {
  const manifest = JSON.parse(readFileSync("public/site.webmanifest", "utf8"));
  assert.equal(manifest.name, "Grain Bazar");
  assert.equal(manifest.short_name, "Grain Bazar");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.display, "standalone");
  const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable"));
  for (const icon of manifest.icons as Array<{ src: string }>) assert.ok(existsSync(`public${icon.src.split("?")[0]}`), icon.src);
});

test("no service worker: a site that changes prices and code must never serve an old copy", () => {
  assert.equal(existsSync("public/sw.js"), false);
  for (const file of readdirSync("src/lib")) {
    if (/\.tsx?$/.test(file)) assert.doesNotMatch(readFileSync(`src/lib/${file}`, "utf8"), /serviceWorker\.register\(/, file);
  }
  assert.doesNotMatch(readFileSync("src/routes/__root.tsx", "utf8"), /serviceWorker\.register\(/);
});
