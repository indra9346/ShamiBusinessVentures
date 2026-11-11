import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { placeEndedCheckout } from "@/lib/upi-store";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const METHODS = ["UPI", "NEFT", "RTGS", "IMPS", "Cash", "Cheque"] as const;
const CHECKED = ["bank statement", "bank app", "bank SMS"] as const;

/**
 * Admin (12 Nov 2026, owner): the customer paid a checkout that ended without payment, after its time or offline. Once
 * the money is seen in the bank, this places it: its stock is taken again at its godown (refused if short) and the payment
 * is recorded like Confirm paid (admin_place_ended_checkout). With a UTR the customer or partner sent, it is filled in.
 */
export function RecordLatePaymentDialog({ orderNo, amount, method: startMethod, utr: sentUtr, onClose }: {
  orderNo: string; amount: number; method?: string | undefined; utr?: string | undefined; onClose: () => void;
}) {
  const { user, refreshHeldCheckouts } = useApp();
  const [method, setMethod] = useState<string>(METHODS.find((m) => m.toUpperCase() === (startMethod ?? "UPI").toUpperCase()) ?? "UPI");
  const [utr, setUtr] = useState(sentUtr ?? "");
  const [checked, setChecked] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = utr.trim().length >= 4 && Boolean(checked);
  const place = async () => {
    setBusy(true);
    try {
      await placeEndedCheckout(orderNo, utr.trim(), method, `Checked against ${checked}${user?.name ? ` by ${user.name}` : ""}`);
      void refreshHeldCheckouts([orderNo]);
      toast.success(`${orderNo} placed`, { description: "The payment is recorded and the order goes to Zoho." });
      onClose();
    } catch (cause) {
      toast.error("Could not place it", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  const choice = (selected: boolean) => cn("rounded-md border px-2.5 py-1 text-xs font-bold", selected ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy");
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Record payment for ${orderNo}?`}</DialogTitle>
          <DialogDescription>{`This checkout ended without payment. Only record ${inrPrecise(amount)} after you see it in the company's bank account. Its stock is taken again at its godown and it becomes an order.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div>
            <p className="mb-1 text-xs font-semibold text-slate">How it was paid</p>
            <div className="flex flex-wrap gap-1.5">
              {METHODS.map((option) => <button key={option} type="button" aria-pressed={method === option} className={choice(method === option)} onClick={() => setMethod(option)}>{option}</button>)}
            </div>
          </div>
          <label className="grid gap-1 text-xs font-semibold text-slate">
            UTR or reference shown by the bank
            <Input value={utr} maxLength={100} autoComplete="off" className="bg-white font-mono uppercase" onChange={(event) => setUtr(event.target.value)} data-no-translate />
          </label>
          <div>
            <p className="mb-1 text-xs font-semibold text-slate">Checked against</p>
            <div className="flex flex-wrap gap-1.5">
              {CHECKED.map((option) => <button key={option} type="button" aria-pressed={checked === option} className={choice(checked === option)} onClick={() => setChecked(option)}>{option.charAt(0).toUpperCase() + option.slice(1)}</button>)}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy || !ready} onClick={() => void place()}>{busy ? "Placing…" : "Record payment and place order"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
