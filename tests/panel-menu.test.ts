import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  activeNavTarget,
  forgetPanelAccess,
  hasRecentPanelAccess,
  keepInView,
  readMenuScroll,
  rememberMenuScroll,
  rememberPanelAccess,
} from "../src/lib/panel-menu.ts";

// The real menu lists, read from their source files so these checks follow any change to the menus.
function menu(file: string, name: string): { to: string }[] {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`export const ${name}`);
  const body = text.slice(start, text.indexOf("];", start));
  return [...body.matchAll(/to: "([^"]+)"/g)].map((match) => ({ to: match[1]! }));
}
const adminNav = menu("src/lib/panel-nav.ts", "adminNav");
const vendorNav = menu("src/lib/panel-nav.ts", "vendorNav");
const accountNav = menu("src/lib/account-nav.ts", "accountNav");

test("the menus were read", () => {
  assert.ok(adminNav.length >= 25 && vendorNav.length >= 8 && accountNav.length >= 8);
});

test("each page lights up its own menu item, and only that one", () => {
  const cases: [string, { to: string }[], string][] = [
    ["/admin/zoho-api-calls", adminNav, "/admin/zoho-api-calls"],
    ["/admin/zoho", adminNav, "/admin/zoho"],
    ["/admin/zoho-diagnostics", adminNav, "/admin/zoho"],
    ["/admin/orders/GB-0611260001", adminNav, "/admin/orders"],
    ["/admin/orders/", adminNav, "/admin/orders"],
    ["/admin/delivery-note/GB-0611260001", adminNav, "/admin/delivery-notes"],
    ["/admin/delivery-notes", adminNav, "/admin/delivery-notes"],
    ["/admin/products/abc", adminNav, "/admin/products"],
    ["/admin/product-codes", adminNav, "/admin/product-codes"],
    ["/admin/payments", adminNav, "/admin/payments"],
    ["/admin/payouts", adminNav, "/admin/payouts"],
    ["/admin/partners", adminNav, "/admin/partners"],
    ["/admin/partner-report", adminNav, "/admin/partner-report"],
    ["/admin/customers/123", adminNav, "/admin/customers"],
    ["/admin/enquiries/9", adminNav, "/admin/enquiries"],
    ["/admin/vendors/7", adminNav, "/admin/vendors"],
    ["/vendor/products/add", vendorNav, "/vendor/products/add"],
    ["/vendor/products", vendorNav, "/vendor/products"],
    ["/vendor/orders/GB-1", vendorNav, "/vendor/orders"],
    ["/account", accountNav, "/account"],
    ["/account/orders/GB-1", accountNav, "/account/orders"],
    ["/account/profile", accountNav, "/account/profile"],
    // 13 Nov 2026: the panel's own wishlist page; the shop's /wishlist is not in the menu any more.
    ["/account/wishlist", accountNav, "/account/wishlist"],
    ["/account/how-to-order", accountNav, "/account/how-to-order"],
  ];
  for (const [path, items, expected] of cases) assert.equal(activeNavTarget(path, items), expected, path);
  assert.equal(activeNavTarget("/shop", adminNav), undefined);
});

test("every page that shows a side menu lights up an item in it", () => {
  const pages = readdirSync("src/routes").filter((file) => {
    if (!/^(admin|vendor|account)(\.|\.tsx$)/.test(file)) return false;
    return readFileSync(`src/routes/${file}`, "utf8").includes("<PanelLayout");
  });
  assert.ok(pages.length >= 55, `found ${pages.length} pages`);
  for (const file of pages) {
    const path = "/" + file.replace(/\.tsx$/, "").replace(/\$[A-Za-z]+/g, "x").split(".").join("/");
    const items = path.startsWith("/admin") ? adminNav : path.startsWith("/vendor") ? vendorNav : accountNav;
    assert.ok(activeNavTarget(path, items), `${file} (${path}) lights up nothing`);
  }
});

test("the menu scrolls only as far as needed to show the item", () => {
  const menuBox = { top: 100, bottom: 600 };
  const scroller = (scrollTop: number) => ({ scrollTop, getBoundingClientRect: () => menuBox });
  const item = (top: number) => ({ getBoundingClientRect: () => ({ top, bottom: top + 40 }) });

  const visible = scroller(300);
  keepInView(visible, item(300));
  assert.equal(visible.scrollTop, 300, "an item already in view does not move the menu");

  const below = scroller(0);
  keepInView(below, item(700));
  assert.equal(below.scrollTop, 148, "an item below the fold comes up just into view (740 - 592)");

  const above = scroller(500);
  keepInView(above, item(50));
  assert.equal(above.scrollTop, 442, "an item above comes down just into view (108 - 50)");
});

test("the menu's scroll is remembered between pages", () => {
  assert.equal(readMenuScroll("admin:full"), 0);
  rememberMenuScroll("admin:full", 812.4);
  rememberMenuScroll("admin:rail", 120);
  assert.equal(readMenuScroll("admin:full"), 812);
  assert.equal(readMenuScroll("admin:rail"), 120);
  assert.equal(readMenuScroll("vendor:full"), 0);
});

test("a passed sign-in check is trusted only for the same person, the same panel and 10 minutes", () => {
  const had = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = globalThis;
  try {
    const now = 1_000_000;
    assert.equal(hasRecentPanelAccess("u1", "admin", now), false);
    rememberPanelAccess("u1", "admin", now);
    assert.equal(hasRecentPanelAccess("u1", "admin", now + 60_000), true);
    assert.equal(hasRecentPanelAccess("u1", "vendor", now), false, "another panel is checked afresh");
    assert.equal(hasRecentPanelAccess("u2", "admin", now), false, "another person is checked afresh");
    assert.equal(hasRecentPanelAccess(undefined, "admin", now), false);
    assert.equal(hasRecentPanelAccess("u1", "admin", now + 10 * 60_000), false, "older than 10 minutes");
    forgetPanelAccess();
    assert.equal(hasRecentPanelAccess("u1", "admin", now), false, "forgotten on sign-out");
  } finally {
    (globalThis as { window?: unknown }).window = had;
  }
  assert.equal(hasRecentPanelAccess("u1", "admin"), false, "never trusted on the server");
});

test("the side menu uses the shared rule, not an exact address match", () => {
  const layout = readFileSync("src/components/panel/PanelLayout.tsx", "utf8");
  assert.ok(layout.includes("activeNavTarget("));
  assert.ok(!layout.includes("pathname === item.to"));
});
