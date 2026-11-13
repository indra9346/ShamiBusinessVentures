// Real-Postgres check of 20261114110000_preorder_batches.sql (with 20261114100000_batch_expenses.sql), on PGlite with every
// migration in the repo and small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not
// part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/preorder-batches.db-test.mjs
//
// WITHOUT_MIGRATION=1 builds the same database without the two migrations: the test then stops at its first pre-order
// step (shown failing). It must end with "preorder batches OK".
import assert from "node:assert/strict";
import { makeWorld, applyMigrations, istDay, ADMIN, ADMIN2, C1, C2, C3, PARTNER_USER, STAFF_USER, HBL_STAFF, VENDOR_USER, SUGAR, OIL } from "./preorder-world.mjs";

const w = await makeWorld({ migrate: false });
const { db, q, one, as, begin, rollback, admin, adminOne, server, serverOne, refuses, n, pair, watch, payloadStock, batch, now, snapshot, order, checkout,
  orderRow, itemsOf, allocsOf, invoiceInZoho, forceStatus, createLot, pull, receive, events, notes, setPreorder } = w;

/* ---------- 1. the migrations: nothing changes for the shop, run twice ---------- */
const stockRows = () => q("SELECT branch_id, product_id, stock::text, zoho_pending, updated_at FROM public.branch_stock ORDER BY 1, 2");
const before = JSON.stringify(await stockRows());
const payloadBefore = JSON.stringify(await q("SELECT id, payload FROM public.catalog_products ORDER BY id"));
if (process.env.WITHOUT_MIGRATION) {
  console.log("without the migrations:");
  await refuses(() => createLot(), /function public\.(preorder_waiting_items|create_incoming_batch)\(.* does not exist/, "no pre-order function yet");
  await refuses(() => q("SELECT incoming FROM public.branch_stock"), /column "incoming" does not exist/, "no arriving column yet");
  console.log("  create_incoming_batch and branch_stock.incoming are missing, as expected (the test needs the migration)");
  process.exit(1);
}
await applyMigrations(db); // each migration twice
assert.equal(JSON.stringify(await stockRows()), before, "branch_stock is byte-identical after the migrations");
assert.equal(JSON.stringify(await q("SELECT id, payload FROM public.catalog_products ORDER BY id")), payloadBefore, "catalogue untouched");
assert.ok((await q("SELECT 1 FROM public.branch_stock WHERE free_total <> stock OR incoming <> 0 OR incoming_detail <> '[]'::jsonb")).length === 0, "free_total = stock, nothing arriving");
assert.deepEqual((await q("SELECT DISTINCT stage FROM public.batches")).map((r) => r.stage), ["received"], "every batch is received");
assert.equal((await q("SELECT count(*)::int AS c FROM public.preorder_watch"))[0].c, 0);
assert.deepEqual((await one("SELECT value FROM public.settings WHERE key = 'preorder'")).value, { enabled: false, graceDays: 0, requireAck: true });
assert.equal((await one("SELECT is_public FROM public.settings WHERE key = 'preorder'")).is_public, true);

/* ---------- 2. rights ---------- */
const priv = async (role, fn) => (await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`)).p;
const SERVER_FNS = [
  "public.create_incoming_batch(text,text,numeric,numeric,date,numeric,text,jsonb,text,jsonb,jsonb,jsonb,timestamp with time zone,uuid,text)",
  "public.apply_preorder_reading(text,text,numeric,timestamp with time zone,uuid[],numeric,boolean)",
  "public.preorder_push_plan(text,text,numeric,uuid[])",
  "public.release_preorder_hold(text,text,numeric,text,jsonb,numeric,uuid[],timestamp with time zone,uuid,text)",
  "public.unmatch_incoming_batch(uuid,text,jsonb,jsonb,timestamp with time zone,uuid,text)",
  "public.receive_bill_lines(text,jsonb,jsonb,text,jsonb,jsonb,timestamp with time zone,uuid,text)",
  "public.preorder_waiting_items(text[])", "public.order_waiting_goods(uuid)", "public.refresh_incoming_all()",
  "public.record_stock_count(text,text,numeric,numeric,numeric,numeric,text,text,boolean,text,uuid,text,uuid,numeric,uuid[])",
];
for (const fn of SERVER_FNS) {
  assert.equal(await priv("anon", fn), false, `anon ${fn}`);
  assert.equal(await priv("authenticated", fn), false, `authenticated ${fn}`);
  assert.equal(await priv("service_role", fn), true, `service ${fn}`);
}
const ADMIN_FNS = ["public.admin_update_incoming_batch(uuid,numeric,date,numeric,numeric,boolean,text,text,text)", "public.admin_cancel_incoming_batch(uuid,text)",
  "public.admin_join_incoming_batches(uuid,uuid,text)", "public.admin_move_to_ready(uuid,numeric,text)", "public.admin_set_preorder_settings(boolean,integer,boolean)",
  "public.order_item_arrivals(uuid)", "public.godown_incoming_lots(text)"];
for (const fn of ADMIN_FNS) {
  assert.equal(await priv("anon", fn), false, `anon ${fn}`);
  assert.equal(await priv("authenticated", fn), true, `authenticated ${fn}`);
}
for (const fn of ["private.take_order_line(uuid,text,text,numeric,boolean,numeric,text)", "private.apply_reading(text,text,numeric,timestamp with time zone,uuid[],numeric)",
  "private.match_incoming_line(text,uuid,jsonb,jsonb,text,date,bigint,uuid,text)", "private.watch_step(text,text,numeric,numeric,numeric)"]) {
  for (const role of ["anon", "authenticated", "service_role"]) assert.equal(await priv(role, fn), false, `${role} ${fn}`);
}
// The old 13-argument record_stock_count is gone; a call with the old arguments reaches the new one.
assert.equal((await q("SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'record_stock_count'"))[0].c, 1);
// Non-admins are refused inside the admin functions.
await refuses(() => as(C1, "authenticated", () => q("SELECT public.admin_set_preorder_settings(true, 0, true)")), /Only administrators/, "customer settings");
await refuses(() => as(PARTNER_USER, "authenticated", () => q("SELECT public.admin_cancel_incoming_batch(gen_random_uuid(), 'nope')")), /Only administrators/, "partner cancel");
await refuses(() => as(STAFF_USER, "authenticated", () => q("SELECT public.admin_move_to_ready(gen_random_uuid(), 1, 'nope')")), /Only administrators/, "staff move");
await refuses(() => as(VENDOR_USER, "authenticated", () => q("SELECT public.admin_update_incoming_batch(gen_random_uuid(), 1, NULL, NULL, NULL, NULL, NULL, NULL, '')")), /Only administrators/, "vendor edit");

/* ---------- 3. switched off by default ---------- */
await refuses(() => createLot(), /Pre-orders are switched off \(Admin › Settings › Pre-orders\)/, "off");
await refuses(() => adminOne("SELECT public.admin_set_preorder_settings(true, 15, true)"), /Grace days must be between 0 and 14/, "grace");
assert.deepEqual((await adminOne("SELECT public.admin_set_preorder_settings(true, 0, true) AS r")).r, { enabled: true, graceDays: 0, requireAck: true });

/* ---------- 4. creation guards, in order ---------- */
await refuses(() => createLot({ by: C1 }), /^Only administrators can create pre-order batches$/, "admin");
await q("UPDATE public.settings SET value = jsonb_set(value, '{enabled}', 'false') WHERE key = 'zoho_stock_master'");
await refuses(() => createLot(), /^Pre-orders need Zoho as the stock master$/, "stock master");
await q("UPDATE public.settings SET value = jsonb_set(value, '{enabled}', 'true') WHERE key = 'zoho_stock_master'");
await q("UPDATE public.settings SET value = jsonb_set(value, '{branch_routing}', 'false') WHERE key = 'platform_features'");
await refuses(() => createLot(), /^Pre-orders need godown matching by PIN to be on$/, "routing");
await q("UPDATE public.settings SET value = jsonb_set(value, '{branch_routing}', 'true') WHERE key = 'platform_features'");
await refuses(() => createLot({ branch: "BR-NOPE" }), /^Choose an active godown linked to a Zoho location$/, "godown");
await refuses(() => createLot({ product: "NOPE" }), /^NOPE is not a website product$/, "product");
await q("DELETE FROM public.zoho_item_links WHERE product_id = $1", [OIL]);
await refuses(() => createLot({ product: OIL }), /^TEST Oil 850ml is not linked to a Zoho item, so its bill can't be matched$/, "link");
await q("INSERT INTO public.zoho_item_links (product_id, zoho_item_id) VALUES ($1, 'I-OIL')", [OIL]);
await q("UPDATE public.zoho_item_links SET track_batches = true WHERE product_id = $1", [SUGAR]);
await refuses(() => createLot(), /^Sugar S1 has batch tracking in Zoho: its batches come from Zoho$/, "tracked");
await q("UPDATE public.zoho_item_links SET track_batches = false WHERE product_id = $1", [SUGAR]);
await q("UPDATE public.branches SET zoho_pricebook_id = 'PB-1' WHERE id = 'BR-HBL'");
await refuses(() => createLot({ branch: "BR-HBL" }), /^Sugar S1 is not sold at Hubli Godown$/, "price list");
await q("UPDATE public.branches SET zoho_pricebook_id = '' WHERE id = 'BR-HBL'");
for (const qty of [0, -1, 1000001, 2.5]) await refuses(() => createLot({ qty }), /^Enter the expected quantity in whole units \(1 to 10,00,000\)$/, `qty ${qty}`);
for (const holdBack of [-1, 361, 0.5]) await refuses(() => createLot({ holdBack }), /^Hold back must be between 0 and the expected quantity$/, `hold ${holdBack}`);
for (const cost of [0, -5, 100000001]) await refuses(() => createLot({ cost }), /^Enter the expected cost per unit before GST$/, `cost ${cost}`);
for (const date of [istDay(-1), istDay(181)]) await refuses(() => createLot({ date }), /^The expected date must be between today and 180 days ahead$/, `date ${date}`);
await q("UPDATE public.branch_stock SET zoho_pending = true WHERE branch_id = 'BR-HBL' AND product_id = $1", [SUGAR]);
await refuses(() => createLot(), /^A stock edit for Sugar S1 at Hubli Godown is waiting to go to Zoho\. Press Sync godowns now first\.$/, "pending");
await q("UPDATE public.branch_stock SET zoho_pending = false WHERE branch_id = 'BR-HBL' AND product_id = $1", [SUGAR]);
const tr = (await q(`INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, to_branch_id, to_location_id, parent_batch_id, product_id, quantity)
  SELECT 'GB-TR-TEST', 'split', 'BR-CLK', 'LOC-CLK', 'BR-HBL', 'LOC-HBL', id, product_id, 1 FROM public.batches WHERE batch_code = 'CLK-011126-01' RETURNING id`))[0].id;
await refuses(() => createLot(), /^A transfer of Sugar S1 between godowns is not finished\. Finish or cancel it first\.$/, "transfer");
await q("UPDATE public.batch_transfers SET status = 'cancelled' WHERE id = $1", [tr]);
await refuses(() => createLot({ readAt: new Date(Date.now() - 11 * 60_000).toISOString() }), /^Zoho's stock reading is too old; try again$/, "old reading");
await refuses(() => createLot({ zoho: { "BR-CLK": 50 } }), /^Zoho's stock reading is too old; try again$/, "a godown without a reading");
await refuses(() => createLot({ checks: { unreceived: [{ bill_id: "B-9", bill_number: "SS9", qty: 360, branch_id: "BR-CLK", ack: false }] } }),
  /^Bill SS9 has 360 Sugar S1 at Challakere Godown that is not received on the website\. Receive it, or tick "Not this purchase"\.$/, "unreceived bill");
// Nothing was made by any refusal.
assert.equal((await q("SELECT count(*)::int AS c FROM public.batches WHERE stage <> 'received'"))[0].c, 0);
assert.equal((await q("SELECT count(*)::int AS c FROM public.preorder_watch"))[0].c, 0);

/* ---------- 5. the worked example (spec 2.7): Sugar S1 at Challakere ---------- */
// Today, no lot: Zoho 50 at CLK, 0 at HBL; the pull keeps 50 ready.
let r = await pull({ "BR-CLK": 50, "BR-HBL": 0 });
assert.equal(r["BR-CLK"].legacy, true, "no lot: the old path");
assert.deepEqual(await pair("BR-CLK"), { ready: 50, arriving: 0, total: 50, detail: [], pending: false });
// L1: the lot. 360 bags at ₹2,500.00 before GST, by +7 days; ticked "not this purchase" on an older bill.
const BY = istDay(7);
const lot = await createLot({ qty: 360, cost: 2500, date: BY, po: { po_id: "PO-1", po_number: "PO-1311260158", line_id: "POL-1" },
  checks: { unreceived: [{ bill_id: "B-OLD9", bill_number: "SS9", qty: 10, branch_id: "BR-CLK", ack: true }] } });
const CODE = lot.batch_code;
assert.match(CODE, /^CLK-\d{6}-\d{2}$/);
assert.deepEqual([n(lot.ready), n(lot.incoming), n(lot.total)], [50, 360, 410]);
assert.deepEqual(lot.held_at_open, { "BR-CLK": 0, "BR-HBL": 0 });
assert.deepEqual(await pair("BR-CLK"), { ready: 50, arriving: 360, total: 410, detail: [{ by: BY, qty: 360 }], pending: false });
assert.deepEqual(await pair("BR-HBL"), { ready: 0, arriving: 0, total: 0, detail: [], pending: false });
assert.equal(await payloadStock(), 50, "the catalogue total counts ready stock only");
assert.deepEqual(await watch("BR-CLK").then((x) => [x.zoho, x.held, x.unbilled]), [50, 0, 360]);
assert.deepEqual(await watch("BR-HBL").then((x) => [x.zoho, x.held]), [0, 0]);
let b = await batch(CODE);
assert.deepEqual([b.stage, n(b.quantity), n(b.remaining_quantity), n(b.expected_quantity), n(b.unit_cost), n(b.est_unit_cost_ex_gst), n(b.est_unit_cost_inc_gst),
  b.cost_basis, b.status, b.zoho_po_number, b.purchase_ref, b.zoho_item_id, b.preorder_checks.unreceived[0].bill_number, b.preorder_checks.opening["BR-CLK"]],
  ["incoming", 360, 360, 360, 2500, 2500, 2625, "ex_gst", "Active", "PO-1311260158", "PO-1311260158", "I-SUGAR", "SS9", 0]);
assert.equal((await events("created")).length, 1);
await refuses(() => createLot({ po: { po_id: "PO-1", po_number: "PO-1311260158", line_id: "POL-1" } }), new RegExp(`^PO PO-1311260158 line is already pre-order batch ${CODE}$`), "PO line once");

// A customer orders 70 (50 ready + 20 arriving): without the tick, refused; with it, one order.
await refuses(() => order(C1, [[SUGAR, 70]]), new RegExp(`^Sugar S1 is partly arriving later \\(by \\d{2} [A-Z][a-z]{2} \\d{4}\\)\\. Tick the pre-order box to continue\\.$`), "no tick");
await refuses(() => order(C1, [[SUGAR, 411, true]]), /^A product does not have enough available stock$/, "beyond ready + arriving");
const o70 = await order(C1, [[SUGAR, 70, true]]);
assert.deepEqual(o70.items.map((i) => [i.qty, n(i.ready_qty), n(i.preorder_qty), i.preorder_by]), [[70, 50, 20, BY]]);
const O70 = o70.order_no;
assert.ok((await orderRow(O70)).preorder_ack_at, "the tick is on record");
assert.deepEqual((await itemsOf(O70)).map((i) => [n(i.preorder_qty), i.preorder_by]), [[20, BY]]);
assert.deepEqual(await allocsOf(O70), [["CLK-011126-01", 50, 2400], [CODE, 20, 2500]]);
assert.deepEqual(await pair("BR-CLK"), { ready: 0, arriving: 340, total: 340, detail: [{ by: BY, qty: 340 }], pending: false });
assert.equal(await payloadStock(), 0);
assert.deepEqual([n((await batch(CODE)).remaining_quantity), (await batch(CODE)).status], [340, "Active"]);
assert.deepEqual((await serverOne("SELECT public.order_waiting_goods(id) AS r FROM public.orders WHERE order_no = $1", [O70])).r,
  { waiting: 20, codes: [CODE], products: ["Sugar S1"], expected_date: BY });
await adminOne("SELECT public.admin_confirm_manual_payment($1, (SELECT total FROM public.orders WHERE order_no = $1), 'NEFT00000001', 'NEFT')", [O70]);
assert.equal((await orderRow(O70)).order_status, "Payment Confirmed");

/* ---------- 5b. matching (L4, L5, every quantity case), each from the state before any bill, its own bill pulled first ---------- */
const BILL = (qty, extra = {}) => ({ bill: { bill_id: "B-SS100", bill_number: "SS100", vendor_name: "SATESH TRADERS", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(),
  modified: "2026-11-14T10:00:00+0530", total: qty * 2653.88, status: "open", ...extra.bill }, line: { line_id: "L-1", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty, unit_ex_gst: 2527.5, unit_inc_gst: 2653.88, ...extra.line } });
const match = async (qty, zoho, { rest = null, restExpected = null, extra = {} } = {}) => {
  const { bill, line } = BILL(qty, extra);
  return receive("BR-CLK", bill, [{ ...line, action: "match", match_batch_id: (await batch(CODE)).id, rest, rest_expected: restExpected }], zoho);
};
const lotId = (await batch(CODE)).id;

// Qb < S with "nothing more is coming": refused, with the exact text.
await begin();
await refuses(() => match(15, { "BR-CLK": 65, "BR-HBL": 0 }, { rest: "none" }),
  new RegExp(`^Bill SS100 has 15 of Sugar S1, but customers already bought 20 on batch ${CODE}\\. Choose "the rest is still coming", or cancel and refund 5 of those orders first\\.$`), "Qb < S none");
await rollback();
// Bill rules: a draft or void bill, another product, another godown, a bad rest date.
await begin();
await refuses(() => match(360, { "BR-CLK": 410, "BR-HBL": 0 }, { extra: { bill: { status: "draft" } } }), /^Open bill SS100 in Zoho first: a draft bill has not added stock$/, "draft");
await refuses(() => match(360, { "BR-CLK": 410, "BR-HBL": 0 }, { extra: { bill: { status: "void" } } }), /^Bill SS100 is void in Zoho$/, "void");
await refuses(() => match(360, { "BR-CLK": 410, "BR-HBL": 0 }, { extra: { line: { product_id: OIL } } }), /^That bill line is another product\. Choose the Sugar S1 line\.$/, "product");
await refuses(() => match(200, { "BR-CLK": 410, "BR-HBL": 0 }, { rest: "coming", restExpected: istDay(-1) }), /^Choose when the rest should arrive$/, "rest date");
await refuses(async () => { const { bill, line } = BILL(360); return receive("BR-HBL", bill, [{ ...line, action: "match", match_batch_id: lotId }], { "BR-CLK": 410, "BR-HBL": 0 }); },
  new RegExp(`^Batch ${CODE} is at Challakere Godown, not at Hubli Godown\\. Choose Challakere Godown as the unloading godown\\.$`), "godown");
await refuses(async () => { const { bill, line } = BILL(360); return serverOne("SELECT public.receive_bill_here('BR-CLK',$1::jsonb,$2::jsonb,'ex_gst',$3,'x')", [JSON.stringify(bill), JSON.stringify([{ ...line, action: "match", match_batch_id: lotId }]), ADMIN]); },
  /^Matching needs a fresh Zoho reading; open Receive purchase again$/, "old receive");
// A new batch from the bill while the lot waits needs a reason of 10 letters.
await refuses(async () => { const { bill, line } = BILL(360); return receive("BR-CLK", bill, [{ ...line, action: "new", not_preorder_note: "other" }], { "BR-CLK": 410, "BR-HBL": 0 }); },
  new RegExp(`^Sugar S1 has pre-order batch ${CODE} waiting at Challakere Godown\\. Match this line to it, or say why it is a different purchase\\.$`), "reason");
await rollback();

// Partial bill variant (spec 2.7): 200 arrive, the rest still coming: CLK-..-R1 with 160; T 340, I 160, ready 180, arriving 160.
await begin();
r = await pull({ "BR-CLK": 250, "BR-HBL": 0 });
assert.deepEqual([n(r["BR-CLK"].T), n(r["BR-CLK"].held)], [340, 200]);
r = await match(200, { "BR-CLK": 250, "BR-HBL": 0 }, { rest: "coming", restExpected: istDay(10) });
assert.equal(r.matched[0].remainder.code, `${CODE}-R1`);
assert.deepEqual([n(r.matched[0].Q), n(r.matched[0].Qb), n(r.matched[0].S), n(r.matched[0].explain)], [360, 200, 20, 200]);
assert.deepEqual(await pair("BR-CLK"), { ready: 180, arriving: 160, total: 340, detail: [{ by: istDay(10), qty: 160 }], pending: false });
assert.deepEqual([n((await batch(CODE)).quantity), n((await batch(CODE)).remaining_quantity), (await batch(CODE)).stage], [200, 180, "received"]);
const r1 = await batch(`${CODE}-R1`);
assert.deepEqual([r1.stage, n(r1.quantity), n(r1.remaining_quantity), n(r1.expected_quantity), r1.expected_date, r1.split_from_batch_id, n(r1.est_unit_cost_ex_gst)],
  ["incoming", 160, 160, 160, istDay(10), lotId, 2500]);
assert.equal((await watch("BR-CLK")).held, 0);
assert.ok(await watch("BR-CLK"), "the watch stays: the remainder is a lot");
await rollback();

// The rest is still coming and 80 are sold: bags beyond the bill move to the remainder, orders awaiting payment first.
await begin();
const hold = await checkout(C2, [[SUGAR, 30, true]]);     // awaiting payment: 30 arriving
const late = await order(C3, [[SUGAR, 0 + 30, true]]).catch(() => null); // C3 is at Hubli: nothing arriving there
assert.equal(late, null, "Hubli has no lot");
const o30 = await order(C2, [[SUGAR, 30, true]]);             // paid later, newest: 30 arriving
assert.deepEqual(await pair("BR-CLK"), { ready: 0, arriving: 280, total: 280, detail: [{ by: BY, qty: 280 }], pending: false });
await pull({ "BR-CLK": 100, "BR-HBL": 0 });
r = await match(50, { "BR-CLK": 100, "BR-HBL": 0 }, { rest: "coming" });  // bill 50; S = 80 -> move 30
assert.deepEqual([n(r.matched[0].S), n(r.matched[0].Qb)], [80, 50]);
assert.deepEqual(await allocsOf(hold.order_no), [[`${CODE}-R1`, 30, 2500]], "the awaiting-payment hold moved first");
assert.deepEqual(await allocsOf(o30.order_no), [[CODE, 30, 2527.5]]);
assert.deepEqual(await allocsOf(O70), [["CLK-011126-01", 50, 2400], [CODE, 20, 2527.5]]);
assert.deepEqual([n((await batch(CODE)).remaining_quantity), n((await batch(`${CODE}-R1`)).remaining_quantity), n((await batch(`${CODE}-R1`)).quantity)], [0, 280, 310]);
assert.deepEqual(r.matched[0].moved_orders, [hold.order_no]);
assert.deepEqual([...r.matched[0].arrived_orders].sort(), [O70, o30.order_no].sort());
assert.equal((await q("SELECT count(*)::int AS c FROM public.order_item_batch_allocations WHERE moved_from_allocation_id IS NOT NULL"))[0].c, 1);
assert.match((await notes("Part of your order comes later"))[0].message, new RegExp(`^${hold.order_no}: 0 of 30 came now; the other 30 come with the next delivery, expected by \\d{2} [A-Z][a-z]{2} \\d{4}\\.$`));
await rollback();

// More than expected (Qb > Q): the batch grows to 400; the extra 40 are ready.
await begin();
await pull({ "BR-CLK": 450, "BR-HBL": 0 });
r = await match(400, { "BR-CLK": 450, "BR-HBL": 0 });
assert.deepEqual(await pair("BR-CLK"), { ready: 380, arriving: 0, total: 380, detail: [], pending: false });
assert.deepEqual([n((await batch(CODE)).quantity), n((await batch(CODE)).remaining_quantity)], [400, 380]);
await rollback();

// Short, nothing more coming (S <= Qb < Q): the batch shrinks to 300, the total falls by 60 through the reading.
await begin();
await pull({ "BR-CLK": 350, "BR-HBL": 0 });
r = await match(300, { "BR-CLK": 350, "BR-HBL": 0 }, { rest: "none" });
assert.deepEqual(await pair("BR-CLK"), { ready: 280, arriving: 0, total: 280, detail: [], pending: false });
assert.equal(r.matched[0].remainder, null);
await rollback();

// The bill for 360 is typed in Zoho (Zoho 410 at CLK); the hourly pull holds the rise: the total stays 340.
r = await pull({ "BR-CLK": 410, "BR-HBL": 0 });
assert.deepEqual([n(r["BR-CLK"].T), n(r["BR-CLK"].held), n(r["BR-CLK"].waiting), n(r["BR-CLK"].unbilled), n(r["BR-CLK"].arriving)], [340, 360, 70, 360, 340]);
assert.deepEqual(await pair("BR-CLK"), { ready: 0, arriving: 340, total: 340, detail: [{ by: BY, qty: 340 }], pending: false });
assert.equal((await watch("BR-CLK")).held, 360);
assert.equal((await events("hold_seen")).length, 1);
const heldNote = await notes("Zoho shows stock the website can't explain");
assert.equal(heldNote.length, 2, "both admins are told");
assert.match(heldNote[0].message, new RegExp(`^Zoho shows 360 more Sugar S1 at Challakere Godown than the website counts \\(since .*\\)\\. If it is the bill for pre-order batch ${CODE}, match it: Admin › Batches › Receive purchase\\. Those bags are not on sale until then\\.$`));
// A second pull of the same reading changes nothing and tells nobody again.
await pull({ "BR-CLK": 410, "BR-HBL": 0 });
assert.equal((await notes("Zoho shows stock the website can't explain")).length, 2);
assert.equal((await watch("BR-CLK")).held, 360);

// Variant: a Zoho counter sale of 10 while the bill is held: falls never reduce held. Total 330, arriving 330, oversold.
await begin();
r = await pull({ "BR-CLK": 400, "BR-HBL": 0 });
assert.deepEqual([n(r["BR-CLK"].T), n(r["BR-CLK"].held), n(r["BR-CLK"].raw)], [330, 360, -10]);
assert.deepEqual(await pair("BR-CLK"), { ready: 0, arriving: 330, total: 330, detail: [{ by: BY, qty: 330 }], pending: false });
assert.equal((await events("oversold")).length, 1);
assert.match((await notes("Pre-order oversold"))[0].message, new RegExp(`^Sugar S1 at Challakere Godown: 10 units promised to customers are neither in stock nor on the way\\. Check pre-order batch ${CODE} and Zoho\\.$`));
await rollback();

// The plain match (Qb = Q): the lot becomes a received batch at the bill's cost; held 0; the watch closes.
const outboxBefore = (await q("SELECT count(*)::int AS c FROM public.zoho_sync_outbox WHERE entity_type = 'order'"))[0].c;
r = await match(360, { "BR-CLK": 410, "BR-HBL": 0 });
assert.deepEqual([n(r.matched[0].cost_before), n(r.matched[0].cost_now), n(r.matched[0].explain)], [2500, 2527.5, 360]);
assert.deepEqual(r.matched[0].arrived_orders, [O70]);
assert.deepEqual(r.watch_closed, [SUGAR]);
assert.deepEqual(await pair("BR-CLK"), { ready: 340, arriving: 0, total: 340, detail: [], pending: false });
assert.equal(await watch("BR-CLK"), null);
assert.equal(await watch("BR-HBL"), null);
b = await batch(CODE);
assert.deepEqual([b.stage, n(b.quantity), n(b.remaining_quantity), n(b.unit_cost), n(b.unit_cost_ex_gst), n(b.unit_cost_inc_gst), n(b.est_unit_cost_ex_gst),
  b.zoho_bill_number, b.zoho_bill_line_id, b.supplier, b.purchase_date, b.matched_by_name, b.status, n(b.hold_back)],
  ["received", 360, 340, 2527.5, 2527.5, 2653.88, 2500, "SS100", "L-1", "SATESH TRADERS", istDay(0), "TEST Admin", "Active", 0]);
assert.match(b.notes, /Pre-order since .*; matched to bill SS100 by TEST Admin on /);
// The 20 pre-sold bags take the bill's cost: profit on them falls by ₹550.00 (cost variance).
const variance = (await one(`SELECT sum((a.reserved_quantity - a.released_quantity) * (b.unit_cost_ex_gst - b.est_unit_cost_ex_gst)) AS v
  FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id WHERE b.id = $1`, [lotId])).v;
assert.equal(n(variance), 550);
assert.ok((await q("SELECT count(*)::int AS c FROM public.zoho_sync_outbox WHERE entity_type = 'order'"))[0].c >= outboxBefore, "the order goes on to Zoho");
assert.ok((await q("SELECT 1 FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = (SELECT id::text FROM public.orders WHERE order_no = $1)", [O70])).length === 1);
assert.match((await notes("Your goods have arrived"))[0].message, new RegExp(`^${O70}: Sugar S1 has arrived at the Challakere Godown godown\\. Your invoice and pickup QR follow shortly\\.$`));
assert.equal((await events("watch_closed")).length, 2);
assert.equal((await events("matched")).length, 1);
// I6: the same bill line twice (another admin): "already batch".
await refuses(async () => { const { bill, line } = BILL(360); return receive("BR-CLK", bill, [{ ...line, action: "new" }], { "BR-CLK": 410 }); },
  new RegExp(`^Bill SS100 line is already batch ${CODE}\\. Each bill line makes one batch\\.$`), "I6");
// The order is confirmed and invoiced in Zoho by the next cron: Zoho 340, nothing waiting: ready 340 (the old path again).
await invoiceInZoho(O70);
r = await pull({ "BR-CLK": 340, "BR-HBL": 0 });
assert.equal(r["BR-CLK"].legacy, true);
assert.deepEqual(await pair("BR-CLK"), { ready: 340, arriving: 0, total: 340, detail: [], pending: false });

console.log("preorder batches: worked example OK");
globalThis.__w = w;
globalThis.__O70 = O70;
await import("./preorder-batches-more.mjs");
console.log("preorder batches OK");
