export type Language = "en" | "kn";

/*
 * The Kannada dictionary (~480 KB) is loaded only when a shopper chooses Kannada, so English
 * visitors never download or process it. Until it arrives, text stays in English.
 */
let kn: Record<string, string> = {};
let replacements: ReadonlyArray<readonly [string, string]> = [];
let kannadaReady = false;
let kannadaLoading: Promise<void> | null = null;

export function isKannadaLoaded() {
  return kannadaReady;
}

/** Loads the Kannada dictionary once (later calls share the same download). */
export function loadKannada(): Promise<void> {
  if (!kannadaLoading) {
    kannadaLoading = import("./i18n-kn.ts")
      .then((module) => installKannada(module.kn, module.replacements))
      .catch((cause) => {
        kannadaLoading = null; // try again on the next request
        throw cause;
      });
  }
  return kannadaLoading;
}

function installKannada(dictionary: Record<string, string>, wordReplacements: ReadonlyArray<readonly [string, string]>) {
  kn = dictionary;
  replacements = wordReplacements;
  templates = compileTemplates(kn);
  anyCase.clear();
  for (const [english, translation] of Object.entries(kn)) {
    const lower = english.toLowerCase();
    if (!anyCase.has(lower)) anyCase.set(lower, translation);
  }
  cache.clear();
  kannadaReady = true;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collapse = (value: string) => value.replace(/\s+/g, " ");

type Template = { pattern: RegExp; slots: number[]; translation: string; weight: number };

/**
 * Dictionary keys with {0}, {1}… placeholders come from template literals such as
 * `${count} orders`. Each becomes a pattern whose placeholders capture the live values;
 * the more fixed text a template has, the earlier it is tried, so "{0} orders today" wins over "{0} orders".
 */
function compileTemplates(dictionary: Record<string, string>): Template[] {
  const templates: Template[] = [];
  for (const [english, translation] of Object.entries(dictionary)) {
    if (!/\{\d+\}/.test(english)) continue;
    const slots: number[] = [];
    const parts = english.split(/\{(\d+)\}/);
    let source = "^";
    parts.forEach((part, index) => {
      if (index % 2 === 0) source += escapeRegExp(part);
      else { slots.push(Number(part)); source += "(.*?)"; }
    });
    const weight = parts.filter((_, index) => index % 2 === 0).join("").replace(/[^A-Za-z]/g, "").length;
    if (weight === 0) continue; // nothing to translate around the values
    templates.push({ pattern: new RegExp(`${source}$`, "s"), slots, translation, weight });
  }
  return templates.sort((a, b) => b.weight - a.weight);
}

let templates: Template[] = [];

// Status values arrive lower-case or snake_case from the database ("approved", "out_for_delivery").
const anyCase = new Map<string, string>();

function replaceEnglish(value: string) {
  let output = value;
  for (const [from, to] of replacements) {
    // Whole words only, so "Bag" doesn't rewrite "Bags" and "of" doesn't rewrite "Profile";
    // case-sensitive, so the English word "can" never becomes the oil-can ಕ್ಯಾನ್.
    const pattern = `(?<![A-Za-z])${escapeRegExp(from)}(?![A-Za-z])`;
    output = output.replace(new RegExp(pattern, "g"), to);
  }
  return output;
}

function fromTemplate(core: string, depth: number): string | undefined {
  for (const template of templates) {
    const match = template.pattern.exec(core);
    if (!match) continue;
    // A template with little fixed text ("{0} of {1}") must not swallow ordinary English such as
    // "Country of Origin": there, every value has to be a number/amount or translatable itself.
    if (template.weight < 5 && match.slice(1).some((value) => /[A-Za-z]/.test(value ?? "") && !(collapse((value ?? "").trim()) in kn))) continue;
    const values = new Map<number, string>();
    // Captured values may themselves be English labels ("Delivered", "Challakere Godown").
    // English plural endings ("{0} account{1}" with {1} = "s") have no place in Kannada.
    template.slots.forEach((slot, index) => {
      const value = match[index + 1] ?? "";
      values.set(slot, /^(s|es)$/.test(value) ? "" : translateCore(value, depth + 1));
    });
    return template.translation.replace(/\{(\d+)\}/g, (whole, slot) => values.get(Number(slot)) ?? whole);
  }
  return undefined;
}

function translateCore(core: string, depth: number): string {
  const key = collapse(core.trim());
  if (!key || !/[A-Za-z]/.test(key)) return core;
  const exact = kn[key] ?? anyCase.get(key.toLowerCase().replace(/_/g, " "));
  if (exact !== undefined) return exact;
  if (depth < 2) {
    const viaTemplate = fromTemplate(key, depth);
    if (viaTemplate !== undefined) return viaTemplate;
    // "Rice (15)", "Orders (3)": a label followed by a count.
    const counted = /^(.*[A-Za-z].*?)\s*\((\d[\d,]*)\)$/.exec(key);
    if (counted) return `${translateCore(counted[1] ?? "", depth + 1)} (${counted[2]})`;
  }
  return replaceEnglish(core);
}

const cache = new Map<string, string>();

export function translateText(value: string, language: Language) {
  if (language === "en" || !kannadaReady || !value.trim()) return value;
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const translated = `${leading}${translateCore(value.trim(), 0)}${trailing}`;
  if (cache.size > 5000) cache.clear();
  cache.set(value, translated);
  return translated;
}
