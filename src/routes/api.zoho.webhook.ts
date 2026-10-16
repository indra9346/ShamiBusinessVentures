import { createFileRoute } from "@tanstack/react-router";

function equalSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Finds the sales order ID in a Zoho webhook body (JSON, or form data with a JSONString field). */
function salesOrderIdFrom(body: string): string {
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
    const nested = (record["salesorder"] ?? record["sales_order"]) as Record<string, unknown> | undefined;
    const id = nested?.["salesorder_id"] ?? record["salesorder_id"];
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return "";
}

/**
 * Zoho Commerce calls this when a sales order is created, confirmed, cancelled, declined,
 * shipped or delivered. The order is re-read from Zoho and applied to Grain Bazar.
 */
export const Route = createFileRoute("/api/zoho/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { zohoWebhookKey, handleZohoOrderWebhook } = await import("@/lib/zoho-commerce.functions");
        const key = new URL(request.url).searchParams.get("key") ?? "";
        if (!equalSecret(key, await zohoWebhookKey()))
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        const salesOrderId = salesOrderIdFrom(await request.text());
        if (!salesOrderId) return Response.json({ ok: true, ignored: "no sales order id" });
        try {
          return Response.json({ ok: true, outcome: await handleZohoOrderWebhook(salesOrderId) });
        } catch (cause) {
          console.error("Zoho order webhook failed", cause);
          // 200 so Zoho does not disable the webhook; the catch-up check and daily run retry.
          return Response.json({ ok: false });
        }
      },
    },
  },
});
