import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, Clock, Copy, Loader2, ShieldCheck, ShoppingCart, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft, holdView, type PaymentHold } from "@/lib/payment-hold";
import { serverNow, useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { normaliseUtr, upiPaymentUri, utrProblem, type UpiSettings } from "@/lib/upi-pay";
import { UpiAppButtons } from "@/components/site/UpiAppButtons";
import { submitUpiPayment, useUpiPayments } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

/**
 * Pay first, then the order is placed. Shows the UPI QR and app buttons for a held checkout and
 * follows it live: the bank alert confirms it automatically (usually within a minute), the
 * customer may also type the UTR, and an unpaid checkout ends when its time is up.
 */
export function HeldCheckoutPay({ settings, orderNo, amount, holdUntil, customer }: {
  settings: UpiSettings; orderNo: string; amount: number; holdUntil: string | null; customer: string;
}) {
  const { paymentHolds, orders, simulateBankAlert, cancelPaymentHold, addToCart } = useApp();
  const { submissions } = useUpiPayments();
  const submission = submissions.find((item) => item.orderNo === orderNo);
  const storeHold = paymentHolds.find((hold) => hold.orderNo === orderNo);
  // Read straight from the database too, so the screen moves on even if the live feed is slow.
  const [liveStatus, setLiveStatus] = useState<{ status: string; outcome: string | null } | null>(null);
  // The database decides when the hold ends, so the countdown runs on the server's clock.
  const now = useServerNow();
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [restored, setRestored] = useState(false);

  const placed = orders.some((order) => order.id === orderNo);
  const hold: Pick<PaymentHold, "status" | "holdUntil" | "outcome"> = placed
    ? { status: "Payment Confirmed", holdUntil: null }
    : liveStatus && liveStatus.status !== AWAITING_PAYMENT
      ? { status: liveStatus.status as PaymentHold["status"], holdUntil: null, outcome: liveStatus.outcome as PaymentHold["outcome"] }
      : storeHold ?? { status: AWAITING_PAYMENT, holdUntil };
  const view = holdView(hold, submission?.status === "submitted", now);
  const left = holdSecondsLeft(hold.holdUntil ?? holdUntil, now);

  const finished = view === "confirmed" || view === "expired" || view === "dropped";
  const timeUp = view === "closing";
  useEffect(() => {
    if (STATIC_DATA_MODE || finished) return;
    let stopped = false;
    const check = async () => {
      // Past the time: let the database end it (stock back) before reading the status.
      if (holdSecondsLeft(holdUntil, serverNow()) === 0) await supabase.rpc("expire_payment_holds");
      const { data } = await supabase.from("orders").select("order_status,payment_hold_outcome").eq("order_no", orderNo).maybeSingle();
      if (!stopped && data) setLiveStatus({ status: data.order_status, outcome: data.payment_hold_outcome ?? null });
    };
    void check();
    // The moment the payment is matched (or the hold ends) the database row changes: show it at once.
    const channel = supabase.channel(`hold-${orderNo}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `order_no=eq.${orderNo}` }, () => void check())
      .subscribe();
    // A backstop in case the live feed drops: every 3 s, every second once the time is up.
    const timer = window.setInterval(() => void check(), timeUp ? 1000 : 3000);
    return () => { stopped = true; window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [orderNo, holdUntil, finished, timeUp]);

  // The demo's hold ends on the screen's clock.
  useEffect(() => {
    if (STATIC_DATA_MODE && view === "closing") void cancelPaymentHold(orderNo);
  }, [view, orderNo, cancelPaymentHold]);

  const uri = useMemo(() => upiPaymentUri(settings, amount, orderNo), [settings, amount, orderNo]);
  const qrSvg = useMemo(() => renderSVG(uri, { border: 2, ecc: "M" }), [uri]);

  const sendUtr = async () => {
    const problem = utrProblem(utr);
    if (problem) { setError(problem); return; }
    setSending(true);
    try {
      await submitUpiPayment({ orderNo, amount, utr: normaliseUtr(utr), customer });
      setError("");
      toast.success("UTR sent", { description: "Your order is placed as soon as our bank shows this payment." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the UTR");
    } finally {
      setSending(false);
    }
  };

  const putBack = () => {
    for (const line of storeHold?.lines ?? []) addToCart(line.productId, line.qty);
    setRestored(true);
    toast.success("Items are back in your cart");
  };

  if (view === "confirmed") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-left text-emerald-900">
        <p className="flex items-center gap-2 text-base font-bold"><CheckCircle2 className="h-5 w-5" /> Payment received · order placed and confirmed</p>
        <p className="mt-1 text-sm">Order <span className="font-semibold">{orderNo}</span> · {inrPrecise(amount)} paid by UPI. We have started on your order.</p>
      </div>
    );
  }

  if (view === "expired" || view === "dropped") {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-left">
        <p className="flex items-center gap-2 text-base font-bold text-navy"><XCircle className="h-5 w-5 text-slate" /> Not placed: {view === "dropped" ? "you cancelled before paying" : "the payment time ran out"}</p>
        <p className="mt-1 text-sm text-slate">
          {orderNo} was not placed and nothing is due. If money already left your account, call us with the UTR from your UPI app and we will place the order or refund it.
        </p>
        {(storeHold?.lines.length ?? 0) > 0 && !restored && (
          <button type="button" onClick={putBack} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-gold px-4 py-2 text-sm font-bold text-midnight hover:bg-gold-light">
            <ShoppingCart className="h-4 w-4" /> Put the items back in my cart
          </button>
        )}
        {restored && <Link to="/cart" className="mt-3 inline-flex rounded-md bg-navy px-4 py-2 text-sm font-semibold text-white">Go to cart</Link>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-left shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate">Pay now to place your order · no extra charges</p>
          <p className="mt-1 text-2xl font-extrabold text-navy">{inrPrecise(amount)}</p>
          <p className="text-xs text-slate">{orderNo} · to {settings.payeeName}</p>
        </div>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", left > 60 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-800")}>
          <Clock className="h-3.5 w-3.5" /> {view === "verifying" ? "Checking your payment" : left > 0 ? `Pay within ${clockText(left)}` : "Time is up"}
        </span>
      </div>

      {view === "verifying" ? (
        <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Checking UTR {submission?.utr} with our bank</p>
          <p className="mt-1">Your order is placed the moment our bank shows this payment. You can close this page; you will get a notification.</p>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div className="mx-auto w-[180px]">
              <div className="rounded-lg border border-border bg-white p-2" role="img" aria-label={`UPI QR code for ${inrPrecise(amount)}`}
                // uqr returns a self-contained <svg> of the QR code (no scripts).
                dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <p className="mt-1 text-center text-[11px] text-slate">Scan with any UPI app</p>
            </div>
            <div className="min-w-0 space-y-3">
              <ol className="list-decimal space-y-1 pl-4 text-sm text-charcoal">
                <li>Scan the QR, or on your phone tap your UPI app below.</li>
                <li>Pay exactly <span className="font-semibold">{inrPrecise(amount)}</span> to <span className="font-semibold">{settings.payeeName}</span>.</li>
                <li>Stay on this page: your order is confirmed automatically, usually within a minute.</li>
              </ol>
              <UpiAppButtons uri={uri} />
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(settings.vpa); toast.success("UPI ID copied"); }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-gold hover:underline">
                <Copy className="h-3.5 w-3.5" /> UPI ID: {settings.vpa}
              </button>
              <p className="flex items-center gap-2 text-xs font-semibold text-slate"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for your payment…</p>
            </div>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            {submission?.status === "rejected" && (
              <p className="mb-2 flex items-start gap-2 rounded-md bg-red-50 p-2 text-xs text-red-800">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> UTR {submission.utr} could not be matched{submission.note ? `: ${submission.note}` : ""}.
              </p>
            )}
            <label className="block text-xs font-semibold text-charcoal" htmlFor={`utr-${orderNo}`}>Paid but not confirmed after a minute? Enter the 12-digit UTR from your UPI app</label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <input id={`utr-${orderNo}`} inputMode="numeric" autoComplete="off" maxLength={16} placeholder="e.g. 612345678901" value={utr}
                onChange={(e) => { setUtr(e.target.value); setError(""); }}
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm tracking-wider" />
              <button type="button" disabled={sending} onClick={() => void sendUtr()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "Send UTR"}</button>
            </div>
            {error && <p className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => void cancelPaymentHold(orderNo)} className="text-xs font-semibold text-slate underline hover:text-navy">
                Cancel: I don't want to pay now
              </button>
              {STATIC_DATA_MODE && (
                <button type="button" onClick={() => simulateBankAlert(orderNo)} className="text-xs font-semibold text-gold underline">
                  Demo only: the bank SMS for this payment arrives
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
