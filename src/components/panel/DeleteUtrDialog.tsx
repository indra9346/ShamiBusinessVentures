import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteUtrRecord } from "@/lib/upi-store";
import { REFUNDED_UTR_NOTE } from "@/lib/payment-rules";

/**
 * Admin, on UPI & Bank Payments: delete a customer's UTR record that was rejected or refunded, saying why. The database
 * refuses one that is waiting, confirmed, or never checked against the bank (admin_delete_utr). A refunded transfer stays
 * unable to pay for anything after its record is gone.
 */
export function DeleteUtrDialog({ orderNo, utr, note, onClose }: { orderNo: string; utr: string; note: string | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteUtrRecord(orderNo, reason);
      toast.success(`UTR ${utr} deleted`, { description: "A copy is kept in the Delete Log." });
      onClose();
    } catch (cause) {
      toast.error("Could not delete the UTR record", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Delete UTR ${utr}?`}</DialogTitle>
          <DialogDescription>
            {note === REFUNDED_UTR_NOTE
              ? `The record that this UTR for ${orderNo} was refunded goes from this list. The transfer still cannot pay for anything, and a copy stays in the Delete Log with your reason.`
              : `The rejected UTR for ${orderNo} goes from this list. Nothing else changes, and a copy stays in the Delete Log with your reason.`}
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Why is it being deleted?" value={reason} onChange={(event) => setReason(event.target.value)} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 4} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete UTR record"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
