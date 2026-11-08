import { EndedCheckouts } from "@/components/panel/EndedCheckouts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, Clock, KeyRound, Landmark, MessageSquare, QrCode, ShieldAlert, Smartphone, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { pushOrderToZohoInBackground, useApp } from "@/lib/store";
import { bankDetailChanges, bankDetailsProblem, cleanBankDetails, EMPTY_BANK_DETAILS, REFUNDED_UTR_NOTE, REUSED_UTR_NOTE, UNCHECKED_UTR_NOTE, type BankDetails } from "@/lib/payment-rules";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DEFAULT_UPI_SETTINGS, isValidVpa, settingsProblem, upiPaymentUri, type UpiSettings } from "@/lib/upi-pay";
import { RejectUtrDialog, type RejectChoice } from "@/components/panel/RejectUtrDialog";
import { isBankMethod } from "@/lib/payment-rules";
import { loadBankAudit, loadBankSettings, loadUpiAudit, markUtrRefunded, rejectUtrAndEndCheckout, reopenBankCredit, reviewUpiPayment, saveBankDetails, saveUpiSettings, settleBankCredit, useUpiPayments, type BankAuditRow, type BankCredit, type UpiAuditRow, type CreditWithoutUtr } from "@/lib/upi-store";
import { parseBankCredit, parseCreditWithoutReference } from "@/lib/bank-alert";
import { CreditHint, CreditsWithoutUtrPanel } from "@/components/panel/CreditsWithoutUtr";
import { SameUtrBadge, UtrChecksPanel, useUtrChecks } from "@/components/panel/UtrChecksPanel";
import { AWAITING_PAYMENT, clockText, holdSecondsLeft } from "@/lib/payment-hold";
import { CustomersPayingNow } from "@/components/panel/CustomersPayingNow";
import { ResizableTable } from "@/hooks/use-column-resize";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/upi-payments")({
  head: () => ({ meta: [{ title: "UPI & Bank Payments | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminUpiPayments,
});

const istTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Direct UPI (zero gateway fee) and NEFT/RTGS bank transfer: the business UPI ID and bank account
 * customers pay, and the UTRs customers send after paying, to be checked against the bank account and
 * confirmed (marks the order paid).
 */
function AdminUpiPayments() {
  const { settings, submissions, credits, creditsWithoutUtr } = useUpiPayments();
  const utrChecks = useUtrChecks();
  const { user, confirmPayment, paymentHolds, orders, simulateBankAlert, refreshHeldCheckouts } = useApp();
  const methodOf = (orderNo: string) => paymentHolds.find((hold) => hold.orderNo === orderNo)?.method ?? orders.find((order) => order.id === orderNo)?.method ?? "UPI";
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
  // Not checked in time: the money may be in the bank, so these stay open until someone closes them.
  const lapsed = submissions.filter((s) => s.status === "rejected" && s.note === UNCHECKED_UTR_NOTE);
  const done = submissions.filter((s) => s.status !== "submitted" && s.note !== UNCHECKED_UTR_NOTE);
  // The Confirmed and Rejected cards open the list below, showing just those.
  const [doneFilter, setDoneFilter] = useState<"all" | "confirmed" | "rejected">("all");
  const doneShown = doneFilter === "all" ? done : done.filter((s) => s.status === doneFilter);
  const openDone = (status: "confirmed" | "rejected") => {
    setDoneFilter(status);
    scrollToSection("checked-payments");
  };
  const markRefunded = async (orderNo: string, utr: string) => {
    if (!window.confirm(`Record that UTR ${utr} for ${orderNo} was refunded?\n\nThat UTR can then pay for nothing, and the customer is told.`)) return;
    setBusy(orderNo);
    try {
      await markUtrRefunded(orderNo);
      toast.success(`${orderNo}: refund recorded`);
    } catch (cause) {
      toast.error("Could not record the refund", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

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

  const [confirming, setConfirming] = useState<{ orderNo: string; amount: number; utr: string } | null>(null);
  const confirm = async (orderNo: string, amount: number, utr: string, checkedAgainst: string, remark: string) => {
    setConfirming(null);
    setBusy(orderNo);
    try {
      if (STATIC_DATA_MODE) {
        // Demo: a held checkout becomes an order; an older demo order is marked paid like a manual payment.
        if (awaiting.some((hold) => hold.orderNo === orderNo)) simulateBankAlert(orderNo);
        else if (!(await confirmPayment(orderNo, amount, utr))) throw new Error("The order could not be marked paid");
      }
      // Live: one database step records the payment for this UTR and closes it.
      // What the admin compared it with stays on the record, shown under Checked payments.
      await reviewUpiPayment(orderNo, "confirmed", utr, [`Checked against ${checkedAgainst}`, user?.name ? `by ${user.name}` : "", remark.trim()].filter(Boolean).join(" ").slice(0, 200));
      pushOrderToZohoInBackground(orderNo);
      toast.success(`${orderNo} marked paid`, { description: `UTR ${utr}` });
    } catch (cause) {
      toast.error("Could not confirm", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };
  // Rejecting asks what happens to the checkout: give the customer time to correct the UTR, or end it now.
  const [rejecting, setRejecting] = useState<{ orderNo: string; utr: string } | null>(null);
  const reject = (orderNo: string, utr: string) => setRejecting({ orderNo, utr });
  const doReject = async (orderNo: string, utr: string, choice: RejectChoice, note: string) => {
    setBusy(orderNo);
    try {
      if (choice === "end-checkout") {
        await rejectUtrAndEndCheckout(orderNo, utr, note || undefined);
        // Moves it to "Ended without payment" at once, without waiting for the live feed.
        void refreshHeldCheckouts([orderNo]);
        toast.message(`${orderNo}: UTR rejected and checkout ended`, { description: "Its stock is back on sale. The customer is told it was not placed." });
        return;
      }
      const rejections = await reviewUpiPayment(orderNo, "rejected", utr, note || undefined);
      if (rejections >= 3 && awaiting.some((hold) => hold.orderNo === orderNo)) toast.message(`${orderNo}: third wrong UTR`, { description: "The checkout has ended and its stock is back on sale. The customer is told." });
      else toast.message(`${orderNo}: UTR rejected`, { description: "The customer is told and can send a corrected UTR." });
    } catch (cause) {
      toast.error("Could not reject", { description: cause instanceof Error ? cause.message : undefined });
      throw cause;
    } finally {
      setBusy("");
    }
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="UPI & Bank Payments" subtitle="UPI, NEFT and RTGS straight to the company's bank account">
      {rejecting && (
        <RejectUtrDialog
          orderNo={rejecting.orderNo}
          utr={rejecting.utr}
          byBank={isBankMethod(methodOf(rejecting.orderNo))}
          waiting={awaiting.some((hold) => hold.orderNo === rejecting.orderNo)}
          windowMinutes={settings?.payWindowMinutes ?? DEFAULT_UPI_SETTINGS.payWindowMinutes}
          onClose={() => setRejecting(null)}
          onReject={(choice, note) => doReject(rejecting.orderNo, rejecting.utr, choice, note)}
        />
      )}
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
        <StatCard onClick={() => scrollToSection("payments-to-check")} label="Waiting for your check" value={String(waiting.length)} icon={QrCode} highlight={waiting.length > 0} description={waiting.length ? `${inrPrecise(waiting.reduce((s, w) => s + w.amount, 0))} to match in the bank` : "Nothing to check"} />
        <StatCard onClick={() => openDone("confirmed")} label="Confirmed" value={String(done.filter((s) => s.status === "confirmed").length)} icon={CheckCircle2} description="Marked paid" />
        <StatCard onClick={() => openDone("rejected")} label="Rejected" value={String(done.filter((s) => s.status === "rejected").length)} icon={XCircle} description="Customer asked to correct" />
      </div>

      <UtrChecksPanel checks={utrChecks.checks} error={utrChecks.error} onChange={utrChecks.refresh} />

      {lapsed.length > 0 && (
        <Panel title="Not checked in time" className="mb-6">
          <p className="mb-3 text-sm text-red-800">These customers sent a UTR and nobody checked it within 24 hours, so the stock was released. Check the bank account. If the money came, ask the customer to press Reorder and send the same UTR. If you refund it instead, press Refunded.</p>
          <ul className="divide-y divide-border text-sm">
            {lapsed.map((s) => {
              const hold = paymentHolds.find((item) => item.orderNo === s.orderNo);
              return (
                <li key={s.orderNo} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-navy">{s.orderNo} · <b>{s.utr}</b> · {inrPrecise(s.amount)}</p>
                    <p className="text-xs text-slate">{s.customer || "—"}{hold?.phone ? ` · ${hold.phone}` : ""}</p>
                    {hold && <p className="text-[11px] text-slate">{hold.lines.map((line) => `${line.name ?? line.productId} × ${line.qty}`).join(", ")}</p>}
                  </div>
                  <Button size="sm" variant="outline" disabled={busy === s.orderNo} onClick={() => void markRefunded(s.orderNo, s.utr)}>Refunded</Button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <div id="payments-to-check" className="scroll-mt-36">
      <Panel title="Payments to check" className="mb-6">
        <p className="mb-3 text-xs text-slate">Open the bank account (or its UPI app), find a credit with this <b>UTR</b> and <b>amount</b>, then confirm. Confirming marks the order paid, like a manual payment.</p>
        {!waiting.length ? <p className="text-sm text-slate">No payments waiting.</p> : (
          <div className="overflow-x-auto">
            <ResizableTable tableId="upi-waiting" className="w-full min-w-[760px] text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                <th className="px-2 py-2">Sent</th><th className="px-2 py-2">Order</th><th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2">Method</th><th className="px-2 py-2">UTR</th><th className="px-2 py-2">Action</th>
              </tr></thead>
              <tbody>
                {waiting.map((s) => {
                  // A checkout waiting for payment is not on the order pages yet, so its items are shown here.
                  const hold = paymentHolds.find((item) => item.orderNo === s.orderNo);
                  return (
                  <tr key={s.orderNo} className="border-b border-border/60">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate">{istTime(s.submittedAt)}</td>
                    <td className="px-2 py-2 font-mono text-xs">
                      {hold ? <span className="text-navy">{s.orderNo}</span> : <Link to="/admin/orders/$id" params={{ id: s.orderNo }} className="text-navy hover:text-gold">{s.orderNo}</Link>}
                      {hold && <span className="mt-0.5 block font-sans text-[11px] text-slate">{hold.lines.map((line) => `${line.name ?? line.productId} × ${line.qty}`).join(", ")}</span>}
                      {hold?.holdUntil && <span className="mt-0.5 block font-sans text-[11px] font-semibold text-amber-800">{`Stock held until ${istTime(new Date(Date.parse(hold.holdUntil) + 86_400_000).toISOString())}`}</span>}
                    </td>
                    <td className="px-2 py-2">{s.customer || "—"}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{inrPrecise(s.amount)}</td>
                    <td className="px-2 py-2 text-xs font-bold">{methodOf(s.orderNo)}</td>
                    <td className="px-2 py-2 font-mono tracking-wider">{s.utr}</td>
                    <td className="px-2 py-2">
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy === s.orderNo} onClick={() => setConfirming({ orderNo: s.orderNo, amount: s.amount, utr: s.utr })}>Confirm paid</Button>
                        <Button size="sm" variant="outline" className="text-danger" disabled={busy === s.orderNo} onClick={() => reject(s.orderNo, s.utr)}>Reject</Button>
                      </div>
                      <CreditHint payment={s} credits={creditsWithoutUtr} />
                      <SameUtrBadge orderNo={s.orderNo} checks={utrChecks.checks} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </ResizableTable>
          </div>
        )}
      </Panel>
      </div>

      <CreditsWithoutUtrPanel credits={creditsWithoutUtr} submissions={submissions} checkouts={paymentHolds} />

      <Panel title="Waiting for payment (not orders yet)" className="mb-6">
        <p className="mb-3 text-xs text-slate">Checkouts whose customer has not paid yet. Their stock is held; they become orders when the bank alert (UPI) or your confirmation matches the payment, and end on their own when the time is up. NEFT and RTGS always wait for your confirmation: an amount alone never confirms them.</p>
        <CustomersPayingNow />
      </Panel>

      <Panel title="Ended without payment" className="mb-6">
        <p className="mb-3 text-xs text-slate">Checkouts whose payment window ran out, or that were ended. They are not orders and owe nothing. Delete one only when it is no longer wanted.</p>
        <EndedCheckouts />
      </Panel>

      <BankAlertsPanel credits={credits} creditsWithoutUtr={creditsWithoutUtr} checkingOrders={waiting.map((row) => row.orderNo)} onDemoMatch={(amount) => {
        const hold = awaiting.find((candidate) => Math.abs(candidate.amount - amount) < 0.005);
        if (hold) { simulateBankAlert(hold.orderNo); toast.success(`${hold.orderNo} paid and placed`); }
        else toast.message("No checkout is waiting for that amount", { description: "Kept as unmatched money." });
      }} />

      <BankDetailsPanel />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <Panel title="UPI settings">
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
                <span className="font-semibold text-navy">Show "Pay by UPI" at checkout (orders below ₹1,00,000)</span>
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

      {(done.length > 0 || doneFilter !== "all") && (
        <div id="checked-payments" className="mt-6 scroll-mt-36">
        <Panel
          title={doneFilter === "confirmed" ? "Confirmed payments" : doneFilter === "rejected" ? "Rejected payments" : "Checked payments"}
          action={doneFilter === "all" ? undefined : <button type="button" className="text-xs font-semibold text-gold hover:underline" onClick={() => setDoneFilter("all")}>Show all</button>}
        >
          {doneShown.length === 0 ? <p className="text-sm text-slate">None yet.</p> : (
          <div className="overflow-x-auto">
            <ResizableTable tableId="upi-done" className="w-full min-w-[700px] text-left text-sm">
              <thead><tr className="border-b border-border text-[11px] font-bold uppercase tracking-wider text-slate">
                <th className="px-2 py-2">Checked</th><th className="px-2 py-2">Order</th><th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2">UTR</th><th className="px-2 py-2">Result</th>
              </tr></thead>
              <tbody>
                {doneShown.map((s) => {
                  const hold = paymentHolds.find((item) => item.orderNo === s.orderNo);
                  return (
                  <tr key={s.orderNo} className="border-b border-border/60">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate">{s.reviewedAt ? istTime(s.reviewedAt) : "—"}</td>
                    <td className="px-2 py-2 font-mono text-xs">
                      {s.orderNo}
                      {hold && hold.status !== "Payment Confirmed" && <span className="mt-0.5 block font-sans text-[11px] text-slate">{hold.lines.map((line) => `${line.name ?? line.productId} × ${line.qty}`).join(", ")}</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{inrPrecise(s.amount)}</td>
                    <td className="px-2 py-2 font-mono">{s.utr}</td>
                    <td className={cn("px-2 py-2 text-xs font-semibold", s.status === "confirmed" ? "text-emerald-700" : "text-danger")}>
                      {s.status === "confirmed" ? `Confirmed paid${s.note ? ` · ${s.note}` : ""}`
                        : s.note === REFUNDED_UTR_NOTE ? "Refunded"
                        : REUSED_UTR_NOTE.test(s.note ?? "") ? s.note
                        : `Rejected${s.note ? `: ${s.note}` : ""}`}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </ResizableTable>
          </div>
          )}
        </Panel>
        </div>
      )}
      {confirming && <ConfirmPaidDialog {...confirming} onClose={() => setConfirming(null)} onConfirm={(checkedAgainst, remark) => void confirm(confirming.orderNo, confirming.amount, confirming.utr, checkedAgainst, remark)} />}
    </PanelLayout>
  );
}

/**
 * The account customers pay by NEFT and RTGS. Until it is saved those methods are hidden, so orders of
 * Rs 1 lakh and above cannot be paid. Every change is logged and every admin told, by the database.
 */
function BankDetailsPanel() {
  const [form, setForm] = useState<BankDetails>(EMPTY_BANK_DETAILS);
  const [saved, setSaved] = useState<BankDetails>(EMPTY_BANK_DETAILS);
  const [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState<BankAuditRow[]>([]);
  // Blank fields after a failed read would look like "nothing saved", so the form stays shut until the read works.
  const [loadState, setLoadState] = useState<"loading" | "failed" | "ready">("loading");
  const [numberAgain, setNumberAgain] = useState("");
  const load = () => {
    setLoadState("loading");
    void loadBankSettings().then(
      (details) => { setForm(details); setSaved(details); setLoadState("ready"); },
      () => setLoadState("failed"),
    );
    void loadBankAudit().then(setAudit);
  };
  useEffect(load, []);
  // Someone else changed them: show it at once, on this very page, without touching what is being typed.
  const { notifications } = useApp();
  const changeAlerts = notifications.filter((item) => item.title === "Bank details changed").length;
  const typing = useRef(false);
  typing.current = JSON.stringify(cleanBankDetails(form)) !== JSON.stringify(cleanBankDetails(saved));
  useEffect(() => {
    const refresh = () => {
      void loadBankAudit().then(setAudit);
      void loadBankSettings().then((details) => {
        setSaved(details);
        if (!typing.current) setForm(details);
        setLoadState("ready");
      }, () => undefined);
    };
    if (changeAlerts) refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [changeAlerts]);
  const problem = bankDetailsProblem(form);
  const live = !bankDetailsProblem(saved);
  const changed = JSON.stringify(cleanBankDetails(form)) !== JSON.stringify(cleanBankDetails(saved));
  const numberChanged = cleanBankDetails(form).accountNumber !== cleanBankDetails(saved).accountNumber;
  const save = async () => {
    if (problem) { toast.error(problem); return; }
    const clean = cleanBankDetails(form);
    // One wrong digit sends customers' money to the wrong account.
    if (numberChanged && cleanBankDetails({ ...form, accountNumber: numberAgain }).accountNumber !== clean.accountNumber) {
      toast.error("The two account numbers do not match");
      return;
    }
    if (!window.confirm(`${live ? "Change the account customers pay into?" : "Customers will pay into this account:"}\n\n${clean.accountName}\nAccount ${clean.accountNumber}\nIFSC ${clean.ifsc}\nBank ${clean.bankName}\n\nEvery admin is told about this.`)) return;
    setSaving(true);
    try {
      // Another admin may have changed them since this page was opened: never put their old values back.
      const current = await loadBankSettings();
      if (JSON.stringify(cleanBankDetails(current)) !== JSON.stringify(cleanBankDetails(saved))) {
        setForm(current);
        setSaved(current);
        setNumberAgain("");
        setAudit(await loadBankAudit());
        toast.error("Another admin changed the bank details", { description: "The form now shows what is saved. Check it and make your change again." });
        return;
      }
      await saveBankDetails(clean);
      setForm(clean);
      setSaved(clean);
      setNumberAgain("");
      setAudit(await loadBankAudit());
      toast.success("Bank details saved", { description: "NEFT and RTGS are now offered at checkout." });
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  const field = (label: string, key: keyof BankDetails, placeholder = "") => (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input value={form[key]} placeholder={placeholder} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </div>
  );
  return (
    <Panel title="Bank details for NEFT and RTGS" className="mb-6">
      {loadState === "failed" && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          Could not read the saved bank details, so they are not shown. Customers still see what was saved. <button type="button" className="font-semibold underline" onClick={load}>Try again</button>
        </p>
      )}
      {loadState === "ready" && (
        <p className={cn("mb-3 flex items-start gap-2 rounded-md border p-2 text-xs", live ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-950")}>
          <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
          {live
            ? "NEFT and RTGS are offered at checkout. Signed-in customers see this account when they pay. Every change is logged below and every admin is told."
            : "NEFT and RTGS are hidden until these are saved, so orders of ₹1,00,000 and above cannot be paid on the website."}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("Account name", "accountName", "Exactly as the bank has it")}
        {field("Account number", "accountNumber")}
        {numberChanged && (
          <div className="grid gap-1.5">
            <Label>Account number again</Label>
            <Input value={numberAgain} autoComplete="off" onChange={(event) => setNumberAgain(event.target.value)} />
          </div>
        )}
        {field("IFSC", "ifsc", "e.g. HDFC0001234")}
        {field("Bank", "bankName", "e.g. HDFC Bank")}
        {field("Branch (optional)", "branch")}
      </div>
      {problem && (form.accountName || form.accountNumber || form.ifsc || form.bankName) && <p className="mt-3 text-xs font-semibold text-danger">{problem}</p>}
      <div className="mt-4"><Button className="bg-navy text-white hover:bg-navy/90" disabled={saving || !changed || loadState !== "ready"} onClick={() => void save()}>Save bank details</Button></div>
      {audit.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-border pt-3 text-xs">
          {audit.map((row, index) => (
            <li key={`${row.changedAt}-${index}`} className="flex flex-wrap gap-x-3">
              <span className="text-slate">{istTime(row.changedAt)}</span>
              <span className="font-semibold">{row.changedBy}</span>
              {bankDetailChanges(row.oldValue, row.newValue).map((change) => (
                <span key={change.label}>{change.label}: {change.from || "—"} → <b>{change.to || "—"}</b></span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const CREDIT_STATUS: Record<BankCredit["status"], { label: string; tone: string }> = {
  matched: { label: "Order paid automatically", tone: "text-emerald-700" },
  unmatched: { label: "No checkout for it", tone: "text-slate" },
  ambiguous: { label: "Several checkouts: waiting for the customer's UTR", tone: "text-amber-700" },
  mismatch: { label: "Wrong amount: you decide", tone: "text-danger" },
  late: { label: "Paid after time ran out: refund or place by hand", tone: "text-danger" },
  balance: { label: "The exact balance: press Confirm paid above", tone: "text-amber-700" },
  settled: { label: "Settled", tone: "text-slate" },
};

/**
 * Automatic capture: the company phone forwards each bank SMS to the website. An SMS with a UTR confirms the matching
 * checkout; one without (IDFC FIRST) is kept for the only checkout waiting for its amount, for an admin to confirm under
 * "Bank credits without a UTR". Shows the set-up, an SMS tester, and every alert with a UTR, with the ones that need a person.
 */
function BankAlertsPanel({ credits, creditsWithoutUtr = [], checkingOrders, onDemoMatch }: {
  credits: BankCredit[]; creditsWithoutUtr?: readonly CreditWithoutUtr[]; checkingOrders: string[]; onDemoMatch: (amount: number) => void;
}) {
  const [sample, setSample] = useState("");
  const [busy, setBusy] = useState("");
  const [suggestedKey, setSuggestedKey] = useState("");
  const parsed = sample.trim() ? parseBankCredit(sample) : null;
  const withoutUtr = sample.trim() && !parsed ? parseCreditWithoutReference(sample) : null;
  const endpoint = typeof window === "undefined" ? "https://grainbazar.com/api/payments/bank-alert" : `${window.location.origin}/api/payments/bank-alert`;
  // The newest SMS of either kind: IDFC FIRST's have no UTR and are kept apart, so they count too.
  const lastAlert = [credits[0]?.receivedAt, creditsWithoutUtr[0]?.receivedAt]
    .filter((at): at is string => Boolean(at))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const needsYou = credits.filter((credit) => ["ambiguous", "mismatch", "late", "balance"].includes(credit.status));

  const settle = async (credit: BankCredit) => {
    const note = window.prompt(`What was done about ₹${credit.amount} (UTR ${credit.utr})? For example: refunded on 28 Oct. A settled alert can pay for nothing, so if you placed the order by hand, record this payment on it instead.`, "");
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

  const reopen = async (credit: BankCredit) => {
    if (!window.confirm(`Reopen the alert for ₹${credit.amount} (UTR ${credit.utr})? Do this only if it was settled by mistake: its money can then pay an order. Every admin is told.`)) return;
    setBusy(credit.id);
    try {
      await reopenBankCredit(credit.id);
      toast.success("Alert reopened");
    } catch (cause) {
      toast.error("Could not reopen", { description: cause instanceof Error ? cause.message : undefined });
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
            <li>Make a long random key (button below) and save it in Hostinger as the environment variable <code className="rounded bg-muted px-1">BANK_ALERT_KEY</code>. Also add <code className="rounded bg-muted px-1">BANK_ALERT_SENDERS</code> with the bank's SMS sender (<code className="rounded bg-muted px-1">IDFCFB</code> for IDFC FIRST). Then redeploy.</li>
            <li>In the app, forward SMS from that sender to this address with method POST, and put the key in the header <code className="rounded bg-muted px-1">X-Bank-Alert-Key</code>:
              <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-[12px]">{endpoint}</code>
              <span className="mt-1 block text-[11px] text-slate">No header field in the app? Use this address instead (the key then shows in the server's access logs):</span>
              <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-[12px]">{endpoint}?key=YOUR_KEY</code></li>
            <li>Pay the ₹1 test QR on this page. Within a minute the SMS shows under "Bank credits without a UTR" (IDFC FIRST sends no UTR), or in the list below for banks whose SMS has one.</li>
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
          <p className="text-xs text-slate">Last bank SMS received: <b>{lastAlert ? istTime(lastAlert) : "none yet"}</b></p>
        </div>
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold text-navy"><MessageSquare className="h-4 w-4 text-gold" /> Test a bank SMS</p>
          <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={4} placeholder="Paste a money-received SMS from the bank"
            className="w-full rounded-md border border-input bg-white p-2 text-sm" />
          {sample.trim() && (parsed ? (
            <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-900">Read as <b>{inrPrecise(parsed.amount)}</b> received · UTR <b className="font-mono">{parsed.utr}</b>{parsed.payer ? ` · from ${parsed.payer}` : ""}</p>
          ) : withoutUtr ? (
            <p className="rounded-md bg-sky-50 p-2 text-sm text-sky-900">
              <span>Read as <b>{inrPrecise(withoutUtr.amount)}</b> credited to <b>{`A/C …${withoutUtr.accountEnding}`}</b>, with no UTR.</span>{" "}
              <span>Kept only when it is the company's account. If exactly one checkout waits for this amount, the money is kept for it and you confirm it under "Bank credits without a UTR".</span>
            </p>
          ) : (
            <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">Not read as a payment (a debit, or no amount / 12-digit UTR). Such SMS are ignored.</p>
          ))}
          {STATIC_DATA_MODE && parsed && (
            <Button size="sm" className="bg-navy text-white" onClick={() => onDemoMatch(parsed.amount)}>Demo: receive this SMS</Button>
          )}
        </div>
      </div>

      {needsYou.length > 0 && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{needsYou.length} payment{needsYou.length === 1 ? "" : "s"} need you: confirm a balance above, or place the order by hand and record this payment on it, or refund it and mark settled.</p>
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
                    {credit.status === "balance" && !checkingOrders.includes(credit.orderNo ?? "") ? "The exact balance: its UTR is not waiting for a check" : CREDIT_STATUS[credit.status].label}{credit.note ? <> · <span>{credit.note}</span></> : null}
                  </td>
                  <td className="px-2 py-2">
                    {/* While its UTR waits, a balance is answered by Confirm paid or Reject above: settling it would make Confirm refuse. */}
                    {(["ambiguous", "mismatch", "late", "unmatched"].includes(credit.status) || (credit.status === "balance" && !checkingOrders.includes(credit.orderNo ?? ""))) && (
                      <Button size="sm" variant="outline" disabled={busy === credit.id} onClick={() => void settle(credit)}>Mark settled</Button>
                    )}
                    {credit.status === "settled" && (
                      <Button size="sm" variant="ghost" disabled={busy === credit.id} onClick={() => void reopen(credit)}>Reopen</Button>
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

/** Payment confirmation is by hand for now: the admin says what they compared the UTR with, and that stays on the record. */
function ConfirmPaidDialog({ orderNo, amount, utr, onClose, onConfirm }: { orderNo: string; amount: number; utr: string; onClose: () => void; onConfirm: (checkedAgainst: string, remark: string) => void }) {
  const [checkedAgainst, setCheckedAgainst] = useState("");
  const [remark, setRemark] = useState("");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Confirm ${inrPrecise(amount)} for ${orderNo}?`}</DialogTitle>
          <DialogDescription>{`Only confirm after you see a credit with UTR ${utr} for this amount.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <p className="text-xs font-semibold text-slate">Checked against</p>
          {["bank SMS", "bank statement", "bank SMS and statement"].map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-navy">
              <input type="radio" name="checked-against" className="h-4 w-4" checked={checkedAgainst === option} onChange={() => setCheckedAgainst(option)} />
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </label>
          ))}
          <Input placeholder="Remark (optional)" maxLength={100} value={remark} onChange={(event) => setRemark(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={!checkedAgainst} onClick={() => onConfirm(checkedAgainst, remark)}>Confirm paid</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
