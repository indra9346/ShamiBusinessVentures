import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import { addDays, dayLabel, incomingDraftProblem, incomingPreview, istToday, qtyText } from "@/lib/preorder";
import { cn } from "@/lib/utils";

/*
 * Admin › Batches › New pre-order (client, "Approved", 14 Nov 2026; spec 10 "IncomingBatchDialog"): goods ordered from a
 * supplier, not at the godown yet, put on sale under a batch made now. The godown (Zoho-linked only), then where the
 * order comes from (a Zoho purchase order line, or typed), then product, quantity, the expected cost before GST, the
 * expected date and how many to sell before arrival. Zoho's stock is read live, with the recent bills of the product
 * that are not received on the website: each must be received first or ticked "Not this purchase".
 */

type Setup = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["getIncomingSetup"]>>;
type PoRow = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["listOpenPurchaseOrders"]>>[number];
type PoLines = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["getPurchaseOrderLines"]>>;

const functions = () => import("@/lib/preorder.functions");
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const money = (n: number) => inrPrecise(n);
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));

export function IncomingBatchDialog({ open, onOpenChange, data, defaultGodown, onReceive, onSaved }: {
  open: boolean; onOpenChange: (open: boolean) => void; data: BatchData; defaultGodown?: string | undefined;
  /** "Receive it" on a bill listed below: that bill at its own godown (the dialog keeps what was typed meanwhile). */
  onReceive: (godownId: string, billId: string) => void; onSaved: (batchId: string) => Promise<void>;
}) {
  const today = istToday();
  const godowns = data.godowns.filter((g) => g.active && g.zohoLinked);
  const products = data.products.filter((p) => p.zohoLinked && !p.zohoTracksBatches);
  const [branchId, setBranchId] = useState(() => godowns.find((g) => g.id === defaultGodown)?.id ?? godowns[0]?.id ?? "");
  const [source, setSource] = useState<"po" | "typed">("typed");
  const [pos, setPos] = useState<PoRow[] | null>(null);
  const [poLines, setPoLines] = useState<PoLines | null>(null);
  const [poLine, setPoLine] = useState<{ poId: string; lineId: string } | null>(null);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [date, setDate] = useState(addDays(today, 7));
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState("");
  const [loading, setLoading] = useState(false);
  const [notThis, setNotThis] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // One id per opening of the dialog (review fix): a press repeated after a lost reply gets the lot it made, not a second.
  const [requestId, setRequestId] = useState(() => newRequestId());
  useEffect(() => { if (open) setRequestId(newRequestId()); }, [open]);

  const product = products.find((p) => p.id === productId);
  const quantity = Number(qty) || 0;
  const sellNow = sell === "" ? quantity : Number(sell) || 0;
  const holdBack = Math.max(0, Math.round((quantity - sellNow) * 100) / 100);
  const problem = incomingDraftProblem({ quantity, holdBack, unitCostExGst: Number(cost) || 0, expectedDate: date, unit: product?.unit ?? "" }, today);
  const here = setup?.godowns.find((g) => g.id === branchId);
  const unticked = (setup?.unreceived ?? []).filter((line) => !notThis.has(`${line.billId}|${line.lineId}`));

  // Zoho now, the hold a godown would start with, bills not received: read again whenever the godown or product changes.
  const loadSetup = useMemo(() => async (godown: string, product: string) => {
    if (!godown || !product) { setSetup(null); return; }
    setLoading(true); setSetupError(""); setNotThis(new Set());
    try {
      if (STATIC_DATA_MODE) { setSetup(null); return; }
      const { getIncomingSetup } = await functions();
      const answer = await getIncomingSetup({ data: { branchId: godown, productId: product } });
      setSetup(answer);
      setCost((current) => current || (answer.cost.lastBill ? String(answer.cost.lastBill) : ""));
    } catch (cause) {
      setSetup(null);
      setSetupError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (open) void loadSetup(branchId, productId); }, [open, branchId, productId, loadSetup]);

  const loadPos = async () => {
    setPos(null); setPoLines(null); setPoLine(null);
    try {
      if (STATIC_DATA_MODE) { setPos([]); return; }
      const { listOpenPurchaseOrders } = await functions();
      setPos(await listOpenPurchaseOrders({ data: { branchId } }));
    } catch (cause) {
      toast.error("Could not read Zoho's purchase orders", { description: errorText(cause) });
      setPos([]);
    }
  };
  const pickPo = async (poId: string) => {
    setPoLines(null); setPoLine(null);
    try {
      const { getPurchaseOrderLines } = await functions();
      setPoLines(await getPurchaseOrderLines({ data: { poId } }));
    } catch (cause) {
      toast.error("Could not read the purchase order", { description: errorText(cause) });
    }
  };
  const pickPoLine = (line: PoLines["lines"][number]) => {
    if (!poLines) return;
    setPoLine({ poId: poLines.po.poId, lineId: line.lineId });
    setProductId(line.productId);
    setQty(String(line.open));
    setSell("");
    setCost(String(line.rateExGst));
    setSupplier(poLines.po.vendorName);
    if (poLines.po.expectedDate && poLines.po.expectedDate >= today) setDate(poLines.po.expectedDate);
  };

  const save = async () => {
    if (problem) return void toast.error(problem);
    if (unticked.length) return void toast.error("Receive the listed bills first, or tick \"Not this purchase\" for each");
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { createIncomingBatch } = await functions();
      const made = await createIncomingBatch({ data: {
        branchId, productId, quantity, unitCostExGst: Number(cost), expectedDate: date, holdBack, supplier, notes,
        po: source === "po" ? poLine : null, notThisPurchase: [...notThis], requestId,
      } });
      const heldSomewhere = Object.values(made.heldAtOpen).some((n) => n > 0);
      toast.success(`Pre-order batch ${made.batchCode} made`, {
        description: `${qtyText(made.ready)} ready + ${qtyText(made.incoming)} arriving on sale at ${here?.name ?? "the godown"}.${heldSomewhere ? " Zoho rose since the last check somewhere: those units are held until matched or explained." : ""}`,
      });
      onOpenChange(false);
      await onSaved(made.batchId);
    } catch (cause) {
      toast.error("Could not make the pre-order batch", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>New pre-order</DialogTitle>
          <DialogDescription>Goods ordered from a supplier and not at the godown yet. Customers can order them now and collect after they arrive; the bill is matched to this batch when it comes.</DialogDescription>
        </DialogHeader>

        {!data.preorder.settings.enabled && (
          <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" />Pre-orders are switched off (Admin › Settings › Pre-orders).</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-slate">Godown (linked to Zoho)
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setPos(null); setPoLines(null); setPoLine(null); }} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <div className="grid gap-1 text-xs font-semibold text-slate">Ordered through
            <div className="flex rounded-md border border-input bg-white p-0.5 text-sm">
              {([["po", "A Zoho purchase order"], ["typed", "Typed in"]] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={source === key} onClick={() => { setSource(key); if (key === "po" && !pos) void loadPos(); if (key === "typed") setPoLine(null); }}
                  className={cn("flex-1 rounded px-2 py-1.5 font-semibold", source === key ? "bg-navy text-white" : "text-slate")}>{label}</button>
              ))}
            </div>
          </div>
        </div>

        {source === "po" && (
          <div className="grid gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate">Open purchase orders</p>
              <Button size="sm" variant="ghost" aria-label="Read purchase orders again" onClick={() => void loadPos()}><RefreshCw className="h-3.5 w-3.5" /></Button>
            </div>
            {pos === null && <p className="text-xs text-slate">Reading Zoho…</p>}
            {pos && pos.length === 0 && <p className="text-xs text-slate">No open purchase order in Zoho. Type the pre-order in instead.</p>}
            {pos && pos.length > 0 && !poLines && (
              <div className="grid max-h-56 gap-1.5 overflow-y-auto">
                {pos.map((po) => (
                  <button key={po.poId} type="button" onClick={() => void pickPo(po.poId)} className="grid min-w-0 grid-cols-[1fr_auto] gap-x-2 rounded-md border border-border p-2 text-left text-sm hover:border-gold">
                    <span className="truncate font-semibold text-navy"><FileText className="mr-1 inline h-3.5 w-3.5" />{po.number}</span>
                    <span className="text-right">{money(po.total)}</span>
                    <span className="truncate text-xs text-slate">{po.vendorName}</span>
                    <span className="text-right text-xs text-slate">{po.expectedDate ? `by ${dayLabel(po.expectedDate)}` : dayLabel(po.date)}</span>
                    {!po.here && <span className="col-span-2 text-[11px] text-amber-800">{`In Zoho at ${po.locationName || "another location"}`}</span>}
                  </button>
                ))}
              </div>
            )}
            {poLines && (
              <div className="grid gap-1.5">
                <button type="button" className="justify-self-start text-xs font-semibold text-navy underline" onClick={() => { setPoLines(null); setPoLine(null); }}>{`${poLines.po.number} · other purchase order`}</button>
                {poLines.lines.map((line) => (
                  <button key={line.lineId} type="button" disabled={Boolean(line.blocker)} onClick={() => pickPoLine(line)}
                    className={cn("grid min-w-0 gap-0.5 rounded-md border p-2 text-left text-sm", poLine?.lineId === line.lineId ? "border-gold bg-gold/10" : "border-border", line.blocker && "opacity-60")}>
                    <span className="font-semibold text-navy">{line.productName || line.name}</span>
                    <span className="text-xs text-slate">{`${qtyText(line.qty)} ordered${line.billedQty !== null ? ` · ${qtyText(line.billedQty)} billed` : ""}${line.inLots ? ` · ${qtyText(line.inLots)} in pre-orders` : ""} · ${money(line.rateExGst)} before GST`}</span>
                    {line.blocker && <span className="text-[11px] text-red-700">{line.blocker}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-slate sm:col-span-2">Product
            <select value={productId} disabled={source === "po" && Boolean(poLine)} onChange={(e) => setProductId(e.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
              <option value="">Choose the product</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Bags coming{product?.unit ? ` (${product.unit})` : ""}
            <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Expected cost per unit before GST
            <Input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Expected by
            <Input type="date" value={date} min={today} max={addDays(today, 180)} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">{`Sell before arrival: up to ${qtyText(sellNow)} of ${qtyText(quantity)}`}
            <Input type="number" min={0} max={quantity || undefined} value={sell === "" ? String(quantity || "") : sell} onChange={(e) => setSell(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Supplier<Input value={supplier} maxLength={120} onChange={(e) => setSupplier(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Notes<Input value={notes} maxLength={300} placeholder="optional" onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
        {setup && (
          <p className="text-[11px] text-slate">
            {setup.cost.lastBill ? `Last bill cost ${money(setup.cost.lastBill)} before GST (${setup.cost.lastBillCode}). ` : ""}
            {setup.cost.purchasePrice ? `Product's purchase price ${money(setup.cost.purchasePrice)} (shown only). ` : ""}
            The bill's real cost replaces the estimate when it is matched.
          </p>
        )}

        {loading && <p className="text-xs text-slate">Reading Zoho's stock and recent bills…</p>}
        {setupError && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{setupError}</p>}
        {setup && here && (
          <div className="grid gap-2 rounded-lg border border-gold/40 bg-ivory p-3 text-sm">
            <p className="font-semibold text-navy">{incomingPreview({ zohoNow: here.zoho, godown: setup.godown.code || here.name, ready: here.ready, readyAfter: here.readyAfter,
              quantity, holdBack, expectedDate: date, todayIst: today })}</p>
            {setup.godowns.filter((g) => g.openingHold > 0).map((g) => (
              <p key={g.id} className="text-xs text-amber-900">{`Held at opening: ${qtyText(g.openingHold)} at ${g.name} (Zoho rose since the website last read it; held until matched or explained)`}</p>
            ))}
            {setup.lots.length > 0 && <p className="text-xs text-slate">{`Other pre-orders of ${setup.product.name}: ${setup.lots.map((l) => `${l.code} (${qtyText(l.quantity)} by ${dayLabel(l.expectedDate)})`).join(", ")}`}</p>}
            {setup.blockers.map((b) => <p key={b} className="text-xs font-semibold text-red-700">{b}</p>)}
          </div>
        )}
        {setup && setup.unreceived.length > 0 && (
          <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
            <p className="font-semibold">Recent bills of this product not received on the website. Receive each first, or tick "Not this purchase" if it is another purchase:</p>
            {setup.unreceived.map((line) => {
              const key = `${line.billId}|${line.lineId}`;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white p-2">
                  <span className="min-w-0 break-words">{`Bill ${line.billNumber} · ${qtyText(line.qty)} · ${line.vendorName} · ${dayLabel(line.date)} · ${line.godownName}`}</span>
                  <span className="flex flex-wrap items-center gap-3">
                    <button type="button" className="font-semibold text-navy underline" onClick={() => onReceive(line.branchId || branchId, line.billId)}>Receive it</button>
                    <label className="flex items-center gap-1 font-semibold">
                      <input type="checkbox" checked={notThis.has(key)} onChange={(e) => setNotThis((all) => { const next = new Set(all); if (e.target.checked) next.add(key); else next.delete(key); return next; })} />
                      Not this purchase
                    </label>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {quantity > 0 && problem && <p className="text-xs text-red-700">{problem}</p>}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-navy text-white" disabled={busy || loading || !productId || !branchId || Boolean(problem) || unticked.length > 0 || Boolean(setup?.blockers.length) || !data.preorder.settings.enabled}
            onClick={() => void save()}>{busy ? "Making…" : "Make pre-order batch"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
