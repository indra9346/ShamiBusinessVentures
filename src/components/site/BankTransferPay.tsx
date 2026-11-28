import { useState } from "react";
import { toast } from "sonner";
import { Copy, Landmark, XCircle } from "lucide-react";
import { inrShop } from "@/lib/data";
import { bankUtrProblem, normaliseBankUtr, type BankDetails } from "@/lib/payment-rules";
import { submitUpiPayment } from "@/lib/upi-store";
import type { UpiSubmission } from "@/lib/upi-pay";

/** The company's account, each detail with a copy button, and how to pay into it. */
export function BankTransferDetails({ details, amount, method, orderNo, timed = true }: { details: BankDetails | null; amount: number; method: string; orderNo: string; timed?: boolean }) {
  if (!details) {
    return (
      <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        Our bank details could not be shown right now. Please call or WhatsApp us for them.
      </p>
    );
  }
  const rows: [string, string][] = [
    ["Account name", details.accountName],
    ["Account number", details.accountNumber],
    ["IFSC", details.ifsc],
    ["Bank", details.bankName],
    ...(details.branch ? ([["Branch", details.branch]] as [string, string][]) : []),
    ["Amount", amount.toFixed(2)],
    ["Remarks", orderNo],
  ];
  return (
    <div className="mt-4 space-y-3">
      <ol className="list-decimal space-y-1 pl-4 text-sm text-charcoal">
        <li className="font-semibold">{`Transfer exactly ${inrShop(amount)} by ${method} from your bank's app, net banking or branch.`}</li>
        <li>{`Write your order number ${orderNo} in the remarks.`}</li>
        <li>{timed ? "Enter the UTR from your bank below, within the time shown." : "Enter the UTR from your bank below."}</li>
      </ol>
      <div className="rounded-md border border-border bg-ivory/60 p-3">
        <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate"><Landmark className="h-3.5 w-3.5" /> Our bank account</p>
        <dl className="divide-y divide-border/60 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5">
              <dt className="text-xs text-slate">{label}</dt>
              <dd className="flex min-w-0 items-center gap-2 font-semibold text-navy">
                <span className="break-all">{value}</span>
                <button type="button" aria-label={`Copy ${label}`} title="Copy" onClick={() => { void navigator.clipboard?.writeText(value); toast.success("Copied", { description: value }); }}
                  className="shrink-0 text-gold hover:text-navy">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** The box where the customer enters a NEFT or RTGS UTR. The database checks it again and tells the admins. */
export function BankUtrForm({ orderNo, amount, method, customer, submission, onSent }: { orderNo: string; amount: number; method: string; customer: string; submission?: UpiSubmission | undefined; onSent?: (utr: string) => void }) {
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const problem = bankUtrProblem(utr);
    if (problem) { setError(problem); return; }
    setSending(true);
    try {
      const sent = normaliseBankUtr(utr);
      await submitUpiPayment({ orderNo, amount, utr: sent, customer });
      setError("");
      onSent?.(sent);
      toast.success("Your order has been placed", { description: `UTR received for ${orderNo}. We are confirming the transfer in our bank account; you will get a notification.`, duration: 10000 });
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
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {`UTR ${submission.utr} could not be matched${submission.note ? `: ${submission.note}` : ""}. Check it and enter it again.`}
        </p>
      )}
      <label className="block text-xs font-semibold text-charcoal" htmlFor={`utr-${orderNo}`}>{`Enter the ${method} UTR from your bank (12 to 22 letters and numbers)`}</label>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input id={`utr-${orderNo}`} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} value={utr}
          placeholder={method === "RTGS" ? "e.g. HDFCR52026110212345678" : "e.g. HDFCN26110212345"}
          onChange={(event) => { setUtr(event.target.value); setError(""); }}
          className="h-10 min-w-0 flex-1 rounded-md border border-input bg-white px-3 font-mono text-sm uppercase tracking-wider" />
        <button type="button" disabled={sending} onClick={() => void send()} className="h-10 rounded-md bg-navy px-4 text-sm font-semibold text-white hover:bg-midnight disabled:opacity-60">{sending ? "Sending…" : "Send UTR"}</button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">{error}</p>}
    </>
  );
}
