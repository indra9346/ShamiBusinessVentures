import { useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { SORT_LABELS, type SortKey } from "@/lib/sort-rows";

export { ALL_SORTS, NO_AMOUNT_SORTS, sortRows, type SortKey } from "@/lib/sort-rows";

/**
 * "Sort by" for the channel partner's order lists (client, 16 Nov 2026: "in channel partner login sort by orders option
 * enable that"). The choice is remembered on this device for each list.
 */
const STORE = "gb-sort:";

/** The list's sort choice, remembered on this device (newest first until changed). */
export function useSortKey(list: string, keys: readonly SortKey[]): [SortKey, (key: SortKey) => void] {
  const [key, setKey] = useState<SortKey>(() => {
    if (typeof window === "undefined") return "newest";
    try {
      const saved = localStorage.getItem(STORE + list) as SortKey | null;
      return saved && keys.includes(saved) ? saved : "newest";
    } catch {
      return "newest";
    }
  });
  const choose = (next: SortKey) => {
    setKey(next);
    try { localStorage.setItem(STORE + list, next); } catch { /* storage blocked */ }
  };
  return [key, choose];
}

export function SortBy({ value, onChange, keys, className }: {
  value: SortKey; onChange: (key: SortKey) => void; keys: readonly SortKey[]; className?: string;
}) {
  return (
    <label className={cn("inline-flex items-center gap-1.5 text-xs text-slate", className)}>
      <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-navy" />
      <span className="font-semibold text-navy">Sort by</span>
      <select value={value} onChange={(event) => onChange(event.target.value as SortKey)}
        className="h-8 rounded-md border border-input bg-white px-2 text-xs text-charcoal" aria-label="Sort by">
        {keys.map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
      </select>
    </label>
  );
}

