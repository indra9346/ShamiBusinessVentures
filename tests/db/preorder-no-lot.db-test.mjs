// I4 of the pre-order spec: with no pre-order batch anywhere, every function 20261114110000_preorder_batches.sql changes
// gives exactly today's results. Two PGlite databases, one without and one with the pre-order migrations (pre-orders
// switched ON in the second, so the switch alone changes nothing), run the same day of business: the pull, orders entered
// by an admin, a pay-first checkout that expires and is placed again, every release path, line edits up and down, a
// typed godown stock up and down, a batch sent to another godown with Zoho's readings, a staff count with the old
// arguments. After every step their rows must be identical. Then the rollback file puts back today's functions exactly.
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/preorder-no-lot.db-test.mjs
//
// It must end with "preorder no-lot regression OK".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, root, istDay, ADMIN, C1, C2, C3, SUGAR, OIL } from "./preorder-world.mjs";

const before = await makeWorld({ migrate: false });
const after = await makeWorld({ migrate: true });
await after.q("UPDATE public.settings SET value = value || '{\"enabled\": true}'::jsonb WHERE key = 'preorder'");

/** Everything the changed functions write, without ids, times or order numbers (those name the second). */
async function rows(w) {
  const { q } = w;
  const orderNos = (await q("SELECT order_no FROM public.orders ORDER BY created_at, order_no")).map((r) => r.order_no);
  const seq = (no) => orderNos.indexOf(no);
  return JSON.stringify({
    stock: await q("SELECT branch_id, product_id, stock::text, zoho_pending FROM public.branch_stock ORDER BY 1, 2"),
    payload: await q("SELECT id, payload->>'stock' AS stock, payload->>'sold' AS sold FROM public.catalog_products ORDER BY id"),
    batches: await q("SELECT batch_code, product_id, branch_id, quantity::text, remaining_quantity::text, sent_quantity::text, status FROM public.batches ORDER BY batch_code, branch_id"),
    allocations: (await q(`SELECT o.order_no, i.product_id, b.batch_code, a.reserved_quantity::text, a.released_quantity::text, a.unit_cost::text
      FROM public.order_item_batch_allocations a JOIN public.order_items i ON i.id = a.order_item_id JOIN public.orders o ON o.id = i.order_id
      JOIN public.batches b ON b.id = a.batch_id ORDER BY o.created_at, i.product_id, b.batch_code, a.reserved_quantity, a.released_quantity`)).map((r) => ({ ...r, order_no: seq(r.order_no) })),
    orders: (await q("SELECT order_no, order_status, payment_status, total::text, branch_id FROM public.orders ORDER BY created_at")).map((r) => ({ ...r, order_no: seq(r.order_no) })),
    items: (await q("SELECT o.order_no, i.product_id, i.qty, i.line_total::text FROM public.order_items i JOIN public.orders o ON o.id = i.order_id ORDER BY o.created_at, i.product_id, i.qty")).map((r) => ({ ...r, order_no: seq(r.order_no) })),
    adjustments: await q("SELECT b.batch_code, x.qty::text, x.reason FROM public.batch_adjustments x JOIN public.batches b ON b.id = x.batch_id ORDER BY b.batch_code, x.qty"),
    counts: await q("SELECT branch_id, product_id, counted::text, site_before::text, site_after::text FROM public.stock_counts ORDER BY counted"),
    transfers: await q("SELECT transfer_no, kind, status, quantity::text, reserved::text FROM public.batch_transfers ORDER BY transfer_no"),
  });
}
const both = async (label, fn) => {
  const a = await fn(before), b = await fn(after);
  const ra = await rows(before), rb = await rows(after);
  if (ra !== rb) {
    const ja = JSON.parse(ra), jb = JSON.parse(rb);
    for (const key of Object.keys(ja)) if (JSON.stringify(ja[key]) !== JSON.stringify(jb[key])) console.error(`${label}: ${key}
 before: ${JSON.stringify(ja[key])}
 after:  ${JSON.stringify(jb[key])}`);
  }
  assert.equal(rb, ra, `${label}: the rows differ`);
  return [a, b];
};

await both("the pull", async (w) => {
  for (const [branch, product, z] of [["BR-CLK", SUGAR, 50], ["BR-HBL", SUGAR, 7], ["BR-CLK", OIL, 30], ["BR-HBL", OIL, 9]]) {
    await w.serverOne("SELECT public.apply_zoho_branch_stock($1,$2,$3,now()) AS r", [branch, product, z]);
  }
});
const [o1a, o1b] = await both("orders entered by an admin", async (w) => [
  (await w.order(C1, [[SUGAR, 3], [OIL, 2], [SUGAR, 1]])).order_no,
  (await w.order(C3, [[SUGAR, 2], [OIL, 1]])).order_no,
  (await w.order(C1, [[OIL, 4]])).order_no,
  (await w.order(C2, [[SUGAR, 5]])).order_no,
]);
await both("refusals", async (w) => {
  await w.refuses(() => w.order(C1, [[SUGAR, 1000]]), /^A product does not have enough available stock$/, "too many");
  await w.refuses(() => w.order(C1, [[SUGAR, 40], [SUGAR, 2]]), /^A product does not have enough available stock$/, "summed");
});
const [ca, cb] = await both("a pay-first checkout", async (w) => (await w.checkout(C2, [[SUGAR, 2]])).order_no);
await both("it expires (release_payment_hold)", async (w) => {
  const no = w === before ? ca : cb;
  await w.forceStatus(no, "Awaiting Payment", { payment_hold_until: new Date(Date.now() - 60_000).toISOString() });
  await w.q("SELECT public.expire_payment_holds()");
});
await both("placed again with its payment (admin_place_ended_checkout)", async (w) => {
  const no = w === before ? ca : cb;
  await w.adminOne("SELECT public.admin_place_ended_checkout($1, 'NEFT77770001', 'NEFT', 'bank statement')", [no]);
});
await both("the customer cancels (cancel_marketplace_order)", async (w) => {
  const no = (w === before ? o1a : o1b)[2];
  await w.as(C1, "authenticated", () => w.q("SELECT public.cancel_marketplace_order($1)", [no]));
});
await both("an admin cancels (admin_cancel_order)", async (w) => {
  const no = (w === before ? o1a : o1b)[1];
  await w.adminOne("SELECT public.admin_cancel_order($1, 'TEST customer phoned', NULL, NULL)", [no]);
});
await both("void in Zoho (apply_zoho_order_cancellation)", async (w) => {
  const no = (w === before ? o1a : o1b)[3];
  await w.server("UPDATE public.orders SET zoho_salesorder_id = 'SO-V', zoho_order_status = 'void' WHERE order_no = $1", [no]);
  await w.serverOne("SELECT public.apply_zoho_order_cancellation(id) FROM public.orders WHERE order_no = $1", [no]);
});
await both("line edits up and down (admin_update_order_item)", async (w) => {
  const no = (w === before ? o1a : o1b)[0];
  const lines = await w.q("SELECT i.id, i.product_id, i.qty FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1 ORDER BY i.product_id, i.qty", [no]);
  await w.adminOne("SELECT public.admin_update_order_item($1, $2, 6, '50 kg', 2741)", [no, lines.find((l) => l.product_id === SUGAR).id]);
  await w.adminOne("SELECT public.admin_update_order_item($1, $2, 1, '850 ml', 130)", [no, lines.find((l) => l.product_id === OIL).id]);
  await w.refuses(() => w.adminOne("SELECT public.admin_update_order_item($1, $2, 900, '50 kg', 2741)", [no, lines.find((l) => l.product_id === SUGAR).id]), /not enough available stock/, "too many");
});
await both("typed godown stock (admin_set_branch_stock, record_batch_stock_change)", async (w) => {
  await w.adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 20)", [SUGAR]);
  await w.adminOne("SELECT public.admin_set_branch_stock('BR-CLK', $1, 33)", [SUGAR]);
  await w.adminOne("SELECT public.admin_set_branch_stock('BR-HBL', $1, 12)", [OIL]);
});
await both("Zoho has them; the next pull (apply_zoho_branch_stock)", async (w) => {
  await w.q("UPDATE public.branch_stock SET zoho_pending = false");
  for (const [branch, product, z] of [["BR-CLK", SUGAR, 31], ["BR-HBL", SUGAR, 7], ["BR-CLK", OIL, 27]]) {
    await w.serverOne("SELECT public.apply_zoho_branch_stock($1,$2,$3,now() + interval '1 minute') AS r", [branch, product, z]);
  }
});
await both("a batch sent to Hubli, with Zoho's readings (batch_transfer_godown)", async (w) => {
  const id = (await w.one("SELECT id FROM public.batches WHERE batch_code = 'CLK-011126-01'")).id;
  const [t] = (await w.serverOne("SELECT public.begin_batch_split($1, '[{\"branch_id\":\"BR-HBL\",\"qty\":4}]'::jsonb, $2, 'TEST Admin', NULL) AS r", [id, ADMIN])).r;
  const stock = JSON.stringify([{ branch_id: "BR-CLK", product_id: SUGAR, stock: 27 }, { branch_id: "BR-HBL", product_id: SUGAR, stock: 11 }]);
  await w.serverOne("SELECT public.finish_batch_transfer($1, 'TO-9', 'in_transit', NULL, $2::jsonb, NULL)", [t.id, stock]);
  await w.serverOne("SELECT public.finish_batch_transfer($1, 'TO-9', 'transferred', NULL, $2::jsonb, NULL)", [t.id, stock]);
});
await both("a staff count with the old arguments (record_stock_count)", async (w) => {
  await w.serverOne("SELECT public.record_stock_count('BR-HBL', $1, 10, 11, -1, 10, 'daily_count', '', false, 'ADJ-1', NULL, 'Hanu', NULL)", [SUGAR]);
});

// The rollback file puts back exactly today's functions (as live has them) on the migrated database.
const defs = async (w) => JSON.stringify(await w.q(`SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
    regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g') AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'private') AND p.proname IN ('route_stock_to_branch','allocate_order_item_batches','place_marketplace_order',
    'admin_update_order_item','admin_place_ended_checkout','record_batch_stock_change','admin_set_branch_stock','apply_zoho_branch_stock',
    'batch_transfer_godown','record_stock_count','begin_batch_split','admin_update_batch','admin_delete_batch','create_batches_from_bill',
    'begin_bill_receive','receive_bill_here','finish_batch_transfer','cancel_batch_transfer','delivery_note_gate','guard_order_mutation',
    'admin_delete_order_all_details','batch_stock_state') ORDER BY 1`));
assert.notEqual(await defs(after), await defs(before));
await after.db.exec(readFileSync(join(root, "supabase", "rollback", "20261114_preorder_rollback.sql"), "utf8"));
assert.equal(await defs(after), await defs(before), "rolled back to today's definitions");
const triggers = async (w) => JSON.stringify(await w.q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
  ('public.branch_stock'::regclass, 'public.batches'::regclass, 'public.order_item_batch_allocations'::regclass) ORDER BY 1`));
assert.equal(await triggers(after), await triggers(before), "the new triggers are gone, batches_stock_state is as before");
// Review fix: the pre-order functions that change data can't run after the rollback, and the order_items CHECK is gone
// (the old quantity edit lowers qty without preorder_qty).
for (const fn of ["public.create_incoming_batch(text,text,numeric,numeric,date,numeric,text,jsonb,text,jsonb,jsonb,jsonb,timestamp with time zone,uuid,text)",
  "public.unmatch_incoming_batch(uuid,text,jsonb,jsonb,timestamp with time zone,uuid,text)", "public.receive_bill_lines(text,jsonb,jsonb,text,jsonb,jsonb,timestamp with time zone,uuid,text)",
  "public.admin_set_preorder_settings(boolean,integer,boolean)", "public.release_preorder_hold(text,text,numeric,text,jsonb,numeric,uuid[],timestamp with time zone,uuid,text)",
  "public.admin_move_to_ready(uuid,numeric,text)", "public.preorder_push_start(text,text)"]) {
  for (const role of ["authenticated", "service_role"]) {
    assert.equal((await after.one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`)).p, false, `${role} ${fn} after the rollback`);
  }
}
assert.equal((await after.q("SELECT 1 FROM pg_constraint WHERE conname = 'order_items_preorder_qty_check'")).length, 0);
// And the old site works on it as before.
await both("after the rollback, an order", async (w) => (await w.order(C1, [[OIL, 1]])).order_no);

console.log("preorder no-lot regression OK");
