import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/zoho-diagnostics")({
  head: () => ({ meta: [{ title: "Zoho diagnostics | Grain Bazar Admin" }, { name: "robots", content: "noindex" }] }),
  component: ZohoDiagnostics,
});

/** Read-only checks against Zoho, for support. */
function ZohoDiagnostics() {
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <PanelLayout items={adminNav} tone="admin" title="Zoho diagnostics" subtitle="Read-only checks against your Zoho organization">
      <Panel title="Sales channel">
        <p className="mb-3 text-sm text-slate">Shows how Zoho labels the channel on a Grain Bazar order and on a Zoho Commerce order. Nothing is changed.</p>
        <Button
          className="bg-navy text-white hover:bg-navy/90"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { probeZohoSalesChannel } = await import("@/lib/zoho-commerce.functions");
              setOutput(await probeZohoSalesChannel());
            } catch (cause) {
              setOutput(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking…" : "Check sales channel"}
        </Button>
        <Button
          variant="outline"
          className="ml-2"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { markZohoOrdersChannel } = await import("@/lib/zoho-commerce.functions");
              setOutput(await markZohoOrdersChannel());
            } catch (cause) {
              setOutput(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          Mark existing orders as GrainBazar
        </Button>
        <p className="mt-3 text-xs text-slate">Needs a sales-order custom field in Zoho: label "Order Channel" (API name cf_order_channel). New orders are marked automatically.</p>
        {output && <pre id="zoho-probe-output" className="mt-4 max-h-[60vh] overflow-auto rounded-md bg-stone-900 p-3 text-xs text-stone-100">{output}</pre>}
      </Panel>
      <ReconcilePanel />
    </PanelLayout>
  );
}

type ReconcileReport = Awaited<ReturnType<typeof import("@/lib/zoho-commerce.functions").reconcileZohoOrders>>;

const ISSUE_LABELS: Record<string, string> = {
  missing_in_zoho: "Not in Zoho / not linked",
  linked_but_not_listed: "Linked, but Zoho did not return it",
  link_mismatch: "Linked to a different Zoho order",
  duplicate_in_zoho: "Duplicate in Zoho",
  total_mismatch: "Total differs",
  status_mismatch: "Cancelled on one side only",
  zoho_without_grain_bazar_order: "In Zoho only",
};

/** Read-only order reconciliation: Grain Bazar orders vs Zoho sales orders (GB-...). */
function ReconcilePanel() {
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [error, setError] = useState("");
  return (
    <div className="mt-6">
      <Panel title="Order reconciliation">
        <p className="mb-3 text-sm text-slate">
          Compares recent Grain Bazar orders with their Zoho sales orders (number GB-…). Read-only: nothing is created or changed in either system.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-navy" htmlFor="reconcile-days">Last</label>
          <select id="reconcile-days" className="rounded-md border px-2 py-1.5 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
          </select>
          <Button
            className="bg-navy text-white hover:bg-navy/90"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const { reconcileZohoOrders } = await import("@/lib/zoho-commerce.functions");
                setReport(await reconcileZohoOrders({ data: { days } }));
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Comparing…" : "Run reconciliation"}
          </Button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        {report && (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-navy">
              <strong>{report.checked}</strong> orders checked · <strong className="text-emerald-700">{report.inSync}</strong> in sync ·{" "}
              <strong className={report.issues.length ? "text-amber-700" : "text-emerald-700"}>{report.issues.length}</strong> to review
              {report.truncated && " · only the newest 80 orders were checked; pick a shorter period"}
            </p>
            {report.issues.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate"><tr><th className="py-1 pr-3">Order</th><th className="py-1 pr-3">Issue</th><th className="py-1">Detail</th></tr></thead>
                  <tbody>
                    {report.issues.map((row, i) => (
                      <tr key={`${row.orderNo}-${i}`} className="border-t align-top">
                        <td className="py-1.5 pr-3 font-semibold text-navy">{row.orderNo}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{ISSUE_LABELS[row.issue] ?? row.issue}</td>
                        <td className="py-1.5 text-slate">{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate">Ran {new Date(report.ranAt).toLocaleString("en-IN")}.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}
