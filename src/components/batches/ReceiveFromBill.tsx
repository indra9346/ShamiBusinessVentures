import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { billPlan, billSummary, costOf, lineBlocker, type BillLine, type CostBasis } from "@/lib/bill-batches";
import { announceTransfer } from "@/components/batches/BatchTransfers";
import { dayLabel, istToday, matchCostChange, matchPlan, qtyText, unitsThatMove } from "@/lib/preorder";
import type { MatchedLine, PreorderCandidate } from "@/lib/zoho-commerce.functions";
import { cn } from "@/lib/utils";

/*
 * Admin > Batches > Receive purchase: a batch per line of a Zoho bill. The admin picks the godown where the goods were
 * unloaded and a recent bill; every line loads with its price breakup and both unit costs; the admin may add
 * manufacture / expiry dates and notes, and presses one button. A bill already at that godown in Zoho changes nothing
 * in Zoho (the bill brought the stock in). A bill at another Zoho location (another godown, Head Office) is moved to the
 * unloading godown with a Zoho transfer order first (client, 10 Nov 2026).
 * Batches use the cost without GST (10 Nov 2026). The business claims back the GST it pays, and sales are counted
 * without GST, so a cost with GST showed the GST as a loss. Both costs are still saved on each batch.
 */
const BASIS: CostBasis = "ex_gst";

type Godown = { id: string; name: string; zohoLinked: boolean };
/** A bill being moved to a godown right now (a receive transfer waiting for Zoho). */
type Moving = { transferNo: string; godownId: string; godownName: string } | null;
type BillRow = { billId: string; billNumber: string; vendorName: string; date: string; total: number; status: string; batchedLines: number; locationName: string; otherLocation: boolean; movingTo: Moving; preorderNote?: string };
type Line = BillLine & {
  productId: string; productName: string; batchId: string; batchCode: string; blocker: string;
  /** Pre-order batches this line may be matched to (14 Nov 2026), best first, and the default action. */
  preorderCandidates?: PreorderCandidate[]; defaultAction?: { action: "new" | "match"; matchBatchId: string };
};
type Bill = Omit<ReturnType<typeof billPlan>, "lines"> & { lines: Line[] };
type Extra = { mfgDate: string; expiryDate: string; notes: string };
/** What a line does: a new batch, or the match to a pre-order (spec 6). */
type Choice = { action: "new" | "match"; matchBatchId: string; rest: "coming" | "none"; restExpectedOn: string; notPreorderNote: string; allArrived: boolean };

const money = (n: number) => inrPrecise(n);
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
const day = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");

export function ReceiveFromBillDialog({ open, onOpenChange, godowns, defaultGodown, initialBillId, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; godowns: Godown[]; defaultGodown?: string | undefined;
  /** Opened from a pre-order's Match now with the one bill found: that bill opens at once. */
  initialBillId?: string | undefined;
  onSaved: (firstBatchId: string) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [branchId, setBranchId] = useState("");
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [bill, setBill] = useState<Bill | null>(null);
  const [otherGodown, setOtherGodown] = useState(false);
  const [movingTo, setMovingTo] = useState<Moving>(null);
  const [billError, setBillError] = useState("");
  const basis = BASIS;
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const usable = (id?: string) => (id && godowns.some((g) => g.id === id) ? id : "");
    setBranchId((current) => usable(defaultGodown) || usable(current) || godowns.find((g) => g.zohoLinked)?.id || godowns[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultGodown]);
  // A bill named by Match now opens as soon as the dialog does.
  useEffect(() => {
    if (open && initialBillId && branchId && bill?.billId !== initialBillId) void pick(initialBillId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialBillId, branchId]);

  const loadBills = useCallback(async (godown: string) => {
    if (!godown) return;
    setLoading(true); setListError(""); setBills(null); setBill(null);
    try {
      if (STATIC_DATA_MODE) { setBills(demoBills()); return; }
      const { listBatchBills } = await import("@/lib/zoho-commerce.functions");
      setBills((await listBatchBills({ data: { branchId: godown } })).bills);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (open && branchId) void loadBills(branchId); }, [open, branchId, loadBills]);

  const pick = async (billId: string) => {
    setLoading(true); setBillError(""); setBill(null); setExtras({}); setChoices({});
    try {
      if (STATIC_DATA_MODE) { setBill(demoBill(billId)); setOtherGodown(false); setMovingTo(null); return; }
      const { getBatchBill } = await import("@/lib/zoho-commerce.functions");
      const answer = await getBatchBill({ data: { branchId, billId } });
      setBill(answer.bill as Bill);
      // Each line starts as the screen suggests: matched to the best pre-order at this godown, else a new batch.
      setChoices(Object.fromEntries((answer.bill.lines as Line[]).map((line) => [line.lineId, {
        action: line.defaultAction?.action ?? "new", matchBatchId: line.defaultAction?.matchBatchId ?? "", rest: "coming" as const,
        restExpectedOn: "", notPreorderNote: "", allArrived: false,
      }])));
      setOtherGodown(answer.otherGodown);
      setMovingTo(answer.movingTo);
    } catch (cause) {
      setBillError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const open_ = bill?.lines.filter((line) => !line.blocker) ?? [];
  // Being moved to another godown: that transfer is retried or cancelled first (the server refuses too). Being moved
  // here: pressing again tries that same transfer again.
  const movingElsewhere = Boolean(movingTo && movingTo.godownId !== branchId);
  // Being moved here already: a press only tries that move again, with the lines, dates and notes it was started with.
  const resuming = Boolean(movingTo && movingTo.godownId === branchId);
  const blockedBill = !bill || bill.status === "void" || movingElsewhere;
  const godownName = godowns.find((g) => g.id === branchId)?.name ?? "this godown";
  const extra = (lineId: string): Extra => extras[lineId] ?? { mfgDate: "", expiryDate: "", notes: "" };
  const setExtra = (lineId: string, key: keyof Extra, value: string) => setExtras((all) => ({ ...all, [lineId]: { ...extra(lineId), [key]: value } }));
  const choice = (lineId: string): Choice => choices[lineId] ?? { action: "new", matchBatchId: "", rest: "coming", restExpectedOn: "", notPreorderNote: "", allArrived: false };
  const setChoice = (lineId: string, patch: Partial<Choice>) => setChoices((all) => ({ ...all, [lineId]: { ...choice(lineId), ...patch } }));
  // What each open line will do, and what stops the Save (the database checks every rule again).
  const plans = open_.map((line) => {
    const c = choice(line.lineId);
    const here = (line.preorderCandidates ?? []).filter((cand) => cand.here);
    const lot = c.action === "match" ? here.find((cand) => cand.id === c.matchBatchId) : undefined;
    const qb = Math.round(line.qty * 100) / 100;
    const plan = lot ? matchPlan({ Q: lot.quantity, S: lot.sold, Qb: qb, rest: c.rest }) : null;
    const problem = c.action === "match"
      ? !lot ? "Choose the pre-order batch to match"
        : plan && !plan.ok ? `Bill ${bill?.billNumber ?? ""} has ${qtyText(qb)} of ${line.productName || line.name}, but customers already bought ${qtyText(lot.sold)} on batch ${lot.code}. Choose "the rest is still coming", or cancel and refund ${qtyText(lot.sold - qb)} of those orders first.`
        : !c.allArrived ? `Tick that all ${qtyText(qb)} bags of ${line.productName || line.name} are at ${godownName}` : ""
      : here.length && c.notPreorderNote.trim().length < 10 ? `${line.productName || line.name}: say why it is not pre-order batch ${here[0]!.code} (at least 10 letters)` : "";
    return { line, choice: c, lot, plan, problem, here };
  });
  const firstProblem = plans.find((p) => p.problem)?.problem ?? "";

  const create = async (): Promise<void> => {
    if (!bill || blockedBill) return;
    if (!open_.length) return void toast.error("Every line of this bill already has a batch or can't have one");
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: batches are not saved"); return; }
      const { createBatchesFromBill } = await import("@/lib/zoho-commerce.functions");
      if (firstProblem) { toast.error(firstProblem); return; }
      const result = await createBatchesFromBill({ data: {
        branchId, billId: bill.billId, costBasis: basis,
        lines: open_.map((line) => {
          const c = choice(line.lineId);
          return {
            lineId: line.lineId, mfgDate: extra(line.lineId).mfgDate || null, expiryDate: extra(line.lineId).expiryDate || null, notes: extra(line.lineId).notes,
            action: c.action, matchBatchId: c.action === "match" ? c.matchBatchId : null, rest: c.rest, restExpectedOn: c.restExpectedOn || null,
            notPreorderNote: c.action === "new" ? c.notPreorderNote.trim() : "", allArrived: c.allArrived,
          };
        }),
      } });
      if (result.transfer) {
        // Moved from the bill's Zoho location first: done, waiting for Zoho, or refused (nothing moved).
        announceTransfer(result.transfer);
        if (result.transfer.status === "cancelled") return;
      } else {
        if (result.made.length) toast.success(`${result.made.length} batch${result.made.length === 1 ? "" : "es"} made from bill ${result.billNumber}`, {
          description: `${result.made.map((m) => m.batch_code).join(", ")}. Stock is unchanged: it came in with the bill.`,
        });
        for (const m of result.matched) announceMatch(m, result.billNumber);
        for (const warning of result.warnings) toast.warning(warning, { duration: 15000 });
      }
      onOpenChange(false);
      setBill(null);
      await onSaved(result.made[0]?.batch_id ?? result.matched[0]?.batchId ?? "");
    } catch (cause) {
      toast.error("Could not make the batches", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Receive purchase from a Zoho bill</DialogTitle>
          <DialogDescription>Choose where the goods were unloaded, then the bill: each line becomes one batch with its own stock number at that godown. If Zoho has the bill at another place, the stock is moved here in Zoho with a transfer order.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-slate">Unloaded at godown
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <Button size="sm" variant="outline" disabled={loading || !branchId} onClick={() => void loadBills(branchId)}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh bills</Button>
        </div>

        {listError && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{listError}</p>}

        {!bill && bills && (
          <div className="grid gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">Recent bills</p>
            {bills.length === 0 && <p className="text-sm text-slate">No recent bills for this godown in Zoho.</p>}
            {bills.map((b) => (
              <button key={b.billId} type="button" disabled={loading} onClick={() => void pick(b.billId)}
                className="grid min-w-0 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-white p-3 text-left text-sm transition hover:border-gold">
                <span className="truncate font-semibold text-navy"><FileText className="mr-1 inline h-3.5 w-3.5" />{b.billNumber}</span>
                <span className="text-right font-semibold">{money(b.total)}</span>
                <span className="truncate text-slate">{b.vendorName}</span>
                <span className="text-right text-xs text-slate">{day(b.date)}</span>
                {b.preorderNote && <span className="col-span-2 text-xs font-semibold text-amber-800">{b.preorderNote}</span>}
                <span className={cn("col-span-2 text-xs", b.batchedLines ? "text-emerald-700" : "text-slate")}>
                  {b.batchedLines ? `${b.batchedLines} line${b.batchedLines === 1 ? "" : "s"} already batched` : "No batches yet"}
                  {b.locationName ? ` · In Zoho at ${b.locationName}` : ""}
                </span>
                {b.movingTo && (
                  <span className="col-span-2 text-xs font-semibold text-amber-800">{`Being moved to ${b.movingTo.godownName} in Zoho (${b.movingTo.transferNo}), waiting for Zoho`}</span>
                )}
                {b.otherLocation && !b.batchedLines && !b.movingTo && (
                  <span className="col-span-2 text-xs font-semibold text-amber-800">{`Receiving here moves it from ${b.locationName || "its Zoho location"} to ${godownName} in Zoho`}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {billError && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{billError}</p>}

        {bill && (
          <div className="grid min-w-0 gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-gold/40 bg-ivory p-3">
              <div className="min-w-0">
                <p className="font-mono text-lg font-bold text-navy">{bill.billNumber}</p>
                <p className="truncate text-sm text-charcoal">{bill.vendorName}</p>
                <p className="text-xs text-slate">{`Bill date ${day(bill.date)}`}</p>
              </div>
              <dl className="grid grid-cols-[auto_auto] gap-x-3 text-right text-xs">
                <dt className="text-slate">Sub total</dt><dd>{money(bill.subTotal)}</dd>
                <dt className="text-slate">GST</dt><dd>{money(bill.taxTotal)}</dd>
                {bill.billDiscount !== 0 && <><dt className="text-amber-800">Discount on whole bill</dt><dd className="text-amber-800">{`−${money(bill.billDiscount)}`}</dd></>}
                {bill.adjustment !== 0 && <><dt className="text-slate">Round-off</dt><dd>{money(bill.adjustment)}</dd></>}
                <dt className="font-semibold">Total</dt><dd className="font-semibold">{money(bill.total)}</dd>
              </dl>
              <Button size="sm" variant="ghost" onClick={() => setBill(null)}>Other bill</Button>
            </div>

            {otherGodown && (
              <p className="flex gap-2 rounded-md border border-sky-300 bg-sky-50 p-2 text-xs text-sky-950">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {`Zoho has this bill's stock at ${bill.locationName || "another location"}. Receiving it at ${godownName} first moves the units there in Zoho with a transfer order (numbered GB-TR-…), then makes the batches here. The bill itself is not changed.`}
              </p>
            )}
            {movingTo && (
              <Warning text={movingTo.godownId === branchId
                ? `This bill is already being moved here in Zoho (${movingTo.transferNo}) and waits for Zoho. Pressing below tries that same transfer again, with the lines, dates and notes it was started with: it looks it up in Zoho first and never makes a second one.`
                : `This bill is being moved to ${movingTo.godownName} in Zoho (${movingTo.transferNo}). Press Retry or Cancel on it under Transfers waiting for Zoho before receiving it anywhere else.`} />
            )}
            {bill.warnings.map((w) => <Warning key={w} text={w} />)}

            <p className="rounded-lg border border-border p-3 text-xs text-slate">
              These batches use the <span className="font-semibold text-navy">cost without GST</span>, because the GST paid on purchases is claimed back and sales are counted without GST too. Both costs are saved on each batch.
            </p>

            <div className="grid gap-2">
              {bill.lines.map((line) => (
                <div key={line.lineId} className={cn("grid min-w-0 gap-2 rounded-lg border p-3", line.blocker ? "border-border bg-slate-50" : "border-border bg-white")}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-navy">{line.name}</p>
                      <p className="text-xs text-slate">{[line.productName && line.productName !== line.name ? `Website: ${line.productName}` : "", line.hsn ? `HSN ${line.hsn}` : ""].filter(Boolean).join(" · ")}</p>
                    </div>
                    {line.batchCode
                      ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"><CheckCircle2 className="mr-1 inline h-3 w-3" />{`Done · ${line.batchCode}`}</span>
                      : line.blocker ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate">{line.blocker}</span> : null}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
                    <Item label="Quantity" value={String(line.qty)} />
                    <Item label="Rate before GST" value={money(line.rate)} />
                    <Item label="Line discount" value={line.discount ? `−${money(line.discount)}${line.discountLabel.endsWith("%") ? ` (${line.discountLabel})` : ""}` : "—"} />
                    <Item label="Taxable amount" value={money(line.taxable)} />
                    <Item label={line.interState ? `IGST ${pct(line.gstPct)}` : `GST ${pct(line.gstPct)}`}
                      value={line.interState ? money(line.igst) : `${money(line.cgst)} + ${money(line.sgst)}`}
                      hint={line.interState ? undefined : `CGST ${pct(line.gstPct / 2)} + SGST ${pct(line.gstPct / 2)}`} />
                    <Item label="Line total with GST" value={money(line.lineTotal)} />
                    <Item label="Cost per unit without GST" value={money(line.unitExGst)} strong={basis === "ex_gst"} />
                    <Item label="Cost per unit with GST" value={money(line.unitIncGst)} strong={basis === "inc_gst"} />
                  </dl>
                  {!line.blocker && !resuming && (line.preorderCandidates?.length ?? 0) > 0 && (
                    <PreorderChoice line={line} choice={choice(line.lineId)} setChoice={(patch) => setChoice(line.lineId, patch)} godownName={godownName} billNumber={bill.billNumber} />
                  )}
                  {!line.blocker && !resuming && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="grid gap-1 text-xs font-semibold text-slate">Manufactured on<Input type="date" value={extra(line.lineId).mfgDate} onChange={(e) => setExtra(line.lineId, "mfgDate", e.target.value)} /></label>
                      <label className="grid gap-1 text-xs font-semibold text-slate">Expiry date<Input type="date" value={extra(line.lineId).expiryDate} onChange={(e) => setExtra(line.lineId, "expiryDate", e.target.value)} /></label>
                      <label className="grid gap-1 text-xs font-semibold text-slate">Notes<Input value={extra(line.lineId).notes} maxLength={300} placeholder="optional" onChange={(e) => setExtra(line.lineId, "notes", e.target.value)} /></label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {bill.lines.some((line) => line.chargeLine) && (
              // Freight, hamali and other charges on the supplier's bill (spec 8.1). Hook for the batch expenses build:
              // pre-ticked here and tagged to the batches made or matched from this bill (chargeTags).
              <div className="rounded-lg border border-border p-3 text-xs">
                <p className="font-semibold text-navy">Freight and other lines on this bill</p>
                {bill.lines.filter((line) => line.chargeLine).map((line) => (
                  <p key={line.lineId} className="mt-1 text-slate">{`${line.name || line.accountName || "Charge"}${line.accountName ? ` (${line.accountName})` : ""}: ${money(line.taxable)} before GST`}</p>
                ))}
                {bill.billDiscount !== 0 && <p className="mt-1 text-slate">{`Discount on the whole bill: −${money(bill.billDiscount)}`}</p>}
                {bill.adjustment !== 0 && <p className="mt-1 text-slate">{`Adjustment / round-off: ${money(bill.adjustment)}`}</p>}
              </div>
            )}
            {plans.some((p) => p.lot) && (
              <div className="grid gap-1 rounded-lg border border-sky-300 bg-sky-50 p-3 text-xs text-sky-950">
                <p className="font-semibold">Before you save</p>
                {plans.filter((p) => p.lot && p.plan?.ok).map(({ line, lot, plan }) => {
                  const change = matchCostChange({ estimate: lot!.estUnitCostExGst ?? 0, bill: line.unitExGst, sold: lot!.sold });
                  const waitingOrders = new Set(lot!.allocations.map((a) => a.orderNo)).size;
                  const moved = plan && plan.ok && plan.move > 0 ? unitsThatMove(lot!.allocations, plan.move) : [];
                  return (
                    <p key={line.lineId} className="break-words">
                      {`${lot!.code}: cost before GST ${money(line.unitExGst)} for all ${qtyText(plan && plan.ok ? plan.quantity : line.qty)} (${change.profit >= 0 ? "+" : "−"}${money(Math.abs(change.profit))} profit on ${qtyText(lot!.sold)} sold)`}
                      {plan && plan.ok && plan.remainder ? ` · the rest ${qtyText(plan.remainder.quantity)} stays a pre-order (${lot!.code}-R)` : ""}
                      {` · ${Math.max(0, waitingOrders - moved.length)} waiting order${waitingOrders - moved.length === 1 ? "" : "s"} become ready`}
                      {moved.length ? ` · ${moved.map((m) => `${m.orderNo} (${qtyText(m.qty)})`).join(", ")} wait for the rest` : ""}
                    </p>
                  );
                })}
              </div>
            )}
            {firstProblem && <Warning text={firstProblem} />}
            {open_.length > 0 && (
              <p className="text-sm font-semibold">{`${open_.length} batch${open_.length === 1 ? "" : "es"} · purchase value ${money(open_.reduce((sum, line) => sum + costOf(line, basis) * line.qty, 0))} without GST`}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {bill && (
            <Button className="bg-navy text-white" disabled={busy || blockedBill || open_.length === 0} onClick={() => void create()}>
              {busy ? (otherGodown ? "Moving in Zoho…" : "Saving…") : resuming && movingTo ? `Try ${movingTo.transferNo} again` : open_.length === 0 ? "All lines done" : otherGodown ? `Move to ${godownName} and create ${open_.length} batch${open_.length === 1 ? "" : "es"}` : `Create ${open_.length} batch${open_.length === 1 ? "" : "es"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Warning({ text }: { text: string }) {
  return <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" />{text}</p>;
}

function Item({ label, value, hint, strong }: { label: string; value: string; hint?: string | undefined; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate">{label}</dt>
      <dd className={cn("break-words", strong ? "font-bold text-navy" : "text-charcoal")}>{value}</dd>
      {hint && <dd className="text-[11px] text-slate">{hint}</dd>}
    </div>
  );
}

// ------------------------------------------------------------------ static preview: the client's real bills of 3 Nov 2026

const demoLine = (id: string, name: string, qty: number, rate: number, itemTotal: number, hsn: string, extra: Record<string, unknown> = {}) => ({
  line_item_id: id, item_id: `I-${id}`, name, quantity: qty, rate, item_total: itemTotal, tax_percentage: 5, tax_name: "GST5", item_type: "inventory", hsn_or_sac: hsn, ...extra,
});
const DEMO = [
  { bill_id: "B1", bill_number: "SS4463", vendor_name: "NIRANJANA ENTERPRISES", date: "2026-11-03", status: "paid", tax_specification: "intra", discount_type: "item_level",
    sub_total: 2111.22, tax_total: 105.56, adjustment: 0.22, total: 2217, line_items: [
      demoLine("L1", "M Bisebelebath 17 GM", 2, 98.04, 196.08, "09109100"),
      demoLine("L2", "M Sambar 17GM", 6, 98.04, 553.24, "09109100", { discount: 35 }),
      demoLine("L3", "C meera Coconut oil 500ML", 6, 198.41, 1190.46, "15131900"),
      demoLine("L4", "E Zandu ultra balm 8ML", 4, 42.86, 171.44, "30049011"),
    ] },
  { bill_id: "B2", bill_number: "VS903", vendor_name: "SHAKTHIDHARA ENTERPRISES", date: "2026-11-03", status: "paid", tax_specification: "intra", discount_type: "item_level",
    sub_total: 1485.72, tax_total: 74.28, adjustment: 0, total: 1560, line_items: [demoLine("L5", "Ekadantha OIL 850ML", 12, 123.81, 1485.72, "15081000")] },
  { bill_id: "B3", bill_number: "LG-12", vendor_name: "Sample Rice Traders", date: "2026-11-02", status: "paid", tax_specification: "intra", discount_type: "entity_level",
    discount: 50, discount_amount: 50, sub_total: 1000, tax_total: 50, adjustment: 0, total: 1000, line_items: [
      demoLine("L6", "Long Grain Basumathi Rice", 1, 1000, 1000, "", { item_type: "sales_and_purchases" }),
    ] },
];
function demoBills(): BillRow[] {
  return DEMO.map((b) => ({ ...billSummary(b), batchedLines: b.bill_id === "B2" ? 1 : 0, otherLocation: false, movingTo: null }));
}
function demoBill(billId: string): Bill {
  const raw = DEMO.find((b) => b.bill_id === billId) ?? DEMO[0]!;
  const plan = billPlan(raw);
  return {
    ...plan,
    lines: plan.lines.map((line) => {
      const batchCode = line.lineId === "L5" ? "CLK-031126-05" : "";
      const productId = line.lineId === "L6" ? "P-BASU" : `P-${line.lineId}`;
      return { ...line, productId, productName: line.name, batchId: batchCode ? "demo" : "", batchCode, blocker: lineBlocker(line, { productId, zohoTracksBatches: false, batchCode }) };
    }),
  };
}

/** A pre-order batch was matched to a bill line: what happened, said once. */
function announceMatch(m: MatchedLine, billNumber: string) {
  const parts = [
    `Cost before GST ${money(m.costBefore)} → ${money(m.costNow)} for every unit, sold ones too.`,
    m.arrivedOrders.length ? `${m.arrivedOrders.length} waiting order${m.arrivedOrders.length === 1 ? "" : "s"} told the goods arrived; invoices and pickup QRs follow.` : "",
    m.remainder ? `The rest (${qtyText(m.remainder.quantity)}) stays a pre-order as ${m.remainder.code}, expected by ${dayLabel(m.remainder.expectedDate)}.` : "",
    m.movedOrders.length ? `${m.movedOrders.join(", ")} wait for the rest.` : "",
  ].filter(Boolean);
  toast.success(`Pre-order batch ${m.batchCode} matched to bill ${billNumber}`, { description: parts.join(" "), duration: 12000 });
}

/**
 * What a bill line of a product with a pre-order batch does (spec 10): match it to a lot at this godown (the best one is
 * chosen already) or make a new batch with the reason; for a short bill, whether the rest is still coming; the tick that
 * every bag is here; the bill's cost against the estimate.
 */
function PreorderChoice({ line, choice, setChoice, godownName, billNumber }: {
  line: Line; choice: Choice; setChoice: (patch: Partial<Choice>) => void; godownName: string; billNumber: string;
}) {
  const candidates = line.preorderCandidates ?? [];
  const here = candidates.filter((c) => c.here);
  const elsewhere = candidates.filter((c) => !c.here);
  const lot = choice.action === "match" ? here.find((c) => c.id === choice.matchBatchId) : undefined;
  const qb = Math.round(line.qty * 100) / 100;
  const short = lot ? qb < lot.quantity : false;
  const noneRefused = lot ? !matchPlan({ Q: lot.quantity, S: lot.sold, Qb: qb, rest: "none" }).ok : false;
  const plan = lot ? matchPlan({ Q: lot.quantity, S: lot.sold, Qb: qb, rest: "coming" }) : null;
  const moving = lot && plan && plan.ok && plan.move > 0 ? unitsThatMove(lot.allocations, plan.move) : [];
  const cost = lot ? matchCostChange({ estimate: lot.estUnitCostExGst ?? 0, bill: line.unitExGst, sold: lot.sold }) : null;
  return (
    <div className="grid gap-2 rounded-md border border-amber-300 bg-amber-50/60 p-2 text-xs">
      <p className="font-semibold text-navy">What to do</p>
      {here.map((c) => (
        <label key={c.id} className="flex items-start gap-2">
          <input type="radio" className="mt-0.5" checked={choice.action === "match" && choice.matchBatchId === c.id} disabled={c.pausedReason === "receiving"}
            onChange={() => setChoice({ action: "match", matchBatchId: c.id })} />
          <span className="min-w-0 break-words">
            {`Match to pre-order ${c.code} — ${qtyText(c.quantity)} expected by ${dayLabel(c.expectedDate)}, ${qtyText(c.sold)} sold, est. ${money(c.estUnitCostExGst ?? 0)}`}
            {c.poMatch ? " · same purchase order" : ""}{c.note ? ` · ${c.note}` : ""}
          </span>
        </label>
      ))}
      <label className="flex items-start gap-2">
        <input type="radio" className="mt-0.5" checked={choice.action === "new"} onChange={() => setChoice({ action: "new" })} />
        <span>New batch — a different purchase</span>
      </label>
      {choice.action === "new" && here.length > 0 && (
        <Input value={choice.notPreorderNote} maxLength={300} placeholder={`Why this is not pre-order ${here[0]!.code} (at least 10 letters)`}
          onChange={(e) => setChoice({ notPreorderNote: e.target.value })} />
      )}
      {elsewhere.map((c) => <p key={c.id} className="text-slate">{`Pre-order ${c.code} is ${c.note}`}</p>)}
      {lot && short && (
        <div className="grid gap-1 rounded border border-amber-200 bg-white p-2">
          <label className="flex flex-wrap items-center gap-2">
            <input type="radio" checked={choice.rest === "coming"} onChange={() => setChoice({ rest: "coming" })} />
            <span>{`The rest (${qtyText(lot.quantity - qb)}) is still coming — expected by`}</span>
            <Input type="date" className="h-8 w-40" value={choice.restExpectedOn || lot.expectedDate} min={istToday()} onChange={(e) => setChoice({ rest: "coming", restExpectedOn: e.target.value })} />
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={choice.rest === "none"} disabled={noneRefused} onChange={() => setChoice({ rest: "none" })} />
            <span className={cn(noneRefused && "text-slate")}>Nothing more is coming</span>
          </label>
          {moving.length > 0 && (
            <p className="text-red-700">{`${qtyText(lot.sold - qb)} sold units are not on bill ${billNumber}; they wait for the rest: ${moving.map((m) => `${m.orderNo} (${qtyText(m.qty)})`).join(", ")}`}</p>
          )}
        </div>
      )}
      {lot && (
        <label className="flex items-start gap-2 font-semibold">
          <input type="checkbox" className="mt-0.5" checked={choice.allArrived} onChange={(e) => setChoice({ allArrived: e.target.checked })} />
          <span>{`All ${qtyText(qb)} bags of this line are at ${godownName}`}</span>
        </label>
      )}
      {lot && cost && (
        <p className="text-slate">{`Bill ${money(line.unitExGst)} vs estimate ${money(lot.estUnitCostExGst ?? 0)} (${cost.perUnit >= 0 ? "+" : "−"}${money(Math.abs(cost.perUnit))} per unit; ${cost.profit >= 0 ? "+" : "−"}${money(Math.abs(cost.profit))} profit on ${qtyText(lot.sold)} sold)`}</p>
      )}
    </div>
  );
}
