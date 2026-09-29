import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CreditCard, IndianRupee, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { inr, payouts } from "@/lib/data";
import { useVendorScope } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/vendor/payouts")({
  head: () => ({
    meta: [
      { title: "Payouts | Shami Vendor Panel" },
      { name: "description", content: "View your settlement and payout history." },
      { property: "og:title", content: "Vendor Payouts | Shami" },
      { property: "og:description", content: "Payout history for Shami marketplace vendors." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VendorPayouts,
});

function VendorPayouts() {
  const { vendorId } = useVendorScope();
  const myPayouts = payouts.filter((p) => p.vendorId === vendorId);
  const [viewing, setViewing] = useState<(typeof payouts)[number] | null>(null);

  const total = myPayouts.reduce((s, p) => s + p.amount, 0);
  const paid = myPayouts.filter((p) => p.status === "Paid").reduce((s, p) => s + p.amount, 0);
  const pending = myPayouts.filter((p) => p.status !== "Paid").reduce((s, p) => s + p.amount, 0);

  return (
    <PanelLayout items={vendorNav} tone="vendor" title="Payouts" subtitle="Settlement history for Shami Sugar Mills">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Payouts" value={inr(total)} icon={Wallet} highlight />
        <StatCard label="Paid Out" value={inr(paid)} icon={IndianRupee} />
        <StatCard label="Pending / Processing" value={inr(pending)} icon={CreditCard} />
        <StatCard label="Payout Records" value={String(myPayouts.length)} icon={CreditCard} />
      </div>

      <Panel
        title="Payout History"
        className="mt-6"
        action={
          <Button
            size="sm"
            className="bg-navy text-white hover:bg-navy/90"
            onClick={() => toast.success("Payout request submitted for review")}
          >
            Request Payout
          </Button>
        }
      >
        <DataTable
          columns={["Payout ID", "Date", "Amount", "Method", "Status", "Actions"]}
          rows={myPayouts.map((p) => [
            <span className="font-semibold text-navy">{p.id}</span>,
            p.date,
            inr(p.amount),
            p.method,
            <StatusBadge status={p.status} />,
            <Button variant="outline" size="sm" onClick={() => setViewing(p)}>View</Button>,
          ])}
        />
      </Panel>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payout {viewing?.id}</DialogTitle>
          </DialogHeader>
          {viewing && (
            <div className="space-y-2 text-sm text-charcoal">
              <div className="flex justify-between"><span>Date</span><span className="font-semibold text-navy">{viewing.date}</span></div>
              <div className="flex justify-between"><span>Amount</span><span className="font-semibold text-navy">{inr(viewing.amount)}</span></div>
              <div className="flex justify-between"><span>Method</span><span className="font-semibold text-navy">{viewing.method}</span></div>
              <div className="flex justify-between"><span>Status</span><StatusBadge status={viewing.status} /></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
