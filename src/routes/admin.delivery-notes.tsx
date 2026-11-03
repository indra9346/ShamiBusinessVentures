import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel } from "@/components/panel/widgets";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { gateWords, istDateTime, paperWarnings, type DeliveryRegisterRow } from "@/lib/delivery-notes";
import { listDeliveryNotes } from "@/lib/delivery-notes.functions";
import { adminNav } from "@/lib/panel-nav";

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
  const [failed, setFailed] = useState("");

  const load = useCallback(async () => {
    if (STATIC_DATA_MODE) { setRows([]); return; }
    try {
      setRows(await listDeliveryNotes());
      setFailed("");
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not read the delivery notes");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const attention = useMemo(() => (rows ?? []).filter((row) => paperWarnings(row.state).length > 0), [rows]);

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
      <Panel title={rows ? `All delivery notes (${rows.length})` : "All delivery notes"}>
        <p className="-mt-1 mb-3 text-xs text-slate">
          Numbers run on with no gap and are never reused. A note is generated on the order page, only after its full invoice amount is paid. This list uses what the website last read from Zoho; opening an order reads Zoho again.
        </p>
        {failed && <p className="mb-2 text-sm text-danger">{failed}</p>}
        {!rows && !failed && <p className="text-sm text-slate">Loading…</p>}
        {rows && (
          <DataTable
            tableId="admin-delivery-notes"
            columns={["Note", "Order", "Customer", "Godown", "Items", "Generated", "By", "Prints", "State"]}
            empty={STATIC_DATA_MODE ? "Delivery notes need the live database, so they are not available in this demo." : "No delivery notes yet"}
            minWidth={980}
            rows={rows.map((row) => {
              const warned = paperWarnings(row.state).length > 0;
              return [
                <span key="note" className="font-mono font-semibold text-navy">{row.note_no}</span>,
                <Link key="order" to="/admin/orders/$id" params={{ id: row.order_no }} className="font-semibold text-gold hover:underline">{row.order_no}</Link>,
                row.customer,
                row.godown,
                String(row.items),
                istDateTime(row.generated_at),
                row.generated_by,
                row.prints > 0 ? `${row.prints} · last ${istDateTime(row.last_printed_at ?? "")}` : "Not printed",
                <span key="state" className={warned ? "font-bold text-danger" : "font-semibold text-emerald-800"}>{warned ? gateWords(row.state).title : "In order"}</span>,
              ];
            })}
          />
        )}
      </Panel>
    </PanelLayout>
  );
}
