import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { PAYMENT_EXPIRED, type PaymentHold } from "@/lib/payment-hold";
import { closedPaymentLabel, endedOutcomeLabel } from "@/lib/order-payment-state";
import { useApp } from "@/lib/store";
import { DeleteOrderDialog } from "@/components/panel/DeleteOrderDialog";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Admin: checkouts whose payment window ran out, or that the customer or an admin ended. They were never
 * orders and owe nothing. An admin may delete one when it is no longer wanted; the database checks it first.
 */
export function EndedCheckouts({ compact = false }: { compact?: boolean }) {
  const { paymentHolds } = useApp();
  const [deleting, setDeleting] = useState<PaymentHold | null>(null);
  const ended = paymentHolds
    .filter((hold) => hold.status === PAYMENT_EXPIRED)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (compact) {
    if (ended.length === 0) return null;
    return (
      <p className="mb-4 rounded-md border border-border bg-ivory px-3 py-2 text-sm text-slate">
        <Link to="/admin/upi-payments" hash="ended-checkouts" className="font-semibold text-navy hover:text-gold">
          {ended.length === 1 ? "1 checkout ended without payment" : `${ended.length} checkouts ended without payment`}
        </Link>
        <span className="mx-1">·</span><span>{closedPaymentLabel(PAYMENT_EXPIRED)}</span>
      </p>
    );
  }
  return (
    <div id="ended-checkouts" className="scroll-mt-36">
      {ended.length === 0 ? (
        <p className="text-sm text-slate">None right now.</p>
      ) : (
        <ul className="divide-y divide-border">
          {ended.map((hold) => (
            <li key={hold.orderNo} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-navy">{(hold.customer || "Customer").slice(0, 60)}</span>
                <span className="ml-2 break-all font-mono text-xs text-slate">{hold.orderNo}</span>
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-slate">{hold.method ?? "UPI"}</span>
                <span className="mt-0.5 block text-xs text-slate"><span>{when(hold.createdAt)}</span><span className="mx-1">·</span><span>{endedOutcomeLabel(hold.outcome)}</span></span>
              </span>
              <span className="font-semibold tabular-nums text-navy">{inrPrecise(hold.amount)}</span>
              <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">{closedPaymentLabel(PAYMENT_EXPIRED)}</span>
              <button type="button" onClick={() => setDeleting(hold)} className="inline-flex items-center gap-1 text-xs font-semibold text-danger underline">
                <Trash2 className="h-3.5 w-3.5" />Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {deleting && <DeleteOrderDialog orderNo={deleting.orderNo} onClose={() => setDeleting(null)} />}
    </div>
  );
}
