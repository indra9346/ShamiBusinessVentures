import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  billCheckSince, istToday, openPurchaseOrders, openingHold, poLineOpen, purchaseOrderLine, readyAfterOpening, unreceivedLines, zohoTimeMs,
  type UnreceivedLine,
} from "@/lib/preorder";

/*
 * Admin › Batches › pre-orders (client, "Approved", 14 Nov 2026; spec section 7.2). A pre-order batch (a lot) is made
 * from a Zoho purchase order line or typed; while it waits for its bill, customers may order its units. Everything here
 * is for administrators only (spec 17.6). Every action that gives the database a Zoho reading reads the waiting order
 * lines first, then Zoho, then saves (spec 2.5); every Zoho call is logged under its purpose, refused while Zoho's daily
 * limit is reached, and pauses Zoho when the limit answer comes. The rules are in src/lib/preorder.ts and the database
 * (supabase/migrations/20261114110000_preorder_batches.sql), which checks everything again under its locks.
 */

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

const kit = async () => (await import("@/lib/zoho-commerce.functions")).preorderZohoKit();
type Kit = Awaited<ReturnType<typeof kit>>;
const str = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const n = (value: unknown) => Number(value) || 0;
const plain = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const TOO_MANY_BILLS = "Too many recent bills to check; try again in a minute";

/** The product, its Zoho item and the godown, with what stops a pre-order (the database says the same, under its locks). */
async function productAndGodown(k: Kit, branchId: string, productId: string) {
  const [{ data: branch }, { data: product }, { data: link }] = await Promise.all([
    k.db.from("branches").select("id,name,code,active,vendor_id,zoho_location_id").eq("id", branchId).maybeSingle(),
    k.db.from("catalog_products").select("id,status,active,vendor_id,payload").eq("id", productId).maybeSingle(),
    k.db.from("zoho_item_links").select("zoho_item_id,track_batches").eq("product_id", productId).maybeSingle(),
  ]);
  if (!branch?.active || branch.vendor_id || !branch.zoho_location_id) throw new Error("Choose an active godown linked to a Zoho location");
  const payload = plain(product?.payload);
  const name = str(payload["name"]) || productId;
  if (!product || product.status !== "approved" || !product.active || str(product.vendor_id).startsWith("zoho:")) throw new Error(`${name} is not a website product`);
  if (!link?.zoho_item_id) throw new Error(`${name} is not linked to a Zoho item, so its bill can't be matched`);
  if (link.track_batches) throw new Error(`${name} has batch tracking in Zoho: its batches come from Zoho`);
  return {
    branch: branch as { id: string; name: string; code: string; zoho_location_id: string },
    product: { id: product.id, name, unit: str(payload["unit"]), gst: n(payload["gst"]), purchasePrice: n(payload["purchasePrice"]), zohoItemId: link.zoho_item_id },
  };
}

/** Lines of recent Zoho bills of an item at a godown that no batch has yet (the bill check, spec 7.3). */
async function unreceivedAt(k: Kit, godown: { id: string; name: string; zoho_location_id: string }, itemId: string, sinceIso: string) {
  const check = await k.billCheck({ locationId: godown.zoho_location_id, sinceIso });
  if (check.incomplete) throw new Error(TOO_MANY_BILLS);
  return unreceivedLines(check.bills, { itemId, locationId: godown.zoho_location_id, batchedLines: check.batchedLines })
    .map((line) => ({ ...line, branchId: godown.id, godownName: godown.name }));
}

/** Zoho's numbers now at every Zoho godown for one product, after the waiting order lines were read. */
async function readNow(k: Kit, product: { id: string; zohoItemId: string }) {
  const readAt = new Date().toISOString();
  const snapshot = await k.snapshot([product.id]);
  const godowns = await k.godowns();
  const { readings } = await k.readings([{ productId: product.id, zohoItemId: product.zohoItemId }], godowns);
  return { readAt, snapshot, godowns, readings };
}

const waitingUnits = async (k: Kit, ids: string[]) => {
  if (!ids.length) return 0;
  const { data } = await k.db.from("order_items").select("qty").in("id", ids);
  return (data ?? []).reduce((sum, row) => sum + n(row.qty), 0);
};

/**
 * New pre-order: Zoho's stock now at every godown, ready stock, the hold a godown would start with, recent bills of the
 * product not received on the website (each needs Receive it or Not this purchase), and cost suggestions (the PO rate
 * comes with the PO; else the last bill batch's cost before GST; the product's purchase price is shown, never used).
 */
export const getIncomingSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40), productId: z.string().trim().min(1).max(100) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: setup", async () => {
      const { branch, product } = await productAndGodown(k, data.branchId, data.productId);
      const now = await readNow(k, product);
      const [watches, { data: stockRows }, { data: lastBill }, { data: lots }] = await Promise.all([
        k.watches([product.id]),
        k.db.from("branch_stock").select("branch_id,stock,free_total,zoho_pending").eq("product_id", product.id),
        k.db.from("batches").select("batch_code,unit_cost_ex_gst,purchase_date").eq("product_id", product.id).eq("stage", "received").neq("zoho_bill_id", "")
          .order("purchase_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        k.db.from("batches").select("batch_code,branch_id,quantity,remaining_quantity,expected_date").eq("product_id", product.id).eq("stage", "incoming"),
      ]);
      const stockOf = new Map((stockRows ?? []).map((row) => [row.branch_id, row]));
      const godowns = await Promise.all(now.godowns.map(async (g) => {
        const zoho = now.readings.find((r) => r.branch_id === g.id)?.zoho ?? 0;
        const row = stockOf.get(g.id);
        const watch = watches.get(`${g.id}|${product.id}`);
        const waiting = await waitingUnits(k, now.snapshot[`${g.id}|${product.id}`] ?? []);
        const totalBefore = n(row?.free_total ?? row?.stock);
        return {
          id: g.id, name: g.name, zoho, ready: n(row?.stock), total: totalBefore, pending: Boolean(row?.zoho_pending), watched: Boolean(watch),
          held: n(watch?.held), waiting,
          openingHold: watch ? 0 : openingHold({ reading: zoho, totalBefore, waiting }),
          readyAfter: watch ? n(row?.stock) : readyAfterOpening({ reading: zoho, totalBefore, waiting }),
        };
      }));
      const unreceived = await unreceivedAt(k, branch, product.zohoItemId, billCheckSince(Date.now()));
      const { data: transfers } = await k.db.from("batch_transfers").select("transfer_no,product_id,lines").in("status", ["pending", "in_transit"]);
      const transferOpen = (transfers ?? []).some((t) => t.product_id === product.id
        || (Array.isArray(t.lines) && t.lines.some((line) => str(plain(line)["product_id"]) === product.id)));
      const pendingAt = godowns.find((g) => g.pending);
      return {
        readAt: now.readAt, todayIst: istToday(), product: { id: product.id, name: product.name, unit: product.unit, gst: product.gst },
        godown: { id: branch.id, name: branch.name, code: branch.code }, godowns, unreceived,
        lots: (lots ?? []).map((l) => ({ code: l.batch_code, branchId: str(l.branch_id), quantity: n(l.quantity), sold: n(l.quantity) - n(l.remaining_quantity), expectedDate: str(l.expected_date) })),
        cost: { lastBill: lastBill ? n(lastBill.unit_cost_ex_gst) || null : null, lastBillCode: str(lastBill?.batch_code), purchasePrice: product.purchasePrice },
        blockers: [
          ...(pendingAt ? [`A stock edit for ${product.name} at ${pendingAt.name} is waiting to go to Zoho. Press Sync godowns now first.`] : []),
          ...(transferOpen ? [`A transfer of ${product.name} between godowns is not finished. Finish or cancel it first.`] : []),
        ],
      };
    });
  });

/** Zoho purchase orders still open (not cancelled, closed or billed), this godown's location first. One Zoho call. */
export const listOpenPurchaseOrders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: purchase orders", async () => {
      const { data: branch } = await k.db.from("branches").select("zoho_location_id").eq("id", data.branchId).maybeSingle();
      const answer = await k.get<{ purchaseorders?: Record<string, unknown>[] }>("purchaseorders", { per_page: "200", sort_column: "date", sort_order: "D" });
      return openPurchaseOrders(answer.purchaseorders ?? [], str(branch?.zoho_location_id));
    });
  });

/**
 * One purchase order's lines: the website product of each, why one can't be a pre-order, the rate before GST, and the
 * units still open (ordered - billed when Zoho says - already in live pre-order batches). One Zoho call.
 */
export const getPurchaseOrderLines = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ poId: z.string().trim().regex(/^\d{1,30}$/) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: purchase orders", async () => {
      const raw = (await k.get<{ purchaseorder?: Record<string, unknown> }>(`purchaseorders/${encodeURIComponent(data.poId)}`)).purchaseorder;
      if (!raw) throw new Error("Zoho did not return the purchase order");
      const inclusive = raw["is_inclusive_tax"] === true;
      const lines = (Array.isArray(raw["line_items"]) ? raw["line_items"] as Record<string, unknown>[] : []).map((line) => purchaseOrderLine(line, inclusive));
      const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))];
      const [{ data: links }, { data: lots }] = await Promise.all([
        itemIds.length ? k.db.from("zoho_item_links").select("product_id,zoho_item_id,track_batches").in("zoho_item_id", itemIds) : Promise.resolve({ data: [] }),
        k.db.from("batches").select("zoho_po_line_id,quantity,batch_code").eq("zoho_po_id", data.poId).eq("stage", "incoming"),
      ]);
      const linkOf = new Map(((links ?? []) as { product_id: string; zoho_item_id: string; track_batches: boolean }[]).map((l) => [l.zoho_item_id, l]));
      const productIds = [...new Set([...linkOf.values()].map((l) => l.product_id))];
      const { data: products } = productIds.length ? await k.db.from("catalog_products").select("id,vendor_id,payload").in("id", productIds) : { data: [] };
      const nameOf = new Map((products ?? []).filter((p) => !str(p.vendor_id).startsWith("zoho:")).map((p) => [p.id, str(plain(p.payload)["name"]) || p.id]));
      return {
        po: {
          poId: str(raw["purchaseorder_id"]), number: str(raw["purchaseorder_number"]), vendorName: str(raw["vendor_name"]),
          date: str(raw["date"]).slice(0, 10), expectedDate: str(raw["delivery_date"] ?? raw["expected_delivery_date"]).slice(0, 10),
          locationId: str(raw["location_id"] ?? raw["branch_id"]), status: str(raw["status"]).toLowerCase(),
        },
        lines: lines.map((line) => {
          const link = linkOf.get(line.itemId);
          const productId = link && nameOf.has(link.product_id) ? link.product_id : "";
          const taken = (lots ?? []).filter((l) => l.zoho_po_line_id === line.lineId);
          const inLots = taken.reduce((sum, l) => sum + n(l.quantity), 0);
          const open = poLineOpen(line, inLots);
          const blocker = !productId ? "This Zoho item is not a website product"
            : link?.track_batches ? "Zoho tracks batches for this item: its batches come from Zoho"
            : taken.length ? `Already pre-order batch ${taken.map((l) => l.batch_code).join(", ")}`
            : open <= 0 ? "Nothing open on this line" : "";
          return { ...line, productId, productName: productId ? nameOf.get(productId) ?? "" : "", inLots, open, blocker };
        }),
      };
    });
  });

/**
 * Makes a pre-order batch. Everything is read again here, never trusted from the browser: the waiting order lines,
 * Zoho's stock at every godown, the recent bills of the product (each not on a batch needs "Not this purchase"), and
 * the purchase order when one is named. Then create_incoming_batch, which checks it all again under its locks.
 */
export const createIncomingBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1).max(40),
    productId: z.string().trim().min(1).max(100),
    quantity: z.number().positive().max(1_000_000),
    unitCostExGst: z.number().positive().max(100_000_000),
    expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    holdBack: z.number().min(0).max(1_000_000).default(0),
    supplier: z.string().trim().max(120).default(""),
    notes: z.string().trim().max(300).default(""),
    po: z.object({ poId: z.string().trim().regex(/^\d{1,30}$/), lineId: z.string().trim().min(1).max(40) }).nullable().default(null),
    /** Bill lines the admin ticked "Not this purchase" ("billId|lineId"). */
    notThisPurchase: z.array(z.string().trim().max(90)).max(100).default([]),
    /** One per opening of the dialog: a repeated press (a lost reply) gets the lot it made (review fix). */
    requestId: z.string().uuid().optional(),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: setup", async () => {
      const { branch, product } = await productAndGodown(k, data.branchId, data.productId);
      let po: { po_id: string; po_number: string; line_id: string } | null = null;
      let supplier = data.supplier;
      if (data.po) {
        const raw = (await k.get<{ purchaseorder?: Record<string, unknown> }>(`purchaseorders/${encodeURIComponent(data.po.poId)}`)).purchaseorder;
        const line = (Array.isArray(raw?.["line_items"]) ? raw!["line_items"] as Record<string, unknown>[] : []).find((l) => str(l["line_item_id"]) === data.po!.lineId);
        if (!raw || !line) throw new Error("That purchase order line is no longer in Zoho. Choose it again.");
        if (str(line["item_id"]) !== product.zohoItemId) throw new Error(`That purchase order line is another item, not ${product.name}`);
        if (["cancelled", "closed", "billed"].includes(str(raw["status"]).toLowerCase())) throw new Error(`Purchase order ${str(raw["purchaseorder_number"])} is ${str(raw["status"]).toLowerCase()} in Zoho`);
        po = { po_id: str(raw["purchaseorder_id"]), po_number: str(raw["purchaseorder_number"]), line_id: data.po.lineId };
        supplier = supplier || str(raw["vendor_name"]);
      }
      const now = await readNow(k, product);
      const unreceived = await unreceivedAt(k, branch, product.zohoItemId, billCheckSince(Date.now()));
      const ticked = new Set(data.notThisPurchase);
      const checks = {
        unreceived: unreceived.map((line: UnreceivedLine & { branchId: string }) => ({
          bill_id: line.billId, bill_number: line.billNumber, line_id: line.lineId, qty: line.qty, branch_id: line.branchId,
          ack: ticked.has(`${line.billId}|${line.lineId}`),
        })),
        checked_at: now.readAt,
        ...(data.requestId ? { request: data.requestId } : {}),
      };
      const { data: made, error } = await k.db.rpc("create_incoming_batch", {
        _branch_id: branch.id, _product_id: product.id, _quantity: data.quantity, _unit_cost_ex_gst: data.unitCostExGst,
        _expected_date: data.expectedDate, _hold_back: data.holdBack, _supplier: supplier, _po: po as unknown as Json, _notes: data.notes,
        _checks: checks as unknown as Json, _readings: now.readings as unknown as Json, _snapshot: now.snapshot as unknown as Json,
        _read_at: now.readAt, _by: context.userId, _by_name: await k.adminName(context.userId),
      });
      if (error) throw new Error(error.message);
      const result = plain(made);
      return {
        batchId: str(result["batch_id"]), batchCode: str(result["batch_code"]), ready: n(result["ready"]), incoming: n(result["incoming"]),
        total: n(result["total"]), heldAtOpen: Object.fromEntries(Object.entries(plain(result["held_at_open"])).map(([g, v]) => [g, n(v)])),
      };
    });
  });

/** Edit a pre-order batch (quantity, date, cost estimate, hold-back, pause, supplier, notes). No Zoho call. */
export const updateIncomingBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    batchId: z.string().uuid(),
    quantity: z.number().positive().max(1_000_000).nullable().default(null),
    expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    unitCostExGst: z.number().positive().max(100_000_000).nullable().default(null),
    holdBack: z.number().min(0).max(1_000_000).nullable().default(null),
    paused: z.boolean().nullable().default(null),
    supplier: z.string().trim().max(120).nullable().default(null),
    notes: z.string().trim().max(300).nullable().default(null),
    note: z.string().trim().max(300).default(""),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: done, error } = await context.supabase.rpc("admin_update_incoming_batch", {
      _batch_id: data.batchId, _quantity: data.quantity as number, _expected_date: data.expectedDate as string, _unit_cost_ex_gst: data.unitCostExGst as number,
      _hold_back: data.holdBack as number, _paused: data.paused as boolean, _supplier: data.supplier as string, _notes: data.notes as string, _note: data.note,
    });
    if (error) throw new Error(error.message);
    return (done ?? null) as Json;
  });

/** Cancel a pre-order batch nobody waits for (the supplier called it off). No Zoho call. */
export const cancelIncomingBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ batchId: z.string().uuid(), note: z.string().trim().max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: done, error } = await context.supabase.rpc("admin_cancel_incoming_batch", { _batch_id: data.batchId, _note: data.note });
    if (error) throw new Error(error.message);
    return (done ?? null) as Json;
  });

/** One bill line for two pre-order batches: join them first (the second's orders and units move to the first). No Zoho call. */
export const joinIncomingBatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ into: z.string().uuid(), from: z.string().uuid(), note: z.string().trim().max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: done, error } = await context.supabase.rpc("admin_join_incoming_batches", { _into: data.into, _from: data.from, _note: data.note });
    if (error) throw new Error(error.message);
    return (done ?? null) as Json;
  });

/** Give an order line ready stock instead of its pre-order units (it then goes on to Zoho at once if nothing else waits). */
export const moveOrderLineToReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ orderItemId: z.string().uuid(), qty: z.number().positive().max(1_000_000), note: z.string().trim().max(300).default("") }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const { data: done, error } = await context.supabase.rpc("admin_move_to_ready", { _order_item_id: data.orderItemId, _qty: data.qty, _note: data.note });
    if (error) throw new Error(error.message);
    return (done ?? null) as Json;
  });

/**
 * Match now: the recent bills of a product with a pre-order batch at its godown that no batch has yet (the bill check,
 * window from when its watch opened), so the admin opens the right one in Receive purchase.
 */
export const findBillsForProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40), productId: z.string().trim().min(1).max(100) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: bill check", async () => {
      const [{ data: branch }, { data: link }, watches] = await Promise.all([
        k.db.from("branches").select("id,name,zoho_location_id").eq("id", data.branchId).maybeSingle(),
        k.db.from("zoho_item_links").select("zoho_item_id").eq("product_id", data.productId).maybeSingle(),
        k.watches([data.productId]),
      ]);
      if (!branch?.zoho_location_id) throw new Error("Choose a godown linked to a Zoho location");
      if (!link?.zoho_item_id) throw new Error("This product is not linked to a Zoho item");
      const since = billCheckSince(Date.now(), [...watches.values()].map((w) => w.opened_at));
      return { bills: await unreceivedAt(k, branch as { id: string; name: string; zoho_location_id: string }, link.zoho_item_id, since) };
    });
  });

/**
 * "It is other stock…": an administrator says what units held at a godown are (not a pre-order's bill), and they count
 * as stock. Refused while a recent bill of the product at that godown, made after the watch opened, is not on a batch
 * and not ticked as regular stock: that bill is most likely the pre-order's, to be matched instead.
 */
export const releasePreorderHold = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1).max(40), productId: z.string().trim().min(1).max(100),
    qty: z.number().positive().max(1_000_000), note: z.string().trim().max(300),
    /** Bill lines ticked as regular stock ("billId|lineId"). */
    regularBills: z.array(z.string().trim().max(90)).max(100).default([]),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: bill check", async () => {
      const { data: branch } = await k.db.from("branches").select("id,name,zoho_location_id").eq("id", data.branchId).maybeSingle();
      const { data: link } = await k.db.from("zoho_item_links").select("zoho_item_id").eq("product_id", data.productId).maybeSingle();
      const watch = (await k.watches([data.productId])).get(`${data.branchId}|${data.productId}`);
      if (!branch?.zoho_location_id || !link?.zoho_item_id || !watch) throw new Error(`Only 0 is held at ${branch?.name ?? "this godown"}`);
      const now = await readNow(k, { id: data.productId, zohoItemId: link.zoho_item_id });
      const since = billCheckSince(Date.now(), [watch.opened_at]);
      const ticked = new Set(data.regularBills);
      const bills = await unreceivedAt(k, branch as { id: string; name: string; zoho_location_id: string }, link.zoho_item_id, since);
      const later = bills.filter((b) => {
        const created = zohoTimeMs(b.createdTime);
        return (!Number.isFinite(created) || created > Date.parse(watch.opened_at)) && !ticked.has(`${b.billId}|${b.lineId}`);
      });
      if (later.length) {
        const b = later[0]!;
        throw new Error(`Bill ${b.billNumber} has ${b.qty} of this product at ${branch.name} and is not received on the website. Match it in Receive purchase, or tick it as regular stock.`);
      }
      const { data: done, error } = await k.db.rpc("release_preorder_hold", {
        _branch_id: data.branchId, _product_id: data.productId, _qty: data.qty, _note: data.note,
        _regular_bills: bills.filter((b) => ticked.has(`${b.billId}|${b.lineId}`)).map((b) => ({ bill_id: b.billId, bill_number: b.billNumber, line_id: b.lineId, qty: b.qty })) as unknown as Json,
        _reading: now.readings.find((r) => r.branch_id === data.branchId)?.zoho ?? 0, _snapshot: now.snapshot[`${data.branchId}|${data.productId}`] ?? [],
        _read_at: now.readAt, _by: context.userId, _by_name: await k.adminName(context.userId),
      });
      if (error) throw new Error(error.message);
      return (done ?? null) as Json;
    });
  });

/** Undo a match within 7 days while nothing has moved since (the database says what has). One Zoho item read. */
export const unmatchIncomingBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ batchId: z.string().uuid(), note: z.string().trim().max(300) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Pre-orders: match", async () => {
      const { data: batch } = await k.db.from("batches").select("id,product_id,zoho_item_id").eq("id", data.batchId).maybeSingle();
      if (!batch) throw new Error("Batch not found");
      const { data: link } = await k.db.from("zoho_item_links").select("zoho_item_id").eq("product_id", batch.product_id).maybeSingle();
      const itemId = str(link?.zoho_item_id) || str(batch.zoho_item_id);
      if (!itemId) throw new Error("This product is not linked to a Zoho item");
      const now = await readNow(k, { id: batch.product_id, zohoItemId: itemId });
      const { data: done, error } = await k.db.rpc("unmatch_incoming_batch", {
        _batch_id: batch.id, _note: data.note, _readings: now.readings as unknown as Json, _snapshot: now.snapshot as unknown as Json,
        _read_at: now.readAt, _by: context.userId, _by_name: await k.adminName(context.userId),
      });
      if (error) throw new Error(error.message);
      return (done ?? null) as Json;
    });
  });

/** The stock maths of one product at one godown (spec 10, PreorderPanel): Zoho's last reading, held, W, U, I, T. No Zoho call. */
export const getPreorderMaths = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ branchId: z.string().trim().min(1).max(40), productId: z.string().trim().min(1).max(100) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const [{ data: watch }, { data: stock }, { data: lots }, { data: events }] = await Promise.all([
      k.db.from("preorder_watch").select("*").eq("branch_id", data.branchId).eq("product_id", data.productId).maybeSingle(),
      k.db.from("branch_stock").select("stock,free_total,incoming,incoming_detail,zoho_pending,updated_at").eq("branch_id", data.branchId).eq("product_id", data.productId).maybeSingle(),
      k.db.from("batches").select("id,batch_code,quantity,remaining_quantity,hold_back,expected_date,selling_paused,paused_reason").eq("branch_id", data.branchId)
        .eq("product_id", data.productId).eq("stage", "incoming").order("expected_date"),
      k.db.from("batch_lot_events").select("id,batch_id,kind,qty,detail,by_name,note,created_at").eq("branch_id", data.branchId).eq("product_id", data.productId)
        .order("id", { ascending: false }).limit(40),
    ]);
    const unbilled = (lots ?? []).reduce((sum, l) => sum + n(l.quantity), 0);
    const arriving = (lots ?? []).reduce((sum, l) => sum + n(l.remaining_quantity), 0);
    const total = n(stock?.free_total ?? stock?.stock);
    return {
      watched: Boolean(watch),
      zoho: watch ? n(watch.zoho_last) : null, readAt: watch?.read_at ?? null, held: n(watch?.held), heldSince: watch?.held_since ?? null,
      openedAt: watch?.opened_at ?? null, waiting: n(watch?.last_waiting), unbilled, arriving, total,
      ready: n(stock?.stock), incoming: n(stock?.incoming), raw: Math.round((total - arriving) * 100) / 100, pending: Boolean(stock?.zoho_pending),
      pendingDelta: n(watch?.pending_delta),
      lots: (lots ?? []).map((l) => ({ id: l.id, code: l.batch_code, quantity: n(l.quantity), remaining: n(l.remaining_quantity), holdBack: n(l.hold_back),
        expectedDate: str(l.expected_date), paused: l.selling_paused, pausedReason: str(l.paused_reason) })),
      events: (events ?? []).map((e) => ({ ...e, qty: e.qty === null ? null : n(e.qty) })),
    };
  });
