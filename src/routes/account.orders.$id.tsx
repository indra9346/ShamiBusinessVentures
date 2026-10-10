import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, Download } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { accountNav } from "@/lib/account-nav";
import { canCancelOrder, inr, orderStages } from "@/lib/data";
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
import { downloadInvoice } from "@/lib/export-utils";
import { orderBelongsToUser } from "@/lib/account-identity";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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
        <Link to="/account/orders" className="mt-3 inline-block text-sm font-semibold text-gold">
          Back to Orders
        </Link>
      </Panel>
    </PanelLayout>
  ),
});

function AccountOrderDetail() {
  const { id } = Route.useParams();
  const { user, orders, updateOrderStatus, requestReturn } = useApp();
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnItemIndex, setReturnItemIndex] = useState("0");
  const [returnQuantity, setReturnQuantity] = useState("1");
  const [returnReason, setReturnReason] = useState("");
  const [returnBusy, setReturnBusy] = useState(false);
  const order = orders.find(
    (candidate) => candidate.id === id && orderBelongsToUser(candidate, user),
  );

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
          <Link to="/account/orders" className="mt-3 inline-block text-sm font-semibold text-gold">
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link to="/account/orders" className="text-sm font-semibold text-navy hover:text-gold">
          ← Back to Orders
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => downloadInvoice(order)}>
            <Download className="mr-1.5 h-4 w-4" /> Download Invoice
          </Button>
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

      <Panel title="Order Timeline">
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
                    i <= currentIdx
                      ? "border-gold bg-gold/10 text-navy"
                      : "border-border text-slate",
                  )}
                >
                  {i <= currentIdx ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-gold" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  {stage}
                </div>
                {i < orderStages.length - 1 && (
                  <div className={cn("h-0.5 w-4", i < currentIdx ? "bg-gold" : "bg-border")} />
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {order.vendorStatuses && order.vendorStatuses.length > 0 && (
        <Panel title="Vendor Shipments" className="mt-5">
          <div className="space-y-3">
            {order.vendorStatuses.map((fulfillment) => (
              <div key={fulfillment.vendorId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                <span className="text-sm font-semibold text-navy">{fulfillment.vendor}</span>
                <StatusBadge status={fulfillment.status} />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate">The overall timeline advances when all vendor shipments reach the next stage.</p>
        </Panel>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel title="Customer Details">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Name</dt>
              <dd className="font-medium text-navy">{order.customer}</dd>
            </div>
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
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Items">
          {order.items.some((item) => item.dbItemId) && order.status !== "Cancelled" && <div className="mb-4 flex justify-end"><Button variant="outline" onClick={() => setReturnOpen(true)}>Request a return</Button></div>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
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
                          src={it.product.image}
                          alt={it.product.name}
                          className="h-12 w-12 rounded-md border border-border object-cover"
                        />
                        <div>
                          <p className="font-medium text-navy">{it.product.name}</p>
                          <p className="text-xs text-slate">{it.vendor}</p>
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
            </table>
          </div>
        </Panel>
        <Panel title="Order Summary">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Subtotal</dt>
              <dd className="text-charcoal">{inr(order.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Discount{order.coupon ? ` (${order.coupon})` : ""}</dt>
              <dd className="text-danger">-{inr(order.discount)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Tax</dt>
              <dd className="text-charcoal">{inr(order.tax)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Shipping</dt>
              <dd className="text-charcoal">
                {order.shipping === 0 ? "Free" : inr(order.shipping)}
              </dd>
            </div>
            <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-bold">
              <dt className="text-navy">Total</dt>
              <dd className="text-gold">{inr(order.amount)}</dd>
            </div>
          </dl>
        </Panel>
      </div>
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}><DialogContent><DialogHeader><DialogTitle>Request a return for {order.id}</DialogTitle></DialogHeader><div className="grid gap-3"><label htmlFor="return-line">Order item</label><select id="return-line" className="h-10 rounded-md border border-border bg-background px-3" value={returnItemIndex} onChange={(e)=>{setReturnItemIndex(e.target.value);setReturnQuantity("1");}}>{order.items.map((item,index)=><option key={index} value={index} disabled={!item.dbItemId}>{item.product.name} (qty {item.qty})</option>)}</select><label htmlFor="return-qty">Quantity</label><Input id="return-qty" type="number" min="1" max={order.items[Number(returnItemIndex)]?.qty ?? 1} value={returnQuantity} onChange={(e)=>setReturnQuantity(e.target.value)}/><label htmlFor="return-reason">Reason</label><Textarea id="return-reason" value={returnReason} onChange={(e)=>setReturnReason(e.target.value)} placeholder="Describe the issue"/></div><DialogFooter><Button variant="outline" onClick={()=>setReturnOpen(false)}>Cancel</Button><Button disabled={returnBusy} className="bg-navy text-white" onClick={async()=>{const item=order.items[Number(returnItemIndex)];if(!item?.dbItemId){toast.error("This order line cannot be returned online");return;}setReturnBusy(true);const ok=await requestReturn(item.dbItemId,Number(returnQuantity),returnReason);setReturnBusy(false);if(ok){toast.success("Return request submitted");setReturnOpen(false);setReturnReason("");}}}>Submit request</Button></DialogFooter></DialogContent></Dialog>
    </PanelLayout>
  );
}
