import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { SendUtrForm } from "@/components/site/UpiIdPay";
import { inrPrecise } from "@/lib/data";
import { loadPartnerCheckouts, type PartnerCheckout } from "@/lib/upi-store";
import { orderToneClass } from "@/lib/order-status-tone";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Channel partner (12 Nov 2026, owner): their own godown's checkouts waiting for payment, or ended in the last 15 days.
 * When a customer has paid (to the company's account, as always) and shows the partner the UTR, the partner can send it
 * here. Only an admin confirms it, after checking the company's bank account (partner_payment_checkouts, submit_utr_for_order).
 */
export function PartnerPaymentsPanel() {
  const [rows, setRows] = useState<PartnerCheckout[] | null>(null);
  const [failed, setFailed] = useState("");
  const load = useCallback(() => {
    void loadPartnerCheckouts().then(
      (list) => { setRows(list); setFailed(""); },
      (cause: unknown) => setFailed(cause instanceof Error ? cause.message : "Could not load the payments"),
    );
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Panel title="Customer payments">
      <p className="mb-3 text-xs text-slate">Checkouts at your godown that are waiting for payment, or ended without it in the last 15 days. If a customer paid and gives you the UTR, send it here. Our office checks it with the company's bank account and places the order.</p>
      {failed ? <p className="text-sm text-danger">{failed}</p>
        : !rows ? <p className="flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : !rows.length ? <p className="text-sm text-slate">Nothing is waiting for payment.</p>
        : (
          <ul className="space-y-3">
            {rows.map((row) => (
              // The order colours (11 Nov 2026): waiting for payment yellow, time ran out red.
              <li key={row.orderNo} className={cn("rounded-lg border p-3", orderToneClass(row.status, "tile") || "border-border bg-white")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-xs font-semibold text-navy">{row.orderNo}</p>
                    <p className="text-xs text-slate"><span>{row.customer}</span> · <span>{when(row.placedAt)}</span> · <span>{row.method}</span></p>
                    {row.items && <p className="text-[11px] text-slate">{row.items}</p>}
                  </div>
                  <div className="text-right">
                    <p className="font-bold tabular-nums text-navy">{inrPrecise(row.total)}</p>
                    <p className={cn("text-[11px] font-semibold", orderToneClass(row.status, "text") || "text-amber-800")}>
                      {row.status === "Payment Expired" ? "Time ran out" : "Waiting for payment"}
                    </p>
                  </div>
                </div>
                {row.utrStatus === "submitted" ? (
                  <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">{`UTR ${row.utr} is with our office for a check.`}</p>
                ) : (
                  <SendUtrForm className="mt-2" orderNo={row.orderNo} defaultMethod={row.method} title="Customer paid? Send the UTR"
                    help="Only send a UTR the customer showed you from their UPI app or bank. Our office confirms it after checking the bank account." onSent={load} />
                )}
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
