import { createFileRoute } from "@tanstack/react-router";

// Cashfree's webhook, if it ever reaches grainbazar.com itself (Hostinger's bot check refuses calls from servers, so
// Cashfree is pointed at the Supabase Edge Function cashfree-webhook instead, which parks calls for the 15-minute job).
// The signature is checked here with the secret key before anything is recorded.
export const Route = createFileRoute("/api/payments/cashfree/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (raw.length > 64_000) return Response.json({ error: "Too large" }, { status: 413 });
        const { handleCashfreeWebhook } = await import("@/lib/cashfree.functions");
        const result = await handleCashfreeWebhook(raw, request.headers.get("x-webhook-signature") ?? "", request.headers.get("x-webhook-timestamp") ?? "");
        return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
