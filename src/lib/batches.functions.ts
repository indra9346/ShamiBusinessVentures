import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import type { BatchAdjustment, BatchAllocation, BatchOrder, BatchOrderItem, BatchRecord } from "@/lib/batches";
import type { BatchTransfer } from "@/lib/batch-transfers";
import { parsePreorderSettings } from "@/lib/preorder";
import { parseKg, type StoredCostDoc, type StoredCostTag } from "@/lib/batch-costs";

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
/** PostgREST returns at most 1,000 rows per request. */
const PAGE = 1000;
const n = (value: unknown) => Number(value) || 0;

/** Every row of a query, page by page, so no report figure is cut off at the row cap. */
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

/** When Zoho's godown stock was last read: read = stock items were actually read (not skipped); failed = items that could not be. */
export type ZohoStockRead = { at: string | null; read: boolean; items: number; failed: number; error: string };

export type BatchProductOption = {
  id: string; name: string; sku: string; unit: string; purchasePrice: number;
  /** The website's selling price (with GST) and GST rate (19 Nov 2026: the Lots page's market price to start from). */
  price?: number; gstRate?: number;
  zohoLinked: boolean; zohoTracksBatches: boolean; stock: Record<string, number>;
  /** A pack's weight in kg from the product's weight text, for splitting an expense by weight (null: not in kg). */
  weightKg: number | null;
};

/**
 * Zoho expenses and bill charges tagged to batches, with their tags (14 Nov 2026, spec 8). Empty until the expenses
 * migration (20261114100000) is applied, so the page works either way.
 */
async function costRows(db: ReturnType<typeof serviceClient>) {
  const tags: StoredCostTag[] = [];
  try {
    tags.push(...(await allRows((from, to) => db.from("batch_cost_tags").select("id,document_id,batch_id,amount,method,weight,note,tagged_by_name,tagged_at")
      .order("id").range(from, to), "expense tags")).map((t) => ({ ...t, amount: n(t.amount), weight: n(t.weight) })));
  } catch {
    return { costDocuments: [] as StoredCostDoc[], costTags: tags };
  }
  // Every document with tags, and those flagged (a deleted or changed expense is shown until it is dealt with).
  const ids = [...new Set(tags.map((t) => t.document_id))];
  const docs: StoredCostDoc[] = [];
  const seen = new Set<number>();
  const add = (rows: StoredCostDoc[]) => {
    for (const d of rows) if (!seen.has(d.id)) {
      seen.add(d.id);
      docs.push({ ...d, amount_before_gst: n(d.amount_before_gst), gst_amount: n(d.gst_amount), cost_amount: n(d.cost_amount),
        accepted_cost_amount: d.accepted_cost_amount === null ? null : n(d.accepted_cost_amount) });
    }
  };
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const { data, error } = await db.from("zoho_cost_documents").select("*").in("id", ids.slice(start, start + IN_CHUNK));
    if (error) throw new Error("Could not read the tagged expenses");
    add((data ?? []) as StoredCostDoc[]);
  }
  const { data: flagged } = await db.from("zoho_cost_documents").select("*").neq("flag", "").limit(200);
  add((flagged ?? []) as StoredCostDoc[]);
  return { costDocuments: docs, costTags: tags };
}

/** A batch's bought quantity changed (17 Nov 2026: relinked to a bill of 340 instead of 360), as recorded. */
export type BatchQuantityChange = {
  id: number; batch_id: string; quantity_before: number; quantity_after: number; remaining_before: number | null;
  remaining_after: number | null; reason: string; bill_number: string; by_name: string; at: string;
};

/** Every recorded change of a batch's bought quantity; none until migration 20261117160000 is applied. */
async function quantityChanges(db: ReturnType<typeof serviceClient>): Promise<BatchQuantityChange[]> {
  try {
    const rows = await allRows((from, to) => db.from("batch_quantity_changes")
      .select("id,batch_id,quantity_before,quantity_after,remaining_before,remaining_after,reason,bill_number,by_name,at")
      .order("at", { ascending: false }).order("id").range(from, to), "quantity changes");
    return rows.map((r) => ({ ...r, quantity_before: n(r.quantity_before), quantity_after: n(r.quantity_after),
      remaining_before: r.remaining_before === null ? null : n(r.remaining_before), remaining_after: r.remaining_after === null ? null : n(r.remaining_after) }));
  } catch {
    return [];
  }
}

export const getBatchData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const [batchRows, adjustmentRows, branchesResult, productRows, linkRows, stockRows, masterResult, reservedRows, transferRows, zohoNotes] = await Promise.all([
      allRows((from, to) => db.from("batches").select("*").order("created_at").order("id").range(from, to), "batches"),
      allRows((from, to) => db.from("batch_adjustments").select("id,batch_id,qty,reason,note,unit_cost,created_at,created_by_name")
        .order("created_at", { ascending: false }).order("id").range(from, to), "batch losses and gains"),
      db.from("branches").select("id,name,code,vendor_id,active,zoho_location_id,sort_order").order("sort_order"),
      allRows((from, to) => db.from("catalog_products").select("id,vendor_id,active,payload").order("id").range(from, to), "products"),
      allRows((from, to) => db.from("zoho_item_links").select("product_id,zoho_item_id,track_batches").order("product_id").range(from, to), "Zoho item links"),
      allRows((from, to) => db.from("branch_stock").select("branch_id,product_id,stock").order("branch_id").order("product_id").range(from, to), "godown stock"),
      db.from("settings").select("value").eq("key", "zoho_stock_master").maybeSingle(),
      // Numbers already handed out (a receipt or Zoho batch that may not be a website batch yet).
      allRows((from, to) => db.from("batch_code_reservations").select("code").order("code").range(from, to), "batch numbers"),
      // Moves between godowns (10 Nov 2026): received bills at another place, batches sent to other godowns.
      allRows((from, to) => db.from("batch_transfers")
        .select("id,transfer_no,kind,status,from_branch_id,from_location_id,from_location_name,to_branch_id,to_location_id,parent_batch_id,quantity,bill,lines,zoho_transfer_order_id,zoho_status,attempts,last_error,result,created_at,created_by_name,sent_at,received_at,received_by_name,received_by_role,create_sent_at,zoho_number_taken")
        .order("id", { ascending: false }).range(from, to), "transfers between godowns"),
      // When Zoho's godown stock was last read, and how it went (13 Nov 2026: the scheduled check had stopped for two
      // days unnoticed). zoho_godown_stock_check is written after each godown stock run; until the first one, the time
      // the hourly check last started is the best there is.
      db.from("settings").select("key,value").in("key", ["zoho_godown_stock_check", "zoho_api_budget", "preorder"]),
    ]);
    // Pre-order batches (14 Nov 2026): the watch per godown and product (held units, the last reading), the ready /
    // arriving split, and the latest lot events (Admin › Batches › Pre-orders).
    const [watchRows, splitRows, lotEvents, costs, quantityChangeRows] = await Promise.all([
      allRows((from, to) => db.from("preorder_watch").select("*").order("product_id").order("branch_id").range(from, to), "pre-order watches"),
      allRows((from, to) => db.from("branch_stock").select("branch_id,product_id,stock,free_total,incoming,incoming_detail,zoho_pending")
        .or("incoming.gt.0,zoho_pending.eq.true").order("branch_id").order("product_id").range(from, to), "arriving stock"),
      db.from("batch_lot_events").select("id,batch_id,branch_id,product_id,kind,qty,detail,by_name,note,created_at").order("id", { ascending: false }).limit(300),
      costRows(db),
      quantityChanges(db),
    ]);
    if (branchesResult.error || masterResult.error) throw new Error("Could not read godowns and settings");
    const setting = (key: string) => {
      const value = (zohoNotes.data ?? []).find((row) => row.key === key)?.value;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    };
    const stockRun = setting("zoho_godown_stock_check");
    const pollAt = setting("zoho_api_budget")?.["lastInboundPollAt"];
    const zohoStock: ZohoStockRead = stockRun && typeof stockRun["at"] === "string"
      ? {
        at: stockRun["at"], read: stockRun["enabled"] === true && n(stockRun["items"]) > 0, items: n(stockRun["items"]),
        failed: n(stockRun["failed"]), error: typeof stockRun["error"] === "string" ? stockRun["error"] : "",
      }
      : { at: typeof pollAt === "string" && pollAt ? pollAt : null, read: true, items: 0, failed: 0, error: "" };
    const batches: BatchRecord[] = batchRows.map((b) => ({
      ...b,
      quantity: n(b.quantity), remaining_quantity: n(b.remaining_quantity), unit_cost: n(b.unit_cost),
      zoho_balance: b.zoho_balance === null ? null : n(b.zoho_balance),
      sent_quantity: b.sent_quantity === undefined || b.sent_quantity === null ? null : n(b.sent_quantity),
      stage: b.stage ?? "received", hold_back: n(b.hold_back),
      expected_quantity: b.expected_quantity === undefined || b.expected_quantity === null ? null : n(b.expected_quantity),
      est_unit_cost_ex_gst: b.est_unit_cost_ex_gst === undefined || b.est_unit_cost_ex_gst === null ? null : n(b.est_unit_cost_ex_gst),
    }));
    const batchIds = batches.map((b) => b.id);

    const allocations: BatchAllocation[] = [];
    for (let start = 0; start < batchIds.length; start += IN_CHUNK) {
      const ids = batchIds.slice(start, start + IN_CHUNK);
      const rows = await allRows((from, to) => db.from("order_item_batch_allocations")
        .select("id,order_item_id,batch_id,reserved_quantity,released_quantity,unit_cost,created_at")
        .in("batch_id", ids).order("id").range(from, to), "batch sales");
      for (const a of rows) allocations.push({ ...a, reserved_quantity: n(a.reserved_quantity), released_quantity: n(a.released_quantity), unit_cost: n(a.unit_cost) });
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
        .select("id,order_no,created_at,order_status,payment_status,branch_id,user_id,customer_name,customer_email,customer_phone,shipping_address,subtotal,discount,payment_hold_until,gst_amount,prices_include_gst")
        .in("id", orderIds.slice(start, start + IN_CHUNK));
      if (error) throw new Error("Could not read orders");
      for (const order of data ?? []) orders.push({ ...order, subtotal: n(order.subtotal), discount: n(order.discount) });
    }
    const adjustments: BatchAdjustment[] = adjustmentRows.map((a) => ({ ...a, qty: n(a.qty), unit_cost: n(a.unit_cost) }));

    const links = new Map(linkRows.map((link) => [link.product_id, link]));
    const stock = new Map<string, Record<string, number>>();
    for (const row of stockRows) stock.set(row.product_id, { ...(stock.get(row.product_id) ?? {}), [row.branch_id]: n(row.stock) });
    const products: BatchProductOption[] = productRows
      .filter((p) => !String(p.vendor_id ?? "").startsWith("zoho:"))
      .map((p) => {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        const link = links.get(p.id);
        return {
          id: p.id, name: String(payload["name"] ?? p.id), sku: String(payload["sku"] ?? ""), unit: String(payload["unit"] ?? ""),
          purchasePrice: n(payload["purchasePrice"]), price: n(payload["price"]), gstRate: n(payload["gst"]), zohoLinked: Boolean(link?.zoho_item_id), zohoTracksBatches: Boolean(link?.track_batches),
          stock: stock.get(p.id) ?? {}, weightKg: parseKg(payload["weight"]),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const master = (masterResult.data?.value ?? {}) as Record<string, unknown>;
    const godownNames = new Map((branchesResult.data ?? []).map((b) => [b.id, b.name]));
    const batchCodes = new Map(batches.map((b) => [b.id, b.batch_code]));
    const transfers: BatchTransfer[] = transferRows.map((t) => ({
      ...t,
      kind: t.kind as BatchTransfer["kind"], status: t.status as BatchTransfer["status"],
      quantity: t.quantity === null ? null : n(t.quantity),
      to_name: godownNames.get(t.to_branch_id) ?? t.to_branch_id,
      from_name: t.from_branch_id ? godownNames.get(t.from_branch_id) ?? t.from_location_name : t.from_location_name,
      received_by_role: (t.received_by_role ?? null) as "admin" | "staff" | "partner" | "zoho" | null,
      parent_batch_code: t.parent_batch_id ? batchCodes.get(t.parent_batch_id) ?? null : null,
      bill_number: t.bill && typeof t.bill === "object" && !Array.isArray(t.bill) ? String((t.bill as Record<string, unknown>)["bill_number"] ?? "") : null,
      lines: (Array.isArray(t.lines) ? t.lines : []) as unknown as BatchTransfer["lines"],
      result: (Array.isArray(t.result) ? t.result : null) as unknown as BatchTransfer["result"],
    }));
    return {
      generatedAt: new Date().toISOString(),
      zohoStockMaster: master["enabled"] === true,
      zohoStock,
      godowns: (branchesResult.data ?? []).filter((b) => !b.vendor_id).map((b) => ({ id: b.id, name: b.name, code: b.code, active: b.active, zohoLinked: Boolean(b.zoho_location_id) })),
      products, batches, allocations, items, orders, adjustments, reservedCodes: reservedRows.map((row) => row.code), transfers,
      // Batch expenses (14 Nov 2026): the report spreads these over each batch's units (buildBatchReport).
      costDocuments: costs.costDocuments, costTags: costs.costTags,
      quantityChanges: quantityChangeRows,
      preorder: {
        settings: parsePreorderSettings(setting("preorder")),
        watches: watchRows.map((w) => ({ ...w, zoho_last: n(w.zoho_last), held: n(w.held), last_waiting: n(w.last_waiting), last_unbilled: n(w.last_unbilled),
          last_raw: w.last_raw === null ? null : n(w.last_raw), pending_delta: n(w.pending_delta) })),
        stock: splitRows.map((row) => ({ ...row, stock: n(row.stock), free_total: n(row.free_total), incoming: n(row.incoming) })),
        events: (lotEvents.data ?? []).map((e) => ({ ...e, qty: e.qty === null ? null : n(e.qty) })),
      },
    };
  });

export type BatchData = Awaited<ReturnType<typeof getBatchData>>;
