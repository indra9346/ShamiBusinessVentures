import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { downloadXlsx } from "@/lib/xlsx";
import { istToday } from "@/lib/godown-report";
import { partnerReportSheets, type PartnerReport } from "@/lib/partner-report";
import { cn } from "@/lib/utils";

type Loaded = PartnerReport & { from: string; to: string; generatedAt: string };

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStartOf = (date: string) => `${date.slice(0, 8)}01`;
const istDateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const istClock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The partner's own sales report for any period: their godown's sales, money collected and due,
 * commission by status and target, live (every 30 seconds and on returning to the tab), and as an
 * Excel download. No company cost or profit is ever sent to the partner.
 */
export function MyPartnerReport({ partnerName }: { partnerName: string }) {
  const today = istToday();
  const [from, setFrom] = useState(monthStartOf(today));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const running = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (running.current) return;
    running.current = true;
    if (!quiet) setLoading(true);
    try {
      const { myPartnerReport } = await import("@/lib/partner-report.functions");
      setReport(await myPartnerReport({ data: { from, to } }));
    } catch (cause) {
      if (!quiet) toast.error("Could not load your report", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [from, to]);
  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(true), 30_000);
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(poll); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const me = report?.partners[0];
  const period = from === to ? istDateLabel(from) : `${istDateLabel(from)} – ${istDateLabel(to)}`;
  const download = () => {
    if (!report) return;
    downloadXlsx(`my-sales-report-${from}${from === to ? "" : `-to-${to}`}.xlsx`,
      partnerReportSheets(report, { period, generatedAt: report.generatedAt }, { audience: "partner" }));
    toast.success("Report downloaded", { description: `${period} · as of ${istClock(report.generatedAt)} IST` });
  };
  const figures: [string, string][] = me ? [
    ["Orders", `${me.orders}${me.cancelledOrders ? ` (+${me.cancelledOrders} cancelled)` : ""}`],
    ["Godown sales (excl. GST)", inrPrecise(me.sales)],
    ["Sales with a commission rate", inrPrecise(me.eligibleSales)],
    ["Target", me.target ? `${inrPrecise(me.target)} · ${me.achievedPercent}% reached` : "Not set"],
    ["Commission earned", inrPrecise(me.commissionEarned)],
    ["Commission pending", inrPrecise(me.commissionPending)],
    ["Commission cancelled", inrPrecise(me.commissionCancelled)],
    ["Collected from customers", inrPrecise(me.collected)],
    ["Due from customers", inrPrecise(me.due)],
    ["Cancelled sales", inrPrecise(me.cancelledValue)],
  ] : [];

  return (
    <Panel title={`My sales report · ${partnerName}`}>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs font-semibold text-slate">From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">To
          <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        {[
          { label: "Today", from: today, to: today },
          { label: "Last 7 days", from: addDays(today, -6), to: today },
          { label: "This month", from: monthStartOf(today), to: today },
        ].map((preset) => (
          <button key={preset.label} type="button" onClick={() => { setFrom(preset.from); setTo(preset.to); }}
            className={cn("h-9 rounded-md border px-3 text-sm", from === preset.from && to === preset.to ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-gold")}>
            {preset.label}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-sm text-navy hover:border-gold">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />Refresh
          </button>
          <button type="button" onClick={download} disabled={!me} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-navy px-3 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">
            <FileSpreadsheet className="h-3.5 w-3.5" />Download Excel
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate">{report ? `${period} · as of ${istClock(report.generatedAt)} IST · updates live` : "Loading…"}</p>
      {me ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {figures.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 border-b border-border/60 pb-1.5">
              <dt className="text-slate">{label}</dt><dd className="font-semibold text-navy tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : report ? <p className="text-sm text-slate">No sales in this period.</p> : null}
    </Panel>
  );
}
