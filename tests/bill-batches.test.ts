import { test } from "node:test";
import assert from "node:assert/strict";
import { BILL_EDITED, batchDeleteBlocker, billChange, billGone, billLinesChange, billPlan, billSummary, costOf, goneBillLookalike, isBillLineFlag, lineBlocker, relinkBlocker } from "../src/lib/bill-batches.ts";

// The client's real bills of 3 Nov 2026, in the shape Zoho's GET /bills/:id returns them.
const line = (id: string, name: string, qty: number, rate: number, itemTotal: number, extra: Record<string, unknown> = {}) => ({
  line_item_id: id, item_id: `I-${id}`, name, quantity: qty, rate, item_total: itemTotal, tax_percentage: 5, tax_name: "GST5", item_type: "inventory", ...extra,
});
const SS4463 = {
  bill_id: "B1", bill_number: "SS4463", vendor_name: "NIRANJANA ENTERPRISES", date: "2026-11-03", location_id: "LOC-CLK", status: "paid",
  tax_specification: "intra", discount_type: "item_level", discount: 0, sub_total: 2111.22, tax_total: 105.56, adjustment: 0.22, total: 2217,
  last_modified_time: "2026-11-05T18:10:00+0530",
  line_items: [
    line("L1", "M Bisebelebath 17 GM", 2, 98.04, 196.08, { hsn_or_sac: "09109100" }),
    line("L2", "M Sambar 17GM", 6, 98.04, 553.24, { hsn_or_sac: "09109100", discount: 35 }),
    line("L3", "C meera Coconut oil 500ML", 6, 198.41, 1190.46, { hsn_or_sac: "15131900" }),
    line("L4", "E Zandu ultra balm 8ML", 4, 42.86, 171.44, { hsn_or_sac: "30049011" }),
  ],
};
const VS903 = {
  bill_id: "B2", bill_number: "VS903", vendor_name: "SHAKTHIDHARA ENTERPRISES", date: "2026-11-03", location_id: "LOC-CLK", status: "paid",
  tax_specification: "intra", discount_type: "item_level", sub_total: 1485.72, tax_total: 74.28, adjustment: 0, total: 1560,
  line_items: [line("L5", "Ekadantha OIL 850ML", 12, 123.81, 1485.72, { hsn_or_sac: "15081000" })],
};

test("SS4463: each line's unit cost without and with GST, as on the paper bill", () => {
  const plan = billPlan(SS4463);
  const got = plan.lines.map((l) => [l.name, l.taxable, l.unitExGst, l.unitIncGst]);
  assert.deepEqual(got, [
    ["M Bisebelebath 17 GM", 196.08, 98.04, 102.94],
    ["M Sambar 17GM", 553.24, 92.21, 96.82],
    ["C meera Coconut oil 500ML", 1190.46, 198.41, 208.33],
    ["E Zandu ultra balm 8ML", 171.44, 42.86, 45.0],
  ]);
});

test("SS4463: the ₹35 sits on the Sambar line only, and the bill adds up", () => {
  const plan = billPlan(SS4463);
  const sambar = plan.lines[1]!;
  assert.equal(sambar.gross, 588.24);
  assert.equal(sambar.discount, 35);
  assert.equal(sambar.discountLabel, "₹35.00");
  assert.deepEqual(plan.lines.filter((l) => l.discount !== 0).map((l) => l.name), ["M Sambar 17GM"]);
  assert.equal(plan.billDiscount, 0);
  assert.equal(plan.adjustment, 0.22);
  // Round-off is shown apart and named in a warning; nothing says the totals disagree.
  assert.ok(plan.warnings.some((w) => w.includes("₹0.22")));
  assert.ok(!plan.warnings.some((w) => w.includes("add up")));
  // Its lines' GST is CGST + SGST (intra-state), 2.5% each.
  // Zoho rounds GST once for the whole bill (105.56); per line it rounds to 105.55. A paisa apart, never more.
  const tax = plan.lines.reduce((s, l) => s + l.cgst + l.sgst, 0);
  assert.ok(Math.abs(tax - plan.taxTotal) <= 0.01 + 1e-9, `line GST ${tax} vs bill ${plan.taxTotal}`);
  assert.ok(plan.lines.every((l) => l.igst === 0));
});

test("VS903: Ekadantha 12 at 123.81 costs 123.81 without GST and 130.00 with", () => {
  const plan = billPlan(VS903);
  const [eka] = plan.lines;
  assert.equal(eka!.taxable, 1485.72);
  assert.equal(eka!.gst, 74.29);
  assert.equal(eka!.unitExGst, 123.81);
  assert.equal(eka!.unitIncGst, 130.0);
  assert.equal(costOf(eka!, "ex_gst"), 123.81);
  assert.equal(costOf(eka!, "inc_gst"), 130.0);
  assert.deepEqual(plan.warnings, []);
});

test("a discount on the whole bill is shown apart, kept out of unit cost, and warned about", () => {
  // SS4463 as it was saved at 13:13: the ₹35 on the whole bill, not on the Sambar line.
  const old = { ...SS4463, discount_type: "entity_level", discount: 35, discount_amount: 35, sub_total: 2146.22,
    line_items: SS4463.line_items.map((l) => (l.line_item_id === "L2" ? { ...l, discount: 0, item_total: 588.24 } : l)) };
  const plan = billPlan(old);
  assert.equal(plan.billDiscount, 35);
  assert.equal(plan.lines[1]!.unitExGst, 98.04);
  assert.equal(plan.lines[1]!.discount, 0);
  assert.ok(plan.warnings.some((w) => w.includes("₹35.00 on the whole bill")));
});

test("a percentage line discount and an inter-state bill", () => {
  const plan = billPlan({ ...VS903, tax_specification: "inter", line_items: [line("L9", "Oil", 10, 100, 900, { discount: "10%", tax_name: "IGST5" })] });
  const [l] = plan.lines;
  assert.equal(l!.discount, 100);
  assert.equal(l!.discountLabel, "10%");
  assert.equal(l!.igst, 45);
  assert.equal(l!.cgst + l!.sgst, 0);
  assert.equal(l!.unitExGst, 90);
  assert.equal(l!.unitIncGst, 94.5);
});

test("a void bill and lines that can't become batches say why", () => {
  assert.ok(billPlan({ ...VS903, status: "void" }).warnings.some((w) => w.includes("void")));
  const plan = billPlan(SS4463);
  const [first] = plan.lines;
  assert.equal(lineBlocker(first!, { productId: "P1", zohoTracksBatches: false, batchCode: "" }), "");
  assert.match(lineBlocker(first!, { productId: "P1", zohoTracksBatches: false, batchCode: "CLK-031126-01" }), /Done: batch CLK-031126-01/);
  assert.match(lineBlocker(first!, { productId: "", zohoTracksBatches: false, batchCode: "" }), /not a website product/);
  assert.match(lineBlocker({ ...first!, itemType: "sales_and_purchases" }, { productId: "P1", zohoTracksBatches: false, batchCode: "" }), /not a stock item/);
  assert.match(lineBlocker(first!, { productId: "P1", zohoTracksBatches: true, batchCode: "" }), /Zoho tracks batches/);
});

test("the recent-bills list keeps only what it shows", () => {
  assert.deepEqual(billSummary({ ...SS4463, line_items: undefined }), {
    billId: "B1", billNumber: "SS4463", vendorName: "NIRANJANA ENTERPRISES", date: "2026-11-03", total: 2217, status: "paid",
    locationId: "LOC-CLK", locationName: "", modifiedAt: "2026-11-05T18:10:00+0530",
  });
});

test("a bill changed, voided or deleted after its batches were made is flagged; an unchanged one is not", () => {
  const stored = { modifiedAt: "2026-11-05T18:10:00+0530", total: 2217 };
  assert.equal(billChange(stored, { status: "paid", modifiedAt: stored.modifiedAt, total: 2217 }), "");
  assert.match(billChange(stored, null), /deleted/);
  assert.match(billChange(stored, { status: "void", modifiedAt: "x", total: 2217 }), /voided/);
  assert.match(billChange(stored, { status: "paid", modifiedAt: stored.modifiedAt, total: 2252 }), /2217.00 → ₹2252.00/);
  assert.match(billChange(stored, { status: "paid", modifiedAt: "2026-11-06T09:00:00+0530", total: 2217 }), /edited/);
});

test("a batch can be deleted only while nothing has touched it", () => {
  const fresh = { quantity: 12, remaining_quantity: 12 };
  assert.equal(batchDeleteBlocker(fresh, [], 0), "");
  assert.match(batchDeleteBlocker({ quantity: 12, remaining_quantity: 11 }, [{ reserved_quantity: 1, released_quantity: 0 }], 0), /Orders have taken stock/);
  assert.match(batchDeleteBlocker(fresh, [{ reserved_quantity: 1, released_quantity: 1 }], 0), /used this batch before/);
  // Owner, 6 Nov: allowed when every order that used it was cancelled or expired, unpaid.
  const released = [{ reserved_quantity: 1, released_quantity: 1 }];
  assert.equal(batchDeleteBlocker(fresh, released, 0, () => ({ order_status: "Cancelled", payment_status: "Pending" })), "");
  assert.equal(batchDeleteBlocker(fresh, released, 0, () => ({ order_status: "Payment Expired", payment_status: "Pending" })), "");
  assert.match(batchDeleteBlocker(fresh, released, 0, () => ({ order_status: "Delivered", payment_status: "Paid" })), /used this batch before/);
  assert.match(batchDeleteBlocker(fresh, released, 0, () => ({ order_status: "Cancelled", payment_status: "Refunded" })), /used this batch before/);
  assert.match(batchDeleteBlocker(fresh, released, 0, () => undefined), /used this batch before/);
  assert.match(batchDeleteBlocker(fresh, [{ reserved_quantity: 1, released_quantity: 0 }], 0, () => ({ order_status: "Cancelled", payment_status: "Pending" })), /Orders have tak/);
  assert.match(batchDeleteBlocker(fresh, [], 1), /Stock counts/);
  assert.match(batchDeleteBlocker({ quantity: 12, remaining_quantity: 10 }, [], 0), /moved/);
});

test("13 Nov: a bill whose edit time moved is flagged only when a batch's own line changed", () => {
  // Zoho moves a bill's edit time for a purchase receive or a payment too: "YET TO COME" (Sugar S1) was flagged that way.
  const stored = { modifiedAt: "2026-11-13T14:10:00+0530", total: 955395 };
  assert.equal(billChange(stored, { status: "open", modifiedAt: "2026-11-13T15:20:00+0530", total: 955395 }), BILL_EDITED);
  const plan = billPlan(SS4463);
  const batches = [
    { batchCode: "CLK-031126-04", lineId: "L1", itemId: "I-L1", quantity: 2, unitExGst: 98.04 },
    { batchCode: "CLK-031126-05", lineId: "L2", itemId: "I-L2", quantity: 6, unitExGst: 92.21 },
  ];
  assert.equal(billLinesChange(batches, plan), "");
  // A cost written before the bill was read (null) is not compared.
  assert.equal(billLinesChange([{ ...batches[0]!, unitExGst: null }], plan), "");
  assert.match(billLinesChange([{ ...batches[0]!, quantity: 3 }], plan), /quantity for batch CLK-031126-04 changed in Zoho \(3 → 2\)/);
  assert.match(billLinesChange([{ ...batches[1]!, unitExGst: 98.04 }], plan), /cost for batch CLK-031126-05 changed in Zoho \(₹98.04 → ₹92.21 before GST\)/);
  assert.match(billLinesChange([{ ...batches[0]!, lineId: "GONE" }], plan), /line of batch CLK-031126-04 was removed/);
  assert.match(billLinesChange([{ ...batches[0]!, itemId: "I-OTHER" }], plan), /another item/);
});

test("13 Nov review: a 3-decimal bill quantity matches its 2-decimal batch; line flags are recognised", () => {
  const plan = billPlan({ ...VS903, line_items: [line("L5", "Loose sugar", 12.345, 40, 493.8)] });
  assert.equal(billLinesChange([{ batchCode: "CLK-1", lineId: "L5", itemId: "I-L5", quantity: 12.35, unitExGst: null }], plan), "");
  assert.match(billLinesChange([{ batchCode: "CLK-1", lineId: "L5", itemId: "I-L5", quantity: 12.4, unitExGst: null }], plan), /quantity for batch CLK-1/);
  for (const flag of ["Bill line of batch X was removed in Zoho", "Bill quantity for batch X changed in Zoho (2 → 3)", "Bill cost for batch X changed in Zoho (₹1.00 → ₹2.00 before GST)"])
    assert.ok(isBillLineFlag(flag), flag);
  for (const flag of ["", BILL_EDITED, "Bill voided in Zoho", "Bill deleted in Zoho", "Bill total changed in Zoho (₹1.00 → ₹2.00)"])
    assert.ok(!isBillLineFlag(flag), flag);
});

test("13 Nov: a batch whose bill was deleted in Zoho is linked to the same purchase entered again, never made twice", () => {
  // Live: CLK-131126-02, Sugar S1 360 from "YET TO COME", deleted in Zoho to be entered with the real bill number.
  const gone = [{ batchCode: "CLK-131126-02", productId: "SUGAR", quantity: 360 }];
  assert.equal(goneBillLookalike({ productId: "SUGAR", qty: 360 }, gone), "CLK-131126-02");
  assert.equal(goneBillLookalike({ productId: "SUGAR", qty: 350 }, gone), "");
  assert.equal(goneBillLookalike({ productId: "OIL", qty: 360 }, gone), "");
  assert.ok(billGone("Bill deleted in Zoho") && billGone("Bill voided in Zoho"));
  assert.ok(!billGone("") && !billGone(BILL_EDITED) && !billGone(null));
  const batch = { productId: "SUGAR", quantity: 360, billId: "OLD", billFlag: "Bill deleted in Zoho" };
  const line = { productId: "SUGAR", qty: 360, batchCode: "" };
  assert.equal(relinkBlocker(batch, line, "NEW"), "");
  assert.match(relinkBlocker({ ...batch, billFlag: "" }, line, "NEW"), /still in Zoho/);
  assert.match(relinkBlocker(batch, line, "OLD"), /own bill/);
  assert.match(relinkBlocker(batch, { ...line, batchCode: "CLK-1" }, "NEW"), /Already batch CLK-1/);
  assert.match(relinkBlocker(batch, { ...line, productId: "OIL" }, "NEW"), /Another product/);
  assert.match(relinkBlocker(batch, { ...line, qty: 350 }, "NEW"), /350 on this bill, 360 in the batch/);
});

test("pre-order batches: a lot is cancelled, not deleted; a batch with expenses keeps them (as admin_delete_batch)", () => {
  const lot = { quantity: 360, remaining_quantity: 360, stage: "incoming", batch_code: "CLK-141126-01" };
  assert.equal(batchDeleteBlocker(lot, [], 0), "Cancel pre-order batch CLK-141126-01 instead");
  assert.equal(batchDeleteBlocker({ ...lot, stage: "cancelled", quantity: 0, remaining_quantity: 0 }, [], 0), "", "a cancelled lot can be deleted");
  assert.equal(batchDeleteBlocker({ ...lot, stage: "received" }, [], 0, undefined, false, { tagged: true }), "Expenses are tagged to batch CLK-141126-01; remove them first");
});

test("charge lines, the bill's created time and its purchase orders", () => {
  const plan = billPlan({ ...SS4463, created_time: "2026-11-03T10:15:00+0530", purchaseorder_ids: ["PO-1", { purchaseorder_id: "PO-2" }],
    line_items: [...SS4463.line_items, { line_item_id: "F1", item_id: "", name: "Freight", quantity: 1, rate: 9000, item_total: 9000, tax_percentage: 0, account_name: "Freight Inward" }] });
  assert.equal(plan.createdAt, "2026-11-03T10:15:00+0530");
  assert.deepEqual(plan.poIds, ["PO-1", "PO-2"]);
  const freight = plan.lines.find((l) => l.lineId === "F1")!;
  assert.deepEqual([freight.chargeLine, freight.accountName], [true, "Freight Inward"]);
  assert.equal(plan.lines.filter((l) => l.chargeLine).length, 1, "stock items are not charge lines");
});
