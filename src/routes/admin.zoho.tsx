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
  startZohoAuthorization,
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

function ZohoCommerceAdmin() {
  const [connection, setConnection] = useState<Connection>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [region, setRegion] = useState("in");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
  useEffect(() => {
    void reload();
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
  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Zoho Commerce"
      subtitle="Connect Zoho securely and sync its catalog and supported coupons into your storefront"
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
              Orders/sales, marketing campaigns, reports, theme/site-builder components, payment
              options, and other Zoho dashboard settings are not synced. Some product image URLs can
              depend on Zoho’s response and may need separate media handling.
            </p>
            <p>
              Products removed from Zoho are hidden from the storefront after a complete successful
              catalog read. A failed or incomplete sync leaves the existing marketplace catalog in
              place.
            </p>
          </div>
        </Panel>
      </div>
    </PanelLayout>
  );
}
