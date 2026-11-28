// Parks a Cashfree webhook call in public.cashfree_webhook_inbox. Cashfree's signature is checked later by the website,
// which holds the secret key, so no secret has to be copied here (the same way as zoho-webhook). The limits below stop a
// stranger who finds this address from filling the database: the website deletes anything badly signed on its next run.
// No imports, so the tests can run it directly.

export const MAX_BODY_BYTES = 64_000;
export const MAX_WAITING = 500;
// base64 of an HMAC-SHA256 is 44 characters; a little room either way.
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/=]{20,100}$/;
const TIMESTAMP_SHAPE = /^[0-9]{6,16}$/;

export type InboxEnvironment = {
  url: string | undefined;
  serviceKey: string | undefined;
  fetch: typeof fetch;
};

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

export async function handleInboxRequest(request: Request, environment: InboxEnvironment): Promise<Response> {
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });
  const signature = (request.headers.get("x-webhook-signature") ?? "").trim();
  const timestamp = (request.headers.get("x-webhook-timestamp") ?? "").trim();
  if (!SIGNATURE_SHAPE.test(signature) || !TIMESTAMP_SHAPE.test(timestamp)) return reply(401, { error: "Unauthorized" });
  const body = await request.text();
  if (!body) return reply(400, { error: "Empty body" });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return reply(413, { error: "Too large" });

  const { url, serviceKey } = environment;
  if (!url || !serviceKey) {
    console.error("cashfree-webhook: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
    return reply(500, { error: "Not set up" });
  }
  const table = `${url.replace(/\/+$/, "")}/rest/v1/cashfree_webhook_inbox`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const waiting = await environment.fetch(`${table}?select=id`, { headers: { ...headers, Prefer: "count=exact", Range: "0-0" } });
  if (!waiting.ok) {
    console.error("cashfree-webhook: could not count the inbox", waiting.status);
    return reply(500, { error: "Could not store" });
  }
  const count = Number((waiting.headers.get("content-range") ?? "").split("/")[1]);
  // 503 makes Cashfree try again later instead of losing the call.
  if (!Number.isFinite(count) || count >= MAX_WAITING) return reply(503, { error: "Inbox full" });

  const stored = await environment.fetch(table, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ body, signature, webhook_timestamp: timestamp }),
  });
  if (!stored.ok) {
    console.error("cashfree-webhook: could not store the call", stored.status);
    return reply(500, { error: "Could not store" });
  }
  return reply(200, { ok: true, queued: true });
}
