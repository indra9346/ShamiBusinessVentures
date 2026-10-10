import { useState, type ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  delta,
  description,
  icon: Icon,
  highlight,
}: {
  label: string;
  value: string;
  delta?: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
}) {
  const up = !delta?.startsWith("-");
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-5 shadow-card transition-all hover:-translate-y-0.5 hover:border-gold",
        highlight && "border-gold/50 bg-ivory",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-slate uppercase">{label}</p>
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
            highlight ? "bg-gold text-midnight" : "bg-navy/5 text-navy",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className={cn("mt-3 text-2xl font-bold", highlight ? "text-gold" : "text-navy")}>{value}</p>
      {delta && (
        <p className={cn("mt-1 flex items-center gap-1 text-xs font-medium", up ? "text-success" : "text-danger")}>
          {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          {delta} vs last month
        </p>
      )}
      {description && <p className="mt-1 text-xs text-slate">{description}</p>}
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card shadow-card", className)}>
      {(title || action) && (
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          {title && <h2 className="truncate text-sm font-bold tracking-wide text-navy uppercase">{title}</h2>}
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

const toneMap: Record<string, string> = {
  success: "bg-success/10 text-success border-success/25",
  Paid: "bg-success/10 text-success border-success/25",
  Delivered: "bg-success/10 text-success border-success/25",
  Successful: "bg-success/10 text-success border-success/25",
  approved: "bg-success/10 text-success border-success/25",
  Approved: "bg-success/10 text-success border-success/25",
  Active: "bg-success/10 text-success border-success/25",
  active: "bg-success/10 text-success border-success/25",
  Published: "bg-success/10 text-success border-success/25",
  warning: "bg-gold/12 text-gold border-gold/30",
  Pending: "bg-gold/12 text-gold border-gold/30",
  pending: "bg-gold/12 text-gold border-gold/30",
  Processing: "bg-gold/12 text-gold border-gold/30",
  Packed: "bg-gold/12 text-gold border-gold/30",
  "Low Stock": "bg-gold/12 text-gold border-gold/30",
  Failed: "bg-danger/10 text-danger border-danger/25",
  Cancelled: "bg-danger/10 text-danger border-danger/25",
  rejected: "bg-danger/10 text-danger border-danger/25",
  Rejected: "bg-danger/10 text-danger border-danger/25",
  blocked: "bg-danger/10 text-danger border-danger/25",
  Blocked: "bg-danger/10 text-danger border-danger/25",
  suspended: "bg-danger/10 text-danger border-danger/25",
  Expired: "bg-slate/10 text-slate border-slate/25",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize",
        toneMap[status] ?? "bg-navy/6 text-navy border-navy/15",
      )}
    >
      {status}
    </span>
  );
}

export function DataTable({
  columns,
  rows,
  empty = "No records found",
}: {
  columns: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="grid place-items-center gap-2 py-14 text-center">
        <p className="text-sm font-semibold text-navy">{empty}</p>
        <p className="text-xs text-slate">Adjust your filters or add a new record to get started.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((c) => (
              <th key={c} className="px-3 py-3 text-[11px] font-bold tracking-wider text-slate uppercase">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/70 transition-colors last:border-0 hover:bg-ivory">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-3.5 align-middle text-charcoal">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Filters<T extends string = string>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value?: T;
  onChange?: (val: T) => void;
}) {
  const [internal, setInternal] = useState<T>(options[0]!);
  const current = value ?? internal;

  const handleSelect = (opt: T) => {
    if (value === undefined) setInternal(opt);
    onChange?.(opt);
  };

  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o === current;
        return (
          <button
            key={o}
            type="button"
            onClick={() => handleSelect(o)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 cursor-pointer",
              active
                ? "border-navy bg-navy text-white shadow-xs"
                : "border-border bg-card text-slate hover:border-gold hover:text-gold hover:bg-gold/5",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}
