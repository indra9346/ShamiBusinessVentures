import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { IndianRupee, PackageCheck, PackageX, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { vendorNav } from "@/lib/panel-nav";
import { inr, orderStages, type OrderStatus } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const Route = createFileRoute("/vendor/orders")({
  head: () => ({
    meta: [
      { title: "Orders | Shami Vendor Panel" },
      { name: "description", content: "Track and update orders containing your products." },
      { property: "og:title", content: "Vendor Orders | Shami" },
      { property: "og:description", content: "Order management for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorOrders,
});

const PAGE_SIZE = 10;

function VendorOrders() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/vendor/orders" && pathname !== "/vendor/orders/") {
    return <Outlet />;
  }
  return <VendorOrdersPanel />;
}

function VendorOrdersPanel() {
  const { updateOrderStatus } = useApp();
  const { vendorOrders, vendorId } = useVendorScope();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);

  const withAmounts = useMemo(
    () =>
      vendorOrders.map((o) => ({
        order: o,
        items: o.items.filter((i) => i.vendorId === vendorId),
        amount: o.items.filter((i) => i.vendorId === vendorId).reduce((s, i) => s + i.product.price * i.qty, 0),
      })),
    [vendorOrders, vendorId],
  );

  const filtered = useMemo(() => {
    let list = withAmounts.filter(({ order: o }) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || o.id.toLowerCase().includes(s) || o.customer.toLowerCase().includes(s);
      const matchesStatus = status === "all" || o.status === status;
      return matchesQ && matchesStatus;
    });
    list = [...list].sort((a, b) => {
      if (sort === "date-desc") return b.order.id.localeCompare(a.order.id);
      if (sort === "date-asc") return a.order.id.localeCompare(b.order.id);
      if (sort === "amount-desc") return b.amount - a.amount;
      if (sort === "amount-asc") return a.amount - b.amount;
      return 0;
    });
    return list;
  }, [withAmounts, q, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const total = vendorOrders.length;
  const pending = vendorOrders.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  const delivered = vendorOrders.filter((o) => o.status === "Delivered").length;
  const revenue = withAmounts.filter((w) => w.order.payment === "Paid").reduce((s, w) => s + w.amount, 0);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Orders" subtitle="Orders containing Shami Sugar Mills items">
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
              placeholder="Search order or customer"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
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
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest First</SelectItem>
                <SelectItem value="date-asc">Oldest First</SelectItem>
                <SelectItem value="amount-desc">Amount: High to Low</SelectItem>
                <SelectItem value="amount-asc">Amount: Low to High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Order ID", "Date", "Customer", "Items", "Subtotal", "Payment", "Status", "Actions"]}
          rows={rows.map(({ order: o, items, amount }) => [
            <Link to="/vendor/orders/$id" params={{ id: o.id }} className="font-semibold text-navy hover:text-gold">
              {o.id}
            </Link>,
            o.date,
            o.customer,
            items.length,
            inr(amount),
            <StatusBadge status={o.payment} />,
            <StatusBadge status={o.status} />,
            <Select
              value={o.status}
              onValueChange={async (v) => {
                if (await updateOrderStatus(o.id, v as OrderStatus)) toast.success(`Order ${o.id} updated to ${v}`);
              }}
            >
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[...orderStages, "Cancelled"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>,
          ])}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>
    </PanelLayout>
  );
}
