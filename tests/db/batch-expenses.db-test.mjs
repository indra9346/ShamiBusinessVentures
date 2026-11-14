// Real-Postgres check of 20261114100000_batch_expenses.sql (Zoho Books expenses and bill charges tagged to batches), on
// PGlite with every migration in the repo and small stand-ins for what Supabase provides. All data is made up; nothing
// live is touched. Not part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/batch-expenses.db-test.mjs
//
// Migration A runs alone first (it may ship before the pre-orders), twice; then the pre-order migration, twice.
// It must end with "batch expenses OK".
import assert from "node:assert/strict";
import { makeWorld, sqlOf, MIGRATION_A, MIGRATION_B, istDay, ADMIN, C1, PARTNER_USER, SUGAR, OIL } from "./preorder-world.mjs";

const w = await makeWorld({ migrate: false });
const { db, q, one, as, adminOne, server, serverOne, refuses, n, batch, createLot, receive, pull, begin, rollback } = w;
if (process.env.WITHOUT_MIGRATION) {
  await refuses(() => serverOne("SELECT public.save_cost_document('{}'::jsonb)"), /function public\.save_cost_document\(jsonb\) does not exist/, "no function yet");
  console.log("without the migration: save_cost_document is missing, as expected");
  process.exit(1);
}
await db.exec(sqlOf(MIGRATION_A));
await db.exec(sqlOf(MIGRATION_A));

const doc = (fields) => serverOne("SELECT public.save_cost_document($1::jsonb) AS id", [JSON.stringify({ source: "expense", doc_date: istDay(0), ...fields })]).then((r) => r.id);
const docRow = (id) => one("SELECT * FROM public.zoho_cost_documents WHERE id = $1", [id]);
const tag = (id, rows, { rebilled = false, by = ADMIN } = {}) => serverOne("SELECT public.tag_batch_costs($1, $2::jsonb, $3, $4, 'TEST Admin') AS r", [id, JSON.stringify(rows), rebilled, by]).then((r) => r.r);
const tags = async (id) => (await q("SELECT b.batch_code, t.amount FROM public.batch_cost_tags t JOIN public.batches b ON b.id = t.batch_id WHERE t.document_id = $1 ORDER BY b.batch_code", [id])).map((r) => [r.batch_code, n(r.amount)]);
const OLD = (await batch("CLK-011126-01")).id, OILB = (await batch("CLK-011126-02")).id;

/* ---------- rights ---------- */
const priv = async (role, fn) => (await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`)).p;
for (const fn of ["public.save_cost_document(jsonb)", "public.tag_batch_costs(bigint,jsonb,boolean,uuid,text,boolean)", "public.untag_batch_costs(bigint,uuid,text)", "public.flag_cost_document_changes(jsonb)"]) {
  assert.deepEqual([await priv("anon", fn), await priv("authenticated", fn), await priv("service_role", fn)], [false, false, true], fn);
}
assert.deepEqual([await priv("anon", "public.accept_cost_document_change(bigint,uuid,text)"), await priv("authenticated", "public.accept_cost_document_change(bigint,uuid,text)")], [false, true]);
assert.equal(await priv("authenticated", "private.batch_cost_tags_check()"), false);

/* ---------- the counted cost: before GST, plus GST only when it can't be claimed ---------- */
const freight = await doc({ zoho_id: "E-FREIGHT", doc_number: "EXP-101", account_name: "Freight Inward", vendor_name: "Lorry Co", amount_before_gst: 9000, gst_amount: 450, gst_claimable: true, reverse_charge: true });
assert.equal(n((await docRow(freight)).cost_amount), 9000, "claimable GST (reverse charge, claimed) is not a cost");
const hamali = await doc({ zoho_id: "E-HAMALI", doc_number: "EXP-102", account_name: "Hamali", amount_before_gst: 1500, gst_amount: 300, gst_claimable: false });
assert.equal(n((await docRow(hamali)).cost_amount), 1800, "unclaimable GST is a real cost");
assert.equal(await doc({ zoho_id: "E-FREIGHT", doc_number: "EXP-101", account_name: "Freight Inward", amount_before_gst: 9000, gst_amount: 450 }), freight, "the same expense, one row");
const discount = await doc({ source: "bill", zoho_id: "B-SS1", zoho_line_id: "bill-discount", doc_number: "SS1", amount_before_gst: -250.5 });
assert.equal(n((await docRow(discount)).cost_amount), -250.5);
await refuses(() => doc({ zoho_id: "E-ZERO", amount_before_gst: 0 }), /^This expense has no amount$/, "zero");
await refuses(() => serverOne("SELECT public.save_cost_document('{\"source\":\"other\",\"zoho_id\":\"x\",\"doc_date\":\"2026-11-01\",\"amount_before_gst\":1}'::jsonb)"), /^Not a Zoho expense or bill line$/, "source");

/* ---------- tagging: only admins, never more than the expense, always its sign ---------- */
await refuses(() => tag(freight, [{ batch_id: OLD, amount: 100, method: "amount" }], { by: C1 }), /^Only administrators can tag expenses to batches$/, "customer");
await refuses(() => tag(freight, []), /^Choose at least one batch$/, "empty");
await refuses(() => tag(freight, [{ batch_id: OLD, amount: 6000, method: "bags" }, { batch_id: OILB, amount: 3000.01, method: "bags" }]), /^₹9000\.01 is more than this expense \(₹9000\.00\)$/, "over");
await refuses(() => tag(freight, [{ batch_id: OLD, amount: -1, method: "amount" }]), /^A tag must have the expense's sign$/, "sign");
await refuses(() => tag(freight, [{ batch_id: OLD, amount: 0, method: "amount" }]), /^A tag must have the expense's sign$/, "zero tag");
await refuses(() => tag(freight, [{ batch_id: "00000000-0000-4000-8000-000000000999", amount: 1, method: "amount" }]), /can't take expenses$/, "no batch");
await refuses(() => tag(freight, [{ batch_id: OLD, amount: 1, method: "amount" }, { batch_id: OLD, amount: 1, method: "amount" }]), /^Batch CLK-011126-01 is listed twice$/, "twice");
let r = await tag(freight, [{ batch_id: OLD, amount: 6000, method: "bags", weight: 50 }, { batch_id: OILB, amount: 2999.99, method: "bags", weight: 30 }]);
assert.deepEqual([n(r.tagged), n(r.untagged)], [8999.99, 0.01]);
assert.deepEqual(await tags(freight), [["CLK-011126-01", 6000], ["CLK-011126-02", 2999.99]]);
assert.equal(n((await docRow(freight)).accepted_cost_amount), 9000);
// Tagging again replaces the split.
await tag(freight, [{ batch_id: OLD, amount: 9000, method: "amount" }]);
assert.deepEqual(await tags(freight), [["CLK-011126-01", 9000]]);
assert.deepEqual((await q("SELECT action FROM public.batch_cost_tag_events WHERE document_id = $1 ORDER BY id", [freight])).map((x) => x.action), ["tag", "tag"]);
await tag(discount, [{ batch_id: OLD, amount: -250.5, method: "value" }]);
// An expense charged on to a customer needs the tick.
const rebilled = await doc({ zoho_id: "E-REB", amount_before_gst: 500, rebilled: true });
await refuses(() => tag(rebilled, [{ batch_id: OLD, amount: 500, method: "amount" }]), /^This expense was charged on to a customer; tick to count it as your cost$/, "rebilled");
await tag(rebilled, [{ batch_id: OLD, amount: 500, method: "amount" }], { rebilled: true });

/* ---------- the backstop holds even for a direct write (checked at commit) ---------- */
await refuses(async () => { await begin(); try { await q("INSERT INTO public.batch_cost_tags (document_id, batch_id, amount, method) VALUES ($1, $2, 1, 'amount')", [freight, OILB]); await db.exec("COMMIT"); } finally { await rollback().catch(() => {}); } },
  /^Expense EXP-101 would be tagged for ₹9001\.00 but it is ₹9000\.00$/, "over, written directly");
await refuses(async () => { await begin(); try { await q("UPDATE public.batch_cost_tags SET amount = -9000 WHERE document_id = $1", [freight]); await db.exec("COMMIT"); } finally { await rollback().catch(() => {}); } },
  /^A tag must have the expense's sign$/, "sign, written directly");
assert.deepEqual(await tags(freight), [["CLK-011126-01", 9000]]);

/* ---------- Zoho changed it: flagged, never more than Zoho's amount, accept after a re-split ---------- */
await doc({ zoho_id: "E-FREIGHT", doc_number: "EXP-101", account_name: "Freight Inward", amount_before_gst: 8000, gst_amount: 400 });
let d = await docRow(freight);
assert.deepEqual([d.flag, n(d.cost_amount), n(d.accepted_cost_amount)], ["Expense changed in Zoho: ₹9000.00 → ₹8000.00; re-confirm the split", 8000, 9000]);
assert.ok(d.flag_at);
assert.deepEqual(await tags(freight), [["CLK-011126-01", 9000]], "tags stay; the P&L scales them down");
await refuses(() => tag(freight, [{ batch_id: OLD, amount: 8000, method: "amount" }]), /^Zoho changed this expense: review it first$/, "flagged");
await refuses(() => adminOne("SELECT public.accept_cost_document_change($1, NULL, NULL)", [freight]), /^Tags add up to ₹9000\.00, Zoho now has ₹8000\.00: re-split first$/, "accept over");
await refuses(() => as(C1, "authenticated", () => q("SELECT public.accept_cost_document_change($1, $2, NULL)", [freight, ADMIN])), /^Only administrators can accept an expense change$/, "customer passing an admin's id");
assert.equal(await serverOne("SELECT public.untag_batch_costs($1, $2, 'TEST Admin') AS c", [freight, ADMIN]).then((x) => x.c), 1);
d = await docRow(freight);
assert.deepEqual([d.flag, d.accepted_cost_amount], ["", null]);
await tag(freight, [{ batch_id: OLD, amount: 8000, method: "amount" }]);
// It rose: accept straight away (the extra stays untagged).
await doc({ zoho_id: "E-FREIGHT", doc_number: "EXP-101", account_name: "Freight Inward", amount_before_gst: 8500, gst_amount: 0 });
assert.match((await docRow(freight)).flag, /^Expense changed in Zoho: ₹8000\.00 → ₹8500\.00/);
r = (await adminOne("SELECT public.accept_cost_document_change($1, NULL, NULL) AS r", [freight])).r;
assert.deepEqual([n(r.accepted), n(r.tagged)], [8500, 8000]);
assert.equal((await docRow(freight)).flag, "");
// The hourly check: an account change is flagged (amounts stay), a deleted expense is gone and counts 0; untag works on it.
assert.equal(await serverOne("SELECT public.flag_cost_document_changes($1::jsonb) AS c", [JSON.stringify([{ id: hamali, account_name: "Loading", flag: "Account changed in Zoho" }, { id: rebilled, gone: true }])]).then((x) => x.c), 2);
assert.deepEqual([(await docRow(hamali)).flag, (await docRow(hamali)).account_name, n((await docRow(hamali)).cost_amount)], ["Account changed in Zoho", "Loading", 1800]);
d = await docRow(rebilled);
assert.deepEqual([d.flag, !!d.gone_at], ["Expense deleted in Zoho", true]);
await refuses(() => tag(rebilled, [{ batch_id: OLD, amount: 1, method: "amount" }], { rebilled: true }), /^This expense is no longer in Zoho$/, "gone");
await refuses(() => adminOne("SELECT public.accept_cost_document_change($1, NULL, NULL)", [rebilled]), /^Tags add up to ₹500\.00, Zoho now has ₹0\.00: re-split first$/, "gone accept");
await serverOne("SELECT public.untag_batch_costs($1, $2, 'TEST Admin')", [rebilled, ADMIN]);
assert.deepEqual(await tags(rebilled), []);
assert.deepEqual((await q("SELECT action FROM public.batch_cost_tag_events WHERE document_id = $1 ORDER BY id", [rebilled])).map((x) => x.action), ["tag", "flag", "untag"]);
// Seen in Zoho again: no longer gone.
await doc({ zoho_id: "E-REB", amount_before_gst: 500, rebilled: true });
assert.deepEqual([(await docRow(rebilled)).flag, (await docRow(rebilled)).gone_at], ["", null]);

/* ---------- a batch with expenses can't be deleted ---------- */
const fresh = (await q(`INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit_cost, branch_id, source, status)
  VALUES ('CLK-TEST-01', $1, 'TEST Oil', 5, 5, 100, 'BR-CLK', 'website', 'Active') RETURNING id`, [OIL]))[0].id;
const unload = await doc({ zoho_id: "E-UNLOAD", amount_before_gst: 200 });
await tag(unload, [{ batch_id: fresh, amount: 200, method: "amount" }]);
await refuses(() => adminOne("SELECT public.admin_delete_batch($1)", [fresh]), /violates foreign key constraint|Expenses are tagged/, "A alone: the key holds");

/* ---------- the pre-order migration on top (twice): its blockers, splits and joins ---------- */
await db.exec(sqlOf(MIGRATION_B));
await db.exec(sqlOf(MIGRATION_B));
await refuses(() => adminOne("SELECT public.admin_delete_batch($1)", [fresh]), /^Expenses are tagged to batch CLK-TEST-01; remove them first$/, "blocker");
await q("UPDATE public.settings SET value = value || '{\"enabled\": true}'::jsonb WHERE key = 'preorder'");
const lot = await createLot({ qty: 360, cost: 2500 });
// Freight paid before the bill, on the lot: ₹1,000.01 by bags.
const advance = await doc({ zoho_id: "E-ADV", doc_number: "EXP-200", amount_before_gst: 1000.01 });
await tag(advance, [{ batch_id: lot.batch_id, amount: 1000.01, method: "bags" }]);
// A short bill with the rest coming: the tag splits 200 : 160 bags, to the paisa (largest remainder).
await pull({ "BR-CLK": 250, "BR-HBL": 0 });
await receive("BR-CLK", { bill_id: "B-P1", bill_number: "P1", vendor_name: "V", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(), modified: "m", total: 1, status: "open" },
  [{ line_id: "PL1", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 200, unit_ex_gst: 2527.5, unit_inc_gst: 2653.88, action: "match", match_batch_id: lot.batch_id, rest: "coming" }], { "BR-CLK": 250, "BR-HBL": 0 });
assert.deepEqual(await tags(advance), [[lot.batch_code, 555.56], [`${lot.batch_code}-R1`, 444.45]]);
assert.ok((await q("SELECT 1 FROM public.batch_cost_tag_events WHERE document_id = $1 AND action = 'split_on_match'", [advance])).length === 1);
// Review fix: the bill's own charges (freight line, tagged at Receive purchase) come off the lot when its match is undone;
// the lot's own expenses (paid before the bill) stay, with the remainder's share back.
const charge = await doc({ source: "bill", zoho_id: "B-P1", zoho_line_id: "CH-1", doc_number: "P1", amount_before_gst: 900 });
await tag(charge, [{ batch_id: lot.batch_id, amount: 900, method: "bags" }]);
const undone = (await serverOne("SELECT public.unmatch_incoming_batch($1, 'wrong bill', $2::jsonb, '{}'::jsonb, $3::timestamptz, $4, 'TEST Admin') AS r",
  [lot.batch_id, JSON.stringify([{ branch_id: "BR-CLK", zoho: 250 }, { branch_id: "BR-HBL", zoho: 0 }]), new Date().toISOString(), ADMIN])).r;
assert.equal(n(undone.charges_untagged), 900);
assert.deepEqual(await tags(charge), []);
assert.deepEqual([(await docRow(charge)).flag, (await docRow(charge)).accepted_cost_amount], ["", null]);
assert.deepEqual(await tags(advance), [[lot.batch_code, 1000.01]]);
assert.deepEqual((await q("SELECT action FROM public.batch_cost_tag_events WHERE document_id = $1 ORDER BY id", [charge])).map((x) => x.action), ["tag", "untag"]);
// Matched again to its real bill: the charge of P1 is free to go to the batch P1 really becomes.
await receive("BR-CLK", { bill_id: "B-P2", bill_number: "P2", vendor_name: "V", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(), modified: "m", total: 1, status: "open" },
  [{ line_id: "PL2", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 360, unit_ex_gst: 2527.5, unit_inc_gst: 2653.88, action: "match", match_batch_id: lot.batch_id }], { "BR-CLK": 250, "BR-HBL": 0 });

/* ---------- review fixes: a re-split in one call; one expense whole or by line, never both ---------- */
await doc({ zoho_id: "E-FREIGHT", doc_number: "EXP-101", account_name: "Freight Inward", amount_before_gst: 7000, gst_amount: 0 });
assert.match((await docRow(freight)).flag, /^Expense changed in Zoho/);
const retag = (id, rows) => serverOne("SELECT public.tag_batch_costs($1, $2::jsonb, false, $3, 'TEST Admin', true) AS r", [id, JSON.stringify(rows), ADMIN]).then((x) => x.r);
// A re-split that fails changes nothing: the old split and the flag stay (it used to be untagged first, in its own call).
await refuses(() => retag(freight, [{ batch_id: OLD, amount: 7000.01, method: "amount" }]), /^₹7000\.01 is more than this expense \(₹7000\.00\)$/, "re-split over");
assert.deepEqual(await tags(freight), [["CLK-011126-01", 8000]]);
assert.match((await docRow(freight)).flag, /^Expense changed in Zoho/);
await retag(freight, [{ batch_id: OLD, amount: 7000, method: "amount" }]);
assert.deepEqual(await tags(freight), [["CLK-011126-01", 7000]]);
assert.deepEqual([(await docRow(freight)).flag, n((await docRow(freight)).accepted_cost_amount)], ["", 7000]);
const itemWhole = await doc({ zoho_id: "E-ITEMS", doc_number: "EXP-300", amount_before_gst: 300 });
const itemLine = await doc({ zoho_id: "E-ITEMS", zoho_line_id: "LI-1", doc_number: "EXP-300", amount_before_gst: 100 });
await tag(itemWhole, [{ batch_id: OLD, amount: 300, method: "amount" }]);
await refuses(() => tag(itemLine, [{ batch_id: OLD, amount: 100, method: "amount" }]), /^This expense is already tagged as a whole; untag it first$/, "line after whole");
await serverOne("SELECT public.untag_batch_costs($1, $2, 'TEST Admin')", [itemWhole, ADMIN]);
await tag(itemLine, [{ batch_id: OLD, amount: 100, method: "amount" }]);
await refuses(() => tag(itemWhole, [{ batch_id: OLD, amount: 300, method: "amount" }]), /^This expense is already split by line; untag its lines first$/, "whole after line");
// The batches are locked before the document (a cancel or a match of the lot finishes first).
assert.match((await one("SELECT pg_get_functiondef('public.tag_batch_costs(bigint,jsonb,boolean,uuid,text,boolean)'::regprocedure) AS d")).d,
  /FROM public\.batches WHERE id = ANY \(ids\) ORDER BY id FOR SHARE;\s+SELECT \* INTO d FROM public\.zoho_cost_documents WHERE id = _document_id FOR UPDATE;/);
// A cancelled lot takes no expenses.
const gone = await createLot({ qty: 5, cost: 2500, zoho: { "BR-CLK": 250, "BR-HBL": 0 } });
await adminOne("SELECT public.admin_cancel_incoming_batch($1, 'supplier cancelled')", [gone.batch_id]);
const other = await doc({ zoho_id: "E-OTHER", amount_before_gst: 50 });
await refuses(() => tag(other, [{ batch_id: gone.batch_id, amount: 1, method: "amount" }]), new RegExp(`^Batch ${gone.batch_code} can't take expenses$`), "cancelled lot");

/* ---------- reading: admins only ---------- */
for (const table of ["zoho_cost_documents", "batch_cost_tags", "batch_cost_tag_events"]) {
  await refuses(() => as(null, "anon", () => q(`SELECT count(*) FROM public.${table}`)), /permission denied/, `anon ${table}`);
  assert.equal((await as(C1, "authenticated", () => one(`SELECT count(*)::int AS c FROM public.${table}`))).c, 0);
  assert.equal((await as(PARTNER_USER, "authenticated", () => one(`SELECT count(*)::int AS c FROM public.${table}`))).c, 0);
  assert.ok((await as(ADMIN, "authenticated", () => one(`SELECT count(*)::int AS c FROM public.${table}`))).c > 0);
  await refuses(() => as(ADMIN, "authenticated", () => q(`DELETE FROM public.${table}`)), /permission denied/, `admin writes ${table}`);
}
assert.equal((await one("SELECT value FROM public.settings WHERE key = 'batch_cost_check'")).value.at, "");

console.log("batch expenses OK");
