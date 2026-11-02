import { Link } from "@tanstack/react-router";
import { inrPrecise } from "@/lib/data";
import type { PaymentHold } from "@/lib/payment-hold";
import { isBankMethod, methodLabel } from "@/lib/payment-rules";
import { cn } from "@/lib/utils";

/** Checkouts still waiting for payment: a reloaded page or a lost tab must not lose the way back to them. */
export function WaitingCheckouts({ holds, sent, className }: { holds: PaymentHold[]; sent: string[]; className?: string }) {
  if (!holds.length) return null;
  const allSent = holds.every((hold) => sent.includes(hold.orderNo));
  return (
    <div className={cn("rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950", className)}>
      <p className="font-semibold">{allSent ? "We are checking the payment for your earlier checkout" : "You have a checkout waiting for payment"}</p>
      <ul className="mt-2 space-y-1.5">
        {holds.map((hold) => (
          <li key={hold.orderNo} className="flex flex-wrap items-center justify-between gap-2">
            <span>{hold.orderNo} · {inrPrecise(hold.amount)} · {methodLabel(hold.method ?? "UPI")}</span>
            <Link to="/account/orders/$id" params={{ id: hold.orderNo }} className="font-semibold underline">{sent.includes(hold.orderNo) ? "View" : isBankMethod(hold.method) ? "Enter UTR" : "Pay now"}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
