import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, QrCode, RefreshCw } from "lucide-react";
import { renderSVG } from "uqr";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { canCancelOrder, inr, inrPrecise, orderStages, type Order } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { invoiceDelivery, issuedZohoNumber, type InvoiceDelivery, type ZohoInvoiceCopy } from "@/lib/invoice-lines";
import { customerInvoiceVisible, invoiceStage, invoiceStageTone } from "@/lib/invoice-visibility";
import { orderToneClass, TONE_CLASSES } from "@/lib/order-status-tone";
import { deliveryQrLink, deliveryQrOrigin } from "@/lib/pdf-qr";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { orderBelongsToUser } from "@/lib/account-identity";
import { useZohoContactNumbers } from "@/hooks/use-zoho-contact-numbers";
import { PickupPointCard } from "@/components/site/PickupPointCard";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InvoicePreviewButton } from "@/components/site/InvoicePreviewDialog";
import { ResizableTable } from "@/hooks/use-column-resize";
import { ZohoInvoiceStatus } from "@/components/panel/ZohoInvoiceStatus";
import { OrderUpiPay } from "@/components/site/UpiPayPanel";
import { PartPaymentNotice } from "@/components/site/PartPaymentNotice";
import { HeldCheckoutPay } from "@/components/site/HeldCheckoutPay";
import { useUpiPayments } from "@/lib/upi-store";
import { resizedImage } from "@/lib/image-url";
import { ItemBatchCodes, useOrderItemBatches } from "@/components/batches/OrderItemBatches";
import { PAYMENT_EXPIRED } from "@/lib/payment-hold";
import { isBankMethod } from "@/lib/payment-rules";

export const Route = createFileRoute("/account/orders/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Order ${params.id} | Shami Business Ventures` },
      { name: "description", content: `Full detail and status timeline for order ${params.id}.` },
      { property: "og:title", content: `Order ${params.id} | Shami` },
      { property: "og:description", content: "Order detail, items, payment and timeline." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountOrderDetail,
  notFoundComponent: () => (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title="Order Not Found"
      subtitle="We could not find this order"
    >
      <Panel title="404">
        <p className="text-sm text-slate">The order you are looking for does not exist.</p>
        <Link to="/account/orders" search={true} className="mt-3 inline-block text-sm font-semibold text-gold">
          Back to Orders
        </Link>
      </Panel>
    </PanelLayout>
  ),
});

function AccountOrderDetail() {
  const { id } = Route.useParams();
  const { returns, user, orders, updateOrderStatus, requestReturn, paymentHolds, ordersLoaded } = useApp();
  const { settings: upiSettings } = useUpiPayments();
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnItemIndex, setReturnItemIndex] = useState("0");
  const [returnQuantity, setReturnQuantity] = useState("1");
  const [returnReason, setReturnReason] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  const order = orders.find(
    (candidate) => candidate.id === id && orderBelongsToUser(candidate, user),
  );
  const itemBatches = useOrderItemBatches(order?.dbOrderId, order?.items.map((item) => `${item.dbItemId}:${item.qty}:${order.status}`).join(",") ?? "");
  // The customer number Zoho gave this account (the order is the signed-in customer's own).
  const customerNumber = useZohoContactNumbers(user?.id).customers.get(order?.customerId || (user?.id ?? ""));

  // A checkout waiting for payment is not an order yet: show its payment screen.
  const hold = order ? undefined : paymentHolds.find((candidate) => candidate.orderNo === id);
  if (!order && hold) {
    return (
      <PanelLayout items={accountNav} tone="customer" title={hold.orderNo} subtitle={hold.status === PAYMENT_EXPIRED ? "Not placed" : "Waiting for payment"}>
        <div className="mb-4">
          <Link to="/account/orders" search={true} className="text-sm font-semibold text-navy hover:text-gold">← Back to Orders</Link>
        </div>
        <HeldCheckoutPay key={hold.orderNo} settings={upiSettings} method={hold.method} orderNo={hold.orderNo} amount={hold.amount} holdUntil={hold.holdUntil} customer={user?.name ?? ""} />
      </PanelLayout>
    );
  }

  // A page reload: orders and checkouts are still being read.
  if (!order && !ordersLoaded) {
    return (
      <PanelLayout items={accountNav} tone="customer" title={id} subtitle="Loading your order…">
        <p className="text-sm text-slate">Loading your order…</p>
      </PanelLayout>
    );
  }

  if (!order) {
    return (
      <PanelLayout
        items={accountNav}
        tone="customer"
        title="Order Not Found"
        subtitle="We could not find this order"
      >
        <Panel title="404">
          <p className="text-sm text-slate">Order id "{id}" was not found.</p>
          <Link to="/account/orders" search={true} className="mt-3 inline-block text-sm font-semibold text-gold">
            Back to Orders
          </Link>
        </Panel>
      </PanelLayout>
    );
  }

  const isCancelled = order.status === "Cancelled";
  const canCancel = canCancelOrder(order, "customer");
  const currentIdx = orderStages.indexOf(order.status);

  return (
    <PanelLayout
      items={accountNav}
      tone="customer"
      title={order.id}
      subtitle={`Placed on ${order.date}`}
    >
      <PartPaymentNotice orderNo={order.id} total={order.amount} paid={order.paidAmount ?? 0} paymentStatus={order.payment} orderStatus={order.status}>
        <OrderUpiPay orderNo={order.id} status={order.status} payment={order.payment} method={order.method}
          balance={Math.max(0, order.amount - (order.paidAmount ?? 0))} customer={order.customer} />
      </PartPaymentNotice>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/account/orders" search={true} className="text-sm font-semibold text-navy hover:text-gold">
          ← Back to Orders
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {/* The invoice now lives in the "Invoice and delivery QR" panel below, with its QR. */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                disabled={!canCancel}
                title={!canCancel && ((order.paidAmount ?? 0) > 0 || order.payment === "Paid" || order.payment === "Partially Paid")
                  ? "A verified refund must be completed before cancellation."
                  : undefined}
              >
                Cancel Order
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel order {order.id}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {canCancel
                    ? "This will mark the order as cancelled and restore its available inventory."
                    : order.vendorStatuses?.some((fulfillment) => !["Placed", "Payment Confirmed", "Cancelled"].includes(fulfillment.status))
                      ? "A vendor has started fulfilment. Contact support if you need help cancelling this order."
                      : "Paid orders cannot be cancelled until a verified refund is completed. Contact support if you need help."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Back</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    if (await updateOrderStatus(order.id, "Cancelled")) toast.success(`Order ${order.id} cancelled`);
                  }}
                >
                  Confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Tinted by status in every portal (owner, 11 Nov 2026): pending yellow, confirmed green, cancelled red. */}
      <Panel title="Order Timeline" className={orderToneClass(order.status, "tile")}>
        {isCancelled ? (
          <div className="flex items-center gap-2 text-danger">
            <StatusBadge status="Cancelled" />
            <p className="text-sm">
              This order was cancelled and is no longer progressing through the fulfilment stages.
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {orderStages.map((stage, i) => (
              <div key={stage} className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
                    // Stages already done are green, like a confirmed order; the rest wait on white.
                    i <= currentIdx
                      ? "border-emerald-600/45 bg-emerald-400/25 text-emerald-950"
                      : "border-border bg-white/70 text-slate",
                  )}
                >
                  {i <= currentIdx ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  {stage}
                </div>
                {i < orderStages.length - 1 && (
                  <div className={cn("h-0.5 w-4", i < currentIdx ? "bg-emerald-600/60" : "bg-border")} />
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <InvoiceDeliveryPanel order={order} />

      {order.vendorStatuses && order.vendorStatuses.length > 1 && (
        <Panel title="Shipments" className="mt-5">
          <div className="space-y-3">
            {order.vendorStatuses.map((fulfillment, index) => (
              <div key={fulfillment.vendorId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <span className="text-sm font-semibold text-navy">Shipment {index + 1}</span>
                <StatusBadge status={fulfillment.status} />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate">The overall timeline advances when every shipment reaches the next stage.</p>
        </Panel>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel title="Customer Details">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Name</dt>
              <dd className="font-medium text-navy">{order.customer}</dd>
            </div>
            {customerNumber && (
              <div className="flex justify-between">
                <dt className="text-slate">Customer No.</dt>
                <dd data-no-translate className="font-mono font-semibold text-navy">{customerNumber}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-slate">Email</dt>
              <dd className="font-medium text-navy">{order.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Phone</dt>
              <dd className="font-medium text-navy">{order.phone}</dd>
            </div>
          </dl>
        </Panel>
        <Panel title="Shipping Address">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Address</dt>
              <dd className="max-w-[60%] text-right font-medium text-navy">{order.address}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">City</dt>
              <dd className="font-medium text-navy">{order.city}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">State</dt>
              <dd className="font-medium text-navy">{order.state}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">PIN</dt>
              <dd className="font-medium text-navy">{order.pin}</dd>
            </div>
          </dl>
          <PickupPointCard pin={order.pin} heading="Collect this order from" className="mt-4" />
        </Panel>
        <Panel title="Payment">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Transaction</dt>
              <dd className="font-medium text-navy">{order.txn}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Method</dt>
              <dd className="font-medium text-navy">{order.method}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Status</dt>
              <dd>
                <StatusBadge status={order.payment} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Date</dt>
              <dd className="font-medium text-navy">{order.date}</dd>
            </div>
          </dl>
          <ZohoInvoiceStatus orderNo={order.id} audience="customer" className="mt-3" />
          {returns.filter((item) => item.order === order.id).map((item) => (
            <p key={item.id} className="mt-3 rounded-md bg-ivory px-3 py-2 text-xs text-navy">
              <span className="font-semibold">Return: {item.product}</span> · {item.status} · Refund {item.refund} · {inrPrecise(item.amount)}
            </p>
          ))}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Items">
          {order.items.some((item) => item.dbItemId) && order.status === "Delivered" && <div className="mb-4 flex justify-end"><Button variant="outline" onClick={() => setReturnOpen(true)}>Request a return</Button></div>}
          <div className="overflow-x-auto">
            <ResizableTable tableId="account-order-lines" className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-bold tracking-wider text-slate uppercase">
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3">SKU</th>
                  <th className="px-3 py-3">Qty</th>
                  <th className="px-3 py-3">Price</th>
                  <th className="px-3 py-3">Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it, i) => (
                  <tr key={i} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <img
                          src={resizedImage(it.product.image, 128)}
                          alt={it.product.name}
                          className="h-12 w-12 rounded-md border border-border object-cover"
                        />
                        <div>
                          <p className="font-medium text-navy">{it.product.name}</p>
                          <p className="text-xs text-slate">Qty {it.qty}</p>
                          <ItemBatchCodes batches={it.dbItemId ? itemBatches.get(it.dbItemId) : undefined} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-charcoal">{it.product.sku}</td>
                    <td className="px-3 py-3 text-charcoal">{it.qty}</td>
                    <td className="px-3 py-3 text-charcoal">{inr(it.product.price)}</td>
                    <td className="px-3 py-3 font-semibold text-navy">
                      {inr(it.product.price * it.qty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        </Panel>
        <Panel title="Order Summary">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Subtotal (before GST)</dt>
              <dd className="text-charcoal">{inrPrecise(order.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Discount{order.coupon ? ` (${order.coupon})` : ""}</dt>
              <dd className="text-danger">-{inrPrecise(order.discount)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">GST</dt>
              <dd className="text-charcoal">{inrPrecise(order.tax)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Shipping</dt>
              <dd className="text-charcoal">
                {order.shipping === 0 ? "Free" : inrPrecise(order.shipping)}
              </dd>
            </div>
            <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-bold">
              <dt className="text-navy">Total</dt>
              <dd className="text-gold">{inrPrecise(order.amount)}</dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}><DialogContent><DialogHeader><DialogTitle>Request a return for {order.id}</DialogTitle></DialogHeader><div className="grid gap-3"><label htmlFor="return-line">Order item</label><select id="return-line" className="h-10 rounded-md border border-border bg-background px-3" value={returnItemIndex} onChange={(e)=>{setReturnItemIndex(e.target.value);setReturnQuantity("1");}}>{order.items.map((item,index)=><option key={index} value={index} disabled={!item.dbItemId}>{item.product.name} (qty {item.qty})</option>)}</select><label htmlFor="return-qty">Quantity</label><Input id="return-qty" type="number" min="1" max={order.items[Number(returnItemIndex)]?.qty ?? 1} value={returnQuantity} onChange={(e)=>setReturnQuantity(e.target.value)}/><label htmlFor="return-reason">Reason</label><Textarea id="return-reason" value={returnReason} onChange={(e)=>setReturnReason(e.target.value)} placeholder="Describe the issue"/></div><DialogFooter><Button variant="outline" onClick={()=>setReturnOpen(false)}>Cancel</Button><Button disabled={returnBusy} className="bg-navy text-white" onClick={async()=>{const item=order.items[Number(returnItemIndex)];if(!item?.dbItemId){toast.error("This order line cannot be returned online");return;}setReturnBusy(true);const ok=await requestReturn(item.dbItemId,Number(returnQuantity),returnReason);setReturnBusy(false);if(ok){toast.success("Return request submitted");setReturnOpen(false);setReturnReason("");}}}>Submit request</Button></DialogFooter></DialogContent></Dialog>
    </PanelLayout>
  );
}

const releasedLabel = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

type InvoiceDeliveryFacts = { zohoNumber: string | null; delivery: InvoiceDelivery | null; failed: boolean };

/**
 * The order's invoice and delivery QR (owner, 11 Nov 2026): it shows here on its own once the order is paid in full and
 * the office has confirmed it, the same rule as the Invoices page and the channel partner's list. The QR is the one
 * printed on the invoice: the godown in-charge scans it to release and hand over the goods. It is asked of the database
 * each time this page opens or comes back into view, never kept in the browser, so a QR the office replaced never shows.
 */
function InvoiceDeliveryPanel({ order }: { order: Order }) {
  const visible = customerInvoiceVisible({ orderStatus: order.status, payment: order.payment });
  const stage = invoiceStage({ orderStatus: order.status, payment: order.payment });
  const tone = invoiceStageTone(stage);
  const [facts, setFacts] = useState<InvoiceDeliveryFacts | null>(null);
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (!visible) return;
    if (STATIC_DATA_MODE) {
      setFacts({ zohoNumber: null, delivery: null, failed: false });
      return;
    }
    let active = true;
    void Promise.all([
      supabase.from("zoho_order_invoices").select("invoice_number,status").eq("order_no", order.id).maybeSingle(),
      supabase.rpc("invoice_delivery_code", { _order_no: order.id }),
    ]).then(([zoho, code]) => {
      if (!active) return;
      setFacts({ zohoNumber: issuedZohoNumber(zoho.data as ZohoInvoiceCopy | null), delivery: code.error ? null : invoiceDelivery(code.data), failed: Boolean(code.error) });
    }).catch(() => {
      if (active) setFacts({ zohoNumber: null, delivery: null, failed: true });
    });
    return () => { active = false; };
  }, [visible, order.id, order.status, reads]);

  // Back from the godown counter: the note's release and the handover show without a reload.
  useEffect(() => {
    if (!visible) return;
    const onFocus = () => setReads((count) => count + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible]);

  const code = facts?.delivery?.code ?? null;
  const qrSvg = useMemo(() => {
    if (!code || typeof window === "undefined") return "";
    return renderSVG(deliveryQrLink(deliveryQrOrigin(window.location.hostname, window.location.origin), code), { ecc: "M", border: 4 });
  }, [code]);

  return (
    <Panel title="Invoice and delivery QR" className={cn("mt-5", TONE_CLASSES[tone].tile)}>
      {stage === "cancelled" ? (
        <p className={cn("text-sm font-semibold", TONE_CLASSES.closed.text)}>This order was cancelled, so it has no invoice or delivery QR.</p>
      ) : stage === "refunded" ? (
        <p className={cn("text-sm font-semibold", TONE_CLASSES.closed.text)}>This order's payment was refunded, so it has no delivery QR.</p>
      ) : !visible ? (
        <div className={cn("space-y-1 text-sm", TONE_CLASSES.pending.text)}>
          <p className="font-semibold">Your invoice and delivery QR appear here once your payment is confirmed.</p>
          {stage === "awaiting_confirmation" && <p className="text-xs">We have your payment. Our team is confirming your order.</p>}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-base font-bold text-navy">{facts?.zohoNumber ? `Invoice ${facts.zohoNumber}` : "Tax invoice"}</p>
              {facts && !facts.zohoNumber && <p className="text-xs text-slate">Your tax invoice is being issued by Zoho Books. It appears here shortly.</p>}
            </div>
            {/* Only the tax invoice: until Zoho issues it, a download would be a proforma without the delivery QR. */}
            {facts?.zohoNumber && <InvoicePreviewButton order={order} label="View / Download Invoice" />}
            {facts?.failed ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-danger">
                <span>Could not load your delivery QR.</span>
                <Button variant="outline" size="sm" onClick={() => setReads((count) => count + 1)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
                </Button>
              </div>
            ) : code ? (
              <div className={cn("space-y-1 text-sm", TONE_CLASSES.confirmed.text)}>
                {order.status === "Delivered" ? <p className="font-semibold">All your goods were handed over.</p>
                  : facts?.delivery?.releasedAt ? (
                    <p className="font-semibold">
                      {facts.delivery.noteNo
                        ? `Delivery note ${facts.delivery.noteNo} released on ${releasedLabel(facts.delivery.releasedAt)}.`
                        : `Delivery note released on ${releasedLabel(facts.delivery.releasedAt)}.`}
                    </p>
                  )
                  : <p className="font-semibold">Delivery note not released yet. The godown in-charge releases it when they scan your QR.</p>}
                <p className="text-xs text-charcoal">The same QR is printed on your invoice. Keep it private: show it only at the godown counter.</p>
              </div>
            ) : facts ? (
              <p className="text-sm text-charcoal">Your delivery QR appears here once Zoho Books shows your paid invoice. Please check again in a little while.</p>
            ) : null}
          </div>
          <div className="mx-auto w-full max-w-[220px]">
            {qrSvg ? (
              <div className="rounded-lg border border-emerald-600/35 bg-white p-2" role="img" aria-label={`Delivery QR for order ${order.id}`}
                // uqr returns a self-contained <svg> of the QR code (no scripts).
                dangerouslySetInnerHTML={{ __html: qrSvg }} />
            ) : (
              <div className="grid aspect-square place-items-center rounded-lg border border-dashed border-emerald-600/35 bg-white/70 p-3 text-center text-xs text-slate">
                <span className="grid justify-items-center gap-1.5"><QrCode className="h-8 w-8" />{facts === null ? "Loading your delivery QR…" : "No QR yet"}</span>
              </div>
            )}
            <p className="mt-2 text-center text-xs font-semibold text-navy">Show this QR at the godown counter. The godown in-charge scans it and hands over your goods.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
