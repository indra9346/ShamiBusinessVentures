import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { HistoryCommission, HistoryEvent, HistoryOrder, HistoryPartner } from "@/lib/partner-history";

/*
 * Admin > Channel Partners > Partner history: every partner of every godown with their change log,
 * their commission lines and the godowns' orders (for the times a godown had no partner). Read-only;
 * the page adds it up with buildPartnerHistory (src/lib/partner-history.ts).
 */

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

/** PostgREST returns at most 1,000 rows per request. */
const PAGE = 1000;
async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${what}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

export const getPartnerHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: branches, error: branchError } = await db.from("branches").select("id,name,vendor_id,sort_order").order("sort_order");
    if (branchError) throw new Error("Could not read godowns");
    const godowns = (branches ?? []).filter((b) => !b.vendor_id).map((b) => ({ id: b.id, name: b.name }));
    const godownIds = godowns.map((g) => g.id);
    const [partnerRows, eventRows, commissionRows, orderRows] = await Promise.all([
      allRows((from, to) => db.from("channel_partners").select("id,name,email,phone,branch_id,status,created_at,updated_at").order("created_at").order("id").range(from, to), "partners"),
      allRows((from, to) => db.from("channel_partner_events").select("partner_id,branch_id,event,at,by_name,backfilled").order("at").order("id").range(from, to), "partner changes"),
      allRows((from, to) => db.from("partner_commissions").select("partner_id,order_id,line_total,amount,status,placed_at").order("placed_at").order("order_item_id").range(from, to), "commissions"),
      godownIds.length
        ? allRows((from, to) => db.from("orders").select("id,branch_id,created_at,order_status,subtotal,discount").in("branch_id", godownIds)
          .order("created_at").order("id").range(from, to), "orders")
        : Promise.resolve([]),
    ]);
    const partners: HistoryPartner[] = partnerRows.map((p) => ({
      id: p.id, name: p.name, email: p.email, phone: p.phone, branchId: p.branch_id, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at,
    }));
    const events: HistoryEvent[] = eventRows.map((e) => ({ ...e, backfilled: Boolean(e.backfilled) }));
    const commissions: HistoryCommission[] = commissionRows.map((c) => ({ ...c, line_total: Number(c.line_total) || 0, amount: Number(c.amount) || 0 }));
    const orders: HistoryOrder[] = orderRows.map((o) => ({ ...o, subtotal: Number(o.subtotal) || 0, discount: Number(o.discount) || 0 }));
    return { generatedAt: new Date().toISOString(), godowns, partners, events, commissions, orders };
  });

export type PartnerHistoryData = Awaited<ReturnType<typeof getPartnerHistory>>;
