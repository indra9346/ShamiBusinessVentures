import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";
import { keepSelectable, runOneByOne, selectionState, toggleAllSelected, toggleSelected, type SelectionState } from "@/lib/bulk-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/*
 * Tick boxes, "Select all" and one Delete for the ticked rows of an admin list (owner, 13 Nov 2026). The list decides
 * which rows may be ticked (the ones with their own Delete) and what deleting one row means; this file only keeps the
 * ticks and runs the deletes one after another through runOneByOne, so each row meets the same database rules and log.
 */

/** The ticks of one list. `ids` are the rows shown that may be deleted; ticks on any other row are dropped. */
export function useBulkSelection(ids: readonly string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const key = ids.join("\u0000");
  useEffect(() => {
    setSelected((current) => keepSelectable(current, key ? key.split("\u0000") : []));
  }, [key]);
  const state = selectionState(selected, ids);
  return {
    selected,
    count: [...selected].filter((id) => ids.includes(id)).length,
    state,
    isSelected: (id: string) => selected.has(id),
    toggle: (id: string, on: boolean) => setSelected((current) => toggleSelected(current, id, on)),
    toggleAll: (on: boolean) => setSelected((current) => toggleAllSelected(current, ids, on)),
    clear: () => setSelected(new Set()),
  };
}

/** A tick box big enough for a thumb on a phone. */
export function TickBox({ checked, indeterminate = false, onChange, label, disabled = false, className }: {
  checked: boolean; indeterminate?: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center", className)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        title={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-[18px] w-[18px] cursor-pointer accent-[oklch(0.32_0.07_258)] disabled:cursor-not-allowed disabled:opacity-40"
      />
    </span>
  );
}

/** The bar above a list: Select all, how many are ticked, Clear, and Delete for the ticked rows. */
export function BulkBar({ state, count, selectable, onToggleAll, onClear, onDelete, hint, className }: {
  state: SelectionState; count: number; selectable: number; onToggleAll: (on: boolean) => void; onClear: () => void; onDelete: () => void;
  /** Shown while nothing is ticked, for example "Tick follow-ups to delete several together". */
  hint: string; className?: string;
}) {
  if (selectable === 0) return null;
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-ivory/70 px-2 py-1.5 text-sm", className)}>
      <label className="inline-flex cursor-pointer items-center font-semibold text-navy">
        <TickBox checked={state === "all"} indeterminate={state === "some"} onChange={onToggleAll} label="Select all" />
        <span>Select all</span>
      </label>
      {count > 0 ? (
        <>
          <span className="text-slate">{`${count} selected`}</span>
          <button type="button" onClick={onClear} className="text-xs font-semibold text-slate underline">Clear</button>
          <Button size="sm" className="ml-auto h-8 bg-danger text-white hover:bg-danger/90" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />{`Delete selected (${count})`}
          </Button>
        </>
      ) : (
        <span className="text-xs text-slate">{hint}</span>
      )}
    </div>
  );
}

export type BulkItem = { id: string; label: string };

/**
 * Confirms and runs the delete of the ticked rows, one after another, then says what went and what stayed (with the
 * database's own reason). `run` must do exactly what the row's own Delete does.
 */
export function BulkDeleteDialog({ title, description, items: ticked, reason = "none", typeDelete = false, run, onClose, onFinished }: {
  /** The heading for this many rows. */
  title: (count: number) => string;
  description: string;
  items: BulkItem[];
  /** "required": a reason of 4 or more characters (logged with each row), "optional", or "none". */
  reason?: "required" | "optional" | "none";
  typeDelete?: boolean;
  run: (id: string, reason: string) => Promise<void>;
  onClose: () => void;
  onFinished?: (doneIds: string[]) => void;
}) {
  // The rows ticked when the dialog opened: the list's ticks are cleared once they are gone, the summary stays.
  const [items] = useState(ticked);
  const [why, setWhy] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(0);
  const [result, setResult] = useState<{ done: string[]; failed: { id: string; message: string }[] } | null>(null);
  const labelOf = useMemo(() => new Map(items.map((item) => [item.id, item.label])), [items]);
  const ready = !busy && items.length > 0 && (reason !== "required" || why.trim().length >= 4) && (!typeDelete || typed.trim() === "DELETE");
  const start = async () => {
    setBusy(true);
    setFinished(0);
    const outcome = await runOneByOne(items.map((item) => item.id), (id) => run(id, why.trim()), setFinished);
    setBusy(false);
    setResult({ done: outcome.done, failed: outcome.failed.map((entry) => ({ id: entry.item, message: entry.message })) });
    if (outcome.done.length) toast.success(outcome.done.length === 1 ? "1 deleted" : `${outcome.done.length} deleted`);
    if (outcome.failed.length) toast.error(outcome.failed.length === 1 ? "1 was kept" : `${outcome.failed.length} were kept`);
    onFinished?.(outcome.done);
  };
  const shown = items.slice(0, 8);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title(items.length)}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid min-w-0 gap-3 text-sm">
            {result.done.length > 0 && (
              <div>
                <p className="mb-1 flex items-center gap-1 font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" /><span>{`Deleted: ${result.done.length}`}</span></p>
                <ul className="space-y-0.5 text-xs text-slate">{result.done.map((id) => <li key={id} className="break-all">{labelOf.get(id) ?? id}</li>)}</ul>
              </div>
            )}
            {result.failed.length > 0 && (
              <div>
                <p className="mb-1 flex items-center gap-1 font-semibold text-danger"><XCircle className="h-4 w-4" /><span>{`Kept: ${result.failed.length}`}</span></p>
                <ul className="space-y-1 text-xs">
                  {result.failed.map((entry) => (
                    <li key={entry.id} className="break-words"><span className="font-semibold text-navy">{labelOf.get(entry.id) ?? entry.id}</span>{" "}<span className="text-slate">{entry.message}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-w-0 gap-3 text-sm">
            <ul className="space-y-0.5 rounded-md border border-border bg-muted/40 p-2 text-xs text-charcoal">
              {shown.map((item) => <li key={item.id} className="break-all">{item.label}</li>)}
              {items.length > shown.length && <li className="font-semibold text-slate">{`and ${items.length - shown.length} more`}</li>}
            </ul>
            {reason !== "none" && (
              <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" disabled={busy}
                placeholder={reason === "required" ? "Why are they being deleted? (kept with each one)" : "Reason (optional)"} value={why} onChange={(event) => setWhy(event.target.value)} />
            )}
            {typeDelete && (
              <label className="grid gap-1 text-xs font-semibold text-slate">Type DELETE to confirm<Input value={typed} disabled={busy} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-no-translate /></label>
            )}
            {busy && <p role="status" className="text-xs font-semibold text-navy">{`Deleting ${Math.min(finished + 1, items.length)} of ${items.length}…`}</p>}
          </div>
        )}
        <DialogFooter className="gap-2">
          {result ? (
            <Button className="bg-navy text-white" onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>Keep them</Button>
              <Button className="bg-danger text-white hover:bg-danger/90" disabled={!ready} onClick={() => void start()}>
                {busy ? "Deleting…" : items.length === 1 ? "Delete 1" : `Delete ${items.length}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
