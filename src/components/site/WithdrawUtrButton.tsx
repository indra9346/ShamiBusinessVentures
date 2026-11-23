import { useState } from "react";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withdrawMyUtr } from "@/lib/upi-store";

/**
 * "Wrong UTR?": the customer takes back a UTR they sent by mistake while it is still being checked, then sends the
 * right one (Sandesh, 21 Nov 2026: "Need cancel option for a wrong UTR number").
 */
export function WithdrawUtrButton({ orderNo, utr, onDone }: { orderNo: string; utr: string; onDone?: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await withdrawMyUtr(orderNo);
      toast.success(`UTR ${utr} taken back`, { description: "Enter the right 12-digit UPI Ref No. from your UPI app." });
      setAsking(false);
      onDone?.();
    } catch (cause) {
      toast.error("Could not take back the UTR", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-900 underline">
        <Undo2 className="h-3.5 w-3.5" /> Wrong UTR? Take it back and send the right one
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-sky-300 bg-white p-2 text-xs text-charcoal">
      <p>{`Take back UTR ${utr}? Only do this if the number was wrong. Your order stays open while the time lasts.`}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking(false)}>Keep it</Button>
        <Button size="sm" className="bg-navy text-white" disabled={busy} onClick={() => void go()}>{busy ? "Taking back…" : "Take it back"}</Button>
      </div>
    </div>
  );
}
