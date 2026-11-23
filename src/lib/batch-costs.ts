/*
 * Batch expenses (client, "Approved", 14 Nov 2026; spec section 8). Zoho Books expenses (freight, hamali, unloading…)
 * and the charge lines of supplier bills are tagged to batches, so each batch shows its landed cost and its profit after
 * expenses. Pure rules shared by the server functions, the admin screens and the tests, so they hold no app imports.
 *
 *   * The counted cost of a document is its amount before GST, plus the GST only when it can't be claimed back. GST the
 *     company claims back is not a cost, so profit stays before GST on both sides; unclaimable GST is a real cost.
 *   * Money is spread in whole paise with the largest-remainder rule (apportionPaise): the parts always add up exactly.
 *   * A document's tags never count for more than Zoho's current amount (effectiveTagAmounts): when Zoho's amount fell,
 *     the tags shrink in proportion; when it rose, the extra stays untagged; a deleted expense counts 0.
 *
 * Zoho Books field names, read from the live organisation on 14 Nov 2026 (GET expenses and GET expenses/:id, read only):
 *   list rows:  expense_id, date, account_name (no account_id), description, reference_number, cf_expense ("EXP-00122",
 *               the Expense # custom field), vendor_name, currency_code, exchange_rate, total, total_without_tax, bcy_total,
 *               bcy_total_without_tax, status ("nonbillable"…), is_billable, location_id, location_name, created_time,
 *               last_modified_time. No tax_amount, itc_eligibility or line_items on list rows.
 *   one expense: the above plus account_id, sub_total, tax_amount, amount, is_inclusive_tax, itc_eligibility ("eligible"),
 *               is_reverse_charge_applied, reverse_charge_tax_id, gst_treatment, tax_treatment, invoice_id, and line_items[]
 *               {line_item_id, account_id, account_name, description, item_total, amount, tax_amount, itc_eligibility,
 *               reverse_charge_tax_id}. No bcy_sub_total was seen (amounts in INR); other currencies use bcy_* or the
 *               exchange rate. Every expense seen had no GST, so the GST fields are parsed defensively.
 */

const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value));
const num = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(/[,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const has = (raw: Record<string, unknown>, key: string) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "";
export const paise = (value: number) => Math.round((value + (value >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

// ------------------------------------------------------------------ paise-exact spreads

/**
 * `total` rupees spread over `weights` in whole paise: each part gets the floor of its exact share, and the paise left
 * over go one each to the largest fractional parts (ties: the earlier one). The parts add up to the total exactly.
 * Negative totals are spread the same way with a minus sign. Negative weights count as 0. When every weight is 0 the
 * total is shared equally (callers that want "all in one place" say so themselves).
 */
export function apportionPaise(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const totalPaise = Math.round(paise(total) * 100);
  const s = sign(totalPaise);
  const absT = BigInt(Math.abs(totalPaise));
  let ws = weights.map((w) => BigInt(Math.round(Math.max(0, Number.isFinite(w) ? w : 0) * 1e6)));
  if (ws.every((w) => w === 0n)) ws = ws.map(() => 1n);
  const W = ws.reduce((a, b) => a + b, 0n);
  const shares = ws.map((w) => (absT * w) / W);
  const rests = ws.map((w) => (absT * w) % W);
  let left = absT - shares.reduce((a, b) => a + b, 0n);
  const order = ws.map((_, i) => i).sort((a, b) => (rests[b]! > rests[a]! ? 1 : rests[b]! < rests[a]! ? -1 : a - b));
  for (const i of order) {
    if (left <= 0n) break;
    if (rests[i] === 0n) break;
    shares[i] = shares[i]! + 1n;
    left -= 1n;
  }
  return shares.map((v) => (s * Number(v)) / 100 || 0);
}

// ------------------------------------------------------------------ split methods (spec 8.2)

export type SplitMethod = "amount" | "percent" | "bags" | "value" | "weight";
export const SPLIT_METHODS: { key: SplitMethod; label: string }[] = [
  { key: "bags", label: "By bags" },
  { key: "value", label: "By value before GST" },
  { key: "weight", label: "By weight (kg)" },
  { key: "amount", label: "Typed amounts" },
  { key: "percent", label: "Percent" },
];

/** A batch an expense may be split over: its units, its cost per unit before GST, a unit's weight in kg (null: unknown). */
export type SplitBatch = { batchId: string; bags: number; unitCostExGst: number; kgPerUnit: number | null; typed?: number | null | undefined };
export type SplitRow = { batchId: string; amount: number; weight: number };

/** A pack's weight in kg from the product's weight text ("50 kg", "26 Kg bag", "500 g", "1 quintal"); null otherwise. */
export function parseKg(weight: unknown): number | null {
  const match = text(weight).toLowerCase().match(/(\d+(?:\.\d+)?)\s*(kgs?|kilo(?:gram)?s?|g|gms?|grams?|qtls?|quintals?)\b/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!(value > 0)) return null;
  const unit = match[2]!;
  if (/^(g|gms?|grams?)$/.test(unit)) return value / 1000;
  if (/^(qtls?|quintals?)$/.test(unit)) return value * 100;
  return value;
}

/** The default method: by bags when every chosen batch is one product, else by value before GST. */
export const defaultSplitMethod = (productIds: string[]): SplitMethod => (new Set(productIds).size <= 1 ? "bags" : "value");

/**
 * The split of `total` (the document's counted cost) over the chosen batches. Bags, value (bags × cost before GST) and
 * weight (bags × kg) spread the whole amount; typed amounts and percents may leave part untagged (overhead). Parts of
 * ₹0 are left out (the database refuses them). `problem` says why it can't be saved, or "".
 */
export function splitByMethod(total: number, batches: SplitBatch[], method: SplitMethod) {
  const amount = paise(total);
  const out = (rows: SplitRow[], problem = "") => {
    const kept = rows.filter((row) => row.amount !== 0);
    const tagged = paise(kept.reduce((sum, row) => sum + row.amount, 0));
    return { rows: kept, tagged, untagged: paise(amount - tagged), problem: problem || (kept.length || !batches.length ? "" : "Nothing would be tagged") };
  };
  if (!batches.length) return out([], "Choose at least one batch");
  if (amount === 0) return out([], "This expense has no amount");
  if (method === "amount") {
    const rows = batches.map((b) => ({ batchId: b.batchId, amount: paise(sign(amount) * Math.abs(num(b.typed))), weight: paise(Math.abs(num(b.typed))) }));
    const sum = rows.reduce((s, row) => s + Math.abs(row.amount), 0);
    return out(rows, paise(sum) > Math.abs(amount) ? `₹${paise(sum).toFixed(2)} is more than this expense (₹${Math.abs(amount).toFixed(2)})` : "");
  }
  if (method === "percent") {
    const pcts = batches.map((b) => Math.max(0, num(b.typed)));
    const sumPct = pcts.reduce((s, p) => s + p, 0);
    if (sumPct > 100.0000001) return out([], `The percents add up to ${Math.round(sumPct * 100) / 100}%, more than 100%`);
    const tagged = paise(amount * sumPct / 100);
    const parts = apportionPaise(tagged, pcts);
    return out(batches.map((b, i) => ({ batchId: b.batchId, amount: parts[i]!, weight: pcts[i]! })));
  }
  let weights: number[];
  if (method === "bags") weights = batches.map((b) => Math.max(0, num(b.bags)));
  else if (method === "value") weights = batches.map((b) => Math.max(0, num(b.bags) * num(b.unitCostExGst)));
  else {
    if (batches.some((b) => !(num(b.kgPerUnit) > 0))) return out([], "By weight needs every product's pack weight in kg");
    weights = batches.map((b) => Math.max(0, num(b.bags) * num(b.kgPerUnit)));
  }
  if (weights.every((w) => w === 0)) return out([], method === "value" ? "The chosen batches have no value to split by" : "The chosen batches have no units to split by");
  const parts = apportionPaise(amount, weights);
  return out(batches.map((b, i) => ({ batchId: b.batchId, amount: parts[i]!, weight: Math.round(weights[i]! * 1e6) / 1e6 })));
}

// ------------------------------------------------------------------ documents read from Zoho (spec 8.1)

/** One Zoho cost as the website mirrors it (public.save_cost_document's _doc), with its counted cost. */
export type CostDoc = {
  source: "expense" | "bill";
  zoho_id: string;
  /** '' = the whole expense; a line_item_id; 'bill-discount' or 'bill-adjustment'. */
  zoho_line_id: string;
  doc_number: string;
  doc_date: string;
  account_id: string;
  account_name: string;
  vendor_name: string;
  description: string;
  location_id: string;
  currency_code: string;
  amount_before_gst: number;
  gst_amount: number;
  gst_claimable: boolean;
  reverse_charge: boolean;
  rebilled: boolean;
  zoho_status: string;
  zoho_modified: string;
};

/** The counted cost: before GST, plus the GST only when it can't be claimed back (the admin's choice wins over Zoho's). */
export const countedCost = (doc: Pick<CostDoc, "amount_before_gst" | "gst_amount" | "gst_claimable">, override?: boolean | null) =>
  paise(doc.amount_before_gst + ((override ?? doc.gst_claimable) ? 0 : Math.max(0, doc.gst_amount)));

const ineligible = (value: unknown) => /^ineligible/i.test(text(value).trim());

/**
 * The Expense # (EXP-00126). A list row carries it as cf_expense; one expense read alone (GET expenses/:id) only inside
 * custom_field_hash.cf_expense or custom_fields[] (api_name cf_expense), live 14 Nov 2026. Else the bank reference.
 */
export function expenseNumber(raw: Record<string, unknown>) {
  const hash = raw["custom_field_hash"] && typeof raw["custom_field_hash"] === "object" ? (raw["custom_field_hash"] as Record<string, unknown>) : {};
  const fields = Array.isArray(raw["custom_fields"]) ? (raw["custom_fields"] as Record<string, unknown>[]) : [];
  const field = fields.find((f) => text(f?.["api_name"]) === "cf_expense" || text(f?.["placeholder"]) === "cf_expense");
  return text(raw["cf_expense"]) || text(hash["cf_expense"]) || text(field?.["value"]) || text(raw["reference_number"]);
}

/**
 * A channel partner's commission: Books books it under a "Channel Partner - <godown> - ..." expense account. Until 17 Nov
 * 2026 it could not be tagged (owner's rule, open question 5); the client then asked for "channel partner commission" as a
 * batch expense, so it can be tagged now (type Channel partner commission). It stays out of the untagged overhead total,
 * which is about costs of the goods.
 */
export const NOT_BATCH_COST_ACCOUNT = /^\s*channel\s*partner\b/i;
export const NOT_BATCH_COST_NOTE = "Channel partner commission: tag it to the batch it was earned on";
export const notBatchCost = (accountName: unknown) => NOT_BATCH_COST_ACCOUNT.test(text(accountName));

// ------------------------------------------------------------------ what an expense is for (17 Nov 2026)

/** The client's expense types (Sandesh, 17 Nov 2026): "transport, amali, driver commission ... channel partner commission and other". */
export const COST_CATEGORIES = [
  { id: "transport", name: "Transport" },
  { id: "hamali", name: "Hamali (loading / unloading)" },
  { id: "driver_commission", name: "Driver commission" },
  { id: "partner_commission", name: "Channel partner commission" },
  { id: "other", name: "Other expense" },
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number]["id"];
export const isCostCategory = (value: unknown): value is CostCategory => COST_CATEGORIES.some((c) => c.id === value);
export const costCategoryName = (id: string) => COST_CATEGORIES.find((c) => c.id === id)?.name ?? "Other expense";

/** A Zoho expense's type from its account (or description) when the admin hasn't chosen one. */
export function guessCostCategory(...words: unknown[]): CostCategory {
  const said = words.map(text).join(" ").toLowerCase();
  if (/channel\s*partner|\bpartner\b.*commission|commission.*\bpartner\b/.test(said)) return "partner_commission";
  if (/driver/.test(said)) return "driver_commission";
  if (/h?amali|hamaali|unload|loading|labou?r|coolie/.test(said)) return "hamali";
  if (/transport|freight|lorry|truck|tempo|carriage|cartage|vehicle|delivery charge/.test(said)) return "transport";
  return "other";
}

/**
 * Cost of goods sold or operating expense (client, 18 Nov 2026: "transport cost and amali comes under cost of goods
 * sold"): the default of each type; any expense can be set the other way (cost_kind).
 */
export type CostKind = "cogs" | "operating";
export const COST_KIND_NAMES: Record<CostKind, string> = { cogs: "Cost of goods sold", operating: "Operating expense" };
export const DEFAULT_COST_KIND: Record<CostCategory, CostKind> = {
  // Client's sheet, 18 Nov 2026: "COGS → Transport, COGS → Amali, COGS → Driver Incentive".
  transport: "cogs", hamali: "cogs", driver_commission: "cogs", partner_commission: "operating", other: "operating",
};
/** The kind an expense counts as: the one chosen, else its type's default. */
export const costKindOf = (doc: { cost_kind?: string | null | undefined; category?: string | null | undefined; account_name?: string | null | undefined; description?: string | null | undefined }): CostKind =>
  doc.cost_kind === "cogs" || doc.cost_kind === "operating" ? doc.cost_kind : DEFAULT_COST_KIND[costCategoryOf(doc)];

/** The type an expense counts under: the one chosen, else the guess from Zoho's account. */
export const costCategoryOf = (doc: { category?: string | null | undefined; account_name?: string | null | undefined; description?: string | null | undefined }): CostCategory =>
  isCostCategory(doc.category) ? doc.category : guessCostCategory(doc.account_name, doc.description);

/** An expense typed in: the counted cost (before GST, plus GST only when it can't be claimed back), as for Zoho ones. */
export const manualExpenseCost = (input: { beforeGst: number; gst: number; gstClaimable: boolean }) =>
  paise(Math.max(0, num(input.beforeGst)) + (input.gstClaimable ? 0 : Math.max(0, num(input.gst))));

/** Why a typed-in expense can't be saved, or "" (public.save_manual_batch_expense checks it again). */
export function manualExpenseProblem(input: { category: string; date: string; beforeGst: number; gst: number }) {
  if (!isCostCategory(input.category)) return "Choose what the expense is for";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "Enter the expense date";
  if (!(num(input.beforeGst) > 0) || num(input.beforeGst) > 100_000_000) return "Enter the amount before GST";
  if (num(input.gst) < 0 || num(input.gst) > num(input.beforeGst)) return "Enter a valid GST amount";
  return "";
}

/**
 * The channel partner commission the website itself worked out on a batch's sales (17 Nov 2026), for the Add expense
 * form to offer: each order line's commission (not cancelled) times the share of that line taken from this batch
 * (units taken minus units released back, over the line's units).
 */
export function batchCommissionShare(
  allocations: { order_item_id: string; reserved_quantity: number; released_quantity: number }[],
  commissions: { order_item_id: string; order_no: string; qty: number; amount: number; status: string }[],
) {
  const byItem = new Map(commissions.filter((c) => c.status !== "cancelled").map((c) => [c.order_item_id, c]));
  const taken = new Map<string, number>();
  for (const a of allocations) taken.set(a.order_item_id, (taken.get(a.order_item_id) ?? 0) + Math.max(0, num(a.reserved_quantity) - num(a.released_quantity)));
  let amount = 0;
  let earned = 0;
  const orders = new Set<string>();
  for (const [itemId, units] of taken) {
    const c = byItem.get(itemId);
    if (!c || !(num(c.qty) > 0) || units <= 0) continue;
    const part = num(c.amount) * Math.min(1, units / num(c.qty));
    amount += part;
    if (c.status === "earned") earned += part;
    orders.add(c.order_no);
  }
  return { amount: paise(amount), earned: paise(earned), pending: paise(amount - earned), orders: [...orders].sort() };
}

/**
 * A Books expense (GET expenses/:id) as cost documents: one for the whole expense, or one per line when it is itemized
 * (more than one line). `mode` forces one or the other, so a document keeps its identity when Zoho's line count changes.
 * Documents with no counted cost are left out.
 */
export function expenseDocuments(raw: Record<string, unknown>, mode: "auto" | "whole" | "lines" = "auto"): CostDoc[] {
  const id = text(raw["expense_id"]);
  if (!id) return [];
  const lines = Array.isArray(raw["line_items"]) ? (raw["line_items"] as Record<string, unknown>[]) : [];
  const currency = text(raw["currency_code"]) || "INR";
  const foreign = currency.toUpperCase() !== "INR";
  const rate = num(raw["exchange_rate"]) > 0 ? num(raw["exchange_rate"]) : 1;
  // Amounts in the base currency (₹): bcy_* when Zoho gives them, else the expense's currency at its rate.
  const base = (value: number, bcyKey?: string) => (foreign ? (bcyKey && has(raw, bcyKey) ? num(raw[bcyKey]) : value * rate) : value);
  const inclusive = raw["is_inclusive_tax"] === true;
  const reverse = raw["is_reverse_charge_applied"] === true;
  const status = text(raw["status"]).toLowerCase();
  const common = {
    source: "expense" as const, zoho_id: id,
    doc_number: expenseNumber(raw).slice(0, 80),
    doc_date: text(raw["date"]).slice(0, 10),
    vendor_name: text(raw["vendor_name"]).slice(0, 120),
    location_id: text(raw["location_id"] ?? raw["branch_id"]),
    currency_code: "INR",
    reverse_charge: reverse,
    rebilled: status === "invoiced",
    zoho_status: status,
    zoho_modified: text(raw["last_modified_time"]),
  };
  const gstOf = (row: Record<string, unknown>) => Math.max(num(row["tax_amount"]), reverse ? num(row["reverse_charge_tax_amount"]) : 0);
  const docs: CostDoc[] = [];
  const itemized = mode === "lines" || (mode === "auto" && lines.length > 1);
  if (!itemized) {
    const tax = gstOf(raw);
    const total = num(raw["total"]);
    let before = has(raw, "sub_total") ? num(raw["sub_total"]) : has(raw, "total_without_tax") ? num(raw["total_without_tax"]) : total - tax;
    // An expense entered "tax inclusive" may report its sub-total with the GST in it.
    if (inclusive && tax > 0 && Math.abs(before - total) < 0.005) before = total - tax;
    const claimable = !(ineligible(raw["itc_eligibility"]) || lines.some((line) => ineligible(line["itc_eligibility"])));
    docs.push({
      ...common, zoho_line_id: "",
      account_id: text(raw["account_id"]), account_name: text(raw["account_name"]).slice(0, 120),
      description: text(raw["description"]).slice(0, 200),
      amount_before_gst: paise(base(before, has(raw, "bcy_sub_total") ? "bcy_sub_total" : "bcy_total_without_tax")),
      gst_amount: paise(base(tax, "bcy_tax_amount")), gst_claimable: claimable,
    });
  } else {
    for (const line of lines) {
      const lineId = text(line["line_item_id"]);
      if (!lineId) continue;
      const tax = gstOf(line);
      const amount = num(line["amount"]);
      let before = has(line, "item_total") ? num(line["item_total"]) : inclusive ? amount - tax : amount;
      if (inclusive && tax > 0 && Math.abs(before - amount) < 0.005) before = amount - tax;
      docs.push({
        ...common, zoho_line_id: lineId,
        account_id: text(line["account_id"]), account_name: text(line["account_name"] ?? raw["account_name"]).slice(0, 120),
        description: (text(line["description"]) || text(raw["description"])).slice(0, 200),
        amount_before_gst: paise(foreign ? before * rate : before), gst_amount: paise(foreign ? tax * rate : tax),
        gst_claimable: !ineligible(line["itc_eligibility"] ?? raw["itc_eligibility"]),
      });
    }
  }
  return docs.filter((doc) => doc.doc_date && countedCost(doc) !== 0);
}

/** A row of the Books expenses list (GET expenses): what the picker shows before the expense is opened. */
export type ExpenseListRow = {
  expenseId: string; date: string; number: string; account: string; description: string; vendor: string;
  beforeGst: number; gst: number; total: number; status: string; rebilled: boolean; modifiedAt: string; locationId: string;
  /** A channel partner's commission: never a batch cost, nor overhead of the batches. */
  notBatchCost: boolean;
};
export function expenseListRow(raw: Record<string, unknown>): ExpenseListRow {
  const foreign = (text(raw["currency_code"]) || "INR").toUpperCase() !== "INR";
  const total = paise(num(foreign && has(raw, "bcy_total") ? raw["bcy_total"] : raw["total"]));
  const beforeKey = foreign ? "bcy_total_without_tax" : "total_without_tax";
  const before = has(raw, beforeKey) ? paise(num(raw[beforeKey])) : has(raw, "sub_total") ? paise(num(raw["sub_total"])) : total;
  const status = text(raw["status"]).toLowerCase();
  return {
    expenseId: text(raw["expense_id"]), date: text(raw["date"]).slice(0, 10),
    number: expenseNumber(raw), account: text(raw["account_name"]),
    description: text(raw["description"]), vendor: text(raw["vendor_name"]),
    beforeGst: before, gst: paise(Math.max(0, total - before)), total, status, rebilled: status === "invoiced",
    modifiedAt: text(raw["last_modified_time"]), locationId: text(raw["location_id"] ?? raw["branch_id"]),
    notBatchCost: notBatchCost(raw["account_name"]),
  };
}

/** The charge lines of a bill as BillPlan has them (src/lib/bill-batches.ts), without importing it. */
export type ChargeBill = {
  billId: string; billNumber: string; vendorName: string; date: string; locationId: string; status: string; modifiedAt: string;
  billDiscount: number; adjustment: number;
  lines: { lineId: string; name: string; accountName: string; chargeLine: boolean; taxable: number; gst: number }[];
};

/**
 * The costs on a supplier's bill that are not goods (spec 8.1): lines with no item or a non-stock item (freight, hamali,
 * transport billed by a vendor), the discount on the whole bill (a negative cost) and the adjustment / round-off. `raw`
 * (the bill as Zoho gave it) supplies each line's input-tax eligibility when Zoho names it.
 */
export function billChargeDocuments(bill: ChargeBill, raw?: Record<string, unknown>): CostDoc[] {
  const rawLines = new Map((Array.isArray(raw?.["line_items"]) ? (raw!["line_items"] as Record<string, unknown>[]) : []).map((line) => [text(line["line_item_id"]), line]));
  const common = {
    source: "bill" as const, zoho_id: bill.billId, doc_number: bill.billNumber.slice(0, 80), doc_date: bill.date.slice(0, 10),
    vendor_name: bill.vendorName.slice(0, 120), location_id: bill.locationId, currency_code: "INR", reverse_charge: false,
    rebilled: false, zoho_status: bill.status, zoho_modified: bill.modifiedAt, account_id: "",
  };
  const docs: CostDoc[] = [];
  for (const line of bill.lines) {
    if (!line.chargeLine || !line.lineId || paise(line.taxable) === 0) continue;
    const rawLine = rawLines.get(line.lineId);
    docs.push({
      ...common, zoho_line_id: line.lineId, account_id: text(rawLine?.["account_id"]), account_name: line.accountName.slice(0, 120),
      description: (line.name || line.accountName || "Charge").slice(0, 200),
      amount_before_gst: paise(line.taxable), gst_amount: paise(Math.max(0, line.gst)), gst_claimable: !ineligible(rawLine?.["itc_eligibility"]),
    });
  }
  if (paise(bill.billDiscount) !== 0)
    docs.push({ ...common, zoho_line_id: "bill-discount", account_name: "Discount on the whole bill", description: "Discount on the whole bill",
      amount_before_gst: -Math.abs(paise(bill.billDiscount)), gst_amount: 0, gst_claimable: true });
  if (paise(bill.adjustment) !== 0)
    docs.push({ ...common, zoho_line_id: "bill-adjustment", account_name: "Adjustment / round-off", description: "Adjustment / round-off",
      amount_before_gst: paise(bill.adjustment), gst_amount: 0, gst_claimable: true });
  return docs.filter((doc) => doc.doc_date);
}

/** The method a bill's charge is spread with at Receive purchase: the discount by value, everything else by bags. */
export const chargeSplitMethod = (lineId: string): SplitMethod => (lineId === "bill-discount" ? "value" : "bags");

// ------------------------------------------------------------------ what the P&L counts (spec 8.4)

/** A mirrored document as stored (public.zoho_cost_documents). */
export type StoredCostDoc = {
  id: number; source: string; zoho_id: string; zoho_line_id: string; doc_number: string; doc_date: string; account_id: string;
  account_name: string; vendor_name: string; description: string; amount_before_gst: number; gst_amount: number; gst_claimable: boolean;
  gst_override: boolean | null; reverse_charge: boolean; rebilled: boolean; cost_amount: number; accepted_cost_amount: number | null;
  zoho_status: string; zoho_modified: string; flag: string; flag_at: string | null; gone_at: string | null; checked_at: string | null;
  /** 17 Nov 2026: what it is for ('' = not chosen; COST_CATEGORIES), and who typed it in (source 'manual'). */
  category?: string; entered_by_name?: string; entered_at?: string | null;
  /** 18 Nov 2026: 'cogs', 'operating' or '' (= its type's default, DEFAULT_COST_KIND). */
  cost_kind?: string;
};
/** A tag as stored (public.batch_cost_tags). */
export type StoredCostTag = { id: number; document_id: number; batch_id: string; amount: number; method: string; weight: number; note: string; tagged_by_name: string; tagged_at: string };

/**
 * What a document's tags count for now, never more than Zoho's current amount:
 *   S = Σ tags; cur = 0 when gone, else the counted cost; target = sign(S)·min(|S|, |cur|) when the signs agree, else 0;
 *   each tag's part of the target in paise (largest remainder, by the tags' own amounts).
 * Returned in the order of `tags`.
 */
export function effectiveTagAmounts(doc: Pick<StoredCostDoc, "cost_amount" | "gone_at">, tags: Pick<StoredCostTag, "amount">[]): number[] {
  if (!tags.length) return [];
  const S = paise(tags.reduce((sum, t) => sum + num(t.amount), 0));
  const cur = doc.gone_at ? 0 : paise(num(doc.cost_amount));
  const target = sign(S) !== 0 && sign(S) === sign(cur) ? sign(S) * Math.min(Math.abs(S), Math.abs(cur)) : 0;
  return apportionPaise(target, tags.map((t) => Math.abs(num(t.amount))));
}

/** Effective amount per tag id, for every document at once. */
export function effectiveTagsById(docs: Pick<StoredCostDoc, "id" | "cost_amount" | "gone_at">[], tags: StoredCostTag[]) {
  const byDoc = new Map<number, StoredCostTag[]>();
  for (const tag of tags) byDoc.set(tag.document_id, [...(byDoc.get(tag.document_id) ?? []), tag]);
  const out = new Map<number, number>();
  const docOf = new Map(docs.map((d) => [d.id, d]));
  for (const [docId, list] of byDoc) {
    const doc = docOf.get(docId);
    const parts = doc ? effectiveTagAmounts(doc, list) : list.map(() => 0);
    list.forEach((tag, i) => out.set(tag.id, parts[i] ?? 0));
  }
  return out;
}

/**
 * Whether a new split takes the old one off first (the server, before tag_batch_costs): the document has tags and is
 * flagged, or its counted cost now (Zoho's amount with the GST choice) is no longer the amount its tags were confirmed
 * against. Saving it would flag it otherwise, and the database would refuse the new split ("Zoho changed this expense:
 * review it first"): a full new split is that review. A deleted document is never re-split.
 */
export function replacesStaleSplit(row: Pick<StoredCostDoc, "flag" | "gone_at" | "accepted_cost_amount"> & { tagged: number }, costNow: number) {
  if (row.gone_at || row.tagged === 0) return false;
  if (row.flag) return true;
  return row.accepted_cost_amount !== null && Math.abs(costNow - row.accepted_cost_amount) >= 0.005;
}

/**
 * What changed in Zoho since a document was saved, as the flag the admin sees, or "" (spec 8.3). `now` = the document
 * as Zoho has it now, or null when Zoho no longer has it. A change of amount is flagged only while the document has tags
 * (the tags were confirmed against accepted_cost_amount); an account or date change is flagged, the amounts stay.
 */
export function costDocChange(
  stored: Pick<StoredCostDoc, "source" | "cost_amount" | "accepted_cost_amount" | "account_name" | "doc_date" | "gst_override" | "rebilled">,
  now: Pick<CostDoc, "amount_before_gst" | "gst_amount" | "gst_claimable" | "account_name" | "doc_date" | "rebilled"> | null,
  gone: "deleted" | "voided" = "deleted",
) {
  const what = stored.source === "bill" ? "Bill" : "Expense";
  if (!now) return stored.source === "bill" ? (gone === "voided" ? "Bill voided in Zoho" : "Bill line deleted in Zoho") : "Expense deleted in Zoho";
  const cost = countedCost(now, stored.gst_override);
  if (stored.accepted_cost_amount !== null && stored.accepted_cost_amount !== undefined && Math.abs(cost - num(stored.accepted_cost_amount)) >= 0.005)
    return `Expense changed in Zoho: ₹${num(stored.accepted_cost_amount).toFixed(2)} → ₹${cost.toFixed(2)}; re-confirm the split`;
  if (now.rebilled && !stored.rebilled) return `${what} was charged on to a customer in Zoho`;
  if (stored.account_name && now.account_name && stored.account_name !== now.account_name)
    return `${what} account changed in Zoho (${stored.account_name} → ${now.account_name})`;
  if (stored.doc_date && now.doc_date && stored.doc_date.slice(0, 10) !== now.doc_date.slice(0, 10))
    return `${what} date changed in Zoho (${stored.doc_date.slice(0, 10)} → ${now.doc_date.slice(0, 10)})`;
  return "";
}

/** A Zoho answer that means the expense or bill is gone. */
export const zohoSaysGone = (message: string) => /does not exist|not found|no longer exists|invalid.*(expense|bill)|\b1002\b/i.test(message);

/** A Zoho answer that means the connection may not read Books expenses yet (the owner's Reauthorize step, spec 13). */
export const expensesNotAllowed = (message: string) => /scope|not authori[sz]ed|unauthori[sz]ed|\b57\b|oauth|permission/i.test(message);
export const REAUTHORIZE_HINT = "Press Reauthorize Zoho in Admin › Zoho to read expenses";
