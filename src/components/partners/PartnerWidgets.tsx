import { useCallback, useEffect, useState } from "react";
import { Medal, Trophy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { inrPrecise } from "@/lib/data";
import { describeRate, type CommissionKind } from "@/lib/partners";
import { ResizableTable } from "@/hooks/use-column-resize";
import { cn } from "@/lib/utils";

export type LeaderRow = Database["public"]["Functions"]["partner_leaderboard"]["Returns"][number];
export type CommissionLine = Database["public"]["Functions"]["partner_commission_lines"]["Returns"][number];

/** Re-runs `load` now, every 30 seconds and when the window regains focus (live tracking). */
export function useLiveRefresh(load: () => Promise<void> | void, deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  useEffect(() => {
    void run();
    const timer = window.setInterval(() => void run(), 30_000);
    const onFocus = () => void run();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [run]);
}

export function usePartnerData(month: string) {
  const [leaders, setLeaders] = useState<LeaderRow[] | null>(null);
  const [lines, setLines] = useState<CommissionLine[] | null>(null);
  const [error, setError] = useState("");
  useLiveRefresh(async () => {
    const [board, ledger] = await Promise.all([
      supabase.rpc("partner_leaderboard", { _month: month }),
      supabase.rpc("partner_commission_lines", { _month: month }),
    ]);
    if (board.error || ledger.error) { setError((board.error ?? ledger.error)!.message); return; }
    setError("");
    setLeaders(board.data ?? []);
    setLines(ledger.data ?? []);
  }, [month]);
  return { leaders, lines, error };
}

const STATUS_STYLE: Record<string, string> = {
  earned: "bg-emerald-100 text-emerald-800",
  pending: "bg-amber-100 text-amber-800",
  cancelled: "bg-slate-100 text-slate-500 line-through",
};

export function CommissionStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize", STATUS_STYLE[status] ?? "bg-slate-100")}>
      {status}
    </span>
  );
}

/** Progress bar towards the monthly target. */
export function TargetBar({ percent }: { percent: number | null }) {
  const width = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cn("h-full rounded-full transition-all", width >= 100 ? "bg-emerald-500" : "bg-gold")} style={{ width: `${width}%` }} />
    </div>
  );
}

/** The monthly leaderboard (same for every partner and the admin). */
export function PartnerLeaderboard({ leaders, highlightPartnerId }: { leaders: LeaderRow[] | null; highlightPartnerId?: string | null }) {
  if (!leaders) return <p className="text-sm text-slate">Loading…</p>;
  if (!leaders.length) return <p className="text-sm text-slate">No active channel partners yet.</p>;
  return (
    <div className="space-y-2">
      {leaders.map((row) => {
        const me = row.partner_id === highlightPartnerId;
        return (
          <div key={row.partner_id} className={cn("rounded-lg border p-3", me ? "border-gold bg-gold/10" : "border-border bg-card", row.rank === 1 && "shadow-sm")}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold",
                  row.rank === 1 ? "bg-gold text-midnight" : row.rank === 2 ? "bg-slate-200 text-navy" : row.rank === 3 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate")}>
                  {row.rank === 1 ? <Trophy className="h-4 w-4" /> : row.rank <= 3 ? <Medal className="h-4 w-4" /> : row.rank}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-navy">{row.partner_name}{me ? " (you)" : ""}</p>
                  <p className="truncate text-xs text-slate">{row.godown}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-navy">{row.achieved_percent === null ? "No target" : `${row.achieved_percent}% of target`}</p>
                <p className="text-xs text-slate">Sales {inrPrecise(Number(row.sales))} · Commission {inrPrecise(Number(row.commission))}</p>
              </div>
            </div>
            {row.achieved_percent !== null && <div className="mt-2"><TargetBar percent={Number(row.achieved_percent)} /></div>}
          </div>
        );
      })}
    </div>
  );
}

/** Commission lines: order, customer, product, qty, rate, commission, status. */
export function CommissionLinesTable({ lines, showPartner, partnerNames }: { lines: CommissionLine[] | null; showPartner?: boolean; partnerNames?: Map<string, string> }) {
  if (!lines) return <p className="text-sm text-slate">Loading…</p>;
  if (!lines.length) return <p className="py-6 text-center text-sm text-slate">No commissions in this month yet.</p>;
  return (
    <div className="overflow-x-auto">
      <ResizableTable tableId="partner-commission-lines" className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
            <th className="px-2 py-2">Date</th>
            <th className="px-2 py-2">Order</th>
            {showPartner && <th className="px-2 py-2">Partner</th>}
            <th className="px-2 py-2">Customer · PIN</th>
            <th className="px-2 py-2">Product</th>
            <th className="px-2 py-2 text-right">Qty</th>
            <th className="px-2 py-2 text-right">Sale (excl. GST)</th>
            <th className="px-2 py-2">Rate</th>
            <th className="px-2 py-2 text-right">Commission</th>
            <th className="px-2 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.order_item_id} className="border-b border-border/60 last:border-0">
              <td className="px-2 py-2 whitespace-nowrap">{new Date(line.placed_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
              <td className="px-2 py-2 font-mono text-xs text-navy">{line.order_no}<div className="font-sans text-[11px] text-slate">{line.order_status} · {line.payment_status}</div></td>
              {showPartner && <td className="px-2 py-2">{partnerNames?.get(line.partner_id) ?? "—"}</td>}
              <td className="px-2 py-2">{line.customer_name}<span className="text-slate"> · {line.pin || "—"}</span></td>
              <td className="px-2 py-2">{line.product_name}</td>
              <td className="px-2 py-2 text-right">{line.qty}</td>
              <td className="px-2 py-2 text-right">{inrPrecise(Number(line.line_total))}</td>
              <td className="px-2 py-2 text-xs">{describeRate(line.kind as CommissionKind, Number(line.rate))}</td>
              <td className="px-2 py-2 text-right font-semibold text-navy">{inrPrecise(Number(line.amount))}</td>
              <td className="px-2 py-2"><CommissionStatusBadge status={line.status} /></td>
            </tr>
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

/** Totals of the lines: earned, pending, sales (cancelled excluded). */
export function commissionTotals(lines: CommissionLine[] | null) {
  const totals = { earned: 0, pending: 0, sales: 0, orders: new Set<string>() };
  for (const line of lines ?? []) {
    if (line.status === "cancelled") continue;
    totals.sales += Number(line.line_total);
    totals.orders.add(line.order_no);
    if (line.status === "earned") totals.earned += Number(line.amount);
    else totals.pending += Number(line.amount);
  }
  return { earned: Math.round(totals.earned * 100) / 100, pending: Math.round(totals.pending * 100) / 100, sales: Math.round(totals.sales * 100) / 100, orders: totals.orders.size };
}
