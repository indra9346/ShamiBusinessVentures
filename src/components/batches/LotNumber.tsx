import { useState } from "react";
import { toast } from "sonner";
import { Hash, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { BatchRecord } from "@/lib/batches";
import { composeLotNo, lotNoProblem, purchaseBatchOf, splitLotNo, suggestLotParts, type LotParts } from "@/lib/lots";

/*
 * A purchase's lot number (client's note, 17 Nov 2026: "SS/S1/340/003" = Satish Sugars / Grade S1 / bags purchased / PO No).
 * Set on the purchase batch; batches sent on from it show the same number. The form suggests each part from the batch and
 * the administrator checks it (the mill is often not the bill's supplier, and most purchases have no PO in Zoho).
 */

export function LotNumberLine({ batch, batches, onChanged }: { batch: BatchRecord; batches: BatchRecord[]; onChanged: () => Promise<void> }) {
  const root = purchaseBatchOf(batch, batches);
  const lotNo = (root.lot_no ?? "").trim();
  const own = root.id === batch.id;
  const editable = own && (batch.stage ?? "received") === "received";
  const [open, setOpen] = useState(false);
  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 rounded-md border border-gold/50 bg-gold/10 px-2 py-0.5 font-semibold text-navy">
        <Hash className="h-3.5 w-3.5" />
        {lotNo ? <span data-no-translate className="font-mono">{`Lot No ${lotNo}`}</span> : <span>Lot No not set</span>}
      </span>
      {!own && <span className="text-xs text-slate">{`from batch ${root.batch_code}`}</span>}
      {editable && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
          <Pencil className="mr-1 h-3 w-3" />{lotNo ? "Edit lot no" : "Set lot no"}
        </Button>
      )}
      {open && <LotNumberDialog batch={root} open={open} onOpenChange={setOpen} onSaved={onChanged} />}
    </p>
  );
}

function LotNumberDialog({ batch, open, onOpenChange, onSaved }: { batch: BatchRecord; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const current = (batch.lot_no ?? "").trim();
  const [parts, setParts] = useState<LotParts>(() => (current ? splitLotNo(current) : suggestLotParts(batch)));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const lotNo = composeLotNo(parts);
  const set = (key: keyof LotParts) => (e: React.ChangeEvent<HTMLInputElement>) => setParts((p) => ({ ...p, [key]: e.target.value }));
  const save = async (value: string) => {
    const why = lotNoProblem(value);
    if (why) { setProblem(why); return; }
    setBusy(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); onOpenChange(false); return; }
      const { data, error } = await supabase.rpc("admin_set_batch_lot_no", { _batch_id: batch.id, _lot_no: value });
      if (error) throw new Error(error.message);
      toast.success(data ? `Lot No ${String(data)} saved on batch ${batch.batch_code}` : `Lot No cleared on batch ${batch.batch_code}`);
      onOpenChange(false);
      await onSaved();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not save the lot number");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{`Lot number of batch ${batch.batch_code}`}</DialogTitle>
          <DialogDescription>{`${batch.product_name} · ${batch.quantity} bought · ${batch.supplier || "no supplier"}. Check each part; the lot number is saved as you see it.`}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="grid gap-1 text-xs font-semibold text-slate">Mill / brand code<Input value={parts.mill} maxLength={16} placeholder="SS (Satish Sugars)" onChange={set("mill")} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Grade<Input value={parts.grade} maxLength={16} placeholder="S1" onChange={set("grade")} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Bags purchased<Input value={parts.bags} maxLength={16} inputMode="numeric" onChange={set("bags")} /></label>
          <label className="grid gap-1 text-xs font-semibold text-slate">PO No<Input value={parts.po} maxLength={16} placeholder="003" onChange={set("po")} /></label>
        </div>
        <p className="rounded-md bg-slate-50 px-3 py-2 text-sm">
          {lotNo ? <><span className="text-slate">Lot No </span><span data-no-translate className="font-mono font-bold text-navy">{lotNo}</span></> : <span className="text-slate">Fill in the parts.</span>}
        </p>
        {!parts.po.trim() && <p className="text-xs text-amber-800">No PO number: type the PO No this purchase was ordered on.</p>}
        {problem && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem}</p>}
        <DialogFooter className="gap-2">
          {current && <Button variant="outline" disabled={busy} onClick={() => void save("")}>Clear</Button>}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !lotNo} className="bg-navy text-white hover:bg-navy/90" onClick={() => void save(lotNo)}>{busy ? "Saving…" : "Save lot no"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
