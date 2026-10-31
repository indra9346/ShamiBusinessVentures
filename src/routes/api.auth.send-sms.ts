import { createFileRoute } from "@tanstack/react-router";
import {
  SMS_FAILED_MESSAGE, fast2smsOtpRequest, fast2smsOutcome, hookErrorBody, smsFailureForCustomer, smsFromHookPayload, verifyHookSignature,
} from "@/lib/sms-hook";

/**
 * Supabase Auth "Send SMS" hook: Supabase makes each phone OTP and POSTs it here, signed with the
 * hook secret (SEND_SMS_HOOK_SECRET, "v1,whsec_…" from the Supabase dashboard). The code is sent
 * through the Fast2SMS OTP route with FAST2SMS_API_KEY. A failure goes back to Supabase with a
 * message the customer sees (e.g. "too many codes, wait"), instead of waiting for an SMS that never comes.
 */
const hookError = (httpCode: number, message: string) => {
  const { status, body } = hookErrorBody(httpCode, message);
  return Response.json(body, { status });
};

export const Route = createFileRoute("/api/auth/send-sms")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["SEND_SMS_HOOK_SECRET"] ?? "";
        const apiKey = process.env["FAST2SMS_API_KEY"] ?? "";
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
      },
    },
  },
});
