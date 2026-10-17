import { createFileRoute } from "@tanstack/react-router";
import { verifyZohoSignature, webhookKeyMatches, zohoLogLine } from "@/lib/zoho-sync-core";

/** Finds the sales order or item ID in a Zoho webhook body (JSON, or form data with a JSONString field). */
function recordFrom(body: string): { kind: "salesorder" | "item"; id: string } | null {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(body));
  } catch {
    const form = new URLSearchParams(body);
    for (const value of form.values()) {
      try {
        candidates.push(JSON.parse(value));
      } catch {
        // not JSON
      }
    }
    candidates.push(Object.fromEntries(form.entries()));
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const order = (record["salesorder"] ?? record["sales_order"]) as Record<string, unknown> | undefined;
    const orderId = order?.["salesorder_id"] ?? record["salesorder_id"];
    if (typeof orderId === "string" || typeof orderId === "number") return { kind: "salesorder", id: String(orderId) };
    const item = record["item"] as Record<string, unknown> | undefined;
    const itemId = item?.["item_id"] ?? record["item_id"];
    if (typeof itemId === "string" || typeof itemId === "number") return { kind: "item", id: String(itemId) };
  }
  return null;
}

/**
 * Zoho calls this (Workflow Rule webhooks) when a sales order or an item is created or edited.
 * The record is re-read from Zoho, never trusted from the payload, and applied to Grain Bazar.
 */
export const Route = createFileRoute("/api/zoho/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { zohoWebhookKey, handleZohoOrderWebhook, handleZohoItemWebhook } = await import("@/lib/zoho-commerce.functions");
        // Authentication, strongest first. The payload is never trusted either way: the record
        // is re-read from Zoho.
        // 1. Signed: Zoho's X-Zoho-Webhook-Signature (HMAC of the body with the webhook Secret,
        //    stored server-side as ZOHO_WEBHOOK_SECRET). A signed call must verify.
        // 2. Unsigned: the shared key as the X-GB-Webhook-Key header or ?key= (older set-ups).
        const body = await request.text();
        const signature = request.headers.get("x-zoho-webhook-signature");
        const secret = process.env["ZOHO_WEBHOOK_SECRET"] ?? "";
        if (signature) {
          const matched = secret ? await verifyZohoSignature(body, signature, secret) : null;
          if (!matched) {
            console.warn(zohoLogLine("webhook_rejected", {
              reason: secret ? "bad signature" : "signed call but ZOHO_WEBHOOK_SECRET is not set",
              bodyBytes: body.length,
              contentType: request.headers.get("content-type"),
            }));
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
          console.info(zohoLogLine("webhook_signature_ok", { encoding: matched }));
        } else {
          const key = request.headers.get("x-gb-webhook-key") ?? new URL(request.url).searchParams.get("key");
          if (!webhookKeyMatches(key, await zohoWebhookKey())) {
            console.warn(zohoLogLine("webhook_rejected", { reason: "no signature and bad key" }));
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
        }
        const record = recordFrom(body);
        if (!record) return Response.json({ ok: true, ignored: "no sales order or item id" });
        try {
          const outcome = record.kind === "salesorder"
            ? await handleZohoOrderWebhook(record.id)
            : await handleZohoItemWebhook(record.id);
          console.info(zohoLogLine("webhook_applied", { kind: record.kind, zohoId: record.id, outcome }));
          return Response.json({ ok: true, outcome });
        } catch (cause) {
          console.error(zohoLogLine("webhook_failed", { kind: record.kind, zohoId: record.id, error: cause instanceof Error ? cause.message : "unknown" }));
          // 200 so Zoho does not disable the webhook; the catch-up check and daily run retry.
          return Response.json({ ok: false });
        }
      },
    },
  },
});
