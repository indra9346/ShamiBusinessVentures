import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Mail, MessageSquare, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { DEFAULT_CUSTOMER_MESSAGES, customerMessageSettingsProblem, type CustomerMessageSettings } from "@/lib/customer-messages";
import { cn } from "@/lib/utils";

type Recent = { order_no: string; kind: string; status: string; sent_to: string; detail: string; created_at: string };
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const KIND: Record<string, string> = { invoice_email: "Invoice email", confirm_sms: "SMS", delivered_sms: "Hand-over SMS" };
const TONE: Record<string, string> = { sent: "text-emerald-700", failed: "text-red-700", skipped: "text-slate", sending: "text-amber-800" };

/*
 * Admin › Settings › Customer messages (client, 19 Nov 2026: "emails are not going to customers; emails should go from
 * Zoho Books and SMS order confirmation after marking payment confirmed"). When a payment is confirmed and the order's
 * Zoho Books invoice exists, Zoho Books emails that invoice to the customer and Fast2SMS sends an SMS; each once per
 * order, only for orders made since the switch went on. The list shows what went to whom.
 */
export function CustomerMessagesPanel() {
  const [settings, setSettings] = useState<CustomerMessageSettings>(DEFAULT_CUSTOMER_MESSAGES);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [saving, setSaving] = useState(false);
  const [testMobile, setTestMobile] = useState("");
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState("");
  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) return;
    try {
      const { getCustomerMessages } = await import("@/lib/zoho-commerce.functions");
      const data = await getCustomerMessages();
      setSettings(data.settings); setRecent(data.recent as Recent[]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not read the customer message settings");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (next: CustomerMessageSettings) => {
    const why = customerMessageSettingsProblem(next);
    if (why) { setProblem(why); return; }
    setSaving(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { setSettings(next); toast.success("Preview: nothing is saved"); return; }
      const { setCustomerMessages } = await import("@/lib/zoho-commerce.functions");
      setSettings(await setCustomerMessages({ data: { email: next.email, sms: next.sms, smsRoute: next.smsRoute, senderId: next.senderId, dltMessageId: next.dltMessageId, deliverySms: next.deliverySms, deliveryDltMessageId: next.deliveryDltMessageId } }));
      toast.success("Customer messages saved");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true); setProblem("");
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: no SMS sent"); return; }
      const { sendTestOrderSms } = await import("@/lib/zoho-commerce.functions");
      const done = await sendTestOrderSms({ data: { mobile: testMobile } });
      toast.success("Test SMS sent", { description: done.result });
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Could not send the test SMS");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel title="Customer messages when a payment is confirmed" action={<Button size="sm" variant="outline" onClick={() => void load()} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>}>
      <div className="grid gap-4 text-sm">
        <label className="flex items-start gap-3">
          <Switch checked={settings.email} disabled={saving} onCheckedChange={(email) => void save({ ...settings, email })} />
          <span><span className="flex items-center gap-1.5 font-semibold text-navy"><Mail className="h-4 w-4" />Email the invoice from Zoho Books</span>
            <span className="block text-xs text-slate">Zoho Books emails the order's invoice to the customer's email from your Zoho organisation's address, once, when the payment is confirmed.</span></span>
        </label>
        <label className="flex items-start gap-3">
          <Switch checked={settings.sms} disabled={saving} onCheckedChange={(sms) => void save({ ...settings, sms })} />
          <span><span className="flex items-center gap-1.5 font-semibold text-navy"><MessageSquare className="h-4 w-4" />Order confirmation SMS</span>
            <span className="block text-xs text-slate">"Grain Bazar: Payment received. Order … for Rs … is confirmed. Collect at … Invoice … Thank you." Sent by Fast2SMS (the same account as the sign-in codes), once per order.</span></span>
        </label>
        <label className="flex items-start gap-3">
          <Switch checked={settings.deliverySms} disabled={saving} onCheckedChange={(deliverySms) => void save({ ...settings, deliverySms })} />
          <span><span className="flex items-center gap-1.5 font-semibold text-navy"><MessageSquare className="h-4 w-4" />Hand-over SMS when the godown hands the order over</span>
            <span className="block text-xs text-slate">"Grain Bazar: Your order … was handed over at … on … Thank you for shopping with us." Sent once per order when the channel partner's QR hand-over completes it. Needs the new order-sms function deployed in Supabase; until then nothing is sent and the list below says why.</span></span>
        </label>
        <div className="grid gap-2 rounded-md border border-border bg-slate-50 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate">SMS route</p>
          <label className="flex items-center gap-2"><input type="radio" name="sms-route" checked={settings.smsRoute === "q"} onChange={() => setSettings({ ...settings, smsRoute: "q" })} />Quick SMS: plain text, no DLT needed, costs more per SMS</label>
          <label className="flex items-center gap-2"><input type="radio" name="sms-route" checked={settings.smsRoute === "dlt"} onChange={() => setSettings({ ...settings, smsRoute: "dlt" })} />DLT: your registered sender ID and approved template (variables: order no, amount, invoice no)</label>
          {settings.smsRoute === "dlt" && (
            <div className="flex flex-wrap gap-2 pl-6">
              <label className="grid gap-1 text-xs font-semibold text-slate">Sender ID<Input className="w-32" maxLength={6} value={settings.senderId} onChange={(e) => setSettings({ ...settings, senderId: e.target.value.toUpperCase() })} /></label>
              <label className="grid gap-1 text-xs font-semibold text-slate">Fast2SMS message ID<Input className="w-40" value={settings.dltMessageId} onChange={(e) => setSettings({ ...settings, dltMessageId: e.target.value })} /></label>
              <label className="grid gap-1 text-xs font-semibold text-slate">Hand-over template message ID (order no, godown, time)<Input className="w-40" value={settings.deliveryDltMessageId} onChange={(e) => setSettings({ ...settings, deliveryDltMessageId: e.target.value })} /></label>
            </div>
          )}
          <Button size="sm" variant="outline" className="justify-self-start" disabled={saving} onClick={() => void save(settings)}>Save route</Button>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs font-semibold text-slate">Send a test SMS to<Input className="w-44" inputMode="numeric" placeholder="10-digit mobile" value={testMobile} onChange={(e) => setTestMobile(e.target.value)} /></label>
            <Button size="sm" variant="outline" disabled={testing || testMobile.replace(/\D/g, "").length < 10} onClick={() => void test()}>{testing ? "Sending…" : "Send test SMS"}</Button>
          </div>
        </div>
        {problem && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem}</p>}
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate">Latest messages</p>
          {recent.length === 0 ? <p className="text-xs text-slate">None yet. They start with the next order whose payment is confirmed after a switch is on.</p> : (
            <ul className="divide-y divide-border text-xs">
              {recent.map((r) => (
                <li key={`${r.order_no}-${r.kind}`} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span><span className="font-mono font-semibold text-navy">{r.order_no}</span>{` · ${KIND[r.kind] ?? r.kind} · ${r.sent_to || "—"} · ${when(r.created_at)}`}</span>
                  <span className={cn("font-semibold", TONE[r.status] ?? "text-slate")}>{`${r.status}${r.detail ? `: ${r.detail}` : ""}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
