import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  Boxes,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Coins,
  ExternalLink,
  FileText,
  Info,
  Package,
  PackageCheck,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Shapes,
  Store,
  Trash2,
  UploadCloud,
  Users,
  XCircle,
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
  retryAllZohoSyncJobs,
  dismissZohoSyncJob,
  dismissAllQuotaFailedJobs,
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
type SyncQueueJob = {
  id: string;
  entity_type: string;
  entity_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  entity_details?: {
    title: string;
    subtitle?: string | undefined;
    meta?: string | undefined;
    link?: string | undefined;
    gstin?: string | null | undefined;
  } | null | undefined;
};
type ZohoOrderView = {
  id: string;
  name: string;
  field: "status" | "payment" | "customer" | "order" | "balance";
  comparator: "is" | "is_not" | "contains" | "gt";
  value: string;
};
type ZohoOrderCustomer = {
  key: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  orders: number;
  spend: number;
  currency: string;
  lastOrder: string;
  address: string;
};

const ORDER_VIEWS_STORAGE_KEY = "shamibusiness.zoho-order-views.v1";

function orderFieldValue(record: MirrorRecord, field: ZohoOrderView["field"]): string {
  const p = record.payload;
  const value = field === "status"
    ? first(p, "order_status", "status")
    : field === "payment"
      ? first(p, "paid_status", "payment_status", "payment")
      : field === "customer"
        ? first(p, "customer_name", "company_name", "contact_name")
        : field === "balance"
          ? first(p, "balance", "amount_due", "balance_due")
          : first(p, "salesorder_number", "order_number", "number", "reference_number") ?? record.external_id;
  return displayValue(value).toLocaleLowerCase();
}

function orderMatchesView(record: MirrorRecord, view: ZohoOrderView) {
  const actual = orderFieldValue(record, view.field);
  const expected = view.value.trim().toLocaleLowerCase();
  if (!expected) return true;
  if (view.comparator === "gt") {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);
    return Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) && actualNumber > expectedNumber;
  }
  if (view.comparator === "contains") return actual.includes(expected);
  if (view.comparator === "is_not") return actual !== expected;
  return actual === expected;
}

const PAGE_SIZE = 200;
const RESOURCE_LABELS: Record<string, string> = {
  categories: "Categories",
  sales_orders: "Sales orders",
  tax_rules: "Tax rules & preferences",
  store_index: "Zoho stores",
  store_meta: "Published store settings",
  customers_from_orders: "Customers from orders",
};
const RESOURCE_ICONS: Record<string, typeof FileText> = {
  sales_orders: FileText,
  categories: Shapes,
  tax_rules: Coins,
  store_index: Store,
  store_meta: Settings2,
  customers_from_orders: Users,
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

function orderTimestamp(value: unknown) {
  if (typeof value !== "string" || !value) return 0;
  const localDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timestamp = localDate
    ? Date.UTC(Number(localDate[3]), Number(localDate[2]) - 1, Number(localDate[1]))
    : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
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

function zohoCommerceBase(region: string) {
  const host: Record<string, string> = {
    com: "commerce.zoho.com",
    eu: "commerce.zoho.eu",
    in: "commerce.zoho.in",
    com_au: "commerce.zoho.com.au",
    jp: "commerce.zoho.jp",
    ca: "commerce.zoho.ca",
  };
  return `https://${host[region] ?? host["in"]}`;
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
  const amountFields: [string, unknown][] = [
    ["Subtotal", first(payload, "sub_total", "subtotal")],
    ["Tax total", first(payload, "tax_total", "tax_amount")],
    ["Discount", first(payload, "discount_amount", "discount")],
    ["Shipping", first(payload, "shipping_charge", "shipping_amount")],
    ["Amount paid", first(payload, "paid_amount", "amount_paid")],
  ].map(([label, value]) => [label, value === undefined ? undefined : money(value, currency)] as [string, unknown]);
  const fields: [string, unknown][] = [
    ["Order number", first(payload, "salesorder_number", "order_number", "number") ?? externalId],
    ["Customer / business", first(payload, "customer_name", "company_name", "contact_name")],
    ["Order date", rawDate ? prettyDate(rawDate) : undefined],
    ["Order status", first(payload, "order_status", "status")],
    ["Payment status", first(payload, "paid_status", "payment_status")],
    ["Fulfillment status", first(payload, "shipment_status", "shipped_status", "package_status")],
    ["Refund status", first(payload, "refund_status", "refund_state")],
    ["Order total", rawTotal === undefined ? undefined : money(rawTotal, currency)],
    ["Amount due", rawBalance === undefined ? undefined : money(rawBalance, currency)],
    ["Items quantity", first(payload, "quantity")],
    ["Reference", first(payload, "reference_number", "reference", "purchaseorder_number")],
    ["Currency", currency],
    ...amountFields,
  ];
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {fields
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([label, value]) => (
            <Field key={label} label={label} value={value} />
          ))}
      </dl>
      <OrderContactDetails payload={payload} />
      <OrderLineItems payload={payload} />
    </div>
  );
}

function OrderContactDetails({ payload }: { payload: Record<string, unknown> }) {
  const customer = first(payload, "customer_name", "contact_name", "company_name");
  const email = first(payload, "email", "customer_email", "contact_email");
  const phone = first(payload, "phone", "phone_number", "customer_phone");
  const billing = first(payload, "billing_address", "billing_address_info");
  const shipping = first(payload, "shipping_address", "shipping_address_info");
  const addressText = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const address = value as Record<string, unknown>;
    return ["attention", "address", "street", "street2", "city", "state", "zip", "zip_code", "country"]
      .map((key) => address[key])
      .filter((part) => part !== undefined && part !== null && part !== "")
      .map(String)
      .join(", ");
  };
  const fields: [string, unknown][] = [
    ["Customer / business", customer],
    ["Email", email],
    ["Phone", phone],
    ["Billing address", addressText(billing)],
    ["Shipping address", addressText(shipping)],
  ];
  const visible = fields.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length) return null;
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate">Customer and delivery</h4>
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map(([label, value]) => <Field key={label} label={label} value={value} />)}
      </dl>
      <p className="mt-2 text-xs text-slate">Contact details are shown only when included in this Zoho order snapshot.</p>
    </section>
  );
}

function OrderLineItems({ payload }: { payload: Record<string, unknown> }) {
  const raw = first(payload, "line_items", "items");
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rows = raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!rows.length) return null;
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate">Items ({rows.length})</h4>
      <div className="overflow-x-auto rounded-md border border-border bg-white">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate">
            <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Amount</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((item, index) => (
              <tr key={String(first(item, "line_item_id", "item_id", "sku") ?? index)}>
                <td className="px-3 py-2 font-medium text-navy">
                  <span className="flex items-center gap-2">
                    {typeof first(item, "image_url", "item_image_url", "image") === "string" && (
                      <img
                        src={String(first(item, "image_url", "item_image_url", "image"))}
                        alt=""
                        loading="lazy"
                        className="h-9 w-9 shrink-0 rounded border border-border object-cover"
                      />
                    )}
                    {displayValue(first(item, "name", "item_name", "description"))}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate">{displayValue(first(item, "sku", "item_sku"))}</td>
                <td className="px-3 py-2 text-right">{displayValue(first(item, "quantity", "qty"))}</td>
                <td className="px-3 py-2 text-right">{money(first(item, "rate", "item_rate"), first(payload, "currency_code", "currency"))}</td>
                <td className="px-3 py-2 text-right font-medium">{money(first(item, "item_total", "total", "amount"), first(payload, "currency_code", "currency"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const [orderStatusFilter, setOrderStatusFilter] = useState("all");
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [orderViews, setOrderViews] = useState<ZohoOrderView[]>([]);
  const [activeOrderViewId, setActiveOrderViewId] = useState("all");
  const [newViewOpen, setNewViewOpen] = useState(false);
  const [draftViewName, setDraftViewName] = useState("");
  const [draftViewField, setDraftViewField] = useState<ZohoOrderView["field"]>("status");
  const [draftViewComparator, setDraftViewComparator] = useState<ZohoOrderView["comparator"]>("is");
  const [draftViewValue, setDraftViewValue] = useState("");
  const [syncQueue, setSyncQueue] = useState<{ counts: Record<string, number>; jobs: SyncQueueJob[] }>({ counts: {}, jobs: [] });
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueRefreshBusy, setQueueRefreshBusy] = useState(false);
  const [queueRefreshedAt, setQueueRefreshedAt] = useState<string | null>(null);
  const [syncOutboxBusy, setSyncOutboxBusy] = useState(false);
  const [writeSyncEnabled, setWriteSyncEnabled] = useState(true);
  const [writeSyncBusy, setWriteSyncBusy] = useState(false);

  const quotaFailedJobs = useMemo(() => {
    return syncQueue.jobs.filter((j) => {
      const err = (j.last_error ?? "").toLowerCase();
      return (
        (j.status === "failed" || j.status === "needs_review") &&
        (err.includes("used up your available sales orders") ||
          err.includes("create more orders") ||
          err.includes("quota reached") ||
          err.includes("monthly limit"))
      );
    });
  }, [syncQueue.jobs]);

  const gstFailedJobs = useMemo(() => {
    return syncQueue.jobs.filter((j) => {
      const err = (j.last_error ?? "").toLowerCase();
      return (
        (j.status === "failed" || j.status === "needs_review") &&
        err.includes("gst_no")
      );
    });
  }, [syncQueue.jobs]);

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
  const reloadQueue = async (reportError = false) => {
    try {
      const queue = await getZohoSyncQueueStatus();
      setSyncQueue(queue as { counts: Record<string, number>; jobs: SyncQueueJob[] });
      setQueueRefreshedAt((queue as { refreshedAt?: string }).refreshedAt ?? new Date().toISOString());
      return true;
    } catch (error) {
      // Older deployments may not yet have the queue migration applied.
      if (reportError) {
        toast.error("Could not refresh Zoho sync status", {
          description: error instanceof Error ? error.message : "Check the connection and try again",
        });
      }
      return false;
    }
  };
  const refreshQueueStatus = async () => {
    setQueueRefreshBusy(true);
    try {
      const refreshed = await reloadQueue(true);
      if (refreshed) toast.success("Zoho sync status refreshed");
    } finally {
      setQueueRefreshBusy(false);
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
    try {
      const saved = localStorage.getItem(ORDER_VIEWS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setOrderViews(parsed.filter((item): item is ZohoOrderView =>
          !!item && typeof item.id === "string" && typeof item.name === "string" &&
          ["status", "payment", "customer", "order", "balance"].includes(item.field) &&
          ["is", "is_not", "contains", "gt"].includes(item.comparator) && typeof item.value === "string",
        ));
      }
    } catch {
      // Ignore malformed browser-local view preferences and leave the shared Zoho data untouched.
    }
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
  const retryAllFailed = async () => {
    setQueueBusy(true);
    try {
      const res = await retryAllZohoSyncJobs();
      await reloadQueue();
      toast.success(`Queued ${res.retried} records for retry`, {
        description: "Click 'Push pending to Zoho' to write them to Zoho now.",
      });
    } catch (error) {
      toast.error("Could not retry failed sync jobs", {
        description: error instanceof Error ? error.message : "Try again",
      });
    } finally {
      setQueueBusy(false);
    }
  };
  const dismissJob = async (id: string, reason?: string) => {
    setQueueBusy(true);
    try {
      await dismissZohoSyncJob({ data: { id, reason } });
      await reloadQueue();
      toast.success("Job dismissed from Zoho sync queue");
    } catch (error) {
      toast.error("Could not dismiss sync job", {
        description: error instanceof Error ? error.message : "Try again",
      });
    } finally {
      setQueueBusy(false);
    }
  };
  const dismissQuotaJobs = async () => {
    setQueueBusy(true);
    try {
      const res = await dismissAllQuotaFailedJobs();
      await reloadQueue();
      toast.success(`Dismissed ${res.dismissed} quota-blocked orders from sync queue`);
    } catch (error) {
      toast.error("Could not dismiss quota-blocked orders", {
        description: error instanceof Error ? error.message : "Try again",
      });
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
  const orderSourceRecords = useMemo(
    () => [...(mirrorRecords["sales_orders"] ?? [])].sort((a, b) =>
      orderTimestamp(first(b.payload, "date", "created_time")) - orderTimestamp(first(a.payload, "date", "created_time")),
    ),
    [mirrorRecords["sales_orders"]],
  );
  const customersFromOrders = useMemo(() => {
    const grouped = new Map<string, ZohoOrderCustomer>();
    for (const record of orderSourceRecords) {
      const p = record.payload;
      const name = displayValue(first(p, "customer_name", "contact_name", "company_name"));
      const email = displayValue(first(p, "customer_email", "email", "contact_email"));
      const phone = displayValue(first(p, "phone", "phone_number", "customer_phone", "mobile"));
      const id = displayValue(first(p, "customer_id", "contact_id"));
      const key = (id !== "—" ? id : email !== "—" ? email : name).toLocaleLowerCase();
      if (!key || key === "—") continue;
      const existing = grouped.get(key);
      const rawAmount = Number(first(p, "total", "bcy_total"));
      const amount = Number.isFinite(rawAmount) ? rawAmount : Number.NaN;
      const rawDate = first(p, "date", "created_time");
      const date = typeof rawDate === "string" ? rawDate : "";
      const address = first(p, "shipping_address", "billing_address");
      const addressText = address && typeof address === "object" && !Array.isArray(address)
        ? ["attention", "address", "street", "street2", "city", "state", "zip", "zip_code", "country"]
            .map((key) => (address as Record<string, unknown>)[key])
            .filter((part) => typeof part === "string" && part.trim())
            .join(", ")
        : "";
      const currency = String(first(p, "currency_code", "currency") ?? "INR").toUpperCase();
      if (existing) {
        existing.orders += 1;
        if (existing.currency === currency && Number.isFinite(existing.spend) && Number.isFinite(amount)) existing.spend += amount;
        else if (existing.currency === currency) existing.spend = Number.NaN;
        else { existing.currency = "MIXED"; existing.spend = Number.NaN; }
        if (email !== "—") existing.email = email;
        if (phone !== "—") existing.phone = phone;
        if (date && (!existing.lastOrder || new Date(date).getTime() > new Date(existing.lastOrder).getTime())) existing.lastOrder = date;
        if (addressText) existing.address = addressText;
      } else {
        grouped.set(key, {
          key, name, email, phone,
          company: displayValue(first(p, "company_name")),
          orders: 1, spend: amount, currency, lastOrder: date, address: addressText,
        });
      }
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [orderSourceRecords]);
  const selectedState = (selectedResource === "customers_from_orders"
    ? statesByResource["sales_orders"]
    : statesByResource[selectedResource]) as MirrorState | undefined;
  const selectedRecords = selectedResource === "customers_from_orders" || selectedResource === "sales_orders"
    ? orderSourceRecords
    : mirrorRecords[selectedResource] ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const activeOrderView = orderViews.find((view) => view.id === activeOrderViewId);
  const matchingRecords = normalizedSearch
    ? selectedRecords.filter((record) =>
        `${record.external_id} ${recordTitle(selectedResource, record)} ${JSON.stringify(record.payload)}`
          .toLocaleLowerCase()
          .includes(normalizedSearch),
      )
    : selectedRecords;
  const filteredOrderRecords = selectedResource === "sales_orders"
    ? matchingRecords.filter((record) => {
        const statusMatches = orderStatusFilter === "all" ||
          displayValue(first(record.payload, "order_status", "status")).toLocaleLowerCase() === orderStatusFilter.toLocaleLowerCase();
        const balance = Number(first(record.payload, "balance", "amount_due", "balance_due"));
        const isOutstanding = Number.isFinite(balance) && balance > 0;
        return statusMatches && (!outstandingOnly || isOutstanding) && (!activeOrderView || orderMatchesView(record, activeOrderView));
      })
    : matchingRecords;
  const orderStatuses = [...new Set(selectedRecords.map((record) =>
    displayValue(first(record.payload, "order_status", "status")),
  ).filter((status) => status !== "—"))].sort((a, b) => a.localeCompare(b));
  const orderState = statesByResource["sales_orders"] as MirrorState | undefined;
  const totalPages = Math.max(1, Math.ceil((filteredOrderRecords.length) / PAGE_SIZE));
  const pageStart = filteredOrderRecords.length ? (salesOrdersPage - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(salesOrdersPage * PAGE_SIZE, filteredOrderRecords.length);
  const visibleRecords = selectedResource === "sales_orders"
    ? filteredOrderRecords.slice((salesOrdersPage - 1) * PAGE_SIZE, salesOrdersPage * PAGE_SIZE)
    : matchingRecords;
  const visibleCustomers = normalizedSearch
    ? customersFromOrders.filter((customer) =>
        `${customer.name} ${customer.company} ${customer.email} ${customer.phone} ${customer.address}`
          .toLocaleLowerCase().includes(normalizedSearch),
      )
    : customersFromOrders;
  const hasVisibleRecords = selectedResource === "customers_from_orders"
    ? visibleCustomers.length > 0
    : visibleRecords.length > 0;

  const saveOrderView = () => {
    const name = draftViewName.trim();
    const value = draftViewValue.trim();
    if (!name || !value) {
      toast.error("Enter a view name and a criterion value");
      return;
    }
    const view: ZohoOrderView = {
      id: crypto.randomUUID(), name, field: draftViewField,
      comparator: draftViewComparator, value,
    };
    const next = [...orderViews, view];
    setOrderViews(next);
    setActiveOrderViewId(view.id);
    setSalesOrdersPage(1);
    setSearch("");
    setNewViewOpen(false);
    setDraftViewName("");
    setDraftViewValue("");
    try {
      localStorage.setItem(ORDER_VIEWS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      toast.error("Could not save this view in this browser");
    }
  };

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
                <span className="font-semibold text-white">Zoho read and write access is enabled.</span> “Sync account data” imports a read-only snapshot from Zoho; “Refresh saved data” reloads that snapshot only. ShamiBusiness changes are queued and sent immediately by “Push pending to Zoho” or by the background worker once daily at 03:00 UTC on this Vercel Hobby plan. Account snapshots still refresh when you request a read sync.
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
              Approved app catalogue changes, customer and vendor contacts, and orders are queued for Zoho Inventory & Zoho Commerce. Click <strong>Push pending to Zoho</strong> to send queued changes immediately. Otherwise, this Vercel Hobby project checks queued changes daily at 03:00 UTC. To import changes made inside Zoho, click <strong>Sync account data</strong> here.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || refreshBusy || mirrorBusy || !connection}
                onClick={() => void syncReadMirror()}
                title="Fetch the latest supported records from Zoho into this website's read-only snapshot."
              >
                <RefreshCw className={`mr-1.5 h-4 w-4 ${mirrorBusy ? "animate-spin" : ""}`} />
                {mirrorBusy ? "Syncing account data…" : "Sync account data"}
              </Button>
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
              {Number(syncQueue.counts["failed"] || 0) > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={queueBusy || !connection}
                  onClick={() => void retryAllFailed()}
                  className="border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 font-semibold"
                  title="Requeues all failed records so they can be written to Zoho with your active write permissions."
                >
                  <RotateCw className={`mr-1.5 h-4 w-4 ${queueBusy ? "animate-spin" : ""}`} />
                  {queueBusy ? "Requeueing…" : `Retry all failed (${syncQueue.counts["failed"]})`}
                </Button>
              )}
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
              <Button
                variant="outline"
                size="sm"
                disabled={queueRefreshBusy}
                onClick={() => void refreshQueueStatus()}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${queueRefreshBusy ? "animate-spin" : ""}`} />
                {queueRefreshBusy ? "Refreshing status…" : "Refresh status"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate" role="status" aria-live="polite">
              {queueRefreshBusy
                ? "Checking the latest sync queue status…"
                : queueRefreshedAt
                  ? `Last checked ${new Date(queueRefreshedAt).toLocaleTimeString()}`
                  : "Refresh status to check the latest sync queue."}
            </p>
          </div>
          {quotaFailedJobs.length > 0 && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-start sm:justify-between text-sm text-amber-950">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
                <div>
                  <p className="font-semibold">Zoho Sales Order Monthly Limit Reached ({quotaFailedJobs.length} orders blocked)</p>
                  <p className="mt-1 text-xs text-amber-900 leading-relaxed">
                    Zoho Inventory&apos;s free plan includes a quota of 50 sales orders per month. These orders cannot be written to Zoho until your Zoho subscription is upgraded or the monthly quota resets on the 1st of next month. You can dismiss them from the queue so they no longer block your sync status.
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <a
                  href="https://www.zoho.com/inventory/pricing.html"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 shadow-sm"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Upgrade Zoho Plan
                </a>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={queueBusy}
                  onClick={() => void dismissQuotaJobs()}
                  className="border-amber-400 bg-amber-100 text-amber-950 hover:bg-amber-200 text-xs font-semibold"
                >
                  <XCircle className="mr-1.5 h-3.5 w-3.5" /> Dismiss {quotaFailedJobs.length} blocked order{quotaFailedJobs.length > 1 ? "s" : ""}
                </Button>
              </div>
            </div>
          )}

          {gstFailedJobs.length > 0 && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-blue-300 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between text-sm text-blue-950">
              <div className="flex items-center gap-2.5">
                <Info className="h-5 w-5 shrink-0 text-blue-600" />
                <div>
                  <p className="font-semibold">GSTIN Auto-Sanitization Enabled ({gstFailedJobs.length} records ready)</p>
                  <p className="text-xs text-blue-800">
                    The integration now automatically validates Indian GSTIN formats, treats unverified or retail consumer numbers safely, and preserves customer inputs in order notes so Zoho write will succeed. Click Retry all failed to push them.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                disabled={queueBusy || !connection}
                onClick={() => void retryAllFailed()}
                className="bg-blue-600 text-white hover:bg-blue-700 text-xs font-semibold shrink-0 shadow-sm"
              >
                <RotateCw className={`mr-1.5 h-3.5 w-3.5 ${queueBusy ? "animate-spin" : ""}`} />
                {queueBusy ? "Requeueing…" : `Retry ${gstFailedJobs.length} GST record${gstFailedJobs.length > 1 ? "s" : ""}`}
              </Button>
            </div>
          )}

          {Number(syncQueue.counts["failed"] || 0) > 0 && quotaFailedJobs.length === 0 && gstFailedJobs.length === 0 && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 sm:flex-row sm:items-center sm:justify-between text-sm text-rose-950">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-5 w-5 shrink-0 text-rose-600" />
                <div>
                  <p className="font-semibold">{syncQueue.counts["failed"]} records failed to sync</p>
                  <p className="text-xs text-rose-800">
                    Review each failed record details below, or click Retry all failed to requeue and push them to Zoho.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                disabled={queueBusy || !connection}
                onClick={() => void retryAllFailed()}
                className="bg-rose-600 text-white hover:bg-rose-700 text-xs font-semibold shrink-0 shadow-sm"
              >
                <RotateCw className={`mr-1.5 h-3.5 w-3.5 ${queueBusy ? "animate-spin" : ""}`} />
                {queueBusy ? "Requeueing…" : `Retry all ${syncQueue.counts["failed"]} records`}
              </Button>
            </div>
          )}

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

          <details className="mb-4 rounded-md border border-border bg-slate-50/70 p-3 text-xs leading-relaxed text-slate">
            <summary className="cursor-pointer font-semibold text-navy flex items-center gap-1.5">
              <Info className="h-4 w-4 text-gold shrink-0" />
              How do records enter this Zoho Sync Queue?
            </summary>
            <div className="mt-2.5 space-y-1.5 pl-5 border-l-2 border-gold/40 text-charcoal">
              <p><strong>Approved Catalogue:</strong> Added automatically when products are approved or updated in Grain Bazar.</p>
              <p><strong>Customers & Vendors:</strong> Added automatically when accounts are registered or address/business details change.</p>
              <p><strong>Orders:</strong> Added automatically when customers place orders or when order quantities/status are updated.</p>
              <p><strong>Historical Sync:</strong> Clicking <em>&ldquo;Queue existing data&rdquo;</em> scans all past local records and queues any not yet synced to Zoho.</p>
            </div>
          </details>

          {syncQueue.jobs.length ? (
            <div className="divide-y divide-border rounded-md border border-border bg-white shadow-xs">
              {syncQueue.jobs.map((job) => {
                const isQuotaError = (job.last_error ?? "").toLowerCase().includes("used up your available sales orders") ||
                  (job.last_error ?? "").toLowerCase().includes("create more orders");
                const isGstError = (job.last_error ?? "").toLowerCase().includes("gst_no");

                return (
                  <div key={job.id} className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center hover:bg-slate-50/50 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-navy">
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize text-slate-800">
                          {job.entity_type}
                        </span>
                        {job.entity_details?.title ? (
                          <span className="font-semibold text-navy">{job.entity_details.title}</span>
                        ) : (
                          <code className="text-xs text-slate">{job.entity_id}</code>
                        )}
                        <StatusBadge status={job.status.replace("_", " ")} />
                        <span className="text-xs text-slate">attempt {job.attempts}</span>
                      </div>

                      {job.entity_details?.subtitle && (
                        <p className="mt-1 text-xs text-slate flex flex-wrap items-center gap-2">
                          <span>{job.entity_details.subtitle}</span>
                          {job.entity_details.meta && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[11px] font-mono text-slate-700">
                              {job.entity_details.meta}
                            </span>
                          )}
                          <code className="text-[10px] text-slate/70">ID: {job.entity_id}</code>
                        </p>
                      )}

                      {job.last_error && (
                        <div className="mt-2 rounded-md p-2.5 text-xs leading-relaxed">
                          {isQuotaError ? (
                            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
                              <p className="font-semibold flex items-center gap-1.5">
                                <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                Zoho Monthly Limit Reached:
                              </p>
                              <p className="mt-0.5">
                                Your Zoho Inventory organization reached its free limit of 50 sales orders/month. Upgrade your Zoho plan or click &quot;Dismiss&quot; to skip this order.
                              </p>
                            </div>
                          ) : isGstError ? (
                            <div className="rounded border border-blue-200 bg-blue-50 p-2 text-blue-900">
                              <p className="font-semibold flex items-center gap-1.5">
                                <Info className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                                GSTIN Format Fixed:
                              </p>
                              <p className="mt-0.5">
                                Zoho rejected the raw GSTIN ({job.last_error}). The integration now validates Indian GSTINs and falls back to consumer status for retail orders. Click Retry to push now.
                              </p>
                            </div>
                          ) : (
                            <p className="text-amber-900">{job.last_error}</p>
                          )}
                        </div>
                      )}
                      <p className="mt-1 text-[11px] text-slate/80">Updated {new Date(job.updated_at).toLocaleString()}</p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {job.entity_details?.link && (
                        <Link
                          to={job.entity_details.link}
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-white px-2.5 text-xs font-semibold text-navy hover:bg-slate-50 shadow-xs"
                        >
                          <ExternalLink className="h-3 w-3" /> View
                        </Link>
                      )}
                      {["failed", "needs_review"].includes(job.status) && (
                        <>
                          <Button size="sm" variant="outline" disabled={queueBusy} onClick={() => void retryJob(job.id)} className="h-8 text-xs font-semibold">
                            <RotateCw className="mr-1 h-3 w-3" /> Retry
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={queueBusy}
                            onClick={() => void dismissJob(job.id, isQuotaError ? "Dismissed: Zoho monthly sales order quota reached" : "Dismissed by admin")}
                            className="h-8 text-xs font-semibold border-slate-300 text-slate-700 hover:bg-slate-100"
                            title="Dismiss this record so it no longer appears as failed"
                          >
                            <XCircle className="mr-1 h-3 w-3" /> Dismiss
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
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
            { key: "customers_from_orders", label: "Customers from orders", icon: Users },
            { key: "categories", label: "Categories", icon: Shapes },
            { key: "tax_rules", label: "Tax records", icon: Coins },
            { key: "store_index", label: "Zoho stores", icon: Store },
            { key: "store_meta", label: "Store settings", icon: Settings2 },
          ].map(({ key, label, icon: Icon }) => {
            const state = (key === "customers_from_orders" ? statesByResource["sales_orders"] : statesByResource[key]) as MirrorState | undefined;
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
                  {key === "customers_from_orders"
                    ? customersFromOrders.length.toLocaleString()
                    : state ? state.record_count.toLocaleString() : "Not synced"}
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
            This page shows a read-only snapshot imported from Zoho. It does not edit Zoho records.
            Use <strong>Open this order in Zoho</strong> for the official editing and navigation options;
            use <strong>Sync account data</strong> to import the latest Zoho values. <strong>Refresh
            saved data</strong> only reloads the last saved snapshot.
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
                    {key === "customers_from_orders"
                      ? customersFromOrders.length
                      : (statesByResource[key] as MirrorState | undefined)?.record_count ?? 0}
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
                    {selectedResource === "customers_from_orders" ? "Customers from Zoho orders" : `${RESOURCE_LABELS[selectedResource]} from Zoho`}
                  </h3>
                  <p className="mt-1 text-sm text-slate">
                    {(selectedResource === "customers_from_orders" ? customersFromOrders.length : selectedState.record_count).toLocaleString()} {selectedResource === "customers_from_orders" ? "customers represented by synced orders" : "records"} · Last updated{" "}
                    {new Date(selectedState.last_synced_at).toLocaleString()}
                  </p>
                </div>
                {selectedState.last_error && (
                  <p className="inline-flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    Most recent sync reported an issue; the last complete data is shown.
                  </p>
                )}
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                  {selectedResource === "sales_orders" && (
                    <select
                      value={orderStatusFilter}
                      onChange={(event) => { setOrderStatusFilter(event.target.value); setSalesOrdersPage(1); }}
                      className="h-10 rounded-md border border-border bg-white px-3 text-sm text-navy shadow-xs"
                      aria-label="Filter sales orders by status"
                    >
                      <option value="all">All statuses</option>
                      {orderStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  )}
                  <div className="relative w-full sm:w-64">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
                    <Input
                      value={search}
                      onChange={(event) => { setSearch(event.target.value); setSalesOrdersPage(1); }}
                      placeholder={`Search ${(RESOURCE_LABELS[selectedResource] ?? "records").toLocaleLowerCase()}`}
                      className="pl-9"
                      aria-label={`Search ${RESOURCE_LABELS[selectedResource] ?? "records"}`}
                    />
                  </div>
                  {selectedResource === "sales_orders" && (
                    <Button size="sm" variant="outline" onClick={() => setNewViewOpen((open) => !open)}>
                      + New View
                    </Button>
                  )}
                </div>
              </div>
              {selectedResource === "customers_from_orders" && (
                <p className="mb-4 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-sm text-slate">
                  This is a customer summary derived from synced Zoho sales orders. It is not Zoho’s standalone Contacts directory; customers without a synced order are not included, and only fields present on their orders are shown.
                </p>
              )}
              {selectedResource === "sales_orders" && (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => { setActiveOrderViewId("all"); setSalesOrdersPage(1); }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium ${activeOrderViewId === "all" ? "border-navy bg-navy text-white" : "border-border bg-white text-slate hover:border-gold"}`}>
                      All Sales Orders
                    </button>
                    <button type="button" onClick={() => { setOutstandingOnly((value) => !value); setSalesOrdersPage(1); }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium ${outstandingOnly ? "border-amber-500 bg-amber-500 text-white" : "border-border bg-white text-slate hover:border-gold"}`}>
                      Outstanding
                    </button>
                    {orderViews.map((view) => (
                      <div key={view.id} className={`inline-flex items-center rounded-full border text-xs ${activeOrderViewId === view.id ? "border-navy bg-navy text-white" : "border-border bg-white text-slate"}`}>
                        <button type="button" onClick={() => { setActiveOrderViewId(view.id); setSalesOrdersPage(1); }} className="px-3 py-1.5 font-medium">{view.name}</button>
                        <button type="button" aria-label={`Delete ${view.name} view`} title="Delete view" onClick={() => {
                          const next = orderViews.filter((item) => item.id !== view.id);
                          setOrderViews(next);
                          if (activeOrderViewId === view.id) setActiveOrderViewId("all");
                          try { localStorage.setItem(ORDER_VIEWS_STORAGE_KEY, JSON.stringify(next)); } catch { /* browser storage is optional */ }
                        }} className="px-2 text-current/70 hover:text-current">×</button>
                      </div>
                    ))}
                    {(orderStatusFilter !== "all" || outstandingOnly || search) && (
                      <button type="button" onClick={() => { setOrderStatusFilter("all"); setOutstandingOnly(false); setSearch(""); setSalesOrdersPage(1); }} className="px-2 py-1 text-xs font-medium text-blue-700 hover:underline">Clear filters</button>
                    )}
                  </div>
                  {newViewOpen && (
                    <div role="dialog" aria-label="Create sales order view" className="mb-4 rounded-lg border border-gold/50 bg-amber-50/50 p-4 shadow-sm">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div><h4 className="font-semibold text-navy">Create a sales order view</h4><p className="mt-1 text-xs text-slate">Saved in this browser and applied across the loaded Zoho snapshot.</p></div>
                        <button type="button" onClick={() => setNewViewOpen(false)} aria-label="Close view builder" className="text-slate hover:text-navy">×</button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Input value={draftViewName} onChange={(event) => setDraftViewName(event.target.value)} placeholder="View name" aria-label="View name" />
                        <select value={draftViewField} onChange={(event) => { const field = event.target.value as ZohoOrderView["field"]; setDraftViewField(field); setDraftViewComparator(field === "balance" ? "gt" : "is"); }} className="h-10 rounded-md border border-border bg-white px-3 text-sm" aria-label="Criterion field">
                          <option value="status">Order status</option><option value="payment">Payment status</option><option value="customer">Customer / business</option><option value="order">Sales order number</option><option value="balance">Outstanding balance</option>
                        </select>
                        <select value={draftViewComparator} onChange={(event) => setDraftViewComparator(event.target.value as ZohoOrderView["comparator"])} className="h-10 rounded-md border border-border bg-white px-3 text-sm" aria-label="Criterion comparator">
                          {draftViewField === "balance" ? <option value="gt">greater than</option> : <><option value="is">is</option><option value="is_not">is not</option><option value="contains">contains</option></>}
                        </select>
                        <Input value={draftViewValue} onChange={(event) => setDraftViewValue(event.target.value)} placeholder={draftViewField === "balance" ? "Amount, e.g. 0" : "Value, e.g. Pending"} aria-label="Criterion value" />
                      </div>
                      <div className="mt-3 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setNewViewOpen(false)}>Cancel</Button><Button size="sm" onClick={saveOrderView}>Save view</Button></div>
                    </div>
                  )}
                </>
              )}
              {selectedResource === "sales_orders" && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate">
                  <span>
                    Showing {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
                    {filteredOrderRecords.length.toLocaleString()} matching sales orders
                  </span>
                  <span>These are Zoho records. They do not create ShamiBusiness orders.</span>
                </div>
              )}
              {hasVisibleRecords ? (
                selectedResource === "customers_from_orders" ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[900px] text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate"><tr><th className="px-4 py-3">Customer / business</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Phone</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Orders</th><th className="px-4 py-3">Sales order value</th><th className="px-4 py-3">Last order</th></tr></thead>
                      <tbody className="divide-y divide-border bg-white">
                        {visibleCustomers.map((customer) => (
                          <tr key={customer.key} className="hover:bg-slate-50">
                            <td className="px-4 py-3"><div className="font-medium text-navy">{customer.name}</div>{customer.company !== "—" && customer.company !== customer.name && <div className="mt-0.5 text-xs text-slate">{customer.company}</div>}</td>
                            <td className="px-4 py-3 text-slate">{customer.email}</td><td className="px-4 py-3 text-slate">{customer.phone}</td><td className="max-w-xs truncate px-4 py-3 text-slate" title={customer.address}>{customer.address || "—"}</td><td className="px-4 py-3">{customer.orders}</td><td className="px-4 py-3 font-medium text-navy">{customer.currency === "MIXED" ? "Mixed currencies" : money(customer.spend, customer.currency)}</td><td className="px-4 py-3 text-slate">{prettyDate(customer.lastOrder)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : selectedResource === "sales_orders" ? (
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
                              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2.5">
                                <p className="text-sm text-slate">This is a read-only copy. Use the matching Zoho record to edit status, payment, shipping, or other Zoho fields.</p>
                                <a
                                  href={`${zohoCommerceBase(region)}/app/${encodeURIComponent(organizationId)}#/salesorders/${encodeURIComponent(record.external_id)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-medium text-navy shadow-sm hover:border-gold"
                                >
                                  <ExternalLink className="h-4 w-4" /> Open this order in Zoho
                                </a>
                              </div>
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
                    {normalizedSearch ? "No matching records" : "No records available"}
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
                      onClick={() => setSalesOrdersPage((page) => Math.max(1, page - 1))}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      {salesOrdersLoading ? "Loading…" : "Previous"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={salesOrdersPage >= totalPages || salesOrdersLoading}
                      onClick={() => setSalesOrdersPage((page) => Math.min(totalPages, page + 1))}
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
                    <h3 className="text-sm font-semibold text-navy">Outbound sync and inbound snapshots</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  Approved catalogue, contact, and order changes are queued for Zoho. Supported account data is read into separate snapshots when synchronized.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700">
                <PackageCheck className="h-4 w-4" />
              </span>
              <div>
                    <h3 className="text-sm font-semibold text-navy">Queued outbox processing</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  Outbound writes can be pushed with &quot;Push pending to Zoho&quot; or processed daily at 03:00 UTC by the scheduled worker on this Vercel Hobby plan.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700">
                <RefreshCw className="h-4 w-4" />
              </span>
              <div>
                    <h3 className="text-sm font-semibold text-navy">Scheduled fulfillment reconciliation</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate">
                  The worker polls supported linked-order shipment milestones daily at 03:00 UTC on this Vercel Hobby plan and applies eligible fulfillment changes to Grain Bazar orders. Imported Zoho sales order snapshots still need a manual &quot;Sync account data&quot; refresh.
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
