// The side menu of the admin, vendor and customer panels. Every panel page renders its own PanelLayout, so on each
// click the menu is built again. This file holds what must survive that: where the menu was scrolled to, which
// item belongs to the page, and that this browser already passed the panel's sign-in check a moment ago.
// No imports, so the tests can load it directly.

/** Pages that are not in the menu, shown as part of the menu item they belong to. */
const MENU_ALIASES: Record<string, string> = {
  "/admin/zoho-diagnostics": "/admin/zoho",
  "/admin/delivery-note": "/admin/delivery-notes",
  "/admin/returns": "/admin/orders",
  "/admin/reviews": "/admin/products",
};

function within(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The menu item for this page: the item whose address is the longest whole-segment start of the page's address,
 * so an order's own page lights up Orders, "Add Product" wins over "Products", and "/admin/zoho-api-calls" does not
 * light up "/admin/zoho". Undefined when nothing fits.
 */
export function activeNavTarget(pathname: string, items: ReadonlyArray<{ to: string }>): string | undefined {
  let path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const [from, to] of Object.entries(MENU_ALIASES)) {
    if (within(path, from)) {
      path = to;
      break;
    }
  }
  let best: string | undefined;
  for (const item of items) {
    if (within(path, item.to) && (best === undefined || item.to.length > best.length)) best = item.to;
  }
  return best;
}

type Box = { top: number; bottom: number };
type Scroller = { scrollTop: number; getBoundingClientRect(): Box };

/** Scroll the menu only as far as needed for the item to be fully in view, with a small margin. */
export function keepInView(menu: Scroller, item: { getBoundingClientRect(): Box }, margin = 8): void {
  const view = menu.getBoundingClientRect();
  const box = item.getBoundingClientRect();
  if (box.top < view.top + margin) menu.scrollTop -= view.top + margin - box.top;
  else if (box.bottom > view.bottom - margin) menu.scrollTop += box.bottom - (view.bottom - margin);
}

// ---- where each menu was scrolled to: kept in memory between pages, and for this tab across a reload
const SCROLL_STORE = "gb-panel-menu-scroll";
const scrolls = new Map<string, number>();

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readMenuScroll(key: string): number {
  const known = scrolls.get(key);
  if (known !== undefined) return known;
  try {
    const saved = Number((JSON.parse(session()?.getItem(SCROLL_STORE) ?? "{}") as Record<string, unknown>)[key]);
    if (Number.isFinite(saved) && saved >= 0) {
      scrolls.set(key, saved);
      return saved;
    }
  } catch {
    /* storage blocked or damaged: start at the top */
  }
  return 0;
}

export function rememberMenuScroll(key: string, top: number): void {
  const value = Math.max(0, Math.round(top));
  scrolls.set(key, value);
  try {
    const store = session();
    if (!store) return;
    const saved = JSON.parse(store.getItem(SCROLL_STORE) ?? "{}") as Record<string, number>;
    saved[key] = value;
    store.setItem(SCROLL_STORE, JSON.stringify(saved));
  } catch {
    /* storage blocked: the in-memory copy still works between pages */
  }
}

// ---- the panel sign-in check, remembered for a short while in this tab only
// Moving between pages of the same panel no longer blanks the screen with "Checking your secure sign-in…": the page
// shows at once and the same check runs again behind it. Anything it finds wrong still signs out or leaves the
// panel as before. The data itself is always protected by the database (row-level security), not by this check.
const ACCESS_MAX_AGE_MS = 10 * 60_000;
let access: { userId: string; tone: string; at: number } | null = null;

export function hasRecentPanelAccess(userId: string | undefined, tone: string, now = Date.now()): boolean {
  if (typeof window === "undefined" || !userId || !access) return false;
  return access.userId === userId && access.tone === tone && now - access.at < ACCESS_MAX_AGE_MS;
}

export function rememberPanelAccess(userId: string, tone: string, now = Date.now()): void {
  access = { userId, tone, at: now };
}

export function forgetPanelAccess(): void {
  access = null;
}
