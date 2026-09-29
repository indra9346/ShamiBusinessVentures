import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IndianRupee, Percent, TrendingUp, Wallet } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/commissions")({
  head: () => ({
    meta: [
      { title: "Commissions | Shami Business Ventures Admin" },
      { name: "description", content: "Vendor commission rates, earnings and payouts breakdown." },
      { property: "og:title", content: "Commissions | Shami Admin" },
      { property: "og:description", content: "Platform commission management." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminCommissions,
});

function AdminCommissions() {
  const { vendors, setVendorStatus } = useApp();
  const [rates, setRates] = useState<Record<string, number>>(() =>
    Object.fromEntries(vendors.map((v) => [v.id, v.commission])),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [rateInput, setRateInput] = useState("");

  const rows = useMemo(
    () =>
      vendors.map((v) => {
        const pct = rates[v.id] ?? v.commission;
        const earned = Math.round(v.sales * (pct / 100));
        return { ...v, pct, earned, net: v.sales - earned };
      }),
    [vendors, rates],
  );

  const totals = useMemo(
    () => ({
      gross: rows.reduce((s, r) => s + r.sales, 0),
      earned: rows.reduce((s, r) => s + r.earned, 0),
      net: rows.reduce((s, r) => s + r.net, 0),
      avgRate: rows.length ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : 0,
    }),
    [rows],
  );

  const editingVendor = vendors.find((v) => v.id === editing);

  const openEdit = (id: string) => {
    setEditing(id);
    setRateInput(String(rates[id] ?? 0));
  };

  const save = () => {
    const val = Number(rateInput);
    if (!editingVendor || Number.isNaN(val) || val < 0 || val > 100) {
      toast.error("Enter a valid commission percentage (0-100)");
      return;
    }
    setRates((r) => ({ ...r, [editingVendor.id]: val }));
    toast.success(`Commission for ${editingVendor.business} set to ${val}%`);
    setEditing(null);
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Commissions" subtitle="Vendor commission rates and earnings">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Gross Sales" value={inr(totals.gross)} icon={IndianRupee} />
        <StatCard label="Commission Earned" value={inr(totals.earned)} icon={Percent} highlight />
        <StatCard label="Vendor Net Payable" value={inr(totals.net)} icon={Wallet} />
        <StatCard label="Average Rate" value={`${totals.avgRate}%`} icon={TrendingUp} />
      </div>

      <Panel title="Commission Earned by Vendor" className="mb-6">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="business" stroke="var(--slate)" fontSize={11} interval={0} angle={-20} textAnchor="end" height={70} />
              <YAxis stroke="var(--slate)" fontSize={12} tickFormatter={(v: number) => `${v / 1000}k`} />
              <Tooltip formatter={(v: number) => inr(v)} />
              <Bar dataKey="earned" fill="var(--gold)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel title="Vendor Commission Breakdown">
        <DataTable
          columns={["Vendor", "Gross Sales", "Commission %", "Commission Earned", "Vendor Net", "Action"]}
          rows={rows.map((r) => [
            <span className="font-semibold text-navy">{r.business}</span>,
            inr(r.sales),
            `${r.pct}%`,
            inr(r.earned),
            inr(r.net),
            <Button size="sm" variant="outline" onClick={() => openEdit(r.id)}>Edit Rate</Button>,
          ])}
        />
      </Panel>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Commission — {editingVendor?.business}</DialogTitle></DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label>Commission Percentage</Label>
            <Input type="number" min={0} max={100} value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button className="bg-navy text-white hover:bg-navy/90" onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  );
}
