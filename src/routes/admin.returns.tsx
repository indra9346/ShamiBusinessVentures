import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, PackageX, RotateCcw, TriangleAlert } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/returns")({
  head: () => ({
    meta: [
      { title: "Returns | Shami Business Ventures Admin" },
      { name: "description", content: "Manage return requests, approvals and refund status." },
      { property: "og:title", content: "Returns | Shami Admin" },
      { property: "og:description", content: "Returns and refund operations." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminReturns,
});

const PAGE_SIZE = 10;

function AdminReturns() {
  const { returns, setReturnStatus } = useApp();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<(typeof returns)[number] | null>(null);

  const stats = useMemo(() => {
    const requested = returns.filter((r) => r.status === "Requested").length;
    const approved = returns.filter((r) => r.status === "Approved").length;
    const completed = returns.filter((r) => r.status === "Completed").length;
    const amount = returns.reduce((s, r) => s + r.amount, 0);
    return { total: returns.length, requested, approved, completed, amount };
  }, [returns]);

  const filtered = useMemo(
    () =>
      returns.filter((r) => {
        const matchSearch = [r.id, r.order, r.customer, r.product].some((v) => v.toLowerCase().includes(search.toLowerCase()));
        const matchStatus = status === "All" || r.status === status;
        return matchSearch && matchStatus;
      }),
    [returns, search, status],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const approve = (id: string) => { setReturnStatus(id, "Approved", "Processing"); toast.success(`Return ${id} approved`); };
  const reject = (id: string) => { setReturnStatus(id, "Rejected", "Not Applicable"); toast.success(`Return ${id} rejected`); };
  const markRefunded = (id: string) => { setReturnStatus(id, "Completed", "Refunded"); toast.success(`Return ${id} marked as refunded`); };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Returns" subtitle="Return requests and refund workflow">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total Returns" value={String(stats.total)} icon={RotateCcw} />
        <StatCard label="Requested" value={String(stats.requested)} icon={TriangleAlert} highlight />
        <StatCard label="Approved" value={String(stats.approved)} icon={CheckCircle2} />
        <StatCard label="Completed" value={String(stats.completed)} icon={PackageX} />
        <StatCard label="Total Value" value={inr(stats.amount)} icon={RotateCcw} />
      </div>

      <Panel
        title="Return Requests"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search return/order/customer" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="h-9 w-60" />
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Status</SelectItem>
                <SelectItem value="Requested">Requested</SelectItem>
                <SelectItem value="Approved">Approved</SelectItem>
                <SelectItem value="Rejected">Rejected</SelectItem>
                <SelectItem value="Picked Up">Picked Up</SelectItem>
                <SelectItem value="Completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Return", "Order", "Customer", "Product", "Vendor", "Amount", "Status", "Refund", "Actions"]}
          rows={pageItems.map((r) => [
            <span className="font-semibold text-navy">{r.id}</span>,
            r.order,
            r.customer,
            r.product,
            r.vendor,
            inr(r.amount),
            <StatusBadge status={r.status} />,
            <StatusBadge status={r.refund} />,
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setView(r)}>View</Button>
              {r.status === "Requested" && <Button size="sm" variant="outline" onClick={() => approve(r.id)}>Approve</Button>}
              {r.status === "Requested" && <Button size="sm" variant="outline" className="text-danger" onClick={() => reject(r.id)}>Reject</Button>}
              {r.status === "Approved" && <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={() => markRefunded(r.id)}>Mark Refunded</Button>}
            </div>,
          ])}
        />
        <div className="mt-4 flex items-center justify-between text-xs text-slate">
          <span>Page {page} of {totalPages} · {filtered.length} returns</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Panel>

      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Return {view?.id}</DialogTitle></DialogHeader>
          {view && (
            <div className="grid gap-2 text-sm text-charcoal">
              <div className="flex justify-between"><span className="text-slate">Order</span><span className="font-semibold text-navy">{view.order}</span></div>
              <div className="flex justify-between"><span className="text-slate">Customer</span><span>{view.customer}</span></div>
              <div className="flex justify-between"><span className="text-slate">Product</span><span>{view.product}</span></div>
              <div className="flex justify-between"><span className="text-slate">Vendor</span><span>{view.vendor}</span></div>
              <div className="flex justify-between"><span className="text-slate">Reason</span><span>{view.reason}</span></div>
              <div className="flex justify-between"><span className="text-slate">Amount</span><span className="font-semibold">{inr(view.amount)}</span></div>
              <div className="flex justify-between"><span className="text-slate">Status</span><StatusBadge status={view.status} /></div>
              <div className="flex justify-between"><span className="text-slate">Refund</span><StatusBadge status={view.refund} /></div>
              <div className="flex justify-between"><span className="text-slate">Date</span><span>{view.date}</span></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
