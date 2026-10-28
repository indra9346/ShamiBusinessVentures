import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, Clock, KeyRound, MessageSquare, QrCode, ShieldAlert, Smartphone, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DEFAULT_UPI_SETTINGS, isValidVpa, settingsProblem, upiPaymentUri, type UpiSettings } from "@/lib/upi-pay";
import { loadUpiAudit, reviewUpiPayment, saveUpiSettings, settleBankCredit, useUpiPayments, type BankCredit, type UpiAuditRow } from "@/lib/upi-store";
import { parseBankCredit } from "@/lib/bank-alert";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft } from "@/lib/payment-hold";
import { CustomersPayingNow } from "@/components/panel/CustomersPayingNow";
import { ResizableTable } from "@/hooks/use-column-resize";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/upi-payments")({
  head: () => ({ meta: [{ title: "UPI Payments | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminUpiPayments,
});

const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Direct UPI (zero gateway fee): the business UPI ID customers pay, and the UTRs customers send
 * after paying, to be checked against the bank account and confirmed (marks the order paid).
 */
function AdminUpiPayments() {
  const { settings, submissions, credits } = useUpiPayments();
  const { confirmPayment, paymentHolds, simulateBankAlert } = useApp();
  const awaiting = paymentHolds.filter((hold) => hold.status === AWAITING_PAYMENT);
  const [form, setForm] = useState<UpiSettings>(DEFAULT_UPI_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  const [audit, setAudit] = useState<UpiAuditRow[]>([]);
  useEffect(() => { if (settings) setForm(settings); }, [settings]);
  useEffect(() => { void loadUpiAudit().then(setAudit); }, [settings]);

  const problem = settingsProblem(form);
  const previewQr = useMemo(() => (isValidVpa(form.vpa) ? renderSVG(upiPaymentUri(form, 1, "TEST-1"), { border: 2 }) : ""), [form]);
  const waiting = submissions.filter((s) => s.status === "submitted");
  const done = submissions.filter((s) => s.status !== "submitted");

  const save = async () => {
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      await saveUpiSettings({ ...form, vpa: form.vpa.trim(), payeeName: form.payeeName.trim() });
      toast.success(form.enabled ? "Direct UPI is on at checkout" : "Settings saved (direct UPI is off)");
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const confirm = async (orderNo: string, amount: number, utr: string) => {
    if (!window.confirm(`Confirm ${inrPrecise(amount)} for ${orderNo}?\n\nOnly confirm after you see a credit with UTR ${utr} for this amount in the bank account.`)) return;
    setBusy(orderNo);
    try {
      if (STATIC_DATA_MODE) {
        // Demo: a held checkout becomes an order; an older demo order is marked paid like a manual payment.
        if (awaiting.some((hold) => hold.orderNo === orderNo)) simulateBankAlert(orderNo);
        else if (!(await confirmPayment(orderNo, amount, utr))) throw new Error("The order could not be marked paid");
      }
      // Live: one database step records the payment (order paid, sent to Zoho Books) and closes the UTR.
      await reviewUpiPayment(orderNo, "confirmed");
      toast.success(`${orderNo} marked paid`, { description: `UTR ${utr}` });
    } catch (cause) {
      toast.error("Could not confirm", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };
  const reject = async (orderNo: string) => {
    const note = window.prompt("Why is this UTR not accepted? The customer sees this.", "No matching credit in the bank account");
    if (note === null) return;
    setBusy(orderNo);
    try {
      await reviewUpiPayment(orderNo, "rejected", note.trim() || undefined);
      toast.message(`${orderNo}: UTR rejected`, { description: "The customer is told and can send a corrected UTR." });
    } catch (cause) {
      toast.error("Could not reject", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="UPI Payments" subtitle="Zero-fee UPI straight to the company's bank account">
      {STATIC_DATA_MODE ? (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <ShieldAlert className="mr-1 inline h-4 w-4" /> Demo / mock: settings and payments here are kept only in this browser. No real money moves.
        </p>
      ) : (
        <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
          <p className="font-semibold"><ShieldAlert className="mr-1 inline h-4 w-4" /> Where the money goes</p>
          <p className="mt-1">Customers pay the business UPI ID below, and their bank sends the money straight to the bank account that UPI ID is linked to (the company's current account). The website never holds money. Before switching on, scan the ₹1 test QR: your UPI app shows the bank-registered name of the account, and it must be the company's. Every change of the UPI ID is logged below and every admin is notified.</p>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Waiting for your check" value={String(waiting.length)} icon={QrCode} highlight={waiting.length > 0} description={waiting.length ? `${inrPrecise(waiting.reduce((s, w) => s + w.amount, 0))} to match in the bank` : "Nothing to check"} />
        <StatCard label="Confirmed" value={String(done.filter((s) => s.status === "confirmed").length)} icon={CheckCircle2} description="Marked paid" />
        <StatCard label="Rejected" value={String(done.filter((s) => s.status === "rejected").length)} icon={XCircle} description="Customer asked to correct" />
      </div>

      <Panel title="Payments to check" className="mb-6">
        <p className="mb-3 text-xs text-slate">Open the bank account (or its UPI app), find a credit with this <b>UTR</b> and <b>amount</b>, then confirm. Confirming marks the order paid, like a manual payment.</p>
        {!waiting.length ? <p className="text-sm text-slate">No UPI payments waiting.</p> : (
          <div className="overflow-x-auto">
            <ResizableTable tableId="upi-waiting" className="w-full min-w-[760px] text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                <th className="px-2 py-2">Sent</th><th className="px-2 py-2">Order</th><th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2">UTR</th><th className="px-2 py-2">Action</th>
              </tr></thead>
              <tbody>
                {waiting.map((s) => (
                  <tr key={s.orderNo} className="border-b border-border/60">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate">{istTime(s.submittedAt)}</td>
                    <td className="px-2 py-2 font-mono text-xs"><Link to="/admin/orders/$id" params={{ id: s.orderNo }} className="text-navy hover:text-gold">{s.orderNo}</Link></td>
                    <td className="px-2 py-2">{s.customer || "—"}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{inrPrecise(s.amount)}</td>
                    <td className="px-2 py-2 font-mono tracking-wider">{s.utr}</td>
                    <td className="px-2 py-2">
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy === s.orderNo} onClick={() => void confirm(s.orderNo, s.amount, s.utr)}>Confirm paid</Button>
                        <Button size="sm" variant="outline" className="text-danger" disabled={busy === s.orderNo} onClick={() => void reject(s.orderNo)}>Reject</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        )}
      </Panel>

      <Panel title="Waiting for payment (not orders yet)" className="mb-6">
        <p className="mb-3 text-xs text-slate">Checkouts whose customer has not paid yet. Their stock is held; they become orders the moment the bank alert (or your confirmation) matches the payment, and end on their own when the time is up.</p>
        <CustomersPayingNow />
      </Panel>

      <BankAlertsPanel credits={credits} onDemoMatch={(amount) => {
        const hold = awaiting.find((candidate) => Math.abs(candidate.amount - amount) < 0.005);
        if (hold) { simulateBankAlert(hold.orderNo); toast.success(`${hold.orderNo} paid and placed`); }
        else toast.message("No checkout is waiting for that amount", { description: "Kept as unmatched money." });
      }} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <Panel title="Settings">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Business UPI ID</Label>
              <Input value={form.vpa} placeholder="e.g. shamibusiness@icici" onChange={(e) => setForm({ ...form, vpa: e.target.value })} />
              <p className="text-[11px] text-slate">From the company's current account or business UPI app (PhonePe / Paytm for Business). UPI to a business account has no MDR.</p>
            </div>
            <div className="grid gap-1.5">
              <Label>Name customers see</Label>
              <Input value={form.payeeName} onChange={(e) => setForm({ ...form, payeeName: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Minutes to pay</Label>
              <Input type="number" min={5} max={60} value={form.payWindowMinutes} onChange={(e) => setForm({ ...form, payWindowMinutes: Number(e.target.value) })} />
            </div>
            <label className="flex items-center gap-3 self-end text-sm">
              <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
              <span>
                <span className="font-semibold text-navy">Show "Pay by UPI" at checkout</span>
                <span className="block text-[11px] text-slate">Off until a UPI ID is entered and you switch it on</span>
              </span>
            </label>
          </div>
          {problem && <p className="mt-3 text-xs font-semibold text-danger">{problem}</p>}
          <div className="mt-4"><Button className="bg-navy text-white hover:bg-navy/90" disabled={saving} onClick={() => void save()}>Save settings</Button></div>
        </Panel>
        <Panel title="Test QR (₹1)">
          {previewQr ? (
            <>
              <div className="mx-auto w-[180px] rounded-lg border border-border bg-white p-2" dangerouslySetInnerHTML={{ __html: previewQr }} />
              <p className="mt-2 text-center text-[11px] text-slate">Scan with your own UPI app to check the name and UPI ID shown (₹1 test). Do not pay if anything looks wrong.</p>
            </>
          ) : <p className="text-sm text-slate">Enter a valid UPI ID to see a test QR.</p>}
        </Panel>
      </div>

      {audit.length > 0 && (
        <Panel title="UPI ID change log" className="mt-6">
          <ul className="space-y-1 text-sm">
            {audit.map((a, i) => (
              <li key={`${a.changedAt}-${i}`} className="flex flex-wrap gap-x-3 border-b border-border/60 pb-1">
                <span className="text-xs text-slate">{istTime(a.changedAt)}</span>
                <span className="font-mono text-xs">{a.oldVpa || "—"} → <b>{a.newVpa || "—"}</b></span>
                <span className="text-xs">{a.newEnabled ? "switched ON" : "OFF"}{a.payeeName ? ` · ${a.payeeName}` : ""}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {done.length > 0 && (
        <Panel title="Checked payments" className="mt-6">
          <div className="overflow-x-auto">
            <ResizableTable tableId="upi-done" className="w-full min-w-[700px] text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                <th className="px-2 py-2">Checked</th><th className="px-2 py-2">Order</th><th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2">UTR</th><th className="px-2 py-2">Result</th>
              </tr></thead>
              <tbody>
                {done.map((s) => (
                  <tr key={s.orderNo} className="border-b border-border/60">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate">{s.reviewedAt ? istTime(s.reviewedAt) : "—"}</td>
                    <td className="px-2 py-2 font-mono text-xs">{s.orderNo}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{inrPrecise(s.amount)}</td>
                    <td className="px-2 py-2 font-mono">{s.utr}</td>
                    <td className={cn("px-2 py-2 text-xs font-semibold", s.status === "confirmed" ? "text-emerald-700" : "text-danger")}>
                      {s.status === "confirmed" ? "Confirmed paid" : `Rejected${s.note ? `: ${s.note}` : ""}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        </Panel>
      )}
    </PanelLayout>
  );
}

const CREDIT_STATUS: Record<BankCredit["status"], { label: string; tone: string }> = {
  matched: { label: "Order paid automatically", tone: "text-emerald-700" },
  unmatched: { label: "No checkout for it", tone: "text-slate" },
  ambiguous: { label: "Several checkouts: waiting for the customer's UTR", tone: "text-amber-700" },
  mismatch: { label: "Wrong amount: you decide", tone: "text-danger" },
  late: { label: "Paid after time ran out: refund or place by hand", tone: "text-danger" },
  settled: { label: "Settled", tone: "text-slate" },
};

/**
 * Automatic capture: the company phone forwards each bank SMS to the website, which reads the
 * amount and UTR and confirms the matching checkout. Shows the set-up, an SMS tester, and every
 * alert received, with the ones that need a person.
 */
function BankAlertsPanel({ credits, onDemoMatch }: { credits: BankCredit[]; onDemoMatch: (amount: number) => void }) {
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState("");
  const [suggestedKey, setSuggestedKey] = useState("");
  const parsed = sample.trim() ? parseBankCredit(sample) : null;
  const endpoint = typeof window === "undefined" ? "https://grainbazar.com/api/payments/bank-alert" : `${window.location.origin}/api/payments/bank-alert`;
  const lastAlert = credits[0]?.receivedAt;
  const needsYou = credits.filter((credit) => ["ambiguous", "mismatch", "late"].includes(credit.status));

  const settle = async (credit: BankCredit) => {
    const note = window.prompt(`What was done about ₹${credit.amount} (UTR ${credit.utr})? For example: refunded on 28 Oct, or order placed by hand.`, "");
    if (!note?.trim()) return;
    setBusy(credit.id);
    try {
      await settleBankCredit(credit.id, note.trim());
      toast.success("Marked settled");
    } catch (cause) {
      toast.error("Could not settle", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  return (
    <Panel title="Automatic payment capture (bank SMS)" className="mb-6">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-2 text-sm text-charcoal">
          <p className="flex items-center gap-2 font-semibold text-navy"><Smartphone className="h-4 w-4 text-gold" /> Set up once on the company phone (the SIM that gets the bank's credit SMS)</p>
          <ol className="list-decimal space-y-1 pl-5 text-[13px]">
            <li>Install a free SMS-forwarding app (for example <b>SMS to URL Forwarder</b> on Android) and allow it to read SMS.</li>
            <li>Make a long random key (button below) and save it in Hostinger as the environment variable <code className="rounded bg-muted px-1">BANK_ALERT_KEY</code>, then redeploy.</li>
            <li>In the app, forward the bank's SMS sender (e.g. SBIUPI, HDFCBK) to this address with method POST:
              <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-[12px]">{endpoint}?key=YOUR_KEY</code></li>
            <li>Send yourself ₹1 by UPI to the business UPI ID: the alert appears below within a minute.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => {
              const bytes = new Uint8Array(24);
              crypto.getRandomValues(bytes);
              setSuggestedKey(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
            }}><KeyRound className="mr-1 h-3.5 w-3.5" /> Make a key</Button>
            {suggestedKey && <code className="break-all rounded bg-muted px-2 py-1 text-[12px]">{suggestedKey}</code>}
          </div>
          <p className="text-[11px] text-slate">The key is shown only here and is not saved by this page. Keep it private: anyone with it could send fake alerts.</p>
          <p className="text-xs text-slate">Last alert received: <b>{lastAlert ? istTime(lastAlert) : "none yet"}</b></p>
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-navy"><MessageSquare className="h-4 w-4 text-gold" /> Test a bank SMS</p>
          <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={4} placeholder="Paste a money-received SMS from the bank"
            className="w-full rounded-md border border-input bg-white p-2 text-sm" />
          {sample.trim() && (parsed ? (
            <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-900">Read as <b>{inrPrecise(parsed.amount)}</b> received · UTR <b className="font-mono">{parsed.utr}</b>{parsed.payer ? ` · from ${parsed.payer}` : ""}</p>
          ) : (
            <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">Not read as a payment (a debit, or no amount / 12-digit UTR). Such SMS are ignored.</p>
          ))}
          {STATIC_DATA_MODE && parsed && (
            <Button size="sm" className="bg-navy text-white" onClick={() => onDemoMatch(parsed.amount)}>Demo: receive this SMS</Button>
          )}
        </div>
      </div>

      {needsYou.length > 0 && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{needsYou.length} payment{needsYou.length === 1 ? "" : "s"} need you: refund, or place the order by hand, then mark settled.</p>
      )}
      {credits.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <ResizableTable tableId="upi-bank-alerts" className="w-full min-w-[820px] text-left text-sm">
            <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
              <th className="px-2 py-2">Received</th><th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2">UTR</th>
              <th className="px-2 py-2">From</th><th className="px-2 py-2">Order</th><th className="px-2 py-2">Result</th><th className="px-2 py-2" />
            </tr></thead>
            <tbody>
              {credits.map((credit) => (
                <tr key={credit.id} className="border-b border-border/60" title={credit.raw ?? undefined}>
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-slate">{istTime(credit.receivedAt)}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">{inrPrecise(credit.amount)}</td>
                  <td className="px-2 py-2 font-mono text-xs">{credit.utr}</td>
                  <td className="px-2 py-2 text-xs">{credit.payer ?? credit.sender ?? "—"}</td>
                  <td className="px-2 py-2 font-mono text-xs">{credit.orderNo ?? "—"}</td>
                  <td className={cn("px-2 py-2 text-xs font-semibold", CREDIT_STATUS[credit.status].tone)}>
                    {CREDIT_STATUS[credit.status].label}{credit.note ? ` · ${credit.note}` : ""}
                  </td>
                  <td className="px-2 py-2">
                    {["ambiguous", "mismatch", "late", "unmatched"].includes(credit.status) && (
                      <Button size="sm" variant="outline" disabled={busy === credit.id} onClick={() => void settle(credit)}>Mark settled</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>
      )}
    </Panel>
  );
}
