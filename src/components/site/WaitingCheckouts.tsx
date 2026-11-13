import { Link } from "@tanstack/react-router";
import { inrPrecise } from "@/lib/data";
import { holdView, type PaymentHold } from "@/lib/payment-hold";
import { isBankMethod, methodLabel } from "@/lib/payment-rules";
import { cn } from "@/lib/utils";

/**
 * Checkouts still waiting for payment: a reloaded page or a lost tab must not lose the way back to them. Same rule as the
 * checkout page (holdView): once the bank shows the money, or a UTR is sent, there is nothing to pay (13 Nov 2026: this
 * still said "Pay now" after the bank had shown the money).
 */
export function WaitingCheckouts({ holds, sent, className }: { holds: PaymentHold[]; sent: string[]; className?: string }) {
  if (!holds.length) return null;
  const view = (hold: PaymentHold) => holdView(hold, sent.includes(hold.orderNo));
  const allSent = holds.every((hold) => ["received", "verifying"].includes(view(hold)));
  return (
    <div className={cn("rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950", className)}>
      <p className="font-semibold">{allSent ? "We are checking the payment for your earlier checkout" : "You have a checkout waiting for payment"}</p>
      <ul className="mt-2 space-y-1.5">
        {holds.map((hold) => (
          <li key={hold.orderNo} className="flex flex-wrap items-center justify-between gap-2">
            <span>{hold.orderNo} · {inrPrecise(hold.amount)} · {methodLabel(hold.method ?? "UPI")}{view(hold) === "received" ? " · payment received, being confirmed" : ""}</span>
            <Link to="/account/orders/$id" params={{ id: hold.orderNo }} className="font-semibold underline">{view(hold) === "pay" ? (isBankMethod(hold.method) ? "Enter UTR" : "Pay now") : "View"}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
