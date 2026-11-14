// Second half of preorder-batches.db-test.mjs (run from there, on the same database): releases, readings, the transfer
// path, guards, the admin actions on a lot, edge cases and access. Not a test on its own.
import assert from "node:assert/strict";
import { istDay, ADMIN, C1, C2, C3, PARTNER_USER, STAFF_USER, HBL_STAFF, SUGAR } from "./preorder-world.mjs";

const w = globalThis.__w;
const { db, q, one, as, adminOne, server, serverOne, refuses, n, pair, watch, payloadStock, batch, now, order, checkout,
  orderRow, itemsOf, allocsOf, invoiceInZoho, forceStatus, createLot, pull, receive, events, notes, setPreorder } = w;
const split = async (branch) => { const p = await pair(branch); return [p.ready, p.arriving, p.total]; };
const lotOf = async (code) => { const b = await batch(code); return [b.stage, n(b.quantity), n(b.remaining_quantity)]; };
const waitingOf = async (no) => n((await serverOne("SELECT public.order_waiting_goods(id) AS r FROM public.orders WHERE order_no = $1", [no])).r.waiting);
const itemId = async (no) => (await one("SELECT i.id FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1 ORDER BY i.id LIMIT 1", [no])).id;
const lid = async (code) => (await batch(code)).id;
let r;

/* ---------- 6. Hubli: 5 ready, a lot of 100 (the watch opens again at both godowns) ---------- */
await pull({ "BR-CLK": 340, "BR-HBL": 5 });
assert.deepEqual(await split("BR-HBL"), [5, 0, 5]);
const H = await createLot({ branch: "BR-HBL", qty: 100, cost: 2500, date: istDay(5), zoho: { "BR-CLK": 340, "BR-HBL": 5 } });
const HCODE = H.batch_code;
assert.match(HCODE, /^HBL-\d{6}-\d{2}$/);
assert.deepEqual(await split("BR-HBL"), [5, 100, 105]);
assert.deepEqual(await split("BR-CLK"), [340, 0, 340], "Challakere is watched too, with nothing arriving");
assert.deepEqual([(await watch("BR-CLK")).held, (await watch("BR-HBL")).held], [0, 0]);

/* ---------- 7. every release path gives back exactly what it took (ready to ready, arriving to the lot) ---------- */
const state = async () => JSON.stringify([await split("BR-HBL"), await lotOf(HCODE), await payloadStock()]);
const base = await state();
const take8 = async () => {
  const o = await order(C3, [[SUGAR, 8, true]]);
  assert.deepEqual(await split("BR-HBL"), [0, 97, 97]);
  assert.deepEqual(await allocsOf(o.order_no), [[HCODE, 3, 2500]], "5 ready (no batch at Hubli), 3 from the lot");
  return o.order_no;
};
// 1. release_payment_hold (an unpaid checkout expires).
const ck = await checkout(C3, [[SUGAR, 8, true]]);
assert.equal((await orderRow(ck.order_no)).order_status, "Awaiting Payment");
assert.deepEqual(await split("BR-HBL"), [0, 97, 97]);
await forceStatus(ck.order_no, "Awaiting Payment", { payment_hold_until: new Date(Date.now() - 60_000).toISOString() });
await q("SELECT public.expire_payment_holds()");
assert.equal((await orderRow(ck.order_no)).order_status, "Payment Expired");
assert.equal(await state(), base, "release_payment_hold");
// 2. cancel_marketplace_order (the customer cancels).
let no = await take8();
await as(C3, "authenticated", () => q("SELECT public.cancel_marketplace_order($1)", [no]));
assert.equal(await state(), base, "cancel_marketplace_order");
// 3. admin_cancel_order.
no = await take8();
await adminOne("SELECT public.admin_cancel_order($1, 'TEST customer phoned', NULL, NULL)", [no]);
assert.equal(await state(), base, "admin_cancel_order");
// 4. apply_zoho_order_cancellation (void in Zoho).
no = await take8();
await server("UPDATE public.orders SET zoho_salesorder_id = 'SO-V', zoho_order_status = 'void' WHERE order_no = $1", [no]);
assert.equal((await serverOne("SELECT public.apply_zoho_order_cancellation(id) AS r FROM public.orders WHERE order_no = $1", [no])).r, "cancelled");
assert.equal(await state(), base, "apply_zoho_order_cancellation");
// 5. The admin's quantity edit: down gives back the newest units first (the lot's), up takes ready units only.
no = await take8();
await adminOne("SELECT public.admin_update_order_item($1, $2, 4, '50 kg', 2741)", [no, await itemId(no)]);
assert.deepEqual(await split("BR-HBL"), [1, 100, 101], "3 back to the lot, 1 to ready");
assert.deepEqual([n((await itemsOf(no))[0].preorder_qty), n((await itemsOf(no))[0].qty)], [3, 4]);
await refuses(async () => adminOne("SELECT public.admin_update_order_item($1, $2, 6, '50 kg', 2741)", [no, await itemId(no)]), /^There is not enough available stock for this quantity$/, "admin can't take arriving units");
await adminOne("SELECT public.admin_update_order_item($1, $2, 5, '50 kg', 2741)", [no, await itemId(no)]);
assert.deepEqual(await split("BR-HBL"), [0, 100, 100]);
await adminOne("SELECT public.admin_cancel_order($1, 'TEST done with it', NULL, NULL)", [no]);
assert.equal(await state(), base, "quantity edit then cancel");

/* ---------- 8. readings: snapshot union, a newer reading, a waiting website edit and its push ---------- */
// An invoice made between the snapshot and the read is still subtracted (errs low); the next pull is exact.
const two = (await order(C3, [[SUGAR, 2]])).order_no;               // ready only
assert.deepEqual(await split("BR-HBL"), [3, 100, 103]);
await pull({ "BR-CLK": 340, "BR-HBL": 3 }, { between: async () => invoiceInZoho(two) });  // Zoho took the 2 out
assert.deepEqual(await split("BR-HBL"), [1, 100, 101], "the 2 are subtracted twice once: never above the truth");
// Review fix (held leak): the 2 were counted only through the snapshot (suspect). They have left W since, so at the next
// pull they come back unheld: the total is the truth again and nothing is held (before the fix, 2 stayed held until the
// last Sugar lot closed, and head office could not edit Hubli's stock).
r = await pull({ "BR-CLK": 340, "BR-HBL": 3 });
assert.deepEqual([...(await split("BR-HBL")), (await watch("BR-HBL")).held, n(r["BR-HBL"].healed)], [3, 100, 103, 0, 2]);
assert.equal((await notes("Zoho shows stock the website can't explain")).filter((x) => /Hubli/.test(x.message)).length, 0, "no false alert");
// A real rise the website can't explain (a credit note in Zoho) is held; an admin who knows releases it.
await pull({ "BR-CLK": 340, "BR-HBL": 5 });
assert.deepEqual([...(await split("BR-HBL")), (await watch("BR-HBL")).held], [3, 100, 103, 2]);
await serverOne("SELECT public.release_preorder_hold('BR-HBL', $1, 2, 'credit note CN-2 from a customer return', '[]'::jsonb, 5, '{}'::uuid[], $2::timestamptz, $3, 'TEST Admin')", [SUGAR, now(), ADMIN]);
assert.deepEqual([...(await split("BR-HBL")), (await watch("BR-HBL")).held], [5, 100, 105, 0]);
await pull({ "BR-CLK": 340, "BR-HBL": 3 });                      // and 2 sold at the Hubli counter
assert.deepEqual([...(await split("BR-HBL")), (await watch("BR-HBL")).held], [3, 100, 103, 0]);
// A reading older than the watch's last change is skipped.
r = (await serverOne("SELECT public.apply_preorder_reading('BR-HBL', $1, 99, $2::timestamptz, '{}'::uuid[]) AS r", [SUGAR, new Date(Date.now() - 3600_000).toISOString()])).r;
assert.deepEqual(r, { skipped: "newer" });
// Typing a higher ready stock is refused while the lot is on its way (I3); lowering it is allowed.
await refuses(() => adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 4)", [SUGAR]),
  new RegExp(`^Pre-order batch ${HCODE} is on its way to Hubli Godown\\. Its bags come into stock with its Zoho bill, so don't type them in\\. You can still lower this stock\\.$`), "I3 increase");
await adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 2)", [SUGAR]);
assert.deepEqual([...(await split("BR-HBL")), (await pair("BR-HBL")).pending], [2, 100, 102, true], "typed ready stock + arriving = total");
// Review fix: the waiting edit no longer stops the pull's reading (it stays in the total), so Zoho's falls are seen.
r = await pull({ "BR-CLK": 340, "BR-HBL": 3 });
assert.deepEqual([n(r["BR-HBL"].T), n(r["BR-HBL"].held)], [102, 0]);
// The push: the edit itself (-1) goes to Zoho, then it waits no more; the total does not move.
const plan = (await serverOne("SELECT public.preorder_push_plan('BR-HBL', $1, 3, '{}'::uuid[]) AS r", [SUGAR])).r;
assert.deepEqual([plan.blocked, n(plan.delta)], [false, -1]);
let st = (await serverOne("SELECT public.preorder_push_start('BR-HBL', $1) AS r", [SUGAR])).r;
assert.deepEqual([st.blocked, n(st.delta)], [false, -1]);
// While it is on its way, readings of that godown wait (Zoho may or may not show it yet).
assert.deepEqual((await pull({ "BR-CLK": 340, "BR-HBL": 2 }))["BR-HBL"], { skipped: "pushing" });
await refuses(() => serverOne("SELECT public.release_preorder_hold('BR-HBL', $1, 1, 'checking the in-flight guard', '[]'::jsonb, 2, '{}'::uuid[], $2::timestamptz, $3, 'TEST Admin')", [SUGAR, now(), ADMIN]),
  /^A stock edit for Sugar S1 at Hubli Godown is being sent to Zoho right now\. Try again in a minute\.$/, "reading while pushing");
// An admin edit while it is on its way stays waiting (review fix: it used to be cleared and become a false hold).
await adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 1)", [SUGAR]);
st = (await serverOne("SELECT public.preorder_push_finish('BR-HBL', $1, true) AS r", [SUGAR])).r;
assert.deepEqual([n(st.sent), n(st.pending)], [-1, -1]);
assert.deepEqual(await pair("BR-HBL").then((p) => [p.ready, p.arriving, p.total, p.pending]), [1, 100, 101, true]);
r = await pull({ "BR-CLK": 340, "BR-HBL": 2 });                   // Zoho took the -1 (3 -> 2): no rise, nothing held
assert.deepEqual([n(r["BR-HBL"].T), n(r["BR-HBL"].held)], [101, 0]);
st = (await serverOne("SELECT public.preorder_push_start('BR-HBL', $1) AS r", [SUGAR])).r;
assert.equal(n(st.delta), -1);
await serverOne("SELECT public.preorder_push_finish('BR-HBL', $1, false) AS r", [SUGAR]);   // Zoho refused: still waiting
assert.equal((await pair("BR-HBL")).pending, true);
st = (await serverOne("SELECT public.preorder_push_start('BR-HBL', $1) AS r", [SUGAR])).r;
await serverOne("SELECT public.preorder_push_finish('BR-HBL', $1, true) AS r", [SUGAR]);
r = await pull({ "BR-CLK": 340, "BR-HBL": 1 });
assert.deepEqual(await pair("BR-HBL").then((p) => [p.ready, p.arriving, p.total, p.pending]), [1, 100, 101, false]);
// Back to 2 ready for what follows: a Zoho receipt of 1 (unexplained, held) released by an admin.
await pull({ "BR-CLK": 340, "BR-HBL": 2 });
await serverOne("SELECT public.release_preorder_hold('BR-HBL', $1, 1, 'credit note CN-3 from a customer return', '[]'::jsonb, 2, '{}'::uuid[], $2::timestamptz, $3, 'TEST Admin')", [SUGAR, now(), ADMIN]);
assert.deepEqual(await pair("BR-HBL").then((p) => [p.ready, p.arriving, p.total, p.pending]), [2, 100, 102, false]);

/* ---------- 9. a bill typed at the wrong place: held there; received through a transfer (L6) ---------- */
// The Hubli lot's bill (100) is typed at Challakere: Challakere holds the 100.
await pull({ "BR-CLK": 440, "BR-HBL": 2 });
assert.deepEqual([(await watch("BR-CLK")).held, ...(await split("BR-CLK"))], [100, 340, 0, 340]);
await refuses(() => adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 330)", [SUGAR]),
  /^Zoho shows 100 more Sugar S1 at Challakere Godown than the website counts\. Match its bill or explain it first\.$/, "held: no edits");
const push = (await serverOne("SELECT public.preorder_push_plan('BR-CLK', $1, 440, '{}'::uuid[]) AS r", [SUGAR])).r;
assert.deepEqual([push.blocked, push.message], [true, "Zoho shows 100 unexplained Sugar S1 at Challakere Godown; the stock edit waits until it is matched or explained."]);
const HB = { bill_id: "B-HB1", bill_number: "HB1", vendor_name: "JAYESH TRADERS", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(), modified: "m1", total: 265388, status: "open" };
const hLine = { line_id: "HL-1", product_id: SUGAR, zoho_item_id: "I-SUGAR", name: "Sugar S1", unit: "pcs", qty: 100, unit_ex_gst: 2527.5, unit_inc_gst: 2653.88, action: "match", match_batch_id: await lid(HCODE) };
const beginReceive = () => serverOne("SELECT public.begin_bill_receive('BR-HBL','LOC-CLK','Challakere',$1::jsonb,$2::jsonb,'ex_gst',$3,'TEST Admin') AS r", [JSON.stringify(HB), JSON.stringify([hLine]), ADMIN]);
let t = (await beginReceive()).r;
assert.deepEqual([(await batch(HCODE)).selling_paused, (await batch(HCODE)).paused_reason], [true, "receiving"]);
assert.deepEqual(await split("BR-HBL"), [2, 0, 102], "nothing arriving is sold while it is received");
await refuses(async () => adminOne("SELECT public.admin_update_incoming_batch($1, 120, NULL, NULL, NULL, NULL, NULL, NULL, 'x')", [await lid(HCODE)]),
  new RegExp(`^Batch ${HCODE} is being received from bill HB1; wait for that to finish$`), "edit while receiving");
// Cancelling the transfer resumes selling.
await serverOne("SELECT public.cancel_batch_transfer($1, 'TEST Zoho refused', $2, NULL, NULL)", [t.id, ADMIN]);
assert.deepEqual([(await batch(HCODE)).selling_paused, (await batch(HCODE)).paused_reason], [false, ""]);
assert.deepEqual(await split("BR-HBL"), [2, 100, 102]);
t = (await beginReceive()).r;
// Zoho moved it: Challakere 340 (the 100 left), Hubli 102. Finishing matches the lot at Hubli; Hubli's e = the 100 moved.
const stock = [{ branch_id: "BR-CLK", product_id: SUGAR, stock: 340, waiting: [] }, { branch_id: "BR-HBL", product_id: SUGAR, stock: 102, waiting: [] }];
r = (await serverOne("SELECT public.finish_batch_transfer($1, 'TO-1', 'transferred', NULL, $2::jsonb, NULL) AS r", [t.id, JSON.stringify(stock)])).r;
assert.equal(r.status, "done");
assert.deepEqual([...(await lotOf(HCODE)), String((await batch(HCODE)).transfer_id) === String(t.id)], ["received", 100, 100, true]);
assert.deepEqual(await split("BR-HBL"), [102, 0, 102], "the bags arrived and count once");
// The last lot closed: the watch closes; Challakere's phantom hold of 100 is counted as stock, with an alert.
assert.equal(await watch("BR-CLK"), null);
assert.deepEqual(await split("BR-CLK"), [340, 0, 340]);
assert.match((await notes("Held stock now counts")).at(-1).message, /^When the last pre-order of Sugar S1 closed, Zoho still showed 100 at Challakere Godown that the website could not explain; it now counts as stock\. Check Zoho for a duplicate bill\.$/);

/* ---------- 10. nothing leaves before it arrives (I5) ---------- */
const L = (await createLot({ branch: "BR-HBL", qty: 50, cost: 2500, date: istDay(3), zoho: { "BR-CLK": 340, "BR-HBL": 102 } })).batch_code;
const Lid = await lid(L);
const big = (await order(C3, [[SUGAR, 110, true]])).order_no;       // 102 ready + 8 arriving
assert.deepEqual(await allocsOf(big), [[HCODE, 100, 2527.5], [L, 8, 2500]], "the matched batch first, then the lot (2 unbatched)");
assert.equal(await waitingOf(big), 8);
await adminOne("SELECT public.admin_confirm_manual_payment($1, (SELECT total FROM public.orders WHERE order_no = $1), 'NEFT00000002', 'NEFT')", [big]);
await adminOne("SELECT public.admin_update_order_status($1, 'Accepted')", [big]);   // Accepted stays allowed
assert.equal((await orderRow(big)).order_status, "Accepted");
const notArrived = new RegExp(`^Order ${big} is waiting for goods: ${L} has not arrived \\(expected \\d{2} [A-Z][a-z]{2} \\d{4}\\)\\. It can be packed or handed over once its bill is matched\\.$`);
await refuses(() => adminOne("SELECT public.admin_update_order_status($1, 'Packed')", [big]), notArrived, "admin Packed");
await refuses(() => server("UPDATE public.orders SET order_status = 'Packed' WHERE order_no = $1", [big]), notArrived, "server Packed");
await refuses(async () => {
  await db.query("UPDATE auth.cur SET uid = $1", [PARTNER_USER]);
  await q("SELECT set_config('app.delivery_handover', 'on', false)");
  try { await q("UPDATE public.orders SET order_status = 'Delivered' WHERE order_no = $1", [big]); }
  finally { await q("SELECT set_config('app.delivery_handover', 'off', false)"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}, notArrived, "a hand-over scan");
const gate = (await one("SELECT private.delivery_note_gate(id, '{\"read\":true}'::jsonb) AS g FROM public.orders WHERE order_no = $1", [big])).g;
assert.deepEqual([gate.code, gate.allowed, n(gate.waiting), gate.expected_date, gate.waiting_batches], ["not_arrived", false, 8, istDay(3), [L]]);
await refuses(() => adminOne("SELECT public.admin_delete_order_all_details($1, 'TEST cleanup')", [big]),
  new RegExp(`^Order ${big} is waiting for bags of batch ${L}\\. Cancel it \\(with refund\\) first\\.$`), "delete");
// Zoho is the record: a package from Zoho is applied, and the admins are told.
await q("SELECT set_config('app.zoho_inbound', 'on', false)");
await q("UPDATE public.orders SET order_status = 'Packed' WHERE order_no = $1", [big]);
await q("SELECT set_config('app.zoho_inbound', 'off', false)");
assert.equal((await orderRow(big)).order_status, "Packed");
assert.equal((await notes("Order moved on in Zoho before its goods arrived")).at(-1).message, `Order ${big} was marked Packed in Zoho before batch ${L} was matched.`);
// The lot can't be sent on, edited as a normal batch or deleted.
await refuses(() => serverOne("SELECT public.begin_batch_split($1, '[{\"branch_id\":\"BR-CLK\",\"qty\":1}]'::jsonb, $2, 'x', NULL)", [Lid, ADMIN]),
  new RegExp(`^Batch ${L} has not arrived yet\\. Send it to other godowns after it is matched to its bill\\.$`), "split");
await refuses(() => adminOne("SELECT public.admin_update_batch($1, 1, '', '', '', NULL, NULL)", [Lid]), new RegExp(`^Edit pre-order batch ${L} instead$`), "edit");
await refuses(() => adminOne("SELECT public.admin_delete_batch($1)", [Lid]), new RegExp(`^Cancel pre-order batch ${L} instead$`), "delete batch");
// A staff count of a watched product needs Zoho's number after it.
await refuses(() => serverOne("SELECT public.record_stock_count('BR-HBL', $1, 0, 0, 0, 0, 'daily_count', '', false, '', NULL, 'x', NULL)", [SUGAR]),
  /^Sugar S1 has a pre-order batch, so this count needs Zoho's stock after it\. Count again\.$/, "count without Zoho");

/* ---------- 11. the admin's actions on a lot: edit (L2), pause (L3), hold release, move to ready, join (L7), cancel (L8) ---------- */
await refuses(() => adminOne("SELECT public.admin_update_incoming_batch($1, 7, NULL, NULL, NULL, NULL, NULL, NULL, 'x')", [Lid]),
  new RegExp(`^8 units are already sold or held on batch ${L}; the expected quantity can't go below that$`), "below sold");
await refuses(() => adminOne("SELECT public.admin_update_incoming_batch($1, NULL, $2::date, NULL, NULL, NULL, NULL, NULL, 'x')", [Lid, istDay(-1)]),
  /^The expected date must be between today and 180 days ahead$/, "date");
await refuses(() => adminOne("SELECT public.admin_update_incoming_batch($1, NULL, NULL, NULL, 51, NULL, NULL, NULL, 'x')", [Lid]), /^Hold back must be between 0 and the expected quantity$/, "hold");
const hblBefore = await split("BR-HBL");
await adminOne("SELECT public.admin_update_incoming_batch($1, 60, $2::date, 2550, NULL, NULL, NULL, NULL, 'supplier sends more')", [Lid, istDay(9)]);
assert.deepEqual(await split("BR-HBL"), [hblBefore[0], hblBefore[1] + 10, hblBefore[2] + 10]);
assert.deepEqual([n((await batch(L)).quantity), n((await batch(L)).remaining_quantity), n((await batch(L)).est_unit_cost_ex_gst), n((await batch(L)).est_unit_cost_inc_gst)], [60, 52, 2550, 2677.5]);
assert.deepEqual(await allocsOf(big), [[HCODE, 100, 2527.5], [L, 8, 2550]], "sales take the new estimate");
assert.match((await notes("Arrival date changed")).at(-1).message, new RegExp(`^${big}: Sugar S1 is now expected by \\d{2} [A-Z][a-z]{2} \\d{4}\\.$`));
// L3: pause, hold back, resume.
await adminOne("SELECT public.admin_update_incoming_batch($1, NULL, NULL, NULL, NULL, true, NULL, NULL, 'stop for now')", [Lid]);
assert.equal((await pair("BR-HBL")).arriving, 0);
await adminOne("SELECT public.admin_update_incoming_batch($1, NULL, NULL, NULL, 40, false, NULL, NULL, 'sell some')", [Lid]);
assert.deepEqual([(await pair("BR-HBL")).arriving, (await batch(L)).paused_reason], [12, ""], "52 left, 40 held back: 12 on sale");
await adminOne("SELECT public.admin_update_incoming_batch($1, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'all')", [Lid]);
assert.equal((await events("paused")).length + (await events("resumed")).length, 2);
// An unexplained rise (a credit note) is held; a guarded release makes it stock; then a line moves to ready stock.
const bigItem = await itemId(big);
await refuses(() => adminOne("SELECT public.admin_move_to_ready($1, 9, 'x')", [bigItem]), /^Only 8 of this line is waiting$/, "more than waits");
await refuses(() => adminOne("SELECT public.admin_move_to_ready($1, 3, 'x')", [bigItem]), /^Only 0 ready at Hubli Godown$/, "no ready");
await pull({ "BR-CLK": 340, "BR-HBL": 105 });
assert.deepEqual([(await watch("BR-HBL")).held, (await pair("BR-HBL")).ready], [3, 0]);
const release = (qty, note, by = ADMIN) => serverOne("SELECT public.release_preorder_hold('BR-HBL', $1, $2, $3, '[]'::jsonb, 105, '{}'::uuid[], $4::timestamptz, $5, 'TEST Admin')", [SUGAR, qty, note, now(), by]);
await refuses(() => release(3, "credit"), /^Say what this stock is \(at least 10 letters\)$/, "short note");
await refuses(() => release(4, "credit note CN-7 from a customer return"), /^Only 3 is held at Hubli Godown$/, "more than held");
await refuses(() => release(3, "credit note CN-7 from a customer return", C1), /^Only administrators can release held stock$/, "not admin");
await release(3, "credit note CN-7 from a customer return");
assert.deepEqual([(await watch("BR-HBL")).held, (await pair("BR-HBL")).ready], [0, 3]);
r = (await adminOne("SELECT public.admin_move_to_ready($1, 3, 'serve from the credit note') AS r", [bigItem])).r;
assert.deepEqual([n(r.moved), n(r.still_waiting)], [3, 5]);
assert.deepEqual(await split("BR-HBL"), [0, 55, 55], "total unchanged; 3 back on the lot");
assert.equal(await waitingOf(big), 5);
// Join (L7): a second lot at Hubli takes orders, then goes into the first; its expenses go with it.
const L2 = (await createLot({ branch: "BR-HBL", qty: 20, cost: 2600, date: istDay(12), zoho: { "BR-CLK": 340, "BR-HBL": 105 } })).batch_code;
assert.deepEqual((await pair("BR-HBL")).detail, [{ by: istDay(9), qty: 55 }, { by: istDay(12), qty: 20 }], "sold by expected date");
const o3 = (await order(C3, [[SUGAR, 60, true]])).order_no;  // 55 from L, 5 from L2
assert.deepEqual(await allocsOf(o3), [[L, 55, 2550], [L2, 5, 2600]]);
const doc = (await serverOne(`SELECT public.save_cost_document('{"source":"expense","zoho_id":"E-1","doc_number":"EXP-1","doc_date":"${istDay(0)}","amount_before_gst":900,"gst_amount":0}'::jsonb) AS id`)).id;
await serverOne("SELECT public.tag_batch_costs($1, $2::jsonb, false, $3, 'TEST Admin')", [doc, JSON.stringify([{ batch_id: Lid, amount: 600, method: "bags" }, { batch_id: await lid(L2), amount: 300, method: "bags" }]), ADMIN]);
await refuses(() => adminOne("SELECT public.admin_join_incoming_batches($1, $1, 'same')", [Lid]), /^Choose two different pre-order batches$/, "same");
await refuses(async () => adminOne("SELECT public.admin_join_incoming_batches($1, $2, 'x')", [Lid, await lid(L2)]), /^Say why the batches are joined$/, "note");
const totalBefore = (await pair("BR-HBL")).total;
await adminOne("SELECT public.admin_join_incoming_batches($1, $2, 'one bill line for both')", [Lid, await lid(L2)]);
assert.deepEqual(await lotOf(L), ["incoming", 80, 15], "60 + 20 expected, 60 + 5 sold");
assert.deepEqual(await lotOf(L2), ["cancelled", 0, 0]);
assert.equal((await pair("BR-HBL")).total, totalBefore, "T unchanged");
assert.deepEqual(await allocsOf(o3), [[L, 60, 2550]]);
assert.deepEqual((await q("SELECT amount FROM public.batch_cost_tags WHERE document_id = $1", [doc])).map((x) => n(x.amount)), [900], "tags add up on the lot");
// Cancel (L8): refused while orders wait, with expenses, without a reason; then the total falls by its quantity.
await refuses(() => adminOne("SELECT public.admin_cancel_incoming_batch($1, 'supplier cancelled')", [Lid]),
  new RegExp(`^Orders still wait for 65 units of batch ${L}\\. Cancel and refund them, or move them to ready stock, first\\.$`), "waiting orders");
const L3 = (await createLot({ branch: "BR-CLK", qty: 30, cost: 2500, date: istDay(2), zoho: { "BR-CLK": 340, "BR-HBL": 105 } })).batch_code;
await serverOne("SELECT public.untag_batch_costs($1, $2, 'TEST Admin')", [doc, ADMIN]);
await serverOne("SELECT public.tag_batch_costs($1, $2::jsonb, false, $3, 'TEST Admin')", [doc, JSON.stringify([{ batch_id: await lid(L3), amount: 100, method: "amount" }]), ADMIN]);
await refuses(async () => adminOne("SELECT public.admin_cancel_incoming_batch($1, 'supplier cancelled')", [await lid(L3)]), new RegExp(`^Expenses are tagged to batch ${L3}; move or remove them first$`), "tags");
await serverOne("SELECT public.untag_batch_costs($1, $2, 'TEST Admin')", [doc, ADMIN]);
await refuses(async () => adminOne("SELECT public.admin_cancel_incoming_batch($1, 'no')", [await lid(L3)]), /^Say why the pre-order is cancelled$/, "note");
const clkBefore = await split("BR-CLK");
await adminOne("SELECT public.admin_cancel_incoming_batch($1, 'supplier cancelled the lorry')", [await lid(L3)]);
assert.deepEqual(await lotOf(L3), ["cancelled", 0, 0]);
assert.deepEqual(await split("BR-CLK"), [clkBefore[0], 0, clkBefore[2] - 30]);
// L10: a cancelled lot can be deleted; its audit rows stay.
await adminOne("SELECT public.admin_delete_batch($1)", [await lid(L3)]);
assert.equal(await batch(L3), undefined);
assert.ok((await q("SELECT 1 FROM public.batch_lot_events WHERE batch_id IS NULL AND detail->>'batch_code' = $1", [L3])).length > 0);

/* ---------- 12. matching the joined lot, and undoing it (L9) ---------- */
await pull({ "BR-CLK": 340, "BR-HBL": 185 });
assert.equal((await watch("BR-HBL")).held, 80);
const JB = { bill_id: "B-J1", bill_number: "J1", vendor_name: "JAYESH TRADERS", date: istDay(0), created_time: new Date(Date.now() + 3600_000).toISOString(), modified: "m", total: 1, status: "open" };
const jLine = { line_id: "JL-1", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 80, unit_ex_gst: 2540, unit_inc_gst: 2667, action: "match", match_batch_id: Lid };
const hblHeld = await split("BR-HBL");
await receive("BR-HBL", JB, [jLine], { "BR-CLK": 340, "BR-HBL": 185 });
assert.deepEqual(await lotOf(L), ["received", 80, 15]);
assert.equal(await watch("BR-HBL"), null, "the last lot closed");
assert.equal(await waitingOf(big), 0);
assert.equal(await waitingOf(o3), 0);
// Undo it: the lot waits again, the bill's 80 are held again, the total is what it was before the match.
const unmatch = (note = "matched the wrong bill") => serverOne("SELECT public.unmatch_incoming_batch($1, $2, $3::jsonb, '{}'::jsonb, $4::timestamptz, $5, 'TEST Admin') AS r",
  [Lid, note, JSON.stringify([{ branch_id: "BR-CLK", zoho: 340 }, { branch_id: "BR-HBL", zoho: 185 }]), now(), ADMIN]);
await refuses(() => unmatch("no"), /^Say why the match is undone$/, "note");
await unmatch();
assert.deepEqual(await lotOf(L), ["incoming", 80, 15]);
assert.deepEqual([(await batch(L)).zoho_bill_id, n((await batch(L)).unit_cost)], ["", 2550]);
assert.equal((await watch("BR-HBL")).held, 80);
assert.deepEqual(await split("BR-HBL"), hblHeld, "as before the match");
assert.equal(await waitingOf(big), 5);
// Matched again; then a new order takes from it: undoing is refused; and after 7 days.
await receive("BR-HBL", JB, [jLine], { "BR-CLK": 340, "BR-HBL": 185 });
await order(C3, [[SUGAR, 1]]);
await refuses(() => unmatch(), new RegExp(`^Batch ${L} has moved on since its match \\(new orders took from it\\), so it can't be undone\\. Correct it with the bill flags instead\\.$`), "moved on");
await q("UPDATE public.batches SET matched_at = now() - interval '8 days' WHERE id = $1", [Lid]);
await refuses(() => unmatch(), /\(matched more than 7 days ago\)/, "7 days");

/* ---------- 13. edge cases the database decides ---------- */
// (2) A bill typed before the lot, not pulled yet: held at opening; matched later it explains nothing (e = 0).
const E = await createLot({ branch: "BR-CLK", qty: 40, cost: 2500, date: istDay(4), zoho: { "BR-CLK": 380, "BR-HBL": 184 } });
assert.deepEqual(E.held_at_open, { "BR-CLK": 40, "BR-HBL": 0 });
assert.deepEqual(await split("BR-CLK"), [340, 40, 380]);
const early = { bill_id: "B-EARLY", bill_number: "EARLY1", vendor_name: "X", date: istDay(-1), created_time: new Date(Date.now() - 86400_000).toISOString(), modified: "m", total: 1, status: "open" };
r = await receive("BR-CLK", early, [{ line_id: "E1", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 40, unit_ex_gst: 2500, unit_inc_gst: 2625, action: "match", match_batch_id: E.batch_id }], { "BR-CLK": 380, "BR-HBL": 184 });
assert.equal(n(r.matched[0].explain), 0, "a bill made before the watch opened explains nothing");
assert.deepEqual(await split("BR-CLK"), [380, 0, 380], "the watch closed: Zoho less waiting");
// (17) A product that becomes batch-tracked in Zoho: no match.
const T1 = await createLot({ branch: "BR-CLK", qty: 10, cost: 2500, date: istDay(4), zoho: { "BR-CLK": 380, "BR-HBL": 184 } });
await q("UPDATE public.zoho_item_links SET track_batches = true WHERE product_id = $1", [SUGAR]);
await refuses(() => receive("BR-CLK", { ...early, bill_id: "B-T1", bill_number: "T1", created_time: now() }, [{ line_id: "T1", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 10, unit_ex_gst: 1, unit_inc_gst: 1, action: "match", match_batch_id: T1.batch_id }], { "BR-CLK": 390, "BR-HBL": 184 }),
  /^Sugar S1 has batch tracking in Zoho: its batches come from Zoho$/, "tracked");
await q("UPDATE public.zoho_item_links SET track_batches = false WHERE product_id = $1", [SUGAR]);
// (14) The expected date passes: no new pre-orders; one alert; a later date resumes selling and tells the customers.
const o5 = (await order(C1, [[SUGAR, 382, true]])).order_no;    // 380 ready + 2 arriving
await q("UPDATE public.batches SET expected_date = $2::date WHERE id = $1", [T1.batch_id, istDay(-1)]);
assert.equal((await pair("BR-CLK")).arriving, 0, "overdue: nothing on sale");
await refuses(() => order(C1, [[SUGAR, 1, true]]), /^A product does not have enough available stock$/, "overdue lot sells nothing");
assert.ok((await serverOne("SELECT public.refresh_incoming_all() AS n")).n >= 1);
await serverOne("SELECT public.refresh_incoming_all()");
const overdue = (await notes("Pre-order batch overdue")).filter((x) => x.message.includes(T1.batch_code));
assert.equal(overdue.length, 2, "once per admin, once only");
assert.match(overdue.at(-1).message, new RegExp(`^Pre-order batch ${T1.batch_code} was expected by \\d{2} [A-Z][a-z]{2} \\d{4} and has no bill\\. New pre-orders stopped; 1 orders wait\\.$`));
await adminOne("SELECT public.admin_update_incoming_batch($1, NULL, $2::date, NULL, NULL, NULL, NULL, NULL, 'lorry late')", [T1.batch_id, istDay(6)]);
assert.equal((await pair("BR-CLK")).arriving, 8);
assert.ok((await notes("Arrival date changed")).some((x) => x.order_no === o5));
// (18) Switching pre-orders off with a lot open is refused; off in the settings row: nothing arriving is offered.
await refuses(() => adminOne("SELECT public.admin_set_preorder_settings(false, 0, true)"), /^Close, match or cancel the 1 pre-order batches first$/, "off with lots");
await setPreorder({ enabled: false });
await serverOne("SELECT public.refresh_incoming_all()");
assert.equal((await pair("BR-CLK")).arriving, 0);
await setPreorder({ enabled: true });
await serverOne("SELECT public.refresh_incoming_all()");
assert.equal((await pair("BR-CLK")).arriving, 8);
// requireAck off: no tick needed.
await setPreorder({ requireAck: false });
const noTick = (await order(C2, [[SUGAR, 1]])).order_no;
assert.equal(n((await itemsOf(noTick))[0].preorder_qty), 1);
await setPreorder({ requireAck: true });
// (23) Zoho shows fewer of the bill's bags than the match explains: matched anyway, logged, never carried as credit.
const before23 = (await events("left_unseen")).length;
await receive("BR-CLK", { ...early, bill_id: "B-T2", bill_number: "T2", created_time: new Date(Date.now() + 3600_000).toISOString() },
  [{ line_id: "T2", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: 10, unit_ex_gst: 2500, unit_inc_gst: 2625, action: "match", match_batch_id: T1.batch_id }], { "BR-CLK": 385, "BR-HBL": 184 });
assert.equal((await events("left_unseen")).length, before23 + 1);
// The guarded order can be packed now that its bags are here.
await adminOne("SELECT public.admin_confirm_manual_payment($1, (SELECT total FROM public.orders WHERE order_no = $1), 'NEFT00000005', 'NEFT')", [o5]);
await adminOne("SELECT public.admin_update_order_status($1, 'Packed')", [o5]);
assert.equal((await orderRow(o5)).order_status, "Packed");

/* ---------- 14. what each person sees ---------- */
await createLot({ branch: "BR-CLK", qty: 25, cost: 2500, date: istDay(8), zoho: { "BR-CLK": 385, "BR-HBL": 184 } });
// Staff and the channel partner of the godown see what is coming (no costs); others don't.
const seen = await as(STAFF_USER, "authenticated", () => q("SELECT * FROM public.godown_incoming_lots('BR-CLK')"));
assert.deepEqual(seen.map((x) => [x.product_name, n(x.expected), n(x.sold), x.waiting_orders, x.expected_date, x.paused]), [["Sugar S1", 25, 0, 0, istDay(8), false]]);
assert.deepEqual(Object.keys(seen[0]).sort(), ["expected", "expected_date", "paused", "product_id", "product_name", "sold", "waiting_orders"]);
assert.equal((await as(PARTNER_USER, "authenticated", () => q("SELECT * FROM public.godown_incoming_lots('BR-CLK')"))).length, 1);
await refuses(() => as(HBL_STAFF, "authenticated", () => q("SELECT * FROM public.godown_incoming_lots('BR-CLK')")), /^Only this godown's staff, its channel partner or an administrator can see what is coming$/, "other godown");
await refuses(() => as(C1, "authenticated", () => q("SELECT * FROM public.godown_incoming_lots('BR-CLK')")), /can see what is coming/, "customer");
// A customer sees their own pre-ordered lines (waiting, expected, arrived); nobody else's.
const readyNow = (await pair("BR-CLK")).ready;
const mine = (await order(C2, [[SUGAR, readyNow + 1, true]])).order_no;   // the ready bags and 1 arriving
const arrivals = await as(C2, "authenticated", () => q("SELECT * FROM public.order_item_arrivals((SELECT id FROM public.orders WHERE order_no = $1))", [mine]));
assert.deepEqual(arrivals.map((x) => [n(x.preorder_qty), n(x.waiting), x.expected_date, x.arrived_on]), [[1, 1, istDay(8), null]]);
assert.equal((await as(C1, "authenticated", () => q("SELECT * FROM public.order_item_arrivals((SELECT id FROM public.orders WHERE order_no = $1))", [mine]))).length, 0);
const arrived = await as(C1, "authenticated", () => q("SELECT * FROM public.order_item_arrivals((SELECT id FROM public.orders WHERE order_no = $1))", [globalThis.__O70]));
assert.deepEqual(arrived.map((x) => [n(x.preorder_qty), n(x.waiting), x.arrived_on]), [[20, 0, istDay(0)]]);
// Anyone reads ready and arriving; nobody but admins reads the watch, the audit, the bill cache or the expenses.
const anonRow = await as(null, "anon", () => one("SELECT stock, incoming, incoming_detail FROM public.branch_stock WHERE branch_id = 'BR-CLK' AND product_id = $1", [SUGAR]));
assert.deepEqual([n(anonRow.incoming), anonRow.incoming_detail], [24, [{ by: istDay(8), qty: 24 }]]);
for (const table of ["preorder_watch", "batch_lot_events", "zoho_bill_line_cache", "zoho_cost_documents", "batch_cost_tags", "batch_cost_tag_events"]) {
  await refuses(() => as(null, "anon", () => q(`SELECT count(*) FROM public.${table}`)), /permission denied/, `anon ${table}`);
  assert.equal((await as(C1, "authenticated", () => one(`SELECT count(*)::int AS c FROM public.${table}`))).c, 0, `customer ${table}`);
  assert.equal((await as(PARTNER_USER, "authenticated", () => one(`SELECT count(*)::int AS c FROM public.${table}`))).c, 0, `partner ${table}`);
}
assert.ok((await as(ADMIN, "authenticated", () => one("SELECT count(*)::int AS c FROM public.batch_lot_events"))).c > 0);
assert.ok((await as(ADMIN, "authenticated", () => one("SELECT count(*)::int AS c FROM public.preorder_watch"))).c > 0);
await refuses(() => as(C1, "authenticated", () => q("SELECT public.order_waiting_goods(gen_random_uuid())")), /permission denied/, "customer server fn");
console.log("preorder batches: releases, readings, transfers, guards, lot actions, edge cases, access OK");
