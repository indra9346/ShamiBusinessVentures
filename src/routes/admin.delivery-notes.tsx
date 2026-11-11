import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScanLine } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { DataTable, Panel } from "@/components/panel/widgets";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
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
      { name: "description", content: "Every delivery note, how it was released, who printed it, the godown's scans, and the delivery QR rules." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminDeliveryNotes,
});

/** What godown staff and the channel partner may do on a scan of the invoice QR (public.delivery_qr_rules). */
type QrRules = {
  staff_print_slips: boolean; staff_print_note: boolean; staff_handover: boolean;
  partner_print_slips: boolean; partner_print_note: boolean; partner_handover: boolean;
};
type QrRule = keyof QrRules;

const RULE_ROWS: { who: string; detail: string; rules: { key: QrRule; label: string }[] }[] = [
  {
    who: "Godown staff",
    detail: "Staff of the order's godown who are not the in-charge.",
    rules: [{ key: "staff_print_slips", label: "Print delivery slips" }, { key: "staff_print_note", label: "Print the delivery note" }, { key: "staff_handover", label: "Hand over goods" }],
  },
  {
    who: "Channel partner",
    detail: "The partner who runs the order's godown.",
    rules: [{ key: "partner_print_slips", label: "Print delivery slips" }, { key: "partner_print_note", label: "Print the delivery note" }, { key: "partner_handover", label: "Hand over goods" }],
  },
];

/**
 * The admin's switches for the invoice QR (owner, 11 Nov 2026: "both options should be there and enable this option in
 * admin for controlling"). The godown in-charge and admins can always print and hand over; staff and the channel
 * partner only what is on here. The database reads these again on every scan.
 */
function DeliveryQrRules() {
  const [rules, setRules] = useState<QrRules | null>(null);
  const [failed, setFailed] = useState("");
  const [saving, setSaving] = useState<QrRule | "">("");

  useEffect(() => {
    if (STATIC_DATA_MODE) return;
    void (async () => {
      const { data, error } = await supabase.rpc("delivery_qr_rules");
      if (error) { setFailed(/does not exist|schema cache|could not find/i.test(error.message) ? "The delivery QR rules are not set up in the database yet." : error.message); return; }
      setRules(data as unknown as QrRules);
    })();
  }, []);

  const change = async (key: QrRule, on: boolean) => {
    setSaving(key);
    const { data, error } = await supabase.rpc("admin_set_delivery_qr_rules", { _rules: { [key]: on } });
    setSaving("");
    if (error) { toast.error("Could not change the rule", { description: error.message }); return; }
    setRules(data as unknown as QrRules);
    toast.success("Delivery QR rule saved", { description: "It applies from the next scan." });
  };

  return (
    <Panel title="Delivery QR rules" className="mb-4">
      <p className="-mt-1 mb-3 text-xs text-slate">
        When someone at the godown scans the QR on a customer's invoice: the godown in-charge and admins can always print the delivery note and slips and hand over the goods. Choose what godown staff and the channel partner may do.
      </p>
      {STATIC_DATA_MODE && <p className="text-sm text-slate">The rules need the live database, so they are not available in this demo.</p>}
      {failed && <p className="text-sm text-danger">{failed}</p>}
      {!rules && !failed && !STATIC_DATA_MODE && <p className="text-sm text-slate">Loading…</p>}
      {rules && (
        <div className="grid gap-3 md:grid-cols-2">
          {RULE_ROWS.map((row) => (
            <div key={row.who} className="rounded-md border border-border p-3">
              <p className="text-sm font-bold text-navy">{row.who}</p>
              <p className="mb-2 text-xs text-slate">{row.detail}</p>
              <ul className="space-y-2">
                {row.rules.map((rule) => (
                  <li key={rule.key} className="flex items-center justify-between gap-3 text-sm">
                    <label htmlFor={`qr-rule-${rule.key}`} className="text-charcoal">{rule.label}</label>
                    <Switch id={`qr-rule-${rule.key}`} checked={rules[rule.key]} disabled={saving !== ""} onCheckedChange={(on) => void change(rule.key, on)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-slate">Choose the in-charge in Attendance &gt; Employees (Make in-charge).</p>
    </Panel>
  );
}

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
          <ScanLine className="h-4 w-4" /> Scan the QR on an invoice
        </Link>
        <span className="text-xs text-slate">The godown in-charge scans from the staff app, channel partners from their partner page. Delivery papers printed before 12 Nov 2026 can still be scanned.</span>
      </div>
      <DeliveryQrRules />
      <Panel title={rows ? `All delivery notes (${rows.length})` : "All delivery notes"}>
        <p className="-mt-1 mb-3 text-xs text-slate">
          Numbers run on with no gap and are never reused. A note is released automatically once the order's full payment is confirmed and Zoho Books has the paid invoice; if that did not happen, the godown in-charge's scan or Release now on the order page releases it. This list uses what the website last read from Zoho; opening an order reads Zoho again.
        </p>
        {failed && <p className="mb-2 text-sm text-danger">{failed}</p>}
        {!rows && !failed && <p className="text-sm text-slate">Loading…</p>}
        {rows && (
          <DataTable
            tableId="admin-delivery-notes"
            columns={["Note", "State", "Order", "Customer", "Godown", "Items", "Handed over", "Released", "Prints"]}
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
          Every scan of an invoice's QR code, and of delivery papers printed before 12 Nov 2026: who (in-charge, staff, channel partner or office), when, at which godown, on the godown's registered phone or their own, and what the system answered. Nothing here can be changed or deleted.
        </p>
        {scans && (
          <DataTable
            tableId="admin-delivery-scans"
            columns={["When", "Answer", "QR", "Note", "Scanned by", "Phone"]}
            empty="No scans yet"
            minWidth={880}
            rows={scans.map((scan) => [
              <span key="when" className="whitespace-nowrap">{istDateTime(scan.occurred_at)}</span>,
              <span key="answer" className={cn("font-semibold", scan.result === "handed_over" ? "text-emerald-800" : scanIsRefusal(scan.result) ? "text-danger" : "text-charcoal")}>
                {scanResultLabel(scan.result)}{scan.lines.length > 0 ? ` (item${scan.lines.length === 1 ? "" : "s"} ${scan.lines.join(", ")})` : ""}
                {scan.order_delivered && <span className="block text-[11px] text-emerald-800">Order marked Delivered</span>}
              </span>,
              scannedPaperLabel(scan),
              scan.order_no ? <Link key="note" to="/admin/orders/$id" params={{ id: scan.order_no }} className="font-semibold text-gold hover:underline">{scan.note_no ? `${scan.note_no} · ${scan.order_no}` : scan.order_no}</Link> : "—",
              `${scan.actor_name} (${roleWords(scan.actor_role).en}${scan.branch_name ? `, ${scan.branch_name}` : ""})`,
              scan.device_registered ? `Godown phone${scan.device_label ? `: ${scan.device_label}` : ""}` : "Own phone",
            ])}
          />
        )}
      </Panel>
    </PanelLayout>
  );
}
