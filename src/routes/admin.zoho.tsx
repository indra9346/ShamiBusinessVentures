import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Coins,
  ExternalLink,
  FileText,
  Package,
  PackageCheck,
  RefreshCw,
  Search,
  Settings2,
  Shapes,
  Store,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { PanelLayout } from "@/components/panel/PanelLayout";
import { Panel, StatusBadge } from "@/components/panel/widgets";
import { adminNav } from "@/lib/panel-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  getZohoSyncQueueStatus,
  getZohoWriteSyncConfig,
  setZohoWriteSyncConfig,
  processZohoSyncNow,
  queueZohoInitialExport,
  retryZohoSyncJob,
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
type SyncQueueJob = { id: string; entity_type: string; entity_id: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string };

const PAGE_SIZE = 200;
const RESOURCE_LABELS: Record<string, string> = {
  categories: "Categories",
  sales_orders: "Sales orders",
  tax_rules: "Tax rules & preferences",
  store_index: "Zoho stores",
  store_meta: "Published store settings",
};
const RESOURCE_ICONS: Record<string, typeof FileText> = {
  sales_orders: FileText,
  categories: Shapes,
  tax_rules: Coins,
  store_index: Store,
  store_meta: Settings2,
};

function first(payload: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function nestedFirst(payload: Record<string, unknown>, ...keys: string[]): unknown {
  const direct = first(payload, ...keys);
  if (direct !== undefined) return direct;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 5 || value === null || typeof value !== "object") return undefined;
    const entries = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const key of keys) {
      const match = entries.find(
        ([entryKey, candidate]) =>
          entryKey === key && candidate !== null && candidate !== undefined && candidate !== "",
      );
      if (match) return match[1];
    }
    for (const [, child] of entries) {
      const found = visit(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(payload, 0);
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? `${value.length} items` : "None";
  if (typeof value === "object") return "Available";
  return String(value);
}

function prettyDate(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function money(value: unknown, currency: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: typeof currency === "string" && currency.length === 3 ? currency : "INR",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${displayValue(currency)} ${amount.toLocaleString()}`;
  }
}

function recordTitle(resource: string, record: MirrorRecord) {
  const payload = record.payload;
  if (resource === "sales_orders") {
    return displayValue(
      first(payload, "salesorder_number", "order_number", "number", "reference_number") ??
        record.external_id,
    );
  }
  if (resource === "categories")
    return displayValue(first(payload, "name", "category_name") ?? record.external_id);
  if (resource === "tax_rules")
    return displayValue(
      first(payload, "tax_name", "name", "_zoho_resource_type") ?? record.external_id,
    );
  if (resource === "store_index")
    return displayValue(first(payload, "site_title", "store_name", "name") ?? record.external_id);
  return displayValue(nestedFirst(payload, "label", "name", "payment_mode") ?? record.external_id);
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-white/80 px-3 py-2.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-navy">{displayValue(value)}</dd>
    </div>
  );
}

function OrderFields({
  payload,
  externalId,
}: {
  payload: Record<string, unknown>;
  externalId: string;
}) {
  const currency = first(payload, "currency_code", "currency");
  const rawDate = first(payload, "date", "created_time");
  const rawTotal = first(payload, "total", "bcy_total");
  const rawBalance = first(payload, "balance");
  const fields: [string, unknown][] = [
    ["Order number", first(payload, "salesorder_number", "order_number", "number") ?? externalId],
    ["Customer / business", first(payload, "customer_name", "company_name", "contact_name")],
    ["Order date", rawDate ? prettyDate(rawDate) : undefined],
    ["Order status", first(payload, "order_status", "status")],
    ["Payment status", first(payload, "paid_status", "payment_status")],
    ["Order total", rawTotal === undefined ? undefined : money(rawTotal, currency)],
    ["Amount due", rawBalance === undefined ? undefined : money(rawBalance, currency)],
    ["Items quantity", first(payload, "quantity")],
    ["Currency", currency],
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {fields
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([label, value]) => (
          <Field key={label} label={label} value={value} />
        ))}
    </dl>
  );
}

function ResourceFields({
  resource,
  payload,
}: {
  resource: string;
  payload: Record<string, unknown>;
}) {
  let fields: [string, unknown][];
  if (resource === "categories") {
    fields = [
      ["Category name", nestedFirst(payload, "name", "category_name")],
      ["Category ID", nestedFirst(payload, "category_id")],
      ["Parent category", nestedFirst(payload, "parent_category_id")],
      ["Visible in store", nestedFirst(payload, "visibility", "is_visible")],
      ["Shown in menu", nestedFirst(payload, "show_in_menu")],
    ];
  } else if (resource === "tax_rules") {
    fields = [
      ["Tax name", nestedFirst(payload, "tax_name", "name")],
      [
        "Rate",
        nestedFirst(payload, "tax_percentage") === undefined
          ? undefined
          : `${displayValue(nestedFirst(payload, "tax_percentage"))}%`,
      ],
      ["Country", nestedFirst(payload, "country_name", "country_code")],
      ["State", nestedFirst(payload, "state_name", "state")],
      ["Tax exempt", nestedFirst(payload, "is_tax_exempt")],
      ["Setting", nestedFirst(payload, "_zoho_resource_type")],
    ];
  } else if (resource === "store_index") {
    fields = [
      ["Store name", first(payload, "site_title", "store_name")],
      ["Store ID", first(payload, "zsite_id", "site_id", "zsiteid")],
      ["Primary domain", first(payload, "primary_domain")],
      ["Store status", first(payload, "store_enabled")],
      ["Currency", first(payload, "store_currency_code")],
    ];
  } else {
    const rawMethods = nestedFirst(payload, "payment_methods", "offline_payment_methods");
    const methods = Array.isArray(rawMethods)
      ? rawMethods
          .map((method) => {
            if (!method || typeof method !== "object") return "";
            const item = method as Record<string, unknown>;
            const label = first(item, "label", "name");
            const mode = first(item, "payment_mode", "mode");
            return [label, mode].filter(Boolean).map(displayValue).join(" · ");
          })
          .filter(Boolean)
          .join(", ")
      : undefined;
    fields = [
      ["Available payment methods", methods || nestedFirst(payload, "label", "payment_mode")],
      ["Payment mode", nestedFirst(payload, "payment_mode")],
      ["Online payments", nestedFirst(payload, "is_online_payment_configured")],
      ["Offline payments", nestedFirst(payload, "is_offline_payment_configured")],
      ["Store currency", nestedFirst(payload, "store_currency_code")],
    ];
  }
  return (
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {fields.filter(([, value]) => value !== undefined && value !== null && value !== "")
        .length ? (
        fields
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([label, value]) => <Field key={label} label={label} value={value} />)
      ) : (
        <p className="text-sm text-slate sm:col-span-2 xl:col-span-3">
          Zoho did not return these overview fields. Open the complete response below to review the
          available information.
        </p>
      )}
    </dl>
  );
}

function ZohoCommerceAdmin() {
  const [connection, setConnection] = useState<Connection>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [region, setRegion] = useState("in");
  const [busy, setBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mirrorStates, setMirrorStates] = useState<MirrorState[]>([]);
  const [mirrorRecords, setMirrorRecords] = useState<Record<string, MirrorRecord[]>>({});
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [salesOrdersPage, setSalesOrdersPage] = useState(1);
  const [salesOrdersLoading, setSalesOrdersLoading] = useState(false);
  const mirrorRequestId = useRef(0);
  const [selectedResource, setSelectedResource] = useState("sales_orders");
  const [search, setSearch] = useState("");
  const [syncQueue, setSyncQueue] = useState<{ counts: Record<string, number>; jobs: SyncQueueJob[] }>({ counts: {}, jobs: [] });
  const [queueBusy, setQueueBusy] = useState(false);
  const [syncOutboxBusy, setSyncOutboxBusy] = useState(false);
  const [writeSyncEnabled, setWriteSyncEnabled] = useState(true);
  const [writeSyncBusy, setWriteSyncBusy] = useState(false);

  const reload = async () => {
    try {
      const status = await getZohoConnectionStatus();
      setConnection(status as Connection);
      if (status) {
        setOrganizationId(status.organization_id);
        setRegion(status.region);
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Zoho status");
      return false;
    } finally {
      setLoaded(true);
    }
  };
  const reloadMirror = async (page = salesOrdersPage, resource?: string) => {
    const requestId = ++mirrorRequestId.current;
    if (resource === "sales_orders") setSalesOrdersLoading(true);
    try {
      const result = await getZohoCommerceReadMirror({
        data: {
          salesOrdersPage: page,
          ...(resource ? { resource: resource as "categories" | "sales_orders" | "tax_rules" | "store_index" | "store_meta" } : {}),
        },
      });
      if (requestId !== mirrorRequestId.current) return false;
      const returnedOrderState = (result.resources as MirrorState[]).find((item) => item.resource === "sales_orders");
      const lastPage = Math.max(1, Math.ceil((returnedOrderState?.record_count ?? 0) / PAGE_SIZE));
      if (page > lastPage) {
        setSalesOrdersPage(lastPage);
        return await reloadMirror(lastPage, resource);
      }
      if (resource) {
        const receivedStates = result.resources as MirrorState[];
        setMirrorStates((current) => [...current.filter((item) => item.resource !== resource), ...receivedStates]);
        setMirrorRecords((current) => ({ ...current, ...(result.snapshots as Record<string, MirrorRecord[]>) }));
      } else {
        setMirrorStates(result.resources as MirrorState[]);
        setMirrorRecords(result.snapshots as Record<string, MirrorRecord[]>);
      }
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Zoho data mirror");
      return false;
    } finally {
      if (requestId === mirrorRequestId.current) setSalesOrdersLoading(false);
    }
  };
  const reloadQueue = async () => {
    try {
      const queue = await getZohoSyncQueueStatus();
      setSyncQueue(queue as { counts: Record<string, number>; jobs: SyncQueueJob[] });
    } catch {
      // Older deployments may not yet have the queue migration applied.
    }
  };
  const refreshSavedData = async () => {
    setRefreshBusy(true);
    try {
      const [statusLoaded, snapshotLoaded] = await Promise.all([reload(), reloadMirror()]);
      if (statusLoaded && snapshotLoaded) {
        toast.success("Loaded the latest saved Zoho snapshots", {
          description: "To read new changes from Zoho, choose Sync account data.",
        });
      }
    } finally {
      setRefreshBusy(false);
    }
  };
  const toggleWriteSync = async (enabled: boolean) => {
    setWriteSyncBusy(true);
    try {
      await setZohoWriteSyncConfig({ data: { enabled } });
      setWriteSyncEnabled(enabled);
      toast.success(enabled ? "Outbound write sync is active" : "Outbound write sync paused");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update sync configuration");
    } finally {
      setWriteSyncBusy(false);
    }
  };

  const runSyncOutbox = async () => {
    setSyncOutboxBusy(true);
    try {
      const res = await processZohoSyncNow({ data: { limit: 50 } });
      await reloadQueue();
      await reloadMirror();
      if (res.processed === 0) {
        toast.info("No pending jobs to process", {
          description: "All records are up to date in Zoho.",
        });
      } else {
        toast.success(`Processed ${res.processed} records for Zoho`, {
          description: `${res.complete} completed, ${res.failed} failed, ${res.needsReview} needs review.`,
        });
      }
    } catch (error) {
      toast.error("Zoho outbox sync failed", {
        description: error instanceof Error ? error.message : "Verify Zoho authorization scopes and try again",
      });
      await reloadQueue();
    } finally {
      setSyncOutboxBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    void reloadMirror(1);
    void reloadQueue();
    void getZohoWriteSyncConfig()
      .then((cfg) => {
        if (cfg && typeof cfg.enabled === "boolean") setWriteSyncEnabled(cfg.enabled);
      })
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected")) toast.success("Zoho Commerce connected with read and write access");
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
      setSalesOrdersPage(1);
      await reloadMirror(1);
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
  const retryJob = async (id: string) => {
    setQueueBusy(true);
    try {
      await retryZohoSyncJob({ data: { id } });
      await reloadQueue();
      toast.success("Sync job queued for retry");
    } catch (error) {
      toast.error("Could not retry this sync job", { description: error instanceof Error ? error.message : "Try again" });
    } finally {
      setQueueBusy(false);
    }
  };
  const queueInitialExport = async () => {
    setQueueBusy(true);
    try {
      const result = await queueZohoInitialExport();
      await reloadQueue();
      toast.success(`Queued ${result.queued} existing records for Zoho`, {
        description: `${result.customers} contacts, ${result.catalog} catalogue items, and ${result.orders} orders.`,
      });
    } catch (error) {
      toast.error("Could not queue existing records", {
        description: error instanceof Error ? error.message : "Check the production sync migration and try again",
      });
    } finally {
      setQueueBusy(false);
    }
  };

  const statesByResource = useMemo(
    () => Object.fromEntries(mirrorStates.map((item) => [item.resource, item])),
    [mirrorStates],
  );
  const selectedState = statesByResource[selectedResource] as MirrorState | undefined;
  const selectedRecords = mirrorRecords[selectedResource] ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleRecords = normalizedSearch
    ? selectedRecords.filter((record) =>
        `${record.external_id} ${recordTitle(selectedResource, record)} ${JSON.stringify(record.payload)}`
          .toLocaleLowerCase()
          .includes(normalizedSearch),
      )
    : selectedRecords;
  const orderState = statesByResource["sales_orders"] as MirrorState | undefined;
  const totalPages = Math.max(1, Math.ceil((orderState?.record_count ?? 0) / PAGE_SIZE));
  const pageStart = orderState?.record_count ? (salesOrdersPage - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(salesOrdersPage * PAGE_SIZE, orderState?.record_count ?? 0);

  return (
    <PanelLayout
      items={adminNav}
      tone="admin"
      title="Zoho Commerce"
      subtitle="Admin-only Zoho snapshots, refreshed when you sync"
    >
      <div className="space-y-5">
        <Panel className="overflow-hidden">
          <div className="-m-4 bg-gradient-to-r from-navy to-[#17375f] p-5 text-white sm:-m-5 sm:p-6">
            <div className="flex flex-col gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
                  <Store className="h-4 w-4" /> Zoho Commerce connection
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold">
                    {connection?.status === "connected"
                      ? "Your store is connected"
                      : loaded
                        ? "Connect your Zoho store"
                        : "Checking your connection…"}
                  </h2>
                  {connection?.status === "connected" && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-semibold text-emerald-100">
                      <BadgeCheck className="h-4 w-4" /> Connected · Read & Write Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-white/70">
                  {connection
                    ? `Organization ${connection.organization_id} · Zoho ${connection.region.toUpperCase()}`
                    : "Authorize securely using Zoho OAuth. Your Zoho password is never entered here."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || refreshBusy || mirrorBusy}
                  onClick={() => void connect()}
                  className="bg-white text-navy hover:bg-white/90"
                >
                  {connection ? "Reauthorize Zoho" : "Connect Zoho"}
                </Button>
                <Button
                  disabled={busy || refreshBusy || mirrorBusy || !connection}
                  variant="outline"
                  onClick={() => void sync()}
                  className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                >
                  <CloudDownload className={`mr-2 h-4 w-4 ${busy ? "animate-bounce" : ""}`} />
                  {busy ? "Syncing catalog…" : "Sync catalog"}
                </Button>
                <Button
                  disabled={busy || refreshBusy || mirrorBusy || !connection}
                  variant="outline"
                  onClick={() => void syncReadMirror()}
                  className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${mirrorBusy ? "animate-spin" : ""}`} />
                  {mirrorBusy ? "Syncing account data…" : "Sync account data"}
                </Button>
                <Button
                  disabled={busy || refreshBusy || mirrorBusy}
                  variant="ghost"
                  onClick={() => void refreshSavedData()}
                  className="text-white hover:bg-white/10 hover:text-white"
                  title="Reload the last saved snapshot from the database; use either sync button to fetch new data from Zoho."
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${refreshBusy ? "animate-spin" : ""}`} />
                  {refreshBusy ? "Refreshing saved data…" : "Refresh saved data"}
                </Button>
              </div>
              <div className="rounded-md border border-white/20 bg-white/10 p-3 text-xs leading-relaxed text-white/90">
                <span className="font-semibold text-white">Full Two-Way Sync Active:</span> Zoho Commerce & Zoho Inventory write permissions are enabled. If your store was previously connected in read-only mode, click <strong>Reauthorize Zoho</strong> to grant write permissions. Use <strong>Push pending to Zoho</strong> below to write queued records immediately.
              </div>
            </div>
            {connection?.last_error && (
              <p role="alert" className="mt-4 rounded-md bg-red-100 p-3 text-sm text-red-900">
                {connection.last_error}
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Customer, vendor, catalogue & order sync health">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-3xl text-sm leading-relaxed text-slate">
              Approved app catalogue changes, customer and vendor contacts, and orders are queued for Zoho Inventory & Zoho Commerce. Click <strong>Push pending to Zoho</strong> to actively sync queued changes now, or allow them to reconcile on each scheduled run.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={syncOutboxBusy || !connection}
                onClick={() => void runSyncOutbox()}
                className="bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm font-semibold"
                title="Immediately writes all queued customer, vendor, catalog, and order changes to Zoho."
              >
                <UploadCloud className={`mr-1.5 h-4 w-4 ${syncOutboxBusy ? "animate-bounce" : ""}`} />
                {syncOutboxBusy ? "Pushing to Zoho…" : `Push pending to Zoho (${syncQueue.counts["pending"] ?? 0})`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={queueBusy || !connection}
                onClick={() => void queueInitialExport()}
                title="Queues existing local records only. Zoho is contacted when pushed."
              >
                <CloudDownload className="mr-2 h-4 w-4" />
                {queueBusy ? "Queueing existing data…" : "Queue existing data"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void reloadQueue()}>
                <RefreshCw className="mr-2 h-4 w-4" /> Refresh status
              </Button>
            </div>
          </div>
          {Number(syncQueue.counts["pending"] || 0) > 0 && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between text-sm text-amber-950">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-semibold">{syncQueue.counts["pending"]} records are queued for Zoho write</p>
                  <p className="text-xs text-amber-850">
                    Customers, vendors, catalogue items, and sales orders are ready to be written to Zoho Commerce & Inventory.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                disabled={syncOutboxBusy || !connection}
                onClick={() => void runSyncOutbox()}
                className="bg-amber-600 text-white hover:bg-amber-700 text-xs font-semibold shrink-0 shadow-sm"
              >
                <UploadCloud className={`mr-1.5 h-3.5 w-3.5 ${syncOutboxBusy ? "animate-bounce" : ""}`} />
                {syncOutboxBusy ? "Pushing data…" : `Push ${syncQueue.counts["pending"]} records now`}
              </Button>
            </div>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {["pending", "failed", "needs_review", "complete"].map((status) => (
              <div key={status} className="rounded-md border border-border bg-white px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-slate">{status.replace("_", " ")}</p>
                <p className="mt-1 text-xl font-semibold text-navy">{syncQueue.counts[status] ?? 0}</p>
              </div>
            ))}
          </div>
          {syncQueue.jobs.length ? (
            <div className="divide-y divide-border rounded-md border border-border">
              {syncQueue.jobs.map((job) => (
                <div key={job.id} className="flex flex-col justify-between gap-3 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-navy">
                      <span className="capitalize">{job.entity_type}</span>
                      <code className="text-xs text-slate">{job.entity_id}</code>
                      <StatusBadge status={job.status.replace("_", " ")} />
                      <span className="text-xs text-slate">attempt {job.attempts}</span>
                    </div>
                    {job.last_error && <p className="mt-1 text-sm text-amber-900">{job.last_error}</p>}
                    <p className="mt-1 text-xs text-slate">Updated {new Date(job.updated_at).toLocaleString()}</p>
                  </div>
                  {["failed", "needs_review"].includes(job.status) && (
                    <Button size="sm" variant="outline" disabled={queueBusy} onClick={() => void retryJob(job.id)}>
                      Retry after review
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-slate">No customer, vendor, catalogue, or order sync jobs are recorded yet. Queue details appear after the production migration is applied.</p>
          )}
        </Panel>

        <section
          aria-label="Zoho data overview"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        >
          {[
            { key: "sales_orders", label: "Sales orders", icon: FileText },
            { key: "categories", label: "Categories", icon: Shapes },
            { key: "tax_rules", label: "Tax records", icon: Coins },
            { key: "store_index", label: "Zoho stores", icon: Store },
            { key: "store_meta", label: "Store settings", icon: Settings2 },
          ].map(({ key, label, icon: Icon }) => {
            const state = statesByResource[key] as MirrorState | undefined;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedResource(key);
                  setSearch("");
                }}
                className={`rounded-lg border bg-card p-4 text-left shadow-card transition hover:border-gold/60 hover:shadow-md ${selectedResource === key ? "border-gold ring-1 ring-gold/30" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate">
                    {label}
                  </span>
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-navy/5 text-navy">
                    <Icon className="h-4 w-4" />
                  </span>
                </div>
                <p className="mt-3 text-2xl font-bold text-navy">
                  {state ? state.record_count.toLocaleString() : "Not synced"}
                </p>
                <p className="mt-1 text-xs text-slate">
                  {state
                    ? `Updated ${new Date(state.last_synced_at).toLocaleString()}`
                    : "Not synced yet"}
                </p>
              </button>
            );
          })}
        </section>

        <Panel title="Synced Zoho data">
          <p className="mb-4 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2.5 text-sm leading-relaxed text-slate">
            This page shows the last data saved in ShamiBusiness from Zoho. It is not a live view;
            use <strong>Sync account data</strong> to request a fresh read from Zoho, or{" "}
            <strong>Refresh saved data</strong> to reload what is already stored.
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-4">
            {Object.entries(RESOURCE_LABELS).map(([key, label]) => {
              const Icon = RESOURCE_ICONS[key] ?? FileText;
              const active = selectedResource === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setSelectedResource(key);
                    setSearch("");
                  }}
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-navy text-white" : "text-slate hover:bg-navy/5 hover:text-navy"}`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${active ? "bg-white/15 text-white" : "bg-slate-100 text-slate"}`}
                  >
                    {(statesByResource[key] as MirrorState | undefined)?.record_count ?? 0}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedState ? (
            <>
              <div className="mb-4 flex flex-col gap-3 rounded-lg bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-semibold text-navy">
                    {RESOURCE_LABELS[selectedResource]} from Zoho
                  </h3>
                  <p className="mt-1 text-sm text-slate">
                    {selectedState.record_count.toLocaleString()} records · Last updated{" "}
                    {new Date(selectedState.last_synced_at).toLocaleString()}
                  </p>
                </div>
                {selectedState.last_error && (
                  <p className="inline-flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    Most recent sync reported an issue; the last complete data is shown.
                  </p>
                )}
                <div className="relative w-full sm:max-w-xs">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={`Search ${(RESOURCE_LABELS[selectedResource] ?? "records").toLocaleLowerCase()}`}
                    className="pl-9"
                    aria-label={`Search ${RESOURCE_LABELS[selectedResource] ?? "records"}`}
                  />
                </div>
              </div>
              {selectedResource === "sales_orders" && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate">
                  <span>
                    Showing {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
                    {orderState?.record_count.toLocaleString()} sales orders
                    {normalizedSearch ? " · search applies to this page" : ""}
                  </span>
                  <span>These are Zoho records. They do not create ShamiBusiness orders.</span>
                </div>
              )}
              {visibleRecords.length ? (
                selectedResource === "sales_orders" ? (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <div className="hidden grid-cols-[1.05fr_1.3fr_.8fr_.8fr_.8fr_.9fr] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-slate lg:grid">
                      <span>Order</span>
                      <span>Customer / business</span>
                      <span>Date</span>
                      <span>Payment</span>
                      <span>Status</span>
                      <span className="text-right">Total</span>
                    </div>
                    <div className="divide-y divide-border">
                      {visibleRecords.map((record) => {
                        const p = record.payload;
                        const orderNumber = recordTitle(selectedResource, record);
                        const customer = first(p, "customer_name", "company_name", "contact_name");
                        const orderStatus = first(p, "order_status", "status");
                        const paymentStatus = first(p, "paid_status", "payment_status");
                        const date = first(p, "date", "created_time");
                        return (
                          <details
                            key={record.external_id}
                            className="group bg-white open:bg-slate-50/60"
                          >
                            <summary className="grid cursor-pointer list-none grid-cols-1 items-center gap-2 px-4 py-3.5 transition hover:bg-slate-50 lg:grid-cols-[1.05fr_1.3fr_.8fr_.8fr_.8fr_.9fr] lg:gap-3">
                              <span className="flex items-center gap-2 font-semibold text-navy">
                                <ChevronRight className="h-4 w-4 shrink-0 text-slate transition-transform group-open:rotate-90" />
                                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-navy/5 text-navy">
                                  <FileText className="h-4 w-4" />
                                </span>
                                {orderNumber}
                              </span>
                              <span className="text-sm text-slate">{displayValue(customer)}</span>
                              <span className="text-sm text-slate lg:text-charcoal">
                                {prettyDate(date)}
                              </span>
                              <span className="text-sm text-slate lg:text-charcoal">
                                {displayValue(paymentStatus)}
                              </span>
                              <span>
                                {orderStatus ? (
                                  <StatusBadge status={displayValue(orderStatus)} />
                                ) : (
                                  "—"
                                )}
                              </span>
                              <span className="text-left text-sm font-semibold text-navy lg:text-right">
                                {money(
                                  first(p, "total", "bcy_total"),
                                  first(p, "currency_code", "currency"),
                                )}
                              </span>
                            </summary>
                            <div className="space-y-3 border-t border-border px-4 py-4">
                              <OrderFields payload={p} externalId={record.external_id} />
                              <details className="rounded-md border border-border bg-white">
                                <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-slate">
                                  View complete Zoho response
                                </summary>
                                <pre className="max-h-80 overflow-auto border-t border-border bg-slate-50 p-3 text-xs leading-relaxed text-charcoal">
                                  {JSON.stringify(p, null, 2)}
                                </pre>
                              </details>
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {visibleRecords.map((record) => (
                      <article
                        key={record.external_id}
                        className="rounded-lg border border-border bg-white p-4"
                      >
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <h4 className="font-semibold text-navy">
                              {recordTitle(selectedResource, record)}
                            </h4>
                            <p className="mt-1 text-xs text-slate">
                              Zoho reference: {record.external_id}
                            </p>
                          </div>
                          <span className="grid h-9 w-9 place-items-center rounded-lg bg-navy/5 text-navy">
                            {(() => {
                              const Icon = RESOURCE_ICONS[selectedResource] ?? FileText;
                              return <Icon className="h-4 w-4" />;
                            })()}
                          </span>
                        </div>
                        <ResourceFields resource={selectedResource} payload={record.payload} />
                        <details className="mt-3 rounded-md border border-border bg-white">
                          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-slate">
                            View complete Zoho response
                          </summary>
                          <pre className="max-h-72 overflow-auto border-t border-border bg-slate-50 p-3 text-xs leading-relaxed text-charcoal">
                            {JSON.stringify(record.payload, null, 2)}
                          </pre>
                        </details>
                      </article>
                    ))}
                  </div>
                )
              ) : (
                <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
                  <Boxes className="mx-auto h-8 w-8 text-slate/50" />
                  <p className="mt-3 font-medium text-navy">
                    {normalizedSearch ? "No matching records on this page" : "No records available"}
                  </p>
                  <p className="mt-1 text-sm text-slate">
                    {normalizedSearch
                      ? "Clear the search or try a different term."
                      : "Sync account data from Zoho to populate this section."}
                  </p>
                </div>
              )}

              {selectedResource === "sales_orders" && orderState && totalPages > 1 && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <p className="text-sm text-slate">
                    Page {salesOrdersPage} of {totalPages}{" "}
                    <span className="text-slate/70">· 200 orders per page</span>
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={salesOrdersPage <= 1 || salesOrdersLoading}
                      onClick={() => {
                        const page = salesOrdersPage - 1;
                        void reloadMirror(page, "sales_orders").then((loadedPage) => {
                          if (loadedPage) setSalesOrdersPage(page);
                        });
                      }}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      {salesOrdersLoading ? "Loading…" : "Previous"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={salesOrdersPage >= totalPages || salesOrdersLoading}
                      onClick={() => {
                        const page = salesOrdersPage + 1;
                        void reloadMirror(page, "sales_orders").then((loadedPage) => {
                          if (loadedPage) setSalesOrdersPage(page);
                        });
                      }}
                    >
                      {salesOrdersLoading ? "Loading…" : "Next"}
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center">
              <CloudDownload className="mx-auto h-8 w-8 text-slate/50" />
              <p className="mt-3 font-medium text-navy">No account data synced yet</p>
              <p className="mt-1 text-sm text-slate">
                Connect Zoho, then choose “Sync account data” to read the supported information.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="About this connection">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-navy">Two-way active synchronization</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  Approved products, customer profiles, vendor contacts, and sales orders are actively written to Zoho Inventory and Zoho Commerce.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700">
                <PackageCheck className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-navy">Live outbox processing</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  Outbound writes can be pushed instantly using &quot;Push pending to Zoho&quot; or automatically processed by the background sync worker.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700">
                <RefreshCw className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-navy">Fulfillment & contact reconciliation</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  Zoho shipment milestones (dispatched, delivered) and non-conflicting profile edits reconcile back automatically into Grain Bazar.
                </p>
              </div>
            </div>
          </div>
          <details className="mt-5 rounded-lg border border-border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-navy">
              What is not available in this integration?
            </summary>
            <p className="border-t border-border px-4 py-3 text-sm leading-relaxed text-slate">
              Zoho’s documented scopes used here do not provide account-wide access to quotes, all
              customers, all carts, editable pages or themes, files, menus, blogs, native reports,
              or payment gateway actions. These areas are not represented as synced data.{" "}
              <a
                href="https://www.zoho.com/commerce/api/"
                target="_blank"
                rel="noreferrer"
                className="ml-1 inline-flex items-center gap-1 font-medium text-blue-700 hover:underline"
              >
                Zoho Commerce API documentation <ExternalLink className="h-3 w-3" />
              </a>
            </p>
          </details>
        </Panel>
      </div>
    </PanelLayout>
  );
}
