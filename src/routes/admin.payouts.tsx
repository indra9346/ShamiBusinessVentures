import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock, IndianRupee, Loader } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr, payouts as seedPayouts, vendors } from "@/lib/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/payouts")({
  head: () => ({
    meta: [
      { title: "Payouts | Shami Business Ventures Admin" },
      { name: "description", content: "Manage and track vendor payouts and settlement status." },
      { property: "og:title", content: "Payouts | Shami Admin" },
      { property: "og:description", content: "Vendor payout processing." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPayouts,
});

function AdminPayouts() {
  const [payouts, setPayouts] = useState(() => seedPayouts.map((p) => ({ ...p })));
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [view, setView] = useState<(typeof payouts)[number] | null>(null);

  const stats = useMemo(() => {
    const paid = payouts.filter((p) => p.status === "Paid").reduce((s, p) => s + p.amount, 0);
    const processing = payouts.filter((p) => p.status === "Processing").reduce((s, p) => s + p.amount, 0);
    const pending = payouts.filter((p) => p.status === "Pending").reduce((s, p) => s + p.amount, 0);
    const total = payouts.reduce((s, p) => s + p.amount, 0);
    return { paid, processing, pending, total };
  }, [payouts]);

  const filtered = useMemo(
    () =>
      payouts.filter((p) => {
        const matchSearch = [p.id, p.vendor].some((v) => v.toLowerCase().includes(search.toLowerCase()));
        const matchStatus = status === "All" || p.status === status;
        return matchSearch && matchStatus;
      }),
    [payouts, search, status],
  );

  const markPaid = (id: string) => {
    setPayouts((l) => l.map((p) => (p.id === id ? { ...p, status: "Paid" } : p)));
    toast.success(`Payout ${id} marked as paid`);
  };
  const process = (id: string) => {
    setPayouts((l) => l.map((p) => (p.id === id ? { ...p, status: "Processing" } : p)));
    toast.success(`Payout ${id} sent for processing`);
  };

  const vendorInfo = view ? vendors.find((v) => v.id === view.vendorId) : undefined;

  return (
    <PanelLayout items={adminNav} tone="admin" title="Payouts" subtitle="Vendor settlement and payout tracking">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paid" value={inr(stats.paid)} icon={CheckCircle2} />
        <StatCard label="Processing" value={inr(stats.processing)} icon={Loader} />
        <StatCard label="Pending" value={inr(stats.pending)} icon={Clock} highlight />
        <StatCard label="Total Payouts" value={inr(stats.total)} icon={IndianRupee} />
      </div>

      <Panel
        title="Payout Requests"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search payout/vendor" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-56" />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Status</SelectItem>
                <SelectItem value="Paid">Paid</SelectItem>
                <SelectItem value="Processing">Processing</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Payout ID", "Vendor", "Date", "Amount", "Method", "Status", "Actions"]}
          rows={filtered.map((p) => [
            <span className="font-semibold text-navy">{p.id}</span>,
            p.vendor,
            p.date,
            inr(p.amount),
            p.method,
            <StatusBadge status={p.status} />,
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setView(p)}>View</Button>
              {p.status === "Pending" && <Button size="sm" variant="outline" onClick={() => process(p.id)}>Process</Button>}
              {p.status !== "Paid" && <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={() => markPaid(p.id)}>Mark as Paid</Button>}
            </div>,
          ])}
        />
      </Panel>

      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Payout {view?.id}</DialogTitle></DialogHeader>
          {view && (
            <div className="grid gap-2 text-sm text-charcoal">
              <div className="flex justify-between"><span className="text-slate">Vendor</span><span className="font-semibold text-navy">{view.vendor}</span></div>
              <div className="flex justify-between"><span className="text-slate">Amount</span><span className="font-semibold">{inr(view.amount)}</span></div>
              <div className="flex justify-between"><span className="text-slate">Method</span><span>{view.method}</span></div>
              <div className="flex justify-between"><span className="text-slate">Status</span><StatusBadge status={view.status} /></div>
              <div className="flex justify-between"><span className="text-slate">Date</span><span>{view.date}</span></div>
              <hr className="my-1 border-border" />
              <p className="text-xs font-bold uppercase tracking-wide text-slate">Bank Details</p>
              <div className="flex justify-between"><span className="text-slate">Account</span><span>{vendorInfo?.bank ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-slate">GSTIN</span><span>{vendorInfo?.gst ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-slate">City</span><span>{vendorInfo?.city ?? "—"}</span></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
