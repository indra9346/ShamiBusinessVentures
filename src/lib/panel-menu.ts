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
  "/admin/profile": "/admin/settings",
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

// ---- the admin menu's sections (like Zoho Books): which page sits where, and which sections are open on this device
export type MenuGroup<T> = { key: string; label: string; items: T[] };

const ADMIN_GROUPS: { key: string; label: string; pages: string[] }[] = [
  { key: "", label: "", pages: ["/admin/dashboard"] },
  { key: "sales", label: "Sales", pages: ["/admin/orders", "/admin/delivery-notes", "/admin/customers", "/admin/enquiries", "/admin/follow-ups", "/admin/coupons"] },
  { key: "money", label: "Payments", pages: ["/admin/payments", "/admin/upi-payments", "/admin/payouts", "/admin/commissions"] },
  { key: "products", label: "Products", pages: ["/admin/products", "/admin/product-codes", "/admin/categories", "/admin/pricing", "/admin/ads"] },
  { key: "inventory", label: "Inventory", pages: ["/admin/inventory", "/admin/batches", "/admin/stock-counts", "/admin/rice-samples"] },
  { key: "partners", label: "Partners & Godowns", pages: ["/admin/partners", "/admin/partner-payouts", "/admin/partner-report", "/admin/branches", "/admin/vendors", "/admin/attendance"] },
  { key: "reports", label: "Reports", pages: ["/admin/reports", "/admin/godown-report"] },
  { key: "system", label: "Zoho & Settings", pages: ["/admin/zoho", "/admin/zoho-api-calls", "/admin/notifications", "/admin/settings"] },
];

/** The menu's items in their sections, in the order above. A page nobody placed still shows, under More. */
export function adminNavGroups<T extends { to: string }>(items: ReadonlyArray<T>): MenuGroup<T>[] {
  const placed = new Set(ADMIN_GROUPS.flatMap((group) => group.pages));
  const groups: MenuGroup<T>[] = ADMIN_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    items: group.pages.map((page) => items.find((item) => item.to === page)).filter((item): item is T => Boolean(item)),
  })).filter((group) => group.items.length > 0);
  const rest = items.filter((item) => !placed.has(item.to));
  if (rest.length) groups.push({ key: "more", label: "More", items: [...rest] });
  return groups;
}

const GROUPS_STORE = "gb-panel-menu-groups";

/** Is this section open: the admin's own choice on this device, and the section of the page being shown always starts open. */
export function groupOpenState(key: string, saved: Record<string, boolean>, activeGroup: string | undefined): boolean {
  if (key === activeGroup) return true;
  return saved[key] === true;
}

export function nextGroupOpenState(saved: Record<string, boolean>, key: string, open: boolean): Record<string, boolean> {
  return { ...saved, [key]: open };
}

export function readMenuGroups(): Record<string, boolean> {
  try {
    if (typeof window === "undefined") return {};
    const parsed = JSON.parse(window.localStorage.getItem(GROUPS_STORE) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveMenuGroups(saved: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(GROUPS_STORE, JSON.stringify(saved));
  } catch {
    /* storage blocked: the sections still work on this page */
  }
}
