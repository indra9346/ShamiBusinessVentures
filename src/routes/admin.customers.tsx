import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, IndianRupee, Mail, ShieldCheck, Users, UserX } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { Pager } from "@/components/panel/pager";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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
const MAX_BCC_RECIPIENTS = 25;

const hasEmailAddress = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

function AdminCustomers() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname !== "/admin/customers" && pathname !== "/admin/customers/") {
    return <Outlet />;
  }
  return <AdminCustomersPanel />;
}

function AdminCustomersPanel() {
  const { customers, setCustomerStatus } = useApp();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [city, setCity] = useState("all");
  const [sort, setSort] = useState("spend-desc");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

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
  const selectablePage = rows.filter((customer) => hasEmailAddress(customer.email));
  const selectedCustomers = customers.filter((customer) => selectedIds.has(customer.id));
  const selectedEmails = Array.from(
    new Map(
      selectedCustomers
        .map((customer) => customer.email.trim())
        .filter(hasEmailAddress)
        .map((email) => [email.toLowerCase(), email] as const),
    ).values(),
  );
  const allPageSelected =
    selectablePage.length > 0 && selectablePage.every((customer) => selectedIds.has(customer.id));

  const togglePageSelection = () => {
    if (allPageSelected) {
      setSelectedIds((current) => {
        const next = new Set(current);
        selectablePage.forEach((customer) => next.delete(customer.id));
        return next;
      });
      return;
    }

    const knownAddresses = new Set(selectedEmails.map((email) => email.toLowerCase()));
    const newRecipients = selectablePage.filter((customer) => {
      const address = customer.email.trim().toLowerCase();
      if (selectedIds.has(customer.id) || knownAddresses.has(address)) return false;
      knownAddresses.add(address);
      return true;
    });
    const capacity = Math.max(0, MAX_BCC_RECIPIENTS - selectedEmails.length);
    const recipientsToAdd = newRecipients.slice(0, capacity);
    if (recipientsToAdd.length < newRecipients.length) {
      toast.info(`Email drafts are limited to ${MAX_BCC_RECIPIENTS} recipients. Clear some selections first.`);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      recipientsToAdd.forEach((customer) => next.add(customer.id));
      return next;
    });
  };

  const toggleCustomerSelection = (customerId: string, checked: boolean) => {
    const customer = customers.find((item) => item.id === customerId);
    if (checked && customer && hasEmailAddress(customer.email)) {
      const isNewAddress = !selectedEmails.some(
        (email) => email.toLowerCase() === customer.email.trim().toLowerCase(),
      );
      if (isNewAddress && selectedEmails.length >= MAX_BCC_RECIPIENTS) {
        toast.error(`Email drafts are limited to ${MAX_BCC_RECIPIENTS} recipients.`);
        return;
      }
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(customerId);
      else next.delete(customerId);
      return next;
    });
  };

  const draftBulkEmail = () => {
    if (selectedEmails.length < 2) {
      toast.error("Select at least two customers with valid email addresses.");
      return;
    }
    if (selectedEmails.length > MAX_BCC_RECIPIENTS) {
      toast.error(`Select no more than ${MAX_BCC_RECIPIENTS} customers for one email draft.`);
      return;
    }

    // BCC keeps recipients' addresses private. Sending still happens in the admin's email app.
    window.location.href = `mailto:?bcc=${encodeURIComponent(selectedEmails.join(","))}`;
  };

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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-ivory/70 p-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-navy">
              {selectedEmails.length} customer{selectedEmails.length === 1 ? "" : "s"} selected
            </p>
            <p className="mt-1 text-xs text-slate">
              Bulk email opens your email app with recipients in BCC; review and send it there.
              Select up to {MAX_BCC_RECIPIENTS} customers per draft.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={togglePageSelection} disabled={!selectablePage.length}>
              {allPageSelected ? "Clear page selection" : `Select this page (${selectablePage.length})`}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())} disabled={!selectedIds.size}>
              Clear all
            </Button>
            <Button size="sm" onClick={draftBulkEmail} disabled={selectedEmails.length < 2 || selectedEmails.length > MAX_BCC_RECIPIENTS}>
              <Mail className="mr-1.5 h-4 w-4" /> Draft email (BCC)
            </Button>
          </div>
        </div>
        <DataTable
          columns={["Select", "Customer", "Contact", "Location", "Joined", "Orders", "Spend", "Last Order", "Status", "Actions"]}
          rows={rows.map((c) => [
            <Checkbox
              checked={selectedIds.has(c.id)}
              onCheckedChange={(checked) => toggleCustomerSelection(c.id, checked === true)}
              disabled={!hasEmailAddress(c.email)}
              aria-label={`Select ${c.name} for bulk email`}
            />,
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
                  void setCustomerStatus(c.id, next).then((ok) => { if (ok) toast.success(`${c.name} ${next === "blocked" ? "blocked" : "unblocked"}`); });
                }}
              >
                {c.status === "blocked" ? "Unblock" : "Block"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { window.location.href = `mailto:${encodeURIComponent(c.email)}`; }}>Email</Button>
            </div>,
          ])}
        />
        <Pager page={pageSafe} pages={pages} onPage={setPage} total={filtered.length} />
      </Panel>
    </PanelLayout>
  );
}
