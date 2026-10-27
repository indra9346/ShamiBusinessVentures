import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ExternalLink, Gauge, RefreshCw } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { supabase } from "@/integrations/supabase/client";
import { ResizableTable } from "@/hooks/use-column-resize";
import { downloadCSV } from "@/lib/export-utils";
import { ZOHO_CALL_LOG_SETTING, callsByPurpose, type ZohoCallLog } from "@/lib/zoho-call-log";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/zoho-api-calls")({
  head: () => ({ meta: [{ title: "Zoho API Calls | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: ZohoApiCalls,
});

const ZOHO_DAILY_LIMIT = 5000;
const ZOHO_USAGE_PAGE = "https://inventory.zoho.in/app/60066526172#/settings/developerspace/apidashboard";
const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" });

/** Admin: every Zoho API call the website made (last 7 days), by purpose, endpoint and hour. */
function ZohoApiCalls() {
  const [log, setLog] = useState<ZohoCallLog | null>(null);
  const [day, setDay] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("settings").select("value").eq("key", ZOHO_CALL_LOG_SETTING).maybeSingle();
    setLog((data?.value as ZohoCallLog | null) ?? { days: {} });
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const days = useMemo(() => Object.keys(log?.days ?? {}).sort().reverse(), [log]);
  const selected = day && log?.days[day] ? day : days[0] ?? "";
  const current = selected ? log?.days[selected] : undefined;
  const purposes = callsByPurpose(current);
  const rows = Object.values(current?.rows ?? {}).sort((a, b) => b.count - a.count);
  const hours = (current?.hours ?? []).map((count, hour) => ({ hour, count })).filter((h) => h.count > 0);
  const busiestHour = hours.reduce((best, h) => (h.count > (best?.count ?? 0) ? h : best), null as { hour: number; count: number } | null);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Zoho API Calls" subtitle="What each Zoho API call from this website was for (last 7 days)">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select value={selected} onChange={(e) => setDay(e.target.value)} aria-label="Day" className="h-9 rounded-md border border-input bg-white px-2 text-sm">
          {days.length ? days.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>) : <option value="">No calls logged yet</option>}
        </select>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
        <Button size="sm" variant="outline" disabled={!rows.length} onClick={() => downloadCSV(`zoho-api-calls-${selected}.csv`,
          ["Purpose", "Zoho API", "Method", "Endpoint", "Calls", "Failed", "Last call (IST)"],
          rows.map((r) => [r.purpose, r.api, r.method, r.endpoint, r.count, r.errors, istTime(r.last)]))}>Export CSV</Button>
        <a href={ZOHO_USAGE_PAGE} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-navy underline">
          Zoho's own API Usage page <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <p className="mb-4 text-xs text-slate">
        Counted by the website as it calls Zoho (sign-in token requests are not API calls and are not counted). Zoho's daily limit of {ZOHO_DAILY_LIMIT.toLocaleString("en-IN")} also
        includes anything else using the Zoho organization, so Zoho's own page can show a little more. Updates every 30 seconds.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={`Calls · ${selected ? dayLabel(selected) : "—"}`} value={(current?.total ?? 0).toLocaleString("en-IN")} icon={Activity} highlight
          description={`${Math.max(0, ZOHO_DAILY_LIMIT - (current?.total ?? 0)).toLocaleString("en-IN")} of ${ZOHO_DAILY_LIMIT.toLocaleString("en-IN")} left`} />
        <StatCard label="Failed calls" value={String(current?.errors ?? 0)} icon={AlertTriangle} description="Zoho refused or did not answer" />
        <StatCard label="Biggest user" value={purposes[0]?.purpose ?? "—"} icon={Gauge} description={purposes[0] ? `${purposes[0].count} calls` : "No calls yet"} compact />
        <StatCard label="Busiest hour (IST)" value={busiestHour ? `${String(busiestHour.hour).padStart(2, "0")}:00` : "—"} icon={Activity} description={busiestHour ? `${busiestHour.count} calls` : "No calls yet"} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="By purpose">
          {!purposes.length ? <p className="text-sm text-slate">No calls logged for this day.</p> : (
            <div className="overflow-x-auto">
              <ResizableTable tableId="zoho-calls-purpose" className="w-full text-left text-sm">
                <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                  <th className="px-2 py-2">Purpose</th><th className="px-2 py-2 text-right">Calls</th><th className="px-2 py-2 text-right">Share</th><th className="px-2 py-2 text-right">Failed</th>
                </tr></thead>
                <tbody>
                  {purposes.map((p) => (
                    <tr key={p.purpose} className="border-b border-border/60">
                      <td className="px-2 py-1.5 font-medium text-navy">{p.purpose}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.count}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{current?.total ? `${Math.round((p.count / current.total) * 100)}%` : "—"}</td>
                      <td className={cn("px-2 py-1.5 text-right tabular-nums", p.errors > 0 && "font-semibold text-danger")}>{p.errors}</td>
                    </tr>
                  ))}
                </tbody>
              </ResizableTable>
            </div>
          )}
        </Panel>
        <Panel title="By hour (IST)">
          {!hours.length ? <p className="text-sm text-slate">No calls logged for this day.</p> : (
            <div className="space-y-1">
              {hours.map((h) => (
                <div key={h.hour} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 tabular-nums text-slate">{String(h.hour).padStart(2, "0")}:00–{String(h.hour + 1).padStart(2, "0")}:00</span>
                  <span className="h-3 rounded bg-gold" style={{ width: `${Math.max(2, (h.count / (busiestHour?.count || 1)) * 100)}%` }} />
                  <span className="tabular-nums text-navy">{h.count}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title={`Every Zoho endpoint called · ${rows.length}`} className="mt-6">
        {!rows.length ? <p className="text-sm text-slate">No calls logged for this day.</p> : (
          <div className="overflow-x-auto">
            <ResizableTable tableId="zoho-calls-endpoints" className="w-full min-w-[820px] text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                <th className="px-2 py-2">Purpose</th><th className="px-2 py-2">Zoho API</th><th className="px-2 py-2">Method</th><th className="px-2 py-2">Endpoint</th>
                <th className="px-2 py-2 text-right">Calls</th><th className="px-2 py-2 text-right">Failed</th><th className="px-2 py-2">Last call</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.purpose}|${r.api}|${r.method}|${r.endpoint}`} className="border-b border-border/60">
                    <td className="px-2 py-1.5 text-navy">{r.purpose}</td>
                    <td className="px-2 py-1.5">{r.api}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.method}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.endpoint}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.count}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums", r.errors > 0 && "font-semibold text-danger")}>{r.errors}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-slate">{istTime(r.last)}</td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        )}
      </Panel>
    </PanelLayout>
  );
}
