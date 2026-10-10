import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Boxes, IndianRupee, Package, ShoppingCart, Star, Users, Wallet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Filters, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { getOrderItemTotal, inr } from "@/lib/data";
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
  const { vendor, vendorProducts, vendorOrders, vendorReviews, vendorId } = useVendorScope();
  const [period, setPeriod] = useState("This Month");
  const commission = vendor?.commission ?? 8;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === "Today") start.setDate(now.getDate());
  if (period === "This Week") start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  if (period === "This Year") start.setMonth(0, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const periodOrders = vendorOrders.filter((order) => {
    const date = new Date(order.createdAt ?? order.date);
    return !Number.isNaN(date.getTime()) && date >= start && date <= end;
  });
  const periodRevenue = periodOrders.filter((order) => order.payment === "Paid" && order.status !== "Cancelled").reduce((sum, order) => sum + order.items
    .filter((item) => item.vendorId === vendorId)
    .reduce((subtotal, item) => subtotal + getOrderItemTotal(item), 0), 0);

  const bucketStarts: Date[] = [];
  if (period === "This Year") {
    for (let month = 0; month < 12; month += 1) bucketStarts.push(new Date(now.getFullYear(), month, 1));
  } else if (period === "This Month") {
    for (let day = 1; day <= new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); day += 7) bucketStarts.push(new Date(now.getFullYear(), now.getMonth(), day));
  } else if (period === "This Week") {
    const monday = new Date(start);
    for (let day = 0; day < 7; day += 1) bucketStarts.push(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day));
  } else bucketStarts.push(new Date(start));

  const salesSeries = bucketStarts.map((bucketStart, index) => {
    const next = bucketStarts[index + 1];
    const bucketEnd = next ? new Date(next.getTime() - 1) : period === "This Year"
      ? new Date(now.getFullYear(), bucketStart.getMonth() + 1, 0, 23, 59, 59, 999)
      : period === "This Month" ? new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
        : period === "This Week" ? new Date(bucketStart.getFullYear(), bucketStart.getMonth(), bucketStart.getDate(), 23, 59, 59, 999)
          : end;
    return { start: bucketStart, end: bucketEnd, month: period === "This Year"
      ? bucketStart.toLocaleDateString("en-IN", { month: "short" })
      : period === "This Month" ? `${bucketStart.getDate()}–${Math.min(bucketStart.getDate() + 6, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`
        : period === "This Week" ? bucketStart.toLocaleDateString("en-IN", { weekday: "short" }) : "Today", revenue: 0, orders: 0 };
  });
  for (const order of periodOrders) {
    const parsedDate = new Date(order.createdAt ?? order.date);
    if (Number.isNaN(parsedDate.getTime())) continue;
    const bucket = salesSeries.find((item) => parsedDate >= item.start && parsedDate <= item.end);
    if (!bucket) continue;
    bucket.orders += 1;
    if (order.payment === "Paid" && order.status !== "Cancelled") bucket.revenue += order.items.filter((item) => item.vendorId === vendorId).reduce((sum, item) => sum + getOrderItemTotal(item), 0);
  }

  const pendingOrders = periodOrders.filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
  const lowStock = vendorProducts
    .filter((p) => p.stock <= 0 || p.stock < (p.minimumStock ?? 30))
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
  const uniqueCustomers = new Set(periodOrders.map((o) => o.customerId)).size;
  const publishedReviews = vendorReviews.filter((review) => review.status === "Published");
  const avgRating = publishedReviews.length
    ? Math.round((publishedReviews.reduce((s, r) => s + r.rating, 0) / publishedReviews.length) * 10) / 10
    : 0;
  const pendingEarnings = periodOrders
    .filter((o) => o.payment === "Paid" && o.status !== "Delivered" && o.status !== "Cancelled")
    .reduce((s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + getOrderItemTotal(i), 0) * (1 - commission / 100), 0);

  const topProducts = [...vendorProducts].sort((a, b) => b.sold - a.sold).slice(0, 5);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Vendor Dashboard" subtitle={vendor?.business ?? "Your vendor account"}>
      <Filters options={["Today", "This Week", "This Month", "This Year"]} value={period} onChange={setPeriod} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={`${period} Paid Sales`} value={inr(periodRevenue)} icon={IndianRupee} highlight />
        <StatCard label={`${period} Orders`} value={String(periodOrders.length)} icon={ShoppingCart} />
        <StatCard label="Pending Orders" value={String(pendingOrders)} icon={ShoppingCart} />
        <StatCard label="Total Products" value={String(vendorProducts.length)} icon={Package} />
        <StatCard label="Unique Customers" value={String(uniqueCustomers)} icon={Users} />
        <StatCard label="Low Stock Products" value={String(lowStock.length)} icon={Boxes} />
        <StatCard label="Average Rating" value={publishedReviews.length ? `${avgRating} / 5` : "—"} icon={Star} />
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
            rows={periodOrders.slice(0, 8).map((o) => {
              const amt = o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0);
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
