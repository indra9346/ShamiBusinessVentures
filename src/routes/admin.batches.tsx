import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowLeft, ChevronRight, Clock3, FileSpreadsheet, IndianRupee, Layers, Mail, MapPin, PackageCheck, PackagePlus, Pencil,
  Phone, RefreshCw, Search, ShoppingCart, TrendingDown, TrendingUp, UserRound, Warehouse,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { downloadXlsx } from "@/lib/xlsx";
import { supabase } from "@/integrations/supabase/client";
import {
  adjustmentReasonLabel, batchAdjustmentSheet, batchReportSheets, buildBatchReport, formatBatchCode, godownCodeOf, isBatchCode, istDate,
  normalizeBatchCode, searchBatchReport, sumTotals, type BatchAdjustment, type BatchReport, type BatchReportRow, type BatchSale,
} from "@/lib/batches";
import type { BatchData } from "@/lib/batches.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Search = { godown?: string | undefined; batch?: string | undefined; order?: string | undefined; customer?: string | undefined; tab?: "batches" | "trace" | undefined; q?: string | undefined };

export const Route = createFileRoute("/admin/batches")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search["godown"] === "string" && search["godown"] ? { godown: search["godown"] } : {}),
    ...(typeof search["batch"] === "string" && search["batch"] ? { batch: search["batch"] } : {}),
    ...(typeof search["order"] === "string" && search["order"] ? { order: search["order"] } : {}),
    ...(typeof search["customer"] === "string" && search["customer"] ? { customer: search["customer"] } : {}),
    ...(search["tab"] === "trace" ? { tab: "trace" as const } : {}),
    ...(typeof search["q"] === "string" && search["q"] ? { q: search["q"] } : {}),
  }),
  head: () => ({ meta: [{ title: "Batches | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminBatches,
});

const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const todayIst = () => istDate(new Date().toISOString());

/**
 * Admin > Batches: every purchase batch (stock number) per godown — purchased, sold, delivered,
 * lost, available, sales, profit and days to sell out — with step-by-step drill-down
 * (godown > batch > order > customer) and back-tracking (customer or order > batches).
 * "Receive purchase" records a new batch (and sends it to Zoho); Excel downloads the lot.
 */
function AdminBatches() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const go = useCallback((next: Partial<Search>, replace = false) => {
    void navigate({ search: (prev: Search) => {
      const merged: Search = { ...prev, ...next };
      for (const key of Object.keys(merged) as (keyof Search)[]) if (!merged[key]) delete merged[key];
      return merged;
    }, replace });
  }, [navigate]);
  const [data, setData] = useState<BatchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [editRow, setEditRow] = useState<BatchReportRow | null>(null);
  const [status, setStatus] = useState<"all" | "stock" | "soldout">("all");
  const [productFilter, setProductFilter] = useState("");

  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setData(demoData()); return; }
    setLoading(true);
    try {
      const { getBatchData } = await import("@/lib/batches.functions");
      setData(await getBatchData());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load batches");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let timer: number | null = null;
    const soon = () => { if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 2000); };
    const channel = supabase.channel(`batches-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "batches" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
      .subscribe();
    return () => { if (timer) window.clearTimeout(timer); void supabase.removeChannel(channel); };
  }, [load]);

  const report = useMemo(() => data ? buildBatchReport({ ...data, today: todayIst() }) : null, [data]);
  const godownName = (id?: string) => data?.godowns.find((g) => g.id === id)?.name ?? "";
  const selected = report?.rows.find((row) => row.batch.id === search.batch) ?? null;

  const downloadExcel = () => {
    if (!report || !data) return;
    const scope = search.godown ? report.rows.filter((r) => r.batch.branch_id === search.godown) : report.rows;
    const ids = new Set(scope.map((r) => r.batch.id));
    const scoped: BatchReport = {
      ...report, rows: scope, all: sumTotals(scope), sales: report.sales.filter((s) => ids.has(s.batchId)),
      godowns: report.godowns.filter((g) => !search.godown || g.godownId === search.godown),
    };
    const codes = new Map(report.rows.map((r) => [r.batch.id, { code: r.batch.batch_code, product: r.batch.product_name, godown: r.godown }]));
    const label = search.godown ? godownName(search.godown) : "All godowns";
    downloadXlsx(`batch-report-${label.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${todayIst()}.xlsx`, [
      ...batchReportSheets(scoped, { generatedAt: data.generatedAt, scope: label }),
      batchAdjustmentSheet(data.adjustments.filter((a) => ids.has(a.batch_id)), codes),
    ]);
    toast.success("Batch report downloaded", { description: `${label} · ${scope.length} batches` });
  };

  const steps: { label: string; onClick?: () => void }[] = [{ label: "All batches", onClick: () => go({ godown: undefined, batch: undefined, order: undefined, customer: undefined, tab: undefined }) }];
  if (search.tab === "trace") steps.push({ label: "Trace customer / order", onClick: () => go({ batch: undefined, order: undefined, customer: undefined }) });
  if (search.godown && search.tab !== "trace") steps.push({ label: godownName(search.godown), onClick: () => go({ batch: undefined, order: undefined, customer: undefined }) });
  if (search.customer && search.tab === "trace") {
    const c = report?.customers.find((x) => x.key === search.customer);
    steps.push({ label: c?.name || "Customer", onClick: () => go({ batch: undefined, order: undefined }) });
  }
  if (selected) steps.push({ label: selected.batch.batch_code, onClick: () => go({ order: undefined }) });
  if (search.order) steps.push({ label: report?.sales.find((s) => s.orderId === search.order)?.orderNo ?? "Order" });

  return (
    <PanelLayout items={adminNav} tone="admin" title="Batches" subtitle="Stock numbers per purchase: sales, profit and customers of every batch, per godown">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-white p-0.5 text-sm">
          {([["batches", "Batches"], ["trace", "Trace customer / order"]] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => go({ tab: key === "trace" ? "trace" : undefined, batch: undefined, order: undefined, customer: undefined })}
              className={cn("rounded-md px-3 py-1.5 font-semibold transition", (search.tab ?? "batches") === key ? "bg-navy text-white" : "text-slate hover:text-navy")}>{label}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
          <Button size="sm" variant="outline" disabled={!report} onClick={downloadExcel}><FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />Download Excel</Button>
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={!data} onClick={() => setReceiveOpen(true)}><PackagePlus className="mr-1.5 h-3.5 w-3.5" />Receive purchase</Button>
        </div>
      </div>

      <nav aria-label="Steps" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
        {steps.map((step, i) => (
          <span key={`${step.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate" />}
            {step.onClick && i < steps.length - 1
              ? <button type="button" onClick={step.onClick} className="rounded px-1.5 py-0.5 font-medium text-navy hover:bg-ivory hover:underline">{step.label}</button>
              : <span className="rounded bg-ivory px-1.5 py-0.5 font-semibold text-charcoal">{step.label}</span>}
          </span>
        ))}
      </nav>

      {error && <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!report && !error && <p className="py-10 text-center text-sm text-slate">Loading batches…</p>}

      {report && data && (
        search.tab === "trace"
          ? <TraceView report={report} search={search} go={go} />
          : selected
            ? <BatchDetail row={selected} report={report} adjustments={data.adjustments} orderId={search.order} go={go} onEdit={() => setEditRow(selected)} />
            : <BatchList report={report} data={data} search={search} go={go} status={status} setStatus={setStatus}
                productFilter={productFilter} setProductFilter={setProductFilter} />
      )}

      {data && <ReceiveDialog open={receiveOpen} onOpenChange={setReceiveOpen} data={data} defaultGodown={search.godown}
        onSaved={async (batchId) => { await load(); go({ tab: undefined, batch: batchId, order: undefined, customer: undefined }); }} />}
      {editRow && <EditDialog row={editRow} onClose={() => setEditRow(null)} onSaved={async () => { setEditRow(null); await load(); }} />}
    </PanelLayout>
  );
}

// ------------------------------------------------------------------ step 1 + 2: godowns and batches

function BatchList({ report, data, search, go, status, setStatus, productFilter, setProductFilter }: {
  report: BatchReport; data: BatchData; search: Search; go: (next: Partial<Search>, replace?: boolean) => void;
  status: "all" | "stock" | "soldout"; setStatus: (s: "all" | "stock" | "soldout") => void;
  productFilter: string; setProductFilter: (p: string) => void;
}) {
  const [query, setQuery] = useState(search.q ?? "");
  const found = searchBatchReport(report, query);
  const rows = found.rows.filter((row) => (!search.godown || row.batch.branch_id === search.godown)
    && (!productFilter || row.batch.product_id === productFilter)
    && (status === "all" || (status === "stock" ? row.available > 0 : row.available <= 0)));
  const scope = search.godown ? report.godowns.find((g) => g.godownId === search.godown) : null;
  const totals = scope ?? { ...report.all, batches: report.rows.length, active: report.rows.filter((r) => r.available > 0).length, averageDaysToSellOut: average(report.rows) };
  const products = [...new Map(report.rows.map((r) => [r.batch.product_id, r.batch.product_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard compact label="Batches in stock" value={`${totals.active} / ${totals.batches}`} icon={Layers} description="with units left / all" />
        <StatCard compact label="Units available" value={units(totals.available)} icon={PackageCheck} description={`of ${units(totals.purchased)} purchased`} />
        <StatCard compact label="Sales (excl. GST)" value={money(totals.sales)} icon={ShoppingCart} description={`${units(totals.sold)} units sold`} />
        <StatCard compact label={totals.profit < 0 ? "Loss" : "Profit"} value={money(totals.profit)} icon={totals.profit < 0 ? TrendingDown : TrendingUp} highlight description="after cost and stock lost" />
        <StatCard compact label="Stock lost" value={money(totals.lossValue)} icon={TrendingDown} description={`${units(totals.lost)} units (counts, damage)`} />
        <StatCard compact label="Avg. days to sell out" value={totals.averageDaysToSellOut === null ? "—" : String(totals.averageDaysToSellOut)} icon={Clock3} description="sold-out batches" />
      </div>

      {!search.godown && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {report.godowns.map((g) => (
            <button key={g.godownId} type="button" onClick={() => go({ godown: g.godownId })}
              className="group rounded-lg border border-border bg-card p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-gold">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-bold text-navy"><Warehouse className="h-4 w-4" />{g.godown}</span>
                <ChevronRight className="h-4 w-4 text-slate transition group-hover:translate-x-0.5" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <Figure label="Batches" value={`${g.active} / ${g.batches}`} />
                <Figure label="Available" value={units(g.available)} />
                <Figure label="Sold" value={units(g.sold)} />
                <Figure label="Sales" value={money(g.sales)} />
                <Figure label={g.profit < 0 ? "Loss" : "Profit"} value={money(g.profit)} tone={g.profit < 0 ? "bad" : "good"} />
                <Figure label="Avg. days" value={g.averageDaysToSellOut === null ? "—" : String(g.averageDaysToSellOut)} />
              </div>
            </button>
          ))}
        </div>
      )}

      <Panel title={scope ? `${scope.godown} · batches` : "All batches"}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} onBlur={() => go({ q: query.trim() || undefined }, true)}
              placeholder="Batch no., product, supplier, order no., customer or phone" className="pl-8" />
          </label>
          <select value={search.godown ?? ""} onChange={(e) => go({ godown: e.target.value || undefined })} className="h-9 rounded-md border border-input bg-white px-2 text-sm">
            <option value="">All godowns</option>
            {data.godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select value={productFilter} onChange={(e) => setProductFilter(e.target.value)} className="h-9 max-w-[220px] rounded-md border border-input bg-white px-2 text-sm">
            <option value="">All products</option>
            {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <div className="flex rounded-md border border-input bg-white p-0.5 text-xs">
            {([["all", "All"], ["stock", "In stock"], ["soldout", "Sold out"]] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setStatus(key)} className={cn("rounded px-2.5 py-1 font-semibold", status === key ? "bg-navy text-white" : "text-slate")}>{label}</button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate">
            {report.rows.length === 0
              ? `No batches yet. Use Receive purchase when stock arrives: each purchase gets its own stock number (for example ${formatBatchCode("CLK", todayIst(), 1)}).`
              : "No batches match."}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                  <tr>
                    <th className="px-3 py-2.5">Batch no.</th><th className="px-3 py-2.5">Product</th><th className="px-3 py-2.5">Godown</th>
                    <th className="px-3 py-2.5">Purchased</th><th className="px-3 py-2.5 text-right">Bought</th><th className="px-3 py-2.5">Sold / available</th>
                    <th className="px-3 py-2.5 text-right">Lost</th><th className="px-3 py-2.5 text-right">Sales</th><th className="px-3 py-2.5 text-right">Profit</th>
                    <th className="px-3 py-2.5 text-right">Days</th><th className="px-3 py-2.5">Zoho</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.batch.id} onClick={() => go({ batch: row.batch.id })} className="cursor-pointer border-t border-border hover:bg-ivory/60">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-navy">{row.batch.batch_code}</td>
                      <td className="max-w-[240px] truncate px-3 py-2.5" title={row.batch.product_name}>{row.batch.product_name}</td>
                      <td className="max-w-[160px] truncate px-3 py-2.5 text-slate" title={row.godown}>{row.godown}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate">{day(row.batch.purchase_date)}</td>
                      <td className="px-3 py-2.5 text-right">{units(row.purchased)}</td>
                      <td className="min-w-[160px] px-3 py-2.5"><FlowBar row={row} /></td>
                      <td className={cn("px-3 py-2.5 text-right", row.lost > 0 && "text-red-700")}>{units(row.lost)}</td>
                      <td className="px-3 py-2.5 text-right">{money(row.sales)}</td>
                      <td className={cn("px-3 py-2.5 text-right font-semibold", row.profit < 0 ? "text-red-700" : "text-emerald-700")}>{money(row.profit)}</td>
                      <td className="px-3 py-2.5 text-right">{row.daysToSellOut ?? <span className="text-slate">{row.ageDays}</span>}</td>
                      <td className="px-3 py-2.5"><ZohoBadge row={row} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-2 p-3 lg:hidden">
              {rows.map((row) => (
                <button key={row.batch.id} type="button" onClick={() => go({ batch: row.batch.id })} className="rounded-lg border border-border bg-white p-3 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-navy">{row.batch.batch_code}</span>
                    <ZohoBadge row={row} />
                  </div>
                  <p className="mt-1 truncate text-sm">{row.batch.product_name}</p>
                  <p className="text-xs text-slate">{row.godown} · {day(row.batch.purchase_date)}</p>
                  <div className="mt-2"><FlowBar row={row} /></div>
                  <div className="mt-2 flex justify-between text-xs"><span>{`Sales ${money(row.sales)}`}</span><span className={row.profit < 0 ? "text-red-700" : "text-emerald-700"}>{row.profit < 0 ? `Loss ${money(row.profit)}` : `Profit ${money(row.profit)}`}</span></div>
                </button>
              ))}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

const average = (rows: BatchReportRow[]) => {
  const done = rows.filter((r) => r.daysToSellOut !== null);
  return done.length ? Math.round((done.reduce((s, r) => s + (r.daysToSellOut ?? 0), 0) / done.length) * 10) / 10 : null;
};

function Figure({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | undefined }) {
  return (
    <div className="rounded-md bg-ivory/70 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-slate">{label}</p>
      <p className={cn("truncate font-semibold text-charcoal", tone === "good" && "text-emerald-700", tone === "bad" && "text-red-700")}>{value}</p>
    </div>
  );
}

/** Where the batch's units went: sold, awaiting payment, lost, still available. */
function FlowBar({ row, large }: { row: BatchReportRow; large?: boolean }) {
  const total = Math.max(row.purchased + row.gained, row.sold + row.held + row.lost + row.available, 1);
  const part = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
  return (
    <div>
      <div className={cn("flex overflow-hidden rounded-full bg-slate-100", large ? "h-4" : "h-2")}>
        <span className="bg-emerald-500" style={{ width: part(row.sold) }} title={`Sold ${units(row.sold)}`} />
        <span className="bg-amber-400" style={{ width: part(row.held) }} title={`Awaiting payment ${units(row.held)}`} />
        <span className="bg-red-500" style={{ width: part(row.lost) }} title={`Lost ${units(row.lost)}`} />
        <span className="bg-sky-300" style={{ width: part(row.available) }} title={`Available ${units(row.available)}`} />
      </div>
      <p className="mt-1 text-xs text-slate">{`${units(row.sold)} sold · ${units(row.available)} left · ${row.sellThrough}%`}</p>
    </div>
  );
}

function ZohoBadge({ row }: { row: BatchReportRow }) {
  if (!row.batch.zoho_batch_id)
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate">{row.batch.zoho_adjustment_id ? "Zoho stock" : "Website"}</span>;
  if (row.zohoGap !== null && Math.abs(row.zohoGap) > 0.001)
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800" title="Zoho's batch balance differs from the website">{`Zoho ${row.zohoGap > 0 ? "+" : ""}${units(row.zohoGap)}`}</span>;
  return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Zoho batch ✓</span>;
}

// ------------------------------------------------------------------ step 3 + 4: batch, order, customer

function BatchDetail({ row, report, adjustments, orderId, go, onEdit }: {
  row: BatchReportRow; report: BatchReport; adjustments: BatchAdjustment[]; orderId?: string | undefined;
  go: (next: Partial<Search>) => void; onEdit: () => void;
}) {
  const sales = report.sales.filter((s) => s.batchId === row.batch.id);
  const order = orderId ? sales.find((s) => s.orderId === orderId) : undefined;
  // Step 4 opens below the batch summary: bring it into view.
  useEffect(() => {
    if (orderId) document.getElementById("batch-order-customer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [orderId]);
  const customers = [...new Map(sales.filter((s) => !s.held).map((s) => [s.customerKey, s])).values()];
  const b = row.batch;
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-gold/40 bg-gradient-to-br from-ivory to-white p-4 shadow-card">
        <div>
          <button type="button" onClick={() => go({ batch: undefined, order: undefined })} className="mb-2 flex items-center gap-1 text-xs font-semibold text-slate hover:text-navy"><ArrowLeft className="h-3.5 w-3.5" />Back to batches</button>
          <p className="text-xs uppercase tracking-wide text-slate">Batch / stock no.</p>
          <h2 className="font-mono text-2xl font-bold text-navy">{b.batch_code}</h2>
          <p className="mt-1 font-semibold text-charcoal">{b.product_name}</p>
          <p className="flex flex-wrap gap-x-2 text-sm text-slate [&>span+span]:before:mr-2 [&>span+span]:before:content-['·']">
            <span>{row.godown}</span>
            <span>{`Purchased ${day(b.purchase_date)}`}</span>
            {b.supplier && <span>{`From ${b.supplier}`}</span>}
            {b.purchase_ref && <span>{`Bill / PO ${b.purchase_ref}`}</span>}
          </p>
          <p className="flex flex-wrap gap-x-2 text-xs text-slate [&>span+span]:before:mr-2 [&>span+span]:before:content-['·']">
            <span>{`Cost ${money(b.unit_cost)} per unit`}</span>
            {b.received_by_name && <span>{`Received by ${b.received_by_name}`}</span>}
            {b.source === "zoho" && <span>Made in Zoho</span>}
            {b.expiry_date && <span>{`Expiry ${day(b.expiry_date)}`}</span>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ZohoBadge row={row} />
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="mr-1.5 h-3.5 w-3.5" />Edit details</Button>
        </div>
      </div>

      <Panel title="Stock flow">
        <div className="grid gap-4 p-4">
          <FlowBar row={row} large />
          <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
            <Figure label="Purchased" value={units(row.purchased)} />
            <Figure label="Sold" value={units(row.sold)} tone="good" />
            <Figure label="Delivered" value={units(row.delivered)} />
            <Figure label="Awaiting payment" value={units(row.held)} />
            <Figure label="Lost" value={units(row.lost)} tone={row.lost > 0 ? "bad" : undefined} />
            <Figure label="Available" value={units(row.available)} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <Figure label="Purchase value" value={money(row.purchaseValue)} />
            <Figure label="Sales (excl. GST)" value={money(row.sales)} />
            <Figure label="Cost of sold" value={money(row.costOfSold)} />
            <Figure label="Stock lost" value={money(row.lossValue)} tone={row.lossValue > 0 ? "bad" : undefined} />
            <Figure label={row.profit < 0 ? "Loss" : "Profit"} value={money(row.profit)} tone={row.profit < 0 ? "bad" : "good"} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Figure label={row.daysToSellOut === null ? "Days in stock" : "Days to sell out"} value={String(row.daysToSellOut ?? row.ageDays ?? "—")} />
            <Figure label="First sale" value={row.firstSale ? day(istDate(row.firstSale)) : "—"} />
            <Figure label="Sold out on" value={b.depleted_at ? day(istDate(b.depleted_at)) : "—"} />
            <Figure label="Customers" value={String(row.customers)} />
          </div>
          {(row.ledgerGap !== 0 || (row.zohoGap !== null && row.zohoGap !== 0)) && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {row.ledgerGap !== 0 && <span className="block">{`Website ledger differs by ${units(row.ledgerGap)} units.`}</span>}
              {row.zohoGap !== null && row.zohoGap !== 0 && <span className="block">{`Zoho's batch balance is ${units(b.zoho_balance ?? 0)}; the website expects ${units((b.zoho_balance ?? 0) - row.zohoGap)} (available + orders not packed yet).`}</span>}
            </p>
          )}
        </div>
      </Panel>

      {order ? <div id="batch-order-customer" className="scroll-mt-4"><OrderCustomer sale={order} report={report} go={go} /></div> : null}

      <Panel title={`Orders from this batch (${sales.length})`}>
        {sales.length === 0 ? <p className="px-4 py-6 text-sm text-slate">No orders have taken stock from this batch yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ivory text-left text-xs uppercase tracking-wide text-slate">
                <tr><th className="px-3 py-2">Order</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Phone</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Sales</th><th className="px-3 py-2 text-right">Profit</th></tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={`${s.orderItemId}-${s.batchId}`} onClick={() => go({ order: s.orderId })}
                    className={cn("cursor-pointer border-t border-border hover:bg-ivory/60", s.orderId === orderId && "bg-gold/10")}>
                    <td className="px-3 py-2 font-mono text-xs font-semibold text-navy">{s.orderNo}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate">{when(s.orderDate)}</td>
                    <td className="px-3 py-2">{s.held ? "Awaiting Payment" : s.orderStatus}</td>
                    <td className="px-3 py-2">{s.customerName || "—"}</td>
                    <td className="px-3 py-2 text-slate">{s.customerPhone || "—"}</td>
                    <td className="px-3 py-2 text-right">{units(s.qty)}</td>
                    <td className="px-3 py-2 text-right">{money(s.value)}</td>
                    <td className={cn("px-3 py-2 text-right", s.profit < 0 ? "text-red-700" : "text-emerald-700")}>{s.held ? "—" : money(s.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Panel title={`Customers (${customers.length})`}>
          {customers.length === 0 ? <p className="px-4 py-6 text-sm text-slate">No customers yet.</p> : (
            <ul className="divide-y divide-border">
              {customers.map((s) => (
                <li key={s.customerKey}>
                  <button type="button" onClick={() => go({ tab: "trace", customer: s.customerKey, batch: undefined, order: undefined })} className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-ivory/60">
                    <span><span className="font-semibold text-navy">{s.customerName || "Customer"}</span><span className="block text-xs text-slate">{[s.customerPhone, s.customerEmail].filter(Boolean).join(" · ")}</span></span>
                    <ChevronRight className="h-4 w-4 text-slate" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Losses and gains">
          <AdjustmentList rows={adjustments.filter((a) => a.batch_id === b.id)} />
        </Panel>
      </div>
    </div>
  );
}

function AdjustmentList({ rows }: { rows: BatchAdjustment[] }) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-slate">No stock lost or found in counts for this batch.</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
          <span><span className="font-semibold">{adjustmentReasonLabel(r.reason)}</span><span className="block text-xs text-slate">{when(r.created_at)}{r.created_by_name && ` · ${r.created_by_name}`}{r.note && ` · ${r.note}`}</span></span>
          <span className={cn("font-semibold", r.qty < 0 ? "text-red-700" : "text-emerald-700")}>{r.qty > 0 ? "+" : ""}{units(r.qty)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Step 4: the order and its customer, with every batch that customer bought from (back-tracking). */
function OrderCustomer({ sale, report, go }: { sale: BatchSale; report: BatchReport; go: (next: Partial<Search>) => void }) {
  const lines = report.sales.filter((s) => s.orderId === sale.orderId);
  const customer = report.customers.find((c) => c.key === sale.customerKey);
  const otherBatches = report.rows.filter((r) => customer?.batches.includes(r.batch.batch_code));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={`Order ${sale.orderNo}`} action={<Link to="/admin/orders/$id" params={{ id: sale.orderNo }} className="text-xs font-semibold text-navy hover:underline">Open order</Link>}>
        <div className="grid gap-2 p-4 text-sm">
          <p className="text-slate">{when(sale.orderDate)} · <span className="font-semibold text-charcoal">{sale.held ? "Awaiting Payment" : sale.orderStatus}</span></p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {lines.map((l) => (
              <li key={`${l.orderItemId}-${l.batchId}`} className="flex items-center justify-between gap-2 px-3 py-2">
                <span><span className="block">{l.productName}</span><button type="button" onClick={() => go({ batch: l.batchId })} className="font-mono text-xs font-semibold text-navy hover:underline">{l.batchCode}</button></span>
                <span className="text-right">{units(l.qty)} × {money(l.rate)}<span className="block text-xs text-slate">{money(l.value)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
      <Panel title="Customer">
        <div className="grid gap-2 p-4 text-sm">
          <p className="flex items-center gap-2 text-base font-bold text-navy"><UserRound className="h-4 w-4" />{sale.customerName || "Customer"}</p>
          {sale.customerPhone && <a href={`tel:${sale.customerPhone}`} className="flex items-center gap-2 hover:underline"><Phone className="h-4 w-4 text-slate" />{sale.customerPhone}</a>}
          {sale.customerEmail && <a href={`mailto:${sale.customerEmail}`} className="flex items-center gap-2 hover:underline"><Mail className="h-4 w-4 text-slate" />{sale.customerEmail}</a>}
          {sale.customerAddress && <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate" />{sale.customerAddress}</p>}
          {customer && (
            <>
              <p className="mt-2 text-xs uppercase tracking-wide text-slate">{`Bought from ${otherBatches.length} batch${otherBatches.length === 1 ? "" : "es"} · ${customer.orders.length} order${customer.orders.length === 1 ? "" : "s"} · ${money(customer.value)}`}</p>
              <div className="flex flex-wrap gap-1.5">
                {otherBatches.map((r) => (
                  <button key={r.batch.id} type="button" onClick={() => go({ batch: r.batch.id, order: undefined })}
                    className="rounded-full border border-border bg-white px-2.5 py-1 font-mono text-xs font-semibold text-navy hover:border-gold">{r.batch.batch_code}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ back-tracking: customer / order -> batches

function TraceView({ report, search, go }: { report: BatchReport; search: Search; go: (next: Partial<Search>, replace?: boolean) => void }) {
  const [query, setQuery] = useState(search.q ?? "");
  const found = searchBatchReport(report, query);
  const customers = query.trim() ? found.customers : report.customers;
  const customer = report.customers.find((c) => c.key === search.customer);
  const sales = customer ? report.sales.filter((s) => s.customerKey === customer.key) : [];
  const orders = [...new Map(sales.map((s) => [s.orderId, s])).values()];
  // On a phone the customer opens below the list: bring it into view.
  useEffect(() => {
    if (search.customer && window.innerWidth < 1024)
      document.getElementById("trace-customer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [search.customer]);
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,1fr)_2fr] [&>*]:min-w-0">
      <Panel title="Find a customer or order">
        <div className="border-b border-border p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate" />
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onBlur={() => go({ q: query.trim() || undefined }, true)}
              placeholder="Name, phone, email or order no." className="pl-8" />
          </label>
        </div>
        {customers.length === 0 ? <p className="px-4 py-6 text-sm text-slate">{query ? "No customer matches that search." : "No customers bought from a batch yet."}</p> : (
          <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
            {customers.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={() => go({ customer: c.key })} className={cn("flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-ivory/60", c.key === search.customer && "bg-gold/10")}>
                  <span className="min-w-0"><span className="block truncate font-semibold text-navy">{c.name || "Customer"}</span><span className="block truncate text-xs text-slate">{c.phone || c.email}</span></span>
                  <span className="shrink-0 text-right text-xs text-slate">{`${c.batches.length} batch${c.batches.length === 1 ? "" : "es"}`}<span className="block">{money(c.value)}</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {customer ? (
        <div id="trace-customer" className="grid min-w-0 scroll-mt-4 gap-4 [&>*]:min-w-0">
          <Panel title="Customer">
            <div className="grid gap-1.5 p-4 text-sm">
              <p className="flex items-center gap-2 text-base font-bold text-navy"><UserRound className="h-4 w-4" />{customer.name || "Customer"}</p>
              {customer.phone && <a href={`tel:${customer.phone}`} className="flex items-center gap-2 hover:underline"><Phone className="h-4 w-4 text-slate" />{customer.phone}</a>}
              {customer.email && <a href={`mailto:${customer.email}`} className="flex items-center gap-2 hover:underline"><Mail className="h-4 w-4 text-slate" />{customer.email}</a>}
              {customer.address && <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate" />{customer.address}</p>}
              <p className="text-xs text-slate">{`${customer.orders.length} order${customer.orders.length === 1 ? "" : "s"} · ${units(customer.qty)} units · ${money(customer.value)}`}</p>
            </div>
          </Panel>
          <Panel title="Orders and the batches they came from">
            <ul className="divide-y divide-border">
              {orders.map((o) => (
                <li key={o.orderId} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link to="/admin/orders/$id" params={{ id: o.orderNo }} className="font-mono text-sm font-semibold text-navy hover:underline">{o.orderNo}</Link>
                    <span className="text-xs text-slate">{when(o.orderDate)} · {o.held ? "Awaiting Payment" : o.orderStatus}</span>
                  </div>
                  <ul className="mt-2 grid gap-1.5">
                    {sales.filter((s) => s.orderId === o.orderId).map((s) => (
                      <li key={`${s.orderItemId}-${s.batchId}`} className="flex items-center justify-between gap-2 rounded-md bg-ivory/60 px-3 py-1.5 text-sm">
                        <span className="min-w-0 truncate">{s.productName}</span>
                        <button type="button" onClick={() => go({ tab: undefined, batch: s.batchId, order: s.orderId, customer: undefined })}
                          className="flex shrink-0 items-center gap-1 font-mono text-xs font-semibold text-navy hover:underline">{s.batchCode} · {units(s.qty)}<ChevronRight className="h-3.5 w-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : (
        <div className="grid place-items-center rounded-lg border border-dashed border-border p-10 text-center text-sm text-slate">
          <div><IndianRupee className="mx-auto mb-2 h-6 w-6 text-gold" /><p>Pick a customer to see every order and the batch each item came from.</p><p>Search by phone or order number to trace a complaint back to its batch.</p></div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ receive a purchase

function ReceiveDialog({ open, onOpenChange, data, defaultGodown, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; data: BatchData; defaultGodown?: string | undefined; onSaved: (batchId: string) => Promise<void>;
}) {
  const godowns = data.godowns.filter((g) => g.active);
  const [form, setForm] = useState({ branchId: "", productId: "", quantity: "", unitCost: "", purchaseDate: todayIst(), batchCode: "", supplier: "", purchaseRef: "", mfgDate: "", expiryDate: "", notes: "" });
  const [busy, setBusy] = useState(false);
  // A cost the admin typed is kept when the product changes; otherwise the product's purchase rate fills it.
  const [costTyped, setCostTyped] = useState(false);
  useEffect(() => {
    // Only an active godown (the select lists only those).
    const usable = (id?: string) => (id && godowns.some((g) => g.id === id) ? id : "");
    if (open) setForm((f) => ({ ...f, branchId: usable(f.branchId) || usable(defaultGodown) || godowns.find((g) => g.zohoLinked)?.id || godowns[0]?.id || "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const product = data.products.find((p) => p.id === form.productId);
  const godown = data.godowns.find((g) => g.id === form.branchId);
  const autoCode = godown ? (() => {
    const prefix = formatBatchCode(godownCodeOf(godown), form.purchaseDate, 1).slice(0, -2);
    const used = [...data.batches.map((b) => b.batch_code), ...data.reservedCodes].map((c) => c.toUpperCase()).filter((c) => c.startsWith(prefix)).map((c) => Number(c.slice(prefix.length))).filter(Number.isFinite);
    return `${prefix}${String((used.length ? Math.max(...used) : 0) + 1).padStart(2, "0")}`;
  })() : "";
  const zohoNote = !product || !godown ? "" : !data.zohoStockMaster || !product.zohoLinked || !godown.zohoLinked
    ? "Website only: this product or godown is not linked to Zoho stock, so the stock goes to Zoho with the next sync."
    : product.zohoTracksBatches
      ? `Zoho tracks batches for this item: Zoho gets batch ${normalizeBatchCode(form.batchCode) || autoCode} at ${godown.name}.`
      : `Zoho gets the stock at ${godown.name}, with the batch number on the Zoho stock adjustment and on the sales orders, invoices and packages of orders from this batch.`;
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = async (): Promise<void> => {
    const quantity = Number(form.quantity), unitCost = Number(form.unitCost);
    if (!form.branchId || !form.productId) return void toast.error("Choose the godown and the product");
    if (!(quantity > 0)) return void toast.error("Enter the quantity received");
    if (!(unitCost >= 0) || form.unitCost === "") return void toast.error("Enter the purchase cost per unit");
    if (form.batchCode && !isBatchCode(form.batchCode)) return void toast.error("Batch number: 2-40 letters, digits, - / _ .");
    setBusy(true);
    try {
      const { receiveBatchPurchase } = await import("@/lib/zoho-commerce.functions");
      const saved = await receiveBatchPurchase({ data: {
        branchId: form.branchId, productId: form.productId, quantity, unitCost, purchaseDate: form.purchaseDate,
        batchCode: form.batchCode, supplier: form.supplier, purchaseRef: form.purchaseRef, notes: form.notes,
        mfgDate: form.mfgDate || null, expiryDate: form.expiryDate || null,
      } });
      toast.success(`Batch ${saved.batchCode} received`, {
        description: saved.zoho === "batch" ? "Zoho has the batch at this godown." : saved.zoho === "stock" ? "Zoho has the stock at this godown." : "Website only; Zoho gets the stock at the next sync.",
      });
      onOpenChange(false);
      setCostTyped(false);
      setForm((f) => ({ ...f, productId: "", quantity: "", unitCost: "", batchCode: "", supplier: "", purchaseRef: "", mfgDate: "", expiryDate: "", notes: "" }));
      await onSaved(saved.batchId);
    } catch (cause) {
      toast.error("Could not receive the purchase", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Receive purchase</DialogTitle>
          <DialogDescription>One purchase = one batch with its own stock number. Orders from this godown take the oldest batch first.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Godown"><select value={form.branchId} onChange={set("branchId")} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">{godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
          <Field label="Purchase date"><Input type="date" value={form.purchaseDate} max={todayIst()} onChange={set("purchaseDate")} /></Field>
          <Field label="Product" wide>
            <select value={form.productId} onChange={(e) => { const p = data.products.find((x) => x.id === e.target.value); setForm((f) => ({ ...f, productId: e.target.value, unitCost: costTyped ? f.unitCost : (p?.purchasePrice ? String(p.purchasePrice) : "") })); }} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              <option value="">Choose a product…</option>
              {data.products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ""}</option>)}
            </select>
            {product && godown && <span className="mt-1 block text-xs text-slate">{`Now at ${godown.name}: ${units(product.stock[godown.id] ?? 0)}`}</span>}
          </Field>
          <Field label="Quantity received"><Input type="number" min="0" step="any" value={form.quantity} onChange={set("quantity")} placeholder="e.g. 50" /></Field>
          <Field label="Purchase cost per unit (₹)"><Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(e) => { setCostTyped(e.target.value !== ""); set("unitCost")(e); }} placeholder="landing cost" /></Field>
          <Field label="Batch / stock no." wide>
            <Input value={form.batchCode} onChange={set("batchCode")} placeholder={autoCode ? `${autoCode} (automatic)` : "automatic"} className="font-mono uppercase placeholder:normal-case" />
          </Field>
          <Field label="Supplier"><Input value={form.supplier} onChange={set("supplier")} placeholder="optional" /></Field>
          <Field label="Bill / PO no."><Input value={form.purchaseRef} onChange={set("purchaseRef")} placeholder="optional" /></Field>
          <Field label="Manufactured on"><Input type="date" value={form.mfgDate} onChange={set("mfgDate")} /></Field>
          <Field label="Expiry date"><Input type="date" value={form.expiryDate} onChange={set("expiryDate")} /></Field>
          <Field label="Notes" wide><Textarea rows={2} value={form.notes} onChange={set("notes")} placeholder="optional" /></Field>
        </div>
        {zohoNote && <p className="rounded-md border border-border bg-ivory p-2 text-xs text-charcoal">{zohoNote}</p>}
        {product && Number(form.quantity) > 0 && Number(form.unitCost) >= 0 && (
          <p className="text-sm font-semibold">{`Purchase value: ${money(Number(form.quantity) * Number(form.unitCost))}`}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-navy text-white" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Receive batch"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={cn("grid gap-1 text-xs font-semibold text-slate", wide && "sm:col-span-2")}>{label}{children}</label>;
}

function EditDialog({ row, onClose, onSaved }: { row: BatchReportRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const b = row.batch;
  const [form, setForm] = useState({ unitCost: String(b.unit_cost), supplier: b.supplier, purchaseRef: b.purchase_ref, notes: b.notes, mfgDate: b.mfg_date ?? "", expiryDate: b.expiry_date ?? "" });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const save = async (): Promise<void> => {
    const cost = Number(form.unitCost);
    if (!(cost >= 0) || form.unitCost === "") return void toast.error("Enter a valid purchase cost");
    setBusy(true);
    const { error } = await supabase.rpc("admin_update_batch", {
      _batch_id: b.id, _unit_cost: cost, _supplier: form.supplier, _purchase_ref: form.purchaseRef, _notes: form.notes,
      _mfg_date: form.mfgDate || null, _expiry_date: form.expiryDate || null,
    });
    setBusy(false);
    if (error) return void toast.error("Could not save the batch", { description: error.message });
    toast.success(`Batch ${b.batch_code} saved`);
    await onSaved();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Batch {b.batch_code}</DialogTitle>
          <DialogDescription>Quantities change only through orders, receipts and stock counts. A new cost also updates the profit of sales already made.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Purchase cost per unit (₹)"><Input type="number" min="0" step="0.01" value={form.unitCost} onChange={set("unitCost")} /></Field>
          <Field label="Supplier"><Input value={form.supplier} onChange={set("supplier")} /></Field>
          <Field label="Bill / PO no."><Input value={form.purchaseRef} onChange={set("purchaseRef")} /></Field>
          <Field label="Manufactured on"><Input type="date" value={form.mfgDate} onChange={set("mfgDate")} /></Field>
          <Field label="Expiry date"><Input type="date" value={form.expiryDate} onChange={set("expiryDate")} /></Field>
          <Field label="Notes" wide><Textarea rows={2} value={form.notes} onChange={set("notes")} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-navy text-white" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ static preview data

function demoData(): BatchData {
  const now = new Date().toISOString();
  const godowns = [{ id: "BR-CLK", name: "Grain Bazar Challakere Godown", code: "CLK", active: true, zohoLinked: true }, { id: "BR-HBL", name: "Grain Bazar Hubli Godown", code: "HBL", active: true, zohoLinked: true }];
  const batch = (id: string, code: string, branch: string, product: string, name: string, qty: number, left: number, cost: number, date: string, depleted: string | null) => ({
    id, batch_code: code, product_id: product, product_name: name, branch_id: branch, quantity: qty, remaining_quantity: left, unit: "pack", unit_cost: cost,
    purchase_date: date, mfg_date: null, expiry_date: null, status: left > 0 ? "Active" : "Depleted", source: "website", supplier: "Sri Oils", purchase_ref: "BILL-101",
    notes: "", received_by_name: "Head office", zoho_batch_id: "", zoho_adjustment_id: "", zoho_balance: null, zoho_checked_at: null, depleted_at: depleted,
    created_at: `${date}T05:00:00Z`, vendor: null, vendor_id: null, warehouse: null, updated_at: now, received_by: null, zoho_item_id: "",
  });
  return {
    generatedAt: now, zohoStockMaster: true, godowns,
    products: [{ id: "P023", name: "Groundnut Oil 5L Can", sku: "SBV-OI-1022", unit: "", purchasePrice: 820, zohoLinked: true, zohoTracksBatches: true, stock: { "BR-CLK": 30 } }],
    batches: [
      batch("b1", "CLK-201026-01", "BR-CLK", "P023", "Groundnut Oil 5L Can", 50, 0, 800, "2026-10-20", "2026-10-29T08:00:00Z"),
      batch("b2", "CLK-301026-01", "BR-CLK", "P023", "Groundnut Oil 5L Can", 50, 30, 820, "2026-10-30", null),
      batch("b3", "HBL-251026-01", "BR-HBL", "P023", "Groundnut Oil 5L Can", 40, 25, 810, "2026-10-25", null),
    ],
    allocations: [
      { id: "a1", order_item_id: "i1", batch_id: "b1", reserved_quantity: 48, released_quantity: 0, unit_cost: 800, created_at: now },
      { id: "a2", order_item_id: "i2", batch_id: "b2", reserved_quantity: 20, released_quantity: 0, unit_cost: 820, created_at: now },
      { id: "a3", order_item_id: "i3", batch_id: "b3", reserved_quantity: 15, released_quantity: 0, unit_cost: 810, created_at: now },
    ],
    items: [
      { id: "i1", order_id: "o1", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 48, unit_price: 949, gst_rate: 5 },
      { id: "i2", order_id: "o2", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 20, unit_price: 949, gst_rate: 5 },
      { id: "i3", order_id: "o3", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 15, unit_price: 955, gst_rate: 5 },
    ],
    orders: [
      { id: "o1", order_no: "CLK-577522-251026-101500", created_at: "2026-10-25T04:45:00Z", order_status: "Delivered", payment_status: "Paid", branch_id: "BR-CLK", user_id: "u1", customer_name: "Ravi Traders", customer_email: "ravi@example.com", customer_phone: "9876500011", shipping_address: { line1: "Main Road", city: "Challakere", pin: "577522" }, subtotal: 45552, discount: 0 },
      { id: "o2", order_no: "CLK-577522-301026-121000", created_at: "2026-10-30T06:40:00Z", order_status: "Packed", payment_status: "Paid", branch_id: "BR-CLK", user_id: "u2", customer_name: "Lakshmi Stores", customer_email: "", customer_phone: "9876500022", shipping_address: { line1: "Market", city: "Challakere", pin: "577522" }, subtotal: 18980, discount: 0 },
      { id: "o3", order_no: "HBL-580020-281026-093000", created_at: "2026-10-28T04:00:00Z", order_status: "Delivered", payment_status: "Paid", branch_id: "BR-HBL", user_id: "u1", customer_name: "Ravi Traders", customer_email: "ravi@example.com", customer_phone: "9876500011", shipping_address: { line1: "Station Road", city: "Hubli", pin: "580020" }, subtotal: 14325, discount: 0 },
    ],
    adjustments: [{ id: "x1", batch_id: "b1", qty: -2, reason: "damaged", note: "2 cans leaked", unit_cost: 800, created_at: "2026-10-27T10:00:00Z", created_by_name: "Manju" }],
    reservedCodes: [],
  } as BatchData;
}
