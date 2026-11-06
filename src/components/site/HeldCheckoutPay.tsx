import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, Clock, Copy, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft, holdView, type PaymentHold } from "@/lib/payment-hold";
import { serverNow, useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { CancelCheckoutButton } from "@/components/site/CancelCheckoutButton";
import { normaliseUtr, upiPaymentUri, utrFromText, utrProblem, type UpiSettings } from "@/lib/upi-pay";
import { GST_BILL_PAY_NOTE } from "@/lib/gstin";
import { UpiAppButtons } from "@/components/site/UpiAppButtons";
import { BankTransferDetails, BankUtrForm } from "@/components/site/BankTransferPay";
import { ReorderButton } from "@/components/site/ReorderButton";
import { isBankMethod, lapsedTransfer, REFUNDED_UTR_NOTE, REUSED_UTR_NOTE, UNCHECKED_UTR_NOTE } from "@/lib/payment-rules";
import { submitUpiPayment, useBankDetails, useUpiPayments } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

/**
 * Pay first, then the order is placed. UPI: the QR (amount and order number filled in) and app buttons. When the bank's
 * SMS shows exactly this amount the screen says the money has reached us, and an admin confirms it; the customer may
 * also paste or type the UTR. NEFT and RTGS: the
 * company's bank details and the UTR box; an admin checks the UTR. Either way the screen follows it live,
 * and an unpaid checkout ends when its time is up, with a Reorder button for the same items.
 */
export function HeldCheckoutPay({ settings, orderNo, amount, holdUntil, customer, method: methodProp, onEnded }: {
  settings: UpiSettings | null; orderNo: string; amount: number; holdUntil: string | null; customer: string; method?: string | undefined;
  onEnded?: (orderNo: string) => void;
}) {
  const { paymentHolds, orders, simulateBankAlert, cancelPaymentHold } = useApp();
  const { submissions } = useUpiPayments();
  const submission = submissions.find((item) => item.orderNo === orderNo);
  const storeHold = paymentHolds.find((hold) => hold.orderNo === orderNo);
  // Read straight from the database too, so the screen moves on even if the live feed is slow.
  const [liveStatus, setLiveStatus] = useState<{ status: string; outcome: string | null; holdUntil: string | null; moneySeenAt: string | null; gstBillTo: string | null; gstin: string | null } | null>(null);
  // The database decides when the hold ends, so the countdown runs on the server's clock.
  const now = useServerNow();
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const method = methodProp ?? storeHold?.method ?? "UPI";
  const byBank = isBankMethod(method);
  const { details: bankDetails, loaded: bankLoaded, failed: bankFailed } = useBankDetails(byBank);

  // The time can change: a rejected NEFT or RTGS UTR gets 1 more hour.
  const endsAt = liveStatus?.holdUntil ?? storeHold?.holdUntil ?? holdUntil;
  const placed = orders.some((order) => order.id === orderNo);
  const hold: Pick<PaymentHold, "status" | "holdUntil" | "outcome"> = placed
    ? { status: "Payment Confirmed", holdUntil: null }
    : liveStatus && liveStatus.status !== AWAITING_PAYMENT
      ? { status: liveStatus.status as PaymentHold["status"], holdUntil: null, outcome: liveStatus.outcome as PaymentHold["outcome"] }
      : storeHold && storeHold.status !== AWAITING_PAYMENT
        ? storeHold
        : { status: AWAITING_PAYMENT, holdUntil: endsAt };
  const moneySeenAt = liveStatus?.moneySeenAt ?? storeHold?.moneySeenAt ?? null;
  const view = holdView({ ...hold, moneySeenAt: hold.status === AWAITING_PAYMENT ? moneySeenAt : null }, submission?.status === "submitted", now);
  const left = holdSecondsLeft(hold.holdUntil ?? endsAt, now);

  const finished = view === "confirmed" || view === "expired" || view === "dropped";
  const timeUp = view === "closing";
  useEffect(() => {
    if (STATIC_DATA_MODE || finished) return;
    let stopped = false;
    const check = async () => {
      // Past the time: let the database end it (stock back) before reading the status.
      if (holdSecondsLeft(endsAt, serverNow()) === 0) await supabase.rpc("expire_payment_holds");
      const { data } = await supabase.from("orders").select("order_status,payment_hold_outcome,payment_hold_until,bank_credit_seen_at,is_b2b,customer_gstin,business_legal_name").eq("order_no", orderNo).maybeSingle();
      if (!stopped && data) setLiveStatus({
        status: data.order_status, outcome: data.payment_hold_outcome ?? null, holdUntil: data.payment_hold_until ?? null, moneySeenAt: data.bank_credit_seen_at ?? null,
        // A GST bill: the bill is to the firm, so the money should come from the firm's own account.
        gstBillTo: data.is_b2b && data.customer_gstin ? (data.business_legal_name || "your firm") : null, gstin: data.customer_gstin ?? null,
      });
    };
    void check();
    // The moment the payment is matched (or the hold ends) the database row changes: show it at once.
    const channel = supabase.channel(`hold-${orderNo}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders", filter: `order_no=eq.${orderNo}` }, () => void check())
      .subscribe();
    // A backstop in case the live feed drops: every 3 s, every second once the time is up.
    const timer = window.setInterval(() => void check(), timeUp ? 1000 : 3000);
    return () => { stopped = true; window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [orderNo, endsAt, finished, timeUp]);

  // Why it ended is told by its UTR row, read fresh: the list of submissions on screen can be behind.
  const ended = view === "expired" || view === "dropped";
  const [finalUtr, setFinalUtr] = useState<{ status: string; note: string | null; utr: string } | null | undefined>(undefined);
  useEffect(() => {
    if (!ended) return;
    onEnded?.(orderNo);
    if (STATIC_DATA_MODE) return;
    let stopped = false;
    const read = () => void supabase.from("upi_payment_submissions").select("status,note,utr").eq("order_no", orderNo).maybeSingle()
      .then(({ data, error }) => {
        if (stopped) return;
        if (error) { window.setTimeout(read, 3000); return; }
        setFinalUtr(data ?? null);
      });
    read();
    return () => { stopped = true; };
  }, [ended, orderNo, onEnded]);

  // The demo's hold ends on the screen's clock.
  useEffect(() => {
    if (STATIC_DATA_MODE && view === "closing") void cancelPaymentHold(orderNo);
  }, [view, orderNo, cancelPaymentHold]);

  const uri = useMemo(() => (settings && !byBank ? upiPaymentUri(settings, amount, orderNo) : ""), [settings, byBank, amount, orderNo]);
  const qrSvg = useMemo(() => (uri ? renderSVG(uri, { border: 2, ecc: "M" }) : ""), [uri]);

  const sendUtr = async () => {
    // Typed or pasted with words around it: the UTR is picked out when it is certain.
    const typed = utrFromText(utr) ?? utr;
    const problem = utrProblem(typed);
    if (problem) { setError(problem); return; }
    setSending(true);
    try {
      await submitUpiPayment({ orderNo, amount, utr: normaliseUtr(typed), customer });
      setError("");
      toast.success("UTR sent", { description: "Your order is placed as soon as our team confirms this payment." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the UTR");
    } finally {
      setSending(false);
    }
  };

  if (view === "confirmed") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-left text-emerald-900">
        <p className="flex items-center gap-2 text-base font-bold"><CheckCircle2 className="h-5 w-5" /> Payment received · order placed and confirmed</p>
        <p className="mt-1 text-sm">Order <span className="font-semibold">{orderNo}</span> · {`${inrPrecise(amount)} paid by ${method}. We have started on your order.`}</p>
      </div>
    );
  }

  if (ended) {
    // Until the UTR row is read, say only what is certain: telling someone who paid that nothing is due would be wrong.
    const row = STATIC_DATA_MODE ? submission : finalUtr;
    if (row === undefined && !STATIC_DATA_MODE) {
      return (
        <div className="rounded-lg border border-border bg-card p-5 text-left">
          <p className="flex items-center gap-2 text-base font-bold text-navy"><XCircle className="h-5 w-5 text-slate" /> Not placed</p>
        </div>
      );
    }
    const note = row?.status === "rejected" ? row.note ?? "" : "";
    // A UTR that nobody checked in time: the money may well be with us, so never say nothing is due.
    const unchecked = note === UNCHECKED_UTR_NOTE;
    const closed = note === REFUNDED_UTR_NOTE || REUSED_UTR_NOTE.test(note);
    const byAdmin = (liveStatus?.outcome ?? storeHold?.outcome) === "ended";
    const moneyCame = Boolean(moneySeenAt);
    const reason = view === "dropped" ? "you cancelled before paying"
      : moneyCame && !byAdmin ? "we could not confirm your payment in time"
      : unchecked ? UNCHECKED_UTR_NOTE
      : note === REFUNDED_UTR_NOTE ? "we refunded your transfer"
      : REUSED_UTR_NOTE.test(note) ? "your payment went to your new order"
      : byAdmin ? "our team ended this checkout"
      : row?.status === "rejected" ? "the UTR you sent could not be matched"
      : byBank ? "the UTR did not come in time" : "the payment time ran out";
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-left">
        <p className="flex items-center gap-2 text-base font-bold text-navy"><XCircle className="h-5 w-5 text-slate" /> Not placed: {reason}</p>
        <p className="mt-1 text-sm text-slate">
          {moneyCame
            ? "Your money reached us, so do not pay again. Press Reorder and call us: we will place the order with it or refund it."
            : unchecked
            ? `Do not pay again. Press Reorder and send the same UTR ${row?.utr}, or call us and we will refund it.`
            : closed ? `${orderNo} was not placed and nothing is due.`
            : byAdmin && row?.status === "rejected" ? `If you already transferred the money, call us with UTR ${row.utr} and we will place the order or refund it.`
            : `${orderNo} was not placed and nothing is due. If money already left your account, call us with the UTR from your bank or UPI app and we will place the order or refund it.`}
        </p>
        {(storeHold?.lines.length ?? 0) > 0 && (
          <div className="mt-3">
            <ReorderButton lines={storeHold?.lines ?? []} />
            <p className="mt-1.5 text-xs text-slate">Puts the same items back in your cart, at today's prices and stock.</p>
          </div>
        )}
      </div>
    );
  }

  // A UPI checkout's screen needs the UPI settings; they arrive a moment later.
  if (!byBank && !settings) return <p className="flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading the payment screen…</p>;

  // They already paid for an earlier checkout that nobody checked in time: do not ask them to pay again.
  const earlier = lapsedTransfer(submissions, now);

  return (
    <div className="rounded-lg border border-border bg-card p-4 text-left shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate">{view === "received" ? "Your payment" : byBank ? "Transfer now to place your order" : "Pay now to place your order · no extra charges"}</p>
          <p className="mt-1 text-2xl font-extrabold text-navy">{inrPrecise(amount)}</p>
          <p className="text-xs text-slate">{orderNo} · {method} · to {byBank ? bankDetails?.accountName : settings?.payeeName}</p>
        </div>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", view === "received" ? "bg-emerald-50 text-emerald-800" : left > 60 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-800")}>
          <Clock className="h-3.5 w-3.5" /> {view === "received" ? "Payment received" : view === "verifying" ? "Checking your payment" : left > 0 ? (byBank ? `Enter UTR within ${clockText(left)}` : `Pay within ${clockText(left)}`) : "Time is up"}
        </span>
      </div>

      {(liveStatus?.gstBillTo ?? storeHold?.gstBillTo) && view !== "received" && view !== "verifying" && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">{GST_BILL_PAY_NOTE}</p>
          <p className="mt-0.5 text-xs">{`GST bill to: ${liveStatus?.gstBillTo ?? storeHold?.gstBillTo}${liveStatus?.gstin ? ` · GSTIN ${liveStatus.gstin}` : ""}`}</p>
        </div>
      )}
      {view === "received" ? (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> We have received your payment</p>
          <p className="mt-1">{`Our bank shows ${inrPrecise(amount)} at ${new Date(moneySeenAt ?? Date.now()).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}.`}</p>
          <p className="mt-1">Our team is confirming it now. Your order is placed as soon as they do, and you will get a notification. Please do not pay again. You can close this page.</p>
        </div>
      ) : view === "verifying" ? (
        <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Checking UTR {submission?.utr} with our bank</p>
          <p className="mt-1">{byBank
            ? "Your order is placed once we confirm this payment in our bank account. You can close this page; you will get a notification."
            : "Your order is placed once our team confirms this payment with our bank. You can close this page; you will get a notification."}</p>
        </div>
      ) : byBank ? (
        <>
          {earlier && (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
              {Math.abs(earlier.amount - amount) < 0.005
                ? `Already transferred? Do not pay again: enter UTR ${earlier.utr} below.`
                : `Your earlier transfer (UTR ${earlier.utr}) was for ${inrPrecise(earlier.amount)}. This order comes to ${inrPrecise(amount)}, so please call us before paying.`}
            </p>
          )}
          {bankLoaded || bankFailed
            ? <BankTransferDetails details={bankDetails} amount={amount} method={method} orderNo={orderNo} />
            : <p className="mt-4 flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading our bank details…</p>}
          <div className="mt-4 border-t border-border pt-4">
            <BankUtrForm orderNo={orderNo} amount={amount} method={method} customer={customer} submission={submission} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              {submission?.status !== "submitted" && <CancelCheckoutButton orderNo={orderNo} byBank={byBank} />}
              {STATIC_DATA_MODE && (
                <button type="button" onClick={() => simulateBankAlert(orderNo)} className="text-xs font-semibold text-gold underline">
                  Demo only: the admin confirms this payment
                </button>
              )}
            </div>
          </div>
        </>
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
                <li>Pay exactly <span className="font-semibold">{inrPrecise(amount)}</span> to <span className="font-semibold">{settings?.payeeName}</span>.</li>
                <li>Stay on this page: it shows when your payment reaches our bank. Our team then confirms it and your order is placed.</li>
              </ol>
              <UpiAppButtons uri={uri} />
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(settings?.vpa ?? ""); toast.success("UPI ID copied"); }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-gold hover:underline">
                <Copy className="h-3.5 w-3.5" /> UPI ID: {settings?.vpa}
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
            <label className="block text-xs font-semibold text-charcoal" htmlFor={`utr-${orderNo}`}>Paid? Paste or type the 12-digit UTR from your UPI app: it speeds up the check</label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <input id={`utr-${orderNo}`} inputMode="numeric" autoComplete="off" maxLength={300} placeholder="e.g. 612345678901" value={utr}
                onChange={(e) => { setUtr(e.target.value); setError(""); }}
                // The whole "Share receipt" text of PhonePe, Google Pay or Paytm can be pasted: the UTR is picked out of it.
                onPaste={(e) => {
                  const found = utrFromText(e.clipboardData.getData("text"));
                  if (found) { e.preventDefault(); setUtr(found); setError(""); }
                }}
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm tracking-wider" />
              <button type="button" disabled={sending} onClick={() => void sendUtr()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "Send UTR"}</button>
            </div>
            {error && <p className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              {submission?.status !== "submitted" && <CancelCheckoutButton orderNo={orderNo} byBank={byBank} />}
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
