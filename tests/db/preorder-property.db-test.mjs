// I1 of the pre-order spec, on the real functions: at every godown the website's total (free_total) is never above the
// truth, whatever happens in whatever order. Random sequences (seeded) of lots made and resized, orders with and without
// pre-order units, cancels, bills typed in Zoho (at the lot's godown or the wrong one, short, exact or over), counter
// sales, unrelated rises, hourly pulls (with an invoice between the snapshot and the read), invoices and manual confirms,
// matches (full, partial with the rest coming, short with nothing more coming, over), undoing a match, joins, cancels of
// lots, moving a line to ready stock, typed decreases and their push, staff counts, batches sent between godowns, and
// releases of held stock. After every step:
//   T <= Z - X - W + U  (+ the falls in Zoho the website has not read yet)   at every watched godown
//   (a godown without a watch follows today's rule exactly: preorder-no-lot.db-test.mjs),
// where Z is Zoho's available stock, X the lots' bags already typed into Zoho, W the units promised and not yet out of
// Zoho, U the lots' units still to come. Every lot's ledger adds up (sold + left = expected, never below 0).
// At the end every bill is matched, every lot closed, every order invoiced and a last pull taken: the website's stock is
// Zoho's exactly.
//
// One limit, from Zoho giving only its net number: a counter sale in Zoho and a rise the website has not read yet at the
// same godown within one pull interval net out (a lot's bill typed in Zoho; or the units of an order invoiced while the
// website was reading, which it subtracted twice and sees come back at the next reading), so the sale is not seen until
// the bill is matched. The generator keeps a reading between those two. The same holds the other way round (review fix,
// 14 Nov 2026): an order invoiced in Zoho just after the read but before the website wrote (counted once, rightly) may
// come back unheld at the next reading, so a rise in that interval waits for that reading too.
// Liveness (review fix): a reading race alone never leaves units held: half the pulls (raced or not) are followed by two
// quiet pulls, and at every godown that had nothing unread before the raced pull, no more is held than before it.
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> [PREORDER_SEQ=20] [PREORDER_STEPS=40] [PREORDER_SEED=1] \
//     node tests/db/preorder-property.db-test.mjs
//
// It must end with "preorder property OK".
import assert from "node:assert/strict";
import { makeWorld, istDay, ADMIN, C1, C3, SUGAR } from "./preorder-world.mjs";

const SEQ = Number(process.env.PREORDER_SEQ ?? 20), STEPS = Number(process.env.PREORDER_STEPS ?? 40), SEED0 = Number(process.env.PREORDER_SEED ?? 1);
const w = await makeWorld();
const { db, q, one, as, begin, rollback, guarded, adminOne, server, serverOne, n, pair, watch, batch, now, snapshot, order, invoiceInZoho, pull, receive } = w;
await q("UPDATE public.settings SET value = value || '{\"enabled\": true}'::jsonb WHERE key = 'preorder'");
const G = ["BR-CLK", "BR-HBL"];
const other = (g) => (g === "BR-CLK" ? "BR-HBL" : "BR-CLK");
const buyer = (g) => (g === "BR-CLK" ? C1 : C3);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ---------- first, the case that made the hold step measure against the website's own total ---------- */
// A bill typed in Zoho and an invoice of a waiting order in the same hour: Zoho's net rise is 360 - 10. The website
// holds all 360 bill bags and its total stays exact.
await begin();
await pull({ "BR-CLK": 50, "BR-HBL": 0 });
const ten = (await order(C1, [[SUGAR, 10]])).order_no;                  // 10 of the 50 ready, waiting for Zoho
await w.createLot({ qty: 360, zoho: { "BR-CLK": 50, "BR-HBL": 0 } });
assert.deepEqual([(await pair("BR-CLK")).total], [400]);
await invoiceInZoho(ten);                                                 // Zoho: 50 - 10 = 40
let r = await pull({ "BR-CLK": 40 + 360, "BR-HBL": 0 });                 // and the bill: 400
assert.deepEqual([n(r["BR-CLK"].held), n(r["BR-CLK"].T)], [360, 400], "never 410: the 10 invoiced are not new stock");
await rollback();

/* ---------- the random sequences ---------- */
const ALLOWED = [
  /does not have enough available stock/, /partly arriving later/, /Arriving stock of .* changed/, /is waiting to go to Zoho/,
  /is not waiting for/, /already sold or held/, /being received/, /has moved on since its match/, /Only .* ready at/, /Only .* of this line is waiting/,
  /Only .* is held at/, /Zoho shows .* more .* than the website counts/, /is on its way to/, /Orders still wait for/, /Choose two different/,
  /not the same product at the same godown/, /has a line with no quantity/, /Maximum purchase quantity/, /Batch .* has .* left; .* were chosen/,
  /is already at/, /Pre-order batch .* has not arrived yet|has not arrived yet/, /A transfer of .* between godowns is not finished/,
];
const allowed = (e) => ALLOWED.some((p) => p.test(e.message));

let checks = 0, events = 0, refusals = 0;
const lastRefusals = [];
const tally = {};
for (let seq = 0; seq < SEQ; seq++) {
  const seed = SEED0 + seq;
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  await begin();
  const txnNow = new Date((await one("SELECT now() AS t")).t);
  const sim = { Z: { "BR-CLK": 50, "BR-HBL": 0 }, X: { "BR-CLK": 0, "BR-HBL": 0 }, unseen: { "BR-CLK": 0, "BR-HBL": 0 },
    billRise: { "BR-CLK": 0, "BR-HBL": 0 }, fall: { "BR-CLK": 0, "BR-HBL": 0 }, lateRace: { "BR-CLK": 0, "BR-HBL": 0 },
    rose: { "BR-CLK": 0, "BR-HBL": 0 }, netted: new Set(), bills: [], lastMatched: null, billNo: 0 };
  const hist = [];
  const read = (gs = G) => { for (const g of gs) { sim.unseen[g] = 0; sim.billRise[g] = 0; sim.fall[g] = 0; sim.lateRace[g] = 0; sim.rose[g] = 0; } };
  await pull({ ...sim.Z }); read();

  const lots = () => q("SELECT * FROM public.batches WHERE stage = 'incoming' AND product_id = $1 ORDER BY batch_code", [SUGAR]);
  const liveOrders = () => q(`SELECT o.order_no, o.branch_id, i.id AS item_id, i.qty,
      COALESCE((SELECT sum(a.reserved_quantity - a.released_quantity) FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id
        WHERE a.order_item_id = i.id AND b.stage = 'incoming'), 0) AS waiting
    FROM public.orders o JOIN public.order_items i ON i.order_id = o.id
    WHERE o.order_status NOT IN ('Cancelled', 'Payment Expired') AND i.product_id = $1 ORDER BY o.created_at, o.order_no`, [SUGAR]);
  const pendingAt = async (g) => (await pair(g))?.pending === true;

  async function check(label) {
    checks++;
    if (process.env.PREORDER_DEBUG) hist.push(`  ${label} after: Z=${JSON.stringify(sim.Z)} X=${JSON.stringify(sim.X)} HBL=${JSON.stringify(await pair("BR-HBL"))}`);
    const live = await liveOrders();
    for (const g of G) {
      const p = await pair(g);
      const watched = !!(await watch(g));
      const W = live.filter((o) => o.branch_id === g && !sim.netted.has(o.order_no)).reduce((s, o) => s + o.qty, 0);
      const U = n((await one("SELECT COALESCE(sum(quantity), 0) AS u FROM public.batches WHERE stage = 'incoming' AND branch_id = $1 AND product_id = $2", [g, SUGAR])).u);
      const truth = sim.Z[g] - sim.X[g] - W + U;
      // A godown without a watch follows today's rule (ready = max(0, Zoho - waiting) at each pull, moved by orders and
      // releases in between, never below 0): preorder-no-lot.db-test.mjs shows it is exactly today's. I1 is about the
      // watched total, which is never floored.
      if (!watched) { assert.ok(p.ready >= 0 && p.arriving === 0 && p.total === p.ready, `seed ${seed} after ${label}: ${g} unwatched ${JSON.stringify(p)}`); continue; }
      const bound = truth + sim.unseen[g];
      const value = p.total;
      if (!(value <= bound + 1e-6) && process.env.PREORDER_DEBUG) console.error(JSON.stringify({ bills: sim.bills, history: hist.slice(-12),
        batches: await q("SELECT batch_code, stage, branch_id, quantity, remaining_quantity, expected_quantity FROM public.batches WHERE product_id = $1 ORDER BY batch_code", [SUGAR]),
        events: (await q("SELECT kind, branch_id, qty, note FROM public.batch_lot_events ORDER BY id")).slice(-14) }));
      assert.ok(value <= bound + 1e-6, `seed ${seed} after ${label}: ${g} ${watched ? "total" : "ready"} ${value} > truth ${bound} (Z ${sim.Z[g]} X ${sim.X[g]} W ${W} U ${U} unseen ${sim.unseen[g]})`);
      assert.ok(p.ready >= 0 && p.arriving >= 0 && p.arriving <= Math.max(0, p.total) + 1e-6, `seed ${seed} after ${label}: ${g} split ${JSON.stringify(p)}`);
    }
    for (const lot of await lots()) {
      const net = n((await one("SELECT COALESCE(sum(reserved_quantity - released_quantity), 0) AS s FROM public.order_item_batch_allocations WHERE batch_id = $1", [lot.id])).s);
      assert.ok(n(lot.remaining_quantity) >= 0 && n(lot.remaining_quantity) <= n(lot.quantity), `seed ${seed}: lot ${lot.batch_code} remaining`);
      assert.equal(n(lot.quantity) - n(lot.remaining_quantity), net, `seed ${seed} after ${label}: lot ${lot.batch_code} ledger`);
    }
  }
  /** A step: refused steps change nothing (savepoint); allowed refusals are counted, anything else fails the test. */
  async function step(label, fn) {
    events++;
    if (process.env.PREORDER_DEBUG) hist.push(`${label} before: Z=${JSON.stringify(sim.Z)} X=${JSON.stringify(sim.X)} unseen=${JSON.stringify(sim.unseen)} HBL=${JSON.stringify(await pair("BR-HBL"))} w=${JSON.stringify(await watch("BR-HBL"))}`);
    try { await guarded(fn); tally[label] = (tally[label] ?? 0) + 1; }
    catch (e) {
      if (!allowed(e)) {
        if (process.env.PREORDER_DEBUG) console.error(JSON.stringify({ sim: { Z: sim.Z, X: sim.X, bills: sim.bills, last: sim.lastMatched },
          batches: await q("SELECT batch_code, stage, quantity, remaining_quantity, expected_quantity, split_from_batch_id, id FROM public.batches WHERE product_id = $1 ORDER BY batch_code", [SUGAR]),
          events: await q("SELECT kind, batch_id, qty, detail - 'before' AS d FROM public.batch_lot_events WHERE kind IN ('matched','remainder','joined','unmatched') ORDER BY id") }, null, 1));
        throw new Error(`seed ${seed} ${label}: ${e.message}`);
      }
      refusals++;
      lastRefusals.push(`${label}: ${e.message}`);
    }
    await check(label);
  }
  const typeBill = (lot, g, qty) => {
    const bill = { lot: lot.id, lotCode: lot.batch_code, g, qty, id: `B-${seed}-${++sim.billNo}`, matched: false };
    sim.Z[g] += qty; sim.X[g] += qty; sim.billRise[g] += qty;
    sim.bills.push(bill);
    return bill;
  };
  const doPull = async ({ invoiceBetween = false, invoiceAfterRead = false } = {}) => {
    const readAt = now();
    const snap = await snapshot([SUGAR]);
    const raced = {};
    const late = {};
    if (invoiceBetween) {
      const cand = (await liveOrders()).filter((o) => n(o.waiting) === 0 && !sim.netted.has(o.order_no));
      if (cand.length) {
        const o = pick(cand); await invoiceInZoho(o.order_no); sim.Z[o.branch_id] -= o.qty; sim.netted.add(o.order_no);
        raced[o.branch_id] = (raced[o.branch_id] ?? 0) + o.qty;
      }
    }
    // Zoho's numbers as read now; an order invoiced after the read but before the website writes is counted once, rightly.
    const readZ = { ...sim.Z };
    if (invoiceAfterRead) {
      const cand = (await liveOrders()).filter((o) => n(o.waiting) === 0 && !sim.netted.has(o.order_no));
      if (cand.length) {
        const o = pick(cand); await invoiceInZoho(o.order_no); sim.Z[o.branch_id] -= o.qty; sim.netted.add(o.order_no);
        late[o.branch_id] = (late[o.branch_id] ?? 0) + o.qty;
      }
    }
    for (const g of G) {
      const watched = !!(await watch(g));
      if (await pendingAt(g)) {
        // Review fix: Zoho's reading first (the waiting edit stays in the total), then the edit itself goes to Zoho, only
        // while nothing is held there.
        if (watched) {
          const res = (await serverOne("SELECT public.apply_preorder_reading($1, $2, $3, $4::timestamptz, $5::uuid[]) AS r", [g, SUGAR, readZ[g], readAt, snap[`${g}|${SUGAR}`] ?? []])).r;
          if (res.skipped) continue;
          if (res.watched !== false) {
            read([g]);
            const st = (await serverOne("SELECT public.preorder_push_start($1, $2) AS r", [g, SUGAR])).r;
            if (st.blocked || st.skipped) continue;
            sim.Z[g] += n(st.delta);
            await serverOne("SELECT public.preorder_push_finish($1, $2, true)", [g, SUGAR]);
            continue;
          }
        }
        {
          const waiting = n((await one("SELECT private.batch_transfer_orders_waiting($1, $2) AS w", [g, SUGAR])).w);
          const site = (await pair(g)).ready;
          sim.Z[g] += site + waiting - sim.Z[g];
          await serverOne("SELECT public.apply_zoho_branch_stock($1, $2, $3, $4::timestamptz)", [g, SUGAR, Math.max(0, sim.Z[g] - waiting), readAt]);
        }
        read([g]);
        continue;
      }
      const res = (await serverOne("SELECT public.apply_preorder_reading($1, $2, $3, $4::timestamptz, $5::uuid[]) AS r", [g, SUGAR, readZ[g], readAt, snap[`${g}|${SUGAR}`] ?? []])).r;
      if (res.watched === false) {
        const waiting = n((await one("SELECT private.batch_transfer_orders_waiting($1, $2) AS w", [g, SUGAR])).w);
        await serverOne("SELECT public.apply_zoho_branch_stock($1, $2, $3, $4::timestamptz)", [g, SUGAR, Math.max(0, readZ[g] - waiting), readAt]);
      } else if (res.skipped) continue;
      read([g]);
    }
    // Subtracted twice now (in the snapshot and gone from Zoho), so the next reading sees it come back like a rise: the
    // same documented limit as a bill (no counter sale until that reading).
    for (const [g, k] of Object.entries(raced)) sim.billRise[g] += k;
    for (const [g, k] of Object.entries(late)) sim.lateRace[g] += k;
  };
  /** Liveness (review fix): a reading race alone never leaves units held. At each godown that had nothing unread before the
   * raced pull (no bill, rise or sale, no edit waiting), two quiet pulls later nothing more is held than before it. */
  const checkHealed = async (before, label) => {
    for (const [g, heldBefore] of Object.entries(before)) {
      const wa = await watch(g);
      if (!wa) continue;
      if (!(wa.held <= heldBefore + 1e-6) && process.env.PREORDER_DEBUG) console.error(JSON.stringify({ g, wa, heldBefore, history: hist.slice(-12),
        events: (await q("SELECT kind, branch_id, qty, detail - 'before' AS d FROM public.batch_lot_events WHERE branch_id = $1 ORDER BY id", [g])).slice(-8) }));
      assert.ok(wa.held <= heldBefore + 1e-6, `seed ${seed} ${label}: ${g} held ${wa.held} after a raced pull and two quiet ones, ${heldBefore} before`);
    }
  };
  const matchBill = async (bill, rest) => {
    const lot = await one("SELECT * FROM public.batches WHERE id = $1", [bill.lot]);
    const BILL = { bill_id: bill.id, bill_number: bill.id, vendor_name: "V", date: istDay(0), created_time: new Date(txnNow.getTime() + 3600_000).toISOString(), modified: "m", total: 1, status: "open" };
    const res = await receive(lot.branch_id, BILL, [{ line_id: "L", product_id: SUGAR, zoho_item_id: "I-SUGAR", qty: bill.qty, unit_ex_gst: 2500, unit_inc_gst: 2625,
      action: "match", match_batch_id: lot.id, rest }], { ...sim.Z });
    bill.matched = true;
    sim.X[bill.g] -= bill.qty;
    sim.lastMatched = bill;
    // Other bills typed for this lot belong to its remainder now; with no remainder they are ordinary stock.
    const rem = res.matched[0].remainder;
    for (const o of sim.bills.filter((x) => x.lot === bill.lot && !x.matched)) {
      if (rem) { o.lot = rem.id; o.lotCode = rem.code; } else { o.matched = true; sim.X[o.g] -= o.qty; }
    }
    bill.remainder = rem ? rem.id : null;
    for (const g of G) if (!res.readings[`${g}|${SUGAR}`]?.skipped) read([g]);
    return res;
  };

  for (let s = 0; s < STEPS; s++) {
    const kind = pick(["lot", "lot", "edit", "order", "order", "order", "cancel", "bill", "bill", "moveBill", "sale", "rise", "pull", "pull", "invoice",
      "confirm", "match", "match", "unmatch", "join", "cancelLot", "toReady", "decrease", "count", "split", "release"]);
    const allLots = await lots();
    switch (kind) {
      case "lot": {
        const g = pick(G);
        await step("lot", async () => {
          await w.createLot({ branch: g, qty: int(5, 60), holdBack: rand() < 0.2 ? int(0, 5) : 0, date: istDay(int(1, 10)), zoho: { ...sim.Z } });
          read();
        });
        break;
      }
      case "edit": {
        if (!allLots.length) break;
        const lot = pick(allLots);
        const sold = n(lot.quantity) - n(lot.remaining_quantity);
        await step("edit", () => adminOne("SELECT public.admin_update_incoming_batch($1, $2, NULL, NULL, 0, NULL, NULL, NULL, 'sim')", [lot.id, Math.max(1, sold + int(0, 20))]));
        break;
      }
      case "order": {
        const g = pick(G);
        await step("order", () => order(buyer(g), [[SUGAR, int(1, 15), rand() < 0.8]]));
        break;
      }
      case "cancel": {
        const live = (await liveOrders()).filter((o) => !sim.netted.has(o.order_no));
        if (!live.length) break;
        const o = pick(live);
        await step("cancel", () => adminOne("SELECT public.admin_cancel_order($1, 'sim cancel', NULL, NULL)", [o.order_no]));
        break;
      }
      case "bill": {
        const free = allLots.filter((l) => !sim.bills.some((b) => b.lot === l.id && !b.matched));
        if (!free.length) break;
        const lot = pick(free);
        const g = rand() < 0.85 ? lot.branch_id : other(lot.branch_id);
        if (sim.fall[g] > 0 || sim.lateRace[g] > 0) { await step("pull", () => doPull()); }
        const Q = n(lot.quantity);
        const qty = pick([Q, Q, Q, Math.max(1, Q - int(1, Math.max(1, Q - 1))), Q + int(1, 10)]);
        typeBill(lot, g, qty);
        await check("bill typed");
        break;
      }
      case "moveBill": {
        const wrong = sim.bills.filter((b) => !b.matched && allLots.some((l) => l.id === b.lot && l.branch_id !== b.g));
        if (!wrong.length) break;
        const b = pick(wrong);
        const right = allLots.find((l) => l.id === b.lot).branch_id;
        if (sim.fall[right] > 0 || sim.lateRace[right] > 0) { await step("pull", () => doPull()); }
        sim.Z[b.g] -= b.qty; sim.X[b.g] -= b.qty; sim.billRise[b.g] = Math.max(0, sim.billRise[b.g] - b.qty);
        sim.Z[right] += b.qty; sim.X[right] += b.qty; sim.billRise[right] += b.qty;
        b.g = right;
        await check("bill moved in Zoho");
        break;
      }
      case "sale": {
        const g = pick(G);
        if (sim.billRise[g] > 0) break;   // the documented limit: a pull between a bill and a counter sale
        const max = Math.floor(sim.Z[g] - sim.X[g]);
        if (max <= 0) break;
        const k = int(1, Math.min(max, 12));
        sim.Z[g] -= k; sim.unseen[g] += k; sim.fall[g] += k;
        await check("counter sale");
        break;
      }
      case "rise": {
        const g = pick(G);
        if (sim.lateRace[g] > 0) { await step("pull", () => doPull()); }
        const k = int(1, 10);
        sim.Z[g] += k; sim.rose[g] += k;
        await check("unrelated rise");
        break;
      }
      case "pull": {
        const x = rand();
        const clean = {};
        for (const g of G) {
          const wa = await watch(g);
          // (and no line from an earlier reading still counted as possibly out of Zoho already: a sales order confirmed by
          // hand in the same interval as a bill nets out in Zoho, which a reading can't see; that is not a race)
          const leftOver = (await one("SELECT cardinality(suspect_lines) AS c FROM public.preorder_watch WHERE branch_id = $1 AND product_id = $2", [g, SUGAR]))?.c ?? 0;
          if (wa && !leftOver && !sim.billRise[g] && !sim.fall[g] && !sim.lateRace[g] && !sim.rose[g] && !(await pendingAt(g))) clean[g] = wa.held;
        }
        await step("pull", () => doPull({ invoiceBetween: x < 0.3, invoiceAfterRead: x >= 0.3 && x < 0.5 }));
        if (rand() < 0.5) { await step("pull", () => doPull()); await step("pull", () => doPull()); await checkHealed(clean, "quiet pulls"); }
        break;
      }
      case "invoice": {
        const cand = (await liveOrders()).filter((o) => n(o.waiting) === 0 && !sim.netted.has(o.order_no));
        if (!cand.length) break;
        const o = pick(cand);
        await step("invoice", async () => { await invoiceInZoho(o.order_no); sim.Z[o.branch_id] -= o.qty; sim.netted.add(o.order_no); });
        break;
      }
      case "confirm": {
        // A sales order confirmed by hand in Zoho before its bags arrived: Zoho commits it (rule b keeps it in W).
        const cand = (await liveOrders()).filter((o) => n(o.waiting) > 0 && !sim.netted.has(o.order_no));
        if (!cand.length) break;
        const o = pick(cand);
        await step("confirm", async () => {
          await server("UPDATE public.orders SET zoho_salesorder_id = 'SO-' || order_no, zoho_order_status = 'confirmed' WHERE order_no = $1", [o.order_no]);
          sim.Z[o.branch_id] -= o.qty; sim.netted.add(o.order_no);
        });
        break;
      }
      case "match": {
        const ready = sim.bills.filter((b) => !b.matched && allLots.some((l) => l.id === b.lot && l.branch_id === b.g && l.paused_reason !== "receiving"));
        if (!ready.length) break;
        const b = pick(ready);
        const lot = allLots.find((l) => l.id === b.lot);
        const S = n(lot.quantity) - n(lot.remaining_quantity);
        const rest = b.qty < n(lot.quantity) ? (b.qty >= S && rand() < 0.5 ? "none" : "coming") : null;
        await step("match", () => matchBill(b, rest));
        break;
      }
      case "unmatch": {
        const b = sim.lastMatched;
        if (!b || !b.matched) break;
        await step("unmatch", async () => {
          await serverOne("SELECT public.unmatch_incoming_batch($1, 'sim undo', $2::jsonb, $3::jsonb, $4::timestamptz, $5, 'TEST Admin')",
            [b.lot, JSON.stringify(G.map((g) => ({ branch_id: g, zoho: sim.Z[g] }))), JSON.stringify(await snapshot([SUGAR])), now(), ADMIN]);
          b.matched = false; sim.X[b.g] += b.qty; sim.lastMatched = null;
          // The remainder is cancelled: bills typed for it are the lot's again.
          for (const o of sim.bills.filter((x) => b.remainder && x.lot === b.remainder && !x.matched)) { o.lot = b.lot; o.lotCode = b.lotCode; }
          for (const g of G) if (!(await pendingAt(g))) read([g]);
        });
        break;
      }
      case "join": {
        const g = pick(G);
        const free = allLots.filter((l) => l.branch_id === g && !sim.bills.some((b) => b.lot === l.id && !b.matched));
        if (free.length < 2) break;
        await step("join", () => adminOne("SELECT public.admin_join_incoming_batches($1, $2, 'sim join')", [free[0].id, free[1].id]));
        break;
      }
      case "cancelLot": {
        const free = allLots.filter((l) => !sim.bills.some((b) => b.lot === l.id && !b.matched));
        if (!free.length) break;
        await step("cancelLot", () => adminOne("SELECT public.admin_cancel_incoming_batch($1, 'sim cancel lot')", [pick(free).id]));
        break;
      }
      case "toReady": {
        const cand = (await liveOrders()).filter((o) => n(o.waiting) > 0);
        if (!cand.length) break;
        const o = pick(cand);
        await step("toReady", () => adminOne("SELECT public.admin_move_to_ready($1, $2, 'sim')", [o.item_id, int(1, Math.max(1, Math.floor(n(o.waiting))))]));
        break;
      }
      case "decrease": {
        const g = pick(G);
        const p = await pair(g);
        if (p.ready <= 0) break;
        await step("decrease", () => adminOne("SELECT public.admin_set_branch_stock($1, $2, $3)", [g, SUGAR, Math.floor(p.ready * rand())]));
        break;
      }
      case "count": {
        // A staff count that finds fewer bags: Zoho is adjusted first, then the website takes Zoho's number.
        const g = pick(G);
        const max = Math.floor(sim.Z[g] - sim.X[g]);
        if (max <= 0) break;
        const d = int(1, Math.min(max, 5));
        await step("count", async () => {
          const watched = !!(await watch(g));
          const snap = await snapshot([SUGAR]);
          const after = sim.Z[g] - d;
          const waiting = n((await one("SELECT private.batch_transfer_orders_waiting($1, $2) AS w", [g, SUGAR])).w);
          await serverOne("SELECT public.record_stock_count($1, $2, $3, $4, $5, $6, 'daily_count', '', false, 'ADJ', NULL, 'sim', NULL, $7, $8::uuid[])",
            [g, SUGAR, after, sim.Z[g], -d, Math.max(0, after - waiting), watched ? after : null, snap[`${g}|${SUGAR}`] ?? []]);
          sim.Z[g] = after;
          if (!(await pendingAt(g))) read([g]);
        });
        break;
      }
      case "split": {
        const g = pick(G);
        const b = await one("SELECT * FROM public.batches WHERE stage = 'received' AND branch_id = $1 AND product_id = $2 AND remaining_quantity > 0 ORDER BY random() LIMIT 1", [g, SUGAR]);
        if (!b) break;
        const k = int(1, Math.min(5, Math.floor(n(b.remaining_quantity))));
        if (sim.Z[g] - sim.X[g] < k) break;
        await step("split", async () => {
          const [t] = (await serverOne("SELECT public.begin_batch_split($1, $2::jsonb, $3, 'sim', NULL) AS r", [b.id, JSON.stringify([{ branch_id: other(g), qty: k }]), ADMIN])).r;
          sim.Z[g] -= k; sim.Z[other(g)] += k;
          const snap = await snapshot([SUGAR]);
          const stock = JSON.stringify(G.map((x) => ({ branch_id: x, product_id: SUGAR, stock: sim.Z[x], waiting: snap[`${x}|${SUGAR}`] ?? [] })));
          await serverOne("SELECT public.finish_batch_transfer($1, 'TO-S', 'in_transit', NULL, $2::jsonb, NULL)", [t.id, stock]);
          await serverOne("SELECT public.finish_batch_transfer($1, 'TO-S', 'transferred', NULL, $2::jsonb, NULL)", [t.id, stock]);
          for (const x of G) if (!(await pendingAt(x))) read([x]);
        });
        break;
      }
      case "release": {
        // An admin who knows: only the held units that are not lot bags typed into Zoho.
        const g = pick(G);
        const wa = await watch(g);
        if (!wa || (await pendingAt(g))) break;
        const free = Math.floor(wa.held - sim.X[g]);
        if (free <= 0 || sim.fall[g] > 0 || sim.billRise[g] > 0) break;
        const snap = await snapshot([SUGAR]);
        const k = int(1, free);
        await step("release", async () => {
          await serverOne("SELECT public.release_preorder_hold($1, $2, $3, 'other stock, checked in Zoho', '[]'::jsonb, $4, $5::uuid[], $6::timestamptz, $7, 'TEST Admin')",
            [g, SUGAR, k, sim.Z[g], snap[`${g}|${SUGAR}`] ?? [], now(), ADMIN]);
          read([g]);
        });
        break;
      }
    }
  }

  /* ---------- the end: every bill matched, every lot closed, every order invoiced, a last pull ---------- */
  for (let round = 0; round < 12 && (await lots()).length; round++) {
    await step("pull", () => doPull());
    for (const lot of await lots()) {
      if (lot.paused_reason === "receiving") continue;
      let b = sim.bills.find((x) => x.lot === lot.id && !x.matched);
      if (b && b.g !== lot.branch_id) { sim.Z[b.g] -= b.qty; sim.X[b.g] -= b.qty; sim.Z[lot.branch_id] += b.qty; sim.X[lot.branch_id] += b.qty; b.g = lot.branch_id; }
      if (!b) b = typeBill(lot, lot.branch_id, n(lot.quantity));
    }
    await step("pull", () => doPull());
    for (const lot of await lots()) {
      const b = sim.bills.find((x) => x.lot === lot.id && !x.matched);
      if (!b) continue;
      const S = n(lot.quantity) - n(lot.remaining_quantity);
      await step("match", () => matchBill(b, b.qty < n(lot.quantity) ? (b.qty >= S ? "none" : "coming") : null));
    }
  }
  if ((await lots()).length && process.env.PREORDER_DEBUG) console.error(JSON.stringify({ lots: await lots(), bills: sim.bills, refused: lastRefusals.slice(-6) }, null, 1));
  assert.equal((await lots()).length, 0, `seed ${seed}: every lot closed`);
  for (const o of (await liveOrders()).filter((x) => !sim.netted.has(x.order_no))) {
    await invoiceInZoho(o.order_no); sim.Z[o.branch_id] -= o.qty; sim.netted.add(o.order_no);
  }
  for (const g of G) while (await pendingAt(g)) await step("pull", () => doPull());
  await step("pull", () => doPull());
  assert.equal((await q("SELECT count(*)::int AS c FROM public.preorder_watch")).at(0).c, 0, `seed ${seed}: no watch left`);
  for (const g of G) {
    const waiting = n((await one("SELECT private.batch_transfer_orders_waiting($1, $2) AS w", [g, SUGAR])).w);
    assert.equal(waiting, 0, `seed ${seed}: nothing waits`);
    assert.equal((await pair(g)).ready, Math.max(0, sim.Z[g] - sim.X[g]), `seed ${seed}: ${g} website stock is Zoho's exactly`);
    assert.equal(sim.X[g], 0);
  }
  assert.equal(n((await one("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = $1", [SUGAR])).s),
    (await q("SELECT sum(stock) AS s FROM public.branch_stock WHERE product_id = $1", [SUGAR])).map((x) => n(x.s))[0], `seed ${seed}: catalogue total`);
  await rollback();
}
console.log(`  ${SEQ} sequences, ${events} steps (${refusals} refused as the rules say), ${checks} invariant checks`);
console.log(`  steps done: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log("preorder property OK");
