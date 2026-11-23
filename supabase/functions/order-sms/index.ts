// Order-confirmation SMS (client, 19 Nov 2026), sent by Fast2SMS from Supabase (Edge Function), where the Fast2SMS key
// used for sign-in codes already is (secret FAST2SMS_API_KEY), so the key never has to be typed into the website's
// hosting. Only the website's server calls it: the bearer token must be this project's service-role key (Supabase gives
// every function SUPABASE_SERVICE_ROLE_KEY). The text and the route come from customer-messages.ts (a copy of
// src/lib/customer-messages.ts; tests/customer-messages.test.ts checks they stay the same).
// Deploy with --no-verify-jwt (config.toml): the check below is the gate.

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

import { cleanCustomerMessageSettings, fast2smsOrderRequest, indianMobile, type ConfirmedOrder } from "./customer-messages.ts";

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || given !== serviceKey) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const apiKey = Deno.env.get("FAST2SMS_API_KEY") ?? "";
  if (!apiKey) return Response.json({ ok: false, error: "FAST2SMS_API_KEY is not set" }, { status: 500 });
  let payload: { mobile?: unknown; settings?: unknown; order?: Partial<ConfirmedOrder> };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const mobile = indianMobile(String(payload.mobile ?? ""));
  if (!mobile) return Response.json({ ok: false, error: "Not a 10-digit Indian mobile number" }, { status: 400 });
  const o = payload.order ?? {};
  const order: ConfirmedOrder = {
    orderNo: String(o.orderNo ?? "").slice(0, 40), customer: String(o.customer ?? "").slice(0, 80), total: Number(o.total) || 0,
    godown: String(o.godown ?? "").slice(0, 60), invoiceNumber: String(o.invoiceNumber ?? "").slice(0, 40), pickup: o.pickup === true,
  };
  if (!order.orderNo) return Response.json({ ok: false, error: "No order number" }, { status: 400 });
  const { url, init } = fast2smsOrderRequest(apiKey, mobile, cleanCustomerMessageSettings(payload.settings), order);
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const reply = (await response.json().catch(() => null)) as { return?: unknown; request_id?: unknown; message?: unknown } | null;
    if (response.ok && reply?.return === true) return Response.json({ ok: true, requestId: String(reply.request_id ?? "") });
    const message = Array.isArray(reply?.message) ? reply!.message.join(" ") : String(reply?.message ?? `HTTP ${response.status}`);
    return Response.json({ ok: false, error: `Fast2SMS: ${message}`.slice(0, 300) }, { status: 502 });
  } catch (cause) {
    return Response.json({ ok: false, error: `Fast2SMS unreachable: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300) }, { status: 502 });
  }
});
