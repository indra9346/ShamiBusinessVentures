import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { inrPrecise } from "@/lib/data";
import { PAYMENT_EXPIRED, type PaymentHold } from "@/lib/payment-hold";
import { closedPaymentLabel, endedOutcomeLabel } from "@/lib/order-payment-state";
import { useApp } from "@/lib/store";
import { DeleteOrderDialog } from "@/components/panel/DeleteOrderDialog";
import { RecordLatePaymentDialog } from "@/components/panel/RecordLatePaymentDialog";
import type { UpiSubmission } from "@/lib/upi-pay";
import { DeleteOrderRecordDialog } from "@/components/panel/DeleteOrderRecord";
import { BulkBar, BulkDeleteDialog, TickBox, useBulkSelection } from "@/components/panel/BulkSelect";
import { bulkDeleteAllDetailsProblem, normaliseDeleteCheck, type DeleteCheck } from "@/lib/order-cancel";
import { upiRecordsChanged } from "@/lib/upi-store";
import { orderToneClass } from "@/lib/order-status-tone";
import { cn } from "@/lib/utils";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Admin: checkouts whose payment window ran out, or that the customer or an admin ended. They were never
 * orders and owe nothing. An admin may delete one when it is no longer wanted; the database checks it first.
 * Added 11 Nov 2026: one the ordinary delete keeps (a refunded UTR, say) may still go with Delete all details, which
 * keeps a full copy in the Delete Log, when the database allows that.
 * Added 13 Nov 2026 (owner): tick several and delete them together. Each still goes through the same database step as its
 * own button (admin_delete_order, or admin_delete_order_all_details after the same check), one after another.
 */
export function EndedCheckouts({ compact = false, submissions = [] }: { compact?: boolean; submissions?: UpiSubmission[] }) {
  const { paymentHolds, forgetOrder } = useApp();
  const [deleting, setDeleting] = useState<PaymentHold | null>(null);
  // Added 12 Nov 2026 (owner): the customer paid it after all (late or offline); the admin records it once the bank shows it.
  const [recording, setRecording] = useState<PaymentHold | null>(null);
  const [deletingAll, setDeletingAll] = useState<PaymentHold | null>(null);
  const ended = paymentHolds
    .filter((hold) => hold.status === PAYMENT_EXPIRED)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Why a row cannot be deleted (the database's own check), so the list says it instead of offering a Delete that fails.
  const [kept, setKept] = useState<Record<string, string>>({});
  // Of those kept, the ones Delete all details may still take.
  const [allDetails, setAllDetails] = useState<Record<string, boolean>>({});
  const endedKey = ended.map((hold) => hold.orderNo).join(",");
  useEffect(() => {
    if (compact || STATIC_DATA_MODE || !endedKey) return;
    let active = true;
    void Promise.all(endedKey.split(",").map(async (orderNo) => {
      const { data, error } = await supabase.rpc("order_delete_blocker", { _order_no: orderNo });
      const why = error ? "" : (data as string | null) ?? "";
      if (!why) return [orderNo, why, false] as const;
      const all = await supabase.rpc("order_delete_all_check", { _order_no: orderNo });
      return [orderNo, why, !all.error && !(all.data as { blocker?: string | null } | null)?.blocker] as const;
    })).then((rows) => {
      if (!active) return;
      setKept(Object.fromEntries(rows.filter(([, why]) => why).map(([orderNo, why]) => [orderNo, why])));
      setAllDetails(Object.fromEntries(rows.filter(([, , all]) => all).map(([orderNo]) => [orderNo, true])));
    });
    return () => { active = false; };
  }, [compact, endedKey]);
  // Rows that have a Delete of their own may be ticked; "Kept" rows may not.
  const deletable = ended.filter((hold) => !kept[hold.orderNo] || allDetails[hold.orderNo]).map((hold) => hold.orderNo);
  const bulk = useBulkSelection(compact ? [] : deletable);
  const [bulkOpen, setBulkOpen] = useState(false);
  const deleteOne = async (orderNo: string, reason: string) => {
    if (!STATIC_DATA_MODE) {
      if (!kept[orderNo]) {
        const { error } = await supabase.rpc("admin_delete_order", { _order_no: orderNo, _reason: reason });
        if (error) throw new Error(error.message);
      } else {
        // The same check "Delete all details" makes first; one that would ask a question stays for its own Delete.
        const { data, error } = await supabase.rpc("order_delete_with_payments_check", { _order_no: orderNo });
        if (error) throw new Error(error.message);
        const problem = bulkDeleteAllDetailsProblem(normaliseDeleteCheck(data as unknown as DeleteCheck));
        if (problem) throw new Error(problem);
        const removed = await supabase.rpc("admin_delete_order_all_details", { _order_no: orderNo, _reason: reason });
        if (removed.error) throw new Error(removed.error.message);
      }
    }
    forgetOrder(orderNo);
  };
  if (compact) {
    if (ended.length === 0) return null;
    return (
      <p className={cn("mb-4 rounded-md border px-3 py-2 text-sm text-slate", orderToneClass(PAYMENT_EXPIRED, "tile"))}>
        <Link to="/admin/upi-payments" hash="ended-checkouts" className="font-semibold text-navy hover:text-gold">
          {ended.length === 1 ? "1 checkout ended without payment" : `${ended.length} checkouts ended without payment`}
        </Link>
        <span className="mx-1">·</span><span>{closedPaymentLabel(PAYMENT_EXPIRED)}</span>
      </p>
    );
  }
  return (
    <div id="ended-checkouts" className="scroll-mt-36">
      {ended.length === 0 ? (
        <p className="text-sm text-slate">None right now.</p>
      ) : (
        <>
        <BulkBar state={bulk.state} count={bulk.count} selectable={deletable.length} onToggleAll={bulk.toggleAll} onClear={bulk.clear} onDelete={() => setBulkOpen(true)} hint="Tick checkouts to delete several together" />
        <ul className="divide-y divide-border">
          {ended.map((hold) => (
            // Red like every order that ended without going ahead (the order colours, 11 Nov 2026).
            <li key={hold.orderNo} className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2 py-2 text-sm", orderToneClass(hold.status, "row"))}>
              <span className="flex min-w-0 items-start gap-1">
              {deletable.includes(hold.orderNo)
                ? <TickBox checked={bulk.isSelected(hold.orderNo)} onChange={(on) => bulk.toggle(hold.orderNo, on)} label={`Select ${hold.orderNo}`} className="-ml-1.5 -mt-1.5" />
                : <span className="w-6 shrink-0" aria-hidden />}
              <span className="min-w-0">
                <span className="font-semibold text-navy">{(hold.customer || "Customer").slice(0, 60)}</span>
                <span className="ml-2 break-all font-mono text-xs text-slate">{hold.orderNo}</span>
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-slate">{hold.method ?? "UPI"}</span>
                <span className="mt-0.5 block text-xs text-slate"><span>{when(hold.createdAt)}</span><span className="mx-1">·</span><span>{endedOutcomeLabel(hold.outcome)}</span></span>
              </span>
              </span>
              <span className="font-semibold tabular-nums text-navy">{inrPrecise(hold.amount)}</span>
              <span className={cn("rounded border px-2 py-0.5 text-xs font-semibold", orderToneClass(PAYMENT_EXPIRED, "badge"))}>{closedPaymentLabel(PAYMENT_EXPIRED)}</span>
              {(() => {
                const sent = submissions.find((item) => item.orderNo === hold.orderNo);
                if (sent?.status === "submitted") return <span className="text-[11px] font-semibold text-sky-800">{`UTR ${sent.utr} sent: check it under Payments to check`}</span>;
                if (sent && (sent.note === "refunded by our team" || /^Placed again as /.test(sent.note ?? ""))) return null;
                return (
                  <button type="button" onClick={() => setRecording(hold)} className="text-xs font-semibold text-emerald-700 underline">Record payment</button>
                );
              })()}
              {kept[hold.orderNo] && allDetails[hold.orderNo] ? (
                <span className="flex max-w-xs flex-col items-end gap-1 text-right text-[11px] text-slate">
                  <span><span className="font-semibold">Ordinary delete keeps it:</span> <span>{kept[hold.orderNo]}</span></span>
                  <button type="button" onClick={() => setDeletingAll(hold)} className="inline-flex items-center gap-1 text-xs font-semibold text-danger underline">
                    <Trash2 className="h-3.5 w-3.5" />Delete all details
                  </button>
                </span>
              ) : kept[hold.orderNo] ? (
                <span className="max-w-xs text-right text-[11px] text-slate"><span className="font-semibold">Kept:</span> <span>{kept[hold.orderNo]}</span></span>
              ) : (
                <button type="button" onClick={() => setDeleting(hold)} className="inline-flex items-center gap-1 text-xs font-semibold text-danger underline">
                  <Trash2 className="h-3.5 w-3.5" />Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
      {deleting && <DeleteOrderDialog orderNo={deleting.orderNo} onClose={() => setDeleting(null)} />}
      {recording && <RecordLatePaymentDialog orderNo={recording.orderNo} amount={recording.amount} method={recording.method} onClose={() => setRecording(null)} />}
      {deletingAll && <DeleteOrderRecordDialog orderNo={deletingAll.orderNo} onClose={() => setDeletingAll(null)} />}
      {bulkOpen && (
        <BulkDeleteDialog
          title={(n) => (n === 1 ? "Delete 1 ended checkout?" : `Delete ${n} ended checkouts?`)}
          description="Each one is checked by the database exactly as its own Delete is, one after another: anything paid, sent to Zoho or still being checked stays, and you are told why. Zoho and stock are not touched, and each delete is recorded with your reason (Delete all details keeps a full copy in the Delete Log)."
          items={ended.filter((hold) => bulk.isSelected(hold.orderNo)).map((hold) => ({ id: hold.orderNo, label: `${hold.orderNo} · ${(hold.customer || "Customer").slice(0, 40)} · ${inrPrecise(hold.amount)}` }))}
          reason="required"
          typeDelete
          run={deleteOne}
          onClose={() => setBulkOpen(false)}
          onFinished={(done) => { if (done.length) { bulk.clear(); upiRecordsChanged(); } }}
        />
      )}
    </div>
  );
}
