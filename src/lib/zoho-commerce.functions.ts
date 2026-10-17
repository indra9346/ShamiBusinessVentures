import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { PICKUP_SETTINGS_KEY, parsePickupSettings, pickupPointForPin } from "@/lib/pickup-points";
import { isMeasureUnit, toBaseQuantity } from "@/lib/data";
import { reconcileOrders, shouldRetryZohoCall, zohoLogLine, zohoOrderNumber, zohoRetryDelayMs, type ZohoOrderForReconcile } from "@/lib/zoho-sync-core";

const REGIONS = {
  com: ["https://accounts.zoho.com", "https://commerce.zoho.com", "https://www.zohoapis.com"],
  eu: ["https://accounts.zoho.eu", "https://commerce.zoho.eu", "https://www.zohoapis.eu"],
  in: ["https://accounts.zoho.in", "https://commerce.zoho.in", "https://www.zohoapis.in"],
  com_au: ["https://accounts.zoho.com.au", "https://commerce.zoho.com.au", "https://www.zohoapis.com.au"],
  jp: ["https://accounts.zoho.jp", "https://commerce.zoho.jp", "https://www.zohoapis.jp"],
  ca: ["https://accounts.zohocloud.ca", "https://commerce.zoho.ca", "https://www.zohoapis.ca"],
} as const;
type Region = keyof typeof REGIONS;
const enc = new TextEncoder();
const reqEnv = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Server configuration is missing ${key}`);
  return value;
};
const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const unb64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const unb64Url = (data: string) => {
  const normalized = data.replaceAll("-", "+").replaceAll("_", "/");
  return unb64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
};
async function stateHash(state: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(state)));
  return b64(digest).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function dbAdmin() {
  return createClient(reqEnv("SUPABASE_URL"), reqEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}
async function aesKey() {
  const raw = unb64(reqEnv("ZOHO_TOKEN_ENCRYPTION_KEY"));
  if (raw.length !== 32)
    throw new Error("ZOHO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const all = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(token)),
  );
  return {
    refresh_token_ciphertext: b64(all.slice(0, -16)),
    token_iv: b64(iv),
    token_tag: b64(all.slice(-16)),
  };
}
async function decrypt(row: {
  refresh_token_ciphertext: string;
  token_iv: string;
  token_tag: string;
}) {
  const all = new Uint8Array([...unb64(row.refresh_token_ciphertext), ...unb64(row.token_tag)]);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.token_iv) }, await aesKey(), all),
  );
}
async function sign(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(reqEnv("ZOHO_OAUTH_STATE_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function verifyState(value: string) {
  const [payload, signature] = value.split(".");
  if (!payload || !signature || (await sign(payload)) !== signature)
    throw new Error("Zoho authorization state is invalid or expired");
  const data = JSON.parse(new TextDecoder().decode(unb64Url(payload))) as {
    uid: string;
    org: string;
    region: Region;
    exp: number;
  };
  if (data.exp < Date.now() || !(data.region in REGIONS) || !data.org)
    throw new Error("Zoho authorization state is invalid or expired");
  return data;
}

export const startZohoAuthorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      organizationId: z.string().trim().min(1).max(80),
      region: z.enum(["com", "eu", "in", "com_au", "jp", "ca"]),
    }),
  )
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const redirectUri = reqEnv("ZOHO_REDIRECT_URI");
    const expiresAt = new Date(Date.now() + 600_000);
    const payload = b64(
      enc.encode(
        JSON.stringify({
          uid: context.userId,
          org: data.organizationId,
          region: data.region,
          exp: expiresAt.getTime(),
        }),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const state = `${payload}.${await sign(payload)}`;
    const db = await dbAdmin();
    // State lives only as a SHA-256 hash. The callback consumes this row before
    // exchanging its code, so an authorization response cannot be replayed.
    await db.from("zoho_oauth_states").delete().lt("expires_at", new Date().toISOString());
    const { error: stateError } = await db.from("zoho_oauth_states").insert({
      state_hash: await stateHash(state),
      user_id: context.userId,
      organization_id: data.organizationId,
      region: data.region,
      expires_at: expiresAt.toISOString(),
    });
    if (stateError) throw new Error("Could not create the protected Zoho authorization state");
    const auth = new URL(`${REGIONS[data.region][0]}/oauth/v2/auth`);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: reqEnv("ZOHO_CLIENT_ID"),
      scope:
        "ZohoCommerce.items.READ,ZohoCommerce.items.CREATE,ZohoCommerce.items.UPDATE,ZohoCommerce.coupons.READ,ZohoCommerce.coupons.CREATE,ZohoCommerce.coupons.UPDATE,ZohoCommerce.salesorders.READ,ZohoCommerce.salesorders.CREATE,ZohoCommerce.salesorders.UPDATE,ZohoCommerce.settings.READ,ZohoCommerce.settings.UPDATE,ZohoCommerce.sitesIndex.READ,ZohoCommerce.webhooks.READ,ZohoCommerce.webhooks.CREATE,ZohoInventory.contacts.READ,ZohoInventory.contacts.CREATE,ZohoInventory.contacts.UPDATE,ZohoInventory.items.READ,ZohoInventory.items.CREATE,ZohoInventory.items.UPDATE,ZohoInventory.salesorders.READ,ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE,ZohoInventory.inventoryadjustments.READ,ZohoInventory.inventoryadjustments.CREATE,ZohoInventory.settings.READ",
      redirect_uri: redirectUri,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return { url: auth.toString() };
  });

export async function completeZohoAuthorization(code: string, state: string) {
  const info = await verifyState(state);
  const { data: storedState, error: stateError } = await (await dbAdmin())
    .from("zoho_oauth_states")
    .delete()
    .eq("state_hash", await stateHash(state))
    .eq("user_id", info.uid)
    .eq("organization_id", info.org)
    .eq("region", info.region)
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (stateError || !storedState)
    throw new Error("Zoho authorization state is invalid, expired, or has already been used");
  const [accounts] = REGIONS[info.region];
  const response = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: reqEnv("ZOHO_CLIENT_ID"),
      client_secret: reqEnv("ZOHO_CLIENT_SECRET"),
      redirect_uri: reqEnv("ZOHO_REDIRECT_URI"),
      code,
    }),
  });
  const tokens = (await response.json()) as { refresh_token?: string; error?: string };
  if (!response.ok || !tokens.refresh_token)
    throw new Error(tokens.error ?? "Zoho authorization could not be completed");
  const { error } = await (await dbAdmin()).from("zoho_commerce_connection").upsert({
    id: true,
    organization_id: info.org,
    region: info.region,
    ...(await encrypt(tokens.refresh_token)),
    status: "connected",
    last_error: null,
    connected_by: info.uid,
    updated_at: new Date().toISOString(),
  });
  if (error)
    throw new Error(
      "Zoho authorized, but its connection could not be saved; check the database migration and server encryption settings",
    );
}

export const getZohoConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await (
      await dbAdmin()
    )
      .from("zoho_commerce_connection")
      .select("organization_id,region,status,last_synced_at,last_error,updated_at")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error("Could not load Zoho connection status");
    return data ?? null;
  });

export const getZohoSyncQueueStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const statuses = ["pending", "processing", "failed", "needs_review", "complete"] as const;
    const [jobsResult, ...statusResults] = await Promise.all([
      db.from("zoho_sync_outbox")
      .select("id,entity_type,entity_id,status,attempts,last_error,created_at,updated_at")
        .order("updated_at", { ascending: false }).limit(30),
      ...statuses.map((status) => db.from("zoho_sync_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", status)),
    ]);
    if (jobsResult.error || statusResults.some((result) => result.error)) {
      throw new Error("Could not load Zoho sync queue status");
    }
    const counts = Object.fromEntries(
      statuses.map((status, index) => [status, statusResults[index]?.count ?? 0]),
    );

    const rawJobs = jobsResult.data ?? [];
    const customerIds = rawJobs.filter((j) => j.entity_type === "customer").map((j) => j.entity_id);
    const orderIds = rawJobs.filter((j) => j.entity_type === "order").map((j) => j.entity_id);
    const catalogIds = rawJobs.filter((j) => j.entity_type === "catalog").map((j) => j.entity_id);

    const [profilesRes, ordersRes, catalogRes] = await Promise.all([
      customerIds.length
        ? db.from("profiles").select("id,full_name,email,phone,company,gstin").in("id", customerIds)
        : { data: [] },
      orderIds.length
        ? db.from("orders").select("id,order_no,customer_name,customer_email,customer_phone,customer_gstin,total,payment_status,order_status,created_at").in("id", orderIds)
        : { data: [] },
      catalogIds.length
        ? db.from("catalog_products").select("id,payload").in("id", catalogIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data ?? []).map((p) => [p.id, p]));
    const orderMap = new Map((ordersRes.data ?? []).map((o) => [o.id, o]));
    const catalogMap = new Map((catalogRes.data ?? []).map((c) => [c.id, c]));

    const jobs = rawJobs.map((job) => {
      let details: {
        title: string;
        subtitle?: string | undefined;
        meta?: string | undefined;
        link?: string | undefined;
        gstin?: string | null | undefined;
      } | null = null;

      if (job.entity_type === "customer") {
        const p = profileMap.get(job.entity_id);
        if (p) {
          const name = p.company?.trim() || p.full_name?.trim() || "Customer Contact";
          const sub = [p.email, p.phone].filter(Boolean).join(" · ");
          details = {
            title: name,
            subtitle: sub || `User: ${p.id.slice(0, 8)}…`,
            meta: p.gstin ? `GSTIN: ${p.gstin}` : "No GSTIN",
            link: `/admin/customers`,
            gstin: p.gstin,
          };
        }
      } else if (job.entity_type === "order") {
        const o = orderMap.get(job.entity_id);
        if (o) {
          const orderNum = o.order_no ? `Order #${o.order_no}` : `Order ${o.id.slice(0, 8)}`;
          const amount = Number(o.total);
          const totalStr = Number.isFinite(amount) ? `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "";
          const sub = [o.customer_name, totalStr, o.order_status].filter(Boolean).join(" · ");
          details = {
            title: orderNum,
            subtitle: sub,
            ...(o.customer_gstin ? { meta: `Customer GSTIN: ${o.customer_gstin}` } : {}),
            link: `/admin/orders/${o.id}`,
            ...(o.customer_gstin ? { gstin: o.customer_gstin } : {}),
          };
        }
      } else if (job.entity_type === "catalog") {
        const c = catalogMap.get(job.entity_id);
        if (c) {
          const payload = plainObject(c.payload);
          const name = str(payload["name"]) || job.entity_id;
          const sku = str(payload["sku"]);
          const price = finiteNumber(payload["price"]);
          const sub = [sku ? `SKU: ${sku}` : null, price !== null ? `₹${price.toLocaleString("en-IN")}` : null].filter(Boolean).join(" · ");
          details = {
            title: name,
            subtitle: sub,
            link: `/admin/products`,
          };
        }
      }

      return {
        ...job,
        entity_details: details,
      };
    });

    return {
      counts,
      jobs,
      refreshedAt: new Date().toISOString(),
    };
  });

export const retryZohoSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { error } = await (await dbAdmin()).rpc("retry_zoho_sync_job", { _id: data.id });
    if (error) throw new Error("Could not requeue the selected Zoho sync job");
  });

export const retryAllZohoSyncJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: failedJobs, error } = await db
      .from("zoho_sync_outbox")
      .select("id")
      .in("status", ["failed", "needs_review"]);
    if (error) throw new Error("Could not load failed jobs to retry");
    let count = 0;
    for (const job of (failedJobs ?? [])) {
      const { error: rpcErr } = await db.rpc("retry_zoho_sync_job", { _id: job.id });
      if (!rpcErr) count++;
    }
    return { retried: count };
  });

export const dismissZohoSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid(), reason: z.string().optional() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const reason = data.reason || "Dismissed by admin from Zoho sync queue";
    const { error } = await db
      .from("zoho_sync_outbox")
      .update({
        status: "complete",
        last_error: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error("Could not dismiss the selected sync job");
    return { success: true };
  });

export const dismissAllQuotaFailedJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: failedJobs, error: fetchError } = await db
      .from("zoho_sync_outbox")
      .select("id,last_error")
      .in("status", ["failed", "needs_review"]);
    if (fetchError) throw new Error("Could not load jobs to dismiss");

    const matched = (failedJobs ?? []).filter((j) => {
      const err = (j.last_error ?? "").toLowerCase();
      return (
        err.includes("used up your available sales orders") ||
        err.includes("create more orders") ||
        err.includes("sales order monthly limit")
      );
    });

    let count = 0;
    for (const job of matched) {
      const { error } = await db
        .from("zoho_sync_outbox")
        .update({
          status: "complete",
          last_error: "Dismissed by admin: Zoho sales order monthly limit reached",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (!error) count++;
    }
    return { dismissed: count };
  });

/**
 * Queue records that existed before the outbound triggers were installed.
 *
 * This only writes to the local durable outbox. Zoho is not contacted here;
 * the protected worker will send these records only after outbound writes have
 * been explicitly enabled. Existing pending, failed, processing, and review
 * jobs are deliberately left untouched so an administrator can resolve their
 * current state without a backfill creating duplicate work.
 */
export const queueZohoInitialExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const [rolesResult, catalogResult, ordersResult, existingResult] = await Promise.all([
      db.from("user_roles").select("user_id").in("role", ["customer", "vendor"]),
      db.from("catalog_products")
        .select("id")
        .eq("status", "approved")
        .not("vendor_id", "like", "zoho:%"),
      db.from("orders")
        .select("id")
        .is("zoho_salesorder_id", null)
        .not("order_status", "in", "(Cancelled,Awaiting Payment)"),
      db.from("zoho_sync_outbox")
        .select("entity_type,entity_id")
        .in("status", ["pending", "processing", "failed", "needs_review"]),
    ]);
    if (rolesResult.error || catalogResult.error || ordersResult.error || existingResult.error)
      throw new Error("Could not prepare the initial Zoho export; verify the production sync migration");

    const existing = new Set(
      (existingResult.data ?? []).map((job) => `${job.entity_type}:${job.entity_id}`),
    );
    const candidateJobs = [
      ...new Set((rolesResult.data ?? []).map((role) => role.user_id)),
    ].map((userId) => ({ entityType: "customer", entityId: userId }))
      .concat((catalogResult.data ?? []).map((product) => ({ entityType: "catalog", entityId: product.id })))
      .concat((ordersResult.data ?? []).map((order) => ({ entityType: "order", entityId: order.id })));
    const jobs = candidateJobs.filter((job) => !existing.has(`${job.entityType}:${job.entityId}`));

    for (let index = 0; index < jobs.length; index += 50) {
      const batch = jobs.slice(index, index + 50);
      const results = await Promise.all(
        batch.map((job) =>
          db.rpc("enqueue_zoho_sync", {
            _entity_type: job.entityType,
            _entity_id: job.entityId,
          }),
        ),
      );
      if (results.some((result) => result.error))
        throw new Error("Could not enqueue the initial Zoho export");
    }
    return {
      queued: jobs.length,
      customers: jobs.filter((job) => job.entityType === "customer").length,
      catalog: jobs.filter((job) => job.entityType === "catalog").length,
      orders: jobs.filter((job) => job.entityType === "order").length,
      skippedExisting: candidateJobs.length - jobs.length,
    };
  });

const ZOHO_READ_RESOURCES = [
  "categories",
  "sales_orders",
  "tax_rules",
  "store_index",
  "store_meta",
] as const;
type ZohoReadResource = (typeof ZOHO_READ_RESOURCES)[number];

async function fetchZohoPages(
  region: Region,
  organizationId: string,
  token: string,
  path: string,
  property: string,
  query: Record<string, string> = {},
) {
  const output: Record<string, unknown>[] = [];
  for (let page = 1; page <= 25; page += 1) {
    const url = new URL(`${REGIONS[region][1]}${path}`);
    url.search = new URLSearchParams({ ...query, page: String(page), per_page: "200" }).toString();
    const response = await fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "X-com-zoho-store-organizationid": organizationId,
      },
    });
    const data = (await response.json()) as {
      code?: number;
      message?: string;
      page_context?: { has_more_page?: boolean };
      [key: string]: unknown;
    };
    if (!response.ok || data.code !== 0)
      throw new Error(data.message ?? `Zoho ${property} request failed (${response.status})`);
    const rows = Array.isArray(data[property]) ? (data[property] as Record<string, unknown>[]) : [];
    output.push(...rows);
    if (data.page_context?.has_more_page === false) return output;
    if (data.page_context?.has_more_page === undefined && rows.length < 200) return output;
  }
  throw new Error(`Zoho ${property} exceeded the 5,000-record safety limit`);
}

async function saveZohoSnapshot(
  db: SupabaseClient<Database>,
  organizationId: string,
  resource: ZohoReadResource,
  rows: Record<string, unknown>[],
  getId: (row: Record<string, unknown>) => string,
) {
  const batchId = crypto.randomUUID();
  const records = rows.flatMap((payload) => {
    const externalId = getId(payload);
    return externalId
      ? [
          {
            organization_id: organizationId,
            resource,
            batch_id: batchId,
            external_id: externalId,
            payload: payload as Json,
          },
        ]
      : [];
  });
  for (let i = 0; i < records.length; i += 100) {
    const { error } = await db.from("zoho_commerce_sync_data").insert(records.slice(i, i + 100));
    if (error) throw new Error(`Could not stage Zoho ${resource} snapshot`);
  }
  const { data: previous, error: previousError } = await db
    .from("zoho_commerce_sync_state")
    .select("current_batch_id")
    .eq("organization_id", organizationId)
    .eq("resource", resource)
    .maybeSingle();
  if (previousError) throw new Error(`Could not check the existing Zoho ${resource} snapshot`);
  const { error: stateError } = await db.from("zoho_commerce_sync_state").upsert(
    {
      organization_id: organizationId,
      resource,
      current_batch_id: batchId,
      record_count: records.length,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "organization_id,resource" },
  );
  if (stateError) throw new Error(`Could not publish the Zoho ${resource} snapshot`);
  if (previous?.current_batch_id && previous.current_batch_id !== batchId) {
    await db
      .from("zoho_commerce_sync_data")
      .delete()
      .eq("organization_id", organizationId)
      .eq("resource", resource)
      .eq("batch_id", previous.current_batch_id);
  }
  return records.length;
}

export const getZohoCommerceReadMirror = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    salesOrdersPage: z.number().int().min(1).max(999).default(1),
    resource: z.enum(["categories", "sales_orders", "tax_rules", "store_index", "store_meta"]).optional(),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: connection, error: connectionError } = await db
      .from("zoho_commerce_connection")
      .select("organization_id")
      .eq("id", true)
      .maybeSingle();
    if (connectionError) throw new Error("Could not load the Zoho connection");
    if (!connection)
      return {
        resources: [],
        snapshots: {} as Record<
          string,
          { external_id: string; payload: Json; captured_at: string }[]
        >,
      };
    let resourcesQuery = db
      .from("zoho_commerce_sync_state")
      .select("organization_id,resource,current_batch_id,record_count,last_synced_at,last_error")
      .eq("organization_id", connection.organization_id);
    if (data.resource) resourcesQuery = resourcesQuery.eq("resource", data.resource);
    const { data: resources, error } = await resourcesQuery;
    if (error) throw new Error("Could not load the Zoho data mirror");
    const entries = await Promise.all(
      (resources ?? []).map(async (state) => {
        let query = db
          .from("zoho_commerce_sync_data")
          .select("external_id,payload,captured_at")
          .eq("organization_id", connection.organization_id)
          .eq("resource", state.resource)
          .eq("batch_id", state.current_batch_id)
          .order("external_id", { ascending: true });
        if (state.resource === "sales_orders") {
          // Keep the full bounded mirror available to the admin UI so search, status
          // filters, and saved views operate across the whole snapshot, not just one page.
          const pageSize = 1000;
          const total = Math.min(state.record_count, 5000);
          const pages = Math.ceil(total / pageSize);
          const chunks = await Promise.all(
            Array.from({ length: pages }, (_, index) =>
              db
                .from("zoho_commerce_sync_data")
                .select("external_id,payload,captured_at")
                .eq("organization_id", connection.organization_id)
                .eq("resource", state.resource)
                .eq("batch_id", state.current_batch_id)
                .order("external_id", { ascending: true })
                .range(index * pageSize, Math.min(total - 1, (index + 1) * pageSize - 1)),
            ),
          );
          const failedChunk = chunks.find((chunk) => chunk.error);
          if (failedChunk?.error) throw new Error(`Could not load Zoho ${state.resource} records`);
          return [state.resource, chunks.flatMap((chunk) => chunk.data ?? [])] as const;
        } else {
          query = query.limit(200);
        }
        const { data: rows, error: rowsError } = await query;
        if (rowsError) throw new Error(`Could not load Zoho ${state.resource} records`);
        return [state.resource, rows ?? []] as const;
      }),
    );
    const snapshots = Object.fromEntries(entries) as Record<
      string,
      { external_id: string; payload: Json; captured_at: string }[]
    >;
    return { resources: resources ?? [], snapshots };
  });

export const syncZohoCommerceReadMirror = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: connection, error } = await db
      .from("zoho_commerce_connection")
      .select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag")
      .eq("id", true)
      .maybeSingle();
    if (error || !connection) throw new Error("Connect Zoho before syncing its data");
    const region = connection.region as Region;
    if (!(region in REGIONS)) throw new Error("The Zoho data center is not supported");
    const organizationId = connection.organization_id;
    const token = await accessToken(region, await decrypt(connection));
    const outcomes: Record<string, { count: number; error?: string }> = {};
    const run = async (
      resource: ZohoReadResource,
      fetchRows: () => Promise<Record<string, unknown>[]>,
      id: (row: Record<string, unknown>) => string,
    ) => {
      try {
        const rows = await fetchRows();
        outcomes[resource] = {
          count: await saveZohoSnapshot(db, organizationId, resource, rows, id),
        };
        return rows;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : `Could not sync ${resource}`;
        outcomes[resource] = { count: 0, error: message.slice(0, 300) };
        await db
          .from("zoho_commerce_sync_state")
          .update({ last_error: message.slice(0, 500) })
          .eq("organization_id", organizationId)
          .eq("resource", resource);
        return [];
      }
    };

    const [, , , sites] = await Promise.all([
      run(
        "categories",
        () =>
          fetchZohoPages(region, organizationId, token, "/store/api/v1/categories", "categories"),
        (row) => str(row["category_id"]),
      ),
      run(
        "sales_orders",
        () =>
          fetchZohoPages(
            region,
            organizationId,
            token,
            "/store/api/v1/salesorders",
            "salesorders",
            {
              filter_by: "Status.All",
            },
          ),
        (row) => str(row["salesorder_id"]),
      ),
      run(
        "tax_rules",
        async () => {
          const rules = await fetchZohoPages(
            region,
            organizationId,
            token,
            "/store/api/v1/settings/taxrules",
            "taxrules",
          );
          const url = `${REGIONS[region][1]}/store/api/v1/settings/taxpreferences`;
          const response = await fetch(url, {
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              "X-com-zoho-store-organizationid": organizationId,
            },
          });
          const data = (await response.json()) as {
            code?: number;
            message?: string;
            tax_preferences?: Record<string, unknown>;
          };
          if (!response.ok || data.code !== 0)
            throw new Error(
              data.message ?? `Zoho tax preferences request failed (${response.status})`,
            );
          return [
            ...rules,
            ...(data.tax_preferences
              ? [{ ...data.tax_preferences, _zoho_resource_type: "tax_preferences" }]
              : []),
          ];
        },
        (row) =>
          str(
            row["rule_id"] ??
              row["tax_id"] ??
              (row["_zoho_resource_type"] === "tax_preferences" ? "tax_preferences" : ""),
          ),
      ),
      run(
        "store_index",
        async () => {
          const response = await fetch(`${REGIONS[region][1]}/zs-site/api/v1/index/sites`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
          });
          const data = (await response.json()) as {
            status_code?: string;
            status_message?: string;
            get_sites?: { my_sites?: Record<string, unknown>[] };
          };
          if (!response.ok || data.status_code !== "0")
            throw new Error(
              data.status_message ?? `Zoho store index request failed (${response.status})`,
            );
          return data.get_sites?.my_sites ?? [];
        },
        (row) => str(row["zsite_id"]),
      ),
    ]);
    await run(
      "store_meta",
      async () => {
        const site = sites.find((item) => str(item["zohofinance_orgid"]) === organizationId);
        if (!site)
          throw new Error(
            "The Zoho site index did not identify a published store for this organization",
          );
        const domain = str(site["primary_domain"]);
        if (!domain || domain.length > 253 || /[^a-z0-9.-]/i.test(domain))
          throw new Error("Zoho returned an invalid published store domain");
        const response = await fetch(`${REGIONS[region][1]}/storefront/api/v1/store-meta`, {
          headers: { "domain-name": domain },
        });
        const data = (await response.json()) as {
          status_code?: string;
          status_message?: string;
          payload?: Record<string, unknown>;
        };
        if (!response.ok || data.status_code !== "0" || !data.payload)
          throw new Error(
            data.status_message ?? `Zoho storefront settings request failed (${response.status})`,
          );
        return [{ site_id: str(site["zsite_id"]), primary_domain: domain, ...data.payload }];
      },
      (row) => str(row["site_id"]),
    );

    const failures = Object.entries(outcomes).filter(([, value]) => value.error);
    const summary = failures.length
      ? failures
          .map(([resource, value]) => `${resource}: ${value.error}`)
          .join("; ")
          .slice(0, 500)
      : null;
    const { error: statusError } = await db
      .from("zoho_commerce_connection")
      .update({
        status: summary ? "error" : "connected",
        last_error: summary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (statusError)
      throw new Error("Zoho data synced, but its connection status could not be saved");
    return { outcomes, failures: failures.length };
  });

const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
function mapProduct(p: Record<string, unknown>, organizationId: string) {
  const variants = Array.isArray(p["variants"]) ? (p["variants"] as Record<string, unknown>[]) : [];
  const v = variants[0] ?? p;
  const cat =
    p["category"] && typeof p["category"] === "object"
      ? (p["category"] as Record<string, unknown>)
      : {};
  const show = p["show_in_storefront"] !== false && str(p["status"]).toLowerCase() !== "inactive";
  const image = str(p["image_url"]) || str(p["image"]);
  const id = `zoho-${str(p["product_id"])}`;
  const category = str(cat["category_name"]) || str(p["category_name"]) || "Uncategorized";
  return {
    id,
    vendor_id: `zoho:${organizationId}`,
    category,
    status: "approved",
    active: show,
    payload: {
      id,
      name: str(p["name"]),
      sku: str(v["sku"]) || str(p["sku"]),
      brand: str(p["brand"]),
      vendor: "Zoho Commerce",
      vendorId: `zoho:${organizationId}`,
      category,
      subcategory: "",
      image,
      price: num(v["rate"] ?? p["rate"]),
      mrp: num(v["label_rate"] ?? p["label_rate"] ?? v["rate"] ?? p["rate"]),
      gst: 0,
      rating: 0,
      reviews: 0,
      stock: num(
        v["stock_on_hand"] ?? v["available_stock"] ?? v["initial_stock"] ?? p["stock_on_hand"],
      ),
      minimumStock: num(v["reorder_level"] ?? p["reorder_level"]),
      warehouseStock: num(v["stock_on_hand"] ?? p["stock_on_hand"]),
      requiredStock: 0,
      reserved: 0,
      sold: 0,
      weight: str((v["package_details"] as Record<string, unknown> | undefined)?.["weight"]),
      status: "approved",
      active: show,
      tags: Array.isArray(p["tags"])
        ? p["tags"].filter((tag): tag is string => typeof tag === "string")
        : [],
      description: str(p["product_description"] ?? p["description"]),
      specs: Array.isArray(p["specifications"]) ? p["specifications"] : [],
      created: str(p["created_time"]),
      updated: str(p["last_modified_time"]),
      zoho: {
        productId: str(p["product_id"]),
        url: str(p["url"]),
        showInStorefront: show,
        isReturnable: p["is_returnable"] === true,
        featured: p["is_featured"] === true,
        seoTitle: str(p["seo_title"]),
        seoKeyword: str(p["seo_keyword"]),
        seoDescription: str(p["seo_description"]),
        variants: variants.map((item) => ({
          id: str(item["variant_id"]),
          sku: str(item["sku"]),
          rate: num(item["rate"]),
          labelRate: num(item["label_rate"]),
          stockOnHand: num(item["stock_on_hand"] ?? item["available_stock"]),
          options: [
            item["attribute_option_name1"],
            item["attribute_option_name2"],
            item["attribute_option_name3"],
          ].filter((value) => typeof value === "string"),
        })),
      },
    },
  };
}
async function accessToken(region: Region, refreshToken: string) {
  const [accounts] = REGIONS[region];
  const response = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: reqEnv("ZOHO_CLIENT_ID"),
      client_secret: reqEnv("ZOHO_CLIENT_SECRET"),
      refresh_token: refreshToken,
    }),
  });
  const data = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !data.access_token)
    throw new Error(data.error ?? "Could not refresh Zoho access token");
  return data.access_token;
}

type ZohoSyncJob = {
  id: string;
  entity_type: "customer" | "order" | "catalog";
  entity_id: string;
  attempts: number;
};

function inventoryApi(region: Region, resource: string, organizationId: string, query: Record<string, string> = {}) {
  const url = new URL(`${REGIONS[region][2]}/inventory/v1/${resource}`);
  url.search = new URLSearchParams({ organization_id: organizationId, ...query }).toString();
  return url;
}

async function inventoryRequest<T>(
  region: Region,
  organizationId: string,
  token: string,
  resource: string,
  method: "GET" | "POST" | "PUT",
  body?: Record<string, unknown>,
  query: Record<string, string> = {},
): Promise<T> {
  const send = () => fetch(inventoryApi(region, resource, organizationId, query), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  // Up to 2 retries with backoff: 429 for any method (Zoho did not process it); 5xx and network
  // errors only for GET/PUT. A POST is never resent blindly; order creation looks up its unique
  // GB- number on the next attempt instead (see syncZohoOrder).
  const MAX_RETRIES = 2;
  let response: Response | null = null;
  for (let retry = 0; ; retry += 1) {
    let status: number | "network";
    try {
      response = await send();
      status = response.status;
    } catch (cause) {
      response = null;
      status = "network";
      if (retry >= MAX_RETRIES || !shouldRetryZohoCall(method, status)) throw cause;
    }
    if (response && (response.ok || !shouldRetryZohoCall(method, status))) break;
    if (retry >= MAX_RETRIES) break;
    const waitMs = zohoRetryDelayMs(retry + 1, response?.headers.get("retry-after") ?? null);
    console.warn(zohoLogLine("zoho_call_retry", { resource: resource.split("/")[0], method, status: String(status), retry: retry + 1, waitMs }));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (!response) throw new Error(`Zoho Inventory ${resource} could not be reached`);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0)
    throw new Error(data.message ?? `Zoho Inventory ${resource} failed (${response.status})`);
  return data;
}

async function commerceRequest<T>(
  region: Region,
  organizationId: string,
  token: string,
  resource: string,
  method: "GET" | "POST" | "PUT",
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${REGIONS[region][1]}/store/api/v1/${resource}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "X-com-zoho-store-organizationid": organizationId,
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0)
    throw new Error(data.message ?? `Zoho Commerce ${resource} failed (${response.status})`);
  return data;
}

/** Turns Zoho's permission and plan-limit refusals into the step that fixes them. */
export function zohoPermissionHint(message: string) {
  if (/used up your available sales orders|create more orders|monthly limit/i.test(message))
    return " This is the Zoho organization's sales-order plan limit; Zoho must raise it (Zoho billing or support) before more orders can be created.";
  if (/not authori[sz]ed|invalid[_ ]?scope|oauth|permission/i.test(message))
    return ' Open Admin > Zoho, click "Reauthorize Zoho" and accept every permission Zoho lists.';
  return "";
}

function splitContactName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? "Grain Bazar Customer", last_name: parts.slice(1).join(" ") };
}

export const INDIAN_GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export const INDIAN_STATE_CODES: Record<string, string> = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UT", "06": "HR", "07": "DL",
  "08": "RJ", "09": "UP", "10": "BR", "11": "SK", "12": "AR", "13": "NL", "14": "MN",
  "15": "MZ", "16": "TR", "17": "ML", "18": "AS", "19": "WB", "20": "JH", "21": "OR",
  "22": "CT", "23": "MP", "24": "GJ", "26": "DN", "27": "MH", "28": "AP", "29": "KA",
  "30": "GA", "31": "LD", "32": "KL", "33": "TN", "34": "PY", "35": "AN", "36": "TS",
  "37": "AD", "38": "LA",
};

export function cleanAndValidateGstin(raw?: string | null): {
  isValid: boolean;
  gstin?: string | undefined;
  placeOfContact?: string | undefined;
  note?: string | undefined;
} {
  if (!raw) return { isValid: false };
  const trimmed = raw.trim().toUpperCase();
  if (
    !trimmed ||
    ["NA", "N/A", "NONE", "NIL", "NULL", "0", "PENDING", "NO", "NOT APPLICABLE", "UNREGISTERED"].includes(trimmed)
  ) {
    return { isValid: false, note: `Customer marked GSTIN as "${raw.trim()}"` };
  }
  if (INDIAN_GSTIN_REGEX.test(trimmed)) {
    const stateDigits = trimmed.slice(0, 2);
    const placeOfContact = INDIAN_STATE_CODES[stateDigits];
    return {
      isValid: true,
      gstin: trimmed,
      ...(placeOfContact ? { placeOfContact } : {}),
    };
  }
  return { isValid: false, note: `Customer provided unverified GSTIN: "${raw.trim()}"` };
}

async function upsertZohoContact(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  userId: string,
  contactType: "customer" | "vendor",
) {
  const [{ data: profile, error: profileError }, { data: roles, error: rolesError }, { data: addresses, error: addressesError }, { data: link }] = await Promise.all([
    db.from("profiles").select("id,full_name,email,phone,company,gstin,business_address,business_city").eq("id", userId).maybeSingle(),
    db.from("user_roles").select("role").eq("user_id", userId),
    db.from("addresses").select("label,name,phone,line,city,state,pin,landmark,is_default").eq("user_id", userId).order("is_default", { ascending: false }).order("created_at", { ascending: true }).limit(10),
    db.from("zoho_contact_links").select("zoho_contact_id").eq("user_id", userId).eq("contact_type", contactType).maybeSingle(),
  ]);
  if (profileError || rolesError || addressesError) throw new Error("Could not read Grain Bazar profile data for Zoho synchronization");
  if (!profile) throw new Error("Grain Bazar profile no longer exists");
  const allowedRole = (roles ?? []).some((r) => r.role === contactType || r.role === "admin");
  if (!allowedRole) return null;

  const email = profile.email?.trim() || `${(profile.phone || userId).replace(/[^0-9a-zA-Z]/g, "")}@shamibusiness.com`;

  const mainAddress = contactType === "vendor"
    ? (profile.business_address
        ? { address: profile.business_address, city: profile.business_city ?? "Bengaluru", state: "Karnataka", zip: "", country: "India", attention: profile.full_name || profile.company || "Vendor" }
        : addresses?.[0]
          ? { address: addresses[0].line, street2: addresses[0].landmark ?? "", city: addresses[0].city, state: addresses[0].state, zip: addresses[0].pin, country: "India", attention: addresses[0].name }
          : null)
    : addresses?.[0]
      ? { address: addresses[0].line, street2: addresses[0].landmark ?? "", city: addresses[0].city, state: addresses[0].state, zip: addresses[0].pin, country: "India", attention: addresses[0].name }
      : (profile.business_address
          ? { address: profile.business_address, city: profile.business_city ?? "Bengaluru", state: "Karnataka", zip: "", country: "India", attention: profile.full_name || "Customer" }
          : null);

  const name = profile.company?.trim() || profile.full_name?.trim() || email;
  const person = { ...splitContactName(profile.full_name || name), email, phone: profile.phone ?? "", mobile: profile.phone ?? "", is_primary_contact: true };
  const gstInfo = cleanAndValidateGstin(profile.gstin);
  const notesParts = [`Grain Bazar ${contactType} record · ID: ${userId}`];
  if (gstInfo.note) notesParts.push(gstInfo.note);

  const contact: Record<string, unknown> = {
    contact_type: contactType,
    contact_name: name,
    company_name: profile.company || undefined,
    contact_persons: [person],
    notes: notesParts.join(" | "),
    // Zoho allows "consumer" only on customers; an unregistered vendor is "business_none".
    gst_treatment: gstInfo.isValid ? "business_gst" : contactType === "vendor" ? "business_none" : "consumer",
    ...(gstInfo.isValid && gstInfo.gstin ? { gst_no: gstInfo.gstin } : {}),
    ...(gstInfo.placeOfContact ? { place_of_contact: gstInfo.placeOfContact } : {}),
    ...(mainAddress ? { billing_address: mainAddress, shipping_address: mainAddress } : {}),
  };

  let contactId = link?.zoho_contact_id ?? "";
  let zohoModifiedAt: string | null = null;
  if (!contactId) {
    const found = await inventoryRequest<{ contacts?: Record<string, unknown>[] }>(region, organizationId, token, "contacts", "GET", undefined, { email, per_page: "200" });
    const exact = (found.contacts ?? []).filter((row) => str(row["contact_type"]) === contactType && str(row["email"]).toLowerCase() === email.toLowerCase());
    if (exact.length > 1) throw new NeedsReviewError(`More than one Zoho ${contactType} contact matches ${email}`);
    if (exact.length === 1) contactId = str(exact[0]!["contact_id"]);
  }
  if (!contactId) {
    const created = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, "contacts", "POST", contact);
    contactId = str(created.contact?.["contact_id"]);
    zohoModifiedAt = str(created.contact?.["last_modified_time"]) || null;
    if (!contactId) throw new Error("Zoho created a contact but returned no contact ID");
  } else {
    const updated = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, `contacts/${encodeURIComponent(contactId)}`, "PUT", contact);
    zohoModifiedAt = str(updated.contact?.["last_modified_time"]) || null;
  }
  const { error: linkError } = await db.from("zoho_contact_links").upsert({ user_id: userId, contact_type: contactType, zoho_contact_id: contactId, updated_at: new Date().toISOString(), ...(zohoModifiedAt ? { last_zoho_modified_at: zohoModifiedAt } : {}) });
  if (linkError) throw new Error("Zoho contact synchronized, but its ID could not be saved in Grain Bazar");
  return contactId;
}

class NeedsReviewError extends Error {}

/**
 * State shared by every job in one sync run. Contact upserts are memoized per user and type,
 * so parallel jobs for the same vendor reuse one Zoho call instead of racing to create
 * duplicate contacts.
 */
type ZohoRunContext = { contacts: Map<string, Promise<string | null>> };

function newZohoRunContext(): ZohoRunContext {
  return { contacts: new Map() };
}

function upsertZohoContactOnce(
  ctx: ZohoRunContext,
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  userId: string,
  contactType: "customer" | "vendor",
) {
  const key = `${contactType}:${userId}`;
  let pending = ctx.contacts.get(key);
  if (!pending) {
    pending = upsertZohoContact(db, region, organizationId, token, userId, contactType);
    ctx.contacts.set(key, pending);
  }
  return pending;
}

/** Runs `worker` over `items` with at most `size` in flight, preserving nothing but completion. */
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

type CatalogProduct = Database["public"]["Tables"]["catalog_products"]["Row"];
type ZohoItemLink = {
  product_id: string;
  zoho_item_id: string;
  updated_at: string;
  last_polled_at: string | null;
  last_zoho_modified_at: string | null;
  app_fingerprint: string | null;
};

const zohoTaxCache = new Map<string, { at: number; taxes: Record<string, unknown>[] }>();

/**
 * Zoho India tax preferences for a GST slab: intra-state "GSTn" (CGST + SGST group) and
 * inter-state "IGSTn". Null when the organization has no matching pair, so the item keeps
 * whatever tax Zoho already has instead of failing the sync.
 */
async function zohoGstTaxPreferences(region: Region, organizationId: string, token: string, gst: number) {
  const key = `${region}:${organizationId}`;
  let cached = zohoTaxCache.get(key);
  if (!cached || Date.now() - cached.at > 10 * 60_000) {
    try {
      const result = await inventoryRequest<{ taxes?: Record<string, unknown>[] }>(
        region, organizationId, token, "settings/taxes", "GET",
      );
      cached = { at: Date.now(), taxes: result.taxes ?? [] };
      zohoTaxCache.set(key, cached);
    } catch {
      return null;
    }
  }
  const matches = (prefix: "GST" | "IGST") => cached!.taxes.filter((tax) =>
    Number(tax["tax_percentage"]) === gst &&
    new RegExp(`^${prefix}\\s*${gst}(\\b|\\s|$)`, "i").test(str(tax["tax_name"]).trim()));
  const intra = matches("GST");
  const inter = matches("IGST");
  if (intra.length !== 1 || inter.length !== 1) return null;
  return [
    { tax_id: str(intra[0]!["tax_id"]), tax_specification: "intra" },
    { tax_id: str(inter[0]!["tax_id"]), tax_specification: "inter" },
  ];
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function catalogSharedValues(product: CatalogProduct) {
  const payload = plainObject(product.payload);
  return {
    name: str(payload["name"]).trim(),
    sku: str(payload["sku"]).trim(),
    rate: finiteNumber(payload["price"]),
    purchaseRate: finiteNumber(payload["purchasePrice"]),
    reorderLevel: finiteNumber(payload["minimumStock"]),
    description: str(payload["description"]).trim(),
    image: str(payload["image"]).trim(),
    /** Grain Bazar is the stock master: Zoho stock on hand is adjusted to match this. */
    stock: finiteNumber(payload["stock"]),
    hsn: str(payload["hsn"]).trim(),
  };
}

/**
 * Zoho item details set from the admin product form (brand, manufacturer, unit, GST).
 * Null for products saved before that form existed, so their Zoho-side values are left alone.
 */
function catalogItemDetails(product: CatalogProduct) {
  const payload = plainObject(product.payload);
  const fromForm = payload["ratePricing"] !== undefined
    || payload["manufacturer"] !== undefined
    || payload["unit"] !== undefined;
  if (!fromForm) return null;
  return {
    brand: str(payload["brand"]).trim(),
    manufacturer: str(payload["manufacturer"]).trim(),
    unit: str(payload["unit"]).trim(),
    gst: finiteNumber(payload["gst"]),
  };
}

async function catalogFingerprint(product: CatalogProduct) {
  const shared = catalogSharedValues(product);
  const details = catalogItemDetails(product);
  const stable = JSON.stringify({
    vendorId: product.vendor_id,
    category: product.category,
    status: product.status,
    active: product.active,
    ...shared,
    // Older products keep their exact fingerprint, so Zoho-side edits are not flagged as conflicts.
    ...(details ? { details } : {}),
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(stable)));
  // The suffix identifies the image alone, so a sync can skip re-uploading an unchanged image.
  const imageDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(shared.image)));
  return `${b64(digest)}:${b64(imageDigest).slice(0, 16)}:${await editableDigest(product)}`;
}

/** The product fields Zoho may also edit (never stock: Grain Bazar is the stock master). */
function catalogEditableValues(product: CatalogProduct) {
  const payload = plainObject(product.payload);
  return {
    name: str(payload["name"]).trim(),
    sku: str(payload["sku"]).trim(),
    price: finiteNumber(payload["price"]),
    purchasePrice: finiteNumber(payload["purchasePrice"]),
    minimumStock: finiteNumber(payload["minimumStock"]),
    description: str(payload["description"]).trim(),
    active: product.active,
  };
}

function zohoEditableValues(item: Record<string, unknown>) {
  const status = str(item["status"]).toLowerCase();
  return {
    name: str(item["name"]).trim(),
    sku: str(item["sku"]).trim(),
    price: finiteNumber(item["rate"]),
    purchasePrice: finiteNumber(item["purchase_rate"]),
    minimumStock: finiteNumber(item["reorder_level"]),
    description: str(item["description"]).trim(),
    active: status ? status !== "inactive" : null,
  };
}

async function editableDigest(product: CatalogProduct) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify(catalogEditableValues(product)))));
  return b64(digest).slice(0, 22);
}

/**
 * Which side's item values are right when Zoho's copy differs from Grain Bazar's:
 * "same" (nothing to do), "zoho" (apply Zoho's edit here) or "app" (Grain Bazar's push wins).
 * If only Zoho changed since the last sync, Zoho wins; if both changed, the latest edit wins.
 */
async function zohoItemDecision(product: CatalogProduct, link: ZohoItemLink, item: Record<string, unknown>) {
  const zoho = zohoEditableValues(item);
  const app = catalogEditableValues(product);
  const differs = (Object.keys(zoho) as (keyof typeof zoho)[]).some((key) => {
    const value = zoho[key];
    return value !== null && value !== "" && value !== app[key];
  });
  if (!differs) return "same" as const;
  const parts = (link.app_fingerprint ?? "").split(":");
  if (parts.length >= 3 && parts[2] === await editableDigest(product)) return "zoho" as const;
  const zohoMs = Date.parse(str(item["last_modified_time"]));
  const appMs = Date.parse(product.updated_at);
  return Number.isFinite(zohoMs) && Number.isFinite(appMs) && zohoMs > appMs ? "zoho" as const : "app" as const;
}

/** Applies Zoho's item values (not stock) to the product; keeps a QTL rate in step with a new price. */
async function applyZohoItemToProduct(db: Awaited<ReturnType<typeof dbAdmin>>, product: CatalogProduct, item: Record<string, unknown>) {
  const { error } = await db.rpc("apply_zoho_catalog_item", {
    _product_id: product.id,
    _item: item as Json,
    _expected_updated_at: product.updated_at,
  });
  if (error) throw new Error("Zoho item was fetched, but Grain Bazar could not safely apply the update");
  const load = () => db.from("catalog_products")
    .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
    .eq("id", product.id).single();
  let { data: applied } = await load();
  if (!applied) throw new Error("Zoho item was applied, but Grain Bazar could not confirm the resulting product");
  const payload = plainObject(applied.payload);
  const rate = plainObject(payload["ratePricing"]);
  const price = finiteNumber(payload["price"]);
  if (price && isMeasureUnit(rate["packUnit"]) && isMeasureUnit(rate["basisUnit"]) && Number(rate["packQty"]) > 0 && Number(rate["basisQty"]) > 0) {
    const perBase = price / toBaseQuantity(Number(rate["packQty"]), rate["packUnit"]);
    const basisRate = Math.round(perBase * toBaseQuantity(Number(rate["basisQty"]), rate["basisUnit"]) * 100) / 100;
    if (basisRate !== Number(rate["basisRate"])) {
      await db.from("catalog_products")
        .update({ payload: { ...payload, ratePricing: { ...rate, basisRate } } as Json })
        .eq("id", product.id);
      applied = (await load()).data ?? applied;
    }
  }
  return applied;
}

/** Zoho -> Grain Bazar for one linked item (webhook, catch-up, daily run). */
type ZohoApiContext = { region: Region; organizationId: string; token: string };

const htmlToText = (html: string) => html
  .replace(/<br\s*\/?>(\s*)/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, "\n\n").trim();

/**
 * Edits made on the Zoho Commerce product page (description, variant reorder level) live on the
 * Commerce product, not on the inventory item. When that product changed after the last sync,
 * its values are folded into the item copy that is compared and applied.
 */
async function withCommerceProductValues(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  api: ZohoApiContext | undefined,
  link: ZohoItemLink,
  item: Record<string, unknown>,
  /** false for read-only diagnostics: do not move the "last seen" marker. */
  record = true,
) {
  if (!api) return item;
  const sku = str(item["sku"]).trim();
  let productId = "";
  let mirrorId = "";
  let mirrorPayload: Record<string, unknown> = {};
  if (sku) {
    const { data: mirror } = await db.from("catalog_products").select("id,payload")
      .like("id", "zoho-%").eq("payload->>sku", sku).limit(1).maybeSingle();
    mirrorId = mirror?.id ?? "";
    mirrorPayload = plainObject(mirror?.payload);
    productId = str(plainObject(mirrorPayload["zoho"])["productId"]);
  }
  productId ||= str(item["group_id"]);
  if (!productId) return item;
  try {
    const response = await commerceRequest<{ product?: Record<string, unknown> }>(
      api.region, api.organizationId, api.token, `products/${encodeURIComponent(productId)}`, "GET",
    );
    const product = response.product;
    if (!product) return item;
    const variants = (Array.isArray(product["variants"]) ? product["variants"] : []).map(plainObject);
    const variant = variants.find((v) => str(v["sku"]).trim().toLowerCase() === sku.toLowerCase()) ?? (variants.length === 1 ? variants[0] : undefined);
    const description = htmlToText(str(product["product_description"])) || htmlToText(str(product["product_short_description"]));
    const variantReorder = variant && str(variant["reorder_level"]) !== "" ? finiteNumber(variant["reorder_level"]) : null;

    // Zoho's product response has no modified time, and a product-page save does not always
    // move the item's. So Grain Bazar remembers the Commerce values it last saw (on the
    // product's Zoho Commerce copy) and treats any difference as a Zoho edit.
    const seen = plainObject(mirrorPayload["zohoSeen"]);
    const hasSeen = typeof seen["description"] === "string";
    // Field by field: only a field that changed since it was last seen is a Zoho edit. (A reorder
    // level Grain Bazar itself pushed must not make Zoho's unchanged description "win".)
    const descriptionChanged = hasSeen && seen["description"] !== description;
    const reorderChanged = hasSeen && (seen["reorderLevel"] ?? null) !== variantReorder;
    const productChanged = descriptionChanged || reorderChanged;
    if (record && mirrorId && (!hasSeen || productChanged)) {
      await db.from("catalog_products")
        .update({ payload: { ...mirrorPayload, zohoSeen: { description, reorderLevel: variantReorder, at: new Date().toISOString() } } as Json })
        .eq("id", mirrorId);
    }
    if (!productChanged) return item;
    return {
      ...item,
      ...(descriptionChanged && description ? { description } : {}),
      ...(reorderChanged && variantReorder !== null ? { reorder_level: variantReorder } : {}),
      // A description edit on the product page is seen now, so it is the latest edit. A reorder
      // change also edits the item, so the item's own modified time already covers it.
      ...(descriptionChanged ? { last_modified_time: new Date().toISOString() } : {}),
    };
  } catch {
    return item;
  }
}

async function applyZohoItemChange(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  link: ZohoItemLink,
  rawItem: Record<string, unknown>,
  api?: ZohoApiContext,
) {
  const item = await withCommerceProductValues(db, api, link, rawItem);
  const zohoModifiedAt = str(item["last_modified_time"]);
  const zohoMs = Date.parse(zohoModifiedAt);
  const knownMs = Date.parse(link.last_zoho_modified_at ?? "");
  if (!Number.isFinite(zohoMs) || (Number.isFinite(knownMs) && zohoMs <= knownMs)) {
    await db.from("zoho_item_links").update({ last_polled_at: new Date().toISOString() }).eq("product_id", link.product_id);
    return "unchanged" as const;
  }
  const { data: product } = await db.from("catalog_products")
    .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
    .eq("id", link.product_id).maybeSingle();
  if (!product) return "unchanged" as const;
  const decision = await zohoItemDecision(product, link, item);
  if (decision === "app") {
    // Grain Bazar's edit is newer: send it to Zoho now rather than taking Zoho's older value.
    await db.rpc("enqueue_zoho_sync", { _entity_type: "catalog", _entity_id: product.id });
    return "app_newer" as const;
  }
  const applied = decision === "zoho" ? await applyZohoItemToProduct(db, product, item) : product;
  const { error } = await db.from("zoho_item_links").update({
    updated_at: new Date().toISOString(),
    last_polled_at: new Date().toISOString(),
    last_zoho_modified_at: zohoModifiedAt,
    app_fingerprint: await catalogFingerprint(applied),
  }).eq("product_id", link.product_id);
  if (error) throw new Error("Zoho item was applied, but its reconciliation cursor could not be saved");
  return decision === "zoho" ? "applied" as const : "unchanged" as const;
}

function fingerprintImagePart(fingerprint: string | null | undefined) {
  return fingerprint?.split(":")[1] ?? "";
}

/**
 * Zoho's stock that is free to sell: on hand minus quantity committed to open sales orders.
 * Grain Bazar deducts stock when an order is placed, while Zoho only lowers stock on hand when
 * it ships, so this (not raw stock on hand) is what must equal Grain Bazar's stock.
 */
function zohoAvailableForSale(item: Record<string, unknown> | undefined) {
  if (!item) return 0;
  const direct = finiteNumber(item["actual_available_for_sale_stock"]) ?? finiteNumber(item["available_for_sale_stock"]);
  if (direct !== null) return direct;
  const onHand = finiteNumber(item["stock_on_hand"]) ?? 0;
  const committed = finiteNumber(item["actual_committed_stock"]) ?? finiteNumber(item["committed_stock"]) ?? 0;
  return onHand - committed;
}

function todayInIndia() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Brings Zoho's available-for-sale stock to Grain Bazar's stock with a quantity adjustment for
 * the difference. Idempotent: it is computed from the item's current stock, so re-running
 * never double-counts.
 */
async function syncZohoItemStock(
  region: Region,
  organizationId: string,
  token: string,
  itemId: string,
  sku: string,
  appStock: number,
  zohoAvailable: number,
) {
  const delta = Math.round((appStock - zohoAvailable) * 1000) / 1000;
  if (delta === 0) return;
  try {
    await inventoryRequest(region, organizationId, token, "inventoryadjustments", "POST", {
      date: todayInIndia(),
      reason: "Grain Bazar stock sync",
      adjustment_type: "quantity",
      description: `Set ${sku} available stock to ${appStock} to match Grain Bazar`,
      line_items: [{ item_id: itemId, quantity_adjusted: delta }],
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Zoho rejected the stock adjustment";
    const hint = /not authori[sz]ed/i.test(message)
      ? ' Click "Reauthorize Zoho" to grant the stock adjustment permission, then Retry.'
      : "";
    throw new NeedsReviewError(`Item details synced, but stock for ${sku} could not be set to ${appStock}: ${message}.${hint}`);
  }
}

async function uploadCatalogImageToZohoInventory(
  region: Region,
  organizationId: string,
  token: string,
  itemId: string,
  imageUrl: string,
) {
  if (!imageUrl) return;
  const supabaseBase = new URL(reqEnv("SUPABASE_URL"));
  let source: URL;
  try {
    source = new URL(imageUrl);
  } catch {
    // Local bundled placeholders are not user-uploaded product assets.
    if (imageUrl.startsWith("/")) return;
    throw new NeedsReviewError("Product image must be uploaded to ShamiBusiness catalog storage before Zoho sync");
  }
  if (source.origin !== supabaseBase.origin || !source.pathname.startsWith("/storage/v1/object/public/catalog-images/")) {
    throw new NeedsReviewError("Product image is not in ShamiBusiness catalog storage; upload it there before Zoho sync");
  }
  const response = await fetch(source, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`Could not read the saved product image (${response.status})`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const extensionByType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const extension = extensionByType[contentType];
  if (!extension) throw new NeedsReviewError("Zoho accepts JPG, PNG, WebP, or GIF product images; re-upload this image in a supported format");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 5 * 1024 * 1024) throw new NeedsReviewError("Product image is larger than the 5 MB ShamiBusiness upload limit");
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: contentType }), `product.${extension}`);
  const upload = await fetch(inventoryApi(region, `items/${encodeURIComponent(itemId)}/image`, organizationId), {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const result = (await upload.json()) as { code?: number; message?: string };
  if (!upload.ok || result.code !== 0) throw new Error(result.message ?? `Zoho Inventory image upload failed (${upload.status})`);
}

async function saveZohoReview(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  entityType: "customer" | "catalog" | "order",
  entityId: string,
  reason: string,
) {
  const { data: existing, error: existingError } = await db.from("zoho_sync_outbox").select("id")
    .eq("entity_type", entityType).eq("entity_id", entityId).eq("status", "needs_review")
    .limit(1).maybeSingle();
  if (existingError) throw new Error("Could not record the Zoho reconciliation review request");
  const update = { last_error: reason.slice(0, 1000), updated_at: new Date().toISOString() };
  const { error } = existing?.id
    ? await db.from("zoho_sync_outbox").update(update).eq("id", existing.id)
    : await db.from("zoho_sync_outbox").insert({
        entity_type: entityType,
        entity_id: entityId,
        event_type: "upsert",
        status: "needs_review",
        last_error: update.last_error,
      });
  if (error) throw new Error("Could not record the Zoho reconciliation review request");
}

async function syncZohoCatalogItem(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  productId: string,
  ctx: ZohoRunContext = newZohoRunContext(),
) {
  const { data: product, error: productError } = await db.from("catalog_products")
    .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
    .eq("id", productId).maybeSingle();
  if (productError) throw new Error("Could not read the Grain Bazar product for Zoho synchronization");
  if (!product) {
    const { data: tombstone, error: tombstoneError } = await db.from("zoho_catalog_tombstones")
      .select("product_id,zoho_item_id").eq("product_id", productId).maybeSingle();
    if (tombstoneError) throw new Error("Could not read the deleted Zoho item mapping");
    if (!tombstone) return;
    await inventoryRequest(region, organizationId, token,
      `items/${encodeURIComponent(tombstone.zoho_item_id)}/inactive`, "POST");
    const { error: deleteError } = await db.from("zoho_catalog_tombstones")
      .delete().eq("product_id", productId);
    if (deleteError) throw new Error("Zoho item was deactivated, but its deletion record could not be cleared");
    return;
  }
  if (product.vendor_id.startsWith("zoho:")) return;

  const { data: savedLink, error: savedLinkError } = await db.from("zoho_item_links")
    .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
    .eq("product_id", product.id).maybeSingle();
  if (savedLinkError) throw new Error("Could not read the saved Zoho item mapping");
  const link = savedLink as ZohoItemLink | null;
  const fingerprint = await catalogFingerprint(product);

  // A rejected or disabled marketplace product must never be sold as an
  // active item through Zoho. Existing links are retained for audit/recovery.
  if (product.status !== "approved" || !product.active) {
    if (link?.zoho_item_id) {
      await inventoryRequest(region, organizationId, token,
        `items/${encodeURIComponent(link.zoho_item_id)}/inactive`, "POST");
      const { error } = await db.from("zoho_item_links").update({
        updated_at: new Date().toISOString(), app_fingerprint: fingerprint,
      }).eq("product_id", product.id);
      if (error) throw new Error("Zoho item was deactivated, but its mapping could not be saved");
    }
    return;
  }

  if (link?.zoho_item_id) {
    const pre = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
    );
    if (pre.item && await applyZohoItemChange(db, link, pre.item, { region, organizationId, token }) === "applied") {
      // Zoho's edit is in Grain Bazar now; push from the updated product (stock and the rest).
      return syncZohoCatalogItem(db, region, organizationId, token, productId, ctx);
    }
  }

  const shared = catalogSharedValues(product);
  if (!shared.name) throw new NeedsReviewError(`Product ${product.id} has no name for Zoho Inventory`);
  if (!shared.sku) throw new NeedsReviewError(`Product ${shared.name} has no SKU for Zoho item matching`);
  if (shared.rate === null || shared.rate < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid selling price for Zoho Inventory`);
  if (shared.purchaseRate !== null && shared.purchaseRate < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid purchase price for Zoho Inventory`);
  if (shared.reorderLevel !== null && shared.reorderLevel < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid reorder level for Zoho Inventory`);

  if (shared.stock !== null && shared.stock < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has negative stock; correct it before Zoho sync`);

  let itemId = link?.zoho_item_id ?? "";

  // Unchanged since the last successful sync: confirm with one read and stop if Zoho still
  // matches, instead of rewriting the item, its status, image and vendor every time.
  if (itemId && link?.app_fingerprint === fingerprint) {
    const current = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "GET",
    );
    const item = current.item;
    const tracked = str(item?.["item_type"]) === "inventory";
    const zohoStock = zohoAvailableForSale(item);
    const inSync = !!item &&
      str(item["status"]) === "active" &&
      str(item["sku"]).trim().toLowerCase() === shared.sku.toLowerCase() &&
      finiteNumber(item["rate"]) === shared.rate &&
      (shared.stock === null || (tracked && zohoStock === shared.stock));
    if (inSync) {
      // The item is current, but the Commerce product page may still need the description.
      if (shared.description) {
        await pushCommerceDescription(db, { region, organizationId, token }, shared.sku, str(item?.["group_id"]), shared.description);
      }
      return;
    }
  }

  // Use the vendor's existing Zoho contact; only create/update it when none is linked yet.
  let vendorContactId: string | undefined;
  if (product.vendor_id) {
    const { data: vendor } = await db.from("profiles")
      .select("id").eq("vendor_id", product.vendor_id).maybeSingle();
    if (vendor) {
      const { data: vendorLink } = await db.from("zoho_contact_links")
        .select("zoho_contact_id").eq("user_id", vendor.id).eq("contact_type", "vendor").maybeSingle();
      if (vendorLink?.zoho_contact_id) vendorContactId = vendorLink.zoho_contact_id;
      else {
        try {
          const id = await upsertZohoContactOnce(ctx, db, region, organizationId, token, vendor.id, "vendor");
          if (id) vendorContactId = id;
        } catch (err) {
          console.warn(`Vendor contact sync skipped for product ${shared.sku}:`, err);
        }
      }
    }
  }

  const details = catalogItemDetails(product);
  const taxPreferences = details?.gst !== null && details?.gst !== undefined
    ? await zohoGstTaxPreferences(region, organizationId, token, details.gst)
    : null;
  const itemPayload: Record<string, unknown> = {
    ...(details?.brand ? { brand: details.brand } : {}),
    ...(details?.manufacturer ? { manufacturer: details.manufacturer } : {}),
    ...(details?.unit ? { unit: details.unit } : {}),
    ...(taxPreferences ? { item_tax_preferences: taxPreferences } : {}),
    name: shared.name,
    sku: shared.sku,
    rate: shared.rate,
    product_type: "goods",
    can_be_sold: true,
    can_be_purchased: true,
    ...(vendorContactId ? { vendor_id: vendorContactId } : {}),
    ...(shared.purchaseRate !== null ? { purchase_rate: shared.purchaseRate } : {}),
    ...(shared.reorderLevel !== null ? { reorder_level: shared.reorderLevel } : {}),
    ...(shared.description ? { description: shared.description } : {}),
    ...(shared.hsn ? { hsn_or_sac: shared.hsn } : {}),
  };

  if (!itemId) {
    const found = await inventoryRequest<{ items?: Record<string, unknown>[] }>(
      region, organizationId, token, "items", "GET", undefined,
      { search_text: shared.sku, per_page: "200" },
    );
    const matches = (found.items ?? []).filter((item) =>
      str(item["sku"]).trim().toLowerCase() === shared.sku.toLowerCase(),
    );
    if (matches.length > 1)
      throw new NeedsReviewError(`SKU ${shared.sku} matches multiple Zoho Inventory items`);
    if (matches.length === 1) itemId = str(matches[0]!["item_id"]);
  }

  let resultItem: Record<string, unknown> | undefined;
  let stockFollowUp: string | null = null;
  if (!itemId) {
    // New items are stock-tracked from the start and open with Grain Bazar's stock.
    const created = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, "items", "POST", {
        ...itemPayload,
        item_type: "inventory",
        unit: details?.unit || "pcs",
        ...(shared.stock !== null && shared.stock > 0 ? {
          initial_stock: shared.stock,
          initial_stock_rate: shared.purchaseRate ?? shared.rate,
        } : {}),
      },
    );
    resultItem = created.item;
    itemId = str(resultItem?.["item_id"]);
    if (!itemId) throw new Error("Zoho Inventory created an item but returned no item ID");
  } else {
    const updated = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "PUT", itemPayload,
    );
    resultItem = updated.item;
    // Items first created without stock tracking show a blank stock on hand; switch them on.
    if (shared.stock !== null && str(resultItem?.["item_type"]) !== "inventory") {
      try {
        const converted = await inventoryRequest<{ item?: Record<string, unknown> }>(
          region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "PUT", { item_type: "inventory" },
        );
        resultItem = converted.item ?? resultItem;
      } catch (cause) {
        stockFollowUp = `Turn on "Track Inventory" for ${shared.sku} in Zoho so its stock can sync (${
          cause instanceof Error ? cause.message : "Zoho refused the change"
        }).`;
      }
    }
    if (shared.stock !== null && !stockFollowUp && str(resultItem?.["item_type"]) === "inventory") {
      await syncZohoItemStock(
        region, organizationId, token, itemId, shared.sku, shared.stock, zohoAvailableForSale(resultItem),
      );
    }
  }
  if (str(resultItem?.["status"]) !== "active") {
    await inventoryRequest(region, organizationId, token,
      `items/${encodeURIComponent(itemId)}/active`, "POST");
  }
  if (!link || fingerprintImagePart(link.app_fingerprint) !== fingerprintImagePart(fingerprint)) {
    await uploadCatalogImageToZohoInventory(region, organizationId, token, itemId, shared.image);
  }
  const { error: linkError } = await db.from("zoho_item_links").upsert({
    product_id: product.id,
    zoho_item_id: itemId,
    updated_at: new Date().toISOString(),
    app_fingerprint: fingerprint,
    ...(str(resultItem?.["last_modified_time"]) ? {
      last_zoho_modified_at: str(resultItem?.["last_modified_time"]),
    } : {}),
  });
  if (linkError) throw new Error("Zoho item synchronized, but its Grain Bazar mapping could not be saved");
  if (shared.description) {
    await pushCommerceDescription(db, { region, organizationId, token }, shared.sku, str(resultItem?.["group_id"]), shared.description);
  }
  if (stockFollowUp) throw new NeedsReviewError(stockFollowUp);
}

const escapeHtml = (text: string) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Grain Bazar -> Zoho Commerce: shoppers read the description on the Commerce product page,
 * which is separate from the Inventory item's description. Writes it there when it differs,
 * then records it as "last seen" so the inbound check does not mistake it for a Zoho edit.
 * Never fails the item sync; a refusal is logged and the next push retries.
 */
async function pushCommerceDescription(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  api: ZohoApiContext,
  sku: string,
  groupId: string,
  description: string,
) {
  try {
    let productId = "";
    let mirrorId = "";
    let mirrorPayload: Record<string, unknown> = {};
    if (sku) {
      const { data: mirror } = await db.from("catalog_products").select("id,payload")
        .like("id", "zoho-%").eq("payload->>sku", sku).limit(1).maybeSingle();
      mirrorId = mirror?.id ?? "";
      mirrorPayload = plainObject(mirror?.payload);
      productId = str(plainObject(mirrorPayload["zoho"])["productId"]);
    }
    productId ||= groupId;
    if (!productId) return;
    const html = description.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    const asZohoShowsIt = htmlToText(html);
    const current = await commerceRequest<{ product?: Record<string, unknown> }>(
      api.region, api.organizationId, api.token, `products/${encodeURIComponent(productId)}`, "GET",
    );
    // Read exactly as the inbound check does (main description, else the short one).
    const zohoText = htmlToText(str(current.product?.["product_description"]))
      || htmlToText(str(current.product?.["product_short_description"]));
    const seen = plainObject(mirrorPayload["zohoSeen"]);
    // Latest edit wins: if Zoho's text changed since Grain Bazar last saw it, that Zoho edit has
    // not been pulled in yet; leave it for the inbound sync instead of overwriting it.
    if (typeof seen["description"] === "string" && seen["description"] !== zohoText && zohoText !== asZohoShowsIt) return;
    if (zohoText !== asZohoShowsIt) {
      await commerceRequest(
        api.region, api.organizationId, api.token, `products/${encodeURIComponent(productId)}`, "PUT",
        { product_description: html },
      );
    }
    if (mirrorId) {
      const { zohoCommerceWriteError: _cleared, ...cleanPayload } = mirrorPayload;
      await db.from("catalog_products").update({
        payload: { ...cleanPayload, zohoSeen: { description: asZohoShowsIt, reorderLevel: seen["reorderLevel"] ?? null, at: new Date().toISOString() } } as Json,
      }).eq("id", mirrorId);
    }
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
    console.warn(`Zoho Commerce description for ${sku} not updated; the next push retries:`, message);
    // Leave the reason on the product's Zoho Commerce copy so it can be seen and fixed.
    if (sku) {
      const { data: mirror } = await db.from("catalog_products").select("id,payload")
        .like("id", "zoho-%").eq("payload->>sku", sku).limit(1).maybeSingle();
      if (mirror) await db.from("catalog_products").update({
        payload: { ...plainObject(mirror.payload), zohoCommerceWriteError: { message, at: new Date().toISOString() } } as Json,
      }).eq("id", mirror.id);
    }
  }
}

type GrainBazarOrderItem = { product_id: string | null; product_name: string; sku: string | null; qty: number; unit_price: number; gst_rate: number };

/** Zoho line items for Grain Bazar order lines, matched to Zoho items by SKU. */
async function zohoLineItemsForOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  items: GrainBazarOrderItem[],
) {
  const lineItems: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!item.sku) throw new NeedsReviewError(`Product ${item.product_name} has no SKU for Zoho item matching`);
    const result = await inventoryRequest<{ items?: Record<string, unknown>[] }>(region, organizationId, token, "items", "GET", undefined, { search_text: item.sku, per_page: "200" });
    let matches = (result.items ?? []).filter((row) => str(row["sku"]).trim().toLowerCase() === item.sku?.trim().toLowerCase() && str(row["status"]).toLowerCase() !== "inactive");
    if (matches.length === 0 && item.product_id) {
      try {
        await syncZohoCatalogItem(db, region, organizationId, token, item.product_id);
        const retryResult = await inventoryRequest<{ items?: Record<string, unknown>[] }>(region, organizationId, token, "items", "GET", undefined, { search_text: item.sku, per_page: "200" });
        matches = (retryResult.items ?? []).filter((row) => str(row["sku"]).trim().toLowerCase() === item.sku?.trim().toLowerCase() && str(row["status"]).toLowerCase() !== "inactive");
      } catch (autoSyncErr) {
        console.warn(`Could not auto-sync catalog product ${item.sku} during order sync:`, autoSyncErr);
      }
    }
    if (matches.length !== 1) throw new NeedsReviewError(matches.length ? `SKU ${item.sku} matches multiple Zoho items` : `SKU ${item.sku} has no active Zoho Inventory item; map this product before order sync`);
    lineItems.push({ item_id: str(matches[0]!["item_id"]), name: item.product_name, quantity: item.qty, rate: item.unit_price, tax_percentage: item.gst_rate });
  }
  return lineItems;
}

const ZOHO_CLOSED_ORDER_STATES = ["void", "cancelled", "closed"];

/**
 * Grain Bazar -> Zoho for an order already in Zoho: a Grain Bazar cancellation voids the Zoho
 * order, a confirmed payment confirms a Zoho draft, and edited items/totals are written to Zoho.
 * A Zoho order that was voided or closed in Zoho is never reopened from here.
 */
async function syncLinkedZohoOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  items: GrainBazarOrderItem[],
) {
  const zohoId = order.zoho_salesorder_id!;
  const path = `salesorders/${encodeURIComponent(zohoId)}`;
  const load = async () => {
    const response = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, path, "GET");
    if (!response.salesorder) throw new Error(`Zoho did not return sales order ${zohoId}`);
    return response.salesorder;
  };
  let zoho = await load();
  const zohoStatus = () => str(zoho["order_status"] ?? zoho["status"]).toLowerCase();

  if (order.order_status === "Cancelled") {
    if (!["void", "cancelled"].includes(zohoStatus())) {
      await inventoryRequest(region, organizationId, token, `${path}/status/void`, "POST");
      zoho = await load();
    }
  } else if (ZOHO_CLOSED_ORDER_STATES.includes(zohoStatus())) {
    await saveZohoZohoState(db, order.id, zoho);
    throw new NeedsReviewError(`Zoho sales order ${str(zoho["salesorder_number"])} is ${zohoStatus()} in Zoho, but Grain Bazar order ${order.order_no} is ${order.order_status}. Cancel it in Grain Bazar or create a new Zoho order.`);
  } else {
    const zohoTotal = Number(zoho["total"]);
    const invoiced = str(zoho["invoiced_status"]).toLowerCase();
    if (Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 0.01) {
      if (invoiced && invoiced !== "not_invoiced" && invoiced !== "null")
        throw new NeedsReviewError(`Grain Bazar order ${order.order_no} changed to ₹${Number(order.total).toFixed(2)}, but Zoho sales order ${str(zoho["salesorder_number"])} is already invoiced at ₹${zohoTotal.toFixed(2)}. Adjust the invoice in Zoho.`);
      const lines = await zohoLineItemsForOrder(db, region, organizationId, token, items);
      // Keep Zoho's line IDs for items still on the order so Zoho updates them in place.
      const zohoLines = (Array.isArray(zoho["line_items"]) ? zoho["line_items"] : []).map(plainObject);
      const used = new Set<string>();
      const lineItems = lines.map((line) => {
        const match = zohoLines.find((z) => str(z["item_id"]) === line["item_id"] && !used.has(str(z["line_item_id"])));
        if (match) used.add(str(match["line_item_id"]));
        return match ? { ...line, line_item_id: str(match["line_item_id"]) } : line;
      });
      await inventoryRequest(region, organizationId, token, path, "PUT", {
        salesorder_number: str(zoho["salesorder_number"]),
        customer_id: str(zoho["customer_id"]),
        date: str(zoho["date"]),
        line_items: lineItems,
        discount: Number(order.discount) || 0,
        discount_type: "entity_level",
        is_discount_before_tax: true,
        shipping_charge: Number(order.shipping) || 0,
        is_inclusive_tax: false,
        ...(str(zoho["place_of_supply"]) ? { place_of_supply: str(zoho["place_of_supply"]) } : {}),
        ...(str(zoho["gst_treatment"]) ? { gst_treatment: str(zoho["gst_treatment"]) } : {}),
        ...(str(zoho["gst_no"]) ? { gst_no: str(zoho["gst_no"]) } : {}),
      }, { ignore_auto_number_generation: "true" });
      zoho = await load();
    }
    const confirmedInApp = !["Placed", "Awaiting Payment"].includes(order.order_status);
    if (confirmedInApp && zohoStatus() === "draft") {
      await inventoryRequest(region, organizationId, token, `${path}/status/confirmed`, "POST");
      zoho = await load();
    }
  }
  await saveZohoZohoState(db, order.id, zoho);
  await refreshSalesOrderSnapshotSafe(db, organizationId, zoho);
  const finalTotal = Number(zoho["total"]);
  if (order.order_status !== "Cancelled" && Number.isFinite(finalTotal) && Math.abs(finalTotal - Number(order.total)) > 2)
    throw new NeedsReviewError(`Zoho sales order ${str(zoho["salesorder_number"])} totals ₹${finalTotal.toFixed(2)}; Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Review taxes, discount and shipping.`);
}

/** Records Zoho's status and change time on the Grain Bazar order (shown in the admin). */
async function saveZohoZohoState(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string, zoho: Record<string, unknown>) {
  const modified = str(zoho["last_modified_time"]);
  await db.from("orders").update({
    zoho_order_status: str(zoho["order_status"] ?? zoho["status"]).toLowerCase() || null,
    ...(Number.isFinite(Date.parse(modified)) ? { zoho_last_modified_at: new Date(Date.parse(modified)).toISOString() } : {}),
  }).eq("id", orderId);
}

async function refreshSalesOrderSnapshotSafe(db: Awaited<ReturnType<typeof dbAdmin>>, organizationId: string, zoho: Record<string, unknown>) {
  try {
    await refreshSalesOrderSnapshot(db, organizationId, zoho);
  } catch {
    // The snapshot is a convenience copy; the next "Sync account data" refreshes it.
  }
}

/** Zoho shipment progress as a Grain Bazar status, from packages or the order's shipped status. */
function zohoFulfillmentStatus(zoho: Record<string, unknown>): "Dispatched" | "Delivered" | null {
  const packages = Array.isArray(zoho["packages"]) ? zoho["packages"] as Record<string, unknown>[] : [];
  const statuses = packages.map((pkg) => {
    const shipment = pkg["shipment_order"];
    return shipment && typeof shipment === "object"
      ? str((shipment as Record<string, unknown>)["status"]).toLowerCase()
      : str(pkg["status"]).toLowerCase();
  });
  statuses.push(str(zoho["shipped_status"]).toLowerCase());
  if (statuses.includes("delivered")) return "Delivered";
  if (statuses.some((status) => ["shipped", "in_transit", "in transit", "fulfilled"].includes(status))) return "Dispatched";
  return null;
}

/**
 * Zoho -> Grain Bazar for one Zoho sales order (from a webhook, the catch-up check or the daily
 * run). Applied once per Zoho change. Void/cancel cancels the Grain Bazar order when its rules
 * allow it (before dispatch, nothing paid); shipments move it to Dispatched/Delivered; anything
 * that would change money or contradict a later Grain Bazar state is flagged for review instead.
 */
async function applyZohoSalesOrderToApp(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  organizationId: string,
  zoho: Record<string, unknown>,
): Promise<string> {
  const zohoId = str(zoho["salesorder_id"]);
  const number = str(zoho["salesorder_number"]);
  if (!zohoId) return "ignored";
  const columns = "id,order_no,order_status,total,zoho_salesorder_id,zoho_last_modified_at";
  let { data: order } = await db.from("orders").select(columns).eq("zoho_salesorder_id", zohoId).maybeSingle();
  if (!order && number.startsWith("GB-")) {
    const byNumber = await db.from("orders").select(columns).eq("order_no", number.slice(3)).is("zoho_salesorder_id", null).maybeSingle();
    order = byNumber.data;
    if (order) await db.from("orders").update({ zoho_salesorder_id: zohoId }).eq("id", order.id).is("zoho_salesorder_id", null);
  }
  if (!order) return "not_grain_bazar";

  const modifiedMs = Date.parse(str(zoho["last_modified_time"]));
  const knownMs = Date.parse(order.zoho_last_modified_at ?? "");
  if (Number.isFinite(modifiedMs) && Number.isFinite(knownMs) && modifiedMs <= knownMs) return "unchanged";

  const status = str(zoho["order_status"] ?? zoho["status"]).toLowerCase();
  let outcome = "recorded";
  if (["void", "cancelled"].includes(status) && order.order_status !== "Cancelled") {
    const { data: result, error } = await db.rpc("apply_zoho_order_cancellation", { _order_id: order.id });
    if (error || (result && result.startsWith("blocked"))) {
      const why = error?.message
        ?? (result === "blocked_paid" ? "a payment was received (refund it first)" : `it is already ${order.order_status}`);
      await saveZohoReview(db, "order", order.id, `Zoho sales order ${number} was ${status === "void" ? "voided" : "cancelled"} in Zoho, but Grain Bazar order ${order.order_no} was not cancelled because ${why}. Decide which is right and correct the other side.`);
      outcome = "review";
    } else {
      outcome = "cancelled";
    }
  } else if (order.order_status !== "Cancelled") {
    const fulfillment = zohoFulfillmentStatus(zoho);
    if (fulfillment && fulfillment !== order.order_status) {
      const { error } = await db.rpc("apply_zoho_order_fulfillment", { _order_id: order.id, _status: fulfillment });
      if (!error) outcome = fulfillment.toLowerCase();
    }
    const zohoTotal = Number(zoho["total"]);
    if (!["void", "cancelled"].includes(status) && Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 2) {
      await saveZohoReview(db, "order", order.id, `Zoho sales order ${number} now totals ₹${zohoTotal.toFixed(2)}, but Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Items or prices were changed in Zoho; make the same change in Grain Bazar (or undo it in Zoho).`);
      outcome = "review";
    }
  }
  await saveZohoZohoState(db, order.id, zoho);
  await refreshSalesOrderSnapshotSafe(db, organizationId, zoho);
  return outcome;
}

/** Catch-up for Zoho -> Grain Bazar: applies the most recently changed Zoho sales orders. */
async function applyRecentZohoOrderChanges(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
) {
  const result = await inventoryRequest<{ salesorders?: Record<string, unknown>[] }>(
    region, organizationId, token, "salesorders", "GET", undefined,
    { sort_column: "last_modified_time", sort_order: "D", per_page: "50", search_text: "GB-" },
  );
  const summary = { checked: 0, changed: 0 };
  for (const row of result.salesorders ?? []) {
    if (!str(row["salesorder_number"]).startsWith("GB-")) continue;
    summary.checked += 1;
    try {
      // Fetch the full order (packages, line items) before applying it.
      const full = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
        region, organizationId, token, `salesorders/${encodeURIComponent(str(row["salesorder_id"]))}`, "GET",
      );
      const outcome = await applyZohoSalesOrderToApp(db, organizationId, full.salesorder ?? row);
      if (!["unchanged", "not_grain_bazar", "ignored"].includes(outcome)) summary.changed += 1;
    } catch (cause) {
      console.warn(`Could not apply Zoho sales order ${str(row["salesorder_number"])}:`, cause);
    }
  }
  return summary;
}

async function zohoOrderContext(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data: connection, error } = await db
    .from("zoho_commerce_connection")
    .select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag")
    .eq("id", true)
    .maybeSingle();
  if (error || !connection) throw new Error("Connect Zoho first");
  const region = connection.region as Region;
  return { region, organizationId: connection.organization_id, token: await accessToken(region, await decrypt(connection)) };
}

/** Shared secret in the webhook address, so only Zoho (holding the address) can call it. */
export async function zohoWebhookKey() {
  // v2: the v1 key was exposed on 2026-10-17 and no longer works.
  return (await sign("zoho-order-webhook-v2")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "").slice(0, 40);
}

/** Webhook entry point: re-reads the order from Zoho (never trusting the payload) and applies it. */
export async function handleZohoOrderWebhook(salesOrderId: string) {
  const db = await dbAdmin();
  const { region, organizationId, token } = await zohoOrderContext(db);
  const response = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
    region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}`, "GET",
  );
  if (!response.salesorder) return "missing";
  return applyZohoSalesOrderToApp(db, organizationId, response.salesorder);
}

/** Pushes products to Zoho now and settles their queued catalog jobs. */
async function syncCatalogProductsDirect(db: Awaited<ReturnType<typeof dbAdmin>>, productIds: string[]) {
  const { region, organizationId, token } = await zohoOrderContext(db);
  const runCtx = newZohoRunContext();
  const outcome = { pushed: 0, review: 0 };
  for (const productId of [...new Set(productIds)].slice(0, 20)) {
    const settle = (status: "complete" | "needs_review", message: string | null) => db.from("zoho_sync_outbox")
      .update({ status, last_error: message, updated_at: new Date().toISOString() })
      .eq("entity_type", "catalog").eq("entity_id", productId).in("status", ["pending", "failed"]);
    try {
      await syncZohoCatalogItem(db, region, organizationId, token, productId, runCtx);
      await settle("complete", null);
      outcome.pushed += 1;
    } catch (cause) {
      const message = (cause instanceof Error ? cause.message : "Zoho rejected the product").slice(0, 900);
      await settle("needs_review", message);
      outcome.review += 1;
    }
  }
  return outcome;
}

/** The signed-in user's vendor ID, or null when they are not a vendor. */
async function callerVendorId(db: Awaited<ReturnType<typeof dbAdmin>>, userId: string) {
  const { data } = await db.from("profiles").select("vendor_id").eq("id", userId).maybeSingle();
  return data?.vendor_id ?? null;
}

/**
 * Who may trigger an instant Zoho push for an order: the customer who placed it, an admin,
 * or a vendor with a line in it (vendor fulfilment updates change the order too).
 */
async function mayPushOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  userId: string,
  isAdmin: () => Promise<boolean>,
  order: { id: string; user_id: string | null },
) {
  if (order.user_id === userId) return true;
  if (await isAdmin()) return true;
  const vendorId = await callerVendorId(db, userId);
  if (!vendorId) return false;
  const { count } = await db.from("order_items").select("id", { count: "exact", head: true })
    .eq("order_id", order.id).eq("vendor_id", vendorId);
  return (count ?? 0) > 0;
}

/** After checkout or a status change: the order's products changed stock; send them to Zoho now. */
export const pushOrderStockToZoho = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    const db = await dbAdmin();
    const { data: order } = await db.from("orders").select("id,user_id").eq("order_no", data.orderNo).maybeSingle();
    if (!order) return { pushed: 0 };
    const isAdmin = async () => !!(await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" })).data;
    if (!(await mayPushOrder(db, context.userId, isAdmin, order))) return { pushed: 0 };
    if (!(await isZohoWriteSyncActive(db))) return { pushed: 0 };
    const { data: items } = await db.from("order_items").select("product_id").eq("order_id", order.id);
    const ids = (items ?? []).map((item) => item.product_id).filter((id): id is string => !!id);
    try {
      return await syncCatalogProductsDirect(db, ids);
    } catch {
      return { pushed: 0 };
    }
  });

/** Admin or vendor product edits: send them to Zoho now instead of waiting for the daily run. */
export const pushProductChangeToZoho = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ productIds: z.array(z.string().trim().min(1).max(80)).min(1).max(20) }))
  .handler(async ({ data, context }) => {
    const db = await dbAdmin();
    const { data: isAdmin } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) {
      // A vendor may push only their own products.
      const vendorId = await callerVendorId(db, context.userId);
      if (!vendorId) return { pushed: 0, review: 0 };
      const { data: owned } = await db.from("catalog_products").select("id").in("id", data.productIds).eq("vendor_id", vendorId);
      if ((owned ?? []).length !== new Set(data.productIds).size) return { pushed: 0, review: 0 };
    }
    if (!(await isZohoWriteSyncActive(db))) return { pushed: 0, review: 0 };
    return syncCatalogProductsDirect(db, data.productIds);
  });

/** Webhook entry point for Zoho items: re-reads the item from Zoho and applies it. */
export async function handleZohoItemWebhook(itemId: string) {
  const db = await dbAdmin();
  const { data: link } = await db.from("zoho_item_links")
    .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
    .eq("zoho_item_id", itemId).maybeSingle();
  if (!link) return "not_grain_bazar";
  const { region, organizationId, token } = await zohoOrderContext(db);
  const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
    region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "GET",
  );
  if (!response.item) return "missing";
  return applyZohoItemChange(db, link as ZohoItemLink, response.item, { region, organizationId, token });
}

/** Catch-up for Zoho -> Grain Bazar items: applies the most recently changed linked items. */
async function applyRecentZohoItemChanges(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string) {
  // All linked items (the catalogue is small); Zoho's item list does not sort by modified time.
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await inventoryRequest<{ items?: Record<string, unknown>[] }>(
      region, organizationId, token, "items", "GET", undefined, { page: String(page), per_page: "200" },
    );
    rows.push(...(result.items ?? []));
    if ((result.items ?? []).length < 200) break;
  }
  const ids = rows.map((row) => str(row["item_id"])).filter(Boolean);
  if (!ids.length) return { checked: 0, changed: 0 };
  const { data: links } = await db.from("zoho_item_links")
    .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
    .in("zoho_item_id", ids);
  const summary = { checked: 0, changed: 0 };
  for (const link of (links ?? []) as ZohoItemLink[]) {
    const row = rows.find((item) => str(item["item_id"]) === link.zoho_item_id);
    summary.checked += 1;
    void row;
    try {
      const full = await inventoryRequest<{ item?: Record<string, unknown> }>(
        region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
      );
      if (full.item && await applyZohoItemChange(db, link, full.item, { region, organizationId, token }) === "applied") summary.changed += 1;
    } catch (cause) {
      console.warn(`Could not apply Zoho item ${link.zoho_item_id}:`, cause);
    }
  }
  return summary;
}

/** Admin diagnostics: how one product compares with its Zoho item, and what a sync would do. */
export const inspectZohoProductSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ productId: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: link } = await db.from("zoho_item_links")
      .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
      .eq("product_id", data.productId).maybeSingle();
    const { data: product } = await db.from("catalog_products")
      .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
      .eq("id", data.productId).maybeSingle();
    if (!link || !product) return JSON.stringify({ link, product: !!product });
    const { region, organizationId, token } = await zohoOrderContext(db);
    const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
    );
    const item = response.item ?? {};
    // Returned as text: Zoho's raw values are untyped.
    return JSON.stringify({
      link: { ...link, app_fingerprint_parts: (link.app_fingerprint ?? "").split(":").length },
      productUpdatedAt: product.updated_at,
      app: catalogEditableValues(product),
      zoho: zohoEditableValues(item),
      zohoRaw: {
        last_modified_time: item["last_modified_time"],
        reorder_level: item["reorder_level"],
        descriptionFields: Object.fromEntries(Object.entries(item)
          .filter(([key, value]) => /desc|reorder/i.test(key) && (typeof value === "string" || typeof value === "number"))
          .map(([key, value]) => [key, String(value).slice(0, 300)])),
        locations: Array.isArray(item["locations"])
          ? (item["locations"] as Record<string, unknown>[]).map((l) => ({ name: l["location_name"], reorder: l["location_reorder_level"] ?? l["reorder_level"] }))
          : undefined,
      },
      editableDigestNow: await editableDigest(product),
      savedDigest: (link.app_fingerprint ?? "").split(":")[2] ?? null,
      decision: await zohoItemDecision(product, link as ZohoItemLink, item),
      withCommerce: zohoEditableValues(await withCommerceProductValues(db, { region, organizationId, token }, link as ZohoItemLink, item, false)),
      commerceProduct: await (async () => {
        const sku = str(item["sku"]).trim();
        const { data: mirror } = await db.from("catalog_products").select("id,payload")
          .like("id", "zoho-%").eq("payload->>sku", sku).limit(1).maybeSingle();
        const productId = str(plainObject(plainObject(mirror?.payload)["zoho"])["productId"]) || str(item["group_id"]);
        if (!productId) return { found: false, mirrorRow: mirror?.id ?? null, groupId: item["group_id"] ?? null };
        try {
          const response = await commerceRequest<{ product?: Record<string, unknown> }>(region, organizationId, token, `products/${encodeURIComponent(productId)}`, "GET");
          const product = response.product ?? {};
          return {
            found: true, productId, mirrorRow: mirror?.id ?? null, groupId: item["group_id"] ?? null,
            last_modified_time: product["last_modified_time"],
            product_description: str(product["product_description"]).slice(0, 300),
            product_short_description: str(product["product_short_description"]).slice(0, 300),
            descriptionText: htmlToText(str(product["product_description"])) || htmlToText(str(product["product_short_description"])),
            lastSeen: plainObject(mirror?.payload)["zohoSeen"] ?? null,
            variants: (Array.isArray(product["variants"]) ? product["variants"] : []).map(plainObject)
              .map((v) => ({ sku: v["sku"], reorder_level: v["reorder_level"], rate: v["rate"] })),
          };
        } catch (cause) {
          return { found: false, productId, error: cause instanceof Error ? cause.message : "error" };
        }
      })(),
    });
  });

/** Admin: pull Zoho-side order changes now (run when the admin opens Orders or Zoho pages). */
export const syncZohoOrderChangesNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const [orders, items] = await Promise.all([
      applyRecentZohoOrderChanges(db, region, organizationId, token),
      applyRecentZohoItemChanges(db, region, organizationId, token)
        .then((result) => ({ ...result, error: "" }))
        .catch((cause: unknown) => ({ checked: 0, changed: 0, error: cause instanceof Error ? cause.message : "Zoho items could not be read" })),
    ]);
    return {
      checked: orders.checked + items.checked,
      changed: orders.changed + items.changed,
      ordersChanged: orders.changed,
      itemsChecked: items.checked,
      itemsChanged: items.changed,
      itemsError: items.error,
    };
  });

/**
 * Admin: the protected webhook address, for a Zoho Books/Inventory Workflow Rule
 * (Sales Order, created or edited -> webhook) when Commerce webhooks are not available.
 */
export const getZohoWebhookAddress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const origin = new URL(reqEnv("ZOHO_REDIRECT_URI")).origin;
    return { url: `${origin}/api/zoho/webhook?key=${await zohoWebhookKey()}` };
  });

/** Admin: ask Zoho Commerce to call Grain Bazar the moment a sales order changes. */
export const registerZohoOrderWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const origin = new URL(reqEnv("ZOHO_REDIRECT_URI")).origin;
    const url = `${origin}/api/zoho/webhook?key=${await zohoWebhookKey()}`;
    try {
      const existing = await commerceRequest<{ webhooks?: Record<string, unknown>[] }>(region, organizationId, token, "settings/webhooks", "GET")
        .catch(() => ({ webhooks: [] as Record<string, unknown>[] }));
      if ((existing.webhooks ?? []).some((hook) => str(hook["url"]).startsWith(`${origin}/api/zoho/webhook`)))
        return { registered: true, already: true };
      await commerceRequest(region, organizationId, token, "settings/webhooks", "POST", {
        url,
        events: [
          "salesorder.created", "salesorder.confirmed", "salesorder.cancelled",
          "salesorder.declined", "salesorder.shipped", "salesorder.delivered",
        ],
      });
      return { registered: true, already: false };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Zoho refused the webhook";
      throw new Error(`${message}${zohoPermissionHint(message)}`);
    }
  });

/** Zoho location of the pickup godown serving the order's PIN code ("" when none is set). */
/** The Zoho location (warehouse) of the order's godown branch; the old pickup setting as a fallback. */
async function zohoLocationForOrder(db: Awaited<ReturnType<typeof dbAdmin>>, shippingAddress: Json | null, branchId?: string | null) {
  if (branchId) {
    const { data: branch } = await db.from("branches").select("zoho_location_id").eq("id", branchId).maybeSingle();
    if (branch?.zoho_location_id) return branch.zoho_location_id;
  }
  const address = plainObject(shippingAddress);
  const pin = str(address["pin"] ?? address["zip"]);
  const { data } = await db.from("settings").select("value").eq("key", PICKUP_SETTINGS_KEY).maybeSingle();
  if (!data) return "";
  return pickupPointForPin(parsePickupSettings(data.value), pin)?.zohoLocationId ?? "";
}

/** Admin: Zoho Inventory locations (warehouses), for linking a pickup godown. */
export const listZohoLocations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    try {
      const result = await inventoryRequest<{ locations?: Record<string, unknown>[] }>(region, organizationId, token, "locations", "GET");
      return (result.locations ?? []).map((location) => ({
        id: str(location["location_id"]),
        name: str(location["location_name"]),
      })).filter((location) => location.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Zoho refused the location list";
      throw new Error(`${message}${zohoPermissionHint(message)}`);
    }
  });

async function findZohoSalesOrdersByNumber(region: Region, organizationId: string, token: string, salesOrderNumber: string) {
  const result = await inventoryRequest<{ salesorders?: Record<string, unknown>[] }>(
    region, organizationId, token, "salesorders", "GET", undefined,
    { salesorder_number: salesOrderNumber, per_page: "200" },
  );
  return (result.salesorders ?? []).filter((row) => str(row["salesorder_number"]) === salesOrderNumber);
}

/** Inventory and Commerce share one organization; a pushed order must also be listed in Commerce > Orders. */
async function assertVisibleInZohoCommerce(region: Region, organizationId: string, token: string, salesOrderId: string, salesOrderNumber: string) {
  try {
    await commerceRequest(region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}`, "GET");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown error";
    throw new NeedsReviewError(`Sales order ${salesOrderNumber} was created in Zoho Inventory (ID ${salesOrderId}) but Zoho Commerce did not return it: ${message}.${zohoPermissionHint(message)}`);
  }
}

async function syncZohoOrder(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string, job: ZohoSyncJob) {
  const orderId = job.entity_id;
  const [{ data: order, error: orderError }, { data: items, error: itemsError }] = await Promise.all([
    db.from("orders").select("*").eq("id", orderId).maybeSingle(),
    db.from("order_items").select("product_id,product_name,sku,qty,unit_price,gst_rate,line_total").eq("order_id", orderId),
  ]);
  if (orderError || itemsError) throw new Error("Could not read the order and items from Grain Bazar");
  if (!order) return;
  if (order.zoho_salesorder_id) {
    await syncLinkedZohoOrder(db, region, organizationId, token, order, items ?? []);
    return;
  }
  let customerId = "";
  if (order.user_id) {
    try {
      customerId = (await upsertZohoContact(db, region, organizationId, token, order.user_id, "customer")) ?? "";
    } catch {
      // Continue to direct contact lookup/creation from order details
    }
  }
  if (!customerId) {
    const orderEmail = order.customer_email?.trim() || `${(order.customer_phone || "customer").replace(/[^0-9]/g, "")}@shamibusiness.com`;
    const found = await inventoryRequest<{ contacts?: Record<string, unknown>[] }>(region, organizationId, token, "contacts", "GET", undefined, { email: orderEmail, per_page: "200" });
    const exact = (found.contacts ?? []).filter((row) => str(row["contact_type"]) === "customer" && str(row["email"]).toLowerCase() === orderEmail.toLowerCase());
    if (exact.length >= 1) {
      customerId = str(exact[0]!["contact_id"]);
    } else {
      const shippingAddr = typeof order.shipping_address === "object" && order.shipping_address !== null
        ? order.shipping_address as Record<string, unknown>
        : {};
      const gstInfo = cleanAndValidateGstin(order.customer_gstin);
      const directNotes = [`Grain Bazar direct order contact`];
      if (gstInfo.note) directNotes.push(gstInfo.note);

      const directContact: Record<string, unknown> = {
        contact_type: "customer",
        contact_name: order.customer_name?.trim() || orderEmail,
        contact_persons: [{
          ...splitContactName(order.customer_name || "Customer"),
          email: orderEmail,
          phone: order.customer_phone ?? "",
          mobile: order.customer_phone ?? "",
          is_primary_contact: true,
        }],
        notes: directNotes.join(" | "),
        gst_treatment: gstInfo.isValid ? "business_gst" : "consumer",
        ...(gstInfo.isValid && gstInfo.gstin ? { gst_no: gstInfo.gstin } : {}),
        ...(gstInfo.placeOfContact ? { place_of_contact: gstInfo.placeOfContact } : {}),
        billing_address: {
          address: str(shippingAddr["line"] || shippingAddr["address"] || "Direct Order"),
          city: str(shippingAddr["city"] || "Bengaluru"),
          state: str(shippingAddr["state"] || "Karnataka"),
          zip: str(shippingAddr["pin"] || shippingAddr["zip"] || ""),
          country: "India",
          attention: order.customer_name || "Customer",
        },
        shipping_address: {
          address: str(shippingAddr["line"] || shippingAddr["address"] || "Direct Order"),
          city: str(shippingAddr["city"] || "Bengaluru"),
          state: str(shippingAddr["state"] || "Karnataka"),
          zip: str(shippingAddr["pin"] || shippingAddr["zip"] || ""),
          country: "India",
          attention: order.customer_name || "Customer",
        },
      };
      const created = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, "contacts", "POST", directContact);
      customerId = str(created.contact?.["contact_id"]);
    }
  }
  if (!customerId) throw new NeedsReviewError("Could not resolve or create Zoho customer contact for order");
  if (!items?.length) throw new NeedsReviewError("Order has no line items");

  const lineItems = await zohoLineItemsForOrder(db, region, organizationId, token, items);
  const safeNumber = zohoOrderNumber(order.order_no);
  // A previous request may have reached Zoho even if the response was lost.
  // On retries, search Zoho first by the unique sales-order number.
  if (job.attempts > 1) {
    const matches = await findZohoSalesOrdersByNumber(region, organizationId, token, safeNumber);
    if (matches.length > 1) throw new NeedsReviewError(`More than one Zoho sales order uses ${safeNumber}`);
    if (matches.length === 1) {
      const existingId = str(matches[0]!["salesorder_id"]);
      const { error: saveExistingError } = await db.from("orders").update({ zoho_salesorder_id: existingId }).eq("id", order.id).is("zoho_salesorder_id", null);
      if (saveExistingError) throw new Error("Existing Zoho order found but its ID could not be recorded");
      return;
    }
  }
  const orderGstInfo = cleanAndValidateGstin(order.customer_gstin);
  const notesParts = [
    `Grain Bazar order ${order.order_no}; payment ${order.payment_status}; app total ₹${Number(order.total).toFixed(2)}. Verify tax treatment and total in Zoho before invoicing.`,
  ];
  if (orderGstInfo.note) notesParts.push(orderGstInfo.note);

  // Pickup orders are created under the godown's Zoho location, so stock leaves that warehouse.
  const locationId = await zohoLocationForOrder(db, order.shipping_address, (order as { branch_id?: string | null }).branch_id);
  const payload: Record<string, unknown> = {
    ...(locationId ? { location_id: locationId } : {}),
    salesorder_number: safeNumber,
    reference_number: String(order.order_no).slice(0, 100),
    customer_id: customerId,
    date: datePart(order.created_at, new Date().toISOString().slice(0, 10)),
    line_items: locationId ? lineItems.map((line) => ({ ...line, location_id: locationId })) : lineItems,
    discount: Number(order.discount) || 0,
    discount_type: "entity_level",
    is_discount_before_tax: true,
    shipping_charge: Number(order.shipping) || 0,
    is_inclusive_tax: false,
    notes: notesParts.join(" "),
    gst_treatment: orderGstInfo.isValid ? "business_gst" : "consumer",
    ...(orderGstInfo.isValid && orderGstInfo.gstin ? { gst_no: orderGstInfo.gstin } : {}),
    ...(orderGstInfo.placeOfContact ? { place_of_supply: orderGstInfo.placeOfContact } : {}),
  };
  const created = await createSalesOrderWithChannel(region, organizationId, token, payload);
  const salesOrderId = str(created.salesorder?.["salesorder_id"]);
  if (!salesOrderId) throw new Error("Zoho created a sales order but returned no salesorder_id");
  const { error: saveError } = await db.from("orders").update({ zoho_salesorder_id: salesOrderId }).eq("id", order.id).is("zoho_salesorder_id", null);
  if (saveError) throw new Error("Zoho sales order created, but its ID could not be stored; retry will check Zoho's unique order number");
  await saveZohoZohoState(db, order.id, created.salesorder ?? {});
  await assertVisibleInZohoCommerce(region, organizationId, token, salesOrderId, safeNumber);
  const zohoTotal = Number(created.salesorder?.["total"]);
  if (Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 2.00)
    throw new NeedsReviewError(`Zoho accepted order ${safeNumber}, but total ₹${zohoTotal.toFixed(2)} differs from Grain Bazar ₹${Number(order.total).toFixed(2)}. Review taxes, discount, and shipping before processing.`);
}


/**
 * Zoho accepts only its own sales channel values (API orders are "Direct Sales"), so Grain Bazar
 * orders carry a sales-order custom field instead: label "Order Channel" (API name
 * cf_order_channel), value "GrainBazar". Add that field once in Zoho (Settings > Preferences >
 * Sales Orders > Field Customization) and show it as a column in the Orders list.
 */
export const ZOHO_CHANNEL_FIELD = "cf_order_channel";
export const ZOHO_CHANNEL_VALUE = "GrainBazar";
const channelCustomFields = [{ api_name: ZOHO_CHANNEL_FIELD, value: ZOHO_CHANNEL_VALUE }];
const isCustomFieldError = (cause: unknown) => /custom ?field|cf_|api_name|invalid.*field/i.test(cause instanceof Error ? cause.message : String(cause));

/** Creates the sales order with the channel field; if the field does not exist in Zoho yet, without it. */
async function createSalesOrderWithChannel(region: Region, organizationId: string, token: string, payload: Record<string, unknown>) {
  try {
    return await inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, "salesorders", "POST",
      { ...payload, custom_fields: channelCustomFields }, { ignore_auto_number_generation: "true" });
  } catch (cause) {
    if (!isCustomFieldError(cause)) throw cause;
    console.warn(`Zoho has no "${ZOHO_CHANNEL_FIELD}" sales order field yet; order created without the channel mark.`);
    return inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, "salesorders", "POST",
      payload, { ignore_auto_number_generation: "true" });
  }
}

/** Admin: marks every existing Grain Bazar sales order in Zoho with Order Channel = GrainBazar. */
export const markZohoOrdersChannel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const { data: rows } = await db.from("orders").select("order_no,zoho_salesorder_id").not("zoho_salesorder_id", "is", null);
    const result = { marked: 0, skipped: [] as string[], fieldMissing: false };
    for (const row of rows ?? []) {
      try {
        await inventoryRequest(region, organizationId, token, `salesorders/${encodeURIComponent(row.zoho_salesorder_id!)}`, "PUT",
          { custom_fields: channelCustomFields });
        result.marked += 1;
      } catch (cause) {
        if (isCustomFieldError(cause)) { result.fieldMissing = true; break; }
        result.skipped.push(`${row.order_no}: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 160));
      }
    }
    return JSON.stringify(result, null, 2);
  });

async function syncZohoCustomer(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  userId: string,
  ctx: ZohoRunContext = newZohoRunContext(),
) {
  const { data: roles, error } = await db.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error("Could not verify the Grain Bazar account role");
  let synced = false;
  if ((roles ?? []).some((role) => role.role === "customer")) {
    await upsertZohoContactOnce(ctx, db, region, organizationId, token, userId, "customer");
    synced = true;
  }
  if ((roles ?? []).some((role) => role.role === "vendor")) {
    await upsertZohoContactOnce(ctx, db, region, organizationId, token, userId, "vendor");
    synced = true;
  }
  if (!synced && (roles ?? []).some((role) => role.role === "admin")) {
    await upsertZohoContactOnce(ctx, db, region, organizationId, token, userId, "vendor");
    synced = true;
  }
}

type ZohoContactLink = {
  user_id: string;
  contact_type: "customer" | "vendor";
  zoho_contact_id: string;
  updated_at: string;
  last_polled_at: string | null;
  last_zoho_modified_at: string | null;
};

function zohoPrimaryPerson(contact: Record<string, unknown>) {
  const people = Array.isArray(contact["contact_persons"]) ? contact["contact_persons"] as Record<string, unknown>[] : [];
  return people.find((person) => person["is_primary_contact"] === true) ?? people[0] ?? {};
}

function zohoContactAddress(contact: Record<string, unknown>) {
  const address = contact["billing_address"];
  if (!address || typeof address !== "object" || Array.isArray(address)) return null;
  const row = address as Record<string, unknown>;
  return {
    address: str(row["address"]),
    city: str(row["city"]),
    state: str(row["state"]),
    zip: str(row["zip"]),
    attention: str(row["attention"]),
  };
}

async function pollZohoContactChanges(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  limit = 20,
) {
  const { data: links, error } = await db.from("zoho_contact_links")
    .select("user_id,contact_type,zoho_contact_id,updated_at,last_polled_at,last_zoho_modified_at")
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error("Could not load Zoho contact mappings for reconciliation");
  const result = { checked: 0, updated: 0, needsReview: 0, failed: 0 };
  for (const link of (links ?? []) as ZohoContactLink[]) {
    result.checked += 1;
    let newestZohoModified = link.last_zoho_modified_at;
    try {
      const response = await inventoryRequest<{ contact?: Record<string, unknown> }>(
        region, organizationId, token, `contacts/${encodeURIComponent(link.zoho_contact_id)}`, "GET",
      );
      const contact = response.contact;
      if (!contact) throw new Error("Zoho contact response did not include a contact");
      const zohoModifiedAt = str(contact["last_modified_time"]);
      const zohoModifiedMs = Date.parse(zohoModifiedAt);
      const previousZohoModifiedMs = Date.parse(link.last_zoho_modified_at ?? "");
      const isNewZohoEdit = Number.isFinite(zohoModifiedMs) &&
        (!Number.isFinite(previousZohoModifiedMs) || zohoModifiedMs > previousZohoModifiedMs);
      if (!isNewZohoEdit) {
        await db.from("zoho_contact_links").update({ last_polled_at: new Date().toISOString() })
          .eq("user_id", link.user_id).eq("contact_type", link.contact_type);
        continue;
      }
      newestZohoModified = zohoModifiedAt;

      const [{ data: profile, error: profileError }, { data: addresses, error: addressError }] = await Promise.all([
        db.from("profiles").select("updated_at,email").eq("id", link.user_id).maybeSingle(),
        db.from("addresses").select("updated_at,is_default").eq("user_id", link.user_id).order("is_default", { ascending: false }).limit(1),
      ]);
      if (profileError || addressError || !profile) throw new Error("Could not compare Zoho changes with the Grain Bazar profile");
      const baseline = Date.parse(link.updated_at);
      const localChanged = [profile.updated_at, ...(addresses ?? []).map((row) => row.updated_at)]
        .some((timestamp) => Date.parse(timestamp) > baseline + 2_000);
      const person = zohoPrimaryPerson(contact);
      const zohoEmail = str(person["email"] ?? contact["email"]).trim().toLowerCase();
      const appEmail = profile.email.trim().toLowerCase();
      if (localChanged || (zohoEmail && appEmail && zohoEmail !== appEmail)) {
        const reason = localChanged
          ? `Zoho contact ${link.zoho_contact_id} and Grain Bazar profile changed since the last sync; review before choosing a winner.`
          : `Zoho contact email changed from ${profile.email} to ${zohoEmail}; verify the login email in Grain Bazar before updating it.`;
        const { data: existing } = await db.from("zoho_sync_outbox").select("id")
          .eq("entity_type", "customer").eq("entity_id", link.user_id).eq("status", "needs_review").limit(1).maybeSingle();
        if (existing?.id) await db.from("zoho_sync_outbox").update({ last_error: reason, updated_at: new Date().toISOString() }).eq("id", existing.id);
        else await db.from("zoho_sync_outbox").insert({ entity_type: "customer", entity_id: link.user_id, event_type: "upsert", status: "needs_review", last_error: reason });
        await db.from("zoho_contact_links").update({ last_polled_at: new Date().toISOString(), last_zoho_modified_at: zohoModifiedAt })
          .eq("user_id", link.user_id).eq("contact_type", link.contact_type);
        result.needsReview += 1;
        continue;
      }
      const address = link.contact_type === "customer" ? zohoContactAddress(contact) : null;
      const { error: applyError } = await db.rpc("apply_zoho_contact_update", {
        _user_id: link.user_id,
        _contact_type: link.contact_type,
        _full_name: str(person["first_name"] || person["last_name"] ? `${str(person["first_name"])} ${str(person["last_name"])}`.trim() : contact["contact_name"]) || null,
        _phone: str(person["phone"] ?? person["mobile"] ?? contact["phone"]) || null,
        _company: str(contact["company_name"]) || null,
        _gstin: str(contact["gst_no"]) || null,
        _address: address as Json | null,
      });
      if (applyError) throw new Error("Zoho edit was fetched, but Grain Bazar could not safely apply it");
      const { error: updateError } = await db.from("zoho_contact_links").update({
        updated_at: new Date().toISOString(), last_polled_at: new Date().toISOString(), last_zoho_modified_at: zohoModifiedAt,
      }).eq("user_id", link.user_id).eq("contact_type", link.contact_type);
      if (updateError) throw new Error("Zoho edit was applied, but its reconciliation cursor could not be saved");
      result.updated += 1;
    } catch {
      // Do not advance last_zoho_modified_at after an API or apply failure; retry on a later run.
      await db.from("zoho_contact_links").update({ last_polled_at: new Date().toISOString() })
        .eq("user_id", link.user_id).eq("contact_type", link.contact_type);
      result.failed += 1;
    }
  }
  return result;
}

async function pollZohoCatalogChanges(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  limit = 20,
) {
  const { data: links, error } = await db.from("zoho_item_links")
    .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error("Could not load Zoho item mappings for reconciliation");
  const result = { checked: 0, updated: 0, needsReview: 0, failed: 0 };
  for (const rawLink of links ?? []) {
    const link = rawLink as ZohoItemLink;
    result.checked += 1;
    try {
      const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
        region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
      );
      const item = response.item;
      if (!item) throw new Error("Zoho Inventory response did not include the mapped item");
      const outcome = await applyZohoItemChange(db, link, item, { region, organizationId, token });
      if (outcome !== "applied") continue;
      result.updated += 1;
    } catch {
      // Do not advance the remote cursor after a failed or unsafe apply. A
      // later run can retry and surface a conflict through the queue.
      await db.from("zoho_item_links").update({ last_polled_at: new Date().toISOString() })
        .eq("product_id", link.product_id);
      result.failed += 1;
    }
  }
  return result;
}

async function pollZohoOrderFulfillment(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  limit = 20,
) {
  const { data: orders, error } = await db.from("orders")
    .select("id,zoho_salesorder_id,zoho_last_polled_at")
    .not("zoho_salesorder_id", "is", null)
    .order("zoho_last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error("Could not load linked Grain Bazar orders for Zoho reconciliation");
  const result = { checked: 0, updated: 0, failed: 0 };
  for (const order of orders ?? []) {
    result.checked += 1;
    try {
      const response = await inventoryRequest<{ salesorder?: Record<string, unknown>; sales_order?: Record<string, unknown> }>(
        region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id!)}`, "GET",
      );
      const zohoOrder = response.salesorder ?? response.sales_order;
      if (!zohoOrder) throw new Error("Zoho response did not include the mapped sales order");
      const packages = Array.isArray(zohoOrder["packages"]) ? zohoOrder["packages"] as Record<string, unknown>[] : [];
      const shipmentStatuses = packages.map((pkg) => {
        const shipment = pkg["shipment_order"];
        return shipment && typeof shipment === "object" ? str((shipment as Record<string, unknown>)["status"]).toLowerCase() : str(pkg["status"]).toLowerCase();
      });
      const incomingStatus = shipmentStatuses.includes("delivered")
        ? "Delivered"
        : shipmentStatuses.some((status) => ["shipped", "in_transit", "in transit"].includes(status))
          ? "Dispatched"
          : null;
      if (incomingStatus) {
        const { error: applyError } = await db.rpc("apply_zoho_order_fulfillment", { _order_id: order.id, _status: incomingStatus });
        if (applyError) throw new Error("Zoho fulfillment status could not be applied to Grain Bazar");
        result.updated += 1;
      }
      await db.from("orders").update({ zoho_last_polled_at: new Date().toISOString() }).eq("id", order.id);
    } catch {
      result.failed += 1;
      // Rotate failed records so one bad Zoho record cannot starve the rest of the order queue.
      await db.from("orders").update({ zoho_last_polled_at: new Date().toISOString() }).eq("id", order.id);
    }
  }
  return result;
}

export async function isZohoWriteSyncActive(dbClient?: SupabaseClient<Database>): Promise<boolean> {
  if (process.env["ZOHO_WRITE_SYNC_ENABLED"] === "false") return false;
  if (process.env["ZOHO_WRITE_SYNC_ENABLED"] === "true") return true;
  try {
    const db = dbClient ?? (await dbAdmin());
    const { data: setting } = await db.from("settings").select("value").eq("key", "zoho_write_sync_enabled").maybeSingle();
    if (setting && setting.value !== undefined && setting.value !== null) {
      return setting.value === true || setting.value === "true";
    }
  } catch {
    // ignore
  }
  return true;
}

export const getZohoWriteSyncConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const enabled = await isZohoWriteSyncActive(db);
    return { enabled };
  });

export const setZohoWriteSyncConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ enabled: z.boolean() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { error } = await db.from("settings").upsert({
      key: "zoho_write_sync_enabled",
      value: data.enabled as unknown as Json,
      is_public: false,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error("Could not update Zoho write sync configuration");
    return { enabled: data.enabled };
  });

export const processZohoSyncNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    limit: z.number().int().min(1).max(100).default(50),
    force: z.boolean().optional(),
    /** Also read Zoho-side edits back after pushing (slow; the daily cron always does it). */
    inbound: z.boolean().optional(),
  }).optional())
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const limit = data?.limit ?? 50;
    return await processZohoSyncOutbox(limit, { force: data?.force ?? true, inbound: data?.inbound ?? false });
  });

/**
 * Processes queued outbound records to Zoho. Active by default; can also be forced by admin action.
 */
export async function processZohoSyncOutbox(limit = 20, options?: { force?: boolean; inbound?: boolean }) {
  const db = await dbAdmin();
  const writeEnabled = options?.force || (await isZohoWriteSyncActive(db));
  if (!writeEnabled) return { enabled: false, processed: 0, complete: 0, failed: 0, needsReview: 0 };
  const { data: connection, error: connectionError } = await db.from("zoho_commerce_connection").select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag").eq("id", true).maybeSingle();
  if (connectionError || !connection) throw new Error("Connect and authorize Zoho Inventory before enabling outbound sync");
  const region = connection.region as Region;
  const token = await accessToken(region, await decrypt(connection));
  const { data: jobs, error: claimError } = await db.rpc("claim_zoho_sync_jobs", { _limit: limit });
  if (claimError) throw new Error("Could not claim Zoho sync jobs; apply the outbound sync migration");
  const summary = { enabled: true, processed: (jobs ?? []).length, complete: 0, failed: 0, needsReview: 0 };
  const ctx = newZohoRunContext();
  const runJob = async (job: ZohoSyncJob) => {
    let status: "complete" | "failed" | "needs_review" = "complete";
    let errorMessage: string | null = null;
    const startedAt = Date.now();
    try {
      if (job.entity_type === "customer")
        await syncZohoCustomer(db, region, connection.organization_id, token, job.entity_id, ctx);
      else if (job.entity_type === "order")
        await syncZohoOrder(db, region, connection.organization_id, token, job);
      else
        await syncZohoCatalogItem(db, region, connection.organization_id, token, job.entity_id, ctx);
    } catch (cause) {
      errorMessage = (cause instanceof Error ? cause.message : "Unexpected Zoho sync failure").slice(0, 1000);
      const isQuotaLimit =
        errorMessage.toLowerCase().includes("used up your available sales orders") ||
        errorMessage.toLowerCase().includes("create more orders");
      status = cause instanceof NeedsReviewError || isQuotaLimit ? "needs_review" : "failed";
    }
    const log = zohoLogLine("outbox_job_finished", { job: job.id, entity: job.entity_type, entityId: job.entity_id, attempt: job.attempts, status, ms: Date.now() - startedAt, error: errorMessage });
    if (status === "complete") console.info(log); else console.warn(log);
    const { error: finishError } = await db.rpc("finish_zoho_sync_job", { _id: job.id, _status: status, _error: errorMessage });
    if (finishError) throw new Error(`Zoho job ${job.id} was processed but its result could not be recorded`);
    if (status === "complete") summary.complete += 1;
    else if (status === "failed") summary.failed += 1;
    else summary.needsReview += 1;
  };
  // Contacts and catalogue items are independent, so a few run at once (well inside Zoho's
  // per-minute limit). Orders run afterwards, one at a time, so their customer and item
  // links exist first and sales orders are created in queue order.
  const claimed = (jobs ?? []) as ZohoSyncJob[];
  await runPool(claimed.filter((job) => job.entity_type !== "order"), 4, runJob);
  await runPool(claimed.filter((job) => job.entity_type === "order"), 1, runJob);

  if (options?.inbound === false) return summary;
  const [contacts, fulfillment, catalog] = await Promise.all([
    pollZohoContactChanges(db, region, connection.organization_id, token, limit),
    applyRecentZohoOrderChanges(db, region, connection.organization_id, token)
      .then(() => pollZohoOrderFulfillment(db, region, connection.organization_id, token, limit)),
    pollZohoCatalogChanges(db, region, connection.organization_id, token, limit),
  ]);
  return {
    ...summary,
    inboundContacts: contacts,
    inboundFulfillment: fulfillment,
    inboundCatalog: catalog,
  };
}

const datePart = (value: unknown, fallback: string) => {
  const match = str(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? fallback;
};
async function couponFingerprint(coupon: Record<string, unknown>) {
  const stable = JSON.stringify({
    name: str(coupon["coupon_name"]),
    active: coupon["is_active"] === true,
    type: str(coupon["discount_type"]).toLowerCase(),
    value: num(coupon["discount_value"]),
    minimum: num(coupon["minimum_order_value"]),
    starts: datePart(coupon["activation_time"], ""),
    ends: datePart(coupon["expiry_time"], ""),
    totalLimit: num(coupon["max_redemption_count"]),
    perUserLimit: num(coupon["max_redemption_count_per_user"]),
    eligibleProducts: coupon["eligible_products"] ?? null,
    eligibleCustomers: coupon["eligible_customers"] ?? null,
    eligibleZones: coupon["eligible_shipping_zones"] ?? null,
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(stable)));
  return b64(digest);
}
function hasCouponRestriction(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) && list.length > 0;
}
async function syncZohoCoupons(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  token: string,
  region: Region,
  organizationId: string,
) {
  const api = `${REGIONS[region][1]}/store/api/v1/coupons`;
  const headers = {
    Authorization: `Zoho-oauthtoken ${token}`,
    "X-com-zoho-store-organizationid": organizationId,
  };
  const response = await fetch(api, { headers });
  const list = (await response.json()) as {
    coupons?: Record<string, unknown>[];
    code?: number;
    message?: string;
  };
  if (!response.ok || list.code !== 0)
    throw new Error(list.message ?? `Zoho coupon request failed (${response.status})`);
  const imported = new Set<string>();
  let synced = 0;
  for (let i = 0; i < (list.coupons ?? []).length; i += 8) {
    const details = await Promise.all(
      (list.coupons ?? []).slice(i, i + 8).map(async (summary) => {
        const id = str(summary["coupon_id"]);
        if (!id) return null;
        const detailResponse = await fetch(`${api}/${encodeURIComponent(id)}`, { headers });
        const detail = (await detailResponse.json()) as {
          coupon?: Record<string, unknown>;
          code?: number;
          message?: string;
        };
        if (!detailResponse.ok || detail.code !== 0 || !detail.coupon)
          throw new Error(detail.message ?? `Could not read Zoho coupon ${id}`);
        return detail.coupon;
      }),
    );
    for (const coupon of details) {
      if (!coupon) continue;
      const code = str(coupon["coupon_code"]).trim().toUpperCase();
      const couponId = str(coupon["coupon_id"]);
      if (!code || !couponId) continue;
      imported.add(couponId);
      const eligibleProducts = coupon["eligible_products"];
      const eligibleCustomers = coupon["eligible_customers"];
      const eligibleZones = coupon["eligible_shipping_zones"];
      // Product/customer/zone restricted offers cannot be safely applied by the
      // marketplace until its checkout supports those Zoho eligibility rules.
      if (
        hasCouponRestriction(eligibleProducts, "products") ||
        hasCouponRestriction(eligibleProducts, "categories") ||
        hasCouponRestriction(eligibleProducts, "collections") ||
        hasCouponRestriction(eligibleCustomers, "customers") ||
        hasCouponRestriction(eligibleZones, "shipping_zones")
      ) {
        await db.from("coupons").update({ active: false }).eq("zoho_coupon_id", couponId);
        continue;
      }
      const type = str(coupon["discount_type"]).toLowerCase();
      if (type !== "flat" && type !== "percentage") {
        await db.from("coupons").update({ active: false }).eq("zoho_coupon_id", couponId);
        continue;
      }
      const active =
        coupon["is_active"] === true && str(coupon["status"]).toLowerCase() === "active";
      const startsOn = datePart(coupon["activation_time"], new Date().toISOString().slice(0, 10));
      const endsOn = datePart(coupon["expiry_time"], "2099-12-31");
      const discountValue = num(coupon["discount_value"]);
      if (discountValue <= 0 || (type === "percentage" && discountValue > 100)) {
        await db.from("coupons").update({ active: false }).eq("zoho_coupon_id", couponId);
        continue;
      }
      const fingerprint = await couponFingerprint(coupon);
      const { data: priorZohoCode } = await db
        .from("coupons")
        .select("code")
        .eq("zoho_coupon_id", couponId)
        .maybeSingle();
      if (priorZohoCode && priorZohoCode.code !== code) {
        await db
          .from("coupons")
          .update({ active: false, zoho_coupon_id: null })
          .eq("code", priorZohoCode.code);
      }
      const { data: prior } = await db
        .from("coupons")
        .select("zoho_notice_fingerprint,used_count")
        .eq("code", code)
        .maybeSingle();
      const zohoRedemptionCount = num(coupon["redemption_count"]);
      // Marketplace redemption counters remain independent from Zoho’s store.
      const usedCount = num(prior?.used_count);
      const usageLimit = Math.max(
        1,
        Math.min(2_147_483_647, num(coupon["max_redemption_count"]) || 2_147_483_647),
      );
      const perUserLimit = num(coupon["max_redemption_count_per_user"]);
      const { error: saveError } = await db.from("coupons").upsert(
        {
          code,
          discount_type: type === "percentage" ? "Percentage" : "Fixed",
          discount_value: discountValue,
          minimum_order: num(coupon["minimum_order_value"]),
          maximum_discount: type === "percentage" ? 999_999_999 : discountValue,
          starts_on: startsOn,
          ends_on: endsOn,
          usage_limit: usageLimit,
          used_count: usedCount,
          active,
          zoho_coupon_id: couponId,
          zoho_redemption_count: zohoRedemptionCount,
          zoho_usage_limit_per_user: perUserLimit > 0 ? perUserLimit : null,
          zoho_notice_fingerprint: prior?.zoho_notice_fingerprint ?? null,
        },
        { onConflict: "code" },
      );
      if (saveError) throw new Error(`Could not save Zoho coupon ${code} to the marketplace`);
      synced += 1;
      // Send one offer notice per customer when the offer is first seen or its
      // terms change. Manual re-syncs with unchanged terms do not send duplicates.
      if (active && prior?.zoho_notice_fingerprint !== fingerprint) {
        const { data: customers, error: customerError } = await db
          .from("user_roles")
          .select("user_id")
          .eq("role", "customer");
        if (customerError) throw new Error("Could not find customers to notify about Zoho coupons");
        const name = str(coupon["coupon_name"]) || code;
        const discount = type === "percentage" ? `${discountValue}% off` : `₹${discountValue} off`;
        const notices = (customers ?? []).map((customer) => ({
          recipient_id: customer.user_id,
          recipient_role: "customer",
          title: `New offer: ${name}`,
          message: `Use ${code} for ${discount}${num(coupon["minimum_order_value"]) ? ` on orders above ₹${num(coupon["minimum_order_value"]).toLocaleString("en-IN")}` : ""}. Apply it at checkout before ${endsOn}.`,
          status: "coupon",
          read: false,
        }));
        for (let j = 0; j < notices.length; j += 250) {
          const { error: noticeError } = await db
            .from("notifications")
            .insert(notices.slice(j, j + 250));
          if (noticeError) throw new Error("Could not send Zoho coupon announcements to customers");
        }
      }
      if (prior?.zoho_notice_fingerprint !== fingerprint) {
        const { error: fingerprintError } = await db
          .from("coupons")
          .update({ zoho_notice_fingerprint: fingerprint })
          .eq("code", code);
        if (fingerprintError)
          throw new Error(`Could not record the Zoho coupon notice state for ${code}`);
      }
    }
  }
  const { data: previous } = await db
    .from("coupons")
    .select("code,zoho_coupon_id")
    .not("zoho_coupon_id", "is", null);
  for (const coupon of previous ?? []) {
    if (imported.has(coupon.zoho_coupon_id ?? "")) continue;
    await db.from("coupons").update({ active: false }).eq("code", coupon.code);
  }
  return synced;
}

export const syncZohoProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: connection, error } = await db
      .from("zoho_commerce_connection")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error || !connection) throw new Error("Connect Zoho Commerce before syncing products");
    const region = connection.region as Region;
    if (!(region in REGIONS)) throw new Error("ZOHO_REGION is not a supported Zoho data center");
    try {
      const token = await accessToken(region, await decrypt(connection));
      const products: Record<string, unknown>[] = [];
      for (let page = 1; ; page += 1) {
        if (page > 500) throw new Error("Zoho catalog exceeds the 100,000-product safety limit");
        const url = new URL(`${REGIONS[region][1]}/store/api/v1/products`);
        url.search = new URLSearchParams({
          filter_by: "Status.All",
          page_start_from: String(page),
          per_page: "200",
        }).toString();
        const response = await fetch(url, {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            "X-com-zoho-store-organizationid": connection.organization_id,
          },
        });
        const data = (await response.json()) as {
          products?: Record<string, unknown>[];
          code?: number;
          message?: string;
        };
        if (!response.ok || data.code !== 0)
          throw new Error(data.message ?? `Zoho products request failed (${response.status})`);
        const pageProducts = data.products ?? [];
        products.push(...pageProducts);
        if (pageProducts.length < 200) break;
      }
      const rows = products
        .filter((p) => str(p["product_id"]))
        .map((p) => mapProduct(p, connection.organization_id));
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { data: existingRows, error: existingError } = await db
          .from("catalog_products")
          .select("id,payload")
          .in("id", batch.map((row) => row.id));
        if (existingError)
          throw new Error("Existing Zoho product limits could not be preserved during catalog sync");
        const existingById = new Map((existingRows ?? []).map((row) => {
          const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
            ? row.payload as Record<string, unknown>
            : {};
          return [row.id, payload] as const;
        }));
        const rowsToSave = batch.map((row) => {
          const existing = existingById.get(row.id);
          const maxPurchaseQuantity = existing?.["maxPurchaseQuantity"];
          const pricingDisplayMode = existing?.["pricingDisplayMode"];
          // Admin-only storefront settings live in the payload; keep them across Zoho re-syncs.
          const preserved: Record<string, unknown> = {};
          if (
            typeof maxPurchaseQuantity === "number"
            && Number.isSafeInteger(maxPurchaseQuantity)
            && maxPurchaseQuantity >= 1
            && maxPurchaseQuantity <= 100000
          ) preserved["maxPurchaseQuantity"] = maxPurchaseQuantity;
          if (pricingDisplayMode === "mrp_only" || pricingDisplayMode === "strike_through")
            preserved["pricingDisplayMode"] = pricingDisplayMode;
          // Keeps the "last seen Commerce values" marker that detects product-page edits.
          if (existing?.["zohoSeen"] && typeof existing["zohoSeen"] === "object") preserved["zohoSeen"] = existing["zohoSeen"];
          return Object.keys(preserved).length > 0
            ? { ...row, payload: { ...row.payload, ...preserved } }
            : row;
        });
        const { error: saveError } = await db
          .from("catalog_products")
          .upsert(rowsToSave, { onConflict: "id" });
        if (saveError)
          throw new Error("Zoho products could not be saved to the marketplace catalog");
      }
      // Hide stale imports only after every page completed successfully.
      const { data: current, error: currentError } = await db
        .from("catalog_products")
        .select("id,payload")
        .like("id", "zoho-%");
      if (currentError)
        throw new Error("Could not verify the current Zoho catalog before reconciling it");
      const liveIds = new Set(rows.map((row) => row.id));
      for (const old of current ?? []) {
        if (liveIds.has(old.id)) continue;
        const payload =
          old.payload && typeof old.payload === "object" && !Array.isArray(old.payload)
            ? (old.payload as Record<string, unknown>)
            : {};
        const { error: hideError } = await db
          .from("catalog_products")
          .update({ active: false, payload: { ...payload, active: false } })
          .eq("id", old.id);
        if (hideError) throw new Error("Could not hide products removed from Zoho Commerce");
      }
      const couponsSynced = await syncZohoCoupons(db, token, region, connection.organization_id);
      const { error: statusError } = await db
        .from("zoho_commerce_connection")
        .update({
          status: "connected",
          last_synced_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);
      if (statusError)
        throw new Error("Catalog synced, but the last-sync status could not be saved");
      return { synced: rows.length, couponsSynced };
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Unexpected Zoho synchronization error";
      await db
        .from("zoho_commerce_connection")
        .update({
          status: "error",
          last_error: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", true);
      throw new Error(message);
    }
  });

/**
 * Pushes one order to Zoho now instead of waiting behind the shared queue, and settles its
 * queue entries: complete on success, needs_review with Zoho's answer on failure (so the
 * error shows in Admin > Zoho). Returns the Zoho sales order ID or throws Zoho's message.
 */
async function pushOrderToZohoDirect(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const { data: connection, error: connectionError } = await db
    .from("zoho_commerce_connection")
    .select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag")
    .eq("id", true)
    .maybeSingle();
  if (connectionError || !connection) throw new Error("Connect and authorize Zoho before pushing orders");
  const region = connection.region as Region;
  const token = await accessToken(region, await decrypt(connection));

  const openJobs = () => db.from("zoho_sync_outbox").select("id")
    .eq("entity_type", "order").eq("entity_id", orderId)
    .in("status", ["pending", "failed", "needs_review"]);
  try {
    // attempts: 2 first looks for an earlier half-finished push by the GB- number.
    await syncZohoOrder(db, region, connection.organization_id, token, {
      id: "direct", entity_type: "order", entity_id: orderId, attempts: 2,
    } as ZohoSyncJob);
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : "Zoho rejected the order").slice(0, 900);
    const { data: jobs } = await openJobs();
    if (jobs?.length) {
      await db.from("zoho_sync_outbox")
        .update({ status: "needs_review", last_error: message, updated_at: new Date().toISOString() })
        .in("id", jobs.map((job) => job.id));
    } else {
      await db.from("zoho_sync_outbox").insert({
        entity_type: "order", entity_id: orderId, event_type: "upsert", status: "needs_review", last_error: message,
      });
    }
    throw new Error(`${message}${zohoPermissionHint(message)}`);
  }
  const { data: jobs } = await openJobs();
  if (jobs?.length) {
    await db.from("zoho_sync_outbox")
      .update({ status: "complete", last_error: null, updated_at: new Date().toISOString() })
      .in("id", jobs.map((job) => job.id));
  }
  const { data: updated } = await db
    .from("orders")
    .select("zoho_salesorder_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!updated?.zoho_salesorder_id)
    throw new Error("Zoho finished without returning a sales order ID; check Admin > Zoho");
  return updated.zoho_salesorder_id;
}

export const syncSingleOrderToZoho = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: order, error } = await db
      .from("orders")
      .select("id")
      .eq("order_no", data.orderNo)
      .maybeSingle();
    if (error || !order) throw new Error("Order not found for Zoho synchronization");
    return { success: true, zohoSalesOrderId: await pushOrderToZohoDirect(db, order.id) };
  });

/**
 * Called right after an order is placed or changed (status, items, cancellation), so Zoho
 * Commerce gets it at once instead of at the daily run. Only the order's customer (or an admin)
 * may trigger it. It never fails the caller: a Zoho refusal stays in the queue for Admin > Zoho
 * and the daily run.
 */
export const pushOrderChangeToZoho = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    const db = await dbAdmin();
    const { data: order, error } = await db
      .from("orders")
      .select("id,user_id,zoho_salesorder_id")
      .eq("order_no", data.orderNo)
      .maybeSingle();
    if (error || !order) return { pushed: false };
    const isAdmin = async () => !!(await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" })).data;
    if (!(await mayPushOrder(db, context.userId, isAdmin, order))) return { pushed: false };
    if (!(await isZohoWriteSyncActive(db))) return { pushed: false };
    try {
      await pushOrderToZohoDirect(db, order.id);
      return { pushed: true };
    } catch (cause) {
      console.warn(`Instant Zoho push for ${data.orderNo} deferred to the queue:`, cause);
      return { pushed: false };
    }
  });


/* ---------------------------------------------------------------------------
 * Two-way sales order editing (Admin > Zoho > Sales orders).
 * Zoho is the record of truth for these orders: every save first reloads the
 * order from Zoho and refuses to overwrite a newer Zoho edit, then writes the
 * change, reads the result back, and stores it in the Grain Bazar snapshot so
 * both panels show the same, most recent version.
 * ------------------------------------------------------------------------- */

const zohoAddressSchema = z.object({
  attention: z.string().trim().max(100),
  address: z.string().trim().min(1).max(500),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  zip: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(50),
});

const salesOrderIdSchema = z.string().trim().regex(/^\d{1,30}$/, "Invalid Zoho sales order ID");

export type ZohoEditableSalesOrder = {
  salesOrderId: string;
  salesOrderNumber: string;
  lastModified: string;
  orderStatus: string;
  customerName: string;
  date: string;
  shipmentDate: string;
  referenceNumber: string;
  notes: string;
  terms: string;
  discountType: string;
  discount: number;
  discountIsPercent: boolean;
  shippingCharge: number;
  adjustment: number;
  adjustmentDescription: string;
  total: number;
  currencyCode: string;
  lineItems: { lineItemId: string; name: string; sku: string; quantity: number; rate: number; itemTotal: number }[];
  billingAddress: z.infer<typeof zohoAddressSchema>;
  shippingAddress: z.infer<typeof zohoAddressSchema>;
  linkedOrderNo: string | null;
};

function zohoAddress(value: unknown): z.infer<typeof zohoAddressSchema> {
  const address = plainObject(value);
  return {
    attention: str(address["attention"]),
    address: str(address["address"] ?? address["street"]),
    city: str(address["city"]),
    state: str(address["state"]),
    zip: str(address["zip"] ?? address["zip_code"]),
    country: str(address["country"]),
    phone: str(address["phone"]),
  };
}

function editableSalesOrder(order: Record<string, unknown>, linkedOrderNo: string | null): ZohoEditableSalesOrder {
  const rawDiscount = order["discount"];
  const discountIsPercent = typeof rawDiscount === "string" && rawDiscount.trim().endsWith("%")
    || order["is_discount_percent"] === true;
  return {
    salesOrderId: str(order["salesorder_id"]),
    salesOrderNumber: str(order["salesorder_number"]),
    lastModified: str(order["last_modified_time"]),
    orderStatus: str(order["order_status"] ?? order["status"]),
    customerName: str(order["customer_name"]),
    date: str(order["date"]),
    shipmentDate: str(order["shipment_date"]),
    referenceNumber: str(order["reference_number"]),
    notes: str(order["notes"]),
    terms: str(order["terms"]),
    discountType: str(order["discount_type"]) || "entity_level",
    discount: num(typeof rawDiscount === "string" ? rawDiscount.replace("%", "") : rawDiscount),
    discountIsPercent,
    shippingCharge: num(order["shipping_charge"]),
    adjustment: num(order["adjustment"]),
    adjustmentDescription: str(order["adjustment_description"]),
    total: num(order["total"]),
    currencyCode: str(order["currency_code"]) || "INR",
    lineItems: (Array.isArray(order["line_items"]) ? order["line_items"] : []).map((raw) => {
      const item = plainObject(raw);
      return {
        lineItemId: str(item["line_item_id"]),
        name: str(item["name"] ?? item["description"]),
        sku: str(item["sku"]),
        quantity: num(item["quantity"]),
        rate: num(item["rate"]),
        itemTotal: num(item["item_total"]),
      };
    }),
    billingAddress: zohoAddress(order["billing_address"]),
    shippingAddress: zohoAddress(order["shipping_address"]),
    linkedOrderNo,
  };
}

async function zohoSalesOrderContext(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data: connection, error } = await db
    .from("zoho_commerce_connection")
    .select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag")
    .eq("id", true)
    .maybeSingle();
  if (error || !connection) throw new Error("Connect Zoho before editing its sales orders");
  const region = connection.region as Region;
  if (!(region in REGIONS)) throw new Error("The Zoho data center is not supported");
  return { region, organizationId: connection.organization_id, token: await accessToken(region, await decrypt(connection)) };
}

async function loadZohoSalesOrder(region: Region, organizationId: string, token: string, salesOrderId: string) {
  const response = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
    region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}`, "GET",
  );
  if (!response.salesorder) throw new Error("Zoho did not return this sales order");
  return response.salesorder;
}

/** Writes Zoho's latest copy into the Grain Bazar snapshot row so the list shows it at once. */
async function refreshSalesOrderSnapshot(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  organizationId: string,
  order: Record<string, unknown>,
) {
  const salesOrderId = str(order["salesorder_id"]);
  const { data: state } = await db
    .from("zoho_commerce_sync_state")
    .select("current_batch_id")
    .eq("organization_id", organizationId)
    .eq("resource", "sales_orders")
    .maybeSingle();
  if (!state?.current_batch_id || !salesOrderId) return;
  const { data: existing } = await db
    .from("zoho_commerce_sync_data")
    .select("payload")
    .eq("organization_id", organizationId)
    .eq("resource", "sales_orders")
    .eq("batch_id", state.current_batch_id)
    .eq("external_id", salesOrderId)
    .maybeSingle();
  const payload = { ...plainObject(existing?.payload), ...order } as Json;
  if (existing) {
    await db
      .from("zoho_commerce_sync_data")
      .update({ payload, captured_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("resource", "sales_orders")
      .eq("batch_id", state.current_batch_id)
      .eq("external_id", salesOrderId);
  } else {
    await db.from("zoho_commerce_sync_data").insert({
      organization_id: organizationId,
      resource: "sales_orders",
      batch_id: state.current_batch_id,
      external_id: salesOrderId,
      payload,
    });
  }
}

async function linkedGrainBazarOrderNo(db: Awaited<ReturnType<typeof dbAdmin>>, salesOrderId: string) {
  const { data } = await db.from("orders").select("order_no").eq("zoho_salesorder_id", salesOrderId).maybeSingle();
  return data?.order_no ? String(data.order_no) : null;
}

export const getZohoSalesOrderForEdit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ salesOrderId: salesOrderIdSchema }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoSalesOrderContext(db);
    try {
      const order = await loadZohoSalesOrder(region, organizationId, token, data.salesOrderId);
      await refreshSalesOrderSnapshot(db, organizationId, order);
      return { order: editableSalesOrder(order, await linkedGrainBazarOrderNo(db, data.salesOrderId)) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not load the Zoho sales order";
      throw new Error(`${message}${zohoPermissionHint(message)}`);
    }
  });

const salesOrderChangesSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shipmentDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
  referenceNumber: z.string().trim().max(100).optional(),
  notes: z.string().max(5000).optional(),
  terms: z.string().max(5000).optional(),
  discount: z.number().min(0).max(100_000_000).optional(),
  shippingCharge: z.number().min(0).max(100_000_000).optional(),
  adjustment: z.number().min(-100_000_000).max(100_000_000).optional(),
  adjustmentDescription: z.string().trim().max(100).optional(),
  lineItems: z.array(z.object({
    lineItemId: z.string().regex(/^\d{1,30}$/),
    quantity: z.number().positive().max(10_000_000),
    rate: z.number().min(0).max(100_000_000),
  })).max(500).optional(),
  billingAddress: zohoAddressSchema.optional(),
  shippingAddress: zohoAddressSchema.optional(),
  status: z.enum(["confirmed", "void", "cancelled"]).optional(),
});

export const updateZohoSalesOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    salesOrderId: salesOrderIdSchema,
    /** last_modified_time the admin edited from; a newer Zoho edit is never overwritten. */
    expectedLastModified: z.string().max(60),
    changes: salesOrderChangesSchema,
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoSalesOrderContext(db);
    const { changes } = data;
    const step = { name: "reading the order from Zoho" };
    try {
      const current = await loadZohoSalesOrder(region, organizationId, token, data.salesOrderId);
      if (str(current["last_modified_time"]) !== data.expectedLastModified) {
        await refreshSalesOrderSnapshot(db, organizationId, current);
        return {
          conflict: true as const,
          order: editableSalesOrder(current, await linkedGrainBazarOrderNo(db, data.salesOrderId)),
        };
      }

      const fieldChange = [
        "date", "shipmentDate", "referenceNumber", "notes", "terms", "discount",
        "shippingCharge", "adjustment", "adjustmentDescription", "lineItems",
      ].some((key) => changes[key as keyof typeof changes] !== undefined);
      if (fieldChange) {
        step.name = "saving the order fields in Zoho";
        const currentLines = (Array.isArray(current["line_items"]) ? current["line_items"] : []).map(plainObject);
        const edits = new Map((changes.lineItems ?? []).map((line) => [line.lineItemId, line]));
        for (const id of edits.keys())
          if (!currentLines.some((line) => str(line["line_item_id"]) === id))
            throw new Error("A line item was removed in Zoho; reload the order and try again");
        const discountType = str(current["discount_type"]) || "entity_level";
        if (changes.discount !== undefined && discountType !== "entity_level")
          throw new Error("This order uses per-item discounts; change them in Zoho");
        const rawDiscount = current["discount"];
        const keepDiscount = typeof rawDiscount === "string" ? rawDiscount : num(rawDiscount);
        const body: Record<string, unknown> = {
          salesorder_number: str(current["salesorder_number"]),
          customer_id: str(current["customer_id"]),
          date: changes.date ?? str(current["date"]),
          shipment_date: changes.shipmentDate ?? str(current["shipment_date"]),
          reference_number: changes.referenceNumber ?? str(current["reference_number"]),
          notes: changes.notes ?? str(current["notes"]),
          terms: changes.terms ?? str(current["terms"]),
          discount_type: discountType,
          is_discount_before_tax: current["is_discount_before_tax"] !== false,
          ...(discountType === "entity_level" ? { discount: changes.discount ?? keepDiscount } : {}),
          shipping_charge: changes.shippingCharge ?? num(current["shipping_charge"]),
          adjustment: changes.adjustment ?? num(current["adjustment"]),
          adjustment_description: changes.adjustmentDescription ?? str(current["adjustment_description"]),
          line_items: currentLines.map((line) => {
            const edit = edits.get(str(line["line_item_id"]));
            const taxId = str(line["tax_id"]);
            return {
              line_item_id: str(line["line_item_id"]),
              item_id: str(line["item_id"]),
              name: str(line["name"]),
              description: str(line["description"]),
              quantity: edit?.quantity ?? num(line["quantity"]),
              rate: edit?.rate ?? num(line["rate"]),
              ...(str(line["unit"]) ? { unit: str(line["unit"]) } : {}),
              ...(taxId ? { tax_id: taxId } : {}),
              ...(discountType === "item_level" && line["discount"] !== undefined ? { discount: line["discount"] } : {}),
              ...(str(line["location_id"]) ? { location_id: str(line["location_id"]) } : {}),
              ...(str(line["warehouse_id"]) ? { warehouse_id: str(line["warehouse_id"]) } : {}),
            };
          }),
          ...(str(current["place_of_supply"]) ? { place_of_supply: str(current["place_of_supply"]) } : {}),
          ...(str(current["gst_treatment"]) ? { gst_treatment: str(current["gst_treatment"]) } : {}),
          ...(str(current["gst_no"]) ? { gst_no: str(current["gst_no"]) } : {}),
        };
        await inventoryRequest(
          region, organizationId, token, `salesorders/${encodeURIComponent(data.salesOrderId)}`, "PUT", body,
          { ignore_auto_number_generation: "true" },
        );
      }
      for (const [type, address] of [["billing", changes.billingAddress], ["shipping", changes.shippingAddress]] as const) {
        if (!address) continue;
        step.name = `saving the ${type} address in Zoho Commerce`;
        await commerceRequest(
          region, organizationId, token,
          `salesorders/${encodeURIComponent(data.salesOrderId)}/address/${type}`, "PUT", address,
        );
      }
      if (changes.status) {
        step.name = `marking the order ${changes.status} in Zoho Commerce`;
        await commerceRequest(
          region, organizationId, token,
          `salesorders/${encodeURIComponent(data.salesOrderId)}/status/${changes.status}`, "POST",
        );
      }

      step.name = "reading the saved order back from Zoho";
      const saved = await loadZohoSalesOrder(region, organizationId, token, data.salesOrderId);
      await refreshSalesOrderSnapshot(db, organizationId, saved);
      return {
        conflict: false as const,
        order: editableSalesOrder(saved, await linkedGrainBazarOrderNo(db, data.salesOrderId)),
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Zoho rejected the change";
      throw new Error(`Zoho refused while ${step.name}: ${message}.${zohoPermissionHint(message)}`);
    }
  });

/**
 * Admin diagnostics: how Zoho labels the sales channel on a Grain Bazar order versus a Zoho
 * Commerce order, and whether the organization exposes sales channels over the API. Read-only.
 */
export const probeZohoSalesChannel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const pick = (record: Record<string, unknown> | undefined) => Object.fromEntries(
      Object.entries(record ?? {}).filter(([key]) => /channel|source|integration|platform|is_.*commerce/i.test(key)),
    );
    const report: Record<string, unknown> = {};
    const { data: gbOrder } = await db.from("orders").select("order_no,zoho_salesorder_id")
      .not("zoho_salesorder_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (gbOrder?.zoho_salesorder_id) {
      try {
        const gb = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
          region, organizationId, token, `salesorders/${encodeURIComponent(gbOrder.zoho_salesorder_id)}`, "GET");
        report["grainBazarOrder"] = {
          orderNo: gbOrder.order_no,
          number: gb.salesorder?.["salesorder_number"],
          fields: pick(gb.salesorder),
          customFields: (Array.isArray(gb.salesorder?.["custom_fields"]) ? gb.salesorder?.["custom_fields"] as Record<string, unknown>[] : [])
            .map((field) => ({ label: field["label"], api_name: field["api_name"], value: field["value"] })),
        };
      } catch (cause) {
        report["grainBazarOrder"] = { error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    try {
      const list = await inventoryRequest<{ salesorders?: Record<string, unknown>[] }>(
        region, organizationId, token, "salesorders", "GET", undefined, { search_text: "CLK-SO", per_page: "5" });
      const first = (list.salesorders ?? [])[0];
      report["commerceListRow"] = pick(first);
      if (first?.["salesorder_id"]) {
        const full = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
          region, organizationId, token, `salesorders/${encodeURIComponent(String(first["salesorder_id"]))}`, "GET");
        report["commerceOrder"] = { number: full.salesorder?.["salesorder_number"], fields: pick(full.salesorder) };
      }
    } catch (cause) {
      report["commerceOrder"] = { error: cause instanceof Error ? cause.message : String(cause) };
    }
    for (const resource of ["saleschannels", "settings/saleschannels", "integrations/saleschannels"]) {
      try {
        const result = await inventoryRequest<Record<string, unknown>>(region, organizationId, token, resource, "GET");
        report[resource] = Object.fromEntries(Object.entries(result).filter(([key]) => !["code", "message"].includes(key)));
      } catch (cause) {
        report[resource] = { error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    return JSON.stringify(report, null, 2);
  });


/**
 * Reconciliation report (read-only): Grain Bazar orders from the last `days` days against the
 * Zoho sales orders numbered GB-..., matched by that unique number. Lists missing, unlinked,
 * duplicated, cancelled-on-one-side and total differences. Changes nothing in either system.
 */
export const reconcileZohoOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ days: z.number().int().min(1).max(90).default(14) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const since = new Date(Date.now() - data.days * 86_400_000);
    const { data: orders, error } = await db.from("orders")
      .select("order_no,order_status,total,zoho_salesorder_id,created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error("Could not read Grain Bazar orders");
    // Per-order lookups with endpoints the sync already uses: by stored Zoho ID, else by the unique
    // GB- number. Capped per run to stay well inside Zoho's per-minute API limit.
    const MAX_LOOKUPS = 80;
    const rows = (orders ?? []).slice(0, MAX_LOOKUPS);
    const truncated = (orders ?? []).length > rows.length;
    const zohoOrders: ZohoOrderForReconcile[] = [];
    const toRecon = (row: Record<string, unknown>): ZohoOrderForReconcile => ({
      salesorder_id: str(row["salesorder_id"]),
      salesorder_number: str(row["salesorder_number"]),
      status: str(row["order_status"] ?? row["status"]),
      total: Number(row["total"]),
    });
    await runPool(rows, 2, async (order) => {
      if (order.zoho_salesorder_id) {
        try {
          const one = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
            region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id)}`, "GET");
          if (one.salesorder) { zohoOrders.push(toRecon(one.salesorder)); return; }
        } catch {
          // Deleted in Zoho or not readable: fall through to the number search.
        }
      }
      const found = await findZohoSalesOrdersByNumber(region, organizationId, token, zohoOrderNumber(order.order_no));
      zohoOrders.push(...found.map(toRecon));
    });
    const report = reconcileOrders((orders ?? []).map((o) => ({ ...o, total: Number(o.total) })), zohoOrders);
    console.info(zohoLogLine("reconcile_finished", { days: data.days, checked: report.checked, inSync: report.inSync, issues: report.issues.length, zohoFetched: zohoOrders.length, truncated }));
    return { ...report, days: data.days, zohoFetched: zohoOrders.length, truncated, ranAt: new Date().toISOString() };
  });
