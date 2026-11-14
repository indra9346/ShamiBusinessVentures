import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileText, IndianRupee, ReceiptText, RefreshCw, Scale, Split, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Panel, StatCard } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import { COST_STATUS_NAMES, costBeforeGst, costMethodName, type BatchExpenseRow, type BatchReport, type BatchReportRow } from "@/lib/batches";
import { NOT_BATCH_COST_NOTE, type StoredCostDoc } from "@/lib/batch-costs";
import { CostError, ExpensePickerDialog, SplitEditor, presetRange, type SplitDoc } from "@/components/batches/ExpensePicker";
import { BillChargesDialog } from "@/components/batches/BillChargesPicker";
import { cn } from "@/lib/utils";

/*
 * Admin › Batches: the expenses of a batch and of every batch (spec 8, 9.3, 10). A batch's profit and loss with its landed
 * cost and the cost check; the expenses tagged to it with Re-split, Accept and Untag; the Expenses tab with the flagged
 * documents first, every tagged document and the untagged Zoho expenses of a period (overhead).
 */

const money = (n: number) => inrPrecise(n);
const units = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const day = (iso: string | null | undefined) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const functions = () => import("@/lib/batch-costs.functions");

/** A stored document and its tags as the split editor takes it (Re-split). */
function storedSplitDoc(doc: StoredCostDoc, data: BatchData): SplitDoc {
  return {
    source: doc.source === "bill" ? "bill" : "expense", zohoId: doc.zoho_id, lineId: doc.zoho_line_id, label: doc.account_name || doc.description || doc.doc_number,
    date: doc.doc_date, account: doc.account_name, reference: doc.doc_number, beforeGst: doc.amount_before_gst, gst: doc.gst_amount, gstClaimable: doc.gst_claimable,
    gstOverride: doc.gst_override, rebilled: doc.rebilled, flag: doc.flag,
    tags: data.costTags.filter((t) => t.document_id === doc.id).map((t) => ({ batchId: t.batch_id, amount: t.amount })),
  };
}

/** Re-split, Accept Zoho's amount, Untag: for one document. */
function DocActions({ doc, data, onChanged }: { doc: StoredCostDoc; data: BatchData; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [resplit, setResplit] = useState(false);
  const tagged = Math.round(data.costTags.filter((t) => t.document_id === doc.id).reduce((sum, t) => sum + t.amount, 0) * 100) / 100;
  const current = doc.gone_at ? 0 : doc.cost_amount;
  const canAccept = Boolean(doc.flag) && Math.abs(tagged) <= Math.abs(current) + 0.004 && (tagged === 0 || Math.sign(tagged) === Math.sign(current));
  const run = async (what: "accept" | "untag") => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const costs = await functions();
      if (what === "accept") await costs.acceptCostChange({ data: { documentId: doc.id } });
      else await costs.untagBatchCosts({ data: { documentId: doc.id } });
      toast.success(what === "accept" ? "Zoho's amount accepted" : "Expense taken off its batches");
      await onChanged();
    } catch (cause) {
      toast.error(what === "accept" ? "Could not accept the change" : "Could not untag the expense", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {!doc.gone_at && <Button size="sm" variant="outline" disabled={busy} onClick={() => setResplit(true)}><Split className="mr-1 h-3.5 w-3.5" />Re-split</Button>}
      {canAccept && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("accept")}><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Accept Zoho's amount</Button>}
      {tagged !== 0 && <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy} onClick={() => void run("untag")}><Trash2 className="mr-1 h-3.5 w-3.5" />Untag</Button>}
      {resplit && (
        <Dialog open={resplit} onOpenChange={setResplit}>
          <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto overflow-x-hidden p-4 sm:p-6">
            <DialogHeader>
              <DialogTitle>Re-split the expense</DialogTitle>
              <DialogDescription>Zoho is read again; the new split replaces the old one.</DialogDescription>
            </DialogHeader>
            <SplitEditor data={data} doc={storedSplitDoc(doc, data)} presetBatchIds={[]} onCancel={() => setResplit(false)}
              onSaved={async () => { setResplit(false); await onChanged(); }} />
          </DialogContent>
        </Dialog>
      )}
    </span>
  );
}

/** The expense rows of a set of tags, one row per document (a document tagged to several batches shows them together). */
function byDocument(rows: BatchExpenseRow[]) {
  const groups = new Map<number, BatchExpenseRow[]>();
  for (const row of rows) groups.set(row.documentId, [...(groups.get(row.documentId) ?? []), row]);
  return [...groups.values()];
}

function DocumentList({ rows, data, onChanged, batchId }: { rows: BatchExpenseRow[]; data: BatchData; onChanged: () => Promise<void>; batchId?: string | undefined }) {
  const docs = new Map(data.costDocuments.map((d) => [d.id, d]));
  const groups = byDocument(rows).sort((a, b) => Number(Boolean(b[0]!.flag || b[0]!.gone)) - Number(Boolean(a[0]!.flag || a[0]!.gone)));
  if (!groups.length) return <p className="text-sm text-slate">No expenses tagged.</p>;
  return (
    <ul className="grid gap-2">
      {groups.map((group) => {
        const first = group[0]!;
        const doc = docs.get(first.documentId);
        const here = batchId ? group.filter((g) => g.batchId === batchId) : group;
        return (
          <li key={first.documentId} className={cn("grid min-w-0 gap-1 rounded-md border p-3 text-sm", first.flag || first.gone ? "border-amber-300 bg-amber-50/60" : "border-border bg-white")}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="font-semibold text-navy">{first.source === "bill" ? <FileText className="mr-1 inline h-3.5 w-3.5" /> : <ReceiptText className="mr-1 inline h-3.5 w-3.5" />}{first.account || first.description || "Expense"}</span>
                <span className="block text-xs text-slate">{[day(first.date), first.reference, first.source === "bill" ? "Supplier bill" : "Zoho Books expense"].filter(Boolean).join(" · ")}</span>
              </span>
              {doc && <DocActions doc={doc} data={data} onChanged={onChanged} />}
            </div>
            <p className="text-xs">{`Zoho before GST ${money(first.beforeGst)} · GST ${money(first.gst)} (${first.claimable ? "claimed back" : "not claimable, a cost"}) · cost ${money(first.gone ? 0 : first.cost)}`}</p>
            {/* One text per batch, so each reads in Kannada too. */}
            <p className="flex flex-wrap gap-x-3 text-xs text-slate">
              {here.map((g) => (
                <span key={g.tagId}>{g.effective !== g.tagged
                  ? `${g.batchCode}: ${money(g.tagged)} tagged, counts ${money(g.effective)} (${costMethodName(g.method)})`
                  : `${g.batchCode}: ${money(g.tagged)} tagged (${costMethodName(g.method)})`}</span>
              ))}
              {batchId && group.length > here.length && <span>{`and ${group.length - here.length} other batch${group.length - here.length === 1 ? "" : "es"}`}</span>}
            </p>
            {(first.flag || first.gone) && (
              <p className="flex gap-1.5 text-xs font-semibold text-amber-900"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {`${first.flag || "Expense deleted in Zoho"}. Profit uses at most Zoho's amount until you re-split or accept it.`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Batch detail: its profit and loss before GST, with expenses and landed cost (spec 9.3). */
export function BatchProfitPanel({ row }: { row: BatchReportRow }) {
  const b = row.batch;
  const lot = b.stage === "incoming";
  const expenses = Math.round((row.expenseValue + row.inheritedExpenseValue) * 100) / 100;
  const line = (label: string, value: number, tone?: "good" | "bad", strong?: boolean) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-0">
      <span className={cn("text-slate", strong && "font-semibold text-charcoal")}>{label}</span>
      <span className={cn("font-semibold", tone === "good" && "text-emerald-700", tone === "bad" && "text-red-700")}>{money(value)}</span>
    </div>
  );
  return (
    <Panel title="Profit and loss (before GST)">
      <div className="grid gap-4 text-sm lg:grid-cols-2">
        <div>
          {line("Sales", row.sales)}
          {line(lot ? "Cost of sold (estimate)" : "Cost of sold (bill cost)", -row.costOfSold)}
          {row.lossValue !== 0 && line(row.lossValue < 0 ? "Stock found" : "Stock lost", -row.lossValue)}
          {line("Profit before expenses", row.profitBeforeExpenses, row.profitBeforeExpenses < 0 ? "bad" : "good")}
          {line("Expenses on sold", -row.expenseOnSoldValue)}
          {row.expenseOnLostValue !== 0 && line("Expenses on lost", -row.expenseOnLostValue)}
          {line("Profit after expenses", row.profit, row.profit < 0 ? "bad" : "good", true)}
          {lot && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">{`${COST_STATUS_NAMES.estimated}: costed with the estimate ${money(costBeforeGst(b))} per unit until the bill is matched.`}</p>}
          {row.costVarianceValue !== 0 && (
            <p className="mt-1 text-xs text-slate">{`Cost variance on sold: ${money(row.costVarianceValue)} (bill ${money(costBeforeGst(b))} vs estimate ${money(b.est_unit_cost_ex_gst ?? 0)} per unit)`}</p>
          )}
        </div>
        <div>
          {line("Expenses tagged here", row.expenseValue)}
          {row.inheritedExpenseValue !== 0 && line("Expenses that came with its units", row.inheritedExpenseValue)}
          {line("Expense per unit", row.expensePerUnit)}
          {line("Landed cost per unit", row.landedUnitCost, undefined, true)}
          {line("Expenses in unsold stock", row.expenseInStockValue)}
          {row.expenseOnHeldValue !== 0 && line("Expenses on units awaiting payment", row.expenseOnHeldValue)}
          {row.expenseOnSentValue !== 0 && line("Expenses sent with units to other godowns", row.expenseOnSentValue)}
          {row.expenseInTransitValue !== 0 && line("Of which on units still on the way", row.expenseInTransitValue)}
          {line("Unsold stock at landed cost", row.landedStockValue)}
          <p className={cn("mt-1 text-xs", row.ledgerGap === 0 && Math.abs(row.costCheckGap) <= 0.05 ? "text-emerald-700" : "text-amber-800")}>
            {row.ledgerGap === 0 && Math.abs(row.costCheckGap) <= 0.05
              ? `Cost check: every rupee of purchase and expenses (${money(expenses)}) is in sold, lost, sent or unsold stock.`
              : row.ledgerGap !== 0
                ? `Cost check: off by ${money(row.costCheckGap)}, which is the ledger gap of ${units(row.ledgerGap)} units at ${money(row.landedUnitCost)}.`
                : `Cost check: off by ${money(row.costCheckGap)} (orders copied another cost than the batch's).`}
          </p>
        </div>
      </div>
    </Panel>
  );
}

/** Batch detail: the expenses tagged to this batch, Add from Zoho Books and Bill charges. */
export function BatchExpensesPanel({ row, report, data, onChanged }: { row: BatchReportRow; report: BatchReport; data: BatchData; onChanged: () => Promise<void> }) {
  const [picker, setPicker] = useState(false);
  const [charges, setCharges] = useState(false);
  const rows = report.expenses.filter((e) => e.batchId === row.batch.id);
  const cancelled = row.batch.stage === "cancelled";
  return (
    <Panel title={`Expenses (${byDocument(rows).length})`} action={cancelled ? undefined : (
      <>
        <Button size="sm" variant="outline" onClick={() => setPicker(true)}><ReceiptText className="mr-1.5 h-3.5 w-3.5" />Add from Zoho Books</Button>
        <Button size="sm" variant="outline" onClick={() => setCharges(true)}><FileText className="mr-1.5 h-3.5 w-3.5" />Bill charges</Button>
      </>
    )}>
      <div className="grid gap-2">
        {row.inheritedExpenseValue !== 0 && (
          <p className="text-xs text-slate">{`${money(row.inheritedExpenseValue)} of expenses came with the units sent here from another godown's batch.`}</p>
        )}
        {cancelled ? <p className="text-sm text-slate">A cancelled pre-order takes no expenses.</p> : <DocumentList rows={rows} data={data} onChanged={onChanged} batchId={row.batch.id} />}
      </div>
      {picker && <ExpensePickerDialog open={picker} onOpenChange={setPicker} data={data} presetBatchIds={[row.batch.id]} onSaved={onChanged} />}
      {charges && <BillChargesDialog open={charges} onOpenChange={setCharges} data={data} presetBatchIds={[row.batch.id]} defaultGodown={row.batch.branch_id ?? undefined}
        initialBillId={row.batch.zoho_bill_id || undefined} onSaved={onChanged} />}
    </Panel>
  );
}

type ListRow = Awaited<ReturnType<typeof import("@/lib/batch-costs.functions")["listZohoExpenses"]>>["rows"][number];

/** Admin › Batches › Expenses: everything tagged (flagged first) and the Zoho expenses of a period nobody tagged (overhead). */
export function ExpensesOverview({ report, data, godownId, onChanged }: { report: BatchReport; data: BatchData; godownId?: string | undefined; onChanged: () => Promise<void> }) {
  const scope = godownId ? report.rows.filter((r) => r.batch.branch_id === godownId) : report.rows;
  const ids = new Set(scope.map((r) => r.batch.id));
  const rows = report.expenses.filter((e) => ids.has(e.batchId));
  const sum = (key: "expenseValue" | "expenseOnSoldValue" | "expenseInStockValue" | "expenseInTransitValue" | "expenseOnLostValue") =>
    Math.round(scope.reduce((total, r) => total + r[key], 0) * 100) / 100;
  const flagged = byDocument(rows).filter((g) => g[0]!.flag || g[0]!.gone).length;
  const [picker, setPicker] = useState<{ open: boolean; expenseId?: string | undefined }>({ open: false });
  const [charges, setCharges] = useState(false);
  const range = presetRange(data, []);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [untagged, setUntagged] = useState<ListRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const loadUntagged = async () => {
    setLoading(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { setUntagged([]); return; }
      const { listZohoExpenses } = await functions();
      const all: ListRow[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const answer = await listZohoExpenses({ data: { from, to, search: "", page } });
        all.push(...answer.rows);
        if (!answer.hasMore) break;
      }
      setUntagged(all.filter((r) => Math.abs(r.tagged) < Math.abs(r.beforeGst) - 0.004));
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  // A channel partner's commission is not a batch cost (owner's rule): shown apart, never in the overhead.
  const commission = (untagged ?? []).filter((r) => r.notBatchCost);
  const overheadRows = (untagged ?? []).filter((r) => !r.notBatchCost);
  const overhead = Math.round(overheadRows.reduce((total, r) => total + Math.max(0, r.beforeGst - r.tagged), 0) * 100) / 100;
  const commissionTotal = Math.round(commission.reduce((total, r) => total + r.beforeGst, 0) * 100) / 100;
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard compact label="Expenses tagged" value={money(sum("expenseValue"))} icon={IndianRupee} description={`${byDocument(rows).length} Zoho documents on ${new Set(rows.map((r) => r.batchId)).size} batches`} />
        <StatCard compact label="On sold units" value={money(sum("expenseOnSoldValue") + sum("expenseOnLostValue"))} icon={Scale} description="in profit after expenses (sold and lost)" />
        <StatCard compact label="In unsold stock" value={money(sum("expenseInStockValue") + sum("expenseInTransitValue"))} icon={Scale} description="stays with the stock until it sells" />
        <StatCard compact label="Changed in Zoho" value={String(flagged)} icon={AlertTriangle} description={flagged ? "re-split or accept below" : "nothing to review"} />
      </div>
      <Panel title="Tagged expenses" action={(
        <>
          <Button size="sm" variant="outline" onClick={() => setPicker({ open: true })}><ReceiptText className="mr-1.5 h-3.5 w-3.5" />Add from Zoho Books</Button>
          <Button size="sm" variant="outline" onClick={() => setCharges(true)}><FileText className="mr-1.5 h-3.5 w-3.5" />Bill charges</Button>
        </>
      )}>
        <DocumentList rows={rows} data={data} onChanged={onChanged} />
      </Panel>
      <Panel title="Zoho expenses not tagged to a batch (overhead)">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-semibold text-slate">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="grid gap-1 text-xs font-semibold text-slate">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadUntagged()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Show untagged expenses</Button>
          </div>
          <CostError text={problem} />
          {untagged && <p className="text-sm font-semibold">{`${overheadRows.length} expenses · ${money(overhead)} before GST not on any batch`}</p>}
          {commission.length > 0 && <p className="text-xs text-slate">{`${NOT_BATCH_COST_NOTE}: ${money(commissionTotal)} left out`}</p>}
          {untagged && overheadRows.map((r) => (
            <button key={r.expenseId} type="button" onClick={() => setPicker({ open: true, expenseId: r.expenseId })}
              className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 rounded-md border border-border bg-white px-3 py-2 text-left text-sm hover:border-gold">
              <span className="truncate font-semibold text-navy">{r.account || "Expense"}</span>
              <span className="text-right font-semibold">{money(Math.max(0, r.beforeGst - r.tagged))}</span>
              <span className="truncate text-xs text-slate">{[day(r.date), r.number, r.description].filter(Boolean).join(" · ")}</span>
              <span className="text-right text-xs text-slate">{r.tagged ? `of ${money(r.beforeGst)}` : ""}</span>
            </button>
          ))}
        </div>
      </Panel>
      {picker.open && <ExpensePickerDialog open={picker.open} onOpenChange={(open) => setPicker({ open })} data={data} presetBatchIds={[]} initialExpenseId={picker.expenseId}
        onSaved={async () => { await onChanged(); if (untagged) void loadUntagged(); }} />}
      {charges && <BillChargesDialog open={charges} onOpenChange={setCharges} data={data} presetBatchIds={[]} defaultGodown={godownId} onSaved={onChanged} />}
    </div>
  );
}
