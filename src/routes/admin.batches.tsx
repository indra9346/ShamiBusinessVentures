import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeft, ArrowRightLeft, CalendarClock, ChevronRight, Clock3, FileSpreadsheet, IndianRupee, Layers, Mail, MapPin, PackageCheck, PackagePlus, Pencil,
  Phone, RefreshCw, Search, ShoppingCart, Trash2, TrendingDown, TrendingUp, UserRound, Warehouse,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { matchesBatchStatus, type BatchStatus } from "@/lib/panel-filters";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { downloadXlsx } from "@/lib/xlsx";
import { supabase } from "@/integrations/supabase/client";
import {
  adjustmentReasonLabel, batchAdjustmentSheet, batchReportSheets, buildBatchReport, costBasesOf, costBasisName, costBeforeGst, costWithGst, formatBatchCode, istDate,
  godownStockChecks, searchBatchReport, sumTotals, type BatchAdjustment, type BatchReport, type BatchReportRow, type BatchSale,
} from "@/lib/batches";
import type { BatchData } from "@/lib/batches.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReceiveFromBillDialog } from "@/components/batches/ReceiveFromBill";
import { IncomingBatchDialog } from "@/components/batches/IncomingBatchDialog";
import { MatchedLotNote, PreorderPanel, clockOf, lotOf, lotOrders, watchOf } from "@/components/batches/PreorderPanel";
import { BatchExpensesPanel, BatchProfitPanel, ExpensesOverview } from "@/components/batches/BatchExpenses";
import { dayLabel, lotBadges, lotLabel, lotOverdue, lotSellable, qtyText } from "@/lib/preorder";
import { SendToGodownsDialog, TransferList } from "@/components/batches/BatchTransfers";
import { transferProgress } from "@/lib/batch-transfers";
import { batchDeleteBlocker, billGone, relinkBlocker } from "@/lib/bill-batches";
import type { BatchBillLine } from "@/lib/zoho-commerce.functions";
import { cn } from "@/lib/utils";

// Tabs: Batches, Pre-orders and Expenses (14 Nov 2026), Trace.
type Search = { godown?: string | undefined; batch?: string | undefined; order?: string | undefined; customer?: string | undefined; tab?: "batches" | "trace" | "preorders" | "expenses" | undefined; q?: string | undefined };

export const Route = createFileRoute("/admin/batches")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search["godown"] === "string" && search["godown"] ? { godown: search["godown"] } : {}),
    ...(typeof search["batch"] === "string" && search["batch"] ? { batch: search["batch"] } : {}),
    ...(typeof search["order"] === "string" && search["order"] ? { order: search["order"] } : {}),
    ...(typeof search["customer"] === "string" && search["customer"] ? { customer: search["customer"] } : {}),
    ...(search["tab"] === "trace" ? { tab: "trace" as const } : search["tab"] === "preorders" ? { tab: "preorders" as const } : search["tab"] === "expenses" ? { tab: "expenses" as const } : {}),
    ...(typeof search["q"] === "string" && search["q"] ? { q: search["q"] } : {}),
  }),
  head: () => ({ meta: [{ title: "Batches | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminBatches,
});

const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** A held sale: the checkout is waiting for payment, and its stock stays put aside until then. */
const heldLabel = (until?: string | null) => until
  ? `Awaiting payment · held until ${new Date(until).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
  : "Awaiting Payment";
const todayIst = () => istDate(new Date().toISOString());

/**
 * Admin > Batches: every purchase batch (stock number) per godown — purchased, sold, delivered,
 * lost, available, sales, profit and days to sell out — with step-by-step drill-down
 * (godown > batch > order > customer) and back-tracking (customer or order > batches).
 * "Receive purchase" makes a batch per line of a Zoho bill (stock comes only from the bill, so batches never change
 * stock); Excel downloads the lot.
 */
function AdminBatches() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const go = useCallback((next: Partial<Search>, replace = false) => {
    void navigate({ search: (prev: Search) => {
      const merged: Search = { ...prev, ...next };
      for (const key of Object.keys(merged) as (keyof Search)[]) if (!merged[key]) delete merged[key];
      return merged;
    }, replace, resetScroll: !replace });
  }, [navigate]);
  const [data, setData] = useState<BatchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Receive purchase opened from a pre-order (Match now): at the lot's godown, with the bill when one was found.
  const [receiveAt, setReceiveAt] = useState<{ godown?: string | undefined; billId?: string | undefined }>({});
  const [incomingOpen, setIncomingOpen] = useState(false);
  // New pre-order put aside while one of its listed bills is received (review fix): it comes back with what was typed.
  const [incomingParked, setIncomingParked] = useState(false);
  const openReceive = useCallback((godown?: string, billId?: string) => { setReceiveAt({ godown, billId }); setReceiveOpen(true); }, []);
  const [editRow, setEditRow] = useState<BatchReportRow | null>(null);
  const [status, setStatus] = useState<BatchStatus>("all");
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
  // Bills edited, voided or deleted in Zoho after their batches were made: flagged on the batches (at most every 30 minutes).
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void (async () => {
      try {
        const { checkBatchBills } = await import("@/lib/zoho-commerce.functions");
        const result = await checkBatchBills();
        if (result.checked) await load();
      } catch { /* the flags wait for the next visit; the page works without them */ }
    })();
  }, [load]);
  // Expenses and bill charges tagged to batches, edited or deleted in Zoho: flagged the same way (spec 8.3, 30-minute throttle).
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void (async () => {
      try {
        const { checkBatchCosts } = await import("@/lib/batch-costs.functions");
        const result = await checkBatchCosts();
        if (result.checked && result.read) await load();
      } catch { /* checked again on the next visit or by the hourly run */ }
    })();
  }, [load]);
  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    let timer: number | null = null;
    const soon = () => { if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => void load(), 2000); };
    const channel = supabase.channel(`batches-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "batches" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
      // Godown stock (Zoho sync, head-office edits, staff counts): the stock check below follows it live.
      .on("postgres_changes", { event: "*", schema: "public", table: "branch_stock" }, soon)
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
    const codes = new Map(report.rows.map((r) => [r.batch.id, { code: r.batch.batch_code, product: r.batch.product_name, godown: r.godown, batch: r.batch }]));
    const label = search.godown ? godownName(search.godown) : "All godowns";
    downloadXlsx(`batch-report-${label.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${todayIst()}.xlsx`, [
      ...batchReportSheets(scoped, { generatedAt: data.generatedAt, scope: label }),
      batchAdjustmentSheet(data.adjustments.filter((a) => ids.has(a.batch_id)), codes),
    ]);
    toast.success("Batch report downloaded", { description: `${label} · ${scope.length} batches` });
  };

  const steps: { label: string; onClick?: () => void }[] = [{ label: "All batches", onClick: () => go({ godown: undefined, batch: undefined, order: undefined, customer: undefined, tab: undefined }) }];
  if (search.tab === "trace") steps.push({ label: "Trace customer / order", onClick: () => go({ batch: undefined, order: undefined, customer: undefined }) });
  if (search.tab === "preorders") steps.push({ label: "Pre-orders", onClick: () => go({ batch: undefined, order: undefined, customer: undefined }) });
  if (search.tab === "expenses") steps.push({ label: "Expenses", onClick: () => go({ batch: undefined, order: undefined, customer: undefined }) });
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
          {([["batches", "Batches"], ["preorders", "Pre-orders"], ["expenses", "Expenses"], ["trace", "Trace customer / order"]] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => go({ tab: key === "batches" ? undefined : key, batch: undefined, order: undefined, customer: undefined })}
              className={cn("rounded-md px-3 py-1.5 font-semibold transition", (search.tab ?? "batches") === key ? "bg-navy text-white" : "text-slate hover:text-navy")}>{label}</button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
          <Button size="sm" variant="outline" disabled={!report} onClick={downloadExcel}><FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />Download Excel</Button>
          <Button size="sm" variant="outline" className="border-amber-400 text-amber-900 hover:bg-amber-50" disabled={!data} onClick={() => setIncomingOpen(true)}><CalendarClock className="mr-1.5 h-3.5 w-3.5" />New pre-order</Button>
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={!data} onClick={() => openReceive(search.godown)}><PackagePlus className="mr-1.5 h-3.5 w-3.5" />Receive purchase</Button>
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
      {data && <ZohoFreshness stock={data.zohoStock} />}
      {data && <PreorderAlerts data={data} go={go} onMatch={openReceive} />}
      {!report && !error && <p className="py-10 text-center text-sm text-slate">Loading batches…</p>}
      {data && data.transfers.some((t) => t.status === "pending") && (
        <Panel title="Transfers waiting for Zoho" className="mb-4 border-amber-300">
          <TransferList transfers={data.transfers.filter((t) => t.status === "pending")} onChanged={load} />
        </Panel>
      )}
      {data && data.transfers.some((t) => t.status === "in_transit") && (
        <Panel title="On the way between godowns" className="mb-4 border-sky-300">
          <TransferList transfers={data.transfers.filter((t) => t.status === "in_transit")} onChanged={load} />
        </Panel>
      )}

      {report && data && (
        search.tab === "trace"
          ? <TraceView report={report} search={search} go={go} />
          : selected
            ? <BatchDetail row={selected} report={report} data={data} adjustments={data.adjustments} orderId={search.order} go={go} onEdit={() => setEditRow(selected)}
                onDeleted={async () => { go({ batch: undefined, order: undefined }); await load(); }} onChanged={load} onMatch={openReceive} />
            : search.tab === "preorders"
              ? <PreorderList data={data} search={search} go={go} onNew={() => setIncomingOpen(true)} />
            : search.tab === "expenses"
              ? <ExpensesOverview report={report} data={data} godownId={search.godown} onChanged={load} />
            : <>
                <BatchList report={report} data={data} search={search} go={go} status={status} setStatus={setStatus}
                  productFilter={productFilter} setProductFilter={setProductFilter} />
                {data.transfers.length > 0 && (
                  <Panel title={`Transfers between godowns (${data.transfers.length})`} className="mt-4">
                    <TransferList transfers={data.transfers} onChanged={load} compact />
                  </Panel>
                )}
              </>
      )}

      {data && <ReceiveFromBillDialog open={receiveOpen} godowns={data.godowns.filter((g) => g.active)} defaultGodown={receiveAt.godown ?? search.godown}
        onOpenChange={(next) => { setReceiveOpen(next); if (!next && incomingParked) { setIncomingParked(false); setIncomingOpen(true); } }}
        initialBillId={receiveAt.billId}
        chargeTagged={(billId, lineId) => {
          const doc = data.costDocuments.find((d) => d.source === "bill" && d.zoho_id === billId && d.zoho_line_id === lineId);
          return doc ? data.costTags.filter((t) => t.document_id === doc.id).reduce((sum, t) => sum + t.amount, 0) : 0;
        }}
        lotTags={(batchId) => data.costTags.filter((t) => t.batch_id === batchId).map((t) => t.amount)}
        onSaved={async (batchId) => { await load(); if (batchId) go({ tab: undefined, batch: batchId, order: undefined, customer: undefined }); }} />}
      {data && (incomingOpen || incomingParked) && <IncomingBatchDialog open={incomingOpen} onOpenChange={setIncomingOpen} data={data} defaultGodown={search.godown}
        onReceive={(godown, billId) => { setIncomingOpen(false); setIncomingParked(true); openReceive(godown, billId); }}
        onSaved={async (batchId) => { await load(); if (batchId) go({ tab: undefined, batch: batchId, order: undefined, customer: undefined }); }} />}
      {editRow && <EditDialog row={editRow} onClose={() => setEditRow(null)} onSaved={async () => { setEditRow(null); await load(); }} />}
    </PanelLayout>
  );
}

// ------------------------------------------------------------------ step 1 + 2: godowns and batches

function BatchList({ report, data, search, go, status, setStatus, productFilter, setProductFilter }: {
  report: BatchReport; data: BatchData; search: Search; go: (next: Partial<Search>, replace?: boolean) => void;
  status: BatchStatus; setStatus: (s: BatchStatus) => void;
  productFilter: string; setProductFilter: (p: string) => void;
}) {
  const [query, setQuery] = useState(search.q ?? "");
  // Pre-order batches (14 Nov 2026): received batches, pre-orders waiting for their bill, or cancelled ones.
  const [stage, setStage] = useState<"all" | "received" | "incoming" | "cancelled">("all");
  const found = searchBatchReport(report, query);
  const rows = found.rows.filter((row) => (!search.godown || row.batch.branch_id === search.godown)
    && (!productFilter || row.batch.product_id === productFilter)
    && (stage === "all" || (row.batch.stage ?? "received") === stage)
    && matchesBatchStatus(row, status));
  const clock = clockOf(data);
  const lots = data.batches.filter((b) => b.stage === "incoming" && (!search.godown || b.branch_id === search.godown));
  const arriving = {
    expected: lots.reduce((sum, b) => sum + b.quantity, 0),
    sold: lots.reduce((sum, b) => sum + b.quantity - b.remaining_quantity, 0),
    open: lots.reduce((sum, b) => sum + lotSellable(lotOf(b), clock), 0),
  };
  // The cards count the whole scope, so they open the list without a search or product filter.
  const openList = (next: BatchStatus) => {
    setQuery("");
    setProductFilter("");
    setStatus(next);
    if (search.q) go({ q: undefined }, true);
    scrollToSection("batch-list");
  };
  const scope = search.godown ? report.godowns.find((g) => g.godownId === search.godown) : null;
  const totals = scope ?? { ...report.all, batches: report.rows.length, active: report.rows.filter((r) => r.available > 0).length, averageDaysToSellOut: average(report.rows) };
  const products = [...new Map(report.rows.map((r) => [r.batch.product_id, r.batch.product_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard onClick={() => openList("stock")} compact label="Batches in stock" value={`${totals.active} / ${totals.batches}`} icon={Layers} description="with units left / all" />
        <StatCard onClick={() => openList("stock")} compact label="Units available" value={units(totals.available)} icon={PackageCheck} description={`of ${units(totals.purchased)} purchased`} />
        <StatCard onClick={() => openList("all")} compact label="Sales (excl. GST)" value={money(totals.sales)} icon={ShoppingCart} description={`${units(totals.sold)} units sold`} />
        <StatCard onClick={() => openList("all")} compact label={totals.profit < 0 ? "Loss after expenses" : "Profit after expenses"} value={money(Math.abs(totals.profit))} icon={totals.profit < 0 ? TrendingDown : TrendingUp} highlight
          description={profitBreakup(totals)} />
        <StatCard onClick={() => openList(totals.lossValue < 0 ? "found" : "lost")} compact label={totals.lossValue < 0 ? "Stock found" : "Stock lost"} value={money(Math.abs(totals.lossValue))} icon={totals.lossValue < 0 ? TrendingUp : TrendingDown}
          description={`${units(totals.lost)} units lost, ${units(totals.gained)} found (counts, damage), at cost before GST`} />
        <StatCard onClick={() => openList("soldout")} compact label="Avg. days to sell out" value={totals.averageDaysToSellOut === null ? "—" : String(totals.averageDaysToSellOut)} icon={Clock3} description="sold-out batches" />
        {lots.length > 0 && (
          <StatCard onClick={() => go({ tab: "preorders" })} compact label="Arriving (pre-order)" value={units(arriving.expected)} icon={CalendarClock}
            description={`${units(arriving.sold)} sold ahead · ${units(arriving.open)} open · ${lots.length} pre-order batch${lots.length === 1 ? "" : "es"}`} />
        )}
        {(totals.expenseValue !== 0 || data.costTags.length > 0) && (
          <StatCard onClick={() => go({ tab: "expenses" })} compact label="Expenses tagged" value={money(totals.expenseValue)} icon={IndianRupee}
            description={`${money(totals.expenseInStockValue + totals.expenseInTransitValue)} in unsold stock · ${money(totals.expenseOnSoldValue)} on sold`} />
        )}
      </div>

      <StockCheck report={report} data={data} godownId={search.godown} onProduct={(productId) => { setQuery(""); setStatus("all"); setProductFilter(productId); scrollToSection("batch-list"); }} />

      {(() => {
        // Bill batches are costed without GST for profit, like sales. A cost typed in by hand can't be told apart.
        const bases = costBasesOf(search.godown ? report.rows.filter((r) => r.batch.branch_id === search.godown) : report.rows);
        return bases.includes("typed") ? (
          <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Some batches have a cost typed in by hand. Their profit uses that cost as it was typed: if it included GST, their profit is understated by the GST. Batches made from a Zoho bill always use their cost without GST.
          </p>
        ) : null;
      })()}

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

      <Panel id="batch-list" title={scope ? `${scope.godown} · batches` : "All batches"}>
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
          <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)} aria-label="Stage" className="h-9 rounded-md border border-input bg-white px-2 text-sm">
            <option value="all">All stages</option>
            <option value="received">Received</option>
            <option value="incoming">Pre-orders</option>
            <option value="cancelled">Cancelled pre-orders</option>
          </select>
          <div className="flex rounded-md border border-input bg-white p-0.5 text-xs">
            {([["all", "All"], ["stock", "In stock"], ["soldout", "Sold out"], ["lost", "Stock lost"], ["found", "Stock found"]] as const).map(([key, label]) => (
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
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-navy">{row.batch.batch_code}<LotTags batch={row.batch} data={data} /></td>
                      <td className="max-w-[240px] truncate px-3 py-2.5" title={row.batch.product_name}>{row.batch.product_name}</td>
                      <td className="max-w-[160px] truncate px-3 py-2.5 text-slate" title={row.godown}>{row.godown}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate">{day(row.batch.purchase_date)}</td>
                      <td className="px-3 py-2.5 text-right">{units(row.purchased)}</td>
                      <td className="min-w-[160px] px-3 py-2.5">{row.batch.stage === "incoming" ? <LotFlowBar batch={row.batch} data={data} /> : <FlowBar row={row} />}</td>
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
                    <span className="min-w-0 font-mono font-semibold text-navy">{row.batch.batch_code}</span>
                    <ZohoBadge row={row} />
                  </div>
                  <LotTags batch={row.batch} data={data} />
                  <p className="mt-1 truncate text-sm">{row.batch.product_name}</p>
                  <p className="text-xs text-slate">{row.godown} · {day(row.batch.purchase_date)}</p>
                  <div className="mt-2">{row.batch.stage === "incoming" ? <LotFlowBar batch={row.batch} data={data} /> : <FlowBar row={row} />}</div>
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

/**
 * How the profit card's figure is made, so a loss or gain of stock can't look like trading profit: sales − purchase cost
 * − expenses on sold − stock lost (with its expenses), before GST (spec 9.3).
 */
const profitBreakup = (t: { sales: number; costOfSold: number; lossValue: number; expenseOnSoldValue: number; expenseOnLostValue: number }) =>
  // Two whole sentences (not a word in the middle), so each reads in Kannada. The sign of loss plus its expenses decides
  // (review fix: 10 lost and 11 found with expenses on the lost read "+ stock found" while it lowered profit).
  t.lossValue + t.expenseOnLostValue < 0
    ? `sales ${money(t.sales)} − purchase cost ${money(t.costOfSold)} − expenses on sold ${money(t.expenseOnSoldValue)} + stock found ${money(Math.abs(t.lossValue + t.expenseOnLostValue))}, before GST`
    : `sales ${money(t.sales)} − purchase cost ${money(t.costOfSold)} − expenses on sold ${money(t.expenseOnSoldValue)} − stock lost ${money(t.lossValue + t.expenseOnLostValue)}, before GST`;

/** The scheduled Zoho check reads Zoho's godown stock every hour (every 15 minutes the job runs; hourly the stock). */
const ZOHO_CHECK_LATE_MINUTES = 90;

/**
 * When Zoho's stock was last read by the scheduled check. Stock received in Zoho (a purchase receive) reaches the
 * godown's stock here only through it; 13 Nov 2026 it had stopped for two days and nobody could see that.
 */
function ZohoFreshness({ stock }: { stock: BatchData["zohoStock"] }) {
  // Ages on an open page: re-checked every minute (the data itself reloads when stock changes).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const checkedAt = stock.at;
  const minutes = checkedAt ? Math.round((nowMs - Date.parse(checkedAt)) / 60_000) : null;
  const late = minutes === null || minutes > ZOHO_CHECK_LATE_MINUTES || !stock.read;
  if (!late && stock.failed === 0) {
    return (
      <p className="mb-3 flex items-center gap-1.5 text-xs text-slate">
        <RefreshCw className="h-3.5 w-3.5" />Zoho stock last read {when(checkedAt!)}{stock.items ? ` (${stock.items} items)` : ""}, every hour. Page updates by itself.
      </p>
    );
  }
  return (
    <p className="mb-4 flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {late
          ? <>
              {checkedAt
                ? stock.read ? `Zoho's stock has not been read since ${when(checkedAt)}.` : `The Zoho check at ${when(checkedAt)} did not read any stock.`
                : "Zoho's stock has not been read yet."}{" "}
              Stock received or changed in Zoho is not on the website until the hourly Zoho check runs again, so godown stock here may be out of date.
              Do not type the stock in by hand to make up for it.
            </>
          : <>Zoho stock last read {when(checkedAt!)}, but {stock.failed} {stock.failed === 1 ? "item" : "items"} could not be read{stock.error ? `: ${stock.error}` : ""}. Their godown stock here may be out of date.</>}
      </span>
    </p>
  );
}

/**
 * Godown stock next to what its batches hold, per product (13 Nov 2026): the two should agree, so a difference is
 * shown with what it means instead of being added to a batch.
 */
function StockCheck({ report, data, godownId, onProduct }: { report: BatchReport; data: BatchData; godownId?: string | undefined; onProduct: (productId: string) => void }) {
  const stock = new Map(data.products.map((p) => [p.id, p.stock]));
  // Received batches only (14 Nov 2026): a pre-order batch's bags are not at the godown yet, and the stock is the ready stock.
  const checks = godownStockChecks(report.rows.filter((row) => (!godownId || row.batch.branch_id === godownId) && (row.batch.stage ?? "received") === "received"),
    (productId, branchId) => stock.get(productId)?.[branchId] ?? 0);
  const off = checks.filter((check) => check.difference !== 0);
  return (
    <Panel id="stock-check" title={off.length ? `Stock check: ${off.length} of ${checks.length} products differ` : checks.length ? `Stock check: all ${checks.length} products agree` : "Stock check"}
      className={off.length ? "border-amber-300" : ""}>
      {checks.length === 0 ? (
        <p className="text-sm text-slate">No batches yet.</p>
      ) : (
        <div className="grid gap-2">
          {(off.length ? off : checks).map((check) => (
            <div key={`${check.godownId}|${check.productId}`} className="min-w-0 rounded-md border border-border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <button type="button" onClick={() => onProduct(check.productId)} className="min-w-0 break-words text-left font-semibold text-navy hover:underline">{check.productName}</button>
                <span className="text-xs text-slate">{check.godown}</span>
              </div>
              <p className="mt-1 text-xs">
                In batches <b>{units(check.inBatches)}</b> · Godown stock <b>{units(check.godownStock)}</b>
              </p>
              <p className={cn("mt-1 text-xs", check.difference === 0 ? "text-emerald-700" : "text-amber-800")}>
                {check.difference === 0
                  ? "Agree"
                  : check.difference < 0
                    ? `${units(-check.difference)} batch units are not in the godown's stock: the Zoho receive has not reached the website yet, or stock was taken out in Zoho.`
                    : `${units(check.difference)} units in the godown have no batch (stock from before batches, or a bill not received as a batch yet).`}
              </p>
            </div>
          ))}
          {off.length > 0 && off.length < checks.length && (
            <p className="text-xs text-slate">
              {checks.length - off.length === 1 ? "The other product agrees." : `The other ${checks.length - off.length} products agree.`}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

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
  const total = Math.max(row.purchased + row.received + row.gained, row.sold + row.held + row.lost + row.sent + row.available, 1);
  const part = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
  return (
    <div>
      <div className={cn("flex overflow-hidden rounded-full bg-slate-100", large ? "h-4" : "h-2")}>
        <span className="bg-emerald-500" style={{ width: part(row.sold) }} title={`Sold ${units(row.sold)}`} />
        <span className="bg-amber-400" style={{ width: part(row.held) }} title={`Awaiting payment ${units(row.held)}`} />
        <span className="bg-red-500" style={{ width: part(row.lost) }} title={`Lost ${units(row.lost)}`} />
        <span className="bg-violet-400" style={{ width: part(row.sent) }} title={`Sent to other godowns ${units(row.sent)}`} />
        <span className="bg-sky-300" style={{ width: part(row.available) }} title={`Available ${units(row.available)}`} />
      </div>
      <p className="mt-1 text-xs text-slate">{`${units(row.sold)} sold${row.sent ? ` · ${units(row.sent)} sent to other godowns` : ""} · ${units(row.available)} left · ${row.sellThrough}%`}</p>
    </div>
  );
}

function ZohoBadge({ row }: { row: BatchReportRow }) {
  if (row.batch.stage === "incoming")
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">No bill yet</span>;
  if (row.batch.stage === "cancelled")
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate">Cancelled</span>;
  if (row.batch.bill_flag)
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800" title={row.batch.bill_flag}>Bill changed</span>;
  if (row.batch.zoho_bill_id)
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800" title={costBasisName(row.batch)}>{`Bill ${row.batch.zoho_bill_number || row.batch.purchase_ref}`}</span>;
  if (!row.batch.zoho_batch_id)
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate">{row.batch.zoho_adjustment_id ? "Zoho stock" : "Website"}</span>;
  if (row.zohoGap !== null && Math.abs(row.zohoGap) > 0.001)
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800" title="Zoho's batch balance differs from the website">{`Zoho ${row.zohoGap > 0 ? "+" : ""}${units(row.zohoGap)}`}</span>;
  return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Zoho batch ✓</span>;
}

// ------------------------------------------------------------------ step 3 + 4: batch, order, customer

function BatchDetail({ row, report, data, adjustments, orderId, go, onEdit, onDeleted, onChanged, onMatch }: {
  row: BatchReportRow; report: BatchReport; data: BatchData; adjustments: BatchAdjustment[]; orderId?: string | undefined;
  go: (next: Partial<Search>) => void; onEdit: () => void; onDeleted: () => Promise<void>; onChanged: () => Promise<void>;
  onMatch: (godown?: string, billId?: string) => void;
}) {
  // A pre-order batch (waiting for its bill): it is edited, matched or cancelled as a pre-order, never sent or counted.
  const isLot = row.batch.stage === "incoming";
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  // Transfers this batch is part of: the one that made it, and the ones it sent.
  const myTransfers = data.transfers.filter((t) => t.parent_batch_id === row.batch.id || t.id === row.batch.transfer_id);
  const parent = row.batch.parent_batch_id ? data.batches.find((b) => b.id === row.batch.parent_batch_id) : undefined;
  const children = data.batches.filter((b) => b.parent_batch_id === row.batch.id);
  // The transfer that brought this batch here, and those still on their way from it.
  const arrival = data.transfers.find((t) => t.id === row.batch.transfer_id && t.kind === "split");
  const onTheWay = myTransfers.filter((t) => t.parent_batch_id === row.batch.id && t.status === "in_transit");
  const product = data.products.find((p) => p.id === row.batch.product_id);
  const canSend = !isLot && row.batch.stage !== "cancelled" && row.available > 0 && Boolean(product?.zohoLinked) && !product?.zohoTracksBatches
    && data.godowns.some((g) => g.active && g.zohoLinked && g.id !== row.batch.branch_id)
    && Boolean(data.godowns.find((g) => g.id === row.batch.branch_id)?.zohoLinked);
  const [deleting, setDeleting] = useState(false);
  // The same rule as admin_delete_batch in the database, which has the last word.
  const batchAllocations = data.allocations.filter((a) => a.batch_id === row.batch.id);
  const orderOf = (allocation: { order_item_id?: string }) => {
    const item = data.items.find((candidate) => candidate.id === allocation.order_item_id);
    return item ? data.orders.find((order) => order.id === item.order_id) : undefined;
  };
  const deleteBlocker = batchDeleteBlocker(row.batch, batchAllocations,
    adjustments.filter((a) => a.batch_id === row.batch.id).length, orderOf,
    // Any transfer that names it as the super batch keeps it, even a cancelled one (as admin_delete_batch).
    Boolean(row.batch.transfer_id || row.batch.parent_batch_id || myTransfers.some((t) => t.parent_batch_id === row.batch.id)),
    // Expenses tagged to it stay for the profit: untag them first (spec 14.25).
    { tagged: data.costTags.some((t) => t.batch_id === row.batch.id) });
  const remove = async (): Promise<void> => {
    setDeleting(true);
    const { data: gone, error } = await supabase.rpc("admin_delete_batch", { _batch_id: row.batch.id });
    setDeleting(false);
    if (error) return void toast.error("Could not delete the batch", { description: error.message });
    const adjustment = String((gone as { zoho_adjustment_id?: string } | null)?.zoho_adjustment_id ?? "");
    toast.success(`Batch ${row.batch.batch_code} deleted`, {
      description: adjustment
        ? `Stock is unchanged. This batch once posted a Zoho stock adjustment (${row.batch.batch_code}); delete that adjustment in Zoho yourself if it is still there.`
        : "Stock is unchanged.",
      duration: adjustment ? 15000 : 5000,
    });
    setConfirmDelete(false);
    await onDeleted();
  };
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
      {billGone(b.bill_flag) && !b.parent_batch_id && <RelinkBill row={row} onChanged={onChanged} />}
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
            {b.cost_basis
              ? <span>{`Cost without GST: ${money(costBeforeGst(b))} per unit`}</span>
              : <span>{`Cost typed in: ${money(b.unit_cost)} per unit`}</span>}
            {costWithGst(b) !== null && <span>{`With GST ${money(costWithGst(b)!)}`}</span>}
            {b.received_by_name && <span>{`Received by ${b.received_by_name}`}</span>}
            {b.source === "zoho" && <span>Made in Zoho</span>}
            {b.expiry_date && <span>{`Expiry ${day(b.expiry_date)}`}</span>}
          </p>
          {parent && (
            <p className="mt-1 text-xs text-slate">Sent here from batch{" "}
              <button type="button" className="font-mono font-semibold text-navy hover:underline" onClick={() => go({ batch: parent.id, order: undefined })}>{parent.batch_code}</button>
              {` (${data.godowns.find((g) => g.id === parent.branch_id)?.name ?? "another godown"}). `}
              {arrival ? transferProgress(arrival) : ""}
            </p>
          )}
          {onTheWay.map((t) => (
            <p key={t.id} className="mt-1 text-xs font-semibold text-sky-900">
              {`On the way to ${t.to_name ?? "another godown"}: ${t.quantity ?? ""} (${t.transfer_no}). ${transferProgress(t)}`}
            </p>
          ))}
          {children.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate">
              <span>Sent to other godowns as</span>
              {children.map((c) => (
                <button key={c.id} type="button" className="font-mono font-semibold text-navy hover:underline" onClick={() => go({ batch: c.id, order: undefined })}>
                  {`${c.batch_code} (${data.godowns.find((g) => g.id === c.branch_id)?.name ?? c.branch_id}, ${units(c.quantity)})`}
                </button>
              ))}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <ZohoBadge row={row} />
          {canSend && (
            <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={() => setSendOpen(true)}><ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />Send to other godowns</Button>
          )}
          {isLot
            ? <span className="max-w-[220px] text-right text-[11px] text-slate">Edit pre-order below</span>
            : row.batch.stage !== "cancelled" && <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="mr-1.5 h-3.5 w-3.5" />Edit details</Button>}
          {deleteBlocker
            ? <p className="max-w-[220px] text-right text-[11px] text-slate">{deleteBlocker}</p>
            : <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => setConfirmDelete(true)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete batch</Button>}
        </div>
      </div>

      {isLot && <PreorderPanel batch={b} data={data} onChanged={onChanged} onMatch={onMatch} />}
      {b.stage === "cancelled" && (
        <p className="rounded-md border border-border bg-slate-50 p-3 text-sm text-slate">{`Pre-order cancelled${b.closed_at ? ` on ${day(istDate(b.closed_at))}` : ""}${b.closed_note ? `: ${b.closed_note}` : ""}.`}</p>
      )}
      <MatchedLotNote batch={b} data={data} onChanged={onChanged} />
      {b.bill_flag && (
        <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{`${b.bill_flag}. This batch was not changed: check bill ${b.zoho_bill_number || b.purchase_ref} in Zoho and decide what to do with the batch.`}</span>
        </p>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{`Delete batch ${b.batch_code}?`}</DialogTitle>
            <DialogDescription>{batchAllocations.length > 0
              ? "Its only orders were cancelled or expired, and every unit came back. Deleting it removes the batch record, and those orders no longer show this batch number. Stock does not change, here or in Zoho."
              : "Nothing has been sold or reserved from it. Deleting it removes only the batch record: stock does not change, here or in Zoho."}</DialogDescription>
          </DialogHeader>
          {b.zoho_adjustment_id && (
            <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {`This batch was received the old way and posted a Zoho stock adjustment (reference ${b.batch_code}). The website does not delete anything in Zoho: delete that adjustment in Zoho yourself if it is still there.`}
            </p>
          )}
          {b.zoho_bill_id && <p className="text-xs text-slate">{`Bill ${b.zoho_bill_number || b.purchase_ref} stays in Zoho; its line can be made into a batch again.`}</p>}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Keep it</Button>
            <Button className="bg-red-700 text-white hover:bg-red-800" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete batch"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Panel title="Stock flow">
        <div className="grid gap-4 p-4">
          <FlowBar row={row} large />
          <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
            {row.received > 0
              ? <Figure label="Received from another godown" value={units(row.received)} />
              : <Figure label="Purchased" value={units(row.purchased)} />}
            <Figure label="Sold" value={units(row.sold)} tone="good" />
            <Figure label="Delivered" value={units(row.delivered)} />
            <Figure label="Awaiting payment" value={units(row.held)} />
            <Figure label="Lost" value={units(row.lost)} tone={row.lost > 0 ? "bad" : undefined} />
            <Figure label="Available" value={units(row.available)} />
          </div>
          {row.sent > 0 && (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-6">
              <Figure label="Sent to other godowns" value={units(row.sent)} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <Figure label="Purchase value (excl. GST)" value={money(row.purchaseValue)} />
            <Figure label="Sales (excl. GST)" value={money(row.sales)} />
            <Figure label="Cost of sold (excl. GST)" value={money(row.costOfSold)} />
            <Figure label="Stock lost (excl. GST)" value={money(row.lossValue)} tone={row.lossValue > 0 ? "bad" : undefined} />
            <Figure label={row.profit < 0 ? "Loss after expenses" : "Profit after expenses"} value={money(row.profit)} tone={row.profit < 0 ? "bad" : "good"} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Figure label={row.daysToSellOut === null ? "Days in stock" : "Days to sell out"} value={String(row.daysToSellOut ?? row.ageDays ?? "—")} />
            <Figure label="First sale" value={row.firstSale ? day(istDate(row.firstSale)) : "—"} />
            <Figure label={b.depleted_at && row.daysToSellOut === null ? "Emptied on" : "Sold out on"} value={b.depleted_at ? day(istDate(b.depleted_at)) : "—"} />
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

      <BatchProfitPanel row={row} report={report} />
      <BatchExpensesPanel row={row} report={report} data={data} onChanged={onChanged} />

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
                    <td className="px-3 py-2">{s.held ? heldLabel(s.holdUntil) : s.orderStatus}</td>
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

      {myTransfers.length > 0 && (
        <Panel title={`Transfers between godowns (${myTransfers.length})`}>
          <TransferList transfers={myTransfers} onChanged={onChanged} />
        </Panel>
      )}
      {sendOpen && (
        <SendToGodownsDialog open={sendOpen} onOpenChange={setSendOpen} batch={b} godowns={data.godowns} available={row.available} onDone={onChanged} />
      )}
    </div>
  );
}

/**
 * A batch whose bill was deleted or voided in Zoho (13 Nov 2026: "YET TO COME" was deleted to be entered again with its
 * real number): link it to the same purchase entered again, instead of making a second batch that would count the
 * units twice. Only a line of the same product and quantity; the cost becomes the new bill's (relink_batch_bill).
 */
function RelinkBill({ row, onChanged }: { row: BatchReportRow; onChanged: () => Promise<void> }) {
  const b = row.batch;
  const [open, setOpen] = useState(false);
  const [bills, setBills] = useState<{ billId: string; billNumber: string; vendorName: string; date: string; total: number }[] | null>(null);
  const [billId, setBillId] = useState("");
  const [lines, setLines] = useState<BatchBillLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const godown = b.branch_id ?? "";
  const loadBills = async () => {
    setProblem("");
    setBills(null);
    try {
      const { listBatchBills } = await import("@/lib/zoho-commerce.functions");
      setBills((await listBatchBills({ data: { branchId: godown } })).bills.filter((bill) => bill.billId !== b.zoho_bill_id));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not read bills from Zoho");
    }
  };
  const pickBill = async (id: string) => {
    setBillId(id);
    setLines(null);
    setProblem("");
    if (!id) return;
    try {
      const { getBatchBill } = await import("@/lib/zoho-commerce.functions");
      setLines((await getBatchBill({ data: { branchId: godown, billId: id } })).bill.lines);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not read the bill from Zoho");
    }
  };
  const link = async (line: BatchBillLine) => {
    setBusy(true);
    try {
      const { relinkBatchToBill } = await import("@/lib/zoho-commerce.functions");
      const done = await relinkBatchToBill({ data: { batchId: b.id, billId, lineId: line.lineId } });
      toast.success(`Batch ${done.batch_code} is now on bill ${done.new_bill}`, {
        description: Number(done.cost_before) !== Number(done.cost_now)
          ? `Its cost changed from ${money(Number(done.cost_before))} to ${money(Number(done.cost_now))} per unit, as on the new bill; its sales use the new cost.`
          : "Same cost as before. Its sales and stock stay as they were.",
        duration: 10000,
      });
      setOpen(false);
      await onChanged();
    } catch (cause) {
      toast.error("Could not link the batch", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  const candidates = (lines ?? []).filter((line) => line.productId === b.product_id);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="flex items-center gap-2 font-bold"><AlertTriangle className="h-4 w-4" />{b.bill_flag}: bill {b.zoho_bill_number || b.purchase_ref}</p>
      <p className="mt-1">
        If this purchase was entered again in Zoho (for example with the real bill number), link this batch to the new bill.
        Do not make a new batch from it: the units would be counted twice.
      </p>
      <Button size="sm" className="mt-3 bg-navy text-white hover:bg-navy/90" onClick={() => { setOpen(true); void loadBills(); }}>Link to the new bill</Button>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{`Link batch ${b.batch_code} to the new bill`}</DialogTitle>
            <DialogDescription>{`Choose the bill entered again in Zoho, then its ${b.product_name} line of ${units(b.quantity)}.`}</DialogDescription>
          </DialogHeader>
          {problem && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem}</p>}
          {!bills && !problem && <p className="text-sm text-slate">Reading bills from Zoho…</p>}
          {bills && (
            <select value={billId} onChange={(e) => void pickBill(e.target.value)} className="h-9 w-full rounded-md border border-input bg-white px-2 text-sm" aria-label="New bill">
              <option value="">Choose the bill</option>
              {bills.map((bill) => <option key={bill.billId} value={bill.billId}>{`${bill.billNumber} · ${bill.vendorName} · ${day(bill.date)} · ${money(bill.total)}`}</option>)}
            </select>
          )}
          {billId && !lines && !problem && <p className="text-sm text-slate">Reading the bill…</p>}
          {lines && (candidates.length === 0
            ? <p className="text-sm text-slate">{`This bill has no ${b.product_name} line.`}</p>
            : (
              <ul className="grid gap-2">
                {candidates.map((line) => {
                  const why = relinkBlocker(
                    { productId: b.product_id, quantity: b.quantity, billId: b.zoho_bill_id ?? "", billFlag: b.bill_flag ?? "" },
                    { productId: line.productId, qty: line.qty, batchCode: line.batchCode }, billId,
                  );
                  return (
                    <li key={line.lineId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                      <span>{`${line.name} · ${units(line.qty)} · ${money(line.unitExGst)} per unit before GST`}</span>
                      {why
                        ? <span className="text-xs text-danger">{why}</span>
                        : <Button size="sm" disabled={busy} className="bg-navy text-white hover:bg-navy/90" onClick={() => void link(line)}>{busy ? "Linking…" : "Link"}</Button>}
                    </li>
                  );
                })}
              </ul>
            ))}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          <p className="text-slate">{when(sale.orderDate)} · <span className="font-semibold text-charcoal">{sale.held ? heldLabel(sale.holdUntil) : sale.orderStatus}</span></p>
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

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={cn("grid gap-1 text-xs font-semibold text-slate", wide && "sm:col-span-2")}>{label}{children}</label>;
}

function EditDialog({ row, onClose, onSaved }: { row: BatchReportRow; onClose: () => void; onSaved: () => Promise<void> }) {
  const b = row.batch;
  const [form, setForm] = useState({ unitCost: String(b.unit_cost), supplier: b.supplier, purchaseRef: b.purchase_ref, notes: b.notes, mfgDate: b.mfg_date ?? "", expiryDate: b.expiry_date ?? "" });
  const [busy, setBusy] = useState(false);
  // A batch made from a Zoho bill takes its cost, supplier and bill number from the bill.
  const fromBill = Boolean(b.zoho_bill_id);
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
          <DialogDescription>{fromBill
            ? `Cost, supplier and bill number come from bill ${b.zoho_bill_number || b.purchase_ref} (${costBasisName(b).toLowerCase()}). Correct the bill in Zoho to change them.`
            : "Quantities change only through orders and stock counts. A new cost also updates the profit of sales already made."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={fromBill ? "Purchase cost per unit (₹)" : "Purchase cost per unit, without GST (₹)"}><Input type="number" min="0" step="0.01" value={form.unitCost} onChange={set("unitCost")} disabled={fromBill} /></Field>
          <Field label="Supplier"><Input value={form.supplier} onChange={set("supplier")} disabled={fromBill} /></Field>
          <Field label="Bill / PO no."><Input value={form.purchaseRef} onChange={set("purchaseRef")} disabled={fromBill} /></Field>
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
    generatedAt: now, zohoStockMaster: true, zohoStock: { at: now, read: true, items: 18, failed: 0, error: "" }, godowns, transfers: [],
    products: [{ id: "P023", name: "Groundnut Oil 5L Can", sku: "SBV-OI-1022", unit: "", purchasePrice: 820, zohoLinked: true, zohoTracksBatches: true, stock: { "BR-CLK": 30 }, weightKg: null }],
    // Expenses (14 Nov 2026): lorry freight on the oil batch, and hamali paid ahead on the sugar pre-order.
    costDocuments: [
      { id: 1, source: "expense", zoho_id: "E1", zoho_line_id: "", doc_number: "EXP-00131", doc_date: "2026-10-30", account_id: "", account_name: "Transportation Charges Freight Charges",
        vendor_name: "", description: "Lorry freight", amount_before_gst: 1500, gst_amount: 0, gst_claimable: true, gst_override: null, reverse_charge: false, rebilled: false,
        cost_amount: 1500, accepted_cost_amount: 1500, zoho_status: "nonbillable", zoho_modified: "", flag: "", flag_at: null, gone_at: null, checked_at: null },
      { id: 2, source: "expense", zoho_id: "E2", zoho_line_id: "", doc_number: "EXP-00132", doc_date: todayIst(), account_id: "", account_name: "Amali Charges - Loading and Unloading",
        vendor_name: "", description: "Hamali, 360 bags", amount_before_gst: 1800, gst_amount: 0, gst_claimable: true, gst_override: null, reverse_charge: false, rebilled: false,
        cost_amount: 1800, accepted_cost_amount: 1800, zoho_status: "nonbillable", zoho_modified: "", flag: "", flag_at: null, gone_at: null, checked_at: null },
    ],
    costTags: [
      { id: 1, document_id: 1, batch_id: "b2", amount: 1500, method: "bags", weight: 50, note: "", tagged_by_name: "Head office", tagged_at: now },
      { id: 2, document_id: 2, batch_id: "b4", amount: 1800, method: "bags", weight: 360, note: "", tagged_by_name: "Head office", tagged_at: now },
    ],
    batches: [
      batch("b1", "CLK-201026-01", "BR-CLK", "P023", "Groundnut Oil 5L Can", 50, 0, 800, "2026-10-20", "2026-10-29T08:00:00Z"),
      batch("b2", "CLK-301026-01", "BR-CLK", "P023", "Groundnut Oil 5L Can", 50, 30, 820, "2026-10-30", null),
      batch("b3", "HBL-251026-01", "BR-HBL", "P023", "Groundnut Oil 5L Can", 40, 25, 810, "2026-10-25", null),
      // A pre-order batch: 360 bags of Sugar S1 expected in a week, 20 sold ahead.
      { ...batch("b4", "CLK-141126-01", "BR-CLK", "P001", "Sugar S1", 360, 340, 2500, todayIst(), null), stage: "incoming", expected_quantity: 360,
        expected_date: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10), hold_back: 0, selling_paused: false, paused_reason: "",
        est_unit_cost_ex_gst: 2500, zoho_po_number: "PO-00031", supplier: "Sri Sugars" },
    ],
    allocations: [
      { id: "a1", order_item_id: "i1", batch_id: "b1", reserved_quantity: 48, released_quantity: 0, unit_cost: 800, created_at: now },
      { id: "a2", order_item_id: "i2", batch_id: "b2", reserved_quantity: 20, released_quantity: 0, unit_cost: 820, created_at: now },
      { id: "a3", order_item_id: "i3", batch_id: "b3", reserved_quantity: 15, released_quantity: 0, unit_cost: 810, created_at: now },
      { id: "a4", order_item_id: "i4", batch_id: "b4", reserved_quantity: 20, released_quantity: 0, unit_cost: 2500, created_at: now },
    ],
    items: [
      { id: "i1", order_id: "o1", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 48, unit_price: 949, gst_rate: 5 },
      { id: "i2", order_id: "o2", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 20, unit_price: 949, gst_rate: 5 },
      { id: "i3", order_id: "o3", product_id: "P023", product_name: "Groundnut Oil 5L Can", qty: 15, unit_price: 955, gst_rate: 5 },
      { id: "i4", order_id: "o4", product_id: "P001", product_name: "Sugar S1", qty: 70, unit_price: 2741, gst_rate: 5 },
    ],
    orders: [
      { id: "o1", order_no: "CLK-577522-251026-101500", created_at: "2026-10-25T04:45:00Z", order_status: "Delivered", payment_status: "Paid", branch_id: "BR-CLK", user_id: "u1", customer_name: "Ravi Traders", customer_email: "ravi@example.com", customer_phone: "9876500011", shipping_address: { line1: "Main Road", city: "Challakere", pin: "577522" }, subtotal: 45552, discount: 0 },
      { id: "o2", order_no: "CLK-577522-301026-121000", created_at: "2026-10-30T06:40:00Z", order_status: "Packed", payment_status: "Paid", branch_id: "BR-CLK", user_id: "u2", customer_name: "Lakshmi Stores", customer_email: "", customer_phone: "9876500022", shipping_address: { line1: "Market", city: "Challakere", pin: "577522" }, subtotal: 18980, discount: 0 },
      { id: "o3", order_no: "HBL-580020-281026-093000", created_at: "2026-10-28T04:00:00Z", order_status: "Delivered", payment_status: "Paid", branch_id: "BR-HBL", user_id: "u1", customer_name: "Ravi Traders", customer_email: "ravi@example.com", customer_phone: "9876500011", shipping_address: { line1: "Station Road", city: "Hubli", pin: "580020" }, subtotal: 14325, discount: 0 },
    ],
    adjustments: [{ id: "x1", batch_id: "b1", qty: -2, reason: "damaged", note: "2 cans leaked", unit_cost: 800, created_at: "2026-10-27T10:00:00Z", created_by_name: "Manju" }],
    reservedCodes: [],
    preorder: {
      settings: { enabled: true, graceDays: 0, requireAck: true },
      watches: [{ branch_id: "BR-CLK", product_id: "P001", zoho_last: 50, held: 0, held_since: null, opened_at: now, read_at: now, last_waiting: 70, last_unbilled: 360, last_raw: 0, updated_at: now, pending_delta: 0 }],
      stock: [{ branch_id: "BR-CLK", product_id: "P001", stock: 0, free_total: 340, incoming: 340, incoming_detail: [], zoho_pending: false }],
      events: [],
    },
  } as unknown as BatchData;
}

// ------------------------------------------------------------------ pre-order batches (14 Nov 2026, src/lib/preorder.ts)

/** Badges of a batch in the list: a pre-order and its state, a remainder, one made from a pre-order. */
function LotTags({ batch, data }: { batch: BatchData["batches"][number]; data: BatchData }) {
  const clock = clockOf(data);
  const tags: { text: string; tone: "amber" | "red" | "slate" | "sky" }[] = [];
  if (batch.stage === "incoming") {
    const lot = lotOf(batch);
    tags.push({ text: lotLabel(lot, clock.todayIst), tone: "amber" });
    if (lotOverdue(lot, clock)) tags.push({ text: "Overdue", tone: "red" });
    if (batch.selling_paused) tags.push({ text: batch.paused_reason === "receiving" ? "Paused while receiving" : "Paused", tone: "slate" });
    if ((watchOf(data, batch.branch_id, batch.product_id)?.held ?? 0) > 0) tags.push({ text: "Zoho rise held", tone: "red" });
  } else if (batch.stage === "cancelled") {
    tags.push({ text: "Cancelled pre-order", tone: "slate" });
  } else if (batch.expected_quantity !== null && batch.expected_quantity !== undefined) {
    tags.push({ text: `From pre-order · bill ${batch.zoho_bill_number || batch.purchase_ref}`, tone: "sky" });
  }
  if (batch.split_from_batch_id) tags.push({ text: `The rest of ${data.batches.find((b) => b.id === batch.split_from_batch_id)?.batch_code ?? "a pre-order"}`, tone: "sky" });
  if (!tags.length) return null;
  const tone = { amber: "bg-amber-100 text-amber-900", red: "bg-red-100 text-red-800", slate: "bg-slate-100 text-slate", sky: "bg-sky-100 text-sky-900" };
  return (
    <span className="mt-1 flex flex-wrap gap-1 font-sans">
      {tags.map((t) => <span key={t.text} className={cn("whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold", tone[t.tone])}>{t.text}</span>)}
    </span>
  );
}

/** A pre-order's units: expected, sold ahead, held at the godown, open to pre-order, held back. */
function LotFlowBar({ batch, data }: { batch: BatchData["batches"][number]; data: BatchData }) {
  const clock = clockOf(data);
  const lot = lotOf(batch);
  const sold = Math.max(0, batch.quantity - batch.remaining_quantity);
  const open = lotSellable(lot, clock);
  const holdBack = Math.min(batch.hold_back ?? 0, batch.remaining_quantity);
  const held = Math.min(watchOf(data, batch.branch_id, batch.product_id)?.held ?? 0, batch.quantity);
  const total = Math.max(batch.quantity, 1);
  const part = (n: number) => `${Math.max(0, (n / total) * 100)}%`;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-amber-100">
        <span className="bg-emerald-500" style={{ width: part(sold) }} title={`Sold ahead ${units(sold)}`} />
        <span className="bg-sky-300" style={{ width: part(open) }} title={`Open to pre-order ${units(open)}`} />
        <span className="bg-slate-300" style={{ width: part(holdBack) }} title={`Held back ${units(holdBack)}`} />
      </div>
      <p className="mt-1 text-xs text-slate">
        {[`Expected ${units(batch.quantity)}`, `${units(sold)} sold`, `${units(open)} open`, ...(holdBack ? [`${units(holdBack)} held back`] : []), ...(held ? [`${units(held)} held in Zoho`] : [])]
          .map((part, index) => <span key={part}>{index ? " · " : ""}{part}</span>)}
      </p>
    </div>
  );
}

/** The pre-order alerts (spec 7.6), each clickable: units Zoho shows that the website can't explain, oversold, overdue. */
function PreorderAlerts({ data, go, onMatch }: { data: BatchData; go: (next: Partial<Search>) => void; onMatch: (godown?: string, billId?: string) => void }) {
  const clock = clockOf(data);
  const name = (productId: string) => data.products.find((p) => p.id === productId)?.name ?? productId;
  const godown = (id: string | null) => data.godowns.find((g) => g.id === id)?.name ?? id ?? "";
  const lotAt = (branchId: string | null, productId: string) => data.batches.find((b) => b.stage === "incoming" && b.branch_id === branchId && b.product_id === productId)
    ?? data.batches.find((b) => b.stage === "incoming" && b.product_id === productId);
  const alerts: { key: string; text: string; tone: "red" | "amber"; action: () => void; label: string }[] = [];
  for (const w of data.preorder.watches) {
    const lot = lotAt(w.branch_id, w.product_id);
    if (w.held > 0)
      alerts.push({ key: `held-${w.branch_id}-${w.product_id}`, tone: "amber", label: "Match now", action: () => onMatch(w.branch_id),
        text: `Zoho shows ${qtyText(w.held)} more ${name(w.product_id)} at ${godown(w.branch_id)} than the website counts${w.held_since ? ` (since ${when(w.held_since)})` : ""}. If it is the bill for pre-order batch ${lot?.batch_code ?? "(none here)"}, match it. Those bags are not on sale until then.` });
    if ((w.last_raw ?? 0) < 0)
      alerts.push({ key: `over-${w.branch_id}-${w.product_id}`, tone: "red", label: "Open", action: () => (lot ? go({ tab: undefined, batch: lot.id }) : go({ tab: "preorders" })),
        text: `${name(w.product_id)} at ${godown(w.branch_id)}: ${qtyText(-(w.last_raw ?? 0))} units promised to customers are neither in stock nor on the way. Check pre-order batch ${lot?.batch_code ?? ""} and Zoho.` });
  }
  for (const b of data.batches) {
    if (b.stage !== "incoming" || !lotOverdue(lotOf(b), clock)) continue;
    const waiting = new Set(lotOrders(data, b.id).map((o) => o.orderNo)).size;
    alerts.push({ key: `due-${b.id}`, tone: "red", label: "Open", action: () => go({ tab: undefined, batch: b.id }),
      text: `Pre-order batch ${b.batch_code} was expected by ${dayLabel(b.expected_date, { full: true })} and has no bill. New pre-orders stopped; ${waiting} orders wait.` });
  }
  if (!alerts.length) return null;
  return (
    <div className="mb-4 grid gap-2">
      {alerts.map((a) => (
        <div key={a.key} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm",
          a.tone === "red" ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-950")}>
          <span className="flex min-w-0 flex-1 gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{a.text}</span></span>
          <Button size="sm" variant="outline" onClick={a.action}>{a.label}</Button>
        </div>
      ))}
    </div>
  );
}

/** Admin › Batches › Pre-orders: every pre-order batch waiting for its bill, then the recent closed ones. */
function PreorderList({ data, search, go, onNew }: { data: BatchData; search: Search; go: (next: Partial<Search>) => void; onNew: () => void }) {
  const clock = clockOf(data);
  const scoped = data.batches.filter((b) => (b.expected_quantity !== null && b.expected_quantity !== undefined) && (!search.godown || b.branch_id === search.godown));
  const open = scoped.filter((b) => b.stage === "incoming").sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? ""));
  const closed = scoped.filter((b) => b.stage !== "incoming").sort((a, b) => (b.matched_at ?? b.closed_at ?? "").localeCompare(a.matched_at ?? a.closed_at ?? "")).slice(0, 20);
  const godown = (id: string | null) => data.godowns.find((g) => g.id === id)?.name ?? "";
  return (
    <div className="grid min-w-0 gap-4">
      {!data.preorder.settings.enabled && (
        <p className="rounded-md border border-border bg-slate-50 p-3 text-sm text-slate">Pre-orders are switched off. Switch them on in Admin › Settings › Pre-orders to make pre-order batches.</p>
      )}
      <Panel title={`Pre-orders waiting for their bill (${open.length})`} action={<Button size="sm" variant="outline" onClick={onNew}><CalendarClock className="mr-1.5 h-3.5 w-3.5" />New pre-order</Button>}>
        {open.length === 0 ? <p className="text-sm text-slate">No pre-order batch is waiting. Press New pre-order when goods are ordered from a supplier.</p> : (
          <div className="grid gap-2">
            {open.map((b) => {
              const lot = lotOf(b);
              const waitingOrders = new Set(lotOrders(data, b.id).map((o) => o.orderNo)).size;
              return (
                <button key={b.id} type="button" onClick={() => go({ tab: undefined, batch: b.id })}
                  className="grid min-w-0 gap-1 rounded-lg border border-border bg-white p-3 text-left text-sm transition hover:border-gold">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-navy">{b.batch_code}</span>
                    <span className="flex flex-wrap gap-1">
                      {lotBadges(lot, clock, { held: watchOf(data, b.branch_id, b.product_id)?.held ?? 0 }).map((badge) => (
                        <span key={badge} className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">{badge}</span>
                      ))}
                    </span>
                  </span>
                  <span className="truncate">{`${b.product_name} · ${godown(b.branch_id)}`}</span>
                  <LotFlowBar batch={b} data={data} />
                  <span className="text-xs text-slate">{`Expected by ${dayLabel(b.expected_date, { full: true })} · ${waitingOrders} order${waitingOrders === 1 ? "" : "s"} waiting${b.zoho_po_number ? ` · PO ${b.zoho_po_number}` : ""}`}</span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>
      {closed.length > 0 && (
        <Panel title="Matched and cancelled pre-orders">
          <div className="grid gap-2">
            {closed.map((b) => (
              <button key={b.id} type="button" onClick={() => go({ tab: undefined, batch: b.id })} className="flex min-w-0 flex-wrap justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-gold">
                <span className="min-w-0 truncate"><span className="font-mono font-semibold text-navy">{b.batch_code}</span>{` · ${b.product_name} · ${godown(b.branch_id)}`}</span>
                <span className="text-xs text-slate">{b.stage === "cancelled" ? `Cancelled${b.closed_at ? ` ${day(istDate(b.closed_at))}` : ""}` : `Matched to bill ${b.zoho_bill_number || b.purchase_ref}${b.matched_at ? ` · ${day(istDate(b.matched_at))}` : ""}`}</span>
              </button>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
