import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Ban, FileX2, History, Trash2 } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, scrollToSection, StatCard } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { inrPrecise } from "@/lib/data";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { supabase } from "@/integrations/supabase/client";
import { deletedPaymentKind, placedAgainText } from "@/lib/order-cancel";
import { useApp } from "@/lib/store";
import { isMissingInDatabase } from "@/lib/upi-store";

export const Route = createFileRoute("/admin/delete-log")({
  head: () => ({ meta: [{ title: "Delete Log | Shami Admin" }, { name: "robots", content: "noindex" }] }),
  component: AdminDeleteLog,
});

type DeletedOrder = { id: number; order_no: string; order_status: string; total: number; item_count: number; reason: string; deleted_by_name: string; deleted_at: string; utrs: string; zoho_salesorder_id: string; zoho_order_status: string };
type RemovedPayment = { id: string; kind: string; order_no: string; payment: Record<string, unknown> | null; reason: string; deleted_by_name: string; deleted_at: string };
type Cancellation = { id: string; order_no: string; stage: string; goods_back: boolean | null; refunded: number; reason: string; cancelled_by_name: string; cancelled_at: string; placed_again_at?: string | null; placed_again_by_name?: string | null };
const CANCELLATION_COLUMNS = "id,order_no,stage,goods_back,refunded,reason,cancelled_by_name,cancelled_at";
type CancellationRead = { data: Cancellation[] | null; error: { code?: string; message?: string } | null };
const readCancellations = (columns: string) =>
  supabase.from("order_cancellations").select(columns).order("cancelled_at", { ascending: false }).limit(200) as unknown as PromiseLike<CancellationRead>;
/** With who placed an ended checkout again (13 Nov 2026), or without it while the database does not have that yet. */
async function loadCancellations(): Promise<CancellationRead> {
  const read = await readCancellations(`${CANCELLATION_COLUMNS},placed_again_at,placed_again_by_name`);
  return read.error && isMissingInDatabase(read.error) ? readCancellations(CANCELLATION_COLUMNS) : read;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
/** When, who and why, each its own piece so each is translated. */
function ByLine({ at, verb, name, reason }: { at: string; verb: "Deleted" | "Removed" | "Cancelled"; name: string; reason: string }) {
  return (
    <p className="break-words text-xs text-slate">
      <span>{when(at)}</span>
      {name && <> · <span>{`${verb} by ${name}`}</span></>}
      {" · "}<span>{reason ? `Reason: ${reason}` : "No reason given"}</span>
    </p>
  );
}

// Static demo only: what the page looks like with a few rows.
const DEMO = {
  orders: [{ id: 1, order_no: "CLK-577522-031126-121319", order_status: "Payment Expired", total: 2835, item_count: 1, reason: "Test checkout with a made-up UTR", deleted_by_name: "Indra Kumar", deleted_at: "2026-11-11T09:30:00Z", utrs: "VAMSHI12345678910 (rejected: refunded by our team)", zoho_salesorder_id: "", zoho_order_status: "" }],
  payments: [{ id: "d1", kind: "utr", order_no: "CLK-577522-101126-101010", payment: { utr: "123456789012", amount: 130 }, reason: "Customer typed the wrong UTR", deleted_by_name: "Indra Kumar", deleted_at: "2026-11-11T08:00:00Z" }],
  cancellations: [{ id: "c1", order_no: "CLK-577522-091126-111111", stage: "Out for Delivery", goods_back: true, refunded: 2835, reason: "Customer refused the bag at the door", cancelled_by_name: "Indra Kumar", cancelled_at: "2026-11-10T12:00:00Z" }],
};

function AdminDeleteLog() {
  const { orders } = useApp();
  const [deleted, setDeleted] = useState<DeletedOrder[] | null>(null);
  const [removed, setRemoved] = useState<RemovedPayment[] | null>(null);
  const [cancelled, setCancelled] = useState<Cancellation[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (STATIC_DATA_MODE) {
      setDeleted(DEMO.orders); setRemoved(DEMO.payments); setCancelled(DEMO.cancellations);
      return;
    }
    void Promise.all([
      supabase.from("deleted_orders_log").select("id,order_no,order_status,total,item_count,reason,deleted_by_name,deleted_at,utrs,zoho_salesorder_id,zoho_order_status").order("deleted_at", { ascending: false }).limit(200),
      supabase.from("deleted_payments_log").select("id,kind,order_no,payment,reason,deleted_by_name,deleted_at").order("deleted_at", { ascending: false }).limit(200),
      loadCancellations(),
    ]).then(([a, b, c]) => {
      if (a.error || b.error || c.error) setFailed(true);
      setDeleted((a.data ?? []).map((row) => ({ ...row, total: Number(row.total) })) as DeletedOrder[]);
      setRemoved((b.data ?? []) as unknown as RemovedPayment[]);
      setCancelled((c.data ?? []).map((row) => ({ ...row, refunded: Number(row.refunded) })) as Cancellation[]);
    });
  }, []);
  const known = new Set(orders.map((order) => order.id));
  const loading = <p className="text-sm text-slate">Loading…</p>;
  const none = <p className="text-sm text-slate">None yet.</p>;
  return (
    <PanelLayout items={adminNav} tone="admin" title="Delete Log" subtitle="Orders deleted, payments and UTRs removed, and orders cancelled by an admin: who, when and why">
      {failed && <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">Some of the log could not be read. Open the page again.</p>}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Orders deleted" value={String(deleted?.length ?? 0)} icon={Trash2} onClick={() => scrollToSection("deleted-orders")} />
        <StatCard label="Payments and UTRs removed" value={String(removed?.length ?? 0)} icon={FileX2} onClick={() => scrollToSection("removed-payments")} />
        <StatCard label="Cancelled by an admin" value={String(cancelled?.length ?? 0)} icon={Ban} onClick={() => scrollToSection("admin-cancellations")} />
      </div>

      <div id="deleted-orders" className="scroll-mt-36">
      <Panel title="Orders deleted">
        <p className="mb-2 text-xs text-slate">A full copy of each order, with its items, payments, refunds and UTRs, is kept in the database. Its number is never used again.</p>
        {!deleted ? loading : !deleted.length ? none : (
          <ul className="divide-y divide-border">
            {deleted.map((row) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all font-mono text-xs font-semibold text-navy">{row.order_no}</span>
                  <span className="font-semibold tabular-nums text-navy">{inrPrecise(row.total)}</span>
                </div>
                <p className="text-xs text-slate">
                  <span>{row.order_status}</span> · <span>{row.item_count === 1 ? "1 item" : `${row.item_count} items`}</span>
                  {row.zoho_salesorder_id && <> · <span data-no-translate>{`Zoho ${row.zoho_salesorder_id} (${row.zoho_order_status || "?"})`}</span></>}
                </p>
                <ByLine at={row.deleted_at} verb="Deleted" name={row.deleted_by_name} reason={row.reason} />
                {row.utrs && <p className="break-all text-[11px] text-slate">{`UTRs sent: ${row.utrs}`}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      </div>

      <div id="removed-payments" className="mt-6 scroll-mt-36">
      <Panel title="Payments and UTRs removed">
        <p className="mb-2 text-xs text-slate">A refunded transfer stays unable to pay for anything after its record is removed.</p>
        {!removed ? loading : !removed.length ? none : (
          <ul className="divide-y divide-border">
            {removed.map((row) => {
              const amount = Number(row.payment?.["amount"] ?? 0);
              const ref = String(row.payment?.["txn_ref"] ?? row.payment?.["utr"] ?? "");
              return (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-slate">{deletedPaymentKind(row.kind)}</span>
                      <span className="ml-2 break-all font-mono text-xs font-semibold text-navy">{row.order_no}</span>
                    </span>
                    {amount > 0 && <span className="font-semibold tabular-nums text-navy">{inrPrecise(amount)}</span>}
                  </div>
                  {ref && <p className="break-all font-mono text-[11px] text-slate">{`Reference: ${ref}`}</p>}
                  <ByLine at={row.deleted_at} verb="Removed" name={row.deleted_by_name} reason={row.reason} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      </div>

      <div id="admin-cancellations" className="mt-6 scroll-mt-36">
      <Panel title="Cancelled by an admin">
        <p className="mb-2 text-xs text-slate">Every cancel and every ended checkout, at the step it was at. An order deleted since keeps this in its copy.</p>
        {!cancelled ? loading : !cancelled.length ? none : (
          <ul className="divide-y divide-border">
            {cancelled.map((row) => (
              <li key={row.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  {known.has(row.order_no) ? (
                    <Link to="/admin/orders/$id" params={{ id: row.order_no }} className="min-w-0 break-all font-mono text-xs font-semibold text-navy hover:text-gold hover:underline">{row.order_no}</Link>
                  ) : <span className="min-w-0 break-all font-mono text-xs font-semibold text-navy">{row.order_no}</span>}
                  {row.refunded > 0 && <span className="font-semibold tabular-nums text-danger">{`Refunded ${inrPrecise(row.refunded)}`}</span>}
                </div>
                <p className="text-xs text-slate">
                  <span>{`Cancelled at ${row.stage}`}</span>
                  {row.goods_back !== null && <> · <span>{row.goods_back ? "The goods came back to the godown." : "The goods did not come back."}</span></>}
                </p>
                <ByLine at={row.cancelled_at} verb="Cancelled" name={row.cancelled_by_name} reason={row.reason} />
                {placedAgainText(row, when) && <p className="text-xs font-semibold text-emerald-800">{placedAgainText(row, when)}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-slate"><History className="h-3.5 w-3.5" />Newest first, the last 200 of each.</p>
    </PanelLayout>
  );
}
