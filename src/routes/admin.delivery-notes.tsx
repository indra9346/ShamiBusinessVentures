import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScanLine } from "lucide-react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel } from "@/components/panel/widgets";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { gateWords, istDateTime, paperWarnings, type DeliveryRegisterRow } from "@/lib/delivery-notes";
import { listDeliveryNotes, listDeliveryScans } from "@/lib/delivery-notes.functions";
import { roleWords, scanIsRefusal, scannedPaperLabel, scanResultLabel, type DeliveryScanRow } from "@/lib/delivery-papers";
import { adminNav } from "@/lib/panel-nav";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/delivery-notes")({
  head: () => ({
    meta: [
      { title: "Delivery Notes | Shami Business Ventures Admin" },
      { name: "description", content: "Every delivery note, who generated and printed it, and any that need attention." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminDeliveryNotes,
});

/** The register of delivery notes: every number, in order, with any that need attention at the top of mind. */
function AdminDeliveryNotes() {
  const [rows, setRows] = useState<DeliveryRegisterRow[] | null>(null);
  const [scans, setScans] = useState<DeliveryScanRow[] | null>(null);
  const [failed, setFailed] = useState("");

  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setRows([]); setScans([]); return; }
    try {
      const [notes, scanRows] = await Promise.all([listDeliveryNotes(), listDeliveryScans()]);
      setRows(notes);
      setScans(scanRows);
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not read the delivery notes");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const attention = useMemo(() => (rows ?? []).filter((row) => paperWarnings(row.state).length > 0), [rows]);
  // Codes the system never made: someone scanned a forged, damaged or foreign QR.
  const unknown = useMemo(() => (scans ?? []).filter((scan) => scan.result === "unknown"), [scans]);

  return (
    <PanelLayout items={adminNav} tone="admin" title="Delivery Notes" subtitle="Every note and slip, in number order">
      {attention.length > 0 && (
        <div className="mb-4 rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-bold">{attention.length} delivery note{attention.length === 1 ? " needs" : "s need"} attention</p>
          <ul className="mt-1 space-y-0.5">
            {attention.slice(0, 12).map((row) => (
              <li key={row.seq}>
                <Link to="/admin/orders/$id" params={{ id: row.order_no }} className="font-semibold underline">{row.note_no}</Link> · {row.order_no}: {gateWords(row.state).title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {unknown.length > 0 && (
        <div className="mb-4 rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-bold">{unknown.length} scan{unknown.length === 1 ? " was" : "s were"} of a QR code that is not in the system</p>
          <p className="mt-0.5">A forged, damaged or foreign paper. The latest: {istDateTime(unknown[0]!.occurred_at)} by {unknown[0]!.actor_name}{unknown[0]!.branch_name ? `, ${unknown[0]!.branch_name}` : ""}. See QR scans below.</p>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/slip" className="inline-flex items-center gap-1.5 rounded-md bg-navy px-3 py-2 text-sm font-semibold text-white hover:bg-navy/90">
          <ScanLine className="h-4 w-4" /> Scan a delivery note or slip
        </Link>
        <span className="text-xs text-slate">Checks a paper's QR. Godown staff scan from their attendance app, channel partners from their partner page.</span>
      </div>
      <Panel title={rows ? `All delivery notes (${rows.length})` : "All delivery notes"}>
        <p className="-mt-1 mb-3 text-xs text-slate">
          Numbers run on with no gap and are never reused. A note is generated on the order page, only after its full invoice amount is paid. This list uses what the website last read from Zoho; opening an order reads Zoho again.
        </p>
        {failed && <p className="mb-2 text-sm text-danger">{failed}</p>}
        {!rows && !failed && <p className="text-sm text-slate">Loading…</p>}
        {rows && (
          <DataTable
            tableId="admin-delivery-notes"
            columns={["Note", "State", "Order", "Customer", "Godown", "Items", "Handed over", "Generated", "Prints"]}
            empty={STATIC_DATA_MODE ? "Delivery notes need the live database, so they are not available in this demo." : "No delivery notes yet"}
            minWidth={1000}
            rows={rows.map((row) => {
              const warned = paperWarnings(row.state).length > 0;
              const handed = Number(row.handed_over ?? 0);
              return [
                <span key="note" className="whitespace-nowrap font-mono font-semibold text-navy">{row.note_no}</span>,
                <span key="state" className={warned ? "font-bold text-danger" : "font-semibold text-emerald-800"}>{warned ? gateWords(row.state).title : "In order"}</span>,
                <Link key="order" to="/admin/orders/$id" params={{ id: row.order_no }} className="font-semibold text-gold hover:underline">{row.order_no}</Link>,
                row.customer,
                row.godown,
                String(row.items),
                <span key="handed" className={cn(handed >= row.items ? "font-semibold text-emerald-800" : "text-charcoal")}>
                  {handed} of {row.items}{row.last_handed_over_at ? ` · ${istDateTime(row.last_handed_over_at)}` : ""}
                  {Number(row.reopened ?? 0) > 0 && <span className="block text-[11px] font-semibold text-amber-800">{row.reopened} reopened by the office</span>}
                  {Number(row.refused_scans ?? 0) > 0 && <span className="block text-[11px] font-semibold text-danger">{row.refused_scans} refused scan{Number(row.refused_scans) === 1 ? "" : "s"}</span>}
                </span>,
                `${istDateTime(row.generated_at)} by ${row.generated_by}`,
                row.prints > 0 ? `${row.prints} · last ${istDateTime(row.last_printed_at ?? "")}` : "Not printed",
              ];
            })}
          />
        )}
      </Panel>
      <Panel title={scans ? `QR scans (latest ${scans.length})` : "QR scans"} className="mt-4">
        <p className="-mt-1 mb-3 text-xs text-slate">
          Every scan of a delivery note's or slip's QR code: who (staff, channel partner or office), when, at which godown, on the godown's registered phone or their own, and what the system answered. Nothing here can be changed or deleted.
        </p>
        {scans && (
          <DataTable
            tableId="admin-delivery-scans"
            columns={["When", "Answer", "Paper", "Note", "Scanned by", "Phone"]}
            empty="No scans yet"
            minWidth={880}
            rows={scans.map((scan) => [
              <span key="when" className="whitespace-nowrap">{istDateTime(scan.occurred_at)}</span>,
              <span key="answer" className={cn("font-semibold", scan.result === "handed_over" ? "text-emerald-800" : scanIsRefusal(scan.result) ? "text-danger" : "text-charcoal")}>
                {scanResultLabel(scan.result)}{scan.lines.length > 0 ? ` (item${scan.lines.length === 1 ? "" : "s"} ${scan.lines.join(", ")})` : ""}
                {scan.order_delivered && <span className="block text-[11px] text-emerald-800">Order marked Delivered</span>}
              </span>,
              scannedPaperLabel(scan),
              scan.order_no ? <Link key="note" to="/admin/orders/$id" params={{ id: scan.order_no }} className="font-semibold text-gold hover:underline">{scan.note_no} · {scan.order_no}</Link> : "—",
              `${scan.actor_name} (${roleWords(scan.actor_role).en}${scan.branch_name ? `, ${scan.branch_name}` : ""})`,
              scan.device_registered ? `Godown phone${scan.device_label ? `: ${scan.device_label}` : ""}` : "Own phone",
            ])}
          />
        )}
      </Panel>
    </PanelLayout>
  );
}
