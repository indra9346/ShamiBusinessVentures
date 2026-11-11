// The search bar of every sign-in panel (owner, 11 Nov 2026): type a page, button or feature name and get suggestions
// as you type, in English or Kannada, with small spelling slips forgiven; pick one to open that page with the button
// shown. Favourites are the pages and buttons a person keeps at hand. No app imports, so the tests load it directly.
import type { PanelFeature, PanelKey, PanelPage } from "./panel-search-index.ts";

export type { PanelKey };

/** One suggestion: a page, or a button/section on a page (`find` is the words to look for there). */
export type PanelEntry = {
  key: string;
  to: string;
  label: string;
  /** The page's name, under a button's label. */
  page: string;
  find: string;
  kind: "page" | PanelFeature["kind"];
};

export const entryKey = (to: string, find = "") => (find ? `${to}#${find}` : to);

/** Every page and button of a panel as suggestions. */
export function panelEntries(pages: PanelPage[], features: PanelFeature[]): PanelEntry[] {
  const names = new Map(pages.map((page) => [page.to, page.label]));
  return [
    ...pages.map((page) => ({ key: entryKey(page.to), to: page.to, label: page.label, page: page.label, find: "", kind: "page" as const })),
    ...features.map((item) => ({
      key: entryKey(item.to, item.text), to: item.to, label: item.text, page: names.get(item.to) ?? item.to, find: item.text, kind: item.kind,
    })),
  ];
}

const fold = (text: string) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** At most one letter added, dropped, changed or two swapped: "patner" finds "partner". */
function nearly(word: string, target: string) {
  if (Math.abs(word.length - target.length) > 1) return false;
  if (word === target) return true;
  let i = 0;
  while (i < word.length && i < target.length && word[i] === target[i]) i += 1;
  const a = word.slice(i);
  const b = target.slice(i);
  return a.slice(1) === b.slice(1) || a.slice(1) === b || a === b.slice(1) || (a.length > 1 && a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2));
}

/**
 * How well a text answers the query, 0 when it does not: the whole text, its start, every word starting a word of the
 * text, the words anywhere, then words with one slip (4+ letters).
 */
export function matchScore(text: string, query: string): number {
  const t = fold(text);
  const q = fold(query);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 85;
  const words = t.split(" ");
  const parts = q.split(" ");
  if (parts.every((part) => words.some((word) => word.startsWith(part)))) return 70 - Math.min(10, words.length);
  if (t.includes(q)) return 55;
  if (parts.every((part) => t.includes(part))) return 45;
  if (parts.every((part) => words.some((word) => word.startsWith(part) || (part.length >= 4 && (nearly(part, word) || nearly(part, word.slice(0, part.length))))))) return 30;
  return 0;
}

/**
 * The suggestions for a query, best first. `translate` gives the Kannada of a label (so Kannada typing works too);
 * favourites and recent picks come a little higher; pages before buttons with the same score.
 */
export function searchPanel(
  entries: PanelEntry[], query: string,
  options: { translate?: (text: string) => string; favourites?: Set<string>; recent?: string[]; limit?: number } = {},
): PanelEntry[] {
  const recent = options.recent ?? [];
  const scored: { entry: PanelEntry; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label;
    const kn = options.translate?.(label);
    let score = Math.max(matchScore(label, query), kn && kn !== label ? matchScore(kn, query) : 0);
    // "attendance add employee": the page's name with the button.
    if (entry.kind !== "page") score = Math.max(score, matchScore(`${entry.page} ${label}`, query) - 5);
    if (!score) continue;
    if (entry.kind === "page") score += 4;
    if (options.favourites?.has(entry.key)) score += 8;
    const seen = recent.indexOf(entry.key);
    if (seen >= 0) score += 6 - Math.min(5, seen);
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.length - b.entry.label.length);
  return scored.slice(0, options.limit ?? 12).map((item) => item.entry);
}

// ---- favourites

export type Favourite = { key: string; to: string; label: string; find: string };
export const MAX_FAVOURITES = 40;
const PATH = /^\/[A-Za-z0-9/_.\-]{0,199}$/;

/** A favourite as stored, checked: a site address only (never another site), short labels, no repeats. */
export function cleanFavourites(value: unknown): Favourite[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Favourite[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = (...names: string[]) => {
      for (const name of names) if (typeof row[name] === "string") return row[name] as string;
      return "";
    };
    const to = text("to", "to_path");
    const find = text("find", "find_text").slice(0, 120);
    const label = text("label").trim().slice(0, 120);
    if (!PATH.test(to) || to.startsWith("//") || !label) continue;
    const key = entryKey(to, find);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, to, label, find });
    if (out.length >= MAX_FAVOURITES) break;
  }
  return out;
}

/** Adds a favourite at the end, or takes it away when it is there already. */
export function toggleFavourite(list: Favourite[], item: Omit<Favourite, "key">): Favourite[] {
  const key = entryKey(item.to, item.find);
  if (list.some((fav) => fav.key === key)) return list.filter((fav) => fav.key !== key);
  if (list.length >= MAX_FAVOURITES) return list;
  return [...list, { ...item, key }];
}

/** Moves a favourite one place up (-1) or down (+1). */
export function moveFavourite(list: Favourite[], key: string, step: -1 | 1): Favourite[] {
  const at = list.findIndex((fav) => fav.key === key);
  const to = at + step;
  if (at < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** The last picks, newest first, without repeats. */
export function rememberPick(recent: string[], key: string, keep = 6): string[] {
  return [key, ...recent.filter((item) => item !== key)].slice(0, keep);
}

// ---- finding the button on the page

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Which of the page's elements shows these words: the one whose text is exactly them, else the smallest one whose
 * text starts with them (a section title followed by a month, a card's label followed by its number).
 */
export function pickElement<T extends { text: string; size: number }>(candidates: T[], words: string[]): T | null {
  const wanted = words.map(squash).filter(Boolean);
  if (!wanted.length) return null;
  let best: T | null = null;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    const text = squash(candidate.text);
    if (!text) continue;
    for (const word of wanted) {
      const rank = text === word ? 0 : text.startsWith(word) ? 1 : -1;
      if (rank < 0) continue;
      const total = rank * 1e6 + candidate.size;
      if (total < bestRank) { best = candidate; bestRank = total; }
    }
  }
  return best;
}
