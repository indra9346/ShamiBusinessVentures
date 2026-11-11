import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_BODY_BYTES, MAX_WAITING, handleInboxRequest } from "../supabase/functions/zoho-webhook/handler.ts";
import { MAX_INBOX_ATTEMPTS, drainWebhookInbox, webhookRecordFrom, type InboxDeps, type InboxRow, type WebhookRecord } from "../src/lib/zoho-webhook-inbox.ts";
import { verifyZohoSignature } from "../src/lib/zoho-sync-core.ts";

const SECRET = "TestWebhookSecret123";
// Worked out here on its own, the way live Zoho calls were confirmed to be signed: hex HMAC-SHA256 of the raw JSON.
const zohoSign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

const invoiceBody = JSON.stringify({ invoice: { invoice_id: "111", salesorder_id: "222", reference_number: "SO-1", total_formatted: "₹15,20,820.00", terms: "Line one\nLine two" } });
const orderBody = JSON.stringify({ salesorder: { salesorder_id: "333" } });
const itemBody = JSON.stringify({ item: { item_id: "444" } });

test("finds the record a Zoho call is about", () => {
  assert.deepEqual(webhookRecordFrom(orderBody), { kind: "salesorder", id: "333" });
  assert.deepEqual(webhookRecordFrom(itemBody), { kind: "item", id: "444" });
  assert.deepEqual(webhookRecordFrom(invoiceBody), { kind: "invoice", id: "111", salesOrderId: "222", reference: "SO-1" });
  assert.deepEqual(webhookRecordFrom(`JSONString=${encodeURIComponent(orderBody)}`), { kind: "salesorder", id: "333" });
  assert.equal(webhookRecordFrom("{}"), null);
  assert.equal(webhookRecordFrom("not json at all"), null);
});

// ---- the Edge Function
function fakeSupabase(options: { waiting?: number; storeStatus?: number; countStatus?: number } = {}) {
  const inserted: Array<Record<string, string | null>> = [];
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchFake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url: String(input), method, headers: init.headers as Record<string, string> });
    if (method === "GET") {
      return new Response("[]", { status: options.countStatus ?? 206, headers: { "content-range": `0-0/${options.waiting ?? 0}` } });
    }
    const status = options.storeStatus ?? 201;
    if (status < 300) inserted.push(JSON.parse(String(init.body)));
    return new Response(null, { status });
  }) as typeof fetch;
  return { inserted, calls, fetch: fetchFake };
}
const environment = (fake: ReturnType<typeof fakeSupabase>) => ({ url: "https://db.example.co/", serviceKey: "server-key", fetch: fake.fetch });
const zohoCall = (body: string, signature: string | null = zohoSign(body), url = "https://db.example.co/functions/v1/zoho-webhook") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-zoho-webhook-signature": signature } : {}) },
    body,
  });

test("the Edge Function parks a signed call exactly as Zoho sent it", async () => {
  const fake = fakeSupabase();
  const response = await handleInboxRequest(zohoCall(invoiceBody, zohoSign(invoiceBody), "https://db.example.co/functions/v1/zoho-webhook?a=1"), environment(fake));
  assert.equal(response.status, 200);
  assert.deepEqual(fake.inserted, [{ body: invoiceBody, signature: zohoSign(invoiceBody), content_type: "application/json", query: "a=1" }]);
  assert.equal(fake.calls[1]?.url, "https://db.example.co/rest/v1/zoho_webhook_inbox");
  assert.equal(fake.calls[1]?.headers["Authorization"], "Bearer server-key");
});

test("the Edge Function turns away what is not a signed Zoho call", async () => {
  const fake = fakeSupabase();
  assert.equal((await handleInboxRequest(new Request("https://x.co/f"), environment(fake))).status, 405);
  assert.equal((await handleInboxRequest(zohoCall(orderBody, null), environment(fake))).status, 401);
  assert.equal((await handleInboxRequest(zohoCall(orderBody, "short"), environment(fake))).status, 401);
  assert.equal((await handleInboxRequest(zohoCall("x".repeat(MAX_BODY_BYTES + 1)), environment(fake))).status, 413);
  assert.equal(fake.inserted.length, 0);
  assert.equal(fake.calls.length, 0, "nothing touches the database for these");
});

test("when it cannot store, the Edge Function tells Zoho to try again", async () => {
  const full = fakeSupabase({ waiting: MAX_WAITING });
  assert.equal((await handleInboxRequest(zohoCall(orderBody), environment(full))).status, 503);
  assert.equal(full.inserted.length, 0);
  assert.equal((await handleInboxRequest(zohoCall(orderBody), environment(fakeSupabase({ storeStatus: 500 })))).status, 500);
  assert.equal((await handleInboxRequest(zohoCall(orderBody), environment(fakeSupabase({ countStatus: 500 })))).status, 500);
  assert.equal((await handleInboxRequest(zohoCall(orderBody), { url: undefined, serviceKey: undefined, fetch })).status, 500);
});

// ---- the 15-minute job
let nextId = 1;
const row = (body: string, signature = zohoSign(body), extra: Partial<InboxRow> = {}): InboxRow =>
  ({ id: nextId++, body, signature, content_type: "application/json", query: "", attempts: 0, ...extra });

function inbox(rows: InboxRow[], apply: (record: WebhookRecord) => Promise<unknown> = async () => "applied", secrets = [SECRET]) {
  const state = { rows: [...rows], applied: [] as WebhookRecord[], logs: [] as string[] };
  const deps: InboxDeps = {
    secrets,
    verify: verifyZohoSignature,
    load: async (limit) => state.rows.slice(0, limit),
    remove: async (ids) => { state.rows = state.rows.filter((r) => !ids.includes(r.id)); },
    setAttempts: async (ids, attempts) => { state.rows = state.rows.map((r) => (ids.includes(r.id) ? { ...r, attempts } : r)); },
    apply: async (record) => { state.applied.push(record); return apply(record); },
    log: (event) => state.logs.push(event),
  };
  return { state, deps };
}

test("a real signed call goes all the way through: Zoho to Supabase to the website", async () => {
  const fake = fakeSupabase();
  assert.equal((await handleInboxRequest(zohoCall(invoiceBody), environment(fake))).status, 200);
  const stored = fake.inserted[0]!;
  const { state, deps } = inbox([{ id: nextId++, body: String(stored["body"]), signature: String(stored["signature"]), content_type: stored["content_type"] ?? null, query: String(stored["query"]), attempts: 0 }]);
  const result = await drainWebhookInbox(deps);
  assert.deepEqual(state.applied, [{ kind: "invoice", id: "111", salesOrderId: "222", reference: "SO-1" }]);
  assert.equal(result.applied, 1);
  assert.equal(state.rows.length, 0, "customer details do not stay in the inbox");
});

test("a badly signed call is deleted and never applied", async () => {
  const { state, deps } = inbox([row(orderBody, zohoSign(orderBody, "SomeOtherSecret999")), row(itemBody, "f".repeat(64))]);
  const result = await drainWebhookInbox(deps);
  assert.equal(result.rejected, 2);
  assert.equal(state.applied.length, 0);
  assert.equal(state.rows.length, 0);
  assert.ok(state.logs.includes("webhook_inbox_rejected"));
});

test("a body changed after signing is refused", async () => {
  const { state, deps } = inbox([row(orderBody.replace("333", "999"), zohoSign(orderBody))]);
  assert.equal((await drainWebhookInbox(deps)).rejected, 1);
  assert.equal(state.applied.length, 0);
});

test("each webhook's own secret is accepted when several are set", async () => {
  const { state, deps } = inbox([row(itemBody, zohoSign(itemBody, "SecondSecret456789"))], undefined, [SECRET, "SecondSecret456789"]);
  assert.equal((await drainWebhookInbox(deps)).applied, 1);
  assert.equal(state.rows.length, 0);
});

test("several calls about one record cost one Zoho read, using the newest", async () => {
  const older = JSON.stringify({ invoice: { invoice_id: "111", salesorder_id: "", reference_number: "" } });
  const { state, deps } = inbox([row(older), row(invoiceBody), row(orderBody)]);
  const result = await drainWebhookInbox(deps);
  assert.equal(result.read, 3);
  assert.deepEqual(state.applied, [{ kind: "invoice", id: "111", salesOrderId: "222", reference: "SO-1" }, { kind: "salesorder", id: "333" }]);
  assert.equal(state.rows.length, 0);
});

test("a signed call about nothing we track is cleared without a Zoho read", async () => {
  const body = JSON.stringify({ hello: "world" });
  const { state, deps } = inbox([row(body)]);
  assert.equal((await drainWebhookInbox(deps)).ignored, 1);
  assert.equal(state.applied.length, 0);
  assert.equal(state.rows.length, 0);
});

test("a call that fails is tried again, then dropped", async () => {
  const fail = async () => { throw new Error("Zoho said no"); };
  const { state, deps } = inbox([row(orderBody)], fail);
  for (let run = 1; run < MAX_INBOX_ATTEMPTS; run += 1) {
    assert.equal((await drainWebhookInbox(deps)).failed, 1);
    assert.equal(state.rows[0]?.attempts, run);
  }
  await drainWebhookInbox(deps);
  assert.equal(state.rows.length, 0);
  assert.equal(state.applied.length, MAX_INBOX_ATTEMPTS);
});

test("one failure does not stop the calls behind it", async () => {
  const { state, deps } = inbox([row(orderBody), row(itemBody)], async (record) => {
    if (record.kind === "salesorder") throw new Error("no");
    return "ok";
  });
  const result = await drainWebhookInbox(deps);
  assert.equal(result.failed, 1);
  assert.equal(result.applied, 1);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]?.body, orderBody);
});

test("while Zoho's daily limit is used up, good calls wait and bad ones still go", async () => {
  const { state, deps } = inbox([row(orderBody), row(itemBody, "e".repeat(64))]);
  const result = await drainWebhookInbox(deps, { maxApplied: 0 });
  assert.equal(result.waiting, 1);
  assert.equal(result.rejected, 1);
  assert.equal(state.applied.length, 0);
  assert.deepEqual(state.rows.map((r) => r.body), [orderBody]);
});

test("a large backlog is shared across runs", async () => {
  const bodies = Array.from({ length: 5 }, (_, i) => JSON.stringify({ item: { item_id: String(i) } }));
  const { state, deps } = inbox(bodies.map((b) => row(b)));
  assert.equal((await drainWebhookInbox(deps, { maxApplied: 2 })).applied, 2);
  assert.equal(state.rows.length, 3);
  assert.equal((await drainWebhookInbox(deps, { maxApplied: 2 })).applied, 2);
  assert.equal((await drainWebhookInbox(deps, { maxApplied: 2 })).applied, 1);
  assert.equal(state.rows.length, 0);
});

test("without the secret nothing is judged or deleted", async () => {
  const { state, deps } = inbox([row(orderBody)], undefined, []);
  assert.equal((await drainWebhookInbox(deps)).read, 0);
  assert.equal(state.rows.length, 1);
  assert.equal(state.applied.length, 0);
});

test("the wiring stays in place", () => {
  const config = readFileSync("supabase/config.toml", "utf8").replace(/\r\n/g, "\n");
  assert.match(config, /\[functions\.zoho-webhook\]\nverify_jwt = false/);
  const sql = readFileSync("supabase/migrations/20261111100000_zoho_webhook_inbox.sql", "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.zoho_webhook_inbox FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /CREATE POLICY/, "no policy: only the server key may touch it");
  const sync = readFileSync("src/routes/api.zoho.sync.ts", "utf8");
  assert.ok(sync.indexOf("drainZohoWebhookInbox") < sync.indexOf("processZohoSyncOutbox"), "the inbox runs first");
  const route = readFileSync("src/routes/api.zoho.webhook.ts", "utf8");
  assert.ok(route.includes("applyZohoWebhookRecord"), "both routes apply calls the same way");
});
