import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Admin: delete an order that never went anywhere, or whose sales order is void in Zoho. The database decides
 * (admin_delete_order): it refuses anything paid, alive in Zoho, invoiced, given a delivery note, reviewed or
 * returned, and says why. Zoho and stock are never touched, and the delete is recorded.
 */
export function DeleteOrderDialog({ orderNo, onClose, onDeleted, voidInZoho = false }: { orderNo: string; onClose: () => void; onDeleted?: () => void; voidInZoho?: boolean }) {
  const { forgetOrder } = useApp();
  // undefined while checking, null when it may be deleted, otherwise the reason it stays.
  const [blocker, setBlocker] = useState<string | null | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (STATIC_DATA_MODE) { setBlocker(null); return; }
    void supabase.rpc("order_delete_blocker", { _order_no: orderNo }).then(({ data, error }) => {
      if (live) setBlocker(error ? error.message : (data ?? null));
    });
    return () => { live = false; };
  }, [orderNo]);
  const remove = async () => {
    setBusy(true);
    if (!STATIC_DATA_MODE) {
      const { error } = await supabase.rpc("admin_delete_order", { _order_no: orderNo, _reason: reason.trim() });
      if (error) {
        setBusy(false);
        toast.error("Could not delete the order", { description: error.message });
        return;
      }
    }
    setBusy(false);
    forgetOrder(orderNo);
    toast.success(`Order ${orderNo} deleted`, { description: "Nothing changed in Zoho or in stock. A record of the delete is kept." });
    onClose();
    onDeleted?.();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Delete order ${orderNo}?`}</DialogTitle>
          <DialogDescription>
            {blocker === undefined
              ? "Checking whether it can be deleted…"
              : blocker
                ? blocker
                : voidInZoho
                  ? "Its sales order is void in Zoho and nothing was paid here. Deleting removes the order and its items from this website for good. The void sales order stays in Zoho on record, stock is not touched, and a record of who deleted it is kept."
                  : "Nothing was paid, sent to Zoho or delivered. Deleting removes the order and its items for good. Zoho and stock are not touched, and a record of who deleted it is kept."}
          </DialogDescription>
        </DialogHeader>
        {blocker === null && (
          <Textarea rows={2} maxLength={300} className="bg-white text-base sm:text-sm" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)} />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          {blocker === null && (
            <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete order"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The button for an order's own page; it leaves for the order list once the order is gone. */
export function DeleteOrderButton({ orderNo, voidInZoho = false }: { orderNo: string; voidInZoho?: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button variant="outline" size="sm" className="text-danger hover:border-danger" onClick={() => setOpen(true)}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete order
      </Button>
      {open && <DeleteOrderDialog orderNo={orderNo} voidInZoho={voidInZoho} onClose={() => setOpen(false)} onDeleted={() => void navigate({ to: "/admin/orders" })} />}
    </>
  );
}
