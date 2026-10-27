import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Download, FileSpreadsheet, IndianRupee, Printer, Radio, RefreshCw, ShoppingCart, TrendingDown, TrendingUp } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { useBranches } from "@/lib/branches";
import { inrPrecise, getOrderItemTotal } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { downloadCSV } from "@/lib/export-utils";
import { downloadXlsx } from "@/lib/xlsx";
import { supabase } from "@/integrations/supabase/client";
import {
  SUMMARY_COLUMNS, buildGodownReport, godownReportSheets, istHour, istStamp, istToday, profitOrLoss, type GodownTotals, type SaleLine,
} from "@/lib/godown-report";
import { Button } from "@/components/ui/button";
import { ResizableTable } from "@/hooks/use-column-resize";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/godown-report")({
  head: () => ({ meta: [{ title: "Godown Report | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: GodownReport,
});

type Report = ReturnType<typeof buildGodownReport> & { from: string; to: string; generatedAt: string; truncated?: boolean };

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monthStartOf = (date: string) => `${date.slice(0, 8)}01`;
const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const istClock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const istDateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const money = (n: number) => inrPrecise(n);
const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
/** Reloads at most this often while orders keep changing. */
const LIVE_DEBOUNCE_MS = 2_000;
const LIVE_POLL_MS = 30_000;

/**
 * Godown report (admin): sales, cost, profit and loss of every godown for a day or any period,
 * with each sale at the time it happened. Live: it rebuilds itself as orders, items and payments
 * change (website, admin or Zoho), every 30 seconds and when the window regains focus.
 * Downloads: an Excel workbook (Summary, one sheet per godown, All sales), one godown's own
 * workbook, CSV, or print / save as PDF.
 */
function GodownReport() {
  const today = istToday();
  const { branches } = useBranches();
  const godowns = branches.filter((branch) => !branch.vendorId);
  const { orders: demoOrders } = useApp();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [report, setReport] = useState<Report | null>(null);
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
        // Static preview: the same report from the demo orders in the browser.
        const inRange = demoOrders.filter((order) => {
          const day = istToday(new Date(order.createdAt ?? order.date));
          return day >= from && day <= to && (!branchId || (order.branchId ?? "none") === branchId);
        });
        const built = buildGodownReport({
          godowns: godowns.filter((g) => !branchId || g.id === branchId).map((g) => ({ id: g.id, name: g.name, code: g.code })),
          orders: inRange.map((order) => ({
            id: order.id, order_no: order.id, branch_id: order.branchId ?? null, created_at: order.createdAt ?? new Date(order.date).toISOString(),
            order_status: order.status, payment_status: order.payment, customer_name: order.customer, subtotal: order.subtotal,
            discount: order.discount, gst_amount: order.tax, shipping: order.shipping, total: order.amount,
            paid_amount: order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0), zoho_salesorder_id: order.zohoSalesOrderId ?? null,
          })),
          items: inRange.flatMap((order) => order.items.map((item, index) => ({
            id: `${order.id}-${index}`, order_id: order.id, product_id: item.product.id, product_name: item.product.name,
            qty: item.qty, unit_price: item.unitPrice ?? item.product.price, line_total: getOrderItemTotal(item),
          }))),
          costs: Object.fromEntries(inRange.flatMap((order) => order.items.map((item) => [item.product.id, item.product.purchasePrice ?? null]))),
          commissions: {},
          branchNames: Object.fromEntries(branches.map((b) => [b.id, b.name])),
        });
        setReport({ ...built, from, to, generatedAt: new Date().toISOString() });
      } else {
        const { godownReport } = await import("@/lib/godown-report.functions");
        setReport(await godownReport({ data: { from, to, ...(branchId ? { branchId } : {}) } }));
      }
      setError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not build the report";
      setError(message);
      if (!quiet) toast.error("Could not build the report", { description: message });
    } finally {
      running.current = false;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, branchId, demoOrders.length, godowns.length]);
  useEffect(() => { void load(); }, [load]);

  // Live: any change to orders, their items or payments rebuilds the report (debounced), and it
  // is re-read every 30 seconds and whenever the admin comes back to the tab.
  useEffect(() => {
    if (!live || STATIC_DATA_MODE) return;
    let timer: number | null = null;
    const soon = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(true), LIVE_DEBOUNCE_MS);
    };
    const channel = supabase.channel(`godown-report-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, soon)
      .subscribe();
    const poll = window.setInterval(() => void load(true), LIVE_POLL_MS);
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
  const godownLabel = branchId ? godowns.find((g) => g.id === branchId)?.name ?? "No godown (direct)" : "All godowns";
  const all = report?.all;
  const busiestHours = useMemo(() => (all ? all.hourly.map((sales, hour) => ({ hour, sales })).filter((h) => h.sales > 0) : []), [all]);
  const fileStem = `${from}${from === to ? "" : `-to-${to}`}`;

  /** Excel workbook: Summary, one sheet per godown and All sales; or one godown's own workbook. */
  const downloadExcel = (godownId?: string) => {
    if (!report) return;
    const godownName = godownId ? report.godowns.find((row) => row.godownId === godownId)?.godown ?? godownId : "";
    downloadXlsx(`godown-report-${godownId ? `${fileSafe(godownName)}-` : ""}${fileStem}.xlsx`,
      godownReportSheets(report, { period, generatedAt: report.generatedAt }, godownId));
    toast.success(godownId ? `${godownName} report downloaded` : "Godown report downloaded", { description: `${period} · as of ${istClock(report.generatedAt)} IST` });
  };
  const exportSummaryCsv = () => {
    if (!report) return;
    downloadCSV(`godown-report-summary-${fileStem}.csv`, ["Godown", ...SUMMARY_COLUMNS.map(([label]) => label)],
      [...report.godowns, report.all].map((row) => [row.godown, ...SUMMARY_COLUMNS.map(([, value]) => value(row))]));
  };
  const exportSalesCsv = () => {
    if (!report) return;
    downloadCSV(`godown-report-sales-${fileStem}.csv`, [
      "Date & time (IST)", "Godown", "Order", "Customer", "Product", "Qty", "Rate (₹)", "Sale excl. GST (₹)", "Purchase rate (₹)", "Cost (₹)",
      "Profit / loss (₹)", "Partner commission (₹)", "Order status", "Payment", "In Zoho", "Zoho invoice",
    ], report.lines.map((line) => [
      istStamp(line.time), line.godown, line.orderNo, line.customer, line.product, line.qty, line.unitPrice, line.lineTotal,
      line.unitCost ?? "", line.cost ?? "", line.margin ?? "", line.commission, line.orderStatus, line.paymentStatus,
      line.inZoho ? "Yes" : "No", line.invoice,
    ]));
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Godown Report" subtitle="Sales, cost, profit and loss of every godown, live, for today or any period">
      <div className="mb-4 flex flex-wrap items-end gap-2 print:hidden">
        <label className="grid gap-1 text-xs font-semibold text-slate">From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">To
          <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">Godown
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal">
            <option value="">All godowns</option>
            {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="none">No godown (direct)</option>
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
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={!report} onClick={() => downloadExcel(branchId || undefined)}>
            <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />{branchId ? "Download Excel (this godown)" : "Download Excel (all godowns)"}
          </Button>
          <Button size="sm" variant="outline" disabled={!report} onClick={exportSummaryCsv}><Download className="mr-1.5 h-3.5 w-3.5" />Summary CSV</Button>
          <Button size="sm" variant="outline" disabled={!report} onClick={exportSalesCsv}><Download className="mr-1.5 h-3.5 w-3.5" />Sales CSV</Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="mr-1.5 h-3.5 w-3.5" />Print / PDF</Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-ivory/60 px-4 py-3 text-sm">
        <div className="min-w-0">
          <p className="font-bold text-navy">Godown Report · {godownLabel} · {period}</p>
          <p className="text-xs text-slate">
            {report ? `As of ${istClock(report.generatedAt)} IST` : "Loading…"} · amounts in ₹ · sales before GST · cost = purchase rate of each item (Zoho item purchase rate, current) · cancelled and refunded orders shown separately
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
          <StatCard label="Sales (excl. GST)" value={money(all.sales)} icon={ShoppingCart} description={`${all.orders} orders (${all.deliveredOrders} delivered) · ${all.unitsSold} units`} highlight />
          <StatCard label="Cost of goods" value={money(all.cost)} icon={IndianRupee} description={all.linesWithoutCost ? `${money(all.salesWithoutCost)} of sales have no purchase rate: left out of profit` : "From item purchase rates"} />
          <StatCard label={all.netProfit < 0 ? "Net loss" : "Net profit"} value={money(Math.abs(all.netProfit))} icon={all.netProfit < 0 ? TrendingDown : TrendingUp}
            description={`Gross ${money(all.grossProfit)} · commission ${money(all.commission)}`} />
          <StatCard label="Losses" value={money(all.lossBelowCost)} icon={TrendingDown}
            description={`Sold below cost · cancelled ${money(all.cancelledValue)} (${all.cancelledOrders}) · refunded ${money(all.refunded)}`} />
        </div>
      )}

      <Panel title={`Godown summary · ${period}`}>
        {!report ? <p className="text-sm text-slate">Loading…</p> : <SummaryTable rows={report.godowns} all={report.all} onDownload={downloadExcel} />}
      </Panel>

      {busiestHours.length > 0 && (
        <Panel title="Sales by hour (IST)" className="mt-6">
          <HourlyStrip godowns={report!.godowns.filter((g) => g.sales > 0)} />
        </Panel>
      )}

      <Panel title={`Sales as they happened · ${report?.lines.length ?? 0} lines`} className="mt-6">
        {!report ? <p className="text-sm text-slate">Loading…</p> : <SalesTable lines={report.lines} />}
      </Panel>
    </PanelLayout>
  );
}

function Amount({ value, signed }: { value: number; signed?: boolean }) {
  return <span className={cn("tabular-nums", signed && value < 0 && "font-semibold text-danger", signed && value > 0 && "text-emerald-700")}>{money(value)}</span>;
}

function SummaryTable({ rows, all, onDownload }: { rows: GodownTotals[]; all: GodownTotals; onDownload: (godownId?: string) => void }) {
  const cols: [string, (row: GodownTotals) => ReactNode][] = [
    ["Orders", (r) => <>{r.orders}{r.cancelledOrders ? <span className="block text-[10px] text-slate">+{r.cancelledOrders} cancelled</span> : null}{r.deliveredOrders ? <span className="block text-[10px] text-emerald-700">{r.deliveredOrders} delivered</span> : null}</>],
    ["Units", (r) => r.unitsSold],
    ["Sales", (r) => <Amount value={r.sales} />],
    ["Discount", (r) => <Amount value={r.discount} />],
    ["Net sales", (r) => <Amount value={r.netSales} />],
    ["Cost of goods", (r) => <>{<Amount value={r.cost} />}{r.linesWithoutCost ? <span className="block text-[10px] text-amber-700" title="Set the purchase rate on these products (Zoho item purchase rate) to count them in profit">{money(r.salesWithoutCost)} sales without rate</span> : null}</>],
    ["Gross profit", (r) => <Amount value={r.grossProfit} signed />],
    ["Delivery", (r) => <Amount value={r.delivery} />],
    ["Partner commission", (r) => <Amount value={r.commission} />],
    ["Net profit / loss", (r) => <><Amount value={r.netProfit} signed /><span className="block text-[10px] text-slate">{profitOrLoss(r.netProfit)}</span></>],
    ["Loss below cost", (r) => <Amount value={r.lossBelowCost} />],
    ["Cancelled", (r) => <Amount value={r.cancelledValue} />],
    ["Refunded", (r) => <>{<Amount value={r.refunded} />}{r.refundedOrders ? <span className="block text-[10px] text-slate">{r.refundedOrders} order(s)</span> : null}</>],
    ["GST", (r) => <Amount value={r.gst} />],
    ["Billed", (r) => <Amount value={r.billed} />],
    ["Collected", (r) => <Amount value={r.collected} />],
    ["Due", (r) => <Amount value={r.due} />],
  ];
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="godown-report-summary" className="w-full min-w-[1200px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            <th className="sticky left-0 bg-card px-2 py-2">Godown</th>
            {cols.map(([label]) => <th key={label} className="px-2 py-2 text-right">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.godownId} className="border-b border-border/60">
              <td className="sticky left-0 bg-card px-2 py-2 font-semibold text-navy">
                {row.godown}
                <button type="button" onClick={() => onDownload(row.godownId)} title={`Download ${row.godown} report (Excel)`}
                  className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-gold hover:underline print:hidden">
                  <Download className="h-3 w-3" />Download Excel
                </button>
              </td>
              {cols.map(([label, cell]) => <td key={label} className="whitespace-nowrap px-2 py-2 text-right">{cell(row)}</td>)}
            </tr>
          ))}
          <tr className="bg-ivory/70 font-bold">
            <td className="sticky left-0 bg-ivory px-2 py-2 text-navy">
              Total
              <button type="button" onClick={() => onDownload()} title="Download all godowns (Excel: one sheet per godown)"
                className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-gold hover:underline print:hidden">
                <Download className="h-3 w-3" />All godowns
              </button>
            </td>
            {cols.map(([label, cell]) => <td key={label} className="whitespace-nowrap px-2 py-2 text-right">{cell(all)}</td>)}
          </tr>
        </tbody>
      </ResizableTable>
    </div>
  );
}

function HourlyStrip({ godowns }: { godowns: GodownTotals[] }) {
  const hours = Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => godowns.some((g) => g.hourly[hour]! > 0));
  const label = (hour: number) => `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`;
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="godown-report-hourly" className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            <th className="px-2 py-2">Time (IST)</th>
            {godowns.map((g) => <th key={g.godownId} className="px-2 py-2 text-right">{g.godown}</th>)}
          </tr>
        </thead>
        <tbody>
          {hours.map((hour) => (
            <tr key={hour} className="border-b border-border/60">
              <td className="whitespace-nowrap px-2 py-1.5 text-slate">{label(hour)}</td>
              {godowns.map((g) => <td key={g.godownId} className="px-2 py-1.5 text-right tabular-nums">{g.hourly[hour] ? money(g.hourly[hour]!) : "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

function SalesTable({ lines }: { lines: SaleLine[] }) {
  if (!lines.length) return <p className="py-6 text-center text-sm text-slate">No sales in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="godown-report-sales" className="w-full min-w-[1100px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            {["Time (IST)", "Godown", "Order", "Customer", "Product", "Qty", "Sale", "Cost", "Profit / loss", "Commission", "Status", "Zoho"].map((h) => (
              <th key={h} className={cn("px-2 py-2", ["Qty", "Sale", "Cost", "Profit / loss", "Commission"].includes(h) && "text-right")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const cancelled = line.orderStatus === "Cancelled";
            return (
              <tr key={`${line.orderNo}-${index}`} className={cn("border-b border-border/60", cancelled && "text-slate line-through decoration-slate/40")}>
                <td className="whitespace-nowrap px-2 py-1.5" title={`Hour ${istHour(line.time)}`}>{istTime(line.time)}</td>
                <td className="px-2 py-1.5">{line.godown}</td>
                <td className="px-2 py-1.5 font-mono text-xs text-navy">{line.orderNo}</td>
                <td className="px-2 py-1.5">{line.customer || "—"}</td>
                <td className="px-2 py-1.5">{line.product}</td>
                <td className="px-2 py-1.5 text-right">{line.qty}</td>
                <td className="px-2 py-1.5 text-right"><Amount value={line.lineTotal} /></td>
                <td className="px-2 py-1.5 text-right">{line.cost === null ? <span className="text-xs text-amber-700">no rate</span> : <Amount value={line.cost} />}</td>
                <td className="px-2 py-1.5 text-right">{line.margin === null ? "—" : <Amount value={line.margin} signed />}</td>
                <td className="px-2 py-1.5 text-right">{line.commission ? <Amount value={line.commission} /> : "—"}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs">{line.orderStatus} · {line.paymentStatus}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-xs">{line.inZoho ? (line.invoice || "Sales order") : <span className="text-amber-700">Not yet</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </ResizableTable>
    </div>
  );
}
