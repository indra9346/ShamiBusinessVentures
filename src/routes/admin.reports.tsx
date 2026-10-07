import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, FileBarChart, IndianRupee, Package, ShoppingCart, Users } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { inr } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { downloadCSV } from "@/lib/export-utils";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({
    meta: [
      { title: "Reports & Analytics | Shami Business Ventures Admin" },
      {
        name: "description",
        content: "Revenue, order, vendor and category reports for the Shami marketplace.",
      },
      { property: "og:title", content: "Reports & Analytics | Shami Admin" },
      {
        property: "og:description",
        content: "Business intelligence for the marketplace control centre.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminReports,
});

const PIE_COLORS = [
  "#0B2341",
  "#C99A2E",
  "#1B3B60",
  "#E0B84A",
  "#2F5480",
  "#8A6A1C",
  "#4A6E99",
  "#D8C48C",
  "#132C4C",
  "#B08A3E",
];

function AdminReports() {
  const { orders, products, customers, vendors } = useApp();
  const [range, setRange] = useState("This Month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [reportType, setReportType] = useState("Revenue");

  const filteredOrders = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    if (range === "Yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    } else if (range === "This Week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    else if (range === "This Month") start.setDate(1);
    else if (range === "Last 7 days") start.setDate(start.getDate() - 6);
    else if (range === "Last 30 days") start.setDate(start.getDate() - 29);
    else if (range === "Custom") {
      if (customStart) start.setTime(new Date(`${customStart}T00:00:00`).getTime());
      if (customEnd) end.setTime(new Date(`${customEnd}T23:59:59`).getTime());
    }
    const lower = start.getTime();
    const upper =
      range === "Yesterday"
        ? new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59).getTime()
        : range === "Custom" && customEnd
          ? end.getTime()
          : now.getTime();
    return orders.filter((order) => {
      const date = new Date(order.date).getTime();
      return Number.isFinite(date) && date >= lower && date <= upper;
    });
  }, [orders, range, customStart, customEnd]);

  const reportSeries = useMemo(() => {
    const byDay = new Map<
      string,
      { month: string; revenue: number; orders: number; customers: Set<string> }
    >();
    for (const order of filteredOrders) {
      const date = new Date(order.date);
      const key = date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
      const point = byDay.get(key) ?? {
        month: key,
        revenue: 0,
        orders: 0,
        customers: new Set<string>(),
      };
      if (order.payment !== "Refunded" && order.status !== "Cancelled")
        point.revenue += order.amount;
      point.orders += 1;
      point.customers.add(order.customerId);
      byDay.set(key, point);
    }
    return [...byDay.values()].map((point) => ({
      month: point.month,
      revenue: point.revenue,
      orders: point.orders,
      customers: point.customers.size,
    }));
  }, [filteredOrders]);

  const categoryData = useMemo(() => {
    const totals = new Map<string, number>();
    for (const order of filteredOrders)
      for (const item of order.items)
        totals.set(
          item.product.category,
          (totals.get(item.product.category) ?? 0) +
            (item.unitPrice ?? item.product.price) * item.qty,
        );
    const grandTotal = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
    return [...totals].map(([name, value]) => ({
      name,
      value: grandTotal ? Math.round((value * 100) / grandTotal) : 0,
    }));
  }, [filteredOrders]);

  const stats = useMemo(() => {
    const live = filteredOrders.filter((o) => o.status !== "Cancelled");
    const revenue = live.reduce((s, o) => s + o.amount, 0);
    const gst = live.reduce((s, o) => s + o.tax, 0);
    const aov = live.length ? Math.round(revenue / live.length) : 0;
    const units = live.reduce((s, o) => s + o.items.reduce((t, i) => t + i.qty, 0), 0);
    return { revenue, gst, aov, units, count: live.length };
  }, [filteredOrders]);

  const topProducts = useMemo(
    () =>
      products
        .map((product) => {
          const sold = filteredOrders.reduce(
            (sum, order) =>
              sum +
              order.items
                .filter((item) => item.product.id === product.id)
                .reduce((qty, item) => qty + item.qty, 0),
            0,
          );
          return { ...product, sold };
        })
        .sort((a, b) => b.sold - a.sold)
        .slice(0, 10),
    [products, filteredOrders],
  );

  const vendorRows = useMemo(
    () =>
      vendors
        .map((v) => {
          const vOrders = filteredOrders.filter((o) => o.items.some((i) => i.vendorId === v.id));
          const revenue = vOrders.reduce(
            (s, o) =>
              s +
              o.items
                .filter((i) => i.vendorId === v.id)
                .reduce((t, i) => t + i.product.price * i.qty, 0),
            0,
          );
          return {
            v,
            orders: vOrders.length,
            revenue,
            commission: Math.round((revenue * Number(v.commission ?? 8)) / 100),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    [filteredOrders, vendors],
  );

  const handleExportMainReport = () => {
    downloadCSV(
      `${reportType}_Report_${range.replace(/\s+/g, "_")}`,
      ["Month", "Net Revenue (INR)", "Orders Count", "Customers Count"],
      reportSeries.map((s) => [s.month, s.revenue, s.orders, s.customers]),
    );
  };

  const handleExportOrdersVsCustomers = () => {
    downloadCSV(
      "Orders_vs_Customers_Report",
      ["Month", "Orders", "Registered Customers", "Revenue (INR)"],
      reportSeries.map((s) => [s.month, s.orders, s.customers, s.revenue]),
    );
  };

  const handleExportTopProducts = () => {
    downloadCSV(
      "Top_Selling_Products",
      ["Product Name", "SKU", "Units Sold", "Unit Price (INR)", "Total Revenue (INR)"],
      topProducts.map((p) => [p.name, p.sku, p.sold, p.price, p.price * p.sold]),
    );
  };

  const handleExportVendorPerformance = () => {
    downloadCSV(
      "Vendor_Performance_Report",
      [
        "Vendor Business Name",
        "Location / City",
        "Completed Orders",
        "Gross Sales (INR)",
        "Commission Rate",
        "Commission Earned (INR)",
      ],
      vendorRows.map((r) => [
        r.v.business,
        r.v.city,
        r.orders,
        r.revenue,
        `${r.v.commission}%`,
        r.commission,
      ]),
    );
  };

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Reports & Analytics"
      subtitle="Marketplace performance intelligence"
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              "Today",
              "Yesterday",
              "This Week",
              "This Month",
              "Last 7 days",
              "Last 30 days",
              "Custom",
            ].map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {range === "Custom" && (
          <>
            <Input
              aria-label="Report start date"
              type="date"
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
              className="w-auto"
            />
            <Input
              aria-label="Report end date"
              type="date"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
              className="w-auto"
            />
          </>
        )}
        <Select value={reportType} onValueChange={setReportType}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["Revenue", "Orders", "Customers"].map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="bg-navy text-white hover:bg-navy/90" onClick={handleExportMainReport}>
          <Download className="mr-1 h-4 w-4" /> Export Report
        </Button>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Net Revenue"
          value={inr(stats.revenue)}
          icon={IndianRupee}
          delta="+14.2%"
          highlight
        />
        <StatCard label="GST Collected" value={inr(stats.gst)} icon={FileBarChart} delta="+11.8%" />
        <StatCard
          label="Average Order Value"
          value={inr(stats.aov)}
          icon={ShoppingCart}
          delta="+3.6%"
        />
        <StatCard label="Units Shipped" value={String(stats.units)} icon={Package} delta="+8.4%" />
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title={`${reportType} Trend — ${range}`}>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={reportSeries}>
                <defs>
                  <linearGradient id="repGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#C99A2E" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#C99A2E" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E6E3DC" />
                <XAxis dataKey="month" stroke="#6B7A8F" fontSize={12} />
                <YAxis
                  stroke="#6B7A8F"
                  fontSize={12}
                  tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  formatter={(v: number) => (reportType === "Revenue" ? inr(v) : String(v))}
                />
                <Area
                  type="monotone"
                  dataKey={
                    reportType === "Revenue"
                      ? "revenue"
                      : reportType === "Orders"
                        ? "orders"
                        : "customers"
                  }
                  stroke="#0B2341"
                  strokeWidth={2}
                  fill="url(#repGold)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Category Share">
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={categoryData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={55}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {categoryData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => `${v}%`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Panel
          title="Orders vs Customers"
          action={
            <Button variant="outline" size="sm" onClick={handleExportOrdersVsCustomers}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          }
        >
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={reportSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E6E3DC" />
                <XAxis dataKey="month" stroke="#6B7A8F" fontSize={12} />
                <YAxis stroke="#6B7A8F" fontSize={12} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="orders" fill="#0B2341" radius={[4, 4, 0, 0]} />
                <Bar dataKey="customers" fill="#C99A2E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel
          title="Best Selling Products"
          action={
            <Button variant="outline" size="sm" onClick={handleExportTopProducts}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          }
        >
          <DataTable
            columns={["Product", "SKU", "Sold", "Price", "Revenue"]}
            rows={topProducts.map((p) => [
              <span className="font-semibold text-navy">{p.name}</span>,
              <span className="text-xs text-slate">{p.sku}</span>,
              String(p.sold),
              inr(p.price),
              <span className="font-semibold text-navy">{inr(p.price * p.sold)}</span>,
            ])}
          />
        </Panel>
      </div>

      <Panel
        title="Vendor Performance"
        action={
          <Button variant="outline" size="sm" onClick={handleExportVendorPerformance}>
            <Download className="mr-1 h-3.5 w-3.5" /> CSV
          </Button>
        }
      >
        <DataTable
          columns={["Vendor", "City", "Orders", "Revenue", "Commission", "Rate"]}
          rows={vendorRows.map((r) => [
            <span className="font-semibold text-navy">{r.v.business}</span>,
            r.v.city,
            String(r.orders),
            <span className="font-semibold text-navy">{inr(r.revenue)}</span>,
            inr(r.commission),
            `${r.v.commission}%`,
          ])}
        />
      </Panel>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active Vendors"
          value={String(
            vendors.filter((v) => v.status === "active" || v.status === "Active").length,
          )}
          icon={Users}
        />
        <StatCard label="Registered Customers" value={String(customers.length)} icon={Users} />
        <StatCard label="Catalogue Size" value={String(products.length)} icon={Package} />
        <StatCard label="Completed Orders" value={String(stats.count)} icon={ShoppingCart} />
      </div>
    </PanelLayout>
  );
}
