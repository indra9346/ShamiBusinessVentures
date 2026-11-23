import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, IndianRupee, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, FilterNote, Panel, scrollToSection, StatCard, StatusBadge } from "@/components/panel/widgets";
import { vendorNav } from "@/lib/panel-nav";
import { inr } from "@/lib/data";
import { matchesPayoutStatus, OPEN_PAYOUTS } from "@/lib/panel-filters";
import { useVendorScope } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/vendor/payouts")({
  head: () => ({ meta: [{ title: "Payouts | Grain Bazar Vendor Panel" }, { name: "robots", content: "noindex" }] }),
  component: VendorPayouts,
});
type Payout = { id: string; requested_at: string; amount: number; method: string; status: string; reference: string | null };
function VendorPayouts() {
  const { vendorId } = useVendorScope();
  const [rows, setRows] = useState<Payout[]>([]);
  const [viewing, setViewing] = useState<Payout | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("All");
  const openList = (next: string) => { setFilter(next); scrollToSection("payout-history"); };
  const loadRevision = useRef(0);
  const load = useCallback(async () => {
    if (!vendorId) { setRows([]); return; }
    const revision = ++loadRevision.current;
    const { data, error } = await supabase.from("vendor_payout_requests").select("*").eq("vendor_id", vendorId).order("requested_at", { ascending: false });
    if (revision !== loadRevision.current) return;
    if (error) { toast.error("Could not load payout history", { description: error.message }); return; }
    setRows((data ?? []).map((payout) => ({ ...payout, amount: Number(payout.amount) })));
  }, [vendorId]);
  useEffect(() => {
    void load();
    if (!vendorId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const revisionRef = loadRevision;
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 100);
    };
    const channel = supabase.channel(`vendor-payout-history-${vendorId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "vendor_payout_requests", filter: `vendor_id=eq.${vendorId}` }, refreshSoon)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (connectedOnce) refreshSoon();
          connectedOnce = true;
        }
      });
    return () => {
      ++revisionRef.current;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [vendorId, load]);
  const totals = useMemo(()=>({total:rows.reduce((s,p)=>s+p.amount,0),paid:rows.filter(p=>p.status==="Paid").reduce((s,p)=>s+p.amount,0),pending:rows.filter(p=>p.status!=="Paid"&&p.status!=="Rejected").reduce((s,p)=>s+p.amount,0)}),[rows]);
  const request = async () => { const value=Number(amount); if(!Number.isFinite(value)||value<=0){toast.error("Enter a valid payout amount");return;} setBusy(true); const {error}=await supabase.rpc("request_vendor_payout",{_amount:value,_method:"NEFT"}); setBusy(false); if(error){toast.error(error.message);return;} toast.success("Payout request submitted for review");setAmount("");setOpen(false);await load(); };
  return <PanelLayout items={vendorNav} tone="vendor" title="Payouts" subtitle="Your settlement history and payout requests">
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard onClick={()=>openList("All")} label="Total Requested" value={inr(totals.total)} icon={Wallet} highlight/><StatCard onClick={()=>openList("Paid")} label="Paid Out" value={inr(totals.paid)} icon={IndianRupee}/><StatCard onClick={()=>openList(OPEN_PAYOUTS)} label="Pending / Processing" value={inr(totals.pending)} icon={CreditCard}/><StatCard onClick={()=>openList("All")} label="Payout Records" value={String(rows.length)} icon={CreditCard}/></div>
    <Panel id="payout-history" title="Payout History" className="mt-6" action={<Button size="sm" className="bg-navy text-white" onClick={()=>setOpen(true)}>Request Payout</Button>}>
      {filter!=="All"&&<FilterNote label={filter==="Paid"?"Paid Out":"Pending / Processing"} onClear={()=>setFilter("All")}/>}
      <DataTable columns={["Payout ID","Date","Amount","Method","Status","Actions"]} rows={rows.filter(p=>matchesPayoutStatus(p.status,filter)).map(p=>[<span className="font-semibold text-navy">{p.id.slice(0,8)}</span>,new Date(p.requested_at).toLocaleDateString("en-IN"),inr(p.amount),p.method,<StatusBadge status={p.status}/>,<Button variant="outline" size="sm" onClick={()=>setViewing(p)}>View</Button>])}/>
      {!rows.length&&<p className="py-4 text-sm text-slate">No payout requests yet. Available settled earnings are checked securely when you submit a request.</p>}
    </Panel>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Request a payout</DialogTitle></DialogHeader><p className="text-sm text-slate">Only paid orders marked delivered are eligible. The server checks your available balance and commission before accepting the request.</p><label htmlFor="payout-amount">Amount (₹)</label><Input id="payout-amount" type="number" min="1" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/><div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button className="bg-navy text-white" disabled={busy} onClick={()=>void request()}>Submit request</Button></div></DialogContent></Dialog>
    <Dialog open={!!viewing} onOpenChange={v=>!v&&setViewing(null)}><DialogContent><DialogHeader><DialogTitle>Payout {viewing?.id.slice(0,8)}</DialogTitle></DialogHeader>{viewing&&<div className="space-y-2 text-sm"><p>Date: {new Date(viewing.requested_at).toLocaleString("en-IN")}</p><p>Amount: <b>{inr(viewing.amount)}</b></p><p>Method: {viewing.method}</p><p>Status: <StatusBadge status={viewing.status}/></p>{viewing.reference&&<p>Transfer reference: {viewing.reference}</p>}</div>}</DialogContent></Dialog>
  </PanelLayout>;
}
