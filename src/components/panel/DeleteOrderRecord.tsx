import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { CheckCircle2, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { inrPrecise } from "@/lib/data";
import { deleteAsksAboutMoney, deletePlan, type DeleteCheck, type MoneyAnswer } from "@/lib/order-cancel";
import { useApp } from "@/lib/store";
import { upiRecordsChanged } from "@/lib/upi-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CancelOrderDialog } from "@/components/panel/CancelOrderDialog";

const NOTHING: DeleteCheck = { blocker: null, status: "Cancelled", paid: 0, payments: [], paid_without_record: 0, bank_alert: false, confirmed_utr: null, needs_cancel: false, after_dispatch: false, zoho_alive: false };

/** The button for an order's own page and the payments list. */
export function DeleteOrderRecordButton({ orderNo, label = "Delete all details", leaveTo = "/admin/orders", className }: { orderNo: string; label?: string; leaveTo?: "/admin/orders" | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button variant="outline" size="sm" className={cn("text-danger hover:border-danger", className)} onClick={() => setOpen(true)}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />{label}
      </Button>
      {open && <DeleteOrderRecordDialog orderNo={orderNo} onClose={() => setOpen(false)} {...(leaveTo ? { onDeleted: () => void navigate({ to: leaveTo }) } : {})} />}
    </>
  );
}

/**
 * Admin: delete an order at any step, with everything on it. If money is recorded on it, the admin says first whether it
 * was really received: only a test or a typing mistake has its payments removed; real money is refunded (Refund) or the
 * order is a real sale and stays. Then the order is cancelled if it is not already, and deleted with a full copy kept.
 * The database checks every step again (deleteOrderPayment, admin_cancel_order, admin_delete_order_all_details).
 */
export function DeleteOrderRecordDialog({ orderNo, onClose, onDeleted }: { orderNo: string; onClose: () => void; onDeleted?: () => void }) {
  const { orders, forgetOrder, cancelOrderAsAdmin } = useApp();
  const [check, setCheck] = useState<DeleteCheck | null>(null);
  const [answer, setAnswer] = useState<MoneyAnswer>(null);
  const [goodsBack, setGoodsBack] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [refunding, setRefunding] = useState(false);
  useEffect(() => {
    if (STATIC_DATA_MODE) { setCheck(NOTHING); return; }
    void supabase.rpc("order_delete_with_payments_check", { _order_no: orderNo }).then(({ data, error }) => {
      if (error) setCheck({ ...NOTHING, blocker: error.message });
      else {
        const raw = data as unknown as DeleteCheck;
        setCheck({ ...raw, paid: Number(raw.paid ?? 0), paid_without_record: Number(raw.paid_without_record ?? 0), payments: (raw.payments ?? []).map((p) => ({ ...p, amount: Number(p.amount) })) });
      }
    });
  }, [orderNo]);
  const order = orders.find((candidate) => candidate.id === orderNo);
  const plan = check ? deletePlan(check, answer, goodsBack) : null;
  const ready = Boolean(plan && !plan.why && reason.trim().length >= 4 && typed.trim() === "DELETE");

  const run = async () => {
    if (!check || !plan || plan.why) return;
    setBusy(true);
    const why = reason.trim();
    const stop = (message: string) => {
      setBusy(false);
      toast.error("Delete stopped", { description: message });
    };
    try {
      if (!STATIC_DATA_MODE && deleteAsksAboutMoney(check) && answer === "not_real") {
        const { deleteOrderPayment } = await import("@/lib/zoho-commerce.functions");
        for (const payment of check.payments) {
          try {
            await deleteOrderPayment({ data: { paymentId: payment.id, reason: why } });
          } catch (cause) {
            return stop(cause instanceof Error ? cause.message : "Could not remove a payment");
          }
          setDone((list) => [...list, `Removed ${inrPrecise(payment.amount)} (${payment.reference || "no reference"})`]);
        }
      }
      if (check.needs_cancel) {
        const ok = await cancelOrderAsAdmin(orderNo, { reason: why, goodsBack: check.after_dispatch ? goodsBack : null, refund: null });
        if (!ok) return stop("The order could not be cancelled. Its payments that were removed stay removed.");
        setDone((list) => [...list, "Order cancelled"]);
      }
      const { error } = STATIC_DATA_MODE ? { error: null } : await supabase.rpc("admin_delete_order_all_details", { _order_no: orderNo, _reason: why });
      if (error) {
        if (/Zoho/i.test(error.message) && check.zoho_alive) {
          setBusy(false);
          toast.message("Almost done", { description: "The order is cancelled. The Zoho sync is voiding its sales order; press Delete again in a minute to finish." });
          onClose();
          return;
        }
        return stop(error.message);
      }
      forgetOrder(orderNo);
      upiRecordsChanged();
      toast.success(`Order ${orderNo} deleted with all its details`, { description: "A full copy is kept in the Delete Log." });
      setBusy(false);
      onClose();
      onDeleted?.();
    } catch (cause) {
      stop(cause instanceof Error ? cause.message : "Something went wrong");
    }
  };

  const choice = (selected: boolean) => cn(
    "rounded-md border px-3 py-2 text-left text-sm font-semibold transition-colors",
    selected ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy",
  );
  if (refunding && order) return <CancelOrderDialog order={order} onClose={() => { setRefunding(false); onClose(); }} />;
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Delete everything on ${orderNo}?`}</DialogTitle>
          <DialogDescription>
            {!check ? "Checking whether it can be deleted…" : check.blocker ? check.blocker : `It is at ${check.status}.`}
          </DialogDescription>
        </DialogHeader>
        {check && !check.blocker && (
          <div className="grid min-w-0 gap-4 text-sm">
            {deleteAsksAboutMoney(check) && (
              <fieldset className="grid min-w-0 gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                <legend className="px-1 font-semibold text-amber-950">{`${inrPrecise(check.paid + check.paid_without_record)} is recorded as paid`}</legend>
                {check.payments.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-amber-900">
                    {check.payments.map((payment) => (
                      <li key={payment.id} className="break-all">
                        <span>{inrPrecise(payment.amount)}</span> · <span>{payment.method || "Payment"}</span> · <span>{`Reference: ${payment.reference || "—"}`}</span>
                        {payment.in_zoho && <> · <span>in Zoho Books</span></>}
                      </li>
                    ))}
                  </ul>
                )}
                {check.confirmed_utr && <p className="text-xs font-semibold text-amber-900">{`The customer's UTR ${check.confirmed_utr} was confirmed against the bank. Choose No only if you are sure the money never came.`}</p>}
                <p className="font-semibold text-amber-950">Was this money really received?</p>
                <div className="grid gap-2">
                  <button type="button" aria-pressed={answer === "not_real"} className={choice(answer === "not_real")} onClick={() => setAnswer("not_real")}>No, it was a test or typed by mistake</button>
                  <button type="button" aria-pressed={answer === "paid_back"} className={choice(answer === "paid_back")} onClick={() => setAnswer("paid_back")}>Yes, and it was paid back to the customer</button>
                  <button type="button" aria-pressed={answer === "kept"} className={choice(answer === "kept")} onClick={() => setAnswer("kept")}>Yes, and we kept it</button>
                </div>
                {answer === "paid_back" && (
                  order
                    ? <Button size="sm" className="justify-self-start bg-navy text-white" onClick={() => setRefunding(true)}>Record the refund</Button>
                    : <p className="text-xs text-amber-900">Open the order and press Cancel Order to record the refund.</p>
                )}
              </fieldset>
            )}
            {check.needs_cancel && check.after_dispatch && (answer === "not_real" || !deleteAsksAboutMoney(check)) && (
              <fieldset className="grid gap-2">
                <legend className="mb-1 font-semibold text-navy">Did the goods come back to the godown?</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button type="button" aria-pressed={goodsBack === true} className={choice(goodsBack === true)} onClick={() => setGoodsBack(true)}>Yes, they are back</button>
                  <button type="button" aria-pressed={goodsBack === false} className={choice(goodsBack === false)} onClick={() => setGoodsBack(false)}>No, they did not come back</button>
                </div>
              </fieldset>
            )}
            {plan?.why ? (
              <p role="status" className="text-sm font-semibold text-slate">{plan.why}</p>
            ) : plan && (
              <>
                <div>
                  <p className="mb-1 font-semibold text-navy">What happens</p>
                  <ol className="list-decimal space-y-1 pl-5 text-xs text-slate">{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                </div>
                <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Why is it being deleted?" value={reason} onChange={(event) => setReason(event.target.value)} />
                <label className="grid gap-1 text-xs font-semibold text-slate">Type DELETE to confirm<Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-no-translate /></label>
              </>
            )}
            {done.length > 0 && (
              <ul className="space-y-0.5 text-xs text-emerald-800">
                {done.map((line) => <li key={line} className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /><span>{line}</span></li>)}
              </ul>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Keep it</Button>
          {check && !check.blocker && plan && !plan.why && (
            <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || !ready} onClick={() => void run()}>{busy ? "Deleting…" : "Delete everything"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
