import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type RejectChoice = "give-time" | "end-checkout";

/**
 * Admin: reject a customer's UTR, and say what happens to the checkout. "Give time" is the old reject: the customer
 * can send the right UTR, and the checkout (with its stock) stays open for that time. "End checkout" rejects and ends
 * it at once: stock back on sale, the customer told it was not placed.
 */
export function RejectUtrDialog({ orderNo, utr, byBank, waiting, windowMinutes, onClose, onReject }: {
  orderNo: string; utr: string; byBank: boolean; waiting: boolean; windowMinutes: number;
  onClose: () => void; onReject: (choice: RejectChoice, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("No matching credit in the bank account");
  const [busy, setBusy] = useState<RejectChoice | null>(null);
  const time = byBank ? "1 hour" : `${windowMinutes} minutes`;
  const go = async (choice: RejectChoice) => {
    setBusy(choice);
    try {
      await onReject(choice, note.trim());
      onClose();
    } catch {
      // The page already showed why; the dialog stays open to try again.
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{`Reject UTR ${utr}?`}</DialogTitle>
          <DialogDescription>{`Order ${orderNo}. The customer sees your reason.`}</DialogDescription>
        </DialogHeader>
        <label className="text-xs font-semibold text-charcoal" htmlFor="reject-note">Reason</label>
        <Textarea id="reject-note" value={note} maxLength={200} rows={2} onChange={(e) => setNote(e.target.value)} />
        {waiting ? (
          <ul className="space-y-2 text-sm text-charcoal">
            <li className="rounded-md border border-amber-200 bg-amber-50 p-2">
              <p className="font-semibold text-amber-950">Give time to correct it</p>
              <p className="text-xs text-amber-900">{`The customer gets ${time} more to send the right UTR. The checkout and its stock stay held until then, and the timer starts again.`}</p>
            </li>
            <li className="rounded-md border border-red-200 bg-red-50 p-2">
              <p className="font-semibold text-red-900">End the checkout</p>
              <p className="text-xs text-red-800">The stock goes back on sale now and the customer is told it was not placed. Use this for a fake or test UTR.</p>
            </li>
          </ul>
        ) : (
          <p className="text-sm text-slate">This checkout has already ended: only the UTR is rejected.</p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={onClose}>Keep it</Button>
          <Button variant="outline" className="border-amber-500 text-amber-900" disabled={busy !== null} onClick={() => void go("give-time")}>
            {busy === "give-time" ? "Rejecting…" : waiting ? "Reject, give time" : "Reject"}
          </Button>
          {waiting && (
            <Button className="bg-red-600 text-white hover:bg-red-700" disabled={busy !== null} onClick={() => void go("end-checkout")}>
              {busy === "end-checkout" ? "Ending…" : "Reject and end checkout"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
