import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { FLAG_LABELS, lateText, ruleLines, type AttendanceFlag, type GodownRules, type RuleChange } from "@/lib/attendance";
import { cn } from "@/lib/utils";

/* Small pieces shared by the staff app, the admin Attendance page and the partner panel. */

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  present: { label: "Present", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  half_day: { label: "Half day", className: "bg-amber-50 text-amber-800 border-amber-200" },
  absent: { label: "Absent", className: "bg-red-50 text-red-700 border-red-200" },
  approved: { label: "Approved", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  pending: { label: "Waiting for approval", className: "bg-amber-50 text-amber-800 border-amber-200" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700 border-red-200" },
  cancelled: { label: "Cancelled", className: "bg-slate-100 text-slate-600 border-slate-200" },
};

export function AttendanceStatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLE[status] ?? { label: status, className: "bg-slate-100 text-slate-600 border-slate-200" };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold", style.className, className)}>{style.label}</span>;
}

function Decision({ who, decision }: { who: string; decision: string | null }) {
  const Icon = decision === "approved" ? CheckCircle2 : decision === "rejected" ? XCircle : Clock;
  const label = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Waiting";
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", decision === "approved" ? "text-emerald-700" : decision === "rejected" ? "text-red-700" : "text-slate")}>
      <Icon className="h-3.5 w-3.5" /> {`${who}: ${label}`}
    </span>
  );
}

/** "Head office: Approved · Channel partner: Waiting". The partner part is left out when the godown has none. */
export function DecisionChips({ head, partner, partnerRequired = true }: { head: string | null; partner: string | null; partnerRequired?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <Decision who="Head office" decision={head} />
      {(partnerRequired || partner) && <Decision who="Channel partner" decision={partner} />}
    </span>
  );
}

/** Parts of a rule's value, each its own piece of text so Kannada translates them one by one. */
function RuleValue({ parts }: { parts: string[] }) {
  return <>{parts.map((part, index) => <span key={part}>{index > 0 ? ", " : ""}<span>{part}</span></span>)}</>;
}

/** A godown's rules in words. */
export function RuleList({ rules, compact = false }: { rules: GodownRules; compact?: boolean }) {
  return (
    <dl className={cn("grid gap-x-6 text-sm", !compact && "sm:grid-cols-2")}>
      {ruleLines(rules).map((line) => (
        <div key={line.key} className="flex justify-between gap-3 border-b border-border/60 py-1.5">
          <dt className="text-slate">{line.label}</dt>
          <dd className="text-right font-semibold text-navy"><RuleValue parts={line.value} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** "Shift starts: 9:30 am → 9:00 am", one line per changed rule. */
export function RuleChangeList({ changes }: { changes: RuleChange[] }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {changes.map((change) => (
        <li key={change.key} className="flex flex-wrap items-baseline gap-x-1">
          <span className="text-slate">{change.label}</span>
          <span className="text-slate">:</span>
          <span className="text-charcoal"><RuleValue parts={change.from} /></span>
          <span className="text-slate">→</span>
          <span className="font-semibold text-navy"><RuleValue parts={change.to} /></span>
        </li>
      ))}
    </ul>
  );
}

export function FlagChips({ flags, lateMinutes }: { flags: string[]; lateMinutes: number }) {
  if (!flags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span key={flag} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
          {flag === "late" ? lateText(lateMinutes) : FLAG_LABELS[flag as AttendanceFlag] ?? flag}
        </span>
      ))}
    </span>
  );
}
