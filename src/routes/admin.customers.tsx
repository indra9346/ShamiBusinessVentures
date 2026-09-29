import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, IndianRupee, ShieldCheck, Users, UserX } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { downloadCSV } from "@/lib/export-utils";

export const Route = createFileRoute("/admin/customers")({
  head: () => ({
    meta: [
      { title: "Customers | Shami Business Ventures Admin" },
      { name: "description", content: "Manage every registered customer on the Shami marketplace." },
      { property: "og:title", content: "Customer Management | Shami Admin" },
      { property: "og:description", content: "Search, filter and manage customer accounts." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminCustomers,
});

const PAGE_SIZE = 12;

function AdminCustomers() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/admin/customers" && pathname !== "/admin/customers/") {
    return <Outlet />;
  }

  const { customers, setCustomerStatus } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [city, setCity] = useState("all");
  const [sort, setSort] = useState("spend-desc");
  const [page, setPage] = useState(1);

  const cities = useMemo(() => Array.from(new Set(customers.map((c) => c.city))), [customers]);

  const filtered = useMemo(() => {
    let list = customers.filter((c) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s) || c.phone.includes(s);
      const matchesStatus = status === "all" || c.status === status;
      const matchesCity = city === "all" || c.city === city;
      return matchesQ && matchesStatus && matchesCity;
    });
    list = [...list].sort((a, b) => {
      if (sort === "spend-desc") return b.spend - a.spend;
      if (sort === "orders-desc") return b.orders - a.orders;
      if (sort === "joined-desc") return b.joined.localeCompare(a.joined);
      return 0;
    });
    return list;
  }, [customers, q, status, city, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const active = customers.filter((c) => c.status === "active").length;
  const blocked = customers.filter((c) => c.status === "blocked").length;
  const totalSpend = customers.reduce((s, c) => s + c.spend, 0);

  const handleExportCustomers = () => {
    downloadCSV(
      "Customers_List",
      ["Customer ID", "Name", "Email", "Phone", "City", "State", "GSTIN", "Total Orders", "Lifetime Spend (INR)", "Status", "Joined Date"],
      filtered.map((c) => [
        c.id,
        c.name,
        c.email,
        c.phone,
        c.city,
        c.state,
        c.gst,
        c.orders,
        c.spend,
        c.status,
        c.joined,
      ])
    );
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Customers" subtitle="Every buyer registered on the platform">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Customers" value={String(customers.length)} icon={Users} highlight />
        <StatCard label="Active" value={String(active)} icon={ShieldCheck} />
        <StatCard label="Blocked" value={String(blocked)} icon={UserX} />
        <StatCard label="Lifetime Spend" value={inr(totalSpend)} icon={IndianRupee} />
      </div>

      <Panel
        title="All Customers"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCustomers}
              className="h-9 hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
            <Input placeholder="Search name, email, phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="h-9 w-56" />
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-32"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="blocked">Blocked</SelectItem>
              </SelectContent>
            </Select>
            <Select value={city} onValueChange={(v) => { setCity(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="City" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Cities</SelectItem>
                {cities.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="spend-desc">Spend: High to Low</SelectItem>
                <SelectItem value="orders-desc">Orders: High to Low</SelectItem>
                <SelectItem value="joined-desc">Newest Joined</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Customer", "Contact", "Location", "Joined", "Orders", "Spend", "Last Order", "Status", "Actions"]}
          rows={rows.map((c) => [
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-navy/10 text-xs font-bold text-navy">{c.avatar}</span>
              <Link to="/admin/customers/$id" params={{ id: c.id }} className="font-medium text-navy hover:text-gold">{c.name}</Link>
            </div>,
            <div><p className="text-charcoal">{c.email}</p><p className="text-xs text-slate">{c.phone}</p></div>,
            `${c.city}, ${c.state}`,
            c.joined,
            c.orders,
            inr(c.spend),
            c.lastOrder,
            <StatusBadge status={c.status} />,
            <div className="flex flex-wrap items-center gap-1.5">
              <Link to="/admin/customers/$id" params={{ id: c.id }}>
                <Button variant="outline" size="sm">View</Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const next = c.status === "blocked" ? "active" : "blocked";
                  setCustomerStatus(c.id, next);
                  toast.success(`${c.name} ${next === "blocked" ? "blocked" : "unblocked"}`);
                }}
              >
                {c.status === "blocked" ? "Unblock" : "Block"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => toast.success(`Email sent to ${c.email}`)}>Email</Button>
            </div>,
          ])}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>
    </PanelLayout>
  );
}
