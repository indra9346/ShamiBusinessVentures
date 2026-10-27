import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { HELD_STATUS_FILTER } from "@/lib/payment-hold";
import { istRange, type ReportItem, type ReportOrder } from "@/lib/godown-report";
import {
  buildPartnerReport, partnerSafeReport, type PartnerCommissionRow, type PartnerTargetRow, type ReportPartner,
} from "@/lib/partner-report";

/*
 * Channel partner report. Admins see every partner with the company's cost and profit; a partner
 * sees only their own report, without cost or profit. Read-only.
 */

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function isAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return !error && Boolean(data);
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IN_CHUNK = 200;
const MAX_ORDERS = 5000;

/** Reads the period's orders of the partners' godowns and builds the report. */
async function loadPartnerReport(db: ReturnType<typeof serviceClient>, from: string, to: string, onlyPartnerId?: string) {
  if (to < from) throw new Error("The end date is before the start date");
  const { fromIso, toIso } = istRange(from, to);
  let partnersQuery = db.from("channel_partners").select("id,name,email,phone,branch_id,status,created_at").order("created_at");
  if (onlyPartnerId) partnersQuery = partnersQuery.eq("id", onlyPartnerId);
  const [partnersResult, branchesResult, productsResult, targetsResult] = await Promise.all([
    partnersQuery,
    db.from("branches").select("id,name"),
    db.from("catalog_products").select("id,payload").not("vendor_id", "like", "zoho:%"),
    db.from("partner_targets").select("partner_id,month,target_sales"),
  ]);
  if (partnersResult.error || branchesResult.error || productsResult.error) throw new Error("Could not read partners, godowns and products");
  const branchName = new Map((branchesResult.data ?? []).map((b) => [b.id, b.name]));
  const partners: ReportPartner[] = (partnersResult.data ?? []).map((p) => ({
    id: p.id, name: p.name, email: p.email, phone: p.phone, branchId: p.branch_id, godown: branchName.get(p.branch_id) ?? p.branch_id,
    status: p.status, createdAt: p.created_at,
  }));
  const branchIds = [...new Set(partners.map((p) => p.branchId))];
  if (!branchIds.length) return buildPartnerReport({ partners, orders: [], items: [], costs: {}, commissionRows: [], targets: [], from, to });

  const { data: orderRows, error: ordersError } = await db.from("orders")
    .select("id,order_no,branch_id,created_at,order_status,payment_status,customer_name,subtotal,discount,gst_amount,shipping,total,paid_amount,zoho_salesorder_id")
    .in("branch_id", branchIds).gte("created_at", fromIso).lt("created_at", toIso).not("order_status", "in", HELD_STATUS_FILTER).order("created_at").limit(MAX_ORDERS);
  if (ordersError) throw new Error("Could not read orders");
  const orderIds = (orderRows ?? []).map((row) => row.id);

  const items: ReportItem[] = [];
  const commissionRows: PartnerCommissionRow[] = [];
  const invoices = new Map<string, string>();
  for (let start = 0; start < orderIds.length; start += IN_CHUNK) {
    const ids = orderIds.slice(start, start + IN_CHUNK);
    const [itemsResult, commissionResult, invoiceResult] = await Promise.all([
      db.from("order_items").select("id,order_id,product_id,product_name,qty,unit_price,line_total").in("order_id", ids),
      db.from("partner_commissions").select("order_item_id,order_id,partner_id,amount,status,kind,rate,line_total").in("order_id", ids),
      db.from("zoho_order_invoices").select("order_id,invoice_number,status").in("order_id", ids),
    ]);
    if (itemsResult.error || commissionResult.error) throw new Error("Could not read order items and commissions");
    for (const row of itemsResult.data ?? [])
      items.push({ ...row, qty: Number(row.qty), unit_price: Number(row.unit_price), line_total: Number(row.line_total) });
    for (const row of commissionResult.data ?? [])
      commissionRows.push({ ...row, amount: Number(row.amount), rate: Number(row.rate), line_total: Number(row.line_total) });
    for (const row of invoiceResult.data ?? [])
      if (row.invoice_number) invoices.set(row.order_id, row.status ? `${row.invoice_number} (${row.status})` : row.invoice_number);
  }
  const costs: Record<string, number | null> = {};
  for (const product of productsResult.data ?? []) {
    const rate = Number(((product.payload ?? {}) as Record<string, unknown>)["purchasePrice"]);
    costs[product.id] = Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  const orders: ReportOrder[] = (orderRows ?? []).map((row) => ({
    ...row,
    subtotal: Number(row.subtotal), discount: Number(row.discount), gst_amount: Number(row.gst_amount),
    shipping: Number(row.shipping), total: Number(row.total), paid_amount: Number(row.paid_amount),
    invoice_number: invoices.get(row.id) ?? null,
  }));
  const targets: PartnerTargetRow[] = (targetsResult.data ?? []).map((t) => ({ ...t, target_sales: Number(t.target_sales) }));
  const report = buildPartnerReport({ partners, orders, items, costs, commissionRows, targets, from, to });
  return { ...report, truncated: (orderRows ?? []).length >= MAX_ORDERS };
}

/** Admin: every channel partner (or one), with cost and profit. */
export const partnerReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ from: day, to: day, partnerId: z.string().uuid().optional() }))
  .handler(async ({ data, context }) => {
    if (!(await isAdmin(context.supabase, context.userId))) throw new Error("Administrator access is required");
    const report = await loadPartnerReport(serviceClient(), data.from, data.to, data.partnerId);
    return { ...report, from: data.from, to: data.to, generatedAt: new Date().toISOString() };
  });

/** A channel partner: their own report only, without the company's cost and profit. */
export const myPartnerReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ from: day, to: day }))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    const { data: me } = await db.from("channel_partners").select("id,status").eq("user_id", context.userId).maybeSingle();
    if (!me || me.status !== "active") throw new Error("Only an active channel partner can see this report");
    const report = await loadPartnerReport(db, data.from, data.to, me.id);
    return { ...partnerSafeReport(report), truncated: "truncated" in report ? Boolean(report.truncated) : false, from: data.from, to: data.to, generatedAt: new Date().toISOString() };
  });
