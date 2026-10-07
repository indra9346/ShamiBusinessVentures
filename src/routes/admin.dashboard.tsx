import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Building2,
  Calendar,
  IndianRupee,
  Landmark,
  Package,
  ShoppingCart,
  Users,
  Wallet,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Filters, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr, payouts } from "@/lib/data";
import { useApp } from "@/lib/store";

export const Route = createFileRoute("/admin/dashboard")({
  head: () => ({
    meta: [
      { title: "Admin Control Centre | Shami Business Ventures" },
      {
        name: "description",
        content: "Platform-wide revenue, vendors, customers, products and payouts.",
      },
      { property: "og:title", content: "Admin Control Centre | Shami" },
      { property: "og:description", content: "Marketplace analytics and management." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminDashboard,
});

const pieColors = ["var(--navy)", "var(--gold)", "var(--gold-light)", "var(--slate)"];

type TimeFilterOption = "Today" | "Yesterday" | "Week" | "Month" | "Year" | "Custom Range";

function parseDate(dateStr: string): Date {
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  const m = dateStr.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m) {
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const day = parseInt(m[1]!, 10);
    const mon = months[m[2]!.toLowerCase()];
    const year = parseInt(m[3]!, 10);
    if (mon !== undefined) {
      return new Date(year, mon, day);
    }
  }
  return new Date(Number.NaN);
}

function AdminDashboard() {
  const { orders, products, customers, vendors } = useApp();
  const [timeFilter, setTimeFilter] = useState<TimeFilterOption>("Month");
  const todayISO = new Date().toISOString().slice(0, 10);
  const [customStart, setCustomStart] = useState(todayISO);
  const [customEnd, setCustomEnd] = useState(todayISO);

  // Determine active date boundaries based on business logic
  const dateRange = useMemo(() => {
    const now = new Date();
    if (timeFilter === "Today") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      return { start, end, label: `Today (${start.toLocaleDateString("en-IN")})` };
    }
    if (timeFilter === "Yesterday") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, -1);
      return { start, end, label: `Yesterday (${start.toLocaleDateString("en-IN")})` };
    }
    if (timeFilter === "Week") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      end.setMilliseconds(-1);
      return {
        start,
        end,
        label: `This Week (${start.toLocaleDateString("en-IN")} – ${end.toLocaleDateString("en-IN")})`,
      };
    }
    if (timeFilter === "Month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      end.setMilliseconds(-1);
      return {
        start,
        end,
        label: `This Month (${start.toLocaleDateString("en-IN", { month: "long", year: "numeric" })})`,
      };
    }
    if (timeFilter === "Year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear() + 1, 0, 1);
      end.setMilliseconds(-1);
      return { start, end, label: `This Year (${now.getFullYear()})` };
    }
    // Custom Range
    const start = new Date(`${customStart}T00:00:00`);
    const end = new Date(`${customEnd}T23:59:59`);
    return {
      start: isNaN(start.getTime())
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
        : start,
      end: isNaN(end.getTime())
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
        : end,
      label: `Custom Range: ${customStart} to ${customEnd}`,
    };
  }, [timeFilter, customStart, customEnd]);

  // Precise filtering of orders and payouts
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const od = parseDate(o.date);
      return od >= dateRange.start && od <= dateRange.end;
    });
  }, [orders, dateRange]);

  const filteredPayouts = useMemo(() => {
    return payouts.filter((p) => {
      const pd = parseDate(p.date);
      return pd >= dateRange.start && pd <= dateRange.end;
    });
  }, [dateRange]);

  // Financial statistics with 100% precision
  const financialStats = useMemo(() => {
    const periodInflow = filteredOrders
      .filter((o) => o.status !== "Cancelled")
      .reduce(
        (s, o) =>
          s + (o.paidAmount ?? (o.payment === "Paid" || o.payment === "COD" ? o.amount : 0)),
        0,
      );

    const periodRefunds = filteredOrders
      .filter((o) => o.payment === "Refunded")
      .reduce((s, o) => s + o.amount, 0);

    const periodPaidPayouts = filteredPayouts
      .filter((p) => p.status === "Paid")
      .reduce((s, p) => s + p.amount, 0);

    // Today's actual paid revenue
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      23,
      59,
      59,
      999,
    );
    const todayRevenue = orders
      .filter((o) => {
        const od = parseDate(o.date);
        return od >= todayStart && od <= todayEnd && o.status !== "Cancelled";
      })
      .reduce(
        (s, o) =>
          s + (o.paidAmount ?? (o.payment === "Paid" || o.payment === "COD" ? o.amount : 0)),
        0,
      );

    // Cumulative platform bank balance
    const totalInflow = orders
      .filter((o) => o.status !== "Cancelled")
      .reduce(
        (s, o) =>
          s + (o.paidAmount ?? (o.payment === "Paid" || o.payment === "COD" ? o.amount : 0)),
        0,
      );
    const totalRefunds = orders
      .filter((o) => o.payment === "Refunded")
      .reduce((s, o) => s + o.amount, 0);
    const totalPaidPayouts = payouts
      .filter((p) => p.status === "Paid")
      .reduce((s, p) => s + p.amount, 0);
    const bankBalance = totalInflow - totalRefunds - totalPaidPayouts;

    return {
      periodInflow,
      periodRefunds,
      periodPaidPayouts,
      todayRevenue,
      bankBalance,
    };
  }, [filteredOrders, filteredPayouts, orders]);

  // Derived counts for the period
  const pendingOrders = filteredOrders.filter(
    (o) => o.status !== "Delivered" && o.status !== "Cancelled",
  ).length;
  const lowStockCount = products.filter((p) => p.stock < (p.minimumStock ?? 30)).length;

  const activeCustomerCount = useMemo(() => {
    const set = new Set(filteredOrders.map((o) => o.customer));
    return set.size;
  }, [filteredOrders]);

  const activeVendorCount = useMemo(() => {
    const set = new Set(filteredOrders.flatMap((o) => o.items.map((i) => i.vendorId)));
    return set.size;
  }, [filteredOrders]);

  // Dynamic Revenue Analytics Chart Data
  const dynamicSalesSeries = useMemo(() => {
    const groups = new Map<string, { revenue: number; customers: Set<string>; sortKey: number }>();
    for (const order of filteredOrders) {
      const date = parseDate(order.date);
      if (Number.isNaN(date.getTime())) continue;
      const key =
        timeFilter === "Month"
          ? `${Math.floor((date.getDate() - 1) / 7) * 7 + 1}–${Math.min(Math.floor((date.getDate() - 1) / 7) * 7 + 7, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate())} ${date.toLocaleDateString("en-IN", { month: "short" })}`
          : timeFilter === "Year" || timeFilter === "Custom Range"
            ? date.toLocaleDateString("en-IN", { month: "short", year: "2-digit" })
            : date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
      const keyDate =
        timeFilter === "Month"
          ? new Date(
              date.getFullYear(),
              date.getMonth(),
              Math.floor((date.getDate() - 1) / 7) * 7 + 1,
            )
          : timeFilter === "Year" || timeFilter === "Custom Range"
            ? new Date(date.getFullYear(), date.getMonth(), 1)
            : new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const group = groups.get(key) ?? {
        revenue: 0,
        customers: new Set<string>(),
        sortKey: keyDate.getTime(),
      };
      if (order.status !== "Cancelled")
        group.revenue +=
          order.paidAmount ??
          (order.payment === "Paid" || order.payment === "COD" ? order.amount : 0);
      group.customers.add(order.customerId);
      groups.set(key, group);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[1].sortKey - b[1].sortKey)
      .map(([month, value]) => ({
        month,
        revenue: value.revenue,
        customers: value.customers.size,
      }));
  }, [timeFilter, filteredOrders]);

  // Dynamic Category Sales
  const dynamicCategorySales = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of filteredOrders) {
      for (const item of o.items) {
        const cat = item.product.category || "General";
        map[cat] = (map[cat] || 0) + item.product.price * item.qty;
      }
    }
    const total = Object.values(map).reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    return Object.entries(map)
      .map(([name, val]) => ({ name, value: Math.round((val / total) * 100) }))
      .sort((a, b) => b.value - a.value);
  }, [filteredOrders]);

  // Dynamic Vendor Performance based on filtered period
  const dynamicVendorPerf = useMemo(() => {
    return vendors
      .map((v) => {
        const vOrders = filteredOrders.filter((o) => o.items.some((i) => i.vendorId === v.id));
        const vSales = vOrders.reduce(
          (s, o) =>
            s +
            o.items
              .filter((i) => i.vendorId === v.id)
              .reduce((sum, item) => sum + item.product.price * item.qty, 0),
          0,
        );
        return {
          ...v,
          periodOrders: vOrders.length,
          periodSales: vSales,
        };
      })
      .sort((a, b) => b.periodSales - a.periodSales);
  }, [vendors, filteredOrders]);

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Control Centre"
      subtitle="Platform overview · All vendors"
    >
      {/* Time Filter Selector (Today, Week, Month, Year, Custom Range) */}
      <div className="flex flex-col gap-3">
        <Filters<TimeFilterOption>
          options={["Today", "Yesterday", "Week", "Month", "Year", "Custom Range"]}
          value={timeFilter}
          onChange={(val) => setTimeFilter(val)}
        />

        {/* Custom Range Picker when Custom Range is active */}
        {timeFilter === "Custom Range" && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-xs">
            <Calendar className="h-4 w-4 text-gold" />
            <span className="text-xs font-semibold text-navy">Date Window:</span>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate">From</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-navy focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate">To</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-navy focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <span className="text-xs font-semibold text-gold">
              {filteredOrders.length} orders matched ({inr(financialStats.periodInflow)})
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Bank Balance"
          value={inr(financialStats.bankBalance)}
          delta={`In: ${inr(financialStats.periodInflow)} · Out: ${inr(financialStats.periodRefunds + financialStats.periodPaidPayouts)}`}
          icon={Landmark}
          highlight
        />
        <StatCard
          label={
            timeFilter === "Today"
              ? "Today's Revenue"
              : timeFilter === "Week"
                ? "Weekly Revenue"
                : timeFilter === "Month"
                  ? "Monthly Revenue"
                  : timeFilter === "Year"
                    ? "Annual Revenue"
                    : "Range Revenue"
          }
          value={inr(financialStats.periodInflow)}
          icon={IndianRupee}
        />
        <StatCard label="Today's Payments" value={inr(financialStats.todayRevenue)} icon={Wallet} />
        <StatCard label="Total Orders" value={String(filteredOrders.length)} icon={ShoppingCart} />
        <StatCard label="Pending Orders" value={String(pendingOrders)} icon={ShoppingCart} />
        <StatCard
          label="Total Customers"
          value={String(activeCustomerCount)}
          delta="Customers with orders in range"
          icon={Users}
        />
        <StatCard
          label="Total Vendors"
          value={String(activeVendorCount)}
          delta="Vendors with orders in range"
          icon={Building2}
        />
        <StatCard
          label="Low Stock Products"
          value={String(lowStockCount)}
          icon={Package}
          highlight={lowStockCount > 0}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title={`Revenue Analytics (${dateRange.label})`}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dynamicSalesSeries}>
                <defs>
                  <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--gold)" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="var(--gold)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--slate)" fontSize={12} />
                <YAxis
                  stroke="var(--slate)"
                  fontSize={12}
                  tickFormatter={(v: number) =>
                    v >= 100000 ? `${(v / 100000).toFixed(1)}L` : inr(v)
                  }
                />
                <Tooltip formatter={(v: number) => inr(v)} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="var(--gold)"
                  strokeWidth={3}
                  fill="url(#rev)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title={`Category Sales (${dateRange.label})`}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dynamicCategorySales}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={3}
                >
                  {dynamicCategorySales.map((_, i) => (
                    <Cell key={i} fill={pieColors[i % pieColors.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => `${v}%`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title={`Customer Growth (${dateRange.label})`}>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dynamicSalesSeries}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--slate)" fontSize={12} />
                <YAxis stroke="var(--slate)" fontSize={12} />
                <Tooltip />
                <Bar dataKey="customers" fill="var(--navy)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title={`Vendor Performance (${dateRange.label})`}>
          <DataTable
            columns={["Vendor", "Period Orders", "Period Sales", "Commission", "Status"]}
            rows={dynamicVendorPerf.map((v) => [
              <span className="font-semibold text-navy">{v.business}</span>,
              v.periodOrders,
              inr(v.periodSales),
              `${v.commission}%`,
              <StatusBadge status={v.status} />,
            ])}
          />
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title={`Latest Orders (${dateRange.label})`}>
          <DataTable
            columns={["Order", "Date", "Customer", "Vendor", "Amount", "Payment", "Status"]}
            rows={filteredOrders
              .slice(0, 10)
              .map((o) => [
                <span className="font-semibold text-navy">{o.id}</span>,
                o.date,
                o.customer,
                o.items[0]?.vendor || "—",
                inr(o.amount),
                <StatusBadge status={o.payment} />,
                <StatusBadge status={o.status} />,
              ])}
          />
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="LOW STOCK ALERTS">
          <DataTable
            columns={["Product", "Current Stock", "Minimum Stock", "Required Stock", "Shortage"]}
            rows={products
              .filter((product) => product.stock < (product.minimumStock ?? 30))
              .slice(0, 10)
              .map((product) => {
                const minimum = product.minimumStock ?? 30;
                const required = Math.max(product.requiredStock ?? 0, minimum);
                return [
                  product.name,
                  product.stock,
                  minimum,
                  required,
                  <span className="font-bold text-amber-700">
                    {Math.max(0, required - product.stock)}
                  </span>,
                ];
              })}
          />
          {lowStockCount === 0 && (
            <p className="mt-3 text-sm text-slate">
              No products are below their minimum stock level.
            </p>
          )}
        </Panel>
      </div>
    </PanelLayout>
  );
}
