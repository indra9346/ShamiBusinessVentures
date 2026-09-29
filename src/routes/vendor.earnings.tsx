import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { IndianRupee, Percent, Wallet, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { inr, salesSeries } from "@/lib/data";
import { useApp, useVendorScope } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
  const commission = vendor?.commission ?? 10;

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");

  const commissionAmt = Math.round(revenue * (commission / 100));
  const netRevenue = revenue - commissionAmt;

  const pendingEarnings = useMemo(
    () =>
      vendorOrders
        .filter((o) => o.status !== "Delivered" && o.status !== "Cancelled")
        .reduce((s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0), 0),
    [vendorOrders, vendorId],
  );
  const availableEarnings = useMemo(
    () =>
      vendorOrders
        .filter((o) => o.status === "Delivered")
        .reduce((s, o) => s + o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0), 0),
    [vendorOrders, vendorId],
  );

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Earnings" subtitle="Revenue, commission and settlement summary">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Gross Revenue" value={inr(revenue)} icon={IndianRupee} highlight />
        <StatCard label="Platform Commission" value={`${inr(commissionAmt)} (${commission}%)`} icon={Percent} />
        <StatCard label="Net Revenue" value={inr(netRevenue)} icon={WalletCards} />
        <StatCard label="Available Earnings" value={inr(availableEarnings)} icon={Wallet} />
      </div>

      <Panel title="Revenue Trend" className="mt-6">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={salesSeries}>
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
            const amt = o.items.filter((i) => i.vendorId === vendorId).reduce((t, i) => t + i.product.price * i.qty, 0);
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
            <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Up to ${inr(availableEarnings)}`} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              className="bg-navy text-white hover:bg-navy/90"
              onClick={() => {
                const val = Number(amount);
                if (!val || val <= 0) {
                  toast.error("Enter a valid amount");
                  return;
                }
                if (val > availableEarnings) {
                  toast.error("Amount exceeds your available earnings");
                  return;
                }
                toast.success(`Withdrawal request of ${inr(val)} submitted`);
                setOpen(false);
                setAmount("");
              }}
            >
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
