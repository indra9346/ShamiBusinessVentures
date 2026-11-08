import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Banknote, CheckCircle2, FileSpreadsheet, History, RefreshCw, Timer, Undo2, Wallet } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { FilterNote, Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";
import { downloadXlsx } from "@/lib/xlsx";
import { cn } from "@/lib/utils";
import {
  PAYOUT_MODES, addDays, dayLabel, groupByDay, istToday, lineState, payoutProblem, payoutStatusLabel, payoutsSheet, rupees, selectionTotals, waitingReason,
  type PartnerPosition, type PayoutRow, type SettlementLine,
} from "@/lib/partner-payouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/admin/partner-payouts")({
  head: () => ({ meta: [{ title: "Partner Payouts | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminPartnerPayouts,
});

const num = (value: unknown) => Number(value) || 0;
const asPosition = (row: Record<string, unknown>) => ({
  ...row, earned: num(row["earned"]), pending: num(row["pending"]), cancelled: num(row["cancelled"]), paid: num(row["paid"]), due: num(row["due"]), owed_back: num(row["owed_back"]), payouts: num(row["payouts"]),
}) as unknown as PartnerPosition;
const asLine = (row: Record<string, unknown>) => ({
  ...row, qty: num(row["qty"]), line_total: num(row["line_total"]), rate: num(row["rate"]), amount: num(row["amount"]), payable: num(row["payable"]), paid_amount: num(row["paid_amount"]), due_amount: num(row["due_amount"]),
}) as unknown as SettlementLine;
const asPayout = (row: Record<string, unknown>) => ({
  ...row, amount: num(row["amount"]), lines_total: num(row["lines_total"]), recovered_total: num(row["recovered_total"]),
}) as unknown as PayoutRow;

const STATE_STYLE: Record<string, string> = {
  "To pay": "bg-amber-100 text-amber-800",
  "Part paid": "bg-amber-100 text-amber-800",
  Paid: "bg-emerald-100 text-emerald-800",
  Waiting: "bg-slate-100 text-slate-600",
  Cancelled: "bg-slate-100 text-slate-500",
  "To take back": "bg-red-100 text-red-700",
};
const PRESETS = [
  { label: "All dates", range: () => ["", ""] as const },
  { label: "Today", range: () => [istToday(), istToday()] as const },
  { label: "Yesterday", range: () => [addDays(istToday(), -1), addDays(istToday(), -1)] as const },
  { label: "Last 7 days", range: () => [addDays(istToday(), -6), istToday()] as const },
  { label: "This month", range: () => [`${istToday().slice(0, 8)}01`, istToday()] as const },
];

/** Commission settlement: what each partner is owed, paying it by day or period, and every payout made. */
function AdminPartnerPayouts() {
  const [positions, setPositions] = useState<PartnerPosition[] | null>(null);
  const [payouts, setPayouts] = useState<PayoutRow[] | null>(null);
  const [partnerId, setPartnerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<SettlementLine[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const [viewing, setViewing] = useState<PayoutRow | null>(null);
  const [correcting, setCorrecting] = useState<PayoutRow | null>(null);
  const [undoing, setUndoing] = useState<PayoutRow | null>(null);
  const [historyFilter, setHistoryFilter] = useState("");

  const loadOverview = useCallback(async () => {
    const [summary, list] = await Promise.all([
      supabase.rpc("partner_settlement_summary"),
      supabase.from("partner_payouts").select("*").order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(1000),
    ]);
    if (summary.error) { toast.error("Could not load the commission balances", { description: summary.error.message }); return; }
    if (list.error) { toast.error("Could not load the payouts", { description: list.error.message }); return; }
    const rows = (summary.data ?? []).map((row) => asPosition(row as unknown as Record<string, unknown>));
    setPositions(rows);
    setPayouts((list.data ?? []).map((row) => asPayout(row as unknown as Record<string, unknown>)));
    setPartnerId((current) => current || (rows.find((row) => row.due > 0) ?? rows.find((row) => row.partner_status === "active") ?? rows[0])?.partner_id || "");
  }, []);
  const loadLines = useCallback(async () => {
    if (!partnerId) return;
    const { data, error } = await supabase.rpc("partner_settlement_lines", { _partner_id: partnerId, ...(from ? { _from: from } : {}), ...(to ? { _to: to } : {}) });
    if (error) { toast.error("Could not load the commissions", { description: error.message }); return; }
    setLines((data ?? []).map((row) => asLine(row as unknown as Record<string, unknown>)));
  }, [partnerId, from, to]);
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { setLines(null); setPicked(new Set()); void loadLines(); }, [loadLines]);
  const reload = async () => { await Promise.all([loadOverview(), loadLines()]); setPicked(new Set()); };

  const position = positions?.find((row) => row.partner_id === partnerId) ?? null;
  const partnerName = useCallback((id: string) => positions?.find((row) => row.partner_id === id)?.partner_name ?? "—", [positions]);
  const totals = useMemo(() => (positions ?? []).reduce((acc, row) => ({
    due: rupees(acc.due + row.due), pending: rupees(acc.pending + row.pending), paid: rupees(acc.paid + row.paid), owedBack: rupees(acc.owedBack + row.owed_back),
  }), { due: 0, pending: 0, paid: 0, owedBack: 0 }), [positions]);
  const days = useMemo(() => groupByDay(lines ?? []), [lines]);
  const selection = useMemo(() => selectionTotals(lines ?? [], picked, position?.owed_back ?? 0), [lines, picked, position]);
  const shownPayouts = (payouts ?? []).filter((row) => !historyFilter || row.partner_id === historyFilter);

  const toggle = (ids: string[], on: boolean) => setPicked((current) => {
    const next = new Set(current);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const payableIds = (rows: SettlementLine[]) => rows.filter((line) => line.due_amount > 0).map((line) => line.order_item_id);
  const allPayable = payableIds(lines ?? []);
  const download = () => {
    const generatedAt = new Date().toISOString();
    downloadXlsx(`partner-payouts-${istToday()}.xlsx`, [payoutsSheet(shownPayouts, partnerName, { title: "Channel partner payouts", generatedAt })]);
    toast.success("Payouts downloaded");
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="Partner Payouts" subtitle="Settle channel partner commissions and keep the record">
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard onClick={() => scrollToSection("settle")} label="To pay now" value={inrPrecise(totals.due)} icon={Wallet} description="Delivered and fully paid" highlight />
        <StatCard onClick={() => scrollToSection("settle")} label="Waiting" value={inrPrecise(totals.pending)} icon={Timer} description="Order not delivered or paid yet" />
        <StatCard onClick={() => scrollToSection("payout-history")} label="Paid out" value={inrPrecise(totals.paid)} icon={CheckCircle2} description="All payouts" />
        <StatCard onClick={() => scrollToSection("settle")} label="To take back" value={inrPrecise(totals.owedBack)} icon={Undo2} description="Comes off the next payout" />
      </div>

      <Panel title="What each partner is owed" className="mb-6">
        {!positions ? <p className="text-sm text-slate">Loading…</p> : !positions.length ? <p className="text-sm text-slate">No channel partners yet.</p> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {positions.map((row) => (
              <button key={row.partner_id} type="button" onClick={() => { setPartnerId(row.partner_id); scrollToSection("settle"); }}
                className={cn("rounded-lg border p-3 text-left transition-colors", row.partner_id === partnerId ? "border-gold bg-gold/10" : "border-border bg-card hover:border-gold")}>
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0"><span className="block truncate font-semibold text-navy">{row.partner_name}</span><span className="block truncate text-xs text-slate">{row.godown}</span></span>
                  {row.partner_status !== "active" && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Suspended</span>}
                </span>
                <span className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs min-[420px]:grid-cols-2 [&>*]:min-w-0">
                  <span className="flex justify-between gap-2"><span className="text-slate">Earned</span><b className="text-navy">{inrPrecise(row.earned)}</b></span>
                  <span className="flex justify-between gap-2"><span className="text-slate">Paid</span><b className="text-navy">{inrPrecise(row.paid)}</b></span>
                  <span className="flex justify-between gap-2"><span className="text-slate">To pay</span><b className={row.due > 0 ? "text-amber-700" : "text-navy"}>{inrPrecise(row.due)}</b></span>
                  <span className="flex justify-between gap-2"><span className="text-slate">Waiting</span><b className="text-navy">{inrPrecise(row.pending)}</b></span>
                </span>
                {row.owed_back > 0 && <span className="mt-1 block text-xs font-semibold text-red-700">{`To take back: ${inrPrecise(row.owed_back)}`}</span>}
              </button>
            ))}
          </div>
        )}
      </Panel>

      <div id="settle" className="mb-6 scroll-mt-36">
        <Panel title={position ? `Settle · ${position.partner_name}` : "Settle"}
          action={<button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-gold hover:underline"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>}>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-semibold text-slate">From
              <input type="date" value={from} max={to || istToday()} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
            </label>
            <label className="grid gap-1 text-xs font-semibold text-slate">To
              <input type="date" value={to} min={from || undefined} max={istToday()} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-sm text-charcoal" />
            </label>
            {PRESETS.map((preset) => {
              const [a, b] = preset.range();
              return (
                <button key={preset.label} type="button" onClick={() => { setFrom(a); setTo(b); }}
                  className={cn("h-9 rounded-md border px-3 text-sm", from === a && to === b ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-gold")}>{preset.label}</button>
              );
            })}
          </div>
          <p className="mb-3 text-xs text-slate">Days are the day the order was placed. A commission can be paid once its order is delivered and fully paid.</p>
          {position && position.owed_back > 0 && (
            <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{`${inrPrecise(position.owed_back)} was paid on orders that were later cancelled, refunded or changed. It comes off the next payout by itself.`}</p>
          )}
          {!lines ? <p className="text-sm text-slate">Loading…</p> : !lines.length ? <p className="py-6 text-center text-sm text-slate">No commissions in this period.</p> : (
            <>
              {allPayable.length > 0 && (
                <label className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
                  <input type="checkbox" className="h-4 w-4" checked={allPayable.every((id) => picked.has(id))} onChange={(e) => toggle(allPayable, e.target.checked)} />
                  Select everything to pay
                </label>
              )}
              <div className="space-y-3">
                {days.map((group) => {
                  const ids = payableIds(group.lines);
                  return (
                    <div key={group.day} className="overflow-hidden rounded-lg border border-border">
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-ivory/70 px-3 py-2 text-sm">
                        <label className={cn("flex items-center gap-2 font-semibold text-navy", !ids.length && "opacity-70")}>
                          <input type="checkbox" className="h-4 w-4" disabled={!ids.length} checked={ids.length > 0 && ids.every((id) => picked.has(id))} onChange={(e) => toggle(ids, e.target.checked)} />
                          {dayLabel(group.day)}
                        </label>
                        <span className="text-xs text-slate">{`To pay ${inrPrecise(group.due)}`}{group.waiting > 0 ? ` · ` : ""}{group.waiting > 0 ? `Waiting ${inrPrecise(group.waiting)}` : ""}</span>
                      </div>
                      <ul className="divide-y divide-border/60">
                        {group.lines.map((line) => {
                          const state = lineState(line);
                          const reason = waitingReason(line);
                          return (
                            <li key={line.order_item_id} className="flex items-start gap-2 px-3 py-2 text-sm">
                              <input type="checkbox" aria-label={`Pay ${line.order_no}`} className="mt-1 h-4 w-4 shrink-0" disabled={line.due_amount <= 0}
                                checked={picked.has(line.order_item_id)} onChange={(e) => toggle([line.order_item_id], e.target.checked)} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                  <Link to="/admin/orders/$id" params={{ id: line.order_no }} className="break-all font-mono text-xs font-semibold text-navy hover:underline">{line.order_no}</Link>
                                  <span className="tabular-nums font-semibold text-navy">{inrPrecise(line.amount)}</span>
                                </div>
                                <p className="break-words text-xs text-slate">{line.product_name} × {line.qty} · {line.customer_name}{line.pin ? ` · ${line.pin}` : ""}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATE_STYLE[state])}>{state}</span>
                                  {line.paid_amount !== 0 && <span className="text-slate">{`Paid ${inrPrecise(line.paid_amount)}`}</span>}
                                  {line.due_amount !== 0 && <span className={line.due_amount < 0 ? "font-semibold text-red-700" : "font-semibold text-amber-700"}>{line.due_amount < 0 ? `Take back ${inrPrecise(-line.due_amount)}` : `Balance ${inrPrecise(line.due_amount)}`}</span>}
                                  {reason && <span className="text-slate">{reason} ({line.order_status} · {line.payment_status})</span>}
                                  {line.payout_nos.length > 0 && <span className="text-slate">{line.payout_nos.join(", ")}</span>}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <div className="sticky bottom-2 z-10 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold bg-card px-3 py-2 shadow-card">
                <p className="text-sm text-navy">{`${picked.size} selected · ${inrPrecise(selection.gross)}`}{selection.recovered > 0 ? ` - ${inrPrecise(selection.recovered)} = ${inrPrecise(selection.most)}` : ""}</p>
                <Button className="bg-navy text-white hover:bg-navy/90" disabled={!picked.size} onClick={() => setPaying(true)}><Banknote className="mr-1.5 h-4 w-4" />Record payout</Button>
              </div>
            </>
          )}
        </Panel>
      </div>

      <div id="payout-history" className="scroll-mt-36">
        <Panel title="Payout history"
          action={<button type="button" onClick={download} disabled={!shownPayouts.length} className="inline-flex items-center gap-1.5 text-xs font-semibold text-gold hover:underline disabled:opacity-50"><FileSpreadsheet className="h-3.5 w-3.5" />Download Excel</button>}>
          <div className="mb-3">
            <select aria-label="Partner" value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)} className="h-9 w-full max-w-xs rounded-md border border-input bg-white px-2 text-sm">
              <option value="">All partners</option>
              {(positions ?? []).map((row) => <option key={row.partner_id} value={row.partner_id}>{row.partner_name}</option>)}
            </select>
          </div>
          {historyFilter && <FilterNote label={partnerName(historyFilter)} onClear={() => setHistoryFilter("")} />}
          {!payouts ? <p className="text-sm text-slate">Loading…</p> : !shownPayouts.length ? <p className="py-6 text-center text-sm text-slate">No payouts recorded yet.</p> : (
            <ul className="space-y-2">
              {shownPayouts.map((row) => (
                <li key={row.id} className={cn("rounded-lg border border-border p-3 text-sm", row.status === "voided" && "bg-slate-50 opacity-75")}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-semibold text-navy">{row.payout_no} · {partnerName(row.partner_id)}</span>
                    <span className={cn("tabular-nums font-bold text-navy", row.status === "voided" && "line-through")}>{inrPrecise(row.amount)}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-slate">{dayLabel(row.paid_on)} · {row.mode}{row.reference ? ` · ${row.reference}` : ""}{row.recovered_total > 0 ? ` · ${inrPrecise(row.recovered_total)} taken back` : ""}{row.note ? ` · ${row.note}` : ""}</p>
                  <p className="text-xs text-slate">{`Recorded by ${row.created_by_name || "—"}`}</p>
                  {row.status === "voided" && <p className="text-xs font-semibold text-red-700">{`${payoutStatusLabel(row.status)}: ${row.void_reason}`}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setViewing(row)}><History className="mr-1.5 h-3.5 w-3.5" />Details</Button>
                    {row.status === "paid" && <Button size="sm" variant="outline" onClick={() => setCorrecting(row)}>Correct details</Button>}
                    {row.status === "paid" && <Button size="sm" variant="outline" className="text-danger hover:border-danger" onClick={() => setUndoing(row)}><Undo2 className="mr-1.5 h-3.5 w-3.5" />Undo</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {paying && position && (
        <RecordPayoutDialog position={position} ids={[...picked]} selection={selection} from={from} to={to}
          onClose={() => setPaying(false)} onDone={async () => { setPaying(false); await reload(); }} />
      )}
      {viewing && <PayoutDetailsDialog payout={viewing} partner={partnerName(viewing.partner_id)} onClose={() => setViewing(null)} />}
      {correcting && <CorrectPayoutDialog payout={correcting} onClose={() => setCorrecting(null)} onDone={async () => { setCorrecting(null); await reload(); }} />}
      {undoing && <UndoPayoutDialog payout={undoing} onClose={() => setUndoing(null)} onDone={async () => { setUndoing(null); await reload(); }} />}
    </PanelLayout>
  );
}

function ModeField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1"><Label className="text-xs">Paid by</Label>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border border-input bg-white px-2 text-base sm:text-sm">
        {PAYOUT_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        {disabled && <option value={value}>{value}</option>}
      </select>
    </div>
  );
}

function RecordPayoutDialog({ position, ids, selection, from, to, onClose, onDone }: {
  position: PartnerPosition; ids: string[]; selection: { gross: number; recovered: number; most: number }; from: string; to: string; onClose: () => void; onDone: () => Promise<void>;
}) {
  const today = istToday();
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState(String(selection.most));
  const [mode, setMode] = useState<string>("UPI");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // One press of the button, however many times it is pressed or retried.
  const requestKey = useRef(crypto.randomUUID());
  const value = Number(amount);
  const problem = payoutProblem({ amount: value, most: selection.most, recovered: selection.recovered, mode, reference, paidOn, today });
  const part = value > 0 && value < selection.most;
  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("admin_create_partner_payout", {
      _partner_id: position.partner_id, _item_ids: ids, _paid_on: paidOn, _mode: mode, _reference: reference, _note: note.trim(), _amount: rupees(value),
      ...(from ? { _period_from: from } : {}), ...(to ? { _period_to: to } : {}), _request_key: requestKey.current,
    });
    setBusy(false);
    if (error) { toast.error("The payout was not recorded", { description: error.message }); return; }
    const saved = data as { payout_no?: string } | null;
    toast.success(`Payout ${saved?.payout_no ?? ""} recorded`, { description: `${position.partner_name} now sees it on their dashboard.` });
    await onDone();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Record payout · ${position.partner_name}`}</DialogTitle>
          <DialogDescription>Record this after the money has been sent. Nothing is paid from here.</DialogDescription>
        </DialogHeader>
        <dl className="space-y-1 rounded-md bg-ivory/70 p-3 text-sm">
          <div className="flex justify-between"><dt className="text-slate">Commissions selected ({ids.length})</dt><dd className="font-semibold text-navy">{inrPrecise(selection.gross)}</dd></div>
          {selection.recovered > 0 && <div className="flex justify-between"><dt className="text-slate">Taken back (paid too much earlier)</dt><dd className="font-semibold text-red-700">-{inrPrecise(selection.recovered)}</dd></div>}
          <div className="flex justify-between border-t border-border pt-1"><dt className="font-semibold text-navy">To pay</dt><dd className="font-bold text-navy">{inrPrecise(selection.most)}</dd></div>
        </dl>
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="grid gap-1"><Label className="text-xs">Date paid</Label><Input type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} /></div>
          <div className="grid gap-1"><Label className="text-xs">Amount paid (₹)</Label><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <ModeField value={mode} onChange={setMode} />
          <div className="grid gap-1"><Label className="text-xs">{mode === "Cash" ? "Voucher no. (optional)" : "UTR / reference"}</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" /></div>
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs">Note (optional)</Label><Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="bg-white text-base sm:text-sm" /></div>
        </div>
        {part && <p className="text-xs text-amber-700">Part payment: the oldest commissions are paid first, and {inrPrecise(rupees(selection.most - value))} stays to pay.</p>}
        {selection.most === 0 && <p className="text-xs text-slate">Earlier overpayments cover all of this, so no money moves. It is recorded as an adjustment.</p>}
        {problem && <p className="text-xs text-danger">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy || Boolean(problem)} onClick={() => void save()}>{busy ? "Saving…" : "Save payout"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayoutDetailsDialog({ payout, partner, onClose }: { payout: PayoutRow; partner: string; onClose: () => void }) {
  const [lines, setLines] = useState<{ id: string; order_no: string; product_name: string; amount: number }[] | null>(null);
  const [events, setEvents] = useState<{ id: string; event: string; at: string; by_name: string; detail: Record<string, unknown> }[]>([]);
  useEffect(() => {
    void Promise.all([
      supabase.from("partner_payout_lines").select("id,order_no,product_name,amount").eq("payout_id", payout.id).order("placed_at"),
      supabase.from("partner_payout_events").select("id,event,at,by_name,detail").eq("payout_id", payout.id).order("at"),
    ]).then(([a, b]) => {
      setLines((a.data ?? []).map((row) => ({ ...row, amount: Number(row.amount) })));
      setEvents((b.data ?? []) as never);
    });
  }, [payout.id]);
  const EVENT: Record<string, string> = { created: "Recorded", corrected: "Details corrected", voided: "Undone" };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{`${payout.payout_no} · ${partner}`}</DialogTitle><DialogDescription>{dayLabel(payout.paid_on)} · {payout.mode}{payout.reference ? ` · ${payout.reference}` : ""}</DialogDescription></DialogHeader>
        {!lines ? <p className="text-sm text-slate">Loading…</p> : (
          <ul className="divide-y divide-border/60 text-sm">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0"><span className="block break-all font-mono text-xs text-navy">{line.order_no}</span><span className="block text-xs text-slate">{line.product_name}</span></span>
                <span className={cn("shrink-0 tabular-nums font-semibold", line.amount < 0 ? "text-red-700" : "text-navy")}>{inrPrecise(line.amount)}</span>
              </li>
            ))}
            <li className="flex justify-between py-1.5 font-bold text-navy"><span>Money paid</span><span className="tabular-nums">{inrPrecise(payout.amount)}</span></li>
          </ul>
        )}
        <div className="border-t border-border pt-2">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-slate">History</p>
          <ul className="space-y-1 text-xs text-slate">
            {events.map((event) => (
              <li key={event.id}>{new Date(event.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} · {EVENT[event.event] ?? event.event} · {event.by_name || "—"}{typeof event.detail?.["reason"] === "string" ? `: ${String(event.detail["reason"])}` : ""}</li>
            ))}
          </ul>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CorrectPayoutDialog({ payout, onClose, onDone }: { payout: PayoutRow; onClose: () => void; onDone: () => Promise<void> }) {
  const adjustment = payout.mode === "Adjustment";
  const [paidOn, setPaidOn] = useState(payout.paid_on);
  const [mode, setMode] = useState(payout.mode);
  const [reference, setReference] = useState(payout.reference);
  const [note, setNote] = useState(payout.note);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_correct_partner_payout", { _payout_id: payout.id, _paid_on: paidOn, _mode: mode, _reference: reference, _note: note.trim(), _reason: reason.trim() });
    setBusy(false);
    if (error) { toast.error("Could not correct the payout", { description: error.message }); return; }
    toast.success("Payout corrected");
    await onDone();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{`Correct ${payout.payout_no}`}</DialogTitle><DialogDescription>To change the amount, undo this payout and record it again.</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="grid gap-1"><Label className="text-xs">Date paid</Label><Input type="date" value={paidOn} max={istToday()} onChange={(e) => setPaidOn(e.target.value)} /></div>
          <ModeField value={mode} onChange={setMode} disabled={adjustment} />
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs">{mode === "Cash" ? "Voucher no. (optional)" : "UTR / reference"}</Label><Input value={reference} disabled={adjustment} onChange={(e) => setReference(e.target.value)} autoComplete="off" /></div>
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs">Note (optional)</Label><Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="bg-white text-base sm:text-sm" /></div>
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs">Why is this being corrected?</Label><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy || reason.trim().length < 4} onClick={() => void save()}>{busy ? "Saving…" : "Save correction"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UndoPayoutDialog({ payout, onClose, onDone }: { payout: PayoutRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_void_partner_payout", { _payout_id: payout.id, _reason: reason.trim() });
    setBusy(false);
    if (error) { toast.error("Could not undo the payout", { description: error.message }); return; }
    toast.success(`${payout.payout_no} undone`, { description: "Its commissions are due again." });
    await onDone();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{`Undo ${payout.payout_no}?`}</DialogTitle><DialogDescription>{`${inrPrecise(payout.amount)} goes back to To pay. The record stays and shows as undone, to the partner too.`}</DialogDescription></DialogHeader>
        <div className="grid gap-1"><Label className="text-xs">Why is this being undone?</Label><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="For example: the transfer bounced" /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button className="bg-danger text-white hover:bg-danger/90" disabled={busy || reason.trim().length < 4} onClick={() => void save()}>{busy ? "Undoing…" : "Undo payout"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
