import { createFileRoute } from "@tanstack/react-router";

function equalSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
        const key = new URL(request.url).searchParams.get("key") ?? "";
        if (!equalSecret(key, await zohoWebhookKey()))
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        const record = recordFrom(await request.text());
        if (!record) return Response.json({ ok: true, ignored: "no sales order or item id" });
        try {
          const outcome = record.kind === "salesorder"
            ? await handleZohoOrderWebhook(record.id)
            : await handleZohoItemWebhook(record.id);
          return Response.json({ ok: true, outcome });
        } catch (cause) {
          console.error("Zoho order webhook failed", cause);
          // 200 so Zoho does not disable the webhook; the catch-up check and daily run retry.
          return Response.json({ ok: false });
        }
      },
    },
  },
});
