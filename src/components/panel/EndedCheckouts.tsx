import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { PAYMENT_EXPIRED, type PaymentHold } from "@/lib/payment-hold";
import { closedPaymentLabel, endedOutcomeLabel } from "@/lib/order-payment-state";
import { useApp } from "@/lib/store";
import { DeleteOrderDialog } from "@/components/panel/DeleteOrderDialog";
import { DeleteAllDetailsDialog } from "@/components/panel/OrderPaymentsPanel";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Admin: checkouts whose payment window ran out, or that the customer or an admin ended. They were never
 * orders and owe nothing. An admin may delete one when it is no longer wanted; the database checks it first.
 * Added 11 Nov 2026: one the ordinary delete keeps (a refunded UTR, say) may still go with Delete all details, which
 * keeps a full copy in the Delete Log, when the database allows that.
 */
export function EndedCheckouts({ compact = false }: { compact?: boolean }) {
  const { paymentHolds } = useApp();
  const [deleting, setDeleting] = useState<PaymentHold | null>(null);
  const [deletingAll, setDeletingAll] = useState<PaymentHold | null>(null);
  const ended = paymentHolds
    .filter((hold) => hold.status === PAYMENT_EXPIRED)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Why a row cannot be deleted (the database's own check), so the list says it instead of offering a Delete that fails.
  const [kept, setKept] = useState<Record<string, string>>({});
  // Of those kept, the ones Delete all details may still take.
  const [allDetails, setAllDetails] = useState<Record<string, boolean>>({});
  const endedKey = ended.map((hold) => hold.orderNo).join(",");
  useEffect(() => {
    if (compact || STATIC_DATA_MODE || !endedKey) return;
    let active = true;
    void Promise.all(endedKey.split(",").map(async (orderNo) => {
      const { data, error } = await supabase.rpc("order_delete_blocker", { _order_no: orderNo });
      const why = error ? "" : (data as string | null) ?? "";
      if (!why) return [orderNo, why, false] as const;
      const all = await supabase.rpc("order_delete_all_check", { _order_no: orderNo });
      return [orderNo, why, !all.error && !(all.data as { blocker?: string | null } | null)?.blocker] as const;
    })).then((rows) => {
      if (!active) return;
      setKept(Object.fromEntries(rows.filter(([, why]) => why).map(([orderNo, why]) => [orderNo, why])));
      setAllDetails(Object.fromEntries(rows.filter(([, , all]) => all).map(([orderNo]) => [orderNo, true])));
    });
    return () => { active = false; };
  }, [compact, endedKey]);
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
              {kept[hold.orderNo] && allDetails[hold.orderNo] ? (
                <span className="flex max-w-xs flex-col items-end gap-1 text-right text-[11px] text-slate">
                  <span><span className="font-semibold">Ordinary delete keeps it:</span> <span>{kept[hold.orderNo]}</span></span>
                  <button type="button" onClick={() => setDeletingAll(hold)} className="inline-flex items-center gap-1 text-xs font-semibold text-danger underline">
                    <Trash2 className="h-3.5 w-3.5" />Delete all details
                  </button>
                </span>
              ) : kept[hold.orderNo] ? (
                <span className="max-w-xs text-right text-[11px] text-slate"><span className="font-semibold">Kept:</span> <span>{kept[hold.orderNo]}</span></span>
              ) : (
                <button type="button" onClick={() => setDeleting(hold)} className="inline-flex items-center gap-1 text-xs font-semibold text-danger underline">
                  <Trash2 className="h-3.5 w-3.5" />Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {deleting && <DeleteOrderDialog orderNo={deleting.orderNo} onClose={() => setDeleting(null)} />}
      {deletingAll && <DeleteAllDetailsDialog orderNo={deletingAll.orderNo} onClose={() => setDeletingAll(null)} />}
    </div>
  );
}
