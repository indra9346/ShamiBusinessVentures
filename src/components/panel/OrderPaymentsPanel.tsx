import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { inrPrecise } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { invoiceBalance, invoicePayments } from "@/lib/invoice-lines";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Row = { id: string; amount: number; method: string | null; status: string; txn_ref: string | null; created_at: string; zoho_payment_id: string | null };

/**
 * Admin, on an order: each payment with its mode and UTR, and what is still due, as the invoice shows it. A payment entered
 * by mistake can be removed here: the balance is worked out again, and a copy is kept with the reason.
 */
export function OrderPaymentsPanel({ orderNo, total }: { orderNo: string; total: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setRows([]); return; }
    const { data: order } = await supabase.from("orders").select("id").eq("order_no", orderNo).maybeSingle();
    if (!order) { setRows([]); return; }
    const { data } = await supabase.from("payments").select("id,amount,method,status,txn_ref,created_at,zoho_payment_id").eq("order_id", order.id).order("created_at");
    setRows((data ?? []).map((row) => ({ ...row, amount: Number(row.amount) })) as Row[]);
  }, [orderNo]);
  useEffect(() => { void load(); }, [load]);
  const counted = invoicePayments((rows ?? []).map((row) => ({ ...row })));
  const paid = counted.reduce((sum, row) => sum + row.amount, 0);
  const { balance } = invoiceBalance(total, paid);
  return (
    <>
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
          <div className="flex justify-between"><dt className="font-semibold text-navy">Balance due</dt><dd className={balance > 0 ? "font-bold text-red-700" : "font-bold text-navy"}>{inrPrecise(balance)}</dd></div>
        </dl>
      </Panel>
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

type Check = { blocker: string | null; notes: string[] };

/** Admin: delete a closed order with everything on it, for the ones the ordinary delete keeps. */
export function DeleteAllDetailsButton({ orderNo }: { orderNo: string }) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const { forgetOrder } = useApp();
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    setCheck(null);
    if (STATIC_DATA_MODE) { setCheck({ blocker: null, notes: [] }); return; }
    void supabase.rpc("order_delete_all_check", { _order_no: orderNo }).then(({ data, error }) => {
      if (error) setCheck({ blocker: error.message, notes: [] });
      else setCheck(data as unknown as Check);
    });
  }, [open, orderNo]);
  const remove = async () => {
    setBusy(true);
    const { error } = STATIC_DATA_MODE ? { error: null } : await supabase.rpc("admin_delete_order_all_details", { _order_no: orderNo, _reason: reason.trim() });
    setBusy(false);
    if (error) { toast.error("Could not delete the order", { description: error.message }); return; }
    forgetOrder(orderNo);
    toast.success(`Order ${orderNo} deleted with all its details`, { description: "A full copy is kept in the delete log." });
    setOpen(false);
    void navigate({ to: "/admin/orders" });
  };
  return (
    <>
      <Button variant="outline" size="sm" className="text-danger hover:border-danger" onClick={() => setOpen(true)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete all details</Button>
      {open && (
        <Dialog open onOpenChange={(next) => { if (!next) setOpen(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{`Delete everything on ${orderNo}?`}</DialogTitle>
              <DialogDescription>
                {!check ? "Checking whether it can be deleted…" : check.blocker ? check.blocker : "The order, its items, refund records and UTRs are removed from this website for good. A full copy stays in the delete log with your reason, its number is never used again, and nothing changes in Zoho."}
              </DialogDescription>
            </DialogHeader>
            {check && !check.blocker && (
              <>
                {check.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">{check.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
                <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Why is it being deleted?" value={reason} onChange={(event) => setReason(event.target.value)} />
                <label className="grid gap-1 text-xs font-semibold text-slate">Type DELETE to confirm<Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-no-translate /></label>
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Keep it</Button>
              {check && !check.blocker && (
                <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 4 || typed.trim() !== "DELETE"} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete everything"}</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
