// Cashfree Payment Gateway on the server (owner, 28 Nov 2026). Makes the Cashfree order for a checkout, reads payments
// back from Cashfree, works through webhook calls parked on Supabase, and lets an admin switch it on or off. Every payment
// reaches an order only through the database function cashfree_record_payment. The secret key never leaves the server.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { SITE_URL } from "@/lib/seo";
import {
  CASHFREE_SETTING_KEY, cashfreeConfigFrom, cashfreeErrorLine, cashfreeHeaders, cashfreeNextStep, cashfreeOpenTo, cashfreeOrderBody,
  cashfreePaymentFrom, cashfreeReturnOrigin, cashfreeReturnUrl, cashfreeSettingFrom, cashfreeSetupProblem, cashfreeSignatureValid,
  cashfreeTester, cashfreeWebhookFrom, cashfreeWebhookUrl, type CashfreeConfig, type CashfreePayment,
} from "@/lib/cashfree";

type Db = SupabaseClient<Database>;
type CashfreeOrderRow = Database["public"]["Tables"]["cashfree_orders"]["Row"];

const env = () => process.env as Record<string, string | undefined>;
const log = (event: string, fields: Record<string, string | number | boolean | null | undefined> = {}) =>
  console.info(JSON.stringify({ at: "cashfree", event, ...fields }));

function dbAdmin(): Db {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("The website is missing its Supabase settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function isAdmin(supabase: Db, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return !error && Boolean(data);
}
async function ensureAdmin(supabase: Db, userId: string) {
  if (!(await isAdmin(supabase, userId))) throw new Error("Administrator access is required");
}
async function readSetting(db: Db) {
  const { data, error } = await db.from("settings").select("value").eq("key", CASHFREE_SETTING_KEY).maybeSingle();
  if (error) throw new Error("Could not read the Cashfree setting");
  return cashfreeSettingFrom(data?.value);
}
const databaseMessage = (error: { message?: string } | null) => (error?.message ?? "").replace(/^.*?ERROR:\s*/i, "").slice(0, 300);

// ---------------------------------------------------------------- Cashfree's API

async function cashfreeCall<T>(config: CashfreeConfig, path: string, init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    method: init.method ?? "GET",
    headers: cashfreeHeaders(config),
    body: init.body === undefined ? null : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body: body as T };
}

type CashfreeOrderEntity = { cf_order_id?: string | number; order_id?: string; order_status?: string; payment_session_id?: string; order_expiry_time?: string };

/** Records what Cashfree says about one payment; the database decides what it means for the order. */
async function recordPayment(db: Db, payment: CashfreePayment, source: "return" | "webhook" | "check" | "admin") {
  const { data, error } = await db.rpc("cashfree_record_payment", {
    _cf_order_ref: payment.cfOrderRef, _cf_payment_id: payment.cfPaymentId, _payment_status: payment.status, _amount: payment.amount,
    _bank_reference: payment.bankReference || null, _payment_group: payment.group || null, _payment_time: payment.paymentTime, _source: source,
  });
  if (error) throw new Error(databaseMessage(error) || "Could not record the Cashfree payment");
  const result = (data ?? {}) as { outcome?: string; already?: boolean };
  if (!result.already) log("payment_recorded", { ref: payment.cfOrderRef, payment: payment.cfPaymentId, status: payment.status, outcome: result.outcome ?? null, source });
  return result;
}

/**
 * Asks Cashfree about one of our Cashfree orders: every payment on it is recorded, then the order is closed when no
 * payment can come any more, or ended at Cashfree when the checkout is over (time up, cancelled, paid another way).
 */
async function refreshCashfreeOrder(db: Db, config: CashfreeConfig, row: CashfreeOrderRow, source: "return" | "check" | "admin", options: { closing?: boolean; force?: boolean } = {}) {
  const { data: order } = await db.from("orders").select("order_status, payment_hold_until").eq("id", row.order_id).maybeSingle();
  const checkoutDone = Boolean(options.closing) || !order || order.order_status !== "Awaiting Payment"
    || (order.payment_hold_until !== null && Date.parse(order.payment_hold_until) <= Date.now());
  if (row.environment !== config.environment) {
    // Made with the other keys (sandbox and production were swapped): these keys cannot ask about it.
    if (checkoutDone && row.status === "open") await closeRow(db, row.id, `Made with Cashfree ${row.environment} keys; the website now uses ${config.environment}`);
    return { paid: false };
  }
  if (!options.force && row.checked_at && Date.now() - Date.parse(row.checked_at) < 4_000) return { paid: false };
  // Another tab is making this Cashfree order this minute: Cashfree may not know it yet, so it is not closed for that.
  if (!row.payment_session_id && row.status === "open" && Date.now() - Date.parse(row.created_at) < 60_000) return { paid: false };
  await db.from("cashfree_orders").update({ checked_at: new Date().toISOString() }).eq("id", row.id);

  const listed = await cashfreeCall<unknown[]>(config, `/orders/${encodeURIComponent(row.cf_order_ref)}/payments`);
  if (!listed.ok && listed.status !== 404) throw new Error(cashfreeErrorLine(listed.status, listed.body));
  let paid = false;
  for (const raw of Array.isArray(listed.body) ? listed.body : []) {
    const payment = cashfreePaymentFrom(raw, row.cf_order_ref);
    if (!payment) continue;
    const result = await recordPayment(db, { ...payment, cfOrderRef: row.cf_order_ref }, source);
    if (payment.status === "SUCCESS" && result.outcome) paid = true;
  }
  if (paid || row.status !== "open") return { paid };

  const read = await cashfreeCall<CashfreeOrderEntity>(config, `/orders/${encodeURIComponent(row.cf_order_ref)}`);
  if (read.status === 404) {
    await closeRow(db, row.id, "Cashfree has no such order");
    return { paid: false };
  }
  if (!read.ok) throw new Error(cashfreeErrorLine(read.status, read.body));
  const cashfreeStatus = String(read.body?.order_status ?? "").toUpperCase();
  await db.from("cashfree_orders").update({ cashfree_status: cashfreeStatus || null }).eq("id", row.id);
  const step = cashfreeNextStep({ cashfreeStatus, checkoutDone, expiresAt: row.expires_at });
  if (step === "close") {
    await closeRow(db, row.id, `Cashfree says ${cashfreeStatus}`);
  } else if (step === "end") {
    const ended = await cashfreeCall<CashfreeOrderEntity>(config, `/orders/${encodeURIComponent(row.cf_order_ref)}`, { method: "PATCH", body: { order_status: "TERMINATED" } });
    const after = String(ended.body?.order_status ?? "").toUpperCase();
    if (ended.ok && (after === "TERMINATED" || after === "EXPIRED")) await closeRow(db, row.id, "Ended at Cashfree when the checkout was over");
    else {
      await db.from("cashfree_orders").update({ cashfree_status: after || cashfreeStatus || null }).eq("id", row.id);
      log("terminate_not_done", { ref: row.cf_order_ref, answer: ended.ok ? after : cashfreeErrorLine(ended.status, ended.body) });
    }
  }
  return { paid: false };
}

async function closeRow(db: Db, id: string, note: string) {
  await db.from("cashfree_orders").update({ status: "closed", closed_at: new Date().toISOString(), closed_note: note.slice(0, 200) }).eq("id", id).eq("status", "open");
}

async function refreshCheckout(db: Db, config: CashfreeConfig, orderNo: string, source: "return" | "check" | "admin", options: { closing?: boolean; force?: boolean; all?: boolean } = {}) {
  let query = db.from("cashfree_orders").select("*").eq("order_no", orderNo).order("created_at");
  if (!options.all) query = query.eq("status", "open");
  const { data: rows, error } = await query;
  if (error) throw new Error("Could not read the Cashfree orders");
  let paid = false;
  for (const row of rows ?? []) paid = (await refreshCashfreeOrder(db, config, row, source, options)).paid || paid;
  return paid;
}

// ---------------------------------------------------------------- webhooks parked on Supabase

export type CashfreeInboxResult = { read: number; recorded: number; rejected: number; ignored: number; failed: number };

/** Works through Cashfree's webhook calls parked by the Edge Function: signature checked here, then recorded, then removed. */
export async function drainCashfreeInbox(limit = 50, db: Db = dbAdmin()): Promise<CashfreeInboxResult> {
  const result: CashfreeInboxResult = { read: 0, recorded: 0, rejected: 0, ignored: 0, failed: 0 };
  const config = cashfreeConfigFrom(env());
  // Without the secret nothing can be proved good or bad: left for a run that has it.
  if (!config) return result;
  const { data: rows, error } = await db.from("cashfree_webhook_inbox").select("*").order("id").limit(limit);
  if (error) throw new Error("Could not read the Cashfree webhook inbox");
  for (const row of rows ?? []) {
    result.read += 1;
    const remove = () => db.from("cashfree_webhook_inbox").delete().eq("id", row.id);
    if (!(await cashfreeSignatureValid(row.body, row.webhook_timestamp, row.signature, config.secretKey))) {
      result.rejected += 1;
      log("webhook_rejected", { id: row.id, reason: "bad signature" });
      await remove();
      continue;
    }
    const hook = cashfreeWebhookFrom(row.body);
    if (!hook?.payment) {
      result.ignored += 1;
      await remove();
      continue;
    }
    try {
      await recordPayment(db, hook.payment, "webhook");
      result.recorded += 1;
      await remove();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A Cashfree order of someone else's test, or of the other environment: nothing of ours to record.
      if (/not one of ours|belongs to another order/.test(message) || row.attempts + 1 >= 5) {
        result.ignored += 1;
        log("webhook_dropped", { id: row.id, reason: message.slice(0, 160) });
        await remove();
      } else {
        result.failed += 1;
        await db.from("cashfree_webhook_inbox").update({ attempts: row.attempts + 1 }).eq("id", row.id);
      }
    }
  }
  return result;
}

/** A webhook that reached the website itself (only if Hostinger ever lets Cashfree's servers through). */
export async function handleCashfreeWebhook(rawBody: string, signature: string, timestamp: string) {
  const config = cashfreeConfigFrom(env());
  if (!config) return { status: 503, body: { error: "Cashfree is not set up" } };
  if (!(await cashfreeSignatureValid(rawBody, timestamp, signature, config.secretKey))) return { status: 401, body: { error: "Unauthorized" } };
  const hook = cashfreeWebhookFrom(rawBody);
  if (!hook?.payment) return { status: 200, body: { ok: true, ignored: true } };
  try {
    const outcome = await recordPayment(dbAdmin(), hook.payment, "webhook");
    return { status: 200, body: { ok: true, outcome: outcome.outcome ?? null } };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/not one of ours|belongs to another order/.test(message)) return { status: 200, body: { ok: true, ignored: true } };
    console.error("Cashfree webhook could not be recorded", message);
    return { status: 500, body: { error: "Could not record" } };
  }
}

/**
 * The 15-minute job (before checkouts whose time is up are ended): asks Cashfree about every open Cashfree order whose
 * checkout is over or that was not asked about for a while, so a paid customer is never left waiting for a lost webhook.
 */
export async function reconcileCashfreeOrders(limit = 30, db: Db = dbAdmin()) {
  const config = cashfreeConfigFrom(env());
  const outcome = { checked: 0, paid: 0, failed: 0 };
  if (!config) return outcome;
  const { data: rows, error } = await db.from("cashfree_orders").select("*").eq("status", "open").order("created_at").limit(limit);
  if (error) throw new Error("Could not read the open Cashfree orders");
  for (const row of rows ?? []) {
    try {
      outcome.checked += 1;
      if ((await refreshCashfreeOrder(db, config, row, "check")).paid) outcome.paid += 1;
    } catch (cause) {
      outcome.failed += 1;
      log("reconcile_failed", { ref: row.cf_order_ref, error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200) });
    }
  }
  return outcome;
}

// ---------------------------------------------------------------- the customer's checkout

/** Whether this customer pays through Cashfree, and how to open it. Never says why not (the office sees that). */
export const getCashfreeCheckout = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const config = cashfreeConfigFrom(env());
    if (!config) return { available: false as const };
    const setting = await readSetting(dbAdmin());
    const claims = context.claims as { email?: string; phone?: string };
    const open = cashfreeOpenTo(config, setting, { isAdmin: setting.enabled && config.environment === "sandbox" ? await isAdmin(context.supabase, context.userId) : false, email: claims.email, phone: claims.phone });
    return open ? { available: true as const, mode: config.environment, sdkUrl: config.sdkUrl } : { available: false as const };
  });

/** The customer presses Pay: an open Cashfree order with time left, or a new one. Returns what the Cashfree SDK needs. */
export const startCashfreePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(3).max(60) }))
  .handler(async ({ data, context }) => {
    const config = cashfreeConfigFrom(env());
    const db = dbAdmin();
    if (!config) throw new Error("Online payment is not available right now");
    const setting = await readSetting(db);
    const claims = context.claims as { email?: string; phone?: string };
    if (!cashfreeOpenTo(config, setting, { isAdmin: await isAdmin(context.supabase, context.userId), email: claims.email, phone: claims.phone }))
      throw new Error("Online payment is not available right now");
    // Nothing is asked of Cashfree about someone else's checkout.
    const { data: own } = await db.from("orders").select("user_id").eq("order_no", data.orderNo).maybeSingle();
    if (!own || own.user_id !== context.userId) throw new Error("This is not your order");
    // An earlier Cashfree order for this checkout may have been paid, or be about to run out: ask Cashfree first.
    if (await refreshCheckout(db, config, data.orderNo, "check")) return { paid: true as const };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data: plan, error } = await db.rpc("cashfree_open_order", { _order_no: data.orderNo, _user_id: context.userId, _environment: config.environment });
      if (error) throw new Error(databaseMessage(error) || "Could not start the payment");
      const step = plan as { action: string; cf_order_ref?: string; payment_session_id?: string; amount?: number; hold_until?: string; customer?: { name?: string; email?: string; phone?: string } };
      if (step.action === "busy") throw new Error("Your payment is being prepared in another window. Please try again in a moment.");
      if (step.action === "reuse") return { paid: false as const, paymentSessionId: step.payment_session_id ?? "", mode: config.environment, sdkUrl: config.sdkUrl, cfOrderRef: step.cf_order_ref ?? "" };
      const ref = step.cf_order_ref ?? "";
      const made = cashfreeOrderBody({
        cfOrderRef: ref, orderNo: data.orderNo, amount: Number(step.amount), holdUntil: step.hold_until ?? null, userId: context.userId,
        customer: step.customer ?? {},
        returnUrl: cashfreeReturnUrl(cashfreeReturnOrigin(getRequest()?.headers.get("origin"), SITE_URL), data.orderNo),
        notifyUrl: cashfreeWebhookUrl(process.env["SUPABASE_URL"]),
      });
      if ("problem" in made) {
        await closeRef(db, ref, made.problem);
        throw new Error(made.problem);
      }
      let created = await cashfreeCall<CashfreeOrderEntity>(config, "/orders", { method: "POST", body: made.body });
      // Made already (the reply was lost the first time): read it back instead of making another.
      if (created.status === 409) created = await cashfreeCall<CashfreeOrderEntity>(config, `/orders/${encodeURIComponent(ref)}`);
      const session = created.body?.payment_session_id;
      if (!created.ok || !session || String(created.body?.order_status ?? "ACTIVE").toUpperCase() !== "ACTIVE") {
        const why = created.ok ? `Cashfree says ${created.body?.order_status ?? "no session"}` : cashfreeErrorLine(created.status, created.body);
        log("order_not_made", { ref, why });
        await closeRef(db, ref, why);
        if (created.ok && attempt === 0) continue;
        throw new Error("Online payment could not be started. Please try again, or pay by UPI QR instead.");
      }
      const { error: saveError } = await db.from("cashfree_orders").update({
        cf_order_id: created.body.cf_order_id === undefined ? null : String(created.body.cf_order_id),
        payment_session_id: session,
        expires_at: created.body.order_expiry_time ? new Date(Date.parse(created.body.order_expiry_time)).toISOString() : String(made.body["order_expiry_time"]),
        cashfree_status: "ACTIVE",
      }).eq("cf_order_ref", ref);
      if (saveError) throw new Error("Could not save the payment. Please try again.");
      log("order_made", { ref, environment: config.environment });
      return { paid: false as const, paymentSessionId: session, mode: config.environment, sdkUrl: config.sdkUrl, cfOrderRef: ref };
    }
    throw new Error("Online payment could not be started. Please try again.");
  });

async function closeRef(db: Db, ref: string, note: string) {
  await db.from("cashfree_orders").update({ status: "closed", closed_at: new Date().toISOString(), closed_note: note.slice(0, 200) }).eq("cf_order_ref", ref).eq("status", "open");
}

/**
 * The customer's page asks again: after Cashfree's screen closes, on coming back, and when the time is up (closing: the
 * Cashfree order is ended at Cashfree when no payment came, so the checkout can end). Webhooks waiting on Supabase are
 * worked through first, so a payment Cashfree already reported shows at once.
 */
export const checkCashfreePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(3).max(60), closing: z.boolean().optional() }))
  .handler(async ({ data, context }) => {
    const config = cashfreeConfigFrom(env());
    const db = dbAdmin();
    const { data: order, error } = await db.from("orders").select("id, user_id, order_status").eq("order_no", data.orderNo).maybeSingle();
    if (error || !order) throw new Error("Order not found");
    if (order.user_id !== context.userId && !(await isAdmin(context.supabase, context.userId))) throw new Error("This is not your order");
    if (config) {
      try {
        await drainCashfreeInbox(20, db);
      } catch (cause) {
        log("inbox_failed", { error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200) });
      }
      await refreshCheckout(db, config, data.orderNo, "return", { closing: Boolean(data.closing) });
    }
    const [{ data: after }, { data: rows }, { data: payments }] = await Promise.all([
      db.from("orders").select("order_status, payment_status").eq("id", order.id).maybeSingle(),
      db.from("cashfree_orders").select("status").eq("order_id", order.id),
      db.from("cashfree_payments").select("payment_status, outcome, first_seen_at").eq("order_id", order.id).order("first_seen_at", { ascending: false }).limit(1),
    ]);
    return {
      orderStatus: after?.order_status ?? order.order_status,
      paid: after?.payment_status === "Paid",
      open: (rows ?? []).filter((row) => row.status === "open").length,
      lastPayment: payments?.[0] ? { status: payments[0].payment_status, outcome: payments[0].outcome } : null,
    };
  });

// ---------------------------------------------------------------- the office

/** Admin > UPI & Bank Payments > Cashfree: is it set up, on, and what came in. */
export const getCashfreeAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = dbAdmin();
    const config = cashfreeConfigFrom(env());
    const [setting, inbox, payments, open] = await Promise.all([
      readSetting(db),
      db.from("cashfree_webhook_inbox").select("id", { count: "exact", head: true }),
      db.from("cashfree_payments").select("cf_payment_id, cf_order_ref, order_no, environment, amount, payment_status, payment_group, bank_reference, reference, outcome, outcome_note, source, first_seen_at, settled_at, settled_note")
        .order("first_seen_at", { ascending: false }).limit(40),
      db.from("cashfree_orders").select("order_no, cf_order_ref, amount, environment, created_at, expires_at, cashfree_status, checked_at").eq("status", "open").order("created_at", { ascending: false }).limit(40),
    ]);
    const lastWebhook = await db.from("cashfree_payments").select("first_seen_at").eq("source", "webhook").order("first_seen_at", { ascending: false }).limit(1);
    return {
      setup: { ready: Boolean(config), environment: config?.environment ?? null, problem: cashfreeSetupProblem(env()) },
      setting,
      webhookUrl: cashfreeWebhookUrl(process.env["SUPABASE_URL"]),
      inboxWaiting: inbox.count ?? 0,
      lastWebhookAt: lastWebhook.data?.[0]?.first_seen_at ?? null,
      payments: payments.data ?? [],
      open: open.data ?? [],
    };
  });

/** Admin: Cashfree on or off, and (for sandbox tests) which logins may use it. */
export const setCashfreeGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ enabled: z.boolean(), testers: z.array(z.string().max(200)).max(20).optional() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = dbAdmin();
    if (data.enabled && !cashfreeConfigFrom(env())) throw new Error(`Cashfree cannot be switched on yet. ${cashfreeSetupProblem(env()) ?? ""}`.trim());
    const current = await readSetting(db);
    const testers = data.testers === undefined ? current.testers : data.testers.map(cashfreeTester).filter((entry): entry is string => Boolean(entry));
    const changedAt = new Date().toISOString();
    const { error } = await db.from("settings").upsert(
      { key: CASHFREE_SETTING_KEY, value: { enabled: data.enabled, testers, changedAt, changedBy: context.userId } as Json, is_public: false, updated_at: changedAt },
      { onConflict: "key" },
    );
    if (error) throw new Error("Could not save the Cashfree setting");
    log("switch", { enabled: data.enabled, testers: testers.length });
    return cashfreeSettingFrom({ enabled: data.enabled, testers });
  });

/** Admin: ask Cashfree about every Cashfree order of one checkout now, paid or not (finds a payment that was missed). */
export const adminCheckCashfree = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(3).max(60) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const config = cashfreeConfigFrom(env());
    if (!config) throw new Error(cashfreeSetupProblem(env()) ?? "Cashfree is not set up");
    const db = dbAdmin();
    await drainCashfreeInbox(50, db);
    const paid = await refreshCheckout(db, config, data.orderNo, "admin", { force: true, all: true });
    return { paid };
  });
