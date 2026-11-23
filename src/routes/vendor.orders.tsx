import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { IndianRupee, PackageCheck, PackageX, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { vendorNav } from "@/lib/panel-nav";
import { getOrderItemTotal, inr, orderStages, vendorOrderStatusOptions, type OrderStatus } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { matchesOrderStatus, OPEN_ORDERS, orderStatusFilter } from "@/lib/panel-filters";
import { orderToneClass } from "@/lib/order-status-tone";

export const Route = createFileRoute("/vendor/orders")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search["q"] === "string" ? { q: search["q"] } : {}),
    ...(typeof search["status"] === "string" ? { status: search["status"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "Orders | Grain Bazar Vendor Panel" },
      { name: "description", content: "Track and update orders containing your products." },
      { property: "og:title", content: "Vendor Orders | Grain Bazar" },
      { property: "og:description", content: "Order management for Grain Bazar marketplace vendors." },
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
  const routeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const { updateOrderStatus } = useApp();
  const { vendor, vendorOrders, vendorId } = useVendorScope();
  const [q, setQ] = useState(routeSearch.q ?? "");
  const [status, setStatus] = useState(() => orderStatusFilter(routeSearch.status, [...orderStages, "Cancelled"]));
  const [sort, setSort] = useState("date-desc");
  const [page, setPage] = useState(1);
  // The Revenue Collected card shows the paid orders it adds up.
  const [paidOnly, setPaidOnly] = useState(false);

  // The cards open the list below with just those orders. resetScroll: the page stays here to scroll to the list.
  const showOrders = (next: string, paid = false) => {
    setQ("");
    setStatus(next);
    setPaidOnly(paid);
    setPage(1);
    void navigate({ search: next === "all" ? {} : { status: next }, resetScroll: false });
  };
  const openList = (next: string, paid = false) => {
    showOrders(next, paid);
    scrollToSection("vendor-orders");
  };

  // A link can change the filter while this list stays open (the sidebar's Orders, "Show all").
  useEffect(() => {
    setStatus(orderStatusFilter(routeSearch.status, [...orderStages, "Cancelled"]));
    setPage(1);
  }, [routeSearch.status]);

  useEffect(() => {
    setQ(routeSearch.q ?? "");
    setPage(1);
  }, [routeSearch.q]);

  const withAmounts = useMemo(
    () =>
      vendorOrders.map((o) => ({
        order: o,
        items: o.items.filter((i) => i.vendorId === vendorId),
        amount: o.items.filter((i) => i.vendorId === vendorId).reduce((s, i) => s + getOrderItemTotal(i), 0),
      })),
    [vendorOrders, vendorId],
  );

  const filtered = useMemo(() => {
    let list = withAmounts.filter(({ order: o }) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || `${o.id} ${o.customer} ${o.status} ${o.items.map((line) => `${line.product.name} ${line.product.sku}`).join(" ")}`.toLowerCase().includes(s);
      const matchesStatus = matchesOrderStatus(o.status, status);
      return matchesQ && matchesStatus && (!paidOnly || (o.payment === "Paid" && o.status !== "Cancelled"));
    });
    list = [...list].sort((a, b) => {
      const createdAt = (order: typeof a.order) => Date.parse(order.createdAt ?? order.date) || 0;
      if (sort === "date-desc") return createdAt(b.order) - createdAt(a.order);
      if (sort === "date-asc") return createdAt(a.order) - createdAt(b.order);
      if (sort === "amount-desc") return b.amount - a.amount;
      if (sort === "amount-asc") return a.amount - b.amount;
      return 0;
    });
    return list;
  }, [withAmounts, q, status, sort, paidOnly]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const total = vendorOrders.length;
  const pending = vendorOrders.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  const delivered = vendorOrders.filter((o) => o.status === "Delivered").length;
  const revenue = withAmounts.filter((w) => w.order.payment === "Paid" && w.order.status !== "Cancelled").reduce((s, w) => s + w.amount, 0);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Orders" subtitle={`Orders containing ${vendor?.business ?? "your store"} items`}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard onClick={() => openList("all")} label="Total Orders" value={String(total)} icon={ShoppingCart} highlight />
        <StatCard onClick={() => openList(OPEN_ORDERS)} label="Pending" value={String(pending)} icon={PackageX} />
        <StatCard onClick={() => openList("Delivered")} label="Delivered" value={String(delivered)} icon={PackageCheck} />
        <StatCard onClick={() => openList("all", true)} label="Revenue Collected" value={inr(revenue)} icon={IndianRupee} />
      </div>

      <Panel
        id="vendor-orders"
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
                <SelectItem value={OPEN_ORDERS}>All pending</SelectItem>
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
        {(paidOnly || status !== "all") && (
          <FilterNote label={paidOnly ? "Revenue Collected" : status === OPEN_ORDERS ? "All pending" : status} onClear={() => showOrders("all")} />
        )}
        <DataTable
          columns={["Order ID", "Date", "Customer", "Items", "Subtotal", "Payment", "Status", "Actions"]}
          // Each row tinted by its order status: waiting yellow, confirmed green, cancelled red.
          rowClassNames={rows.map(({ order: o }) => orderToneClass(o.status, "row"))}
          rows={rows.map(({ order: o, items, amount }) => [
            <Link to="/vendor/orders/$id" params={{ id: o.id }} search={true} className="font-semibold text-navy hover:text-gold">
              {o.id}
            </Link>,
            o.date,
            o.customer,
            items.length,
            inr(amount),
            <StatusBadge status={o.payment} />,
          <StatusBadge status={o.status} />,
            <Select
              disabled={vendorOrderStatusOptions(o).length === 1}
              value={o.status}
              onValueChange={async (v) => {
                if (await updateOrderStatus(o.id, v as OrderStatus)) toast.success(`Order ${o.id} updated to ${v}`);
              }}
            >
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {vendorOrderStatusOptions(o).map((s) => (
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
