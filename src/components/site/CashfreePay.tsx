import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Lock, ShieldCheck } from "lucide-react";
import { inrShop } from "@/lib/data";
import { cashfreeStatusWords } from "@/lib/cashfree";
import { loadCashfreeSdk } from "@/lib/cashfree-sdk";

export type CashfreeCheckout = { available: true; mode: "sandbox" | "production"; sdkUrl: string } | { available: false };

// Asked once per page (and again after a minute): whether this signed-in customer pays through Cashfree.
let asked: { at: number; promise: Promise<CashfreeCheckout> } | null = null;
export function useCashfreeCheckout(enabled: boolean) {
  const [state, setState] = useState<CashfreeCheckout | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    if (!asked || Date.now() - asked.at > 60_000) {
      asked = {
        at: Date.now(),
        promise: import("@/lib/cashfree.functions")
          .then(({ getCashfreeCheckout }) => getCashfreeCheckout())
          .then((answer) => answer as CashfreeCheckout)
          .catch(() => ({ available: false as const })),
      };
    }
    // Never keep the customer waiting on this: after 4 s the usual UPI screen shows.
    const late = window.setTimeout(() => { if (!stopped) setState((current) => current ?? { available: false }); }, 4000);
    void asked.promise.then((answer) => { if (!stopped) setState(answer); });
    return () => { stopped = true; window.clearTimeout(late); };
  }, [enabled]);
  return state;
}

type Phase = "idle" | "opening" | "paying" | "checking" | "notPaid" | "error";

/**
 * Pay through Cashfree (owner, 28 Nov 2026): Cashfree's own payment screen (UPI, cards, net banking) opens over the page.
 * When it closes, the website asks Cashfree whether the payment went through; the order is placed only by the server,
 * from what Cashfree says (or its signed webhook). The page itself follows the order and shows "placed" when it is.
 */
export function CashfreePay({ orderNo, amount, mode, sdkUrl, onUnavailable }: {
  orderNo: string; amount: number; mode: "sandbox" | "production"; sdkUrl: string; onUnavailable: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const stopped = useRef(false);
  // Set again on every mount: React's development mode mounts twice, and a stale "stopped" would end every check.
  useEffect(() => {
    stopped.current = false;
    return () => { stopped.current = true; };
  }, []);

  /** Asks the server, a few times while Cashfree may still be finishing, until the order is paid or Cashfree says no. */
  const follow = useCallback(async (tries: number) => {
    const { checkCashfreePayment } = await import("@/lib/cashfree.functions");
    for (let i = 0; i < tries && !stopped.current; i += 1) {
      try {
        const state = await checkCashfreePayment({ data: { orderNo } });
        if (state.paid || state.orderStatus !== "Awaiting Payment") return true;
        const last = state.lastPayment?.status ?? "";
        if (["FAILED", "USER_DROPPED", "CANCELLED", "VOID"].includes(last) && i >= 1) {
          setPhase("notPaid");
          setMessage(cashfreeStatusWords(last));
          return false;
        }
      } catch {
        // A slow reply: try again.
      }
      await new Promise((resolve) => window.setTimeout(resolve, i < 3 ? 2000 : 4000));
    }
    return false;
  }, [orderNo]);

  // Back from Cashfree's page (it had to leave ours), or a payment Cashfree already reported: shown at once.
  useEffect(() => { void follow(1); }, [follow]);

  const pay = async () => {
    setMessage("");
    setPhase("opening");
    try {
      const { startCashfreePayment } = await import("@/lib/cashfree.functions");
      const start = await startCashfreePayment({ data: { orderNo } });
      if (start.paid) {
        setPhase("checking");
        await follow(3);
        return;
      }
      const Cashfree = await loadCashfreeSdk(start.sdkUrl || sdkUrl);
      setPhase("paying");
      const result = await Cashfree({ mode: start.mode ?? mode }).checkout({ paymentSessionId: start.paymentSessionId, redirectTarget: "_modal" });
      if (stopped.current) return;
      setPhase("checking");
      // Closed without paying: one quick look (a payment may still have gone through), then try again is offered.
      const paid = await follow(result.paymentDetails ? 15 : 2);
      if (!paid && !stopped.current) {
        setPhase("notPaid");
        setMessage((current) => current || (result.error?.message ? "Payment not completed" : "We could not see your payment yet"));
      }
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (/not available/i.test(text)) {
        onUnavailable();
        return;
      }
      setPhase("error");
      setMessage(text.replace(/^Error:\s*/, "").slice(0, 200));
    }
  };

  const busy = phase === "opening" || phase === "paying" || phase === "checking";
  return (
    <div className="mt-4 space-y-3">
      {mode === "sandbox" && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950">Test mode (Cashfree sandbox): no real money moves. Use Cashfree's test UPI ID or card.</p>
      )}
      <button type="button" disabled={busy} onClick={() => void pay()}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-navy px-4 text-base font-bold text-white shadow-sm hover:bg-navy/90 disabled:opacity-70 sm:w-auto sm:min-w-[260px]">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-5 w-5" />}
        {phase === "opening" ? "Opening the payment page…" : phase === "paying" ? "Complete the payment in the Cashfree window" : phase === "checking" ? "Checking your payment…" : phase === "notPaid" || phase === "error" ? `Try again · Pay ${inrShop(amount)}` : `Pay ${inrShop(amount)}`}
      </button>
      <p className="flex items-start gap-1.5 text-xs text-slate"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />UPI, cards or net banking on Cashfree's secure payment page. Your order is placed as soon as the payment succeeds.</p>
      {phase === "checking" && <p className="flex items-center gap-2 text-sm font-semibold text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Checking your payment with Cashfree. Please do not pay again.</p>}
      {phase === "notPaid" && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">{message || "Payment not completed"}</p>
          <p className="mt-0.5">If money left your account, do not pay again: we check with Cashfree and place your order, or the money is refunded.</p>
        </div>
      )}
      {phase === "error" && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" /> {message || "Online payment could not be started"}</p>
          <button type="button" onClick={onUnavailable} className="mt-1 text-xs font-semibold underline">Pay by UPI QR instead</button>
        </div>
      )}
    </div>
  );
}
