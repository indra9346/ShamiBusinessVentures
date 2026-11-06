import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Landmark } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { inrPrecise } from "@/lib/data";
import { madeAfterCredit, suggestCheckoutsForCredit, suggestPaymentsForCredit } from "@/lib/bank-credit-match";
import type { PaymentHold } from "@/lib/payment-hold";
import { pushOrderToZohoInBackground } from "@/lib/store";
import { confirmOrderWithCredit, dismissCreditWithoutUtr, reopenCreditWithoutUtr, type CreditWithoutUtr } from "@/lib/upi-store";
import type { UpiSubmission } from "@/lib/upi-pay";

/*
 * Admin → UPI & Bank Payments: bank credits whose SMS has no UTR (IDFC FIRST Bank's has none), for the company's own
 * account only. When exactly one UPI checkout was waiting for the amount, the database has already kept the credit for
 * it (the customer's screen says the money arrived): the admin checks the payer in the bank app and confirms. Otherwise
 * each credit lists the UTRs and the checkouts waiting for exactly that amount. Confirming marks the order paid and sends
 * it to Zoho (sales order and invoice). The website never confirms one by itself: without a UTR, another payment of the
 * same amount could look the same.
 */

const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const creditTime = (credit: CreditWithoutUtr) => istTime(credit.creditedAt ?? credit.receivedAt);

/** The credits without a UTR that this waiting payment could be. */
export function creditsForPayment(payment: UpiSubmission, credits: readonly CreditWithoutUtr[]) {
  return credits.filter((credit) => credit.status === "new" && suggestPaymentsForCredit(credit, [payment]).length > 0);
}

/** One click to start, a second to mark the order paid. utr null: the credit itself is the payment. */
export function ConfirmWithCredit({ credit, orderNo, utr }: { credit: CreditWithoutUtr; orderNo: string; utr: string | null }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await confirmOrderWithCredit(credit.id, orderNo, utr);
      pushOrderToZohoInBackground(orderNo);
      toast.success(`${orderNo} marked paid`, { description: `Matched to the bank credit of ${inrPrecise(credit.amount)}. It goes to Zoho with its invoice.` });
    } catch (cause) {
      toast.error("Could not confirm", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  if (!asking) {
    return <Button size="sm" variant="outline" className="h-7 border-emerald-600 text-emerald-800" onClick={() => setAsking(true)}>Confirm with this credit</Button>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" className="h-7 bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy} onClick={() => void go()}>
        {busy ? "Confirming…" : "Yes, mark paid"}
      </Button>
      <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}

/** The short line in the "Payments to check" table under a UTR that a credit without a UTR could pay. */
export function CreditHint({ payment, credits }: { payment: UpiSubmission; credits: readonly CreditWithoutUtr[] }) {
  const credit = creditsForPayment(payment, credits)[0];
  if (!credit) return null;
  return (
    <div className="mt-1.5 space-y-1 rounded-md bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-900">
      <p className="flex flex-wrap gap-x-1">
        <span>Bank SMS without a UTR:</span>
        <span className="font-semibold">{inrPrecise(credit.amount)}</span>
        <span>{`to A/C …${credit.accountEnding} at ${creditTime(credit)}`}</span>
      </p>
      <ConfirmWithCredit credit={credit} orderNo={payment.orderNo} utr={payment.utr} />
    </div>
  );
}

const who = (checkout: Pick<PaymentHold, "customer" | "phone">) => [checkout.customer || "Name not given", checkout.phone].filter(Boolean).join(", ");

export function CreditsWithoutUtrPanel({ credits, submissions, checkouts = [] }: {
  credits: readonly CreditWithoutUtr[]; submissions: readonly UpiSubmission[]; checkouts?: readonly PaymentHold[];
}) {
  const [busy, setBusy] = useState("");
  const open = credits.filter((credit) => credit.status === "new");
  const done = credits.filter((credit) => credit.status !== "new").slice(0, 10);
  const utrSentFor = new Set(submissions.filter((item) => item.status === "submitted").map((item) => item.orderNo));

  const dismiss = async (credit: CreditWithoutUtr) => {
    const note = window.prompt(`What was ${inrPrecise(credit.amount)} on A/C …${credit.accountEnding} for? For example: office sale, not a website order.`, "");
    if (!note?.trim()) return;
    setBusy(credit.id);
    try {
      await dismissCreditWithoutUtr(credit.id, note.trim());
      toast.success("Dismissed");
    } catch (cause) {
      toast.error("Could not dismiss", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };
  const reopen = async (credit: CreditWithoutUtr) => {
    setBusy(credit.id);
    try {
      await reopenCreditWithoutUtr(credit.id);
      toast.success("Reopened");
    } catch (cause) {
      toast.error("Could not reopen", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  return (
    <Panel id="credits-without-utr" title="Bank credits without a UTR" className="mb-6 scroll-mt-36">
      <p className="mb-3 text-xs text-slate">
        IDFC FIRST Bank's credit SMS has no UTR. When only one checkout waits for the amount, the website keeps the money for it and tells the customer it arrived. Check the payer in your bank app, then confirm: the order is placed and goes to Zoho with its invoice.
      </p>
      {open.length === 0 ? <p className="text-sm text-slate">No bank credits without a UTR waiting.</p> : (
        <ul className="space-y-3">
          {open.map((credit) => {
            const kept = credit.suggestedOrderNo ? checkouts.find((checkout) => checkout.orderNo === credit.suggestedOrderNo && checkout.status === "Awaiting Payment") : undefined;
            const utrMatches = kept ? [] : suggestPaymentsForCredit(credit, submissions);
            const checkoutMatches = kept ? [] : suggestCheckoutsForCredit(credit, checkouts, utrSentFor);
            const choices = utrMatches.length + checkoutMatches.length;
            return (
              <li key={credit.id} className={`rounded-lg border p-3 ${kept ? "border-emerald-300 bg-emerald-50/40" : "border-border"}`} title={credit.raw}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
                    <Landmark className="h-4 w-4 shrink-0 text-gold" />
                    <span className="font-bold text-navy">{inrPrecise(credit.amount)}</span>
                    <span>{`credited to A/C …${credit.accountEnding}`}</span>
                    <span className="text-xs text-slate">{credit.creditedAt ? `Bank's time: ${creditTime(credit)}` : `SMS received ${creditTime(credit)}`}</span>
                  </p>
                  {!kept && <Button size="sm" variant="ghost" className="h-7 text-slate" disabled={busy === credit.id} onClick={() => void dismiss(credit)}>Not a website payment</Button>}
                </div>
                {kept ? (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-xs">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                      <span>Kept for</span>
                      <span className="font-mono font-semibold text-navy">{kept.orderNo}</span>
                      <span>{who(kept)}</span>
                      <span className="text-slate">{`(the only checkout waiting for this amount; made ${istTime(kept.createdAt)})`}</span>
                    </span>
                    <ConfirmWithCredit credit={credit} orderNo={kept.orderNo} utr={null} />
                  </div>
                ) : choices === 0 ? (
                  <p className="mt-2 text-xs text-slate">No checkout or UTR is waiting for this amount. If it isn't a website payment, mark it so.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {choices > 1 && <li className="text-xs font-semibold text-amber-800">More than one order waits for this amount: check the payer's name in your bank app, then confirm the right one.</li>}
                    {utrMatches.map((payment) => (
                      <li key={`utr-${payment.orderNo}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ivory/60 px-2 py-1.5 text-xs">
                        <span className="flex min-w-0 flex-wrap gap-x-1.5">
                          <span className="font-mono font-semibold text-navy">{payment.orderNo}</span>
                          <span>{payment.customer || "—"}</span>
                          <span className="font-mono">{`UTR ${payment.utr}, sent ${istTime(payment.submittedAt)}`}</span>
                        </span>
                        <ConfirmWithCredit credit={credit} orderNo={payment.orderNo} utr={payment.utr} />
                      </li>
                    ))}
                    {checkoutMatches.map((checkout) => (
                      <li key={`checkout-${checkout.orderNo}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ivory/60 px-2 py-1.5 text-xs">
                        <span className="flex min-w-0 flex-wrap gap-x-1.5">
                          <span className="font-mono font-semibold text-navy">{checkout.orderNo}</span>
                          <span>{who(checkout)}</span>
                          <span className="text-slate">{`no UTR sent, made ${istTime(checkout.createdAt)}`}</span>
                          {madeAfterCredit(credit, checkout) && <span className="font-semibold text-amber-800">made after the money came (a Reorder?)</span>}
                        </span>
                        <ConfirmWithCredit credit={credit} orderNo={checkout.orderNo} utr={null} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {done.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Already decided</h3>
          <ul className="space-y-1.5 text-xs">
            {done.map((credit) => (
              <li key={credit.id} className="flex flex-wrap items-center justify-between gap-2" title={credit.raw}>
                <span className="flex min-w-0 flex-wrap gap-x-1.5">
                  <span className="font-semibold">{inrPrecise(credit.amount)}</span>
                  <span>{`A/C …${credit.accountEnding}`}</span>
                  <span className="text-slate">{creditTime(credit)}</span>
                  {credit.status === "used"
                    ? <span className="font-semibold text-emerald-700">{`Used for ${credit.orderNo ?? "an order"}`}</span>
                    : <span className="text-slate">{`Dismissed: ${credit.note ?? ""}`}</span>}
                </span>
                {credit.status === "dismissed" && (
                  <Button size="sm" variant="ghost" className="h-7" disabled={busy === credit.id} onClick={() => void reopen(credit)}>Reopen</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
