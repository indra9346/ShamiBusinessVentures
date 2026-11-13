import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { invoiceBalance, invoicePayments } from "@/lib/invoice-lines";
import { placedAgainText } from "@/lib/order-cancel";
import { isMissingInDatabase } from "@/lib/upi-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Row = { id: string; amount: number; method: string | null; status: string; txn_ref: string | null; created_at: string; zoho_payment_id: string | null };
type RefundRow = { id: string; amount: number; mode: string; reference: string; refunded_on: string; created_by_name: string; zoho_payment_id: string | null; zoho_refunded_at: string | null; zoho_problem: string | null };
type CancelRow = { stage: string; goods_back: boolean | null; reason: string; cancelled_by_name: string; cancelled_at: string; placed_again_at?: string | null; placed_again_by_name?: string | null };
const CANCEL_COLUMNS = "stage,goods_back,reason,cancelled_by_name,cancelled_at";

const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

/** Where a refund stands in Zoho Books. */
function refundInZoho(row: RefundRow) {
  if (!row.zoho_payment_id) return "website only";
  if (row.zoho_refunded_at) return "recorded in Zoho Books";
  if (row.zoho_problem) return "Zoho Books: not recorded yet, see the Zoho sync";
  return "Zoho Books: waiting for the sync";
}

/**
 * Admin, on an order: each payment with its mode and UTR, and what is still due, as the invoice shows it. A payment entered
 * by mistake can be removed here: the balance is worked out again, and a copy is kept with the reason.
 */
export function OrderPaymentsPanel({ orderNo, total, cancelled: orderCancelled = false }: { orderNo: string; total: number; cancelled?: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [cancelled, setCancelled] = useState<CancelRow | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setRows([]); return; }
    const { data: order } = await supabase.from("orders").select("id").eq("order_no", orderNo).maybeSingle();
    if (!order) { setRows([]); return; }
    const readCancel = (columns: string) => supabase.from("order_cancellations").select(columns).eq("order_id", order.id).maybeSingle() as unknown as PromiseLike<{ data: CancelRow | null; error: { code?: string; message?: string } | null }>;
    const [{ data }, refundRead, firstCancelRead] = await Promise.all([
      supabase.from("payments").select("id,amount,method,status,txn_ref,created_at,zoho_payment_id").eq("order_id", order.id).order("created_at"),
      supabase.from("order_refunds").select("id,amount,mode,reference,refunded_on,created_by_name,zoho_payment_id,zoho_refunded_at,zoho_problem").eq("order_id", order.id).order("created_at"),
      readCancel(`${CANCEL_COLUMNS},placed_again_at,placed_again_by_name`),
    ]);
    // Before the database change of 13 Nov 2026 there is no placed_again_at: read what there is.
    const cancelRead = firstCancelRead.error && isMissingInDatabase(firstCancelRead.error) ? await readCancel(CANCEL_COLUMNS) : firstCancelRead;
    setRows((data ?? []).map((row) => ({ ...row, amount: Number(row.amount) })) as Row[]);
    setRefunds((refundRead.data ?? []).map((row) => ({ ...row, amount: Number(row.amount) })) as RefundRow[]);
    setCancelled((cancelRead.data as CancelRow | null) ?? null);
  }, [orderNo]);
  useEffect(() => { void load(); }, [load]);
  const counted = invoicePayments((rows ?? []).map((row) => ({ ...row })));
  const paid = counted.reduce((sum, row) => sum + row.amount, 0);
  // A cancelled order owes nothing, whatever was paid or refunded on it.
  const balance = orderCancelled ? 0 : invoiceBalance(total, paid).balance;
  return (
    <>
      <div id="payments-received" className="scroll-mt-36">
      <Panel title="Payments received" className="mt-5">
        {!rows ? <p className="text-sm text-slate">Loading…</p> : !rows.length ? <p className="text-sm text-slate">No payment has been recorded on this order.</p> : (
          <ul className="divide-y divide-border/60 text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-navy">{row.method || "Payment"} · {new Date(row.created_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })}{row.status !== "Paid" ? ` · ${row.status}` : ""}</span>
                  <span className="block break-all text-xs text-slate">UTR / Ref: {row.txn_ref || "—"}{row.zoho_payment_id ? " · in Zoho Books" : ""}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums font-bold text-navy">{inrPrecise(row.amount)}</span>
                  {row.status === "Paid" && (
                    <Button size="sm" variant="outline" className="text-danger hover:border-danger" onClick={() => setRemoving(row)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove</Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-2 space-y-1 border-t border-border pt-2 text-sm">
          <div className="flex justify-between"><dt className="text-slate">Order total</dt><dd className="font-semibold text-navy">{inrPrecise(total)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate">Paid</dt><dd className="font-semibold text-navy">{inrPrecise(paid)}</dd></div>
          <div className="flex justify-between"><dt className="font-semibold text-navy">{orderCancelled ? "Balance due (order cancelled)" : "Balance due"}</dt><dd className={balance > 0 ? "font-bold text-red-700" : "font-bold text-navy"}>{inrPrecise(balance)}</dd></div>
        </dl>
        {refunds.length > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <p className="text-xs font-bold uppercase tracking-wider text-slate">Refunds</p>
            <ul className="divide-y divide-border/60 text-sm">
              {refunds.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block font-semibold text-navy"><span>{row.mode}</span> · <span>{day(row.refunded_on)}</span></span>
                    <span className="block break-all text-xs text-slate">
                      <span>{`Reference: ${row.reference || "—"}`}</span> · <span>{refundInZoho(row)}</span>
                      {row.created_by_name && <> · <span>{`Recorded by ${row.created_by_name}`}</span></>}
                    </span>
                  </span>
                  <span className="tabular-nums font-bold text-danger">{`− ${inrPrecise(row.amount)}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* An ended checkout placed again after its payment was found is an order: its ended record stays, not as a cancel. */}
        {cancelled && placedAgainText(cancelled, day) && (
          <div className="mt-3 space-y-0.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-slate">
            <p className="font-semibold text-navy">{placedAgainText(cancelled, day)}</p>
            <p>{`The checkout had ended on ${day(cancelled.cancelled_at)}`}</p>
            {cancelled.cancelled_by_name && <p>{`Ended by ${cancelled.cancelled_by_name}`}</p>}
            <p className="break-words">{cancelled.reason ? `Reason: ${cancelled.reason}` : "No reason given"}</p>
          </div>
        )}
        {cancelled && !placedAgainText(cancelled, day) && (
          <div className="mt-3 space-y-0.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <p className="font-semibold">{`Cancelled at ${cancelled.stage} on ${day(cancelled.cancelled_at)}`}</p>
            {cancelled.cancelled_by_name && <p>{`Cancelled by ${cancelled.cancelled_by_name}`}</p>}
            {cancelled.goods_back !== null && <p>{cancelled.goods_back ? "The goods came back to the godown." : "The goods did not come back."}</p>}
            <p className="break-words">{cancelled.reason ? `Reason: ${cancelled.reason}` : "No reason given"}</p>
          </div>
        )}
      </Panel>
      </div>
      {removing && <RemovePaymentDialog payment={removing} onClose={() => setRemoving(null)} onDone={async () => {
        setRemoving(null);
        await load();
        // The order's own figures on this page come from the app's list: start again from the database.
        window.setTimeout(() => window.location.reload(), 1200);
      }} />}
    </>
  );
}

function RemovePaymentDialog({ payment, onClose, onDone }: { payment: Row; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      const { deleteOrderPayment } = await import("@/lib/zoho-commerce.functions");
      const result = await deleteOrderPayment({ data: { paymentId: payment.id, reason: reason.trim() } });
      toast.success("Payment removed", { description: `Now paid ${inrPrecise(Number(result.paid))}, due ${inrPrecise(Number(result.balance))}.` });
      await onDone();
    } catch (cause) {
      toast.error("Could not remove the payment", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Remove ${inrPrecise(payment.amount)}?`}</DialogTitle>
          <DialogDescription>{`${payment.method || "Payment"} · UTR / Ref: ${payment.txn_ref || "none"}. Use this only if the money was not really received or was entered by mistake. The balance due goes up, the invoice shows it the next time it is opened, and a copy is kept with your reason.${payment.zoho_payment_id ? " It also comes out of Zoho Books." : ""}`}</DialogDescription>
        </DialogHeader>
        <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Why is it being removed?" value={reason} onChange={(event) => setReason(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 4} onClick={() => void remove()}>{busy ? "Removing…" : "Remove payment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
