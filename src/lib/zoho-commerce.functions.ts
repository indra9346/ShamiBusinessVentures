import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";

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
        "ZohoCommerce.items.READ,ZohoCommerce.items.CREATE,ZohoCommerce.items.UPDATE,ZohoCommerce.coupons.READ,ZohoCommerce.coupons.CREATE,ZohoCommerce.coupons.UPDATE,ZohoCommerce.salesorders.READ,ZohoCommerce.salesorders.CREATE,ZohoCommerce.salesorders.UPDATE,ZohoCommerce.settings.READ,ZohoCommerce.settings.UPDATE,ZohoCommerce.sitesIndex.READ,ZohoInventory.contacts.READ,ZohoInventory.contacts.CREATE,ZohoInventory.contacts.UPDATE,ZohoInventory.items.READ,ZohoInventory.items.CREATE,ZohoInventory.items.UPDATE,ZohoInventory.salesorders.READ,ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE",
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
    const { data, error } = await db.from("zoho_sync_outbox")
      .select("id,entity_type,entity_id,status,attempts,last_error,created_at,updated_at")
      .order("updated_at", { ascending: false }).limit(250);
    if (error) throw new Error("Could not load Zoho sync queue status");
    const jobs = data ?? [];
    return {
      counts: jobs.reduce((counts, job) => {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>),
      jobs: jobs.slice(0, 30),
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
          const pageSize = 200;
          const start = (data.salesOrdersPage - 1) * pageSize;
          query = query.range(start, start + pageSize - 1);
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
  const response = await fetch(inventoryApi(region, resource, organizationId, query), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json()) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0)
    throw new Error(data.message ?? `Zoho Inventory ${resource} failed (${response.status})`);
  return data;
}

function splitContactName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? "Grain Bazar Customer", last_name: parts.slice(1).join(" ") };
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
  const contact = {
    contact_type: contactType,
    contact_name: name,
    company_name: profile.company || undefined,
    contact_persons: [person],
    notes: `Grain Bazar ${contactType} record · ID: ${userId}`,
    ...(profile.gstin ? { gst_no: profile.gstin } : {}),
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

type CatalogProduct = Database["public"]["Tables"]["catalog_products"]["Row"];
type ZohoItemLink = {
  product_id: string;
  zoho_item_id: string;
  updated_at: string;
  last_polled_at: string | null;
  last_zoho_modified_at: string | null;
  app_fingerprint: string | null;
};

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
  };
}

async function catalogFingerprint(product: CatalogProduct) {
  const shared = catalogSharedValues(product);
  const stable = JSON.stringify({
    vendorId: product.vendor_id,
    category: product.category,
    status: product.status,
    active: product.active,
    ...shared,
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(stable)));
  return b64(digest);
}

async function saveZohoReview(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  entityType: "customer" | "catalog",
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

  const shared = catalogSharedValues(product);
  if (!shared.name) throw new NeedsReviewError(`Product ${product.id} has no name for Zoho Inventory`);
  if (!shared.sku) throw new NeedsReviewError(`Product ${shared.name} has no SKU for Zoho item matching`);
  if (shared.rate === null || shared.rate < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid selling price for Zoho Inventory`);
  if (shared.purchaseRate !== null && shared.purchaseRate < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid purchase price for Zoho Inventory`);
  if (shared.reorderLevel !== null && shared.reorderLevel < 0)
    throw new NeedsReviewError(`Product ${shared.sku} has an invalid reorder level for Zoho Inventory`);

  let vendorContactId: string | undefined;
  if (product.vendor_id) {
    const { data: vendor } = await db.from("profiles")
      .select("id").eq("vendor_id", product.vendor_id).maybeSingle();
    if (vendor) {
      try {
        const id = await upsertZohoContact(db, region, organizationId, token, vendor.id, "vendor");
        if (id) vendorContactId = id;
      } catch (err) {
        console.warn(`Vendor contact sync skipped for product ${shared.sku}:`, err);
      }
    }
  }

  const itemPayload: Record<string, unknown> = {
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
  };

  let itemId = link?.zoho_item_id ?? "";
  let resultItem: Record<string, unknown> | undefined;
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
  if (!itemId) {
    const created = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, "items", "POST", itemPayload,
    );
    resultItem = created.item;
    itemId = str(resultItem?.["item_id"]);
    if (!itemId) throw new Error("Zoho Inventory created an item but returned no item ID");
  } else {
    const updated = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "PUT", itemPayload,
    );
    resultItem = updated.item;
  }
  await inventoryRequest(region, organizationId, token,
    `items/${encodeURIComponent(itemId)}/active`, "POST");
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
    const existing = await inventoryRequest<{ salesorder?: Record<string, unknown>; sales_order?: Record<string, unknown> }>(
      region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id)}`, "GET",
    );
    const zohoTotal = Number((existing.salesorder ?? existing.sales_order)?.["total"]);
    if (Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 0.01)
      throw new NeedsReviewError(`Zoho sales order ${order.zoho_salesorder_id} totals ₹${zohoTotal.toFixed(2)}; Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Reconcile tax, discount, and shipping before retrying.`);
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
      const directContact = {
        contact_type: "customer",
        contact_name: order.customer_name?.trim() || orderEmail,
        contact_persons: [{
          ...splitContactName(order.customer_name || "Customer"),
          email: orderEmail,
          phone: order.customer_phone ?? "",
          mobile: order.customer_phone ?? "",
          is_primary_contact: true,
        }],
        ...(order.customer_gstin ? { gst_no: order.customer_gstin } : {}),
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
  const safeNumber = `GB-${String(order.order_no).replace(/[^A-Za-z0-9-]/g, "-").slice(-40)}`;
  // A previous request may have reached Zoho even if the response was lost.
  // On retries, search Zoho first by the unique sales-order number.
  if (job.attempts > 1) {
    const matches: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await inventoryRequest<{ salesorders?: Record<string, unknown>[] }>(region, organizationId, token, "salesorders", "GET", undefined, { page: String(page), per_page: "200" });
      const pageRows = result.salesorders ?? [];
      matches.push(...pageRows.filter((row) => str(row["salesorder_number"]) === safeNumber));
      if (pageRows.length < 200) break;
      if (page === 100) throw new NeedsReviewError("Zoho sales-order lookup reached the safety limit during duplicate prevention");
    }
    if (matches.length > 1) throw new NeedsReviewError(`More than one Zoho sales order uses ${safeNumber}`);
    if (matches.length === 1) {
      const existingId = str(matches[0]!["salesorder_id"]);
      const { error: saveExistingError } = await db.from("orders").update({ zoho_salesorder_id: existingId }).eq("id", order.id).is("zoho_salesorder_id", null);
      if (saveExistingError) throw new Error("Existing Zoho order found but its ID could not be recorded");
      return;
    }
  }
  const payload = {
    salesorder_number: safeNumber,
    reference_number: String(order.order_no).slice(0, 100),
    customer_id: customerId,
    date: datePart(order.created_at, new Date().toISOString().slice(0, 10)),
    line_items: lineItems,
    discount: Number(order.discount) || 0,
    discount_type: "entity_level",
    is_discount_before_tax: true,
    shipping_charge: Number(order.shipping) || 0,
    is_inclusive_tax: false,
    notes: `Grain Bazar order ${order.order_no}; payment ${order.payment_status}; app total ₹${Number(order.total).toFixed(2)}. Verify tax treatment and total in Zoho before invoicing.`,
    ...(order.customer_gstin ? { gst_no: order.customer_gstin } : {}),
  };
  const created = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, "salesorders", "POST", payload, { ignore_auto_number_generation: "true" });
  const salesOrderId = str(created.salesorder?.["salesorder_id"]);
  if (!salesOrderId) throw new Error("Zoho created a sales order but returned no salesorder_id");
  const { error: saveError } = await db.from("orders").update({ zoho_salesorder_id: salesOrderId }).eq("id", order.id).is("zoho_salesorder_id", null);
  if (saveError) throw new Error("Zoho sales order created, but its ID could not be stored; retry will check Zoho's unique order number");
  const zohoTotal = Number(created.salesorder?.["total"]);
  if (Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 2.00)
    throw new NeedsReviewError(`Zoho accepted order ${safeNumber}, but total ₹${zohoTotal.toFixed(2)} differs from Grain Bazar ₹${Number(order.total).toFixed(2)}. Review taxes, discount, and shipping before processing.`);
}

async function syncZohoCustomer(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string, userId: string) {
  const { data: roles, error } = await db.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error("Could not verify the Grain Bazar account role");
  let synced = false;
  if ((roles ?? []).some((role) => role.role === "customer")) {
    await upsertZohoContact(db, region, organizationId, token, userId, "customer");
    synced = true;
  }
  if ((roles ?? []).some((role) => role.role === "vendor")) {
    await upsertZohoContact(db, region, organizationId, token, userId, "vendor");
    synced = true;
  }
  if (!synced && (roles ?? []).some((role) => role.role === "admin")) {
    await upsertZohoContact(db, region, organizationId, token, userId, "vendor");
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
      const zohoModifiedAt = str(item["last_modified_time"]);
      const zohoModifiedMs = Date.parse(zohoModifiedAt);
      const knownModifiedMs = Date.parse(link.last_zoho_modified_at ?? "");
      const isNewZohoEdit = Number.isFinite(zohoModifiedMs) &&
        (!Number.isFinite(knownModifiedMs) || zohoModifiedMs > knownModifiedMs);
      if (!isNewZohoEdit) {
        await db.from("zoho_item_links").update({ last_polled_at: new Date().toISOString() })
          .eq("product_id", link.product_id);
        continue;
      }

      const { data: product, error: productError } = await db.from("catalog_products")
        .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
        .eq("id", link.product_id).maybeSingle();
      if (productError || !product) throw new Error("Could not compare the Zoho item to the mapped Grain Bazar product");
      const currentFingerprint = await catalogFingerprint(product);
      if (link.app_fingerprint && currentFingerprint !== link.app_fingerprint) {
        await saveZohoReview(
          db,
          "catalog",
          product.id,
          `Zoho item ${link.zoho_item_id} and Grain Bazar product ${product.id} changed since the last sync; review before choosing a winner.`,
        );
        await db.from("zoho_item_links").update({
          last_polled_at: new Date().toISOString(),
          last_zoho_modified_at: zohoModifiedAt,
        }).eq("product_id", link.product_id);
        result.needsReview += 1;
        continue;
      }

      const { error: applyError } = await db.rpc("apply_zoho_catalog_item", {
        _product_id: product.id,
        _item: item as Json,
        _expected_updated_at: product.updated_at,
      });
      if (applyError)
        throw new Error("Zoho item was fetched, but Grain Bazar could not safely apply the update");
      const { data: applied, error: appliedError } = await db.from("catalog_products")
        .select("id,vendor_id,category,status,active,payload,created_at,updated_at")
        .eq("id", product.id).single();
      if (appliedError || !applied)
        throw new Error("Zoho item was applied, but Grain Bazar could not confirm the resulting product");
      const { error: cursorError } = await db.from("zoho_item_links").update({
        updated_at: new Date().toISOString(),
        last_polled_at: new Date().toISOString(),
        last_zoho_modified_at: zohoModifiedAt,
        app_fingerprint: await catalogFingerprint(applied),
      }).eq("product_id", link.product_id);
      if (cursorError)
        throw new Error("Zoho item was applied, but its reconciliation cursor could not be saved");
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
  .validator(z.object({ limit: z.number().int().min(1).max(100).default(50) }).optional())
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const limit = data?.limit ?? 50;
    return await processZohoSyncOutbox(limit, { force: true });
  });

/**
 * Processes queued outbound records to Zoho. Active by default; can also be forced by admin action.
 */
export async function processZohoSyncOutbox(limit = 20, options?: { force?: boolean }) {
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
  for (const job of (jobs ?? []) as ZohoSyncJob[]) {
    let status: "complete" | "failed" | "needs_review" = "complete";
    let errorMessage: string | null = null;
    try {
      if (job.entity_type === "customer")
        await syncZohoCustomer(db, region, connection.organization_id, token, job.entity_id);
      else if (job.entity_type === "order")
        await syncZohoOrder(db, region, connection.organization_id, token, job);
      else
        await syncZohoCatalogItem(db, region, connection.organization_id, token, job.entity_id);
    } catch (cause) {
      errorMessage = (cause instanceof Error ? cause.message : "Unexpected Zoho sync failure").slice(0, 1000);
      status = cause instanceof NeedsReviewError ? "needs_review" : "failed";
    }
    const { error: finishError } = await db.rpc("finish_zoho_sync_job", { _id: job.id, _status: status, _error: errorMessage });
    if (finishError) throw new Error(`Zoho job ${job.id} was processed but its result could not be recorded`);
    if (status === "complete") summary.complete += 1;
    else if (status === "failed") summary.failed += 1;
    else summary.needsReview += 1;
  }
  const [contacts, fulfillment, catalog] = await Promise.all([
    pollZohoContactChanges(db, region, connection.organization_id, token, limit),
    pollZohoOrderFulfillment(db, region, connection.organization_id, token, limit),
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
        const { error: saveError } = await db
          .from("catalog_products")
          .upsert(rows.slice(i, i + 100), { onConflict: "id" });
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

export const syncSingleOrderToZoho = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: order, error } = await db
      .from("orders")
      .select("id, order_no, zoho_salesorder_id")
      .eq("order_no", data.orderNo)
      .maybeSingle();
    if (error || !order) throw new Error("Order not found for Zoho synchronization");

    const { error: enqueueError } = await db.rpc("enqueue_zoho_sync", {
      _entity_type: "order",
      _entity_id: order.id,
    });
    if (enqueueError) throw new Error("Could not queue order for Zoho synchronization");

    const res = await processZohoSyncNow({ data: { limit: 10, force: true } });
    const { data: updated } = await db
      .from("orders")
      .select("zoho_salesorder_id")
      .eq("id", order.id)
      .maybeSingle();

    return {
      success: true,
      zohoSalesOrderId: updated?.zoho_salesorder_id ?? null,
      processed: res.processed,
      complete: res.complete,
    };
  });

