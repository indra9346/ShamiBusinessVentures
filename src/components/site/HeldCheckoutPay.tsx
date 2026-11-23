import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { CheckCircle2, Clock, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft, holdView, type PaymentHold } from "@/lib/payment-hold";
import { serverNow, useServerNow } from "@/lib/server-clock";
import { useApp } from "@/lib/store";
import { CancelCheckoutButton } from "@/components/site/CancelCheckoutButton";
import { upiPaymentUri, type UpiSettings, overUpiLinkLimit } from "@/lib/upi-pay";
import { GST_BILL_PAY_NOTE } from "@/lib/gstin";
import { UpiAppButtons } from "@/components/site/UpiAppButtons";
import { PAY_RETURNED_EVENT, payPanelId } from "@/lib/upi-return";
import { BankTransferDetails, BankUtrForm } from "@/components/site/BankTransferPay";
import { ReorderButton } from "@/components/site/ReorderButton";
import { isBankMethod, lapsedTransfer, REFUNDED_UTR_NOTE, REUSED_UTR_NOTE, UNCHECKED_UTR_NOTE } from "@/lib/payment-rules";
import { useBankDetails, useUpiPayments } from "@/lib/upi-store";
import { SendUtrForm, UpiIdPay, UpiUtrForm } from "@/components/site/UpiIdPay";
import { WithdrawUtrButton } from "@/components/site/WithdrawUtrButton";
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
  // The UTR just accepted on this page (Sandesh, 21 Nov 2026: "after update the UTR number customer get order has been
  // placed"): the green box shows at once instead of waiting for the UTR list to be read again, which could be slow.
  const [sentUtr, setSentUtr] = useState("");
  const utrBeingChecked = submission?.status === "submitted"
    || (Boolean(sentUtr) && !(submission && submission.utr === sentUtr && submission.status !== "submitted"));
  const shownUtr = submission?.status === "submitted" ? submission.utr : sentUtr || submission?.utr || "";
  const storeHold = paymentHolds.find((hold) => hold.orderNo === orderNo);
  // Read straight from the database too, so the screen moves on even if the live feed is slow.
  const [liveStatus, setLiveStatus] = useState<{ status: string; outcome: string | null; holdUntil: string | null; moneySeenAt: string | null; gstBillTo: string | null; gstin: string | null } | null>(null);
  // The database decides when the hold ends, so the countdown runs on the server's clock.
  const now = useServerNow();
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
  const view = holdView({ ...hold, moneySeenAt: hold.status === AWAITING_PAYMENT ? moneySeenAt : null }, utrBeingChecked, now);
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
  // Read again after the customer sends a UTR for it (paid after the time ran out).
  const [reread, setReread] = useState(0);
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
  }, [ended, orderNo, onEnded, reread]);

  // The demo's hold ends on the screen's clock.
  useEffect(() => {
    if (STATIC_DATA_MODE && view === "closing") void cancelPaymentHold(orderNo);
  }, [view, orderNo, cancelPaymentHold]);

  // Back from the UPI app: ask for the UTR at once, and keep the order 10 more minutes (once) while it is typed.
  // Until the bank SMS reaches the site, the UTR is how we learn that this payment was made.
  const [backFromApp, setBackFromApp] = useState(false);
  useEffect(() => {
    const onBack = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== payPanelId(orderNo)) return;
      setBackFromApp(true);
      if (!STATIC_DATA_MODE) void supabase.rpc("extend_my_payment_hold", { _order_no: orderNo }).then(({ data }) => {
        if (data) setLiveStatus((current) => (current ? { ...current, holdUntil: data } : current));
      });
      window.setTimeout(() => document.getElementById(`utr-${orderNo}`)?.focus({ preventScroll: true }), 600);
    };
    window.addEventListener(PAY_RETURNED_EVENT, onBack);
    return () => window.removeEventListener(PAY_RETURNED_EVENT, onBack);
  }, [orderNo]);

  const uri = useMemo(() => (settings && !byBank ? upiPaymentUri(settings, amount, orderNo) : ""), [settings, byBank, amount, orderNo]);
  const qrSvg = useMemo(() => (uri ? renderSVG(uri, { border: 2, ecc: "M" }) : ""), [uri]);

  if (view === "confirmed") {
    return (
      <div id={payPanelId(orderNo)} className="scroll-mt-24 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-left text-emerald-900">
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
        <div id={payPanelId(orderNo)} className="scroll-mt-24 rounded-lg border border-border bg-card p-5 text-left">
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
      <div id={payPanelId(orderNo)} className="scroll-mt-24 rounded-lg border border-border bg-card p-5 text-left">
        <p className="flex items-center gap-2 text-base font-bold text-navy"><XCircle className="h-5 w-5 text-slate" /> Not placed: {reason}</p>
        {row?.status === "submitted" ? (
          <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> {`Checking UTR ${row.utr} with our bank`}</p>
            <p className="mt-1">It was sent after the time ran out. If the money reached us, we place this order and tell you. Please do not pay again.</p>
          </div>
        ) : (
        <p className="mt-1 text-sm text-slate">
          {moneyCame
            ? "Your money reached us, so do not pay again. Press Reorder and call us: we will place the order with it or refund it."
            : unchecked
            ? `Do not pay again. Press Reorder and send the same UTR ${row?.utr}, or call us and we will refund it.`
            : closed ? `${orderNo} was not placed and nothing is due.`
            : byAdmin && row?.status === "rejected" ? `If you already transferred the money, call us with UTR ${row.utr} and we will place the order or refund it.`
            : `${orderNo} was not placed and nothing is due. If money already left your account, call us with the UTR from your bank or UPI app and we will place the order or refund it.`}
        </p>
        )}
        {/* Added 12 Nov 2026 (owner): paid after the time ran out, or offline: send the UTR; an admin checks the bank. */}
        {row?.status !== "submitted" && !moneyCame && !closed && !unchecked && !STATIC_DATA_MODE && (
          <SendUtrForm className="mt-3" orderNo={orderNo} defaultMethod={method} title="Paid already? Send the UTR"
            help="If you paid after the time ran out, send the UTR from your UPI app or bank. We check it with our bank, and if the money came we place this order and tell you." onSent={() => setReread((n) => n + 1)} />
        )}
        {row?.status !== "submitted" && (storeHold?.lines.length ?? 0) > 0 && (
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
    <div id={payPanelId(orderNo)} className="scroll-mt-24 rounded-lg border border-border bg-card p-4 text-left shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate">{view === "received" ? "Your payment" : view === "verifying" ? "Your order" : byBank ? "Transfer now to place your order" : "Pay now to place your order · no extra charges"}</p>
          <p className="mt-1 text-2xl font-extrabold text-navy">{inrPrecise(amount)}</p>
          <p className="text-xs text-slate">{orderNo} · {method} · to {byBank ? bankDetails?.accountName : settings?.payeeName}</p>
        </div>
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", view === "received" ? "bg-emerald-50 text-emerald-800" : left > 60 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-800")}>
          <Clock className="h-3.5 w-3.5" /> {view === "received" ? "Payment received" : view === "verifying" ? "Order placed · payment being checked" : left > 0 ? (byBank ? `Enter UTR within ${clockText(left)}` : `Pay within ${clockText(left)}`) : "Time is up"}
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
        // Client, 18 Nov 2026: "after update the UTR number customer get order has been placed". With a UTR sent the
        // checkout and its stock are kept for 24 hours while our team checks the bank (expire_payment_holds), so the
        // customer is told the order is placed; a UTR that can't be matched is told to them as it is today.
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-base font-bold text-emerald-800"><CheckCircle2 className="h-5 w-5" /> Your order has been placed</p>
          <p className="mt-1 font-semibold">{`Order ${orderNo} · ${inrPrecise(amount)}`}</p>
          <p className="mt-1 flex items-center gap-1.5 text-xs"><ShieldCheck className="h-3.5 w-3.5 shrink-0" />{`UTR ${shownUtr} received.`}</p>
          <p className="mt-1">Our team is confirming your payment with our bank; your goods are kept for you. You will get a notification once it is confirmed. Please do not pay again.</p>
          {shownUtr && !STATIC_DATA_MODE && <WithdrawUtrButton orderNo={orderNo} utr={shownUtr} onDone={() => setSentUtr("")} />}
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
            <BankUtrForm orderNo={orderNo} amount={amount} method={method} customer={customer} submission={submission} onSent={setSentUtr} />
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
              {overUpiLinkLimit(amount) ? (
                // Client, 19 Nov 2026 (PhonePe: "You can pay up to ₹2,000 with QR codes via gallery"): above ₹2,000 a UPI
                // app refuses a payment link or a gallery QR, so typing our UPI ID comes first.
                <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-bold">{`Paying on this phone? UPI apps allow only ₹2,000 by link or gallery QR.`}</p>
                  <p className="mt-0.5">{`For ${inrPrecise(amount)}: open your UPI app, choose Pay to UPI ID, and enter ${settings?.vpa ?? "our UPI ID"} and the amount (steps below). Or scan this QR with the camera of another phone.`}</p>
                </div>
              ) : (
                <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate">{`If PhonePe says "You can pay up to ₹2,000 with QR codes via gallery", tap Dismiss, then Pay: ${inrPrecise(amount)} is within it.`}</p>
              )}
              {overUpiLinkLimit(amount) && settings?.vpa && (
                <UpiIdPay orderNo={orderNo} vpa={settings.vpa} payeeName={settings.payeeName} amount={amount}
                  onKept={(until) => setLiveStatus((current) => (current ? { ...current, holdUntil: until } : current))} />
              )}
              <ol className="list-decimal space-y-1 pl-4 text-sm text-charcoal">
                <li>{overUpiLinkLimit(amount) ? "Pay to our UPI ID as above, or scan the QR from another phone." : "Scan the QR, or on your phone tap your UPI app below."}</li>
                <li>Pay exactly <span className="font-semibold">{inrPrecise(amount)}</span> to <span className="font-semibold">{settings?.payeeName}</span>.</li>
                <li>Come back here and enter the 12-digit UPI Ref No. (UTR) from the payment receipt. Our team confirms it with our bank and your order is placed.</li>
              </ol>
              {!overUpiLinkLimit(amount) && <UpiAppButtons uri={uri} returnTo={payPanelId(orderNo)} />}
              {!overUpiLinkLimit(amount) && settings?.vpa && (
                <UpiIdPay orderNo={orderNo} vpa={settings.vpa} payeeName={settings.payeeName} amount={amount}
                  onKept={(until) => setLiveStatus((current) => (current ? { ...current, holdUntil: until } : current))} />
              )}
              {!backFromApp && <p className="flex items-center gap-2 text-xs font-semibold text-slate"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for your payment…</p>}
            </div>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            {backFromApp && submission?.status !== "rejected" && (
              <div role="status" className="mb-3 rounded-md border-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-bold">Payment done? Enter its UPI Ref No. now</p>
                <p className="mt-0.5">It is the 12-digit number on the receipt in your UPI app (UPI Ref No., UPI transaction ID or UTR). Your order is kept for you while you enter it.</p>
              </div>
            )}
            <UpiUtrForm orderNo={orderNo} amount={amount} customer={customer} submission={submission} onSent={setSentUtr} />
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
