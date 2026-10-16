import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  Building2,
  CheckCircle2,
  Circle,
  CreditCard,
  ExternalLink,
  FileText,
  MapPin,
  Minus,
  Package,
  Printer,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Truck,
  UploadCloud,
  User,
} from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { canCancelOrder, inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp } from "@/lib/store";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { syncSingleOrderToZoho } from "@/lib/zoho-commerce.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export const Route = createFileRoute("/admin/orders/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Order ${params.id} | Shami Business Ventures Admin` },
      { name: "description", content: `Full detail and status timeline for order ${params.id}.` },
      { property: "og:title", content: `Order ${params.id} | Shami Admin` },
      {
        property: "og:description",
        content: "Order detail, customer GST, items, payment and vendor information.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminOrderDetail,
  notFoundComponent: () => (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Order Not Found"
      subtitle="We could not find this order"
    >
      <Panel title="404">
        <p className="text-sm text-slate">The order you are looking for does not exist.</p>
        <Link to="/admin/orders" className="mt-3 inline-block text-sm font-semibold text-gold">
          Back to Orders
        </Link>
      </Panel>
    </PanelLayout>
  ),
});

function AdminOrderDetail() {
  const { id } = Route.useParams();
  const {
    orders,
    customers,
    vendors,
    batches,
    getFIFOCost,
    updateOrderStatus,
    updateOrderItem,
    updateOrderDelivery,
  } = useApp();
  const order = orders.find((o) => o.id === id);
  // Hooks stay above the early return: orders load after the first render.
  const [pushedZohoId, setPushedZohoId] = useState<string | null>(null);
  const [syncingZoho, setSyncingZoho] = useState(false);

  if (!order) {
    return (
      <PanelLayout
        items={adminNav}
        tone="admin"
        title="Order Not Found"
        subtitle="We could not find this order"
      >
        <Panel title="404">
          <p className="text-sm text-slate">Order id "{id}" was not found.</p>
          <Link to="/admin/orders" className="mt-3 inline-block text-sm font-semibold text-gold">
            Back to Orders
          </Link>
        </Panel>
      </PanelLayout>
    );
  }

  const isCancelled = order.status === "Cancelled";
  const canCancel = canCancelOrder(order, "admin");
  const hasUnrefundedPayment = (order.paidAmount ?? 0) > 0 || order.payment === "Paid" || order.payment === "Partially Paid";
  const canEditItems = !isCancelled && (STATIC_DATA_MODE || (
    order.status === "Placed" && order.payment === "Pending" &&
    (order.paidAmount ?? 0) === 0 && (order.discount ?? 0) === 0 && !order.coupon
  ));
  const currentIdx = orderStages.indexOf(order.status);

  // Retrieve customer details including GSTIN
  const matchedCustomer = customers.find(
    (c) => c.id === order.customerId || c.name === order.customer || c.email === order.email,
  );
  const customerGstin = order.gstin || matchedCustomer?.gst || "29AAACB2026D1Z5";

  // Retrieve vendor records involved in this order
  const orderVendors = vendors.filter((v) =>
    order.items.some((i) => i.vendorId === v.id || i.vendor === v.business),
  );

  const zohoSalesOrderId = pushedZohoId ?? (order.zohoSalesOrderId || null);

  const handleSyncToZoho = async () => {
    setSyncingZoho(true);
    try {
      const res = await syncSingleOrderToZoho({ data: { orderNo: order.id } });
      if (res.zohoSalesOrderId) {
        setPushedZohoId(res.zohoSalesOrderId);
        toast.success(`Order synced to Zoho Sales Order ${res.zohoSalesOrderId}!`);
      } else {
        toast.success("Order sync job queued for Zoho Commerce");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sync order to Zoho");
    } finally {
      setSyncingZoho(false);
    }
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title={order.id}
      subtitle={`Placed on ${order.date}`}
    >
      {/* Top Header Actions */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/admin/orders" className="text-sm font-semibold text-navy hover:text-gold">
            ← Back to Orders
          </Link>
          <span className="text-slate/40">|</span>
          <span className="font-mono text-xs font-semibold text-slate">TXN: {order.txn}</span>
          {zohoSalesOrderId && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
              <Building2 className="h-3 w-3" /> Zoho: {zohoSalesOrderId}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={syncingZoho}
            onClick={() => void handleSyncToZoho()}
            className="border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 font-semibold"
            title="Immediately synchronize this order with Zoho Commerce / Inventory"
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncingZoho ? "animate-spin" : ""}`} />
            {syncingZoho ? "Syncing to Zoho…" : zohoSalesOrderId ? "Re-sync to Zoho" : "Push to Zoho"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            className="text-slate hover:text-navy"
          >
            <Printer className="mr-1.5 h-3.5 w-3.5" /> Print Details
          </Button>

          <Select
            value={order.status}
            disabled={isCancelled}
            onValueChange={async (v) => {
              if (await updateOrderStatus(order.id, v as OrderStatus)) toast.success(`Order ${order.id} updated to ${v}`);
            }}
          >
            <SelectTrigger className="h-9 w-44 font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orderStages.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
              {isCancelled && <SelectItem value="Cancelled">Cancelled</SelectItem>}
            </SelectContent>
          </Select>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={!canCancel}
                className="text-danger hover:border-danger"
              >
                Cancel Order
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel order {order.id}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {canCancel
                    ? "This will mark the order as cancelled, stop fulfilment, and restore its available inventory."
                    : hasUnrefundedPayment
                      ? "Paid orders cannot be cancelled until a verified refund is completed. Refund processing is not configured yet."
                      : order.vendorStatuses?.some((fulfillment) => ["Dispatched", "Out for Delivery", "Delivered"].includes(fulfillment.status))
                        ? "Orders cannot be cancelled after any vendor has dispatched."
                        : "A vendor has already started fulfilment."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Back</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    if (await updateOrderStatus(order.id, "Cancelled")) toast.success(`Order ${order.id} cancelled`);
                  }}
                  className="bg-danger text-white hover:bg-danger/90"
                >
                  Confirm Cancellation
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* WHAT'S NEXT Action Banner (matching Zoho Commerce) */}
      {!isCancelled && order.status !== "Delivered" && (
        <div className="mb-5 flex flex-col gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-5 w-5 text-emerald-700 shrink-0" />
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-900">What's Next?</p>
              <p className="text-sm font-medium text-navy">
                {order.status === "Placed"
                  ? "You can either confirm or cancel this order."
                  : order.status === "Payment Confirmed" || order.status === "Accepted"
                  ? "Order is confirmed. Prepare and pack items for fulfillment."
                  : order.status === "Packed"
                  ? "Package is ready. Hand over to delivery carrier or customer pickup."
                  : order.status === "Dispatched" || order.status === "Out for Delivery"
                  ? "Order is in transit. Awaiting customer receipt confirmation."
                  : "Review order settlement and customer rating."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {order.status === "Placed" && (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm"
                onClick={async () => {
                  if (await updateOrderStatus(order.id, "Accepted")) {
                    toast.success(`Order ${order.id} marked as Confirmed`);
                  }
                }}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Mark as Confirmed
              </Button>
            )}
            {(order.status === "Payment Confirmed" || order.status === "Accepted") && (
              <Button
                size="sm"
                className="bg-navy hover:bg-navy/90 text-white font-semibold shadow-sm"
                onClick={async () => {
                  if (await updateOrderStatus(order.id, "Packed")) {
                    toast.success(`Order ${order.id} marked as Packed`);
                  }
                }}
              >
                <Package className="mr-1.5 h-4 w-4" /> Mark as Packed
              </Button>
            )}
            {order.status === "Packed" && (
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-sm"
                onClick={async () => {
                  if (await updateOrderStatus(order.id, "Out for Delivery")) {
                    toast.success(`Order ${order.id} marked Out for Delivery`);
                  }
                }}
              >
                <Truck className="mr-1.5 h-4 w-4" /> Out for Delivery
              </Button>
            )}
            {(order.status === "Dispatched" || order.status === "Out for Delivery") && (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm"
                onClick={async () => {
                  if (await updateOrderStatus(order.id, "Delivered")) {
                    toast.success(`Order ${order.id} marked Delivered`);
                  }
                }}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Mark Delivered
              </Button>
            )}
            {canCancel && (
              <Button
                variant="outline"
                size="sm"
                className="border-rose-300 text-rose-700 hover:bg-rose-50"
                onClick={async () => {
                  if (await updateOrderStatus(order.id, "Cancelled")) {
                    toast.success(`Order ${order.id} cancelled`);
                  }
                }}
              >
                Cancel Order
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Zoho Integration Status Ribbon */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate">Zoho Commerce / Inventory Integration</span>
              {zohoSalesOrderId ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="h-3 w-3" /> Synced: {zohoSalesOrderId}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  <Circle className="h-3 w-3" /> Ready for Write Sync
                </span>
              )}
            </div>
            <p className="text-xs text-slate mt-0.5">
              {zohoSalesOrderId
                ? `Order is synchronized with Zoho Head Office under Sales Order ${zohoSalesOrderId}.`
                : "Active write sync will automatically mirror this sales order into Zoho Inventory & Commerce."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={syncingZoho}
            onClick={() => void handleSyncToZoho()}
            className="text-xs font-semibold text-navy hover:text-gold"
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncingZoho ? "animate-spin" : ""}`} />
            {syncingZoho ? "Syncing with Zoho…" : zohoSalesOrderId ? "Re-sync to Zoho" : "Push to Zoho Sales Orders"}
          </Button>
          <Link
            to="/admin/zoho"
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate hover:text-navy"
          >
            Zoho Hub <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Zoho ERP Style 4-Stage Horizontal Progression Tracker */}
      <Panel title="Order Stage Progression" className="mb-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            {
              label: "Received",
              desc: `Order placed on ${order.date}`,
              active: true,
              done: order.status !== "Placed",
              current: order.status === "Placed",
              icon: FileText,
            },
            {
              label: "Confirmed",
              desc: order.status === "Placed" ? "Yet to be confirmed" : "Confirmed by admin",
              active: ["Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"].includes(order.status),
              done: ["Packed", "Dispatched", "Out for Delivery", "Delivered"].includes(order.status),
              current: ["Payment Confirmed", "Accepted"].includes(order.status),
              icon: CheckCircle2,
            },
            {
              label: "Ready for Pickup",
              desc: ["Packed", "Dispatched", "Out for Delivery", "Delivered"].includes(order.status) ? "Items packaged" : "Awaiting packaging",
              active: ["Packed", "Dispatched", "Out for Delivery", "Delivered"].includes(order.status),
              done: ["Dispatched", "Out for Delivery", "Delivered"].includes(order.status),
              current: order.status === "Packed",
              icon: Package,
            },
            {
              label: "Delivered",
              desc: order.status === "Delivered" ? "Fulfilled to customer" : "In transit / dispatch",
              active: order.status === "Delivered",
              done: order.status === "Delivered",
              current: ["Dispatched", "Out for Delivery"].includes(order.status),
              icon: Truck,
            },
          ].map((step, idx) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className={cn(
                  "relative flex flex-col justify-between rounded-xl border p-4 transition-all",
                  step.done
                    ? "border-emerald-300 bg-emerald-50/40 text-emerald-950"
                    : step.current
                    ? "border-emerald-700 bg-emerald-50/60 text-navy shadow-sm ring-2 ring-emerald-300/40"
                    : "border-border bg-stone-50/50 text-slate"
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg",
                      step.done
                        ? "bg-emerald-600 text-white"
                        : step.current
                        ? "bg-emerald-700 text-white"
                        : "bg-stone-200 text-stone-500"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className="text-[10px] font-bold tracking-wider uppercase text-slate">Stage {idx + 1}</span>
                </div>
                <div>
                  <p className="font-semibold text-sm">{step.label}</p>
                  <p className="text-xs text-slate/80 mt-0.5">{step.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {order.vendorStatuses && order.vendorStatuses.length > 0 && (
        <Panel title="Vendor Fulfillment Status" className="mt-5">
          <div className="divide-y divide-border">
            {order.vendorStatuses.map((fulfillment) => (
              <div key={fulfillment.vendorId} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-semibold text-navy">{fulfillment.vendor}</p>
                  <p className="font-mono text-xs text-slate">{fulfillment.vendorId}</p>
                </div>
                <StatusBadge status={fulfillment.status} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!canEditItems && !isCancelled && (
        <p className="mb-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-slate">
          Order lines can be edited only while the order is unpaid, undiscounted, and still in Placed status.
        </p>
      )}

      {/* Information Cards: Customer, Delivery, Payment, and Summary */}
      <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {/* 1. Customer Information */}
        <Panel title="Customer Details">
          <div className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate">
            <User className="h-4 w-4 text-navy" /> Customer Profile
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Name</dt>
              <dd className="font-semibold text-navy">{order.customer}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Phone</dt>
              <dd className="font-medium text-navy">{order.phone}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Email</dt>
              <dd className="font-medium text-navy truncate max-w-[150px]" title={order.email}>
                {order.email}
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <dt className="text-slate">GSTIN</dt>
              <dd className="font-mono font-semibold text-navy">{customerGstin}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Customer ID</dt>
              <dd className="font-mono text-xs text-slate">{order.customerId}</dd>
            </div>
          </dl>
        </Panel>

        {/* 2. Delivery & Address */}
        <Panel title="Delivery Information">
          <div className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate">
            <MapPin className="h-4 w-4 text-navy" /> Shipping Address
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Address</dt>
              <dd className="max-w-[65%] text-right font-medium text-navy">{order.address}</dd>
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
              <dt className="text-slate">PIN Code</dt>
              <dd className="font-mono font-medium text-navy">{order.pin}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <dt className="text-slate">Country</dt>
              <dd className="font-medium text-navy">India</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Method</dt>
              <dd className="w-40 text-xs font-semibold text-gold">
                <Input
                  aria-label="Delivery requirement"
                  defaultValue={order.delivery}
                  disabled={!canCancel}
                  className="h-8 text-xs"
                  onBlur={(event) => updateOrderDelivery(order.id, event.target.value)}
                />
              </dd>
            </div>
          </dl>
        </Panel>

        {/* 3. Payment Information */}
        <Panel title="Payment Information">
          <div className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate">
            <CreditCard className="h-4 w-4 text-navy" /> Settlement Ledger
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Transaction ID</dt>
              <dd className="font-mono font-semibold text-navy">{order.txn}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Method</dt>
              <dd className="font-medium text-navy">{order.method}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-slate">Payment Status</dt>
              <dd>
                <StatusBadge status={order.payment} />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Order Status</dt>
              <dd>
                <StatusBadge status={order.status} />
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <dt className="text-slate">Payment Date</dt>
              <dd className="font-medium text-navy">{order.date}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Gateway</dt>
              <dd className="text-xs text-slate">Razorpay / Net Banking</dd>
            </div>
          </dl>
        </Panel>

        {/* 4. Order Financial Summary */}
        <Panel title="Order Summary">
          <div className="flex items-center gap-2 pb-2 text-xs font-semibold text-slate">
            <FileText className="h-4 w-4 text-navy" /> Tax & Charges
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate">Sub Total ({order.items.length} Item{order.items.length === 1 ? "" : "s"})</dt>
              <dd className="font-medium text-charcoal">{inr(order.subtotal)}</dd>
            </div>
            {order.discount > 0 && (
              <div className="flex justify-between text-emerald-700 font-medium">
                <dt>Discount {order.coupon ? `(${order.coupon})` : ""}</dt>
                <dd>-{inr(order.discount)}</dd>
              </div>
            )}
            <div className="rounded-md border border-border/80 bg-stone-50/70 p-2 space-y-1 text-xs">
              <div className="flex justify-between font-semibold text-navy">
                <span>Tax Total</span>
                <span>{inr(order.tax)}</span>
              </div>
              <div className="flex justify-between text-slate pl-2">
                <span>• CGST2.5</span>
                <span>{inr(order.tax / 2)}</span>
              </div>
              <div className="flex justify-between text-slate pl-2">
                <span>• SGST2.5</span>
                <span>{inr(order.tax / 2)}</span>
              </div>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate">Freight / Delivery</dt>
              <dd className="font-medium text-charcoal">
                {order.shipping === 0 ? "Free Shipping" : inr(order.shipping)}
              </dd>
            </div>
            <div className="mt-2 flex justify-between border-t-2 border-border pt-2 text-base font-bold">
              <dt className="text-navy">Total (Tax Inclusive)</dt>
              <dd className="text-gold text-lg">{inr(order.amount)}</dd>
            </div>
          </dl>
        </Panel>
      </div>

      {/* Items Table with FIFO Cost and Pricing Breakdown */}
      <div className="mt-6">
        <Panel title={`Order Items (${order.items.length})`}>
          <p className="-mt-1 mb-3 text-xs text-slate">
            Item quantities, selling price, and FIFO inventory cost layer information
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-bold tracking-wider text-slate uppercase">
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3">SKU</th>
                  <th className="px-3 py-3">Vendor</th>
                  <th className="px-3 py-3 text-center">Bags / Capacity</th>
                  <th className="px-3 py-3 text-right">Selling Price</th>
                  <th className="px-3 py-3 text-right">FIFO Unit Cost</th>
                  <th className="px-3 py-3 text-right">Gross Margin</th>
                  <th className="px-3 py-3 text-right">Line Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it, i) => {
                  const fifoCost = getFIFOCost(it.product.id);
                  const unitPrice = it.unitPrice ?? it.product.price;
                  const margin =
                    unitPrice > 0 ? Math.round(((unitPrice - fifoCost) / unitPrice) * 100) : 0;

                  return (
                    <tr
                      key={i}
                      className="border-b border-border/70 last:border-0 hover:bg-muted/10"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          <img
                            src={it.product.image}
                            alt={it.product.name}
                            className="h-12 w-12 rounded-md border border-border object-cover"
                          />
                          <div>
                            <p className="font-semibold text-navy">{it.product.name}</p>
                            <span className="text-xs text-slate">{it.product.category}</span>
                            <Input
                              aria-label={`${it.product.name} bag capacity`}
                              defaultValue={it.capacity ?? it.product.weight}
                              disabled={!canEditItems}
                              className="mt-1 h-8 w-32 text-xs"
                              onBlur={async (event) => {
                                const value = event.target.value.trim();
                                if (value && value !== (it.capacity ?? it.product.weight) &&
                                  !(await updateOrderItem(order.id, i, { capacity: value }))) {
                                  toast.error("Could not update product capacity");
                                  event.target.value = it.capacity ?? it.product.weight;
                                }
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-charcoal">
                        {it.product.sku}
                      </td>
                      <td className="px-3 py-3 font-medium text-navy">{it.vendor}</td>
                      <td className="px-3 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            aria-label={`Remove one ${it.product.name} bag`}
                            disabled={!canEditItems || it.qty <= 1}
                            onClick={async () => {
                              if (!(await updateOrderItem(order.id, i, { qty: it.qty - 1 })))
                                toast.error("Could not update this order quantity");
                            }}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                          <Input
                            type="number"
                            min={1}
                            key={`${it.dbItemId ?? i}-${it.qty}`}
                            defaultValue={it.qty}
                            disabled={!canEditItems}
                            aria-label={`${it.product.name} bag quantity`}
                            className="h-8 w-16 text-center"
                            onBlur={async (event) => {
                              const quantity = Number(event.target.value);
                              if (Number.isInteger(quantity) && quantity > 0 && quantity !== it.qty) {
                                if (!(await updateOrderItem(order.id, i, { qty: quantity }))) {
                                  toast.error("Could not update quantity. Check available stock.");
                                  event.target.value = String(it.qty);
                                }
                              } else event.target.value = String(it.qty);
                            }}
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="h-8 w-8"
                            aria-label={`Add one ${it.product.name} bag`}
                            disabled={!canEditItems}
                            onClick={async () => {
                              if (!(await updateOrderItem(order.id, i, { qty: it.qty + 1 })))
                                toast.error("Not enough stock available for another bag");
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <span className="mt-1 block text-[11px] text-slate">
                          {it.qty} × {it.capacity ?? it.product.weight}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-charcoal">
                        <Input
                          type="number"
                          min={0}
                          key={`${it.dbItemId ?? i}-${unitPrice}`}
                          defaultValue={unitPrice}
                          disabled={!canEditItems}
                          step="0.01"
                          aria-label={`${it.product.name} unit price`}
                          className="h-8 w-24 text-right"
                          onBlur={async (event) => {
                            const price = Number(event.target.value);
                            if (Number.isFinite(price) && price >= 0 && price !== unitPrice) {
                              if (!(await updateOrderItem(order.id, i, { unitPrice: price }))) {
                                toast.error("Could not update this order price");
                                event.target.value = String(unitPrice);
                              }
                            } else event.target.value = String(unitPrice);
                          }}
                        />
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-slate">
                        {inr(fifoCost)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span
                          className={`text-xs font-semibold ${margin >= 15 ? "text-emerald-700" : "text-amber-700"}`}
                        >
                          {margin}%
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-bold text-navy">
                        {inr(unitPrice * it.qty)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {/* Vendor Information Section */}
      <div className="mt-6">
        <Panel title="Fulfilling Vendors">
          <p className="-mt-1 mb-3 text-xs text-slate">
            Registered vendor details and GSTIN for items in this order
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {orderVendors.map((v) => (
              <div
                key={v.id}
                className="rounded-lg border border-border bg-panel p-4 space-y-2 text-sm"
              >
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-gold" />
                    <span className="font-bold text-navy">{v.business}</span>
                  </div>
                  <span className="font-mono text-xs rounded bg-navy/10 px-1.5 py-0.5 font-semibold text-navy">
                    {v.id}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate">Proprietor / Contact:</span>
                  <span className="font-medium text-navy">{v.owner}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate">Email:</span>
                  <span className="font-medium text-navy">{v.email}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate">Phone:</span>
                  <span className="font-medium text-navy">{v.phone}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate">Vendor GSTIN:</span>
                  <span className="font-mono font-bold text-navy">{v.gst}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate">Location:</span>
                  <span className="font-medium text-navy">{v.city}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </PanelLayout>
  );
}
