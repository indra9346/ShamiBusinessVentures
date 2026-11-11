// The search bar and favourites of every sign-in panel (owner, 11 Nov 2026): "in all respective role pages need one
// interactive search bar for easily getting the button pages ... auto suggestions accurately for faster access and need
// favourites pages so they can add respective pages which they deal with to their favourites".
//
// The suggestions come from src/lib/panel-search-index.ts (every page of the panel and the buttons, sections, tabs and
// cards on it), plus, where the panel has them, products, people and orders. Picking a button opens its page and shows
// that button (scrolled to, outlined for a moment, its tab opened). Favourites are kept per person in the database
// (public.panel_favourites), so they follow them to any phone; before that table exists, on this device only.
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, FileText, FolderOpen, History, LayoutGrid, Link2, MousePointerClick, Rows3, Search, Star, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { createFavouritesStore, type FavouritesDb, type FavouritesStorage, type FavouritesStore } from "@/lib/favourites-store";
import { translateText, useLanguage } from "@/lib/i18n";
import { isKannadaLoaded, loadKannada } from "@/lib/i18n-core";
import {
  MAX_FAVOURITES, entryKey, panelEntries, pickElement, rememberPick, searchPanel,
  type Favourite, type PanelEntry, type PanelKey,
} from "@/lib/panel-search";
import { cn } from "@/lib/utils";

/** A product, person or order the panel already has in hand (admin, vendor and customer panels). */
export type PanelDataResult = { label: string; detail: string; to: string; image?: string; fallbackImage?: string };

const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
const pathOf = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);

// ---- favourites: one store per panel (src/lib/favourites-store.ts), so the menu, the star and the search agree

const favouritesDb: FavouritesDb = {
  async select(userId, panel) {
    if (STATIC_DATA_MODE) return { data: null, error: { message: "demo" } };
    const { data, error } = await supabase.from("panel_favourites").select("item_key,label,to_path,find_text,position")
      .eq("user_id", userId).eq("panel", panel).order("position").order("id");
    return { data, error };
  },
  async add(rows) {
    const { error } = await supabase.from("panel_favourites").upsert(rows, { onConflict: "user_id,panel,item_key" });
    return { error };
  },
  async remove(userId, panel, key) {
    const { error } = await supabase.from("panel_favourites").delete().eq("user_id", userId).eq("panel", panel).eq("item_key", key);
    return { error };
  },
  async place(userId, panel, key, position) {
    const { error } = await supabase.from("panel_favourites").update({ position }).eq("user_id", userId).eq("panel", panel).eq("item_key", key);
    return { error };
  },
};
const deviceStorage: FavouritesStorage = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
};
const currentUser = async () => (await supabase.auth.getSession()).data.session?.user.id ?? null;
const stores = new Map<PanelKey, FavouritesStore>();
function storeOf(panel: PanelKey): FavouritesStore {
  let store = stores.get(panel);
  if (!store) {
    store = createFavouritesStore(panel, { db: favouritesDb, storage: deviceStorage, currentUser });
    stores.set(panel, store);
  }
  return store;
}
const EMPTY_FAVOURITES = { list: [] as Favourite[], userId: null, mode: "loading" as const };

/** This person's favourites in a panel, with adding, removing and moving. */
export function usePanelFavourites(panel: PanelKey) {
  const store = storeOf(panel);
  const state = useSyncExternalStore(store.subscribe, store.getState, () => EMPTY_FAVOURITES);
  useEffect(() => {
    // Every page checks who is signed in: a sign-out and another person's sign-in in between gets their own list.
    void store.ensure().catch(() => undefined);
    const { data } = supabase.auth.onAuthStateChange(() => {
      // Supabase asks for no awaits inside this callback: check just after it.
      window.setTimeout(() => void store.ensure().catch(() => undefined), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [store]);
  const keys = useMemo(() => new Set(state.list.map((fav) => fav.key)), [state.list]);
  const toggle = useCallback((item: Omit<Favourite, "key">) => {
    void store.toggle(item).then((result) => {
      if (result === "added") toast.success("Added to favourites");
      else if (result === "removed") toast.success("Removed from favourites");
      else if (result === "full") toast.error(`You can keep up to ${MAX_FAVOURITES} favourites. Remove one first.`);
      else if (result === "signed-out") toast.error("Sign in again to keep favourites");
      else toast.error("Could not save your favourites");
    });
  }, [store]);
  const move = useCallback((key: string, step: -1 | 1) => {
    void store.move(key, step).then((saved) => { if (!saved) toast.error("Could not save your favourites"); });
  }, [store]);
  return { favourites: state.list, ready: state.mode !== "loading" || state.list.length > 0, keys, toggle, move };
}

// ---- opening a page and showing the button on it

const PENDING_FIND = "gb-panel-find";
function setPendingFind(to: string, find: string) {
  try {
    sessionStorage.setItem(PENDING_FIND, JSON.stringify({ to: pathOf(to), find, at: Date.now() }));
  } catch {
    /* storage blocked: the page still opens */
  }
}
function takePendingFind(pathname: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_FIND) ?? "null") as { to?: string; find?: string; at?: number } | null;
    if (!saved?.find || !saved.to || !samePath(saved.to, pathname) || Date.now() - (saved.at ?? 0) > 30_000) return null;
    sessionStorage.removeItem(PENDING_FIND);
    return saved.find;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const visible = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};
const HIGHLIGHT = ["ring-4", "ring-gold", "ring-offset-2", "ring-offset-white"];

function findOnPage(words: string[]): HTMLElement | null {
  // The page itself first, then its header (the partner page's "Attendance & stock"); never the side menu.
  const roots = [document.querySelector<HTMLElement>("main") ?? document.body, ...Array.from(document.querySelectorAll<HTMLElement>("header"))];
  const nodes = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, button, a, [role='tab'], summary, label, p")))
    // The favourites bar and the search say the same words: never the thing to show.
    .filter((element) => !element.closest("[data-panel-search-ui]"));
  const candidates = nodes.filter(visible).map((element) => ({ element, text: element.innerText || element.textContent || "", size: (element.innerText || "").length }));
  return pickElement(candidates, words)?.element ?? null;
}

/**
 * Shows the element with these words on this page: waits for the page's data (up to 6 s), then looks behind the
 * page's tabs. Scrolls it to the middle, outlines it for a moment and puts the keyboard on it. False when it is not there.
 */
/** Opens a tab: the site's tabs switch on the mouse press, other tabs on a click. */
function openTab(tab: HTMLElement) {
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  if (tab.getAttribute("aria-selected") !== "true") tab.click();
}

export async function revealOnPage(words: string[]): Promise<"shown" | "missing" | "left"> {
  const started = Date.now();
  // The person may move to another page meanwhile: then nothing more is done, there or here.
  const startPath = window.location.pathname;
  const left = () => window.location.pathname !== startPath;
  const waitFor = async (until: number) => {
    let hit = left() ? null : findOnPage(words);
    while (!hit && !left() && Date.now() < until) {
      await sleep(200);
      if (left()) return null;
      hit = findOnPage(words);
    }
    return hit;
  };
  // The page's data first (a short wait), then behind each of its tabs, then a little longer where it started.
  let found = await waitFor(started + 2500);
  if (!found) {
    const root = document.querySelector<HTMLElement>("main") ?? document.body;
    const tabs = Array.from(root.querySelectorAll<HTMLElement>("[role='tab']")).filter(visible).slice(0, 10);
    const original = tabs.find((tab) => tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active");
    for (const tab of tabs) {
      if (left()) return "left";
      if (tab === original) continue;
      openTab(tab);
      found = await waitFor(Date.now() + 500);
      if (found) break;
    }
    if (left()) return "left";
    if (!found && original) {
      openTab(original);
      found = await waitFor(started + 7000);
    }
  }
  if (left()) return "left";
  if (!found) return "missing";
  const target = found.closest<HTMLElement>("button, a, [role='tab'], summary") ?? found.closest<HTMLElement>("section, li") ?? found;
  if (target.getAttribute("role") === "tab" && target.getAttribute("aria-selected") !== "true") openTab(target);
  const closed = target.closest("details");
  if (closed && !closed.open) closed.open = true;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add(...HIGHLIGHT);
  window.setTimeout(() => target.classList.remove(...HIGHLIGHT), 2800);
  if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.tagName === "SUMMARY") target.focus({ preventScroll: true });
  return "shown";
}

/** Opens a page, and on it shows the button or section with `find` (when given). */
export function usePanelGo() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The page on screen: the router changes location before the new page has loaded, while the old one still shows.
  const shownPath = useRouterState({ select: (state) => (state.status === "idle" ? (state.resolvedLocation ?? state.location).pathname : "") });
  const { language, t } = useLanguage();
  const show = useCallback(async (find: string) => {
    const words = [find, language === "kn" ? translateText(find, "kn") : find];
    if ((await revealOnPage(words)) === "missing") toast.message(t(`"${find}" is not shown on this page for you right now.`));
  }, [language, t]);
  // Arrived from a search on another page: show what was picked, once that page is the one on screen.
  useEffect(() => {
    if (!shownPath) return;
    const find = takePendingFind(shownPath);
    if (find) void show(find);
  }, [shownPath, show]);
  return useCallback((to: string, find: string) => {
    if (!find) {
      navigate({ to: to as never });
      return;
    }
    if (samePath(pathname, to)) void show(find);
    else {
      setPendingFind(to, find);
      navigate({ to: to as never });
    }
  }, [navigate, pathname, show]);
}

// ---- the search bar

const KIND_WORDS: Record<PanelEntry["kind"], string> = { page: "Page", button: "Button", section: "Section", card: "Card", tab: "Tab", link: "Link" };
const KIND_ICONS: Record<PanelEntry["kind"], ComponentType<{ className?: string }>> = {
  page: FileText, button: MousePointerClick, section: Rows3, card: LayoutGrid, tab: FolderOpen, link: Link2,
};
const recentKey = (panel: PanelKey) => `gb-panel-recent:${panel}`;
function readRecent(panel: PanelKey): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(recentKey(panel)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

type Row =
  | { kind: "fav"; fav: Favourite; entry: PanelEntry | null }
  | { kind: "entry"; entry: PanelEntry }
  | { kind: "data"; data: PanelDataResult };

const PLACEHOLDERS: Record<PanelKey, string> = {
  admin: "Search pages, buttons, products, people, orders…",
  vendor: "Search pages, buttons, my products and orders…",
  customer: "Search pages, products and my orders…",
  partner: "Search pages and buttons…",
  staff: "Search pages and buttons…",
};

/**
 * The panel's search bar: suggestions as you type (pages, buttons, sections, and the panel's own products, people
 * and orders), favourites and recent picks before typing, arrow keys and Enter, Ctrl+K or "/" from anywhere. On a
 * phone, a search button that opens the bar across the top.
 */
export function PanelSearch({ panel, dataResults, className, compact = false }: {
  panel: PanelKey; dataResults?: (query: string) => PanelDataResult[]; className?: string;
  /** A search button at every width (the staff app's narrow page), opening the bar across the top. */
  compact?: boolean;
}) {
  const go = usePanelGo();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [active, setActive] = useState(0);
  const [drop, setDrop] = useState<{ left: number; width: number } | null>(null);
  const [entries, setEntries] = useState<PanelEntry[] | null>(null);
  const [recent, setRecent] = useState<string[]>(() => (typeof window === "undefined" ? [] : readRecent(panel)));
  const [kannadaReady, setKannadaReady] = useState(() => isKannadaLoaded());
  const { favourites, keys, toggle, move } = usePanelFavourites(panel);
  const wrap = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const sheetInput = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const loadIndex = useCallback(() => {
    if (entries) return;
    void import("@/lib/panel-search-index").then((index) => setEntries(panelEntries(index.PANEL_PAGES[panel], index.PANEL_FEATURES[panel])));
  }, [entries, panel]);
  // Ready before the first letter is typed.
  useEffect(() => {
    const timer = window.setTimeout(loadIndex, 1500);
    return () => window.clearTimeout(timer);
  }, [loadIndex]);
  // Kannada typed while the page is in English: load the Kannada words so they match too.
  useEffect(() => {
    if (!kannadaReady && /[ಀ-೿]/.test(query)) void loadKannada().then(() => setKannadaReady(true)).catch(() => undefined);
  }, [query, kannadaReady]);

  const translate = useCallback((text: string) => (kannadaReady ? translateText(text, "kn") : text), [kannadaReady]);
  const typed = query.trim();
  const results = useMemo(() => (typed && entries ? searchPanel(entries, typed, { translate, favourites: keys, recent, limit: 10 }) : []), [typed, entries, translate, keys, recent]);
  const data = useMemo(() => (typed && dataResults ? dataResults(typed).slice(0, 6) : []), [typed, dataResults]);
  const byKey = useMemo(() => new Map((entries ?? []).map((entry) => [entry.key, entry])), [entries]);
  const recentEntries = useMemo(() => recent.map((key) => byKey.get(key)).filter((entry): entry is PanelEntry => Boolean(entry) && !keys.has(entry!.key)).slice(0, 5), [recent, byKey, keys]);
  const rows: Row[] = useMemo(() => (typed
    ? [...results.map((entry) => ({ kind: "entry" as const, entry })), ...data.map((item) => ({ kind: "data" as const, data: item }))]
    : [...favourites.map((fav) => ({ kind: "fav" as const, fav, entry: byKey.get(fav.key) ?? null })), ...recentEntries.map((entry) => ({ kind: "entry" as const, entry }))]),
  [typed, results, data, favourites, byKey, recentEntries]);
  useEffect(() => { setActive(0); }, [typed]);

  // The suggestions under the search, right-aligned to it, moved in so they stay on the screen with 16 px to spare.
  const placeDrop = useCallback(() => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.min(448, window.innerWidth - 32);
    const left = Math.min(Math.max(box.width - width, 16 - box.left), window.innerWidth - 16 - width - box.left);
    setDrop({ left, width });
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    placeDrop();
    window.addEventListener("resize", placeDrop);
    return () => window.removeEventListener("resize", placeDrop);
  }, [open, placeDrop]);

  const close = () => {
    setOpen(false);
    setSheet(false);
    setQuery("");
  };
  const pick = (row: Row) => {
    if (row.kind === "data") {
      close();
      go(row.data.to, "");
      return;
    }
    const target = row.kind === "fav" ? row.fav : { key: row.entry.key, to: row.entry.to, find: row.entry.find };
    const next = rememberPick(recent, target.key);
    setRecent(next);
    try { localStorage.setItem(recentKey(panel), JSON.stringify(next)); } catch { /* storage blocked */ }
    close();
    go(target.to, target.find);
  };
  const focusSearch = useCallback(() => {
    loadIndex();
    if (!compact && window.matchMedia("(min-width: 768px)").matches && input.current) {
      input.current.focus();
      setOpen(true);
    } else {
      setSheet(true);
    }
  }, [loadIndex, compact]);

  // Ctrl+K (⌘K on a Mac) or "/" opens the search from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !typing)) {
        event.preventDefault();
        focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch]);
  // A tap outside closes the suggestions.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    if (sheet) window.setTimeout(() => sheetInput.current?.focus(), 30);
  }, [sheet]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (rows.length ? (index + 1) % rows.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (rows.length ? (index - 1 + rows.length) % rows.length : 0));
    } else if (event.key === "Enter") {
      const row = rows[active];
      if (!open && !sheet) {
        // Closed (after Escape or a pick): Enter opens the suggestions rather than going somewhere unseen.
        event.preventDefault();
        setOpen(true);
      } else if (row) {
        event.preventDefault();
        pick(row);
      }
    } else if (event.key === "Escape") {
      if (query) setQuery("");
      else close();
    }
  };

  const field = (ref: React.MutableRefObject<HTMLInputElement | null>, wide: boolean) => (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate" />
      <input
        ref={ref}
        type="search"
        role="combobox"
        aria-expanded={open || sheet}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
        aria-label="Search pages and buttons"
        placeholder={PLACEHOLDERS[panel]}
        value={query}
        autoComplete="off"
        onFocus={() => { loadIndex(); setOpen(true); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
        className={cn("h-9 rounded-md border border-input bg-white pr-14 pl-9 text-sm text-charcoal placeholder:text-slate focus:border-gold focus:ring-2 focus:ring-gold/30 focus:outline-none", wide ? "w-full" : "w-60 lg:w-72")}
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-border bg-ivory px-1.5 text-[10px] font-semibold text-slate lg:block">Ctrl K</kbd>
    </div>
  );

  const rowView = (row: Row, index: number) => {
    const entry = row.kind === "data" ? null : row.kind === "fav" ? row.entry : row.entry;
    const label = row.kind === "data" ? row.data.label : row.kind === "fav" ? row.fav.label : row.entry.label;
    const kind: PanelEntry["kind"] = entry?.kind ?? (row.kind === "fav" && row.fav.find ? "button" : "page");
    const Icon = KIND_ICONS[kind];
    const favKey = row.kind === "data" ? "" : row.kind === "fav" ? row.fav.key : row.entry.key;
    const pageName = entry?.page ?? (row.kind === "fav" ? row.fav.to : "");
    const on = favKey ? keys.has(favKey) : false;
    return (
      <div key={`${row.kind}-${favKey || (row.kind === "data" ? row.data.to + row.data.label : index)}`} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        onMouseEnter={() => setActive(index)}
        className={cn("flex items-center gap-1 border-b border-border/50 px-2 py-1 last:border-0", index === active && "bg-ivory")}>
        <button type="button" onClick={() => pick(row)} className="flex min-w-0 flex-1 items-center gap-3 rounded px-1 py-1.5 text-left">
          {row.kind === "data" && row.data.image ? (
            <img src={row.data.image} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-md border border-border bg-card object-cover"
              onError={(event) => {
                const image = event.currentTarget;
                const fallback = row.data.fallbackImage ?? "/products/rice.jpg";
                if (image.getAttribute("src") === fallback) image.style.visibility = "hidden";
                else image.src = fallback;
              }} />
          ) : (
            <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-ivory text-navy">
              {row.kind === "data" ? <span className="text-xs font-semibold text-slate">{row.data.detail.split(" · ").at(-1)?.slice(0, 1)}</span> : <Icon className="h-4 w-4" />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-navy">{label}</span>
            <span className="block truncate text-[11px] text-slate">
              {row.kind === "data" ? row.data.detail : (
                <>
                  <span>{KIND_WORDS[kind]}</span>
                  {kind !== "page" && pageName && <><span aria-hidden="true"> · </span><span>{pageName}</span></>}
                </>
              )}
            </span>
          </span>
        </button>
        {row.kind === "fav" && (
          <span className="flex shrink-0 flex-col">
            <button type="button" aria-label="Move up" title="Move up" onClick={() => move(row.fav.key, -1)} className="rounded p-0.5 text-slate hover:text-navy"><ArrowUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Move down" title="Move down" onClick={() => move(row.fav.key, 1)} className="rounded p-0.5 text-slate hover:text-navy"><ArrowDown className="h-3.5 w-3.5" /></button>
          </span>
        )}
        {row.kind !== "data" && (
          <button type="button" aria-pressed={on} aria-label={on ? "Remove from favourites" : "Add to favourites"} title={on ? "Remove from favourites" : "Add to favourites"}
            onClick={() => {
              const item = row.kind === "fav" ? row.fav : row.entry;
              toggle({ to: item.to, label: row.kind === "fav" ? row.fav.label : row.entry.label, find: item.find });
            }}
            className="shrink-0 rounded p-1.5 hover:bg-gold/10">
            <Star className={cn("h-4 w-4", on ? "fill-gold text-gold" : "text-slate")} />
          </button>
        )}
      </div>
    );
  };

  const heading = (Icon: ComponentType<{ className?: string }>, text: string) => (
    <p className="flex items-center gap-1.5 bg-ivory/60 px-3 py-1.5 text-[11px] font-bold tracking-wide text-slate uppercase"><Icon className="h-3.5 w-3.5" /><span>{text}</span></p>
  );
  const favCount = typed ? 0 : favourites.length;
  const entryCount = typed ? results.length : recentEntries.length;
  const list = (
    <div id={listId} role="listbox" aria-label="Suggestions" className="max-h-[70vh] overflow-y-auto">
      {!typed && (
        <>
          {heading(Star, "Favourites")}
          {favourites.length ? rows.slice(0, favCount).map((row, index) => rowView(row, index))
            : <p className="px-3 py-2 text-xs text-slate">No favourites yet. Tap the star next to a page or button to keep it here.</p>}
          {recentEntries.length > 0 && heading(History, "Recent")}
          {rows.slice(favCount).map((row, index) => rowView(row, favCount + index))}
          <p className="border-t border-border px-3 py-2 text-[11px] text-slate">Type a page or button name, for example: add employee. Ctrl+K or / opens this search from anywhere.</p>
        </>
      )}
      {typed && (
        <>
          {results.length > 0 && heading(MousePointerClick, "Pages and buttons")}
          {rows.slice(0, entryCount).map((row, index) => rowView(row, index))}
          {data.length > 0 && heading(Search, "Products, people and orders")}
          {rows.slice(entryCount).map((row, index) => rowView(row, entryCount + index))}
          {!rows.length && <p className="px-3 py-3 text-sm text-slate">{entries ? "Nothing found. Try another word." : "Loading…"}</p>}
        </>
      )}
    </div>
  );

  return (
    <div data-panel-search-ui="" className={cn("relative", className)}>
      {!compact && (
        <div ref={wrap} className="relative hidden md:block">
          {field(input, false)}
          {open && !sheet && (
            <div style={drop ?? { right: 0, width: "min(28rem, calc(100vw - 2rem))" }} className="absolute top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-card text-left shadow-xl">{list}</div>
          )}
        </div>
      )}
      <button type="button" onClick={() => { loadIndex(); setSheet(true); setOpen(true); }} aria-label="Search pages and buttons" title="Search pages and buttons"
        className={cn("grid h-9 w-9 place-items-center rounded-full border border-border text-navy hover:border-gold hover:text-gold", !compact && "md:hidden")}>
        <Search className="h-4 w-4" />
      </button>
      {/* On the page itself, not inside the header: the header's blur would keep a fixed sheet inside the header. */}
      {sheet && typeof document !== "undefined" && createPortal(
        <div data-panel-search-ui="" className={cn("fixed inset-0 z-[60]", !compact && "md:hidden")}>
          <button type="button" aria-label="Close search" className="absolute inset-0 bg-midnight/60" onClick={close} />
          <div className="relative mx-auto max-w-2xl border-b border-border bg-card p-3 shadow-xl sm:rounded-b-xl">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">{field(sheetInput, true)}</div>
              <button type="button" onClick={close} aria-label="Close search" className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border text-navy"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">{list}</div>
          </div>
        </div>,
        document.body,
      )}
      <span className="sr-only" aria-live="polite">{typed ? t(`${rows.length} suggestions`) : ""}</span>
    </div>
  );
}

// ---- favourites in the menu, beside the page title, and as a bar

/** The star beside a page's title: keeps this page in the person's favourites. */
export function FavouriteToggle({ panel, label, className }: { panel: PanelKey; label: string; className?: string }) {
  const pathname = pathOf(useRouterState({ select: (state) => state.location.pathname }));
  const { keys, toggle } = usePanelFavourites(panel);
  const on = keys.has(entryKey(pathname));
  // A record's own page (an order, a customer) keeps its number in the name.
  const last = pathname.split("/").at(-1) ?? "";
  const readable = (() => {
    try {
      return decodeURIComponent(last);
    } catch {
      return last; // "%" without its two digits: shown as it is
    }
  })();
  const name = pathname.split("/").length > 3 && /\d|[A-Z]/.test(last) && !label.includes(readable) ? `${label} · ${readable}` : label;
  return (
    <button type="button" aria-pressed={on} onClick={() => toggle({ to: pathname, label: name, find: "" })}
      aria-label={on ? "Remove this page from favourites" : "Add this page to favourites"} title={on ? "Remove this page from favourites" : "Add this page to favourites"}
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-gold/10", className)}>
      <Star className={cn("h-4 w-4", on ? "fill-gold text-gold" : "text-slate")} />
    </button>
  );
}

/** The person's favourites at the top of the side menu (admin, vendor and customer panels). */
export function FavouritesNav({ panel, rail, onPick }: { panel: PanelKey; rail: boolean; onPick?: () => void }) {
  const { favourites } = usePanelFavourites(panel);
  const go = usePanelGo();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (!favourites.length) return null;
  return (
    <div data-panel-search-ui="" className={cn(rail ? "mb-1 space-y-0.5 border-b border-white/10 pb-1" : "mb-1 space-y-1 border-b border-white/10 pb-2")}>
      {!rail && (
        <p className="mt-1 flex items-center gap-2 px-3 py-2 text-xs font-semibold tracking-wide text-gold uppercase">
          <Star className="h-3.5 w-3.5 fill-gold" /> Favourites
        </p>
      )}
      {favourites.map((fav) => {
        const here = !fav.find && samePath(pathname, fav.to);
        const classes = cn(
          "w-full rounded-lg font-medium transition-colors",
          rail ? "flex flex-col items-center gap-1 px-0.5 py-2 text-[10px] leading-tight" : "flex items-center gap-3 px-3 py-2 text-left text-sm",
          here ? "bg-white/10 text-gold" : "text-white/70 hover:bg-white/5 hover:text-gold",
        );
        const body = (
          <>
            <Star className={cn("shrink-0 fill-gold/60 text-gold", rail ? "h-5 w-5" : "h-4 w-4")} />
            <span className={cn(rail ? "line-clamp-2 w-full text-center" : "truncate")}>{fav.label}</span>
          </>
        );
        return fav.find ? (
          <button key={fav.key} type="button" title={rail ? fav.label : undefined} className={classes} onClick={() => { onPick?.(); go(fav.to, fav.find); }}>{body}</button>
        ) : (
          <Link key={fav.key} to={fav.to as never} title={rail ? fav.label : undefined} className={classes} onClick={() => onPick?.()}>{body}</Link>
        );
      })}
    </div>
  );
}

/** The person's favourites as a row of buttons under the header (channel partner and godown staff pages). */
export function FavouritesBar({ panel, className }: { panel: PanelKey; className?: string }) {
  const { favourites } = usePanelFavourites(panel);
  const go = usePanelGo();
  if (!favourites.length) return null;
  return (
    <nav aria-label="Favourites" data-panel-search-ui="" className={cn("flex flex-wrap items-center gap-2", className)}>
      <span className="flex items-center gap-1 text-xs font-bold tracking-wide text-slate uppercase"><Star className="h-3.5 w-3.5 fill-gold text-gold" /> Favourites</span>
      {favourites.map((fav) => (
        <button key={fav.key} type="button" onClick={() => go(fav.to, fav.find)}
          className="inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm font-medium text-navy shadow-xs hover:border-gold hover:text-gold">
          <span className="truncate">{fav.label}</span>
        </button>
      ))}
    </nav>
  );
}
