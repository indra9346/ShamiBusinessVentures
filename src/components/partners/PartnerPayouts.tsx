import { useCallback, useState } from "react";
import { ChevronDown, CircleDollarSign, FileSpreadsheet, Landmark, Timer, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Panel, StatCard } from "@/components/panel/widgets";
import { useLiveRefresh } from "@/components/partners/PartnerWidgets";
import { inrPrecise } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { downloadXlsx } from "@/lib/xlsx";
import { dayLabel, istToday, payoutMonthLabel, payoutsSheet, type PartnerPosition, type PayoutRow } from "@/lib/partner-payouts";
import { cn } from "@/lib/utils";

type PayoutLine = { id: string; order_no: string; product_name: string; amount: number };

/** The partner's own side of the settlement: what they earned, what they were paid and every payout, live. */
export function PartnerPayouts({ partnerId, partnerName }: { partnerId: string; partnerName: string }) {
  const [position, setPosition] = useState<PartnerPosition | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[] | null>(null);
  const [open, setOpen] = useState("");
  const [lines, setLines] = useState<Record<string, PayoutLine[]>>({});
  useLiveRefresh(useCallback(async () => {
    const [summary, list] = await Promise.all([
      supabase.rpc("partner_settlement_summary"),
      supabase.from("partner_payouts").select("*").eq("partner_id", partnerId).order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    ]);
    const row = summary.data?.find((item) => item.partner_id === partnerId) as unknown as Record<string, unknown> | undefined;
    if (row) setPosition({ ...row, earned: Number(row["earned"]), pending: Number(row["pending"]), cancelled: Number(row["cancelled"]), paid: Number(row["paid"]), due: Number(row["due"]), owed_back: Number(row["owed_back"]), payouts: Number(row["payouts"]) } as unknown as PartnerPosition);
    if (!list.error) setPayouts((list.data ?? []).map((item) => ({ ...item, amount: Number(item.amount), lines_total: Number(item.lines_total), recovered_total: Number(item.recovered_total) }) as unknown as PayoutRow));
  }, [partnerId]), [partnerId]);

  const toggle = async (id: string) => {
    if (open === id) { setOpen(""); return; }
    setOpen(id);
    if (lines[id]) return;
    const { data } = await supabase.from("partner_payout_lines").select("id,order_no,product_name,amount").eq("payout_id", id).order("placed_at");
    setLines((current) => ({ ...current, [id]: (data ?? []).map((row) => ({ ...row, amount: Number(row.amount) })) }));
  };
  const download = () => {
    downloadXlsx(`my-payouts-${istToday()}.xlsx`, [payoutsSheet(payouts ?? [], () => partnerName, { title: `Payouts · ${partnerName}`, generatedAt: new Date().toISOString() })]);
    toast.success("Payouts downloaded");
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Earned so far" value={inrPrecise(position?.earned ?? 0)} icon={CircleDollarSign} description="Delivered and fully paid orders" />
        <StatCard label="Paid to you" value={inrPrecise(position?.paid ?? 0)} icon={Landmark} description={`${position?.payouts ?? 0} payouts`} />
        <StatCard label="Balance to receive" value={inrPrecise(position?.due ?? 0)} icon={Wallet} description="Earned and not paid yet" highlight />
        <StatCard label="Waiting" value={inrPrecise(position?.pending ?? 0)} icon={Timer} description="Becomes earned on delivery + full payment" />
      </div>
      {position && position.owed_back > 0 && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{`${inrPrecise(position.owed_back)} was paid to you on orders that were later cancelled, refunded or changed. It comes off your next payout.`}</p>
      )}
      <Panel title="Payouts received"
        action={payouts?.length ? <button type="button" onClick={download} className="inline-flex items-center gap-1.5 text-xs font-semibold text-gold hover:underline"><FileSpreadsheet className="h-3.5 w-3.5" />Download Excel</button> : undefined}>
        {!payouts ? <p className="text-sm text-slate">Loading…</p> : !payouts.length ? <p className="py-4 text-center text-sm text-slate">No payouts yet. They appear here as soon as the office records one.</p> : (
          <ul className="space-y-2">
            {payouts.map((row) => {
              const undone = row.status === "voided";
              return (
                <li key={row.id} className={cn("rounded-lg border border-border text-sm", undone && "bg-slate-50 opacity-80")}>
                  <button type="button" aria-expanded={open === row.id} onClick={() => void toggle(row.id)} className="flex w-full items-start justify-between gap-3 p-3 text-left">
                    <span className="min-w-0">
                      <span className="block font-semibold text-navy">{dayLabel(row.paid_on)} · {row.payout_no}</span>
                      <span className="block break-words text-xs text-slate">{row.mode}{row.reference ? ` · ${row.reference}` : ""}{row.note ? ` · ${row.note}` : ""}</span>
                      {payoutMonthLabel(row) && <span className="block text-xs font-semibold text-navy">{payoutMonthLabel(row)}</span>}
                      {row.recovered_total > 0 && <span className="block text-xs text-slate">{`${inrPrecise(row.recovered_total)} taken back from this payout`}</span>}
                      {undone && <span className="block text-xs font-semibold text-red-700">{`Undone: ${row.void_reason}`}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className={cn("tabular-nums font-bold text-navy", undone && "line-through")}>{inrPrecise(row.amount)}</span>
                      <ChevronDown className={cn("h-4 w-4 text-slate transition-transform", open === row.id && "rotate-180")} />
                    </span>
                  </button>
                  {open === row.id && (
                    <ul className="divide-y divide-border/60 border-t border-border px-3 py-1">
                      {row.statement_id && <li className="py-2 text-xs text-slate">This payment is for the whole month, not order by order.</li>}
                      {!lines[row.id] ? <li className="py-2 text-xs text-slate">Loading…</li> : lines[row.id]!.map((line) => (
                        <li key={line.id} className="flex items-baseline justify-between gap-3 py-1.5">
                          <span className="min-w-0"><span className="block break-all font-mono text-xs text-navy">{line.order_no}</span><span className="block text-xs text-slate">{line.product_name}</span></span>
                          <span className={cn("shrink-0 tabular-nums font-semibold", line.amount < 0 ? "text-red-700" : "text-navy")}>{inrPrecise(line.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
