import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { FLAG_LABELS, type AttendanceFlag } from "@/lib/attendance";
import { cn } from "@/lib/utils";

/* Small pieces shared by the staff app, the admin Attendance page and the partner panel. */

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  present: { label: "Present", className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
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

export function FlagChips({ flags, lateMinutes }: { flags: string[]; lateMinutes: number }) {
  if (!flags.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span key={flag} className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
          {flag === "late" ? `Late by ${lateMinutes} min` : FLAG_LABELS[flag as AttendanceFlag] ?? flag}
        </span>
      ))}
    </span>
  );
}
