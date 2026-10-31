import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { BatchAdjustment, BatchAllocation, BatchOrder, BatchOrderItem, BatchRecord } from "@/lib/batches";

/*
 * Admin > Batches: every batch with the orders and customers it went to, its losses and gains,
 * and what the "Receive purchase" form needs (godowns, products with their Zoho link and godown
 * stock). Read-only; the page adds it up with buildBatchReport (src/lib/batches.ts).
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

const IN_CHUNK = 200;
const n = (value: unknown) => Number(value) || 0;

export type BatchProductOption = {
  id: string; name: string; sku: string; unit: string; purchasePrice: number;
  zohoLinked: boolean; zohoTracksBatches: boolean; stock: Record<string, number>;
};

export const getBatchData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const [batchesResult, adjustmentsResult, branchesResult, productsResult, linksResult, stockResult, masterResult] = await Promise.all([
      db.from("batches").select("*").order("purchase_date", { ascending: false }).limit(5000),
      db.from("batch_adjustments").select("id,batch_id,qty,reason,note,unit_cost,created_at,created_by_name").order("created_at", { ascending: false }).limit(5000),
      db.from("branches").select("id,name,code,vendor_id,active,zoho_location_id,sort_order").order("sort_order"),
      db.from("catalog_products").select("id,vendor_id,active,payload"),
      db.from("zoho_item_links").select("product_id,zoho_item_id,track_batches"),
      db.from("branch_stock").select("branch_id,product_id,stock"),
      db.from("settings").select("value").eq("key", "zoho_stock_master").maybeSingle(),
    ]);
    if (batchesResult.error || branchesResult.error || productsResult.error) throw new Error("Could not read batches");
    const batches: BatchRecord[] = (batchesResult.data ?? []).map((b) => ({
      ...b,
      quantity: n(b.quantity), remaining_quantity: n(b.remaining_quantity), unit_cost: n(b.unit_cost),
      zoho_balance: b.zoho_balance === null ? null : n(b.zoho_balance),
    }));
    const batchIds = batches.map((b) => b.id);

    const allocations: BatchAllocation[] = [];
    for (let start = 0; start < batchIds.length; start += IN_CHUNK) {
      const { data, error } = await db.from("order_item_batch_allocations")
        .select("id,order_item_id,batch_id,reserved_quantity,released_quantity,unit_cost,created_at")
        .in("batch_id", batchIds.slice(start, start + IN_CHUNK));
      if (error) throw new Error("Could not read batch sales");
      for (const a of data ?? []) allocations.push({ ...a, reserved_quantity: n(a.reserved_quantity), released_quantity: n(a.released_quantity), unit_cost: n(a.unit_cost) });
    }
    const itemIds = [...new Set(allocations.map((a) => a.order_item_id))];
    const items: BatchOrderItem[] = [];
    for (let start = 0; start < itemIds.length; start += IN_CHUNK) {
      const { data, error } = await db.from("order_items").select("id,order_id,product_id,product_name,qty,unit_price,gst_rate")
        .in("id", itemIds.slice(start, start + IN_CHUNK));
      if (error) throw new Error("Could not read order items");
      for (const item of data ?? []) items.push({ ...item, qty: n(item.qty), unit_price: n(item.unit_price), gst_rate: n(item.gst_rate) });
    }
    const orderIds = [...new Set(items.map((item) => item.order_id))];
    const orders: BatchOrder[] = [];
    for (let start = 0; start < orderIds.length; start += IN_CHUNK) {
      const { data, error } = await db.from("orders")
        .select("id,order_no,created_at,order_status,payment_status,branch_id,user_id,customer_name,customer_email,customer_phone,shipping_address,subtotal,discount")
        .in("id", orderIds.slice(start, start + IN_CHUNK));
      if (error) throw new Error("Could not read orders");
      for (const order of data ?? []) orders.push({ ...order, subtotal: n(order.subtotal), discount: n(order.discount) });
    }
    const adjustments: BatchAdjustment[] = (adjustmentsResult.data ?? []).map((a) => ({ ...a, qty: n(a.qty), unit_cost: n(a.unit_cost) }));

    const links = new Map((linksResult.data ?? []).map((link) => [link.product_id, link]));
    const stock = new Map<string, Record<string, number>>();
    for (const row of stockResult.data ?? []) stock.set(row.product_id, { ...(stock.get(row.product_id) ?? {}), [row.branch_id]: n(row.stock) });
    const products: BatchProductOption[] = (productsResult.data ?? [])
      .filter((p) => !String(p.vendor_id ?? "").startsWith("zoho:"))
      .map((p) => {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        const link = links.get(p.id);
        return {
          id: p.id, name: String(payload["name"] ?? p.id), sku: String(payload["sku"] ?? ""), unit: String(payload["unit"] ?? ""),
          purchasePrice: n(payload["purchasePrice"]), zohoLinked: Boolean(link?.zoho_item_id), zohoTracksBatches: Boolean(link?.track_batches),
          stock: stock.get(p.id) ?? {},
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const master = (masterResult.data?.value ?? {}) as Record<string, unknown>;
    return {
      generatedAt: new Date().toISOString(),
      zohoStockMaster: master["enabled"] === true,
      godowns: (branchesResult.data ?? []).filter((b) => !b.vendor_id).map((b) => ({ id: b.id, name: b.name, code: b.code, active: b.active, zohoLinked: Boolean(b.zoho_location_id) })),
      products, batches, allocations, items, orders, adjustments,
    };
  });

export type BatchData = Awaited<ReturnType<typeof getBatchData>>;
