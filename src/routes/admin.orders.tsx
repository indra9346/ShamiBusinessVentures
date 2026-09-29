import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, IndianRupee, PackageCheck, PackageX, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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
      { name: "description", content: "Manage, track and update every order placed on the Shami marketplace." },
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
  if (pathname !== "/admin/orders" && pathname !== "/admin/orders/") {
    return <Outlet />;
  }

  const { orders, updateOrderStatus, refundOrder } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [payment, setPayment] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);

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
      })
    );
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Orders" subtitle="All orders across every vendor">
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
            <Input
              placeholder="Search order, customer or phone"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="h-9 w-56"
            />
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                {[...orderStages, "Cancelled"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={payment} onValueChange={(v) => { setPayment(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Payment method" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Methods</SelectItem>
                {paymentMethods.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Sort" /></SelectTrigger>
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
          columns={["Order ID", "Date", "Customer", "Vendor(s)", "Items", "Payment", "Payment Status", "Order Status", "Total", "Actions"]}
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
              <span className="text-xs">{vendorSet.slice(0, 2).join(", ")}{vendorSet.length > 2 ? ` +${vendorSet.length - 2}` : ""}</span>,
              o.items.length,
              o.method,
              <StatusBadge status={o.payment} />,
              <StatusBadge status={o.status} />,
              inr(o.amount),
              <div className="flex flex-wrap items-center gap-1.5">
                <Link to="/admin/orders/$id" params={{ id: o.id }}>
                  <Button variant="outline" size="sm">View</Button>
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
                  <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[...orderStages, "Cancelled"].map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={o.status === "Cancelled"}>Cancel</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel order {o.id}?</AlertDialogTitle>
                      <AlertDialogDescription>This will mark the order as cancelled. This action cannot be undone.</AlertDialogDescription>
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
    </PanelLayout>
  );
}
