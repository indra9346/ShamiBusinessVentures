import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock, IndianRupee, RotateCcw, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/payments")({
  head: () => ({
    meta: [
      { title: "Payments | Shami Business Ventures Admin" },
      { name: "description", content: "Track transactions, refunds and payment status across the marketplace." },
      { property: "og:title", content: "Payments | Shami Admin" },
      { property: "og:description", content: "Transaction ledger and payment operations." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPayments,
});

const PAGE_SIZE = 10;

function AdminPayments() {
  const { orders, refundOrder } = useApp();

  const txns = useMemo(
    () =>
      orders.map((o) => ({
        txn: o.txn,
        order: o.id,
        customer: o.customer,
        vendor: o.items[0]!.vendor,
        amount: o.amount,
        method: o.method,
        date: o.date,
        status:
          o.payment === "Paid" ? "Successful" : o.payment === "Pending" || o.payment === "COD" ? "Pending" : o.payment === "Refunded" ? "Refunded" : "Failed",
        refund: o.payment === "Refunded" ? "Refunded to source" : "—",
      })),
    [orders],
  );

  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("All");
  const [status, setStatus] = useState("All");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<(typeof txns)[number] | null>(null);

  const stats = useMemo(() => {
    const collected = txns.filter((t) => t.status === "Successful").reduce((s, t) => s + t.amount, 0);
    const pending = txns.filter((t) => t.status === "Pending").reduce((s, t) => s + t.amount, 0);
    const failed = txns.filter((t) => t.status === "Failed").length;
    const refunded = txns.filter((t) => t.status === "Refunded").reduce((s, t) => s + t.amount, 0);
    return { collected, pending, failed, refunded, success: txns.filter((t) => t.status === "Successful").length };
  }, [txns]);

  const methods = useMemo(() => Array.from(new Set(txns.map((t) => t.method))), [txns]);

  const filtered = useMemo(
    () =>
      txns.filter((t) => {
        const matchSearch = [t.txn, t.order, t.customer].some((v) => v.toLowerCase().includes(search.toLowerCase()));
        const matchMethod = method === "All" || t.method === method;
        const matchStatus = status === "All" || t.status === status;
        return matchSearch && matchMethod && matchStatus;
      }),
    [txns, search, method, status],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Payments" subtitle="Transaction ledger across the marketplace">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total Collected" value={inr(stats.collected)} icon={IndianRupee} highlight />
        <StatCard label="Successful" value={String(stats.success)} icon={CheckCircle2} />
        <StatCard label="Pending" value={inr(stats.pending)} icon={Clock} />
        <StatCard label="Failed" value={String(stats.failed)} icon={XCircle} />
        <StatCard label="Refunded" value={inr(stats.refunded)} icon={RotateCcw} />
      </div>

      <Panel
        title="Transactions"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Search txn/order/customer" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="h-9 w-56" />
            <Select value={method} onValueChange={(v) => { setMethod(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Methods</SelectItem>
                {methods.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All Status</SelectItem>
                <SelectItem value="Successful">Successful</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
                <SelectItem value="Failed">Failed</SelectItem>
                <SelectItem value="Refunded">Refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      >
        <DataTable
          columns={["Txn", "Order", "Customer", "Vendor", "Amount", "Method", "Status", "Date", "Actions"]}
          rows={pageItems.map((t) => [
            <span className="font-semibold text-navy">{t.txn}</span>,
            t.order,
            t.customer,
            t.vendor,
            inr(t.amount),
            t.method,
            <StatusBadge status={t.status} />,
            t.date,
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setView(t)}>View</Button>
              {t.status === "Successful" && (
                <Button size="sm" variant="outline" className="text-danger" onClick={() => { refundOrder(t.order); toast.success(`Refund initiated for ${t.order}`); }}>Refund</Button>
              )}
              {t.status === "Failed" && (
                <Button size="sm" variant="outline" onClick={() => toast.success(`Retry initiated for ${t.txn}`)}>Retry</Button>
              )}
            </div>,
          ])}
        />
        <div className="mt-4 flex items-center justify-between text-xs text-slate">
          <span>Page {page} of {totalPages} · {filtered.length} transactions</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Panel>

      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transaction {view?.txn}</DialogTitle></DialogHeader>
          {view && (
            <div className="grid gap-2 text-sm text-charcoal">
              <div className="flex justify-between"><span className="text-slate">Order</span><span className="font-semibold text-navy">{view.order}</span></div>
              <div className="flex justify-between"><span className="text-slate">Customer</span><span>{view.customer}</span></div>
              <div className="flex justify-between"><span className="text-slate">Vendor</span><span>{view.vendor}</span></div>
              <div className="flex justify-between"><span className="text-slate">Amount</span><span className="font-semibold">{inr(view.amount)}</span></div>
              <div className="flex justify-between"><span className="text-slate">Method</span><span>{view.method}</span></div>
              <div className="flex justify-between"><span className="text-slate">Status</span><StatusBadge status={view.status} /></div>
              <div className="flex justify-between"><span className="text-slate">Refund Status</span><span>{view.refund}</span></div>
              <div className="flex justify-between"><span className="text-slate">Date</span><span>{view.date}</span></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
