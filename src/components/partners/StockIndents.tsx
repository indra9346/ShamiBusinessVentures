import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ClipboardList, Plus, Send, X } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyIndentLine, indentDraftProblem, indentQuantityText, indentStatusLabel, INDENT_UNITS, MAX_INDENT_LINES, partnerCanCancel,
  type Indent, type IndentLineDraft, type IndentStatus,
} from "@/lib/indents";
import { cancelIndent, loadIndentProducts, loadIndents, raiseIndent } from "@/lib/indents-store";
import { todayInIndia } from "@/lib/follow-ups";
import { cn } from "@/lib/utils";

/*
 * Channel partner dashboard: ask head office for stock (an indent) and follow each request's status (owner, 13 Nov
 * 2026). Sending only asks; stock, orders and Zoho stay as they are.
 */

export const INDENT_TONE: Record<IndentStatus, string> = {
  new: "border-sky-200 bg-sky-50 text-sky-900",
  seen: "border-amber-200 bg-amber-50 text-amber-900",
  arranged: "border-emerald-200 bg-emerald-50 text-emerald-900",
  cancelled: "border-slate-200 bg-slate-100 text-slate",
};

export function IndentStatusBadge({ status }: { status: IndentStatus }) {
  return <span className={cn("inline-block rounded border px-2 py-0.5 text-xs font-bold", INDENT_TONE[status])}>{indentStatusLabel(status)}</span>;
}

export const indentTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const indentDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

/** The lines of a request as a small table (phone: stacked). */
export function IndentLines({ indent }: { indent: Indent }) {
  return (
    <ul className="divide-y divide-border/60 rounded-md border border-border bg-white text-sm">
      {indent.lines.map((line) => (
        <li key={line.lineNo} className="grid gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <span className="min-w-0">
            <span className="font-semibold text-navy">{line.productName}</span>
            {line.grade && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-slate">{`Grade: ${line.grade}`}</span>}
            {line.remarks && <span className="block text-xs text-slate">{line.remarks}</span>}
          </span>
          <span className="font-bold tabular-nums text-navy sm:text-right">{indentQuantityText(line.quantity, line.unit)}</span>
        </li>
      ))}
    </ul>
  );
}

const field = "h-10 w-full rounded-md border border-border bg-white px-2 text-base sm:text-sm";

export function PartnerStockIndents({ branchId, godown, partnerName }: { branchId: string; godown: string; partnerName: string }) {
  const [indents, setIndents] = useState<Indent[] | null>(null);
  const [failed, setFailed] = useState("");
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [lines, setLines] = useState<IndentLineDraft[]>([emptyIndentLine()]);
  const [notes, setNotes] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState("");
  const today = todayInIndia();

  const reload = useCallback(async () => {
    try {
      setIndents(await loadIndents());
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not load your stock requirements");
      setIndents([]);
    }
  }, []);
  useEffect(() => {
    void reload();
    void loadIndentProducts().then(setProducts);
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const setLine = (index: number, patch: Partial<IndentLineDraft>) => setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const pickProduct = (index: number, name: string) => {
    const match = products.find((product) => product.name.toLowerCase() === name.trim().toLowerCase());
    setLine(index, { productName: name, productId: match?.id ?? null });
  };
  const problem = indentDraftProblem(lines, notes, neededBy, today);
  const send = async () => {
    if (problem) { toast.error(problem); return; }
    setSending(true);
    try {
      const indentNo = await raiseIndent(lines, notes, neededBy, { branchId, godown, partnerName });
      toast.success(`Stock requirement ${indentNo} sent`, { description: "Head office has been told. You will see its status below." });
      setLines([emptyIndentLine()]);
      setNotes("");
      setNeededBy("");
      await reload();
    } catch (cause) {
      toast.error("Could not send it", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSending(false);
    }
  };
  const cancel = async (indent: Indent) => {
    const reason = window.prompt(`Cancel stock requirement ${indent.indentNo}? Head office is told. Add a reason if you like.`, "");
    if (reason === null) return;
    setBusy(indent.indentNo);
    try {
      await cancelIndent(indent.indentNo, reason);
      toast.message(`Request ${indent.indentNo} cancelled`);
      await reload();
    } catch (cause) {
      toast.error("Could not cancel it", { description: cause instanceof Error ? cause.message : undefined });
      await reload();
    } finally {
      setBusy("");
    }
  };

  return (
    <div id="stock-requirement" className="scroll-mt-36">
      <Panel title="Stock requirement (indent)">
        <p className="mb-3 text-xs text-slate">{`Ask head office for stock for ${godown}. This is a request only: stock and orders change when head office sends the goods.`}</p>
        <datalist id="indent-products">{products.map((product) => <option key={product.id} value={product.name} />)}</datalist>
        <div className="space-y-3">
          {lines.map((line, index) => (
            <fieldset key={index} className="grid min-w-0 gap-2 rounded-lg border border-border bg-ivory/50 p-3 sm:grid-cols-12">
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-charcoal sm:col-span-5">
                <span>{`Product ${index + 1}`}</span>
                <Input list="indent-products" value={line.productName} maxLength={120} placeholder="Choose or type the product" className="bg-white text-base sm:text-sm" onChange={(event) => pickProduct(index, event.target.value)} />
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-charcoal sm:col-span-2">
                <span>Quantity</span>
                <Input type="number" inputMode="decimal" min={0} step="any" value={line.quantity} className="bg-white text-base sm:text-sm" onChange={(event) => setLine(index, { quantity: event.target.value })} />
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-charcoal sm:col-span-2">
                <span>Bags or units</span>
                <select className={field} value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value as IndentLineDraft["unit"] })}>
                  {INDENT_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-charcoal sm:col-span-3">
                <span>Grade</span>
                <Input value={line.grade} maxLength={60} placeholder="For example: Steam, 1 year old" className="bg-white text-base sm:text-sm" onChange={(event) => setLine(index, { grade: event.target.value })} />
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-charcoal sm:col-span-10">
                <span>Remarks</span>
                <Input value={line.remarks} maxLength={300} placeholder="Brand, bag size, anything head office should know" className="bg-white text-base sm:text-sm" onChange={(event) => setLine(index, { remarks: event.target.value })} />
              </label>
              <div className="flex items-end sm:col-span-2">
                {lines.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" className="h-10 text-danger" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                    <X className="mr-1 h-4 w-4" />Remove
                  </Button>
                )}
              </div>
            </fieldset>
          ))}
        </div>
        {lines.length < MAX_INDENT_LINES && (
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setLines((current) => [...current, emptyIndentLine()])}>
            <Plus className="mr-1 h-4 w-4" />Add another product
          </Button>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <label className="grid gap-1 text-xs font-semibold text-charcoal">
            <span>Notes for head office (optional)</span>
            <Textarea rows={2} maxLength={1000} value={notes} className="bg-white text-base sm:text-sm" placeholder="Why it is needed, delivery details…" onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label className="grid content-start gap-1 text-xs font-semibold text-charcoal">
            <span>Needed by (optional)</span>
            <Input type="date" min={today} value={neededBy} className="bg-white text-base sm:text-sm" onChange={(event) => setNeededBy(event.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={sending} onClick={() => void send()}>
            <Send className="mr-1.5 h-4 w-4" />{sending ? "Sending…" : "Send to head office"}
          </Button>
          {problem && problem !== "Add at least one product" && <p className="text-xs font-semibold text-danger">{problem}</p>}
        </div>
      </Panel>

      <Panel title="Your stock requirements" className="mt-6">
        {indents === null ? <p className="text-sm text-slate">Loading…</p>
          : failed ? <p className="text-sm font-semibold text-danger">{failed}</p>
          : indents.length === 0 ? <p className="flex items-center gap-2 text-sm text-slate"><ClipboardList className="h-4 w-4" />None sent yet.</p>
          : (
            <ul className="space-y-3">
              {indents.map((indent) => (
                <li key={indent.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-bold text-navy">{indent.indentNo}</p>
                      <p className="text-xs text-slate">
                        <span>{indentTime(indent.createdAt)}</span>
                        {indent.neededBy && <><span className="mx-1">·</span><span>{`Needed by ${indentDate(indent.neededBy)}`}</span></>}
                      </p>
                    </div>
                    <IndentStatusBadge status={indent.status} />
                  </div>
                  <IndentLines indent={indent} />
                  {indent.notes && <p className="mt-2 whitespace-pre-line text-xs text-charcoal"><span className="font-semibold">Your notes: </span><span>{indent.notes}</span></p>}
                  {indent.statusNote && (
                    <p className="mt-1 text-xs text-charcoal"><span className="font-semibold">{indent.status === "cancelled" && indent.events.at(-1)?.byRole === "partner" ? "Reason: " : "Head office: "}</span><span>{indent.statusNote}</span></p>
                  )}
                  {partnerCanCancel(indent.status) && (
                    <Button size="sm" variant="ghost" className="mt-2 h-8 text-danger" disabled={busy === indent.indentNo} onClick={() => void cancel(indent)}>
                      <X className="mr-1 h-3.5 w-3.5" />Cancel request
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </Panel>
    </div>
  );
}
