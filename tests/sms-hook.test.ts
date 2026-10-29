import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fast2smsOtpRequest, fast2smsOutcome, smsFromHookPayload, verifyHookSignature } from "../src/lib/sms-hook.ts";

const rawKey = Buffer.from("grain-bazar-test-hook-secret-32b");
const secret = `v1,whsec_${rawKey.toString("base64")}`;
const sign = (id: string, ts: string, body: string, key = rawKey) =>
  `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;

test("send-sms hook: only Supabase's fresh signature is accepted", async () => {
  const body = JSON.stringify({ user: { phone: "919346476951" }, sms: { otp: "123456" } });
  const now = 1_793_200_000;
  const ts = String(now);
  const ok = { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) };
  assert.equal(await verifyHookSignature(secret, ok, body, now), true);
  // The secret may be pasted without the "v1," prefix; several signatures may be sent.
  assert.equal(await verifyHookSignature(secret.slice(3), ok, body, now), true);
  assert.equal(await verifyHookSignature(secret, { ...ok, signature: `v1,AAAA ${ok.signature}` }, body, now), true);
  // Tampered body, other secret, wrong id, missing headers, too old or too far ahead.
  assert.equal(await verifyHookSignature(secret, ok, body.replace("123456", "654321"), now), false);
  assert.equal(await verifyHookSignature(secret, { ...ok, signature: sign("msg_1", ts, body, Buffer.from("another-secret-another-secret-12")) }, body, now), false);
  assert.equal(await verifyHookSignature(secret, { ...ok, id: "msg_2" }, body, now), false);
  assert.equal(await verifyHookSignature(secret, { ...ok, signature: null }, body, now), false);
  assert.equal(await verifyHookSignature(secret, ok, body, now + 301), false);
  assert.equal(await verifyHookSignature(secret, ok, body, now - 301), false);
  assert.equal(await verifyHookSignature("", ok, body, now), false);
});

test("send-sms hook: Indian mobile number and code from Supabase's payload", () => {
  assert.deepEqual(smsFromHookPayload({ user: { phone: "919346476951" }, sms: { otp: "123456" } }), { mobile: "9346476951", otp: "123456" });
  assert.deepEqual(smsFromHookPayload({ user: { phone: "+91 93464 76951" }, sms: { otp: "004321" } }), { mobile: "9346476951", otp: "004321" });
  for (const bad of [
    null, {}, { user: { phone: "919346476951" } },
    { user: { phone: "14155550100" }, sms: { otp: "123456" } }, // not India
    { user: { phone: "915346476951" }, sms: { otp: "123456" } }, // not a mobile (starts 5)
    { user: { phone: "919346476951" }, sms: { otp: "12ab56" } },
  ]) assert.equal(smsFromHookPayload(bad), null);
});

test("Fast2SMS: OTP route request and its answers", () => {
  const { url, init } = fast2smsOtpRequest("KEY123", "9346476951", "123456");
  assert.equal(url, "https://www.fast2sms.com/dev/bulkV2");
  assert.equal((init.headers as Record<string, string>)["authorization"], "KEY123");
  assert.deepEqual(JSON.parse(String(init.body)), { route: "otp", variables_values: "123456", numbers: "9346476951", flash: "0" });
  assert.deepEqual(fast2smsOutcome(200, { return: true, request_id: "abc", message: ["SMS sent successfully."] }), { ok: true, requestId: "abc" });
  const refused = fast2smsOutcome(200, { return: false, status_code: 996, message: "Before using OTP route, complete website verification" });
  assert.equal(refused.ok, false);
  assert.match((refused as { message: string }).message, /996.*website verification/);
  assert.equal(fast2smsOutcome(401, { return: false, message: "Invalid Authentication" }).ok, false);
  assert.equal(fast2smsOutcome(500, null).ok, false);
});
