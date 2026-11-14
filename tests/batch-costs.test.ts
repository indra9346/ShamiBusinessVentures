import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apportionPaise, billChargeDocuments, chargeSplitMethod, costDocChange, countedCost, defaultSplitMethod, effectiveTagAmounts, effectiveTagsById,
  expenseDocuments, expenseListRow, expensesNotAllowed, parseKg, replacesStaleSplit, splitByMethod, zohoSaysGone,
  expenseNumber, notBatchCost, NOT_BATCH_COST_NOTE,
} from "../src/lib/batch-costs.ts";
import { billPlan } from "../src/lib/bill-batches.ts";

const sum = (list: number[]) => Math.round(list.reduce((a, b) => a + b, 0) * 100) / 100;

test("apportionPaise: whole paise, exact sums, largest remainder, ties to the earlier part", () => {
  // The pre-order split of 14 Nov: ₹1,000.01 over 200 : 160 bags (the database does the same, tests/db/batch-expenses).
  assert.deepEqual(apportionPaise(1000.01, [200, 160]), [555.56, 444.45]);
  assert.deepEqual(apportionPaise(100, [1, 1, 1]), [33.34, 33.33, 33.33]);
  assert.deepEqual(apportionPaise(-100, [1, 1, 1]), [-33.34, -33.33, -33.33], "a discount spreads with its minus sign");
  assert.deepEqual(apportionPaise(0.01, [1, 1]), [0.01, 0]);
  assert.deepEqual(apportionPaise(0.02, [1, 0, 1]), [0.01, 0, 0.01], "a part with no weight never gets a paisa");
  assert.deepEqual(apportionPaise(10, [0, 0]), [5, 5], "all weights 0: shared equally");
  assert.deepEqual(apportionPaise(10, [-3, 1]), [0, 10], "negative weights count as 0");
  assert.deepEqual(apportionPaise(5, []), []);
  assert.deepEqual(apportionPaise(0, [1, 2]), [0, 0]);
  // Random spreads always add up to the total exactly.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i += 1) {
    const total = Math.round((rand() * 2e6 - 1e6)) / 100;
    const weights = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => Math.round(rand() * 1000) / (rand() < 0.3 ? 7 : 1));
    const parts = apportionPaise(total, weights);
    assert.equal(sum(parts), total, `${total} over ${weights}`);
    for (const part of parts) assert.equal(Math.round(part * 100) / 100, part, "whole paise");
  }
});

test("the counted cost: before GST, plus GST only when it can't be claimed; the admin's choice wins", () => {
  assert.equal(countedCost({ amount_before_gst: 9000, gst_amount: 450, gst_claimable: true }), 9000);
  assert.equal(countedCost({ amount_before_gst: 1500, gst_amount: 300, gst_claimable: false }), 1800);
  assert.equal(countedCost({ amount_before_gst: 1500, gst_amount: 300, gst_claimable: false }, true), 1500);
  assert.equal(countedCost({ amount_before_gst: 9000, gst_amount: 450, gst_claimable: true }, false), 9450);
});

// The shape of a real Books expense (GET expenses/:id, live organisation, 14 Nov 2026), with names and ids made up.
const realShape = (over: Record<string, unknown> = {}) => ({
  expense_id: "E-RENT", transaction_type: "expense", account_id: "A-RENT", account_name: "Godown Rent", gst_treatment: "out_of_scope",
  tax_treatment: "out_of_scope", vendor_id: "", vendor_name: "", product_type: "service", itc_eligibility: "eligible", is_reverse_charge_applied: false,
  reverse_charge_tax_id: "", date: "2026-11-07", tax_id: "", tax_name: "", tax_percentage: 0, taxes: [], currency_id: "C-INR", currency_code: "INR",
  exchange_rate: 1, tax_amount: 0, sub_total: 10000, total: 10000, bcy_total: 10000, amount: 10000, is_inclusive_tax: false, reference_number: "",
  description: "Godown rent for October", is_billable: false, branch_id: "L-CLK", location_id: "L-CLK", created_time: "2026-11-07T16:44:48+0530",
  last_modified_time: "2026-11-07T16:44:48+0530", status: "nonbillable", invoice_id: "", invoice_number: "", cf_expense: "EXP-00122",
  line_items: [{ line_item_id: "LI-1", account_id: "A-RENT", account_name: "Godown Rent", description: "Godown rent for October", tax_amount: 0, tax_id: "",
    itc_eligibility: "eligible", tax_percentage: 0, item_total: 10000, amount: 10000, item_order: 1, reverse_charge_tax_id: "" }],
  ...over,
});

test("expenseDocuments: a plain expense is one document, numbered by its Expense #", () => {
  const [doc, ...rest] = expenseDocuments(realShape());
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...doc }, {
    source: "expense", zoho_id: "E-RENT", zoho_line_id: "", doc_number: "EXP-00122", doc_date: "2026-11-07", vendor_name: "", location_id: "L-CLK",
    currency_code: "INR", reverse_charge: false, rebilled: false, zoho_status: "nonbillable", zoho_modified: "2026-11-07T16:44:48+0530",
    account_id: "A-RENT", account_name: "Godown Rent", description: "Godown rent for October", amount_before_gst: 10000, gst_amount: 0, gst_claimable: true,
  });
  assert.equal(countedCost(doc!), 10000);
  // No Expense # field: the reference number.
  assert.equal(expenseDocuments(realShape({ cf_expense: undefined, reference_number: "SBIF400" }))[0]!.doc_number, "SBIF400");
});

test("expenseDocuments: tax inclusive, reverse charge, ineligible GST, another currency, charged on to a customer", () => {
  const inclusive = expenseDocuments(realShape({ is_inclusive_tax: true, tax_amount: 180, sub_total: 1180, total: 1180, amount: 1180,
    line_items: [{ line_item_id: "LI-1", account_name: "Hamali", tax_amount: 180, item_total: 1180, amount: 1180, itc_eligibility: "eligible" }] }))[0]!;
  assert.deepEqual([inclusive.amount_before_gst, inclusive.gst_amount, countedCost(inclusive)], [1000, 180, 1000]);
  const exclusive = expenseDocuments(realShape({ tax_amount: 180, sub_total: 1000, total: 1180 }))[0]!;
  assert.deepEqual([exclusive.amount_before_gst, exclusive.gst_amount], [1000, 180]);
  // Freight under reverse charge: the GST is paid by the company and claimed back, so the cost is ₹9,000 (spec 9.3).
  const rcm = expenseDocuments(realShape({ is_reverse_charge_applied: true, tax_amount: 0, reverse_charge_tax_amount: 450, sub_total: 9000, total: 9000 }))[0]!;
  assert.deepEqual([rcm.reverse_charge, rcm.gst_amount, countedCost(rcm)], [true, 450, 9000]);
  const blocked = expenseDocuments(realShape({ itc_eligibility: "ineligible_others", tax_amount: 300, sub_total: 1500, total: 1800 }))[0]!;
  assert.deepEqual([blocked.gst_claimable, countedCost(blocked)], [false, 1800]);
  const usd = expenseDocuments(realShape({ currency_code: "USD", exchange_rate: 83, sub_total: 100, total: 100, bcy_total: 8300 }))[0]!;
  assert.deepEqual([usd.amount_before_gst, usd.currency_code], [8300, "INR"]);
  const usdBcy = expenseDocuments(realShape({ currency_code: "USD", exchange_rate: 83, sub_total: 100, total: 100, bcy_sub_total: 8312.5 }))[0]!;
  assert.equal(usdBcy.amount_before_gst, 8312.5);
  assert.equal(expenseDocuments(realShape({ status: "invoiced" }))[0]!.rebilled, true);
  assert.deepEqual(expenseDocuments(realShape({ sub_total: 0, total: 0 })), [], "no amount, no document");
  assert.deepEqual(expenseDocuments({}), []);
});

test("expenseDocuments: an itemized expense is one document per line; the mode keeps a document's identity", () => {
  const raw = realShape({ sub_total: 10800, total: 11070, tax_amount: 270, line_items: [
    { line_item_id: "LI-F", account_id: "A-F", account_name: "Freight Charges", description: "Lorry", item_total: 9000, amount: 9000, tax_amount: 0, itc_eligibility: "eligible" },
    { line_item_id: "LI-H", account_id: "A-H", account_name: "Hamali", description: "", item_total: 1800, amount: 1800, tax_amount: 270, itc_eligibility: "ineligible_others" },
  ] });
  const lines = expenseDocuments(raw);
  assert.deepEqual(lines.map((d) => [d.zoho_line_id, d.account_name, d.description, d.amount_before_gst, d.gst_claimable, countedCost(d)]), [
    ["LI-F", "Freight Charges", "Lorry", 9000, true, 9000],
    ["LI-H", "Hamali", "Godown rent for October", 1800, false, 2070],
  ]);
  const whole = expenseDocuments(raw, "whole");
  assert.deepEqual(whole.map((d) => [d.zoho_line_id, d.amount_before_gst, d.gst_claimable]), [["", 10800, false]]);
  assert.deepEqual(expenseDocuments(realShape(), "lines").map((d) => d.zoho_line_id), ["LI-1"]);
});

test("expenseListRow: a row of the Books list, as the live list gives it", () => {
  const row = expenseListRow({
    expense_id: "E-FR", date: "2026-08-14", user_name: "", paid_through_account_name: "Bank", account_name: "Transportation Charges Freight Charges",
    description: "Transport freight PO 92", currency_id: "C-INR", currency_code: "INR", bcy_total: 43050, bcy_total_without_tax: 43050, total: 43050,
    total_without_tax: 43050, is_billable: false, reference_number: "NEFT-1", vendor_name: "", status: "nonbillable", created_time: "2026-09-09T14:54:33+0530",
    last_modified_time: "2026-09-11T18:25:29+0530", location_id: "L-CLK", location_name: "CLK", cf_expense: "EXP-00040",
  });
  assert.deepEqual(row, {
    expenseId: "E-FR", date: "2026-08-14", number: "EXP-00040", account: "Transportation Charges Freight Charges", description: "Transport freight PO 92",
    vendor: "", beforeGst: 43050, gst: 0, total: 43050, status: "nonbillable", rebilled: false, modifiedAt: "2026-09-11T18:25:29+0530", locationId: "L-CLK",
    notBatchCost: false,
  });
  assert.deepEqual([expenseListRow({ expense_id: "x", total: 1180, total_without_tax: 1000 }).gst], [180]);
});

test("review fixes: the Expense # of one expense read alone; a channel partner's commission is not a batch cost", () => {
  // GET expenses/:id (live shape, 14 Nov 2026): no top-level cf_expense, the number is in custom_field_hash / custom_fields.
  const detail = {
    expense_id: "3579709000001843851", date: "2026-08-14", account_id: "A-1", account_name: "Transportation Charges Freight Charges", total: 500,
    sub_total: 500, tax_amount: 0, reference_number: "IDFB6236M3180855", status: "nonbillable", line_items: [],
    custom_field_hash: { cf_expense: "EXP-00027", cf_expense_unformatted: "EXP-00027" },
    custom_fields: [{ api_name: "cf_expense", label: "Expense #", value: "EXP-00027" }],
  };
  assert.equal(expenseNumber(detail), "EXP-00027");
  assert.equal(expenseDocuments(detail)[0]!.doc_number, "EXP-00027", "not the bank reference");
  assert.equal(expenseNumber({ custom_fields: [{ api_name: "cf_expense", value: "EXP-00101" }], reference_number: "1026270434504" }), "EXP-00101");
  assert.equal(expenseNumber({ reference_number: "NEFT-9" }), "NEFT-9", "no Expense #: the reference");
  // The live Books account for partner commission at Challakere.
  for (const name of ["Channel Partner - Challakere - Commission", "channel partner payouts"]) assert.equal(notBatchCost(name), true, name);
  for (const name of ["Transportation Charges Freight Charges", "Hamali", "Partner lunch"]) assert.equal(notBatchCost(name), false, name);
  assert.equal(expenseListRow({ expense_id: "x", account_name: "Channel Partner - Challakere - Commission", total: 575 }).notBatchCost, true);
  assert.equal(NOT_BATCH_COST_NOTE, "Partner commission is not a batch cost (owner's rule)");
});

test("billChargeDocuments: freight and other non-stock lines, the bill discount (negative) and the round-off", () => {
  const raw = {
    bill_id: "B-9", bill_number: "SS4463", vendor_name: "NIRANJANA ENTERPRISES", date: "2026-11-03", status: "open", location_id: "L-CLK",
    last_modified_time: "2026-11-03T10:00:00+0530", discount_type: "entity_level", discount_amount: 50, adjustment: 0.22, total: 2000,
    line_items: [
      { line_item_id: "L1", item_id: "I-1", name: "Sugar S1", quantity: 2, rate: 500, item_total: 1000, tax_percentage: 5, item_type: "inventory" },
      { line_item_id: "L2", item_id: "", name: "Freight", account_name: "Freight Inward", quantity: 1, rate: 900, item_total: 900, tax_percentage: 0 },
      { line_item_id: "L3", item_id: "I-H", name: "Hamali", account_name: "Hamali", item_type: "sales_and_purchases", quantity: 1, rate: 100, item_total: 100, tax_percentage: 18, itc_eligibility: "ineligible_others" },
    ],
  };
  const docs = billChargeDocuments(billPlan(raw), raw);
  assert.deepEqual(docs.map((d) => [d.source, d.zoho_id, d.zoho_line_id, d.doc_number, d.account_name, d.amount_before_gst, d.gst_amount, d.gst_claimable, countedCost(d)]), [
    ["bill", "B-9", "L2", "SS4463", "Freight Inward", 900, 0, true, 900],
    ["bill", "B-9", "L3", "SS4463", "Hamali", 100, 18, false, 118],
    ["bill", "B-9", "bill-discount", "SS4463", "Discount on the whole bill", -50, 0, true, -50],
    ["bill", "B-9", "bill-adjustment", "SS4463", "Adjustment / round-off", 0.22, 0, true, 0.22],
  ]);
  assert.equal(chargeSplitMethod("bill-discount"), "value");
  assert.equal(chargeSplitMethod("L2"), "bags");
  // A bill of goods only has no charges.
  assert.deepEqual(billChargeDocuments(billPlan({ ...raw, discount_amount: 0, adjustment: 0, line_items: [raw.line_items[0]] })), []);
});

test("splitByMethod: bags, value, weight, typed amounts and percents, to the paisa", () => {
  const batches = [
    { batchId: "sugar", bags: 360, unitCostExGst: 2527.5, kgPerUnit: parseKg("50 kg bag") },
    { batchId: "rice", bags: 120, unitCostExGst: 1300, kgPerUnit: parseKg("26 Kg") },
  ];
  // The spec's ₹10,800 of freight and hamali, all on Sugar S1: ₹30.00 a bag.
  assert.deepEqual(splitByMethod(10800, [batches[0]!], "bags").rows, [{ batchId: "sugar", amount: 10800, weight: 360 }]);
  const bags = splitByMethod(1000, batches, "bags");
  assert.deepEqual(bags.rows.map((r) => r.amount), [750, 250]);
  assert.deepEqual([bags.tagged, bags.untagged, bags.problem], [1000, 0, ""]);
  const value = splitByMethod(1000, batches, "value");
  assert.deepEqual(value.rows.map((r) => r.amount), [853.64, 146.36]);
  assert.equal(sum(value.rows.map((r) => r.amount)), 1000);
  const weight = splitByMethod(1000, batches, "weight");
  assert.deepEqual(weight.rows.map((r) => [r.amount, r.weight]), [[852.27, 18000], [147.73, 3120]]);
  assert.equal(splitByMethod(1000, [{ ...batches[0]!, kgPerUnit: parseKg("5 L") }, batches[1]!], "weight").problem, "By weight needs every product's pack weight in kg");
  // Percents may leave part untagged (overhead); more than 100% is refused.
  const pct = splitByMethod(1000, batches.map((b, i) => ({ ...b, typed: i ? 25 : 50 })), "percent");
  assert.deepEqual([pct.rows.map((r) => r.amount), pct.tagged, pct.untagged], [[500, 250], 750, 250]);
  assert.match(splitByMethod(1000, batches.map((b) => ({ ...b, typed: 60 })), "percent").problem, /more than 100%/);
  const typed = splitByMethod(1000, batches.map((b, i) => ({ ...b, typed: i ? 0 : 400.5 })), "amount");
  assert.deepEqual([typed.rows, typed.untagged], [[{ batchId: "sugar", amount: 400.5, weight: 400.5 }], 599.5]);
  assert.match(splitByMethod(1000, batches.map((b) => ({ ...b, typed: 600 })), "amount").problem, /^₹1200\.00 is more than this expense \(₹1000\.00\)$/);
  // A discount spreads with its minus sign.
  assert.deepEqual(splitByMethod(-50, batches, "value").rows.map((r) => r.amount), [-42.68, -7.32]);
  assert.deepEqual(splitByMethod(-50, batches.map((b) => ({ ...b, typed: 10 })), "amount").rows.map((r) => r.amount), [-10, -10]);
  // Nothing to split over.
  assert.equal(splitByMethod(100, [], "bags").problem, "Choose at least one batch");
  assert.equal(splitByMethod(100, [{ batchId: "x", bags: 0, unitCostExGst: 1, kgPerUnit: null }], "bags").problem, "The chosen batches have no units to split by");
  assert.equal(splitByMethod(0, batches, "bags").problem, "This expense has no amount");
  // Default: by bags for one product, by value across products.
  assert.equal(defaultSplitMethod(["P1", "P1"]), "bags");
  assert.equal(defaultSplitMethod(["P1", "P2"]), "value");
  assert.deepEqual([parseKg("500 g"), parseKg("1 quintal"), parseKg("Sugar"), parseKg("10KG")], [0.5, 100, null, 10]);
});

test("effectiveTagAmounts: never more than Zoho's current amount", () => {
  const tags = [{ amount: 6000 }, { amount: 3000 }];
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 9000, gone_at: null }, tags), [6000, 3000], "unchanged");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 8000, gone_at: null }, tags), [5333.33, 2666.67], "fell: scaled down");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 9500, gone_at: null }, tags), [6000, 3000], "rose: the extra stays untagged");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 9000, gone_at: "2026-11-14T00:00:00Z" }, tags), [0, 0], "deleted: counts 0");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: -250.5, gone_at: null }, [{ amount: -150.25 }, { amount: -100.25 }]), [-150.25, -100.25], "a discount");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: -100, gone_at: null }, [{ amount: -150.25 }, { amount: -100.25 }]), [-59.98, -40.02]);
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 50, gone_at: null }, [{ amount: -10 }]), [0], "signs disagree: 0");
  assert.deepEqual(effectiveTagAmounts({ cost_amount: 50, gone_at: null }, []), []);
  const byId = effectiveTagsById([{ id: 1, cost_amount: 8000, gone_at: null }, { id: 2, cost_amount: 100, gone_at: null }],
    [{ id: 10, document_id: 1, batch_id: "a", amount: 6000, method: "bags", weight: 0, note: "", tagged_by_name: "", tagged_at: "" },
      { id: 11, document_id: 1, batch_id: "b", amount: 3000, method: "bags", weight: 0, note: "", tagged_by_name: "", tagged_at: "" },
      { id: 12, document_id: 2, batch_id: "a", amount: 100, method: "amount", weight: 0, note: "", tagged_by_name: "", tagged_at: "" }]);
  assert.deepEqual([...byId.entries()], [[10, 5333.33], [11, 2666.67], [12, 100]]);
});

test("costDocChange: what the hourly check flags", () => {
  const stored = { source: "expense", cost_amount: 9000, accepted_cost_amount: 9000, account_name: "Freight", doc_date: "2026-11-10", gst_override: null, rebilled: false };
  const now = { amount_before_gst: 9000, gst_amount: 0, gst_claimable: true, account_name: "Freight", doc_date: "2026-11-10", rebilled: false };
  assert.equal(costDocChange(stored, now), "");
  assert.equal(costDocChange(stored, null), "Expense deleted in Zoho");
  assert.equal(costDocChange({ ...stored, source: "bill" }, null), "Bill line deleted in Zoho");
  assert.equal(costDocChange({ ...stored, source: "bill" }, null, "voided"), "Bill voided in Zoho");
  assert.equal(costDocChange(stored, { ...now, amount_before_gst: 8000 }), "Expense changed in Zoho: ₹9000.00 → ₹8000.00; re-confirm the split");
  assert.equal(costDocChange(stored, { ...now, gst_amount: 450, gst_claimable: false }), "Expense changed in Zoho: ₹9000.00 → ₹9450.00; re-confirm the split");
  assert.equal(costDocChange({ ...stored, gst_override: true }, { ...now, gst_amount: 450, gst_claimable: false }), "", "the admin's GST choice holds");
  assert.equal(costDocChange({ ...stored, accepted_cost_amount: null }, { ...now, amount_before_gst: 8000 }), "", "no tags: nothing to re-confirm");
  assert.equal(costDocChange(stored, { ...now, account_name: "Hamali" }), "Expense account changed in Zoho (Freight → Hamali)");
  assert.equal(costDocChange(stored, { ...now, doc_date: "2026-11-11" }), "Expense date changed in Zoho (2026-11-10 → 2026-11-11)");
  assert.equal(costDocChange(stored, { ...now, rebilled: true }), "Expense was charged on to a customer in Zoho");
  assert.ok(zohoSaysGone("The expense does not exist."));
  assert.ok(zohoSaysGone("Resource not found (1002)"));
  assert.ok(!zohoSaysGone("Zoho Books expenses could not be reached"));
  assert.ok(expensesNotAllowed("You are not authorized to perform this operation"));
  assert.ok(expensesNotAllowed("invalid oauth scope"));
});

test("replacesStaleSplit: a new split of a changed expense takes the old one off first", () => {
  const row = { flag: "", gone_at: null, accepted_cost_amount: 9000, tagged: 9000 };
  assert.equal(replacesStaleSplit(row, 9000), false, "unchanged: the new split simply replaces the old one");
  assert.equal(replacesStaleSplit(row, 8000), true, "Zoho's amount moved before the hourly check flagged it");
  assert.equal(replacesStaleSplit({ ...row, flag: "Expense changed in Zoho: ₹9000.00 → ₹8000.00; re-confirm the split" }, 8000), true);
  assert.equal(replacesStaleSplit(row, 9450), true, "the GST choice changed the counted cost");
  assert.equal(replacesStaleSplit({ ...row, tagged: 0, accepted_cost_amount: null }, 8000), false, "no tags: nothing to take off");
  assert.equal(replacesStaleSplit({ ...row, gone_at: "2026-11-14T00:00:00Z", flag: "Expense deleted in Zoho" }, 9000), false, "deleted: never re-split");
});
