import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { uploadCatalogImage } from "@/lib/catalog-images";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  activeCodeOptions,
  codeDetailsProblem,
  codePartProblem,
  codeSetProblem,
  demoCreateCode,
  demoCreatePart,
  demoCreateSet,
  demoSetCodeRetired,
  demoSetPartRetired,
  demoUpdateCode,
  demoUpdatePart,
  demoUpdateSet,
  riceWorkbookMaster,
  type ActiveCodeOption,
  type CodeDetails,
  type CodeMaster,
  type CodePartKind,
  type MasterCode,
} from "@/lib/product-code-rules";

export type { ActiveCodeOption, CodeDetails, CodeMaster, CodePart, CodePartKind, CodeSet, MasterCode } from "@/lib/product-code-rules";

const DEMO_KEY = "gb-demo-product-codes";
// Demo edits stay for this page load even where the browser blocks storage or it is full.
let demoMemory: CodeMaster | null = null;
let demoOnlyInMemory = false;

function readDemoMaster(): CodeMaster {
  if (demoOnlyInMemory && demoMemory) return demoMemory;
  try {
    const saved = window.localStorage.getItem(DEMO_KEY);
    if (saved) demoMemory = JSON.parse(saved) as CodeMaster;
  } catch { /* storage blocked: keep what this page load has */ }
  return demoMemory ?? riceWorkbookMaster();
}

function writeDemoMaster(master: CodeMaster) {
  demoMemory = master;
  try {
    window.localStorage.setItem(DEMO_KEY, JSON.stringify(master));
    demoOnlyInMemory = false;
  } catch {
    demoOnlyInMemory = true;
  }
}

/** A load failure in plain words: the tables may not exist until the migration is applied. */
export function codeListErrorText(error: string): string {
  return /does not exist|schema cache|could not find the table/i.test(error)
    ? "The product code list is not set up on this database yet."
    : error;
}

function failure(error: { message: string; code?: string }): Error {
  if (error.code === "23505") {
    if (/letter/.test(error.message)) return new Error("That letter is already used in this list. A retired one stays reserved.");
    if (/_name_key|lower\(name\)/.test(error.message)) return new Error("That name is already in this list.");
    if (/product_code_sets_category_key/.test(error.message)) return new Error("That category already has a code set.");
    if (/product_code_sets_prefix_key/.test(error.message)) return new Error("That prefix is already used by another category.");
    return new Error("Someone else just added the same code. Refresh and try again.");
  }
  if (error.code === "42501") return new Error("Only an administrator can change the product code list.");
  return new Error(error.message);
}

/** The whole master list. Admin only: anyone else reads nothing. */
export async function loadCodeMaster(): Promise<CodeMaster> {
  if (STATIC_DATA_MODE) return readDemoMaster();
  const [sets, methods, varieties, codes] = await Promise.all([
    supabase.from("product_code_sets").select("*").order("category"),
    supabase.from("product_code_methods").select("*").order("sort_order"),
    supabase.from("product_code_varieties").select("*").order("sort_order"),
    supabase.from("product_codes").select("*").order("code"),
  ]);
  const error = sets.error ?? methods.error ?? varieties.error ?? codes.error;
  if (error) throw failure(error);
  const part = (row: { id: string; set_id: string; letter: string; name: string; sort_order: number; retired_at: string | null }) =>
    ({ id: row.id, setId: row.set_id, letter: row.letter, name: row.name, sortOrder: row.sort_order, retiredAt: row.retired_at });
  return {
    sets: (sets.data ?? []).map((row) => ({ id: row.id, category: row.category, prefix: row.prefix, firstLabel: row.first_label, secondLabel: row.second_label })),
    methods: (methods.data ?? []).map(part),
    varieties: (varieties.data ?? []).map(part),
    codes: (codes.data ?? []).map((row) => ({
      id: row.id, setId: row.set_id, methodId: row.method_id, varietyId: row.variety_id, serial: row.serial, code: row.code,
      name: row.name, description: row.description, subcategory: row.subcategory, images: row.images ?? [], retiredAt: row.retired_at, retiredWithPart: row.retired_with_part,
    })),
  };
}

/* ---------- read-only list for other desks: keep these two stable ---------- */

/** Active codes of one category, in the workbook's order. Admin only: empty for anyone else. */
export async function listActiveCodeOptions(category: string): Promise<ActiveCodeOption[]> {
  return activeCodeOptions(await loadCodeMaster(), category);
}

/** Active rice codes for dropdowns such as the sample and purchase desk. */
export function listActiveRiceOptions(): Promise<ActiveCodeOption[]> {
  return listActiveCodeOptions("Rice");
}

/* ---------- the live list for a page ---------- */

/** The master list, fetched again when the tab comes back into view (the manage page opens in a new tab). */
export function useCodeMaster() {
  const [master, setMaster] = useState<CodeMaster | null>(null);
  const [error, setError] = useState("");
  // Only the newest answer counts: an older one arriving late must not undo a change just made.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    latest.current += 1;
    const asked = latest.current;
    try {
      const loaded = await loadCodeMaster();
      if (asked !== latest.current) return;
      setMaster(loaded);
      setError("");
    } catch (cause) {
      if (asked !== latest.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load the product codes");
    }
  }, []);
  useEffect(() => {
    void reload();
    const onFocus = () => { void reload(); };
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);
  return { master, error, reload };
}

/* ---------- changes (admin) ---------- */

type SetInput = { category: string; prefix: string; firstLabel: string; secondLabel: string };

export async function createCodeSet(input: SetInput): Promise<void> {
  if (STATIC_DATA_MODE) { writeDemoMaster(demoCreateSet(readDemoMaster(), input)); return; }
  const problem = codeSetProblem(await loadCodeMaster(), input);
  if (problem) throw new Error(problem);
  const { error } = await supabase.from("product_code_sets").insert({ category: input.category, prefix: input.prefix.trim().toUpperCase(), first_label: input.firstLabel, second_label: input.secondLabel });
  if (error) throw failure(error);
}

export async function updateCodeSet(id: string, input: SetInput): Promise<void> {
  if (STATIC_DATA_MODE) { writeDemoMaster(demoUpdateSet(readDemoMaster(), id, input)); return; }
  const problem = codeSetProblem(await loadCodeMaster(), input, id);
  if (problem) throw new Error(problem);
  const { error } = await supabase.from("product_code_sets").update({ category: input.category, prefix: input.prefix.trim().toUpperCase(), first_label: input.firstLabel, second_label: input.secondLabel }).eq("id", id);
  if (error) throw failure(error);
}

const partTable = (kind: CodePartKind) => (kind === "method" ? "product_code_methods" : "product_code_varieties") as "product_code_methods";

export async function createCodePart(kind: CodePartKind, setId: string, input: { letter: string; name: string }): Promise<void> {
  if (STATIC_DATA_MODE) { writeDemoMaster(demoCreatePart(readDemoMaster(), kind, setId, input)); return; }
  const master = await loadCodeMaster();
  const problem = codePartProblem(master, kind, setId, input);
  if (problem) throw new Error(problem);
  const parts = (kind === "method" ? master.methods : master.varieties).filter((part) => part.setId === setId);
  const sort_order = parts.reduce((top, part) => Math.max(top, part.sortOrder), 0) + 1;
  const { error } = await supabase.from(partTable(kind)).insert({ set_id: setId, letter: input.letter, name: input.name, sort_order });
  if (error) throw failure(error);
}

export async function updateCodePart(kind: CodePartKind, id: string, setId: string, input: { letter: string; name: string }): Promise<void> {
  if (STATIC_DATA_MODE) { writeDemoMaster(demoUpdatePart(readDemoMaster(), kind, id, input)); return; }
  const problem = codePartProblem(await loadCodeMaster(), kind, setId, input, id);
  if (problem) throw new Error(problem);
  const { error } = await supabase.from(partTable(kind)).update({ letter: input.letter, name: input.name }).eq("id", id);
  if (error) throw failure(error);
}

/** Retiring also retires its codes; restoring brings back the codes that went with it. */
export async function setCodePartRetired(kind: CodePartKind, id: string, retired: boolean): Promise<void> {
  const now = new Date().toISOString();
  if (STATIC_DATA_MODE) { writeDemoMaster(demoSetPartRetired(readDemoMaster(), kind, id, retired, now)); return; }
  const { error } = await supabase.from(partTable(kind)).update({ retired_at: retired ? now : null }).eq("id", id);
  if (error) throw failure(error);
}

/** Makes the next serial for this method and variety. The database works out the code itself. */
export async function createProductCode(setId: string, methodId: string, varietyId: string, details: Partial<CodeDetails> = {}): Promise<MasterCode> {
  if (STATIC_DATA_MODE) {
    const made = demoCreateCode(readDemoMaster(), methodId, varietyId, details);
    writeDemoMaster(made.master);
    return made.code;
  }
  // The insert trigger fills in the serial, the code and a blank name or subcategory.
  const { data, error } = await supabase.from("product_codes").insert({ set_id: setId, method_id: methodId, variety_id: varietyId, ...details }).select("*").single();
  if (error) throw failure(error);
  return {
    id: data.id, setId: data.set_id, methodId: data.method_id, varietyId: data.variety_id, serial: data.serial, code: data.code,
    name: data.name, description: data.description, subcategory: data.subcategory, images: data.images ?? [], retiredAt: data.retired_at, retiredWithPart: data.retired_with_part,
  };
}

/** Name, description, subcategory and images. Products already carrying the code keep what they have. */
export async function updateProductCode(id: string, details: CodeDetails): Promise<void> {
  if (STATIC_DATA_MODE) { writeDemoMaster(demoUpdateCode(readDemoMaster(), id, details)); return; }
  const problem = codeDetailsProblem(undefined, details);
  if (problem) throw new Error(problem);
  const { error } = await supabase.from("product_codes").update(details).eq("id", id);
  if (error) throw failure(error);
}

export async function setProductCodeRetired(id: string, retired: boolean): Promise<void> {
  const now = new Date().toISOString();
  if (STATIC_DATA_MODE) { writeDemoMaster(demoSetCodeRetired(readDemoMaster(), id, retired, now)); return; }
  const { error } = await supabase.from("product_codes").update({ retired_at: retired ? now : null }).eq("id", id);
  if (error) throw failure(error);
}

/** An image for a code. Static demo mode has no storage, so it keeps the picture itself. */
export async function uploadCodeImage(file: File): Promise<string> {
  if (!STATIC_DATA_MODE) return uploadCatalogImage(file, "products");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read this image"));
    reader.readAsDataURL(file);
  });
}
