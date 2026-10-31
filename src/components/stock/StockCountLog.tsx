import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, Download, RefreshCw } from "lucide-react";
import { Panel, StatCard } from "@/components/panel/widgets";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { downloadCSV } from "@/lib/export-utils";
import { indiaTime } from "@/lib/attendance";
import { monthLabel, monthStart } from "@/lib/partners";
import { stockCountReasonLabel } from "@/lib/stock-counts";
import { cn } from "@/lib/utils";

/*
 * Godown stock counts made in the staff app: who counted what, Zoho before → counted, and the
 * website stock after. Shared by Admin > Stock Counts (every godown) and the partner panel (the
 * database shows a partner only their godown's counts).
 */

type StockCount = Database["public"]["Tables"]["stock_counts"]["Row"];

const nextMonth = (month: string) => {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, mon!, 1)).toISOString().slice(0, 10);
};
const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

export function StockCountLog({ godowns }: { godowns: { id: string; name: string }[] }) {
  const [month, setMonth] = useState(monthStart());
  const [godownId, setGodownId] = useState("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [rows, setRows] = useState<StockCount[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: readError } = await supabase.from("stock_counts").select("*")
      .gte("created_at", `${month}T00:00:00+05:30`).lt("created_at", `${nextMonth(month)}T00:00:00+05:30`)
      .order("created_at", { ascending: false }).limit(1000);
    setError(readError ? (/does not exist|schema cache/i.test(readError.message) ? "Stock counts are not set up in the database yet (migration 20261031150000_godown_stock_counts)." : readError.message) : "");
    setRows((data as StockCount[] | null) ?? []);
  }, [month]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const godownName = useMemo(() => new Map(godowns.map((godown) => [godown.id, godown.name])), [godowns]);
  const shown = (rows ?? []).filter((row) => (godownId === "all" || row.branch_id === godownId) && (!flaggedOnly || row.flagged));
  const flagged = (rows ?? []).filter((row) => row.flagged).length;

  const exportCsv = () => downloadCSV(`stock-counts-${month.slice(0, 7)}.csv`,
    ["Date", "Time", "Godown", "Product", "Zoho before", "Counted", "Change", "Website stock before", "Website stock after", "Reason", "Note", "Counted by", "Big change", "Zoho adjustment"],
    shown.map((row) => [new Date(row.created_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), indiaTime(row.created_at), godownName.get(row.branch_id) ?? row.branch_id,
      row.product_name, Number(row.zoho_physical_before), Number(row.counted), Number(row.zoho_delta), Number(row.site_before), Number(row.site_after),
      stockCountReasonLabel(row.reason), row.note, row.counted_by_name, row.flagged ? "Yes" : "", row.zoho_adjustment_id]));

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={`Stock updates · ${monthLabel(month)}`} value={String(rows?.length ?? 0)} icon={Boxes} />
        <StatCard label="Big changes (over 20%)" value={String(flagged)} icon={AlertTriangle} description="Check these against the godown" />
        <StatCard label="Godowns counting" value={String(new Set((rows ?? []).map((row) => row.branch_id)).size)} icon={RefreshCw} />
      </div>
      <Panel title={`Stock updates by godown staff · ${monthLabel(month)}`} action={
        <>
          <input type="month" value={month.slice(0, 7)} max={monthStart().slice(0, 7)} aria-label="Month"
            onChange={(event) => event.target.value && setMonth(`${event.target.value}-01`)} className="h-9 rounded-md border border-input bg-white px-2 text-sm" />
          {godowns.length > 1 && (
            <select value={godownId} onChange={(event) => setGodownId(event.target.value)} aria-label="Godown" className="h-9 rounded-md border border-input bg-white px-2 text-sm">
              <option value="all">All godowns</option>
              {godowns.map((godown) => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-sm text-navy"><input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} /> Big changes only</label>
          <button type="button" onClick={exportCsv} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold text-navy"><Download className="h-4 w-4" /> CSV</button>
        </>
      }>
        <p className="mb-3 text-xs text-slate">Staff enter the packs counted on the godown floor. Zoho's stock at that godown is corrected to the count first, then the website stock. Updates live every minute.</p>
        {rows === null ? <p className="flex items-center gap-2 text-sm text-slate"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</p>
          : shown.length === 0 ? <p className="text-sm text-slate">No stock updates.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs uppercase tracking-wider text-slate">
                <th className="py-2 pr-3">When</th><th className="py-2 pr-3">Godown</th><th className="py-2 pr-3">Product</th>
                <th className="py-2 pr-3 text-right">Zoho before</th><th className="py-2 pr-3 text-right">Counted</th><th className="py-2 pr-3 text-right">Change</th>
                <th className="py-2 pr-3 text-right">Website stock</th><th className="py-2 pr-3">Reason</th><th className="py-2">Counted by</th>
              </tr></thead>
              <tbody>
                {shown.map((row) => {
                  const delta = Number(row.zoho_delta);
                  return (
                    <tr key={row.id} className={cn("border-b border-border/60 last:border-0", row.flagged && "bg-amber-50/70")}>
                      <td className="py-2 pr-3 text-xs text-slate">{`${new Date(row.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })} ${indiaTime(row.created_at)}`}</td>
                      <td className="py-2 pr-3">{godownName.get(row.branch_id) ?? row.branch_id}</td>
                      <td className="py-2 pr-3 font-semibold text-charcoal">{row.product_name}{row.flagged && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">Big change</span>}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmt(Number(row.zoho_physical_before))}</td>
                      <td className="py-2 pr-3 text-right font-bold tabular-nums text-navy">{fmt(Number(row.counted))}</td>
                      <td className={cn("py-2 pr-3 text-right font-semibold tabular-nums", delta > 0 ? "text-emerald-700" : delta < 0 ? "text-red-700" : "text-slate")}>{delta > 0 ? `+${fmt(delta)}` : fmt(delta)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate">{`${fmt(Number(row.site_before))} → ${fmt(Number(row.site_after))}`}</td>
                      <td className="py-2 pr-3 text-xs">{stockCountReasonLabel(row.reason)}{row.note && <span className="block text-slate">{row.note}</span>}</td>
                      <td className="py-2 text-xs">{row.counted_by_name}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
