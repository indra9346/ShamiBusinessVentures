import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { monthLabel, monthStart } from "@/lib/partners";
import { describeScheme, ratesProblem, schemeNow, type SchemeRow } from "@/lib/partner-month";

/** Admin: how this godown's partner is paid, per-unit commission or a monthly share of the profit, from a month on. */
export function CommissionMethod({ godownId }: { godownId: string }) {
  const [rows, setRows] = useState<SchemeRow[] | null>(null);
  const [scheme, setScheme] = useState("net_profit");
  const [from, setFrom] = useState(monthStart().slice(0, 7));
  const [share, setShare] = useState("");
  const [tax, setTax] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("godown_commission_schemes").select("*").eq("branch_id", godownId);
    if (error) { setRows(null); return; }
    setRows((data ?? []).map((row) => ({ ...row, share_percent: row.share_percent === null ? null : Number(row.share_percent), tax_percent: Number(row.tax_percent) })));
  }, [godownId]);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return null;

  const { current, planned } = schemeNow(rows);
  const problem = scheme === "net_profit" ? ratesProblem(share, tax) : "";
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_set_godown_commission_scheme", {
      _branch_id: godownId, _from_month: `${from}-01`, _scheme: scheme,
      ...(scheme === "net_profit" ? { _share_percent: Number(share), _tax_percent: Number(tax) } : {}),
    });
    setBusy(false);
    if (error) { toast.error("It was not saved", { description: error.message }); return; }
    toast.success("Saved");
    await load();
  };
  return (
    <div className="mb-4 space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-semibold text-navy">{describeScheme(current)}</p>
      {planned.map((row) => <p key={row.id} className="text-xs text-amber-800">{`From ${monthLabel(row.from_month)}: `}{describeScheme(row)}</p>)}
      <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
        <div className="grid gap-1"><Label className="text-xs">Way of paying</Label>
          <select aria-label="Way of paying" value={scheme} onChange={(event) => setScheme(event.target.value)} className="h-9 w-full rounded-md border border-input bg-white px-2 text-base sm:text-sm">
            <option value="net_profit">Monthly profit share</option>
            <option value="per_unit">Per-unit commission</option>
          </select>
        </div>
        <div className="grid gap-1"><Label className="text-xs">From month</Label>
          <input type="month" value={from} min={monthStart().slice(0, 7)} onChange={(event) => event.target.value && setFrom(event.target.value)} className="h-9 w-full rounded-md border border-input bg-white px-2 text-base sm:text-sm" aria-label="From month" />
        </div>
        {scheme === "net_profit" && <div className="grid gap-1"><Label className="text-xs">Partner's share (%)</Label><Input aria-label="Partner's share (%)" inputMode="decimal" value={share} onChange={(event) => setShare(event.target.value)} /></div>}
        {scheme === "net_profit" && <div className="grid gap-1"><Label className="text-xs">Income tax (%)</Label><Input aria-label="Income tax (%)" inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></div>}
      </div>
      <p className="text-xs text-slate">Orders already placed stay on the way they were placed under, so nobody is paid twice. The per-unit rates below stay saved.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy || Boolean(problem)} onClick={() => void save()}>Save</Button>
        <Link to="/admin/partner-income" search={{ godown: godownId }} className="text-xs font-semibold text-gold hover:underline">Monthly income and deductions →</Link>
      </div>
    </div>
  );
}
