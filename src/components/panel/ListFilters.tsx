// A search box with filter buttons for a list (owner's note, 11 Nov 2026: filters for the channel partner's and the
// godown staff's orders, and search "in all the places"). The counts say how many rows each button shows.
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Choice = { key: string; label: string };

export function ListFilters({
  query, onQuery, placeholder, groups, shown, total, className,
}: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  /** Rows of filter buttons: the choices, which is on, the counts and what a tap does. */
  groups?: { label: string; choices: ReadonlyArray<Choice>; value: string; onChange: (key: string) => void; counts?: Record<string, number> }[];
  shown: number;
  total: number;
  className?: string;
}) {
  const filtered = Boolean(query.trim()) || (groups ?? []).some((group) => group.value !== group.choices[0]?.key);
  return (
    <div className={cn("mb-3 space-y-2", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate" />
        <input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="h-9 w-full rounded-md border border-input bg-white pr-9 pl-9 text-sm text-charcoal placeholder:text-slate focus:border-gold focus:ring-2 focus:ring-gold/30 focus:outline-none" />
        {query && (
          <button type="button" onClick={() => onQuery("")} aria-label="Clear search" className="absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-slate hover:text-navy">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {(groups ?? []).map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className="flex flex-wrap gap-1.5">
          {group.choices.map((choice) => {
            const on = group.value === choice.key;
            const count = group.counts?.[choice.key];
            return (
              <button key={choice.key} type="button" aria-pressed={on} onClick={() => group.onChange(choice.key)}
                className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold",
                  on ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-gold")}>
                <span>{choice.label}</span>
                {count !== undefined && <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", on ? "bg-white/20" : "bg-ivory text-slate")}>{count}</span>}
              </button>
            );
          })}
        </div>
      ))}
      {filtered && (
        <p className="text-xs text-slate" aria-live="polite">
          <span>{`Showing ${shown} of ${total}`}</span>
          <button type="button" className="ml-2 font-semibold text-navy hover:underline" onClick={() => { onQuery(""); (groups ?? []).forEach((group) => group.onChange(group.choices[0]?.key ?? "all")); }}>
            Show everything
          </button>
        </p>
      )}
    </div>
  );
}
