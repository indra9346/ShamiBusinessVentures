import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { PICKUP_SETTINGS_KEY, parsePickupSettings, pickupPointForPin } from "@/lib/pickup-points";
import { isMeasureUnit, toBaseQuantity } from "@/lib/data";
import { MAX_COUNT, isBigChange, planStockCount, stockCountDescription, zohoLocationStock } from "@/lib/stock-counts";
import {
  batchLineText, isBatchCode, normalizeBatchCode, packageLinesWithBatches, planBatchGain, planBatchLoss, planZohoBatchIn, planZohoBatchOut,
  zohoBatchesAtLocation, zohoTracksBatches, type BatchShare, type StockBatch, type ZohoBatch,
} from "@/lib/batches";
import { awaitingImportApproval, zohoItemAsHiddenProduct, zohoItemImportable, zohoItemSaleProblem, zohoItemsNotOnWebsite } from "@/lib/zoho-item-import";
import { zohoDiscountFields } from "@/lib/zoho-sync-core";
import { liveZohoInvoices, matchRefundPayments, refundAlreadyInZoho, zohoRefundBody, zohoRefundProblem, zohoVoidRefusedReview, type ListedZohoRefund, type WebsiteRefund } from "@/lib/zoho-cancel";
import {
  cleanEmailList, godownPricesFromPricebook, godownStockFromZohoItem, mergeGodownPrices, newOrderEmail, parseZohoItemSyncVendorIds, pendingOrderQty, sameGodownPrices,
  zohoPricebookItemsFor, reconcileCatalog, reconcileCustomers, reconcileOrders, shouldRetryZohoCall,
  zohoItemSyncAllows, zohoLogLine,
  asksAboutUnansweredCreate, unansweredCreateQuestion, zohoPostKind, zohoStatusOutcome, zohoThrownOutcome, type ZohoWriteOutcome,
  zohoOrderIsFor, websiteOrderNoOf, WEBSITE_ORDER_NUMBER, zohoRetryDelayMs, type AppProductForParity, type ZohoItemForParity, type ZohoOrderForReconcile,
  orderNeedsZohoInvoice, paymentsToRecord, roundingWriteOff,
  invoiceDecision, websiteInvoiceStatus, zohoInvoiceFacts, zohoInvoicesOf, type InvoiceRecord, type ZohoInvoiceFacts,
  DAILY_LIMIT_PAUSE_MINUTES, inboundPollDue, isZohoDailyLimitError, zohoPaused,
  invoicePaidOf, invoicePaymentReview, paymentsGoneFromInvoice, paymentsToNoteAsPushed, ROUNDING_WRITE_OFF_LIMIT,
  indiaDate, nextZohoFulfilmentStep, zohoFulfilmentStatus, zohoPackagesOf, zohoStatusMovesForward,
  einvoiceProblems,
  sameZohoPlace, zohoAddressBody, zohoAddressesFromContact, zohoAddressesToUpdate, zohoInvoiceAddressesToCopy, zohoOrderAddress, zohoOrderAddressOpen, zohoOrderFinished, ZOHO_PLACE_CODES,
  zohoGstFields,
} from "@/lib/zoho-sync-core";
import { gstStateCodeOf } from "@/lib/gstin";
import { verifyZohoSignature, webhookSecrets } from "@/lib/zoho-sync-core";
import { drainWebhookInbox, type InboxResult, type WebhookRecord } from "@/lib/zoho-webhook-inbox";
import {
  ZOHO_CALL_DEFAULT_PURPOSE, ZOHO_CALL_LOG_SETTING, describeZohoCall, mergeZohoCalls, type ZohoCall, type ZohoCallLog,
} from "@/lib/zoho-call-log";
import { ZOHO_TOKEN_LIMIT_MESSAGE, createZohoTokenCache, isZohoTokenLimit, type ZohoTokenCache, type ZohoTokenReply } from "@/lib/zoho-token-cache";
import { billChange, billPlan, billSummary, lineBlocker } from "@/lib/bill-batches";
import {
  CREATE_HOLD_MINUTES, createHoldUntil, findTransferByNumber, godownTransferLines, godownTransferResult, isTransferred, readCreateAnswer,
  readZohoTransfer, transferOrderBody, zohoSaysMissing, type BatchTransfer, type GodownTransfer,
} from "@/lib/batch-transfers";
import {
  DEPOSIT_ACCOUNTS_KEY, depositAccountFor, depositAccountHint, godownOfPayment, parseDepositAccounts, withDepositAccount,
  zohoCustomerPaymentBody, zohoDepositAccountOptions, type DepositAccount, type DepositAccounts, type ZohoDepositAccountOption,
} from "@/lib/deposit-accounts";
import { ZOHO_COMMERCE_OFF_MESSAGE, ZOHO_COMMERCE_SETTING_KEY, zohoCommerceModeFrom, zohoOAuthScopes } from "@/lib/zoho-commerce-mode";
import {
  CONTACT_NUMBER_BATCH, EMPTY_CONTACT_NUMBER_FETCH, cleanContactNumber, contactNumberUpdate, zohoContactNumberOf, type ContactNumberFetch,
} from "@/lib/zoho-contact-numbers";

// ---------------------------------------------------------------- Zoho API call log
// Every Zoho API call made from this file is noted with what it was for, and saved to
// settings.zoho_api_calls (Admin > Zoho Commerce > Zoho API calls). Zoho's own API Usage page
// counts calls per module; this says why. Best effort: logging never blocks or fails a sync.
type ContextStore<S> = { run<T>(store: S, fn: () => T): T; getStore(): S | undefined };
function newContextStore<S>(): ContextStore<S> | null {
  try {
    const nodeProcess = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const hooks = nodeProcess?.getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: new () => ContextStore<S> } | undefined;
    return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}
const purposeStore = newContextStore<string>();

/** Runs `fn` with every Zoho call made inside it logged under `purpose`. */
export function withZohoPurpose<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
  return purposeStore ? purposeStore.run(purpose, fn) : fn();
}

const pendingZohoCalls: ZohoCall[] = [];
let zohoCallFlushTimer: ReturnType<typeof setTimeout> | null = null;
function noteZohoCall(url: string, method: string, ok: boolean) {
  const call = describeZohoCall(url);
  if (!call) return;
  pendingZohoCalls.push({ at: new Date().toISOString(), purpose: purposeStore?.getStore() ?? ZOHO_CALL_DEFAULT_PURPOSE, method, ok, ...call });
  zohoCallFlushTimer ??= setTimeout(() => {
    zohoCallFlushTimer = null;
    void flushZohoCallLog();
  }, 20_000);
}

/** Saves the calls noted since the last save. Never throws. */
export async function flushZohoCallLog() {
  if (!pendingZohoCalls.length) return;
  const calls = pendingZohoCalls.splice(0);
  try {
    const db = await dbAdmin();
    const { data } = await db.from("settings").select("value").eq("key", ZOHO_CALL_LOG_SETTING).maybeSingle();
    const log = mergeZohoCalls(data?.value as ZohoCallLog | null, calls);
    await db.from("settings").upsert({ key: ZOHO_CALL_LOG_SETTING, value: log as unknown as Json, is_public: false, updated_at: new Date().toISOString() });
  } catch {
    // The log is best effort.
  }
}

/** Every fetch in this file goes through here, so each Zoho API call is logged. */
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const claim = orderClaims?.getStore();
  if (claim) {
    await beforeZohoCallUnderClaim(claim, url, method);
    // The call's 20 seconds started before the wait for the database. If they are gone, nothing is sent.
    init?.signal?.throwIfAborted();
    if (method === "POST" && zohoPostKind(url) === "order_create") claim.createSent = true;
  }
  try {
    const response = await globalThis.fetch(input, init);
    if (response.status === 401) zohoTokenRefused(init);
    noteZohoCall(url, method, response.ok);
    if (claim) await afterZohoCallUnderClaim(claim, url, method, zohoStatusOutcome(response.status));
    return response;
  } catch (cause) {
    noteZohoCall(url, method, false);
    if (claim) await afterZohoCallUnderClaim(claim, url, method, zohoThrownOutcome(cause));
    throw cause;
  }
};

// ---------------------------------------------------------------- One push at a time per order
// Two pushes of one order at once can make two sales orders, or two invoices and two payments. The
// claim is a row in the database, so it holds across server processes, and a push that dies just stops
// renewing it. Zoho can't check a claim, so each write to Zoho first confirms and extends it: a push
// that stalled and lost its claim can't write. A claim lasts 3 minutes and we wait at most 20 seconds
// for a Zoho call, so a write we are waiting on can't outlive its claim.
//
// Zoho may still finish a write after we stop waiting, when the claim is long gone. So a POST with no
// clear answer holds back this order's other POSTs for 10 minutes. By then what Zoho made shows when
// the order's records are read, and each step looks there first, so nothing is made twice.
type ZohoOrderClaim = {
  db: Awaited<ReturnType<typeof dbAdmin>>;
  orderId: string;
  holder: string;
  createAttemptedAt: string | null;
  createWaitOver: boolean;
  renewedAt: number;
  lost: boolean;
  lastWriteOutcome: ZohoWriteOutcome | null;
  /** A create left this server in this push. */
  createSent: boolean;
  /** A create in this push got no clear answer. */
  createUnanswered: boolean;
  writesHeldBack: boolean;
  /** A POST was refused for that reason. Some steps carry on past a refusal, so this is checked at the end. */
  stoppedByHold: boolean;
};
const orderClaims = newContextStore<ZohoOrderClaim>();
const ZOHO_WRITE_HELD_BACK = "Zoho did not answer an earlier write for this order, and it may still be finishing it. Looking again shortly; nothing more is sent until then.";

/** Another push has this order. Nothing was sent: it isn't a failure, and the queue comes back to it. */
class ZohoOrderBusyError extends Error {
  constructor(message = "Zoho is already processing this order. Check again in a minute.") {
    super(message);
  }
}

/** Zoho may still be finishing something, and that has a known end: no attempt is used up waiting for it. */
class ZohoOrderWaitError extends Error {}

/** A read only keeps a long push's claim alive; only a write has to stop if the claim is gone. */
async function beforeZohoCallUnderClaim(claim: ZohoOrderClaim, url: string, method: string) {
  const writing = method !== "GET";
  if (!claim.lost && (writing || Date.now() - claim.renewedAt > 60_000)) {
    const { data, error } = await claim.db.rpc("renew_zoho_order_push", { _order_id: claim.orderId, _holder: claim.holder });
    if (error || !data) claim.lost = true;
    else claim.renewedAt = Date.now();
  }
  if (claim.lost && writing) throw new ZohoOrderBusyError();
  if (method !== "POST") return;
  const kind = zohoPostKind(url);
  if (kind === "order_create" ? claim.createUnanswered : kind === "other" && claim.writesHeldBack) {
    claim.stoppedByHold = true;
    throw new Error(ZOHO_WRITE_HELD_BACK);
  }
}

/** Never throws: it runs between Zoho's reply and whoever is waiting for it. */
async function afterZohoCallUnderClaim(claim: ZohoOrderClaim, url: string, method: string, outcome: ZohoWriteOutcome) {
  if (method === "GET") return;
  claim.lastWriteOutcome = outcome;
  if (method !== "POST" || outcome !== "unclear") return;
  const kind = zohoPostKind(url);
  if (kind === "order_create") claim.createUnanswered = true;
  if (kind !== "other") return;
  claim.writesHeldBack = true;
  await claim.db.rpc("note_zoho_order_write_unanswered", { _order_id: claim.orderId, _holder: claim.holder }).then(() => undefined, () => undefined);
}

/**
 * Runs one push of one order under its claim; throws ZohoOrderBusyError if another push has it. The holder
 * marks the queue entries this push had read when it began.
 */
async function withZohoOrderClaim(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string, push: () => Promise<void>, holder: string = crypto.randomUUID()) {
  if (!orderClaims) throw new Error("This server can't hold a Zoho order claim, so the order was not sent");
  const { data, error } = await db.rpc("claim_zoho_order_push", { _order_id: orderId, _holder: holder });
  if (error) {
    if (["PGRST202", "42883"].includes(error.code ?? "")) throw new Error("Could not claim the order for Zoho; apply the one-push-per-order migration");
    // A passing database error: nothing was sent, so the queue just comes back to it.
    throw new ZohoOrderBusyError("Could not reach the database to claim this order. It will be tried again.");
  }
  const row = data?.[0];
  if (!row?.claimed) throw new ZohoOrderBusyError();
  const claim: ZohoOrderClaim = {
    db, orderId, holder, createAttemptedAt: row.create_attempted_at, createWaitOver: row.create_wait_over,
    renewedAt: Date.now(), lost: false, lastWriteOutcome: null, createSent: false, createUnanswered: false, writesHeldBack: row.writes_held_back, stoppedByHold: false,
  };
  try {
    await orderClaims.run(claim, push);
  } catch (cause) {
    // Whatever a lost claim's refusal or a hold turned into on its way up, or whatever followed it, this is what happened.
    if (claim.lost) throw new ZohoOrderBusyError();
    if (claim.stoppedByHold) throw new ZohoOrderWaitError(ZOHO_WRITE_HELD_BACK);
    throw cause;
  } finally {
    // If this fails the claim simply runs out.
    await db.rpc("release_zoho_order_push", { _order_id: orderId, _holder: holder }).then(() => undefined, () => undefined);
  }
  // Some steps carry on past a refused write, so a push can reach here without having done everything.
  if (claim.lost) throw new ZohoOrderBusyError();
  if (claim.stoppedByHold) throw new ZohoOrderWaitError(ZOHO_WRITE_HELD_BACK);
  // A question about an unanswered create would have been raised again if it were still open.
  const copies = await zohoQuestionCopies(db, orderId);
  if (copies.length) await closeZohoQuestions(db, copies.map((row) => row.id), null);
}

async function zohoQuestionCopies(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const { data } = await db.from("zoho_sync_outbox").select("id,last_error")
    .eq("entity_type", "order").eq("entity_id", orderId).eq("status", "needs_review").order("updated_at", { ascending: false });
  return (data ?? []).filter((row) => asksAboutUnansweredCreate(row.last_error));
}

function closeZohoQuestions(db: Awaited<ReturnType<typeof dbAdmin>>, ids: string[], note: string | null) {
  return db.from("zoho_sync_outbox").update({ status: "complete", last_error: note, updated_at: new Date().toISOString() }).in("id", ids);
}

/** One copy of the question per order, and the admins hear of it: a paid order may be waiting on the answer. */
async function settleZohoQuestion(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const copies = await zohoQuestionCopies(db, orderId);
  if (copies.length > 1) await closeZohoQuestions(db, copies.slice(1).map((row) => row.id), "Superseded by a newer copy of this question");
  const { data: told } = await db.from("notifications").select("id").eq("order_id", orderId).eq("status", "zoho_question").eq("read", false).limit(1);
  if (told?.length) return;
  const [{ data: order }, { data: admins }] = await Promise.all([
    db.from("orders").select("order_no").eq("id", orderId).maybeSingle(),
    db.from("user_roles").select("user_id").eq("role", "admin"),
  ]);
  if (!order || !admins?.length) return;
  await db.from("notifications").insert(admins.map((admin) => ({
    order_no: order.order_no, order_id: orderId, recipient_id: admin.user_id, recipient_role: "admin", status: "zoho_question",
    title: `Zoho needs checking: ${order.order_no}`,
    message: `Zoho did not answer when order ${order.order_no} was sent. Open Admin > Zoho and read its entry.`,
  })));
}

/**
 * A search miss doesn't prove there is no sales order if an earlier create got no clear answer: Zoho
 * may have made it and be slow to show it, or be making it still. A live read on 3 Nov showed Inventory's
 * search finds Reference#, but how soon a new sales order becomes findable was not measured. So nothing
 * more is sent for 10 minutes (the queue looks again), and after that a person is asked, not the search.
 */
function refuseIfCreateUnanswered(orderNo: string, cancelled = false) {
  const claim = orderClaims?.getStore();
  if (!claim?.createAttemptedAt) return;
  if (!claim.createWaitOver)
    throw new ZohoOrderWaitError(`Zoho did not answer when order ${orderNo} was sent, and it may still be making the sales order. Looking again shortly; nothing more is sent until then.`);
  throw new NeedsReviewError(unansweredCreateQuestion(orderNo, cancelled));
}

/** Sends a create with the attempt noted first, so a reply that never comes can't lead to a second one. */
async function sendZohoOrderCreate<T>(send: () => Promise<T>) {
  const claim = orderClaims?.getStore();
  if (!claim) throw new Error("A sales order was about to be created with no claim on the order");
  const note = (sent: boolean) => claim.db.rpc("note_zoho_order_create", { _order_id: claim.orderId, _holder: claim.holder, _sent: sent });
  // Taking a note back only works for its holder, so it can't touch another push's note.
  const takeBack = () => note(false).then(() => undefined, () => undefined);
  const { data, error } = await note(true);
  if (error || !data) {
    claim.lost = true;
    // The note may have been written even if the reply was lost, and nothing has been sent.
    await takeBack();
    throw new ZohoOrderBusyError();
  }
  try {
    return await send();
  } catch (cause) {
    // Nothing left this server, or Zoho said a clear no: nothing was made, so the next push may create it straight away.
    if (!claim.createUnanswered && (!claim.createSent || claim.lastWriteOutcome === "refused")) await takeBack();
    throw cause;
  }
}

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

// ---------------------------------------------------------------- Zoho Commerce in use or not
// Admin > Zoho Commerce switch (see zoho-commerce-mode.ts). Read at most every 30 s per process;
// the process that changes it forgets its copy at once.
let commerceModeCache: { inUse: boolean; at: number } | null = null;
async function zohoCommerceInUse(db?: SupabaseClient<Database>) {
  if (commerceModeCache && Date.now() - commerceModeCache.at < 30_000) return commerceModeCache.inUse;
  const client = db ?? await dbAdmin();
  const { data, error } = await client.from("settings").select("value").eq("key", ZOHO_COMMERCE_SETTING_KEY).maybeSingle();
  // A failed read keeps the last answer (or "in use", as before the switch existed) and asks again next time.
  if (error) return commerceModeCache?.inUse ?? true;
  const { inUse } = zohoCommerceModeFrom(data?.value);
  commerceModeCache = { inUse, at: Date.now() };
  return inUse;
}

/** Admin: is Zoho Commerce still in use? */
export const getZohoCommerceMode = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data, error } = await (await dbAdmin()).from("settings").select("value").eq("key", ZOHO_COMMERCE_SETTING_KEY).maybeSingle();
    if (error) throw new Error("Could not read whether Zoho Commerce is in use");
    return zohoCommerceModeFrom(data?.value);
  });

/** Admin: turn the Zoho Commerce steps on or off (before or after its subscription ends). */
export const setZohoCommerceMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ inUse: z.boolean() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const changedAt = new Date().toISOString();
    const { error } = await (await dbAdmin()).from("settings").upsert(
      { key: ZOHO_COMMERCE_SETTING_KEY, value: { inUse: data.inUse, changedAt, changedBy: context.userId } as Json, is_public: false, updated_at: changedAt },
      { onConflict: "key" },
    );
    if (error) throw new Error("Could not save whether Zoho Commerce is in use");
    commerceModeCache = null;
    console.info(zohoLogLine("zoho_commerce_mode", { inUse: String(data.inUse) }));
    return { inUse: data.inUse, changedAt };
  });
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
      // Without Zoho Commerce its permissions are not asked for: Zoho could refuse them for a plan that has none.
      scope: zohoOAuthScopes(await zohoCommerceInUse(db)),
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
    const [jobsResult, waitingResult, ...statusResults] = await Promise.all([
      db.from("zoho_sync_outbox")
      .select("id,entity_type,entity_id,status,attempts,last_error,created_at,updated_at")
        .order("updated_at", { ascending: false }).limit(30),
      // Whatever waits for a person stays on the list, however much else has happened since.
      db.from("zoho_sync_outbox")
      .select("id,entity_type,entity_id,status,attempts,last_error,created_at,updated_at")
        .in("status", ["failed", "needs_review"]).order("updated_at", { ascending: false }).limit(200),
      ...statuses.map((status) => db.from("zoho_sync_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", status)),
    ]);
    if (jobsResult.error || waitingResult.error || statusResults.some((result) => result.error)) {
      throw new Error("Could not load Zoho sync queue status");
    }
    const counts = Object.fromEntries(
      statuses.map((status, index) => [status, statusResults[index]?.count ?? 0]),
    );

    const recentJobs = jobsResult.data ?? [];
    const recentIds = new Set(recentJobs.map((job) => job.id));
    const rawJobs = [...recentJobs, ...(waitingResult.data ?? []).filter((job) => !recentIds.has(job.id))];
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
    const db = await dbAdmin();
    const { data: job } = await db.from("zoho_sync_outbox").select("status,last_error").eq("id", data.id).maybeSingle();
    // The person was asked to look in Zoho for an unanswered create, so this Retry is the go-ahead to create it.
    const answersQuestion = job?.status === "needs_review" && asksAboutUnansweredCreate(job.last_error);
    const { error } = answersQuestion
      ? await db.rpc("retry_zoho_sync_job_checked", { _id: data.id })
      : await db.rpc("retry_zoho_sync_job", { _id: data.id });
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
        .not("order_status", "in", '(Cancelled,"Awaiting Payment","Payment Expired")'),
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
  /** "inventory": Zoho Inventory (`path` relative to /inventory/v1), for when Zoho Commerce is off. */
  api: "commerce" | "inventory" = "commerce",
) {
  const output: Record<string, unknown>[] = [];
  for (let page = 1; page <= 25; page += 1) {
    const paging = { ...query, page: String(page), per_page: "200" };
    let url: URL;
    if (api === "inventory") {
      url = inventoryApi(region, path.replace(/^\//, ""), organizationId, paging);
    } else {
      url = new URL(`${REGIONS[region][1]}${path}`);
      url.search = new URLSearchParams(paging).toString();
    }
    const response = await fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(api === "commerce" ? { "X-com-zoho-store-organizationid": organizationId } : {}),
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

    if (!(await zohoCommerceInUse(db))) {
      // Without Zoho Commerce only the sales orders are read, from Zoho Inventory. Categories, tax rules
      // and the store's details came from Zoho Commerce, so their last saved copies stay as they were.
      await run(
        "sales_orders",
        () => fetchZohoPages(region, organizationId, token, "/salesorders", "salesorders", {}, "inventory"),
        (row) => str(row["salesorder_id"]),
      );
    } else {
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
    }

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
// The build includes this file twice on the server (the server-function chunk and the server entry),
// so the token lives on globalThis: one kept token per process, whichever copy asks.
const zohoTokens = ((globalThis as { __grainBazarZohoToken?: ZohoTokenCache }).__grainBazarZohoToken ??= createZohoTokenCache());

async function accessToken(region: Region, refreshToken: string) {
  const [accounts] = REGIONS[region];
  // Kept under a hash of the refresh token: callers read it from the database each time, so after a
  // Reauthorize every server process moves to the new connection on its next call.
  return zohoTokens.get(await stateHash(`${region}:${refreshToken}`), async () => {
    const response = await fetch(`${accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: reqEnv("ZOHO_CLIENT_ID"),
        client_secret: reqEnv("ZOHO_CLIENT_SECRET"),
        refresh_token: refreshToken,
      }),
      // Calls that arrive meanwhile wait on this one, so it can't be left hanging.
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as ZohoTokenReply;
    if (isZohoTokenLimit(response.status, data)) {
      console.warn(zohoLogLine("zoho_token_limit", { status: response.status, error: data.error, description: data.error_description }));
      throw new Error(ZOHO_TOKEN_LIMIT_MESSAGE);
    }
    if (!response.ok || !data.access_token)
      throw new Error(data.error ?? "Could not refresh Zoho access token");
    // The call log leaves token requests out, so this is how often each process really asks.
    console.info(zohoLogLine("zoho_token_new", { expiresIn: String(data.expires_in) }));
    return { token: data.access_token, expiresIn: data.expires_in };
  });
}

/** A kept token Zoho no longer accepts must not stay in use for the rest of its hour. */
function zohoTokenRefused(init: RequestInit | undefined) {
  const header = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
  if (header) zohoTokens.refused(header.replace("Zoho-oauthtoken ", ""));
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

/**
 * Up to 2 retries with backoff: 429 for any method (Zoho did not process it); 5xx and network
 * errors only for GET/PUT. A POST is never resent blindly; order creation looks the order up by
 * its Reference# (the website order number) on the next attempt instead (see syncZohoOrder).
 */
async function fetchWithZohoRetry(send: () => Promise<Response>, resource: string, method: "GET" | "POST" | "PUT" | "DELETE") {
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
  return response;
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
  const response = await fetchWithZohoRetry(send, resource, method);
  if (!response) throw new Error(`Zoho Inventory ${resource} could not be reached`);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0)
    throw zohoApiError(data.message ?? `Zoho Inventory ${resource} failed (${response.status})`);
  return data;
}

/** Set when Zoho reports that the organization's daily API budget is used up (see processZohoSyncOutbox). */
let zohoDailyLimitHit = false;
function zohoApiError(message: string) {
  if (isZohoDailyLimitError(message)) zohoDailyLimitHit = true;
  return new Error(message);
}

async function commerceRequest<T>(
  region: Region,
  organizationId: string,
  token: string,
  resource: string,
  method: "GET" | "POST" | "PUT",
  body?: Record<string, unknown>,
): Promise<T> {
  const send = () => fetch(`${REGIONS[region][1]}/store/api/v1/${resource}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "X-com-zoho-store-organizationid": organizationId,
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const response = await fetchWithZohoRetry(send, resource, method);
  if (!response) throw new Error(`Zoho Commerce ${resource} could not be reached`);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0)
    throw zohoApiError(data.message ?? `Zoho Commerce ${resource} failed (${response.status})`);
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
    // A customer buying in their company's name without a GSTIN is an unregistered business.
    gst_treatment: gstInfo.isValid ? "business_gst" : contactType === "vendor" || profile.company?.trim() ? "business_none" : "consumer",
    ...(gstInfo.isValid && gstInfo.gstin ? { gst_no: gstInfo.gstin } : {}),
    ...(gstInfo.placeOfContact ? { place_of_contact: gstInfo.placeOfContact } : {}),
    ...(mainAddress ? { billing_address: mainAddress, shipping_address: mainAddress } : {}),
  };

  let contactId = link?.zoho_contact_id ?? "";
  let zohoModifiedAt: string | null = null;
  let personError: string | null = null;
  // The contact as Zoho sent it back, for its customer or vendor number.
  let zohoContact: Record<string, unknown> | undefined;
  if (!contactId) {
    const found = await inventoryRequest<{ contacts?: Record<string, unknown>[] }>(region, organizationId, token, "contacts", "GET", undefined, { email, per_page: "200" });
    const exact = (found.contacts ?? []).filter((row) => str(row["contact_type"]) === contactType && str(row["email"]).toLowerCase() === email.toLowerCase());
    if (exact.length > 1) {
      // Several Zoho contacts share the email: use the one this customer's own Zoho sales orders use.
      const preferred = contactType === "customer"
        ? await contactUsedByCustomerOrders(db, region, organizationId, token, userId, exact.map((row) => str(row["contact_id"])))
        : null;
      if (!preferred) throw new NeedsReviewError(`More than one Zoho ${contactType} contact matches ${email}. Merge the duplicates in Zoho (Contacts > select both > Merge), then Retry.`);
      contactId = preferred;
    }
    if (exact.length === 1) contactId = str(exact[0]!["contact_id"]);
  }
  if (!contactId) {
    const created = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, "contacts", "POST", contact);
    contactId = str(created.contact?.["contact_id"]);
    zohoModifiedAt = str(created.contact?.["last_modified_time"]) || null;
    zohoContact = created.contact;
    if (!contactId) throw new Error("Zoho created a contact but returned no contact ID");
  } else {
    // Never send contact_persons on update: Zoho treats a replaced list as deleting the existing
    // persons, which it refuses for persons on Commerce orders. The primary person is updated in
    // place through the documented Contact Persons API instead.
    const { contact_persons: _persons, ...contactFields } = contact;
    const updated = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, `contacts/${encodeURIComponent(contactId)}`, "PUT", contactFields);
    zohoModifiedAt = str(updated.contact?.["last_modified_time"]) || null;
    zohoContact = updated.contact;
    try {
      await upsertPrimaryContactPerson(region, organizationId, token, contactId, person);
    } catch (cause) {
      personError = cause instanceof Error ? cause.message : "Zoho refused the contact person update";
    }
  }
  const { error: linkError } = await db.from("zoho_contact_links").upsert({ user_id: userId, contact_type: contactType, zoho_contact_id: contactId, updated_at: new Date().toISOString(), ...(zohoModifiedAt ? { last_zoho_modified_at: zohoModifiedAt } : {}) });
  if (linkError) throw new Error("Zoho contact synchronized, but its ID could not be saved in Grain Bazar");
  await saveZohoContactNumber(db, userId, contactType, zohoContactNumberOf(zohoContact));
  if (personError) throw new NeedsReviewError(`Zoho contact ${contactId} is linked and updated, but its contact person could not be updated: ${personError}`);
  return contactId;
}

/**
 * Keeps the customer or vendor number Zoho sent with a contact (see zoho-contact-numbers.ts); undefined (Zoho's reply
 * had no number field) keeps what was there. Its own request, and a failure is ignored: before the 12 Nov 2026
 * migration the column is not there, and the contact sync goes on exactly as before.
 */
async function saveZohoContactNumber(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  userId: string,
  contactType: "customer" | "vendor",
  number: string | null | undefined,
) {
  if (number === undefined) return;
  try {
    await db.from("zoho_contact_links").update(contactNumberUpdate(number, new Date().toISOString()))
      .eq("user_id", userId).eq("contact_type", contactType);
  } catch {
    // The number is read again with the contact's next check.
  }
}

/** The database answer for a column it does not have: the customer and vendor number update is not applied yet. */
const missingContactNumberColumn = (error: { code?: string; message?: string }) =>
  error.code === "42703" || error.code === "PGRST204" || /zoho_contact_number/i.test(error.message ?? "");

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

/** A price that is set: Zoho reports a missing MRP as 0 or blank, which must not overwrite one. */
function positiveRate(value: unknown) {
  const rate = finiteNumber(value);
  return rate !== null && rate > 0 ? rate : null;
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
    /** MRP lives on the Zoho Commerce variant (label_rate), not on the Inventory item. */
    mrp: positiveRate(payload["mrp"]),
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
    hsn: str(payload["hsn"]).trim(),
    mrp: positiveRate(payload["mrp"]),
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
    hsn: str(item["hsn_or_sac"]).trim(),
    // Only present when withCommerceProductValues saw a Zoho Commerce MRP edit.
    mrp: positiveRate(item["label_rate"]),
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
  // Without Zoho Commerce there is no product page: the Inventory item's own values are all there is.
  if (!api || !(await zohoCommerceInUse(db))) return item;
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
    const variantMrp = variant ? positiveRate(variant["label_rate"]) : null;

    // Zoho's product response has no modified time, and a product-page save does not always
    // move the item's. So Grain Bazar remembers the Commerce values it last saw (on the
    // product's Zoho Commerce copy) and treats any difference as a Zoho edit.
    const seen = plainObject(mirrorPayload["zohoSeen"]);
    const hasSeen = typeof seen["description"] === "string";
    // MRP was added to "last seen" later; until it is recorded once, Zoho's MRP is not an edit.
    const hasSeenMrp = "mrp" in seen;
    // Field by field: only a field that changed since it was last seen is a Zoho edit. (A reorder
    // level Grain Bazar itself pushed must not make Zoho's unchanged description "win".)
    const descriptionChanged = hasSeen && seen["description"] !== description;
    const reorderChanged = hasSeen && (seen["reorderLevel"] ?? null) !== variantReorder;
    const mrpChanged = hasSeenMrp && (seen["mrp"] ?? null) !== variantMrp;
    const productChanged = descriptionChanged || reorderChanged || mrpChanged;
    if (record && mirrorId && (!hasSeen || !hasSeenMrp || productChanged)) {
      await db.from("catalog_products")
        .update({ payload: { ...mirrorPayload, zohoSeen: { description, reorderLevel: variantReorder, mrp: variantMrp, at: new Date().toISOString() } } as Json })
        .eq("id", mirrorId);
    }
    if (!productChanged) return item;
    return {
      ...item,
      ...(descriptionChanged && description ? { description } : {}),
      ...(reorderChanged && variantReorder !== null ? { reorder_level: variantReorder } : {}),
      ...(mrpChanged && variantMrp !== null ? { label_rate: variantMrp } : {}),
      // A description or MRP edit on the product page is seen now, so it is the latest edit. A
      // reorder change also edits the item, so the item's own modified time already covers it.
      ...(descriptionChanged || mrpChanged ? { last_modified_time: new Date().toISOString() } : {}),
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
  if (!zohoItemSyncAllows(await zohoItemSyncVendorIds(db), product.vendor_id)) return "unchanged" as const;
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
  locationId = "",
) {
  const delta = Math.round((appStock - zohoAvailable) * 1000) / 1000;
  if (delta === 0) return;
  try {
    // At the godown's Zoho location (documented location_id), the same location website orders
    // take stock from; without it Zoho uses the primary location and the two drift apart.
    await inventoryRequest(region, organizationId, token, "inventoryadjustments", "POST", {
      date: todayInIndia(),
      reason: "Grain Bazar stock sync",
      adjustment_type: "quantity",
      description: `Set ${sku} available stock to ${appStock} to match Grain Bazar`,
      ...(locationId ? { location_id: locationId } : {}),
      line_items: [{ item_id: itemId, quantity_adjusted: delta, ...(locationId ? { location_id: locationId } : {}) }],
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
  const update = { last_error: reason.slice(0, 1000), updated_at: new Date().toISOString(), push_holder: null };
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
  // Only the sellers listed in settings (Shami's own products) are kept in Zoho.
  if (!zohoItemSyncAllows(await zohoItemSyncVendorIds(db), product.vendor_id)) return;

  const { data: savedLink, error: savedLinkError } = await db.from("zoho_item_links")
    .select("product_id,zoho_item_id,updated_at,last_polled_at,last_zoho_modified_at,app_fingerprint")
    .eq("product_id", product.id).maybeSingle();
  if (savedLinkError) throw new Error("Could not read the saved Zoho item mapping");
  const link = savedLink as ZohoItemLink | null;
  const fingerprint = await catalogFingerprint(product);

  // A new Zoho item waiting for an admin stays as it is in Zoho: the rule below would switch it off there.
  if (awaitingImportApproval(product.status, product.payload)) return;

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

  // Two Grain Bazar products with one SKU would push two different stock figures to the same Zoho
  // item (Zoho-imported copies are excluded; they are never pushed).
  const { data: sameSku, error: sameSkuError } = await db.from("catalog_products")
    .select("id,vendor_id,payload").eq("payload->>sku", shared.sku).neq("id", product.id);
  if (sameSkuError) throw new Error("Could not check for duplicate SKUs before Zoho sync");
  const duplicates = (sameSku ?? []).filter((row) => !row.vendor_id.startsWith("zoho:"));
  if (duplicates.length)
    throw new NeedsReviewError(`SKU ${shared.sku} is used by ${duplicates.length + 1} Grain Bazar products (${[shared.name, ...duplicates.map((row) => str(plainObject(row.payload)["name"]) || row.id)].join(", ")}). Keep one and change or remove the others, then Retry.`);

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
      // An HSN Zoho lacks is sent once (Zoho blocks order edits on lines without one).
      (!shared.hsn || str(item["hsn_or_sac"]).trim() === shared.hsn) &&
      (shared.stock === null || (tracked && zohoStock === shared.stock));
    if (inSync) {
      // The item is current, but the Commerce product page may still need the description or MRP.
      await pushCommerceProductValues(db, { region, organizationId, token }, shared.sku, str(item?.["group_id"]), shared.description, shared.mrp);
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
    if (matches.length === 1) {
      const candidate = str(matches[0]!["item_id"]);
      const { data: taken } = await db.from("zoho_item_links").select("product_id").eq("zoho_item_id", candidate).neq("product_id", product.id).maybeSingle();
      if (taken) throw new NeedsReviewError(`Zoho item for SKU ${shared.sku} is already linked to Grain Bazar product ${taken.product_id}; resolve the duplicate before linking.`);
      itemId = candidate;
    }
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
    const updateItem = () => inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "PUT", itemPayload,
    );
    let updated: { item?: Record<string, unknown> };
    try {
      updated = await updateItem();
    } catch (cause) {
      // Zoho checks the price against the Commerce MRP on every item update. When the site's MRP
      // was raised to cover the price, send that MRP first, then update the item once more.
      const message = cause instanceof Error ? cause.message : "";
      if (!/greater than (the )?MRP/i.test(message) || shared.mrp === null || shared.mrp < shared.rate) throw cause;
      // The MRP lived on the Zoho Commerce product: with Commerce off the website cannot raise it.
      if (!(await zohoCommerceInUse(db)))
        throw new NeedsReviewError(`Zoho refused the new price of ${shared.sku}: it is above the MRP Zoho holds for this item (${message}). Zoho Commerce is off, so the website cannot change that MRP: change it on the item in Zoho, then Retry.`);
      const current = await inventoryRequest<{ item?: Record<string, unknown> }>(
        region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "GET",
      );
      await pushCommerceProductValues(db, { region, organizationId, token }, shared.sku, str(current.item?.["group_id"]), "", shared.mrp);
      updated = await updateItem();
    }
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
    // When Zoho is the stock master, godown stock is reconciled per location instead.
    if (shared.stock !== null && !stockFollowUp && str(resultItem?.["item_type"]) === "inventory" && !(await isZohoStockMaster(db))) {
      await syncZohoItemStock(
        region, organizationId, token, itemId, shared.sku, shared.stock, zohoAvailableForSale(resultItem),
        await defaultStockLocationId(db),
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
  await pushCommerceProductValues(db, { region, organizationId, token }, shared.sku, str(resultItem?.["group_id"]), shared.description, shared.mrp);
  if (stockFollowUp) throw new NeedsReviewError(stockFollowUp);
}

const escapeHtml = (text: string) => text
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Admin, after Zoho Commerce is bought again, turned back on and reauthorized: brings every Zoho
 * Commerce product page up to date with the website's description and MRP, which changed only on the
 * website (and the Inventory item) while Commerce was off. Touches nothing else: no stock, price or
 * image is pushed. Reads Commerce once first, so a plan not renewed or a Reauthorize still owed is
 * reported before any product.
 */
export const refreshZohoCommerceProductPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    if (!(await zohoCommerceInUse(db))) throw new Error(ZOHO_COMMERCE_OFF_MESSAGE);
    const { region, organizationId, token } = await zohoOrderContext(db);
    try {
      await commerceRequest(region, organizationId, token, "products?page=1&per_page=1", "GET");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "no answer";
      throw new Error(`Zoho Commerce did not answer (${message}). If its plan has ended, buy it again first; then press Reauthorize Zoho and try this again.`);
    }
    const { data: links, error } = await db.from("zoho_item_links").select("product_id,zoho_item_id");
    if (error) throw new Error("Could not read which products are linked to Zoho");
    const allowedVendors = await zohoItemSyncVendorIds(db);
    let sent = 0, skipped = 0, failed = 0;
    for (const link of links ?? []) {
      const { data: product } = await db.from("catalog_products")
        .select("id,vendor_id,category,status,active,payload,created_at,updated_at").eq("id", link.product_id).maybeSingle();
      const shared = product ? catalogSharedValues(product) : null;
      if (!product || !shared?.sku || (!shared.description && shared.mrp === null) || !zohoItemSyncAllows(allowedVendors, product.vendor_id)) {
        skipped += 1;
        continue;
      }
      try {
        const { item } = await inventoryRequest<{ item?: Record<string, unknown> }>(region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET");
        // Never throws: a refusal is left on the product's Zoho Commerce copy, as on every push.
        await pushCommerceProductValues(db, { region, organizationId, token }, shared.sku, str(item?.["group_id"]), shared.description, shared.mrp);
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { products: (links ?? []).length, sent, skipped, failed };
  });

/**
 * Grain Bazar -> Zoho Commerce: shoppers read the description on the Commerce product page,
 * which is separate from the Inventory item's description, and the MRP is the variant's
 * label rate. Writes each when it differs, then records them as "last seen" so the inbound
 * check does not mistake them for Zoho edits.
 * Never fails the item sync; a refusal is logged and the next push retries.
 */
async function pushCommerceProductValues(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  api: ZohoApiContext,
  sku: string,
  groupId: string,
  description: string,
  mrp: number | null,
) {
  if (!description && mrp === null) return;
  // Without Zoho Commerce the description goes on the Inventory item only, and the MRP stays on the website.
  if (!(await zohoCommerceInUse(db))) return;
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
    const current = await commerceRequest<{ product?: Record<string, unknown> }>(
      api.region, api.organizationId, api.token, `products/${encodeURIComponent(productId)}`, "GET",
    );
    const seen = plainObject(mirrorPayload["zohoSeen"]);
    const nextSeen: Record<string, unknown> = { ...seen };

    if (description) {
      const html = description.split(/\n+/).map((line) => line.trim()).filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`).join("");
      const asZohoShowsIt = htmlToText(html);
      // Read exactly as the inbound check does (main description, else the short one).
      const zohoText = htmlToText(str(current.product?.["product_description"]))
        || htmlToText(str(current.product?.["product_short_description"]));
      // Latest edit wins: if Zoho's text changed since Grain Bazar last saw it, that Zoho edit has
      // not been pulled in yet; leave it for the inbound sync instead of overwriting it.
      const zohoEditPending = typeof seen["description"] === "string" && seen["description"] !== zohoText && zohoText !== asZohoShowsIt;
      if (!zohoEditPending) {
        if (zohoText !== asZohoShowsIt) {
          await commerceRequest(
            api.region, api.organizationId, api.token, `products/${encodeURIComponent(productId)}`, "PUT",
            { product_description: html },
          );
        }
        nextSeen["description"] = asZohoShowsIt;
      }
    }

    if (mrp !== null) {
      const variants = (Array.isArray(current.product?.["variants"]) ? current.product["variants"] as unknown[] : []).map(plainObject);
      const variant = variants.find((v) => str(v["sku"]).trim().toLowerCase() === sku.toLowerCase()) ?? (variants.length === 1 ? variants[0] : undefined);
      const variantId = str(variant?.["variant_id"]);
      const zohoMrp = variant ? positiveRate(variant["label_rate"]) : null;
      // Same rule as the description: a Zoho MRP edit not yet pulled in is left alone.
      const zohoEditPending = "mrp" in seen && (seen["mrp"] ?? null) !== zohoMrp && zohoMrp !== mrp;
      if (variantId && !zohoEditPending) {
        if (zohoMrp !== mrp) {
          await commerceRequest(
            api.region, api.organizationId, api.token, `variants/${encodeURIComponent(variantId)}`, "PUT",
            { label_rate: String(mrp) },
          );
        }
        nextSeen["mrp"] = mrp;
      }
    }

    if (mirrorId) {
      const { zohoCommerceWriteError: _cleared, ...cleanPayload } = mirrorPayload;
      await db.from("catalog_products").update({
        payload: { ...cleanPayload, zohoSeen: { ...nextSeen, reorderLevel: seen["reorderLevel"] ?? null, at: new Date().toISOString() } } as Json,
      }).eq("id", mirrorId);
    }
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
    console.warn(`Zoho Commerce description or MRP for ${sku} not updated; the next push retries:`, message);
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

type GrainBazarOrderItem = { id?: string; product_id: string | null; product_name: string; sku: string | null; qty: number; unit_price: number; gst_rate: number; coupon_share?: number };

/** Batch numbers each order line took (FIFO at the order's godown), by order item id. */
async function orderItemBatchCodes(db: Awaited<ReturnType<typeof dbAdmin>>, itemIds: string[]) {
  const byItem = new Map<string, { code: string; qty: number }[]>();
  if (!itemIds.length) return byItem;
  const { data: allocations } = await db.from("order_item_batch_allocations")
    .select("order_item_id,batch_id,reserved_quantity,released_quantity,created_at").in("order_item_id", itemIds).order("created_at");
  const batchIds = [...new Set((allocations ?? []).map((a) => a.batch_id))];
  const { data: batches } = batchIds.length
    ? await db.from("batches").select("id,batch_code").in("id", batchIds)
    : { data: [] as { id: string; batch_code: string }[] };
  const codeOf = new Map((batches ?? []).map((b) => [b.id, b.batch_code]));
  for (const a of allocations ?? []) {
    const left = Number(a.reserved_quantity) - Number(a.released_quantity);
    const code = codeOf.get(a.batch_id);
    if (left <= 0 || !code) continue;
    const list = byItem.get(a.order_item_id) ?? [];
    const same = list.find((b) => b.code === code);
    if (same) same.qty += left;
    else list.push({ code, qty: left });
    byItem.set(a.order_item_id, list);
  }
  return byItem;
}

/** Zoho line items for Grain Bazar order lines, matched to Zoho items by SKU. */
async function zohoLineItemsForOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  items: GrainBazarOrderItem[],
) {
  const lineItems: Record<string, unknown>[] = [];
  // HSN for each line: the product's HSN in Grain Bazar, else the Zoho item's (read from the item
  // record, since Zoho's list response does not document hsn_or_sac). Zoho (GST) refuses to save a
  // sales order whose lines lack a 6-8 digit HSN, which would block every later edit in Zoho.
  const validHsn = (value: unknown) => {
    const hsn = str(value).replace(/\s/g, "");
    return /^\d{6,8}$/.test(hsn) ? hsn : "";
  };
  const productIds = [...new Set(items.map((item) => item.product_id).filter((id): id is string => Boolean(id)))];
  const appHsn = new Map<string, string>();
  if (productIds.length) {
    const { data: rows } = await db.from("catalog_products").select("id,payload").in("id", productIds);
    for (const row of rows ?? []) appHsn.set(row.id, validHsn(plainObject(row.payload)["hsn"]));
  }
  // The batch / stock number of each line, as text on the Zoho line (and so on the invoice).
  const batchCodes = await orderItemBatchCodes(db, items.map((item) => item.id).filter((id): id is string => Boolean(id)));
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
    const zohoItemId = str(matches[0]!["item_id"]);
    let hsn = (item.product_id ? appHsn.get(item.product_id) : "") || validHsn(matches[0]!["hsn_or_sac"]);
    if (!hsn) {
      try {
        const detail = await inventoryRequest<{ item?: Record<string, unknown> }>(region, organizationId, token, `items/${encodeURIComponent(zohoItemId)}`, "GET");
        hsn = validHsn(detail.item?.["hsn_or_sac"]);
      } catch {
        // No HSN available: the line is sent without one (Zoho then asks for it on edit).
      }
    }
    const batchText = item.id ? batchLineText(batchCodes.get(item.id) ?? [], item.qty) : "";
    lineItems.push({
      item_id: zohoItemId, name: item.product_name, quantity: item.qty, rate: item.unit_price, tax_percentage: item.gst_rate,
      ...(Number(item.coupon_share) > 0 ? { discount: Number(item.coupon_share) } : {}),
      ...(hsn ? { hsn_or_sac: hsn } : {}),
      ...(batchText ? { description: batchText } : {}),
    });
  }
  return lineItems;
}

const ZOHO_CLOSED_ORDER_STATES = ["void", "cancelled"];
/** What an answered review says once a Zoho void closed its order. */
const ZOHO_VOID_CLOSED_NOTE = "Closed: the sales order is void in Zoho, so the order was cancelled here too.";
/** Zoho closes a sales order once it is invoiced, even with nothing shipped yet: nothing left to edit there. */
const ZOHO_FINISHED_ORDER_STATES = ["closed", "fulfilled"];

/**
 * A sales order is created with no address, so Zoho gives it the contact's. This writes the website
 * order's own copy onto the sales order only ("update address": Zoho Commerce's, or Zoho Books' once
 * Zoho Commerce is off; the contact stays as it is).
 * Never throws: a sales order with the contact's address is still a sales order, so the push goes on
 * and reports the problem when it has finished. Stops at the first refusal, so a Zoho that hangs
 * delays the push by one call; a retry writes whatever is still missing.
 */
async function writeZohoOrderAddress(
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  salesOrderId: string,
  salesOrderNumber: string,
  types: readonly ("shipping" | "billing")[],
) {
  const address = zohoOrderAddress(order.shipping_address);
  const outcome = { written: 0, problem: null as string | null };
  if (!address || !types.length) return outcome;
  // The same call in Zoho Books once Zoho Commerce is off (Zoho Inventory has none for one sales order).
  const commerce = await zohoCommerceInUse();
  for (const type of types) {
    try {
      const path = `salesorders/${encodeURIComponent(salesOrderId)}/address/${type}`;
      if (commerce) await commerceRequest(region, organizationId, token, path, "PUT", address);
      else await booksRequest(region, organizationId, token, path, "PUT", address);
      outcome.written += 1;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "unknown error";
      console.warn(zohoLogLine("zoho_order_address_failed", { order: order.order_no, zohoId: salesOrderId, type, error: message.slice(0, 200) }));
      outcome.problem = `Zoho sales order ${salesOrderNumber} is in place, but it does not show the address of Grain Bazar order ${order.order_no}: Zoho refused its ${type} address: ${message}.${zohoPermissionHint(message)}`;
      break;
    }
  }
  if (outcome.written) console.info(zohoLogLine("zoho_order_address_set", { order: order.order_no, zohoId: salesOrderId, written: outcome.written }));
  return outcome;
}

/**
 * A later push finishes an address that never reached a sales order, which still shows its contact's
 * address. One that differs from the contact's was set in Zoho or Admin > Zoho, so it is left alone.
 * Only a still-open sales order just found by its Reference# (`newlyFound`) skips that check. Once
 * invoiced or shipped it is too late to write, so every push reports a delivery that shows the wrong
 * place, until a person corrects it or the goods have gone. A pickup has nothing to deliver.
 */
async function finishZohoOrderAddress(
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  newlyFound: boolean,
) {
  const address = zohoOrderAddress(order.shipping_address);
  const missing = address && order.order_status !== "Cancelled" && !zohoOrderFinished(zoho) ? zohoAddressesToUpdate(zoho, address) : [];
  if (!missing.length) return { written: 0, problem: null };
  const number = str(zoho["salesorder_number"]) || order.order_no;
  const open = zohoOrderAddressOpen(zoho);
  let types = missing;
  if (!newlyFound || !open) {
    try {
      const { contact } = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, `contacts/${encodeURIComponent(str(zoho["customer_id"]))}`, "GET");
      types = zohoAddressesFromContact(zoho, contact ?? {}, missing);
    } catch (cause) {
      // Nothing to write once invoiced or shipped, so nothing to retry: the next push checks again.
      if (!open) return { written: 0, problem: null };
      const message = cause instanceof Error ? cause.message : "unknown error";
      return { written: 0, problem: `Zoho sales order ${number} is in place, but the address of Grain Bazar order ${order.order_no} could not be checked against its contact: ${message}.${zohoPermissionHint(message)}` };
    }
  }
  if (!types.length) return { written: 0, problem: null };
  if (!open) {
    const wrongPlace = !/^pickup/i.test(str(order.shipping_method)) && types.some((type) => !sameZohoPlace(zoho[`${type}_address`], address));
    return { written: 0, problem: wrongPlace ? `Zoho sales order ${number} was invoiced or shipped with the customer's saved address, not the address of Grain Bazar order ${order.order_no}.` : null };
  }
  return writeZohoOrderAddress(region, organizationId, token, order, str(zoho["salesorder_id"]), number, types);
}

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
  options: { newlyFound?: boolean; addressProblem?: string | null } = {},
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

  // Problems with the money in Zoho Books, raised once the goods side is done.
  const moneyIssues: ZohoMoneyIssues = { review: [], retry: [] };
  if (order.order_status === "Cancelled") {
    // Added 11 Nov 2026: its Books invoices are voided and the refunds recorded there first, so nothing in Books still
    // counts a cancelled order as owed or paid.
    await settleZohoBooksForCancelledOrder(db, region, organizationId, token, order, zoho, moneyIssues);
    if (!["void", "cancelled"].includes(zohoStatus())) {
      try {
        // Zoho voids only confirmed sales orders; a draft must be confirmed first.
        if (zohoStatus() === "draft") {
          await inventoryRequest(region, organizationId, token, `${path}/status/confirmed`, "POST");
        }
        await inventoryRequest(region, organizationId, token, `${path}/status/void`, "POST");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // Zoho not reached, or its daily limit: the queue tries again by itself.
        if (/could not be reached/i.test(message) || isZohoDailyLimitError(message)) throw cause;
        await saveZohoZohoState(db, order.id, zoho);
        const goodsBack = await cancelledGoodsBack(db, order.id);
        throw new NeedsReviewError([...moneyIssues.review, ...moneyIssues.retry,
          zohoVoidRefusedReview(order.order_no, str(zoho["salesorder_number"]), `${message}${zohoPermissionHint(message)}`, zoho, goodsBack)].join(" "));
      }
      zoho = await load();
      if (!["void", "cancelled"].includes(zohoStatus())) {
        await saveZohoZohoState(db, order.id, zoho);
        throw new NeedsReviewError([...moneyIssues.review, ...moneyIssues.retry,
          `Grain Bazar order ${order.order_no} is cancelled, but Zoho sales order ${str(zoho["salesorder_number"])} is still ${zohoStatus()}. Void it in Zoho.`].join(" "));
      }
    }
  } else if (ZOHO_CLOSED_ORDER_STATES.includes(zohoStatus())) {
    // Zoho is the official book: a void there closes this order too, refused only when money was received here.
    const closed = await closeOrderVoidedInZoho(db, order, str(zoho["salesorder_number"]), zohoStatus());
    await saveZohoZohoState(db, order.id, zoho);
    if (!closed.closed) throw new NeedsReviewError(closed.review);
    await refreshSalesOrderSnapshotSafe(db, organizationId, zoho);
    return;
  } else if (!ZOHO_FINISHED_ORDER_STATES.includes(zohoStatus())) {
    const zohoTotal = Number(zoho["total"]);
    const invoiced = str(zoho["invoiced_status"]).toLowerCase();
    const hasInvoice = Boolean(invoiced) && invoiced !== "not_invoiced" && invoiced !== "null";
    const paiseOff = Math.round(Math.abs(zohoTotal - Number(order.total)) * 100);
    // Zoho rounds CGST and SGST apart, so a sales order can be a few paise off for ever. Once invoiced, up to the write-off
    // limit is that rounding, not a change to the order; this stopped the sync before packing on about 1 order in 4 of 5% goods.
    if (Number.isFinite(zohoTotal) && paiseOff > 1 && !(hasInvoice && paiseOff <= ROUNDING_WRITE_OFF_LIMIT * 100)) {
      if (hasInvoice)
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
        ...zohoDiscountFields(order.discount, items),
        shipping_charge: Number(order.shipping) || 0,
        // Prices include GST on orders from 7 Nov 2026: Zoho takes the rate as GST-inclusive, so its total is the price paid.
        is_inclusive_tax: Boolean(order.prices_include_gst),
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
  // After any edit above, which may take the contact's address again; before the invoice, which
  // is made from the sales order. One try per push: `addressProblem` is this push's earlier refusal.
  const orderAddress = options.addressProblem
    ? { written: 0, problem: options.addressProblem }
    : await finishZohoOrderAddress(region, organizationId, token, order, zoho, options.newlyFound ?? false);
  if (orderAddress.written) zoho = await load();
  // Confirmed by the admin: the Zoho Books invoice, with the verified payments recorded on it.
  let invoiceAddressProblem: string | null = null;
  if (orderNeedsZohoInvoice(order.order_status) && !["draft", ...ZOHO_CLOSED_ORDER_STATES].includes(zohoStatus())) {
    if (await syncZohoOrderInvoice(db, region, organizationId, token, order, zoho, (problem) => { invoiceAddressProblem = problem; }, moneyIssues)) zoho = await load();
    // Now, in case packing below stops the sync first.
    if (moneyIssues.review.length || moneyIssues.retry.length) await tellAdminsOfPaymentReview(db, order, [...moneyIssues.review, ...moneyIssues.retry].join(" "));
    // Paid in full, with the invoice made and sent and the payments on it: the delivery note is released now, without
    // anyone's press (owner, 11 Nov 2026). The database checks the payment again on Zoho read just now; it never stops
    // the sync.
    if (!moneyIssues.review.length && !moneyIssues.retry.length && order.payment_status === "Paid") await releaseDeliveryNoteAfterInvoice(order.order_no);
  }
  // Packed / Dispatched / Out for Delivery / Delivered on the website: package, shipment and
  // delivery in Zoho, at the sales order's godown location.
  if (!["draft", ...ZOHO_CLOSED_ORDER_STATES].includes(zohoStatus())) {
    zoho = await pushZohoFulfilment(db, region, organizationId, token, order, zoho, load);
  }
  await saveZohoZohoState(db, order.id, zoho);
  await refreshSalesOrderSnapshotSafe(db, organizationId, zoho);
  // Raised last: goods that have moved stay in step with Zoho whatever is wrong with the money.
  if (moneyIssues.review.length) throw new NeedsReviewError(moneyIssues.review.join(" "));
  if (moneyIssues.retry.length) throw new Error(moneyIssues.retry.join(" "));
  const finalTotal = Number(zoho["total"]);
  if (order.order_status !== "Cancelled" && Number.isFinite(finalTotal) && Math.abs(finalTotal - Number(order.total)) > 2)
    throw new NeedsReviewError(`Zoho sales order ${str(zoho["salesorder_number"])} totals ₹${finalTotal.toFixed(2)}; Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Review taxes, discount and shipping.`);
  // Everything else is done, so a retry repeats only the address. Once invoiced a retry can't reach
  // the invoice, so that one waits for a person.
  if (orderAddress.problem) {
    if (zohoOrderAddressOpen(zoho)) throw new Error(orderAddress.problem);
    throw new NeedsReviewError(`${orderAddress.problem} Correct the sales order and its invoice in Zoho, then Retry.`);
  }
  // A sent invoice is not rewritten, so a retry can't fix it: this one waits for a person.
  if (invoiceAddressProblem) throw new NeedsReviewError(`${invoiceAddressProblem} Correct the address on the invoice in Zoho Books, then Retry.`);
}

/**
 * Zoho makes an invoice with the contact's address, not its sales order's (seen live, 3 Nov 2026), so
 * the sales order's is copied across while the invoice is a draft, which keeps a correction made there
 * too. An address that differs from the contact's was set by a person and is left alone. An invoice
 * already sent is never changed: one showing the wrong place for a delivery is reported, until a person
 * corrects it or the sales order is finished. Never throws: a refusal must not hold up the invoice.
 */
async function copyZohoAddressToInvoice(
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  invoiceId: string,
  invoice: Record<string, unknown>,
) {
  const outcome = { written: 0, problem: null as string | null };
  const differing = zohoInvoiceAddressesToCopy(invoice, zoho);
  const draft = str(invoice["status"]).toLowerCase() === "draft";
  if (!differing.length || (!draft && zohoOrderFinished(zoho))) return outcome;
  const number = str(invoice["invoice_number"]);
  try {
    const { contact } = await inventoryRequest<{ contact?: Record<string, unknown> }>(region, organizationId, token, `contacts/${encodeURIComponent(str(zoho["customer_id"]))}`, "GET");
    const types = zohoAddressesFromContact(invoice, contact ?? {}, differing);
    if (!draft) {
      const wrongPlace = !/^pickup/i.test(str(order.shipping_method)) && types.some((type) => !sameZohoPlace(invoice[`${type}_address`], zoho[`${type}_address`]));
      if (wrongPlace) outcome.problem = `Zoho Books invoice ${number} was sent with the customer's saved address, not the one on the sales order of Grain Bazar order ${order.order_no}.`;
      return outcome;
    }
    for (const type of types) {
      const body = zohoAddressBody(zoho[`${type}_address`]);
      if (!body) continue;
      await booksRequest(region, organizationId, token, `invoices/${encodeURIComponent(invoiceId)}/address/${type}`, "PUT", body);
      outcome.written += 1;
    }
  } catch (cause) {
    // Nothing to write on a sent invoice, so nothing lost: the next push checks again.
    if (!draft) return outcome;
    const message = cause instanceof Error ? cause.message : "unknown error";
    console.warn(zohoLogLine("zoho_invoice_address_failed", { order: order.order_no, invoice: number, error: message.slice(0, 200) }));
    outcome.problem = `Zoho Books invoice ${number} is in place, but it shows the customer's saved address, not the address of Grain Bazar order ${order.order_no}: ${message}.${zohoPermissionHint(message)}`;
  }
  if (outcome.written) console.info(zohoLogLine("zoho_invoice_address_set", { order: order.order_no, invoice: number, written: outcome.written }));
  return outcome;
}

async function readDepositAccounts(db: Awaited<ReturnType<typeof dbAdmin>>): Promise<DepositAccounts> {
  const { data, error } = await db.from("settings").select("value").eq("key", DEPOSIT_ACCOUNTS_KEY).maybeSingle();
  // Not read is not "none chosen": posting now could put the money in Undeposited Funds by mistake, so the sync waits.
  if (error) throw new Error("Could not read which Zoho account each godown's payments are deposited to");
  return parseDepositAccounts(data?.value);
}

/** The Zoho bank or cash account for this order's payments: its godown's choice, or null for Zoho's Undeposited Funds. */
async function depositAccountForOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
): Promise<DepositAccount | null> {
  const accounts = await readDepositAccounts(db);
  if (!Object.keys(accounts).length) return null;
  const orderBranch = (order as { branch_id?: string | null }).branch_id ?? null;
  let godowns: { id: string; zohoLocationId: string }[] = [];
  if (!orderBranch && str(zoho["location_id"])) {
    const { data, error } = await db.from("branches").select("id,zoho_location_id").is("vendor_id", null);
    if (error) throw new Error("Could not read the godowns to find where this order's payment is deposited");
    godowns = (data ?? []).map((row) => ({ id: row.id, zohoLocationId: str(row.zoho_location_id) }));
  }
  return depositAccountFor(accounts, godownOfPayment(orderBranch, str(zoho["location_id"]), godowns));
}

/** After dispatch the admin said whether the goods came back (order_cancellations.goods_back); null before dispatch. */
async function cancelledGoodsBack(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const { data } = await db.from("order_cancellations").select("goods_back").eq("order_id", orderId).maybeSingle();
  return data?.goods_back ?? null;
}

/**
 * Zoho Books for an order cancelled on the website (src/lib/zoho-cancel.ts says why in this order):
 *   1. a refund whose Books payment id the website lost finds it on the invoice by its UTR;
 *   2. every invoice that still counts is voided, which leaves its payments as the customer's credit in Books;
 *   3. each refund the admin recorded is recorded in Books against its payment, from the account the money went into.
 * Every step looks at Zoho first, so a retry never refunds twice. Nothing is deleted in Zoho. What Zoho refused goes
 * into `moneyIssues`.
 */
async function settleZohoBooksForCancelledOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  moneyIssues: ZohoMoneyIssues,
) {
  const invoices = liveZohoInvoices(zoho);
  const { data: rows, error } = await db.from("order_refunds")
    .select("id,amount,mode,reference,refunded_on,paid_ref,zoho_payment_id,zoho_refunded_at").eq("order_id", order.id).order("created_at");
  if (error) throw new Error("Could not read the order's refunds from Grain Bazar");
  const refunds: WebsiteRefund[] = (rows ?? []).filter((row) => !row.zoho_refunded_at).map((row) => ({
    id: row.id, amount: Number(row.amount), mode: row.mode, reference: row.reference, refundedOn: row.refunded_on,
    paidRef: row.paid_ref, zohoPaymentId: row.zoho_payment_id,
  }));
  if (!invoices.length && !refunds.some((refund) => refund.zohoPaymentId)) return;
  const said = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `${message}${zohoPermissionHint(message)}`;
  };

  // 1. Its Books payment, for a refund whose payment was sent to Zoho but whose id never came back.
  if (refunds.some((refund) => !refund.zohoPaymentId && refund.paidRef)) {
    for (const invoice of invoices) {
      try {
        const listed = await booksRequest<{ payments?: { payment_id?: string; reference_number?: string; amount?: number }[] }>(region, organizationId, token, `invoices/${encodeURIComponent(invoice.id)}/payments`, "GET");
        const found = matchRefundPayments(refunds, (listed.payments ?? []).map((payment) => ({ paymentId: str(payment.payment_id), reference: str(payment.reference_number), amount: Number(payment.amount) || 0 })));
        for (const [refundId, paymentId] of found) {
          await db.from("order_refunds").update({ zoho_payment_id: paymentId }).eq("id", refundId).is("zoho_payment_id", null);
          const refund = refunds.find((row) => row.id === refundId);
          if (refund) refund.zohoPaymentId = paymentId;
        }
      } catch (cause) {
        moneyIssues.retry.push(`Zoho Books invoice ${invoice.number || invoice.id} of cancelled Grain Bazar order ${order.order_no}: reading its payments failed: ${said(cause)}.`);
      }
    }
  }

  // 2. Void what still counts. A refund needs its payment off the invoice first, so a refusal here stops the refunds.
  let voided = true;
  for (const invoice of invoices) {
    try {
      await booksRequest(region, organizationId, token, `invoices/${encodeURIComponent(invoice.id)}/status/void`, "POST");
      console.info(zohoLogLine("zoho_invoice_voided_on_cancel", { order: order.order_no, invoice: invoice.number || invoice.id }));
      await db.from("zoho_order_invoices").update({ status: "void", updated_at: new Date().toISOString() }).eq("order_id", order.id).eq("zoho_invoice_id", invoice.id);
    } catch (cause) {
      voided = false;
      moneyIssues.review.push(`Zoho Books invoice ${invoice.number || invoice.id} of cancelled Grain Bazar order ${order.order_no} could not be voided: ${said(cause)}. Void it in Zoho Books, then Retry.`);
    }
  }
  if (!voided) return;

  // 3. The refunds. Claimed before the post, so two syncs at once cannot both send one; a lost answer is found by 3a next time.
  for (const refund of refunds) {
    if (!refund.zohoPaymentId) continue;
    const paymentPath = `customerpayments/${encodeURIComponent(refund.zohoPaymentId)}`;
    const note = async (refundId: string) => {
      await db.from("order_refunds").update({ zoho_refund_id: refundId, zoho_refunded_at: new Date().toISOString(), zoho_problem: null }).eq("id", refund.id);
    };
    try {
      // 3a. Already there?
      const listed = await booksRequest<{ payment_refunds?: ListedZohoRefund[] }>(region, organizationId, token, `${paymentPath}/refunds`, "GET");
      const already = refundAlreadyInZoho(listed.payment_refunds ?? [], refund, order.order_no);
      if (already) { await note(already); continue; }
    } catch (cause) {
      moneyIssues.retry.push(zohoRefundProblem(order.order_no, refund.amount, `reading the payment's refunds failed: ${said(cause)}`));
      continue;
    }
    const staleClaim = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: claimed, error: claimError } = await db.from("order_refunds").update({ zoho_claimed_at: new Date().toISOString() })
      .eq("id", refund.id).is("zoho_refund_id", null).or(`zoho_claimed_at.is.null,zoho_claimed_at.lt.${staleClaim}`).select("id");
    if (claimError) throw new Error("Could not note the refund before sending it to Zoho");
    if (!claimed?.length) continue;
    let account = "";
    try {
      const read = await booksRequest<{ payment?: { account_id?: string } }>(region, organizationId, token, paymentPath, "GET");
      account = str(read.payment?.account_id);
    } catch (cause) {
      await db.from("order_refunds").update({ zoho_claimed_at: null }).eq("id", refund.id);
      moneyIssues.retry.push(zohoRefundProblem(order.order_no, refund.amount, `reading the payment failed: ${said(cause)}`));
      continue;
    }
    if (!account) {
      await db.from("order_refunds").update({ zoho_claimed_at: null, zoho_problem: "Zoho did not say which account the payment went into" }).eq("id", refund.id);
      moneyIssues.review.push(zohoRefundProblem(order.order_no, refund.amount, "Zoho did not say which account the payment went into"));
      continue;
    }
    try {
      const created = await booksRequest<{ payment_refunds?: { payment_refund_id?: string }[] }>(region, organizationId, token, `${paymentPath}/refunds`, "POST",
        zohoRefundBody(refund, order.order_no, account));
      await note(str(created.payment_refunds?.[0]?.payment_refund_id) || "recorded");
      console.info(zohoLogLine("zoho_refund_recorded", { order: order.order_no, amount: refund.amount }));
    } catch (cause) {
      // Not sent, or the answer was lost: the next sync looks at Zoho's refunds first either way.
      const message = said(cause);
      await db.from("order_refunds").update({ zoho_claimed_at: null, zoho_problem: message.slice(0, 500) }).eq("id", refund.id);
      moneyIssues.retry.push(zohoRefundProblem(order.order_no, refund.amount, message));
    }
  }
}

/**
 * Zoho Books invoice for a confirmed website order: converts its sales order to an invoice (Books
 * "invoices/fromsalesorder", so it gets the godown location's invoice series), marks it sent,
 * then records each verified website payment (by UTR) against it, so Books shows the order PAID.
 * Every step looks at Zoho first, so a retry never makes a second invoice or payment. A payment pushed once is never
 * posted again. What a person must look at, and what Zoho refused or never answered, go into `moneyIssues`, raised at
 * the end of the sync so goods that have moved stay in step with Zoho.
 */
async function ensureZohoBooksInvoice(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  reportAddressProblem: (problem: string) => void,
  moneyIssues: ZohoMoneyIssues,
) {
  const salesOrderId = order.zoho_salesorder_id!;
  const number = str(zoho["salesorder_number"]) || order.order_no;
  const failure = (step: string, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `Zoho Books invoice for ${number}: ${step} failed: ${message}.${zohoPermissionHint(message)}`;
  };
  const fail = (step: string, cause: unknown): never => {
    throw new Error(failure(step, cause));
  };
  type BooksInvoice = { date?: string; invoice_id?: string; invoice_number?: string; status?: string; total?: number; balance?: number; payment_made?: number | null; customer_id?: string; customer_name?: string; gst_treatment?: string; gst_no?: string; place_of_supply?: string; billing_address?: unknown; shipping_address?: unknown };
  const linked = (Array.isArray(zoho["invoices"]) ? zoho["invoices"] : []).map(plainObject)
    .filter((invoice) => str(invoice["invoice_id"]) && !["void"].includes(str(invoice["status"]).toLowerCase()));
  let invoiceId = str(linked[0]?.["invoice_id"]);
  if (!invoiceId) {
    const invoiced = str(zoho["invoiced_status"]).toLowerCase();
    if (invoiced && invoiced !== "not_invoiced" && invoiced !== "null")
      throw new NeedsReviewError(`Zoho sales order ${number} is already invoiced, but its invoice could not be read. Check the invoice and payment for Grain Bazar order ${order.order_no} in Zoho Books.`);
    try {
      const created = await booksRequest<{ invoice?: BooksInvoice }>(region, organizationId, token, `invoices/fromsalesorder?salesorder_id=${encodeURIComponent(salesOrderId)}`, "POST");
      invoiceId = str(created.invoice?.invoice_id);
    } catch (cause) {
      fail("creating the invoice", cause);
    }
    if (!invoiceId) throw new Error(`Zoho Books did not return the invoice created for ${number}`);
    console.info(zohoLogLine("zoho_invoice_created", { order: number }));
  }
  const readInvoice = async () => {
    try {
      const response = await booksRequest<{ invoice?: BooksInvoice }>(region, organizationId, token, `invoices/${encodeURIComponent(invoiceId)}`, "GET");
      if (!response.invoice) throw new Error("no invoice returned");
      return response.invoice;
    } catch (cause) {
      return fail("reading the invoice", cause);
    }
  };
  let invoice = await readInvoice();
  const addressCopy = await copyZohoAddressToInvoice(region, organizationId, token, order, zoho, invoiceId, invoice);
  if (addressCopy.problem) reportAddressProblem(addressCopy.problem);
  if (addressCopy.written) invoice = await readInvoice();
  // Business purchases: the invoice (made from the sales order) must carry the buyer's GSTIN as a
  // registered business (or the IRP rejects it), or be an unregistered business when only a company
  // name was given, and be billed to that company. Checked while it is still a draft; nothing is sent
  // until it is right.
  const expected = zohoGstFields(order.customer_gstin, "invoice", order.business_legal_name);
  const invoiceLabel = `Zoho Books invoice ${str(invoice.invoice_number) || number} for business order ${order.order_no}`;
  if (expected["gst_treatment"] === "business_gst"
    && (str(invoice.gst_treatment) !== "business_gst" || str(invoice.gst_no).toUpperCase() !== String(expected["gst_no"]))) {
    throw new NeedsReviewError(`${invoiceLabel} is not marked "Registered Business - Regular" with GSTIN ${String(expected["gst_no"])} (it shows ${str(invoice.gst_treatment) || "no GST treatment"}${str(invoice.gst_no) ? `, GSTIN ${str(invoice.gst_no)}` : ""}). Open it in Zoho Books, set the customer's GST treatment and GSTIN, save, then Retry.`);
  }
  if (expected["gst_treatment"] === "business_none" && str(invoice.gst_treatment) !== "business_none") {
    throw new NeedsReviewError(`${invoiceLabel} is not marked "Business - Unregistered" (it shows ${str(invoice.gst_treatment) || "no GST treatment"}). Open it in Zoho Books, set the customer's GST treatment, save, then Retry.`);
  }
  const company = (order.business_legal_name ?? "").trim();
  const sameName = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
  if (company && str(invoice.customer_name) && !sameName(str(invoice.customer_name), company)) {
    throw new NeedsReviewError(`${invoiceLabel} is billed to "${str(invoice.customer_name)}", not the company "${company}" the customer entered at checkout. Open the customer in Zoho Books, set the name to "${company}", save, then Retry.`);
  }
  if (str(invoice.status).toLowerCase() === "draft") {
    try {
      await booksRequest(region, organizationId, token, `invoices/${encodeURIComponent(invoiceId)}/status/sent`, "POST");
    } catch (cause) {
      fail("marking the invoice sent", cause);
    }
    invoice = await readInvoice();
  }
  const invoiceTotal = Number(invoice.total);
  if (Number.isFinite(invoiceTotal) && Math.abs(invoiceTotal - Number(order.total)) > 2)
    throw new NeedsReviewError(`Zoho Books invoice ${str(invoice.invoice_number)} totals ₹${invoiceTotal.toFixed(2)}; Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Payments were not recorded; correct the invoice in Zoho Books.`);

  // Verified website payments (admin-confirmed UTRs) not yet on the invoice.
  const { data: payments, error } = await db.from("payments").select("id,amount,txn_ref,method,created_at,status,zoho_invoice_id,zoho_payment_id")
    .eq("order_id", order.id).eq("status", "Paid");
  if (error) throw new Error("Could not read the order's payments from Grain Bazar");
  if (!payments?.length) return invoice;
  let onInvoice: { paymentId: string; reference: string; amount: number }[] = [];
  try {
    const response = await booksRequest<{ payments?: { payment_id?: string; reference_number?: string; amount?: number }[] }>(region, organizationId, token, `invoices/${encodeURIComponent(invoiceId)}/payments`, "GET");
    onInvoice = (response.payments ?? []).map((payment) => ({ paymentId: str(payment.payment_id), reference: str(payment.reference_number), amount: Number(payment.amount) || 0 }));
  } catch (cause) {
    fail("reading the invoice's payments", cause);
  }
  const website = payments.map((payment) => ({
    id: payment.id, amount: Number(payment.amount), txnRef: str(payment.txn_ref), method: payment.method, paidAt: payment.created_at,
    pushedToInvoice: payment.zoho_invoice_id, zohoPaymentId: payment.zoho_payment_id,
  }));
  // A note that cannot be written only delays it: Zoho shows the payment, so the next sync writes it and posts nothing.
  const noteAsPushed = async (paymentId: string, zohoPaymentId: string | null) => {
    const { error: noteError } = await db.from("payments")
      .update({ zoho_invoice_id: invoiceId, zoho_payment_id: zohoPaymentId, zoho_pushed_at: new Date().toISOString() }).eq("id", paymentId);
    if (noteError) console.warn(zohoLogLine("zoho_invoice_payment_note_failed", { order: number, error: noteError.message }));
  };
  for (const seen of paymentsToNoteAsPushed(website, onInvoice, invoiceId)) await noteAsPushed(seen.payment.id, seen.zohoPaymentId);
  const gone = paymentsGoneFromInvoice(website, onInvoice);
  const toRecord = paymentsToRecord(website, onInvoice.map((payment) => payment.reference), Number(invoice.balance));
  const customerId = str(invoice.customer_id) || str(zoho["customer_id"]);
  // The godown's own Zoho bank account, when one is chosen (Admin > Payments & Matching); else Zoho's Undeposited Funds.
  const depositAccount = toRecord.length ? await depositAccountForOrder(db, order, zoho) : null;
  for (const payment of toRecord) {
    // Claimed before the post, so two syncs at once can't both post it. A crash here leaves a review, not a second payment.
    const pushed = website.find((row) => row.txnRef.trim() === payment.reference);
    if (pushed) {
      const { data: claimed, error: claimError } = await db.from("payments")
        .update({ zoho_invoice_id: invoiceId, zoho_pushed_at: new Date().toISOString() }).eq("id", pushed.id).is("zoho_invoice_id", null).select("id");
      if (claimError) throw new Error("Could not note the payment before sending it to Zoho");
      if (!claimed?.length) continue;
    }
    let created: { payment?: { payment_id?: string } } | undefined;
    try {
      created = await booksRequest<{ payment?: { payment_id?: string } }>(region, organizationId, token, "customerpayments", "POST",
        zohoCustomerPaymentBody(payment, { customerId, invoiceId, orderNo: order.order_no }, depositAccount));
    } catch (cause) {
      // Not sent, or the reply was lost: the next sync reads Zoho first either way.
      if (pushed) await db.from("payments").update({ zoho_invoice_id: null, zoho_pushed_at: null }).eq("id", pushed.id);
      const message = cause instanceof Error ? cause.message : String(cause);
      moneyIssues.retry.push(`${failure(`recording payment ${payment.reference}`, cause)}${depositAccountHint(message, depositAccount)}`);
      continue;
    }
    if (pushed) await noteAsPushed(pushed.id, str(created?.payment?.payment_id) || null);
    console.info(zohoLogLine("zoho_invoice_payment_recorded", { order: number, amount: payment.amount, deposited_to: depositAccount ? "godown_account" : "undeposited_funds" }));
  }
  // Paid in full on the website, but Zoho's separate CGST/SGST rounding left a paisa or two on the
  // invoice: write that off so Books shows it PAID for exactly what the customer paid.
  const after = toRecord.length ? await readInvoice() : invoice;
  const websitePaid = website.reduce((sum, payment) => sum + payment.amount, 0);
  const label = str(after.invoice_number) || number;
  // Zoho's own figure, or its list of payments if that says more: a credit applied from a void may show only there.
  const listedMoney = onInvoice.reduce((sum, payment) => sum + payment.amount, 0) + toRecord.reduce((sum, payment) => sum + payment.amount, 0);
  const moneyOn = (seen: BooksInvoice) => Math.max(invoicePaidOf(seen), listedMoney);
  const reviewOf = (seen: BooksInvoice) => invoicePaymentReview(gone.length, websitePaid, Number(order.total), Number(seen.total), moneyOn(seen), Number(seen.balance));
  // Nothing is written off while a pushed payment is missing: that ₹1 may be the payment.
  const writeOff = reviewOf(after) === "gone" ? 0 : roundingWriteOff(Number(order.total), Number(order.paid_amount), Number(after.balance));
  if (writeOff > 0) {
    try {
      await booksRequest(region, organizationId, token, `invoices/${encodeURIComponent(invoiceId)}/writeoff`, "POST");
    } catch (cause) {
      moneyIssues.retry.push(failure(`writing off the ₹${writeOff.toFixed(2)} GST rounding`, cause));
    }
    console.info(zohoLogLine("zoho_invoice_rounding_written_off", { order: number, amount: writeOff }));
  }
  const final = writeOff > 0 ? await readInvoice() : after;
  // Zoho refused or never answered: that is the reason, and the next sync tries again.
  const review = moneyIssues.retry.length ? null : reviewOf(final);
  if (review === "gone") {
    const names = gone.map((payment) => `₹${payment.amount.toFixed(2)} (UTR ${payment.txnRef})`).join(", ");
    const extra = linked.length > 1 ? ` This sales order has ${linked.length} invoices: void the extra one first.` : "";
    moneyIssues.review.push(`Zoho Books invoice ${label} does not show ${names}, which Grain Bazar recorded for order ${order.order_no} and already sent to Zoho. It was not posted again, because that could count the money twice.${extra} If it is in Zoho as the customer's credit (voiding an invoice leaves it there), apply it to this invoice. If it was removed by mistake, record it in Zoho Books with that UTR as the reference. Then Retry. If the money went back to the customer, the website still shows it as paid: tell the office before the goods go.`);
  } else if (review === "short") {
    moneyIssues.review.push(`Zoho Books invoice ${label} holds ₹${moneyOn(final).toFixed(2)} in payments, but Grain Bazar recorded ₹${websitePaid.toFixed(2)} for order ${order.order_no}. If a credit note or write-off closed it, the money may have gone back: check before the goods go. Otherwise correct the payment in Zoho Books. Then Retry.`);
  } else if (review === "over") {
    moneyIssues.review.push(`Zoho Books invoice ${label} holds ₹${moneyOn(final).toFixed(2)} in payments, more than the ₹${websitePaid.toFixed(2)} Grain Bazar recorded for order ${order.order_no}. If one transfer was entered twice, remove the extra in Zoho Books. If the money came in, record it on the website. Then Retry.`);
  } else if (review === "above") {
    moneyIssues.review.push(`Zoho Books invoice ${label} totals ₹${Number(final.total).toFixed(2)}, more than Grain Bazar order ${order.order_no} at ₹${Number(order.total).toFixed(2)}, so ₹${Number(final.balance).toFixed(2)} stays due after the customer paid in full. Re-sync cannot clear this: correct the invoice in Zoho Books, then Retry.`);
  }
  return final;
}

/**
 * The delivery note's automatic release (delivery-notes.functions.ts), loaded when it is needed so neither file imports
 * the other at start. An order that has its note already costs nothing more. Never throws into the sync.
 */
async function releaseDeliveryNoteAfterInvoice(orderNo: string) {
  try {
    const { raiseDeliveryNoteAutomatically } = await import("@/lib/delivery-notes.functions");
    await raiseDeliveryNoteAutomatically(orderNo);
  } catch (cause) {
    console.warn(zohoLogLine("delivery_note_auto_failed", { order: orderNo, error: cause instanceof Error ? cause.message : String(cause) }));
  }
}

type InvoiceRow = Database["public"]["Tables"]["zoho_order_invoices"]["Row"];

/** What went wrong with an order's money during a sync: `review` needs a person, `retry` the next sync tries again. */
type ZohoMoneyIssues = { review: string[]; retry: string[] };

async function readInvoiceRecord(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const { data, error } = await db.from("zoho_order_invoices").select("*").eq("order_id", orderId).maybeSingle();
  if (error) throw new Error("Could not read the order's invoice record");
  return data as InvoiceRow | null;
}

const asInvoiceRecord = (row: InvoiceRow | null): InvoiceRecord | null => row && {
  zohoInvoiceId: row.zoho_invoice_id, invoiceNumber: row.invoice_number, status: row.status,
  autoAttempts: row.auto_attempts, adminApproved: row.admin_approved,
};

async function saveInvoiceRecord(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  order: { id: string; order_no: string },
  patch: Partial<Omit<InvoiceRow, "order_id" | "order_no">>,
) {
  const { error } = await db.from("zoho_order_invoices").upsert(
    { order_id: order.id, order_no: order.order_no, ...patch, updated_at: new Date().toISOString() },
    { onConflict: "order_id" },
  );
  if (error) throw new Error("Could not save the order's invoice record");
}

/**
 * Zoho -> website for the order's invoice, from a sales order detail record: records the live
 * invoice (number, status, amounts) or that the known invoice was voided/deleted in Zoho. Never
 * creates anything. Skipped when the record does not list invoices.
 */
async function recordZohoInvoiceState(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  order: { id: string; order_no: string; order_status: string },
  zoho: Record<string, unknown>,
) {
  const invoices = zohoInvoicesOf(zoho);
  if (!invoices || !orderNeedsZohoInvoice(order.order_status)) return;
  const row = await readInvoiceRecord(db, order.id);
  const decision = invoiceDecision(asInvoiceRecord(row), invoices);
  if (decision.action === "track") {
    const { invoice } = decision;
    const status = websiteInvoiceStatus(invoice.status);
    if (row?.zoho_invoice_id === invoice.invoiceId && row.status === status && Number(row.balance) === invoice.balance) return;
    // More is due than before: a payment was removed in Zoho. A delivered order gets no other sync, so ask for one.
    if (row?.zoho_invoice_id === invoice.invoiceId && row.balance != null && invoice.balance != null && invoice.balance > Number(row.balance) + 0.005) {
      await db.rpc("enqueue_zoho_sync", { _entity_type: "order", _entity_id: order.id });
    }
    await saveInvoiceRecord(db, order, {
      zoho_invoice_id: invoice.invoiceId, invoice_number: invoice.number, status,
      ...(invoice.date ? { invoice_date: invoice.date } : {}),
      total: invoice.total, balance: invoice.balance,
      auto_attempts: Math.max(1, row?.auto_attempts ?? 0),
      last_event: row?.zoho_invoice_id === invoice.invoiceId ? `Invoice ${status.replace("_", " ")} in Zoho` : "Invoice found in Zoho",
    });
  } else if (decision.action === "lost") {
    await saveInvoiceRecord(db, order, {
      zoho_invoice_id: null, status: decision.status, balance: null,
      last_event: `Invoice ${decision.number} was ${decision.status === "void" ? "voided" : "deleted"} in Zoho Books`,
    });
  }
}

/**
 * Website -> Zoho for a confirmed order's invoice. Creates the first invoice automatically; after
 * an invoice was voided/deleted in Zoho, waits for an admin's approval (order page) before making
 * a new one. Returns true when it changed anything in Zoho.
 */
async function syncZohoOrderInvoice(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  reportAddressProblem: (problem: string) => void,
  moneyIssues: ZohoMoneyIssues,
) {
  const row = await readInvoiceRecord(db, order.id);
  const decision = invoiceDecision(asInvoiceRecord(row), zohoInvoicesOf(zoho) ?? []);
  if (decision.action === "lost") {
    await recordZohoInvoiceState(db, order, zoho);
    return false;
  }
  if (decision.action === "await_approval") {
    if (!["void", "deleted", "awaiting_approval"].includes(row?.status ?? "")) {
      await saveInvoiceRecord(db, order, { status: "awaiting_approval", last_event: "No Zoho invoice: waiting for admin approval" });
    }
    return false;
  }
  const invoice = await ensureZohoBooksInvoice(db, region, organizationId, token, order, zoho, reportAddressProblem, moneyIssues);
  const created = decision.action === "create";
  await saveInvoiceRecord(db, order, {
    zoho_invoice_id: str(invoice.invoice_id) || null,
    invoice_number: str(invoice.invoice_number) || null,
    ...(/^\d{4}-\d{2}-\d{2}/.test(str(invoice.date)) ? { invoice_date: str(invoice.date).slice(0, 10) } : {}),
    status: websiteInvoiceStatus(str(invoice.status)),
    total: Number.isFinite(Number(invoice.total)) ? Number(invoice.total) : null,
    balance: Number.isFinite(Number(invoice.balance)) ? Number(invoice.balance) : null,
    ...(created ? {
      auto_attempts: (row?.auto_attempts ?? 0) + 1,
      admin_approved: false,
      last_event: decision.reason === "approved" ? "New invoice created after admin approval" : "Invoice created when the order was confirmed",
    } : {}),
  });
  return true;
}

/**
 * A money problem on an order's invoice reaches the admins' bell, not only the Zoho queue: once a day at most, however
 * often the order syncs. Never stops the sync. Not on the invoice row: customers and vendors can read that.
 */
async function tellAdminsOfPaymentReview(db: Awaited<ReturnType<typeof dbAdmin>>, order: { id: string; order_no: string }, reason: string) {
  const title = "Zoho payment needs you";
  try {
    const { data: told, error: toldError } = await db.from("notifications").select("id").eq("order_no", order.order_no).eq("title", title).eq("message", reason)
      .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString()).limit(1);
    if (toldError) throw new Error(toldError.message);
    if (told?.length) return;
    const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
    const { error } = await db.from("notifications").insert((admins ?? []).map((admin) => ({
      order_no: order.order_no, order_id: order.id, recipient_id: admin.user_id, recipient_role: "admin", title, message: reason, status: "payment",
    })));
    if (error) throw new Error(error.message);
  } catch (cause) {
    console.warn(zohoLogLine("zoho_payment_review_notice_failed", { order: order.order_no, error: cause instanceof Error ? cause.message : String(cause) }));
  }
}

/** Records Zoho's status and change time on the Grain Bazar order (shown in the admin). */
/**
 * A sales order voided or cancelled in Zoho. Zoho is the official book, so the website order closes too, at any stage
 * (apply_zoho_order_cancellation). It is refused only when money was received here, which must be refunded first, and
 * the caller hands that to a person. Once closed, the order's earlier reviews are answered: they asked about this.
 */
async function closeOrderVoidedInZoho(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  order: { id: string; order_no: string; order_status: string },
  salesOrderNumber: string,
  zohoStatus: string,
): Promise<{ closed: true } | { closed: false; review: string }> {
  const { data: result, error } = await db.rpc("apply_zoho_order_cancellation", { _order_id: order.id });
  if (!error && result && !result.startsWith("blocked")) {
    await db.from("zoho_sync_outbox")
      .update({ status: "complete", last_error: ZOHO_VOID_CLOSED_NOTE, updated_at: new Date().toISOString() })
      .eq("entity_type", "order").eq("entity_id", order.id).in("status", ["needs_review", "failed"]);
    return { closed: true };
  }
  const why = error?.message
    ?? (result === "blocked_paid" ? "a payment was received here (refund it first)" : `it is ${order.order_status}`);
  return {
    closed: false,
    review: `Zoho sales order ${salesOrderNumber} was ${zohoStatus === "void" ? "voided" : "cancelled"} in Zoho, but Grain Bazar order ${order.order_no} was not cancelled because ${why}. Decide which is right and correct the other side.`,
  };
}

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

/** Zoho fulfilment progress as a Grain Bazar status (Packed / Dispatched / Delivered), from packages and shipments. */
function zohoFulfillmentStatus(zoho: Record<string, unknown>) {
  return zohoFulfilmentStatus(zohoPackagesOf(zoho), str(zoho["shipped_status"]));
}

/**
 * Website -> Zoho fulfilment for one sales order. Each pass reads Zoho, does the next missing step
 * (package, then shipment, then delivered) and reads Zoho again, so a retry never makes a second
 * package or shipment. Zoho numbers them in the location's own series; if the organization has
 * auto-numbering off, PKG-/SHP- plus the website order number are used instead.
 */
async function pushZohoFulfilment(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  zoho: Record<string, unknown>,
  load: () => Promise<Record<string, unknown>>,
) {
  const salesOrderId = order.zoho_salesorder_id!;
  const number = str(zoho["salesorder_number"]) || order.order_no;
  const today = indiaDate(new Date().toISOString());
  const fail = (step: string, cause: unknown): never => {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Zoho ${step} for ${number} failed: ${message}.${zohoPermissionHint(message)}`);
  };
  /** Creates with Zoho's auto number; if Zoho asks for a number, retries once with our own. */
  const createNumbered = async (resource: string, query: Record<string, string>, body: Record<string, unknown>, numberField: string, ownNumber: string) => {
    try {
      return await inventoryRequest<Record<string, unknown>>(region, organizationId, token, resource, "POST", body, query);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (!/number/i.test(message)) throw cause;
      return await inventoryRequest<Record<string, unknown>>(region, organizationId, token, resource, "POST",
        { ...body, [numberField]: ownNumber }, { ...query, ignore_auto_number_generation: "true" });
    }
  };
  for (let pass = 0; pass < 4; pass += 1) {
    const next = nextZohoFulfilmentStep(order.order_status, zohoPackagesOf(zoho));
    if (!next) return zoho;
    if (next.step === "package") {
      const soLines = (Array.isArray(zoho["line_items"]) ? zoho["line_items"] : []).map(plainObject)
        .filter((line) => str(line["line_item_id"]) && Number(line["quantity"]) > 0);
      let lines: Record<string, unknown>[] = soLines.map((line) => ({ so_line_item_id: str(line["line_item_id"]), quantity: Number(line["quantity"]) }));
      if (soLines.some((line) => line["track_batch_number"] === true)) {
        // Items with Zoho "Track batches": the package names the batches the order took (FIFO).
        const inputs = await packageBatchInputs(db, region, organizationId, token, order.id, soLines, str(zoho["location_id"]));
        const planned = packageLinesWithBatches(soLines, inputs.reserved, inputs.zohoBatchesByItem);
        if (planned.problems.length)
          throw new NeedsReviewError(`Zoho needs batches to pack ${number}: ${planned.problems.join("; ")}. Receive the stock as a batch (Admin > Batches), then retry.`);
        lines = planned.lines;
      }
      if (!lines.length) throw new NeedsReviewError(`Zoho sales order ${number} has no items to pack.`);
      // The batch / stock numbers packed, as text on the package.
      const { data: orderLines } = await db.from("order_items").select("id,product_name,qty").eq("order_id", order.id);
      const codes = await orderItemBatchCodes(db, (orderLines ?? []).map((line) => line.id));
      const packedBatches = (orderLines ?? []).map((line) => {
        const text = batchLineText(codes.get(line.id) ?? [], Number(line.qty));
        return text ? `${line.product_name}: ${text}` : "";
      }).filter(Boolean).join("; ");
      try {
        await createNumbered("packages", { salesorder_id: salesOrderId },
          { date: today, line_items: lines, notes: `Packed for Grain Bazar order ${order.order_no}${packedBatches ? `. ${packedBatches}` : ""}`.slice(0, 1000) },
          "package_number", `PKG-${order.order_no}`.slice(0, 50));
      } catch (cause) {
        fail("package", cause);
      }
      console.info(zohoLogLine("zoho_package_created", { order: number }));
    } else if (next.step === "shipment") {
      try {
        await createNumbered("shipmentorders", { package_ids: next.packageId, salesorder_id: salesOrderId },
          {
            date: today,
            delivery_method: order.shipping_method === "Pickup" ? "Customer pickup from godown" : "Grain Bazar delivery",
            notes: `Dispatched for Grain Bazar order ${order.order_no}`,
          },
          "shipment_number", `SHP-${order.order_no}`.slice(0, 50));
      } catch (cause) {
        fail("shipment", cause);
      }
      console.info(zohoLogLine("zoho_shipment_created", { order: number }));
    } else {
      try {
        await inventoryRequest(region, organizationId, token, `shipmentorders/${encodeURIComponent(next.shipmentId)}/status/delivered`, "POST");
      } catch (cause) {
        fail("delivery", cause);
      }
      console.info(zohoLogLine("zoho_shipment_delivered", { order: number }));
    }
    zoho = await load();
  }
  throw new NeedsReviewError(`Zoho sales order ${number} did not reach "${order.order_status}" after creating its package and shipment. Check it in Zoho.`);
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
  const websiteOrderNo = websiteOrderNoOf({ salesorder_number: number, reference_number: str(zoho["reference_number"]) });
  if (!order && websiteOrderNo) {
    const byNumber = await db.from("orders").select(columns).eq("order_no", websiteOrderNo).is("zoho_salesorder_id", null).maybeSingle();
    order = byNumber.data;
    if (order) {
      await db.from("orders").update({ zoho_salesorder_id: zohoId }).eq("id", order.id).is("zoho_salesorder_id", null);
      // A push may have been waiting to hear of this sales order: the queue confirms and invoices it, or voids it.
      await db.rpc("enqueue_zoho_sync", { _entity_type: "order", _entity_id: order.id });
    }
  }
  if (!order) return "not_grain_bazar";

  const modifiedMs = Date.parse(str(zoho["last_modified_time"]));
  const knownMs = Date.parse(order.zoho_last_modified_at ?? "");
  if (Number.isFinite(modifiedMs) && Number.isFinite(knownMs) && modifiedMs <= knownMs) {
    try {
      await recordZohoInvoiceState(db, order, zoho);
    } catch {
      // The next poll or order sync records it.
    }
    return "unchanged";
  }

  const status = str(zoho["order_status"] ?? zoho["status"]).toLowerCase();
  let outcome = "recorded";
  if (ZOHO_CLOSED_ORDER_STATES.includes(status) && order.order_status !== "Cancelled") {
    const closed = await closeOrderVoidedInZoho(db, order, number, status);
    if (closed.closed) {
      outcome = "cancelled";
    } else {
      await saveZohoReview(db, "order", order.id, closed.review);
      outcome = "review";
    }
  } else if (order.order_status !== "Cancelled") {
    const fulfillment = zohoFulfillmentStatus(zoho);
    if (fulfillment && zohoStatusMovesForward(order.order_status, fulfillment)) {
      const { error } = await db.rpc("apply_zoho_order_fulfillment", { _order_id: order.id, _status: fulfillment });
      if (!error) outcome = fulfillment.toLowerCase();
    }
    const zohoTotal = Number(zoho["total"]);
    if (!["void", "cancelled"].includes(status) && Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 2) {
      await saveZohoReview(db, "order", order.id, `Zoho sales order ${number} now totals ₹${zohoTotal.toFixed(2)}, but Grain Bazar order ${order.order_no} totals ₹${Number(order.total).toFixed(2)}. Items or prices were changed in Zoho; make the same change in Grain Bazar (or undo it in Zoho).`);
      outcome = "review";
    }
    // The order's invoice as Zoho has it now (deleted / voided / paid in Zoho shows on the site).
    try {
      await recordZohoInvoiceState(db, order, zoho);
    } catch {
      // The next poll or order sync records it.
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
    { sort_column: "last_modified_time", sort_order: "D", per_page: "50" },
  );
  const summary = { checked: 0, changed: 0 };
  // Only orders that belong to the website, and only when Zoho changed them since the last apply
  // (one full read per changed order keeps this inside Zoho's daily API budget).
  const rows = result.salesorders ?? [];
  const { data: linked } = await db.from("orders").select("zoho_salesorder_id,zoho_last_modified_at")
    .in("zoho_salesorder_id", rows.map((row) => str(row["salesorder_id"])).filter(Boolean));
  const knownModified = new Map((linked ?? []).map((row) => [row.zoho_salesorder_id!, Date.parse(row.zoho_last_modified_at ?? "")]));
  for (const row of rows) {
    const id = str(row["salesorder_id"]);
    const known = knownModified.get(id);
    if (known === undefined && !websiteOrderNoOf({ salesorder_number: str(row["salesorder_number"]), reference_number: str(row["reference_number"]) })) continue;
    if (known !== undefined && Number.isFinite(known) && Date.parse(str(row["last_modified_time"])) <= known) continue;
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
/** Applies one Zoho webhook call. The record is re-read from Zoho, never trusted from the call itself. */
export async function applyZohoWebhookRecord(record: WebhookRecord) {
  const outcome = await withZohoPurpose(`Zoho webhook: ${record.kind === "salesorder" ? "sales order" : record.kind}`, () =>
    record.kind === "salesorder"
      ? handleZohoOrderWebhook(record.id)
      : record.kind === "invoice"
        ? handleZohoInvoiceWebhook(record)
        : handleZohoItemWebhook(record.id));
  await flushZohoCallLog();
  return outcome;
}

/**
 * Works through the Zoho webhook calls parked by the Supabase function zoho-webhook (see that function for why).
 * Run by the 15-minute job. While Zoho's daily API limit is used up, badly signed calls are still cleared but good
 * ones wait for a later run.
 */
export async function drainZohoWebhookInbox(): Promise<InboxResult> {
  const db = await dbAdmin();
  const { data: budgetRow } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
  const paused = zohoPaused(str(plainObject(budgetRow?.value)["pausedUntil"]), Date.now());
  return drainWebhookInbox({
    secrets: webhookSecrets(process.env["ZOHO_WEBHOOK_SECRET"]),
    verify: verifyZohoSignature,
    load: async (limit) => {
      const { data, error } = await db.from("zoho_webhook_inbox")
        .select("id, body, signature, content_type, query, attempts")
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    remove: async (ids) => {
      const { error } = await db.from("zoho_webhook_inbox").delete().in("id", ids);
      if (error) throw new Error(error.message);
    },
    setAttempts: async (ids, attempts) => {
      const { error } = await db.from("zoho_webhook_inbox").update({ attempts }).in("id", ids);
      if (error) throw new Error(error.message);
    },
    apply: applyZohoWebhookRecord,
    log: (event, fields) => console.info(zohoLogLine(event, fields)),
  }, { maxApplied: paused ? 0 : 25 });
}

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

/**
 * Zoho Books invoice webhook (created / edited / voided): finds the invoice's website order (its
 * sales order, or the website order number in the invoice reference) and applies that
 * sales order, which records the invoice's new state on the website at once.
 */
export async function handleZohoInvoiceWebhook(invoice: { salesOrderId: string; reference: string }) {
  let salesOrderId = invoice.salesOrderId;
  const websiteOrderNo = invoice.reference.startsWith("GB-")
    ? invoice.reference.slice(3)
    : WEBSITE_ORDER_NUMBER.test(invoice.reference.trim()) ? invoice.reference.trim() : "";
  if (!salesOrderId && websiteOrderNo) {
    const db = await dbAdmin();
    const { data } = await db.from("orders").select("zoho_salesorder_id").eq("order_no", websiteOrderNo).maybeSingle();
    salesOrderId = data?.zoho_salesorder_id ?? "";
  }
  if (!salesOrderId) return "not_grain_bazar";
  return handleZohoOrderWebhook(salesOrderId);
}

/**
 * Re-reads the order's Zoho sales order and records its invoice (issued / paid / voided / deleted)
 * on the website. Read-only towards Zoho. Called when an admin, the order's customer or one of its
 * vendors opens the order, at most once every 30 seconds per order.
 */
export const refreshZohoOrderInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderNo: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    const db = await dbAdmin();
    const { data: order } = await db.from("orders")
      .select("id,order_no,order_status,user_id,vendor_ids,zoho_salesorder_id,zoho_last_polled_at")
      .eq("order_no", data.orderNo).maybeSingle();
    if (!order?.zoho_salesorder_id) return { refreshed: false };
    const { data: roles } = await db.from("user_roles").select("role").eq("user_id", context.userId);
    const isAdmin = (roles ?? []).some((row) => row.role === "admin");
    let allowed = isAdmin || order.user_id === context.userId;
    if (!allowed && (roles ?? []).some((row) => row.role === "vendor")) {
      const { data: profile } = await db.from("profiles").select("vendor_id").eq("id", context.userId).maybeSingle();
      allowed = Boolean(profile?.vendor_id && (order.vendor_ids ?? []).includes(profile.vendor_id));
    }
    if (!allowed) throw new Error("Not allowed");
    const last = Date.parse(order.zoho_last_polled_at ?? "");
    if (Number.isFinite(last) && Date.now() - last < 30_000) return { refreshed: false };
    await db.from("orders").update({ zoho_last_polled_at: new Date().toISOString() }).eq("id", order.id);
    const { region, organizationId, token } = await zohoOrderContext(db);
    const response = await withZohoPurpose("Order page: invoice check", () => inventoryRequest<{ salesorder?: Record<string, unknown> }>(
      region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id)}`, "GET",
    ));
    const salesOrder = response.salesorder;
    if (!salesOrder) return { refreshed: false };
    // Opening the order is enough: a sales order voided in Zoho closes it here too (unless money was received here).
    const zohoStatus = str(salesOrder["order_status"] ?? salesOrder["status"]).toLowerCase();
    if (ZOHO_CLOSED_ORDER_STATES.includes(zohoStatus) && order.order_status !== "Cancelled") {
      const closed = await closeOrderVoidedInZoho(db, order, str(salesOrder["salesorder_number"]), zohoStatus);
      if (!closed.closed) await saveZohoReview(db, "order", order.id, closed.review);
      await saveZohoZohoState(db, order.id, salesOrder);
    }
    await withZohoPurpose("Order page: invoice check", () => recordZohoInvoiceState(db, order, salesOrder));
    await flushZohoCallLog();
    return { refreshed: true };
  });

/**
 * Server-only, read-only towards Zoho: what Zoho Books says about the order's invoice right now, for
 * the delivery note check. Also keeps the website's copy of the invoice up to date, as opening the
 * order does. Never throws: when Zoho cannot be read the answer says so, and the database refuses.
 */
export async function readOrderInvoiceFacts(orderNo: string): Promise<ZohoInvoiceFacts> {
  try {
    const db = await dbAdmin();
    const { data: order, error } = await db.from("orders").select("id,order_no,order_status,zoho_salesorder_id").eq("order_no", orderNo).maybeSingle();
    if (error) throw new Error("Could not read the order");
    if (!order?.zoho_salesorder_id) return { read: true, live_invoices: 0 };
    const salesOrderId = order.zoho_salesorder_id;
    const { data: budget } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
    if (zohoPaused(str(plainObject(budget?.value)["pausedUntil"]), Date.now())) throw new Error("Zoho's daily API limit was reached; calls resume automatically within the hour");
    const { region, organizationId, token } = await zohoOrderContext(db);
    return await withZohoPurpose("Delivery note: payment check", async () => {
      const response = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}`, "GET");
      if (!response.salesorder) throw new Error("Zoho returned no sales order");
      const listed = zohoInvoicesOf(response.salesorder);
      if (!listed) throw new Error("Zoho's sales order did not list its invoices");
      await recordZohoInvoiceState(db, order, response.salesorder);
      const live = listed.filter((invoice) => invoice.status !== "void");
      if (live.length !== 1) return zohoInvoiceFacts(listed, null);
      const books = await booksRequest<{ invoice?: Record<string, unknown> }>(region, organizationId, token, `invoices/${encodeURIComponent(live[0]!.invoiceId)}`, "GET");
      return zohoInvoiceFacts(listed, books.invoice ?? null);
    });
  } catch (cause) {
    return { read: false, error: cause instanceof Error ? cause.message.slice(0, 280) : "Zoho could not be read" };
  } finally {
    await flushZohoCallLog();
  }
}

/** Pushes products to Zoho now and settles their queued catalog jobs. */
async function syncCatalogProductsDirect(db: Awaited<ReturnType<typeof dbAdmin>>, productIds: string[]) {
  const { region, organizationId, token } = await zohoOrderContext(db);
  const runCtx = newZohoRunContext();
  const outcome = { pushed: 0, review: 0 };
  for (const productId of [...new Set(productIds)].slice(0, 20)) {
    const settle = (status: "complete" | "failed" | "needs_review", message: string | null) => db.from("zoho_sync_outbox")
      .update({ status, last_error: message, updated_at: new Date().toISOString() })
      .eq("entity_type", "catalog").eq("entity_id", productId).in("status", ["pending", "failed"]);
    try {
      await syncZohoCatalogItem(db, region, organizationId, token, productId, runCtx);
      await settle("complete", null);
      outcome.pushed += 1;
    } catch (cause) {
      const message = (cause instanceof Error ? cause.message : "Zoho rejected the product").slice(0, 900);
      // A transient failure stays queued for the next sync run instead of waiting for a person.
      await settle(cause instanceof NeedsReviewError ? "needs_review" : "failed", message);
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
  const { region, organizationId, token } = await zohoOrderContext(db);
  const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
    region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "GET",
  );
  if (!response.item) return link ? "missing" : "not_grain_bazar";
  if (!link) return importNewZohoItem(db, response.item);
  return applyZohoItemChange(db, link as ZohoItemLink, response.item, { region, organizationId, token });
}

/**
 * A new Zoho item becomes a hidden website product, linked so its later edits and stock come in too.
 * `onRequest`: an admin asked for this item by hand, so it may be older than the date new items come in from.
 */
async function importNewZohoItem(db: Awaited<ReturnType<typeof dbAdmin>>, item: Record<string, unknown>, options: { onRequest?: boolean } = {}) {
  if (options.onRequest ? zohoItemSaleProblem(item) !== null : !zohoItemImportable(item)) return "not_grain_bazar" as const;
  const [vendorId] = await zohoItemSyncVendorIds(db);
  if (!vendorId) return "not_grain_bazar" as const;
  const { data: sibling } = await db.from("catalog_products").select("payload").eq("vendor_id", vendorId).limit(1).maybeSingle();
  const row = zohoItemAsHiddenProduct(item, vendorId, str(plainObject(sibling?.payload)["vendor"]));
  // Two products with one SKU would push different stock to one Zoho item. A person has to sort that out.
  const { data: sameSku } = await db.from("catalog_products").select("id,vendor_id").eq("payload->>sku", row.payload.sku);
  if ((sameSku ?? []).some((other) => !other.vendor_id.startsWith("zoho:"))) {
    console.warn(zohoLogLine("zoho_item_import_skipped", { zohoId: str(item["item_id"]), reason: "SKU already on a website product" }));
    return "sku_in_use" as const;
  }
  const now = new Date().toISOString();
  const { data: created, error } = await db.rpc("import_zoho_catalog_item", {
    _id: row.id,
    _vendor_id: row.vendor_id,
    _category: row.category,
    _payload: row.payload as Json,
    _zoho_item_id: str(item["item_id"]),
    _zoho_modified_at: str(item["last_modified_time"]) || now,
    _fingerprint: await catalogFingerprint({ ...row, payload: row.payload as Json, created_at: now, updated_at: now } as CatalogProduct),
  });
  if (error) throw new Error("Could not bring the new Zoho item into Grain Bazar");
  if (!created) return "not_grain_bazar" as const;
  console.info(zohoLogLine("zoho_item_imported_hidden", { zohoId: str(item["item_id"]), productId: row.id }));
  return "imported_hidden" as const;
}

/** Every Zoho item (up to 1,000), one call per 200. */
async function allZohoItems(region: Region, organizationId: string, token: string) {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await inventoryRequest<{ items?: Record<string, unknown>[] }>(
      region, organizationId, token, "items", "GET", undefined, { page: String(page), per_page: "200" },
    );
    rows.push(...(result.items ?? []));
    if ((result.items ?? []).length < 200) break;
  }
  return rows;
}

/**
 * Admin → Products: Zoho items that have no website product, such as ones made in Zoho before new items
 * came in by themselves. Read only when the admin opens the list (one Zoho call per 200 items).
 */
export const listZohoItemsNotOnWebsite = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const [items, { data: links, error: linkError }, { data: products, error: productError }] = await Promise.all([
      allZohoItems(region, organizationId, token),
      db.from("zoho_item_links").select("zoho_item_id"),
      db.from("catalog_products").select("vendor_id,payload"),
    ]);
    if (linkError || productError) throw new Error("Could not read the website's products");
    const skus = new Set((products ?? []).filter((row) => !row.vendor_id.startsWith("zoho:"))
      .map((row) => str(plainObject(row.payload)["sku"]).trim().toLowerCase()).filter(Boolean));
    return zohoItemsNotOnWebsite(items, new Set((links ?? []).map((link) => link.zoho_item_id)), skus);
  });

/**
 * Admin → Products: brings one Zoho item onto the website the same way a new item comes in: a hidden
 * product waiting for approval, linked to the Zoho item. Nothing is sent to Zoho; the product goes on the
 * shop only when an admin switches it on.
 */
export const bringZohoItemOntoWebsite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ itemId: z.string().trim().regex(/^\d{6,25}$/) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: link } = await db.from("zoho_item_links").select("product_id").eq("zoho_item_id", data.itemId).maybeSingle();
    if (link) throw new Error("This Zoho item is already on the website");
    const { region, organizationId, token } = await zohoOrderContext(db);
    const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(data.itemId)}`, "GET",
    );
    if (!response.item) throw new Error("Zoho has no item with this number");
    const problem = zohoItemSaleProblem(response.item);
    if (problem) throw new Error(problem);
    const result = await importNewZohoItem(db, response.item, { onRequest: true });
    console.info(zohoLogLine("zoho_item_brought_in_by_admin", { zohoId: data.itemId, result, by: context.userId }));
    if (result === "sku_in_use") throw new Error("A website product already uses this item's SKU, so it can't come in twice");
    if (result !== "imported_hidden") throw new Error("It could not come in: it is already on the website, or it was deleted there");
    return { productId: `ZI-${data.itemId}`, name: str(response.item["name"]) };
  });

/** Catch-up for new Zoho items: an edit in Zoho Commerce, for one, doesn't reach the webhook. */
async function importNewZohoItems(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string) {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await inventoryRequest<{ items?: Record<string, unknown>[] }>(
      region, organizationId, token, "items", "GET", undefined, { page: String(page), per_page: "200" },
    );
    rows.push(...(result.items ?? []));
    if ((result.items ?? []).length < 200) break;
  }
  const fresh = rows.filter(zohoItemImportable);
  const summary = { found: fresh.length, imported: 0, failed: 0 };
  if (!fresh.length) return summary;
  const { data: links } = await db.from("zoho_item_links").select("zoho_item_id").in("zoho_item_id", fresh.map((row) => str(row["item_id"])));
  const linked = new Set((links ?? []).map((link) => link.zoho_item_id));
  for (const row of fresh.filter((candidate) => !linked.has(str(candidate["item_id"]))).slice(0, 20)) {
    try {
      const full = await inventoryRequest<{ item?: Record<string, unknown> }>(
        region, organizationId, token, `items/${encodeURIComponent(str(row["item_id"]))}`, "GET",
      );
      if (full.item && await importNewZohoItem(db, full.item) === "imported_hidden") summary.imported += 1;
    } catch (cause) {
      summary.failed += 1;
      console.warn(`Could not bring in Zoho item ${str(row["item_id"])}:`, cause);
    }
  }
  return summary;
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
        if (!(await zohoCommerceInUse(db))) return { found: false, skipped: ZOHO_COMMERCE_OFF_MESSAGE };
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
    // Without Zoho Commerce its webhooks are gone: the admin page then shows the address for a Workflow Rule.
    if (!(await zohoCommerceInUse(db))) throw new Error(`${ZOHO_COMMERCE_OFF_MESSAGE}. Add the webhook address to a Zoho Inventory Workflow Rule instead.`);
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

/**
 * Admin: removes one recorded payment from an order. If it was posted to Zoho Books it comes out of Zoho first (scope
 * ZohoBooks.customerpayments.DELETE, after Reauthorize Zoho); if Zoho will not, the admin deletes it there and presses again.
 * The database then corrects the order and keeps a copy (admin_delete_payment).
 */
export const deleteOrderPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ paymentId: z.string().uuid(), reason: z.string().trim().min(4).max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: payment } = await db.from("payments").select("id,order_id,zoho_payment_id,zoho_invoice_id,txn_ref").eq("id", data.paymentId).maybeSingle();
    if (!payment) throw new Error("This payment no longer exists.");
    const { data: blocker, error: blockerError } = await context.supabase.rpc("payment_delete_blocker", { _payment_id: data.paymentId });
    if (blockerError) throw new Error(blockerError.message);
    if (blocker) throw new Error(blocker);
    if (payment.zoho_payment_id || payment.zoho_invoice_id) {
      const { region, organizationId, token } = await zohoOrderContext(db);
      const stillInZoho = async () => {
        if (!payment.zoho_invoice_id) return Boolean(payment.zoho_payment_id);
        const listed = await booksRequest<{ payments?: { payment_id?: string; reference_number?: string }[] }>(region, organizationId, token, `invoices/${encodeURIComponent(payment.zoho_invoice_id)}/payments`, "GET");
        return (listed.payments ?? []).some((row) => (payment.zoho_payment_id && str(row.payment_id) === payment.zoho_payment_id) || (payment.txn_ref && str(row.reference_number) === payment.txn_ref));
      };
      if (payment.zoho_payment_id) {
        try {
          await booksRequest(region, organizationId, token, `customerpayments/${encodeURIComponent(payment.zoho_payment_id)}`, "DELETE");
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "Zoho refused";
          if (await stillInZoho()) throw new Error(`Zoho Books would not remove this payment: ${message}${zohoPermissionHint(message)} You can delete it in Zoho Books yourself, then press Remove again.`);
        }
      } else if (await stillInZoho()) {
        throw new Error("Zoho Books holds this payment. Delete it in Zoho Books, then press Remove again.");
      }
      const { error: clearError } = await db.from("payments").update({ zoho_payment_id: null, zoho_invoice_id: null, zoho_pushed_at: null }).eq("id", payment.id);
      if (clearError) throw new Error("Could not update the payment record");
    }
    const { data: result, error } = await context.supabase.rpc("admin_delete_payment", { _payment_id: data.paymentId, _reason: data.reason });
    if (error) throw new Error(error.message);
    if (payment.order_id) await db.rpc("enqueue_zoho_sync", { _entity_type: "order", _entity_id: payment.order_id });
    return result as { order_no: string; paid: number; balance: number };
  });

/** The organisation's active Zoho Books bank and cash accounts (scope ZohoBooks.banking.READ). */
async function zohoDepositAccounts(region: Region, organizationId: string, token: string): Promise<ZohoDepositAccountOption[]> {
  const result = await booksRequest<{ bankaccounts?: unknown[] }>(region, organizationId, token, "bankaccounts?filter_by=Status.Active&per_page=200", "GET");
  return zohoDepositAccountOptions(result.bankaccounts ?? []);
}

/**
 * Admin: which Zoho account each godown's website payments are deposited to, and the accounts to choose from.
 * Zoho's list is read only when asked for. If Zoho refuses (e.g. not yet reauthorized for banking), the saved
 * choices still come back, with the reason.
 */
export const listZohoDepositAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const chosen = await readDepositAccounts(db);
    try {
      const { region, organizationId, token } = await zohoOrderContext(db);
      return { chosen, accounts: await zohoDepositAccounts(region, organizationId, token), problem: null as string | null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Zoho refused the list of bank accounts";
      return { chosen, accounts: null as ZohoDepositAccountOption[] | null, problem: `${message}${zohoPermissionHint(message)}` };
    }
  });

/**
 * Admin: choose the Zoho bank or cash account a godown's website payments are deposited to ("" = none:
 * Zoho's Undeposited Funds). The account must be one of Zoho's active bank or cash accounts right now;
 * its name is Zoho's. Only payments posted from now on use it.
 */
export const saveGodownDepositAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40), accountId: z.string().trim().regex(/^\d{0,30}$/) }))
  .handler(async ({ context, data }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: branch, error: branchError } = await db.from("branches").select("id,name,vendor_id").eq("id", data.branchId).maybeSingle();
    if (branchError) throw new Error("Could not read the godown");
    if (!branch || branch.vendor_id) throw new Error("That godown was not found");
    let account: DepositAccount | null = null;
    if (data.accountId) {
      const { region, organizationId, token } = await zohoOrderContext(db);
      let options: ZohoDepositAccountOption[];
      try {
        options = await zohoDepositAccounts(region, organizationId, token);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Zoho refused the list of bank accounts";
        throw new Error(`${message}${zohoPermissionHint(message)}`);
      }
      const option = options.find((item) => item.id === data.accountId);
      if (!option) throw new Error("That account is not an active bank or cash account in Zoho Books. Reload the list and choose again.");
      account = { accountId: option.id, accountName: option.name, setAt: new Date().toISOString(), setBy: context.userId };
    }
    const current = await readDepositAccounts(db);
    const { error } = await db.from("settings").upsert(
      { key: DEPOSIT_ACCOUNTS_KEY, value: withDepositAccount(current, branch.id, account) as unknown as Json, is_public: false, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
    if (error) throw new Error("Could not save the godown's deposit account");
    console.info(zohoLogLine("godown_deposit_account_set", { godown: branch.id, account: account ? "chosen" : "undeposited_funds" }));
    return { chosen: depositAccountFor(withDepositAccount(current, branch.id, account).godowns, branch.id) };
  });

/**
 * The Zoho sales orders for one website order: newer ones carry the website order number in
 * Reference# (their own number comes from the godown's Zoho series), older ones are GB-<order no>.
 */
async function findZohoSalesOrdersForOrder(region: Region, organizationId: string, token: string, orderNo: string) {
  const result = await inventoryRequest<{ salesorders?: Record<string, unknown>[] }>(
    region, organizationId, token, "salesorders", "GET", undefined,
    { search_text: orderNo, per_page: "200" },
  );
  return (result.salesorders ?? []).filter((row) =>
    zohoOrderIsFor({ salesorder_number: str(row["salesorder_number"]), reference_number: str(row["reference_number"]) }, orderNo));
}

/**
 * Inventory and Commerce share one organization; a pushed order must also be listed in Commerce > Orders.
 * Once Zoho Commerce is off there is no Commerce > Orders to check: the Inventory sales order is the order.
 */
async function assertVisibleInZohoCommerce(region: Region, organizationId: string, token: string, salesOrderId: string, salesOrderNumber: string) {
  if (!(await zohoCommerceInUse())) return;
  try {
    await commerceRequest(region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}`, "GET");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown error";
    throw new NeedsReviewError(`Sales order ${salesOrderNumber} was created in Zoho Inventory (ID ${salesOrderId}) but Zoho Commerce did not return it: ${message}.${zohoPermissionHint(message)}`);
  }
}

/** Records a sales order found in Zoho by its Reference# (or older GB- number) on the site order, then syncs it. */
async function linkAndSyncZohoOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  order: Database["public"]["Tables"]["orders"]["Row"],
  items: GrainBazarOrderItem[],
  salesOrderId: string,
) {
  const { error } = await db.from("orders").update({ zoho_salesorder_id: salesOrderId }).eq("id", order.id).is("zoho_salesorder_id", null);
  if (error) throw new Error("Existing Zoho order found but its ID could not be recorded");
  await syncLinkedZohoOrder(db, region, organizationId, token, { ...order, zoho_salesorder_id: salesOrderId }, items, { newlyFound: true });
}

async function syncZohoOrder(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string, job: ZohoSyncJob) {
  const orderId = job.entity_id;
  const [{ data: order, error: orderError }, { data: items, error: itemsError }] = await Promise.all([
    db.from("orders").select("*").eq("id", orderId).maybeSingle(),
    db.from("order_items").select("id,product_id,product_name,sku,qty,unit_price,gst_rate,line_total,coupon_share").eq("order_id", orderId),
  ]);
  if (orderError || itemsError) throw new Error("Could not read the order and items from Grain Bazar");
  if (!order) return;
  // An unpaid checkout (or one whose payment time ran out) is not an order: Zoho never sees it.
  if (["Awaiting Payment", "Payment Expired"].includes(order.order_status)) return;
  if (order.zoho_salesorder_id) {
    await syncLinkedZohoOrder(db, region, organizationId, token, order, items ?? []);
    return;
  }
  // Cancelled before it ever reached Zoho: never create an open sales order that would commit
  // stock the site has already given back. If an earlier push did reach Zoho, link and void it.
  if (order.order_status === "Cancelled") {
    const matches = await findZohoSalesOrdersForOrder(region, organizationId, token, order.order_no);
    if (matches.length > 1) throw new NeedsReviewError(`More than one Zoho sales order is for ${order.order_no}`);
    if (matches.length === 1) await linkAndSyncZohoOrder(db, region, organizationId, token, order, items ?? [], str(matches[0]!["salesorder_id"]));
    else refuseIfCreateUnanswered(order.order_no, true);
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
        contact_name: order.business_legal_name?.trim() || order.customer_name?.trim() || orderEmail,
        contact_persons: [{
          ...splitContactName(order.customer_name || "Customer"),
          email: orderEmail,
          phone: order.customer_phone ?? "",
          mobile: order.customer_phone ?? "",
          is_primary_contact: true,
        }],
        notes: directNotes.join(" | "),
        ...(order.business_legal_name ? { company_name: order.business_legal_name } : {}),
        ...zohoGstFields(order.customer_gstin, "contact", order.business_legal_name),
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
  // A previous request may have reached Zoho even if the response was lost. The queue's attempt
  // count can't tell: a direct push doesn't add to it, an admin's Retry resets it and an order change
  // adds a new row. So every push searches Zoho first for a sales order with this website order number.
  const matches = await findZohoSalesOrdersForOrder(region, organizationId, token, order.order_no);
  if (matches.length > 1) throw new NeedsReviewError(`More than one Zoho sales order is for ${order.order_no}`);
  if (matches.length === 1) {
    // Bring the found sales order up to date too (status, lines), not just link it.
    await linkAndSyncZohoOrder(db, region, organizationId, token, order, items, str(matches[0]!["salesorder_id"]));
    return;
  }
  refuseIfCreateUnanswered(order.order_no);
  const orderGstInfo = cleanAndValidateGstin(order.customer_gstin);
  const notesParts = [
    `Grain Bazar order ${order.order_no}; payment ${order.payment_status}; app total ₹${Number(order.total).toFixed(2)}. Verify tax treatment and total in Zoho before invoicing.`,
  ];
  if (orderGstInfo.note) notesParts.push(orderGstInfo.note);
  if (order.business_legal_name && !orderGstInfo.isValid) {
    notesParts.push(`Business buyer (unregistered, no GSTIN): ${order.business_legal_name}.`);
  }
  if (orderGstInfo.isValid) {
    // Business (B2B) purchase: say who the buyer is and whether the invoice can go to the IRP as is.
    const billing = typeof order.shipping_address === "object" && order.shipping_address !== null ? order.shipping_address as Record<string, unknown> : {};
    const problems = einvoiceProblems({
      gstin: order.customer_gstin,
      legalName: order.business_legal_name,
      address: { line: str(billing["line"]), city: str(billing["city"]), state: str(billing["state"]), pin: str(billing["pin"]) },
      lines: lineItems.map((line) => ({ name: str((line as Record<string, unknown>)["name"]) || str((line as Record<string, unknown>)["description"]), hsn: str((line as Record<string, unknown>)["hsn_or_sac"]) })),
    });
    notesParts.push(`B2B buyer: ${order.business_legal_name || order.customer_name} · GSTIN ${orderGstInfo.gstin}.`);
    notesParts.push(problems.length ? `E-invoice (IRP) check: fix before pushing to IRP: ${problems.join("; ")}.` : "E-invoice (IRP) check: ready.");
    console.info(zohoLogLine("einvoice_readiness", { order: order.order_no, ready: problems.length === 0, problems: problems.join("; ") }));
  }

  // Pickup orders are created under the godown's Zoho location, so stock leaves that warehouse.
  const locationId = await zohoLocationForOrder(db, order.shipping_address, (order as { branch_id?: string | null }).branch_id);
  // The godown's channel partner is the order's salesperson in Zoho ("Sales by Salesperson").
  const branchId = (order as { branch_id?: string | null }).branch_id;
  const { data: partner } = branchId
    ? await db.from("channel_partners").select("name").eq("branch_id", branchId).eq("status", "active").maybeSingle()
    : { data: null };
  // Without one Zoho takes the contact's place of supply. Delivered goods are supplied where they
  // are delivered (as on the website invoice); a GSTIN's own state, from zohoGstFields below, wins.
  const deliveryPlace = /^pickup/i.test(str(order.shipping_method))
    ? undefined
    : ZOHO_PLACE_CODES[gstStateCodeOf(str(plainObject(order.shipping_address)["state"])) ?? ""];
  const payload: Record<string, unknown> = {
    ...(deliveryPlace ? { place_of_supply: deliveryPlace } : {}),
    ...(locationId ? { location_id: locationId } : {}),
    ...(partner?.name ? { salesperson_name: partner.name } : {}),
    // No salesorder_number: Zoho numbers the order in the godown location's own transaction series
    // (Settings > Transaction Number Series). The website order number goes in Reference#.
    reference_number: String(order.order_no).slice(0, 100),
    customer_id: customerId,
    date: datePart(order.created_at, new Date().toISOString().slice(0, 10)),
    line_items: locationId ? lineItems.map((line) => ({ ...line, location_id: locationId })) : lineItems,
    ...zohoDiscountFields(order.discount, items),
    shipping_charge: Number(order.shipping) || 0,
    // Prices include GST on orders from 7 Nov 2026: Zoho takes the rate as GST-inclusive, so its total is the price paid.
    is_inclusive_tax: Boolean(order.prices_include_gst),
    notes: notesParts.join(" "),
    ...zohoGstFields(order.customer_gstin, "order", order.business_legal_name),
  };
  const created = await sendZohoOrderCreate(() => createSalesOrderWithChannel(region, organizationId, token, payload, order.order_no));
  const safeNumber = str(created.salesorder?.["salesorder_number"]) || order.order_no;
  const salesOrderId = str(created.salesorder?.["salesorder_id"]);
  if (!salesOrderId) throw new Error("Zoho created a sales order but returned no salesorder_id");
  const { data: savedRows, error: saveError } = await db.from("orders").update({ zoho_salesorder_id: salesOrderId }).eq("id", order.id).is("zoho_salesorder_id", null).select("id");
  if (saveError) throw new Error("Zoho sales order created, but its ID could not be stored; the retry finds it by its Reference#");
  if (!savedRows?.length) {
    // Another push linked a sales order first. If it is a different one, this one is a duplicate: never invoice it.
    const { data: linked } = await db.from("orders").select("zoho_salesorder_id").eq("id", order.id).maybeSingle();
    if (linked?.zoho_salesorder_id && linked.zoho_salesorder_id !== salesOrderId) {
      throw new NeedsReviewError(`Two Zoho sales orders exist for ${order.order_no}: ${linked.zoho_salesorder_id} is linked and ${safeNumber} is a duplicate. Delete the duplicate in Zoho.`);
    }
  }
  await saveZohoZohoState(db, order.id, created.salesorder ?? {});
  // Before the email, which shows the address.
  const orderAddress = zohoOrderAddress(order.shipping_address);
  const addressWrite = await writeZohoOrderAddress(region, organizationId, token, order, salesOrderId, safeNumber,
    orderAddress ? zohoAddressesToUpdate(created.salesorder ?? {}, orderAddress) : []);
  // Official Zoho notification: Zoho Books "Email a sales order" (Books workflow email alerts do
  // not fire for orders created through the API). Never blocks or fails the order sync.
  try {
    const outcome = await emailNewZohoOrder(db, region, organizationId, token, salesOrderId, {
      number: safeNumber,
      customer: order.customer_name ?? "",
      total: Number(created.salesorder?.["total"] ?? order.total) || 0,
      delivery: str(order.shipping_method),
    });
    if (outcome === "sent") console.info(zohoLogLine("order_email_sent", { order: safeNumber, zohoId: salesOrderId }));
  } catch (cause) {
    console.warn(zohoLogLine("order_email_failed", { order: safeNumber, zohoId: salesOrderId, error: cause instanceof Error ? cause.message : "unknown" }));
  }
  await assertVisibleInZohoCommerce(region, organizationId, token, salesOrderId, safeNumber);
  const zohoTotal = Number(created.salesorder?.["total"]);
  if (Number.isFinite(zohoTotal) && Math.abs(zohoTotal - Number(order.total)) > 2.00)
    throw new NeedsReviewError(`Zoho accepted order ${safeNumber}, but total ₹${zohoTotal.toFixed(2)} differs from Grain Bazar ₹${Number(order.total).toFixed(2)}. Review taxes, discount, and shipping before processing.`);
  // Already paid when it reached Zoho (confirmed by the bank alert or an admin): confirm it, invoice it and
  // record the payment now, or they wait until someone next moves the order.
  if (!["Placed", "Awaiting Payment"].includes(order.order_status)) {
    await syncLinkedZohoOrder(db, region, organizationId, token, { ...order, zoho_salesorder_id: salesOrderId }, items, { addressProblem: addressWrite.problem });
  } else if (addressWrite.problem) {
    throw new Error(addressWrite.problem);
  }
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
async function createSalesOrderWithChannel(region: Region, organizationId: string, token: string, payload: Record<string, unknown>, orderNo: string) {
  if (!payload["salesperson_name"]) return createSalesOrderWithPlace(region, organizationId, token, payload, orderNo);
  try {
    return await createSalesOrderWithPlace(region, organizationId, token, payload, orderNo);
  } catch (cause) {
    // A salesperson Zoho will not take never blocks the order: create it without one.
    if (!/sales ?person/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
    console.warn(zohoLogLine("zoho_salesperson_skipped", { error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown" }));
    const { salesperson_name: _skipped, ...withoutSalesperson } = payload;
    return createSalesOrderWithPlace(region, organizationId, token, withoutSalesperson, orderNo);
  }
}

/** A delivery place Zoho will not take never blocks the order: it then uses the contact's. A GSTIN's place stays required. */
async function createSalesOrderWithPlace(region: Region, organizationId: string, token: string, payload: Record<string, unknown>, orderNo: string) {
  if (!payload["place_of_supply"] || payload["gst_treatment"] === "business_gst") return createSalesOrderNumbered(region, organizationId, token, payload, orderNo);
  try {
    return await createSalesOrderNumbered(region, organizationId, token, payload, orderNo);
  } catch (cause) {
    if (!/place.?of.?supply/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
    console.warn(zohoLogLine("zoho_delivery_place_skipped", { order: orderNo, error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown" }));
    const { place_of_supply: _skipped, ...withoutPlace } = payload;
    return createSalesOrderNumbered(region, organizationId, token, withoutPlace, orderNo);
  }
}

/**
 * Zoho numbers the order itself, in the godown location's transaction series. Only if the
 * organization has sales-order auto-numbering switched off does it get the website order number.
 */
async function createSalesOrderNumbered(region: Region, organizationId: string, token: string, payload: Record<string, unknown>, orderNo: string) {
  try {
    return await createSalesOrderWithChannelField(region, organizationId, token, payload, {});
  } catch (cause) {
    if (!/number/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
    console.warn(zohoLogLine("zoho_order_own_number", { order: orderNo }));
    return createSalesOrderWithChannelField(region, organizationId, token,
      { ...payload, salesorder_number: orderNo.slice(0, 50) }, { ignore_auto_number_generation: "true" });
  }
}

async function createSalesOrderWithChannelField(region: Region, organizationId: string, token: string, payload: Record<string, unknown>, query: Record<string, string>) {
  try {
    return await inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, "salesorders", "POST",
      { ...payload, custom_fields: channelCustomFields }, query);
  } catch (cause) {
    if (!isCustomFieldError(cause)) throw cause;
    console.warn(`Zoho has no "${ZOHO_CHANNEL_FIELD}" sales order field yet; order created without the channel mark.`);
    return inventoryRequest<{ salesorder?: Record<string, unknown> }>(region, organizationId, token, "salesorders", "POST",
      payload, query);
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

/**
 * The customer and vendor numbers kept now, by "user id:contact type"; null when they cannot be read (before the 12 Nov
 * 2026 migration the column is not there), and then the hourly check writes none.
 */
async function keptZohoContactNumbers(db: Awaited<ReturnType<typeof dbAdmin>>, userIds: string[]) {
  if (!userIds.length) return null;
  const { data, error } = await db.from("zoho_contact_links").select("user_id,contact_type,zoho_contact_number").in("user_id", [...new Set(userIds)]);
  if (error) return null;
  return new Map(((data ?? []) as { user_id: string; contact_type: string; zoho_contact_number: string | null }[])
    .map((row) => [`${row.user_id}:${row.contact_type}`, cleanContactNumber(row.zoho_contact_number)]));
}

/**
 * Admin > Zoho Commerce: "Fetch customer and vendor numbers from Zoho". Asks Zoho for the next linked contacts (those
 * never asked first, then the ones asked longest ago), CONTACT_NUMBER_BATCH per press, three at a time, one GET each,
 * all in the Zoho call log. Holds off while Zoho's daily-limit pause is on, and starts it if Zoho says the limit is
 * reached. Nothing is written to Zoho. A contact Zoho can't read is marked asked too, so it never holds up the rest.
 */
export const fetchZohoContactNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ContactNumberFetch> => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: budgetRow } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
    const pausedUntil = str(plainObject(budgetRow?.value)["pausedUntil"]);
    if (zohoPaused(pausedUntil, Date.now())) return { ...EMPTY_CONTACT_NUMBER_FETCH, failed: [], pausedUntil };
    const { data: links, error } = await db.from("zoho_contact_links")
      .select("user_id,contact_type,zoho_contact_id,zoho_contact_number_checked_at")
      .order("zoho_contact_number_checked_at", { ascending: true, nullsFirst: true })
      .order("updated_at", { ascending: true })
      .limit(CONTACT_NUMBER_BATCH);
    if (error) {
      if (missingContactNumberColumn(error)) return { ...EMPTY_CONTACT_NUMBER_FETCH, failed: [], needsMigration: true };
      throw new Error("Could not read the Zoho contact links");
    }
    const result: ContactNumberFetch = { ...EMPTY_CONTACT_NUMBER_FETCH, failed: [] };
    const batch = (links ?? []) as { user_id: string; contact_type: "customer" | "vendor"; zoho_contact_id: string }[];
    if (batch.length) {
      const { region, organizationId, token } = await zohoOrderContext(db);
      zohoDailyLimitHit = false;
      try {
        await withZohoPurpose("Admin: customer and vendor numbers", () => runPool(batch, 3, async (link) => {
          // The limit was reached: the rest wait for the next press after the pause.
          if (zohoDailyLimitHit) return;
          const checkedAt = new Date().toISOString();
          try {
            const response = await inventoryRequest<{ contact?: Record<string, unknown> }>(
              region, organizationId, token, `contacts/${encodeURIComponent(link.zoho_contact_id)}`, "GET",
            );
            if (!response.contact) throw new Error("Zoho contact response did not include a contact");
            const number = zohoContactNumberOf(response.contact);
            const { error: saveError } = await db.from("zoho_contact_links").update(contactNumberUpdate(number, checkedAt))
              .eq("user_id", link.user_id).eq("contact_type", link.contact_type);
            if (saveError) throw new Error("The number could not be saved");
            result.read += 1;
            if (number === undefined) result.notSaid += 1;
            else if (number) result.found += 1;
            else result.empty += 1;
          } catch {
            if (zohoDailyLimitHit) return;
            result.failed.push(link.zoho_contact_id);
            await db.from("zoho_contact_links").update({ zoho_contact_number_checked_at: checkedAt })
              .eq("user_id", link.user_id).eq("contact_type", link.contact_type);
          }
        }));
      } finally {
        await flushZohoCallLog();
        if (zohoDailyLimitHit) await pauseZohoForDailyLimit(db);
      }
      if (zohoDailyLimitHit) {
        const { data: paused } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
        result.pausedUntil = str(plainObject(paused?.value)["pausedUntil"]) || new Date().toISOString();
      }
    }
    const [linked, numbered, notAsked] = await Promise.all([
      db.from("zoho_contact_links").select("user_id", { count: "exact", head: true }),
      db.from("zoho_contact_links").select("user_id", { count: "exact", head: true }).not("zoho_contact_number", "is", null),
      db.from("zoho_contact_links").select("user_id", { count: "exact", head: true }).is("zoho_contact_number_checked_at", null),
    ]);
    return { ...result, linked: linked.count ?? 0, numbered: numbered.count ?? 0, remaining: notAsked.count ?? 0 };
  });

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
  const keptNumbers = await keptZohoContactNumbers(db, ((links ?? []) as ZohoContactLink[]).map((link) => link.user_id));
  for (const link of (links ?? []) as ZohoContactLink[]) {
    result.checked += 1;
    let newestZohoModified = link.last_zoho_modified_at;
    try {
      const response = await inventoryRequest<{ contact?: Record<string, unknown> }>(
        region, organizationId, token, `contacts/${encodeURIComponent(link.zoho_contact_id)}`, "GET",
      );
      const contact = response.contact;
      if (!contact) throw new Error("Zoho contact response did not include a contact");
      // The customer or vendor number comes with every check, at no extra call; written only when it changed.
      const number = zohoContactNumberOf(contact);
      if (keptNumbers && number !== undefined && keptNumbers.get(`${link.user_id}:${link.contact_type}`) !== number) {
        await saveZohoContactNumber(db, link.user_id, link.contact_type, number);
      }
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
    .select("id,order_no,order_status,zoho_salesorder_id,zoho_last_polled_at")
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
      const incomingStatus = zohoFulfillmentStatus(zohoOrder);
      if (incomingStatus && zohoStatusMovesForward(order.order_status, incomingStatus)) {
        const { error: applyError } = await db.rpc("apply_zoho_order_fulfillment", { _order_id: order.id, _status: incomingStatus });
        if (applyError) throw new Error("Zoho fulfillment status could not be applied to Grain Bazar");
        result.updated += 1;
      }
      await recordZohoInvoiceState(db, order, zohoOrder);
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

/** Sellers whose products sync with Zoho items (Shami's own); empty = every seller. */
async function zohoItemSyncVendorIds(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data } = await db.from("settings").select("value").eq("key", "zoho_item_sync_vendor_ids").maybeSingle();
  return parseZohoItemSyncVendorIds(data?.value);
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
  // Zoho's daily API budget is used up: pause (an hour) instead of failing call after call.
  const { data: budgetRow } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
  const budget = plainObject(budgetRow?.value);
  if (zohoPaused(str(budget["pausedUntil"]), Date.now()))
    return { enabled: true, processed: 0, complete: 0, failed: 0, needsReview: 0, deferred: 0, paused: true, pausedUntil: str(budget["pausedUntil"]), reason: "Zoho's daily API limit was reached; the sync resumes automatically." };
  zohoDailyLimitHit = false;
  try {
    return await processZohoSyncOutboxRun(db, limit, options, budget);
  } finally {
    await flushZohoCallLog();
    if (zohoDailyLimitHit) await pauseZohoForDailyLimit(db);
  }
}

const ZOHO_API_BUDGET_SETTING = "zoho_api_budget";

/** Zoho's daily budget is used up: everything that checks the pause holds off for an hour. */
async function pauseZohoForDailyLimit(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data } = await db.from("settings").select("value").eq("key", ZOHO_API_BUDGET_SETTING).maybeSingle();
  const pausedUntil = new Date(Date.now() + DAILY_LIMIT_PAUSE_MINUTES * 60_000).toISOString();
  await db.from("settings").upsert({ key: ZOHO_API_BUDGET_SETTING, value: { ...plainObject(data?.value), pausedUntil } as Json, is_public: false, updated_at: new Date().toISOString() });
  console.warn(zohoLogLine("zoho_daily_limit_pause", { pausedUntil }));
}

async function processZohoSyncOutboxRun(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  limit: number,
  options: { force?: boolean; inbound?: boolean } | undefined,
  budget: Record<string, unknown>,
) {
  const writeEnabled = options?.force || (await isZohoWriteSyncActive(db));
  if (!writeEnabled) return { enabled: false, processed: 0, complete: 0, failed: 0, needsReview: 0, deferred: 0 };
  const { data: connection, error: connectionError } = await db.from("zoho_commerce_connection").select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag").eq("id", true).maybeSingle();
  if (connectionError || !connection) throw new Error("Connect and authorize Zoho Inventory before enabling outbound sync");
  const region = connection.region as Region;
  const token = await accessToken(region, await decrypt(connection));
  const { data: jobs, error: claimError } = await db.rpc("claim_zoho_sync_jobs", { _limit: limit });
  if (claimError) throw new Error("Could not claim Zoho sync jobs; apply the outbound sync migration");
  const summary = { enabled: true, processed: (jobs ?? []).length, complete: 0, failed: 0, needsReview: 0, deferred: 0 };
  const ctx = newZohoRunContext();
  const runJob = async (job: ZohoSyncJob) => {
    let status: "complete" | "failed" | "needs_review" = "complete";
    let errorMessage: string | null = null;
    const startedAt = Date.now();
    try {
      if (job.entity_type === "customer")
        await withZohoPurpose("Website → Zoho: customer", () => syncZohoCustomer(db, region, connection.organization_id, token, job.entity_id, ctx));
      else if (job.entity_type === "order")
        await withZohoPurpose("Website → Zoho: order", () => withZohoOrderClaim(db, job.entity_id, () => syncZohoOrder(db, region, connection.organization_id, token, job)));
      else
        await withZohoPurpose("Website → Zoho: product", () => syncZohoCatalogItem(db, region, connection.organization_id, token, job.entity_id, ctx));
    } catch (cause) {
      if (cause instanceof ZohoOrderBusyError || cause instanceof ZohoOrderWaitError) {
        const waiting = cause instanceof ZohoOrderWaitError;
        console.info(zohoLogLine("outbox_job_deferred", { job: job.id, entityId: job.entity_id, waiting }));
        const { error: deferError } = await db.rpc("defer_zoho_sync_job", { _id: job.id, _seconds: waiting ? 300 : 60, _message: waiting ? cause.message : null });
        if (deferError) throw new Error(`Zoho job ${job.id} could not go back in line`);
        summary.deferred += 1;
        return;
      }
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
    // A clean run answers this order's rows from before it: they would still tell a person to enter money that is back.
    if (status === "complete" && job.entity_type === "order") {
      await db.from("zoho_sync_outbox").update({ status: "complete", last_error: null, updated_at: new Date().toISOString() })
        .eq("entity_type", "order").eq("entity_id", job.entity_id).in("status", ["needs_review", "failed"]).lt("updated_at", new Date(startedAt).toISOString());
    }
    if (job.entity_type === "order" && status === "needs_review" && asksAboutUnansweredCreate(errorMessage)) await settleZohoQuestion(db, job.entity_id);
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
  // The full re-check of Zoho (contacts, orders, items, godown prices and stock) is a safety net
  // behind the webhooks: hourly on the scheduled run, at once when an admin asks for it.
  if (options?.inbound !== true && !inboundPollDue(str(budget["lastInboundPollAt"]), Date.now())) return { ...summary, inbound: "skipped (hourly)" };
  await db.from("settings").upsert({ key: ZOHO_API_BUDGET_SETTING, value: { ...budget, lastInboundPollAt: new Date().toISOString() } as Json, is_public: false, updated_at: new Date().toISOString() });
  const [contacts, fulfillment, catalog] = await Promise.all([
    withZohoPurpose("Hourly check: customers", () => pollZohoContactChanges(db, region, connection.organization_id, token, limit)),
    withZohoPurpose("Hourly check: orders", () => applyRecentZohoOrderChanges(db, region, connection.organization_id, token)
      .then(() => pollZohoOrderFulfillment(db, region, connection.organization_id, token, limit))),
    withZohoPurpose("Hourly check: products", () => pollZohoCatalogChanges(db, region, connection.organization_id, token, limit)),
  ]);
  const newItems = await withZohoPurpose("Hourly check: new items", () => importNewZohoItems(db, region, connection.organization_id, token))
    .catch((cause: unknown) => ({ found: 0, imported: 0, failed: 1, errors: [cause instanceof Error ? cause.message : String(cause)] }));
  // Godown prices (Zoho price lists) and godown stock (Zoho locations), both ways. After the
  // catalogue pull, so new item links are in place; after the order jobs, so new sales orders
  // already hold their stock in Zoho.
  const godownPrices = await withZohoPurpose("Hourly check: godown prices", () => syncZohoGodownPrices(db, region, connection.organization_id, token))
    .catch((cause: unknown) => ({ godowns: 0, prices: 0, sentToZoho: 0, failed: 1, errors: [cause instanceof Error ? cause.message : String(cause)] }));
  const godownStock = await withZohoPurpose("Hourly check: godown stock", () => syncZohoGodownStock(db, region, connection.organization_id, token))
    .catch((cause: unknown) => ({ enabled: true, items: 0, pulled: 0, sentToZoho: 0, failed: 1, errors: [cause instanceof Error ? cause.message : String(cause)] }));
  // Rice sample purchase orders cancelled or removed in Zoho, so a sample comes back even if nobody has the page open.
  const ricePurchaseOrders = await import("@/lib/rice-samples.functions").then((desk) => desk.syncRiceSamplePos())
    .catch((cause: unknown) => ({ failed: 1, errors: [cause instanceof Error ? cause.message : String(cause)] }));
  return {
    ...summary,
    ricePurchaseOrders,
    inboundContacts: contacts,
    inboundFulfillment: fulfillment,
    inboundCatalog: catalog,
    newItems,
    godownPrices,
    godownStock,
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
    // Before the try: this is not a broken connection, so it must not mark the connection as failed.
    if (!(await zohoCommerceInUse(db)))
      throw new Error(`${ZOHO_COMMERCE_OFF_MESSAGE}. Add products on the website (or bring Zoho Inventory items in from Admin > Products) and make coupons in Admin > Coupons.`);
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
 * One at a time per order, across processes, by its claim (see withZohoOrderClaim). Within this process the
 * later one waits, then brings Zoho up to date with whatever changed meanwhile.
 */
const directPushes = new Map<string, Promise<unknown>>();
function pushOrderToZohoDirect(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const next = (directPushes.get(orderId) ?? Promise.resolve()).catch(() => undefined).then(() => pushOrderToZohoNow(db, orderId));
  directPushes.set(orderId, next);
  const forget = () => { if (directPushes.get(orderId) === next) directPushes.delete(orderId); };
  next.then(forget, forget);
  return next;
}

async function pushOrderToZohoNow(db: Awaited<ReturnType<typeof dbAdmin>>, orderId: string) {
  const { data: connection, error: connectionError } = await db
    .from("zoho_commerce_connection")
    .select("organization_id,region,refresh_token_ciphertext,token_iv,token_tag")
    .eq("id", true)
    .maybeSingle();
  if (connectionError || !connection) throw new Error("Connect and authorize Zoho before pushing orders");
  const region = connection.region as Region;
  const token = await accessToken(region, await decrypt(connection));

  const holder = crypto.randomUUID();
  // The entries this push had read when it began. One added or changed since is a change it may not have seen, so that stays for the queue.
  const readJobs = () => db.from("zoho_sync_outbox").select("id")
    .eq("entity_type", "order").eq("entity_id", orderId)
    .in("status", ["pending", "failed", "needs_review"]).eq("push_holder", holder);
  try {
    await withZohoPurpose("Website → Zoho: order (instant)", () => withZohoOrderClaim(db, orderId, () => syncZohoOrder(db, region, connection.organization_id, token, {
      id: "direct", entity_type: "order", entity_id: orderId, attempts: 0,
    } as ZohoSyncJob), holder));
  } catch (cause) {
    // Not this order's failure: its queue entries stay as they are, for the queue.
    if (cause instanceof ZohoOrderBusyError) throw cause;
    const message = (cause instanceof Error ? cause.message : "Zoho rejected the order").slice(0, 900);
    // Same split as the queue worker: a timeout or Zoho outage is retried by the next sync run;
    // only a rejection that needs a person goes to review (the worker never claims those).
    const status = cause instanceof NeedsReviewError ? "needs_review" : "failed";
    const { data: jobs } = await readJobs();
    if (jobs?.length) {
      await db.from("zoho_sync_outbox")
        .update({ status, last_error: message, updated_at: new Date().toISOString() })
        .in("id", jobs.map((job) => job.id));
    } else {
      await db.from("zoho_sync_outbox").insert({
        entity_type: "order", entity_id: orderId, event_type: "upsert", status, last_error: message,
      });
    }
    if (status === "needs_review" && asksAboutUnansweredCreate(message)) await settleZohoQuestion(db, orderId);
    throw new Error(`${message}${zohoPermissionHint(message)}`);
  }
  await db.from("zoho_sync_outbox")
    .update({ status: "complete", last_error: null, updated_at: new Date().toISOString() })
    .eq("entity_type", "order").eq("entity_id", orderId).in("status", ["pending", "failed", "needs_review"]).eq("push_holder", holder);
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
 * Server-only: sends an order to Zoho at once, the same push as an admin's status change (a bank alert confirmed
 * the payment, or the godown's QR handover delivered the last item). Never throws; a failure stays in the queue for
 * the 15-minute sync.
 */
export async function pushOrderToZohoFromServer(orderNo: string, purpose: string): Promise<boolean> {
  try {
    const db = await dbAdmin();
    const { data: order } = await db.from("orders").select("id").eq("order_no", orderNo).maybeSingle();
    if (!order || !(await isZohoWriteSyncActive(db))) return false;
    await withZohoPurpose(purpose, () => pushOrderToZohoDirect(db, order.id));
    await flushZohoCallLog();
    return true;
  } catch (cause) {
    console.warn(`Zoho push for ${orderNo} deferred to the queue:`, cause);
    return false;
  }
}

/** Server-only: sends a paid order to Zoho at once (a bank alert confirmed it). */
export const pushPaidOrderToZohoNow = (orderNo: string) => pushOrderToZohoFromServer(orderNo, "Website → Zoho: paid order (bank alert)");

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
      return {
        order: editableSalesOrder(order, await linkedGrainBazarOrderNo(db, data.salesOrderId)),
        /** "Mark as Cancelled" exists only in Zoho Commerce. */
        commerceInUse: await zohoCommerceInUse(db),
      };
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

      // Without Zoho Commerce: addresses through Zoho Books, Confirm and Void through Zoho Inventory.
      // Checked before anything is written, so a refused status never leaves half the change saved.
      const commerce = await zohoCommerceInUse(db);
      if (!commerce && changes.status === "cancelled")
        throw new Error(`${ZOHO_COMMERCE_OFF_MESSAGE}: "Mark as Cancelled" belongs to Zoho Commerce. Use "Mark as Void" instead`);

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
        step.name = `saving the ${type} address in Zoho`;
        const path = `salesorders/${encodeURIComponent(data.salesOrderId)}/address/${type}`;
        if (commerce) await commerceRequest(region, organizationId, token, path, "PUT", address);
        else await booksRequest(region, organizationId, token, path, "PUT", address);
      }
      if (changes.status) {
        step.name = `marking the order ${changes.status} in Zoho`;
        const path = `salesorders/${encodeURIComponent(data.salesOrderId)}/status/${changes.status}`;
        if (commerce) await commerceRequest(region, organizationId, token, path, "POST");
        else await inventoryRequest(region, organizationId, token, path, "POST");
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
 * Zoho sales orders, matched by Reference# (the website order number; GB-… for older orders). Lists missing, unlinked,
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
    // Per-order lookups with endpoints the sync already uses: by stored Zoho ID, else by the website
    // order number (Reference#, or GB- for older orders). Capped to stay inside Zoho's API limit.
    const MAX_LOOKUPS = 80;
    const rows = (orders ?? []).slice(0, MAX_LOOKUPS);
    const truncated = (orders ?? []).length > rows.length;
    const zohoOrders: ZohoOrderForReconcile[] = [];
    const toRecon = (row: Record<string, unknown>): ZohoOrderForReconcile => ({
      salesorder_id: str(row["salesorder_id"]),
      salesorder_number: str(row["salesorder_number"]),
      reference_number: str(row["reference_number"]),
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
      const found = await findZohoSalesOrdersForOrder(region, organizationId, token, order.order_no);
      zohoOrders.push(...found.map(toRecon));
    });
    const report = reconcileOrders((orders ?? []).map((o) => ({ ...o, total: Number(o.total) })), zohoOrders);
    console.info(zohoLogLine("reconcile_finished", { days: data.days, checked: report.checked, inSync: report.inSync, issues: report.issues.length, zohoFetched: zohoOrders.length, truncated }));
    return { ...report, days: data.days, zohoFetched: zohoOrders.length, truncated, ranAt: new Date().toISOString() };
  });


// ---------------------------------------------------------------- official Zoho order emails
const ORDER_EMAIL_SETTING = "zoho_order_email";
type OrderEmailConfig = { enabled: boolean; to: string[] };

async function readOrderEmailConfig(db: Awaited<ReturnType<typeof dbAdmin>>): Promise<OrderEmailConfig> {
  const { data } = await db.from("settings").select("value").eq("key", ORDER_EMAIL_SETTING).maybeSingle();
  const value = plainObject(data?.value);
  const to = Array.isArray(value["to"]) ? cleanEmailList(value["to"].map((entry) => str(entry))) : [];
  return { enabled: value["enabled"] === true && to.length > 0, to };
}

/** Zoho Books API v3 (same organization as Inventory). */
async function booksRequest<T>(region: Region, organizationId: string, token: string, resource: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: Record<string, unknown>) {
  const url = new URL(`${REGIONS[region][2]}/books/v3/${resource}`);
  url.searchParams.set("organization_id", organizationId);
  const send = () => fetch(url, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const response = await fetchWithZohoRetry(send, resource, method);
  if (!response) throw new Error(`Zoho Books ${resource} could not be reached`);
  const data = (await response.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!response.ok || data.code !== 0) throw zohoApiError(data.message ?? `Zoho Books ${resource} failed (${response.status})`);
  return data;
}

/**
 * Zoho Books "Email a sales order" (POST /books/v3/salesorders/{id}/email, scope
 * ZohoBooks.salesorders.CREATE). Sent once, when the website order's Zoho sales order is created.
 */
async function emailNewZohoOrder(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  salesOrderId: string,
  order: { number: string; customer: string; total: number; delivery: string },
): Promise<"off" | "sent"> {
  const config = await readOrderEmailConfig(db);
  if (!config.enabled) return "off";
  const email = newOrderEmail(order);
  await booksRequest(region, organizationId, token, `salesorders/${encodeURIComponent(salesOrderId)}/email`, "POST", {
    to_mail_ids: config.to,
    subject: email.subject,
    body: email.body,
    send_from_org_email_id: true,
  });
  return "sent";
}

export const getZohoOrderEmailConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    return readOrderEmailConfig(await dbAdmin());
  });

export const setZohoOrderEmailConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ enabled: z.boolean(), to: z.array(z.string().max(200)).max(10) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const to = cleanEmailList(data.to);
    if (data.enabled && !to.length) throw new Error("Add at least one valid email address before turning Zoho order emails on.");
    const db = await dbAdmin();
    const { error } = await db.from("settings").upsert({
      key: ORDER_EMAIL_SETTING,
      value: { enabled: data.enabled, to } as unknown as Json,
      is_public: false,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error("Could not save the Zoho order email setting");
    console.info(zohoLogLine("order_email_setting_changed", { enabled: data.enabled, recipients: to.length }));
    return { enabled: data.enabled && to.length > 0, to };
  });

/**
 * Sends one real test email through Zoho Books "Email a sales order" for the newest website order
 * that is in Zoho, to the saved recipients. Only runs when an admin clicks it. (Zoho documents no
 * dry run: reading or previewing needs ZohoBooks.salesorders.READ, which is not requested.)
 */
export const sendZohoOrderTestEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const config = await readOrderEmailConfig(db);
    if (!config.to.length) throw new Error("Save at least one recipient first.");
    const { data: order, error } = await db.from("orders")
      .select("order_no,customer_name,total,shipping_method,zoho_salesorder_id")
      .not("zoho_salesorder_id", "is", null).neq("order_status", "Cancelled")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error("Could not read orders");
    if (!order?.zoho_salesorder_id) throw new Error("No open website order is linked to Zoho yet.");
    const { region, organizationId, token } = await zohoOrderContext(db);
    const number = order.order_no;
    const email = newOrderEmail({ number, customer: order.customer_name ?? "", total: Number(order.total) || 0, delivery: str(order.shipping_method) });
    await booksRequest(region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id)}/email`, "POST", {
      to_mail_ids: config.to,
      subject: `Test: ${email.subject}`,
      body: email.body,
      send_from_org_email_id: true,
    });
    console.info(zohoLogLine("order_email_test_sent", { order: number, recipients: config.to.length }));
    return { order: number, sentTo: config.to };
  });

// ---------------------------------------------------------------- product / stock / customer parity
/**
 * Read-only parity report: Grain Bazar products (SKU, price, stock, active) against their linked
 * Zoho items, and Grain Bazar customers against their linked Zoho contacts. Uses documented Zoho
 * Inventory list endpoints (page / per_page / page_context.has_more_page) and the item record for
 * available-for-sale stock (not part of the documented list response). Changes nothing.
 */
export const reconcileZohoCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const [productsResult, itemLinksResult, contactLinksResult, rolesResult, profilesResult, ordersResult] = await Promise.all([
      db.from("catalog_products").select("id,vendor_id,active,status,payload"),
      db.from("zoho_item_links").select("product_id,zoho_item_id"),
      db.from("zoho_contact_links").select("user_id,contact_type,zoho_contact_id"),
      db.from("user_roles").select("user_id,role").eq("role", "customer"),
      db.from("profiles").select("id,full_name,email"),
      db.from("orders").select("user_id").not("user_id", "is", null).limit(5000),
    ]);
    for (const result of [productsResult, itemLinksResult, contactLinksResult, rolesResult, profilesResult, ordersResult])
      if (result.error) throw new Error("Could not read Grain Bazar data for the parity check");

    // Zoho-imported copies (vendor "zoho:...") mirror Zoho items and are never pushed back.
    const zohoImported = (productsResult.data ?? []).filter((row) => row.vendor_id.startsWith("zoho:")).length;
    const products: AppProductForParity[] = (productsResult.data ?? [])
      .filter((row) => row.status !== "rejected" && !row.vendor_id.startsWith("zoho:"))
      .map((row) => {
        const payload = plainObject(row.payload);
        return {
          id: row.id,
          name: str(payload["name"]) || row.id,
          sku: str(payload["sku"]).trim(),
          price: finiteNumber(payload["price"]),
          stock: finiteNumber(payload["stock"]),
          active: row.active,
        };
      });
    const itemLinks = new Map((itemLinksResult.data ?? []).map((row) => [row.product_id, row.zoho_item_id]));

    // Zoho items (all statuses), documented pagination; at most 10 pages of 200.
    const zohoItems = new Map<string, ZohoItemForParity>();
    let itemsTruncated = false;
    for (let page = 1; ; page += 1) {
      const result = await inventoryRequest<{ items?: Record<string, unknown>[]; page_context?: { has_more_page?: boolean } }>(
        region, organizationId, token, "items", "GET", undefined, { filter_by: "Status.All", page: String(page), per_page: "200" },
      );
      for (const row of result.items ?? []) {
        const id = str(row["item_id"]);
        zohoItems.set(id, { item_id: id, sku: str(row["sku"]), name: str(row["name"]), rate: finiteNumber(row["rate"]), available: null, status: str(row["status"]) });
      }
      if (!result.page_context?.has_more_page) break;
      if (page >= 10) { itemsTruncated = true; break; }
    }
    // Available-for-sale per linked item, from the item record (documented); capped per run.
    const STOCK_READS = 60;
    const linkedForStock = products.filter((product) => itemLinks.has(product.id) && zohoItems.has(itemLinks.get(product.id)!)).slice(0, STOCK_READS);
    const stockTruncated = products.filter((product) => itemLinks.has(product.id)).length > linkedForStock.length;
    await runPool(linkedForStock, 3, async (product) => {
      const zohoId = itemLinks.get(product.id)!;
      try {
        const detail = await inventoryRequest<{ item?: Record<string, unknown> }>(region, organizationId, token, `items/${encodeURIComponent(zohoId)}`, "GET");
        const current = zohoItems.get(zohoId);
        if (current && detail.item) zohoItems.set(zohoId, { ...current, available: zohoAvailableForSale(detail.item) });
      } catch {
        // Unreadable item: its stock is not compared (shown as not checked).
      }
    });
    const catalog = reconcileCatalog(products, itemLinks, [...zohoItems.values()]);

    // Customers vs Zoho contacts.
    const names = new Map((profilesResult.data ?? []).map((row) => [row.id, row.full_name || row.email || row.id]));
    const withOrders = new Set((ordersResult.data ?? []).map((row) => row.user_id as string));
    const customers = [...new Set((rolesResult.data ?? []).map((row) => row.user_id))].map((id) => ({ id, name: names.get(id) ?? id, hasOrders: withOrders.has(id) }));
    const contactLinks = new Map((contactLinksResult.data ?? []).filter((row) => row.contact_type === "customer").map((row) => [row.user_id, row.zoho_contact_id]));
    let zohoContactIds: Set<string> | null = new Set();
    for (let page = 1; ; page += 1) {
      const result = await inventoryRequest<{ contacts?: Record<string, unknown>[]; page_context?: { has_more_page?: boolean } }>(
        region, organizationId, token, "contacts", "GET", undefined, { page: String(page), per_page: "200" },
      );
      for (const row of result.contacts ?? []) zohoContactIds.add(str(row["contact_id"]));
      if (!result.page_context?.has_more_page) break;
      if (page >= 10) { zohoContactIds = null; break; }
    }
    const customerReport = reconcileCustomers(customers, contactLinks, zohoContactIds);

    const notChecked = linkedForStock.filter((product) => zohoItems.get(itemLinks.get(product.id)!)?.available === null).length;
    console.info(zohoLogLine("catalog_parity_finished", {
      products: catalog.checked, productsInSync: catalog.inSync, productIssues: catalog.issues.length,
      customers: customerReport.checked, customerIssues: customerReport.issues.length, stockNotChecked: notChecked,
    }));
    return {
      catalog,
      customers: customerReport,
      zohoImported,
      zohoItemsFetched: zohoItems.size,
      itemsTruncated,
      stockTruncated,
      stockNotChecked: notChecked,
      contactsChecked: zohoContactIds !== null,
      ranAt: new Date().toISOString(),
    };
  });


/** Updates the contact's primary person in place (Zoho Inventory Contact Persons API), or adds one. */
async function upsertPrimaryContactPerson(
  region: Region,
  organizationId: string,
  token: string,
  contactId: string,
  person: { first_name: string; last_name: string; email: string; phone: string; mobile: string },
) {
  const listed = await inventoryRequest<{ contact_persons?: Record<string, unknown>[] }>(
    region, organizationId, token, `contacts/${encodeURIComponent(contactId)}/contactpersons`, "GET",
  );
  const persons = (listed.contact_persons ?? []).map(plainObject);
  const primary = persons.find((row) => row["is_primary_contact"] === true)
    ?? persons.find((row) => str(row["email"]).toLowerCase() === person.email.toLowerCase())
    ?? persons[0];
  const fields = {
    contact_id: contactId,
    first_name: person.first_name || "Customer",
    last_name: person.last_name,
    email: person.email,
    phone: person.phone,
    mobile: person.mobile,
  };
  if (primary && str(primary["contact_person_id"])) {
    await inventoryRequest(region, organizationId, token, `contacts/contactpersons/${encodeURIComponent(str(primary["contact_person_id"]))}`, "PUT", fields);
  } else {
    await inventoryRequest(region, organizationId, token, "contacts/contactpersons", "POST", fields);
  }
}

/** Among duplicate Zoho contacts, the one this customer's own Zoho sales orders use (if exactly one). */
async function contactUsedByCustomerOrders(
  db: Awaited<ReturnType<typeof dbAdmin>>,
  region: Region,
  organizationId: string,
  token: string,
  userId: string,
  candidates: string[],
): Promise<string | null> {
  const { data: orders } = await db.from("orders").select("zoho_salesorder_id")
    .eq("user_id", userId).not("zoho_salesorder_id", "is", null)
    .order("created_at", { ascending: false }).limit(5);
  const used = new Set<string>();
  for (const order of orders ?? []) {
    try {
      const response = await inventoryRequest<{ salesorder?: Record<string, unknown> }>(
        region, organizationId, token, `salesorders/${encodeURIComponent(order.zoho_salesorder_id!)}`, "GET",
      );
      const customerId = str(response.salesorder?.["customer_id"]);
      if (candidates.includes(customerId)) used.add(customerId);
    } catch {
      // Unreadable order: ignore it for this choice.
    }
  }
  return used.size === 1 ? [...used][0]! : null;
}


/** Zoho location of the default (else the only active) godown, where Grain Bazar keeps its stock. */
async function defaultStockLocationId(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data: branches } = await db.from("branches").select("zoho_location_id,is_default,active").eq("active", true).is("vendor_id", null);
  const withLocation = (branches ?? []).filter((branch) => branch.zoho_location_id);
  const chosen = withLocation.find((branch) => branch.is_default) ?? (withLocation.length === 1 ? withLocation[0] : undefined);
  return chosen?.zoho_location_id ?? "";
}

/* ------------------------------------------------------------------------- */
/* Godown catalogue, two-way with Zoho: price lists and stock per location.   */
/* ------------------------------------------------------------------------- */

/** On when Zoho owns stock per location: each godown's stock is reconciled with its Zoho location
 *  (website edits sent, Zoho changes pulled). Off: the website's total stock is sent to the default
 *  godown's location, as before. */
async function isZohoStockMaster(db: Awaited<ReturnType<typeof dbAdmin>>) {
  return (await zohoStockMasterSetting(db)).enabled;
}

/** The "Zoho is the stock master" switch and when it was turned on (orders before then are
 *  already reflected in Zoho's stock). */
async function zohoStockMasterSetting(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data } = await db.from("settings").select("value,updated_at").eq("key", "zoho_stock_master").maybeSingle();
  const value = data?.value && typeof data.value === "object" && !Array.isArray(data.value) ? data.value as Record<string, unknown> : {};
  const since = typeof value["since"] === "string" && value["since"] ? value["since"] : (data?.updated_at ?? new Date().toISOString());
  return { enabled: value["enabled"] === true, since };
}

/** Zoho sales price lists (all pages). */
async function fetchZohoSalesPricebooks(region: Region, organizationId: string, token: string) {
  const books: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await inventoryRequest<{ pricebooks?: Record<string, unknown>[] }>(
      region, organizationId, token, "pricebooks", "GET", undefined,
      { page: String(page), per_page: "200", filter_by: "SalesOrPurchaseType.Sales" },
    );
    books.push(...(result.pricebooks ?? []));
    if ((result.pricebooks ?? []).length < 200) break;
  }
  return books;
}

/** One Zoho price list with its items (list responses can leave the items out). */
async function fetchZohoPricebook(region: Region, organizationId: string, token: string, books: Record<string, unknown>[], pricebookId: string) {
  let book = books.find((entry) => str(entry["pricebook_id"]) === pricebookId);
  if (!book) throw new NeedsReviewError(`Zoho price list ${pricebookId} was not found (deleted, or not a sales price list)`);
  if (str(book["pricebook_type"]) !== "fixed_percentage" && !Array.isArray(book["pricebook_items"])) {
    const one = await inventoryRequest<{ pricebook?: Record<string, unknown> }>(
      region, organizationId, token, `pricebooks/${encodeURIComponent(pricebookId)}`, "GET",
    );
    if (one.pricebook) book = one.pricebook;
  }
  return book;
}

/**
 * Two-way godown prices. For each godown linked to a Zoho price list: start from Zoho's list,
 * let website edits still waiting for Zoho win, send the merged list to Zoho when it differs,
 * then save the merged list on the website (which clears the waiting flags). A failed send keeps
 * the website edits waiting for the next run.
 */
async function syncZohoGodownPrices(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string) {
  const summary = { godowns: 0, prices: 0, sentToZoho: 0, failed: 0, errors: [] as string[] };
  const { data: branches } = await db.from("branches").select("id,name,zoho_pricebook_id").eq("active", true).neq("zoho_pricebook_id", "");
  if (!branches?.length) return summary;
  const [books, { data: links }, { data: products }] = await Promise.all([
    fetchZohoSalesPricebooks(region, organizationId, token),
    db.from("zoho_item_links").select("product_id,zoho_item_id"),
    db.from("catalog_products").select("id,vendor_id,payload"),
  ]);
  const productByZohoItem = new Map((links ?? []).map((link) => [link.zoho_item_id, link.product_id]));
  const zohoItemByProduct = new Map((links ?? []).map((link) => [link.product_id, link.zoho_item_id]));
  const basePrice = new Map((products ?? [])
    .filter((product) => !product.vendor_id?.startsWith("zoho:"))
    .map((product) => [product.id, finiteNumber((product.payload as Record<string, unknown> | null)?.["price"]) ?? 0]));
  for (const branch of branches) {
    try {
      const readAt = new Date().toISOString();
      const [book, { data: rows }] = await Promise.all([
        fetchZohoPricebook(region, organizationId, token, books, branch.zoho_pricebook_id),
        db.from("branch_prices").select("product_id,price,listed,pending").eq("branch_id", branch.id),
      ]);
      const zohoPrices = godownPricesFromPricebook(book, productByZohoItem, basePrice);
      const perItem = str(book["pricebook_type"]) !== "fixed_percentage";
      const merged = mergeGodownPrices(zohoPrices, perItem ? (rows ?? []) : []);
      if (perItem && !sameGodownPrices(merged, zohoPrices)) {
        const items = zohoPricebookItemsFor(
          Array.isArray(book["pricebook_items"]) ? (book["pricebook_items"] as Record<string, unknown>[]) : [],
          merged, productByZohoItem, zohoItemByProduct,
        );
        await inventoryRequest(region, organizationId, token, `pricebooks/${encodeURIComponent(branch.zoho_pricebook_id)}`, "PUT", {
          name: str(book["name"]),
          pricebook_type: "per_item",
          sales_or_purchase_type: str(book["sales_or_purchase_type"]) || "sales",
          ...(str(book["currency_id"]) ? { currency_id: str(book["currency_id"]) } : {}),
          ...(str(book["pricing_scheme"]) ? { pricing_scheme: str(book["pricing_scheme"]) } : {}),
          pricebook_items: items,
        });
        summary.sentToZoho += 1;
      }
      const { data: kept, error } = await db.rpc("apply_zoho_branch_prices", {
        _branch_id: branch.id, _pricebook_name: str(book["name"]), _prices: merged as unknown as Json, _read_at: readAt,
      });
      if (error) throw new Error(error.message);
      summary.godowns += 1;
      summary.prices += Number(kept) || 0;
    } catch (cause) {
      summary.failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      summary.errors.push(`${branch.name}: ${message}${zohoPermissionHint(message)}`.slice(0, 400));
    }
  }
  return summary;
}

/**
 * Two-way godown stock (stock master ON). For each linked item and each godown with a Zoho
 * location: a website edit still waiting is sent to that location as a stock adjustment; otherwise
 * the godown takes Zoho's available stock there, less website orders Zoho does not hold yet.
 */
async function syncZohoGodownStock(db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string) {
  const summary = {
    enabled: false, items: 0, pulled: 0, sentToZoho: 0, failed: 0, errors: [] as string[],
    batches: { items: 0, linked: 0, added: 0, skipped: 0, failed: 0, errors: [] as string[] },
    transfers: { checked: 0, received: 0, cancelled: 0, failed: 0, heldBack: 0, errors: [] as string[] },
  };
  // Read time first: anything a transfer changes from here on (including what the check below settles) is newer than
  // it, so this run neither pulls over it nor pushes an older count over it.
  const readAt = new Date().toISOString();
  // Transfers between godowns first: one Zoho already moved, received or voided is settled here before stock is pulled,
  // so units arrive with their batch; the godowns of one that can't be settled yet are left alone this run.
  const onTheWay = await reconcileTransfersOnTheWay(db);
  summary.transfers = onTheWay.summary;
  if (!(await isZohoStockMaster(db))) return summary;
  summary.enabled = true;
  // The transfers could not be read: which godowns they touch is unknown, so no godown stock moves this run.
  if (onTheWay.holdAll) return summary;
  const [{ data: branches }, { data: links }, { data: products }, { data: stockRows }] = await Promise.all([
    db.from("branches").select("id,zoho_location_id").eq("active", true).is("vendor_id", null).neq("zoho_location_id", ""),
    db.from("zoho_item_links").select("product_id,zoho_item_id,track_batches"),
    db.from("catalog_products").select("id,vendor_id,payload"),
    db.from("branch_stock").select("branch_id,product_id,stock,zoho_pending"),
  ]);
  if (!branches?.length || !links?.length) return summary;
  const siteProducts = new Map((products ?? []).filter((product) => !product.vendor_id?.startsWith("zoho:"))
    .map((product) => [product.id, str((product.payload as Record<string, unknown> | null)?.["sku"]) || product.id]));
  const siteStock = new Map((stockRows ?? []).map((row) => [`${row.branch_id}|${row.product_id}`, row]));
  // Website orders Zoho does not hold yet, placed since Zoho became the stock master.
  const { since } = await zohoStockMasterSetting(db);
  const [{ data: recentOrders }, { data: defaultBranch }] = await Promise.all([
    db.from("orders").select("id,branch_id,order_status,zoho_salesorder_id,zoho_order_status,created_at,order_items(product_id,qty)").gte("created_at", since),
    db.from("branches").select("id").eq("is_default", true).maybeSingle(),
  ]);
  const pending = pendingOrderQty((recentOrders ?? []).map((order) => ({
    branch_id: order.branch_id, order_status: order.order_status, zoho_salesorder_id: order.zoho_salesorder_id,
    zoho_order_status: order.zoho_order_status, created_at: order.created_at,
    items: ((order as { order_items?: { product_id: string | null; qty: number }[] }).order_items ?? []),
  })), since, defaultBranch?.id ?? "");
  const trackedItems: { productId: string; zohoItemId: string; purchaseRate: number }[] = [];
  await runPool(links.filter((link) => siteProducts.has(link.product_id)), 3, async (link) => {
    try {
      const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
        region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
      );
      const item = response.item ?? {};
      summary.items += 1;
      if (str(item["item_type"]) && str(item["item_type"]) !== "inventory") return;
      // Zoho "Track batches": remembered for the admin pages; its batches are read below.
      const tracked = zohoTracksBatches(item);
      if (tracked !== link.track_batches)
        await db.from("zoho_item_links").update({ track_batches: tracked }).eq("product_id", link.product_id);
      if (tracked) trackedItems.push({ productId: link.product_id, zohoItemId: link.zoho_item_id, purchaseRate: Math.max(0, Number(item["purchase_rate"]) || 0) });
      for (const branch of branches) {
        // A transfer between godowns that Zoho may already count but the website has not settled: next run.
        if (onTheWay.holdBack.has(`${branch.id}|${link.product_id}`)) continue;
        const ordersWaiting = pending.get(branch.id)?.get(link.product_id) ?? 0;
        const zohoStock = godownStockFromZohoItem(item, branch.zoho_location_id, ordersWaiting);
        let row = siteStock.get(`${branch.id}|${link.product_id}`);
        if (row?.zoho_pending) {
          // Read again: a transfer or an order since the start of this run changed it, and Zoho (read just now) may
          // already have that change; sending the older count would undo it in Zoho. The next run sends it.
          const { data: now } = await db.from("branch_stock").select("branch_id,product_id,stock,zoho_pending,updated_at")
            .eq("branch_id", branch.id).eq("product_id", link.product_id).maybeSingle();
          if (!now || Date.parse(now.updated_at) > Date.parse(readAt)) continue;
          // A transfer touching this godown and item that is not settled (waiting, or on its way): Zoho's count may move
          // under it at any moment, so the edit is sent once it is settled.
          const { data: open, error: openError } = await db.from("batch_transfers").select("product_id,lines")
            .in("status", ["pending", "in_transit"]).or(`from_branch_id.eq.${branch.id},to_branch_id.eq.${branch.id}`);
          if (openError) continue;
          if ((open ?? []).some((t) => t.product_id === link.product_id || godownTransferLines(t.lines).some((line) => line.product_id === link.product_id))) continue;
          row = now;
        }
        let target = zohoStock;
        if (row?.zoho_pending) {
          // Website edit wins: bring the Zoho location to the website count (plus orders Zoho
          // does not hold yet, which the website has already taken off).
          const zohoAvailable = godownStockFromZohoItem(item, branch.zoho_location_id, 0) ?? 0;
          const delta = Math.round((Number(row.stock) + ordersWaiting - zohoAvailable) * 1000) / 1000;
          if (delta !== 0) {
            // A website receipt or edit: a batch-tracked item names its batches. Other items' batches
            // already took the change when it was made (admin_set_branch_stock); a batch-tracked
            // item's batches take what Zoho changed here (a gain only on a batch Zoho already has,
            // since a website-only receipt is in its batch already).
            const batchLine = await batchAwareAdjustment(db, region, organizationId, token, {
              itemId: link.zoho_item_id, tracked, locationId: branch.zoho_location_id,
              branchId: branch.id, productId: link.product_id, delta, gainShares: tracked ? "linked" : false,
            });
            const adjustment = await inventoryRequest<{ inventory_adjustment?: Record<string, unknown> }>(region, organizationId, token, "inventoryadjustments", "POST", {
              date: todayInIndia(),
              reason: "Grain Bazar godown stock",
              adjustment_type: "quantity",
              description: `Set ${siteProducts.get(link.product_id)} stock at this godown to ${row.stock} to match Grain Bazar`,
              location_id: branch.zoho_location_id,
              line_items: [batchLine.line],
            });
            if (tracked) await recordBatchShares(db, batchLine.shares, {
              reason: "correction", note: "Godown stock set by head office", by: null, byName: "Website",
              zohoAdjustmentId: str(adjustment.inventory_adjustment?.["inventory_adjustment_id"]),
            });
            summary.sentToZoho += 1;
          }
          target = Number(row.stock);
        }
        if (target === null) continue;
        const { error } = await db.rpc("apply_zoho_branch_stock", {
          _branch_id: branch.id, _product_id: link.product_id, _stock: target, _read_at: readAt,
        });
        if (error) throw new Error(error.message);
        if (!row?.zoho_pending) summary.pulled += 1;
      }
    } catch (cause) {
      summary.failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      summary.errors.push(`${siteProducts.get(link.product_id)}: ${message}${zohoPermissionHint(message)}`.slice(0, 300));
    }
  });
  summary.errors = summary.errors.slice(0, 10);
  if (trackedItems.length) {
    summary.batches = await syncZohoBatches(db, region, organizationId, token, trackedItems, branches);
    summary.batches.errors = summary.batches.errors.slice(0, 10);
  }
  return summary;
}

/** Website orders Zoho does not hold yet, per godown and product (same rule as the stock sync). */
async function pendingWebsiteOrders(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { since } = await zohoStockMasterSetting(db);
  const [{ data: recentOrders }, { data: defaultBranch }] = await Promise.all([
    db.from("orders").select("id,branch_id,order_status,zoho_salesorder_id,zoho_order_status,created_at,order_items(product_id,qty)").gte("created_at", since),
    db.from("branches").select("id").eq("is_default", true).maybeSingle(),
  ]);
  return pendingOrderQty((recentOrders ?? []).map((order) => ({
    branch_id: order.branch_id, order_status: order.order_status, zoho_salesorder_id: order.zoho_salesorder_id,
    zoho_order_status: order.zoho_order_status, created_at: order.created_at,
    items: ((order as { order_items?: { product_id: string | null; qty: number }[] }).order_items ?? []),
  })), since, defaultBranch?.id ?? "");
}

/** Website orders Zoho does not hold yet for one product at one godown. */
async function pendingWebsiteOrderQty(db: Awaited<ReturnType<typeof dbAdmin>>, branchId: string, productId: string) {
  return (await pendingWebsiteOrders(db)).get(branchId)?.get(productId) ?? 0;
}

/**
 * Godown staff stock count (staff app, rules in src/lib/stock-counts.ts). The employee enters the
 * packs counted on the floor of their own godown. Zoho's physical stock at the godown's location is
 * brought to the count with one inventory adjustment; only when Zoho accepted it are the count and
 * the godown's website stock saved (record_stock_count). If Zoho can't be reached nothing changes,
 * so the website and Zoho never disagree.
 */
export const submitStockCount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    productId: z.string().trim().min(1).max(100),
    counted: z.number().int().min(0).max(MAX_COUNT),
    reason: z.enum(["daily_count", "received", "damaged", "correction"]),
    note: z.string().trim().max(200).default(""),
  }))
  .handler(async ({ data, context }) => withZohoPurpose("Godown stock count (staff app)", async () => {
    const db = await dbAdmin();
    const { data: employee } = await db.from("staff_employees").select("id,name,branch_id,status").eq("user_id", context.userId).maybeSingle();
    if (!employee || employee.status !== "active") throw new Error("Only active godown employees can update stock");
    if (!(await isZohoStockMaster(db))) throw new Error("Stock updates need Zoho as the stock master. Ask head office.");
    const [{ data: branch }, { data: link }, { data: product }] = await Promise.all([
      db.from("branches").select("id,name,zoho_location_id,active").eq("id", employee.branch_id).maybeSingle(),
      db.from("zoho_item_links").select("zoho_item_id").eq("product_id", data.productId).maybeSingle(),
      db.from("catalog_products").select("id,vendor_id,payload").eq("id", data.productId).maybeSingle(),
    ]);
    if (!branch?.active || !str(branch.zoho_location_id)) throw new Error("Your godown is not linked to a Zoho location. Ask head office.");
    if (!product || str(product.vendor_id).startsWith("zoho:")) throw new Error("Product not found");
    if (!link?.zoho_item_id) throw new Error("This product is not linked to Zoho yet. Ask head office.");

    const { region, organizationId, token } = await zohoOrderContext(db);
    const response = await inventoryRequest<{ item?: Record<string, unknown> }>(
      region, organizationId, token, `items/${encodeURIComponent(link.zoho_item_id)}`, "GET",
    );
    const zoho = zohoLocationStock(response.item ?? {}, branch.zoho_location_id);
    if (!zoho) throw new Error("Zoho has no stock record for this item at your godown. Ask head office.");
    const pendingOrders = await pendingWebsiteOrderQty(db, branch.id, product.id);
    const plan = planStockCount({ counted: data.counted, physical: zoho.physical, accounting: zoho.accounting, pendingOrders });
    const productName = str((product.payload as Record<string, unknown> | null)?.["name"]) || product.id;

    let adjustmentId = "";
    let shares: BatchShare[] = [];
    const tracked = zohoTracksBatches(response.item);
    // The website stock before the count: a head-office edit still waiting for Zoho is already on
    // the batches (admin_set_branch_stock), so batches take only the website's own change below.
    const { data: siteRow } = await db.from("branch_stock").select("stock").eq("branch_id", branch.id).eq("product_id", product.id).maybeSingle();
    const siteBefore = Number(siteRow?.stock ?? 0);
    if (plan.delta !== 0) {
      // Batch-tracked in Zoho: the adjustment names the batches (the oldest lose first).
      const batchLine = await batchAwareAdjustment(db, region, organizationId, token, {
        itemId: link.zoho_item_id, tracked, locationId: branch.zoho_location_id,
        branchId: branch.id, productId: product.id, delta: plan.delta, gainShares: true,
      });
      if (tracked) shares = batchLine.shares;
      const adjustment = await inventoryRequest<{ inventory_adjustment?: Record<string, unknown> }>(
        region, organizationId, token, "inventoryadjustments", "POST", {
          date: todayInIndia(),
          reason: "Grain Bazar godown stock",
          adjustment_type: "quantity",
          description: stockCountDescription({ godown: branch.name, employee: employee.name, counted: data.counted, physical: zoho.physical, reason: data.reason, note: data.note }),
          location_id: branch.zoho_location_id,
          line_items: [batchLine.line],
        },
      );
      adjustmentId = str(adjustment.inventory_adjustment?.["inventory_adjustment_id"]);
    }
    const flagged = isBigChange(zoho.physical, data.counted);
    const { data: countId, error } = await db.rpc("record_stock_count", {
      _branch_id: branch.id, _product_id: product.id, _counted: data.counted, _zoho_physical_before: zoho.physical,
      _zoho_delta: plan.delta, _site_after: plan.siteAfter, _reason: data.reason, _note: data.note, _flagged: flagged,
      _zoho_adjustment_id: adjustmentId, _counted_by: context.userId, _counted_by_name: employee.name, _employee_id: employee.id,
    });
    if (error) {
      throw new Error(plan.delta !== 0
        ? "Zoho has the new count, but the website could not save it. The website catches up at the next Zoho sync (within 15 minutes)."
        : "The count could not be saved. Try again.");
    }
    // The same loss / gain per batch, for the batch reports: for a batch-tracked item the batches
    // Zoho changed; otherwise the website's change (oldest batch loses first, newest takes a gain).
    if (!tracked) {
      const change = Math.round((plan.siteAfter - siteBefore) * 1000) / 1000;
      const website = change === 0 ? [] : await websiteBatchesAt(db, branch.id, product.id);
      shares = change < 0 ? planBatchLoss(website, -change).shares : change > 0 ? planBatchGain(website, change).shares : [];
    }
    await recordBatchShares(db, shares, {
      reason: data.reason === "damaged" ? "damaged" : "stock_count", note: data.note, stockCountId: countId ?? null,
      zohoAdjustmentId: adjustmentId, by: context.userId, byName: employee.name,
    });
    return { productName, counted: data.counted, zohoBefore: zoho.physical, delta: plan.delta, siteAfter: plan.siteAfter, flagged, adjustmentId };
  }));

/** Admin → Godowns: Zoho sales price lists to link a godown to. */
export const listZohoPriceLists = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    try {
      const books = await fetchZohoSalesPricebooks(region, organizationId, token);
      return books.map((book) => ({
        id: str(book["pricebook_id"]),
        name: str(book["name"]),
        type: str(book["pricebook_type"]) === "fixed_percentage" ? ("percentage" as const) : ("per_item" as const),
        active: str(book["status"]) !== "inactive",
      })).filter((book) => book.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Zoho price lists could not be read";
      throw new Error(`${message}${zohoPermissionHint(message)}`);
    }
  });

/** Admin: reconcile godown prices (and stock, when Zoho is the stock master) with Zoho now. */
export const syncZohoGodownsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { region, organizationId, token } = await zohoOrderContext(db);
    const prices = await syncZohoGodownPrices(db, region, organizationId, token);
    const stock = await syncZohoGodownStock(db, region, organizationId, token);
    return { prices, stock };
  });

// ---------------------------------------------------------------- batches (rules in src/lib/batches.ts)
// Zoho refuses packages and adjustments of an item with "Track batches" ticked unless they name
// the batches, so every such call here says which Zoho batches the units come from or go to.

/** Batches of one Zoho item, all locations (GET /items/batches, scope items.READ). */
async function zohoItemBatches(region: Region, organizationId: string, token: string, itemId: string) {
  const response = await inventoryRequest<{ batches?: unknown[] }>(region, organizationId, token, "items/batches", "GET", undefined,
    { item_id: itemId, per_page: "200" });
  return Array.isArray(response.batches) ? response.batches : [];
}

/** The website's batches of a product at a godown. */
async function websiteBatchesAt(db: Awaited<ReturnType<typeof dbAdmin>>, branchId: string, productId: string): Promise<StockBatch[]> {
  const { data } = await db.from("batches").select("id,batch_code,purchase_date,created_at,remaining_quantity,zoho_batch_id")
    .eq("branch_id", branchId).eq("product_id", productId);
  return (data ?? []).map((b) => ({
    id: b.id, batchCode: b.batch_code, purchaseDate: b.purchase_date, createdAt: b.created_at,
    remaining: Number(b.remaining_quantity), zohoBatchId: b.zoho_batch_id,
  }));
}

/**
 * The Zoho adjustment line for a stock change of `delta` units at a godown, plus the same change
 * per website batch (for the batch reports). Item with Zoho "Track batches": a loss comes out of
 * Zoho's oldest batches at that location; a gain goes to a website batch Zoho does not have yet
 * (by its number), else Zoho's newest batch there, else a new batch number. Other items: the
 * oldest website batch loses first, the newest takes a gain.
 */
async function batchAwareAdjustment(
  db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string,
  input: { itemId: string; tracked: boolean; locationId: string; branchId: string; productId: string; delta: number; gainShares: boolean | "linked" },
) {
  const line: Record<string, unknown> = { item_id: input.itemId, quantity_adjusted: input.delta, location_id: input.locationId };
  const website = await websiteBatchesAt(db, input.branchId, input.productId);
  let shares: BatchShare[] = [];
  if (!input.tracked) {
    shares = input.delta < 0 ? planBatchLoss(website, -input.delta).shares : input.gainShares === true ? planBatchGain(website, input.delta).shares : [];
    return { line, shares };
  }
  const zoho = zohoBatchesAtLocation(await zohoItemBatches(region, organizationId, token, input.itemId), input.locationId);
  const byZohoId = new Map(website.filter((b) => b.zohoBatchId).map((b) => [b.zohoBatchId!, b]));
  if (input.delta < 0) {
    const plan = planZohoBatchOut(zoho, -input.delta);
    if (plan.short > 0)
      throw new Error(`Zoho has only ${-input.delta - plan.short} of this item in batches at this godown. Receive the rest as a batch (Admin > Batches) first.`);
    line["batches"] = plan.lines;
    shares = plan.lines.flatMap((l) => {
      const batch = byZohoId.get(l.batch_id);
      return batch ? [{ batchId: batch.id, qty: -l.out_quantity }] : [];
    });
  } else if (input.delta > 0) {
    const unlinked = website.filter((b) => !b.zohoBatchId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (unlinked) {
      line["batches"] = [{ batch_number: unlinked.batchCode, in_quantity: input.delta }];
      if (input.gainShares === true) shares = [{ batchId: unlinked.id, qty: input.delta }];
    } else {
      let fresh = "";
      if (!zoho.length) {
        const { data: next } = await db.rpc("next_batch_code", { _branch_id: input.branchId, _purchase_date: todayInIndia() });
        fresh = next ?? `${input.branchId}-${todayInIndia()}`;
      }
      line["batches"] = planZohoBatchIn(zoho, input.delta, fresh);
      const newest = zoho.at(-1);
      const target = newest ? byZohoId.get(newest.batchId) : undefined;
      if (input.gainShares && target) shares = [{ batchId: target.id, qty: input.delta }];
    }
  }
  return { line, shares };
}

/** Records the per-batch part of a stock change; a failure is logged, never undoes the change. */
async function recordBatchShares(
  db: Awaited<ReturnType<typeof dbAdmin>>, shares: BatchShare[],
  meta: { reason: string; note: string; stockCountId?: string | null; zohoAdjustmentId: string; by: string | null; byName: string },
) {
  if (!shares.length) return;
  const { error } = await db.rpc("record_batch_adjustments", {
    _rows: shares.map((share) => ({
      batch_id: share.batchId, qty: share.qty, reason: meta.reason, note: meta.note,
      stock_count_id: meta.stockCountId ?? "", zoho_adjustment_id: meta.zohoAdjustmentId,
    })) as Json,
    _created_by: meta.by, _created_by_name: meta.byName,
  });
  if (error) console.error(zohoLogLine("batch_adjustment_failed", { reason: meta.reason, message: error.message.slice(0, 200) }));
}

/**
 * Zoho -> website for batch-tracked items: Zoho batches at each godown's location are linked to the
 * website batch with the same number (Zoho's balance is kept for the reconciliation), and batches
 * made in Zoho (a purchase receive, a transfer to another godown) are added to the website.
 */
async function syncZohoBatches(
  db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string,
  items: { productId: string; zohoItemId: string; purchaseRate: number }[],
  branches: { id: string; zoho_location_id: string }[],
) {
  const summary = { items: 0, linked: 0, added: 0, skipped: 0, failed: 0, errors: [] as string[] };
  for (const item of items) {
    try {
      const list = await zohoItemBatches(region, organizationId, token, item.zohoItemId);
      const rows = branches.flatMap((branch) => zohoBatchesAtLocation(list, branch.zoho_location_id).map((batch) => ({
        zoho_batch_id: batch.batchId, batch_number: batch.batchNumber, product_id: item.productId, branch_id: branch.id,
        zoho_item_id: item.zohoItemId, in_quantity: batch.inQuantity, balance: batch.balance,
        mfg_date: batch.manufacturedDate.slice(0, 10), expiry_date: batch.expiryDate.slice(0, 10),
        unit_cost: item.purchaseRate, seen_on: todayInIndia(),
      })));
      summary.items += 1;
      if (!rows.length) continue;
      const { data, error } = await db.rpc("apply_zoho_batches", { _rows: rows as Json });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { linked?: number; added?: number; skipped?: number };
      summary.linked += result.linked ?? 0;
      summary.added += result.added ?? 0;
      summary.skipped += result.skipped ?? 0;
    } catch (cause) {
      summary.failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      summary.errors.push(`${item.productId}: ${message}${zohoPermissionHint(message)}`.slice(0, 300));
    }
  }
  return summary;
}

/** For a package: the Zoho batches the website order took, per Zoho item, and Zoho's batches at the order's location. */
async function packageBatchInputs(
  db: Awaited<ReturnType<typeof dbAdmin>>, region: Region, organizationId: string, token: string,
  orderId: string, soLines: Record<string, unknown>[], fallbackLocation: string,
) {
  const reserved = new Map<string, { zohoBatchId: string; qty: number }[]>();
  const zohoBatchesByItem = new Map<string, ZohoBatch[]>();
  const { data: items } = await db.from("order_items").select("id,product_id").eq("order_id", orderId);
  const itemIds = (items ?? []).map((item) => item.id);
  const productOf = new Map((items ?? []).map((item) => [item.id, item.product_id ?? ""]));
  const { data: allocations } = itemIds.length
    ? await db.from("order_item_batch_allocations").select("order_item_id,batch_id,reserved_quantity,released_quantity").in("order_item_id", itemIds)
    : { data: [] as { order_item_id: string; batch_id: string; reserved_quantity: number; released_quantity: number }[] };
  const { data: links } = await db.from("zoho_item_links").select("product_id,zoho_item_id");
  const zohoItemOf = new Map((links ?? []).map((link) => [link.product_id, link.zoho_item_id]));
  const batchIds = [...new Set((allocations ?? []).map((a) => a.batch_id))];
  const { data: batches } = batchIds.length
    ? await db.from("batches").select("id,zoho_batch_id").in("id", batchIds)
    : { data: [] as { id: string; zoho_batch_id: string }[] };
  const zohoBatchOf = new Map((batches ?? []).map((b) => [b.id, b.zoho_batch_id]));
  for (const allocation of allocations ?? []) {
    const left = Number(allocation.reserved_quantity) - Number(allocation.released_quantity);
    const zohoItem = zohoItemOf.get(productOf.get(allocation.order_item_id) ?? "");
    const zohoBatch = zohoBatchOf.get(allocation.batch_id);
    if (left <= 0 || !zohoItem || !zohoBatch) continue;
    reserved.set(zohoItem, [...(reserved.get(zohoItem) ?? []), { zohoBatchId: zohoBatch, qty: left }]);
  }
  for (const line of soLines.filter((l) => l["track_batch_number"] === true)) {
    const itemId = str(line["item_id"]);
    if (!itemId || zohoBatchesByItem.has(itemId)) continue;
    const location = str(line["location_id"]) || fallbackLocation;
    zohoBatchesByItem.set(itemId, zohoBatchesAtLocation(await zohoItemBatches(region, organizationId, token, itemId), location));
  }
  return { reserved, zohoBatchesByItem };
}

/*
 * Admin > Batches > Receive purchase, from a Zoho bill (client request, 5 Nov 2026). Stock comes in only through
 * Zoho bills, so nothing here posts a Zoho adjustment or changes stock on either side: a batch records which bill
 * line the units came from and what they cost. Zoho calls are kept low: the recent-bills list is one call, a bill's
 * lines are one call when it is picked, and creating batches reads the bill once more (never trusting the browser).
 */
const BILL_LIST_SIZE = 50;
const BILL_CHECK_SETTING = "batch_bill_check";
const BILL_CHECK_MINUTES = 30;
/** Bills Zoho no longer lists are looked up one by one: at most this many per check. */
const BILL_CHECK_LOOKUPS = 10;

function billsPermissionHint(message: string) {
  return /scope|not authorized|unauthori[sz]ed|permission|57\b/i.test(message)
    ? " Zoho has not allowed the website to read bills yet: press Reauthorize Zoho in Admin > Zoho, then try again."
    : "";
}

async function batchGodown(db: Awaited<ReturnType<typeof dbAdmin>>, branchId: string) {
  const { data: branch } = await db.from("branches").select("id,name,code,zoho_location_id,active,vendor_id").eq("id", branchId).maybeSingle();
  if (!branch?.active || branch.vendor_id) throw new Error("Choose an active godown");
  return branch as { id: string; name: string; code: string; zoho_location_id: string; active: boolean; vendor_id: string | null };
}

/** The bill and, per line, its website product, Zoho batch tracking and any batch already made from it. */
async function billWithLines(db: Awaited<ReturnType<typeof dbAdmin>>, billId: string) {
  const { region, organizationId, token } = await zohoOrderContext(db);
  let raw: Record<string, unknown> | undefined;
  try {
    raw = (await inventoryRequest<{ bill?: Record<string, unknown> }>(region, organizationId, token, `bills/${encodeURIComponent(billId)}`, "GET")).bill;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not read the bill from Zoho (${message}).${billsPermissionHint(message)}`);
  }
  if (!raw) throw new Error("Zoho did not return the bill");
  const plan = billPlan(raw);
  const itemIds = [...new Set(plan.lines.map((line) => line.itemId).filter(Boolean))];
  const [{ data: links }, { data: done }] = await Promise.all([
    itemIds.length ? db.from("zoho_item_links").select("product_id,zoho_item_id,track_batches").in("zoho_item_id", itemIds) : Promise.resolve({ data: [] }),
    db.from("batches").select("id,batch_code,zoho_bill_line_id").eq("zoho_bill_id", plan.billId),
  ]);
  const linkOf = new Map(((links ?? []) as { product_id: string; zoho_item_id: string; track_batches: boolean }[]).map((link) => [link.zoho_item_id, link]));
  const doneOf = new Map(((done ?? []) as { id: string; batch_code: string; zoho_bill_line_id: string }[]).map((row) => [row.zoho_bill_line_id, row]));
  const productIds = [...new Set([...linkOf.values()].map((link) => link.product_id))];
  const { data: products } = productIds.length
    ? await db.from("catalog_products").select("id,vendor_id,payload").in("id", productIds)
    : { data: [] };
  const productOf = new Map(((products ?? []) as { id: string; vendor_id: string | null; payload: Record<string, unknown> | null }[])
    .filter((p) => !str(p.vendor_id).startsWith("zoho:")).map((p) => [p.id, str(p.payload?.["name"]) || p.id]));
  const lines = plan.lines.map((line) => {
    const link = linkOf.get(line.itemId);
    const productId = link && productOf.has(link.product_id) ? link.product_id : "";
    const batch = doneOf.get(line.lineId);
    const info = { productId, zohoTracksBatches: Boolean(link?.track_batches), batchCode: batch?.batch_code ?? "" };
    return { ...line, productId, productName: productId ? productOf.get(productId) ?? "" : "", batchId: batch?.id ?? "", batchCode: info.batchCode, blocker: lineBlocker(line, info) };
  });
  return { plan: { ...plan, lines }, bill: raw };
}

export type BatchBillLine = Awaited<ReturnType<typeof billWithLines>>["plan"]["lines"][number];
export type BatchBill = Awaited<ReturnType<typeof billWithLines>>["plan"];

/**
 * Bills being moved to a godown right now (a receive transfer waiting for Zoho), by Zoho bill id. Such a bill can't be
 * received anywhere else until that transfer is retried or cancelled (receive_bill_here, begin_bill_receive).
 */
async function billsBeingMoved(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const [{ data: rows }, { data: branches }] = await Promise.all([
    db.from("batch_transfers").select("transfer_no,to_branch_id,bill").eq("kind", "receive").eq("status", "pending"),
    db.from("branches").select("id,name"),
  ]);
  const nameOf = new Map((branches ?? []).map((b) => [b.id, b.name]));
  const moving = new Map<string, { transferNo: string; godownId: string; godownName: string }>();
  for (const row of rows ?? []) {
    const billId = str(plainObject(row.bill)["bill_id"]);
    if (billId) moving.set(billId, { transferNo: row.transfer_no, godownId: row.to_branch_id, godownName: nameOf.get(row.to_branch_id) ?? row.to_branch_id });
  }
  return moving;
}

/** A Zoho location's name: Zoho's own, else the godown linked to it, else a plain word. */
async function locationNames(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const { data } = await db.from("branches").select("name,zoho_location_id").is("vendor_id", null).neq("zoho_location_id", "");
  const byLocation = new Map(((data ?? []) as { name: string; zoho_location_id: string }[]).map((b) => [b.zoho_location_id, b.name]));
  return (locationId: string, zohoName: string) => zohoName || byLocation.get(locationId) || (locationId ? "another Zoho location" : "");
}

/**
 * Recent Zoho bills, newest first, wherever Zoho has them, with how many of their lines already have a batch. The
 * admin picks the godown where the goods were unloaded; a bill at another Zoho location is moved there on receipt
 * (client, 10 Nov 2026). One Zoho call.
 */
export const listBatchBills = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40) }))
  .handler(async ({ data, context }) => withZohoPurpose("Batches: recent bills", async () => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const branch = await batchGodown(db, data.branchId);
    const { region, organizationId, token } = await zohoOrderContext(db);
    let list: Record<string, unknown>[] = [];
    try {
      const response = await inventoryRequest<{ bills?: Record<string, unknown>[] }>(region, organizationId, token, "bills", "GET", undefined,
        { per_page: String(BILL_LIST_SIZE), sort_column: "date", sort_order: "D" });
      list = response.bills ?? [];
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Could not read bills from Zoho (${message}).${billsPermissionHint(message)}`);
    }
    const [nameOf, moving] = await Promise.all([locationNames(db), billsBeingMoved(db)]);
    const bills = list.map(billSummary).filter((bill) => bill.status !== "void");
    const ids = bills.map((bill) => bill.billId);
    // Bill lines with a batch: a batch sent on to another godown carries the bill too, but no bill line of its own.
    const { data: batched } = ids.length ? await db.from("batches").select("zoho_bill_id").in("zoho_bill_id", ids).neq("zoho_bill_line_id", "") : { data: [] };
    const count = new Map<string, number>();
    for (const row of (batched ?? []) as { zoho_bill_id: string }[]) count.set(row.zoho_bill_id, (count.get(row.zoho_bill_id) ?? 0) + 1);
    return {
      godown: { id: branch.id, name: branch.name, zohoLinked: Boolean(branch.zoho_location_id) },
      bills: bills.map((bill) => ({
        ...bill, locationName: nameOf(bill.locationId, bill.locationName), batchedLines: count.get(bill.billId) ?? 0,
        // Being moved to a godown right now: Retry or Cancel that transfer before receiving it anywhere.
        movingTo: moving.get(bill.billId) ?? null,
        // A bill whose Zoho location is another place: receiving it here moves its units here in Zoho.
        otherLocation: Boolean(bill.locationId && branch.zoho_location_id && bill.locationId !== branch.zoho_location_id),
      })),
    };
  }));

/** One bill with every line's price breakup, product and whether it has a batch, and where Zoho has it. One Zoho call. */
export const getBatchBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40), billId: z.string().trim().min(1).max(40) }))
  .handler(async ({ data, context }) => withZohoPurpose("Batches: one bill", async () => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const branch = await batchGodown(db, data.branchId);
    const { plan } = await billWithLines(db, data.billId);
    const [nameOf, moving] = await Promise.all([locationNames(db), billsBeingMoved(db)]);
    const otherGodown = Boolean(plan.locationId && branch.zoho_location_id && plan.locationId !== branch.zoho_location_id);
    return { bill: { ...plan, locationName: nameOf(plan.locationId, plan.locationName) }, otherGodown, movingTo: moving.get(plan.billId) ?? null };
  }));

/**
 * One batch per chosen bill line, all or none, at the godown where the goods were unloaded (branchId). The bill is
 * read from Zoho again here, so the costs and the bill's location are Zoho's, not the browser's.
 *   Bill already at that godown in Zoho (or Zoho names no location): as before, nothing is sent to Zoho.
 *   Bill at another Zoho location (another godown, Head Office): its units are moved to the godown in Zoho with a
 *   transfer order first, and the batches are made only once Zoho has moved them (see runBatchTransfer).
 */
export const createBatchesFromBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1).max(40),
    billId: z.string().trim().min(1).max(40),
    costBasis: z.enum(["ex_gst", "inc_gst"]),
    lines: z.array(z.object({
      lineId: z.string().trim().min(1).max(40),
      mfgDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
      expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
      notes: z.string().trim().max(300).default(""),
    })).min(1).max(200),
  }))
  .handler(async ({ data, context }) => withZohoPurpose("Batches: from a bill", async () => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const branch = await batchGodown(db, data.branchId);
    const { plan } = await billWithLines(db, data.billId);
    if (plan.status === "void") throw new Error("This bill is void in Zoho. Batches cannot be made from it.");
    const moveFrom = plan.locationId && branch.zoho_location_id && plan.locationId !== branch.zoho_location_id ? plan.locationId : "";
    const byId = new Map(plan.lines.map((line) => [line.lineId, line]));
    const rows = data.lines.map((pick) => {
      const line = byId.get(pick.lineId);
      if (!line) throw new Error("A chosen line is no longer on the bill. Open the bill again.");
      if (line.blocker) throw new Error(`${line.name}: ${line.blocker}`);
      if (pick.mfgDate && pick.expiryDate && pick.expiryDate < pick.mfgDate) throw new Error(`${line.name}: the expiry date is before the manufacture date`);
      return {
        // Two decimals, as the batch keeps it: the units Zoho moves are the units the batch holds.
        line_id: line.lineId, product_id: line.productId, zoho_item_id: line.itemId, qty: Math.round(line.qty * 100) / 100,
        unit_ex_gst: line.unitExGst, unit_inc_gst: line.unitIncGst,
        mfg_date: pick.mfgDate, expiry_date: pick.expiryDate, notes: pick.notes,
        // For the Zoho transfer order when the bill is elsewhere.
        name: line.name, unit: line.unit,
      };
    });
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", context.userId).maybeSingle();
    const bill = { bill_id: plan.billId, bill_number: plan.billNumber, vendor_name: plan.vendorName, date: plan.date, modified: plan.modifiedAt, total: plan.total };
    if (moveFrom) {
      const nameOf = await locationNames(db);
      const { data: begun, error: beginError } = await db.rpc("begin_bill_receive", {
        _branch_id: branch.id, _from_location_id: moveFrom, _from_location_name: nameOf(moveFrom, plan.locationName),
        _bill: bill, _lines: rows, _cost_basis: data.costBasis, _by: context.userId, _by_name: str(profile?.full_name),
      });
      if (beginError || !begun) throw new Error(beginError?.message ?? "Could not start moving the bill");
      const transfer = await runBatchTransfer(db, begun as unknown as BatchTransfer);
      return {
        made: transfer.status === "done" ? (transfer.result ?? []).map((m) => ({ line_id: m.line_id ?? "", batch_id: m.batch_id, batch_code: m.batch_code })) : [],
        billNumber: plan.billNumber, transfer,
      };
    }
    // Refused while the same bill is being moved to another godown (Zoho may have its units there already).
    const { data: made, error } = await db.rpc("receive_bill_here", {
      _branch_id: branch.id, _bill: bill,
      _lines: rows, _cost_basis: data.costBasis, _by: context.userId, _by_name: str(profile?.full_name),
    });
    if (error) throw new Error(error.message);
    return { made: (made ?? []) as { line_id: string; batch_id: string; batch_code: string }[], billNumber: plan.billNumber, transfer: null as BatchTransfer | null };
  }));

// ------------------------------------------------------------------ moving stock between godowns (client, 10 Nov 2026)

/** How long one server call may hold a transfer (claim_batch_transfer): enough for every Zoho call it makes. */
const TRANSFER_CLAIM_SECONDS = 300;

type ZohoInventoryClient = Awaited<ReturnType<typeof openZohoInventory>>;
type ZohoTransferLook =
  | { state: "found"; found: { id: string; number: string; status: string } }
  | { state: "absent" }
  | { state: "error"; message: string };

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const clockInIndia = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

/**
 * Runs work on a transfer while this call holds it (claim_batch_transfer), so no other call creates, cancels or
 * finishes it meanwhile: a double press, two admins, or a press during the stock sync. onBusy when another call holds
 * it. work gets the transfer as it is now. The claim is let go at the end, and runs out by itself if the server stops.
 */
async function withTransferClaim<T>(
  db: Awaited<ReturnType<typeof dbAdmin>>, transferId: number,
  work: (t: BatchTransfer, claim: string) => Promise<T>, onBusy: (t: BatchTransfer) => T | Promise<T>,
): Promise<T> {
  const claim = crypto.randomUUID();
  const { data, error } = await db.rpc("claim_batch_transfer", { _transfer_id: transferId, _claim: claim, _seconds: TRANSFER_CLAIM_SECONDS });
  if (error || !data) throw new Error(error?.message ?? "Transfer not found");
  const t = data as unknown as BatchTransfer;
  if (!t.claimed) return onBusy(t);
  try {
    return await work(t, claim);
  } finally {
    await db.rpc("release_batch_transfer", { _transfer_id: transferId, _claim: claim });
  }
}

/** Pages of Zoho's transfer-order list read when looking a number up; past that, absence can't be confirmed. */
const TRANSFER_LOOKUP_PAGES = 5;

/**
 * Zoho's transfer order for a website transfer: by its saved id, else by its number. A saved id Zoho says no longer
 * exists (deleted there) is checked by number too, so "absent" means Zoho has no transfer order for it at all. The
 * number search reads every page Zoho has (up to TRANSFER_LOOKUP_PAGES of 200): if Zoho ignores the number filter, a
 * transfer further down the list is still found, and when there are more pages than that the answer is an error, never
 * "absent".
 */
async function findZohoTransfer(zoho: ZohoInventoryClient, t: Pick<BatchTransfer, "transfer_no" | "zoho_transfer_order_id">): Promise<ZohoTransferLook> {
  const said = (answer: { status: number; body: Record<string, unknown> | null }) =>
    `Zoho answered ${answer.status}${str(answer.body?.["message"]) ? `: ${str(answer.body?.["message"])}` : ""}`;
  if (t.zoho_transfer_order_id) {
    const got = await zoho.send(`transferorders/${encodeURIComponent(t.zoho_transfer_order_id)}`, "GET");
    const found = got.status >= 200 && got.status < 300 ? readZohoTransfer(got.body?.["transfer_order"]) : null;
    if (found) return { state: "found", found };
    if (!zohoSaysMissing(got.status, got.body)) return { state: "error", message: said(got) };
  }
  for (let page = 1; page <= TRANSFER_LOOKUP_PAGES; page += 1) {
    const list = await zoho.send("transferorders", "GET", undefined, { transfer_order_number: t.transfer_no, page: String(page), per_page: "200" });
    if (list.status < 200 || list.status >= 300) return { state: "error", message: said(list) };
    const found = findTransferByNumber(list.body, t.transfer_no);
    if (found) return { state: "found", found };
    if (plainObject(list.body?.["page_context"])["has_more_page"] !== true) return { state: "absent" };
  }
  return { state: "error", message: `Zoho lists more than ${TRANSFER_LOOKUP_PAGES * 200} transfer orders, so ${t.transfer_no} could not be ruled out` };
}

/**
 * Zoho's own stock now at the godowns a transfer touches: what finish_batch_transfer and cancel_batch_transfer set the
 * moving godowns to, so a stock sync that already pulled the move can't count it twice. Website orders Zoho doesn't hold
 * yet are taken off in the database, under the product's lock, so an order placed while Zoho is read still counts.
 * null when Zoho is not the stock master (the website keeps godown stock itself and moves it by the quantity). Throws
 * when Zoho can't be read: the caller leaves the transfer as it is.
 */
async function transferStockReadings(db: Awaited<ReturnType<typeof dbAdmin>>, t: Pick<BatchTransfer, "from_branch_id" | "to_branch_id" | "lines">): Promise<Json | null> {
  if (!(await isZohoStockMaster(db))) return null;
  const godownIds = [t.from_branch_id, t.to_branch_id].filter((id): id is string => Boolean(id));
  const items = new Map<string, string>();
  for (const line of t.lines ?? []) if (line.product_id && line.zoho_item_id) items.set(line.product_id, line.zoho_item_id);
  if (!godownIds.length || !items.size) return [];
  const [{ data: godowns, error }, { region, organizationId, token }] = await Promise.all([
    db.from("branches").select("id,zoho_location_id").in("id", godownIds),
    zohoOrderContext(db),
  ]);
  if (error) throw new Error("Could not read the godowns");
  const readings: { branch_id: string; product_id: string; stock: number }[] = [];
  for (const [productId, itemId] of items) {
    const item = (await inventoryRequest<{ item?: Record<string, unknown> }>(region, organizationId, token, `items/${encodeURIComponent(itemId)}`, "GET")).item;
    if (!item) throw new Error(`Zoho did not return item ${itemId}`);
    for (const godown of godowns ?? []) {
      if (!godown.zoho_location_id) continue;
      const stock = godownStockFromZohoItem(item, godown.zoho_location_id, 0);
      if (stock !== null) readings.push({ branch_id: godown.id, product_id: productId, stock });
    }
  }
  return readings as unknown as Json;
}

/**
 * Takes one website transfer through Zoho and finishes it here, holding it so no other call works on it meanwhile. The
 * database already set the units aside under a fixed number (GB-TR-…), which is also the transfer order's number in Zoho:
 *   1. Anything sent before (a create whose answer may have been lost, or a known transfer order): look it up in Zoho
 *      first. Create only when Zoho has nothing, and never within CREATE_HOLD_MINUTES of a create whose answer was lost.
 *   2. A bill received elsewhere: mark it received in Zoho (it is already at the unloading godown).
 *   3. Zoho moved it: read Zoho's stock at the two godowns, then finish here (new batches, godown stock).
 * Zoho refused and has nothing under the number: cancelled, the units go back. No clear answer: it stays pending,
 * noted, for Retry. Zoho's stock is never changed any other way.
 * settleOnly (the stock sync): finish or cancel what Zoho already has, but never create, and leave no note when Zoho
 * has nothing yet.
 */
async function runBatchTransfer(db: Awaited<ReturnType<typeof dbAdmin>>, start: Pick<BatchTransfer, "id" | "transfer_no" | "status">,
  options: { settleOnly?: boolean } = {}): Promise<BatchTransfer> {
  return withZohoPurpose(`Batch transfer ${start.transfer_no}`, () => withTransferClaim(db, start.id, async (t, claim) => {
    if (t.status !== "pending") return t;
    const note = async (message: string, zohoId = "", zohoStatus = "", numberTaken = false) => {
      const { data } = await db.rpc("note_batch_transfer_attempt", {
        _transfer_id: t.id, _error: message.slice(0, 480), _zoho_transfer_order_id: zohoId, _zoho_status: zohoStatus, _claim: claim,
        _number_taken: numberTaken,
      });
      return (data ?? { ...t, last_error: message }) as unknown as BatchTransfer;
    };
    // A pending transfer never moved stock here, so a cancel only gives the units back to the super batch (or frees the bill).
    const cancel = async (message: string) => {
      const { data, error } = await db.rpc("cancel_batch_transfer", { _transfer_id: t.id, _reason: message.slice(0, 480), _by: null, _stock: null, _claim: claim });
      if (error) throw new Error(error.message);
      return data as unknown as BatchTransfer;
    };
    const waitNote = (until: number) => `Zoho may still be making ${t.transfer_no}: its answer was lost. Retry looks the number up in Zoho first and never makes a second one; if Zoho doesn't show it yet, Retry again after ${clockInIndia(until)}.`;
    let found: { id: string; status: string } | null = null;
    try {
      const zoho = await openZohoInventory();
      const today = todayInIndia();
      if (t.zoho_transfer_order_id || t.create_sent_at) {
        const look = await findZohoTransfer(zoho, t);
        if (look.state === "error") return await note(`Could not look ${t.transfer_no} up in Zoho (${look.message}). Press Retry.`);
        if (look.state === "found") found = look.found;
      }
      if (!found && options.settleOnly) return t;
      if (!found) {
        const hold = createHoldUntil({ create_sent_at: t.create_sent_at ?? null, zoho_transfer_order_id: "" });
        if (hold) return await note(waitNote(hold));
        // Written down before the create goes out: if its answer is lost, the next try looks it up instead.
        const { error: sentError } = await db.rpc("note_batch_transfer_create", { _transfer_id: t.id, _claim: claim });
        if (sentError) return await note(`Could not start ${t.transfer_no}: ${sentError.message}. Press Retry.`);
        const created = await zoho.send("transferorders", "POST", transferOrderBody(t, today), { ignore_auto_number_generation: "true" });
        const answer = readCreateAnswer(created.status, created.body);
        if (answer.kind === "created") found = { id: answer.id, status: answer.status };
        else if (answer.kind === "unknown") return await note(`${answer.message}. ${waitNote(Date.now() + CREATE_HOLD_MINUTES * 60_000)}`);
        else {
          // Zoho said no, or that the number is taken: look the number up before deciding (the wording is not proof).
          const look = await findZohoTransfer(zoho, { transfer_no: t.transfer_no, zoho_transfer_order_id: "" });
          const said = answer.kind === "refused" ? answer.message : "the number is taken";
          if (look.state === "error") return await note(`Zoho answered "${said}", and looking ${t.transfer_no} up failed (${look.message}). Press Retry.`);
          if (look.state === "found") found = look.found;
          else if (answer.kind === "refused") return await cancel(`Zoho refused transfer ${t.transfer_no}: ${answer.message}.${zohoPermissionHint(answer.message)}`);
          // Zoho says it has the number but can't show it: remembered, so Cancel won't give the units back on a guess.
          else return await note(`Zoho says ${t.transfer_no} already exists but its list does not show it. Find it in Zoho (Inventory > Transfer Orders): void it there and press Cancel, or press Retry.`, "", "", true);
        }
      }
      if (found.status === "void") return await cancel(`Transfer ${t.transfer_no} is void in Zoho, so nothing moved.`);
      // A bill received at its unloading godown is already there: received at once. A batch sent to another godown stays
      // in transit until that godown marks it received (markTransferReceived).
      if (t.kind === "receive" && !isTransferred(found.status)) {
        await zoho.send(`transferorders/${encodeURIComponent(found.id)}/markastransferred`, "POST", undefined, { date: today });
        const again = await zoho.send(`transferorders/${encodeURIComponent(found.id)}`, "GET");
        found = readZohoTransfer(again.body?.["transfer_order"]) ?? found;
      }
    } catch (cause) {
      // No answer at all (network, timeout): it may or may not be in Zoho. Retry looks it up.
      return await note(`Zoho did not answer: ${errorText(cause)}. Press Retry in a few minutes: it looks ${t.transfer_no} up in Zoho first.`, found?.id ?? "", found?.status ?? "");
    }
    let stock: Json | null = null;
    if (isTransferred(found.status) || (t.kind === "split" && found.status === "in_transit")) {
      try {
        stock = await transferStockReadings(db, t);
      } catch (cause) {
        return await note(`Zoho moved it (${t.transfer_no}), but Zoho's stock could not be read (${errorText(cause)}). Press Retry to finish here.`, found.id, found.status);
      }
    }
    const { data, error } = await db.rpc("finish_batch_transfer", {
      _transfer_id: t.id, _zoho_transfer_order_id: found.id, _zoho_status: found.status, _actor: null, _stock: stock, _claim: claim,
    });
    if (error) return await note(`Zoho moved it (${t.transfer_no}), but the website could not finish: ${error.message}. Press Retry.`, found.id, found.status);
    return data as unknown as BatchTransfer;
  }, (busy) => ({ ...busy, last_error: `${busy.transfer_no} is being sent to Zoho by another request right now. Refresh in a minute.` })));
}

async function adminName(db: Awaited<ReturnType<typeof dbAdmin>>, userId: string) {
  const { data } = await db.from("profiles").select("full_name,email").eq("id", userId).maybeSingle();
  return str(data?.full_name).trim() || str(data?.email).trim() || `Admin ${userId.slice(0, 8)}`;
}

/**
 * Sends part of a batch (the super batch) to one or more other godowns: a Zoho transfer order and a new batch for each.
 * requestId is the Send dialog's own key: pressing Send again after a lost answer gets the transfers the first press
 * began (and carries them on), never a second set.
 */
export const sendBatchToGodowns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    batchId: z.string().uuid(),
    targets: z.array(z.object({ branchId: z.string().trim().min(1).max(40), qty: z.number().positive().max(1_000_000) })).min(1).max(10),
    requestId: z.string().uuid(),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: begun, error } = await db.rpc("begin_batch_split", {
      _batch_id: data.batchId, _targets: data.targets.map((t) => ({ branch_id: t.branchId, qty: Math.round(t.qty * 100) / 100 })),
      _by: context.userId, _by_name: await adminName(db, context.userId), _request: data.requestId,
    });
    if (error || !begun) throw new Error(error?.message ?? "Could not start the transfer");
    const results: BatchTransfer[] = [];
    // One at a time: each is its own Zoho transfer order.
    for (const transfer of begun as unknown as BatchTransfer[]) results.push(await runBatchTransfer(db, transfer));
    return results;
  });

/**
 * Who may mark a transfer received at a godown: an administrator, or that godown's active staff or channel partner.
 * Checked before anything is written to Zoho; the database checks it again when it finishes.
 */
async function godownReceiver(db: Awaited<ReturnType<typeof dbAdmin>>, userId: string, branchId: string) {
  const [{ data: admin }, { data: staff }, { data: partner }] = await Promise.all([
    db.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
    db.from("staff_employees").select("name").eq("user_id", userId).eq("status", "active").eq("branch_id", branchId).maybeSingle(),
    db.from("channel_partners").select("name").eq("user_id", userId).eq("status", "active").eq("branch_id", branchId).maybeSingle(),
  ]);
  return Boolean(admin || staff || partner);
}

/** The godown of a signed-in godown staff member or channel partner, or null for anyone else. */
async function godownOfUser(db: Awaited<ReturnType<typeof dbAdmin>>, userId: string) {
  const [{ data: staff }, { data: partner }] = await Promise.all([
    db.from("staff_employees").select("branch_id").eq("user_id", userId).eq("status", "active").maybeSingle(),
    db.from("channel_partners").select("branch_id").eq("user_id", userId).eq("status", "active").maybeSingle(),
  ]);
  return staff?.branch_id ?? partner?.branch_id ?? null;
}

/** What the staff and partner apps may see of a transfer (GodownTransfer): no bill, costs, Zoho ids or errors. */
function godownTransferView(t: BatchTransfer): GodownTransfer & { last_error: string } {
  return {
    id: t.id, transfer_no: t.transfer_no, kind: t.kind, status: t.status,
    from_branch_id: t.from_branch_id, from_location_name: t.from_location_name, from_name: t.from_name ?? null,
    to_branch_id: t.to_branch_id, to_name: t.to_name, parent_batch_code: t.parent_batch_code,
    quantity: t.quantity === null ? null : Number(t.quantity),
    lines: godownTransferLines(t.lines), result: godownTransferResult(t.result),
    created_at: t.created_at, created_by_name: t.created_by_name, sent_at: t.sent_at ?? null, received_at: t.received_at ?? null,
    received_by_name: t.received_by_name ?? "", received_by_role: t.received_by_role ?? null,
    // Only a cancel says why (voided or deleted in Zoho: nothing arrived, units back at the sending godown).
    last_error: t.status === "cancelled" ? t.last_error : "",
  };
}

/**
 * The receiving godown marks a batch sent to it as received (owner, 10 Nov 2026): Zoho's transfer order is marked
 * received, then the new batch is made at that godown and its stock is set from Zoho. Pressing twice, or after Zoho
 * already shows it received, finishes it once. One voided or deleted in Zoho meanwhile is cancelled instead: nothing
 * arrived, and the units are back at the sending godown (the answer says so, status "cancelled").
 */
export const markTransferReceived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ transferId: z.number().int().positive() }))
  .handler(async ({ data, context }) => withZohoPurpose("Batch transfer: received at the godown", async () => {
    const db = await dbAdmin();
    const { data: row, error } = await db.from("batch_transfers").select("id,to_branch_id").eq("id", data.transferId).maybeSingle();
    if (error || !row) throw new Error("Transfer not found");
    if (!(await godownReceiver(db, context.userId, row.to_branch_id)))
      throw new Error("Only the receiving godown's staff, its channel partner or the office can mark this received");
    return withTransferClaim(db, row.id, async (t, claim) => {
      if (t.status === "done") throw new Error(`Transfer ${t.transfer_no} is already received`);
      if (t.status === "cancelled") throw new Error(`Transfer ${t.transfer_no} was cancelled: nothing arrived. Tell the office if goods did arrive.`);
      if (t.status !== "in_transit") throw new Error(`Transfer ${t.transfer_no} is not on its way yet. Refresh the page.`);
      const zoho = await openZohoInventory();
      const look = await findZohoTransfer(zoho, t);
      if (look.state === "error") throw new Error(`Could not read transfer ${t.transfer_no} from Zoho (${look.message}). Nothing changed; try again.`);
      if (look.state === "absent" || look.found.status === "void") {
        // Zoho no longer has it on the way: the units are back at the sending godown in Zoho.
        const why = look.state === "absent" ? "deleted in Zoho" : "voided in Zoho";
        let stock: Json | null;
        try {
          stock = await transferStockReadings(db, t);
        } catch (cause) {
          throw new Error(`Transfer ${t.transfer_no} was ${why}, but Zoho's stock could not be read (${errorText(cause)}). Nothing changed; try again.`);
        }
        const { data: cancelled, error: cancelError } = await db.rpc("cancel_batch_transfer", {
          _transfer_id: t.id, _reason: `Transfer ${t.transfer_no} was ${why}: nothing arrived, and the units are back at ${t.from_name || "the sending godown"}.`,
          _by: null, _stock: stock, _claim: claim,
        });
        if (cancelError) throw new Error(cancelError.message);
        return godownTransferView(cancelled as unknown as BatchTransfer);
      }
      let found = look.found;
      if (!isTransferred(found.status)) {
        let marked: { status: number; body: Record<string, unknown> | null } | null = null;
        try {
          marked = await zoho.send(`transferorders/${encodeURIComponent(found.id)}/markastransferred`, "POST", undefined, { date: todayInIndia() });
        } catch {
          marked = null;
        }
        const again = await findZohoTransfer(zoho, { transfer_no: t.transfer_no, zoho_transfer_order_id: found.id }).catch(() => null);
        if (again?.state === "found") found = again.found;
        if (!isTransferred(found.status)) {
          // Without a clear answer Zoho may have marked it received anyway: pressing again reads it and finishes here.
          if (!marked || marked.status >= 500 || again?.state !== "found")
            throw new Error(`Zoho gave no clear answer for ${t.transfer_no}. It may be marked received there already: press Mark received again to finish here.`);
          const message = str(marked.body?.["message"]);
          throw new Error(`Zoho did not mark ${t.transfer_no} received${message ? `: ${message}` : ""}.${zohoPermissionHint(message)} Nothing changed; try again.`);
        }
      }
      let stock: Json | null;
      try {
        stock = await transferStockReadings(db, t);
      } catch (cause) {
        throw new Error(`Zoho shows ${t.transfer_no} received, but Zoho's stock could not be read (${errorText(cause)}). Press Mark received again to finish here.`);
      }
      const { data: done, error: finishError } = await db.rpc("finish_batch_transfer", {
        _transfer_id: t.id, _zoho_transfer_order_id: found.id, _zoho_status: found.status, _actor: context.userId, _stock: stock, _claim: claim,
      });
      if (finishError) throw new Error(finishError.message);
      return godownTransferView(done as unknown as BatchTransfer);
    }, (busy) => {
      throw new Error(`${busy.transfer_no} is being worked on right now (by the office, or the stock check). Refresh in a minute.`);
    });
  }));

/**
 * For the staff and partner apps: batches sent between the signed-in person's godown and others. Everything on its way
 * (to them, to mark received; from them, to see it is travelling), then the latest arrivals, with where from and where
 * to. Only what moves, how many, where and who: no bill, costs, supplier, Zoho ids or errors, which are the office's.
 */
export const listGodownTransfers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await dbAdmin();
    const branchId = await godownOfUser(db, context.userId);
    if (!branchId) return { godownId: null as string | null, transfers: [] as GodownTransfer[] };
    const fields = "id,transfer_no,kind,status,from_branch_id,from_location_name,to_branch_id,parent_batch_id,quantity,lines,result,created_at,created_by_name,sent_at,received_at,received_by_name,received_by_role";
    const mine = `to_branch_id.eq.${branchId},from_branch_id.eq.${branchId}`;
    const [onTheWay, arrived] = await Promise.all([
      db.from("batch_transfers").select(fields).eq("kind", "split").eq("status", "in_transit").or(mine).order("id", { ascending: false }),
      db.from("batch_transfers").select(fields).eq("kind", "split").eq("status", "done").or(mine).order("id", { ascending: false }).limit(10),
    ]);
    if (onTheWay.error || arrived.error) throw new Error("Could not read the transfers");
    const rows = [...(onTheWay.data ?? []), ...(arrived.data ?? [])];
    const parentIds = [...new Set(rows.map((r) => r.parent_batch_id).filter((id): id is string => Boolean(id)))];
    const [{ data: branches }, { data: parents }] = await Promise.all([
      db.from("branches").select("id,name"),
      parentIds.length ? db.from("batches").select("id,batch_code").in("id", parentIds) : Promise.resolve({ data: [] as { id: string; batch_code: string }[] }),
    ]);
    const nameOf = new Map((branches ?? []).map((b) => [b.id, b.name]));
    const codeOf = new Map((parents ?? []).map((b) => [b.id, b.batch_code]));
    return {
      godownId: branchId,
      transfers: rows.map((t): GodownTransfer => ({
        id: t.id, transfer_no: t.transfer_no, kind: t.kind as GodownTransfer["kind"], status: t.status as GodownTransfer["status"],
        from_branch_id: t.from_branch_id, from_location_name: t.from_location_name,
        from_name: t.from_branch_id ? nameOf.get(t.from_branch_id) ?? t.from_location_name : t.from_location_name,
        to_branch_id: t.to_branch_id, to_name: nameOf.get(t.to_branch_id) ?? t.to_branch_id,
        parent_batch_code: t.parent_batch_id ? codeOf.get(t.parent_batch_id) ?? null : null,
        quantity: t.quantity === null ? null : Number(t.quantity),
        lines: godownTransferLines(t.lines), result: godownTransferResult(t.result),
        created_at: t.created_at, created_by_name: t.created_by_name, sent_at: t.sent_at, received_at: t.received_at,
        received_by_name: t.received_by_name, received_by_role: (t.received_by_role ?? null) as "admin" | "staff" | "partner" | "zoho" | null,
      })),
    };
  });

/** Tries a pending transfer again: looks it up in Zoho by its number first, then finishes it. */
export const retryBatchTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ transferId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: row, error } = await db.from("batch_transfers").select("id,transfer_no,status").eq("id", data.transferId).maybeSingle();
    if (error || !row) throw new Error("Transfer not found");
    if (row.status !== "pending") throw new Error(`Transfer ${row.transfer_no} is not waiting any more. Refresh the page.`);
    return runBatchTransfer(db, { id: row.id, transfer_no: row.transfer_no, status: "pending" });
  });

/**
 * Cancels a transfer once Zoho is seen not to have it (no transfer order under its id or number, or Zoho's is void).
 * Waiting for Zoho: the units go back to the super batch, or the bill can be received again; not within
 * CREATE_HOLD_MINUTES of a create whose answer was lost, as Zoho may still be making it. On its way (voided or deleted in
 * Zoho): the units are back at the sending godown in Zoho, so they go back on the super batch and its godown's stock.
 */
export const cancelBatchTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // anyway: the admin checked Zoho by hand after Zoho said "number already exists" without listing it.
  .validator(z.object({ transferId: z.number().int().positive(), anyway: z.boolean().default(false) }))
  .handler(async ({ data, context }) => withZohoPurpose("Batch transfer: cancel", async () => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const who = await adminName(db, context.userId);
    return withTransferClaim(db, data.transferId, async (t, claim) => {
      if (t.status === "cancelled") return t;
      if (t.status === "done") throw new Error(`Transfer ${t.transfer_no} is done: its units are at ${t.to_name ?? "the other godown"}.`);
      const zoho = await openZohoInventory();
      const look = await findZohoTransfer(zoho, t);
      if (look.state === "error") throw new Error(`Could not check ${t.transfer_no} in Zoho (${look.message}), so it can't be cancelled yet. Try again.`);
      if (t.status === "pending" && look.state === "absent") {
        // A create whose answer was lost may still land (even when an older, deleted transfer order's id is saved here).
        const hold = createHoldUntil({ create_sent_at: t.create_sent_at ?? null, zoho_transfer_order_id: "" });
        if (hold) throw new Error(`Zoho may still be making ${t.transfer_no} (its answer was lost). Cancel works from ${clockInIndia(hold)}, once Zoho has had time; or press Retry, which looks it up first.`);
        if (t.zoho_number_taken && !data.anyway) throw new Error(`Zoho said ${t.transfer_no} already exists but does not list it. Look in Zoho (Inventory > Transfer Orders): if it is there, void it; then press "Cancel anyway".`);
      }
      if (look.state === "found" && look.found.status !== "void")
        throw new Error(t.status === "in_transit"
          ? `Zoho has ${t.transfer_no} on its way (${look.found.status}). Mark it received when it arrives, or void or delete it in Zoho first and then cancel.`
          : `Zoho has transfer ${t.transfer_no} (${look.found.status}). Press Retry to finish it, or void it in Zoho first and then cancel.`);
      let stock: Json | null = null;
      if (t.status === "in_transit") {
        try {
          stock = await transferStockReadings(db, t);
        } catch (cause) {
          throw new Error(`Could not read Zoho's stock for ${t.transfer_no} (${errorText(cause)}). Nothing changed; try again.`);
        }
      }
      const { data: done, error } = await db.rpc("cancel_batch_transfer", {
        _transfer_id: t.id, _reason: `Cancelled by ${who}: ${look.state === "absent" ? (data.anyway ? "not in Zoho (checked by hand)" : "not in Zoho") : "void in Zoho"}`, _by: context.userId, _stock: stock, _claim: claim,
      });
      if (error) throw new Error(error.message);
      return done as unknown as BatchTransfer;
    }, (busy) => {
      throw new Error(`${busy.transfer_no} is being worked on right now. Try again in a minute.`);
    });
  }));

/**
 * Transfers between godowns not yet settled, checked against Zoho at each stock sync, before godown stock is pulled:
 *   on its way and marked received in Zoho itself: finished here (its batch made, the receiving godown's stock from
 *   Zoho), as if the godown had pressed Mark received;
 *   on its way and voided or deleted in Zoho: cancelled, the units back on the super batch and at the sending godown;
 *   waiting for Zoho, once anything was sent (a create whose answer was lost, or a known transfer order): finished or
 *   cancelled if Zoho already has it, as Retry would, but never created from here.
 * holdBack: godown and product pairs of every transfer this could not settle (still waiting for Zoho, an error, another
 * call holding it), at both godowns. The stock sync neither pulls nor pushes those pairs until the transfer is settled:
 * Zoho may already count units the website has not recorded yet, and a waiting website stock edit sent over them would
 * create or lose them in Zoho. A transfer simply on its way (Zoho agrees) holds nothing back.
 */
async function reconcileTransfersOnTheWay(db: Awaited<ReturnType<typeof dbAdmin>>) {
  const summary = { checked: 0, received: 0, cancelled: 0, failed: 0, heldBack: 0, errors: [] as string[] };
  const holdBack = new Set<string>();
  const { data: rows, error } = await db.from("batch_transfers")
    .select("id,transfer_no,kind,status,from_branch_id,to_branch_id,product_id,lines,zoho_transfer_order_id,create_sent_at")
    .in("status", ["pending", "in_transit"]).order("id");
  if (error) {
    summary.failed += 1;
    summary.errors.push(`Transfers between godowns could not be read, so godown stock was left alone this run: ${error.message}`.slice(0, 300));
    return { summary, holdBack, holdAll: true };
  }
  const hold = (row: { from_branch_id: string | null; to_branch_id: string; product_id: string | null; lines: Json }) => {
    const products = new Set<string>(row.product_id ? [row.product_id] : []);
    for (const line of godownTransferLines(row.lines)) if (line.product_id) products.add(line.product_id);
    for (const godown of [row.from_branch_id, row.to_branch_id]) if (godown) for (const product of products) holdBack.add(`${godown}|${product}`);
  };
  let zoho: ZohoInventoryClient | null = null;
  for (const row of rows ?? []) {
    try {
      if (row.status === "pending") {
        // Never sent to Zoho: nothing there to settle, but the send already took the units off the sending godown.
        if (!row.zoho_transfer_order_id && !row.create_sent_at) {
          hold(row);
          continue;
        }
        const after = await runBatchTransfer(db, { id: row.id, transfer_no: row.transfer_no, status: "pending" }, { settleOnly: true });
        summary.checked += 1;
        if (after.status === "done") summary.received += 1;
        if (after.status === "cancelled") summary.cancelled += 1;
        if (after.status === "pending") hold(row);
        continue;
      }
      const client = zoho ?? (zoho = await openZohoInventory());
      const outcome = await withTransferClaim(db, row.id, async (t, claim) => {
        if (t.status !== "in_transit") return "settled" as const;
        const look = await findZohoTransfer(client, t);
        if (look.state === "error") throw new Error(look.message);
        if (look.state === "found" && look.found.status !== "void" && !isTransferred(look.found.status)) return "on_the_way" as const;
        const stock = await transferStockReadings(db, t);
        if (look.state === "found" && isTransferred(look.found.status)) {
          const { error: finishError } = await db.rpc("finish_batch_transfer", {
            _transfer_id: t.id, _zoho_transfer_order_id: look.found.id, _zoho_status: look.found.status, _actor: null, _stock: stock, _claim: claim,
          });
          if (finishError) throw new Error(finishError.message);
          return "received" as const;
        }
        const why = look.state === "absent" ? "deleted in Zoho" : "voided in Zoho";
        const { error: cancelError } = await db.rpc("cancel_batch_transfer", {
          _transfer_id: t.id, _reason: `Transfer ${t.transfer_no} was ${why}: nothing arrived, and the units are back at ${t.from_name || "the sending godown"}.`,
          _by: null, _stock: stock, _claim: claim,
        });
        if (cancelError) throw new Error(cancelError.message);
        return "cancelled" as const;
      }, () => "busy" as const);
      summary.checked += 1;
      if (outcome === "received") summary.received += 1;
      else if (outcome === "cancelled") summary.cancelled += 1;
      else if (outcome === "busy") hold(row);
    } catch (cause) {
      summary.failed += 1;
      hold(row);
      summary.errors.push(`${row.transfer_no}: ${errorText(cause)}`.slice(0, 300));
    }
  }
  summary.heldBack = holdBack.size;
  summary.errors = summary.errors.slice(0, 10);
  return { summary, holdBack, holdAll: false };
}

/**
 * Flags batches whose bill was edited, voided or deleted in Zoho since the batches were made. Runs when the Batches
 * page opens, at most every 30 minutes: one bills list call, plus one call per bill Zoho no longer lists (at most 10).
 * Batches are never changed, only flagged.
 */
export const checkBatchBills = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => withZohoPurpose("Batches: bill check", async () => {
    await ensureAdmin(context.supabase, context.userId);
    const db = await dbAdmin();
    const { data: setting } = await db.from("settings").select("value").eq("key", BILL_CHECK_SETTING).maybeSingle();
    const last = Date.parse(str(plainObject(setting?.value)["at"]));
    if (Number.isFinite(last) && Date.now() - last < BILL_CHECK_MINUTES * 60_000) return { checked: false as const, flagged: 0 };
    const { data: rows } = await db.from("batches").select("zoho_bill_id,zoho_bill_modified,zoho_bill_total").neq("zoho_bill_id", "");
    const stored = new Map<string, { modifiedAt: string; total: number }>();
    for (const row of (rows ?? []) as { zoho_bill_id: string; zoho_bill_modified: string; zoho_bill_total: number | null }[])
      if (!stored.has(row.zoho_bill_id)) stored.set(row.zoho_bill_id, { modifiedAt: row.zoho_bill_modified, total: Number(row.zoho_bill_total) || 0 });
    await db.from("settings").upsert({ key: BILL_CHECK_SETTING, value: { at: new Date().toISOString() } as Json, is_public: false, updated_at: new Date().toISOString() });
    if (!stored.size) return { checked: true as const, flagged: 0 };
    const { region, organizationId, token } = await zohoOrderContext(db);
    const list = (await inventoryRequest<{ bills?: Record<string, unknown>[] }>(region, organizationId, token, "bills", "GET", undefined,
      { per_page: "200", sort_column: "last_modified_time", sort_order: "D" })).bills ?? [];
    const seen = new Map(list.map(billSummary).map((bill) => [bill.billId, bill]));
    const flags: { bill_id: string; flag: string }[] = [];
    let lookups = 0;
    for (const [billId, was] of stored) {
      let now: { status: string; modifiedAt: string; total: number } | null | undefined = seen.get(billId);
      if (!now) {
        // Not among the 200 most recently changed bills: unchanged, voided far back, or deleted. Ask Zoho, a few at a time.
        if (lookups >= BILL_CHECK_LOOKUPS) continue;
        lookups += 1;
        try {
          const bill = (await inventoryRequest<{ bill?: Record<string, unknown> }>(region, organizationId, token, `bills/${encodeURIComponent(billId)}`, "GET")).bill;
          now = bill ? billSummary(bill) : null;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (!/does not exist|not found|invalid.*bill|1002/i.test(message)) continue;
          now = null;
        }
      }
      flags.push({ bill_id: billId, flag: billChange(was, now) });
    }
    const { data: flagged, error } = await db.rpc("flag_batch_bill_changes", { _rows: flags });
    if (error) throw new Error(error.message);
    return { checked: true as const, flagged: Number(flagged) || 0 };
  }));

/**
 * One Zoho Inventory request and its raw answer, for the rice sample desk's purchase orders, where it matters whether Zoho
 * could have acted on a request. Never resends (inventoryRequest resends on a 429); throws only when no answer came back.
 * Goes through this file's fetch, so the call is logged.
 */
export async function openZohoInventory() {
  const db = await dbAdmin();
  const { region, organizationId, token } = await zohoOrderContext(db);
  const send = async (resource: string, method: "GET" | "POST", body?: Record<string, unknown>, query: Record<string, string> = {}) => {
    const response = await fetch(inventoryApi(region, resource, organizationId, query), {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed: unknown = await response.json().catch(() => null);
    const answer = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    if (isZohoDailyLimitError(str(answer?.["message"]))) await pauseZohoForDailyLimit(db);
    return { status: response.status, body: answer };
  };
  return { region: region as string, organizationId, send };
}
