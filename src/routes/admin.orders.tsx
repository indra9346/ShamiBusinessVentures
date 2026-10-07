import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Download,
  IndianRupee,
  Minus,
  PackageCheck,
  PackageX,
  Plus,
  ShoppingCart,
} from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp } from "@/lib/store";
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
import { downloadCSV, downloadInvoice } from "@/lib/export-utils";
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
const paymentMethods = ["UPI", "Credit Card", "Debit Card", "Net Banking", "Cash on Delivery"];

function AdminOrders() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { orders, customers, products, placeOrder, updateOrderStatus, refundOrder } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [payment, setPayment] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [delivery, setDelivery] = useState("Standard Freight — 2 to 4 days");
  const [paymentDueDate, setPaymentDueDate] = useState("");
  const [draftItems, setDraftItems] = useState<
    Array<{ productId: string; qty: string; capacity: string; price: string }>
  >([]);

  const createOrder = () => {
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
          qty > (products.find((product) => product.id === productId)?.stock ?? 0),
      )
    ) {
      toast.error(
        "Choose a customer and valid product, bag count, capacity, price, and available stock.",
      );
      return;
    }
    const order = placeOrder({
      lines: lines.map((line) => ({
        product: line.product!,
        qty: line.qty,
        capacity: line.capacity,
        unitPrice: line.unitPrice,
      })),
      method: "UPI",
      payment: "Pending",
      customerOverride: customer,
      delivery,
      source: "WhatsApp / Admin entry",
      ...(paymentDueDate ? { paymentDueDate } : {}),
    });
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
                setDraftItems([
                  {
                    productId: products[0]?.id ?? "",
                    qty: "1",
                    capacity: products[0]?.weight ?? "",
                    price: String(products[0]?.price ?? ""),
                  },
                ]);
                setNewOrderOpen(true);
              }}
            >
              + New / WhatsApp Order
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
            return [
              <Link
                to="/admin/orders/$id"
                params={{ id: o.id }}
                className="font-mono font-bold text-navy hover:text-gold hover:underline transition-colors"
              >
                {o.id}
              </Link>,
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadInvoice(o)}
                  title="Download GST Invoice"
                  className="hover:border-gold hover:text-gold transition-colors"
                >
                  <Download className="h-3.5 w-3.5 mr-1" /> Invoice
                </Button>
                <Select
                  value={o.status}
                  onValueChange={(v) => {
                    updateOrderStatus(o.id, v as OrderStatus);
                    toast.success(`Order ${o.id} updated to ${v}`);
                  }}
                >
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...orderStages, "Cancelled"].map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={o.status === "Cancelled"}>
                      Cancel
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel order {o.id}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will mark the order as cancelled. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Back</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          updateOrderStatus(o.id, "Cancelled");
                          toast.success(`Order ${o.id} cancelled`);
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
                  disabled={o.payment === "Refunded"}
                  onClick={() => {
                    refundOrder(o.id);
                    toast.success(`Order ${o.id} refunded`);
                  }}
                >
                  Refund
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
            <div className="space-y-3">
              {draftItems.map((line, index) => {
                const product = products.find((candidate) => candidate.id === line.productId);
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
                                    price: String(selected?.price ?? ""),
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
                          {products.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name} · {item.sku}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-slate">Available: {product?.stock ?? 0}</span>
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
                  setDraftItems((items) => [
                    ...items,
                    {
                      productId: products[0]?.id ?? "",
                      qty: "1",
                      capacity: products[0]?.weight ?? "",
                      price: String(products[0]?.price ?? ""),
                    },
                  ])
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOrderOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createOrder}>Create Order</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
