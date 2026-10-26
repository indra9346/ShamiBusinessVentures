import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Download,
  IndianRupee,
  Minus,
  PackageCheck,
  PackageX,
  Plus,
  RefreshCw,
  ShoppingCart,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { canCancelOrder, inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp, type Address } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { godownOfferOf, orderGodownFor, useBranches } from "@/lib/branches";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadCSV } from "@/lib/export-utils";
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
import { InvoicePreviewButton } from "@/components/site/InvoicePreviewDialog";

export const Route = createFileRoute("/admin/orders")({
  head: () => ({
    meta: [
      { title: "Orders | Shami Business Ventures Admin" },
      {
        name: "description",
        content: "Manage, track and update every order placed on the Shami marketplace.",
      },
      { property: "og:title", content: "Order Management | Shami Admin" },
      { property: "og:description", content: "Full order lifecycle management console." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminOrders,
});

const PAGE_SIZE = 10;
const paymentMethods = ["UPI", "Credit Card", "Debit Card", "Net Banking"];

function AdminOrders() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { orders, customers, products, placeOrder, updateOrderStatus } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [payment, setPayment] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [zohoSync, setZohoSync] = useState<"idle" | "pulling" | "linking">("idle");
  // Pull order changes made in Zoho (void, confirm, shipped…) whenever the admin opens Orders.
  const pullZohoChanges = async (announce: boolean) => {
    if (STATIC_DATA_MODE) return;
    setZohoSync("pulling");
    try {
      const { syncZohoOrderChangesNow } = await import("@/lib/zoho-commerce.functions");
      const result = await syncZohoOrderChangesNow();
      if (result.itemsError) toast.error("Zoho item changes could not be read", { description: result.itemsError });
      if (announce) toast.success(`Zoho: ${result.ordersChanged} order and ${result.itemsChanged} product updates applied here`);
    } catch (cause) {
      if (announce) toast.error("Could not read Zoho order changes", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setZohoSync("idle");
    }
  };
  useEffect(() => {
    void pullZohoChanges(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const turnOnInstantZohoUpdates = async () => {
    setZohoSync("linking");
    try {
      const { registerZohoOrderWebhook } = await import("@/lib/zoho-commerce.functions");
      const result = await registerZohoOrderWebhook();
      toast.success(result.already ? "Instant Zoho updates are already on" : "Instant Zoho updates turned on");
    } catch {
      // Commerce webhooks need extra Zoho rights; a Books/Inventory Workflow Rule does the same job.
      await showWebhookAddress();
    } finally {
      setZohoSync("idle");
    }
  };
  const [webhookAddress, setWebhookAddress] = useState<string | null>(null);
  const showWebhookAddress = async () => {
    try {
      const { getZohoWebhookAddress } = await import("@/lib/zoho-commerce.functions");
      setWebhookAddress((await getZohoWebhookAddress()).url);
    } catch (cause) {
      toast.error("Could not load the Zoho webhook address", { description: cause instanceof Error ? cause.message : undefined });
    }
  };
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [delivery, setDelivery] = useState("Standard Freight — 2 to 4 days");
  const [paymentDueDate, setPaymentDueDate] = useState("");
  const [draftItems, setDraftItems] = useState<
    Array<{ productId: string; qty: string; capacity: string; price: string }>
  >([]);
  // The order must ship to one of the customer's own saved addresses (the database checks it).
  const [customerAddresses, setCustomerAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState("");
  const [orderFormError, setOrderFormError] = useState("");
  // The order belongs to the godown serving the delivery address (by PIN when PIN matching is
  // on), and the database charges that godown's price from its stock: show the same here.
  const branchState = useBranches();
  const orderAddress = customerAddresses?.find((address) => address.id === addressId);
  const orderGodown = branchState.ready ? orderGodownFor(branchState, orderAddress?.pin) : null;
  // Zoho-imported copies (vendor "zoho:…") mirror the real products and hold no godown stock:
  // orders are always placed for the real product.
  const orderableProducts = products.filter((product) => !product.vendorId.startsWith("zoho:") && product.active);
  const offerOf = (product: (typeof products)[number] | undefined) =>
    product ? godownOfferOf(branchState, orderGodown, product) : { price: null, stock: 0 };
  const newLine = () => {
    const product = orderableProducts.find((item) => offerOf(item).price !== null) ?? orderableProducts[0];
    return { productId: product?.id ?? "", qty: "1", capacity: product?.weight ?? "", price: String(offerOf(product).price ?? "") };
  };
  // A different address can mean a different godown: re-price the lines.
  useEffect(() => {
    setDraftItems((items) => items.map((item) => {
      const price = offerOf(products.find((product) => product.id === item.productId)).price;
      return { ...item, price: price === null ? "" : String(price) };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderGodown?.id, branchState.prices, branchState.features.branchRouting]);
  useEffect(() => {
    setCustomerAddresses(null);
    setAddressId("");
    if (!customerId || STATIC_DATA_MODE) return;
    let active = true;
    void supabase.from("addresses").select("*").eq("user_id", customerId)
      .order("is_default", { ascending: false }).order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) { setCustomerAddresses([]); return; }
        const list = (data ?? []).map((row) => ({
          id: row.id, label: row.label, name: row.name, phone: row.phone, line: row.line,
          city: row.city, state: row.state, pin: row.pin, landmark: row.landmark || "", default: row.is_default,
        }) as Address);
        setCustomerAddresses(list);
        setAddressId(list[0]?.id ?? "");
      });
    return () => { active = false; };
  }, [customerId]);

  const createOrder = async () => {
    const customer = customers.find((item) => item.id === customerId);
    const lines = draftItems.map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId);
      return {
        product,
        qty: Number(item.qty),
        capacity: item.capacity.trim(),
        unitPrice: Number(item.price),
      };
    });
    const requestedByProduct = new Map<string, number>();
    for (const line of lines) {
      if (line.product)
        requestedByProduct.set(
          line.product.id,
          (requestedByProduct.get(line.product.id) ?? 0) + line.qty,
        );
    }
    setOrderFormError("");
    const shippingAddress = customerAddresses?.find((address) => address.id === addressId);
    if (customer && !STATIC_DATA_MODE && !shippingAddress) {
      setOrderFormError("This customer has no saved address. Ask them to add one in My Account → Addresses, then try again.");
      return;
    }
    const missing = lines.find((line) => line.product && !line.capacity);
    if (missing) {
      setOrderFormError(`Enter the capacity / size for ${missing.product!.name} (for example 1 L or 25 kg).`);
      return;
    }
    if (
      !customer ||
      !lines.length ||
      lines.some(
        (line) =>
          !line.product ||
          !Number.isInteger(line.qty) ||
          line.qty < 1 ||
          !line.capacity ||
          !Number.isFinite(line.unitPrice) ||
          line.unitPrice < 0,
      ) ||
      [...requestedByProduct].some(
        ([productId, qty]) =>
          qty > offerOf(products.find((product) => product.id === productId)).stock,
      )
    ) {
      setOrderFormError("Choose a customer and a valid product, bag count, price and available stock.");
      return;
    }
    const notSold = lines.find((line) => offerOf(line.product).price === null);
    if (notSold) {
      setOrderFormError(`${notSold.product!.name} is not sold at ${orderGodown?.name ?? "this godown"}. Remove it or choose another address.`);
      return;
    }
    let order: Awaited<ReturnType<typeof placeOrder>>;
    try {
      order = await placeOrder({
        lines: lines.map((line) => ({
          product: line.product!,
          qty: line.qty,
          capacity: line.capacity,
          unitPrice: line.unitPrice,
        })),
        method: "UPI",
        payment: "Pending",
        customerOverride: customer,
        ...(shippingAddress ? { shippingAddress } : {}),
        delivery,
        source: "WhatsApp / Admin entry",
        ...(paymentDueDate ? { paymentDueDate } : {}),
      });
    } catch (cause) {
      setOrderFormError(cause instanceof Error ? cause.message : "The order could not be saved.");
      return;
    }
    toast.success(
      `Order ${order.id} created. Review and edit its lines before confirming payment.`,
    );
    setNewOrderOpen(false);
    setDraftItems([]);
  };

  const filtered = useMemo(() => {
    let list = orders.filter((o) => {
      const s = q.trim().toLowerCase();
      const matchesQ =
        !s ||
        o.id.toLowerCase().includes(s) ||
        o.customer.toLowerCase().includes(s) ||
        o.phone.toLowerCase().includes(s);
      const matchesStatus = status === "all" || o.status === status;
      const matchesPayment = payment === "all" || o.method === payment;
      return matchesQ && matchesStatus && matchesPayment;
    });
    list = [...list].sort((a, b) => {
      if (sort === "date-desc") return b.id.localeCompare(a.id);
      if (sort === "date-asc") return a.id.localeCompare(b.id);
      if (sort === "amount-desc") return b.amount - a.amount;
      if (sort === "amount-asc") return a.amount - b.amount;
      return 0;
    });
    return list;
  }, [orders, q, status, payment, sort]);

  if (pathname !== "/admin/orders" && pathname !== "/admin/orders/") {
    return <Outlet />;
  }

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const total = orders.length;
  const pending = orders.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  const delivered = orders.filter((o) => o.status === "Delivered").length;
  const cancelled = orders.filter((o) => o.status === "Cancelled").length;
  const revenue = orders.filter((o) => o.payment === "Paid").reduce((s, o) => s + o.amount, 0);

  const handleExportOrders = () => {
    downloadCSV(
      "Orders_Export",
      [
        "Order ID",
        "Date",
        "Customer",
        "Phone",
        "Email",
        "Vendors",
        "Items Count",
        "Payment Method",
        "Payment Status",
        "Order Status",
        "Subtotal (INR)",
        "GST (INR)",
        "Total (INR)",
      ],
      filtered.map((o) => {
        const vendorNames = Array.from(new Set(o.items.map((i) => i.vendor))).join(", ");
        return [
          o.id,
          o.date,
          o.customer,
          o.phone,
          o.email,
          vendorNames,
          o.items.length,
          o.method,
          o.payment,
          o.status,
          o.subtotal,
          o.tax,
          o.amount,
        ];
      }),
    );
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Orders"
      subtitle="All orders across every vendor"
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Orders" value={String(total)} icon={ShoppingCart} highlight />
        <StatCard label="Pending" value={String(pending)} icon={PackageX} />
        <StatCard label="Delivered" value={String(delivered)} icon={PackageCheck} />
        <StatCard label="Revenue Collected" value={inr(revenue)} icon={IndianRupee} />
      </div>

      <Panel
        title="All Orders"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setDraftItems([newLine()]);
                setNewOrderOpen(true);
              }}
            >
              + New / WhatsApp Order
            </Button>
            <Button
              variant="outline"
              disabled={zohoSync !== "idle"}
              onClick={() => void pullZohoChanges(true)}
              title="Bring in order changes made in Zoho (void, confirm, shipped, delivered)"
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${zohoSync === "pulling" ? "animate-spin" : ""}`} />
              {zohoSync === "pulling" ? "Checking Zoho…" : "Sync from Zoho"}
            </Button>
            <Button
              variant="outline"
              disabled={zohoSync !== "idle"}
              onClick={() => void turnOnInstantZohoUpdates()}
              title="Ask Zoho Commerce to notify this site the moment a sales order changes"
            >
              <Zap className="mr-1.5 h-4 w-4" />
              {zohoSync === "linking" ? "Turning on…" : "Instant Zoho updates"}
            </Button>
            <Input
              placeholder="Search order, customer or phone"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="h-9 w-56"
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                {[...orderStages, "Cancelled"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={payment}
              onValueChange={(v) => {
                setPayment(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder="Payment method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Methods</SelectItem>
                {paymentMethods.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest First</SelectItem>
                <SelectItem value="date-asc">Oldest First</SelectItem>
                <SelectItem value="amount-desc">Amount: High to Low</SelectItem>
                <SelectItem value="amount-asc">Amount: Low to High</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportOrders}
              className="h-9 hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
          </div>
        }
      >
        <DataTable
          columns={[
            "Order ID",
            "Date",
            "Customer",
            "Vendor(s)",
            "Items",
            "Payment",
            "Payment Status",
            "Order Status",
            "Total",
            "Actions",
          ]}
          rows={rows.map((o) => {
            const vendorSet = Array.from(new Set(o.items.map((i) => i.vendor)));
            const canCancel = canCancelOrder(o, "admin");
            const needsRefund = (o.paidAmount ?? 0) > 0 || o.payment === "Paid" || o.payment === "Partially Paid";
            return [
              <div>
                <Link
                  to="/admin/orders/$id"
                  params={{ id: o.id }}
                  className="font-mono font-bold text-navy hover:text-gold hover:underline transition-colors block"
                >
                  {o.id}
                </Link>
                {o.zohoSalesOrderId ? (
                  <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-800">
                    Zoho: {o.zohoSalesOrderId}
                    {o.zohoOrderStatus && (
                      <span className={["void", "cancelled"].includes(o.zohoOrderStatus) && o.status !== "Cancelled" ? "font-bold text-danger" : ""}>
                        {" · "}{o.zohoOrderStatus}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-slate/70">
                    Zoho ready
                  </span>
                )}
              </div>,
              o.date,
              <div>
                <p className="font-medium text-navy">{o.customer}</p>
                <p className="text-xs text-slate">{o.phone}</p>
              </div>,
              <span className="text-xs">
                {vendorSet.slice(0, 2).join(", ")}
                {vendorSet.length > 2 ? ` +${vendorSet.length - 2}` : ""}
              </span>,
              o.items.length,
              o.method,
              <StatusBadge status={o.payment} />,
              <StatusBadge status={o.status} />,
              inr(o.amount),
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to="/admin/orders/$id" params={{ id: o.id }}>
                  <Button variant="outline" size="sm">
                    View
                  </Button>
                </Link>
                <InvoicePreviewButton order={o} copy="office" size="sm" label="Invoice" />
                <Select
                  value={o.status}
                  disabled={o.status === "Cancelled"}
                  onValueChange={async (v) => {
                    if (await updateOrderStatus(o.id, v as OrderStatus)) toast.success(`Order ${o.id} updated to ${v}`);
                  }}
                >
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...orderStages, ...(o.status === "Cancelled" ? ["Cancelled" as const] : [])].map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canCancel}
                      title={!canCancel && needsRefund
                        ? "A verified refund must be completed before cancellation."
                        : undefined}
                    >
                      Cancel
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel order {o.id}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        {canCancel
                          ? "This will mark the order as cancelled and restore its available inventory."
                          : needsRefund
                            ? "Paid orders cannot be cancelled until a verified refund is completed. Refund processing is not configured yet."
                            : o.vendorStatuses?.some((fulfillment) => ["Dispatched", "Out for Delivery", "Delivered"].includes(fulfillment.status))
                              ? "Orders cannot be cancelled after any vendor has dispatched. Contact support if this order needs intervention."
                              : "A vendor has already started fulfilment. Contact support if this order needs intervention."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Back</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={async () => {
                          if (await updateOrderStatus(o.id, "Cancelled")) toast.success(`Order ${o.id} cancelled`);
                        }}
                      >
                        Confirm Cancel
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title="Refund processing requires a configured payment provider"
                >
                  Refund provider required
                </Button>
              </div>,
            ];
          })}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>
      <Dialog open={newOrderOpen} onOpenChange={setNewOrderOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>New / WhatsApp Order</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate">
            Enter the customer's WhatsApp requirement, edit product lines, then save the order for
            payment review.
          </p>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label>Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id}>
                      {customer.name} · {customer.phone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>Delivery address</Label>
              {customerAddresses === null ? (
                <p className="text-sm text-slate">{customerId ? "Loading saved addresses…" : "Select a customer first."}</p>
              ) : customerAddresses.length === 0 ? (
                <p className="text-sm text-amber-700">This customer has no saved address yet. Ask them to add one in My Account → Addresses.</p>
              ) : (
                <Select value={addressId} onValueChange={setAddressId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select address" />
                  </SelectTrigger>
                  <SelectContent>
                    {customerAddresses.map((address) => (
                      <SelectItem key={address.id} value={address.id}>
                        {address.label}{address.default ? " (default)" : ""} · {[address.line, address.city, address.pin].filter(Boolean).join(", ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {orderGodown && (
                <p className="text-xs text-slate">
                  Fulfilled from <span className="font-semibold text-navy">{orderGodown.name}</span>: prices and stock below are this godown's.
                </p>
              )}
            </div>
            <div className="space-y-3">
              {draftItems.map((line, index) => {
                const product = products.find((candidate) => candidate.id === line.productId);
                const offer = offerOf(product);
                const lineTotal = (Number(line.qty) || 0) * (Number(line.price) || 0);
                return (
                  <div
                    key={index}
                    className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
                  >
                    <div className="grid gap-1">
                      <Label>Product</Label>
                      <Select
                        value={line.productId}
                        onValueChange={(productId) => {
                          const selected = products.find((item) => item.id === productId);
                          setDraftItems((items) =>
                            items.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    productId,
                                    capacity: selected?.weight ?? "",
                                    price: String(offerOf(selected).price ?? ""),
                                  }
                                : item,
                            ),
                          );
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {orderableProducts.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name} · {item.sku}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {product && offer.price === null ? (
                        <span className="text-xs font-semibold text-amber-700">Not sold at {orderGodown?.name ?? "this godown"}</span>
                      ) : (
                        <span className="text-xs text-slate">Available: {offer.stock}{orderGodown ? ` at ${orderGodown.name}` : ""}</span>
                      )}
                    </div>
                    <div className="grid gap-1">
                      <Label>Bags</Label>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          aria-label="Decrease bag quantity"
                          disabled={(Number(line.qty) || 0) <= 1}
                          onClick={() =>
                            setDraftItems((items) =>
                              items.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      qty: String(Math.max(1, (Number(item.qty) || 1) - 1)),
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <Input
                          type="number"
                          min={1}
                          value={line.qty}
                          aria-label="Number of bags"
                          className="min-w-0 text-center"
                          onChange={(event) =>
                            setDraftItems((items) =>
                              items.map((item, i) =>
                                i === index ? { ...item, qty: event.target.value } : item,
                              ),
                            )
                          }
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          aria-label="Increase bag quantity"
                          onClick={() =>
                            setDraftItems((items) =>
                              items.map((item, i) =>
                                i === index
                                  ? { ...item, qty: String((Number(item.qty) || 0) + 1) }
                                  : item,
                              ),
                            )
                          }
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <Label>Capacity / bag</Label>
                      <Input
                        value={line.capacity}
                        onChange={(event) =>
                          setDraftItems((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, capacity: event.target.value } : item,
                            ),
                          )
                        }
                        placeholder="25 kg"
                      />
                    </div>
                    <div className="grid gap-1">
                      <Label>Price / bag (₹)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={line.price}
                        onChange={(event) =>
                          setDraftItems((items) =>
                            items.map((item, i) =>
                              i === index ? { ...item, price: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <span className="text-xs text-slate">Line: {inr(lineTotal)}</span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={draftItems.length <= 1}
                      onClick={() => setDraftItems((items) => items.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDraftItems((items) => [...items, newLine()])
                }
              >
                + Add another product
              </Button>
            </div>
            <div className="grid gap-1">
              <Label>Delivery requirement</Label>
              <Input value={delivery} onChange={(event) => setDelivery(event.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label>Payment due date</Label>
              <Input
                type="date"
                value={paymentDueDate}
                onChange={(event) => setPaymentDueDate(event.target.value)}
              />
            </div>
            <p className="text-right text-sm font-semibold text-navy">
              Order subtotal:{" "}
              {inr(
                draftItems.reduce(
                  (sum, item) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0),
                  0,
                ),
              )}
            </p>
          </div>
          {orderFormError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{orderFormError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOrderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createOrder}>Create Order</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!webhookAddress} onOpenChange={(open) => !open && setWebhookAddress(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Instant updates from Zoho</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate">
            Create a Zoho webhook with this address and a Workflow Rule on Sales Orders (when created or
            edited). Zoho then sends every new, edited, confirmed, voided or shipped sales order here at once.
            Keep the address private: it carries the key that lets Zoho in.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={webhookAddress ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              type="button"
              onClick={() => {
                if (!webhookAddress) return;
                void navigator.clipboard.writeText(webhookAddress).then(
                  () => toast.success("Webhook address copied"),
                  () => toast.error("Copy failed; select the address and copy it"),
                );
              }}
            >
              Copy
            </Button>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-charcoal">
            <li>Zoho Books → Settings → Workflow Actions → Webhooks → New Webhook.</li>
            <li>Module: Sales Order · Method: POST · URL: paste the address above · Body: Default Payload · Save.</li>
            <li>Settings → Workflow Rules → New Workflow Rule · Module: Sales Order · Event Based · Created or Edited · When any field is updated · Edited each time.</li>
            <li>Actions: Type Webhooks → choose the webhook from step 2 · Save.</li>
          </ol>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
