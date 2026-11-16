import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, applyReading, deriveSplit, lotSellable, matchPlan, openingHold, roundTo, takeLine, type Lot, type MatchRest, type PreorderClock,
} from "../src/lib/preorder.ts";

/*
 * Spec 15.1: seeded random sequences of everything that can happen to one product at two godowns, on the pure mirror of
 * the database (src/lib/preorder.ts). After every step, at every watched godown, the website's total is never above the
 * truth: T <= Z - X - W + U (+ the falls in Zoho the website has not read yet), where Z is Zoho's stock, X the lots'
 * bags already typed into Zoho, W the units promised and not yet out of Zoho, U the lots' units still to come. Ready and
 * arriving are never below 0, and every lot's ledger adds up. At the end every bill is matched, every lot closed, every
 * order invoiced and a last pull taken: the website's stock is Zoho's exactly.
 * The same property on the real functions: tests/db/preorder-property.db-test.mjs. PREORDER_SIM_SEQ sets the run size, PREORDER_SIM_FIRST the first seed.
 */

type G = "CLK" | "HBL";
const GODOWNS: G[] = ["CLK", "HBL"];
type SimLot = Lot & { g: G; billTyped: boolean };
type Bill = { lotId: string; g: G; qty: number; afterOpen: boolean };
type Order = { id: number; g: G; qty: number; lotUnits: Map<string, number>; live: boolean; inZoho: boolean };
type Watch = { zohoLast: number; held: number };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (n: number) => roundTo(n, 2);
const each = <T>(record: Record<G, T>) => GODOWNS.map((g) => [g, record[g]] as const);

function world(seed: number) {
  const rand = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const clock: PreorderClock = { todayIst: "2026-11-14", graceDays: 0, on: true };
  const Z: Record<G, number> = { CLK: int(0, 80), HBL: int(0, 20) };
  const X: Record<G, number> = { CLK: 0, HBL: 0 };
  const T: Record<G, number> = { CLK: 0, HBL: 0 };
  const unseen: Record<G, number> = { CLK: 0, HBL: 0 };
  const unread: Record<G, number> = { CLK: 0, HBL: 0 };
  const netted: Record<G, boolean> = { CLK: false, HBL: false };
  const unrelated: Record<G, number> = { CLK: 0, HBL: 0 };
  const futureBill: Record<G, number> = { CLK: 0, HBL: 0 };
  const futureAfterOpen: Record<G, boolean> = { CLK: false, HBL: false };
  const watch: Record<G, Watch | null> = { CLK: null, HBL: null };
  const lots: SimLot[] = [];
  const bills: Bill[] = [];
  const orders: Order[] = [];
  let lotNo = 0;
  let orderNo = 0;

  const open = (g?: G) => lots.filter((l) => l.stage === "incoming" && (!g || l.g === g));
  const U = (g: G) => r2(open(g).reduce((s, l) => s + l.quantity, 0));
  const W = (g: G) => r2(orders.filter((o) => o.live && !o.inZoho && o.g === g).reduce((s, o) => s + o.qty, 0));
  const truth = (g: G) => r2(Z[g] - X[g] - W(g) + U(g));
  const split = (g: G) => deriveSplit({ total: T[g], lots: open(g), ...clock });
  const waitingOn = (o: Order) => [...o.lotUnits.entries()].reduce((s, [id, q]) => s + (lots.find((l) => l.id === id)?.stage === "incoming" ? q : 0), 0);

  /** route_stock_to_branch: a pair with a lot moves its total; any other pair moves its ready stock, never below 0. */
  const route = (g: G, delta: number) => { T[g] = open(g).length ? r2(T[g] + delta) : Math.max(0, r2(T[g] + delta)); };
  const markRead = (g: G) => { unseen[g] = 0; unread[g] = 0; netted[g] = false; };
  /** One reading of a godown (snapshot W taken before Zoho was read). */
  const read = (g: G, waiting: number, explained = 0) => {
    const w = watch[g];
    if (w) {
      const r = applyReading({ watch: w, reading: Z[g], waiting, unbilled: U(g), total: T[g], explained });
      watch[g] = { zohoLast: r.zohoLast, held: r.held };
      T[g] = r.total;
    } else {
      T[g] = Math.max(0, r2(Z[g] - waiting));
      unrelated[g] = 0;
      futureBill[g] = 0; // pulled before any lot: those bags are ordinary stock now (received as a batch)
    }
    markRead(g);
  };
  /** The last lot of the product closed: with fresh readings every godown takes Z - W; without, T stays (never below 0). */
  const closeIfDone = (withReadings: boolean) => {
    if (open().length > 0) return;
    for (const g of GODOWNS) {
      if (!watch[g]) continue;
      // With a reading the held units count as stock now (a bill typed for a purchase not made into a lot yet is
      // ordinary stock from here on: the creation check would make the admin receive it as a batch).
      if (withReadings) { T[g] = Math.max(0, r2(Z[g] - W(g))); markRead(g); futureBill[g] = 0; } else T[g] = Math.max(0, T[g]);
      watch[g] = null;
      unrelated[g] = 0;
    }
  };

  const events: Record<string, () => boolean> = {
    createLot() {
      if (open().length >= 3) return false;
      const g = pick(GODOWNS);
      const q = int(1, 12) * 10;
      const lot: SimLot = { id: `L${++lotNo}`, code: `L${lotNo}`, stage: "incoming", quantity: q, remaining: q, holdBack: rand() < 0.2 ? int(0, q) : 0,
        expectedDate: addDays(clock.todayIst, int(0, 6)), paused: false, createdAt: String(lotNo).padStart(4, "0"), g, billTyped: false };
      const waits = Object.fromEntries(GODOWNS.map((x) => [x, W(x)])) as Record<G, number>;
      if (watch[g]) T[g] = r2(T[g] + q);
      lots.push(lot);
      // A bill typed in Zoho for this purchase before the lot, not pulled yet: it belongs to the lot (held at opening).
      if (futureBill[g] > 0) {
        bills.push({ lotId: lot.id, g, qty: futureBill[g], afterOpen: futureAfterOpen[g] });
        X[g] = r2(X[g] + futureBill[g]);
        lot.billTyped = true;
        futureBill[g] = 0;
      }
      for (const x of GODOWNS) {
        if (watch[x]) { read(x, waits[x]); continue; }
        const held = openingHold({ reading: Z[x], totalBefore: T[x], waiting: waits[x] });
        watch[x] = { zohoLast: Z[x], held };
        T[x] = r2(Z[x] - held - waits[x] + U(x));
        markRead(x);
      }
      return true;
    },
    order() {
      const g = pick(GODOWNS);
      const s = split(g);
      const qty = int(1, 60);
      const t = takeLine({ qty, ready: s.ready, total: T[g], lots: open(g), allowed: qty, clock });
      if (!t.ok) return false;
      route(g, -qty);
      const lotUnits = new Map<string, number>();
      for (const take of t.takes) {
        const lot = lots.find((l) => l.id === take.lotId)!;
        lot.remaining = r2(lot.remaining - take.qty);
        lotUnits.set(lot.id, take.qty);
      }
      orders.push({ id: ++orderNo, g, qty, lotUnits, live: true, inZoho: false });
      return true;
    },
    cancelOrder() {
      const live = orders.filter((o) => o.live);
      if (!live.length) return false;
      const o = pick(live);
      o.live = false;
      if (o.inZoho) Z[o.g] = r2(Z[o.g] + o.qty); // a credit note in Zoho gives the units back there too
      route(o.g, o.qty);
      for (const [id, q] of o.lotUnits) {
        const lot = lots.find((l) => l.id === id)!;
        if (lot.stage === "incoming") lot.remaining = r2(lot.remaining + q);
      }
      return true;
    },
    invoice() {
      const ready = orders.filter((o) => o.live && !o.inZoho && waitingOn(o) === 0);
      if (!ready.length) return false;
      const o = pick(ready);
      o.inZoho = true;
      Z[o.g] = r2(Z[o.g] - o.qty);
      return true;
    },
    typeBill() {
      const unbilled = open().filter((l) => !l.billTyped && unseen[l.g] === 0);
      if (!unbilled.length) return false;
      const lot = pick(unbilled);
      const qb = Math.max(1, lot.quantity + pick([0, 0, -int(1, lot.quantity), int(1, 30)]));
      lot.billTyped = true;
      bills.push({ lotId: lot.id, g: lot.g, qty: qb, afterOpen: true });
      Z[lot.g] = r2(Z[lot.g] + qb);
      X[lot.g] = r2(X[lot.g] + qb);
      unread[lot.g] = r2(unread[lot.g] + qb);
      return true;
    },
    billBeforeLot() {
      const g = pick(GODOWNS);
      // (a rise and an unread Zoho sale in one pull interval net out: the database's stated limit)
      if (open(g).length || futureBill[g] > 0 || unseen[g] > 0) return false;
      const qty = int(1, 10) * 10;
      futureBill[g] = qty;
      futureAfterOpen[g] = Boolean(watch[g]);
      Z[g] = r2(Z[g] + qty);
      unread[g] = r2(unread[g] + qty);
      return true;
    },
    counterSale() {
      const g = pick(GODOWNS);
      // Zoho gives net numbers only: a sale and an unread rise in one pull interval net out (the database's stated limit).
      if (unread[g] > 0 || netted[g] || futureBill[g] > 0) return false;
      // Only units the website does not offer as ready: a counter sale of units the website still sells is an oversell
      // that happens today too, without pre-orders (it shows at the next pull), and is not what this checks.
      const free = Math.floor(Z[g] - X[g] - W(g) - split(g).ready);
      if (free <= 0) return false;
      const k = int(1, Math.min(free, 15));
      Z[g] = r2(Z[g] - k);
      unseen[g] = r2(unseen[g] + k);
      return true;
    },
    unrelatedRise() {
      const g = pick(GODOWNS);
      if (unseen[g] > 0) return false;
      const k = int(1, 20);
      Z[g] = r2(Z[g] + k);
      unread[g] = r2(unread[g] + k);
      if (watch[g]) unrelated[g] = r2(unrelated[g] + k);
      return true;
    },
    pull() {
      const waits = Object.fromEntries(GODOWNS.map((x) => [x, W(x)])) as Record<G, number>;
      // Sometimes an order is invoiced between the snapshot and the read: still subtracted (it errs low).
      const between = rand() < 0.3 ? orders.filter((o) => o.live && !o.inZoho && waitingOn(o) === 0) : [];
      const late = between.length ? pick(between) : null;
      if (late) { late.inZoho = true; Z[late.g] = r2(Z[late.g] - late.qty); }
      for (const g of GODOWNS) read(g, waits[g]);
      if (late) netted[late.g] = true;
      return true;
    },
    match() {
      const typed = bills.filter((b) => lots.find((l) => l.id === b.lotId)?.stage === "incoming");
      if (!typed.length) return false;
      const bill = pick(typed);
      return matchBill(bill, rand() < 0.5 ? "coming" : "none");
    },
    cancelLot() {
      const idle = open().filter((l) => !l.billTyped && l.remaining === l.quantity);
      if (!idle.length) return false;
      const lot = pick(idle);
      T[lot.g] = r2(T[lot.g] - lot.quantity);
      lot.stage = "cancelled"; lot.quantity = 0; lot.remaining = 0;
      closeIfDone(false);
      return true;
    },
    moveToReady() {
      const g = pick(GODOWNS);
      const ready = split(g).ready;
      const candidates = orders.filter((o) => o.live && o.g === g && waitingOn(o) > 0);
      if (!candidates.length || ready < 1) return false;
      const o = pick(candidates);
      const [id, q] = [...o.lotUnits.entries()].find(([lid, units]) => units > 0 && lots.find((l) => l.id === lid)?.stage === "incoming")!;
      const m = Math.min(q, Math.floor(ready));
      if (m <= 0) return false;
      o.lotUnits.set(id, r2(q - m));
      const lot = lots.find((l) => l.id === id)!;
      lot.remaining = r2(lot.remaining + m);
      return true;
    },
    join() {
      const g = pick(GODOWNS);
      const here = open(g).filter((l) => !l.billTyped);
      if (here.length < 2) return false;
      const [into, from] = [here[0]!, here[1]!];
      into.quantity = r2(into.quantity + from.quantity);
      into.remaining = r2(into.remaining + from.remaining);
      for (const o of orders) {
        const q = o.lotUnits.get(from.id);
        if (q) { o.lotUnits.delete(from.id); o.lotUnits.set(into.id, r2((o.lotUnits.get(into.id) ?? 0) + q)); }
      }
      from.stage = "cancelled"; from.quantity = 0; from.remaining = 0;
      return true;
    },
    release() {
      const g = pick(GODOWNS);
      const w = watch[g];
      if (!w || unrelated[g] <= 0 || unread[g] > unrelated[g]) return false;
      const waiting = W(g);
      // The admin says what the unexplained units are (other stock); only those may be released.
      const heldAfterStep = Math.max(0, w.held + Math.max(0, r2(Z[g] - w.held - waiting + U(g) - T[g])));
      const q = Math.min(heldAfterStep, unrelated[g]);
      if (q <= 0) return false;
      read(g, waiting, q);
      unrelated[g] = r2(unrelated[g] - q);
      return true;
    },
    nextDay() {
      clock.todayIst = addDays(clock.todayIst, 1);
      return true;
    },
  };

  function matchBill(bill: Bill, wanted: MatchRest) {
    const lot = lots.find((l) => l.id === bill.lotId)!;
    const S = r2(lot.quantity - lot.remaining);
    let plan = matchPlan({ Q: lot.quantity, S, Qb: bill.qty, rest: wanted });
    if (!plan.ok) plan = matchPlan({ Q: lot.quantity, S, Qb: bill.qty, rest: "coming" });
    if (!plan.ok) throw new Error("rest coming is never refused");
    const uBefore = U(lot.g);
    const waits = Object.fromEntries(GODOWNS.map((x) => [x, W(x)])) as Record<G, number>;
    lot.stage = "received"; lot.quantity = plan.quantity; lot.remaining = plan.remaining;
    if (plan.remainder) {
      const rest: SimLot = { id: `L${++lotNo}`, code: `${lot.code}-R`, stage: "incoming", quantity: plan.remainder.quantity, remaining: plan.remainder.remaining,
        holdBack: Math.min(lot.holdBack, plan.remainder.quantity), expectedDate: lot.expectedDate < clock.todayIst ? clock.todayIst : lot.expectedDate,
        paused: false, createdAt: String(lotNo).padStart(4, "0"), g: lot.g, billTyped: false };
      lots.push(rest);
      // Units sold beyond the bill move to the remainder, newest orders first.
      let need = plan.move;
      for (const o of [...orders].reverse()) {
        if (need <= 0) break;
        const q = o.live ? o.lotUnits.get(lot.id) ?? 0 : 0;
        if (q <= 0) continue;
        const m = Math.min(q, need);
        o.lotUnits.set(lot.id, r2(q - m));
        o.lotUnits.set(rest.id, r2((o.lotUnits.get(rest.id) ?? 0) + m));
        need = r2(need - m);
      }
    }
    T[lot.g] = r2(T[lot.g] + U(lot.g) - uBefore);
    X[bill.g] = r2(X[bill.g] - bill.qty);
    for (const g of GODOWNS) read(g, waits[g], g === bill.g && bill.afterOpen ? bill.qty : 0);
    closeIfDone(true);
    return true;
  }

  function check(label: string) {
    for (const [g, w] of each(watch)) {
      const s = split(g);
      if (w) {
        assert.ok(T[g] <= truth(g) + unseen[g] + 1e-6, `seed ${seed} after ${label}: ${g} total ${T[g]} > truth ${truth(g)} + unseen ${unseen[g]} (Z ${Z[g]} X ${X[g]} W ${W(g)} U ${U(g)} held ${w.held})`);
      } else {
        assert.ok(T[g] >= 0 && s.incoming === 0, `seed ${seed} after ${label}: ${g} unwatched ${T[g]}`);
      }
      assert.ok(s.ready >= 0 && s.incoming >= 0 && s.incoming <= Math.max(0, T[g]) + 1e-6, `seed ${seed} after ${label}: ${g} split ${JSON.stringify(s)}`);
    }
    for (const lot of open()) {
      const held = r2(orders.filter((o) => o.live).reduce((sum, o) => sum + (o.lotUnits.get(lot.id) ?? 0), 0));
      assert.ok(lot.remaining >= 0 && lot.remaining <= lot.quantity, `seed ${seed} after ${label}: lot ${lot.code} remaining ${lot.remaining}`);
      assert.equal(r2(lot.quantity - lot.remaining), held, `seed ${seed} after ${label}: lot ${lot.code} ledger`);
      assert.ok(lotSellable(lot, clock) >= 0);
    }
  }

  function finish() {
    for (let guard = 0; open().length > 0; guard++) {
      assert.ok(guard < 50, `seed ${seed}: lots never closed`);
      for (const lot of open()) {
        if (!lot.billTyped) {
          lot.billTyped = true;
          bills.push({ lotId: lot.id, g: lot.g, qty: lot.quantity, afterOpen: true });
          Z[lot.g] = r2(Z[lot.g] + lot.quantity);
          X[lot.g] = r2(X[lot.g] + lot.quantity);
        }
        const bill = bills.find((b) => b.lotId === lot.id)!;
        matchBill(bill, "none");
        check("final match");
      }
    }
    for (const o of orders) if (o.live && !o.inZoho) { o.inZoho = true; Z[o.g] = r2(Z[o.g] - o.qty); }
    const waits = Object.fromEntries(GODOWNS.map((x) => [x, W(x)])) as Record<G, number>;
    for (const g of GODOWNS) read(g, waits[g]);
    for (const g of GODOWNS) {
      assert.equal(X[g], 0, `seed ${seed}: every bill matched`);
      assert.ok(Z[g] >= 0, `seed ${seed}: Zoho never below 0 (${Z[g]})`);
      assert.equal(T[g], Z[g], `seed ${seed}: ${g} website ${T[g]} = Zoho ${Z[g]} at the end`);
    }
  }

  return { events, check, finish, rand, pull: events["pull"]! };
}

const WEIGHTS: [string, number][] = [
  ["createLot", 3], ["order", 6], ["cancelOrder", 2], ["invoice", 3], ["typeBill", 3], ["billBeforeLot", 1], ["counterSale", 2],
  ["unrelatedRise", 1], ["pull", 4], ["match", 3], ["cancelLot", 1], ["moveToReady", 1], ["join", 1], ["release", 1], ["nextDay", 1],
];
const TOTAL = WEIGHTS.reduce((s, [, w]) => s + w, 0);

test("pre-order simulation: the website never promises more than it has or will have, and ends equal to Zoho", () => {
  const sequences = Number(process.env["PREORDER_SIM_SEQ"] ?? 10_000);
  const tally: Record<string, number> = {};
  const first = Number(process.env["PREORDER_SIM_FIRST"] ?? 1);
  for (let seed = first; seed < first + sequences; seed++) {
    const w = world(seed);
    w.pull();
    w.check("start");
    const steps = 10 + Math.floor(w.rand() * 30);
    for (let i = 0; i < steps; i++) {
      let roll = w.rand() * TOTAL;
      const [name] = WEIGHTS.find(([, weight]) => (roll -= weight) < 0) ?? WEIGHTS[0]!;
      if (w.events[name]!()) tally[name] = (tally[name] ?? 0) + 1;
      w.check(name);
    }
    w.finish();
  }
  // Every kind of event really happened.
  for (const [name] of WEIGHTS) assert.ok((tally[name] ?? 0) > 0, `${name} never happened`);
});
