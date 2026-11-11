import { useState } from "react";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise, type Order } from "@/lib/data";
import { adminCancelPlan, cancelFormProblem, cancelSteps, refundArgument, REFUND_MODES, type CancelForm } from "@/lib/order-cancel";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

type CancelableOrder = Pick<Order, "id" | "status" | "payment" | "paidAmount" | "amount" | "vendorStatuses">;

/**
 * Admin: cancel an order at any step. After dispatch it asks whether the goods came back; if money was received it asks
 * how it was paid back first; it always asks why. The database checks everything again (admin_cancel_order).
 */
export function CancelOrderButton({ order, className, label = "Cancel Order" }: { order: CancelableOrder; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!adminCancelPlan(order).allowed) return null;
  return (
    <>
      <Button variant="outline" size="sm" className={cn("text-danger hover:border-danger", className)} onClick={() => setOpen(true)}>
        <Ban className="mr-1.5 h-3.5 w-3.5" />{label}
      </Button>
      {open && <CancelOrderDialog order={order} onClose={() => setOpen(false)} />}
    </>
  );
}

export function CancelOrderDialog({ order, onClose }: { order: CancelableOrder; onClose: () => void }) {
  const { cancelOrderAsAdmin } = useApp();
  const plan = adminCancelPlan(order);
  const today = indiaToday();
  const [form, setForm] = useState<CancelForm>({ reason: "", goodsBack: null, refundMode: "", refundReference: "", refundedOn: today });
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = cancelFormProblem(order, form, today);
  const set = (patch: Partial<CancelForm>) => setForm((current) => ({ ...current, ...patch }));
  const submit = async () => {
    setTried(true);
    if (problem) return;
    setBusy(true);
    const ok = await cancelOrderAsAdmin(order.id, {
      reason: form.reason,
      goodsBack: plan.afterDispatch ? form.goodsBack : null,
      refund: refundArgument(order, form),
    });
    setBusy(false);
    if (!ok) return;
    toast.success(`Order ${order.id} cancelled`, plan.needsRefund ? { description: `Refund of ${inrPrecise(plan.refundAmount)} recorded.` } : undefined);
    onClose();
  };
  const choice = (selected: boolean) => cn(
    "rounded-md border px-3 py-2 text-left text-sm font-semibold transition-colors",
    selected ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy",
  );
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Cancel order ${order.id}?`}</DialogTitle>
          <DialogDescription>
            {plan.afterDispatch ? `It has already left the godown (${order.status}).` : `It is at ${order.status} and has not left the godown.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4 text-sm">
          {plan.afterDispatch && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 font-semibold text-navy">Did the goods come back to the godown?</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button type="button" aria-pressed={form.goodsBack === true} className={choice(form.goodsBack === true)} onClick={() => set({ goodsBack: true })}>Yes, they are back</button>
                <button type="button" aria-pressed={form.goodsBack === false} className={choice(form.goodsBack === false)} onClick={() => set({ goodsBack: false })}>No, they did not come back</button>
              </div>
            </fieldset>
          )}
          {plan.needsRefund && (
            <fieldset className="grid min-w-0 gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <legend className="px-1 font-semibold text-amber-950">{`Refund ${inrPrecise(plan.refundAmount)} first`}</legend>
              <p className="text-xs text-amber-900">{`${inrPrecise(plan.refundAmount)} was paid on this order. Pay it back to the customer, then record how:`}</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="How the money was paid back">
                {REFUND_MODES.map((mode) => (
                  <button key={mode} type="button" aria-pressed={form.refundMode === mode} className={cn(choice(form.refundMode === mode), "px-2.5 py-1 text-xs")} onClick={() => set({ refundMode: mode })}>
                    {mode}
                  </button>
                ))}
              </div>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate">
                {form.refundMode === "Cash" ? "Note (optional)" : "UTR or reference of the refund"}
                <Input value={form.refundReference} maxLength={100} autoComplete="off" className="bg-white" onChange={(event) => set({ refundReference: event.target.value })} data-no-translate />
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate">
                Date paid back
                <Input type="date" max={today} value={form.refundedOn} className="bg-white" onChange={(event) => set({ refundedOn: event.target.value })} />
              </label>
            </fieldset>
          )}
          <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate">
            Why is it being cancelled?
            <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </label>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate">
            {cancelSteps(order, form.goodsBack).map((step) => <li key={step}>{step}</li>)}
          </ul>
          {tried && problem && <p role="alert" className="text-sm font-semibold text-danger">{problem}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Keep the order</Button>
          <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy} onClick={() => void submit()}>
            {busy ? "Cancelling…" : plan.needsRefund ? "Cancel and record refund" : "Cancel order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
