import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CloudDownload, Link2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getZohoConnectionStatus,
  getZohoCommerceReadMirror,
  startZohoAuthorization,
  syncZohoCommerceReadMirror,
  syncZohoProducts,
} from "@/lib/zoho-commerce.functions";

export const Route = createFileRoute("/admin/zoho")({ component: ZohoCommerceAdmin });

type Connection = {
  organization_id: string;
  region: string;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  updated_at: string;
} | null;

type MirrorState = {
  organization_id: string;
  resource: string;
  current_batch_id: string;
  record_count: number;
  last_synced_at: string;
  last_error: string | null;
};
type MirrorRecord = { external_id: string; payload: Record<string, unknown>; captured_at: string };
const RESOURCE_LABELS: Record<string, string> = {
  categories: "Categories",
  sales_orders: "Sales orders (includes available package, shipment, payment, and return fields)",
  tax_rules: "Tax rules and preferences",
  store_index: "Zoho stores",
  store_meta: "Published storefront settings",
};

function ZohoCommerceAdmin() {
  const [connection, setConnection] = useState<Connection>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [region, setRegion] = useState("in");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mirrorStates, setMirrorStates] = useState<MirrorState[]>([]);
  const [mirrorRecords, setMirrorRecords] = useState<Record<string, MirrorRecord[]>>({});
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const salesOrders = mirrorRecords["sales_orders"] ?? [];
  const totalByCurrency = salesOrders.reduce<Record<string, number>>((totals, record) => {
    const payload = record.payload;
    const currency = String(payload["currency_code"] ?? "Unknown currency");
    const total = Number(payload["total"]);
    if (Number.isFinite(total)) totals[currency] = (totals[currency] ?? 0) + total;
    return totals;
  }, {});
  const reload = async () => {
    try {
      const status = await getZohoConnectionStatus();
      setConnection(status as Connection);
      if (status) {
        setOrganizationId(status.organization_id);
        setRegion(status.region);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Zoho status");
    } finally {
      setLoaded(true);
    }
  };
  const reloadMirror = async () => {
    try {
      const result = await getZohoCommerceReadMirror();
      setMirrorStates(result.resources as MirrorState[]);
      setMirrorRecords(result.snapshots as Record<string, MirrorRecord[]>);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Zoho data mirror");
    }
  };
  useEffect(() => {
    void reload();
    void reloadMirror();
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected")) toast.success("Zoho Commerce connected");
    if (params.has("error"))
      toast.error("Zoho connection failed", {
        description: "Review Zoho app settings and server configuration, then try again.",
      });
  }, []);
  const connect = async () => {
    setBusy(true);
    try {
      if (!organizationId.trim()) throw new Error("Enter the Zoho Commerce organization ID");
      const { url } = await startZohoAuthorization({
        data: { organizationId, region: region as "com" | "eu" | "in" | "com_au" | "jp" | "ca" },
      });
      window.location.assign(url);
    } catch (error) {
      toast.error("Could not start Zoho authorization", {
        description: error instanceof Error ? error.message : "Try again",
      });
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      const { synced, couponsSynced } = await syncZohoProducts();
      toast.success(`Synced ${synced} products and ${couponsSynced} coupons from Zoho Commerce`);
      await reload();
    } catch (error) {
      toast.error("Zoho product sync failed", {
        description: error instanceof Error ? error.message : "Check the connection and try again",
      });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const syncReadMirror = async () => {
    setMirrorBusy(true);
    try {
      const result = await syncZohoCommerceReadMirror();
      await reloadMirror();
      if (result.failures) {
        const failed = Object.entries(result.outcomes)
          .filter(([, outcome]) => outcome.error)
          .map(([resource]) => RESOURCE_LABELS[resource] ?? resource)
          .join(", ");
        toast.error("Zoho data sync completed with some errors", { description: failed });
      } else {
        toast.success("Synced the available Zoho read-only data");
      }
      await reload();
    } catch (error) {
      toast.error("Zoho data sync failed", {
        description:
          error instanceof Error ? error.message : "Check the connection and requested scopes",
      });
    } finally {
      setMirrorBusy(false);
    }
  };
  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Zoho Commerce"
      subtitle="Read supported Zoho Commerce catalog and account data securely"
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel title="Connection">
          <div className="mb-5 flex items-center gap-3 rounded-lg border p-4">
            {connection?.status === "connected" ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : connection?.status === "error" ? (
              <AlertCircle className="h-5 w-5 text-red-600" />
            ) : (
              <Link2 className="h-5 w-5 text-slate-500" />
            )}
            <div>
              <p className="font-semibold text-navy">
                {!loaded
                  ? "Checking connection…"
                  : connection?.status === "connected"
                    ? "Connected"
                    : connection?.status === "error"
                      ? "Sync needs attention"
                      : "Not connected"}
              </p>
              <p className="text-sm text-slate">
                {connection
                  ? `Organization ${connection.organization_id} · Zoho ${connection.region.toUpperCase()}`
                  : "Authorize using Zoho OAuth. Your Zoho password is never entered here."}
              </p>
            </div>
          </div>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="zoho-org">Zoho Commerce organization ID</Label>
              <Input
                id="zoho-org"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                placeholder="Organization ID from Zoho Commerce"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Zoho data center</Label>
              <Select value={region} onValueChange={(value) => setRegion(value ?? "in")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">India (.in)</SelectItem>
                  <SelectItem value="com">United States (.com)</SelectItem>
                  <SelectItem value="eu">Europe (.eu)</SelectItem>
                  <SelectItem value="com_au">Australia (.com.au)</SelectItem>
                  <SelectItem value="jp">Japan (.jp)</SelectItem>
                  <SelectItem value="ca">Canada (.ca)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => void connect()}
                className="bg-navy text-white hover:bg-navy/90"
              >
                {connection ? "Reauthorize Zoho" : "Connect Zoho"}
              </Button>
              <Button disabled={busy || !connection} variant="outline" onClick={() => void sync()}>
                <CloudDownload className="mr-2 h-4 w-4" />
                Sync products and coupons now
              </Button>
              <Button
                disabled={busy || mirrorBusy || !connection}
                variant="outline"
                onClick={() => void syncReadMirror()}
              >
                <CloudDownload className="mr-2 h-4 w-4" />
                Sync Zoho account data
              </Button>
              <Button disabled={busy} variant="ghost" onClick={() => void reload()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh status
              </Button>
            </div>
            {connection?.last_synced_at && (
              <p className="text-xs text-slate">
                Last successful sync: {new Date(connection.last_synced_at).toLocaleString()}
              </p>
            )}
            {connection?.last_error && (
              <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
                {connection.last_error}
              </p>
            )}
          </div>
        </Panel>
        <Panel title="What syncs to the customer catalog">
          <div className="space-y-3 text-sm text-slate">
            <p>
              Zoho product name, SKU, brand, category, storefront visibility, price, list price,
              stock, reorder level, package weight, descriptions, product tags, returnability,
              featured flag, and SEO metadata are copied to Supabase. Existing storefront approval
              and customer access rules still apply. Zoho catalog updates are reflected in the
              marketplace after a successful sync.
            </p>
            <p>
              Product variants are retained in the imported Zoho source record; marketplace price
              and stock display use the first Zoho variant. Tax is set to 0 until the administrator
              configures the marketplace GST rate in the product editor.
            </p>
            <p>
              General Zoho coupons also sync, appear in customer in-app notifications, and are
              validated again by the server during checkout. Coupon sync runs with this manual sync;
              it is not instant. Product-, customer-, or shipping-restricted coupons are disabled
              because this checkout cannot yet reproduce those eligibility rules. Zoho does not
              expose its coupon “Show in Store” flag through the coupon API, so only create active
              general coupons intended for marketplace customers.
            </p>
            <p>
              The separate admin-only data mirror can read categories, sales orders, tax rules and
              preferences, the authorized account’s store index, and published storefront metadata.
              Sales orders include the customer/order fields Zoho returns, plus shipment-package and
              return/payment status fields where present. This data stays in an admin-only Zoho
              snapshot area; it is not imported into marketplace orders or exposed to shoppers.
            </p>
            <p>
              This is not full Zoho dashboard parity. The published API does not establish safe
              account-wide read access for quotes, every customer, all carts, editable pages/files/
              menus/themes, product filter or recommendation rules, blogs, or native report widgets.
              A shopper cart API is tied to an individual cart ID. The app can calculate summaries
              from synced sales orders, but those are marketplace summaries, not Zoho’s native
              reports. Zoho Payments onboarding does not enable payment collection here.
            </p>
            <p>
              Products removed from Zoho are hidden from the storefront after a complete successful
              catalog read. A failed or incomplete sync leaves the existing marketplace catalog in
              place.
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="Available Zoho data (admin only)">
        <p className="mb-4 text-sm text-slate">
          Reauthorize Zoho after deploying this update so it can grant the additional verified
          read-only scopes. Then select <strong>Sync Zoho account data</strong>. Failed resource
          reads keep the previous complete snapshot available.
        </p>
        {!mirrorStates.length ? (
          <p className="text-sm text-slate">No additional Zoho data has been synced yet.</p>
        ) : (
          <div className="space-y-3">
            {mirrorStates.map((state) => {
              const records = mirrorRecords[state.resource] ?? [];
              return (
                <details key={state.resource} className="rounded-lg border p-4">
                  <summary className="cursor-pointer font-semibold text-navy">
                    {RESOURCE_LABELS[state.resource] ?? state.resource} · {state.record_count}{" "}
                    records · {new Date(state.last_synced_at).toLocaleString()}
                  </summary>
                  {state.record_count > records.length && (
                    <p className="mt-2 text-xs text-slate">
                      Showing {records.length} records here; all {state.record_count} synced records
                      remain in the private mirror.
                    </p>
                  )}
                  {state.last_error && (
                    <p className="mt-3 text-sm text-red-700">Last sync error: {state.last_error}</p>
                  )}
                  <div className="mt-3 space-y-3">
                    {records.map((record) => (
                      <details key={record.external_id} className="rounded-md bg-slate-50 p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          {record.external_id}
                          {state.resource === "sales_orders" && record.payload["customer_name"]
                            ? ` · ${String(record.payload["customer_name"])}`
                            : ""}
                        </summary>
                        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {JSON.stringify(record.payload, null, 2)}
                        </pre>
                      </details>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
        {salesOrders.length > 0 && (
          <div className="mt-5 rounded-lg border bg-slate-50 p-4">
            <h3 className="font-semibold text-navy">Summary from displayed Sales Orders</h3>
            <p className="mt-1 text-sm text-slate">
              This quick total covers the sales-order records currently displayed above. It is not
              an export of Zoho’s native Reports or a complete account-wide report.
            </p>
            <p className="mt-2 text-sm">
              {salesOrders.length} orders ·{" "}
              {Object.entries(totalByCurrency)
                .map(([currency, total]) => `${currency} ${total.toLocaleString()}`)
                .join(" · ")}
            </p>
          </div>
        )}
        <div className="mt-5 border-t pt-4">
          <h3 className="font-semibold text-navy">
            Zoho areas without verified account-wide read access in this integration
          </h3>
          <p className="mt-2 text-sm text-slate">
            Quotes; a global cart list; a full customer directory; standalone shipment/return
            listing; collection administration; Files; editable page bodies, menus, themes, and
            site-builder content; filter/recommendation rules; blogs; native reports; payment
            gateway credentials or payment actions. Zoho exposes some related information inside
            sales-order or public storefront responses, but that does not provide the full admin
            module shown in its dashboard.
          </p>
        </div>
      </Panel>
    </PanelLayout>
  );
}
