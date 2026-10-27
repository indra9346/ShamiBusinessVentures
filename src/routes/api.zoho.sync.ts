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
        // Unpaid checkouts whose time is up give their stock back, even if nobody has a page open.
        try {
          const url = process.env["SUPABASE_URL"];
          const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
          if (url && key) {
            const { createClient } = await import("@supabase/supabase-js");
            await createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).rpc("expire_payment_holds");
          }
        } catch (cause) {
          console.warn("Could not end expired payment holds", cause);
        }
        try {
          const { processZohoSyncOutbox } = await import("@/lib/zoho-commerce.functions");
          return Response.json(await processZohoSyncOutbox(20), {
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
