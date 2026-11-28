import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { inrPrecise } from "@/lib/data";
import { placeEndedCheckout } from "@/lib/upi-store";
import { cn } from "@/lib/utils";

type AdminState = Awaited<ReturnType<typeof import("@/lib/cashfree.functions").getCashfreeAdmin>>;
type PaymentRow = AdminState["payments"][number];

const istTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
const OUTCOME: Record<string, { label: string; tone: string }> = {
  paid_order: { label: "Paid the order", tone: "bg-emerald-50 text-emerald-800" },
  not_paid: { label: "Not paid", tone: "bg-slate-100 text-slate-700" },
  needs_refund: { label: "Needs refund", tone: "bg-red-50 text-red-800" },
  needs_review: { label: "Needs a check", tone: "bg-amber-50 text-amber-900" },
};

/**
 * Admin > UPI & Bank Payments > Cashfree (28 Nov 2026): whether the server has Cashfree's keys, the on/off switch, the
 * webhook address to give Cashfree, and every Cashfree payment with what it did. Money that came for a checkout that
 * had ended or was already paid is listed with what to do: place the order with it, or refund it in Cashfree.
 */
export function CashfreeGatewayPanel() {
  const [state, setState] = useState<AdminState | null>(null);
  const [failed, setFailed] = useState("");
  const [saving, setSaving] = useState(false);
  const [testers, setTesters] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const { getCashfreeAdmin } = await import("@/lib/cashfree.functions");
      const next = await getCashfreeAdmin();
      setState(next);
      setTesters(next.setting.testers.join("\n"));
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not read the Cashfree setting");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (enabled: boolean, testerList?: string[]) => {
    setSaving(true);
    try {
      const { setCashfreeGateway } = await import("@/lib/cashfree.functions");
      await setCashfreeGateway({ data: { enabled, ...(testerList ? { testers: testerList } : {}) } });
      toast.success(enabled ? "Cashfree is on for UPI checkouts" : "Cashfree is off: customers see the UPI QR again");
      await load();
    } catch (cause) {
      toast.error("Could not save", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const checkNow = async (orderNo: string) => {
    setBusy(orderNo);
    try {
      const { adminCheckCashfree } = await import("@/lib/cashfree.functions");
      const result = await adminCheckCashfree({ data: { orderNo } });
      toast.success(result.paid ? `${orderNo}: Cashfree shows a payment` : `${orderNo}: no successful payment at Cashfree`);
      await load();
    } catch (cause) {
      toast.error("Could not ask Cashfree", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  const settle = async (row: PaymentRow, how: "refunded" | "placed") => {
    setBusy(row.cf_payment_id);
    try {
      if (how === "placed") await placeEndedCheckout(row.order_no, row.reference, "UPI", `Cashfree payment ${row.cf_payment_id}`);
      const { error } = await supabase.rpc("admin_settle_cashfree_payment", { _cf_payment_id: row.cf_payment_id, _how: how, _note: null });
      if (error) throw new Error(error.message);
      toast.success(how === "placed" ? `${row.order_no} placed with this payment` : "Marked as refunded in Cashfree");
      await load();
    } catch (cause) {
      toast.error("Could not do that", { description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setBusy("");
    }
  };

  const enabled = state?.setting.enabled ?? false;
  const ready = state?.setup.ready ?? false;
  return (
    <Panel title="Cashfree payment gateway" className="mb-6" action={
      <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh</Button>
    }>
      {failed ? <p className="text-sm text-danger">{failed}</p> : !state ? <p className="text-sm text-slate">Loading…</p> : (
        <div className="grid gap-4">
          <div className="grid gap-1 text-sm">
            <p>
              <span className="font-semibold text-navy">Keys on the server: </span>
              {ready
                ? <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", state.setup.environment === "production" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}>{state.setup.environment === "production" ? "Production (real money)" : "Sandbox (test money)"}</span>
                : <span className="text-danger">{state.setup.problem}</span>}
            </p>
            {!ready && <p className="text-xs text-slate">Add CASHFREE_APP_ID, CASHFREE_SECRET_KEY and CASHFREE_ENV (sandbox or production) in Hostinger's environment variables, then redeploy. Until then customers keep the UPI QR.</p>}
          </div>

          <label className="flex items-center gap-3 text-sm">
            <Switch checked={enabled} disabled={saving || (!ready && !enabled)} onCheckedChange={(value) => void save(value)} />
            <span className="font-semibold text-navy">UPI checkouts open Cashfree's payment page</span>
          </label>
          <p className="-mt-2 text-xs text-slate">On: a customer paying by UPI presses Pay and pays on Cashfree's page (UPI, cards, net banking); the order is placed when Cashfree confirms the payment. NEFT and RTGS stay as they are. Off: customers see our UPI QR and send the UTR, as before.</p>

          {state.setup.environment === "sandbox" && (
            <div className="grid gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold">Sandbox: only admins and these test logins see Cashfree</p>
              <p className="text-xs">Emails or 10-digit mobile numbers, one per line. Ordinary customers keep the UPI QR, so nobody pays the real shop with test money. An order paid in sandbox is a real order in the website and Zoho: cancel it after the test.</p>
              <textarea value={testers} onChange={(event) => setTesters(event.target.value)} rows={3} maxLength={2000}
                className="w-full rounded-md border border-border bg-white p-2 text-sm text-charcoal" placeholder={"owner@example.com\n9876543210"} />
              <div><Button type="button" size="sm" disabled={saving} onClick={() => void save(enabled, testers.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))}>Save test logins</Button></div>
            </div>
          )}

          <div className="grid gap-1 text-sm">
            <p className="font-semibold text-navy">Webhook address for Cashfree</p>
            {state.webhookUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-slate-50 px-2 py-1 text-xs">{state.webhookUrl}</code>
                <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(state.webhookUrl ?? "").then(() => toast.success("Copied"))}><Copy className="mr-1.5 h-3.5 w-3.5" /> Copy</Button>
              </div>
            ) : <p className="text-xs text-danger">The website does not know its Supabase address.</p>}
            <p className="text-xs text-slate">In Cashfree: Developers › Webhooks › Add webhook endpoint. Paste this address and tick Success, Failed and User dropped payments. Each new order also tells Cashfree this address.</p>
            <p className="text-xs text-slate">{`Webhook calls waiting: ${state.inboxWaiting} · Last payment from a webhook: ${state.lastWebhookAt ? istTime(state.lastWebhookAt) : "none yet"}`}</p>
          </div>

          {state.open.length > 0 && (
            <div className="grid gap-1.5">
              <p className="text-sm font-semibold text-navy">Customers on Cashfree's page now</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead className="text-slate"><tr><th className="py-1 pr-2">Order</th><th className="py-1 pr-2">Amount</th><th className="py-1 pr-2">Started</th><th className="py-1 pr-2">Cashfree</th><th /></tr></thead>
                  <tbody>
                    {state.open.map((row) => (
                      <tr key={row.cf_order_ref} className="border-t border-border">
                        <td className="py-1.5 pr-2 font-semibold">{row.order_no}</td>
                        <td className="py-1.5 pr-2">{inrPrecise(Number(row.amount))}</td>
                        <td className="py-1.5 pr-2">{istTime(row.created_at)}</td>
                        <td className="py-1.5 pr-2">{row.cashfree_status ?? "ACTIVE"}</td>
                        <td className="py-1.5 text-right"><Button type="button" variant="outline" size="sm" disabled={busy === row.order_no} onClick={() => void checkNow(row.order_no)}>Check now</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <p className="text-sm font-semibold text-navy">Cashfree payments</p>
            {state.payments.length === 0 ? <p className="text-xs text-slate">None yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-slate"><tr><th className="py-1 pr-2">When</th><th className="py-1 pr-2">Order</th><th className="py-1 pr-2">Amount</th><th className="py-1 pr-2">Reference</th><th className="py-1 pr-2">Cashfree</th><th className="py-1 pr-2">What it did</th><th /></tr></thead>
                  <tbody>
                    {state.payments.map((row) => {
                      const outcome = OUTCOME[row.outcome] ?? OUTCOME["needs_review"]!;
                      const open = (row.outcome === "needs_refund" || row.outcome === "needs_review") && !row.settled_at;
                      return (
                        <tr key={row.cf_payment_id} className="border-t border-border align-top">
                          <td className="py-1.5 pr-2 whitespace-nowrap">{istTime(row.first_seen_at)}</td>
                          <td className="py-1.5 pr-2 font-semibold">{row.order_no}{row.environment === "sandbox" && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-900">TEST</span>}</td>
                          <td className="py-1.5 pr-2">{inrPrecise(Number(row.amount))}</td>
                          <td className="py-1.5 pr-2 break-all">{row.reference}</td>
                          <td className="py-1.5 pr-2">{row.payment_status}{row.payment_group ? ` · ${row.payment_group}` : ""}</td>
                          <td className="py-1.5 pr-2">
                            <span className={cn("rounded-full px-2 py-0.5 font-semibold", outcome.tone)}>{outcome.label}</span>
                            {row.outcome_note && <p className="mt-0.5 text-slate">{row.outcome_note}</p>}
                            {row.settled_note && <p className="mt-0.5 text-slate">{row.settled_note}</p>}
                          </td>
                          <td className="py-1.5 text-right">
                            {open && (
                              <div className="flex flex-col items-end gap-1">
                                <Button type="button" size="sm" disabled={busy === row.cf_payment_id} onClick={() => void settle(row, "placed")}>Place order with it</Button>
                                <Button type="button" variant="outline" size="sm" disabled={busy === row.cf_payment_id} onClick={() => void settle(row, "refunded")}>Refunded in Cashfree</Button>
                              </div>
                            )}
                            {!open && row.outcome !== "paid_order" && (
                              <Button type="button" variant="outline" size="sm" disabled={busy === row.order_no} onClick={() => void checkNow(row.order_no)}>Check now</Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate">Needs refund: the money came for a checkout that had ended, was cancelled or was already paid. Place the order with it (if the goods are still in stock), or refund it in the Cashfree dashboard and press Refunded in Cashfree.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
