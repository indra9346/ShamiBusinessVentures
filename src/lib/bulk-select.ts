/*
 * Ticking several rows of an admin list and deleting them together (owner, 13 Nov 2026). Each row is still deleted by
 * the same database step as its own Delete button, one after another, so every rule and every log entry stays the same;
 * a row the database keeps is reported with its reason and the rest carry on.
 */

export type SelectionState = "none" | "some" | "all";

export function toggleSelected(selected: ReadonlySet<string>, id: string, on: boolean) {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Ticks or clears every row shown (rows that cannot be deleted are left out of `ids` by the caller). */
export function toggleAllSelected(selected: ReadonlySet<string>, ids: readonly string[], on: boolean) {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function selectionState(selected: ReadonlySet<string>, ids: readonly string[]): SelectionState {
  const ticked = ids.filter((id) => selected.has(id)).length;
  if (ticked === 0) return "none";
  return ticked === ids.length ? "all" : "some";
}

/** Drops ticks on rows that are no longer shown or can no longer be deleted, so a hidden row is never deleted. */
export function keepSelectable(selected: ReadonlySet<string>, ids: readonly string[]) {
  const shown = new Set(ids);
  const kept = [...selected].filter((id) => shown.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}

export type BulkResult<T> = { done: T[]; failed: { item: T; message: string }[] };

/**
 * Runs `step` for each item in turn (never in parallel, so the database sees the same calls as single deletes). A
 * failure is noted and the next item goes ahead.
 */
export async function runOneByOne<T>(items: readonly T[], step: (item: T) => Promise<void>, onProgress?: (finished: number) => void): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { done: [], failed: [] };
  let finished = 0;
  for (const item of items) {
    try {
      await step(item);
      result.done.push(item);
    } catch (cause) {
      result.failed.push({ item, message: cause instanceof Error && cause.message ? cause.message : "Could not delete it" });
    }
    finished += 1;
    onProgress?.(finished);
  }
  return result;
}
