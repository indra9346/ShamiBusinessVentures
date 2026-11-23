import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { Clock, ShieldCheck } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft } from "@/lib/payment-hold";
import { useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { endPaymentHold, useUpiPayments } from "@/lib/upi-store";
import { cn } from "@/lib/utils";
import { orderToneClass } from "@/lib/order-status-tone";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Admin: customers whose checkout is waiting for payment right now, each with the same live
 * countdown the customer sees (server clock, every second). They are not orders yet; each one
 * becomes an order the moment its payment is matched, or ends when its time is up.
 */
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

export function CustomersPayingNow({ compact = false }: { compact?: boolean }) {
  const { paymentHolds, refreshHeldCheckouts } = useApp();
  const { submissions } = useUpiPayments();
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
    const overdue = paying.filter((hold) => holdSecondsLeft(hold.holdUntil, now) === 0).map((hold) => hold.orderNo);
    void supabase.rpc("expire_payment_holds").then(() => refreshHeldCheckouts(overdue));
  }, [anyOver, now]);
  const [ending, setEnding] = useState<string | null>(null);
  if (compact && paying.length === 0) return null;

  return (
    <div className={cn("rounded-lg border bg-card", compact ? cn("mb-4 p-3", orderToneClass(AWAITING_PAYMENT, "border")) : "border-border p-0")}>
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
            // A rejected UTR gives the customer more time, so the timer starts again: say so.
            const rejected = submissions.find((item) => item.orderNo === hold.orderNo && item.status === "rejected");
            return (
              // Yellow like every order still waiting for its payment (the order colours, 11 Nov 2026).
              <li key={hold.orderNo} className={cn("px-2 py-2", orderToneClass(hold.status, "row"))}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold text-navy">{(hold.customer || "Customer").slice(0, 60)}</span>
                    <span className="ml-2 font-mono text-xs text-slate">{hold.orderNo}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-slate">{hold.method ?? "UPI"}</span>
                    {hold.gstBillTo && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900" title={`GST bill to ${hold.gstBillTo}: the money should come from the firm's account`}>GST bill</span>}
                  </span>
                  <span className="font-semibold tabular-nums text-navy">{inrPrecise(hold.amount)}</span>
                  {hold.moneySeenAt ? (
                    // The bank shows the money (13 Nov 2026: the countdown kept running): it only needs confirming.
                    <span className="inline-flex min-w-[118px] items-center justify-end gap-1 text-xs font-bold text-emerald-700">
                      <ShieldCheck className="h-3.5 w-3.5" /> money seen · confirm it
                    </span>
                  ) : (
                    <span className={cn("inline-flex min-w-[118px] items-center justify-end gap-1 font-mono text-sm font-bold tabular-nums",
                      left === 0 ? "text-slate" : left <= 60 ? "text-red-700" : "text-amber-700")}>
                      {left > 0 ? <><Clock className="h-3.5 w-3.5" />{clockText(left)} left</> : <><ShieldCheck className="h-3.5 w-3.5" /> time up · check the bank</>}
                    </span>
                  )}
                  {!STATIC_DATA_MODE && (
                    <button type="button" onClick={() => setEnding(hold.orderNo)} className="text-xs font-semibold text-danger underline">End checkout</button>
                  )}
                </div>
                {rejected && left > 0 && (
                  <p className="mt-0.5 text-[11px] font-semibold text-amber-800">
                    {`UTR ${rejected.utr} rejected${rejected.reviewedAt ? ` at ${clock(rejected.reviewedAt)}` : ""}: the customer can send the right one until ${clock(hold.holdUntil ?? "")}. To stop it now, press End checkout.`}
                  </p>
                )}
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", left <= 60 ? "bg-red-500" : "bg-amber-500")} style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ending && <EndCheckoutDialog orderNo={ending} onClose={() => setEnding(null)} />}
    </div>
  );
}

/** Admin: end a checkout that is waiting for payment, saying why (kept with the cancellations in the Delete Log). */
function EndCheckoutDialog({ orderNo, onClose }: { orderNo: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const end = async () => {
    setBusy(true);
    try {
      await endPaymentHold(orderNo, reason);
      toast.message(`${orderNo} ended`, { description: "Its stock is back on sale." });
      onClose();
    } catch (cause) {
      toast.error("Could not end it", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`End checkout ${orderNo}?`}</DialogTitle>
          <DialogDescription>Its stock goes back on sale and the customer is told it was not placed.</DialogDescription>
        </DialogHeader>
        <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Why is it being ended?" value={reason} onChange={(event) => setReason(event.target.value)} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 4} onClick={() => void end()}>{busy ? "Ending…" : "End checkout"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
