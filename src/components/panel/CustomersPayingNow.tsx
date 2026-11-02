import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { Clock, ShieldCheck } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft } from "@/lib/payment-hold";
import { useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { endPaymentHold } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

/**
 * Admin: customers whose checkout is waiting for payment right now, each with the same live
 * countdown the customer sees (server clock, every second). They are not orders yet; each one
 * becomes an order the moment its payment is matched, or ends when its time is up.
 */
export function CustomersPayingNow({ compact = false }: { compact?: boolean }) {
  const { paymentHolds } = useApp();
  const now = useServerNow();
  const paying = paymentHolds
    .filter((hold) => hold.status === AWAITING_PAYMENT)
    .sort((a, b) => Date.parse(a.holdUntil ?? "") - Date.parse(b.holdUntil ?? ""));
  // A hold whose time is up ends now (stock back), even if the customer closed their page.
  const anyOver = paying.some((hold) => holdSecondsLeft(hold.holdUntil, now) === 0);
  const lastSweep = useRef(0);
  useEffect(() => {
    if (STATIC_DATA_MODE || !anyOver || now - lastSweep.current < 30000) return;
    lastSweep.current = now;
    void supabase.rpc("expire_payment_holds").then(() => undefined);
  }, [anyOver, now]);
  if (compact && paying.length === 0) return null;
  const endHold = async (orderNo: string) => {
    if (!window.confirm(`End checkout ${orderNo}?\n\nIts stock goes back on sale and the customer is told it was not placed.`)) return;
    try {
      await endPaymentHold(orderNo);
      toast.message(`${orderNo} ended`, { description: "Its stock is back on sale." });
    } catch (cause) {
      toast.error("Could not end it", { description: cause instanceof Error ? cause.message : undefined });
    }
  };

  return (
    <div className={cn("rounded-lg border bg-card", compact ? "mb-4 border-amber-200 p-3" : "border-border p-0")}>
      {compact && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-bold text-navy">
            <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" /></span>
            Customers paying now ({paying.length}) · not orders yet
          </p>
          <Link to="/admin/upi-payments" className="text-xs font-semibold text-gold hover:underline">UPI & Bank Payments</Link>
        </div>
      )}
      {paying.length === 0 ? (
        <p className="text-sm text-slate">Nobody is paying right now.</p>
      ) : (
        <ul className="divide-y divide-border">
          {paying.map((hold) => {
            const left = holdSecondsLeft(hold.holdUntil, now);
            const total = Math.max(1, (Date.parse(hold.holdUntil ?? "") - Date.parse(hold.createdAt)) / 1000);
            const share = Math.min(100, Math.max(0, (left / total) * 100));
            return (
              <li key={hold.orderNo} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold text-navy">{(hold.customer || "Customer").slice(0, 60)}</span>
                    <span className="ml-2 font-mono text-xs text-slate">{hold.orderNo}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-slate">{hold.method ?? "UPI"}</span>
                  </span>
                  <span className="font-semibold tabular-nums text-navy">{inrPrecise(hold.amount)}</span>
                  <span className={cn("inline-flex min-w-[118px] items-center justify-end gap-1 font-mono text-sm font-bold tabular-nums",
                    left === 0 ? "text-slate" : left <= 60 ? "text-red-700" : "text-amber-700")}>
                    {left > 0 ? <><Clock className="h-3.5 w-3.5" />{clockText(left)} left</> : <><ShieldCheck className="h-3.5 w-3.5" /> time up · checking</>}
                  </span>
                  {!compact && !STATIC_DATA_MODE && (
                    <button type="button" onClick={() => void endHold(hold.orderNo)} className="text-xs font-semibold text-danger underline">End checkout</button>
                  )}
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", left <= 60 ? "bg-red-500" : "bg-amber-500")} style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
