/*
 * The master list of product names and codes: the rules, with no database or React in them.
 *
 *   code = [set prefix][method letter][variety letter][serial]   e.g. RS01 = Raw Rice + Sona Rice + 01
 *
 * The database enforces the same rules (migration 20261102190000_product_code_master). They are kept
 * here too so the page can say what is wrong before saving, and so static demo mode behaves the same.
 * Decisions on pack sizes, serials and Zoho: docs/product-codes.md.
 */

export type CodePartKind = "method" | "variety";

export type CodeSet = { id: string; category: string; prefix: string; firstLabel: string; secondLabel: string };
/** A method or a variety: one letter position of the code. */
export type CodePart = { id: string; setId: string; letter: string; name: string; sortOrder: number; retiredAt: string | null };
export type MasterCode = {
  id: string;
  setId: string;
  methodId: string;
  varietyId: string;
  serial: number;
  code: string;
  name: string;
  description: string;
  subcategory: string;
  images: string[];
  retiredAt: string | null;
  /** Retired because its method or variety was, so it comes back when they do. */
  retiredWithPart: boolean;
};
export type CodeMaster = { sets: CodeSet[]; methods: CodePart[]; varieties: CodePart[]; codes: MasterCode[] };

/** One usable code, with everything a form or another desk needs to show it. */
export type ActiveCodeOption = {
  code: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  methodName: string;
  methodLetter: string;
  varietyName: string;
  varietyLetter: string;
  serial: number;
  images: string[];
};

/** The client's workbook, Rice_Product_Codes.xlsx (Legend sheet). tests/product-codes.test.ts holds this to the file. */
export const RICE_WORKBOOK = {
  category: "Rice",
  methods: [
    { letter: "R", name: "Raw Rice" },
    { letter: "S", name: "Steam Rice" },
    { letter: "P", name: "Half Boiled" },
    { letter: "B", name: "Boiled" },
    { letter: "N", name: "Broken" },
  ],
  varieties: [
    { letter: "S", name: "Sona Rice" },
    { letter: "K", name: "Kaveri Rice" },
    { letter: "N", name: "RNR" },
    { letter: "H", name: "HMT" },
    { letter: "J", name: "JSR (Bullet)" },
    { letter: "M", name: "Basmati (Sriram Sona)" },
  ],
} as const;

const tidy = (text: string) => text.trim().replace(/\s+/g, " ");
const sameText = (a: string, b: string) => tidy(a).toLowerCase() === tidy(b).toLowerCase();

export const normalizeLetter = (raw: string) => raw.trim().toUpperCase();
export const isCodeLetter = (letter: string) => /^[A-Z]$/.test(letter);
export const isCodePrefix = (prefix: string) => /^[A-Z]{0,3}$/.test(prefix);
/** What an admin typed in the code box: "rs 01" reads as RS01. */
export const normalizeCodeInput = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const serialText = (serial: number) => String(serial).padStart(2, "0");
export const buildCode = (prefix: string, methodLetter: string, varietyLetter: string, serial: number) =>
  `${prefix}${methodLetter}${varietyLetter}${serialText(serial)}`;
export const defaultCodeName = (methodName: string, varietyName: string, serial: number) =>
  `${methodName} - ${varietyName}${serial > 1 ? ` ${serialText(serial)}` : ""}`;

/** The rice set as the migration seeds it, for static demo mode. */
export function riceWorkbookMaster(): CodeMaster {
  const setId = "set-rice";
  const stamp = <T extends { letter: string; name: string }>(kind: CodePartKind, list: readonly T[]): CodePart[] =>
    list.map((part, index) => ({ id: `${kind}-${part.letter}`, setId, letter: part.letter, name: part.name, sortOrder: index + 1, retiredAt: null }));
  const methods = stamp("method", RICE_WORKBOOK.methods);
  const varieties = stamp("variety", RICE_WORKBOOK.varieties);
  const codes = methods.flatMap((method) => varieties.map((variety): MasterCode => {
    const code = buildCode("", method.letter, variety.letter, 1);
    return {
      id: `code-${code}`, setId, methodId: method.id, varietyId: variety.id, serial: 1, code,
      name: defaultCodeName(method.name, variety.name, 1), description: "", subcategory: method.name, images: [], retiredAt: null, retiredWithPart: false,
    };
  }));
  return { sets: [{ id: setId, category: RICE_WORKBOOK.category, prefix: "", firstLabel: "Method", secondLabel: "Variety" }], methods, varieties, codes };
}

export const emptyCodeMaster = (): CodeMaster => ({ sets: [], methods: [], varieties: [], codes: [] });

const partsOf = (master: CodeMaster, kind: CodePartKind) => (kind === "method" ? master.methods : master.varieties);
const bySort = (a: CodePart, b: CodePart) => a.sortOrder - b.sortOrder || a.letter.localeCompare(b.letter);

export const setForCategory = (master: CodeMaster, category: string) =>
  master.sets.find((set) => sameText(set.category, category));
export const partsOfSet = (master: CodeMaster, kind: CodePartKind, setId: string) =>
  partsOf(master, kind).filter((part) => part.setId === setId).sort(bySort);
export const activePartsOfSet = (master: CodeMaster, kind: CodePartKind, setId: string) =>
  partsOfSet(master, kind, setId).filter((part) => !part.retiredAt);
export const codesOfPart = (master: CodeMaster, kind: CodePartKind, partId: string) =>
  master.codes.filter((code) => (kind === "method" ? code.methodId : code.varietyId) === partId);
export const codesOfPair = (master: CodeMaster, methodId: string, varietyId: string) =>
  master.codes.filter((code) => code.methodId === methodId && code.varietyId === varietyId).sort((a, b) => a.serial - b.serial);
export const letterLocked = (master: CodeMaster, kind: CodePartKind, partId: string) => codesOfPart(master, kind, partId).length > 0;
/** Next serial for this method and variety. Retired codes count: their numbers are never used again. */
export const nextSerial = (master: CodeMaster, methodId: string, varietyId: string) =>
  codesOfPair(master, methodId, varietyId).reduce((top, code) => Math.max(top, code.serial), 0) + 1;

export const findMasterCode = (master: CodeMaster, typed: string) => {
  const wanted = normalizeCodeInput(typed);
  return wanted ? master.codes.find((code) => code.code === wanted) : undefined;
};

export function codeOption(master: CodeMaster, code: MasterCode): ActiveCodeOption | null {
  const set = master.sets.find((row) => row.id === code.setId);
  const method = master.methods.find((row) => row.id === code.methodId);
  const variety = master.varieties.find((row) => row.id === code.varietyId);
  if (!set || !method || !variety) return null;
  return {
    code: code.code, name: code.name, description: code.description, category: set.category, subcategory: code.subcategory,
    methodName: method.name, methodLetter: method.letter, varietyName: variety.name, varietyLetter: variety.letter,
    serial: code.serial, images: code.images,
  };
}

/** Codes that can go on a product now, in the workbook's order. Leave out the category for every set. */
export function activeCodeOptions(master: CodeMaster, category?: string): ActiveCodeOption[] {
  const position = (parts: CodePart[], id: string) => parts.find((part) => part.id === id)?.sortOrder ?? 0;
  return master.codes
    .filter((code) => !code.retiredAt)
    .filter((code) => !category || sameText(master.sets.find((set) => set.id === code.setId)?.category ?? "", category))
    .sort((a, b) => position(master.methods, a.methodId) - position(master.methods, b.methodId)
      || position(master.varieties, a.varietyId) - position(master.varieties, b.varietyId)
      || a.serial - b.serial)
    .map((code) => codeOption(master, code))
    .filter((option): option is ActiveCodeOption => option !== null);
}

/* ---------- what can and can't be saved ---------- */

export function codeSetProblem(master: CodeMaster, input: { category: string; prefix: string; firstLabel: string; secondLabel: string }, editingId?: string): string | null {
  if (!tidy(input.category)) return "Choose a category";
  if (tidy(input.category).length > 80) return "A category name is up to 80 characters";
  if (!tidy(input.firstLabel) || !tidy(input.secondLabel)) return "Name both letter positions, for example Method and Variety";
  if (tidy(input.firstLabel).length > 40 || tidy(input.secondLabel).length > 40) return "A position's name is up to 40 characters";
  const prefix = normalizeLetter(input.prefix);
  if (!isCodePrefix(prefix)) return "A prefix is up to 3 letters, A to Z";
  const others = master.sets.filter((set) => set.id !== editingId);
  if (others.some((set) => sameText(set.category, input.category))) return `${tidy(input.category)} already has a code set`;
  if (prefix && others.some((set) => set.prefix === prefix)) return `Prefix ${prefix} is already used by ${others.find((set) => set.prefix === prefix)?.category}`;
  const editing = master.sets.find((set) => set.id === editingId);
  if (editing && prefix !== editing.prefix && master.codes.some((code) => code.setId === editing.id)) return "This set already has codes, so its prefix can no longer change";
  return null;
}

/** Why this method or variety can't be saved; null when it can. */
export function codePartProblem(master: CodeMaster, kind: CodePartKind, setId: string, input: { letter: string; name: string }, editingId?: string): string | null {
  const set = master.sets.find((row) => row.id === setId);
  const label = ((kind === "method" ? set?.firstLabel : set?.secondLabel) ?? (kind === "method" ? "method" : "variety")).toLowerCase();
  const letter = normalizeLetter(input.letter);
  if (!isCodeLetter(letter)) return "Use one letter, A to Z";
  if (!tidy(input.name)) return `Enter the ${label} name`;
  if (tidy(input.name).length > 80) return "A name is up to 80 characters";
  const others = partsOfSet(master, kind, setId).filter((part) => part.id !== editingId);
  const sameLetter = others.find((part) => part.letter === letter);
  if (sameLetter) return sameLetter.retiredAt
    ? `Letter ${letter} belonged to ${sameLetter.name} (retired). It stays reserved, so old codes can never come back. Choose another letter.`
    : `Letter ${letter} is already used by ${sameLetter.name}`;
  // A retired one's name is free: its replacement can carry the same name under a new letter.
  if (others.some((part) => !part.retiredAt && sameText(part.name, input.name))) return `A ${label} called ${tidy(input.name)} already exists`;
  const editing = partsOfSet(master, kind, setId).find((part) => part.id === editingId);
  if (editing?.retiredAt && editing.letter !== letter) return `${editing.name} is retired, so letter ${editing.letter} stays reserved.`;
  if (editing?.retiredAt && tidy(editing.name) !== tidy(input.name)) return `${editing.name} is retired. Restore it before changing its name.`;
  if (editing && editing.letter !== letter && letterLocked(master, kind, editing.id)) {
    return `Letter ${editing.letter} is locked because codes use it. Retire this ${label} and create a new one with the letter you want.`;
  }
  return null;
}

/** The code the next serial would make, or why it can't be made. */
export function newCodePreview(master: CodeMaster, methodId: string, varietyId: string): { code: string; serial: number; name: string; subcategory: string } | { error: string } {
  const method = master.methods.find((part) => part.id === methodId);
  const variety = master.varieties.find((part) => part.id === varietyId);
  const set = master.sets.find((row) => row.id === method?.setId);
  if (!method || !variety || !set || variety.setId !== set.id) return { error: "Choose a method and variety from the same category" };
  if (method.retiredAt || variety.retiredAt) return { error: "That method or variety is retired, so it cannot get new codes" };
  const serial = nextSerial(master, methodId, varietyId);
  if (serial > 99) return { error: "This method and variety have used all 99 serial numbers" };
  const code = buildCode(set.prefix, method.letter, variety.letter, serial);
  const taken = master.codes.find((row) => row.code === code);
  if (taken) {
    const where = master.sets.find((row) => row.id === taken.setId)?.category ?? "another category";
    return { error: `Code ${code} is already used in ${where}. Give this category's set a prefix, or use a different letter.` };
  }
  return { code, serial, name: defaultCodeName(method.name, variety.name, serial), subcategory: method.name };
}

/* ---------- products ---------- */

export type CodedProduct = {
  id: string;
  name: string;
  sku?: string;
  category: string;
  subcategory?: string;
  status?: string;
  active?: boolean;
  weight?: string;
  ratePricing?: { packQty: number; packUnit: string } | undefined;
  productCode?: string | undefined;
};

const PACK_UNITS: Record<string, { dimension: "mass" | "volume"; inBase: number }> = {
  g: { dimension: "mass", inBase: 0.001 }, gm: { dimension: "mass", inBase: 0.001 }, gram: { dimension: "mass", inBase: 0.001 }, grams: { dimension: "mass", inBase: 0.001 },
  kg: { dimension: "mass", inBase: 1 }, kgs: { dimension: "mass", inBase: 1 }, kilo: { dimension: "mass", inBase: 1 },
  qtl: { dimension: "mass", inBase: 100 }, quintal: { dimension: "mass", inBase: 100 }, tonne: { dimension: "mass", inBase: 1000 }, ton: { dimension: "mass", inBase: 1000 },
  ml: { dimension: "volume", inBase: 0.001 }, l: { dimension: "volume", inBase: 1 }, ltr: { dimension: "volume", inBase: 1 }, litre: { dimension: "volume", inBase: 1 }, litres: { dimension: "volume", inBase: 1 }, liter: { dimension: "volume", inBase: 1 },
};
const packIn = (quantity: number, unit: string) => {
  const known = PACK_UNITS[unit.toLowerCase()];
  return known && quantity > 0 ? `${known.dimension}:${Math.round(quantity * known.inBase * 1000) / 1000}` : null;
};

/** A pack size in comparable form: "25 kg", "25kg bag" and a 25 kg trade-rate pack all read the same. */
export function packKey(product: Pick<CodedProduct, "weight" | "ratePricing">): string {
  const rate = product.ratePricing ? packIn(Number(product.ratePricing.packQty), String(product.ratePricing.packUnit)) : null;
  if (rate) return rate;
  const weight = (product.weight ?? "").trim().toLowerCase();
  const multiple = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([a-z]+)/.exec(weight);
  const single = /^(\d+(?:\.\d+)?)\s*([a-z]+)/.exec(weight);
  const worked = multiple ? packIn(Number(multiple[1]) * Number(multiple[2]), multiple[3]!) : single ? packIn(Number(single[1]), single[2]!) : null;
  return worked ?? `text:${weight.replace(/\s+/g, " ")}`;
}

export const productsWithCode = <T extends CodedProduct>(products: T[], code: string) => products.filter((product) => product.productCode === code);

/** Live products that already sell this code in this pack size: the one to warn about. */
export function duplicateProducts<T extends CodedProduct>(products: T[], code: string, pack: Pick<CodedProduct, "weight" | "ratePricing">, excludeId?: string): T[] {
  if (!code) return [];
  const key = packKey(pack);
  return products.filter((product) => product.id !== excludeId && product.productCode === code
    && product.active !== false && product.status !== "rejected" && packKey(product) === key);
}

export const productsWithoutCode = <T extends CodedProduct>(products: T[], category?: string) =>
  products.filter((product) => !product.productCode && (!category || sameText(product.category, category)));

/** The duplicates the admin has to confirm: none when this save changes neither the code nor the pack. */
export function duplicatesToConfirm<T extends CodedProduct>(
  products: T[],
  code: string,
  pack: Pick<CodedProduct, "weight" | "ratePricing">,
  excludeId?: string,
  original?: { code: string; pack: Pick<CodedProduct, "weight" | "ratePricing"> },
): T[] {
  if (original && original.code === code && packKey(original.pack) === packKey(pack)) return [];
  return duplicateProducts(products, code, pack, excludeId);
}

/** A pack size in words, for messages. */
export function packLabel(pack: Pick<CodedProduct, "weight" | "ratePricing">): string {
  if (pack.ratePricing && Number(pack.ratePricing.packQty) > 0) return `${pack.ratePricing.packQty} ${pack.ratePricing.packUnit}`;
  return (pack.weight ?? "").trim() || "this pack size";
}

/* ---------- the same rules as the database triggers, for static demo mode ---------- */

let demoCounter = 0;
const demoId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(demoCounter += 1)}`;

export function demoCreateSet(master: CodeMaster, input: { category: string; prefix: string; firstLabel: string; secondLabel: string }): CodeMaster {
  const problem = codeSetProblem(master, input);
  if (problem) throw new Error(problem);
  const set: CodeSet = { id: demoId("set"), category: tidy(input.category), prefix: normalizeLetter(input.prefix), firstLabel: tidy(input.firstLabel), secondLabel: tidy(input.secondLabel) };
  return { ...master, sets: [...master.sets, set] };
}

export function demoUpdateSet(master: CodeMaster, id: string, input: { category: string; prefix: string; firstLabel: string; secondLabel: string }): CodeMaster {
  const problem = codeSetProblem(master, input, id);
  if (problem) throw new Error(problem);
  return { ...master, sets: master.sets.map((set) => set.id === id ? { ...set, category: tidy(input.category), prefix: normalizeLetter(input.prefix), firstLabel: tidy(input.firstLabel), secondLabel: tidy(input.secondLabel) } : set) };
}

const withParts = (master: CodeMaster, kind: CodePartKind, parts: CodePart[]): CodeMaster =>
  kind === "method" ? { ...master, methods: parts } : { ...master, varieties: parts };

export function demoCreatePart(master: CodeMaster, kind: CodePartKind, setId: string, input: { letter: string; name: string }): CodeMaster {
  const problem = codePartProblem(master, kind, setId, input);
  if (problem) throw new Error(problem);
  const sortOrder = partsOfSet(master, kind, setId).reduce((top, part) => Math.max(top, part.sortOrder), 0) + 1;
  const part: CodePart = { id: demoId(kind), setId, letter: normalizeLetter(input.letter), name: tidy(input.name), sortOrder, retiredAt: null };
  return withParts(master, kind, [...partsOf(master, kind), part]);
}

export function demoUpdatePart(master: CodeMaster, kind: CodePartKind, id: string, input: { letter: string; name: string }): CodeMaster {
  const existing = partsOf(master, kind).find((part) => part.id === id);
  if (!existing) throw new Error("That method or variety no longer exists");
  const problem = codePartProblem(master, kind, existing.setId, input, id);
  if (problem) throw new Error(problem);
  return withParts(master, kind, partsOf(master, kind).map((part) => part.id === id ? { ...part, letter: normalizeLetter(input.letter), name: tidy(input.name) } : part));
}

export function demoSetPartRetired(master: CodeMaster, kind: CodePartKind, id: string, retired: boolean, now: string): CodeMaster {
  const existing = partsOf(master, kind).find((part) => part.id === id);
  if (!existing) throw new Error("That method or variety no longer exists");
  // Retiring what is already retired changes nothing.
  if (retired && existing.retiredAt) return master;
  if (!retired && existing.retiredAt && partsOf(master, kind).some((part) => part.id !== id && part.setId === existing.setId && !part.retiredAt && sameText(part.name, existing.name))) {
    throw new Error(`Another one is already called ${existing.name}. Rename it before restoring this.`);
  }
  const next = withParts(master, kind, partsOf(master, kind).map((part) => part.id === id ? { ...part, retiredAt: retired ? now : null } : part));
  const liveParts = (code: MasterCode) => !next.methods.find((part) => part.id === code.methodId)?.retiredAt && !next.varieties.find((part) => part.id === code.varietyId)?.retiredAt;
  const mine = (code: MasterCode) => (kind === "method" ? code.methodId : code.varietyId) === id;
  return {
    ...next,
    codes: next.codes.map((code) => {
      if (!mine(code)) return code;
      if (retired) return code.retiredAt ? code : { ...code, retiredAt: now, retiredWithPart: true };
      return code.retiredWithPart && liveParts(code) ? { ...code, retiredAt: null, retiredWithPart: false } : code;
    }),
  };
}

export function demoCreateCode(master: CodeMaster, methodId: string, varietyId: string, input: { name?: string; description?: string; subcategory?: string; images?: string[] } = {}): { master: CodeMaster; code: MasterCode } {
  const preview = newCodePreview(master, methodId, varietyId);
  if ("error" in preview) throw new Error(preview.error);
  if ((input.images ?? []).length > 8) throw new Error("A code can hold up to 8 images");
  const method = master.methods.find((part) => part.id === methodId)!;
  const code: MasterCode = {
    id: demoId("code"), setId: method.setId, methodId, varietyId, serial: preview.serial, code: preview.code,
    name: tidy(input.name ?? "") || preview.name, description: (input.description ?? "").trim(),
    subcategory: tidy(input.subcategory ?? "") || preview.subcategory, images: input.images ?? [], retiredAt: null, retiredWithPart: false,
  };
  return { master: { ...master, codes: [...master.codes, code] }, code };
}

export type CodeDetails = Pick<MasterCode, "name" | "description" | "subcategory" | "images">;

/** Why these details can't be saved on this code; null when they can. */
export function codeDetailsProblem(code: MasterCode | undefined, details: CodeDetails): string | null {
  if (code?.retiredAt) return `Code ${code.code} is retired. Restore it before changing its details.`;
  if (!tidy(details.name)) return "Enter the product name for this code";
  if (tidy(details.name).length > 160) return "A product name is up to 160 characters";
  if (details.description.trim().length > 2000) return "A description is up to 2000 characters";
  if (!tidy(details.subcategory)) return "Enter the subcategory for this code";
  if (tidy(details.subcategory).length > 80) return "A subcategory is up to 80 characters";
  if (details.images.length > 8) return "A code can hold up to 8 images";
  return null;
}

export function demoUpdateCode(master: CodeMaster, id: string, details: CodeDetails): CodeMaster {
  const code = master.codes.find((row) => row.id === id);
  if (!code) throw new Error("That code no longer exists");
  const problem = codeDetailsProblem(code, details);
  if (problem) throw new Error(problem);
  return { ...master, codes: master.codes.map((row) => row.id === id ? { ...row, name: tidy(details.name), description: details.description.trim(), subcategory: tidy(details.subcategory), images: details.images } : row) };
}

export function demoSetCodeRetired(master: CodeMaster, id: string, retired: boolean, now: string): CodeMaster {
  const code = master.codes.find((row) => row.id === id);
  if (!code) throw new Error("That code no longer exists");
  if (!retired && (master.methods.find((part) => part.id === code.methodId)?.retiredAt || master.varieties.find((part) => part.id === code.varietyId)?.retiredAt)) {
    throw new Error(`Restore the method and variety of ${code.code} first`);
  }
  if (retired && code.retiredAt) return master;
  return { ...master, codes: master.codes.map((row) => row.id === id ? { ...row, retiredAt: retired ? now : null, retiredWithPart: false } : row) };
}
