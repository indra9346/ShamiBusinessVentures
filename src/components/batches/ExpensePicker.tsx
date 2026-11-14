import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ReceiptText, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import { costBeforeGst, istDate } from "@/lib/batches";
import {
  REAUTHORIZE_HINT, SPLIT_METHODS, countedCost, defaultSplitMethod, expensesNotAllowed, splitByMethod, type SplitBatch, type SplitMethod,
} from "@/lib/batch-costs";
import { cn } from "@/lib/utils";

/*
 * Admin › Batches › Expenses (spec 8.2, 10): "Add from Zoho Books" picks a Books expense (or one line of an itemized
 * one) and splits it over batches, by bags, value before GST, weight, typed amounts or percents, with a live preview to
 * the paisa. The server reads the expense from Zoho again and does the split itself (src/lib/batch-costs.functions.ts).
 */

const money = (n: number) => inrPrecise(n);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const day = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");
const todayIst = () => istDate(new Date().toISOString());
const daysBefore = (iso: string, days: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const functions = () => import("@/lib/batch-costs.functions");

/** One cost to split: a Books expense (or line), or a charge line of a supplier's bill, with what is tagged of it so far. */
export type SplitDoc = {
  source: "expense" | "bill"; zohoId: string; lineId: string; label: string; date: string; account: string; reference: string;
  beforeGst: number; gst: number; gstClaimable: boolean; gstOverride: boolean | null; rebilled: boolean; flag: string;
  tags: { batchId: string; amount: number }[];
};

/** Where the expense picker opens: the batch whose page it was opened from (its date sets the range), if any. */
export function presetRange(data: BatchData, batchIds: string[]) {
  const first = data.batches.find((b) => batchIds.includes(b.id));
  const from = first ? daysBefore(first.purchase_date ?? istDate(first.created_at), 30) : daysBefore(todayIst(), 30);
  return { from, to: todayIst() };
}

/** Reauthorize hint or the plain error, as a box. */
export function CostError({ text }: { text: string }) {
  if (!text) return null;
  const reauthorize = text.startsWith(REAUTHORIZE_HINT) || expensesNotAllowed(text);
  return (
    <p className={cn("flex gap-2 rounded-md border p-2 text-xs", reauthorize ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-700")}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">{reauthorize ? `${REAUTHORIZE_HINT}. Bill charges work without it.` : text}</span>
    </p>
  );
}

type ListRow = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["listZohoExpenses"]>>["rows"][number];
type ExpenseDocs = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["getZohoExpense"]>>["docs"];

/** Add from Zoho Books: list → (line) → split. `initialExpenseId` opens one expense straight away. */
export function ExpensePickerDialog({ open, onOpenChange, data, presetBatchIds, initialExpenseId, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; data: BatchData; presetBatchIds: string[]; initialExpenseId?: string | undefined;
  onSaved: () => Promise<void>;
}) {
  const range = presetRange(data, presetBatchIds);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const [untaggedOnly, setUntaggedOnly] = useState(true);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [docs, setDocs] = useState<ExpenseDocs | null>(null);
  const [doc, setDoc] = useState<SplitDoc | null>(null);

  const load = async (nextPage = 1) => {
    setLoading(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { setRows(demoRows()); setHasMore(false); return; }
      const { listZohoExpenses } = await functions();
      const answer = await listZohoExpenses({ data: { from, to, search: query.trim(), page: nextPage } });
      setRows((current) => (nextPage === 1 ? answer.rows : [...(current ?? []), ...answer.rows]));
      setHasMore(answer.hasMore);
      setPage(nextPage);
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  const openExpense = async (expenseId: string) => {
    setLoading(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { toast.message("Preview: expenses are read from Zoho Books when the site is live"); return; }
      const { getZohoExpense } = await functions();
      const answer = await getZohoExpense({ data: { expenseId } });
      setDocs(answer.docs);
      if (answer.docs.length === 1) setDoc(docOf(answer.docs[0]!));
      if (!answer.docs.length) setProblem("This expense has no amount to tag");
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    setDoc(null); setDocs(null); setProblem("");
    if (initialExpenseId) void openExpense(initialExpenseId);
    else void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialExpenseId]);

  const accounts = [...new Set((rows ?? []).map((r) => r.account).filter(Boolean))].sort();
  const shown = (rows ?? []).filter((r) => (!untaggedOnly || Math.abs(r.tagged) < Math.abs(r.beforeGst) - 0.004) && (!account || r.account === account));
  const untaggedTotal = shown.reduce((sum, r) => sum + Math.max(0, r.beforeGst - r.tagged), 0);
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Add from Zoho Books</DialogTitle>
          <DialogDescription>Pick an expense (freight, hamali, unloading…), then the batches it belongs to. Amounts are before GST; GST that is claimed back is not a cost.</DialogDescription>
        </DialogHeader>
        <CostError text={problem} />
        {doc ? (
          <SplitEditor data={data} doc={doc} presetBatchIds={presetBatchIds} onCancel={() => setDoc(null)}
            onSaved={async () => { close(); await onSaved(); }} />
        ) : docs && docs.length > 1 ? (
          <div className="grid gap-2">
            <p className="text-sm font-semibold text-navy">This expense has several lines: tag each line on its own</p>
            {docs.map((d) => (
              <button key={d.zoho_line_id} type="button" onClick={() => setDoc(docOf(d))}
                className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 rounded-lg border border-border bg-white p-3 text-left text-sm hover:border-gold">
                <span className="truncate font-semibold text-navy">{d.account_name || d.description}</span>
                <span className="text-right font-semibold">{money(d.cost)}</span>
                <span className="truncate text-xs text-slate">{d.description}</span>
                <span className="text-right text-xs text-slate">{d.tagged ? `${money(d.tagged)} tagged` : "Not tagged"}</span>
              </button>
            ))}
            <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setDocs(null)}>Back to the list</Button>
          </div>
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto]">
              <label className="grid gap-1 text-xs font-semibold text-slate">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="grid gap-1 text-xs font-semibold text-slate">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <label className="relative grid gap-1 text-xs font-semibold text-slate">Search
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Account, description or vendor" onKeyDown={(e) => { if (e.key === "Enter") void load(1); }} />
              </label>
              <Button size="sm" variant="outline" className="self-end" disabled={loading} onClick={() => void load(1)}>
                <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Load expenses
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account" className="h-8 max-w-[260px] rounded-md border border-input bg-white px-2 text-sm">
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <label className="flex items-center gap-1.5 font-semibold text-slate">
                <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} />Untagged only
              </label>
              {rows && <span className="text-slate">{`${shown.length} shown · ${money(untaggedTotal)} not tagged to any batch (overhead)`}</span>}
            </div>
            {!rows && loading && <p className="text-sm text-slate">Reading expenses from Zoho Books…</p>}
            {rows && shown.length === 0 && <p className="text-sm text-slate">No expenses match. Widen the dates or untick Untagged only.</p>}
            <div className="grid gap-2">
              {shown.map((r) => (
                <button key={r.expenseId} type="button" disabled={loading} onClick={() => void openExpense(r.expenseId)}
                  className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-white p-3 text-left text-sm transition hover:border-gold">
                  <span className="truncate font-semibold text-navy"><ReceiptText className="mr-1 inline h-3.5 w-3.5" />{r.account || "Expense"}</span>
                  <span className="text-right font-semibold">{money(r.beforeGst)}</span>
                  <span className="truncate text-xs text-slate">{[day(r.date), r.number, r.description].filter(Boolean).join(" · ")}</span>
                  <span className="text-right text-xs text-slate">{r.gst ? `+ GST ${money(r.gst)}` : "No GST"}</span>
                  <span className={cn("col-span-2 text-xs", r.tagged ? "text-emerald-700" : "text-slate")}>
                    {r.tagged ? `${money(r.tagged)} tagged · ${money(Math.max(0, r.beforeGst - r.tagged))} untagged` : "Not tagged"}
                    {r.rebilled ? " · charged on to a customer" : ""}
                  </span>
                </button>
              ))}
            </div>
            {hasMore && <Button size="sm" variant="outline" className="justify-self-start" disabled={loading} onClick={() => void load(page + 1)}>Load more expenses</Button>}
          </div>
        )}
        {!doc && (
          <DialogFooter>
            <Button variant="outline" onClick={close}>Close</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A document from getZohoExpense / getBillCharges as the split editor takes it. */
export function docOf(d: ExpenseDocs[number]): SplitDoc {
  return {
    source: d.source, zohoId: d.zoho_id, lineId: d.zoho_line_id, label: d.account_name || d.description || d.doc_number, date: d.doc_date,
    account: d.account_name, reference: d.doc_number, beforeGst: d.amount_before_gst, gst: d.gst_amount, gstClaimable: d.gst_claimable,
    gstOverride: d.gstOverride, rebilled: d.rebilled, flag: d.flag, tags: d.tags.map((t) => ({ batchId: t.batchId, amount: t.amount })),
  };
}

/** The batches of the same purchase: those made from one Zoho bill (not their copies at other godowns). */
const billBatches = (data: BatchData, billId: string) => data.batches.filter((b) => billId && b.zoho_bill_id === billId && !b.parent_batch_id && (b.stage ?? "received") === "received");

/** A pre-order batch with every remainder before and after it ("-R1", "-R2"). */
function lotFamily(data: BatchData, batchId: string) {
  const start = data.batches.find((b) => b.id === batchId);
  if (!start || (start.expected_quantity === null || start.expected_quantity === undefined)) return [];
  let root = start;
  for (let guard = 0; root.split_from_batch_id && guard < 20; guard += 1) root = data.batches.find((b) => b.id === root.split_from_batch_id) ?? root;
  const family = [root];
  for (let i = 0; i < family.length && i < 50; i += 1) family.push(...data.batches.filter((b) => b.split_from_batch_id === family[i]!.id));
  return family.filter((b) => b.stage !== "cancelled");
}

/**
 * The split of one document over batches (spec 8.2): which batches (quick picks: the bill's batches, a pre-order and its
 * remainders), the method, the live preview per batch (₹ and ₹ per bag), the GST choice and, for an expense charged on to
 * a customer, the tick. Saving replaces the document's earlier split.
 */
export function SplitEditor({ data, doc, presetBatchIds, onCancel, onSaved }: {
  data: BatchData; doc: SplitDoc; presetBatchIds: string[]; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>(() => [...new Set([...doc.tags.map((t) => t.batchId), ...presetBatchIds])]);
  const productOf = (id: string) => data.batches.find((b) => b.id === id)?.product_id ?? "";
  // By bags for one product, by value across products; a bill's discount by value (spec 8.2).
  const [method, setMethod] = useState<SplitMethod>(() => (doc.lineId === "bill-discount" ? "value" : defaultSplitMethod(selected.map(productOf))));
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(doc.tags.map((t) => [t.batchId, String(Math.abs(t.amount))])));
  const [gst, setGst] = useState<"zoho" | "claimable" | "cost">(doc.gstOverride === null ? "zoho" : doc.gstOverride ? "claimable" : "cost");
  const [confirmRebilled, setConfirmRebilled] = useState(false);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const override = gst === "zoho" ? null : gst === "claimable";
  const cost = countedCost({ amount_before_gst: doc.beforeGst, gst_amount: doc.gst, gst_claimable: doc.gstClaimable }, override);
  const productWeight = new Map(data.products.map((p) => [p.id, p.weightKg]));
  const inputs: SplitBatch[] = selected.map((id) => {
    const b = data.batches.find((x) => x.id === id);
    return {
      batchId: id, bags: b?.quantity ?? 0, unitCostExGst: b ? costBeforeGst(b) : 0, kgPerUnit: b ? productWeight.get(b.product_id) ?? null : null,
      typed: typed[id] === undefined || typed[id] === "" ? null : Number(typed[id]),
    };
  });
  const split = splitByMethod(cost, inputs, method);
  const amountOf = new Map(split.rows.map((r) => [r.batchId, r.amount]));
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const godown = (id: string | null) => data.godowns.find((g) => g.id === id)?.name ?? "";
    return data.batches
      .filter((b) => b.stage !== "cancelled" && (selected.includes(b.id) || !q || b.batch_code.toLowerCase().includes(q) || b.product_name.toLowerCase().includes(q) || godown(b.branch_id).toLowerCase().includes(q)))
      .sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)) || (b.purchase_date ?? "").localeCompare(a.purchase_date ?? ""))
      .slice(0, 60)
      .map((b) => ({ ...b, godown: godown(b.branch_id) }));
  }, [data, query, selected]);
  const fromBill = doc.source === "bill" ? billBatches(data, doc.zohoId) : [];
  const preset = data.batches.find((b) => presetBatchIds.includes(b.id));
  const sameBill = preset?.zoho_bill_id ? billBatches(data, preset.zoho_bill_id) : [];
  const family = preset ? lotFamily(data, preset.id) : [];
  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const pick = (ids: string[]) => setSelected((list) => [...new Set([...list, ...ids])]);
  const problem = split.problem || (doc.rebilled && !confirmRebilled ? "This expense was charged on to a customer; tick to count it as your cost" : "");

  const save = async () => {
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { tagBatchCosts } = await functions();
      const result = await tagBatchCosts({ data: {
        source: doc.source, zohoId: doc.zohoId, lineId: doc.lineId, method, confirmRebilled, note: note.trim(),
        batches: selected.map((id) => ({ batchId: id, typed: method === "amount" || method === "percent" ? Number(typed[id] || 0) : null })),
        ...(override !== doc.gstOverride ? { gstOverride: override } : {}),
      } });
      toast.success(`${money(result.tagged)} tagged to ${selected.length} batch${selected.length === 1 ? "" : "es"}`, {
        description: result.untagged ? `${money(result.untagged)} stays untagged (overhead).` : "The whole expense is on the batches.",
      });
      await onSaved();
    } catch (cause) {
      toast.error("Could not tag the expense", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-1 rounded-lg border border-gold/40 bg-ivory p-3 text-sm">
        <p className="font-semibold text-navy">{doc.label}</p>
        <p className="text-xs text-slate">{[day(doc.date), doc.reference, doc.source === "bill" ? "Supplier bill" : "Zoho Books expense"].filter(Boolean).join(" · ")}</p>
        <p className="text-xs">{`Before GST ${money(doc.beforeGst)} · GST ${money(doc.gst)} · ${doc.gstClaimable ? "claimable in Zoho" : "not claimable in Zoho"} · counted cost ${money(cost)}`}</p>
        {doc.gst > 0 && (
          <label className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-slate">GST on this expense</span>
            <select value={gst} onChange={(e) => setGst(e.target.value as typeof gst)} className="h-8 rounded-md border border-input bg-white px-2 text-xs">
              <option value="zoho">As Zoho says</option>
              <option value="claimable">Claimed back (not a cost)</option>
              <option value="cost">Not claimed (a cost)</option>
            </select>
          </label>
        )}
        {doc.flag && <p className="text-xs font-semibold text-amber-800">{`${doc.flag}. Saving replaces the old split with this one, checked against Zoho's amount now.`}</p>}
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {SPLIT_METHODS.map((m) => (
          <button key={m.key} type="button" onClick={() => setMethod(m.key)}
            className={cn("rounded-full border px-2.5 py-1 font-semibold", method === m.key ? "border-navy bg-navy text-white" : "border-border bg-white text-slate")}>{m.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {fromBill.length > 0 && <Button size="sm" variant="outline" onClick={() => pick(fromBill.map((b) => b.id))}>{`Batches of bill ${doc.reference}`}</Button>}
        {sameBill.length > 1 && <Button size="sm" variant="outline" onClick={() => pick(sameBill.map((b) => b.id))}>{`Batches of bill ${preset?.zoho_bill_number || preset?.purchase_ref || ""}`}</Button>}
        {family.length > 1 && <Button size="sm" variant="outline" onClick={() => pick(family.map((b) => b.id))}>This pre-order and its remainders</Button>}
      </div>

      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a batch: number, product or godown" className="pl-8" />
      </label>
      <div className="grid max-h-[320px] gap-1.5 overflow-y-auto">
        {candidates.map((b) => {
          const on = selected.includes(b.id);
          const amount = amountOf.get(b.id) ?? 0;
          return (
            <div key={b.id} className={cn("grid min-w-0 grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border px-2 py-1.5 text-xs", on ? "border-navy/40 bg-white" : "border-border bg-slate-50")}>
              <input type="checkbox" checked={on} onChange={() => toggle(b.id)} aria-label={b.batch_code} />
              <span className="min-w-0">
                <span className="font-mono font-semibold text-navy">{b.batch_code}</span>
                <span className="block truncate text-slate">{`${b.product_name} · ${b.godown} · ${b.quantity} ${b.stage === "incoming" ? "expected" : "units"}`}</span>
              </span>
              {on && (method === "amount" || method === "percent"
                ? <Input className="h-8 w-28" type="number" min="0" step="0.01" value={typed[b.id] ?? ""} placeholder={method === "percent" ? "%" : "₹"}
                    onChange={(e) => setTyped((all) => ({ ...all, [b.id]: e.target.value }))} />
                : <span className="text-right font-semibold">{money(amount)}<span className="block font-normal text-slate">{b.quantity > 0 ? `${money(amount / b.quantity)} per unit` : ""}</span></span>)}
            </div>
          );
        })}
      </div>

      <p className="rounded-md border border-sky-200 bg-sky-50 p-2 text-xs text-sky-950">
        {`${money(split.tagged)} of ${money(cost)} tagged; ${money(split.untagged)} stays untagged (overhead).`}
      </p>
      {doc.rebilled && (
        <label className="flex items-start gap-2 text-xs font-semibold">
          <input type="checkbox" className="mt-0.5" checked={confirmRebilled} onChange={(e) => setConfirmRebilled(e.target.checked)} />
          <span>This expense was charged on to a customer in Zoho. Count it as our cost anyway</span>
        </label>
      )}
      <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
      {problem && <p className="text-xs font-semibold text-red-700">{problem}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onCancel}>Back</Button>
        <Button className="bg-navy text-white" disabled={busy || Boolean(problem)} onClick={() => void save()}>{busy ? "Saving…" : "Save the split"}</Button>
      </div>
    </div>
  );
}

function demoRows(): ListRow[] {
  const row = (id: string, date: string, account: string, description: string, amount: number, tagged = 0): ListRow => ({
    expenseId: id, date, number: `EXP-${id}`, account, description, vendor: "", beforeGst: amount, gst: 0, total: amount, status: "nonbillable",
    rebilled: false, modifiedAt: "", locationId: "", tagged,
  });
  return [
    row("00131", todayIst(), "Transportation Charges Freight Charges", "Lorry freight for sugar", 9000, 9000),
    row("00132", todayIst(), "Amali Charges - Loading and Unloading", "Hamali, 360 bags", 1800),
    row("00133", daysBefore(todayIst(), 3), "Challakere Godown Rent", "Godown rent", 10000),
  ];
}
