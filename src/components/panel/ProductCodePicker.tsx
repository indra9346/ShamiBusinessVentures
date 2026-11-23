import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Product } from "@/lib/data";
import { useApp } from "@/lib/store";
import {
  activePartsOfSet,
  codeOption,
  codePartProblem,
  codesOfPair,
  duplicateProducts,
  duplicatesToConfirm,
  findMasterCode,
  newCodePreview,
  normalizeCodeInput,
  normalizeLetter,
  packKey,
  packLabel,
  setForCategory,
  type ActiveCodeOption,
  type CodePartKind,
  type MasterCode,
} from "@/lib/product-code-rules";
import { codeListErrorText, createCodePart, createProductCode, useCodeMaster } from "@/lib/product-codes";

/** What a chosen code brings from the master list. */
export type CodeFill = Pick<ActiveCodeOption, "code" | "name" | "description" | "category" | "subcategory" | "brand" | "images">;
/** The product form's fields a code can fill in. */
export type CodeFormFields = { name: string; description: string; subcategory: string; image: string };
type Pack = Pick<Product, "weight" | "ratePricing">;

const NEW_PART = "__new_part__";

const fillOf = (option: ActiveCodeOption): CodeFill => ({
  code: option.code, name: option.name, description: option.description, category: option.category, subcategory: option.subcategory, brand: option.brand, images: option.images,
});
const clean = (text: string | undefined) => (text ?? "").trim();
const sameWords = (a: string | undefined, b: string | undefined) => clean(a).toLowerCase() === clean(b).toLowerCase();

/**
 * Chooses a product's code from the master list: type it, or pick the method and variety. Adding a
 * product, the choice fills the form at once (`onSelect`). Editing a live product it changes nothing but
 * the code; the admin takes the master's name, subcategory or image one by one (`onUse`). Nothing on the
 * product is saved until the form is. A code stays chosen until another is picked or X is tapped: half
 * typed text never takes it off.
 */
export function ProductCodePicker({
  mode,
  category,
  value,
  onSelect,
  onClear,
  current,
  onUse,
  pack,
  excludeProductId,
  subcategories,
  duplicateOk,
  onDuplicateOk,
  original,
  onBoxChange,
}: {
  mode: "add" | "edit";
  category: string;
  value: string;
  onSelect: (fill: CodeFill) => void;
  onClear: () => void;
  current: CodeFormFields;
  onUse: (patch: Partial<CodeFormFields>) => void;
  /** This product's pack size, to warn when a live product already sells this code in it. */
  pack: Pack;
  excludeProductId?: string;
  /** The category's subcategories, to say when a code would add one. */
  subcategories: string[];
  duplicateOk: boolean;
  onDuplicateOk: (ok: boolean) => void;
  /** Editing: what the product has now. */
  original?: { code: string; subcategory: string; pack: Pack };
  /** What the code box says, so the form can refuse to save over text that isn't a code. */
  onBoxChange: (text: string) => void;
}) {
  const { products, categories } = useApp();
  const { master, error, reload } = useCodeMaster();
  const [typed, setTyped] = useState(value);
  const [methodId, setMethodId] = useState("");
  const [varietyId, setVarietyId] = useState("");
  const [newPart, setNewPart] = useState<{ kind: CodePartKind; letter: string; name: string } | null>(null);
  const [pendingPart, setPendingPart] = useState<{ kind: CodePartKind; letter: string } | null>(null);
  const [confirmingCode, setConfirmingCode] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keep the box in step with the form, without wiping what is being typed.
  const lastValue = useRef(value);
  useEffect(() => {
    if (value) setTyped(value);
    else if (normalizeCodeInput(typed) === lastValue.current) setTyped("");
    lastValue.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const typedCode = normalizeCodeInput(typed);
  useEffect(() => { onBoxChange(typedCode); }, [typedCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = master ? setForCategory(master, category) : undefined;
  const methods = useMemo(() => (master && set ? activePartsOfSet(master, "method", set.id) : []), [master, set]);
  const varieties = useMemo(() => (master && set ? activePartsOfSet(master, "variety", set.id) : []), [master, set]);
  const chosen = master && value ? findMasterCode(master, value) : undefined;
  const option = master && chosen ? codeOption(master, chosen) : null;

  // The dropdowns show the chosen code, and forget a pair from another category.
  useEffect(() => {
    if (!chosen) return;
    setMethodId(chosen.methodId);
    setVarietyId(chosen.varietyId);
  }, [chosen?.id]);
  useEffect(() => {
    if (chosen) return;
    setMethodId("");
    setVarietyId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set?.id]);
  const shownMethod = methods.some((part) => part.id === methodId) ? methodId : "";
  const shownVariety = varieties.some((part) => part.id === varietyId) ? varietyId : "";

  // A part just created here is chosen once the list has it.
  useEffect(() => {
    if (!pendingPart || !set) return;
    const made = (pendingPart.kind === "method" ? methods : varieties).find((part) => part.letter === pendingPart.letter);
    if (!made) return;
    if (pendingPart.kind === "method") setMethodId(made.id);
    else setVarietyId(made.id);
    setPendingPart(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPart, methods, varieties, set]);

  const pairCodes = master && shownMethod && shownVariety ? codesOfPair(master, shownMethod, shownVariety) : [];
  const pairActive = pairCodes.filter((code) => !code.retiredAt);
  const preview = master && shownMethod && shownVariety ? newCodePreview(master, shownMethod, shownVariety) : null;
  const isLiveCategory = (name: string) => categories.length === 0 || categories.some((row) => sameWords(row.name, name));

  /** Why this code can't go on this product; "" when it can. */
  const refusal = (code: MasterCode) => {
    if (code.retiredAt) return `${code.code} is retired, so it can't go on a product. Retired codes are never used again.`;
    const belongsTo = master ? codeOption(master, code)?.category : undefined;
    if (mode === "edit" && !sameWords(belongsTo, category)) return `${code.code} belongs to ${belongsTo}, but this product is in ${category}.`;
    if (mode === "add" && belongsTo && !isLiveCategory(belongsTo)) return `${code.code} belongs to ${belongsTo}, which is no longer a category. Move its set on the Product Codes page first.`;
    return "";
  };

  const pick = (code: MasterCode) => {
    if (!master) return;
    const picked = codeOption(master, code);
    if (!picked) return;
    if (picked.code !== value) onDuplicateOk(false);
    setTyped(code.code);
    setConfirmingCode(false);
    onSelect(fillOf(picked));
  };

  const onType = (raw: string) => {
    const text = normalizeCodeInput(raw);
    setTyped(text);
    const match = master ? findMasterCode(master, text) : undefined;
    if (match && match.code !== value && !refusal(match)) pick(match);
  };

  // What was typed may have become a code since: the list just loaded, or it was made in the other tab.
  useEffect(() => {
    if (!master || !typedCode || typedCode === value) return;
    const match = findMasterCode(master, typedCode);
    if (match && !refusal(match)) pick(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master]);

  const typedMatch = master && typedCode ? findMasterCode(master, typedCode) : undefined;
  const keeps = value ? ` ${value} stays on this product until you choose another code.` : "";
  const typedProblem = !master || typedCode === value ? ""
    : !typedCode ? (value ? `${value} is still chosen. To take it off, tap X below.` : "")
    : typedMatch ? (refusal(typedMatch) ? refusal(typedMatch) + keeps : "")
    : typedCode.length >= 4 ? `No code ${typedCode} in the list.${keeps}`
    : value ? `Finish typing a code.${keeps}` : "";

  const choosePair = (nextMethod: string, nextVariety: string) => {
    setMethodId(nextMethod);
    setVarietyId(nextVariety);
    setConfirmingCode(false);
    if (!master || !nextMethod || !nextVariety) return;
    const active = codesOfPair(master, nextMethod, nextVariety).filter((code) => !code.retiredAt);
    if (active.length === 1) pick(active[0]!);
  };

  const saveNewPart = async () => {
    if (!newPart || !set || !master) return;
    const problem = codePartProblem(master, newPart.kind, set.id, newPart);
    if (problem) { toast.error(problem); return; }
    setBusy(true);
    try {
      await createCodePart(newPart.kind, set.id, { letter: normalizeLetter(newPart.letter), name: newPart.name });
      setPendingPart({ kind: newPart.kind, letter: normalizeLetter(newPart.letter) });
      setNewPart(null);
      await reload();
      toast.success(`${newPart.kind === "method" ? set.firstLabel : set.secondLabel} added`);
    } catch (cause) {
      toast.error("Could not add this", { description: cause instanceof Error ? cause.message : "Please retry." });
    } finally {
      setBusy(false);
    }
  };

  const makeCode = async () => {
    if (!set || !shownMethod || !shownVariety) return;
    setBusy(true);
    try {
      const made = await createProductCode(set.id, shownMethod, shownVariety);
      await reload();
      onDuplicateOk(false);
      setTyped(made.code);
      setConfirmingCode(false);
      onSelect({ code: made.code, name: made.name, description: made.description, category: set.category, subcategory: made.subcategory, brand: set.brand, images: made.images });
      toast.success(`Code ${made.code} created`);
    } catch (cause) {
      toast.error("Could not create this code", { description: cause instanceof Error ? cause.message : "Please retry." });
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    setTyped("");
    setMethodId("");
    setVarietyId("");
    setConfirmingCode(false);
    onDuplicateOk(false);
    onClear();
  };

  // A tick given for one pack size doesn't cover another.
  const packNow = packKey(pack);
  useEffect(() => { onDuplicateOk(false); }, [packNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const duplicates = useMemo(() => duplicateProducts(products, value, pack, excludeProductId), [products, value, packNow, excludeProductId]); // eslint-disable-line react-hooks/exhaustive-deps
  const mustConfirm = duplicatesToConfirm(products, value, pack, excludeProductId, original).length > 0;
  const manageHref = `/admin/product-codes?category=${encodeURIComponent(category)}`;
  const differs = (a: string | undefined, b: string | undefined) => clean(a) !== clean(b);
  const inList = (sub: string | undefined) => subcategories.some((known) => sameWords(known, sub));
  const takingNameOrDescription = !!option && mode === "edit" && (differs(option.name, current.name) || (!!option.description && differs(option.description, current.description)));

  const partSelect = (kind: CodePartKind) => {
    const parts = kind === "method" ? methods : varieties;
    const label = kind === "method" ? set?.firstLabel ?? "Method" : set?.secondLabel ?? "Variety";
    const shown = kind === "method" ? shownMethod : shownVariety;
    return (
      <div className="min-w-0">
        <Label>{label}</Label>
        <Select
          value={shown}
          disabled={!set}
          onValueChange={(next) => {
            if (next === NEW_PART) { setNewPart({ kind, letter: "", name: "" }); return; }
            setNewPart(null);
            if (kind === "method") choosePair(next, shownVariety);
            else choosePair(shownMethod, next);
          }}
        >
          <SelectTrigger aria-label={label}><SelectValue placeholder={`Choose ${label.toLowerCase()}`} /></SelectTrigger>
          <SelectContent>
            {parts.map((part) => <SelectItem key={part.id} value={part.id}>{part.name} ({part.letter})</SelectItem>)}
            <SelectItem value={NEW_PART} className="font-semibold text-navy">+ New {label.toLowerCase()}…</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <fieldset id="product-code" className="min-w-0 space-y-3 rounded-md border border-gold/50 bg-ivory/50 p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">Product code</legend>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 basis-56 text-xs text-slate">
          {mode === "add"
            ? "Choose a code and its name, category, subcategory and image fill in. You can still change them before saving."
            : "Choosing a code changes only the code. This product's name and image stay as they are unless you take the list's below."}
        </p>
        <a href={manageHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-navy underline hover:text-gold">
          Manage codes <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </div>

      {error && !master && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The code list could not load ({codeListErrorText(error)}). You can still save this product{value ? `, and it keeps ${value}` : " and give it a code later"}.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <Label>Type a code</Label>
          <Input
            value={typed}
            placeholder="e.g. RS01"
            aria-label="Type a product code"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={10}
            className="font-mono uppercase"
            onChange={(event) => onType(event.target.value)}
          />
        </div>
        {partSelect("method")}
        {partSelect("variety")}
      </div>

      {typedProblem && <p role="alert" className="text-xs font-medium text-danger">{typedProblem}</p>}

      {master && !set && !typedMatch && (
        <p className="text-xs text-slate">
          {category} has no code list yet. <a href={manageHref} target="_blank" rel="noopener noreferrer" className="font-semibold text-navy underline hover:text-gold">Start one</a> or save this product without a code.
        </p>
      )}

      {newPart && set && (
        <div className="space-y-2 rounded-md border border-gold/50 bg-card p-3">
          <p className="text-sm font-semibold text-navy">New {(newPart.kind === "method" ? set.firstLabel : set.secondLabel).toLowerCase()} for {set.category}</p>
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <div>
              <Label className="text-xs">Letter</Label>
              <Input maxLength={1} className="font-mono uppercase" aria-label="Letter" value={newPart.letter} onChange={(event) => setNewPart({ ...newPart, letter: event.target.value.toUpperCase() })} />
            </div>
            <div className="min-w-0">
              <Label className="text-xs">Name</Label>
              <Input aria-label="Name" maxLength={80} value={newPart.name} onChange={(event) => setNewPart({ ...newPart, name: event.target.value })} />
            </div>
          </div>
          {master && (newPart.letter || newPart.name) && codePartProblem(master, newPart.kind, set.id, newPart) && (
            <p className="text-xs text-danger">{codePartProblem(master, newPart.kind, set.id, newPart)}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setNewPart(null)}>Cancel</Button>
            <Button type="button" size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void saveNewPart()}>{busy ? "Adding…" : "Add"}</Button>
          </div>
        </div>
      )}

      {shownMethod && shownVariety && !newPart && (
        <div className="space-y-2">
          {pairActive.length > 0 && !(pairActive.length === 1 && pairActive[0]!.code === value) && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Choose the code">
              {pairActive.map((code) => (
                <button
                  key={code.id}
                  type="button"
                  onClick={() => pick(code)}
                  className={`min-h-9 rounded-md border px-3 py-1.5 text-left text-xs ${code.code === value ? "border-navy bg-navy text-white" : "border-border bg-card text-navy hover:border-gold"}`}
                >
                  <span className="font-mono font-bold">{code.code}</span> {code.name}
                </button>
              ))}
            </div>
          )}
          {pairActive.length === 0 && (
            <p className="text-xs text-slate">
              {pairCodes.length > 0 ? `${pairCodes.map((code) => code.code).join(", ")} retired. ` : "No code yet for this pair. "}
              {value ? `${value} stays on this product until you choose another code.` : ""}
            </p>
          )}
          {preview && "error" in preview && <p className="text-xs text-danger">{preview.error}</p>}
          {preview && "code" in preview && !confirmingCode && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmingCode(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {pairActive.length === 0 ? `Create ${preview.code}` : `Add the next code, ${preview.code}`}
            </Button>
          )}
          {preview && "code" in preview && confirmingCode && (
            <div className="space-y-2 rounded-md border border-gold/50 bg-card p-3 text-xs text-charcoal">
              <p>Make <b className="font-mono">{preview.code}</b> now? This goes into the code list at once. It can be retired but never deleted, and its number is then used up.</p>
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setConfirmingCode(false)}>Not now</Button>
                <Button type="button" size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void makeCode()}>{busy ? "Making…" : `Make ${preview.code}`}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {original?.code && value !== original.code && (
        <p className="text-xs font-medium text-navy">
          {value ? `This product changes from ${original.code} to ${value} when you save.` : `Code ${original.code} comes off this product when you save.`}
        </p>
      )}

      {value && (
        <div className="space-y-2 rounded-md border border-border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm text-charcoal">
              <span className="mr-2 rounded bg-navy px-2 py-0.5 font-mono text-xs font-bold text-white">{value}</span>
              <span className="font-semibold text-navy">{option?.name ?? (master ? "Not in the list" : "")}</span>
            </p>
            <button type="button" aria-label={`Remove code ${value} from this product`} title="Remove the code" className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-slate hover:text-danger" onClick={remove}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {option && <p className="text-xs text-slate">{option.category} › {option.subcategory}</p>}
          {chosen?.retiredAt && (
            <p className="text-xs font-medium text-amber-800">
              {mode === "edit" && original?.code === value ? "This code is retired. This product keeps it unless you choose another." : "This code is retired. Choose another."}
            </p>
          )}

          {option && differs(option.name, current.name) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
              <span className="min-w-0 flex-1 basis-48 text-charcoal">Name here: {current.name || "blank"}. List says: <b>{option.name}</b></span>
              <Button type="button" size="sm" variant="outline" onClick={() => onUse({ name: option.name })}>Use list name</Button>
            </div>
          )}
          {option && differs(option.subcategory, current.subcategory) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
              <span className="min-w-0 flex-1 basis-48 text-charcoal">Subcategory here: {current.subcategory || "blank"}. List says: <b>{option.subcategory}</b></span>
              <Button type="button" size="sm" variant="outline" onClick={() => onUse({ subcategory: option.subcategory })}>Use list subcategory</Button>
            </div>
          )}
          {option && option.description && differs(option.description, current.description) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
              <span className="min-w-0 flex-1 basis-48 text-charcoal">The list has a different description.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => onUse({ description: option.description })}>Use list description</Button>
            </div>
          )}
          {option && !inList(current.subcategory) && clean(current.subcategory) === clean(option.subcategory) && (mode === "add" || original?.subcategory !== current.subcategory) && (
            <p className="text-xs text-slate">{option.subcategory} is not a subcategory of {option.category} yet. It is added to the list when you save, and shows as a filter on the store.</p>
          )}

          {option && (
            option.images.length > 0 ? (
              <div className="border-t border-border pt-2">
                <p className="mb-1.5 text-xs text-slate">Images on this code. Tap one to use it on this product.</p>
                <div className="flex flex-wrap gap-2">
                  {option.images.map((url) => (
                    <button key={url} type="button" aria-label="Use this image" aria-pressed={current.image === url} onClick={() => onUse({ image: url })}
                      className={`h-14 w-14 overflow-hidden rounded-md border-2 bg-card ${current.image === url ? "border-navy" : "border-border hover:border-gold"}`}>
                      <img src={url} alt="" loading="lazy" className="h-full w-full object-contain" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="border-t border-border pt-2 text-xs text-slate">
                No images on this code yet. Add them under Manage codes, or use the product image field.
              </p>
            )
          )}
          {takingNameOrDescription && (
            <p className="text-xs text-slate">Taking the list's name or description sends it to Zoho on save, like any other edit. The code itself is not sent to Zoho, and the SKU stays the same.</p>
          )}
        </div>
      )}

      {value && duplicates.length > 0 && (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="flex gap-1.5 font-semibold">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            An active product already has code {value} in {packLabel(pack)}:
          </p>
          <ul className="space-y-1">
            {duplicates.map((product) => (
              <li key={product.id}>
                <Link to="/admin/products/$id" params={{ id: product.id }} target="_blank" className="font-semibold underline">{product.name}</Link>
                {" "}({product.weight}, SKU {product.sku})
              </li>
            ))}
          </ul>
          {mustConfirm && (
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={duplicateOk} onChange={(event) => onDuplicateOk(event.target.checked)} />
              Yes, keep both. They are meant to be separate products.
            </label>
          )}
        </div>
      )}
    </fieldset>
  );
}
