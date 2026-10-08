import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock, IndianRupee, Loader } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel, StatCard, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/payouts")({ component: AdminPayouts });
type Payout = { id: string; vendorId: string; vendor: string; date: string; amount: number; method: string; status: string; reference: string | null };

function AdminPayouts() {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const [view, setView] = useState<Payout | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [{ data, error }, { data: profiles }] = await Promise.all([
      supabase.from("vendor_payout_requests").select("*").order("requested_at", { ascending: false }),
      supabase.from("profiles").select("vendor_id,company,full_name").not("vendor_id", "is", null),
    ]);
    if (error) { toast.error(error.message); return; }
    const names = new Map((profiles ?? []).map((p) => [p.vendor_id!, p.company || p.full_name]));
    setPayouts((data ?? []).map((p) => ({ id: p.id, vendorId: p.vendor_id, vendor: names.get(p.vendor_id) ?? p.vendor_id, date: new Date(p.requested_at).toLocaleDateString("en-IN"), amount: Number(p.amount), method: p.method, status: p.status, reference: p.reference })));
  };
  useEffect(() => { void load(); }, []);
  const stats = useMemo(() => ({ paid: payouts.filter(p => p.status === "Paid").reduce((s,p)=>s+p.amount,0), processing: payouts.filter(p=>p.status === "Processing").reduce((s,p)=>s+p.amount,0), pending: payouts.filter(p=>p.status === "Pending").reduce((s,p)=>s+p.amount,0), total: payouts.reduce((s,p)=>s+p.amount,0) }), [payouts]);
  const filtered = payouts.filter(p => [p.id,p.vendor].some(v=>v.toLowerCase().includes(search.toLowerCase())) && (status === "All" || p.status === status));
  const update = async (p: Payout, next: "Processing" | "Paid" | "Rejected") => {
    if (next === "Paid" && !reference.trim()) { toast.error("Enter the bank transfer reference first"); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc("admin_update_payout", { _id: p.id, _status: next, _reference: next === "Paid" ? reference.trim() : null });
    setBusy(false);
    if (error || !data) { toast.error(error?.message ?? "Could not update payout"); return; }
    toast.success(`Payout ${p.id} updated to ${next}`); setView(null); setReference(""); await load();
  };
  return <PanelLayout items={adminNav} tone="admin" title="Payouts" subtitle="Vendor settlement and payout tracking">
    <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard label="Paid" value={inr(stats.paid)} icon={CheckCircle2}/><StatCard label="Processing" value={inr(stats.processing)} icon={Loader}/><StatCard label="Pending" value={inr(stats.pending)} icon={Clock} highlight/><StatCard label="Total Payouts" value={inr(stats.total)} icon={IndianRupee}/></div>
    <Panel title="Payout Requests" action={<div className="flex gap-2"><Input placeholder="Search payout/vendor" value={search} onChange={e=>setSearch(e.target.value)} className="h-9 w-56"/><Select value={status} onValueChange={setStatus}><SelectTrigger className="h-9 w-40"><SelectValue/></SelectTrigger><SelectContent>{["All","Paid","Processing","Pending","Rejected"].map(s=><SelectItem key={s} value={s}>{s === "All" ? "All Status" : s}</SelectItem>)}</SelectContent></Select></div>}>
      <DataTable columns={["Payout ID","Vendor","Date","Amount","Method","Status","Actions"]} rows={filtered.map(p=>[<span className="font-semibold text-navy">{p.id.slice(0,8)}</span>,p.vendor,p.date,inr(p.amount),p.method,<StatusBadge status={p.status}/>,<Button size="sm" variant="outline" onClick={()=>{setView(p);setReference("");}}>Review</Button>])}/>
    </Panel>
    <Dialog open={!!view} onOpenChange={o=>!o&&setView(null)}><DialogContent><DialogHeader><DialogTitle>Payout {view?.id.slice(0,8)}</DialogTitle></DialogHeader>{view&&<div className="grid gap-3 text-sm"><p>Vendor: <b>{view.vendor}</b> ({view.vendorId})</p><p>Amount: <b>{inr(view.amount)}</b> · {view.method} · {view.date}</p><p>Status: <StatusBadge status={view.status}/></p>{view.reference&&<p>Bank reference: {view.reference}</p>}{view.status!=="Paid"&&view.status!=="Rejected"&&<><label htmlFor="bank-reference">Bank transfer reference (required to mark Paid)</label><Input id="bank-reference" value={reference} onChange={e=>setReference(e.target.value)} placeholder="UTR / NEFT reference"/><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>void update(view,"Rejected")}>Reject</Button><Button variant="outline" disabled={busy} onClick={()=>void update(view,"Processing")}>Mark processing</Button><Button className="bg-navy text-white" disabled={busy} onClick={()=>void update(view,"Paid")}>Mark paid</Button></div></>}</div>}</DialogContent></Dialog>
  </PanelLayout>;
}
