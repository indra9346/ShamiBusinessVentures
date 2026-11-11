import { useRef, useState, type ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useColumnResize } from "@/hooks/use-column-resize";
import { ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { orderTone, paymentTone, TONE_CLASSES } from "@/lib/order-status-tone";

export function StatCard({
  label,
  value,
  delta,
  description,
  icon: Icon,
  highlight,
  compact = false,
  link,
  onClick,
}: {
  label: string;
  value: string;
  delta?: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  highlight?: boolean;
  compact?: boolean;
  /** The page with this data: tapping the card opens it. */
  link?: LinkProps;
  /** Or what tapping does when the data is further down this same page. */
  onClick?: () => void;
}) {
  const up = !delta?.startsWith("-");
  const classes = cn(
    "rounded-lg border border-border bg-card shadow-card transition-all hover:-translate-y-0.5 hover:border-gold",
    compact ? "p-3 sm:p-4" : "p-5",
    highlight && "border-gold/50 bg-ivory",
  );
  const tappable = "relative block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold";
  const arrow = <ChevronRight aria-hidden="true" className="absolute right-2.5 bottom-2.5 h-4 w-4 text-slate" />;
  const body = (
    <>
      <div className={cn("flex items-start justify-between", compact ? "gap-2" : "gap-3")}>
        <p className={cn("font-medium tracking-wide text-slate uppercase", compact ? "min-w-0 text-[10px] leading-tight sm:text-xs" : "text-xs")}>{label}</p>
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-lg",
            compact ? "h-8 w-8 sm:h-9 sm:w-9" : "h-9 w-9",
            highlight ? "bg-gold text-midnight" : "bg-navy/5 text-navy",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p className={cn(compact ? "mt-2 text-xl sm:mt-3 sm:text-2xl" : "mt-3 text-2xl", "font-bold", highlight ? "text-gold" : "text-navy")}>{value}</p>
      {delta && (
        <p className={cn("mt-1 flex items-center gap-1 text-xs font-medium", up ? "text-success" : "text-danger")}>
          {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          {delta} vs last month
        </p>
      )}
      {description && <p className="mt-1 text-xs text-slate">{description}</p>}
    </>
  );
  if (link) return <Link {...link} className={cn(classes, tappable)}>{body}{arrow}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cn(classes, tappable, "flex flex-col justify-start")}>{body}{arrow}</button>;
  return <div className={classes}>{body}</div>;
}

/** A data card opening data further down this page: the section needs an id. Waits a frame so a new filter has drawn. */
export const scrollToSection = (id: string) =>
  window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));

/** What a data card narrowed a list to, with the way back to everything. */
export function FilterNote({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-ivory px-3 py-2 text-xs text-navy">
      <span>Showing:</span>
      <span className="font-semibold">{label}</span>
      <button type="button" onClick={onClear} className="font-semibold text-gold hover:underline">Show all</button>
    </p>
  );
}

/** A dashboard panel's link to the page with all of its data. */
export function ViewAll(props: LinkProps) {
  return <Link {...props} className="text-xs font-semibold whitespace-nowrap text-gold hover:underline">View all</Link>;
}

export function Panel({
  id,
  title,
  action,
  children,
  className,
}: {
  /** Where a data card scrolls to: the panel's content, so on a phone its filters don't push the list off the screen. */
  id?: string;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border bg-card shadow-card", className)}>
      {(title || action) && (
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          {title && <h2 className="break-words text-sm font-bold tracking-wide text-navy uppercase sm:truncate">{title}</h2>}
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div id={id} className={cn("p-4 sm:p-5", id && "scroll-mt-36")}>{children}</div>
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

/**
 * An order's or a payment's status takes the shared order colours first (pending yellow, confirmed green, closed red;
 * the owner's note of 11 Nov 2026), so the customer, admin, vendor and partner screens agree. Order and payment values
 * are written with a capital (Placed, Paid, COD); the lower-case keys above are reviews', vendors' and Zoho jobs' own
 * states, so they keep their colours, as do words that are not about an order (Active, Published, Low Stock, Expired).
 */
function orderBadgeClass(status: string) {
  if (!/^[A-Z]/.test(status)) return null;
  const tone = orderTone(status) ?? paymentTone(status);
  return tone ? TONE_CLASSES[tone].badge : null;
}

/**
 * plain: the general colours, not the order colours, for a word that means something else on that page, like a
 * return's "Refunded", which there is the good outcome, not a reversal.
 */
export function StatusBadge({ status, plain = false }: { status: string; plain?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize",
        (plain ? null : orderBadgeClass(status)) ?? toneMap[status] ?? "bg-navy/6 text-navy border-navy/15",
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
  columnClassNames,
  minWidth = 640,
  tableId,
  rowClassNames,
}: {
  columns: string[];
  rows: ReactNode[][];
  empty?: string;
  /** Optional classes per column (width, alignment, wrapping), applied to its header and cells. */
  columnClassNames?: (string | undefined)[];
  /**
   * Optional classes per row, in the same order as rows: an order row's status tint (orderToneClass(status, "row")).
   * A tint brings its own hover, which replaces the plain one, so the row under the pointer still shows.
   */
  rowClassNames?: (string | undefined)[];
  /** Table min width in px before it scrolls sideways. */
  minWidth?: number;
  /** Where its column widths are remembered; defaults to this page and these columns. */
  tableId?: string;
}) {
  // Columns resize like Excel / Zoho: drag a header's right edge, double-click it to fit.
  const tableRef = useRef<HTMLTableElement>(null);
  const page = typeof window === "undefined" ? "" : window.location.pathname;
  useColumnResize(tableRef, tableId ?? `${page}::${columns.join("|")}`);
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
      <table ref={tableRef} className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((c, j) => (
              <th key={c} className={cn("px-3 py-3 text-[11px] font-bold tracking-wider text-slate uppercase", columnClassNames?.[j])}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn("border-b border-border/70 transition-colors last:border-0 hover:bg-ivory", rowClassNames?.[i])}>
              {r.map((cell, j) => (
                <td key={j} className={cn("px-3 py-3.5 align-middle text-charcoal", columnClassNames?.[j])}>
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
