// Builds src/lib/panel-search-index.ts: every page of each sign-in panel (admin, vendor, customer, channel partner,
// godown staff) with the buttons, sections, tabs and cards on it, read from the page's own source and the components
// it uses. The panel search suggests these, so a person can type "add employee" or "bank statement" and land on the
// right page with that button shown (owner, 11 Nov 2026).
//
//   node scripts/build-panel-search-index.mjs          writes the file
//   node scripts/build-panel-search-index.mjs --check  exits 1 when the file is out of date (the tests run this)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(SRC, "lib", "panel-search-index.ts");
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** Which route files belong to which panel. Sign-in, sign-up and redirect-only pages are left out. */
const ROUTES = readdirSync(join(SRC, "routes")).filter((name) => name.endsWith(".tsx") && !name.includes("$"));
const PANELS = {
  admin: ROUTES.filter((name) => name.startsWith("admin.") && !["admin.login.tsx", "admin.index.tsx"].includes(name)),
  vendor: ROUTES.filter((name) => name.startsWith("vendor.") && !["vendor.login.tsx", "vendor.index.tsx", "vendor.register.tsx"].includes(name)),
  customer: [...ROUTES.filter((name) => name.startsWith("account.")), "wishlist.tsx"].filter((name) => ROUTES.includes(name)),
  partner: ["partner.index.tsx", "partner.attendance.tsx", "slip.tsx"],
  staff: ["staff.index.tsx", "staff.device.tsx", "slip.tsx"],
};

/** Page names people know them by: the side menus first, then these, then the page's own heading. */
const EXTRA_LABELS = {
  "/partner": "Home", "/partner/attendance": "Attendance & stock", "/slip": "Scan delivery QR",
  "/staff": "Home", "/staff/device": "Godown phone",
};

/** Words on so many pages that, alone, they find nothing useful. */
const STOP = new Set([
  "cancel", "close", "save", "saved", "edit", "delete", "remove", "copy", "copied", "new", "yes", "no", "ok", "back", "next",
  "previous", "prev", "refresh", "retry", "try again", "reload", "more", "less", "show all", "show fewer", "show less", "done",
  "submit", "add", "open", "view", "apply", "clear", "reset", "change", "update", "confirm", "search", "filter", "download",
  "print", "upload", "all", "today", "reopen", "hide", "show", "details", "loading", "keep", "skip", "send", "undo", "go",
  "on", "off", "select", "choose", "start", "stop", "logout", "log out", "sign out", "sign in",
]);

function navLabels() {
  const labels = {};
  for (const file of ["lib/panel-nav.ts", "lib/account-nav.ts"]) {
    for (const match of read(join(SRC, file)).matchAll(/\{ label: "([^"]+)", to: "([^"]+)"/g)) labels[match[2]] = match[1];
  }
  return labels;
}

/** The opening tag starting at `at` ("<Name ...>" or "<Name .../>"), skipping braces and strings. */
function openingTag(src, at) {
  let depth = 0;
  let quote = "";
  for (let i = at + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return { text: src.slice(at, i + 1), end: i + 1, selfClosing: src[i - 1] === "/" };
  }
  return null;
}

/** A string attribute's value: title="X", or the fixed start of title={`X ${...}`}. */
function attribute(tag, name) {
  const plain = tag.match(new RegExp(`\\b${name}="([^"]+)"`));
  if (plain) return plain[1];
  const quoted = tag.match(new RegExp(`\\b${name}=\\{"([^"]+)"\\}`));
  if (quoted) return quoted[1];
  const template = tag.match(new RegExp(`\\b${name}=\\{\`([^\`]*)\`\\}`));
  if (template) return template[1].split("${")[0];
  return null;
}

/** What an element says: its own words, or (when they come from code) the finished-state words in its strings. */
function elementWords(inner) {
  let outside = "";
  const literals = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (depth > 0) {
      if (quote) {
        if (ch === "\\") { i += 1; continue; }
        if (ch === quote) { if (!current.includes("${")) literals.push(current); quote = ""; current = ""; continue; }
        current += ch;
        continue;
      }
      if (ch === '"' || ch === "`") { quote = ch; current = ""; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      continue;
    }
    if (ch === "{") { depth = 1; outside += " "; continue; }
    outside += ch;
  }
  const own = clean(outside.replace(/<[^<>]*>/g, " "));
  if (letters(own) >= 3) return [own];
  // Words people read start with a capital or a number; class names and keys do not. "Creating…" is a busy state.
  return literals.map(clean).filter((text) => letters(text) >= 3 && /^[A-Z0-9₹]/.test(text) && !/(…|\.\.\.)$/.test(text));
}

const letters = (text) => (text.match(/[A-Za-z]/g) ?? []).length;
function clean(text) {
  return text.replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim().replace(/^[·:,\-–—\s]+|[·:,\-–—(\s]+$/g, "").trim();
}

/** Buttons, sections, tabs and cards in a piece of source. */
function features(src) {
  const found = [];
  const add = (text, kind) => {
    const words = clean(text ?? "");
    if (letters(words) < 3 || words.length > 60 || /[{}<>=]/.test(words) || STOP.has(words.toLowerCase())) return;
    found.push({ text: words, kind });
  };
  for (const match of src.matchAll(/<(Panel|StatCard|Button|button|Link|TabsTrigger|h2|h3|summary)\b/g)) {
    const tag = openingTag(src, match.index);
    if (!tag) continue;
    const name = match[1];
    if (name === "Panel") { add(attribute(tag.text, "title"), "section"); continue; }
    if (name === "StatCard") { add(attribute(tag.text, "label"), "card"); continue; }
    if (tag.selfClosing) continue;
    const close = src.indexOf(`</${name}>`, tag.end);
    if (close < 0 || close - tag.end > 1500) continue;
    const kind = name === "h2" || name === "h3" || name === "summary" ? "section" : name === "TabsTrigger" ? "tab" : name === "Link" ? "link" : "button";
    for (const words of elementWords(src.slice(tag.end, close))) add(words, kind);
  }
  return found;
}

/** Top-level declarations of a file: name to source. */
function blocks(src) {
  const lines = src.split("\n");
  const out = new Map();
  let name = null;
  let start = 0;
  const flush = (end) => { if (name) out.set(name, lines.slice(start, end).join("\n")); };
  lines.forEach((line, index) => {
    const match = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)\s*[=:])/);
    if (match) { flush(index); name = match[1] ?? match[2]; start = index; }
  });
  flush(lines.length);
  return out;
}

/** "@/components/..." imports of a piece of source: file to the names it brings in. */
function componentImports(src) {
  const out = [];
  for (const match of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@\/components\/([^"]+)"/g)) {
    const path = match[2];
    if (/^(ui|site|brand)\//.test(path) || ["panel/PanelLayout", "panel/widgets", "panel/pager", "panel/PanelSearch"].includes(path)) continue;
    const file = [".tsx", ".ts"].map((ext) => join(SRC, "components", `${path}${ext}`)).find(existsSync);
    if (!file) continue;
    const names = match[1].split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()).filter((n) => /^[A-Z]/.test(n));
    out.push({ file, names });
  }
  return out;
}

/** The source a page actually draws: the route file and, from each component file it uses, the parts it uses. */
function pageSource(routeFile) {
  const parts = [];
  const seen = new Set();
  const visit = (file, wanted, depth) => {
    const src = read(file);
    const all = blocks(src);
    const used = new Set();
    const queue = wanted ? [...wanted] : [...all.keys()];
    while (queue.length) {
      const name = queue.shift();
      const key = `${file}#${name}`;
      if (used.has(name) || seen.has(key) || !all.has(name)) continue;
      used.add(name);
      seen.add(key);
      const body = all.get(name);
      parts.push(body);
      // Same-file components this one draws.
      for (const ref of body.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) if (all.has(ref[1])) queue.push(ref[1]);
    }
    if (depth >= 3) return;
    const usedSource = [...used].map((name) => all.get(name)).join("\n");
    for (const { file: next, names } of componentImports(src)) {
      const drawn = names.filter((name) => new RegExp(`<${name}\\b`).test(usedSource));
      if (drawn.length) visit(next, drawn, depth + 1);
    }
  };
  visit(routeFile, null, 0);
  return parts.join("\n");
}

function routePath(src, file) {
  const match = src.match(/createFileRoute\("([^"]+)"\)/);
  if (!match) throw new Error(`no route path in ${file}`);
  return match[1].length > 1 ? match[1].replace(/\/$/, "") : match[1];
}

function pageLabel(path, src, labels) {
  if (labels[path]) return labels[path];
  if (EXTRA_LABELS[path]) return EXTRA_LABELS[path];
  const title = src.match(/<PanelLayout\b[^>]*?\btitle="([^"]+)"/);
  if (title) return title[1];
  const meta = src.match(/title: "([^"|]+?)\s*(?:\||")/);
  return meta ? meta[1].trim() : path;
}

export function buildIndex() {
  const labels = navLabels();
  const pages = {};
  const items = {};
  for (const [panel, files] of Object.entries(PANELS)) {
    pages[panel] = [];
    items[panel] = [];
    for (const name of files) {
      const file = join(SRC, "routes", name);
      if (!existsSync(file)) continue;
      const src = read(file);
      const to = routePath(src, name);
      const label = pageLabel(to, src, labels);
      pages[panel].push({ to, label });
      const seen = new Set([label.toLowerCase()]);
      for (const feature of features(pageSource(file))) {
        const key = feature.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items[panel].push({ to, text: feature.text, kind: feature.kind });
      }
    }
    // Menu order for pages people know from the menu, then the rest.
    const order = Object.keys(labels);
    pages[panel].sort((a, b) => (order.indexOf(a.to) + 1 || 999) - (order.indexOf(b.to) + 1 || 999));
  }
  const body = (value) => JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");
  const lines = [
    "// GENERATED by scripts/build-panel-search-index.mjs from the panel pages. Do not edit by hand: change the pages and",
    "// run `node scripts/build-panel-search-index.mjs` (the tests check this file is up to date).",
    "",
    'export type PanelKey = "admin" | "vendor" | "customer" | "partner" | "staff";',
    "export type PanelPage = { to: string; label: string };",
    '/** A button, section, tab, card or link on a page; `text` is what the page shows, used to find it there. */',
    'export type PanelFeature = { to: string; text: string; kind: "section" | "button" | "tab" | "card" | "link" };',
    "",
    "export const PANEL_PAGES: Record<PanelKey, PanelPage[]> = {",
    ...Object.entries(pages).map(([panel, list]) => `  ${panel}: [\n${list.map((page) => `    ${body(page)},`).join("\n")}\n  ],`),
    "};",
    "",
    "export const PANEL_FEATURES: Record<PanelKey, PanelFeature[]> = {",
    ...Object.entries(items).map(([panel, list]) => `  ${panel}: [\n${list.map((item) => `    ${body(item)},`).join("\n")}\n  ],`),
    "};",
    "",
  ];
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = buildIndex();
  if (process.argv.includes("--check")) {
    const now = existsSync(OUT) ? read(OUT) : "";
    if (now !== next) {
      console.error("src/lib/panel-search-index.ts is out of date: run node scripts/build-panel-search-index.mjs");
      process.exit(1);
    }
    console.log("panel search index is up to date");
  } else {
    writeFileSync(OUT, next);
    const count = (next.match(/"kind"/g) ?? []).length;
    console.log(`wrote ${OUT} (${count} buttons and sections)`);
  }
}
