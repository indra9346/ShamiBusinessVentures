import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { parseBankCredit, smsFromPayload } from "@/lib/bank-alert";
import { webhookKeyMatches } from "@/lib/zoho-sync-core";

/**
 * The company phone forwards each bank SMS here (an SMS-forwarding app, POST, with the secret
 * BANK_ALERT_KEY as the X-Bank-Alert-Key header or ?key=). A "money received" SMS with an amount
 * and UTR is recorded; a matching unpaid checkout is confirmed at once and sent to Zoho.
 * Optional BANK_ALERT_SENDERS (comma list, e.g. "SBIUPI,HDFCBK") accepts only the bank's SMS IDs.
 */
export const Route = createFileRoute("/api/payments/bank-alert")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["BANK_ALERT_KEY"] ?? "";
        const key = request.headers.get("x-bank-alert-key") ?? new URL(request.url).searchParams.get("key");
        if (expected.length < 24 || !webhookKeyMatches(key, expected)) {
          console.warn("bank-alert rejected:", expected.length < 24 ? "BANK_ALERT_KEY is not set (24+ characters)" : "bad key");
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const body = (await request.text()).slice(0, 4000);
        const { text, sender } = smsFromPayload(body);
        const senders = (process.env["BANK_ALERT_SENDERS"] ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (senders.length && !senders.some((s) => (sender ?? "").toUpperCase().includes(s))) {
          return Response.json({ ok: true, ignored: "not from the bank's SMS ID" });
        }
        const parsed = parseBankCredit(text);
        if (!parsed) return Response.json({ ok: true, ignored: "not a money-received SMS with an amount and UTR" });

        const url = process.env["SUPABASE_URL"];
        const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
        if (!url || !serviceKey) return Response.json({ error: "Server configuration is missing" }, { status: 500 });
        const db = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data, error } = await db.rpc("record_bank_credit", {
          _utr: parsed.utr, _amount: parsed.amount, _raw: text, _source: "sms",
          ...(parsed.payer ? { _payer: parsed.payer } : {}),
          ...(sender ? { _sender: sender } : {}),
        });
        if (error) {
          console.error("bank-alert could not be recorded:", error.message);
          // 500 so the forwarding app retries; the same UTR is never recorded twice.
          return Response.json({ ok: false }, { status: 500 });
        }
        const outcome = data as { status: string; order_no?: string };
        if (outcome.status === "matched" && outcome.order_no) {
          const { pushPaidOrderToZohoNow } = await import("@/lib/zoho-commerce.functions");
          await pushPaidOrderToZohoNow(outcome.order_no);
        }
        console.info("bank-alert:", outcome.status, outcome.order_no ?? "", `₹${parsed.amount}`);
        return Response.json({ ok: true, status: outcome.status, order: outcome.order_no ?? null });
      },
    },
  },
});
