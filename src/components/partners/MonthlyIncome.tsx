import { useCallback, useRef, useState } from "react";
import { Lock, Plus, Trash2, Unlock } from "lucide-react";
import { toast } from "sonner";
import { Panel } from "@/components/panel/widgets";
import { useLiveRefresh } from "@/components/partners/PartnerWidgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { monthLabel } from "@/lib/partners";
import {
  DEDUCTION_CATEGORIES, STATE_LABEL, asMonthStatement, categoryLabel, deductionProblem, eventLabel, incomeSteps, percentText, ratesProblem, resultSteps, statementState,
  type MonthStatement, type Step,
} from "@/lib/partner-month";
import { cn } from "@/lib/utils";

const money = (value: number) => (value < 0 ? `-${inrPrecise(-value)}` : inrPrecise(value));
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const STATE_STYLE: Record<string, string> = {
  running: "bg-sky-100 text-sky-800",
  to_close: "bg-amber-100 text-amber-800",
  to_pay: "bg-amber-100 text-amber-800",
  part_paid: "bg-amber-100 text-amber-800",
  paid: "bg-emerald-100 text-emerald-800",
  nothing_to_pay: "bg-slate-100 text-slate-600",
};

function Steps({ steps }: { steps: Step[] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {steps.map((step) => (
        <div key={step.key} className={cn("flex items-baseline justify-between gap-3", step.kind === "total" && "border-t border-border pt-1.5 font-bold text-navy", step.kind === "share" && "mt-1 rounded-md bg-ivory px-2 py-1.5 font-bold text-navy")}>
          <dt className={cn("min-w-0", !step.kind || step.kind === "minus" ? "text-slate" : "")}>{step.label}</dt>
          <dd className="shrink-0 tabular-nums font-semibold">{step.kind === "minus" && step.amount > 0 ? `-${inrPrecise(step.amount)}` : money(step.amount)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One godown's month on monthly profit share: total income, the deductions, income tax and what remains, live. The partner
 * and the admin both add deductions; the admin also closes the month. Nothing shows for a month on per-unit commission.
 */
export function MonthlyIncome({ month, branchId, audience, onLoaded }: {
  month: string;
  /** Only the admin names a godown; a partner always gets their own. */
  branchId?: string;
  audience: "partner" | "admin";
  onLoaded?: (statement: MonthStatement | null) => void;
}) {
  const [statement, setStatement] = useState<MonthStatement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("partner_month_statement", { _month: month, ...(branchId ? { _branch_id: branchId } : {}) });
    if (error) { setFailed(true); setLoaded(true); onLoaded?.(null); return; }
    const next = asMonthStatement(data);
    setFailed(false);
    setStatement(next);
    setLoaded(true);
    onLoaded?.(next);
  }, [month, branchId, onLoaded]);
  useLiveRefresh(load, [load]);

  if (audience === "partner" && (failed || !statement)) return null;
  const title = `Monthly income · ${monthLabel(month)}`;
  if (failed) return <Panel title={title}><p role="alert" className="text-sm text-red-700">Could not load this month.</p></Panel>;
  if (!loaded) return <Panel title={title}><p className="text-sm text-slate">Loading…</p></Panel>;
  if (!statement) return <Panel title={title}><p className="text-sm text-slate">This godown is on per-unit commission for this month. Change it on the Channel Partners page.</p></Panel>;

  const state = statementState(statement);
  return (
    <Panel id="monthly-income" title={title} action={<span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", STATE_STYLE[state])}>{STATE_LABEL[state]}</span>}>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Total income</h3>
          <Steps steps={incomeSteps(statement)} />
          <p className="mt-2 text-xs text-slate">{`${statement.orders} delivered and fully paid order${statement.orders === 1 ? "" : "s"}. All figures are before GST.`}</p>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Deductions</h3>
          <Deductions statement={statement} branchId={branchId} reload={load} />
        </section>
      </div>
      <section className="mt-6 max-w-xl">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">What remains</h3>
        <Steps steps={resultSteps(statement, audience)} />
        {statement.profit_before_tax <= 0 && <p className="mt-2 text-xs text-slate">No profit this month, so there is no share to pay. A loss is not carried into the next month.</p>}
        {statement.status === "closed" && statement.share_amount > 0 && (
          <p className="mt-2 text-sm text-navy">{`Paid ${inrPrecise(statement.paid)} · To pay ${inrPrecise(statement.due)}`}</p>
        )}
      </section>
      {statement.lines_without_cost > 0 && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{`${inrPrecise(statement.sales_without_cost)} of sales has no purchase rate, so it is left out of the income until the rate is entered.`}</p>
      )}
      {audience === "partner" && (
        <p className="mt-4 text-xs text-slate">
          {state === "running" ? "This month is still running. The figures change as orders are delivered and paid."
            : statement.status === "open" ? "The office will check this month and close it. After that the deductions are locked."
            : statement.closed_at ? `Closed on ${when(statement.closed_at)}.` : ""}
        </p>
      )}
      {statement.is_admin && branchId && <AdminControls statement={statement} branchId={branchId} reload={load} />}
    </Panel>
  );
}

function Deductions({ statement, branchId, reload }: { statement: MonthStatement; branchId: string | undefined; reload: () => Promise<void> }) {
  const [category, setCategory] = useState<string>("rent");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  // One press of the button, however many times it is pressed or retried.
  const requestKey = useRef(crypto.randomUUID());
  const problem = deductionProblem({ category, label, amount });
  const add = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("partner_add_month_deduction", {
      _month: statement.month, _category: category, _label: label.trim(), _amount: Number(amount),
      ...(branchId ? { _branch_id: branchId } : {}), _request_key: requestKey.current,
    });
    setBusy(false);
    if (error) { toast.error("The deduction was not added", { description: error.message }); return; }
    requestKey.current = crypto.randomUUID();
    setLabel("");
    setAmount("");
    toast.success("Deduction added");
    await reload();
  };
  const remove = async (id: string) => {
    const { error } = await supabase.rpc("partner_remove_month_deduction", { _deduction_id: id });
    if (error) { toast.error("The deduction was not removed", { description: error.message }); return; }
    toast.success("Deduction removed");
    await reload();
  };
  return (
    <div className="space-y-3">
      {statement.deductions.length ? (
        <ul className="divide-y divide-border/60 text-sm">
          {statement.deductions.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 py-1.5">
              <span className="min-w-0">
                <span className="block font-semibold text-navy">{categoryLabel(row.category)}</span>
                {row.label && <span className="block break-words text-xs text-charcoal">{row.label}</span>}
                <span className="block text-xs text-slate">{`Added by ${row.added_by_name || "—"}`}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="tabular-nums font-semibold text-navy">{inrPrecise(row.amount)}</span>
                {row.can_remove && (
                  <button type="button" aria-label={`Remove ${row.label || categoryLabel(row.category)}`} onClick={() => void remove(row.id)} className="grid h-8 w-8 place-items-center rounded-md text-slate hover:bg-red-50 hover:text-red-700">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </span>
            </li>
          ))}
          <li className="flex justify-between gap-3 py-1.5 font-bold text-navy"><span>Total deductions</span><span className="tabular-nums">{inrPrecise(statement.deductions_total)}</span></li>
        </ul>
      ) : <p className="text-sm text-slate">No deductions added yet.</p>}
      {statement.can_add ? (
        <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="grid gap-1"><Label className="text-xs">Deduction for</Label>
            <select aria-label="Deduction for" value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 w-full rounded-md border border-input bg-white px-2 text-base sm:text-sm">
              {DEDUCTION_CATEGORIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </div>
          <div className="grid gap-1"><Label className="text-xs">Amount (₹)</Label><Input aria-label="Amount (₹)" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
          <div className="grid gap-1 sm:col-span-2"><Label className="text-xs">{category === "other" ? "What is it for?" : "Details (optional)"}</Label><Input aria-label={category === "other" ? "What is it for?" : "Details (optional)"} maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} /></div>
          <div className="sm:col-span-2">
            <Button className="w-full bg-navy text-white hover:bg-navy/90 sm:w-auto" disabled={busy || Boolean(problem)} onClick={() => void add()}><Plus className="mr-1.5 h-4 w-4" />{busy ? "Adding…" : "Add deduction"}</Button>
          </div>
        </div>
      ) : <p className="flex items-center gap-1.5 text-xs text-slate"><Lock className="h-3.5 w-3.5" />This month is closed, so the deductions are locked.</p>}
    </div>
  );
}

function AdminControls({ statement, branchId, reload }: { statement: MonthStatement; branchId: string; reload: () => Promise<void> }) {
  const [share, setShare] = useState(statement.share_percent === null ? "" : percentText(statement.share_percent));
  const [tax, setTax] = useState(percentText(statement.tax_percent));
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const problem = ratesProblem(share, tax);
  const open = statement.status === "open";
  const saveRates = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_set_partner_month_rates", { _branch_id: branchId, _month: statement.month, _share_percent: Number(share), _tax_percent: Number(tax) });
    setBusy(false);
    if (error) { toast.error("The percentages were not saved", { description: error.message }); return; }
    toast.success("Percentages saved for this month");
    await reload();
  };
  const lines = statement.lines ?? [];
  return (
    <div className="mt-6 space-y-4 border-t border-border pt-4">
      {open && (
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate">Percentages for this month</h3>
          <div className="grid max-w-xl gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end [&>*]:min-w-0">
            <div className="grid gap-1"><Label className="text-xs">Partner's share (%)</Label><Input aria-label="Partner's share (%)" inputMode="decimal" value={share} onChange={(event) => setShare(event.target.value)} /></div>
            <div className="grid gap-1"><Label className="text-xs">Income tax (%)</Label><Input aria-label="Income tax (%)" inputMode="decimal" value={tax} onChange={(event) => setTax(event.target.value)} /></div>
            <Button variant="outline" disabled={busy || Boolean(problem)} onClick={() => void saveRates()}>Save for this month</Button>
          </div>
          {problem ? <p className="mt-1 text-xs text-danger">{problem}</p> : statement.rates_custom ? <p className="mt-1 text-xs text-slate">This month has its own percentages.</p> : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {open && <Button className="bg-navy text-white hover:bg-navy/90" disabled={!statement.month_over} onClick={() => setClosing(true)}><Lock className="mr-1.5 h-4 w-4" />Close this month</Button>}
        {open && !statement.month_over && <p className="text-xs text-slate">A month can be closed when it is over.</p>}
        {!open && statement.paid === 0 && <Button variant="outline" onClick={() => setReopening(true)}><Unlock className="mr-1.5 h-4 w-4" />Reopen this month</Button>}
        {!open && statement.closed_at && <p className="text-xs text-slate">{`Closed on ${when(statement.closed_at)} by ${statement.closed_by_name || "—"}. Paid to ${statement.partner_name}.`}</p>}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold text-navy">{`Orders counted (${lines.length})`}</summary>
        {lines.length ? (
          <ul className="mt-2 divide-y divide-border/60">
            {lines.map((line, index) => (
              <li key={`${line.order_no}-${line.product_name}-${index}`} className="py-1.5">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="break-all font-mono text-xs font-semibold text-navy">{line.order_no}</span>
                  <span className="tabular-nums font-semibold text-navy">{line.cost_known ? money(line.sales - line.coupon - line.cost + line.delivery) : money(line.delivery)}</span>
                </span>
                <span className="block break-words text-xs text-slate">{line.product_name} × {line.qty}{line.row_kind === "correction" ? " · Correction" : ""}{line.cost_known ? "" : " · No purchase rate"}</span>
                <span className="block text-xs text-slate">{`Sale ${money(line.sales)} · Coupon ${money(line.coupon)} · Cost ${money(line.cost)} · Delivery ${money(line.delivery)}`}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-xs text-slate">No orders counted in this month yet.</p>}
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold text-navy">History</summary>
        {statement.events?.length ? (
          <ul className="mt-2 space-y-1 text-xs text-slate">
            {statement.events.map((event, index) => (
              <li key={`${event.at}-${index}`}>{when(event.at)} · {eventLabel(event.event)} · {event.by_name || "—"}{typeof event.detail?.["label"] === "string" && event.detail["label"] ? ` · ${String(event.detail["label"])}` : ""}{typeof event.detail?.["amount"] === "number" ? ` · ${inrPrecise(Number(event.detail["amount"]))}` : ""}{typeof event.detail?.["reason"] === "string" ? `: ${String(event.detail["reason"])}` : ""}</li>
            ))}
          </ul>
        ) : <p className="mt-2 text-xs text-slate">Nothing yet.</p>}
      </details>
      {closing && <CloseDialog statement={statement} branchId={branchId} onClose={() => setClosing(false)} onDone={async () => { setClosing(false); await reload(); }} />}
      {reopening && <ReopenDialog statement={statement} branchId={branchId} onClose={() => setReopening(false)} onDone={async () => { setReopening(false); await reload(); }} />}
    </div>
  );
}

function CloseDialog({ statement, branchId, onClose, onDone }: { statement: MonthStatement; branchId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_close_partner_month", { _branch_id: branchId, _month: statement.month });
    setBusy(false);
    if (error) { toast.error("The month was not closed", { description: error.message }); return; }
    toast.success("Month closed", { description: monthLabel(statement.month) });
    await onDone();
  };
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Close ${monthLabel(statement.month)}?`}</DialogTitle>
          <DialogDescription>The figures are stored and the deductions are locked. The partner's share then appears on Partner Payouts.</DialogDescription>
        </DialogHeader>
        <Steps steps={resultSteps(statement, "admin")} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy} onClick={() => void save()}>{busy ? "Closing…" : "Close month"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReopenDialog({ statement, branchId, onClose, onDone }: { statement: MonthStatement; branchId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_reopen_partner_month", { _branch_id: branchId, _month: statement.month, _reason: reason.trim() });
    setBusy(false);
    if (error) { toast.error("The month was not reopened", { description: error.message }); return; }
    toast.success("Month reopened", { description: monthLabel(statement.month) });
    await onDone();
  };
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{`Reopen ${monthLabel(statement.month)}?`}</DialogTitle><DialogDescription>Deductions can be changed again, and the partner's share goes off Partner Payouts until the month is closed again.</DialogDescription></DialogHeader>
        <div className="grid gap-1"><Label className="text-xs">Why is it being reopened?</Label><Input aria-label="Why is it being reopened?" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it closed</Button>
          <Button className="bg-navy text-white hover:bg-navy/90" disabled={busy || reason.trim().length < 4} onClick={() => void save()}>{busy ? "Reopening…" : "Reopen month"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
