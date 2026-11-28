import { createFileRoute } from "@tanstack/react-router";

function equalSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/zoho/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env["CRON_SECRET"];
        const auth = request.headers.get("authorization") ?? "";
        if (!secret || !equalSecret(auth, `Bearer ${secret}`))
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        // Cashfree first (28 Nov 2026): webhook calls parked on Supabase, then every open Cashfree order is asked about,
        // so a checkout paid through Cashfree is placed, not ended, even when the customer closed the page.
        let cashfree: unknown = null;
        try {
          const { drainCashfreeInbox, reconcileCashfreeOrders } = await import("@/lib/cashfree.functions");
          cashfree = { inbox: await drainCashfreeInbox(), orders: await reconcileCashfreeOrders() };
        } catch (cause) {
          console.error("Cashfree check failed", cause);
          cashfree = { error: "Cashfree check failed" };
        }
        // Unpaid checkouts whose time is up give their stock back, even if nobody has a page open.
        try {
          const url = process.env["SUPABASE_URL"];
          const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
          if (url && key) {
            const { createClient } = await import("@supabase/supabase-js");
            const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
            await db.rpc("expire_payment_holds");
            // Pre-order batches (14 Nov 2026): ready and arriving worked out again (a lot's date passes at midnight in
            // India) and one alert per overdue lot. Database only, no Zoho call.
            const { error: incomingError } = await db.rpc("refresh_incoming_all");
            if (incomingError) console.warn("Could not refresh arriving stock", incomingError.message);
          }
        } catch (cause) {
          console.warn("Could not end expired payment holds", cause);
        }
        // Zoho's webhook calls parked on Supabase. First, and on its own, so a problem here never stops the outbound sync.
        let webhookInbox: unknown = null;
        try {
          const { drainZohoWebhookInbox } = await import("@/lib/zoho-commerce.functions");
          webhookInbox = await drainZohoWebhookInbox();
        } catch (cause) {
          console.error("Zoho webhook inbox failed", cause);
          webhookInbox = { error: "Zoho webhook inbox failed" };
        }
        try {
          const { processZohoSyncOutbox } = await import("@/lib/zoho-commerce.functions");
          return Response.json({ ...(await processZohoSyncOutbox(20)), webhookInbox, cashfree }, {
            headers: { "cache-control": "no-store" },
          });
        } catch (cause) {
          console.error("Zoho outbound sync worker failed", cause);
          return Response.json({ error: "Zoho sync worker failed" }, { status: 500 });
        }
      },
    },
  },
});
