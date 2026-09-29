import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Building2, CheckCircle2, Download, IndianRupee, XCircle } from "lucide-react";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/admin/vendors")({
  head: () => ({
    meta: [
      { title: "Vendors | Shami Business Ventures Admin" },
      { name: "description", content: "Approve, suspend and manage every vendor on the Shami marketplace." },
      { property: "og:title", content: "Vendor Management | Shami Admin" },
      { property: "og:description", content: "Vendor onboarding, performance and status control." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminVendors,
});

const PAGE_SIZE = 10;

function AdminVendors() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/admin/vendors" && pathname !== "/admin/vendors/") {
    return <Outlet />;
  }

  const { vendors, setVendorStatus } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("sales-desc");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let list = vendors.filter((v) => {
      const s = q.trim().toLowerCase();
      const matchesQ = !s || v.business.toLowerCase().includes(s) || v.owner.toLowerCase().includes(s) || v.email.toLowerCase().includes(s);
      const matchesStatus = status === "all" || v.status === status;
      return matchesQ && matchesStatus;
    });
    list = [...list].sort((a, b) => {
      if (sort === "sales-desc") return b.sales - a.sales;
      if (sort === "orders-desc") return b.orders - a.orders;
      if (sort === "rating-desc") return b.rating - a.rating;
      return 0;
    });
    return list;
  }, [vendors, q, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pages);
  const rows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const approved = vendors.filter((v) => v.status === "approved").length;
  const pending = vendors.filter((v) => v.status === "pending").length;
  const totalSales = vendors.reduce((s, v) => s + v.sales, 0);

  const handleExportVendors = () => {
    downloadCSV(
      "Vendors_List",
      ["Vendor ID", "Business Name", "Owner", "Email", "Phone", "City", "GSTIN", "Products Count", "Orders Count", "Sales (INR)", "Commission Rate", "Rating", "Status", "Joined Date"],
      filtered.map((v) => [
        v.id,
        v.business,
        v.owner,
        v.email,
        v.phone,
        v.city,
        v.gst,
        v.products,
        v.orders,
        v.sales,
        `${v.commission}%`,
        v.rating,
        v.status,
        v.joined,
      ])
    );
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Vendors" subtitle="Marketplace seller network">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Vendors" value={String(vendors.length)} icon={Building2} highlight />
        <StatCard label="Approved" value={String(approved)} icon={CheckCircle2} />
        <StatCard label="Pending Approval" value={String(pending)} icon={XCircle} />
        <StatCard label="Total Sales" value={inr(totalSales)} icon={IndianRupee} />
      </div>

      <Panel
        title="All Vendors"
        className="mt-6"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportVendors}
              className="h-9 hover:border-gold hover:text-gold transition-colors"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
            <Input placeholder="Search business, owner, email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="h-9 w-56" />
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sales-desc">Sales: High to Low</SelectItem>
                <SelectItem value="orders-desc">Orders: High to Low</SelectItem>
                <SelectItem value="rating-desc">Rating: High to Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Vendor", "Owner", "Contact", "City", "GST", "Products", "Orders", "Revenue", "Commission", "Rating", "Joined", "Status", "Actions"]}
          rows={rows.map((v) => [
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-navy/10 text-xs font-bold text-navy">
                {v.business.split(" ").map((w) => w[0]).slice(0, 2).join("")}
              </span>
              <span className="font-medium text-navy">{v.business}</span>
            </div>,
            v.owner,
            <div><p className="text-charcoal">{v.email}</p><p className="text-xs text-slate">{v.phone}</p></div>,
            v.city,
            v.gst,
            v.products,
            v.orders,
            inr(v.sales),
            `${v.commission}%`,
            `${v.rating}★`,
            v.joined,
            <StatusBadge status={v.status} />,
            <div className="flex flex-wrap items-center gap-1.5">
              <Link to="/admin/vendors/$id" params={{ id: v.id }}>
                <Button variant="outline" size="sm">View</Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                disabled={v.status === "approved"}
                onClick={() => { setVendorStatus(v.id, "approved"); toast.success(`${v.business} approved`); }}
              >
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={v.status === "pending"}
                onClick={() => { setVendorStatus(v.id, "pending"); toast.success(`${v.business} marked pending / rejected`); }}
              >
                Reject
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={v.status === "suspended"}>Suspend</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Suspend {v.business}?</AlertDialogTitle>
                    <AlertDialogDescription>This vendor's listings will be hidden until reinstated.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => { setVendorStatus(v.id, "suspended"); toast.success(`${v.business} suspended`); }}>
                      Suspend
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>,
          ])}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>
    </PanelLayout>
  );
}
