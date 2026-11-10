import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowUpFromLine, PackageCheck, RefreshCw, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { transferProgress, type BatchTransfer } from "@/lib/batch-transfers";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

/*
 * The staff and partner apps: stock moving between this godown and others (owner, 10 Nov 2026). What is on its way here
 * is marked received when it arrives; that makes its batch here and raises this godown's stock, in Zoho and on the
 * website. What this godown sent shows where it went and whether it has arrived. Shows nothing when there is nothing.
 */

const at = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
  : "");
const units = (t: BatchTransfer) => t.lines.map((line) => `${line.qty} × ${line.name}`).join(", ");

export function GodownTransfers() {
  const [godownId, setGodownId] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<BatchTransfer[]>([]);
  const [confirming, setConfirming] = useState(0);
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) return;
    try {
      const { listGodownTransfers } = await import("@/lib/zoho-commerce.functions");
      const answer = await listGodownTransfers();
      setGodownId(answer.godownId);
      setTransfers(answer.transfers);
    } catch { /* the card waits for the next load; the rest of the app works without it */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const receive = async (t: BatchTransfer): Promise<void> => {
    setBusy(t.id);
    try {
      const { markTransferReceived } = await import("@/lib/zoho-commerce.functions");
      const done = await markTransferReceived({ data: { transferId: t.id } });
      toast.success(`Received: ${units(t)}`, { description: `${(done.result ?? []).map((m) => m.batch_code).join(", ")} is now in your godown's stock.` });
      setConfirming(0);
      await load();
    } catch (cause) {
      toast.error("Not marked received", { description: cause instanceof Error ? cause.message : String(cause), duration: 12000 });
    } finally {
      setBusy(0);
    }
  };

  if (!godownId) return null;
  const incoming = transfers.filter((t) => t.status === "in_transit" && t.to_branch_id === godownId);
  const outgoing = transfers.filter((t) => t.status === "in_transit" && t.from_branch_id === godownId);
  const recent = transfers.filter((t) => t.status === "done" && t.kind === "split").slice(0, 6);
  if (!incoming.length && !outgoing.length && !recent.length) return null;

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-navy"><Truck className="h-4 w-4" /> Stock between godowns</h2>
        <button type="button" aria-label="Refresh" onClick={() => void load()} className="grid h-8 w-8 place-items-center rounded-md border border-border text-navy hover:border-gold"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>

      {incoming.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-emerald-800"><ArrowDownToLine className="h-3.5 w-3.5" /> Coming to your godown</p>
          {incoming.map((t) => (
            <div key={t.id} className="space-y-2 rounded-xl border-2 border-emerald-600 bg-emerald-50 p-3">
              <p className="break-words text-sm font-bold text-emerald-950">{units(t)}</p>
              <p className="break-words text-xs text-emerald-950">
                {`From ${t.from_name || t.from_location_name || "another godown"} · batch ${t.parent_batch_code ?? ""} · sent ${at(t.sent_at)}${t.created_by_name ? ` by ${t.created_by_name}` : ""} · ${t.transfer_no}`}
              </p>
              {confirming === t.id ? (
                <div className="space-y-2 rounded-lg bg-white p-2">
                  <p className="text-xs font-semibold text-charcoal">{`Count it first: ${units(t)}. Has all of it arrived?`}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={busy !== 0} onClick={() => void receive(t)}>
                      {busy === t.id ? "Marking…" : "Yes, all arrived: mark received"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== 0} onClick={() => setConfirming(0)}>Not yet</Button>
                  </div>
                  <p className="text-[11px] text-slate">If some is missing or damaged, don't mark it: tell the office.</p>
                </div>
              ) : (
                <Button size="sm" className="h-10 w-full bg-emerald-700 text-white hover:bg-emerald-800" onClick={() => setConfirming(t.id)}>
                  <PackageCheck className="mr-1.5 h-4 w-4" /> Mark received
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className={cn("space-y-2", incoming.length > 0 && "mt-4")}>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-sky-900"><ArrowUpFromLine className="h-3.5 w-3.5" /> Sent from your godown, on the way</p>
          {outgoing.map((t) => (
            <div key={t.id} className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950">
              <p className="break-words text-sm font-semibold">{`${units(t)} → ${t.to_name ?? "another godown"}`}</p>
              <p className="break-words">{`Batch ${t.parent_batch_code ?? ""} · sent ${at(t.sent_at)} · ${t.transfer_no} · waiting for ${t.to_name ?? "them"} to mark it received`}</p>
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className={cn("space-y-1.5", (incoming.length > 0 || outgoing.length > 0) && "mt-4")}>
          <p className="text-xs font-bold uppercase tracking-wide text-slate">Recently received</p>
          <ul className="space-y-1.5 text-xs text-charcoal">
            {recent.map((t) => (
              <li key={t.id} className="break-words">
                <span className="font-semibold">{units(t)}</span>
                {t.to_branch_id === godownId ? ` from ${t.from_name || t.from_location_name}` : ` to ${t.to_name ?? ""}`}
                {` · ${transferProgress(t).replace(/^Sent [^.]*\. /, "")}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
