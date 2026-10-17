import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
      <CatalogParityPanel />
      <OrderEmailPanel />
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

type CatalogReport = Awaited<ReturnType<typeof import("@/lib/zoho-commerce.functions").reconcileZohoCatalog>>;

const CATALOG_LABELS: Record<string, string> = {
  duplicate_sku: "Same SKU on several products",
  not_linked: "Not linked to a Zoho item",
  missing_in_zoho: "Linked item missing in Zoho",
  sku_mismatch: "SKU differs",
  price_mismatch: "Price differs",
  stock_mismatch: "Stock differs",
  inactive_in_zoho: "Inactive in Zoho",
  not_linked_with_orders: "Ordered but no Zoho contact",
  contact_missing_in_zoho: "Linked contact missing in Zoho",
};

/** Read-only parity: products (SKU, price, stock, status) and customers against Zoho. */
function CatalogParityPanel() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CatalogReport | null>(null);
  const [error, setError] = useState("");
  const rows = report ? [
    ...report.catalog.issues.map((row) => ({ key: `p-${row.productId}-${row.issue}`, who: row.name, issue: row.issue, detail: row.detail })),
    ...report.customers.issues.map((row) => ({ key: `c-${row.userId}-${row.issue}`, who: row.name, issue: row.issue, detail: row.detail })),
  ] : [];
  return (
    <div className="mt-6">
      <Panel title="Products, stock and customers">
        <p className="mb-3 text-sm text-slate">
          Compares every Grain Bazar product (SKU, price, stock, active) with its Zoho item, and customers who ordered with their Zoho contact.
          Read-only: nothing is created or changed in either system.
        </p>
        <Button
          className="bg-navy text-white hover:bg-navy/90"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const { reconcileZohoCatalog } = await import("@/lib/zoho-commerce.functions");
              setReport(await reconcileZohoCatalog());
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Comparing…" : "Run parity check"}
        </Button>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        {report && (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-navy">
              Products: <strong>{report.catalog.checked}</strong> checked · <strong className="text-emerald-700">{report.catalog.inSync}</strong> in sync ·{" "}
              <strong className={report.catalog.issues.length ? "text-amber-700" : "text-emerald-700"}>{report.catalog.issues.length}</strong> to review
              {report.catalog.zohoOnly > 0 && ` · ${report.catalog.zohoOnly} Zoho items not used by the website`}
              {report.zohoImported > 0 && ` · ${report.zohoImported} Zoho-imported copies not compared`}
            </p>
            <p className="text-navy">
              Customers: <strong>{report.customers.checked}</strong> accounts · <strong>{report.customers.linked}</strong> linked to Zoho ·{" "}
              {report.customers.notLinkedNoOrders} not linked yet (no orders, linked on first order) ·{" "}
              <strong className={report.customers.issues.length ? "text-amber-700" : "text-emerald-700"}>{report.customers.issues.length}</strong> to review
            </p>
            {(report.itemsTruncated || report.stockTruncated || report.stockNotChecked > 0 || !report.contactsChecked) && (
              <p className="text-xs text-amber-700">
                {report.itemsTruncated && "Only the first 2,000 Zoho items were read. "}
                {report.stockTruncated && "Stock was compared for the first 60 linked products only. "}
                {report.stockNotChecked > 0 && `${report.stockNotChecked} items' stock could not be read from Zoho. `}
                {!report.contactsChecked && "Zoho has more than 2,000 contacts, so contact existence was not checked."}
              </p>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate"><tr><th className="py-1 pr-3">Product / customer</th><th className="py-1 pr-3">Issue</th><th className="py-1">Detail</th></tr></thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} className="border-t align-top">
                        <td className="py-1.5 pr-3 font-semibold text-navy">{row.who}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{CATALOG_LABELS[row.issue] ?? row.issue}</td>
                        <td className="py-1.5 text-slate">{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-slate">Ran {new Date(report.ranAt).toLocaleString("en-IN")} · {report.zohoItemsFetched} Zoho items read.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * Official Zoho notification for each new website order: Zoho Books "Email a sales order".
 * Off by default; needs Zoho re-authorized with Zoho Books permission.
 */
function OrderEmailPanel() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [recipients, setRecipients] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void import("@/lib/zoho-commerce.functions")
      .then(({ getZohoOrderEmailConfig }) => getZohoOrderEmailConfig())
      .then((config) => { setEnabled(config.enabled); setRecipients(config.to.join(", ")); })
      .catch(() => setMessage("Could not load the current setting."))
      .finally(() => setLoaded(true));
  }, []);
  const save = async (next: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const { setZohoOrderEmailConfig } = await import("@/lib/zoho-commerce.functions");
      const saved = await setZohoOrderEmailConfig({ data: { enabled: next, to: recipients.split(/[\s,;]+/).filter(Boolean) } });
      setEnabled(saved.enabled);
      setRecipients(saved.to.join(", "));
      setMessage(saved.enabled ? "On: Zoho will email each new website order to these addresses." : "Off: no Zoho order emails are sent.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6">
      <Panel title="Zoho order emails">
        <p className="mb-3 text-sm text-slate">
          When a website order reaches Zoho, Zoho Books can email that sales order (official "Email a sales order") from your Zoho organization to the
          addresses below. Zoho workflow email alerts do not fire for orders created by the website, so this is the Zoho route for new-order emails.
          Needs Zoho re-authorized once with Zoho Books permission.
        </p>
        <div className="grid gap-2 sm:max-w-xl">
          <label className="text-sm font-semibold text-navy" htmlFor="zoho-order-email-to">Send to (up to 5, comma separated)</label>
          <input
            id="zoho-order-email-to"
            className="rounded-md border px-3 py-2 text-sm"
            value={recipients}
            disabled={!loaded || busy}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="orders@yourbusiness.com"
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2">
            <Button className="bg-navy text-white hover:bg-navy/90" disabled={!loaded || busy} onClick={() => void save(true)}>
              {enabled ? "Save recipients" : "Turn on"}
            </Button>
            {enabled && <Button variant="outline" disabled={busy} onClick={() => void save(false)}>Turn off</Button>}
            <Button
              variant="outline"
              disabled={busy || !recipients.trim()}
              onClick={async () => {
                if (!window.confirm(`Zoho will send a real test email for your newest website order to the saved recipients. Send it now?`)) return;
                setBusy(true);
                setMessage("");
                try {
                  const { sendZohoOrderTestEmail } = await import("@/lib/zoho-commerce.functions");
                  const sent = await sendZohoOrderTestEmail();
                  setMessage(`Zoho accepted the test email for ${sent.order} to ${sent.sentTo.join(", ")}. Check the inbox (and spam).`);
                } catch (cause) {
                  setMessage(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send test email
            </Button>
          </div>
          <p className="text-xs text-slate">Status: {loaded ? (enabled ? "On" : "Off") : "Loading…"}</p>
          {message && <p role="status" className="text-sm text-navy">{message}</p>}
        </div>
      </Panel>
    </div>
  );
}
