import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, History } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { inrPrecise } from "@/lib/data";
import { downloadXlsx } from "@/lib/xlsx";
import { buildPartnerHistory, partnerHistorySheet, type HistoryPeriod } from "@/lib/partner-history";
import type { PartnerHistoryData } from "@/lib/partner-history.functions";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Who ran each godown from when to when, with what they sold and earned in that time, and the
 * gaps when a godown had no partner. `refreshKey` changes after a partner is added or suspended.
 */
export function PartnerHistoryPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<PartnerHistoryData | null>(null);
  const [error, setError] = useState("");
  const [godownId, setGodownId] = useState("");
  useEffect(() => {
    if (STATIC_DATA_MODE) { setData(demoHistory()); return; }
    let live = true;
    void import("@/lib/partner-history.functions")
      .then(({ getPartnerHistory }) => getPartnerHistory())
      .then((result) => { if (live) { setData(result); setError(""); } })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load the partner history"); });
    return () => { live = false; };
  }, [refreshKey]);
  const history = useMemo(() => (data ? buildPartnerHistory({ ...data, now: data.generatedAt }) : null), [data]);
  const shown = history ? history.godowns.filter((g) => !godownId || g.godownId === godownId) : [];

  const download = () => {
    if (!history || !data) return;
    const name = godownId ? history.godowns.find((g) => g.godownId === godownId)?.godown ?? godownId : "all-godowns";
    downloadXlsx(`partner-history-${name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.xlsx`,
      [partnerHistorySheet(history, { generatedAt: data.generatedAt, ...(godownId ? { godownId } : {}) })]);
    toast.success("Partner history downloaded");
  };

  return (
    <Panel title="Partner history" action={
      <div className="flex flex-wrap items-center gap-2">
        <select value={godownId} onChange={(e) => setGodownId(e.target.value)} aria-label="Godown" className="h-8 rounded-md border border-input bg-white px-2 text-sm">
          <option value="">All godowns</option>
          {(history?.godowns ?? []).map((g) => <option key={g.godownId} value={g.godownId}>{g.godown}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={!history} onClick={download}><FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />Download Excel</Button>
      </div>
    }>
      <div className="grid gap-5 p-4">
        <p className="flex items-start gap-2 rounded-md bg-ivory/70 p-3 text-xs text-charcoal">
          <History className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
          <span>Changing a partner never moves past data: each order's commission stays with the partner who was active when it was placed (even if it is delivered or paid later), a suspended partner's login stops at once, and the new partner earns only on orders placed after they were added.</span>
        </p>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {!history && !error && <p className="text-sm text-slate">Loading partner history…</p>}
        {shown.map((g) => {
          const rows = history!.periods.filter((p) => p.godownId === g.godownId);
          return (
            <section key={g.godownId} className="min-w-0">
              <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-bold text-navy">
                <span>{g.godown}</span>
                <span className="text-xs font-normal text-slate">{g.current ? `Current partner: ${g.current.name}` : "No partner now"}</span>
                <span className="text-xs font-normal text-slate">{`${g.partnersSoFar} partner${g.partnersSoFar === 1 ? "" : "s"} so far`}</span>
              </h3>
              {rows.length === 0
                ? <p className="text-sm text-slate">No channel partner has run this godown yet.</p>
                : <ol className="relative grid gap-3 border-l-2 border-border pl-4">{rows.map((p) => <PeriodRow key={`${p.kind}-${p.partner?.id ?? "gap"}-${p.from}`} period={p} />)}</ol>}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}

function PeriodRow({ period: p }: { period: HistoryPeriod }) {
  const gap = p.kind === "gap";
  return (
    <li className="relative min-w-0">
      <span className={cn("absolute -left-[23px] top-1.5 h-3 w-3 rounded-full border-2 border-white",
        gap ? "bg-amber-400" : p.current ? "bg-emerald-500" : "bg-slate-400")} aria-hidden="true" />
      <div className={cn("rounded-lg border p-3", gap ? "border-dashed border-amber-300 bg-amber-50/60" : "border-border bg-white")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold text-navy">{gap ? "No partner" : p.partner!.name}</p>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold",
            gap ? "bg-amber-100 text-amber-800" : p.current ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate")}>
            {gap ? (p.current ? "No partner now" : "No partner") : p.current ? "Current partner" : "Past partner"}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate">
          {`${when(p.from)} → ${p.to ? when(p.to) : "now"} · ${p.days} day${p.days === 1 ? "" : "s"}`}
          {p.approximate && <span className="italic">{" (time from older records, approximate)"}</span>}
        </p>
        {!gap && <p className="text-xs text-slate">{[p.partner!.email, p.partner!.phone].filter(Boolean).join(" · ")}</p>}
        {(p.startedBy || p.endedBy) && (
          <p className="text-xs text-slate">{[p.startedBy && `Added by ${p.startedBy}`, p.endedBy && `Ended by ${p.endedBy}`].filter(Boolean).join(" · ")}</p>
        )}
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Fig label="Orders" value={String(p.orders)} />
          <Fig label={gap ? "Sales (no commission)" : "Sales excl. GST"} value={inrPrecise(p.sales)} />
          {!gap && <Fig label="Commission earned" value={inrPrecise(p.earned)} tone="good" />}
          {!gap && <Fig label="Pending" value={inrPrecise(p.pending)} />}
          {!gap && p.cancelled > 0 && <Fig label="Cancelled" value={inrPrecise(p.cancelled)} />}
        </dl>
      </div>
    </li>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div className="flex gap-1">
      <dt className="text-slate">{label}</dt>
      <dd className={cn("font-semibold text-charcoal", tone === "good" && "text-emerald-700")}>{value}</dd>
    </div>
  );
}

/** Static preview: the Challakere change of 31 Oct 2026 (sample figures). */
function demoHistory(): PartnerHistoryData {
  const p = (id: string, name: string, branchId: string, status: string, createdAt: string, updatedAt: string) =>
    ({ id, name, email: `${name.split(" ")[0]!.toLowerCase()}@example.com`, phone: "98765 00000", branchId, status, createdAt, updatedAt });
  return {
    generatedAt: new Date().toISOString(),
    godowns: [{ id: "BR-CLK", name: "Grain Bazar Challakere Godown" }, { id: "BR-HBL", name: "Grain Bazar Hubli Godown" }],
    partners: [
      p("p1", "Testing Channel Partner", "BR-CLK", "suspended", "2026-10-26T12:39:00Z", "2026-10-31T15:23:00Z"),
      p("p2", "Vamshi", "BR-CLK", "active", "2026-10-31T15:24:00Z", "2026-10-31T15:24:00Z"),
      p("p3", "Test Mallikarjun", "BR-HBL", "active", "2026-10-26T12:49:00Z", "2026-10-26T12:49:00Z"),
    ],
    events: [
      { partner_id: "p1", branch_id: "BR-CLK", event: "added", at: "2026-10-26T12:39:00Z", by_name: "Indra Kumar", backfilled: true },
      { partner_id: "p1", branch_id: "BR-CLK", event: "suspended", at: "2026-10-31T15:23:00Z", by_name: "", backfilled: true },
      { partner_id: "p2", branch_id: "BR-CLK", event: "added", at: "2026-10-31T15:24:00Z", by_name: "Sandesh", backfilled: false },
      { partner_id: "p3", branch_id: "BR-HBL", event: "added", at: "2026-10-26T12:49:00Z", by_name: "Indra Kumar", backfilled: true },
    ],
    commissions: [
      { partner_id: "p1", order_id: "o1", line_total: 24000, amount: 25, status: "earned", placed_at: "2026-10-28T05:00:00Z" },
      { partner_id: "p1", order_id: "o2", line_total: 4000, amount: 200, status: "pending", placed_at: "2026-10-31T04:00:00Z" },
      { partner_id: "p2", order_id: "o3", line_total: 2700, amount: 2.5, status: "pending", placed_at: "2026-10-31T16:00:00Z" },
      { partner_id: "p3", order_id: "o4", line_total: 5400, amount: 20, status: "earned", placed_at: "2026-10-29T06:00:00Z" },
    ],
    orders: [],
  };
}
