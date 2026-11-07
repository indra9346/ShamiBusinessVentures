import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  RICE_PO_SETTINGS_KEY, cancelRicePo, checkRicePo, createInZohoOnce, differsFromRaised, findPurchaseOrdersByReference, gstPreferencesFrom, inPlay, indiaToday, isSamplePhone, itemBody, itemMatchFrom, nameKey,
  PO_DEATH_WORDS, planPoLine, plainZohoRefusal, poDescription, poLineProblem, poReference, raiseRicePo, retiredPoProblem, settleRaisedPo, syncRaisedPos, vendorBody, vendorMatchesFrom, zohoVerdict,
  type CancelResult, type ClaimAnswer, type CreationStore, type PoActor, type PoFound, type PoLifeStore, type PoPlan, type PoStore, type PoSyncResult, type RaiseResult, type RecordAnswer, type ReleaseAnswer, type RetiredPo, type RiceEvent, type RicePo, type RiceSample, type RiceTest,
  type TakeoverAnswer, type ZohoItemMatch, type ZohoRaw, type ZohoSend, type ZohoVendorMatch,
  canCancelPo, poTaxFrom, zohoStatusLabel, type PoTaxAnswer,
} from "@/lib/rice-samples";
import { GSTIN_REGEX, normaliseGstin } from "@/lib/gstin";
import { zohoPaused } from "@/lib/zoho-sync-core";

/*
 * Admin > Rice Samples. Everything here checks the admin role. The page reads through the admin's own session, so the
 * tables' row security applies; only the purchase order lock and Zoho calls use the service role. The rules live in
 * src/lib/rice-samples.ts; this file connects them to the database and to Zoho.
 */

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

const PAGE = 1000;
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${what}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

const n = (value: unknown) => Number(value) || 0;
const nullableNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const asRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);

type ReadClient = SupabaseClient<Database>;

const poFromRow = (row: Database["public"]["Tables"]["rice_sample_purchase_orders"]["Row"]): RicePo => ({
  sample_id: row.sample_id, reference: row.reference, state: row.state as RicePo["state"], generation: row.generation, retired_pos: (row.retired_pos ?? []) as unknown as RetiredPo[], attempt_id: row.attempt_id, attempts: row.attempts,
  snapshot: row.snapshot as unknown as PoPlan, claimed_by_name: row.claimed_by_name, claimed_at: row.claimed_at, last_error: row.last_error,
  zoho_po_id: row.zoho_po_id, zoho_po_number: row.zoho_po_number, zoho_po_status: row.zoho_po_status,
  zoho_sub_total: nullableNumber(row.zoho_sub_total), zoho_tax_total: nullableNumber(row.zoho_tax_total), zoho_total: nullableNumber(row.zoho_total),
  differences: row.differences ?? [], duplicates: (row.duplicates ?? []) as unknown as PoFound[], zoho_gone: row.zoho_gone,
  zoho_checked_at: row.zoho_checked_at, raised_at: row.raised_at, raised_by_name: row.raised_by_name,
});

export type RiceGodown = { id: string; name: string; isDefault: boolean; locationId: string; locationName: string };

async function readSettings(db: ReadClient) {
  const { data } = await db.from("settings").select("value").eq("key", RICE_PO_SETTINGS_KEY).maybeSingle();
  return { issueOnCreate: asRecord(data?.value)["issueOnCreate"] === true };
}

/**
 * Everything the page shows. Read as the signed-in admin, so row security decides what comes back. A POST, because every caller's
 * GET would have the same address and no cache header, and a cache in front of the site must never store prices and phone numbers.
 */
export const getRiceSampleDesk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = context.supabase;
    const [samples, tests, events, pos, branches, settings, profile, connection] = await Promise.all([
      allRows((from, to) => db.from("rice_samples").select("*").order("arrival_date", { ascending: false }).order("id").range(from, to), "rice samples"),
      allRows((from, to) => db.from("rice_sample_tests").select("*").order("tested_at", { ascending: false }).order("id").range(from, to), "cook tests"),
      allRows((from, to) => db.from("rice_sample_events").select("*").order("at", { ascending: false }).order("id", { ascending: false }).range(from, to), "sample history"),
      allRows((from, to) => db.from("rice_sample_purchase_orders").select("*").order("sample_id").range(from, to), "purchase orders"),
      db.from("branches").select("id,name,is_default,active,vendor_id,zoho_location_id,zoho_location_name,sort_order").order("sort_order"),
      readSettings(db),
      db.from("profiles").select("full_name").eq("id", context.userId).maybeSingle(),
      // Holds the Zoho token, so only the service role reads it, and only these two columns.
      (serviceClient() as unknown as SupabaseClient).from("zoho_commerce_connection").select("organization_id,region").eq("id", true).maybeSingle(),
    ]);
    if (branches.error) throw new Error("Could not read godowns");
    const godowns: RiceGodown[] = (branches.data ?? []).filter((b) => b.active && !b.vendor_id).map((b) => ({
      id: b.id, name: b.name, isDefault: b.is_default, locationId: b.zoho_location_id, locationName: b.zoho_location_name,
    }));
    return {
      samples: samples.map((s): RiceSample => ({ ...s, party_role: s.party_role as RiceSample["party_role"], status: s.status as RiceSample["status"], price_per_qntl: n(s.price_per_qntl), quantity_qntl: n(s.quantity_qntl),
        // Missing until the bags migration is applied, and null for a sample entered in quintals.
        quantity_bags: s.quantity_bags == null ? null : n(s.quantity_bags), bag_kg: s.bag_kg == null ? null : n(s.bag_kg) })),
      tests: tests as unknown as RiceTest[],
      events: events as unknown as RiceEvent[],
      pos: pos.map(poFromRow),
      godowns,
      issueOnCreate: settings.issueOnCreate,
      adminName: text(profile.data?.full_name),
      zoho: connection.data ? { region: text(connection.data["region"]), organizationId: text(connection.data["organization_id"]) } : null,
    };
  });
export type RiceDesk = Awaited<ReturnType<typeof getRiceSampleDesk>>;

// ---------------------------------------------------------------- Zoho, through the file that logs every call

const PURPOSE = "Rice sample purchase order";

async function zohoKit() {
  const { openZohoInventory, withZohoPurpose } = await import("@/lib/zoho-commerce.functions");
  return { openZohoInventory, withZohoPurpose };
}

/** Runs `fn` with Zoho connected, every call logged under this desk. A Zoho that cannot be reached at all becomes plain words. */
async function withZoho<T>(fn: (zoho: { send: ZohoSend; region: string; organizationId: string }) => Promise<T>, purpose = PURPOSE): Promise<T> {
  const { openZohoInventory, withZohoPurpose } = await zohoKit();
  return withZohoPurpose(purpose, async () => {
    let zoho;
    try {
      zoho = await openZohoInventory();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      throw new Error(/connect zoho/i.test(message) ? "Zoho is not connected. Open Admin > Zoho Commerce and connect it first." : `Could not sign in to Zoho. Open Admin > Zoho Commerce and press Reauthorize Zoho. (${message})`);
    }
    return fn(zoho);
  });
}

const readOk = (raw: ZohoRaw) => {
  if (zohoVerdict(raw) !== "ok") throw new Error(plainZohoRefusal(raw));
  return asRecord(raw.body);
};

/** Shown as soon as the buy screen opens, so the owner learns about a missing permission before filling anything in. */
export const checkZohoPurchaseAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    try {
      return await withZoho(async ({ send }) => {
        readOk(await send("purchaseorders", "GET", undefined, { per_page: "1" }));
        return { ok: true as const, message: "" };
      });
    } catch (cause) {
      return { ok: false as const, message: cause instanceof Error ? cause.message : "Zoho could not be reached." };
    }
  });

const vendorSearchInput = z.object({ name: z.string().trim().max(120).default(""), phone: z.string().trim().max(20).default("") });

/** Zoho vendors by name, company or phone. Customers with the same name are returned too, marked, so the admin isn't misled. */
export const searchZohoVendors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(vendorSearchInput)
  .handler(async ({ data, context }): Promise<ZohoVendorMatch[]> => {
    await ensureAdmin(context.supabase, context.userId);
    const phone = data.phone.replace(/\D/g, "").slice(-10);
    return withZoho(async ({ send }) => {
      const queries: Record<string, string>[] = [];
      if (data.name) queries.push({ contact_name_contains: data.name, per_page: "50" }, { company_name_contains: data.name, per_page: "50" });
      if (phone.length === 10) queries.push({ phone_contains: phone, per_page: "50" });
      const results = await Promise.all(queries.map((query) => send("contacts", "GET", undefined, query)));
      return vendorMatchesFrom(results.flatMap((raw) => asRecords(readOk(raw)["contacts"])), data.name, phone);
    });
  });

export const searchZohoItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ text: z.string().trim().min(1).max(100) }))
  .handler(async ({ data, context }): Promise<ZohoItemMatch[]> => {
    await ensureAdmin(context.supabase, context.userId);
    return withZoho(async ({ send }) => {
      const body = readOk(await send("items", "GET", undefined, { name_contains: data.text, per_page: "50" }));
      return asRecords(body["items"]).map(itemMatchFrom).filter((item) => item.id && item.active && item.canBePurchased).sort((a, b) => a.name.localeCompare(b.name));
    });
  });

async function actorOf(db: ReadClient, userId: string): Promise<PoActor> {
  const { data } = await db.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
  return { userId, name: text(data?.full_name).trim() || text(data?.email).trim() || "Admin" };
}

function creationStore(db: ReadClient): CreationStore {
  const call = async (name: "rice_sample_creation_claim" | "rice_sample_creation_takeover", args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args as never);
    if (error) throw new Error(error.message);
    return data as never;
  };
  return {
    claim: ({ kind, key, displayName, attemptId, actor }) => call("rice_sample_creation_claim", { _kind: kind, _name_key: key, _display_name: displayName, _attempt_id: attemptId, _user: actor.userId, _user_name: actor.name }),
    takeover: ({ kind, key, expectedAttempt, attemptId, actor }) => call("rice_sample_creation_takeover", { _kind: kind, _name_key: key, _expected_attempt: expectedAttempt, _attempt_id: attemptId, _user: actor.userId, _user_name: actor.name }),
    finish: async ({ kind, key, attemptId, state, zohoId, message }) => {
      const { error } = await db.rpc("rice_sample_creation_finish", { _kind: kind, _name_key: key, _attempt_id: attemptId, _state: state, _zoho_id: zohoId, _message: message });
      if (error) throw new Error(error.message);
    },
  };
}

/** A new Zoho vendor. Only after the admin confirmed it on screen; `confirmed` must be true. */
export const createZohoVendorForSample = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    name: z.string().trim().min(2).max(120), phone: z.string().trim().max(20), gstin: z.string().trim().max(20).default(""),
    placeOfContact: z.string().trim().regex(/^[A-Z]{2}$/), confirmed: z.literal(true),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const gstin = normaliseGstin(data.gstin);
    if (gstin && !GSTIN_REGEX.test(gstin)) throw new Error("This is not a valid GSTIN (for example 29ABCDE1234F1Z5)");
    if (data.phone && !isSamplePhone(data.phone)) throw new Error("Enter a phone number with 10 digits, or leave it empty");
    const db = serviceClient();
    const actor = await actorOf(db, context.userId);
    return withZoho(async ({ send }) => {
      const { cleanAndValidateGstin } = await import("@/lib/zoho-commerce.functions");
      const placeOfContact = (gstin && cleanAndValidateGstin(gstin).placeOfContact) || data.placeOfContact;
      const findExact = async () => {
        const rows = asRecords(readOk(await send("contacts", "GET", undefined, { contact_name_contains: data.name, per_page: "200" }))["contacts"]);
        const match = rows.find((row) => nameKey(text(row["contact_name"])) === nameKey(data.name) && text(row["contact_type"]).toLowerCase() === "vendor");
        return match ? text(match["contact_id"]) : null;
      };
      return createInZohoOnce({ store: creationStore(db), zoho: send, newId: () => crypto.randomUUID() }, "vendor", {
        name: data.name, resource: "contacts", idField: "contact_id", responseKey: "contact", findExact,
        body: vendorBody({ name: data.name, phone: data.phone, gstin, placeOfContact }),
      }, actor);
    });
  });

/** A new Zoho item. Only after the admin confirmed it on screen; `confirmed` must be true. */
export const createZohoItemForSample = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    name: z.string().trim().min(2).max(100), unit: z.enum(["qtl", "kg"]), hsn: z.string().trim().regex(/^\d{6,8}$/),
    purchaseRate: z.number().positive().max(100_000_000), gstRate: z.union([z.literal(5), z.null()]), confirmed: z.literal(true),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const actor = await actorOf(db, context.userId);
    return withZoho(async ({ send }) => {
      let taxPreferences: { tax_id: string; tax_specification: string }[] | null = null;
      if (data.gstRate !== null) {
        const taxes = asRecords(readOk(await send("settings/taxes", "GET"))["taxes"]);
        taxPreferences = gstPreferencesFrom(taxes, data.gstRate);
        if (!taxPreferences) throw new Error(`Zoho's tax list has no single GST${data.gstRate} and IGST${data.gstRate} to use. The item was not created. Choose "Set GST later in Zoho" or fix the taxes in Zoho.`);
      }
      const findExact = async () => {
        const rows = asRecords(readOk(await send("items", "GET", undefined, { name_contains: data.name, per_page: "200" }))["items"]);
        const match = rows.find((row) => nameKey(text(row["name"])) === nameKey(data.name));
        return match ? text(match["item_id"]) : null;
      };
      const result = await createInZohoOnce({ store: creationStore(db), zoho: send, newId: () => crypto.randomUUID() }, "item", {
        name: data.name, resource: "items", idField: "item_id", responseKey: "item", findExact,
        body: itemBody({ name: data.name, unit: data.unit, hsn: data.hsn, purchaseRate: data.purchaseRate, taxPreferences }),
      }, actor);
      if (result.kind !== "created" && result.kind !== "exists") return { result, item: null };
      const raw = await send(`items/${encodeURIComponent(result.id)}`, "GET");
      const item = zohoVerdict(raw) === "ok" ? itemMatchFrom(asRecord(raw.body?.["item"])) : null;
      return { result, item };
    });
  });

// ---------------------------------------------------------------- The purchase order

function poStore(db: ReadClient): PoStore {
  const rpc = async <T>(name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name as never, args as never);
    if (error) throw new Error((error as { message: string }).message);
    return data as T;
  };
  return {
    claim: ({ sampleId, attemptId, reference, snapshot, actor }) => rpc<ClaimAnswer>("rice_sample_po_claim", { _sample_id: sampleId, _attempt_id: attemptId, _reference: reference, _snapshot: snapshot, _user: actor.userId, _user_name: actor.name }),
    takeover: ({ sampleId, expectedAttempt, attemptId, snapshot, actor }) => rpc<TakeoverAnswer>("rice_sample_po_takeover", { _sample_id: sampleId, _expected_attempt: expectedAttempt, _attempt_id: attemptId, _snapshot: snapshot, _user: actor.userId, _user_name: actor.name }),
    release: ({ sampleId, expectedAttempt, actor }) => rpc<ReleaseAnswer>("rice_sample_po_release", { _sample_id: sampleId, _expected_attempt: expectedAttempt, _user: actor.userId, _user_name: actor.name }),
    markFailed: ({ sampleId, attemptId, state, message, detail, actor }) => rpc<void>("rice_sample_po_mark_failed", { _sample_id: sampleId, _attempt_id: attemptId, _state: state, _message: message, _detail: detail, _user: actor.userId, _user_name: actor.name }),
    record: ({ sampleId, po, subTotal, taxTotal, total, differences, foundBySearch, actor }) => rpc<RecordAnswer>("rice_sample_po_record", {
      _sample_id: sampleId, _po_id: po.id, _po_number: po.number, _po_status: po.status, _sub_total: subTotal, _tax_total: taxTotal, _total: total,
      _differences: differences, _found_by_search: foundBySearch, _user: actor.userId, _user_name: actor.name,
    }),
  };
}

const engine = (db: ReadClient, send: ZohoSend) => ({
  store: poStore(db), zoho: send, newId: () => crypto.randomUUID(), now: () => Date.now(),
  log: (event: string, detail: Record<string, unknown>) => console.warn(JSON.stringify({ event, ...detail })),
});

async function readPo(db: ReadClient, sampleId: string) {
  const { data, error } = await db.from("rice_sample_purchase_orders").select("*").eq("sample_id", sampleId).maybeSingle();
  if (error) throw new Error("Could not read this sample's purchase order");
  return data ? poFromRow(data) : null;
}

const raisedResult = (po: RicePo): Extract<RaiseResult, { kind: "raised" }> => ({ kind: "raised", poId: po.zoho_po_id, poNumber: po.zoho_po_number, poStatus: po.zoho_po_status, total: po.zoho_total, warnings: [], already: true });
const BUSY_MS = 120_000;
const stillSending = (po: RicePo) => po.state === "sending" && Date.now() - Date.parse(po.claimed_at) < BUSY_MS;

const raiseInput = z.object({
  sampleId: z.string().uuid(),
  vendorRole: z.enum(["broker", "seller"]),
  vendorId: z.string().trim().regex(/^\d{1,30}$|^[A-Za-z0-9_-]{1,40}$/),
  itemId: z.string().trim().regex(/^\d{1,30}$|^[A-Za-z0-9_-]{1,40}$/),
  kgPerUnit: z.number().positive().max(100_000),
  quantityQntl: z.number().positive().max(1_000_000),
  ratePerQntl: z.number().positive().max(1_000_000),
  branchId: z.string().trim().min(1).max(40),
  // What the admin's confirmation screen showed. The server works these out again and refuses if they differ.
  confirmed: z.object({
    vendorName: z.string().max(200), itemName: z.string().max(200), itemUnit: z.string().max(40), poQuantity: z.number(), poRate: z.number(), subTotal: z.number(), issueOnCreate: z.boolean(), taxId: z.string().max(40), taxKind: z.enum(["intra", "inter", "none"]), taxPercent: z.number(), sourceOfSupply: z.string().max(4), destinationOfSupply: z.string().max(4),
    sampleUpdatedAt: z.string().max(60),
  }),
});

/** The tax to show on the confirm screen, from the vendor, item and godown as they are now. Reads Zoho, changes nothing. */
export const previewRicePoTax = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ vendorId: raiseInput.shape.vendorId, itemId: raiseInput.shape.itemId, branchId: raiseInput.shape.branchId }))
  .handler(async ({ data, context }): Promise<PoTaxAnswer> => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: branch } = await serviceClient().from("branches").select("name,state_code").eq("id", data.branchId).maybeSingle();
    if (!branch) return { ok: false, message: "Choose a godown first." };
    return withZoho(async ({ send }) => {
      const vendorRaw = await send(`contacts/${encodeURIComponent(data.vendorId)}`, "GET");
      if (zohoVerdict(vendorRaw) !== "ok") return { ok: false, message: `The vendor could not be read from Zoho. ${plainZohoRefusal(vendorRaw)}` };
      const itemRaw = await send(`items/${encodeURIComponent(data.itemId)}`, "GET");
      if (zohoVerdict(itemRaw) !== "ok") return { ok: false, message: `The item could not be read from Zoho. ${plainZohoRefusal(itemRaw)}` };
      return poTaxFrom(asRecord(itemRaw.body?.["item"]), asRecord(vendorRaw.body?.["contact"]), { name: branch.name, stateCode: text(branch.state_code) });
    }, "Rice sample desk: tax check");
  });

/**
 * Raises the sample's purchase order. Works out the figures again, reads the vendor and item fresh from Zoho, and only then
 * asks the lock. A request that fails after the lock is held always answers "uncertain", so nobody is told it is safe to retry
 * when it may not be.
 */
export const raiseRiceSamplePurchaseOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(raiseInput)
  .handler(async ({ data, context }): Promise<RaiseResult> => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const existing = await readPo(db, data.sampleId);
    if (existing?.state === "raised") return { ...raisedResult(existing), warnings: differsFromRaised(existing.snapshot, { ...data, taxId: data.confirmed.taxId, taxKind: data.confirmed.taxKind }) };
    if (existing && stillSending(existing)) return { kind: "in_progress", message: `${existing.claimed_by_name || "Another admin"} is raising this purchase order right now. It will show here in a moment.` };

    const [{ data: sample }, { data: branch }] = await Promise.all([
      db.from("rice_samples").select("*").eq("id", data.sampleId).maybeSingle(),
      db.from("branches").select("id,name,active,vendor_id,zoho_location_id,state_code").eq("id", data.branchId).maybeSingle(),
    ]);
    if (!sample) return { kind: "rejected", message: "This sample no longer exists." };
    if (sample.deleted_at) return { kind: "rejected", message: "This card is deleted. Restore it first. Nothing was sent to Zoho." };
    if (!inPlay(sample.status as RiceSample["status"])) return { kind: "rejected", message: `This sample is ${sample.status}. Nothing was sent to Zoho.` };
    if (sample.updated_at !== data.confirmed.sampleUpdatedAt) return { kind: "rejected", message: "This sample has changed since you opened this screen. Review it and confirm again. Nothing was sent to Zoho." };
    // A broker's sample can be bought from the broker or from the seller behind them, once that seller's name is on record.
    if (data.vendorRole === "broker" && sample.party_role !== "broker") return { kind: "rejected", message: "This sample has no broker on record. Nothing was sent to Zoho." };
    if (data.vendorRole === "seller" && sample.party_role === "broker" && !text(sample.seller_name)) return { kind: "rejected", message: "This sample has no seller on record, only the broker. Edit the sample first. Nothing was sent to Zoho." };
    if (!branch?.active || branch.vendor_id) return { kind: "rejected", message: "Choose an active godown. Nothing was sent to Zoho." };
    if (!branch.zoho_location_id) return { kind: "rejected", message: `${branch.name} is not linked to a Zoho location, so the rice would not be received at the right place. Link it in Admin > Branches. Nothing was sent to Zoho.` };
    const settings = await readSettings(db);
    if (settings.issueOnCreate !== data.confirmed.issueOnCreate) {
      return { kind: "rejected", message: `The purchase order setting has changed: it would now be created as ${settings.issueOnCreate ? "Issued" : "Draft"}. Review and confirm again. Nothing was sent to Zoho.` };
    }

    return withZoho(async ({ send, organizationId }) => {
      // An earlier purchase order brought back to life in Zoho would make this one a second live order.
      if (existing?.retired_pos.length) {
        const problem = await retiredPoProblem(send, existing.retired_pos);
        if (problem) return { kind: "rejected", message: problem };
      }
      // Vendor and item straight from Zoho, not from what the browser remembers.
      const vendorRaw = await send(`contacts/${encodeURIComponent(data.vendorId)}`, "GET");
      if (zohoVerdict(vendorRaw) !== "ok") return { kind: "rejected", message: `The vendor could not be read from Zoho. ${plainZohoRefusal(vendorRaw)} Nothing was sent.` };
      const vendor = asRecord(vendorRaw.body?.["contact"]);
      if (text(vendor["contact_type"]).toLowerCase() !== "vendor") return { kind: "rejected", message: `${text(vendor["contact_name"]) || "This contact"} is a customer in Zoho, not a vendor. Choose or create a vendor. Nothing was sent.` };
      if (text(vendor["status"]).toLowerCase() === "inactive") return { kind: "rejected", message: `${text(vendor["contact_name"])} is inactive in Zoho. Nothing was sent.` };
      if (text(vendor["contact_name"]) !== data.confirmed.vendorName) return { kind: "rejected", message: `This vendor is now called "${text(vendor["contact_name"])}" in Zoho, not "${data.confirmed.vendorName}". Review and confirm again. Nothing was sent.` };
      const itemRaw = await send(`items/${encodeURIComponent(data.itemId)}`, "GET");
      if (zohoVerdict(itemRaw) !== "ok") return { kind: "rejected", message: `The item could not be read from Zoho. ${plainZohoRefusal(itemRaw)} Nothing was sent.` };
      const item = itemMatchFrom(asRecord(itemRaw.body?.["item"]));
      if (!item.id || !item.active || !item.canBePurchased) return { kind: "rejected", message: `${item.name || "This item"} cannot be bought in Zoho (inactive or not for purchase). Nothing was sent.` };
      if (item.name !== data.confirmed.itemName) return { kind: "rejected", message: `This item is now called "${item.name}" in Zoho, not "${data.confirmed.itemName}". Review and confirm again. Nothing was sent.` };
      if (item.unit !== data.confirmed.itemUnit) return { kind: "rejected", message: `${item.name}'s unit in Zoho is now "${item.unit || "not set"}", not "${data.confirmed.itemUnit || "not set"}". Review and confirm again. Nothing was sent.` };

      const problem = poLineProblem({ quantityQntl: data.quantityQntl, ratePerQntl: data.ratePerQntl, kgPerUnit: data.kgPerUnit, availableQntl: n(sample.quantity_qntl), unit: item.unit, itemName: item.name });
      if (problem) return { kind: "rejected", message: `${problem} Nothing was sent to Zoho.` };
      const line = planPoLine({ quantityQntl: data.quantityQntl, ratePerQntl: data.ratePerQntl, kgPerUnit: data.kgPerUnit });
      if (line.poQuantity !== data.confirmed.poQuantity || line.poRate !== data.confirmed.poRate || line.subTotal !== data.confirmed.subTotal) {
        return { kind: "rejected", message: "The figures on your screen do not match the sample any more. Review and confirm again. Nothing was sent to Zoho." };
      }
      // The tax as Zoho has it now, which must be what the confirm screen showed.
      const taxAnswer = poTaxFrom(asRecord(itemRaw.body?.["item"]), vendor, { name: branch.name, stateCode: text(branch.state_code) });
      if (!taxAnswer.ok) return { kind: "rejected", message: `${taxAnswer.message} Nothing was sent to Zoho.` };
      const { tax } = taxAnswer;
      if (tax.kind !== data.confirmed.taxKind || tax.taxId !== data.confirmed.taxId || tax.percent !== data.confirmed.taxPercent || tax.sourceOfSupply !== data.confirmed.sourceOfSupply || tax.destinationOfSupply !== data.confirmed.destinationOfSupply) return { kind: "rejected", message: `The tax has changed since this screen opened: it is now ${tax.taxName}. Review and confirm again. Nothing was sent to Zoho.` };
      const plan: PoPlan = {
        reference: existing?.state === "dead" ? poReference(sample.id, existing.generation + 1) : existing?.reference ?? poReference(sample.id), date: indiaToday(Date.now()), vendorRole: data.vendorRole, vendorId: data.vendorId, vendorName: text(vendor["contact_name"]),
        itemId: data.itemId, itemName: item.name, itemUnit: item.unit, kgPerUnit: data.kgPerUnit, quantityQntl: data.quantityQntl, ratePerQntl: data.ratePerQntl,
        poQuantity: line.poQuantity, poRate: line.poRate, subTotal: line.subTotal, gstPercent: tax.percent, taxId: tax.taxId, taxName: tax.taxName, taxKind: tax.kind, sourceOfSupply: tax.sourceOfSupply, destinationOfSupply: tax.destinationOfSupply, branchId: branch.id, branchName: branch.name, locationId: branch.zoho_location_id,
        issueOnCreate: settings.issueOnCreate, description: poDescription(sample.variety, sample.method, data.quantityQntl, data.ratePerQntl), organizationId,
      };
      const actor = await actorOf(db, context.userId);
      try {
        return await raiseRicePo(engine(db, send), sample.id, plan, actor);
      } catch (cause) {
        // Either the lock refused (nothing sent), or something failed after it was held (Zoho may have it).
        const message = cause instanceof Error ? cause.message : "Something went wrong.";
        const unknown: RaiseResult = { kind: "uncertain", retryAfterSeconds: 0, message: `The website could not finish this (${message}). Zoho may have the purchase order. Press Check Zoho before anything else. Do not create it by hand in Zoho.` };
        let after: RicePo | null;
        try {
          after = await readPo(db, sample.id);
        } catch {
          return unknown;
        }
        if (after?.state === "raised") return raisedResult(after);
        if (after && (after.state === "sending" || after.state === "uncertain")) return unknown;
        return { kind: "rejected", message: `${message} Nothing was sent to Zoho.` };
      }
    });
  });

/** The Check Zoho button: searches Zoho by the sample's reference and links what it finds. Never creates anything. */
export const checkRiceSamplePurchaseOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ sampleId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<RaiseResult> => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const po = await readPo(db, data.sampleId);
    if (!po) return { kind: "absent", message: "No purchase order was started for this sample." };
    if (po.state === "raised") return raisedResult(po);
    if (po.state === "rejected") return { kind: "absent", message: "Zoho refused the last attempt, so nothing exists. You can raise it again." };
    if (stillSending(po)) return { kind: "in_progress", message: `${po.claimed_by_name || "Another admin"} is raising this purchase order right now.` };
    const actor = await actorOf(db, context.userId);
    return withZoho(({ send }) => checkRicePo(engine(db, send), data.sampleId, po, actor));
  });

/**
 * The way out when Zoho's list can't be searched in full: an admin searched Zoho by hand and says the purchase order is not there.
 * Goes on the sample's history by name. The two minutes still apply, and any later resend searches again first.
 */
export const releaseRiceSampleByHand = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ sampleId: z.string().uuid(), reference: z.string().max(60), confirmed: z.literal(true) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const po = await readPo(db, data.sampleId);
    if (!po || (po.state !== "sending" && po.state !== "uncertain") || po.reference !== data.reference) return { ok: false, message: "This has changed. Refresh the page." };
    const actor = await actorOf(db, context.userId);
    const { data: answer, error } = await db.rpc("rice_sample_po_release", { _sample_id: data.sampleId, _expected_attempt: po.attempt_id, _user: actor.userId, _user_name: actor.name, _by_hand: true });
    if (error) return { ok: false, message: error.message };
    const outcome = asRecord(answer);
    if (outcome["outcome"] === "released") return { ok: true, message: "" };
    return { ok: false, message: outcome["outcome"] === "too_soon" ? `Zoho may still be working on the last request. Wait ${text(outcome["wait_seconds"])} seconds.` : "This has changed. Refresh the page." };
  });

function poLifeStore(db: ReadClient): PoLifeStore {
  return {
    refresh: async ({ sampleId, poId, status, subTotal, taxTotal, total, gone, duplicates }) => {
      const { error } = await db.rpc("rice_sample_po_refresh", { _sample_id: sampleId, _po_id: poId, _po_status: status, _sub_total: subTotal, _tax_total: taxTotal, _total: total, _gone: gone, _duplicates: duplicates as unknown as Json });
      if (error) throw new Error(error.message);
    },
    markDead: async ({ sampleId, poId, reason, status, note, actor }) => {
      const { data, error } = await db.rpc("rice_sample_po_mark_dead", { _sample_id: sampleId, _po_id: poId, _reason: reason, _zoho_status: status, _note: note, _user: actor?.userId ?? null, _user_name: actor?.name ?? "" });
      if (error) throw new Error(error.message);
      return { outcome: asRecord(data)["outcome"] === "freed" ? "freed" : "changed" };
    },
    cancelAsked: async ({ sampleId, number, reason, actor }) => {
      const { error } = await db.rpc("rice_sample_po_cancel_asked", { _sample_id: sampleId, _po_number: number, _reason: reason, _user: actor.userId, _user_name: actor.name });
      if (error) throw new Error(error.message);
    },
  };
}

const EMPTY_SYNC: PoSyncResult = { checked: 0, freed: [], unknown: 0, listRead: false };
/** After a check that failed or left something unsettled, open pages wait this long before asking Zoho again. */
const POLL_HOLD_SECONDS = 300;

/**
 * Brings raised purchase orders in step with Zoho. Called while the page is open, and by the hourly sync so a sample is right even
 * if nobody looks. No raised purchase orders means no Zoho call at all. minGapSeconds: several open pages share one check.
 */
export async function syncRiceSamplePos(options: { minGapSeconds?: number } = {}): Promise<PoSyncResult> {
  const db = serviceClient();
  const { data: budget } = await db.from("settings").select("value").eq("key", "zoho_api_budget").maybeSingle();
  if (zohoPaused(text(asRecord(budget?.value)["pausedUntil"]), Date.now())) return EMPTY_SYNC;
  const { data, error } = await db.from("rice_sample_purchase_orders").select("*").eq("state", "raised").order("zoho_checked_at", { ascending: true, nullsFirst: true }).limit(200);
  if (error) throw new Error("Could not read purchase orders");
  const rows = (data ?? []).map(poFromRow);
  if (!rows.length) return EMPTY_SYNC;
  if (options.minGapSeconds) {
    const { data: claimed, error: claimError } = await db.rpc("rice_sample_po_poll_claim", { _gap_seconds: options.minGapSeconds });
    if (claimError) throw new Error("Could not read purchase orders");
    if (!claimed) return EMPTY_SYNC;
  }
  const hold = () => db.rpc("rice_sample_po_poll_hold", { _seconds: POLL_HOLD_SECONDS });
  try {
    const result = await withZoho(({ send, organizationId }) => syncRaisedPos({ store: poLifeStore(db), zoho: send, organizationId }, rows), "Rice sample desk: status check");
    if (!result.listRead || result.unknown) await hold();
    return result;
  } catch (cause) {
    await hold();
    throw cause;
  }
}

/** The open page's regular check. Quiet on failure: the next one tries again. */
export const pollRiceSamplePos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PoSyncResult> => {
    await ensureAdmin(context.supabase, context.userId);
    try {
      return await syncRiceSamplePos({ minGapSeconds: 45 });
    } catch (cause) {
      console.warn(JSON.stringify({ event: "rice_po_poll_failed", message: cause instanceof Error ? cause.message : String(cause) }));
      return EMPTY_SYNC;
    }
  });

/** Cancels a purchase order in Zoho, with Zoho's own "Mark as Cancelled". Needs the admin's confirmation and a reason. Never deletes from Zoho. */
export const cancelRiceSamplePurchaseOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // poId: the purchase order on the admin's screen. A newer one on the same sample is not what they agreed to cancel.
  .validator(z.object({ sampleId: z.string().uuid(), poId: z.string().trim().min(1).max(40), reason: z.string().trim().min(3).max(300), confirmed: z.literal(true) }))
  .handler(async ({ data, context }): Promise<CancelResult> => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const po = await readPo(db, data.sampleId);
    if (!po || po.state !== "raised") return { kind: "refused", message: "This sample has no live purchase order to cancel." };
    if (po.zoho_po_id !== data.poId) return { kind: "refused", message: `This sample now has a different purchase order, ${po.zoho_po_number}. Nothing was sent to Zoho. Close this and look again.` };
    if (!canCancelPo(po.zoho_po_status)) return { kind: "refused", message: `${po.zoho_po_number} is ${zohoStatusLabel(po.zoho_po_status)} in Zoho, so it can't be cancelled from here. Nothing was sent to Zoho.` };
    const actor = await actorOf(db, context.userId);
    return withZoho(({ send, organizationId }) => cancelRicePo({ store: poLifeStore(db), zoho: send, organizationId }, po, actor, data.reason));
  });

/** Zoho's current status for a raised purchase order, on the admin's request. */
export const refreshRiceSamplePoStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ sampleId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const po = await readPo(db, data.sampleId);
    if (!po || po.state !== "raised") return { ok: false, message: "This sample has no purchase order yet." };
    return withZoho(async ({ send, organizationId }) => {
      const store = poLifeStore(db);
      const settled = await settleRaisedPo({ store, zoho: send, organizationId }, po, null);
      if (settled.kind === "freed") return { ok: true, message: `${settled.number} is ${PO_DEATH_WORDS[settled.reason]} in Zoho. The sample is back in play.` };
      if (settled.kind === "changed") return { ok: true, message: "" };
      if (settled.kind !== "alive") return { ok: false, message: settled.message };
      // Finds any second purchase order with this reference, and proves on real data that the search after a lost answer works.
      const search = await findPurchaseOrdersByReference(send, po.reference);
      if (search.complete) await store.refresh({ sampleId: data.sampleId, poId: po.zoho_po_id, status: settled.status, subTotal: null, taxTotal: null, total: null, gone: false, duplicates: search.matches.filter((match) => match.id !== po.zoho_po_id) });
      const lost = search.complete && !search.matches.some((match) => match.id === po.zoho_po_id);
      return { ok: !lost, message: lost ? `Status updated, but Zoho's search by reference did not find this purchase order. Check its Reference# in Zoho is still ${po.reference}.` : "" };
    });
  });
