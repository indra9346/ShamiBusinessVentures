import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  CASHFREE_API_BASE, CASHFREE_SDK_URL, cashfreeConfigFrom, cashfreeCustomerId, cashfreeExpiry, cashfreeHeaders, cashfreeNextStep, cashfreeOpenTo,
  cashfreeOrderBody, cashfreePaymentFrom, cashfreePhone, cashfreeReturnOrigin, cashfreeReturnUrl, cashfreeSettingFrom, cashfreeSetupProblem,
  cashfreeSignatureValid, cashfreeTester, cashfreeWebhookFrom, cashfreeWebhookUrl,
} from "../src/lib/cashfree.ts";
import { handleInboxRequest } from "../supabase/functions/cashfree-webhook/handler.ts";

const KEYS = { CASHFREE_APP_ID: "TEST_APP", CASHFREE_SECRET_KEY: "TEST_SECRET_0123456789", CASHFREE_ENV: "sandbox" };

test("Cashfree is off until all three settings are there, and never says the secret", () => {
  assert.equal(cashfreeConfigFrom({}), null);
  assert.equal(cashfreeSetupProblem({}), "Not set on the server: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV");
  assert.equal(cashfreeConfigFrom({ ...KEYS, CASHFREE_SECRET_KEY: " " }), null);
  assert.equal(cashfreeSetupProblem({ ...KEYS, CASHFREE_ENV: "live" }), "CASHFREE_ENV must be sandbox or production");
  assert.equal(cashfreeSetupProblem(KEYS), null);
  const sandbox = cashfreeConfigFrom(KEYS)!;
  assert.equal(sandbox.environment, "sandbox");
  assert.equal(sandbox.apiBase, CASHFREE_API_BASE.sandbox);
  assert.equal(sandbox.sdkUrl, CASHFREE_SDK_URL);
  const production = cashfreeConfigFrom({ ...KEYS, CASHFREE_ENV: " Production " })!;
  assert.equal(production.apiBase, "https://api.cashfree.com/pg");
  for (const problem of [cashfreeSetupProblem({}), cashfreeSetupProblem({ ...KEYS, CASHFREE_ENV: "x" })]) assert.ok(!String(problem).includes("TEST_SECRET"));
  const headers = cashfreeHeaders(sandbox);
  assert.equal(headers["x-client-id"], "TEST_APP");
  assert.equal(headers["x-api-version"], "2025-01-01");
});

test("a local stand-in replaces Cashfree only in sandbox and only on this computer", () => {
  const local = { ...KEYS, CASHFREE_TEST_API_BASE: "http://localhost:54500/pg/", CASHFREE_TEST_SDK_URL: "http://localhost:54500/sdk.js" };
  assert.equal(cashfreeConfigFrom(local)!.apiBase, "http://localhost:54500/pg");
  assert.equal(cashfreeConfigFrom(local)!.sdkUrl, "http://localhost:54500/sdk.js");
  assert.equal(cashfreeConfigFrom({ ...local, CASHFREE_ENV: "production" })!.apiBase, CASHFREE_API_BASE.production);
  assert.equal(cashfreeConfigFrom({ ...KEYS, CASHFREE_TEST_API_BASE: "https://evil.example/pg" })!.apiBase, CASHFREE_API_BASE.sandbox);
});

test("who sees Cashfree: everyone in production, only admins and test logins in sandbox", () => {
  const on = cashfreeSettingFrom({ enabled: true, testers: ["Owner@Example.com", "+91 98765 43210", "nonsense", "owner@example.com"] });
  assert.deepEqual(on.testers, ["owner@example.com", "9876543210"]);
  const off = cashfreeSettingFrom({ enabled: "yes" });
  assert.equal(off.enabled, false);
  assert.equal(cashfreeSettingFrom(null).enabled, false);
  const production = { environment: "production" as const };
  const sandbox = { environment: "sandbox" as const };
  assert.equal(cashfreeOpenTo(production, on, { isAdmin: false }), true);
  assert.equal(cashfreeOpenTo(production, off, { isAdmin: true }), false, "the switch is off");
  assert.equal(cashfreeOpenTo(null, on, { isAdmin: true }), false, "no keys");
  assert.equal(cashfreeOpenTo(sandbox, on, { isAdmin: false, email: "someone@else.com" }), false, "a real customer never sees sandbox");
  assert.equal(cashfreeOpenTo(sandbox, on, { isAdmin: true }), true);
  assert.equal(cashfreeOpenTo(sandbox, on, { isAdmin: false, email: "OWNER@example.com" }), true);
  assert.equal(cashfreeOpenTo(sandbox, on, { isAdmin: false, phone: "919876543210" }), true);
  assert.equal(cashfreeTester(" 09876543210 "), "9876543210");
  assert.equal(cashfreeTester("12345"), null);
});

test("customer details as Cashfree wants them", () => {
  assert.equal(cashfreePhone("+91 98765-43210"), "9876543210");
  assert.equal(cashfreePhone("09876543210"), "9876543210");
  assert.equal(cashfreePhone("1234567890"), null);
  assert.equal(cashfreePhone(""), null);
  assert.match(cashfreeCustomerId("00000000-0000-4000-8000-0000000000c1"), /^[0-9a-f]{32}$/);
});

test("the Cashfree order: our order number, the amount due, a mobile, expiry after the checkout's time", () => {
  const now = Date.parse("2026-11-28T06:00:00Z");
  const made = cashfreeOrderBody({
    cfOrderRef: "CLK-577522-281126-113000", orderNo: "CLK-577522-281126-113000", amount: 2625.004, holdUntil: "2026-11-28T06:10:00Z",
    userId: "00000000-0000-4000-8000-0000000000c1", customer: { name: "Asha  Sample", email: "asha@example.com", phone: "9876543210" },
    returnUrl: "https://www.grainbazar.com/account/orders/CLK-577522-281126-113000", notifyUrl: "https://abc.supabase.co/functions/v1/cashfree-webhook", now,
  });
  assert.ok("body" in made);
  const body = made.body as Record<string, any>;
  assert.equal(body.order_id, "CLK-577522-281126-113000");
  assert.equal(body.order_amount, 2625);
  assert.equal(body.order_currency, "INR");
  assert.deepEqual(body.customer_details, { customer_id: "000000000000400080000000000000c1", customer_phone: "9876543210", customer_name: "Asha Sample", customer_email: "asha@example.com" });
  assert.equal(body.order_meta.notify_url, "https://abc.supabase.co/functions/v1/cashfree-webhook");
  assert.equal(body.order_expiry_time, "2026-11-28T06:16:00Z", "16 minutes from now is later than the hold + 2");
  assert.equal(body.order_tags.order_no, "CLK-577522-281126-113000");
  assert.equal(cashfreeExpiry("2026-11-28T07:00:00Z", now), "2026-11-28T07:02:00Z", "a longer hold: 2 minutes after it");
  const noPhone = cashfreeOrderBody({ cfOrderRef: "CLK-1", orderNo: "CLK-1", amount: 10, holdUntil: null, userId: "u-1", customer: { phone: "" }, returnUrl: "https://x", notifyUrl: null });
  assert.ok("problem" in noPhone && /mobile number/.test(noPhone.problem));
  assert.ok("problem" in cashfreeOrderBody({ cfOrderRef: "CLK 1", orderNo: "x", amount: 10, holdUntil: null, userId: "u", customer: { phone: "9876543210" }, returnUrl: "", notifyUrl: null }));
  assert.ok("problem" in cashfreeOrderBody({ cfOrderRef: "CLK-1", orderNo: "x", amount: 0.5, holdUntil: null, userId: "u", customer: { phone: "9876543210" }, returnUrl: "", notifyUrl: null }));
  const plain = cashfreeOrderBody({ cfOrderRef: "CLK-1", orderNo: "x", amount: 10, holdUntil: null, userId: "u", customer: { phone: "9876543210", name: "A", email: "not-an-email" }, returnUrl: "https://x", notifyUrl: "http://insecure" });
  assert.ok("body" in plain);
  const details = (plain.body as Record<string, any>).customer_details;
  assert.equal(details.customer_name, undefined, "a name under 3 letters is left out");
  assert.equal(details.customer_email, undefined);
  assert.equal((plain.body as Record<string, any>).order_meta.notify_url, undefined, "Cashfree takes only https");
});

test("return and webhook addresses", () => {
  assert.equal(cashfreeReturnUrl("https://www.grainbazar.com/", "CLK-1"), "https://www.grainbazar.com/account/orders/CLK-1");
  assert.equal(cashfreeReturnOrigin("https://www.grainbazar.com", "https://grainbazar.com"), "https://www.grainbazar.com");
  assert.equal(cashfreeReturnOrigin("http://localhost:5320", "https://grainbazar.com"), "http://localhost:5320");
  assert.equal(cashfreeReturnOrigin("https://grainbazar.com.evil.net", "https://grainbazar.com"), "https://grainbazar.com");
  assert.equal(cashfreeReturnOrigin(null, "https://grainbazar.com"), "https://grainbazar.com");
  assert.equal(cashfreeWebhookUrl("https://ppziinqjxqpxpmudinfd.supabase.co/"), "https://ppziinqjxqpxpmudinfd.supabase.co/functions/v1/cashfree-webhook");
  assert.equal(cashfreeWebhookUrl("http://localhost:54394"), null);
});

const sampleWebhook = JSON.stringify({
  data: {
    order: { order_id: "CLK-577522-281126-113000", order_amount: 2625.0, order_currency: "INR", order_tags: { order_no: "CLK-577522-281126-113000" } },
    payment: { cf_payment_id: 5114910298456, payment_status: "SUCCESS", payment_amount: 2625.0, payment_currency: "INR", payment_message: "Transaction Success",
      payment_time: "2026-11-28T11:35:10+05:30", bank_reference: "512345678901", auth_id: null, payment_method: { upi: { channel: "collect", upi_id: "test@upi" } }, payment_group: "upi" },
    customer_details: { customer_name: "Asha", customer_id: "abc", customer_email: "asha@example.com", customer_phone: "9876543210" },
  },
  event_time: "2026-11-28T11:35:12+05:30",
  type: "PAYMENT_SUCCESS_WEBHOOK",
});

test("a webhook's payment, and a payment from Cashfree's API", () => {
  const hook = cashfreeWebhookFrom(sampleWebhook)!;
  assert.equal(hook.type, "PAYMENT_SUCCESS_WEBHOOK");
  assert.deepEqual(hook.payment, {
    cfPaymentId: "5114910298456", cfOrderRef: "CLK-577522-281126-113000", status: "SUCCESS", amount: 2625, bankReference: "512345678901", group: "upi",
    paymentTime: "2026-11-28T06:05:10.000Z",
  });
  assert.equal(cashfreeWebhookFrom("not json"), null);
  assert.deepEqual(cashfreeWebhookFrom(JSON.stringify({ type: "REFUND_STATUS_WEBHOOK", data: { refund: {} } })), { type: "REFUND_STATUS_WEBHOOK", payment: null });
  const fromApi = cashfreePaymentFrom({ cf_payment_id: "91", order_id: "CLK-1_2", payment_status: "user_dropped", payment_amount: "10.50", payment_group: "UPI", payment_completion_time: "2026-11-28T06:00:00Z" }, "CLK-1_2")!;
  assert.equal(fromApi.status, "USER_DROPPED");
  assert.equal(fromApi.amount, 10.5);
  assert.equal(fromApi.group, "upi");
  assert.equal(cashfreePaymentFrom({ cf_payment_id: "a b", payment_status: "SUCCESS", payment_amount: 1 }, "x"), null);
  assert.equal(cashfreePaymentFrom({ cf_payment_id: "1", payment_status: "SUCCESS", payment_amount: "lots" }, "x"), null);
});

test("only a webhook signed with our secret key counts", async () => {
  const secret = "TEST_SECRET_0123456789";
  const ts = "1764309912000";
  const sign = (text: string, key = secret) => createHmac("sha256", key).update(text).digest("base64");
  assert.equal(await cashfreeSignatureValid(sampleWebhook, ts, sign(ts + sampleWebhook), secret), true);
  assert.equal(await cashfreeSignatureValid(sampleWebhook, ts, sign(`${ts}.${sampleWebhook}`), secret), true, "the dotted form in one Cashfree page");
  assert.equal(await cashfreeSignatureValid(sampleWebhook, ts, sign(ts + sampleWebhook, "another key"), secret), false);
  assert.equal(await cashfreeSignatureValid(sampleWebhook.replace("2625", "1"), ts, sign(ts + sampleWebhook), secret), false, "a changed body");
  assert.equal(await cashfreeSignatureValid(sampleWebhook, "1764309912001", sign(ts + sampleWebhook), secret), false, "another time");
  assert.equal(await cashfreeSignatureValid(sampleWebhook, ts, sign(ts + sampleWebhook), ""), false, "no secret, no trust");
  assert.equal(await cashfreeSignatureValid(sampleWebhook, "abc", sign(ts + sampleWebhook), secret), false);
});

test("an open Cashfree order is closed, ended at Cashfree, or kept", () => {
  const now = Date.parse("2026-11-28T06:30:00Z");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "EXPIRED", checkoutDone: false, expiresAt: null, now }), "close");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "TERMINATED", checkoutDone: true, expiresAt: null, now }), "close");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "ACTIVE", checkoutDone: true, expiresAt: "2026-11-28T06:40:00Z", now }), "end");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "ACTIVE", checkoutDone: false, expiresAt: "2026-11-28T06:40:00Z", now }), "keep", "the customer may still pay");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "ACTIVE", checkoutDone: false, expiresAt: "2026-11-28T06:20:00Z", now }), "end");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "TERMINATION_REQUESTED", checkoutDone: true, expiresAt: null, now }), "keep", "a payment may be going through");
  assert.equal(cashfreeNextStep({ cashfreeStatus: "PAID", checkoutDone: true, expiresAt: null, now }), "keep", "its payment is read and recorded first");
});

test("the Supabase Edge Function parks only signed-looking calls", async () => {
  const stored: unknown[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return new Response("[]", { status: 200, headers: { "content-range": "0-0/3" } });
    stored.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  const environment = { url: "https://abc.supabase.co", serviceKey: "service", fetch: fakeFetch };
  const call = (headers: Record<string, string>, body = sampleWebhook, method = "POST") =>
    handleInboxRequest(new Request("https://abc.supabase.co/functions/v1/cashfree-webhook", { method, headers, body: method === "POST" ? body : undefined }), environment);
  assert.equal((await call({}, sampleWebhook, "GET")).status, 405);
  assert.equal((await call({ "x-webhook-timestamp": "1764309912000" })).status, 401);
  assert.equal((await call({ "x-webhook-signature": "bad sig!", "x-webhook-timestamp": "1764309912000" })).status, 401);
  assert.equal((await call({ "x-webhook-signature": "a".repeat(44), "x-webhook-timestamp": "1764309912000" }, "")).status, 400);
  assert.equal((await call({ "x-webhook-signature": "a".repeat(44), "x-webhook-timestamp": "1764309912000" }, "x".repeat(70_000))).status, 413);
  const ok = await call({ "x-webhook-signature": "a".repeat(43) + "=", "x-webhook-timestamp": "1764309912000" });
  assert.equal(ok.status, 200);
  assert.deepEqual(stored, [{ body: sampleWebhook, signature: "a".repeat(43) + "=", webhook_timestamp: "1764309912000" }]);
  const full = { ...environment, fetch: (async () => new Response("[]", { status: 200, headers: { "content-range": "0-0/500" } })) as unknown as typeof fetch };
  const refused = await handleInboxRequest(new Request("https://x/", { method: "POST", headers: { "x-webhook-signature": "a".repeat(44), "x-webhook-timestamp": "1764309912000" }, body: sampleWebhook }), full);
  assert.equal(refused.status, 503, "full: Cashfree retries later");
});
