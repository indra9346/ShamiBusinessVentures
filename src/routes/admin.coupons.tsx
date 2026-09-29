import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BadgePercent, CheckCircle2, Clock, Plus, Trash2, Copy } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp, type Coupon } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/admin/coupons")({
  head: () => ({
    meta: [
      { title: "Coupons | Shami Business Ventures Admin" },
      { name: "description", content: "Create and manage discount coupons for the marketplace." },
      { property: "og:title", content: "Coupons | Shami Admin" },
      { property: "og:description", content: "Coupon and promotions management." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminCoupons,
});

const emptyForm = { code: "", type: "Percentage", value: "", min: "", max: "", start: "", end: "", limit: "" };

function AdminCoupons() {
  const { coupons, addCoupon, deleteCoupon } = useApp();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const stats = useMemo(() => {
    const active = coupons.filter((c) => c.status === "Active").length;
    const expired = coupons.filter((c) => c.status === "Expired").length;
    const scheduled = coupons.filter((c) => c.status === "Scheduled").length;
    const used = coupons.reduce((s, c) => s + c.used, 0);
    return { total: coupons.length, active, expired, scheduled, used };
  }, [coupons]);

  const create = () => {
    if (!form.code.trim() || !form.value.trim() || !form.min || !form.max || !form.start || !form.end || !form.limit) {
      toast.error("Please fill in all coupon fields");
      return;
    }
    if (coupons.some((c) => c.code.toUpperCase() === form.code.toUpperCase())) {
      toast.error(`Coupon code "${form.code}" already exists`);
      return;
    }
    const coupon: Coupon = {
      code: form.code.toUpperCase(),
      type: form.type,
      value: form.type === "Percentage" ? `${form.value}%` : `₹${form.value}`,
      min: Number(form.min),
      max: Number(form.max),
      start: form.start,
      end: form.end,
      limit: Number(form.limit),
      used: 0,
      status: "Active",
    };
    addCoupon(coupon);
    toast.success(`Coupon "${coupon.code}" created`);
    setForm(emptyForm);
    setOpen(false);
  };

  const remove = (code: string) => {
    deleteCoupon(code);
    toast.success(`Coupon "${code}" deleted`);
  };

  const copy = (code: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    toast.success(`Coupon code "${code}" copied`);
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Coupons" subtitle="Discounts and promotional codes">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Coupons" value={String(stats.total)} icon={BadgePercent} />
        <StatCard label="Active" value={String(stats.active)} icon={CheckCircle2} highlight />
        <StatCard label="Scheduled" value={String(stats.scheduled)} icon={Clock} />
        <StatCard label="Total Redemptions" value={String(stats.used)} icon={BadgePercent} />
      </div>

      <Panel
        title="All Coupons"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="bg-navy text-white hover:bg-navy/90"><Plus className="mr-1 h-4 w-4" /> Create Coupon</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Create Coupon</DialogTitle></DialogHeader>
              <div className="grid gap-3 py-2 sm:grid-cols-2">
                <div className="grid gap-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} /></div>
                <div className="grid gap-1.5">
                  <Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Percentage">Percentage</SelectItem>
                      <SelectItem value="Fixed">Fixed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5"><Label>Value ({form.type === "Percentage" ? "%" : "₹"})</Label><Input type="number" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>Min Order Value</Label><Input type="number" value={form.min} onChange={(e) => setForm((f) => ({ ...f, min: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>Max Discount</Label><Input type="number" value={form.max} onChange={(e) => setForm((f) => ({ ...f, max: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>Usage Limit</Label><Input type="number" value={form.limit} onChange={(e) => setForm((f) => ({ ...f, limit: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>Start Date</Label><Input placeholder="01 Sep 2026" value={form.start} onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} /></div>
                <div className="grid gap-1.5"><Label>End Date</Label><Input placeholder="30 Sep 2026" value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} /></div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button className="bg-navy text-white hover:bg-navy/90" onClick={create}>Create</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      >
        <DataTable
          columns={["Code", "Type", "Value", "Min/Max", "Validity", "Usage", "Status", "Actions"]}
          rows={coupons.map((c) => [
            <div className="flex items-center gap-2">
              <span className="font-semibold text-navy">{c.code}</span>
              <button onClick={() => copy(c.code)} className="text-slate hover:text-gold" aria-label="Copy code"><Copy className="h-3.5 w-3.5" /></button>
            </div>,
            c.type,
            c.value,
            `₹${c.min} / ₹${c.max}`,
            <span className="text-xs">{c.start} – {c.end}</span>,
            <div className="w-32">
              <Progress value={Math.min(100, (c.used / c.limit) * 100)} className="h-2" />
              <p className="mt-1 text-[11px] text-slate">{c.used}/{c.limit}</p>
            </div>,
            <StatusBadge status={c.status} />,
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="text-danger hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete coupon "{c.code}"?</AlertDialogTitle>
                  <AlertDialogDescription>This coupon will no longer be usable at checkout.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => remove(c.code)}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>,
          ])}
        />
      </Panel>
    </PanelLayout>
  );
}
