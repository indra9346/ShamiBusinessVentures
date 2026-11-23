import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Panel } from "@/components/panel/widgets";
import { PARTNER_REFRESH_EVENT, useLiveRefresh } from "@/components/partners/PartnerWidgets";
import { SendUtrForm } from "@/components/site/UpiIdPay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inrPrecise } from "@/lib/data";
import { pushOrderToZohoInBackground } from "@/lib/store";
import { approvePartnerPayment, loadPartnerCheckouts, rejectPartnerPayment, PARTNER_PAYMENT_CHECKS, type PartnerCheckout, type PartnerPaymentCheck } from "@/lib/upi-store";
import { orderToneClass } from "@/lib/order-status-tone";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** Who sent the UTR, as the partner reads it. */
const SENT_BY: Record<string, string> = { customer: "Sent by the customer", partner: "Sent by you", admin: "Sent by our office" };

/**
 * What approving records: for a checkout still waiting, the UTR's own amount (the database offers Approve only when that is
 * what is left to pay); for an ended one, what is left to pay, as Place again records it.
 */
export const partnerUtrAmount = (row: Pick<PartnerCheckout, "status" | "utrAmount" | "total" | "paidAmount">) =>
  row.status === "Payment Expired" ? Math.max(0, row.total - row.paidAmount) : row.utrAmount ?? Math.max(0, row.total - row.paidAmount);

/**
 * Channel partner (12 Nov 2026, owner): their own godown's checkouts waiting for payment, or ended in the last 15 days.
 * When a customer has paid and shows the partner the UTR, the partner can send it here (submit_utr_for_order).
 * Changed 16 Nov 2026 (owner: "Give option to approve payments of customers in their login for channel partners respective
 * to their Godown orders only"): once the partner has seen the money arrive, they approve the UTR here
 * (partner_approve_payment), with the same checks as our office's Confirm. They never reject one: that stays with our
 * office, which is told of every approval. Changed again 16 Nov 2026 (owner: "Channel partner should be able to approve
 * the order just like admin"): also a UTR the partner sent for the customer. Only the partner's own order waits for our
 * office, as every UTR does when our office has switched approval off.
 */
export function PartnerPaymentsPanel() {
  const [rows, setRows] = useState<PartnerCheckout[] | null>(null);
  const [failed, setFailed] = useState("");
  const [asking, setAsking] = useState<PartnerCheckout | null>(null);
  const [approving, setApproving] = useState("");
  const [rejecting, setRejecting] = useState<PartnerCheckout | null>(null);
  // Reads again every 30 seconds, on focus and after any partner step (16 Nov 2026: a page opened earlier kept showing
  // an old state), as Orders to confirm does.
  const load = useCallback(async (): Promise<PartnerCheckout[] | null> => {
    try {
      const list = await loadPartnerCheckouts();
      setRows(list); setFailed("");
      return list;
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not load the payments");
      return null;
    }
  }, []);
  useLiveRefresh(() => { void load(); }, [load]);
  // Owner, 16 Nov 2026: a partner who sends the customer's UTR goes straight on to check the bank and approve it.
  const sent = async (orderNo: string) => {
    const list = await load();
    const row = list?.find((r) => r.orderNo === orderNo && r.utrStatus === "submitted" && r.utr && r.canApprove);
    if (row) setAsking(row);
  };

  const approve = async (row: PartnerCheckout, checked: PartnerPaymentCheck) => {
    if (!row.utr) return;
    setApproving(row.orderNo);
    try {
      await approvePartnerPayment(row.orderNo, row.utr, checked);
      toast.success(`${row.orderNo} is paid and placed`, { description: "It now waits for you under Orders to confirm." });
      // The same instant Zoho push our office's Confirm makes; the queue sends it anyway if this one cannot.
      pushOrderToZohoInBackground(row.orderNo);
      setAsking(null);
      void load();
      // Orders to confirm reads again at once: the order is there now.
      window.dispatchEvent(new Event(PARTNER_REFRESH_EVENT));
    } catch (cause) {
      toast.error("Could not approve the payment", { description: cause instanceof Error ? cause.message : undefined });
      void load();
    } finally {
      setApproving("");
    }
  };

  const reject = async (row: PartnerCheckout, reason: string) => {
    if (!row.utr) return;
    setApproving(row.orderNo);
    try {
      await rejectPartnerPayment(row.orderNo, row.utr, reason);
      toast.success(`UTR ${row.utr} rejected`, { description: "The customer and our office are told. The customer can send the right UTR while the time lasts." });
      setRejecting(null);
      void load();
    } catch (cause) {
      toast.error("Could not reject the UTR", { description: cause instanceof Error ? cause.message : undefined });
      void load();
    } finally {
      setApproving("");
    }
  };

  return (
    <Panel title="Customer payments" action={
      <Button size="sm" variant="outline" onClick={() => void load()} aria-label="Refresh customer payments"><RefreshCw className="h-4 w-4" /></Button>
    }>
      <p className="mb-3 text-xs text-slate">Checkouts at your godown that are waiting for payment, or ended without it in the last 15 days. If a customer paid and gives you the UTR, send it here. When our office allows it, you approve the UTR yourself once you have seen the money arrive in the bank account, as our office does, also a UTR you sent for the customer; otherwise our office checks it and places the order.</p>
      {failed ? <p className="text-sm text-danger">{failed}</p>
        : !rows ? <p className="flex items-center gap-2 text-sm text-slate"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : !rows.length ? <p className="text-sm text-slate">Nothing is waiting for payment.</p>
        : (
          <ul className="space-y-3">
            {rows.map((row) => (
              // The order colours (11 Nov 2026): waiting for payment yellow, time ran out red.
              <li key={row.orderNo} className={cn("rounded-lg border p-3", orderToneClass(row.status, "tile") || "border-border bg-white")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-xs font-semibold text-navy">{row.orderNo}</p>
                    <p className="text-xs text-slate"><span>{row.customer}</span> · <span>{when(row.placedAt)}</span> · <span>{row.method}</span></p>
                    {row.items && <p className="text-[11px] text-slate">{row.items}</p>}
                  </div>
                  <div className="text-right">
                    <p className="font-bold tabular-nums text-navy">{inrPrecise(row.total)}</p>
                    <p className={cn("text-[11px] font-semibold", orderToneClass(row.status, "text") || "text-amber-800")}>
                      {row.status === "Payment Expired" ? "Time ran out" : "Waiting for payment"}
                    </p>
                  </div>
                </div>
                {row.utrStatus === "submitted" && row.utr && row.canApprove ? (
                  <div className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-sky-900">
                    <p className="break-all text-xs font-semibold">{`UTR ${row.utr} for ${inrPrecise(partnerUtrAmount(row))}`}</p>
                    <p className="text-[11px]">
                      <span>{SENT_BY[row.utrSentBy ?? "customer"] ?? SENT_BY["customer"]}</span>
                      {row.utrSentAt && <span>{` · ${when(row.utrSentAt)}`}</span>}
                      {row.utrLate && <span> · <span>after the checkout ended</span></span>}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 text-[11px]">Seen this money arrive? Approve it. Not in the bank, or another amount? Reject it. Or leave it for our office.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" disabled={!!approving} onClick={() => setRejecting(row)}>
                          <XCircle className="mr-1.5 h-4 w-4" />Reject UTR
                        </Button>
                        <Button size="sm" className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={!!approving} onClick={() => setAsking(row)}>
                          <CheckCircle2 className="mr-1.5 h-4 w-4" />{approving === row.orderNo ? "Approving…" : "Approve payment"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : row.utrStatus === "submitted" ? (
                  <p className="mt-2 rounded-md bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">{`UTR ${row.utr} is with our office for a check.`}</p>
                ) : (
                  <SendUtrForm className="mt-2" orderNo={row.orderNo} defaultMethod={row.method} title="Customer paid? Send the UTR"
                    help="Only send a UTR the customer showed you from their UPI app or bank. Once it is sent, check the money in the bank account: when our office allows it, the Approve payment box opens here for you." onSent={() => void sent(row.orderNo)} />
                )}
              </li>
            ))}
          </ul>
        )}
      {rejecting && (
        <RejectPaymentDialog row={rejecting} busy={approving === rejecting.orderNo}
          onClose={() => { if (!approving) setRejecting(null); }} onReject={(reason) => void reject(rejecting, reason)} />
      )}
      {asking && (
        <ApprovePaymentDialog row={asking} busy={approving === asking.orderNo}
          onClose={() => { if (!approving) setAsking(null); }} onApprove={(checked) => void approve(asking, checked)} />
      )}
    </Panel>
  );
}

/** The partner says why the UTR doesn't match; the database checks it is their godown's and tells our office. */
function RejectPaymentDialog({ row, busy, onClose, onReject }: { row: PartnerCheckout; busy: boolean; onClose: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const reasons = ["Not in the bank account", "Different amount in the bank", "UTR belongs to another payment"];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-words pr-6">{`Reject UTR ${row.utr ?? ""} on ${row.orderNo}?`}</DialogTitle>
          <DialogDescription>Only reject after checking the bank account. The customer is told to check their UTR, and our office is told too.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {reasons.map((text) => (
            <label key={text} className="flex items-center gap-2 text-sm text-navy">
              <input type="radio" name="partner-reject-reason" className="h-4 w-4" checked={reason === text} onChange={() => setReason(text)} />
              <span>{text}</span>
            </label>
          ))}
          <Input placeholder="Or type the reason" value={reasons.includes(reason) ? "" : reason} onChange={(event) => setReason(event.target.value)} maxLength={160} />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-red-700 text-white hover:bg-red-800" disabled={busy || reason.trim().length < 3} onClick={() => onReject(reason.trim())}>
            {busy ? "Rejecting…" : "Reject UTR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The partner says where they saw the money and that they saw it, as our office does for its Confirm. The database checks
 * the rest again (partner_approve_payment).
 */
function ApprovePaymentDialog({ row, busy, onClose, onApprove }: {
  row: PartnerCheckout; busy: boolean; onClose: () => void; onApprove: (checked: PartnerPaymentCheck) => void;
}) {
  const [checked, setChecked] = useState<PartnerPaymentCheck | "">("");
  const [seen, setSeen] = useState(false);
  const amount = inrPrecise(partnerUtrAmount(row));
  const late = row.status === "Payment Expired";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          {/* Room for the close button: a long order number wraps before it. */}
          <DialogTitle className="break-words pr-6">{`Approve ${amount} for ${row.orderNo}?`}</DialogTitle>
          <DialogDescription>{`Only approve after you have seen this money arrive with UTR ${row.utr ?? ""}.`}</DialogDescription>
          {late && <p className="text-sm font-semibold text-amber-800">This checkout ended before the payment was sent. Approving takes its stock again at your godown and places the order.</p>}
        </DialogHeader>
        <p className="text-sm text-charcoal"><span>{row.customer}</span> · <span>{row.method}</span>{row.items ? <> · <span>{row.items}</span></> : null}</p>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs font-semibold text-slate">Where did you see this money?</legend>
          {PARTNER_PAYMENT_CHECKS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-navy">
              <input type="radio" name="partner-payment-check" className="h-4 w-4" checked={checked === option.value} onChange={() => setChecked(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-start gap-2 rounded-md border border-border bg-white p-2 text-sm text-charcoal">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={seen} onChange={(event) => setSeen(event.target.checked)} />
          <span className="break-words">{`I saw ${amount} with UTR ${row.utr ?? ""} arrive in the bank account the customer paid into.`}</span>
        </label>
        <p className="text-[11px] text-slate">Our office is told of every payment you approve. An approval cannot be undone here: if you made a mistake, call our office at once.</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={busy || !checked || !seen} onClick={() => checked && onApprove(checked)}>
            {busy ? "Approving…" : late ? "Approve & place order" : "Approve payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
