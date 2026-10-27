import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { HELD_STATUS_FILTER } from "@/lib/payment-hold";
import { buildGodownReport, istRange, type ReportItem, type ReportOrder } from "@/lib/godown-report";

/*
 * Admin godown report: reads one period's orders, items, purchase rates (the Zoho item purchase
 * rate kept on each product), partner commissions and Zoho invoice numbers, and adds them up per
 * godown. Read-only.
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

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IN_CHUNK = 200;

export const godownReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ from: day, to: day, branchId: z.string().trim().max(40).optional() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    if (data.to < data.from) throw new Error("The end date is before the start date");
    const db = serviceClient();
    const { fromIso, toIso } = istRange(data.from, data.to);

    const [branchesResult, productsResult] = await Promise.all([
      db.from("branches").select("id,name,code,vendor_id,sort_order").order("sort_order"),
      db.from("catalog_products").select("id,payload").not("vendor_id", "like", "zoho:%"),
    ]);
    if (branchesResult.error || productsResult.error) throw new Error("Could not read godowns and products");

    let ordersQuery = db.from("orders")
      .select("id,order_no,branch_id,created_at,order_status,payment_status,customer_name,subtotal,discount,gst_amount,shipping,total,paid_amount,zoho_salesorder_id")
      .gte("created_at", fromIso).lt("created_at", toIso).not("order_status", "in", HELD_STATUS_FILTER).order("created_at").limit(5000);
    if (data.branchId) ordersQuery = data.branchId === "none" ? ordersQuery.is("branch_id", null) : ordersQuery.eq("branch_id", data.branchId);
    const { data: orderRows, error: ordersError } = await ordersQuery;
    if (ordersError) throw new Error("Could not read orders");
    const orderIds = (orderRows ?? []).map((row) => row.id);

    const items: ReportItem[] = [];
    const commissions: Record<string, number> = {};
    const invoices = new Map<string, string>();
    for (let start = 0; start < orderIds.length; start += IN_CHUNK) {
      const ids = orderIds.slice(start, start + IN_CHUNK);
      const [itemsResult, commissionResult, invoiceResult] = await Promise.all([
        db.from("order_items").select("id,order_id,product_id,product_name,qty,unit_price,line_total").in("order_id", ids),
        db.from("partner_commissions").select("order_item_id,amount,status").in("order_id", ids),
        db.from("zoho_order_invoices").select("order_id,invoice_number,status").in("order_id", ids),
      ]);
      if (itemsResult.error) throw new Error("Could not read order items");
      for (const row of itemsResult.data ?? [])
        items.push({ ...row, qty: Number(row.qty), unit_price: Number(row.unit_price), line_total: Number(row.line_total) });
      for (const row of commissionResult.data ?? [])
        if (row.status !== "cancelled") commissions[row.order_item_id] = Number(row.amount);
      for (const row of invoiceResult.data ?? [])
        if (row.invoice_number) invoices.set(row.order_id, row.status ? `${row.invoice_number} (${row.status})` : row.invoice_number);
    }

    const costs: Record<string, number | null> = {};
    for (const product of productsResult.data ?? []) {
      const payload = (product.payload ?? {}) as Record<string, unknown>;
      const rate = Number(payload["purchasePrice"]);
      costs[product.id] = Number.isFinite(rate) && rate > 0 ? rate : null;
    }

    const orders: ReportOrder[] = (orderRows ?? []).map((row) => ({
      ...row,
      subtotal: Number(row.subtotal), discount: Number(row.discount), gst_amount: Number(row.gst_amount),
      shipping: Number(row.shipping), total: Number(row.total), paid_amount: Number(row.paid_amount),
      invoice_number: invoices.get(row.id) ?? null,
    }));
    // Godowns are listed even with no sales; vendor pickup points only when they had orders.
    const branchNames = Object.fromEntries((branchesResult.data ?? []).map((branch) => [branch.id, branch.vendor_id ? `${branch.name} (vendor point)` : branch.name]));
    const godowns = (branchesResult.data ?? [])
      .filter((branch) => !branch.vendor_id && (!data.branchId || branch.id === data.branchId))
      .map((branch) => ({ id: branch.id, name: branch.name, code: branch.code }));
    const report = buildGodownReport({ godowns, orders, items, costs, commissions, branchNames });
    return { ...report, from: data.from, to: data.to, generatedAt: new Date().toISOString(), truncated: (orderRows ?? []).length >= 5000 };
  });
