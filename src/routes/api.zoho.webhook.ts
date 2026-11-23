import { createFileRoute } from "@tanstack/react-router";
import { verifyZohoSignature, webhookKeyMatches, webhookSecrets, zohoLogLine } from "@/lib/zoho-sync-core";
import { webhookRecordFrom } from "@/lib/zoho-webhook-inbox";

/**
 * Zoho calls this (Workflow Rule webhooks) when a sales order or an item is created or edited. Since Hostinger began
 * refusing calls from servers (10 Nov 2026) Zoho delivers to the Supabase function zoho-webhook instead; this address
 * stays so Zoho can be pointed back here if Hostinger lifts that block.
 * The record is re-read from Zoho, never trusted from the payload, and applied to Grain Bazar.
 */
export const Route = createFileRoute("/api/zoho/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { zohoWebhookKey, applyZohoWebhookRecord } = await import("@/lib/zoho-commerce.functions");
        // Authentication, strongest first. The payload is never trusted either way: the record
        // is re-read from Zoho.
        // 1. Signed: Zoho's X-Zoho-Webhook-Signature (HMAC of the body with the webhook Secret,
        //    stored server-side as ZOHO_WEBHOOK_SECRET). A signed call must verify.
        // 2. Unsigned: the shared key as the X-GB-Webhook-Key header or ?key= (older set-ups).
        const body = await request.text();
        const signature = request.headers.get("x-zoho-webhook-signature");
        const secrets = webhookSecrets(process.env["ZOHO_WEBHOOK_SECRET"]);
        if (signature) {
          let matched: string | null = null;
          for (const secret of secrets) {
            matched = await verifyZohoSignature(body, signature, secret, {
              query: [...new URL(request.url).searchParams.entries()],
              contentType: request.headers.get("content-type"),
            });
            if (matched) break;
          }
          if (!matched) {
            console.warn(zohoLogLine("webhook_rejected", {
              reason: secrets.length ? "bad signature" : "signed call but ZOHO_WEBHOOK_SECRET is not set",
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
        const record = webhookRecordFrom(body);
        if (!record) return Response.json({ ok: true, ignored: "no sales order, invoice or item id" });
        try {
          const outcome = await applyZohoWebhookRecord(record);
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
