import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";

const REGIONS = {
  com: ["https://accounts.zoho.com", "https://commerce.zoho.com"],
  eu: ["https://accounts.zoho.eu", "https://commerce.zoho.eu"],
  in: ["https://accounts.zoho.in", "https://commerce.zoho.in"],
  com_au: ["https://accounts.zoho.com.au", "https://commerce.zoho.com.au"],
  jp: ["https://accounts.zoho.jp", "https://commerce.zoho.jp"],
  ca: ["https://accounts.zohocloud.ca", "https://commerce.zoho.ca"],
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
  const data = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as {
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
    const payload = b64(
      enc.encode(
        JSON.stringify({
          uid: context.userId,
          org: data.organizationId,
          region: data.region,
          exp: Date.now() + 600_000,
        }),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const auth = new URL(`${REGIONS[data.region][0]}/oauth/v2/auth`);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: reqEnv("ZOHO_CLIENT_ID"),
      scope:
        "ZohoCommerce.items.READ,ZohoCommerce.coupons.READ,ZohoCommerce.salesorders.READ,ZohoCommerce.settings.READ,ZohoCommerce.sitesIndex.READ",
      redirect_uri: redirectUri,
      access_type: "offline",
      prompt: "consent",
      state: `${payload}.${await sign(payload)}`,
    }).toString();
    return { url: auth.toString() };
  });

export async function completeZohoAuthorization(code: string, state: string) {
  const info = await verifyState(state);
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
