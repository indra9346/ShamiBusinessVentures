import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, Clock, ShieldCheck, XCircle } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { normaliseUtr, settingsProblem, upiPaymentUri, utrProblem, type UpiSettings } from "@/lib/upi-pay";
import { UpiAppButtons } from "@/components/site/UpiAppButtons";
import { UpiIdPay } from "@/components/site/UpiIdPay";
import { payPanelId } from "@/lib/upi-return";
import { BankTransferDetails, BankUtrForm } from "@/components/site/BankTransferPay";
import { allowedMethods, isBankMethod } from "@/lib/payment-rules";
import { submitUpiPayment, useBankDetails, useUpiPayments } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

/**
 * The order page's "Pay by UPI" box: shown while a UPI order is unpaid and direct UPI is on (or a
 * UTR was already sent, so the customer sees its status), hidden otherwise.
 */
export function OrderUpiPay({ orderNo, status, payment, method, balance, customer }: {
  orderNo: string; status: string; payment: string; method: string; balance: number; customer: string;
}) {
  const { settings, submissions } = useUpiPayments();
  const sent = submissions.find((item) => item.orderNo === orderNo);
  const on = settings?.enabled && !settingsProblem(settings);
  const byBank = isBankMethod(method);
  const { details: bankDetails, loaded: bankLoaded, failed: bankFailed } = useBankDetails(byBank);
  if (byBank) {
    if (status === "Cancelled") return null;
    if (sent?.status === "confirmed") {
      return (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-left text-sm text-emerald-900">
          <p className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-5 w-5" /> {`Payment received · UTR ${sent.utr}`}</p>
        </div>
      );
    }
    // Paid some other way (an admin recorded it): nothing to transfer, whatever became of a UTR sent earlier.
    if (payment === "Paid" || balance <= 0) return null;
    // A rejected UTR's row keeps the old amount: what is due now is the balance.
    const amount = sent?.status === "submitted" ? sent.amount : balance;
    // A bigger order may also go by RTGS.
    const byWhat = method === "NEFT" && allowedMethods(amount).includes("RTGS") ? "NEFT or RTGS" : method;
    return (
      <div className="mb-6 rounded-lg border border-border bg-card p-4 text-left shadow-card">
        <p className="text-xs font-bold uppercase tracking-wider text-slate">{`Pay by ${byWhat}`}</p>
        <p className="mt-1 text-2xl font-extrabold text-navy">{inrPrecise(amount)}</p>
        {sent?.status === "submitted" ? (
          <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Payment being verified</p>
            <p className="mt-1">{`UTR ${sent.utr} sent. We will confirm it against our bank account.`}</p>
          </div>
        ) : (
          <>
            {bankLoaded || bankFailed
              ? <BankTransferDetails details={bankDetails} amount={amount} method={byWhat} orderNo={orderNo} timed={false} />
              : <p className="mt-4 text-sm text-slate">Loading our bank details…</p>}
            <div className="mt-4 border-t border-border pt-4">
              <BankUtrForm orderNo={orderNo} amount={amount} method={method} customer={customer} submission={sent} />
            </div>
          </>
        )}
      </div>
    );
  }
  if (!settings || status === "Cancelled") return null;
  // Paid (or refunded) some other way: nothing to pay, whatever became of a UTR sent earlier (13 Nov 2026: a paid,
  // delivered order showed "Pay by UPI ₹0.00 · Unpaid" and "UTR … could not be matched"). A confirmed UTR still shows
  // its own "Payment received" box in the panel below.
  if (sent?.status !== "confirmed" && (payment === "Paid" || payment === "Refunded" || balance <= 0)) return null;
  if (!sent && (!on || payment === "Paid" || balance <= 0 || !/upi/i.test(method))) return null;
  return <div className="mb-6"><UpiPayPanel settings={settings} orderNo={orderNo} amount={sent && sent.status !== "rejected" ? sent.amount : balance} customer={customer} /></div>;
}

/**
 * Pay the order by UPI straight to the company's bank account (no gateway, no commission):
 * a QR for the exact amount, one-tap UPI app buttons on phones, then the 12-digit UTR from the
 * customer's UPI app. The admin confirms the UTR against the bank credit.
 */
export function UpiPayPanel({ settings, orderNo, amount, customer }: { settings: UpiSettings; orderNo: string; amount: number; customer: string }) {
  const { submissions } = useUpiPayments();
  const submission = submissions.find((item) => item.orderNo === orderNo);
  const uri = useMemo(() => upiPaymentUri(settings, amount, orderNo), [settings, amount, orderNo]);
  const qrSvg = useMemo(() => renderSVG(uri, { border: 2, ecc: "M" }), [uri]);
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async (value = utr) => {
    const problem = utrProblem(value);
    if (problem) { setError(problem); return; }
    setSending(true);
    try {
      await submitUpiPayment({ orderNo, amount, utr: normaliseUtr(value), customer });
      setError("");
      toast.success("Payment details sent", { description: "We will confirm it as soon as it reaches our bank." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the payment details");
    } finally {
      setSending(false);
    }
  };

  if (submission?.status === "confirmed") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-left text-sm text-emerald-900">
        <p className="flex items-center gap-2 font-bold"><CheckCircle2 className="h-5 w-5" /> Payment received for {orderNo}</p>
        <p className="mt-1">{inrPrecise(amount)} · UTR {submission.utr}. Your order is now being processed.</p>
      </div>
    );
  }

  return (
    <div id={payPanelId(orderNo)} className="scroll-mt-24 rounded-lg border border-border bg-card p-4 text-left shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate">Pay by UPI · no extra charges</p>
          <p className="mt-1 text-2xl font-extrabold text-navy">{inrPrecise(amount)}</p>
          <p className="text-xs text-slate">Order {orderNo} · to {settings.payeeName}</p>
        </div>
        {submission?.status !== "submitted" && (
          // An order placed before pay-first has no payment window: no countdown, just unpaid.
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
            <Clock className="h-3.5 w-3.5" /> Unpaid
          </span>
        )}
      </div>

      {submission?.status === "submitted" ? (
        <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <p className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> Payment being verified</p>
          <p className="mt-1">UTR {submission.utr} sent. We confirm it against our bank account, usually within a few minutes in working hours, and your order moves to "Payment Confirmed".</p>
        </div>
      ) : (
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
              <li>Check the amount <span className="font-semibold">{inrPrecise(amount)}</span> and pay to <span className="font-semibold">{settings.payeeName}</span>.</li>
              <li>Copy the 12-digit <span className="font-semibold">UTR / UPI Ref. No.</span> from the payment receipt and enter it here.</li>
            </ol>
            <UpiAppButtons uri={uri} returnTo={payPanelId(orderNo)} />
            <UpiIdPay orderNo={orderNo} vpa={settings.vpa} payeeName={settings.payeeName} amount={amount} keepCheckout={false} />
          </div>
        </div>
      )}

      {submission?.status !== "submitted" && (
        <div className="mt-4 border-t border-border pt-4">
          {submission?.status === "rejected" && (
            <p className="mb-2 flex items-start gap-2 rounded-md bg-red-50 p-2 text-xs text-red-800">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> UTR {submission.utr} could not be matched{submission.note ? `: ${submission.note}` : ""}. Check it and enter it again.
            </p>
          )}
          <label className="block text-xs font-semibold text-charcoal" htmlFor={`utr-${orderNo}`}>After paying, enter the 12-digit UTR</label>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <input id={`utr-${orderNo}`} inputMode="numeric" autoComplete="off" maxLength={16} placeholder="e.g. 612345678901" value={utr}
              onChange={(e) => { setUtr(e.target.value); setError(""); }}
              className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm tracking-wider" />
            <button type="button" disabled={sending} onClick={() => void submit()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "I have paid"}</button>
          </div>
          {error && <p className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
          {STATIC_DATA_MODE && (
            <button type="button" onClick={() => { const fake = String(Math.floor(1e11 + Math.random() * 9e11)); setUtr(fake); void submit(fake); }}
              className="mt-2 text-xs font-semibold text-slate underline">Demo only: simulate paying and entering a UTR</button>
          )}
        </div>
      )}
    </div>
  );
}
