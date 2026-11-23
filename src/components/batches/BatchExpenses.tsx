import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileText, IndianRupee, Pencil, Plus, ReceiptText, RefreshCw, Scale, Split, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Panel, StatCard } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import { COST_STATUS_NAMES, costBeforeGst, costMethodName, type BatchExpenseRow, type BatchReport, type BatchReportRow } from "@/lib/batches";
import { COST_CATEGORIES, COST_KIND_NAMES, DEFAULT_COST_KIND, NOT_BATCH_COST_NOTE, costCategoryName, costCategoryOf, costKindOf, manualExpenseCost, manualExpenseProblem, type CostKind, type StoredCostDoc } from "@/lib/batch-costs";
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

/**
 * Cost of goods sold or operating expense (client, 18 Nov 2026): its type's default (transport and hamali are cost of
 * goods), or set either way for this expense. Changes only where the P&L shows it, not the profit after all expenses.
 */
function KindPicker({ doc, onChanged }: { doc: StoredCostDoc; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const kind = costKindOf(doc);
  const chosen = doc.cost_kind === "cogs" || doc.cost_kind === "operating";
  const save = async (next: CostKind) => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const costs = await functions();
      // Back to the type's default is stored as '' so a later change of type moves it too.
      await costs.setExpenseKind({ data: { documentId: doc.id, kind: next === DEFAULT_COST_KIND[costCategoryOf(doc)] ? "" : next } });
      await onChanged();
    } catch (cause) {
      toast.error("Could not change the expense", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <select aria-label="Cost of goods sold or operating expense" value={kind} disabled={busy || Boolean(doc.gone_at)} onChange={(e) => void save(e.target.value as CostKind)}
      title={chosen ? undefined : "As its type: transport and hamali are cost of goods sold"}
      className={cn("h-7 max-w-[11rem] rounded-md border px-1.5 text-xs font-semibold", kind === "cogs" ? "border-sky-300 bg-sky-50 text-sky-900" : "border-violet-300 bg-violet-50 text-violet-900")}>
      <option value="cogs">{COST_KIND_NAMES.cogs}</option>
      <option value="operating">{COST_KIND_NAMES.operating}</option>
    </select>
  );
}

/** What an expense is for (17 Nov 2026): the admin's choice, else the guess from Zoho's account (shown in grey). */
function CategoryPicker({ doc, onChanged }: { doc: StoredCostDoc; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const chosen = doc.category ?? "";
  const shown = costCategoryOf(doc);
  const save = async (category: string) => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const costs = await functions();
      await costs.setExpenseCategory({ data: { documentId: doc.id, category } });
      await onChanged();
    } catch (cause) {
      toast.error("Could not change the expense type", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <select aria-label="Expense type" value={chosen || shown} disabled={busy || Boolean(doc.gone_at)} onChange={(e) => void save(e.target.value)}
      className={cn("h-7 max-w-[13rem] rounded-md border border-input bg-white px-1.5 text-xs", !chosen && "text-slate")}
      title={chosen ? undefined : "Guessed from the Zoho account; choose to keep it"}>
      {COST_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

/** Edit and Delete: for an expense typed in on the website. */
function ManualDocActions({ doc, data, report, onChanged }: { doc: StoredCostDoc; data: BatchData; report: BatchReport; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const tags = data.costTags.filter((t) => t.document_id === doc.id);
  const first = report.rows.find((r) => r.batch.id === tags[0]?.batch_id);
  const remove = async () => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const costs = await functions();
      await costs.deleteManualExpense({ data: { documentId: doc.id } });
      toast.success("Expense deleted");
      setConfirming(false);
      await onChanged();
    } catch (cause) {
      toast.error("Could not delete the expense", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {first && <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>}
      <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy} onClick={() => setConfirming(true)}><Trash2 className="mr-1 h-3.5 w-3.5" />Delete</Button>
      {editing && first && <ManualExpenseDialog open={editing} onOpenChange={setEditing} row={first} report={report} existing={{ doc, tags }} onSaved={onChanged} />}
      <Dialog open={confirming} onOpenChange={(next) => { if (!busy) setConfirming(next); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this expense?</DialogTitle>
            <DialogDescription>{`${costCategoryName(costCategoryOf(doc))} ${money(doc.cost_amount)} comes off its batches; their profit goes up by it.`}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Keep it</Button>
            <Button disabled={busy} className="bg-red-600 text-white hover:bg-red-700" onClick={() => void remove()}>{busy ? "Deleting…" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
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

function DocumentList({ rows, data, report, onChanged, batchId }: { rows: BatchExpenseRow[]; data: BatchData; report: BatchReport; onChanged: () => Promise<void>; batchId?: string | undefined }) {
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
                <span className="font-semibold text-navy">{first.source === "bill" ? <FileText className="mr-1 inline h-3.5 w-3.5" /> : first.source === "manual" ? <Pencil className="mr-1 inline h-3.5 w-3.5" /> : <ReceiptText className="mr-1 inline h-3.5 w-3.5" />}{first.account || first.description || "Expense"}</span>
                <span className="block text-xs text-slate">{[day(first.date), first.reference, first.source === "bill" ? "Supplier bill" : first.source === "manual" ? "Typed in on the website" : "Zoho Books expense"].filter(Boolean).join(" · ")}</span>
                {first.source === "manual" && doc && (doc.vendor_name || doc.description || doc.entered_by_name) && (
                  <span className="block text-xs text-slate">{[doc.vendor_name && `Paid to ${doc.vendor_name}`, doc.description, doc.entered_by_name && `added by ${doc.entered_by_name}`].filter(Boolean).join(" · ")}</span>
                )}
              </span>
              <span className="flex flex-wrap items-center justify-end gap-1">
                {doc && <KindPicker doc={doc} onChanged={onChanged} />}
                {doc && first.source !== "manual" && <CategoryPicker doc={doc} onChanged={onChanged} />}
                {doc && (first.source === "manual"
                  ? <ManualDocActions doc={doc} data={data} report={report} onChanged={onChanged} />
                  : <DocActions doc={doc} data={data} onChanged={onChanged} />)}
              </span>
            </div>
            <p className="text-xs">{first.source === "manual"
              ? `Before GST ${money(first.beforeGst)} · GST ${money(first.gst)} (${first.claimable ? "claimed back" : "not claimable, a cost"}) · cost ${money(first.gone ? 0 : first.cost)}`
              : `Zoho before GST ${money(first.beforeGst)} · GST ${money(first.gst)} (${first.claimable ? "claimed back" : "not claimable, a cost"}) · cost ${money(first.gone ? 0 : first.cost)}`}</p>
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

/** Which parts of the profit and loss are open (client, 17 Nov 2026: "give option to hide & expand"), kept on this device. */
const PL_SECTIONS_KEY = "gb-batch-pl-sections";
type PlSection = "before" | "withGst" | "landed";
const PL_DEFAULT: Record<PlSection, boolean> = { before: true, withGst: true, landed: false };
function usePlSections() {
  const [open, setOpen] = useState<Record<PlSection, boolean>>(() => {
    try {
      const saved = typeof window === "undefined" ? null : JSON.parse(window.localStorage.getItem(PL_SECTIONS_KEY) ?? "null");
      return saved && typeof saved === "object" ? { ...PL_DEFAULT, ...saved } : PL_DEFAULT;
    } catch {
      return PL_DEFAULT;
    }
  });
  const toggle = (key: PlSection) => setOpen((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    try { window.localStorage.setItem(PL_SECTIONS_KEY, JSON.stringify(next)); } catch { /* private mode: just this visit */ }
    return next;
  });
  return { open, toggle };
}

function PlSectionBox({ title, note, open, onToggle, children }: { title: string; note: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-border">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-left hover:bg-slate-100">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-navy">{title}</span>
          <span className="block text-xs text-slate">{note}</span>
        </span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate" />}
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
    </div>
  );
}

/**
 * Batch detail: its profit and loss before GST and with GST (client, 17 Nov 2026), and its landed cost (spec 9.3). Each
 * part opens and closes; the choice is kept on this device.
 */
export function BatchProfitPanel({ row }: { row: BatchReportRow }) {
  const b = row.batch;
  const lot = b.stage === "incoming";
  const expenses = Math.round((row.expenseValue + row.inheritedExpenseValue) * 100) / 100;
  const { open, toggle } = usePlSections();
  const line = (label: string, value: number, tone?: "good" | "bad", strong?: boolean) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-0">
      <span className={cn("min-w-0 text-slate", strong && "font-semibold text-charcoal")}>{label}</span>
      <span className={cn("shrink-0 font-semibold tabular-nums", tone === "good" && "text-emerald-700", tone === "bad" && "text-red-700")}>{money(value)}</span>
    </div>
  );
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const withGstBeforeExpenses = r2(row.salesWithGstValue - row.costOfSoldWithGstValue - row.lossWithGstValue);
  // 18 Nov 2026: gross profit after the cost of goods (bill cost + transport, hamali …), then operating expenses.
  const grossBefore = r2(row.profitBeforeExpenses - row.expenseOnSoldCogsValue);
  const operatingBefore = r2(row.expenseOnSoldValue + row.expenseOnLostValue - row.expenseOnSoldCogsValue);
  const grossWithGst = r2(withGstBeforeExpenses - row.expenseOnSoldCogsWithGstValue);
  // Client's sheet, 18 Nov 2026: bag cost = (bill + cost-of-goods expenses) ÷ bags bought, with GST and before GST.
  const bags = row.purchased;
  const bagCost = bags > 0 ? (row.purchaseValue + row.expenseCogsValue) / bags : 0;
  const bagCostWithGst = bags > 0 ? (row.purchaseWithGstValue + row.expenseCogsWithGstValue) / bags : 0;
  const bagLine = (label: string, purchase: number, cogs: number, perBag: number) => bags > 0 && (
    <div className="mt-2 rounded-md bg-sky-50 px-2 py-1.5 text-xs text-sky-950">
      <div className="flex items-baseline justify-between gap-2 font-semibold"><span>{label}</span><span className="tabular-nums">{money(r2(perBag))}</span></div>
      <p className="mt-0.5 tabular-nums">{`(Bill ${money(purchase)} + cost-of-goods expenses ${money(cogs)}) ÷ ${units(bags)} bags = ${perBag.toFixed(2)}`}</p>
    </div>
  );
  const operatingWithGst = r2(row.expenseOnSoldWithGstValue - row.expenseOnSoldCogsWithGstValue);
  const toReceive = Math.round(Math.max(0, row.salesWithGstValue - row.receivedWithGstValue) * 100) / 100;
  return (
    <Panel title="Profit and loss">
      <div className="grid gap-3 text-sm lg:grid-cols-2">
        <PlSectionBox title="Before GST" note={`Gross profit ${money(grossBefore)} · net profit ${money(row.profit)}`} open={open.before} onToggle={() => toggle("before")}>
          {line("Sales", row.sales)}
          {line(lot ? "Cost of sold (estimate)" : "Cost of sold (bill cost)", -row.costOfSold)}
          {row.lossValue !== 0 && line(row.lossValue < 0 ? "Stock found" : "Stock lost", -row.lossValue)}
          {line("Cost of goods expenses on sold (transport, hamali …)", -row.expenseOnSoldCogsValue)}
          {line("Cost of goods sold", -(row.costOfSold + row.expenseOnSoldCogsValue), undefined, true)}
          {line("Gross profit", grossBefore, grossBefore < 0 ? "bad" : "good", true)}
          {line("Operating expenses on sold (commissions, other)", -operatingBefore)}
          {line("Net profit (after all expenses)", row.profit, row.profit < 0 ? "bad" : "good", true)}
          {bagLine("Bag cost (before GST)", row.purchaseValue, row.expenseCogsValue, bagCost)}
          {lot && <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">{`${COST_STATUS_NAMES.estimated}: costed with the estimate ${money(costBeforeGst(b))} per unit until the bill is matched.`}</p>}
          {row.costVarianceValue !== 0 && (
            <p className="mt-1 text-xs text-slate">{`Cost variance on sold: ${money(row.costVarianceValue)} (bill ${money(costBeforeGst(b))} vs estimate ${money(b.est_unit_cost_ex_gst ?? 0)} per unit)`}</p>
          )}
        </PlSectionBox>
        <PlSectionBox title="With GST" note={`Gross profit ${money(grossWithGst)} · net profit ${money(row.profitWithGstValue)}`} open={open.withGst} onToggle={() => toggle("withGst")}>
          {line("Sales with GST", row.salesWithGstValue)}
          {line("Cost of sold with GST", -row.costOfSoldWithGstValue)}
          {row.lossWithGstValue !== 0 && line(row.lossWithGstValue < 0 ? "Stock found with GST" : "Stock lost with GST", -row.lossWithGstValue)}
          {line("Cost of goods expenses on sold, with GST", -row.expenseOnSoldCogsWithGstValue)}
          {line("Cost of goods sold with GST", -(row.costOfSoldWithGstValue + row.expenseOnSoldCogsWithGstValue), undefined, true)}
          {line("Gross profit", grossWithGst, grossWithGst < 0 ? "bad" : "good", true)}
          {line("Operating expenses on sold, with GST", -operatingWithGst)}
          {line("Net profit (after all expenses)", row.profitWithGstValue, row.profitWithGstValue < 0 ? "bad" : "good", true)}
          {line("Received from paid orders", row.receivedWithGstValue)}
          {toReceive > 0 && line("Still to receive on sold units", toReceive)}
          {bagLine("Bag cost with GST", row.purchaseWithGstValue, row.expenseCogsWithGstValue, bagCostWithGst)}
          <p className="mt-1 text-xs text-slate">These amounts include the GST collected on sales and paid on purchases; that GST goes to the government, so the profit before GST is the business's own.</p>
        </PlSectionBox>
        <div className="lg:col-span-2">
          <PlSectionBox title="Landed cost and unsold stock" note={`Landed cost per unit ${money(row.landedUnitCost)} (before GST)`} open={open.landed} onToggle={() => toggle("landed")}>
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
          </PlSectionBox>
        </div>
      </div>
    </Panel>
  );
}

/** A batch's expenses by type (17 Nov 2026): what each counts for now, as the profit uses it. */
function expensesByCategory(rows: BatchExpenseRow[], docs: StoredCostDoc[]) {
  const docOf = new Map(docs.map((d) => [d.id, d]));
  const totals = new Map<string, number>();
  for (const e of rows) {
    const doc = docOf.get(e.documentId);
    const id = costCategoryOf(doc ?? { account_name: e.account, description: e.description });
    totals.set(id, Math.round(((totals.get(id) ?? 0) + e.effective) * 100) / 100);
  }
  return COST_CATEGORIES.filter((c) => totals.has(c.id)).map((c) => ({ id: c.id, name: c.name, amount: totals.get(c.id)! }));
}

/** Batch detail: the expenses tagged to this batch, Add expense (typed in), Add from Zoho Books and Bill charges. */
export function BatchExpensesPanel({ row, report, data, onChanged }: { row: BatchReportRow; report: BatchReport; data: BatchData; onChanged: () => Promise<void> }) {
  const [picker, setPicker] = useState(false);
  const [charges, setCharges] = useState(false);
  const [adding, setAdding] = useState(false);
  const rows = report.expenses.filter((e) => e.batchId === row.batch.id);
  const cancelled = row.batch.stage === "cancelled";
  const byType = expensesByCategory(rows, data.costDocuments);
  return (
    <Panel title={`Expenses (${byDocument(rows).length})`} action={cancelled ? undefined : (
      <>
        <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={() => setAdding(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />Add expense</Button>
        <Button size="sm" variant="outline" onClick={() => setPicker(true)}><ReceiptText className="mr-1.5 h-3.5 w-3.5" />Add from Zoho Books</Button>
        <Button size="sm" variant="outline" onClick={() => setCharges(true)}><FileText className="mr-1.5 h-3.5 w-3.5" />Bill charges</Button>
      </>
    )}>
      <div className="grid gap-2">
        {row.inheritedExpenseValue !== 0 && (
          <p className="text-xs text-slate">{`${money(row.inheritedExpenseValue)} of expenses came with the units sent here from another godown's batch.`}</p>
        )}
        {byType.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {byType.map((t) => <span key={t.id} className="rounded-full border border-border bg-slate-50 px-2 py-0.5"><span className="text-slate">{t.name}</span> <span className="font-semibold">{money(t.amount)}</span></span>)}
          </div>
        )}
        {cancelled ? <p className="text-sm text-slate">A cancelled pre-order takes no expenses.</p> : <DocumentList rows={rows} data={data} report={report} onChanged={onChanged} batchId={row.batch.id} />}
      </div>
      {adding && <ManualExpenseDialog open={adding} onOpenChange={setAdding} row={row} report={report} onSaved={onChanged} />}
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
        <DocumentList rows={rows} data={data} report={report} onChanged={onChanged} />
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

/** The batches made from the same bill as this one (the same truck), for sharing a transport or hamali bill by bags. */
function sameBillBatches(row: BatchReportRow, report: BatchReport) {
  const billId = row.batch.zoho_bill_id ?? "";
  if (!billId) return [];
  return report.rows.filter((r) => r.batch.id !== row.batch.id && r.batch.zoho_bill_id === billId && !r.batch.parent_batch_id && r.batch.stage !== "cancelled");
}

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

type WebsiteCommission = { amount: number; earned: number; pending: number; orders: string[] };

/**
 * Add expense / Edit (17 Nov 2026, client: "an option to attach expense occurred for that batch like transport, amali,
 * driver commission etc and channel partner commission and other ... give option to edit the expense"): typed in on the
 * website, on this batch or shared by bags with the batches of the same bill. The profit after expenses and the landed
 * cost take it at once. Channel partner commission offers what the website worked out on this batch's orders.
 */
export function ManualExpenseDialog({ open, onOpenChange, row, report, existing, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; row: BatchReportRow; report: BatchReport;
  existing?: { doc: StoredCostDoc; tags: { batch_id: string; amount: number; method: string }[] } | undefined;
  onSaved: () => Promise<void>;
}) {
  const doc = existing?.doc;
  const siblings = sameBillBatches(row, report);
  const startShared = Boolean(existing && existing.tags.length > 1);
  const [category, setCategory] = useState<string>(doc ? costCategoryOf(doc) : "transport");
  const [date, setDate] = useState(doc?.doc_date?.slice(0, 10) ?? today());
  const [beforeGst, setBeforeGst] = useState(doc ? String(doc.amount_before_gst) : "");
  const [gst, setGst] = useState(doc && doc.gst_amount ? String(doc.gst_amount) : "");
  const [claimable, setClaimable] = useState(doc ? doc.gst_claimable : true);
  const [paidTo, setPaidTo] = useState(doc?.vendor_name ?? "");
  const [reference, setReference] = useState(doc?.doc_number ?? "");
  const [note, setNote] = useState(doc?.description ?? "");
  const [shared, setShared] = useState(startShared);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [commission, setCommission] = useState<WebsiteCommission | null>(null);
  const [commissionError, setCommissionError] = useState("");
  const cost = manualExpenseCost({ beforeGst: Number(beforeGst) || 0, gst: Number(gst) || 0, gstClaimable: claimable });
  const shareRows = shared ? [row, ...siblings] : [row];
  const bags = shareRows.reduce((sum, r) => sum + Math.max(0, r.batch.quantity), 0);

  const loadCommission = async () => {
    setCommissionError("");
    try {
      if (STATIC_DATA_MODE) { setCommission({ amount: 0, earned: 0, pending: 0, orders: [] }); return; }
      const costs = await functions();
      setCommission(await costs.batchWebsiteCommission({ data: { batchId: row.batch.id } }));
    } catch (cause) {
      setCommissionError(errorText(cause));
    }
  };
  const pickCategory = (next: string) => {
    setCategory(next);
    if (next === "partner_commission" && !commission) void loadCommission();
  };

  const save = async () => {
    const why = manualExpenseProblem({ category, date, beforeGst: Number(beforeGst) || 0, gst: Number(gst) || 0 });
    if (why) { setProblem(why); return; }
    setBusy(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); onOpenChange(false); return; }
      const costs = await functions();
      await costs.saveManualExpense({ data: {
        documentId: doc?.id ?? null, category, date, beforeGst: Number(beforeGst), gst: Number(gst) || 0, gstClaimable: claimable,
        paidTo: paidTo.trim(), reference: reference.trim(), note: note.trim(),
        method: shared ? "bags" : "amount", batches: shareRows.map((r) => ({ batchId: r.batch.id, typed: null })),
      } });
      toast.success(doc ? "Expense saved" : `Expense added to ${shared ? `${shareRows.length} batches` : `batch ${row.batch.batch_code}`}`, {
        description: `${costCategoryName(category)} ${money(cost)}: the profit after expenses and the landed cost now count it.`,
      });
      onOpenChange(false);
      await onSaved();
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{doc ? "Edit expense" : `Add an expense to batch ${row.batch.batch_code}`}</DialogTitle>
          <DialogDescription>{`${row.batch.product_name} · ${units(row.batch.quantity)} bought. Amounts before GST, as the batch profit is counted.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="grid gap-1 text-xs font-semibold text-slate">What it is for
            <select value={category} onChange={(e) => pickCategory(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal">
              {COST_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {category === "partner_commission" && (
            <div className="rounded-md border border-border bg-slate-50 p-2 text-xs">
              {commissionError && <p className="text-danger">{commissionError}</p>}
              {!commission && !commissionError && <p className="text-slate">Reading the website's commission on this batch's orders…</p>}
              {commission && (commission.amount > 0
                ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{`Website commission on this batch's orders: ${money(commission.amount)} (earned ${money(commission.earned)}, pending ${money(commission.pending)}; ${commission.orders.length} orders)`}</span>
                    <Button size="sm" variant="outline" onClick={() => { setBeforeGst(String(commission.amount)); setGst(""); }}>Use this amount</Button>
                  </div>
                )
                : <p className="text-slate">No channel partner commission on this batch's orders on the website. Type the amount paid.</p>)}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs font-semibold text-slate">Date<Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="grid gap-1 text-xs font-semibold text-slate">Amount before GST (₹)<Input type="number" inputMode="decimal" min="0" step="0.01" value={beforeGst} onChange={(e) => setBeforeGst(e.target.value)} /></label>
            <label className="grid gap-1 text-xs font-semibold text-slate">GST (₹, if any)<Input type="number" inputMode="decimal" min="0" step="0.01" value={gst} onChange={(e) => setGst(e.target.value)} /></label>
            <label className="flex items-end gap-2 pb-2 text-xs font-semibold text-slate">
              <input type="checkbox" checked={claimable} onChange={(e) => setClaimable(e.target.checked)} />GST claimed back (not a cost)
            </label>
            <label className="grid gap-1 text-xs font-semibold text-slate">Paid to<Input value={paidTo} maxLength={120} placeholder="Lorry owner, driver, partner…" onChange={(e) => setPaidTo(e.target.value)} /></label>
            <label className="grid gap-1 text-xs font-semibold text-slate">Receipt / bill no.<Input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} /></label>
          </div>
          <label className="grid gap-1 text-xs font-semibold text-slate">Note<Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></label>
          {siblings.length > 0 && (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              <span>{`Share by bags with the other ${siblings.length} batch${siblings.length === 1 ? "" : "es"} of bill ${row.batch.zoho_bill_number || ""} (${siblings.map((s) => s.batch.batch_code).join(", ")})`}</span>
            </label>
          )}
          <p className="rounded-md bg-slate-50 px-2 py-1.5 text-xs">
            {cost > 0
              ? shared
                ? `Counts ${money(cost)}, shared over ${shareRows.length} batches by their ${units(bags)} bags.`
                : `Counts ${money(cost)} on batch ${row.batch.batch_code}${row.batch.quantity > 0 ? `: about ${money(cost / row.batch.quantity)} a bag` : ""}.`
              : "Type the amount."}
          </p>
          {problem && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || cost <= 0} className="bg-navy text-white hover:bg-navy/90" onClick={() => void save()}>{busy ? "Saving…" : doc ? "Save" : "Add expense"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
