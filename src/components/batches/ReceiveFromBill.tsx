import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { billPlan, billSummary, costOf, lineBlocker, type BillLine, type CostBasis } from "@/lib/bill-batches";
import { cn } from "@/lib/utils";

/*
 * Admin > Batches > Receive purchase: a batch per line of a Zoho bill. The admin picks the godown and a recent bill;
 * every line loads with its price breakup and both unit costs; the admin chooses which cost this bill's batches use,
 * may add manufacture / expiry dates and notes, and presses one button. Nothing is sent to Zoho and no stock changes:
 * the bill already brought the stock in.
 */

type Godown = { id: string; name: string; zohoLinked: boolean };
type BillRow = { billId: string; billNumber: string; vendorName: string; date: string; total: number; status: string; batchedLines: number };
type Line = BillLine & { productId: string; productName: string; batchId: string; batchCode: string; blocker: string };
type Bill = Omit<ReturnType<typeof billPlan>, "lines"> & { lines: Line[] };
type Extra = { mfgDate: string; expiryDate: string; notes: string };

const money = (n: number) => inrPrecise(n);
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`;
const day = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }) : "—");

export function ReceiveFromBillDialog({ open, onOpenChange, godowns, defaultGodown, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; godowns: Godown[]; defaultGodown?: string | undefined;
  onSaved: (firstBatchId: string) => Promise<void>;
}) {
  const [branchId, setBranchId] = useState("");
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [bill, setBill] = useState<Bill | null>(null);
  const [otherGodown, setOtherGodown] = useState(false);
  const [billError, setBillError] = useState("");
  const [basis, setBasis] = useState<CostBasis | "">("");
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const usable = (id?: string) => (id && godowns.some((g) => g.id === id) ? id : "");
    setBranchId((current) => usable(current) || usable(defaultGodown) || godowns.find((g) => g.zohoLinked)?.id || godowns[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    setLoading(true); setBillError(""); setBill(null); setBasis(""); setExtras({});
    try {
      if (STATIC_DATA_MODE) { setBill(demoBill(billId)); setOtherGodown(false); return; }
      const { getBatchBill } = await import("@/lib/zoho-commerce.functions");
      const answer = await getBatchBill({ data: { branchId, billId } });
      setBill(answer.bill as Bill);
      setOtherGodown(answer.otherGodown);
    } catch (cause) {
      setBillError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const open_ = bill?.lines.filter((line) => !line.blocker) ?? [];
  const blockedBill = !bill || bill.status === "void" || otherGodown;
  const extra = (lineId: string): Extra => extras[lineId] ?? { mfgDate: "", expiryDate: "", notes: "" };
  const setExtra = (lineId: string, key: keyof Extra, value: string) => setExtras((all) => ({ ...all, [lineId]: { ...extra(lineId), [key]: value } }));

  const create = async (): Promise<void> => {
    if (!bill || blockedBill) return;
    if (!basis) return void toast.error("Choose cost without GST or cost with GST for this bill");
    if (!open_.length) return void toast.error("Every line of this bill already has a batch or can't have one");
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: batches are not saved"); return; }
      const { createBatchesFromBill } = await import("@/lib/zoho-commerce.functions");
      const result = await createBatchesFromBill({ data: {
        branchId, billId: bill.billId, costBasis: basis,
        lines: open_.map((line) => ({ lineId: line.lineId, mfgDate: extra(line.lineId).mfgDate || null, expiryDate: extra(line.lineId).expiryDate || null, notes: extra(line.lineId).notes })),
      } });
      toast.success(`${result.made.length} batch${result.made.length === 1 ? "" : "es"} made from bill ${result.billNumber}`, {
        description: `${result.made.map((m) => m.batch_code).join(", ")}. Stock is unchanged: it came in with the bill.`,
      });
      onOpenChange(false);
      setBill(null);
      await onSaved(result.made[0]?.batch_id ?? "");
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
          <DialogDescription>Pick the bill: each line becomes one batch with its own stock number. The bill already added the stock in Zoho, so stock does not change here.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-slate">Godown
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
                <span className={cn("col-span-2 text-xs", b.batchedLines ? "text-emerald-700" : "text-slate")}>
                  {b.batchedLines ? `${b.batchedLines} line${b.batchedLines === 1 ? "" : "s"} already batched` : "No batches yet"}
                </span>
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

            {otherGodown && <Warning text="This bill is for another godown in Zoho. Choose that godown to make its batches." />}
            {bill.warnings.map((w) => <Warning key={w} text={w} />)}

            <fieldset className="grid gap-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate">Cost these batches use</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["ex_gst", "inc_gst"] as const).map((value) => (
                  <label key={value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm", basis === value ? "border-navy bg-navy/5" : "border-border")}>
                    <input type="radio" name="cost-basis" className="mt-1" checked={basis === value} onChange={() => setBasis(value)} />
                    <span><span className="block font-semibold">{value === "ex_gst" ? "Cost without GST" : "Cost with GST"}</span>
                      <span className="block text-xs text-slate">{value === "ex_gst" ? "Taxable amount per unit. Use when GST paid is claimed back." : "Taxable amount plus GST per unit. Use when GST paid is a cost."}</span></span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate">Both costs are saved on each batch. Profit uses the one chosen here and says which.</p>
            </fieldset>

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
                  {!line.blocker && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="grid gap-1 text-xs font-semibold text-slate">Manufactured on<Input type="date" value={extra(line.lineId).mfgDate} onChange={(e) => setExtra(line.lineId, "mfgDate", e.target.value)} /></label>
                      <label className="grid gap-1 text-xs font-semibold text-slate">Expiry date<Input type="date" value={extra(line.lineId).expiryDate} onChange={(e) => setExtra(line.lineId, "expiryDate", e.target.value)} /></label>
                      <label className="grid gap-1 text-xs font-semibold text-slate">Notes<Input value={extra(line.lineId).notes} maxLength={300} placeholder="optional" onChange={(e) => setExtra(line.lineId, "notes", e.target.value)} /></label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {basis && open_.length > 0 && (
              <p className="text-sm font-semibold">{`${open_.length} batch${open_.length === 1 ? "" : "es"} · purchase value ${money(open_.reduce((sum, line) => sum + costOf(line, basis) * line.qty, 0))} (${basis === "inc_gst" ? "cost with GST" : "cost without GST"})`}</p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {bill && (
            <Button className="bg-navy text-white" disabled={busy || blockedBill || !basis || open_.length === 0} onClick={() => void create()}>
              {busy ? "Saving…" : open_.length === 0 ? "All lines done" : `Create ${open_.length} batch${open_.length === 1 ? "" : "es"}`}
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
  return DEMO.map((b) => ({ ...billSummary(b), batchedLines: b.bill_id === "B2" ? 1 : 0 }));
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
