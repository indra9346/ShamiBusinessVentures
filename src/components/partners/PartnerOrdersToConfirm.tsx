import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileText, Loader2, RefreshCw } from "lucide-react";
import { ALL_SORTS, SortBy, sortRows, useSortKey } from "@/components/panel/SortBy";
import { Panel } from "@/components/panel/widgets";
import { useLiveRefresh } from "@/components/partners/PartnerWidgets";
import { InvoicePreviewDialog } from "@/components/site/InvoicePreviewDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise, type Order } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import type { InvoiceFacts } from "@/lib/invoice-lines";
import { partnerInvoiceOrder, paymentLabel } from "@/lib/partner-invoices";
import {
  PARTNER_CONFIRM_WORDS, confirmQuestion, confirmedNote, partnerOrderInvoice, partnerOrderRows, rowConfirmState, type PartnerOrderRow,
} from "@/lib/partner-confirm";
import { TONE_CLASSES } from "@/lib/order-status-tone";
import { dayLabel, preorderText } from "@/lib/preorder";
import { pushOrderToZohoInBackground } from "@/lib/store";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Channel partner (owner, 13 Nov 2026: "Channel partner need option to confirm the order & get invoice also"): their own
 * godown's orders waiting to be confirmed, with Confirm order on each one whose payment our office has settled in full,
 * and the order's invoice to view, print or download once it is made. The database decides again on every confirm
 * (partner_confirm_order); payments stay with the office.
 */
export function PartnerOrdersToConfirm() {
  const [rows, setRows] = useState<PartnerOrderRow[] | null>(null);
  const [failed, setFailed] = useState("");
  const [loading, setLoading] = useState(false);
  const [asking, setAsking] = useState<PartnerOrderRow | null>(null);
  const [confirming, setConfirming] = useState("");
  const [opening, setOpening] = useState("");
  const [shown, setShown] = useState<{ order: Order; facts: InvoiceFacts } | null>(null);
  // Orders whose goods are still on a pre-order (review fix): their invoice and pickup QR come when the goods arrive.
  const [goodsWaiting, setGoodsWaiting] = useState<Map<string, string | null>>(new Map());
  // Sort by (client, 16 Nov 2026).
  const [sort, setSort] = useSortKey("partner-orders", ALL_SORTS);

  const load = async () => {
    if (STATIC_DATA_MODE) { setRows([]); return; }
    setLoading(true);
    try {
      const [{ data, error }, waitingGoods] = await Promise.all([
        supabase.rpc("partner_orders_to_confirm"),
        supabase.rpc("partner_orders_waiting_goods"),
      ]);
      if (error) throw new Error(error.message);
      setRows(partnerOrderRows(data));
      // Before the pre-order release the function is not there: nothing waits then.
      setGoodsWaiting(new Map((waitingGoods.error ? [] : waitingGoods.data ?? []).map((row) => [row.order_no, row.expected_date])));
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not load the orders");
    } finally {
      setLoading(false);
    }
  };
  useLiveRefresh(load, []);

  const confirm = async (row: PartnerOrderRow) => {
    setConfirming(row.order_no);
    try {
      const { data, error } = await supabase.rpc("partner_confirm_order", { _order_no: row.order_no });
      if (error) throw new Error(error.message);
      const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      if (result["already"] === true) {
        toast.info(`Order ${row.order_no} was already confirmed`);
      } else {
        toast.success(`Order ${row.order_no} confirmed`, { description: confirmedNote(row.order_status) });
        // The same instant Zoho push an admin's confirm makes; the queue sends it anyway if this one cannot.
        pushOrderToZohoInBackground(row.order_no);
      }
      setAsking(null);
      await load();
    } catch (cause) {
      toast.error("Could not confirm the order", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setConfirming("");
    }
  };

  const openInvoice = async (orderNo: string) => {
    setOpening(orderNo);
    try {
      const { data, error } = await supabase.rpc("partner_invoice_order", { _order_no: orderNo });
      if (error) throw new Error(error.message);
      setShown(partnerInvoiceOrder(data));
    } catch (cause) {
      toast.error("Could not open the invoice", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setOpening("");
    }
  };

  const sorted = sortRows(rows ?? [], sort, (row) => ({ when: row.placed_at, amount: row.total, customer: row.customer, orderNo: row.order_no }));
  const waiting = sorted.filter((row) => rowConfirmState(row) !== "confirmed");
  const confirmed = sorted.filter((row) => rowConfirmState(row) === "confirmed");

  const item = (row: PartnerOrderRow) => {
    const state = rowConfirmState(row);
    const invoice = partnerOrderInvoice(row);
    return (
      // The order colours (11 Nov 2026): waiting for this partner's confirm yellow (a Payment Confirmed order too), confirmed green.
      <li key={row.order_no} className={cn("rounded-lg border p-3", TONE_CLASSES[state === "confirmed" ? "confirmed" : "pending"].tile)}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-all font-mono text-xs font-semibold text-navy">{row.order_no}</p>
            <p className="text-xs text-slate"><span>{row.customer}</span> · <span>{when(row.placed_at)}</span> · <span>{row.order_status}</span></p>
            {row.items && <p className="text-[11px] text-slate">{row.items}</p>}
            {goodsWaiting.has(row.order_no) && (
              <p className="mt-0.5 text-[11px] font-semibold text-amber-800">
                <span>{preorderText.partnerInvoiceLater}</span>
                {goodsWaiting.get(row.order_no) && <span> · {preorderText.waiting(dayLabel(goodsWaiting.get(row.order_no)))}</span>}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="font-bold tabular-nums text-navy">{inrPrecise(row.total)}</p>
            <p className="text-[11px] font-semibold text-charcoal">
              {paymentLabel(row.payment_status) === "Paid" ? "Paid in full" : `${paymentLabel(row.payment_status)} · ${inrPrecise(row.paid_amount)} paid`}
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className={cn("min-w-0 text-xs", state === "ready" ? "font-semibold text-emerald-900" : state === "confirmed" ? "font-semibold text-emerald-900" : "text-amber-900")}>
            {state === "confirmed" && row.confirmed_at ? `Confirmed ${when(row.confirmed_at)}` : PARTNER_CONFIRM_WORDS[state]}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {state === "ready" && (
              <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={confirming === row.order_no} onClick={() => setAsking(row)}>
                <CheckCircle2 className="mr-1.5 h-4 w-4" />Confirm order
              </Button>
            )}
            {invoice.open ? (
              <Button size="sm" variant="outline" disabled={opening === row.order_no} onClick={() => void openInvoice(row.order_no)}>
                <FileText className="mr-1.5 h-4 w-4" />{opening === row.order_no ? "Opening…" : "Invoice"}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-[11px] text-slate">{invoice.words}</p>
      </li>
    );
  };

  return (
    <Panel id="orders-to-confirm" title="Orders to confirm"
      action={(
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-2.5 text-xs text-navy hover:border-gold">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />Refresh
        </button>
      )}>
      <p className="mb-3 text-xs text-slate">Paid orders of your godown wait here for you to confirm them, as our office does. A payment is approved first, by our office or, when our office allows it, by you under Customer payments. Open an order's invoice here or under Customer invoices to view, print or download it.</p>
      {failed ? <p className="text-sm text-danger">{failed}</p>
        : !rows ? <p className="flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : !rows.length ? <p className="text-sm text-slate">No orders are waiting to be confirmed.</p>
        : (
          <div className="space-y-4">
            <SortBy value={sort} onChange={setSort} keys={ALL_SORTS} />
            {waiting.length > 0 && <ul className="space-y-3">{waiting.map(item)}</ul>}
            {confirmed.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold text-navy">Confirmed in the last 3 days</p>
                <ul className="space-y-3">{confirmed.map(item)}</ul>
              </div>
            )}
          </div>
        )}

      <Dialog open={!!asking} onOpenChange={(open) => { if (!open && !confirming) setAsking(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm this order?</DialogTitle>
            <DialogDescription>{asking ? confirmQuestion(asking.order_no, asking.order_status) : ""}</DialogDescription>
          </DialogHeader>
          {asking && (
            <p className="text-sm text-charcoal">{asking.customer} · {inrPrecise(asking.total)} · {asking.items}</p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!!confirming} onClick={() => setAsking(null)}>Not now</Button>
            <Button className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={!!confirming || !asking} onClick={() => asking && void confirm(asking)}>
              {confirming ? "Confirming…" : "Confirm order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {shown && (
        <InvoicePreviewDialog order={shown.order} facts={shown.facts} open onOpenChange={(next) => { if (!next) setShown(null); }} />
      )}
    </Panel>
  );
}
