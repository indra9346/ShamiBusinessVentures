import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { normaliseUtr, pasteSafeAmount, rupeesAndPaise, utrFromText, utrProblem, type UpiSubmission } from "@/lib/upi-pay";
import { sendUtrForOrder, submitUpiPayment } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

/** Copies text, also where the browser has no clipboard API (an older phone browser, or a page not on https). */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* falls back below */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  }
}

/**
 * Added 11 Nov 2026 (owner): pay from your own UPI app by our UPI ID, when the QR or the app buttons do not work (a UPI
 * app can refuse a payment link with its "risk policy" message; no money is taken then). Copy the UPI ID, pay the exact
 * amount in any UPI app with "Pay to UPI ID", come back and enter the UTR. Copying keeps a waiting checkout 10 more
 * minutes, once, like coming back from a UPI app (extend_my_payment_hold).
 */
export function UpiIdPay({ orderNo, vpa, payeeName, amount, keepCheckout = true, onKept, className }: {
  orderNo: string; vpa: string; payeeName: string; amount: number; keepCheckout?: boolean;
  onKept?: (holdUntil: string) => void; className?: string;
}) {
  const [copied, setCopied] = useState<"id" | "amount" | null>(null);
  // Only an amount that survives a UPI app keeping just the digits of a paste is copied (pasteSafeAmount): ₹98.04 is typed.
  const amountText = pasteSafeAmount(amount);
  const split = rupeesAndPaise(amount);
  const copy = async (what: "id" | "amount") => {
    if (what === "amount" && amountText === null) return;
    const ok = await copyText(what === "id" ? vpa : amountText ?? "");
    if (!ok) { toast.error("Could not copy. Please type it in your UPI app."); return; }
    setCopied(what);
    toast.success(what === "id" ? "UPI ID copied" : "Amount copied");
    if (what === "id" && keepCheckout && !STATIC_DATA_MODE) {
      void supabase.rpc("extend_my_payment_hold", { _order_no: orderNo }).then(({ data }) => { if (data) onKept?.(data); });
    }
  };
  const button = (what: "id" | "amount", label: string) => (
    <button type="button" onClick={() => void copy(what)}
      className={cn("inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-bold transition-colors",
        copied === what ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-navy bg-white text-navy hover:bg-navy hover:text-white")}>
      {copied === what ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === what ? "Copied" : label}
    </button>
  );
  return (
    <div className={cn("rounded-lg border border-gold/40 bg-ivory p-3", className)}>
      <p className="text-sm font-bold text-navy">Or pay from your UPI app by our UPI ID</p>
      <p className="mt-0.5 text-xs text-slate">Use this if the QR or the app button does not work for you.</p>
      <ol className="mt-2 list-decimal space-y-2 pl-4 text-xs text-charcoal">
        <li>
          <span>Copy our UPI ID:</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all rounded-md border border-border bg-white px-2 py-1.5 font-mono text-sm font-semibold text-navy" data-no-translate>{vpa}</span>
            {button("id", "Copy UPI ID")}
          </span>
        </li>
        <li>{`Open any UPI app (Google Pay, PhonePe, Paytm, BHIM…), choose Pay to UPI ID and paste it. Check that the name shows ${payeeName}.`}</li>
        <li>
          <span>Pay exactly this amount:</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-border bg-white px-2 py-1.5 font-mono text-sm font-semibold text-navy" data-no-translate>{inrPrecise(amount)}</span>
            {amountText !== null && button("amount", "Copy amount")}
          </span>
          {amountText === null && (
            <span className="mt-1 block rounded-md bg-amber-50 p-2 text-[11px] font-semibold text-amber-900">
              {`Type it yourself with the point: ${split.rupees} rupees ${split.paise} paise. Do not paste it: some UPI apps, such as PhonePe, drop the point and ask for ${inrPrecise(split.rupees * 100 + split.paise)}. Check your app shows ${inrPrecise(amount)} before you pay.`}
            </span>
          )}
        </li>
        <li>Come back here and enter the 12-digit UPI Ref No. (UTR) from the receipt below.</li>
      </ol>
      <p className="mt-2 text-[11px] text-slate">If your UPI app says the payment failed or was declined, no money was taken. Try paying this way, or with another UPI app.</p>
    </div>
  );
}

/** The UTR box for a UPI payment: typed or pasted (the whole receipt text works); the order is placed once our team confirms it. */
export function UpiUtrForm({ orderNo, amount, customer, submission, label = "Paid? Enter the 12-digit UPI Ref No. (UTR) from your UPI app", onSent }: {
  orderNo: string; amount: number; customer: string; submission?: UpiSubmission | undefined; label?: string;
  /** Told the UTR the moment it is accepted, so the page can say "Your order has been placed" at once (23 Nov 2026). */
  onSent?: (utr: string) => void;
}) {
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    // Typed or pasted with words around it: the UTR is picked out when it is certain.
    const typed = utrFromText(utr) ?? utr;
    const problem = utrProblem(typed);
    if (problem) { setError(problem); return; }
    setSending(true);
    try {
      const sent = normaliseUtr(typed);
      await submitUpiPayment({ orderNo, amount, utr: sent, customer });
      setError("");
      setUtr("");
      onSent?.(sent);
      toast.success("Your order has been placed", { description: `UTR received for ${orderNo}. We are confirming the payment with our bank; you will get a notification.`, duration: 10000 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the UTR");
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      {submission?.status === "rejected" && (
        <p className="mb-2 flex items-start gap-2 rounded-md bg-red-50 p-2 text-xs text-red-800">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> UTR {submission.utr} could not be matched{submission.note ? `: ${submission.note}` : ""}.
        </p>
      )}
      <label className="block text-xs font-semibold text-charcoal" htmlFor={`utr-${orderNo}`}>{label}</label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input id={`utr-${orderNo}`} inputMode="numeric" autoComplete="off" maxLength={300} placeholder="e.g. 612345678901" value={utr}
          onChange={(e) => { setUtr(e.target.value); setError(""); }}
          // The whole "Share receipt" text of PhonePe, Google Pay or Paytm can be pasted: the UTR is picked out of it.
          onPaste={(e) => {
            const found = utrFromText(e.clipboardData.getData("text"));
            if (found) { e.preventDefault(); setUtr(found); setError(""); }
          }}
          className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm tracking-wider" />
        <button type="button" disabled={sending} onClick={() => void send()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "Send UTR"}</button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
    </>
  );
}

const SEND_METHODS = ["UPI", "NEFT", "RTGS", "IMPS"] as const;

/**
 * Added 12 Nov 2026 (owner): a UTR for a checkout, from the customer after its time ran out ("paid already"), or from
 * the godown's channel partner for a customer. It only waits for an admin's check against the bank (submit_utr_for_order):
 * nothing is confirmed by sending it. A checkout that ended is placed again only when the admin finds the money.
 */
export function SendUtrForm({ orderNo, defaultMethod = "UPI", title, help, onSent, className }: {
  orderNo: string; defaultMethod?: string; title: string; help: string; onSent?: () => void; className?: string;
}) {
  const start = (SEND_METHODS as readonly string[]).includes(defaultMethod) ? defaultMethod : "UPI";
  const [method, setMethod] = useState(start);
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const typed = method === "UPI" ? utrFromText(utr) ?? utr : utr;
    const clean = typed.replace(/\s+/g, "").toUpperCase();
    if (method === "UPI" ? !/^\d{12}$/.test(clean) : !/^[0-9A-Z]{12,22}$/.test(clean)) {
      setError(method === "UPI" ? "The UTR has 12 digits" : "Enter the UTR from the bank: 12 to 22 letters and numbers");
      return;
    }
    setSending(true);
    try {
      await sendUtrForOrder(orderNo, clean, method);
      setError("");
      setUtr("");
      toast.success("UTR sent", { description: "We check it with our bank. If the money came, the order is placed and you are told." });
      onSent?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the UTR");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={cn("rounded-md border border-border bg-white p-3", className)}>
      <p className="text-sm font-bold text-navy">{title}</p>
      <p className="mt-0.5 text-xs text-slate">{help}</p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="How it was paid">
        {SEND_METHODS.map((option) => (
          <button key={option} type="button" aria-pressed={method === option} onClick={() => { setMethod(option); setError(""); }}
            className={cn("rounded-md border px-2.5 py-1 text-xs font-bold", method === option ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy")}>
            {option}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <input aria-label="UTR" inputMode={method === "UPI" ? "numeric" : "text"} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={300}
          placeholder={method === "UPI" ? "e.g. 612345678901" : "e.g. HDFCN52026111212345"} value={utr}
          onChange={(e) => { setUtr(e.target.value); setError(""); }}
          onPaste={(e) => {
            if (method !== "UPI") return;
            const found = utrFromText(e.clipboardData.getData("text"));
            if (found) { e.preventDefault(); setUtr(found); setError(""); }
          }}
          className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal" />
        <button type="button" disabled={sending} onClick={() => void send()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "Send UTR"}</button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
    </div>
  );
}
