import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRightLeft, PackageCheck, Plus, RefreshCw, Trash2, Truck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { splitPlanProblem, transferProgress, TRANSFER_STATUS_WORDS, transferSummary, type BatchTransfer } from "@/lib/batch-transfers";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

/*
 * Moving stock between godowns (client, 10 Nov 2026): send part of a batch to other godowns, and the list of
 * transfers with what still waits for Zoho. The database and Zoho decide; this only asks and shows.
 */

type Godown = { id: string; name: string; active: boolean; zohoLinked: boolean };
type Row = { branchId: string; qty: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** What a finished request says, one toast per transfer. */
export function announceTransfer(t: BatchTransfer) {
  if (t.status === "in_transit") {
    toast.success(`${t.transfer_no} sent: on the way to ${t.to_name ?? "the godown"}`, {
      description: `It left in Zoho. It reaches ${t.to_name ?? "the godown"}'s stock when they mark it received.`, duration: 10000,
    });
  } else if (t.status === "done") {
    const made = (t.result ?? []).map((m) => m.batch_code).join(", ");
    toast.success(`${t.transfer_no} received at ${t.to_name ?? "the godown"}`, { description: made ? `New batch${(t.result ?? []).length === 1 ? "" : "es"} ${made} at ${t.to_name ?? "the godown"}.` : undefined });
  } else if (t.status === "cancelled") {
    toast.error(`${t.transfer_no} not done`, { description: `${t.last_error} Nothing moved; the units are back.`, duration: 15000 });
  } else {
    toast.warning(`${t.transfer_no} is waiting for Zoho`, { description: `${t.last_error} It is kept aside under Transfers: press Retry there.`, duration: 15000 });
  }
}

/** Admin > Batches > a batch > Send to other godowns: one row per godown, how many go there. */
export function SendToGodownsDialog({ open, onOpenChange, batch, godowns, available, onDone }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  batch: { id: string; batch_code: string; product_name: string; branch_id: string | null; unit: string };
  godowns: Godown[]; available: number; onDone: () => Promise<void>;
}) {
  const choices = godowns.filter((g) => g.active && g.zohoLinked && g.id !== batch.branch_id);
  const [rows, setRows] = useState<Row[]>([{ branchId: choices[0]?.id ?? "", qty: "" }]);
  const [busy, setBusy] = useState(false);
  const plan = rows.map((row) => ({ branchId: row.branchId, qty: Number(row.qty) }));
  const problem = splitPlanProblem(available, batch.branch_id ?? "", plan);
  const total = Math.round(plan.reduce((sum, row) => sum + (Number.isFinite(row.qty) ? row.qty : 0), 0) * 100) / 100;
  const setRow = (index: number, change: Partial<Row>) => setRows((all) => all.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const send = async (): Promise<void> => {
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is sent"); return; }
      const { sendBatchToGodowns } = await import("@/lib/zoho-commerce.functions");
      const results = await sendBatchToGodowns({ data: { batchId: batch.id, targets: plan } });
      results.forEach(announceTransfer);
      onOpenChange(false);
      setRows([{ branchId: choices[0]?.id ?? "", qty: "" }]);
      await onDone();
    } catch (cause) {
      toast.error("Could not send the stock", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{`Send from ${batch.batch_code} to other godowns`}</DialogTitle>
          <DialogDescription>
            {`${batch.product_name}: ${available} left here. Each godown gets a Zoho transfer order; the units leave here now and are on the way until that godown marks them received. Then it gets its own batch (${batch.batch_code}-HBL1 and so on) with the same cost, bill and dates.`}
          </DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">No other active godown is linked to a Zoho location.</p>
        ) : (
          <div className="grid gap-2">
            {rows.map((row, index) => (
              <div key={index} className="flex items-end gap-2">
                <label className="grid min-w-0 flex-1 gap-1 text-xs font-semibold text-slate">To godown
                  <select value={row.branchId} onChange={(e) => setRow(index, { branchId: e.target.value })} className="h-10 w-full min-w-0 rounded-md border border-input bg-white px-2 text-sm">
                    <option value="">Choose…</option>
                    {choices.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label className="grid w-24 shrink-0 gap-1 text-xs font-semibold text-slate">{`Quantity${batch.unit ? ` (${batch.unit})` : ""}`}
                  <Input inputMode="decimal" value={row.qty} onChange={(e) => setRow(index, { qty: e.target.value.replace(/[^0-9.]/g, "") })} className="h-10" />
                </label>
                {rows.length > 1 && (
                  <Button size="icon" variant="ghost" className="h-10 w-10 shrink-0" aria-label="Remove this godown" onClick={() => setRows((all) => all.filter((_, i) => i !== index))}><X className="h-4 w-4" /></Button>
                )}
              </div>
            ))}
            {rows.length < choices.length && (
              <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setRows((all) => [...all, { branchId: "", qty: "" }])}><Plus className="mr-1.5 h-3.5 w-3.5" />Another godown</Button>
            )}
            <p className={cn("text-sm", problem && rows.some((row) => row.qty) ? "text-red-700" : "text-slate")}>
              {problem && rows.some((row) => row.qty) ? problem : `Sending ${total} of ${available}; ${Math.round((available - total) * 100) / 100} stay${available - total === 1 ? "s" : ""} in ${batch.batch_code}.`}
            </p>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Back</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy || Boolean(problem) || choices.length === 0} onClick={() => void send()}>
            <ArrowRightLeft className="mr-1.5 h-4 w-4" />{busy ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Transfers between godowns: what waits for Zoho first (Retry / Cancel), then the rest, newest first. */
export function TransferList({ transfers, onChanged, compact }: { transfers: BatchTransfer[]; onChanged: () => Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState(0);
  if (!transfers.length) return <p className="px-4 py-6 text-sm text-slate">No transfers between godowns yet.</p>;
  const act = async (t: BatchTransfer, action: "retry" | "cancel" | "receive"): Promise<void> => {
    setBusy(t.id);
    try {
      const functions = await import("@/lib/zoho-commerce.functions");
      const result = action === "retry"
        ? await functions.retryBatchTransfer({ data: { transferId: t.id } })
        : action === "receive"
          ? await functions.markTransferReceived({ data: { transferId: t.id } })
          : await functions.cancelBatchTransfer({ data: { transferId: t.id } });
      if (action === "cancel") toast.success(`${t.transfer_no} cancelled`, { description: "Nothing moved in Zoho; the units are back." });
      else announceTransfer(result);
      await onChanged();
    } catch (cause) {
      toast.error(action === "retry" ? "Could not finish the transfer" : action === "receive" ? "Not marked received" : "Could not cancel the transfer",
        { description: cause instanceof Error ? cause.message : String(cause), duration: 12000 });
    } finally {
      setBusy(0);
    }
  };
  const rank = (t: BatchTransfer) => (t.status === "pending" ? 2 : t.status === "in_transit" ? 1 : 0);
  const ordered = [...transfers].sort((a, b) => rank(b) - rank(a) || b.id - a.id);
  return (
    <ul className="divide-y divide-border text-sm">
      {(compact ? ordered.slice(0, 20) : ordered).map((t) => (
        <li key={t.id} className="grid gap-1 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words font-semibold text-navy">{transferSummary(t)}</span>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              t.status === "done" ? "bg-emerald-100 text-emerald-800" : t.status === "pending" ? "bg-amber-100 text-amber-900"
                : t.status === "in_transit" ? "bg-sky-100 text-sky-900" : "bg-slate-100 text-slate")}>
              {TRANSFER_STATUS_WORDS[t.status]}
            </span>
          </div>
          <span className="text-xs text-slate">
            {`${when(t.created_at)}${t.created_by_name ? ` · ${t.created_by_name}` : ""}${t.zoho_transfer_order_id ? ` · Zoho ${t.zoho_status || "made"}` : ""}`}
            {t.status === "done" && t.result?.length ? ` · new batch${t.result.length === 1 ? "" : "es"} ${t.result.map((m) => m.batch_code).join(", ")}` : ""}
          </span>
          {transferProgress(t) && <span className={cn("text-xs", t.status === "in_transit" ? "font-semibold text-sky-900" : "text-emerald-800")}>{transferProgress(t)}</span>}
          {t.status === "in_transit" && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={busy !== 0} onClick={() => void act(t, "receive")}>
                <PackageCheck className={cn("mr-1.5 h-3.5 w-3.5", busy === t.id && "animate-pulse")} />Mark received
              </Button>
              <span className="self-center text-[11px] text-slate">{`For when it has reached ${t.to_name ?? "the godown"}. Their staff or partner can also mark it in their app.`}</span>
            </div>
          )}
          {t.last_error && t.status === "pending" && (
            <span className={cn("flex gap-1.5 text-xs", t.status === "pending" ? "text-amber-900" : "text-slate")}><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t.last_error}</span>
          )}
          {t.status === "pending" && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy !== 0} onClick={() => void act(t, "retry")}>
                <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy === t.id && "animate-spin")} />Retry
              </Button>
              <Button size="sm" variant="outline" className="border-red-200 text-red-700 hover:bg-red-50" disabled={busy !== 0} onClick={() => void act(t, "cancel")}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />Cancel
              </Button>
              <span className="self-center text-[11px] text-slate">Retry looks it up in Zoho first. Cancel works only if Zoho doesn't have it.</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
