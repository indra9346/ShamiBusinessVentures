import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, IndianRupee, Package, ShoppingCart, Star, Users, Wallet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Filters, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { inr, salesSeries } from "@/lib/data";
import { useVendorScope } from "@/lib/store";

export const Route = createFileRoute("/vendor/dashboard")({
  head: () => ({
    meta: [
      { title: "Vendor Dashboard | Shami Business Ventures" },
      { name: "description", content: "Vendor sales, orders, stock and payout overview." },
      { property: "og:title", content: "Vendor Dashboard | Shami" },
      { property: "og:description", content: "Operational overview for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorDashboard,
});

function VendorDashboard() {
  const { vendorProducts, vendorOrders, vendorReviews, revenue } = useVendorScope();

  const pendingOrders = vendorOrders.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  const lowStock = vendorProducts.filter((p) => p.stock > 0 && p.stock < 30);
  const uniqueCustomers = new Set(vendorOrders.map((o) => o.customerId)).size;
  const avgRating = vendorReviews.length
    ? Math.round((vendorReviews.reduce((s, r) => s + r.rating, 0) / vendorReviews.length) * 10) / 10
    : 0;
  const pendingEarnings = vendorOrders
    .filter((o) => o.status !== "Delivered" && o.status !== "Cancelled")
    .reduce((s, o) => s + o.items.filter((i) => i.vendorId === "V01").reduce((t, i) => t + i.product.price * i.qty, 0), 0);

  const topProducts = [...vendorProducts].sort((a, b) => b.sold - a.sold).slice(0, 5);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Vendor Dashboard" subtitle="Shami Sugar Mills · Verified vendor">
      <Filters options={["Today", "This Week", "This Month", "This Year", "Custom Date"]} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Revenue" value={inr(revenue)} delta="+14%" icon={IndianRupee} highlight />
        <StatCard label="Total Orders" value={String(vendorOrders.length)} icon={ShoppingCart} />
        <StatCard label="Pending Orders" value={String(pendingOrders)} icon={ShoppingCart} />
        <StatCard label="Total Products" value={String(vendorProducts.length)} icon={Package} />
        <StatCard label="Unique Customers" value={String(uniqueCustomers)} icon={Users} />
        <StatCard label="Low Stock Products" value={String(lowStock.length)} icon={Boxes} />
        <StatCard label="Average Rating" value={vendorReviews.length ? `${avgRating} / 5` : "—"} icon={Star} />
        <StatCard label="Pending Earnings" value={inr(pendingEarnings)} icon={Wallet} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title="Sales Overview">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={salesSeries}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--slate)" fontSize={12} />
                <YAxis stroke="var(--slate)" fontSize={12} tickFormatter={(v: number) => `${v / 100000}L`} />
                <Tooltip formatter={(v: number) => inr(v)} />
                <Line type="monotone" dataKey="revenue" stroke="var(--gold)" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Orders Overview">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={salesSeries}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--slate)" fontSize={12} />
                <YAxis stroke="var(--slate)" fontSize={12} />
                <Tooltip />
                <Bar dataKey="orders" fill="var(--navy)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Panel title="Recent Orders">
          <DataTable
            columns={["Order", "Date", "Customer", "Amount", "Payment", "Status"]}
            rows={vendorOrders.slice(0, 8).map((o) => {
              const amt = o.items.filter((i) => i.vendorId === "V01").reduce((t, i) => t + i.product.price * i.qty, 0);
              return [
                <Link to="/vendor/orders/$id" params={{ id: o.id }} className="font-semibold text-navy hover:text-gold">
                  {o.id}
                </Link>,
                o.date,
                o.customer,
                inr(amt),
                <StatusBadge status={o.payment} />,
                <StatusBadge status={o.status} />,
              ];
            })}
          />
        </Panel>
        <Panel title="Top Products">
          <div className="space-y-4">
            {topProducts.map((p) => (
              <div key={p.id} className="flex items-center gap-3">
                <img src={p.image} alt={p.name} loading="lazy" width={800} height={800} className="h-11 w-11 rounded-md object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-navy">{p.name}</p>
                  <p className="text-xs text-slate">{p.sold} units sold</p>
                </div>
                <p className="text-sm font-bold text-gold">{inr(p.price * p.sold)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Low Stock Alerts">
          <DataTable
            columns={["Product", "SKU", "Category", "Stock", "Status"]}
            empty="No products are low on stock"
            rows={lowStock.map((p) => [
              <span className="font-semibold text-navy">{p.name}</span>,
              p.sku,
              p.category,
              p.stock,
              <StatusBadge status="Low Stock" />,
            ])}
          />
        </Panel>
      </div>
    </PanelLayout>
  );
}
