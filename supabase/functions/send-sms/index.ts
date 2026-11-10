// Supabase Auth "Send SMS" hook, run by Supabase itself (Edge Function), so a phone sign-in code never depends on
// grainbazar.com accepting a call from Supabase's servers. Since 10 Nov 2026 Hostinger answers 403 to every request
// that comes from a server, which stopped all phone codes. Same rules as /api/auth/send-sms (sms-hook.ts is a copy of
// src/lib/sms-hook.ts; tests/sms-hook.test.ts checks they stay the same).
//
// Secrets (Supabase > Edge Functions > Secrets): SEND_SMS_HOOK_SECRET ("v1,whsec_..." from Auth > Hooks) and
// FAST2SMS_API_KEY. Deploy with --no-verify-jwt: Supabase signs the call; there is no user token.

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

import {
  SMS_FAILED_MESSAGE, fast2smsOtpRequest, fast2smsOutcome, hookErrorBody, smsFailureForCustomer, smsFromHookPayload, verifyHookSignature,
} from "./sms-hook.ts";

const hookError = (httpCode: number, message: string) => {
  const { status, body } = hookErrorBody(httpCode, message);
  return Response.json(body, { status });
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("SEND_SMS_HOOK_SECRET") ?? "";
  const apiKey = Deno.env.get("FAST2SMS_API_KEY") ?? "";
  if (!secret || !apiKey) {
    console.error("send-sms hook:", !secret ? "SEND_SMS_HOOK_SECRET is not set" : "FAST2SMS_API_KEY is not set");
    return hookError(500, "SMS sending is not set up yet. Please sign in with email.");
  }
  const body = (await request.text()).slice(0, 20_000);
  const signed = await verifyHookSignature(secret, {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  }, body);
  if (!signed) {
    console.warn("send-sms hook rejected: bad or old signature");
    return hookError(401, "Unauthorized");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return hookError(400, "Bad request");
  }
  const sms = smsFromHookPayload(payload);
  if (!sms) return hookError(400, "Enter a valid 10-digit Indian mobile number");

  const { url, init } = fast2smsOtpRequest(apiKey, sms.mobile, sms.otp);
  let status = 0;
  let reply: unknown = null;
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    status = response.status;
    reply = await response.json().catch(() => null);
  } catch (cause) {
    console.error("send-sms hook: Fast2SMS unreachable:", cause instanceof Error ? cause.message : String(cause));
    return hookError(502, SMS_FAILED_MESSAGE);
  }
  const outcome = fast2smsOutcome(status, reply);
  // Never log the code; the last 4 digits of the number are enough to trace a delivery.
  if (!outcome.ok) {
    console.error(`send-sms hook: ******${sms.mobile.slice(-4)}:`, outcome.message);
    const failure = smsFailureForCustomer(outcome.code);
    return hookError(failure.httpCode, failure.message);
  }
  console.info(`send-sms hook: sent to ******${sms.mobile.slice(-4)} (Fast2SMS ${outcome.requestId})`);
  return Response.json({});
});
