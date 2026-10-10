import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { IndianRupee, Percent, Wallet, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { getOrderItemTotal, inr } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/vendor/earnings")({
  head: () => ({
    meta: [
      { title: "Earnings | Shami Vendor Panel" },
      { name: "description", content: "Track revenue, commission and payouts for your store." },
      { property: "og:title", content: "Vendor Earnings | Shami" },
      { property: "og:description", content: "Earnings breakdown for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorEarnings,
});

function VendorEarnings() {
  const { vendors } = useApp();
  const { vendorOrders, vendorId, revenue } = useVendorScope();
  const vendor = vendors.find((v) => v.id === vendorId);
  const commission = vendor?.commission ?? 8;

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reservedPayouts, setReservedPayouts] = useState<number | null>(null);
  const [payoutRefreshKey, setPayoutRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!vendorId) { setReservedPayouts(null); return; }
    let active = true;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const loadReservedPayouts = async () => {
      const requestRevision = ++revision;
      const { data, error } = await supabase.from("vendor_payout_requests")
        .select("amount")
        .eq("vendor_id", vendorId)
        .in("status", ["Pending", "Processing", "Paid"]);
      if (!active || requestRevision !== revision) return;
      if (error) {
        setReservedPayouts(null);
        toast.error("Could not load your payout reservations", { description: error.message });
        return;
      }
      setReservedPayouts((data ?? []).reduce((sum, payout) => sum + Number(payout.amount), 0));
    };
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadReservedPayouts(), 100);
    };
    void loadReservedPayouts();
    const channel = supabase.channel(`vendor-earnings-payouts-${vendorId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_payout_requests", filter: `vendor_id=eq.${vendorId}` }, refreshSoon)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (connectedOnce) refreshSoon();
          connectedOnce = true;
        }
      });
    return () => {
      active = false;
      ++revision;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [vendorId, payoutRefreshKey]);

  const commissionAmt = Math.round(revenue * (commission / 100) * 100) / 100;
  const netRevenue = revenue - commissionAmt;
  const revenueSeries = useMemo(() => {
    const months = new Map<string, number>();
    for (const order of vendorOrders) {
      if (order.status !== "Delivered" || order.payment !== "Paid") continue;
      const d = new Date(order.createdAt ?? order.date);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const amount = order.items.filter((i) => i.vendorId === vendorId).reduce((sum, i) => sum + getOrderItemTotal(i), 0);
      months.set(key, (months.get(key) ?? 0) + amount);
    }
    return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12)
      .map(([key, value]) => ({ month: new Date(`${key}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" }), revenue: value }));
  }, [vendorOrders, vendorId]);

  const pendingEarnings = useMemo(() => vendorOrders
    .filter((order) => order.payment === "Paid" && order.status !== "Delivered" && order.status !== "Cancelled")
    .reduce((sum, order) => sum + order.items.filter((item) => item.vendorId === vendorId).reduce((value, item) => value + getOrderItemTotal(item), 0) * (1 - commission / 100), 0),
  [vendorOrders, vendorId, commission]);
  const settledNetEarnings = useMemo(() => vendorOrders
    .filter((order) => order.payment === "Paid" && order.status === "Delivered")
    .reduce((sum, order) => sum + order.items.filter((item) => item.vendorId === vendorId).reduce((value, item) => value + getOrderItemTotal(item), 0) * (1 - commission / 100), 0),
  [vendorOrders, vendorId, commission]);
  const availableEarnings = reservedPayouts === null ? null : Math.floor(Math.max(0, settledNetEarnings - reservedPayouts) * 100) / 100;

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Earnings" subtitle="Revenue, commission and settlement summary">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paid Revenue" value={inr(revenue)} icon={IndianRupee} highlight />
        <StatCard label="Platform Commission" value={`${inr(commissionAmt)} (${commission}%)`} icon={Percent} />
        <StatCard label="Net Revenue" value={inr(netRevenue)} icon={WalletCards} />
        <StatCard label="Available Earnings" value={availableEarnings === null ? "Loading…" : inr(availableEarnings)} icon={Wallet} />
      </div>
      <p className="mt-3 text-xs text-slate">Paid revenue uses each order line’s captured price. Available earnings include only paid, delivered orders after commission and payout reservations.</p>

      <Panel title="Revenue Trend" className="mt-6">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={revenueSeries}>
              <defs>
                <linearGradient id="rev-vendor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--gold)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--gold)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" stroke="var(--slate)" fontSize={12} />
              <YAxis stroke="var(--slate)" fontSize={12} tickFormatter={(v: number) => `${v / 100000}L`} />
              <Tooltip formatter={(v: number) => inr(v)} />
              <Area type="monotone" dataKey="revenue" stroke="var(--gold)" strokeWidth={3} fill="url(#rev-vendor)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel
        title="Transactions"
        className="mt-6"
        action={
          <Button size="sm" className="bg-navy text-white hover:bg-navy/90" onClick={() => setOpen(true)}>
            Request Withdrawal
          </Button>
        }
      >
        <DataTable
          columns={["Order", "Date", "Customer", "Amount", "Payment", "Status"]}
          rows={vendorOrders.map((o) => {
            const amt = o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + getOrderItemTotal(i), 0);
            return [
              <span className="font-semibold text-navy">{o.id}</span>,
              o.date,
              o.customer,
              inr(amt),
              <StatusBadge status={o.payment} />,
              <StatusBadge status={o.status} />,
            ];
          })}
        />
      </Panel>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request Withdrawal</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label>Amount (₹)</Label>
            <Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={availableEarnings === null ? "Balance is loading" : `Up to ${inr(availableEarnings)}`} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={async () => {
                const val = Number(amount);
                if (!Number.isFinite(val) || val <= 0) {
                  toast.error("Enter a valid amount");
                  return;
                }
                if (availableEarnings === null) {
                  toast.error("Wait for your available balance to load");
                  return;
                }
                if (val > availableEarnings) {
                  toast.error("Amount exceeds your available earnings");
                  return;
                }
                setSubmitting(true);
                const { error } = await supabase.rpc("request_vendor_payout", { _amount: val, _method: "NEFT" });
                setSubmitting(false);
                if (error) { toast.error(error.message); return; }
                toast.success(`Withdrawal request of ${inr(val)} submitted for review`);
                setOpen(false);
                setAmount("");
                setPayoutRefreshKey((key) => key + 1);
              }}
              disabled={submitting || availableEarnings === null || availableEarnings <= 0}
            >
              {submitting ? "Submitting…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
