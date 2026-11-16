// Regression tests for the review of the pre-order migrations (14 Nov 2026), on PGlite with every migration in the repo
// (preorder-world.mjs). Each block reproduces one finding and checks the fix. All data is made up; nothing live is touched.
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/preorder-review-fixes.db-test.mjs
//
// It must end with "preorder review fixes OK".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, sqlOf, files, MIGRATION_A, MIGRATION_B, root, istDay, ADMIN, C1, C3, PARTNER_USER, SUGAR } from "./preorder-world.mjs";

const w = await makeWorld();
const { db, q, one, as, begin, rollback, admin, adminOne, server, serverOne, refuses, n, pair, watch, batch, now, snapshot, order, checkout,
  orderRow, invoiceInZoho, createLot, pull, receive, notes, payloadStock } = w;
await adminOne("SELECT public.admin_set_preorder_settings(true, 0, true)");
const split = async (g) => { const p = await pair(g); return [p.ready, p.arriving, p.total]; };
const held = async (g) => (await watch(g)).held;
const bill = (id, qty, line = "L-1") => ({
  bill: { bill_id: id, bill_number: id, vendor_name: "SATESH TRADERS", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(), modified: "m", total: 1, status: "open" },
  line: { line_id: line, product_id: SUGAR, zoho_item_id: "I-SUGAR", qty, unit_ex_gst: 2527.5, unit_inc_gst: 2653.88 },
});
const ok = (label) => console.log(`  ${label}: OK`);

/* ---------- 1. a one-off low reading heals (held leak) ---------- */
await begin();
{
  const lot = await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  const o = await order(C1, [[SUGAR, 10]]);                     // ready, on a draft sales order: waiting
  assert.deepEqual(await split("BR-CLK"), [40, 360, 400]);
  // The bank alert's push confirms the sales order in Zoho between the pull's snapshot and its item read (Zoho 50 -> 40).
  await pull({ "BR-CLK": 40, "BR-HBL": 0 }, { between: () => server("UPDATE public.orders SET zoho_salesorder_id = 'SO-1', zoho_order_status = 'confirmed' WHERE order_no = $1", [o.order_no]) });
  assert.deepEqual(await split("BR-CLK"), [30, 360, 390], "counted twice once: never above the truth");
  const r = await pull({ "BR-CLK": 40, "BR-HBL": 0 });          // a quiet pull
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK"), n(r["BR-CLK"].healed)], [40, 360, 400, 0, 10], "healed, nothing held");
  assert.equal((await notes("Zoho shows stock the website can't explain")).length, 0, "no false alert");
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 39)", [SUGAR]);   // head office may edit again
  // The bill (200, the rest still coming) is matched: ready is the truth (240 in Zoho, 1 typed off, nothing waiting).
  await q("UPDATE public.branch_stock SET zoho_pending = false WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR]);
  await q("UPDATE public.preorder_watch SET pending_delta = 0 WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR]);
  await pull({ "BR-CLK": 239, "BR-HBL": 0 });
  const { bill: B, line } = bill("B-R1", 200);
  await receive("BR-CLK", B, [{ ...line, action: "match", match_batch_id: lot.batch_id, rest: "coming", rest_expected: istDay(9) }], { "BR-CLK": 239, "BR-HBL": 0 });
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK")], [239, 160, 399, 0]);
}
await rollback();
// The other way round stays safe: an order invoiced just after the read is counted once (exact), and if Zoho shows no rise
// at the next reading nothing comes back.
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  const o = await order(C1, [[SUGAR, 10]]);
  const readAt = now();
  const snap = await snapshot();
  await server("UPDATE public.orders SET zoho_salesorder_id = 'SO-2', zoho_order_status = 'confirmed' WHERE order_no = $1", [o.order_no]);
  await serverOne("SELECT public.apply_preorder_reading('BR-CLK', $1, 50, $2::timestamptz, $3::uuid[])", [SUGAR, readAt, snap[`BR-CLK|${SUGAR}`]]);
  assert.deepEqual(await split("BR-CLK"), [40, 360, 400]);
  await pull({ "BR-CLK": 40, "BR-HBL": 0 });
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK")], [40, 360, 400, 0]);
}
await rollback();
ok("1 low reading heals");

/* ---------- 2. a staff count after a waiting head-office decrease ---------- */
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 45)", [SUGAR]);
  assert.deepEqual([...(await split("BR-CLK")), (await pair("BR-CLK")).pending], [45, 360, 405, true]);
  // Staff count 45 against Zoho's 50: the server posts -5; the count replaces the waiting edit.
  await serverOne("SELECT public.record_stock_count('BR-CLK', $1, 45, 50, -5, 45, 'daily_count', '', false, 'ADJ-1', NULL, 'Ravi', NULL, 45, '{}'::uuid[])", [SUGAR]);
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK"), (await pair("BR-CLK")).pending], [45, 360, 405, 0, false]);
  await pull({ "BR-CLK": 45, "BR-HBL": 0 });
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK")], [45, 360, 405, 0]);
  // A waiting increase at a watched godown with no lot (Hubli) carried into Zoho by the count is not held.
  await adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 4)", [SUGAR]);
  await serverOne("SELECT public.record_stock_count('BR-HBL', $1, 4, 0, 4, 4, 'daily_count', '', false, 'ADJ-2', NULL, 'Hanu', NULL, 4, '{}'::uuid[])", [SUGAR]);
  assert.deepEqual([...(await split("BR-HBL")), await held("BR-HBL")], [4, 0, 4, 0]);
}
await rollback();
ok("2 count after a waiting edit");

/* ---------- 4. the push of a waiting edit never raises Zoho where a lot is (oversold) ---------- */
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await order(C1, [[SUGAR, 70, true]]);                          // 50 ready + 20 arriving
  await pull({ "BR-CLK": 40, "BR-HBL": 0 });                       // a counter sale of 10: oversold
  assert.deepEqual(await split("BR-CLK"), [0, 330, 330]);
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 0)", [SUGAR]);  // saved at the same 0
  const plan = (await serverOne("SELECT public.preorder_push_plan('BR-CLK', $1, 40, '{}'::uuid[]) AS r", [SUGAR])).r;
  assert.deepEqual([plan.blocked, n(plan.delta)], [false, 0], "nothing to send (was +10 to Zoho)");
  const st = (await serverOne("SELECT public.preorder_push_start('BR-CLK', $1) AS r", [SUGAR])).r;
  assert.deepEqual([st.blocked, n(st.delta), (await pair("BR-CLK")).pending], [false, 0, false]);
  // A waiting increase where a lot is is never sent.
  await q("UPDATE public.branch_stock SET zoho_pending = true WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR]);
  await q("UPDATE public.preorder_watch SET pending_delta = 3 WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR]);
  const up = (await serverOne("SELECT public.preorder_push_start('BR-CLK', $1) AS r", [SUGAR])).r;
  assert.deepEqual([up.blocked, up.message], [true, "Sugar S1 has a pre-order batch at Challakere Godown, so the website never raises its stock in Zoho there; the edit waits."]);
}
await rollback();
ok("4 no Zoho increase from an oversold push");

/* ---------- 6 + 13. readings during a push; an edit made during the push ---------- */
await begin();
{
  const lot = await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 45)", [SUGAR]);
  await pull({ "BR-CLK": 50, "BR-HBL": 0 });
  const st = (await serverOne("SELECT public.preorder_push_start('BR-CLK', $1) AS r", [SUGAR])).r;
  assert.equal(n(st.delta), -5);
  // Receive purchase of another bill at Challakere while the -5 is on its way: refused (Zoho may or may not show it).
  const { bill: B, line } = bill("B-OTHER", 10);
  await refuses(() => receive("BR-CLK", B, [{ ...line, action: "new", not_preorder_note: "another supplier's lorry" }], { "BR-CLK": 55, "BR-HBL": 0 }),
    /^A stock edit for Sugar S1 at Challakere Godown is being sent to Zoho right now\. Try again in a minute\.$/, "receive while pushing");
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 42)", [SUGAR]);   // edit 2 (-3) during the POST
  await serverOne("SELECT public.preorder_push_finish('BR-CLK', $1, true)", [SUGAR]);
  assert.deepEqual([(await pair("BR-CLK")).pending, n((await one("SELECT pending_delta FROM public.preorder_watch WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR])).pending_delta)], [true, -3]);
  // Now the receive: Zoho 45 + 10; the total keeps edit 2, nothing held, no false "left".
  await receive("BR-CLK", B, [{ ...line, action: "new", not_preorder_note: "another supplier's lorry" }], { "BR-CLK": 55, "BR-HBL": 0 });
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK")], [52, 360, 412, 0]);
  assert.equal((await q("SELECT 1 FROM public.batch_lot_events WHERE kind = 'left_unseen'")).length, 0);
  // Edit 2 goes next time, by itself.
  await pull({ "BR-CLK": 55, "BR-HBL": 0 });
  assert.equal(n((await serverOne("SELECT public.preorder_push_start('BR-CLK', $1) AS r", [SUGAR])).r.delta), -3);
  await serverOne("SELECT public.preorder_push_finish('BR-CLK', $1, true)", [SUGAR]);
  await pull({ "BR-CLK": 52, "BR-HBL": 0 });
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK"), (await pair("BR-CLK")).pending], [52, 360, 412, 0, false]);
  void lot;
}
await rollback();
ok("6/13 push in flight");

/* ---------- 7 + 12. undo of a match: refused with a waiting edit, or while an order on it is being sent to Zoho ---------- */
await begin();
{
  const lot = await createLot({ qty: 100, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  const o = await order(C1, [[SUGAR, 60, true]]);                // 50 ready + 10 arriving
  await pull({ "BR-CLK": 150, "BR-HBL": 0 });
  const { bill: B, line } = bill("B-U1", 100);
  await receive("BR-CLK", B, [{ ...line, action: "match", match_batch_id: lot.batch_id }], { "BR-CLK": 150, "BR-HBL": 0 });
  const undo = () => serverOne("SELECT public.unmatch_incoming_batch($1, 'wrong bill', $2::jsonb, '{}'::jsonb, $3::timestamptz, $4, 'TEST Admin') AS r",
    [lot.batch_id, JSON.stringify([{ branch_id: "BR-CLK", zoho: 150 }, { branch_id: "BR-HBL", zoho: 0 }]), now(), ADMIN]);
  await adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 0)", [SUGAR]);   // saved at Hubli, waiting for Zoho
  await refuses(undo, /^A stock edit for Sugar S1 at Hubli Godown is waiting to go to Zoho\. Press Sync godowns now first\.$/, "pending");
  await q("UPDATE public.branch_stock SET zoho_pending = false WHERE product_id = $1", [SUGAR]);
  await server("INSERT INTO public.zoho_order_push_claims (order_id, holder, locked_until) SELECT id, gen_random_uuid(), now() + interval '3 minutes' FROM public.orders WHERE order_no = $1", [o.order_no]);
  await refuses(undo, /has moved on since its match \(an order on it is being sent to Zoho\)/, "push running");
  await server("UPDATE public.zoho_order_push_claims SET locked_until = now() - interval '1 minute', write_unanswered_at = now() - interval '2 minutes'");
  await refuses(undo, /an order on it is being sent to Zoho/, "unanswered write");
  await server("UPDATE public.zoho_order_push_claims SET write_unanswered_at = now() - interval '11 minutes'");
  await undo();
  assert.equal((await batch(lot.batch_code)).stage, "incoming");
}
await rollback();
ok("7/12 undo guards");

/* ---------- 9. no "out of stock" / "low stock" alert for a number that exists only half-way ---------- */
await begin();
{
  const alerts = async () => (await q("SELECT title FROM public.notifications WHERE title IN ('Product out of stock', 'Low stock alert')")).length;
  const before = await alerts();
  const lot = await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await adminOne("SELECT public.admin_update_incoming_batch($1, 400, NULL, NULL, NULL, NULL, NULL, NULL, 'more coming')", [lot.batch_id]);
  await pull({ "BR-CLK": 250, "BR-HBL": 0 });
  const { bill: B, line } = bill("B-A1", 200);
  await receive("BR-CLK", B, [{ ...line, action: "match", match_batch_id: lot.batch_id, rest: "coming", rest_expected: istDay(9) }], { "BR-CLK": 250, "BR-HBL": 0 });
  assert.equal(await alerts(), before, "no stock alert from a lot made, resized or matched");
  assert.equal(await payloadStock(), 250, "the catalogue total is the final ready stock");
}
await rollback();
ok("9 no half-way stock alerts");

/* ---------- 10. a blocked edit no longer stops Zoho's readings (counter sales are seen) ---------- */
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 48)", [SUGAR]);
  await pull({ "BR-CLK": 410, "BR-HBL": 0 });                     // the lorry's bill typed in Zoho: held, the edit blocked
  assert.deepEqual([await held("BR-CLK"), (await serverOne("SELECT public.preorder_push_start('BR-CLK', $1) AS r", [SUGAR])).r.blocked], [360, true]);
  await pull({ "BR-CLK": 380, "BR-HBL": 0 });                     // 30 sold at the counter through Zoho
  assert.deepEqual([...(await split("BR-CLK")), await held("BR-CLK")], [18, 360, 378, 360], "the sale is seen while the edit waits");
}
await rollback();
ok("10 readings while an edit is blocked");

/* ---------- 11. a retried "Make pre-order batch" makes one lot ---------- */
await begin();
{
  const request = "5b0d7f5e-0d1c-4f0e-9a51-1a2b3c4d5e6f";
  const a = await createLot({ qty: 360, checks: { request } });
  const b = await createLot({ qty: 360, checks: { request } });
  assert.deepEqual([b.batch_id, b.repeated], [a.batch_id, true]);
  assert.equal((await q("SELECT count(*)::int AS c FROM public.batches WHERE stage = 'incoming'"))[0].c, 1);
  assert.deepEqual(await split("BR-CLK"), [50, 360, 410]);
  const c = await createLot({ qty: 10, checks: { request: "6b0d7f5e-0d1c-4f0e-9a51-1a2b3c4d5e6f" } });
  assert.notEqual(c.batch_id, a.batch_id);
}
await rollback();
ok("11 one lot per request");

/* ---------- 15. Migration B refuses to run without Migration A ---------- */
{
  const bare = await makeWorld({ migrate: false });
  await assert.rejects(() => bare.db.exec(sqlOf(MIGRATION_B)), /Apply 20261114100000_batch_expenses\.sql first/);
  await bare.db.exec("ROLLBACK");
  assert.equal((await bare.q("SELECT to_regclass('public.preorder_watch') AS t"))[0].t, null, "nothing was applied");
  await bare.db.close();
}
ok("15 B needs A");

/* ---------- 16 + 17 + 21. lock order and lock timeout (source checks; PGlite has one connection) ---------- */
{
  const def = async (fn) => (await one(`SELECT pg_get_functiondef('${fn}'::regprocedure) AS d`)).d;
  const move = await def("public.admin_move_to_ready(uuid,numeric,text)");
  assert.ok(move.indexOf("FROM public.orders WHERE id = it.order_id FOR UPDATE") < move.indexOf("FROM public.catalog_products WHERE id = it.product_id FOR UPDATE"), "order before product");
  const place = await def("public.place_marketplace_order(text,uuid,text,text,text,text,jsonb,text,text,jsonb)");
  assert.ok(place.indexOf("PERFORM private.lock_products(") > 0 && place.indexOf("PERFORM private.lock_products(") < place.indexOf("FOR line IN SELECT value FROM jsonb_array_elements(_items)"), "cart locked in id order first");
  for (const file of [MIGRATION_A, MIGRATION_B]) assert.match(sqlOf(file), /^BEGIN;\s+SET LOCAL lock_timeout = '5s';/m, `${file} lock_timeout`);
}
ok("16/17/21 lock order and timeout");

/* ---------- 20. a reading in grams never makes a hold the total can't carry ---------- */
await begin();
{
  await pull({ "BR-CLK": 50, "BR-HBL": 12.344 });               // no lot yet: the old path keeps 12.34 at Hubli
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 12.344 } });
  assert.equal(await held("BR-HBL"), 0, "0.004 kg is not held at opening");
  await pull({ "BR-CLK": 50, "BR-HBL": 12.344 });
  await pull({ "BR-CLK": 50, "BR-HBL": 12.345 });
  assert.deepEqual([await held("BR-HBL"), (await pair("BR-HBL")).total], [0, 12.34]);
  await adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 12)", [SUGAR]);   // not refused by 0.004 "held"
}
await rollback();
ok("20 readings at the total's precision");

/* ---------- 36. an unpaid checkout hears "pay to complete", not "invoice and QR follow" ---------- */
await begin();
{
  const lot = await createLot({ qty: 100, zoho: { "BR-CLK": 0, "BR-HBL": 0 } });
  const ck = await checkout(C1, [[SUGAR, 5, true]]);
  assert.equal((await orderRow(ck.order_no)).order_status, "Awaiting Payment");
  await pull({ "BR-CLK": 100, "BR-HBL": 0 });
  const { bill: B, line } = bill("B-N1", 100);
  await receive("BR-CLK", B, [{ ...line, action: "match", match_batch_id: lot.batch_id }], { "BR-CLK": 100, "BR-HBL": 0 });
  const msgs = (await notes("Your goods have arrived")).filter((x) => x.order_no === ck.order_no).map((x) => x.message);
  assert.deepEqual(msgs, [`${ck.order_no}: Sugar S1 has arrived. Pay to complete your order.`]);
}
await rollback();
ok("36 unpaid checkout wording");

/* ---------- 38. the channel partner sees which of their orders wait for goods ---------- */
await begin();
{
  await createLot({ qty: 100, date: istDay(6), zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  const o = await order(C1, [[SUGAR, 60, true]]);
  const rows = await as(PARTNER_USER, "authenticated", () => q("SELECT * FROM public.partner_orders_waiting_goods()"));
  assert.deepEqual(rows.map((x) => [x.order_no, n(x.waiting), x.expected_date]), [[o.order_no, 10, istDay(6)]]);
  await refuses(() => as(C3, "authenticated", () => q("SELECT * FROM public.partner_orders_waiting_goods()")), /^Only an active channel partner can see these orders$/, "customer");
}
await rollback();
ok("38 partner waiting goods");

/* ---------- 3. readings wait for a transfer the website has not finished (it was counted twice) ---------- */
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  // 20 bags sent from a Challakere batch to Hubli: Zoho may show them received before the website finishes the transfer.
  const tr = (await q(`INSERT INTO public.batch_transfers (transfer_no, kind, from_branch_id, from_location_id, to_branch_id, to_location_id, parent_batch_id, product_id, quantity)
    SELECT 'GB-TR-R3', 'split', 'BR-CLK', 'LOC-CLK', 'BR-HBL', 'LOC-HBL', id, product_id, 20 FROM public.batches WHERE batch_code = 'CLK-011126-01' RETURNING id`))[0].id;
  // Hubli staff count 20 (as Zoho shows): refused, before anything is held (it used to hold 20 there for good).
  await refuses(() => serverOne("SELECT public.record_stock_count('BR-HBL', $1, 20, 20, 0, 20, 'daily_count', '', false, '', NULL, 'Hanu', NULL, 20, '{}'::uuid[])", [SUGAR]),
    /^A transfer of Sugar S1 at Hubli Godown is not finished in Zoho\. Count again after it is\.$/, "count");
  assert.deepEqual([...(await split("BR-HBL")), await held("BR-HBL")], [0, 0, 0, 0]);
  // So are a release of held stock there and a Receive purchase of the product (their readings would see it too).
  await refuses(() => serverOne("SELECT public.release_preorder_hold('BR-HBL', $1, 1, 'checking the transfer guard', '[]'::jsonb, 20, '{}'::uuid[], $2::timestamptz, $3, 'TEST Admin')", [SUGAR, now(), ADMIN]),
    /^A transfer of Sugar S1 between godowns is not finished\. Finish or cancel it first\.$/, "release");
  const { bill: B, line } = bill("B-R3", 10);
  await refuses(() => receive("BR-CLK", B, [{ ...line, action: "new", not_preorder_note: "another purchase of sugar" }], { "BR-CLK": 60, "BR-HBL": 20 }),
    /^A transfer of Sugar S1 between godowns is not finished\. Finish or cancel it first\.$/, "receive");
  // A count at a godown the transfer does not touch is fine; once the transfer is done, Hubli counts too.
  await q("UPDATE public.batch_transfers SET status = 'cancelled' WHERE id = $1", [tr]);
  await serverOne("SELECT public.record_stock_count('BR-HBL', $1, 0, 0, 0, 0, 'daily_count', '', false, '', NULL, 'Hanu', NULL, 0, '{}'::uuid[])", [SUGAR]);
  assert.deepEqual([...(await split("BR-HBL")), await held("BR-HBL")], [0, 0, 0, 0]);
}
await rollback();
ok("3 readings wait for an unfinished transfer");

/* ---------- 32. a short bill's rest needs a date from today on; a transfer finishing the match later is not refused ---------- */
await begin();
{
  const made = await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await q("UPDATE public.batches SET expected_date = $2::date WHERE id = $1", [made.batch_id, istDay(-3)]);    // running late
  const lot = (await q("SELECT * FROM public.batches WHERE id = $1", [made.batch_id]))[0];
  const { bill: B, line } = bill("B-L1", 150);
  const check = (transfer) => one("SELECT private.match_line_check('BR-CLK', b, $2::jsonb, $3::jsonb, 'coming', NULL, $4) AS r FROM public.batches b WHERE b.id = $1",
    [lot.id, JSON.stringify(B), JSON.stringify(line), transfer]);
  await refuses(() => check(null), /^Choose when the rest should arrive$/, "asked now with the lot's past date");
  await check(1);                                                                                         // finished by transfer 1 later
}
await rollback();
ok("32 rest date");

/* ---------- 14. stock typed in on the website where a lot is: refused (the old receipt dialog is off since 31 Oct) ---------- */
await begin();
{
  await createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
  await refuses(() => admin("SELECT public.admin_receive_inventory_batch('X-1', $1, 360, 2500, CURRENT_DATE, 'BR-CLK')", [SUGAR]),
    /^Record purchases in Admin > Batches > Receive purchase \(choose the godown\)\.$/, "old receipt dialog");
  // Any manual raise at the lot's godown (app.stock_manual, as a website-only receipt sets it) is refused by the routing
  // trigger; a manual change at a watched godown with no lot (Hubli) is remembered until it is in Zoho.
  const manual = (branch, delta) => guardedManual(branch, delta);
  async function guardedManual(branch, delta) {
    await q("SELECT set_config('app.branch_id', $1, true), set_config('app.stock_manual', 'on', true)", [branch]);
    // (A refusal rolls back to the savepoint, which puts the two settings back as well.)
    await q("UPDATE public.catalog_products SET payload = jsonb_set(payload, '{stock}', to_jsonb((payload->>'stock')::numeric + $2)) WHERE id = $1", [SUGAR, delta]);
    await q("SELECT set_config('app.stock_manual', 'off', true), set_config('app.branch_id', '', true)");
  }
  await refuses(() => manual("BR-CLK", 360), /^Pre-order batch CLK-[0-9-]+ is on its way to Challakere Godown\. Its bags come into stock with its Zoho bill, so don't type them in\. You can still lower this stock\.$/, "receipt at the lot");
  await manual("BR-HBL", 4);
  assert.deepEqual([...(await split("BR-HBL")), (await pair("BR-HBL")).pending,
    n((await one("SELECT pending_delta FROM public.preorder_watch WHERE branch_id = 'BR-HBL' AND product_id = $1", [SUGAR])).pending_delta)], [4, 0, 4, true, 4]);
}
await rollback();
ok("14 manual receipts where a lot is");

void files; void readFileSync; void join; void root; void admin; void db; void invoiceInZoho;
console.log("preorder review fixes OK");
