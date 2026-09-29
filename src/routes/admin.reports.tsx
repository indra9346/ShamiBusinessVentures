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
import { categorySales, inr, salesSeries } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { downloadCSV } from "@/lib/export-utils";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({
    meta: [
      { title: "Reports & Analytics | Shami Business Ventures Admin" },
      { name: "description", content: "Revenue, order, vendor and category reports for the Shami marketplace." },
      { property: "og:title", content: "Reports & Analytics | Shami Admin" },
      { property: "og:description", content: "Business intelligence for the marketplace control centre." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminReports,
});

const PIE_COLORS = ["#0B2341", "#C99A2E", "#1B3B60", "#E0B84A", "#2F5480", "#8A6A1C", "#4A6E99", "#D8C48C", "#132C4C", "#B08A3E"];

function AdminReports() {
  const { orders, products, customers, vendors } = useApp();
  const [range, setRange] = useState("Last 8 months");
  const [reportType, setReportType] = useState("Revenue");

  const stats = useMemo(() => {
    const live = orders.filter((o) => o.status !== "Cancelled");
    const revenue = live.reduce((s, o) => s + o.amount, 0);
    const gst = live.reduce((s, o) => s + o.tax, 0);
    const aov = live.length ? Math.round(revenue / live.length) : 0;
    const units = live.reduce((s, o) => s + o.items.reduce((t, i) => t + i.qty, 0), 0);
    return { revenue, gst, aov, units, count: live.length };
  }, [orders]);

  const topProducts = useMemo(
    () => [...products].sort((a, b) => b.sold - a.sold).slice(0, 10),
    [products],
  );

  const vendorRows = useMemo(
    () =>
      vendors
        .map((v) => {
          const vOrders = orders.filter((o) => o.items.some((i) => i.vendorId === v.id));
          const revenue = vOrders.reduce(
            (s, o) => s + o.items.filter((i) => i.vendorId === v.id).reduce((t, i) => t + i.product.price * i.qty, 0),
            0,
          );
          return { v, orders: vOrders.length, revenue, commission: Math.round((revenue * Number(v.commission ?? 8)) / 100) };
        })
        .sort((a, b) => b.revenue - a.revenue),
    [orders, vendors],
  );

  const handleExportMainReport = () => {
    downloadCSV(
      `${reportType}_Report_${range.replace(/\s+/g, "_")}`,
      ["Month", "Net Revenue (INR)", "Orders Count", "Customers Count"],
      salesSeries.map((s) => [s.month, s.revenue, s.orders, s.customers])
    );
  };

  const handleExportOrdersVsCustomers = () => {
    downloadCSV(
      "Orders_vs_Customers_Report",
      ["Month", "Orders", "Registered Customers", "Revenue (INR)"],
      salesSeries.map((s) => [s.month, s.orders, s.customers, s.revenue])
    );
  };

  const handleExportTopProducts = () => {
    downloadCSV(
      "Top_Selling_Products",
      ["Product Name", "SKU", "Units Sold", "Unit Price (INR)", "Total Revenue (INR)"],
      topProducts.map((p) => [p.name, p.sku, p.sold, p.price, p.price * p.sold])
    );
  };

  const handleExportVendorPerformance = () => {
    downloadCSV(
      "Vendor_Performance_Report",
      ["Vendor Business Name", "Location / City", "Completed Orders", "Gross Sales (INR)", "Commission Rate", "Commission Earned (INR)"],
      vendorRows.map((r) => [r.v.business, r.v.city, r.orders, r.revenue, `${r.v.commission}%`, r.commission])
    );
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Reports & Analytics" subtitle="Marketplace performance intelligence">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["Last 7 days", "Last 30 days", "Last 8 months", "This financial year"].map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={reportType} onValueChange={setReportType}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["Revenue", "Orders", "Customers"].map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="bg-navy text-white hover:bg-navy/90" onClick={handleExportMainReport}>
          <Download className="mr-1 h-4 w-4" /> Export Report
        </Button>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Net Revenue" value={inr(stats.revenue)} icon={IndianRupee} delta="+14.2%" highlight />
        <StatCard label="GST Collected" value={inr(stats.gst)} icon={FileBarChart} delta="+11.8%" />
        <StatCard label="Average Order Value" value={inr(stats.aov)} icon={ShoppingCart} delta="+3.6%" />
        <StatCard label="Units Shipped" value={String(stats.units)} icon={Package} delta="+8.4%" />
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title={`${reportType} Trend — ${range}`}>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesSeries}>
                <defs>
                  <linearGradient id="repGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#C99A2E" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#C99A2E" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E6E3DC" />
                <XAxis dataKey="month" stroke="#6B7A8F" fontSize={12} />
                <YAxis stroke="#6B7A8F" fontSize={12} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v: number) => (reportType === "Revenue" ? inr(v) : String(v))} />
                <Area
                  type="monotone"
                  dataKey={reportType === "Revenue" ? "revenue" : reportType === "Orders" ? "orders" : "customers"}
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
                <Pie data={categorySales} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                  {categorySales.map((_, i) => (
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
        <Panel title="Orders vs Customers" action={<Button variant="outline" size="sm" onClick={handleExportOrdersVsCustomers}><Download className="mr-1 h-3.5 w-3.5" /> CSV</Button>}>
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={salesSeries}>
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

        <Panel title="Best Selling Products" action={<Button variant="outline" size="sm" onClick={handleExportTopProducts}><Download className="mr-1 h-3.5 w-3.5" /> CSV</Button>}>
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
        <StatCard label="Active Vendors" value={String(vendors.filter((v) => v.status === "active" || v.status === "Active").length)} icon={Users} />
        <StatCard label="Registered Customers" value={String(customers.length)} icon={Users} />
        <StatCard label="Catalogue Size" value={String(products.length)} icon={Package} />
        <StatCard label="Completed Orders" value={String(stats.count)} icon={ShoppingCart} />
      </div>
    </PanelLayout>
  );
}
