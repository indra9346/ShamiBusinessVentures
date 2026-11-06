import { useState } from "react";
import { toast } from "sonner";
import { XCircle } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The customer cancels a checkout they have not paid for: its stock goes back on sale and nothing is due. Two taps, so it
 * is never done by mistake. The database refuses once a UTR has been sent (cancel_payment_hold): the money may already be
 * on its way, so then the customer calls us instead.
 */
export function CancelCheckoutButton({ orderNo, byBank, className }: { orderNo: string; byBank: boolean; className?: string }) {
  const { cancelPaymentHold } = useApp();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      if (await cancelPaymentHold(orderNo)) toast.success("Order cancelled", { description: "Nothing is due. You can order the same items again any time." });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)}
        className={cn("inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-xs font-semibold text-charcoal hover:border-danger hover:text-danger", className)}>
        <XCircle className="h-4 w-4" /> Cancel this order
      </button>
    );
  }
  return (
    <div className={cn("w-full rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900", className)}>
      <p className="font-semibold">{`Cancel order ${orderNo}?`}</p>
      <p className="mt-0.5">{byBank
        ? "Only if you have not transferred the money. If you already did, enter the UTR instead."
        : "Only if you have not paid. If money already left your account, enter the UTR instead."}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void cancel()} className="h-8 rounded-md bg-danger px-3 font-semibold text-white disabled:opacity-60">
          {busy ? "Cancelling…" : "Yes, cancel it"}
        </button>
        <button type="button" disabled={busy} onClick={() => setAsking(false)} className="h-8 rounded-md border border-border bg-white px-3 font-semibold text-charcoal">
          Keep the order
        </button>
      </div>
    </div>
  );
}
