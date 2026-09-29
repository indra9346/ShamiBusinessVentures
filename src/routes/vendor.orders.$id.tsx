import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, Printer } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/vendor/orders/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Order ${params.id} | Shami Vendor Panel` },
      { name: "description", content: "Vendor order detail, items and status timeline." },
      { property: "og:title", content: `Order ${params.id} | Shami Vendor` },
      { property: "og:description", content: "Detailed vendor order view." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorOrderDetail,
  notFoundComponent: () => (
    <PanelLayout items={vendorNav} tone="vendor" title="Order Not Found" subtitle="This order does not exist">
      <Panel title="Not Found">
        <p className="text-sm text-slate">We couldn't find this order in your account. It may have been removed.</p>
        <Link to="/vendor/orders" className="mt-4 inline-block text-sm font-semibold text-gold hover:underline">
          Back to Orders
        </Link>
      </Panel>
    </PanelLayout>
  ),
});

function VendorOrderDetail() {
  const { id } = Route.useParams();
  const { updateOrderStatus } = useApp();
  const { vendorOrders, vendorId } = useVendorScope();
  const order = vendorOrders.find((o) => o.id === id);

  if (!order) {
    return (
      <PanelLayout items={vendorNav} tone="vendor" title="Order Not Found" subtitle="This order does not exist">
        <Panel title="Not Found">
          <p className="text-sm text-slate">We couldn't find order {id} for your account.</p>
          <Link to="/vendor/orders" className="mt-4 inline-block text-sm font-semibold text-gold hover:underline">
            Back to Orders
          </Link>
        </Panel>
      </PanelLayout>
    );
  }

  const myItems = order.items.filter((i) => i.vendorId === vendorId);
  const subtotal = myItems.reduce((s, i) => s + i.product.price * i.qty, 0);
  const currentIndex = orderStages.indexOf(order.status);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title={`Order ${order.id}`} subtitle={`Placed on ${order.date}`}>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Panel title="My Items">
            <div className="divide-y divide-border">
              {myItems.map((it) => (
                <div key={it.product.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <img src={it.product.image} alt={it.product.name} loading="lazy" width={800} height={800} className="h-12 w-12 rounded-md object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-navy">{it.product.name}</p>
                    <p className="text-xs text-slate">Qty {it.qty} × {inr(it.product.price)}</p>
                  </div>
                  <p className="text-sm font-bold text-navy">{inr(it.product.price * it.qty)}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-between border-t border-border pt-3 text-sm font-bold text-navy">
              <span>Vendor Subtotal</span>
              <span>{inr(subtotal)}</span>
            </div>
          </Panel>

          <Panel title="Order Timeline">
            <div className="flex flex-wrap gap-4">
              {orderStages.map((stage, i) => {
                const done = order.status !== "Cancelled" && i <= currentIndex;
                return (
                  <div key={stage} className="flex items-center gap-2">
                    {done ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <Circle className="h-4 w-4 text-slate" />
                    )}
                    <span className={cn("text-xs font-semibold", done ? "text-navy" : "text-slate")}>{stage}</span>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Customer">
            <div className="space-y-1.5 text-sm text-charcoal">
              <p className="font-semibold text-navy">{order.customer}</p>
              <p>{order.phone}</p>
              <p>{order.email}</p>
              <p>{order.address}</p>
              <p>{order.city}, {order.state} {order.pin}</p>
            </div>
          </Panel>

          <Panel title="Payment">
            <div className="space-y-2 text-sm text-charcoal">
              <div className="flex justify-between"><span>Method</span><span className="font-semibold text-navy">{order.method}</span></div>
              <div className="flex justify-between"><span>Transaction</span><span className="font-semibold text-navy">{order.txn}</span></div>
              <div className="flex justify-between"><span>Payment Status</span><StatusBadge status={order.payment} /></div>
              <div className="flex justify-between"><span>Order Status</span><StatusBadge status={order.status} /></div>
            </div>
          </Panel>

          <Panel title="Actions">
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <span className="text-xs font-semibold text-slate">Update Status</span>
                <Select
                  value={order.status}
                  onValueChange={(v) => {
                    updateOrderStatus(order.id, v as OrderStatus);
                    toast.success(`Order ${order.id} updated to ${v}`);
                  }}
                >
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...orderStages, "Cancelled"].map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => toast.success(`Packing slip for ${order.id} sent to printer`)}
              >
                <Printer className="mr-1.5 h-4 w-4" /> Print Packing Slip
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </PanelLayout>
  );
}
