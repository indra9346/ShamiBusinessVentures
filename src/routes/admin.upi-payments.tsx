import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { toast } from "sonner";
import { CheckCircle2, QrCode, ShieldAlert, XCircle } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { useApp } from "@/lib/store";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DEFAULT_UPI_SETTINGS, isValidVpa, settingsProblem, upiPaymentUri, type UpiSettings } from "@/lib/upi-pay";
import { reviewUpiPayment, saveUpiSettings, useUpiPayments } from "@/lib/upi-store";
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
  const { settings, submissions } = useUpiPayments();
  const { confirmPayment } = useApp();
  const [form, setForm] = useState<UpiSettings>(DEFAULT_UPI_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => { if (settings) setForm(settings); }, [settings]);

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
    setBusy(orderNo);
    try {
      // The same confirmation admins use for manual payments: marks the order paid with this UTR.
      if (!(await confirmPayment(orderNo, amount, utr))) throw new Error("The order could not be marked paid");
      reviewUpiPayment(orderNo, "confirmed");
      toast.success(`${orderNo} marked paid`, { description: `UTR ${utr}` });
    } catch (cause) {
      toast.error("Could not confirm", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };
  const reject = (orderNo: string) => {
    const note = window.prompt("Why is this UTR not accepted? The customer sees this.", "No matching credit in the bank account");
    if (note === null) return;
    reviewUpiPayment(orderNo, "rejected", note.trim() || undefined);
    toast.message(`${orderNo}: UTR rejected`, { description: "The customer can enter a corrected UTR." });
  };

  return (
    <PanelLayout items={adminNav} tone="admin" title="UPI Payments" subtitle="Zero-fee UPI straight to the company's bank account">
      {STATIC_DATA_MODE ? (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <ShieldAlert className="mr-1 inline h-4 w-4" /> Demo / mock: settings and payments here are kept only in this browser. No real money moves.
        </p>
      ) : (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <ShieldAlert className="mr-1 inline h-4 w-4" /> Direct UPI is being tested. It stays off on the live store until the test is approved.
        </p>
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
                        <Button size="sm" variant="outline" className="text-danger" disabled={busy === s.orderNo} onClick={() => reject(s.orderNo)}>Reject</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
        )}
      </Panel>

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
              <Switch checked={form.enabled} disabled={!STATIC_DATA_MODE} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
              <span>
                <span className="font-semibold text-navy">Show "Pay by UPI" at checkout</span>
                {!STATIC_DATA_MODE && <span className="block text-[11px] text-slate">Available after the test is approved</span>}
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
