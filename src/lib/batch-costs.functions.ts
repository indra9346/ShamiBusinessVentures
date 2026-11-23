import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { billPlan, billSummary } from "@/lib/bill-batches";
import { costBeforeGst } from "@/lib/batches";
import {
  billChargeDocuments, chargeSplitMethod, costDocChange, countedCost, expenseDocuments, expenseListRow, expensesNotAllowed, parseKg, REAUTHORIZE_HINT,
  batchCommissionShare, COST_CATEGORIES, manualExpenseCost, manualExpenseProblem, replacesStaleSplit, splitByMethod, zohoSaysGone,
  type ChargeBill, type CostDoc, type SplitBatch, type SplitMethod, type StoredCostDoc,
} from "@/lib/batch-costs";

/*
 * Batch expenses (client, "Approved", 14 Nov 2026; spec section 8). An administrator tags Zoho Books expenses (freight,
 * hamali, unloading…) and the charge lines of supplier bills to batches, and the batch report counts them in the landed
 * cost (src/lib/batches.ts). The server re-reads the expense or bill from Zoho before every tag, never trusting the
 * browser, and works out the split to the paisa (src/lib/batch-costs.ts); the database (supabase/migrations/
 * 20261114100000_batch_expenses.sql) checks it again: never more than the expense, always its sign, administrators only.
 * Every Zoho call goes through preorderZohoKit: logged under "Batches: expenses" / "Batches: expense check", refused while
 * Zoho's daily limit is reached, and pausing Zoho when the limit answer comes.
 *
 * Reading Books expenses needs the ZohoBooks.expenses.READ permission: until the owner presses Reauthorize Zoho, expense
 * calls answer with REAUTHORIZE_HINT; bill charges work without it (bills are read with ZohoInventory.bills.READ).
 */

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

const kit = async () => (await import("@/lib/zoho-commerce.functions")).preorderZohoKit();
type Kit = Awaited<ReturnType<typeof kit>>;
type Db = SupabaseClient<Database>;
const str = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const n = (value: unknown) => Number(value) || 0;
const plain = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ZOHO_ID = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);

/** The expense check runs at most every 30 minutes (the Batches page and the hourly run share it). */
const COST_CHECK_SETTING = "batch_cost_check";
const COST_CHECK_MINUTES = 30;
/** Per check: expense list pages, single expenses read, single bills read. */
const COST_CHECK_LIST_PAGES = 3;
const COST_CHECK_EXPENSE_READS = 10;
const COST_CHECK_BILL_READS = 5;

/** A Books answer, with the Reauthorize hint when the connection may not read expenses yet. */
async function booksRead<T>(k: Kit, resource: string, query: Record<string, string> = {}) {
  try {
    return await k.books<T>(resource, query);
  } catch (cause) {
    const message = errorText(cause);
    if (expensesNotAllowed(message)) throw new Error(`${REAUTHORIZE_HINT} (${message})`);
    throw cause;
  }
}

/** The stored documents of these Zoho ids with their tags (admin screens and the re-read before a tag). */
async function storedDocs(db: Db, source: "expense" | "bill", zohoIds: string[]) {
  if (!zohoIds.length) return { docs: [] as StoredCostDoc[], tags: [] as { id: number; document_id: number; batch_id: string; amount: number; method: string }[] };
  const { data: docs } = await db.from("zoho_cost_documents").select("*").eq("source", source).in("zoho_id", zohoIds);
  const ids = (docs ?? []).map((d) => d.id);
  const { data: tags } = ids.length
    ? await db.from("batch_cost_tags").select("id,document_id,batch_id,amount,method").in("document_id", ids)
    : { data: [] };
  return {
    docs: ((docs ?? []) as StoredCostDoc[]).map((d) => ({ ...d, cost_amount: n(d.cost_amount), amount_before_gst: n(d.amount_before_gst), gst_amount: n(d.gst_amount),
      accepted_cost_amount: d.accepted_cost_amount === null ? null : n(d.accepted_cost_amount) })),
    tags: (tags ?? []).map((t) => ({ ...t, amount: n(t.amount) })),
  };
}

/** How a stored expense was split into documents: the whole expense, or its lines (so a re-read keeps each document's identity). */
const expenseMode = (stored: Pick<StoredCostDoc, "zoho_line_id">[]): "auto" | "whole" | "lines" =>
  !stored.length ? "auto" : stored.some((d) => d.zoho_line_id === "") ? "whole" : "lines";

/** One Zoho cost read from Zoho now: an expense (or one of its lines), or a charge line of a bill. null = Zoho has no such line. */
async function readDocNow(k: Kit, source: "expense" | "bill", zohoId: string, lineId: string): Promise<CostDoc | null> {
  if (source === "expense") {
    const raw = (await booksRead<{ expense?: Record<string, unknown> }>(k, `expenses/${encodeURIComponent(zohoId)}`)).expense;
    if (!raw) return null;
    return expenseDocuments(raw, lineId ? "lines" : "whole").find((doc) => doc.zoho_line_id === lineId) ?? null;
  }
  const raw = (await k.get<{ bill?: Record<string, unknown> }>(`bills/${encodeURIComponent(zohoId)}`)).bill;
  if (!raw) return null;
  if (str(raw["status"]).toLowerCase() === "void") throw new Error("This bill is void in Zoho");
  return billChargeDocuments(billPlan(raw), raw).find((doc) => doc.zoho_line_id === lineId) ?? null;
}

/** The batches a cost is split over, with what each split method needs (units, cost before GST, a unit's kg). */
async function splitInputs(db: Db, picks: { batchId: string; typed?: number | null | undefined }[]): Promise<SplitBatch[]> {
  const ids = [...new Set(picks.map((p) => p.batchId))];
  const { data: rows, error } = await db.from("batches")
    .select("id,batch_code,product_id,quantity,unit_cost,unit_cost_ex_gst,unit_cost_inc_gst,cost_basis,stage").in("id", ids);
  if (error) throw new Error("Could not read the batches");
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  for (const row of rows ?? []) if (row.stage === "cancelled") throw new Error(`Batch ${row.batch_code} can't take expenses`);
  const productIds = [...new Set((rows ?? []).map((row) => row.product_id))];
  const { data: products } = productIds.length ? await db.from("catalog_products").select("id,payload").in("id", productIds) : { data: [] };
  const kgOf = new Map((products ?? []).map((p) => [p.id, parseKg(plain(p.payload)["weight"])]));
  return picks.map((pick) => {
    const row = byId.get(pick.batchId);
    if (!row) throw new Error("A chosen batch no longer exists. Refresh and try again.");
    return {
      batchId: row.id, bags: n(row.quantity), kgPerUnit: kgOf.get(row.product_id) ?? null, typed: pick.typed ?? null,
      unitCostExGst: costBeforeGst({ unit_cost: n(row.unit_cost), unit_cost_ex_gst: row.unit_cost_ex_gst === null ? null : n(row.unit_cost_ex_gst),
        unit_cost_inc_gst: row.unit_cost_inc_gst === null ? null : n(row.unit_cost_inc_gst), cost_basis: row.cost_basis }),
    };
  });
}

/** Saves the document as Zoho has it now and replaces its tags with the split: one transaction per database call. */
async function saveAndTag(db: Db, doc: CostDoc & { gst_override?: boolean | null }, picks: SplitBatch[], method: SplitMethod,
  who: { id: string; name: string; confirmRebilled: boolean; note: string; replace?: boolean }) {
  // 17 Nov 2026: a channel partner's commission may be tagged too (client); it was refused before (owner's rule).
  const { data: docId, error: saveError } = await db.rpc("save_cost_document", { _doc: doc as unknown as Json });
  if (saveError || docId === null) throw new Error(saveError?.message ?? "Could not save the expense");
  const { data: row, error: readError } = await db.from("zoho_cost_documents").select("id,cost_amount,flag,gone_at").eq("id", Number(docId)).single();
  if (readError || !row) throw new Error("Could not read the expense back");
  const split = splitByMethod(n(row.cost_amount), picks, method);
  if (split.problem) throw new Error(split.problem);
  // A stale split (Zoho changed the document) is replaced in the same database call (review fix: untag first, in a call
  // of its own, could leave the document untagged when the second call failed).
  const { error } = await db.rpc("tag_batch_costs", {
    _document_id: row.id, _confirm_rebilled: who.confirmRebilled, _by: who.id, _by_name: who.name, _replace: who.replace ?? false,
    _rows: split.rows.map((r) => ({ batch_id: r.batchId, amount: r.amount, method, weight: r.weight, note: who.note })) as unknown as Json,
  });
  if (error) throw new Error(error.message);
  return { documentId: row.id, cost: n(row.cost_amount), tagged: split.tagged, untagged: split.untagged };
}

// ---------------------------------------------------------------- the picker

/**
 * Books expenses in a date range, newest first, 200 a page, with what is tagged of each already. One Zoho call per page.
 * Amounts on the list are before GST and the total; GST eligibility comes when one is opened (getZohoExpense).
 */
export const listZohoExpenses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ from: DATE, to: DATE, search: z.string().trim().max(100).default(""), page: z.number().int().min(1).max(50).default(1) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    if (data.to < data.from) throw new Error("The end date is before the start date");
    const k = await kit();
    return k.work("Batches: expenses", async () => {
      const answer = await booksRead<{ expenses?: Record<string, unknown>[]; page_context?: Record<string, unknown> }>(k, "expenses", {
        filter_by: "Status.All", date_start: data.from, date_end: data.to, sort_column: "date", sort_order: "D", per_page: "200", page: String(data.page),
        ...(data.search ? { search_text: data.search } : {}),
      });
      const rows = (answer.expenses ?? []).map(expenseListRow).filter((row) => row.expenseId);
      const stored = await storedDocs(k.db, "expense", rows.map((row) => row.expenseId));
      const docOf = new Map(stored.docs.map((d) => [d.id, d]));
      const tagged = new Map<string, number>();
      for (const tag of stored.tags) {
        const doc = docOf.get(tag.document_id);
        if (doc) tagged.set(doc.zoho_id, Math.round(((tagged.get(doc.zoho_id) ?? 0) + tag.amount) * 100) / 100);
      }
      return {
        rows: rows.map((row) => ({ ...row, tagged: tagged.get(row.expenseId) ?? 0 })),
        page: data.page, hasMore: plain(answer.page_context)["has_more_page"] === true,
      };
    });
  });

/** One Books expense as cost documents (itemized: one per line), with each one's tags so far. One Zoho call. */
export const getZohoExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ expenseId: ZOHO_ID }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Batches: expenses", async () => {
      const raw = (await booksRead<{ expense?: Record<string, unknown> }>(k, `expenses/${encodeURIComponent(data.expenseId)}`)).expense;
      if (!raw) throw new Error("This expense is no longer in Zoho");
      const stored = await storedDocs(k.db, "expense", [data.expenseId]);
      return { expense: expenseListRow(raw), docs: withStored(expenseDocuments(raw, expenseMode(stored.docs)), stored) };
    });
  });

/** The charge lines of one Zoho bill (freight, hamali, the discount, the round-off) and the batches made from it. One Zoho call. */
export const getBillCharges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ billId: ZOHO_ID }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Batches: expenses", async () => {
      const raw = (await k.get<{ bill?: Record<string, unknown> }>(`bills/${encodeURIComponent(data.billId)}`)).bill;
      if (!raw) throw new Error("Zoho did not return the bill");
      const plan = billPlan(raw);
      const stored = await storedDocs(k.db, "bill", [plan.billId]);
      const { data: batches } = await k.db.from("batches").select("id,batch_code").eq("zoho_bill_id", plan.billId).neq("zoho_bill_line_id", "").eq("stage", "received");
      return {
        bill: { billId: plan.billId, billNumber: plan.billNumber, vendorName: plan.vendorName, date: plan.date, total: plan.total, status: plan.status },
        docs: plan.status === "void" ? [] : withStored(billChargeDocuments(plan, raw), stored),
        batches: (batches ?? []).map((b) => ({ id: b.id, code: b.batch_code })),
      };
    });
  });

/** Documents read from Zoho with their stored row (if any): counted cost with the admin's GST choice, tags, flag. */
function withStored(docs: CostDoc[], stored: Awaited<ReturnType<typeof storedDocs>>) {
  return docs.map((doc) => {
    const row = stored.docs.find((d) => d.zoho_line_id === doc.zoho_line_id);
    const tags = row ? stored.tags.filter((t) => t.document_id === row.id) : [];
    return {
      ...doc, cost: countedCost(doc, row?.gst_override ?? null), gstOverride: row?.gst_override ?? null,
      documentId: row?.id ?? null, flag: row?.flag ?? "", acceptedCost: row?.accepted_cost_amount ?? null,
      tags: tags.map((t) => ({ batchId: t.batch_id, amount: t.amount, method: t.method })),
      tagged: Math.round(tags.reduce((sum, t) => sum + t.amount, 0) * 100) / 100,
    };
  });
}

/**
 * Tags one expense (or expense line, or bill charge) to batches, replacing its earlier split: the document is read from
 * Zoho again, saved, and split here to the paisa (by bags, value, weight, typed amounts or percents). One Zoho call.
 */
export const tagBatchCosts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    source: z.enum(["expense", "bill"]),
    zohoId: ZOHO_ID,
    lineId: z.string().trim().max(40).default(""),
    method: z.enum(["amount", "percent", "bags", "value", "weight"]),
    batches: z.array(z.object({ batchId: z.string().uuid(), typed: z.number().min(0).max(100_000_000).nullable().default(null) })).min(1).max(200),
    confirmRebilled: z.boolean().default(false),
    /** The admin's GST choice: true = claimable (not a cost), false = a cost, null = Zoho's; left out = as before. */
    gstOverride: z.boolean().nullable().optional(),
    note: z.string().trim().max(300).default(""),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    return k.work("Batches: expenses", async () => {
      const doc = await readDocNow(k, data.source, data.zohoId, data.lineId);
      if (!doc) throw new Error(data.source === "bill" ? "This bill line is no longer in Zoho" : "This expense is no longer in Zoho");
      const picks = await splitInputs(k.db, data.batches);
      const name = await k.adminName(context.userId);
      const stored = await storedDocs(k.db, data.source, [data.zohoId]);
      const row = stored.docs.find((d) => d.zoho_line_id === data.lineId);
      const override = data.gstOverride !== undefined ? data.gstOverride : row?.gst_override ?? null;
      const tagged = row ? stored.tags.filter((t) => t.document_id === row.id).reduce((sum, t) => sum + t.amount, 0) : 0;
      // A new split of a document Zoho changed (or whose GST choice changed) replaces the old one in one call, checked
      // against Zoho's amount now; if anything is refused the old split and its flag stay.
      const replace = Boolean(row && replacesStaleSplit({ ...row, tagged }, countedCost(doc, override)));
      return saveAndTag(k.db, { ...doc, ...(data.gstOverride !== undefined ? { gst_override: data.gstOverride } : {}) }, picks, data.method,
        { id: context.userId, name, confirmRebilled: data.confirmRebilled, note: data.note, replace });
    });
  });

/** Takes every tag off a document (allowed in any state, a deleted expense too). No Zoho call. */
export const untagBatchCosts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ documentId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: removed, error } = await k.db.rpc("untag_batch_costs", { _document_id: data.documentId, _by: context.userId, _by_name: await k.adminName(context.userId) });
    if (error) throw new Error(error.message);
    return { removed: Number(removed) || 0 };
  });

/** Accepts Zoho's new amount for a flagged document (its tags must already fit in it). No Zoho call. */
export const acceptCostChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ documentId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: done, error } = await k.db.rpc("accept_cost_document_change", { _document_id: data.documentId, _by: context.userId, _by_name: await k.adminName(context.userId) });
    if (error) throw new Error(error.message);
    return (done ?? null) as Json;
  });

// ---------------------------------------------------------------- expenses typed in (client, 17 Nov 2026)

const CATEGORY = z.enum(COST_CATEGORIES.map((c) => c.id) as [string, ...string[]]);

/**
 * Saves an expense typed in on the website (transport, hamali, driver commission, channel partner commission, other) and
 * puts it on batches: new, or an edit of one typed in before. The whole expense goes on the chosen batches, by typed
 * amounts (one batch: all of it) or by bags. No Zoho call; public.save_manual_batch_expense checks it all again.
 */
export const saveManualExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    documentId: z.number().int().positive().nullable().default(null),
    category: CATEGORY,
    date: DATE,
    beforeGst: z.number().positive().max(100_000_000),
    gst: z.number().min(0).max(100_000_000).default(0),
    gstClaimable: z.boolean().default(true),
    paidTo: z.string().trim().max(120).default(""),
    reference: z.string().trim().max(80).default(""),
    note: z.string().trim().max(200).default(""),
    method: z.enum(["amount", "bags"]),
    batches: z.array(z.object({ batchId: z.string().uuid(), typed: z.number().min(0).max(100_000_000).nullable().default(null) })).min(1).max(50),
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const problem = manualExpenseProblem({ category: data.category, date: data.date, beforeGst: data.beforeGst, gst: data.gst });
    if (problem) throw new Error(problem);
    const k = await kit();
    const cost = manualExpenseCost(data);
    const picks = await splitInputs(k.db, data.method === "amount" && data.batches.length === 1 ? [{ batchId: data.batches[0]!.batchId, typed: cost }] : data.batches);
    const split = splitByMethod(cost, picks, data.method);
    if (split.problem) throw new Error(split.problem);
    if (split.untagged !== 0) throw new Error(`The batches' shares add up to ₹${split.tagged.toFixed(2)}, the expense is ₹${cost.toFixed(2)}`);
    const { data: done, error } = await k.db.rpc("save_manual_batch_expense", {
      _document_id: data.documentId as unknown as number,
      _doc: { category: data.category, doc_date: data.date, amount_before_gst: data.beforeGst, gst_amount: data.gst, gst_claimable: data.gstClaimable,
        paid_to: data.paidTo, reference: data.reference, note: data.note } as unknown as Json,
      _rows: split.rows.map((r) => ({ batch_id: r.batchId, amount: r.amount, method: data.method, weight: r.weight })) as unknown as Json,
      _by: context.userId, _by_name: await k.adminName(context.userId),
    });
    if (error) throw new Error(error.message);
    const result = plain(done);
    return { documentId: n(result["document_id"]), cost: n(result["cost_amount"]) };
  });

/** Deletes an expense typed in (off its batches; kept for its history). No Zoho call. */
export const deleteManualExpense = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ documentId: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: removed, error } = await k.db.rpc("delete_manual_batch_expense", { _document_id: data.documentId, _by: context.userId, _by_name: await k.adminName(context.userId) });
    if (error) throw new Error(error.message);
    return { removed: Number(removed) || 0 };
  });

/** Sets what an expense is for (a Zoho one too). No Zoho call. */
export const setExpenseCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ documentId: z.number().int().positive(), category: z.union([CATEGORY, z.literal("")]) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: saved, error } = await k.db.rpc("set_cost_document_category", { _document_id: data.documentId, _category: data.category, _by: context.userId, _by_name: await k.adminName(context.userId) });
    if (error) throw new Error(error.message);
    return { category: str(saved) };
  });

/** Sets whether an expense is cost of goods sold or an operating expense ('' = its type's default). No Zoho call. */
export const setExpenseKind = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ documentId: z.number().int().positive(), kind: z.enum(["", "cogs", "operating"]) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: saved, error } = await k.db.rpc("set_cost_document_kind", { _document_id: data.documentId, _kind: data.kind, _by: context.userId, _by_name: await k.adminName(context.userId) });
    if (error) throw new Error(error.message);
    return { kind: str(saved) };
  });

/**
 * The channel partner commission the website worked out on this batch's sales (its order lines' commissions, by the
 * units taken from this batch), for the Add expense form to offer. Read-only, no Zoho call.
 */
export const batchWebsiteCommission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ batchId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const k = await kit();
    const { data: allocations, error } = await k.db.from("order_item_batch_allocations").select("order_item_id,reserved_quantity,released_quantity").eq("batch_id", data.batchId);
    if (error) throw new Error("Could not read the batch's sales");
    const itemIds = [...new Set((allocations ?? []).map((a) => a.order_item_id))];
    const commissions: { order_item_id: string; order_no: string; qty: number; amount: number; status: string }[] = [];
    for (let start = 0; start < itemIds.length; start += 200) {
      const { data: rows, error: readError } = await k.db.from("partner_commissions").select("order_item_id,order_no,qty,amount,status").in("order_item_id", itemIds.slice(start, start + 200));
      if (readError) throw new Error("Could not read the partner commissions");
      commissions.push(...(rows ?? []).map((r) => ({ ...r, qty: n(r.qty), amount: n(r.amount) })));
    }
    return batchCommissionShare((allocations ?? []).map((a) => ({ ...a, reserved_quantity: n(a.reserved_quantity), released_quantity: n(a.released_quantity) })), commissions);
  });

// ---------------------------------------------------------------- Receive purchase: the bill's own charges (spec 8.2)

/**
 * After Receive purchase: the ticked charge lines of the bill (freight, hamali, the discount, the round-off) tagged to every
 * batch made or matched from that bill, the charges by bags and the discount by value. The bill was read from Zoho in the
 * same request. Never fails the receive (its batches are saved already): what could not be tagged comes back as warnings.
 */
export async function tagBillCharges(db: Db, plan: ChargeBill, raw: Record<string, unknown>, lineIds: string[], by: { id: string; name: string }) {
  const wanted = new Set(lineIds);
  const docs = billChargeDocuments(plan, raw).filter((doc) => wanted.has(doc.zoho_line_id));
  if (!docs.length) return [] as string[];
  const { data: batches } = await db.from("batches").select("id").eq("zoho_bill_id", plan.billId).neq("zoho_bill_line_id", "").eq("stage", "received");
  if (!batches?.length)
    return [`The freight and other lines of bill ${plan.billNumber} are tagged once its batches are made: open one of them, then Expenses › Bill charges.`];
  const picks = await splitInputs(db, batches.map((b) => ({ batchId: b.id })));
  const stored = await storedDocs(db, "bill", [plan.billId]);
  const warnings: string[] = [];
  for (const doc of docs) {
    try {
      // Ticked again after the bill was edited in Zoho: the new split over all of the bill's batches replaces the old one.
      const row = stored.docs.find((d) => d.zoho_line_id === doc.zoho_line_id);
      const tagged = row ? stored.tags.filter((t) => t.document_id === row.id).reduce((sum, t) => sum + t.amount, 0) : 0;
      const replace = Boolean(row && replacesStaleSplit({ ...row, tagged }, countedCost(doc, row.gst_override)));
      await saveAndTag(db, doc, picks, chargeSplitMethod(doc.zoho_line_id), { ...by, confirmRebilled: false, note: `Bill ${plan.billNumber}`, replace });
    } catch (cause) {
      warnings.push(`${doc.description} on bill ${plan.billNumber} was not tagged: ${errorText(cause)}`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------- the check (spec 8.3)

/** Edited, deleted or voided in Zoho since they were tagged: flagged on the Batches page. At most every 30 minutes. */
export const checkBatchCosts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await ensureAdmin(context.supabase, context.userId);
    return checkBatchCostsNow();
  });

/** The check from the hourly run (spec 7.5) or the page: refused while Zoho's daily limit is reached, logged as "Batches: expense check". */
export async function checkBatchCostsNow() {
  const k = await kit();
  return k.work("Batches: expense check", () => checkBatchCostsRun(k));
}

/** One flag_cost_document_changes row: the document's values as Zoho has them now, and the flag when something changed. */
function changeRow(stored: StoredCostDoc, now: CostDoc | null, goneFlag = "") {
  if (!now) return { id: stored.id, gone: true, flag: goneFlag || costDocChange(stored, null) };
  const flag = costDocChange(stored, now);
  return {
    id: stored.id, amount_before_gst: now.amount_before_gst, gst_amount: now.gst_amount, gst_claimable: now.gst_claimable, account_id: now.account_id,
    account_name: now.account_name, doc_date: now.doc_date, zoho_status: now.zoho_status, zoho_modified: now.zoho_modified, rebilled: now.rebilled,
    ...(flag ? { flag } : {}),
  };
}

const byZohoId = (docs: StoredCostDoc[]) => {
  const groups = new Map<string, StoredCostDoc[]>();
  for (const doc of docs) groups.set(doc.zoho_id, [...(groups.get(doc.zoho_id) ?? []), doc]);
  // Checked longest ago first, so the reads go round all of them.
  return [...groups.entries()].sort((a, b) => str(a[1][0]!.checked_at).localeCompare(str(b[1][0]!.checked_at)));
};

/**
 * The check itself, from the Batches page and from the hourly run: every tagged document still in Zoho is compared with
 * Zoho. Expenses: 1–3 list calls over the tagged dates; one unchanged since it was saved (same last_modified_time) is
 * only marked checked, a changed or missing one is read (at most 10). Bill charges: one bills list call; a bill whose
 * edit time moved, or that is no longer listed, is read (at most 5). Tags are never changed: the P&L counts at most
 * Zoho's amount, and the admin re-splits or accepts.
 */
export async function checkBatchCostsRun(given?: Kit) {
  const k = given ?? await kit();
  const db = k.db;
  const { data: setting } = await db.from("settings").select("value").eq("key", COST_CHECK_SETTING).maybeSingle();
  const last = Date.parse(str(plain(setting?.value)["at"]));
  if (Number.isFinite(last) && Date.now() - last < COST_CHECK_MINUTES * 60_000) return { checked: false as const, flagged: 0 };
  const { data: tagRows, error: tagError } = await db.from("batch_cost_tags").select("document_id");
  if (tagError) throw new Error("Could not read the expense tags");
  const ids = [...new Set((tagRows ?? []).map((t) => t.document_id))];
  if (!ids.length) return { checked: false as const, flagged: 0 };
  await db.from("settings").upsert({ key: COST_CHECK_SETTING, value: { at: new Date().toISOString() } as Json, is_public: false, updated_at: new Date().toISOString() });
  const docs: StoredCostDoc[] = [];
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error } = await db.from("zoho_cost_documents").select("*").in("id", ids.slice(start, start + 200)).is("gone_at", null);
    if (error) throw new Error("Could not read the tagged expenses");
    for (const d of (data ?? []) as StoredCostDoc[]) docs.push({ ...d, cost_amount: n(d.cost_amount), accepted_cost_amount: d.accepted_cost_amount === null ? null : n(d.accepted_cost_amount) });
  }
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let read = 0;

  // Bill charges (read with the Inventory permission, so they are checked even before the Books Reauthorize).
  const bills = byZohoId(docs.filter((d) => d.source === "bill"));
  if (bills.length) {
    try {
      const list = (await k.get<{ bills?: Record<string, unknown>[] }>("bills", { per_page: "200", sort_column: "last_modified_time", sort_order: "D" })).bills ?? [];
      const listed = new Map(list.map(billSummary).map((b) => [b.billId, b]));
      let reads = 0;
      for (const [billId, stored] of bills) {
        const seen = listed.get(billId);
        if (seen && seen.status !== "void" && seen.modifiedAt && seen.modifiedAt === stored[0]!.zoho_modified) {
          for (const doc of stored) rows.push({ id: doc.id });
          continue;
        }
        if (reads >= COST_CHECK_BILL_READS) continue;
        reads += 1;
        let raw: Record<string, unknown> | undefined;
        try {
          raw = (await k.get<{ bill?: Record<string, unknown> }>(`bills/${encodeURIComponent(billId)}`)).bill;
        } catch (cause) {
          if (!zohoSaysGone(errorText(cause))) { errors.push(`Bill ${stored[0]!.doc_number}: ${errorText(cause)}`.slice(0, 200)); continue; }
        }
        read += 1;
        if (!raw) { for (const doc of stored) rows.push(changeRow(doc, null, "Bill deleted in Zoho")); continue; }
        if (str(raw["status"]).toLowerCase() === "void") { for (const doc of stored) rows.push(changeRow(doc, null, "Bill voided in Zoho")); continue; }
        const now = billChargeDocuments(billPlan(raw), raw);
        for (const doc of stored) rows.push(changeRow(doc, now.find((d) => d.zoho_line_id === doc.zoho_line_id) ?? null));
      }
    } catch (cause) {
      errors.push(`Bills: ${errorText(cause)}`.slice(0, 200));
    }
  }

  // Books expenses.
  const expenses = byZohoId(docs.filter((d) => d.source === "expense"));
  if (expenses.length) {
    try {
      const dates = docs.filter((d) => d.source === "expense").map((d) => d.doc_date.slice(0, 10)).sort();
      const listed = new Map<string, ReturnType<typeof expenseListRow>>();
      for (let page = 1; page <= COST_CHECK_LIST_PAGES; page += 1) {
        const answer = await booksRead<{ expenses?: Record<string, unknown>[]; page_context?: Record<string, unknown> }>(k, "expenses", {
          filter_by: "Status.All", date_start: dates[0]!, date_end: dates.at(-1)!, sort_column: "date", sort_order: "D", per_page: "200", page: String(page),
        });
        for (const row of (answer.expenses ?? []).map(expenseListRow)) listed.set(row.expenseId, row);
        if (plain(answer.page_context)["has_more_page"] !== true) break;
      }
      let reads = 0;
      for (const [expenseId, stored] of expenses) {
        const seen = listed.get(expenseId);
        if (seen && seen.modifiedAt && seen.modifiedAt === stored[0]!.zoho_modified) {
          for (const doc of stored) rows.push({ id: doc.id });
          continue;
        }
        if (reads >= COST_CHECK_EXPENSE_READS) continue;
        reads += 1;
        let raw: Record<string, unknown> | undefined;
        try {
          raw = (await booksRead<{ expense?: Record<string, unknown> }>(k, `expenses/${encodeURIComponent(expenseId)}`)).expense;
        } catch (cause) {
          if (!zohoSaysGone(errorText(cause))) { errors.push(`Expense ${stored[0]!.doc_number || expenseId}: ${errorText(cause)}`.slice(0, 200)); continue; }
        }
        read += 1;
        if (!raw) { for (const doc of stored) rows.push(changeRow(doc, null)); continue; }
        const now = expenseDocuments(raw, expenseMode(stored));
        for (const doc of stored) rows.push(changeRow(doc, now.find((d) => d.zoho_line_id === doc.zoho_line_id) ?? null));
      }
    } catch (cause) {
      errors.push(`Expenses: ${errorText(cause)}`.slice(0, 200));
    }
  }

  const { data: flagged, error } = rows.length ? await db.rpc("flag_cost_document_changes", { _rows: rows as unknown as Json }) : { data: 0, error: null };
  if (error) throw new Error(error.message);
  return { checked: true as const, flagged: Number(flagged) || 0, read, errors: errors.slice(0, 10) };
}
