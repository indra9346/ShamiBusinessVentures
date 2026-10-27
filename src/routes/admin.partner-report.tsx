import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Handshake, IndianRupee, Printer, Radio, RefreshCw, Target, TrendingDown, TrendingUp } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { TargetBar } from "@/components/partners/PartnerWidgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { downloadXlsx } from "@/lib/xlsx";
import { supabase } from "@/integrations/supabase/client";
import { istToday, profitOrLoss } from "@/lib/godown-report";
import { buildPartnerReport, partnerReportSheets, type PartnerLine, type PartnerReport, type PartnerTotals } from "@/lib/partner-report";
import { Button } from "@/components/ui/button";
import { ResizableTable } from "@/hooks/use-column-resize";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/partner-report")({
  head: () => ({ meta: [{ title: "Channel Partner Report | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminPartnerReport,
});

type Loaded = PartnerReport & { from: string; to: string; generatedAt: string; truncated?: boolean };

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStartOf = (date: string) => `${date.slice(0, 8)}01`;
const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const istClock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const istDateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const money = (n: number) => inrPrecise(n);
const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

/**
 * Channel partner report (admin): each godown partner's sales, the company's cost and profit on
 * them, losses, commission (earned / pending / cancelled) and target, live, for any period, with
 * Excel downloads for all partners or one.
 */
function AdminPartnerReport() {
  const today = istToday();
  const [from, setFrom] = useState(monthStartOf(today));
  const [to, setTo] = useState(today);
  const [partnerId, setPartnerId] = useState("");
  const [report, setReport] = useState<Loaded | null>(null);
  const [partnerList, setPartnerList] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const running = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (running.current) return;
    running.current = true;
    if (!quiet) setLoading(true);
    try {
      if (STATIC_DATA_MODE) {
        const empty = buildPartnerReport({ partners: [], orders: [], items: [], costs: {}, commissionRows: [], targets: [], from, to });
        setReport({ ...empty, from, to, generatedAt: new Date().toISOString() });
      } else {
        const { partnerReport } = await import("@/lib/partner-report.functions");
        const next = await partnerReport({ data: { from, to, ...(partnerId ? { partnerId } : {}) } });
        setReport(next);
        if (!partnerId) setPartnerList(next.partners.map((row) => ({ id: row.partner.id, name: `${row.partner.name} · ${row.partner.godown}` })));
      }
      setError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not build the report";
      setError(message);
      if (!quiet) toast.error("Could not build the partner report", { description: message });
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [from, to, partnerId]);
  useEffect(() => { void load(); }, [load]);

  // Live: orders, items and payments changing anywhere (website, admin, Zoho) rebuild the report;
  // also every 30 seconds and when the tab is opened again.
  useEffect(() => {
    if (!live || STATIC_DATA_MODE) return;
    let timer: number | null = null;
    const soon = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(true), 2_000);
    };
    const channel = supabase.channel(`partner-report-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, soon)
      .subscribe();
    const poll = window.setInterval(() => void load(true), 30_000);
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      void supabase.removeChannel(channel);
    };
  }, [live, load]);

  const period = from === to ? istDateLabel(from) : `${istDateLabel(from)} – ${istDateLabel(to)}`;
  const all = report?.all;
  const download = (onePartner?: string) => {
    if (!report) return;
    const name = onePartner ? report.partners.find((row) => row.partner.id === onePartner)?.partner.name ?? "partner" : "";
    downloadXlsx(`partner-report-${onePartner ? `${fileSafe(name)}-` : ""}${from}${from === to ? "" : `-to-${to}`}.xlsx`,
      partnerReportSheets(report, { period, generatedAt: report.generatedAt }, { audience: "admin", ...(onePartner ? { partnerId: onePartner } : {}) }));
    toast.success(onePartner ? `${name}'s report downloaded` : "Partner report downloaded", { description: `${period} · as of ${istClock(report.generatedAt)} IST` });
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Channel Partner Report" subtitle="Sales, profit, losses, commission and target of every godown channel partner, live">
      <div className="mb-4 flex flex-wrap items-end gap-2 print:hidden">
        <label className="grid gap-1 text-xs font-semibold text-slate">From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">To
          <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">Partner
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal">
            <option value="">All partners</option>
            {partnerList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: "Today", from: today, to: today },
            { label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
            { label: "Last 7 days", from: addDays(today, -6), to: today },
            { label: "This month", from: monthStartOf(today), to: today },
          ].map((preset) => (
            <Button key={preset.label} size="sm" variant={from === preset.from && to === preset.to ? "default" : "outline"}
              className={from === preset.from && to === preset.to ? "bg-navy text-white" : ""}
              onClick={() => { setFrom(preset.from); setTo(preset.to); }}>{preset.label}</Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={!report?.partners.length} onClick={() => download(partnerId || undefined)}>
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />{partnerId ? "Download Excel (this partner)" : "Download Excel (all partners)"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="mr-1.5 h-3.5 w-3.5" />Print / PDF</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-ivory/60 px-4 py-3 text-sm">
        <div className="min-w-0">
          <p className="font-bold text-navy">Channel Partner Report · {period}</p>
          <p className="text-xs text-slate">
            {report ? `As of ${istClock(report.generatedAt)} IST` : "Loading…"} · a partner answers for their godown's sales from the day their login was made · amounts in ₹, sales before GST ·
            cost = Zoho item purchase rate · target counts sales with a commission rate (as the leaderboard) · <Link to="/admin/partners" className="font-semibold text-navy underline">rates, targets and logins</Link>
          </p>
          {report?.truncated && <p className="mt-1 text-xs font-semibold text-danger">More than 5,000 orders: choose a shorter period for a complete report.</p>}
          {error && <p className="mt-1 text-xs font-semibold text-danger">Last update failed: {error}. Showing the previous figures.</p>}
        </div>
        <button type="button" onClick={() => setLive((on) => !on)} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold print:hidden",
          live ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-border bg-white text-slate")}
          title={live ? "Updates as orders change, every 30 s and on return to this tab. Click to pause." : "Paused. Click to update live again."}>
          <Radio className={cn("h-3.5 w-3.5", live && "animate-pulse")} />{live ? "Live" : "Paused"}
        </button>
      </div>

      {all && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Partner sales (excl. GST)" value={money(all.sales)} icon={Handshake} highlight description={`${all.orders} orders · ${all.unitsSold} units · ${report!.partners.length} partners`} />
          <StatCard label="Commission" value={money(all.commissionEarned + all.commissionPending)} icon={IndianRupee}
            description={`Earned ${money(all.commissionEarned)} · pending ${money(all.commissionPending)}`} />
          <StatCard label={all.netProfit < 0 ? "Net loss after commission" : "Net profit after commission"} value={money(Math.abs(all.netProfit))}
            icon={all.netProfit < 0 ? TrendingDown : TrendingUp} description={all.salesWithoutCost ? `${money(all.salesWithoutCost)} of sales have no purchase rate` : `Gross ${money(all.grossProfit)}`} />
          <StatCard label="Target reached" value={all.achievedPercent === null ? "No target" : `${all.achievedPercent}%`} icon={Target}
            description={`${money(all.eligibleSales)} of ${money(all.target)}`} />
        </div>
      )}

      <Panel title={`Partners · ${period}`}>
        {!report ? <p className="text-sm text-slate">Loading…</p>
          : !report.partners.length ? <p className="text-sm text-slate">No channel partners yet. Create their logins on <Link to="/admin/partners" className="font-semibold text-navy underline">Channel Partners</Link>.</p>
          : <PartnerTable rows={report.partners} all={report.all} onDownload={download} />}
      </Panel>

      <Panel title={`Partner sales as they happened · ${report?.lines.length ?? 0} lines`} className="mt-6">
        {!report ? <p className="text-sm text-slate">Loading…</p> : <PartnerLines lines={report.lines} names={new Map(report.partners.map((row) => [row.partner.id, row.partner.name]))} />}
      </Panel>
    </PanelLayout>
  );
}

function Amount({ value, signed }: { value: number; signed?: boolean }) {
  return <span className={cn("tabular-nums", signed && value < 0 && "font-semibold text-danger", signed && value > 0 && "text-emerald-700")}>{money(value)}</span>;
}

function PartnerTable({ rows, all, onDownload }: { rows: PartnerTotals[]; all: PartnerReport["all"]; onDownload: (partnerId?: string) => void }) {
  const cols: [string, (row: PartnerTotals | PartnerReport["all"]) => ReactNode][] = [
    ["Orders", (r) => <>{r.orders}{r.cancelledOrders ? <span className="block text-[10px] text-slate">+{r.cancelledOrders} cancelled</span> : null}</>],
    ["Sales", (r) => <Amount value={r.sales} />],
    ["Target", (r) => <div className="min-w-[120px]"><span className="tabular-nums">{r.target ? money(r.target) : "—"}</span>
      {r.achievedPercent !== null && <><div className="mt-1"><TargetBar percent={r.achievedPercent} /></div><span className="text-[10px] text-slate">{r.achievedPercent}% · {money(r.eligibleSales)}</span></>}</div>],
    ["Commission earned", (r) => <Amount value={r.commissionEarned} />],
    ["Commission pending", (r) => <Amount value={r.commissionPending} />],
    ["Commission cancelled", (r) => <Amount value={r.commissionCancelled} />],
    ["Cost of goods", (r) => <>{<Amount value={r.cost} />}{r.salesWithoutCost ? <span className="block text-[10px] text-amber-700">{money(r.salesWithoutCost)} without rate</span> : null}</>],
    ["Gross profit", (r) => <Amount value={r.grossProfit} signed />],
    ["Net profit / loss", (r) => <><Amount value={r.netProfit} signed /><span className="block text-[10px] text-slate">{profitOrLoss(r.netProfit)} after commission</span></>],
    ["Loss below cost", (r) => <Amount value={r.lossBelowCost} />],
    ["Cancelled", (r) => <Amount value={r.cancelledValue} />],
    ["Refunded", (r) => <Amount value={r.refunded} />],
    ["Collected", (r) => <Amount value={r.collected} />],
    ["Due", (r) => <Amount value={r.due} />],
  ];
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="partner-report-summary" className="w-full min-w-[1300px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            <th className="px-2 py-2">#</th>
            <th className="px-2 py-2">Partner</th>
            {cols.map(([label]) => <th key={label} className="px-2 py-2 text-right">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.partner.id} className="border-b border-border/60 align-top">
              <td className="px-2 py-2 font-bold text-navy">{row.rank}</td>
              <td className="px-2 py-2">
                <p className="font-semibold text-navy">{row.partner.name}{row.partner.status !== "active" ? <span className="ml-1 text-[10px] text-slate">(suspended)</span> : null}</p>
                <p className="text-[11px] text-slate">{row.partner.godown}</p>
                <button type="button" onClick={() => onDownload(row.partner.id)} className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-gold hover:underline print:hidden">
                  <Download className="h-3 w-3" />Download Excel
                </button>
              </td>
              {cols.map(([label, cell]) => <td key={label} className="whitespace-nowrap px-2 py-2 text-right">{cell(row)}</td>)}
            </tr>
          ))}
          <tr className="bg-ivory/70 font-bold align-top">
            <td className="px-2 py-2" />
            <td className="px-2 py-2 text-navy">Total
              <button type="button" onClick={() => onDownload()} className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-gold hover:underline print:hidden">
                <Download className="h-3 w-3" />All partners
              </button>
            </td>
            {cols.map(([label, cell]) => <td key={label} className="whitespace-nowrap px-2 py-2 text-right">{cell(all)}</td>)}
          </tr>
        </tbody>
      </ResizableTable>
    </div>
  );
}

function PartnerLines({ lines, names }: { lines: PartnerLine[]; names: Map<string, string> }) {
  if (!lines.length) return <p className="py-6 text-center text-sm text-slate">No partner sales in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="partner-report-lines" className="w-full min-w-[1200px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            {["Time (IST)", "Partner", "Godown", "Order", "Customer", "Product", "Qty", "Sale", "Cost", "Profit / loss", "Commission", "Commission status", "Order"].map((h, i) => (
              <th key={`${h}${i}`} className={cn("px-2 py-2", ["Qty", "Sale", "Cost", "Profit / loss", "Commission"].includes(h) && "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.itemId} className={cn("border-b border-border/60", line.orderStatus === "Cancelled" && "text-slate line-through decoration-slate/40")}>
              <td className="whitespace-nowrap px-2 py-1.5">{istTime(line.time)}</td>
              <td className="px-2 py-1.5 text-navy">{names.get(line.partnerId) ?? "—"}</td>
              <td className="px-2 py-1.5">{line.godown}</td>
              <td className="px-2 py-1.5 font-mono text-xs text-navy">{line.orderNo}</td>
              <td className="px-2 py-1.5">{line.customer || "—"}</td>
              <td className="px-2 py-1.5">{line.product}</td>
              <td className="px-2 py-1.5 text-right">{line.qty}</td>
              <td className="px-2 py-1.5 text-right"><Amount value={line.lineTotal} /></td>
              <td className="px-2 py-1.5 text-right">{line.cost === null ? <span className="text-xs text-amber-700">no rate</span> : <Amount value={line.cost} />}</td>
              <td className="px-2 py-1.5 text-right">{line.margin === null ? "—" : <Amount value={line.margin} signed />}</td>
              <td className="px-2 py-1.5 text-right">{line.commission ? <Amount value={line.commission} /> : "—"}<span className="block text-[10px] text-slate">{line.rate}</span></td>
              <td className="px-2 py-1.5 text-xs capitalize">{line.commissionStatus}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-xs">{line.orderStatus} · {line.paymentStatus}</td>
            </tr>
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}
