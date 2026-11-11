import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  MAX_FAVOURITES, cleanFavourites, entryKey, matchScore, moveFavourite, panelEntries, pickElement, rememberPick, searchPanel, toggleFavourite,
} from "../src/lib/panel-search.ts";
import { PANEL_FEATURES, PANEL_PAGES } from "../src/lib/panel-search-index.ts";
import {
  ORDER_FILTERS, filterCounts, matchesOrderFilter, matchesPaymentFilter, matchesReleasedFilter, matchesSearch,
} from "../src/lib/list-search.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// 11 Nov 2026, the owner: "in all respective role pages ... need one interactive search bar for easily getting the
// button pages ... auto suggestions accurately for faster access and need favourites pages", and the handwritten note:
// "Add Channel Partner option if it is not available · Give filter option in channel partner logins for orders & same
// in godown in-charge (staff) · Give search option also in all the places".

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const entries = (panel: keyof typeof PANEL_PAGES) => panelEntries(PANEL_PAGES[panel], PANEL_FEATURES[panel]);
const top = (panel: keyof typeof PANEL_PAGES, query: string, n = 3) => searchPanel(entries(panel), query).slice(0, n);

test("the index is built from the pages as they are now", () => {
  const out = execFileSync(process.execPath, ["scripts/build-panel-search-index.mjs", "--check"], { cwd: new URL(".", root), encoding: "utf8" });
  assert.match(out, /up to date/);
});

test("every panel has its pages, and its buttons and sections", () => {
  for (const panel of ["admin", "vendor", "customer", "partner", "staff"] as const) {
    assert.ok(PANEL_PAGES[panel].length >= 3, `${panel} pages`);
    assert.ok(PANEL_FEATURES[panel].length >= 15, `${panel} buttons`);
    for (const item of PANEL_FEATURES[panel]) {
      assert.ok(PANEL_PAGES[panel].some((page) => page.to === item.to), `${item.text} is on a page of the ${panel} panel`);
      // Words people read, never code: no class names, no braces, no busy states.
      assert.doesNotMatch(item.text, /[{}<>=]|^(text|bg|flex|grid|rounded|border|h|w|px|py)-|…$/, item.text);
    }
  }
  const has = (panel: keyof typeof PANEL_PAGES, to: string, text: string) =>
    assert.ok(PANEL_FEATURES[panel].some((item) => item.to === to && item.text === text), `${panel}: ${text} on ${to}`);
  has("admin", "/admin/attendance", "Add employee");
  has("admin", "/admin/attendance", "Reset password");
  has("admin", "/admin/attendance", "Make in-charge");
  has("admin", "/admin/partners", "Add channel partner");
  has("admin", "/admin/partners", "Settle commissions");
  has("partner", "/partner", "Customer invoices");
  has("partner", "/partner", "Released delivery notes");
  has("staff", "/staff", "Released delivery notes");
  has("staff", "/staff", "Request leave");
  // The search bar's own buttons are not suggestions.
  assert.ok(!PANEL_FEATURES.admin.some((item) => item.text === "Move up" || item.text === "Favourites"));
  // Sign-in pages are not part of a panel.
  assert.ok(!PANEL_PAGES.admin.some((page) => page.to === "/admin/login"));
});

test("suggestions: a button by its name, a page by its name, with the page's own name too", () => {
  const [first] = top("admin", "add employee");
  assert.deepEqual([first!.to, first!.label, first!.kind], ["/admin/attendance", "Add employee", "section"]);
  assert.equal(top("admin", "channel partners")[0]!.to, "/admin/partners");
  assert.equal(top("admin", "channel partners")[0]!.kind, "page", "the page first");
  assert.ok(top("admin", "add channel", 5).some((entry) => entry.label === "Add channel partner"));
  assert.ok(top("admin", "attendance reset password", 3).some((entry) => entry.label === "Reset password" && entry.to === "/admin/attendance"));
  assert.ok(top("partner", "invoices", 3).some((entry) => entry.label === "Customer invoices"));
  assert.ok(top("staff", "leave", 3).some((entry) => entry.label === "Request leave"));
  assert.deepEqual(searchPanel(entries("admin"), "   "), []);
  assert.deepEqual(searchPanel(entries("admin"), "zzqqxx"), []);
});

test("small spelling slips are forgiven; letters must still be there", () => {
  assert.equal(top("admin", "patners")[0]!.to, "/admin/partners");
  assert.ok(top("admin", "atendance", 3).some((entry) => entry.to === "/admin/attendance"));
  assert.equal(matchScore("Partner Payouts", "pa"), 85);
  assert.equal(matchScore("Partner Payouts", "payouts partner"), 70 - 2);
  assert.ok(matchScore("Delivery Notes", "delivry") > 0);
  assert.equal(matchScore("Delivery Notes", "dl"), 0);
});

test("Kannada typing finds the same pages, through the site's own Kannada words", () => {
  const translate = (text: string) => kn[text] ?? text;
  const attendance = kn["Attendance"];
  assert.ok(attendance, "the menu word has Kannada");
  const found = searchPanel(entries("admin"), attendance!, { translate });
  assert.equal(found[0]!.to, "/admin/attendance");
});

test("favourites and recent picks come first among equals", () => {
  const all = entries("admin");
  const plain = searchPanel(all, "report");
  const last = plain.at(-1)!;
  const boosted = searchPanel(all, "report", { favourites: new Set([last.key]) });
  assert.ok(boosted.indexOf(boosted.find((entry) => entry.key === last.key)!) < plain.length - 1);
  const recent = searchPanel(all, "report", { recent: [last.key] });
  assert.ok(recent.findIndex((entry) => entry.key === last.key) < plain.findIndex((entry) => entry.key === last.key));
});

test("favourites: this site only, short, no repeats, at most 40; add, remove, move", () => {
  const list = cleanFavourites([
    { to: "/admin/orders", label: "Orders" },
    { to: "/admin/orders", label: "Orders again" },
    { to_path: "/admin/attendance", label: "Add employee", find_text: "Add employee" },
    { to: "https://evil.example/", label: "x" }, { to: "//evil.example", label: "x" }, { to: "javascript:alert(1)", label: "x" },
    { to: "/admin/x", label: "" }, null, "x", 3,
  ]);
  assert.deepEqual(list.map((fav) => fav.key), ["/admin/orders", "/admin/attendance#Add employee"]);
  assert.deepEqual(cleanFavourites("nope"), []);
  assert.equal(cleanFavourites(Array.from({ length: 60 }, (_, i) => ({ to: `/admin/p${i}`, label: `P${i}` }))).length, MAX_FAVOURITES);

  let favs = toggleFavourite([], { to: "/partner", label: "Customer invoices", find: "Customer invoices" });
  assert.deepEqual(favs.map((fav) => fav.key), [entryKey("/partner", "Customer invoices")]);
  favs = toggleFavourite(favs, { to: "/slip", label: "Scan delivery QR", find: "" });
  assert.deepEqual(moveFavourite(favs, "/slip", -1).map((fav) => fav.key), ["/slip", "/partner#Customer invoices"]);
  assert.equal(moveFavourite(favs, "/slip", 1), favs, "the last cannot go further down");
  assert.deepEqual(toggleFavourite(favs, { to: "/slip", label: "x", find: "" }).map((fav) => fav.key), ["/partner#Customer invoices"], "a second tap removes it");
  const full = cleanFavourites(Array.from({ length: 40 }, (_, i) => ({ to: `/admin/p${i}`, label: `P${i}` })));
  assert.equal(toggleFavourite(full, { to: "/admin/new", label: "New", find: "" }), full, "no 41st");
  assert.deepEqual(rememberPick(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.equal(rememberPick(["a", "b", "c", "d", "e", "f"], "g").length, 6);
});

test("on the page, the button with exactly those words wins, then the smallest that starts with them", () => {
  const nodes = [
    { id: "section", text: "Customer invoices\nYour signature on these invoices …", size: 900 },
    { id: "heading", text: "Customer invoices", size: 17 },
    { id: "other", text: "Customer invoices help", size: 22 },
  ];
  assert.equal(pickElement(nodes, ["Customer invoices"])!.id, "heading");
  assert.equal(pickElement([{ id: "card", text: "Your commissions · Nov 2026", size: 27 }, { id: "big", text: "Your commissions · Nov 2026 and more", size: 200 }], ["Your commissions"])!.id, "card");
  // Kannada page: the Kannada words count too.
  assert.equal(pickElement([{ id: "kn", text: "ಗ್ರಾಹಕರ ಇನ್‌ವಾಯ್ಸ್‌ಗಳು", size: 10 }], ["Customer invoices", "ಗ್ರಾಹಕರ ಇನ್‌ವಾಯ್ಸ್‌ಗಳು"])!.id, "kn");
  assert.equal(pickElement(nodes, ["Nothing like it"]), null);
  assert.equal(pickElement(nodes, ["", "  "]), null);
});

test("list search: every word somewhere, numbers without their spaces and dashes", () => {
  const row = ["CLK-577522-071126-164455", "CLKINV0711260364", "Ravi Traders", "Payment Confirmed", "9876543210"];
  assert.ok(matchesSearch(row, "ravi"));
  assert.ok(matchesSearch(row, "RAVI clk"));
  assert.ok(matchesSearch(row, "577522071126"), "order number without dashes");
  assert.ok(matchesSearch(row, "98765 43210"), "phone with a space");
  assert.ok(!matchesSearch(row, "ravi hubli"));
  assert.ok(matchesSearch(row, ""));
  assert.ok(matchesSearch([null, undefined, 42], "42"));
});

test("order filters follow the portals' colours; delivered has its own", () => {
  const cases: [string, string[]][] = [
    ["Placed", ["all", "pending"]],
    ["Awaiting Payment", ["all", "pending"]],
    ["Payment Confirmed", ["all", "confirmed"]],
    ["Packed", ["all", "confirmed"]],
    ["Delivered", ["all", "delivered"]],
    ["Cancelled", ["all", "closed"]],
    ["Payment Expired", ["all", "closed"]],
  ];
  for (const [status, shows] of cases) {
    for (const filter of ORDER_FILTERS.map((item) => item.key)) {
      assert.equal(matchesOrderFilter(status, filter), shows.includes(filter), `${status} under ${filter}`);
    }
  }
  assert.ok(matchesPaymentFilter("Paid", "paid") && !matchesPaymentFilter("Pending", "paid"));
  assert.ok(matchesPaymentFilter("Partially Paid", "unpaid") && matchesPaymentFilter(null, "unpaid") && matchesPaymentFilter("x", "all"));
  assert.ok(matchesReleasedFilter({ delivered: false, to_go: 2 }, "to_go"));
  assert.ok(!matchesReleasedFilter({ delivered: false, to_go: 0 }, "to_go") && matchesReleasedFilter({ delivered: false, to_go: 0 }, "handed"));
  assert.ok(matchesReleasedFilter({ delivered: true, to_go: 3 }, "handed"));
  assert.deepEqual(filterCounts(["Placed", "Delivered", "Packed"], ["all", "pending", "delivered"], (status, key) => matchesOrderFilter(status, key)), { all: 3, pending: 1, delivered: 1 });
});

test("wired in: every panel's header, the side menu, the title star, the partner and staff pages", () => {
  const layout = read("src/components/panel/PanelLayout.tsx");
  assert.match(layout, /<PanelSearch panel=\{tone\} dataResults=\{dataResults\} \/>/);
  assert.match(layout, /<FavouriteToggle panel=\{tone\} label=\{title\} \/>/);
  assert.match(layout, /<FavouritesNav panel=\{tone\} rail=\{rail\} onPick=\{\(\) => setOpen\(false\)\} \/>/);
  assert.doesNotMatch(layout, /globalQuery/, "the old search box is gone");
  for (const [file, panel] of [["src/routes/partner.index.tsx", "partner"], ["src/routes/partner.attendance.tsx", "partner"], ["src/routes/staff.index.tsx", "staff"]]) {
    const page = read(file!);
    assert.match(page, new RegExp(`<PanelSearch panel="${panel}"`), file);
    assert.match(page, new RegExp(`<FavouritesBar panel="${panel}" />`), file);
  }
  const search = read("src/components/panel/PanelSearch.tsx");
  assert.match(search, /from\("panel_favourites"\)/);
  assert.match(search, /import\("@\/lib\/panel-search-index"\)/, "the index loads when needed, not with every page");
  assert.match(search, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === "k"/);
  // Review of 12 Nov 2026:
  // the favourites go through the store, which every page re-checks for who is signed in;
  assert.match(search, /createFavouritesStore\(panel, \{ db: favouritesDb, storage: deviceStorage, currentUser \}\)/);
  assert.match(search, /void store\.ensure\(\)\.catch\(\(\) => undefined\);\n\s+const \{ data \} = supabase\.auth\.onAuthStateChange/);
  // moving one is an update of that row, never an upsert that could bring back a removed one;
  assert.match(search, /from\("panel_favourites"\)\.update\(\{ position \}\)/);
  // the button is looked for once the new page is the one on screen;
  assert.match(search, /state\.status === "idle" \? \(state\.resolvedLocation \?\? state\.location\)\.pathname : ""/);
  assert.match(search, /const find = takePendingFind\(shownPath\);/);
  // the page header is searched too, never the search or the favourites;
  assert.match(search, /\.\.\.Array\.from\(document\.querySelectorAll<HTMLElement>\("header"\)\)/);
  assert.match(search, /!element\.closest\("\[data-panel-search-ui\]"\)/);
  // a broken address does not break the title's star;
  assert.match(search, /try \{\n\s+return decodeURIComponent\(last\);\n\s+\} catch \{/);
  // the phone's search sheet sits on the page, not inside the header (whose blur would trap it).
  assert.match(search, /createPortal\(\n\s+<div data-panel-search-ui="" className=\{cn\("fixed inset-0 z-\[60\]"/);
});

test("pages with no search on them are offered as pages only", () => {
  for (const panel of ["partner", "staff", "customer"] as const) {
    for (const to of ["/slip", "/staff/device", "/wishlist"]) {
      assert.ok(!PANEL_FEATURES[panel].some((item) => item.to === to), `${panel}: no buttons of ${to}`);
    }
  }
  assert.ok(PANEL_PAGES.partner.some((page) => page.to === "/slip"), "the scan page itself is still there");
  assert.ok(PANEL_PAGES.customer.some((page) => page.to === "/wishlist"));
  assert.ok(!PANEL_FEATURES.partner.some((item) => /sign in$/i.test(item.text)), "no buttons for signed-out visitors");
});

test("the admin's customer and vendor numbers are read in pages, so none are cut off", () => {
  const hook = read("src/hooks/use-zoho-contact-numbers.ts");
  assert.match(hook, /supabase\.rpc\("zoho_contact_numbers"\)\.range\(from, from \+ PAGE - 1\)/);
  assert.match(hook, /if \(page\.length < PAGE\) break;/);
});

test("filters and search on the partner's and staff's order lists; Add channel partner on the admin page", () => {
  const invoices = read("src/components/partners/PartnerInvoices.tsx");
  assert.match(invoices, /<ListFilters query=\{query\} onQuery=\{setQuery\} placeholder="Search order no\., invoice no\. or customer"/);
  assert.match(invoices, /\{shownRows\.map\(\(row\) =>/);
  const commissions = read("src/components/partners/PartnerWidgets.tsx");
  assert.match(commissions, /placeholder="Search order no\., customer, PIN code or product"/);
  assert.match(commissions, /\{shownOrders\.map\(\(order\) =>/);
  const released = read("src/components/panel/DeliveryNotePanel.tsx");
  assert.match(released, /placeholder="Search order no\., customer or note no\."/);
  assert.match(released, /const shown = all \|\| filtering \? matching : matching\.slice\(0, 8\);/);
  const partners = read("src/routes/admin.partners.tsx");
  assert.match(partners, /onClick=\{\(\) => setAdding\(true\)\}><UserPlus className="mr-1\.5 h-4 w-4" \/>Add channel partner<\/Button>/);
  assert.match(partners, /<CreatePartnerForm key=\{godown\.id\} godownId=\{godown\.id\}/);
  assert.match(partners, /A godown has one channel partner at a time/);
  // The login shown once stays on screen after the list reloads (review, 12 Nov 2026): in the window and on the card.
  assert.match(partners, /\{created \? <CredentialsBox email=\{created\.email\} password=\{created\.password\} godownName=\{created\.godownName\} \/>/);
  assert.match(partners, /onCreated=\{\(login\) => setCreated\(\{ \.\.\.login, godownName: godown\.name \}\)\}/);
  assert.match(partners, /\{created && <div className="mb-3"><CredentialsBox email=\{created\.email\}/);
  assert.match(partners, /onCreated\?\.\(login\);/);
});

test("the favourites table: own rows only, this site's addresses, 40 at most", () => {
  const sql = read("supabase/migrations/20261112170000_panel_favourites.sql");
  for (const action of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.match(sql, new RegExp(`FOR ${action} TO authenticated (USING|WITH CHECK) \\(user_id = auth\\.uid\\(\\)\\)`), action);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.panel_favourites FROM anon;/);
  assert.match(sql, /to_path ~ '\^\/\[A-Za-z0-9\/_\.-\]\{0,199\}\$' AND to_path !~ '\^\/\/'/);
  assert.match(sql, /You can keep up to 40 favourites here/);
});

test("new words have Kannada", () => {
  for (const key of [
    "Search pages and buttons", "Favourites", "Add to favourites", "Remove from favourites", "Add this page to favourites", "Pages and buttons",
    "Showing {0} of {1}", "Show everything", "Goods to hand over", "Not paid", "Add channel partner", "Open the godown's card",
    "No orders match. Clear the search or pick another filter.", "\"{0}\" is not shown on this page for you right now.",
  ]) assert.match(kn[key] ?? "", /[ಀ-೿]/, key);
});
