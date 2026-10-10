import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";

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
  // Date-only values should be interpreted in local time, matching the date inputs.
  const isoDate = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
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

function orderTimestamp(order: { createdAt?: string; date: string }): Date {
  return parseDate(order.createdAt || order.date);
}

function paymentsReceived(order: { amount: number; paidAmount?: number; payment: string; status: string }): number {
  if (order.status === "Cancelled") return 0;
  if (order.paidAmount !== undefined) return Math.max(0, order.paidAmount);
  return order.payment === "Paid" ? order.amount : 0;
}

function orderValue(order: { amount: number; status: string }): number {
  return order.status === "Cancelled" ? 0 : order.amount;
}

function AdminDashboard() {
  const { orders, products, customers, vendors } = useApp();
  const [timeFilter, setTimeFilter] = useState<TimeFilterOption>("Month");
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const [customStart, setCustomStart] = useState(todayISO);
  const [customEnd, setCustomEnd] = useState(todayISO);
  const [payouts, setPayouts] = useState<{ id: string; date: string; amount: number; status: string }[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase.from("vendor_payout_requests").select("id,requested_at,processed_at,amount,status");
      if (error) return;
      setPayouts((data ?? []).map((p) => ({ id: p.id, date: p.status === "Paid" && p.processed_at ? p.processed_at : p.requested_at, amount: Number(p.amount), status: p.status })));
    };
    void load();
    const channel = supabase.channel("admin-dashboard-payouts").on("postgres_changes", { event: "*", schema: "public", table: "vendor_payout_requests" }, () => void load()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

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
    const end = new Date(`${customEnd}T23:59:59.999`);
    const valid = !isNaN(start.getTime()) && !isNaN(end.getTime()) && start <= end;
    return {
      start: valid ? start : new Date(Number.NaN),
      end: valid ? end : new Date(Number.NaN),
      valid,
      label: `Custom Range: ${customStart} to ${customEnd}`,
    };
  }, [timeFilter, customStart, customEnd]);

  // Precise filtering of orders and payouts
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const od = orderTimestamp(o);
      return od >= dateRange.start && od <= dateRange.end;
    });
  }, [orders, dateRange]);

  const filteredPayouts = useMemo(() => {
    return payouts.filter((p) => {
      const pd = new Date(p.date);
      return pd >= dateRange.start && pd <= dateRange.end;
    });
  }, [dateRange, payouts]);

  // Financial statistics with 100% precision
  const financialStats = useMemo(() => {
    const periodInflow = filteredOrders.reduce((sum, order) => sum + paymentsReceived(order), 0);
    const periodOrderValue = filteredOrders.reduce((sum, order) => sum + orderValue(order), 0);

    const periodRefunds = filteredOrders
      .filter((o) => o.payment === "Refunded")
      .reduce((s, o) => s + o.amount, 0);

    const periodPaidPayouts = filteredPayouts
      .filter((p) => p.status === "Paid")
      .reduce((s, p) => s + p.amount, 0);

    // This is derived from marketplace records, not a direct bank feed.
    const totalInflow = orders
      .filter((o) => o.status !== "Cancelled")
      .reduce((sum, order) => sum + paymentsReceived(order), 0);
    const totalRefunds = orders
      .filter((o) => o.payment === "Refunded")
      .reduce((s, o) => s + o.amount, 0);
    const totalPaidPayouts = payouts
      .filter((p) => p.status === "Paid")
      .reduce((s, p) => s + p.amount, 0);
    const bankBalance = totalInflow - totalRefunds - totalPaidPayouts;

    return {
      periodInflow,
      periodOrderValue,
      periodRefunds,
      periodPaidPayouts,
      bankBalance,
    };
  }, [filteredOrders, filteredPayouts, orders, payouts]);

  // Derived counts for the period
  const pendingOrders = filteredOrders.filter(
    (o) => o.status !== "Delivered" && o.status !== "Cancelled",
  ).length;
  const lowStockProducts = products
    .filter((product) => product.stock <= 0 || product.stock < (product.minimumStock ?? 30))
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name));
  const lowStockCount = lowStockProducts.length;

  const activeCustomerCount = useMemo(() => {
    const set = new Set(filteredOrders
      .filter((order) => order.customerId || order.email || order.customer)
      .map((order) => order.customerId || order.email || order.customer));
    return set.size;
  }, [filteredOrders]);

  const activeVendorCount = useMemo(() => {
    const set = new Set(filteredOrders.flatMap((o) => o.items.map((i) => i.vendorId).filter(Boolean)));
    return set.size;
  }, [filteredOrders]);

  // Dynamic Revenue Analytics Chart Data
  const dynamicSalesSeries = useMemo(() => {
    const groups = new Map<string, { revenue: number; customers: Set<string>; sortKey: number }>();
    for (const order of filteredOrders) {
      const date = orderTimestamp(order);
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
      group.revenue += paymentsReceived(order);
      if (order.customerId || order.email || order.customer) {
        group.customers.add(order.customerId || order.email || order.customer);
      }
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
      if (o.status === "Cancelled") continue;
      for (const item of o.items) {
        const cat = item.product.category || "General";
        map[cat] = (map[cat] || 0) + (item.unitPrice ?? item.product.price) * item.qty;
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
        const vOrders = filteredOrders.filter((o) => o.status !== "Cancelled" && o.items.some((i) => i.vendorId === v.id));
        const vSales = vOrders.reduce(
          (s, o) =>
            s +
            o.items
              .filter((i) => i.vendorId === v.id)
              .reduce((sum, item) => sum + (item.unitPrice ?? item.product.price) * item.qty, 0),
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
              {dateRange.valid === false
                ? "Choose an end date on or after the start date."
                : `${filteredOrders.length} orders · ${inr(financialStats.periodOrderValue)} order value · ${inr(financialStats.periodInflow)} received`}
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Lifetime Net Receipts"
          value={inr(financialStats.bankBalance)}
          delta="Recorded payments less refunds and paid payouts · not a bank feed"
          icon={Landmark}
          highlight
        />
        <StatCard
          label="Payments Received"
          value={inr(financialStats.periodInflow)}
          icon={IndianRupee}
        />
        <StatCard label="Order Value" value={inr(financialStats.periodOrderValue)} delta="Non-cancelled orders in selected range" icon={Wallet} />
        <StatCard label="Orders in Range" value={String(filteredOrders.length)} icon={ShoppingCart} />
        <StatCard label="Pending Orders in Range" value={String(pendingOrders)} icon={ShoppingCart} />
        <StatCard
          label="Customers in Range"
          value={String(activeCustomerCount)}
          delta="Unique customers with orders in range"
          icon={Users}
        />
        <StatCard
          label="Vendors in Range"
          value={String(activeVendorCount)}
          delta="Unique vendors with orders in range"
          icon={Building2}
        />
        <StatCard
          label="Low Stock Products"
          value={String(lowStockCount)}
          delta="Current inventory · independent of date range"
          icon={Package}
          highlight={lowStockCount > 0}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title={`Payments Received (${dateRange.label})`}>
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
        <Panel title={`Category Order Value (${dateRange.label})`}>
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
        <Panel title={`Customers with Orders (${dateRange.label})`}>
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
        <Panel title={`Vendor Performance · Order Value (${dateRange.label})`}>
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
            rows={[...filteredOrders]
              .sort((a, b) => orderTimestamp(b).getTime() - orderTimestamp(a).getTime())
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
          {lowStockProducts.length ? (
            <div className="max-h-[34rem] overflow-auto">
              <DataTable
                columns={["Product", "Current Stock", "Minimum Stock", "Required Stock", "Shortage"]}
                rows={lowStockProducts.map((product) => {
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
            </div>
          ) : (
            <div className="grid min-h-36 place-items-center text-center">
              <div>
                <p className="font-semibold text-navy">Stock levels look healthy</p>
                <p className="mt-1 text-sm text-slate">No products are out of stock or below their reorder level.</p>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </PanelLayout>
  );
}
