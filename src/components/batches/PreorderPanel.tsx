import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Merge, PackageSearch, PauseCircle, Pencil, PlayCircle, RefreshCw, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Panel } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchData } from "@/lib/batches.functions";
import type { BatchRecord } from "@/lib/batches";
import {
  closeBlocker, dayLabel, incomingDraftProblem, istToday, lotBadges, lotLabel, lotOverdue, lotSellable, qtyText, unmatchBlocker,
  type Lot, type PreorderClock,
} from "@/lib/preorder";
import { cn } from "@/lib/utils";

/*
 * Admin › Batches: a pre-order batch (a lot, spec 10 "PreorderPanel"): what is expected, sold and held, the stock maths
 * of its godown, the hold box ("Zoho shows stock the website can't explain"), the customers waiting, and the actions
 * (edit, pause, join, move a line to ready stock, cancel). Customers' phones and addresses are never shown here.
 */

const money = (n: number) => inrPrecise(n);
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

/** A batches row as the pure rules see a lot. */
export const lotOf = (b: BatchRecord): Lot => ({
  id: b.id, code: b.batch_code, stage: b.stage ?? "received", quantity: b.quantity, remaining: b.remaining_quantity, holdBack: b.hold_back ?? 0,
  expectedDate: b.expected_date ?? "", paused: Boolean(b.selling_paused), pausedReason: b.paused_reason ?? "", createdAt: b.created_at,
});

/** Today in India, grace days and the switch, for the lot rules on this page. */
export const clockOf = (data: BatchData): PreorderClock => ({
  todayIst: istToday(), graceDays: data.preorder.settings.graceDays, on: data.preorder.settings.enabled && data.zohoStockMaster,
});

/** The watch row of a godown and product (held units, Zoho's last number), if the product has a lot anywhere. */
export const watchOf = (data: BatchData, branchId: string | null, productId: string) =>
  data.preorder.watches.find((w) => w.branch_id === branchId && w.product_id === productId);

/** The orders holding units of a batch (order number, units, status; no customer details). */
export function lotOrders(data: BatchData, batchId: string) {
  const rows: { orderItemId: string; orderNo: string; qty: number; status: string; createdAt: string }[] = [];
  for (const a of data.allocations) {
    if (a.batch_id !== batchId || a.reserved_quantity <= a.released_quantity) continue;
    const item = data.items.find((i) => i.id === a.order_item_id);
    const order = item ? data.orders.find((o) => o.id === item.order_id) : undefined;
    if (!item || !order) continue;
    const same = rows.find((r) => r.orderItemId === item.id);
    if (same) same.qty += a.reserved_quantity - a.released_quantity;
    else rows.push({ orderItemId: item.id, orderNo: order.order_no, qty: a.reserved_quantity - a.released_quantity, status: order.order_status, createdAt: order.created_at });
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function functions() {
  return import("@/lib/preorder.functions");
}

/** "Move to ready stock": an order line takes ready units instead of its pre-order units (admin_move_to_ready). */
export function MoveToReadyButton({ orderItemId, waiting, productName, onMoved }: { orderItemId: string; waiting: number; productName: string; onMoved: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(waiting));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const move = async () => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { moveOrderLineToReady } = await functions();
      await moveOrderLineToReady({ data: { orderItemId, qty: Number(qty), note } });
      toast.success(`${qty} ${productName} moved to ready stock`, { description: "If nothing else of the order waits, it goes on to Zoho now." });
      setOpen(false);
      await onMoved();
    } catch (cause) {
      toast.error("Could not move it to ready stock", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" className="mt-1 h-7 px-2 text-[11px]" onClick={() => { setQty(String(waiting)); setOpen(true); }}>Move to ready stock</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>{`Move ${productName} to ready stock`}</DialogTitle>
            <DialogDescription>{`${qtyText(waiting)} of this line wait for a pre-order batch. Units moved now come from the ready stock at the order's godown, and the batch gets them back for other customers.`}</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1 text-xs font-semibold text-slate">Units to move
            <Input type="number" min={1} max={waiting} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Note (optional)
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Keep waiting</Button>
            <Button className="bg-navy text-white" disabled={busy || !(Number(qty) > 0) || Number(qty) > waiting} onClick={() => void move()}>{busy ? "Moving…" : "Move to ready stock"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Maths = Awaited<ReturnType<Awaited<ReturnType<typeof functions>>["getPreorderMaths"]>>;

/** Zoho's last number, held, W, U, I and T at a godown, as the hold step uses them (spec 2.2). */
export function StockMaths({ branchId, productId, godown, refreshKey }: { branchId: string; productId: string; godown: string; refreshKey?: number }) {
  const [maths, setMaths] = useState<Maths | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) return;
    try {
      const { getPreorderMaths } = await functions();
      setMaths(await getPreorderMaths({ data: { branchId, productId } }));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [branchId, productId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (error) return <p className="text-xs text-red-700">{error}</p>;
  if (!maths) return <p className="text-xs text-slate">{STATIC_DATA_MODE ? "Stock maths are read from the database." : "Reading the stock maths…"}</p>;
  const row = (label: string, value: string, hint: string, tone?: "bad") => (
    <div className="min-w-0 rounded-md bg-ivory/70 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-slate">{label}</dt>
      <dd className={cn("font-semibold text-charcoal", tone === "bad" && "text-red-700")}>{value}</dd>
      <dd className="text-[10px] text-slate">{hint}</dd>
    </div>
  );
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
        {row("Zoho (Z)", maths.zoho === null ? "—" : qtyText(maths.zoho), `last read ${when(maths.readAt)}`)}
        {row("Held", qtyText(maths.held), maths.held > 0 ? `since ${when(maths.heldSince)}` : "nothing unexplained")}
        {row("Waiting orders (W)", qtyText(maths.waiting), "not in Zoho yet")}
        {row("To come (U)", qtyText(maths.unbilled), "pre-order units, no bill")}
        {row("Arriving left (I)", qtyText(maths.arriving), "not sold or held")}
        {row("Total (T)", qtyText(maths.total), "Z − held − W + U")}
        {row("Ready", qtyText(maths.ready), "T − I, not below 0")}
        {row("Arriving on sale", qtyText(maths.incoming), "open to pre-order")}
        {row("T − I", qtyText(maths.raw), maths.raw < 0 ? "promised units neither in stock nor on the way" : "never below 0", maths.raw < 0 ? "bad" : undefined)}
        {row("Edit waiting for Zoho", maths.pending ? qtyText(maths.pendingDelta) : "none", maths.pending ? "sent when nothing is held" : `at ${godown}`)}
      </dl>
      {maths.events.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-navy">{`What happened here (${maths.events.length})`}</summary>
          <ul className="mt-1 grid gap-1">
            {maths.events.map((e) => (
              <li key={e.id} className="rounded border border-border px-2 py-1">
                <span className="font-semibold">{e.kind.replace(/_/g, " ")}</span>{e.qty !== null ? ` · ${qtyText(e.qty)}` : ""}{` · ${when(e.created_at)}`}
                {e.by_name ? ` · ${e.by_name}` : ""}{e.note ? ` · ${e.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The hold box: Zoho rose and the website can't say why. Match the bill, or say what the stock is (guarded). */
export function HoldBox({ data, branchId, productId, productName, onMatch, onChanged }: {
  data: BatchData; branchId: string; productId: string; productName: string;
  onMatch: (branchId: string, billId?: string) => void; onChanged: () => Promise<void>;
}) {
  const watch = watchOf(data, branchId, productId);
  const godown = data.godowns.find((g) => g.id === branchId)?.name ?? branchId;
  const [finding, setFinding] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  if (!watch || watch.held <= 0) return null;
  const codes = data.batches.filter((b) => b.stage === "incoming" && b.product_id === productId && b.branch_id === branchId).map((b) => b.batch_code);
  const matchNow = async () => {
    setFinding(true);
    try {
      if (STATIC_DATA_MODE) { onMatch(branchId); return; }
      const { findBillsForProduct } = await functions();
      const { bills } = await findBillsForProduct({ data: { branchId, productId } });
      if (bills.length === 0) toast.message("No bill of this product here is waiting", { description: "Open Receive purchase to look through the recent bills." });
      onMatch(branchId, bills.length === 1 ? bills[0]!.billId : undefined);
    } catch (cause) {
      toast.error("Could not check the bills", { description: errorText(cause) });
    } finally {
      setFinding(false);
    }
  };
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="flex gap-2 font-semibold"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        {`Zoho shows ${qtyText(watch.held)} more ${productName} at ${godown} than the website counts (since ${when(watch.held_since)}). If it is the bill for pre-order batch ${codes.join(", ") || "(none here)"}, match it: Admin › Batches › Receive purchase. Those bags are not on sale until then.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" className="bg-navy text-white" disabled={finding} onClick={() => void matchNow()}><PackageSearch className="mr-1.5 h-3.5 w-3.5" />{finding ? "Checking bills…" : "Match now"}</Button>
        <Button size="sm" variant="outline" onClick={() => setReleaseOpen(true)}>It is other stock</Button>
      </div>
      {releaseOpen && <ReleaseHoldDialog branchId={branchId} productId={productId} productName={productName} godown={godown} held={watch.held}
        onClose={() => setReleaseOpen(false)} onDone={async () => { setReleaseOpen(false); await onChanged(); }} />}
    </div>
  );
}

function ReleaseHoldDialog({ branchId, productId, productName, godown, held, onClose, onDone }: {
  branchId: string; productId: string; productName: string; godown: string; held: number; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [bills, setBills] = useState<{ billId: string; billNumber: string; lineId: string; qty: number; vendorName: string; date: string }[] | null>(null);
  const [error, setError] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState(String(held));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (STATIC_DATA_MODE) { setBills([]); return; }
    void (async () => {
      try {
        const { findBillsForProduct } = await functions();
        setBills((await findBillsForProduct({ data: { branchId, productId } })).bills);
      } catch (cause) {
        setError(errorText(cause));
      }
    })();
  }, [branchId, productId]);
  const release = async () => {
    setBusy(true);
    try {
      const { releasePreorderHold } = await functions();
      await releasePreorderHold({ data: { branchId, productId, qty: Number(qty), note, regularBills: [...ticked] } });
      toast.success(`${qty} ${productName} at ${godown} now count as stock`);
      await onDone();
    } catch (cause) {
      toast.error("Could not release the held stock", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`What is the held ${productName} at ${godown}?`}</DialogTitle>
          <DialogDescription>Only when these units are not a pre-order's bill (another supplier's bill typed only in Zoho, a credit note, a move in Zoho). They then count as ready stock. A pre-order's bill is matched instead.</DialogDescription>
        </DialogHeader>
        {error && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {bills === null && !error && <p className="text-xs text-slate">Checking the recent bills…</p>}
        {bills && bills.length > 0 && (
          <div className="grid gap-1.5">
            <p className="text-xs font-semibold text-slate">Recent bills of this product here, not received on the website. Tick only those that are regular stock:</p>
            {bills.map((b) => {
              const key = `${b.billId}|${b.lineId}`;
              return (
                <label key={key} className="flex items-start gap-2 rounded border border-border p-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={ticked.has(key)} onChange={(e) => setTicked((all) => { const next = new Set(all); if (e.target.checked) next.add(key); else next.delete(key); return next; })} />
                  <span className="min-w-0 break-words">{`Bill ${b.billNumber} · ${qtyText(b.qty)} · ${b.vendorName} · ${dayLabel(b.date)} — regular stock, not this pre-order`}</span>
                </label>
              );
            })}
          </div>
        )}
        <label className="grid gap-1 text-xs font-semibold text-slate">Units that are other stock
          <Input type="number" min={1} max={held} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-slate">Say what this stock is (at least 10 letters)
          <Textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: credit note from the supplier for 5 bags returned last week" />
        </label>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Keep it held</Button>
          <Button className="bg-navy text-white" disabled={busy || note.trim().length < 10 || !(Number(qty) > 0) || Number(qty) > held} onClick={() => void release()}>{busy ? "Saving…" : "It is other stock"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Admin › Batches › a pre-order batch: the lot, its godown's stock maths, the hold box, waiting customers, actions. */
export function PreorderPanel({ batch, data, onChanged, onMatch }: {
  batch: BatchRecord; data: BatchData; onChanged: () => Promise<void>; onMatch: (branchId: string, billId?: string) => void;
}) {
  const clock = clockOf(data);
  const lot = lotOf(batch);
  const godown = data.godowns.find((g) => g.id === batch.branch_id)?.name ?? "";
  const watch = watchOf(data, batch.branch_id, batch.product_id);
  const sold = Math.round((batch.quantity - batch.remaining_quantity) * 100) / 100;
  const open = lotSellable(lot, clock);
  const orders = lotOrders(data, batch.id);
  const waiting = orders.reduce((sum, o) => sum + o.qty, 0);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mathsKey, setMathsKey] = useState(0);
  const changed = async () => { setMathsKey((k) => k + 1); await onChanged(); };
  const others = data.batches.filter((b) => b.id !== batch.id && b.stage === "incoming" && b.product_id === batch.product_id && b.branch_id === batch.branch_id);
  // Expenses tagged to it (freight paid ahead) stay for the profit: untag them, or join the lot into another, first.
  const cancelWhy = closeBlocker(lot, { waiting, tagged: data.costTags.some((t) => t.batch_id === batch.id) });
  const setPaused = async (paused: boolean) => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { updateIncomingBatch } = await functions();
      await updateIncomingBatch({ data: { batchId: batch.id, paused, note: paused ? "Paused by admin" : "Resumed by admin" } });
      toast.success(paused ? `Pre-order batch ${batch.batch_code} paused: nothing more is sold from it` : `Pre-order batch ${batch.batch_code} is selling again`);
      await changed();
    } catch (cause) {
      toast.error("Could not change the batch", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-4">
      <Panel title={`Pre-order batch ${batch.batch_code}`}>
        <div className="flex flex-wrap gap-1.5">
          {lotBadges(lot, clock, { held: watch?.held ?? 0 }).map((badge) => (
            <span key={badge} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold",
              badge === "Overdue" || badge.startsWith("Zoho") ? "bg-red-100 text-red-800" : badge.startsWith("Paused") ? "bg-slate-200 text-slate" : badge === "Selling" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900")}>{badge}</span>
          ))}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Fig label="Expected" value={qtyText(batch.quantity)} />
          <Fig label="Sold ahead" value={qtyText(sold)} />
          <Fig label="Held at godown" value={qtyText(watch?.held ?? 0)} />
          <Fig label="Open to pre-order" value={qtyText(open)} />
          <Fig label="Held back" value={qtyText(batch.hold_back ?? 0)} />
          <Fig label="Expected by" value={dayLabel(batch.expected_date, { full: true })} tone={lotOverdue(lot, clock) ? "bad" : undefined} />
          <Fig label="Purchase order" value={batch.zoho_po_number || "Typed in"} />
          <Fig label="Cost before GST" value={`${money(batch.est_unit_cost_ex_gst ?? batch.unit_cost)} (estimate until the bill)`} />
        </dl>
        <p className="mt-2 text-xs text-slate">
          <span>{lotLabel(lot, clock.todayIst)}</span><span>{` · ${godown}`}</span>
          {batch.supplier && <span>{` · supplier ${batch.supplier}`}</span>}
          {batch.received_by_name && <span>{` · made by ${batch.received_by_name}`}</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={batch.paused_reason === "receiving"} onClick={() => setEditOpen(true)}><Pencil className="mr-1.5 h-3.5 w-3.5" />Edit pre-order</Button>
          {batch.selling_paused
            ? <Button size="sm" variant="outline" disabled={busy || batch.paused_reason === "receiving"} onClick={() => void setPaused(false)}><PlayCircle className="mr-1.5 h-3.5 w-3.5" />Resume selling</Button>
            : <Button size="sm" variant="outline" disabled={busy} onClick={() => void setPaused(true)}><PauseCircle className="mr-1.5 h-3.5 w-3.5" />Pause selling</Button>}
          {others.length > 0 && <Button size="sm" variant="outline" onClick={() => setJoinOpen(true)}><Merge className="mr-1.5 h-3.5 w-3.5" />Join with another pre-order</Button>}
          <Button size="sm" className="bg-navy text-white" onClick={() => onMatch(batch.branch_id ?? "")}><PackageSearch className="mr-1.5 h-3.5 w-3.5" />Match a bill</Button>
          {cancelWhy
            ? <p className="max-w-sm text-[11px] text-slate">{cancelWhy}</p>
            : <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => setCancelOpen(true)}><XCircle className="mr-1.5 h-3.5 w-3.5" />Cancel pre-order</Button>}
        </div>
      </Panel>

      {batch.branch_id && <HoldBox data={data} branchId={batch.branch_id} productId={batch.product_id} productName={batch.product_name} onMatch={onMatch} onChanged={changed} />}

      <Panel title={`Stock maths at ${godown}`} action={<Button size="sm" variant="ghost" aria-label="Read the stock maths again" onClick={() => setMathsKey((k) => k + 1)}><RefreshCw className="h-3.5 w-3.5" /></Button>}>
        {batch.branch_id && <StockMaths branchId={batch.branch_id} productId={batch.product_id} godown={godown} refreshKey={mathsKey} />}
      </Panel>

      <Panel title={`Waiting customers (${orders.length})`}>
        {orders.length === 0 ? <p className="text-sm text-slate">Nobody has ordered from this batch yet.</p> : (
          <div className="grid gap-2">
            {orders.map((o) => (
              <div key={o.orderItemId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <span className="min-w-0"><span className="font-mono font-semibold text-navy">{o.orderNo}</span>{` · ${qtyText(o.qty)} waiting · ${o.status}`}</span>
                {o.status !== "Cancelled" && <MoveToReadyButton orderItemId={o.orderItemId} waiting={o.qty} productName={batch.product_name} onMoved={changed} />}
              </div>
            ))}
            <p className="text-xs text-slate">When the bill is short and the rest is still coming, orders awaiting payment wait longest, then the newest paid ones.</p>
          </div>
        )}
      </Panel>

      {editOpen && <EditLotDialog batch={batch} today={clock.todayIst} onClose={() => setEditOpen(false)} onSaved={async () => { setEditOpen(false); await changed(); }} />}
      {cancelOpen && <NoteDialog title={`Cancel pre-order batch ${batch.batch_code}?`} description="Nobody waits for its units. It stays in the list as cancelled, for the record."
        action="Cancel pre-order" placeholder="Why it is cancelled (supplier called it off…)" onClose={() => setCancelOpen(false)}
        onSubmit={async (note) => {
          const { cancelIncomingBatch } = await functions();
          await cancelIncomingBatch({ data: { batchId: batch.id, note } });
          toast.success(`Pre-order batch ${batch.batch_code} cancelled`);
          setCancelOpen(false);
          await changed();
        }} />}
      {joinOpen && <JoinDialog batch={batch} others={others} onClose={() => setJoinOpen(false)} onDone={async () => { setJoinOpen(false); await changed(); }} />}
    </div>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: "bad" | undefined }) {
  return (
    <div className="min-w-0 rounded-md bg-ivory/70 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-slate">{label}</dt>
      <dd className={cn("break-words font-semibold text-charcoal", tone === "bad" && "text-red-700")}>{value}</dd>
    </div>
  );
}

function EditLotDialog({ batch, today, onClose, onSaved }: { batch: BatchRecord; today: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [qty, setQty] = useState(String(batch.quantity));
  const [date, setDate] = useState(batch.expected_date ?? "");
  const [cost, setCost] = useState(String(batch.est_unit_cost_ex_gst ?? batch.unit_cost));
  const [holdBack, setHoldBack] = useState(String(batch.hold_back ?? 0));
  const [supplier, setSupplier] = useState(batch.supplier ?? "");
  const [notes, setNotes] = useState(batch.notes ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = incomingDraftProblem({ quantity: Number(qty), holdBack: Number(holdBack), unitCostExGst: Number(cost), expectedDate: date, unit: batch.unit }, date && date < today && date === batch.expected_date ? date : today);
  const save = async () => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { updateIncomingBatch } = await functions();
      const changedNumber = (now: string, was: number | null | undefined) => (Number(now) !== Number(was ?? NaN) ? Number(now) : null);
      await updateIncomingBatch({ data: {
        batchId: batch.id, quantity: changedNumber(qty, batch.quantity), expectedDate: date !== batch.expected_date ? date : null,
        unitCostExGst: changedNumber(cost, batch.est_unit_cost_ex_gst ?? batch.unit_cost), holdBack: changedNumber(holdBack, batch.hold_back ?? 0),
        supplier: supplier !== (batch.supplier ?? "") ? supplier : null, notes: notes !== (batch.notes ?? "") ? notes : null, note,
      } });
      toast.success(`Pre-order batch ${batch.batch_code} saved`, { description: date > (batch.expected_date ?? "") ? "Waiting customers are told the new date." : undefined });
      await onSaved();
    } catch (cause) {
      toast.error("Could not save the pre-order batch", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Edit pre-order batch ${batch.batch_code}`}</DialogTitle>
          <DialogDescription>The quantity can't go below what is already sold or held. A later date tells the waiting customers.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold text-slate">Expected quantity<Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Expected by<Input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Cost per unit before GST (estimate)<Input type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Hold back (not sold before arrival)<Input type="number" min={0} value={holdBack} onChange={(e) => setHoldBack(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Supplier<Input value={supplier} maxLength={120} onChange={(e) => setSupplier(e.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Notes<Input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></label>
        </div>
        <label className="grid gap-1 text-xs font-semibold text-slate">Why (kept with the change)<Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        {problem && <p className="text-xs text-red-700">{problem}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button className="bg-navy text-white" disabled={busy || Boolean(problem)} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JoinDialog({ batch, others, onClose, onDone }: { batch: BatchRecord; others: BatchRecord[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [from, setFrom] = useState(others[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      const { joinIncomingBatches } = await functions();
      await joinIncomingBatches({ data: { into: batch.id, from, note } });
      toast.success(`Joined into ${batch.batch_code}`);
      await onDone();
    } catch (cause) {
      toast.error("Could not join the batches", { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>{`Join a pre-order batch into ${batch.batch_code}`}</DialogTitle>
          <DialogDescription>When one bill line covers two pre-orders: the other's units, orders and expenses move here, and it is closed as joined.</DialogDescription>
        </DialogHeader>
        <select value={from} aria-label="Pre-order to join" onChange={(e) => setFrom(e.target.value)} className="h-10 w-full rounded-md border border-input bg-white px-2 text-sm">
          {others.map((b) => <option key={b.id} value={b.id}>{`${b.batch_code} · ${qtyText(b.quantity)} by ${dayLabel(b.expected_date)}`}</option>)}
        </select>
        <label className="grid gap-1 text-xs font-semibold text-slate">Why<Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button className="bg-navy text-white" disabled={busy || !from || note.trim().length < 4} onClick={() => void join()}>{busy ? "Joining…" : "Join"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({ title, description, action, placeholder, onClose, onSubmit }: {
  title: string; description: string; action: string; placeholder: string; onClose: () => void; onSubmit: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      await onSubmit(note);
    } catch (cause) {
      toast.error(`Could not ${action.toLowerCase()}`, { description: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea value={note} maxLength={300} placeholder={placeholder} onChange={(e) => setNote(e.target.value)} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button className="bg-red-700 text-white hover:bg-red-800" disabled={busy || note.trim().length < 4} onClick={() => void submit()}>{busy ? "Saving…" : action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A batch that was a pre-order and is matched to its bill: when and from what, and "Undo the match" while the database
 * allows it (7 days, nothing moved since; it says what has).
 */
export function MatchedLotNote({ batch, data, onChanged }: { batch: BatchRecord; data: BatchData; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  if (batch.expected_quantity === null || batch.expected_quantity === undefined || batch.stage !== "received") return null;
  const remainder = data.batches.find((b) => b.split_from_batch_id === batch.id);
  const newOrders = data.allocations.some((a) => (a.batch_id === batch.id || a.batch_id === remainder?.id) && batch.matched_at && a.created_at > batch.matched_at);
  const why = unmatchBlocker({
    matched: Boolean(batch.matched_at), matchedAt: batch.matched_at ?? null, nowMs: Date.now(), newOrders, movedOnInZoho: false,
    countedOrSent: Boolean(batch.sent_quantity) || data.adjustments.some((a) => a.batch_id === batch.id), viaTransfer: Boolean(batch.transfer_id),
    billFlag: batch.bill_flag ?? "", remainderMovedOn: Boolean(remainder && (remainder.stage !== "incoming" || remainder.paused_reason === "receiving")),
  });
  const variance = Math.round(((batch.unit_cost_ex_gst ?? batch.unit_cost) - (batch.est_unit_cost_ex_gst ?? batch.unit_cost)) * 100) / 100;
  return (
    <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-xs text-sky-950">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CalendarClock className="h-4 w-4 shrink-0" />
        <span>
          <span>{`From pre-order · bill ${batch.zoho_bill_number || batch.purchase_ref}`}</span>
          {(batch.matched_at || batch.matched_by_name) && <span>{batch.matched_at
            ? ` · matched ${when(batch.matched_at)}${batch.matched_by_name ? ` by ${batch.matched_by_name}` : ""}`
            : ` · matched by ${batch.matched_by_name}`}</span>}
        </span>
        <span>{`Estimate ${money(batch.est_unit_cost_ex_gst ?? 0)} → bill ${money(batch.unit_cost_ex_gst ?? batch.unit_cost)} before GST (${variance >= 0 ? "+" : "−"}${money(Math.abs(variance))} per unit)`}</span>
        {remainder && <span>{`The rest: ${remainder.batch_code} (${remainder.stage})`}</span>}
      </p>
      {why
        ? <p className="mt-1 text-[11px] text-slate">{`The match can't be undone: ${why}.`}</p>
        : <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px]" onClick={() => setOpen(true)}><Undo2 className="mr-1 h-3 w-3" />Undo the match</Button>}
      {open && <NoteDialog title={`Undo the match of ${batch.batch_code}?`} description="It becomes a pre-order batch again and the bill's bags are held at the godown until the bill is matched again. Allowed for 7 days, while nothing has moved since."
        action="Undo the match" placeholder="Why the match is undone" onClose={() => setOpen(false)}
        onSubmit={async (note) => {
          const { unmatchIncomingBatch } = await functions();
          await unmatchIncomingBatch({ data: { batchId: batch.id, note } });
          toast.success(`${batch.batch_code} is a pre-order batch again`);
          setOpen(false);
          await onChanged();
        }} />}
    </div>
  );
}
