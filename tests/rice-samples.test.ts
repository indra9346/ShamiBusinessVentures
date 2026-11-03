import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestInComparison, checkRicePo, createInZohoOnce, findPurchaseOrdersByReference, gstPreferencesFrom, itemBody, itemMatchFrom, kgPerZohoUnit, latestTest, nameKey, phoneLinks, planPoLine, plainZohoRefusal,
  differsFromRaised, poDifferences, poLineProblem, poReference, priceUnitWarning, purchaseOrderBody, raiseRicePo, readPoStatus, riceTextOptions, sortSamples, testsBySample, vendorBody, vendorMatchesFrom, zohoPoUrl, zohoStatusLabel, zohoVerdict,
  type ClaimAnswer, type CreationStore, type PoActor, type PoFound, type PoPlan, type PoStore, type RecordAnswer, type RicePo, type RiceSample, type RiceTest, type ZohoRaw, type ZohoSend,
} from "../src/lib/rice-samples.ts";

const SAMPLE = "11111111-1111-4111-8111-111111111111";
const REF = poReference(SAMPLE);
const ACTOR: PoActor = { userId: "22222222-2222-4222-8222-222222222222", name: "Head Office" };

const plan = (patch: Partial<PoPlan> = {}): PoPlan => ({
  reference: REF, date: "2026-11-03", vendorRole: "broker", vendorId: "V1", vendorName: "Test Traders", itemId: "I1", itemName: "Rice bulk", itemUnit: "qtl", kgPerUnit: 100,
  quantityQntl: 100, ratePerQntl: 4200, poQuantity: 100, poRate: 4200, subTotal: 420000, gstPercent: null, branchId: "BR-CLK", branchName: "Challakere", locationId: "L1", issueOnCreate: false,
  description: "Sona Rice, Steam Rice. 100 quintal at Rs 4200 per quintal.", ...patch,
});

let clockNow = () => Date.now();

// ---------------------------------------------------------------- The database's rules, in memory (the real ones are tested on PGlite)
function memoryStore(startedAgoSeconds = 0) {
  clockNow = () => state.clock;
  const state = { row: null as null | { state: string; attempt: string; attempts: number; claimedAt: number; snapshot: PoPlan; po?: RicePo; duplicates: PoFound[] }, clock: Date.now() };
  const poRow = (found: PoFound, totals: { total: number | null }): RicePo => ({
    sample_id: SAMPLE, reference: REF, state: "raised", attempt_id: state.row!.attempt, attempts: state.row!.attempts, snapshot: state.row!.snapshot, claimed_by_name: ACTOR.name,
    claimed_at: new Date(state.row!.claimedAt).toISOString(), last_error: "", zoho_po_id: found.id, zoho_po_number: found.number, zoho_po_status: found.status, zoho_sub_total: null, zoho_tax_total: null,
    zoho_total: totals.total, differences: [], duplicates: [], zoho_gone: false, zoho_checked_at: null, raised_at: null, raised_by_name: ACTOR.name,
  });
  const store: PoStore = {
    async claim({ attemptId, snapshot }): Promise<ClaimAnswer> {
      const row = state.row;
      if (row?.po) return { outcome: "already_raised", po: row.po };
      if (row?.state === "sending" && state.clock - row.claimedAt < 120_000) return { outcome: "in_progress", by: ACTOR.name, since: new Date(row.claimedAt).toISOString() };
      if (row && (row.state === "sending" || row.state === "uncertain")) return { outcome: "verify_first", attempt_id: row.attempt, claimed_at: new Date(row.claimedAt).toISOString(), snapshot: row.snapshot, attempts: row.attempts };
      state.row = { state: "sending", attempt: attemptId, attempts: (row?.attempts ?? 0) + 1, claimedAt: state.clock - startedAgoSeconds * 1000, snapshot, duplicates: [] };
      return { outcome: "claimed", attempts: state.row.attempts };
    },
    async takeover({ expectedAttempt, attemptId, snapshot }) {
      const row = state.row;
      if (!row || row.po || row.attempt !== expectedAttempt) return { outcome: "changed" };
      const wait = 120 - Math.floor((state.clock - row.claimedAt) / 1000);
      if (wait > 0) return { outcome: "too_soon", wait_seconds: wait };
      Object.assign(row, { state: "sending", attempt: attemptId, attempts: row.attempts + 1, claimedAt: state.clock, snapshot });
      return { outcome: "claimed", attempts: row.attempts };
    },
    async release({ expectedAttempt }) {
      const row = state.row;
      if (!row || row.po || row.attempt !== expectedAttempt) return { outcome: "changed" };
      const wait = 120 - Math.floor((state.clock - row.claimedAt) / 1000);
      if (wait > 0) return { outcome: "too_soon", wait_seconds: wait };
      row.state = "rejected";
      return { outcome: "released" };
    },
    async markFailed({ attemptId, state: next }) {
      if (state.row && state.row.attempt === attemptId && state.row.state === "sending") state.row.state = next;
    },
    async record({ po, total }): Promise<RecordAnswer> {
      const row = state.row!;
      if (row.po) {
        if (row.po.zoho_po_id === po.id) return { outcome: "same", po: row.po };
        row.duplicates.push(po);
        return { outcome: "duplicate", po: row.po };
      }
      row.state = "raised";
      row.po = poRow(po, { total });
      return { outcome: "recorded", po: row.po };
    },
  };
  return { store, state, age: (seconds: number) => { state.clock += seconds * 1000; } };
}

// ---------------------------------------------------------------- A fake Zoho, shaped like the live answers read on 2 Nov 2026
function fakeZoho(options: { create?: "ok" | "reject" | "no_scope" | "timeout_created" | "timeout_nothing" | "http502_created" | "no_id" | "wrong_rate"; filterIgnored?: boolean; pages?: number; searchFails?: boolean; issueFails?: boolean } = {}) {
  const orders: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const row = (order: Record<string, unknown>) => ({ purchaseorder_id: order["purchaseorder_id"], purchaseorder_number: order["purchaseorder_number"], reference_number: order["reference_number"], status: order["status"], total: order["total"] });
  const make = (body: Record<string, unknown>, rateOverride?: number) => {
    const line = (body["line_items"] as Record<string, unknown>[])[0]!;
    const rate = rateOverride ?? Number(line["rate"]), quantity = Number(line["quantity"]);
    const order = {
      purchaseorder_id: `PO${orders.length + 1}`, purchaseorder_number: `PO-03112601${48 + orders.length}`, reference_number: body["reference_number"], status: "draft", vendor_id: body["vendor_id"], location_id: body["location_id"],
      line_items: [{ item_id: line["item_id"], rate, quantity, unit: "qtl", item_total: rate * quantity }], sub_total: rate * quantity, tax_total: rate * quantity * 0.05, total: rate * quantity * 1.05,
    };
    orders.push(order);
    return order;
  };
  const send: ZohoSend = async (resource, method, body, query = {}) => {
    calls.push(`${method} ${resource}`);
    if (resource === "purchaseorders" && method === "POST") {
      const mode = options.create ?? "ok";
      if (mode === "reject") return { status: 400, body: { code: 4, message: "Vendor does not exist" } };
      if (mode === "no_scope") return { status: 401, body: { code: 57, message: "You are not authorized to perform this operation" } };
      if (mode === "timeout_created") { make(body!); throw new DOMException("The operation timed out", "TimeoutError"); }
      if (mode === "timeout_nothing") throw new DOMException("The operation timed out", "TimeoutError");
      if (mode === "http502_created") { make(body!); return { status: 502, body: null }; }
      if (mode === "no_id") return { status: 201, body: { code: 0, message: "success" } };
      const order = make(body!, mode === "wrong_rate" ? 1 : undefined);
      return { status: 201, body: { code: 0, message: "success", purchase_order: order } };
    }
    if (resource === "purchaseorders" && method === "GET") {
      if (options.searchFails) throw new Error("network down");
      const filter = query["reference_number"];
      const page = Number(query["page"] ?? 1), lastPage = options.pages ?? 1;
      const list = filter && !options.filterIgnored ? orders.filter((order) => order["reference_number"] === filter) : page === 1 ? orders : [];
      return { status: 200, body: { code: 0, purchaseorders: list.map(row), page_context: { page, has_more_page: page < lastPage } } };
    }
    const issue = /^purchaseorders\/([^/]+)\/status\/issued$/.exec(resource);
    if (issue) {
      if (options.issueFails) return { status: 400, body: { code: 9, message: "Approval needed" } };
      const order = orders.find((entry) => entry["purchaseorder_id"] === issue[1])!;
      order["status"] = "open";
      return { status: 200, body: { code: 0, message: "The purchase order has been marked as issued." } };
    }
    const one = /^purchaseorders\/([^/]+)$/.exec(resource);
    if (one) {
      const order = orders.find((entry) => entry["purchaseorder_id"] === one[1]);
      return order ? { status: 200, body: { code: 0, purchaseorder: order } } : { status: 404, body: { code: 1002, message: "Purchase order does not exist" } };
    }
    throw new Error(`unexpected ${method} ${resource}`);
  };
  return { send, orders, calls };
}

let ids = 0;
const deps = (store: PoStore, send: ZohoSend, nowMs = () => clockNow()) => ({ store, zoho: send, newId: () => `attempt-${ids += 1}`, now: nowMs });

// ---------------------------------------------------------------- Raising once

test("a clean raise creates one draft with the sample's reference and Zoho's own number", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  const result = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  assert.equal(zoho.orders.length, 1);
  assert.equal(zoho.orders[0]!["reference_number"], REF);
  assert.equal(zoho.orders[0]!["status"], "draft");
  if (result.kind === "raised") { assert.equal(result.poNumber, "PO-0311260148"); assert.deepEqual(result.warnings, []); }
  assert.deepEqual(zoho.calls.filter((call) => call.startsWith("POST")), ["POST purchaseorders"]);
});

test("the request body carries no purchase order number, no internal notes, the godown and the item", () => {
  const body = purchaseOrderBody(plan());
  assert.equal("purchaseorder_number" in body, false);
  assert.equal("notes" in body, false);
  assert.equal(body["location_id"], "L1");
  assert.equal(body["reference_number"], REF);
  const line = (body["line_items"] as Record<string, unknown>[])[0]!;
  assert.deepEqual([line["item_id"], line["quantity"], line["rate"], line["purchase_rate"], line["location_id"]], ["I1", 100, 4200, 4200, "L1"]);
});

test("double tap and two admins: the second request is told it is in progress, and only one reaches Zoho", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  const [first, second] = await Promise.all([
    raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR),
    raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), { userId: "another", name: "Second Admin" }),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ["in_progress", "raised"]);
  assert.equal(zoho.orders.length, 1);
});

test("twenty requests at once still make one purchase order", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  await Promise.all(Array.from({ length: 20 }, () => raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR)));
  assert.equal(zoho.orders.length, 1);
});

test("a retry after success returns the same purchase order and sends nothing", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  const callsBefore = zoho.calls.length;
  const again = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(again.kind, "raised");
  if (again.kind === "raised") { assert.equal(again.already, true); assert.equal(again.poId, "PO1"); }
  assert.equal(zoho.calls.length, callsBefore);
});

test("timeout, but Zoho made it: found at once by reference, no second send", async () => {
  const { store, state } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_created" });
  const result = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  assert.equal(zoho.orders.length, 1);
  assert.equal(state.row?.state, "raised");
  assert.equal(zoho.calls.filter((call) => call === "POST purchaseorders").length, 1);
});

test("timeout, and Zoho's reference filter is ignored: the full walk still finds it", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_created", filterIgnored: true });
  zoho.orders.push({ purchaseorder_id: "OLD", purchaseorder_number: "PO-OLD", reference_number: "", status: "open" });
  const result = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  if (result.kind === "raised") assert.notEqual(result.poId, "OLD");
});

test("a gateway error after Zoho made it is treated the same way", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho({ create: "http502_created" });
  assert.equal((await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR)).kind, "raised");
  assert.equal(zoho.orders.length, 1);
});

test("timeout and nothing in Zoho: locked, says to wait, and cannot resend for two minutes", async () => {
  const { store, state, age } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_nothing" });
  const first = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(first.kind, "uncertain");
  assert.equal(state.row?.state, "uncertain");
  // Pressing again too soon: Zoho is searched, nothing is sent.
  const soon = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(soon.kind, "uncertain");
  if (soon.kind === "uncertain") assert.ok(soon.retryAfterSeconds > 0);
  assert.equal(zoho.calls.filter((call) => call === "POST purchaseorders").length, 1);
  // After two minutes and a full search, it may go again.
  age(126);
  const zohoNow = fakeZoho();
  const later = await raiseRicePo(deps(store, zohoNow.send), SAMPLE, plan(), ACTOR);
  assert.equal(later.kind, "raised");
  assert.equal(zohoNow.orders.length, 1);
});

test("the late arrival: the first send landed after all, so the resend finds both and says so", async () => {
  const { store, age } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_nothing" });
  await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  age(126);
  // The first request lands while the second is on its way.
  const shared = fakeZoho();
  const raceSend: ZohoSend = async (resource, method, body, query) => {
    if (resource === "purchaseorders" && method === "POST") {
      shared.orders.push({ purchaseorder_id: "LATE", purchaseorder_number: "PO-LATE", reference_number: REF, status: "draft" });
    }
    return shared.send(resource, method, body, query);
  };
  const result = await raiseRicePo(deps(store, raceSend), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  if (result.kind === "raised") assert.ok(result.warnings.some((warning) => /more than one purchase order/.test(warning)), JSON.stringify(result.warnings));
  assert.equal(shared.orders.length, 2);
});

test("an uncertain send with Zoho unsearchable stays locked and sends nothing", async () => {
  const { store, age } = memoryStore();
  await raiseRicePo(deps(store, fakeZoho({ create: "timeout_nothing" }).send), SAMPLE, plan(), ACTOR);
  age(600);
  const down = fakeZoho({ searchFails: true });
  const result = await raiseRicePo(deps(store, down.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "uncertain");
  assert.equal(down.calls.includes("POST purchaseorders"), false);
});

test("a search too large to finish is not trusted to mean no", async () => {
  const { store, age } = memoryStore();
  await raiseRicePo(deps(store, fakeZoho({ create: "timeout_nothing" }).send), SAMPLE, plan(), ACTOR);
  age(600);
  const huge = fakeZoho({ pages: 500 });
  const result = await raiseRicePo(deps(store, huge.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "uncertain");
  assert.equal(huge.calls.includes("POST purchaseorders"), false);
});

test("a freed or refused sample searches before sending again, and adopts what landed meanwhile", async () => {
  const { store, age } = memoryStore();
  const zoho = fakeZoho({ create: "reject" });
  await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  // Something with this reference is in Zoho now, whatever the refusal said.
  zoho.orders.push({ purchaseorder_id: "LANDED", purchaseorder_number: "PO-LANDED", reference_number: REF, status: "draft" });
  zoho.calls.length = 0;
  const result = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  if (result.kind === "raised") assert.equal(result.poId, "LANDED");
  assert.equal(zoho.calls.includes("POST purchaseorders"), false);
  age(0);
});

test("a retry through the plain lock with Zoho unsearchable sends nothing and stays locked", async () => {
  const { store, state } = memoryStore();
  await raiseRicePo(deps(store, fakeZoho({ create: "reject" }).send), SAMPLE, plan(), ACTOR);
  const down = fakeZoho({ searchFails: true });
  const result = await raiseRicePo(deps(store, down.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "uncertain");
  if (result.kind === "uncertain") assert.equal(result.searchIncomplete, true);
  assert.equal(down.calls.includes("POST purchaseorders"), false);
  assert.equal(state.row?.state, "uncertain");
});

test("a search that starts before the two minutes is never proof, even if it ends after", async () => {
  const { store, state, age } = memoryStore();
  await raiseRicePo(deps(store, fakeZoho({ create: "timeout_nothing" }).send), SAMPLE, plan(), ACTOR);
  age(115);
  const slow = fakeZoho();
  const crawl: ZohoSend = async (resource, method, body, query) => { age(10); return slow.send(resource, method, body, query); };
  const po = { snapshot: plan(), claimed_at: new Date(state.row!.claimedAt).toISOString(), attempt_id: state.row!.attempt };
  assert.equal((await checkRicePo(deps(store, crawl), SAMPLE, po, ACTOR)).kind, "uncertain");
  assert.equal(state.row?.state, "uncertain");
  const raised = await raiseRicePo(deps(store, fakeZoho().send), SAMPLE, plan(), ACTOR);
  assert.equal(raised.kind, "raised"); // By then it really has been two minutes.
  age(0);
  const fresh = memoryStore();
  await raiseRicePo(deps(fresh.store, fakeZoho({ create: "timeout_nothing" }).send), SAMPLE, plan(), ACTOR);
  fresh.age(115);
  const sent = fakeZoho();
  const crawl2: ZohoSend = async (resource, method, body, query) => { fresh.age(10); return sent.send(resource, method, body, query); };
  assert.equal((await raiseRicePo(deps(fresh.store, crawl2), SAMPLE, plan(), ACTOR)).kind, "uncertain");
  assert.equal(sent.calls.includes("POST purchaseorders"), false);
});

test("a second admin who confirmed different figures is told what was really raised", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  const other = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan({ ratePerQntl: 4000, quantityQntl: 50 }), ACTOR);
  assert.equal(other.kind, "raised");
  if (other.kind === "raised") assert.match(other.warnings.join(" "), /not what you just confirmed.*100 quintal.*Rs 4200/);
  assert.deepEqual(differsFromRaised(plan(), plan()), []);
});

test("a purchase order found by search as a Draft says so when the setting is Issued", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_created" });
  const result = await raiseRicePo(deps(store, zoho.send), SAMPLE, plan({ issueOnCreate: true }), ACTOR);
  assert.equal(result.kind, "raised");
  if (result.kind === "raised") assert.match(result.warnings.join(" "), /Draft in Zoho. Issue it there/);
});

test("if the database also fails after no answer, the search still runs and links what is there", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho({ create: "timeout_created" });
  const failing: PoStore = { ...store, markFailed: async () => { throw new Error("database down"); } };
  assert.equal((await raiseRicePo(deps(failing, zoho.send), SAMPLE, plan(), ACTOR)).kind, "raised");
});

test("a refusal is still reported as a refusal when saving it fails", async () => {
  const { store } = memoryStore();
  const failing: PoStore = { ...store, markFailed: async () => { throw new Error("database down"); } };
  assert.equal((await raiseRicePo(deps(failing, fakeZoho({ create: "reject" }).send), SAMPLE, plan(), ACTOR)).kind, "rejected");
});

test("Zoho refuses: nothing exists, plain words, and the admin can fix and retry", async () => {
  const { store, state } = memoryStore();
  const refused = fakeZoho({ create: "reject" });
  const result = await raiseRicePo(deps(store, refused.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") { assert.match(result.message, /Vendor does not exist/); assert.match(result.message, /Nothing was created/); }
  assert.equal(state.row?.state, "rejected");
  const fixed = fakeZoho();
  assert.equal((await raiseRicePo(deps(store, fixed.send), SAMPLE, plan(), ACTOR)).kind, "raised");
});

test("a missing Zoho permission tells the owner to re-authorize", async () => {
  const { store } = memoryStore();
  const result = await raiseRicePo(deps(store, fakeZoho({ create: "no_scope" }).send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.match(result.message, /Reauthorize Zoho/);
});

test("Zoho says success with no ID: treated as unknown, never as created or refused", async () => {
  const { store, state } = memoryStore();
  const result = await raiseRicePo(deps(store, fakeZoho({ create: "no_id" }).send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "uncertain");
  assert.equal(state.row?.state, "uncertain");
});

test("Zoho saved a different rate: the purchase order is kept and the difference is shown", async () => {
  const { store } = memoryStore();
  const result = await raiseRicePo(deps(store, fakeZoho({ create: "wrong_rate" }).send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  if (result.kind === "raised") assert.ok(result.warnings.some((warning) => /rate is ₹1, not ₹4200/.test(warning)));
});

test("if saving fails after Zoho made it, the admin is told not to create it again, and Check Zoho links it", async () => {
  const { store, state, age } = memoryStore();
  const zoho = fakeZoho();
  const broken: PoStore = { ...store, record: async () => { throw new Error("database down"); } };
  const result = await raiseRicePo(deps(broken, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "uncertain");
  if (result.kind === "uncertain") assert.match(result.message, /could not save/);
  age(126);
  const po = { snapshot: plan(), claimed_at: new Date(state.row!.claimedAt).toISOString(), attempt_id: state.row!.attempt };
  const checked = await checkRicePo(deps(store, zoho.send, () => state.clock), SAMPLE, po, ACTOR);
  assert.equal(checked.kind, "raised");
  assert.equal(zoho.orders.length, 1);
});

test("Check Zoho never creates anything, and frees the sample once a full search after two minutes finds nothing", async () => {
  const { store, state, age } = memoryStore();
  const zoho = fakeZoho();
  await store.claim({ sampleId: SAMPLE, attemptId: "a", reference: REF, snapshot: plan(), actor: ACTOR });
  await store.markFailed({ sampleId: SAMPLE, attemptId: "a", state: "uncertain", message: "", detail: "", actor: ACTOR });
  const po = () => ({ snapshot: plan(), claimed_at: new Date(state.row!.claimedAt).toISOString(), attempt_id: state.row!.attempt });
  const soon = await checkRicePo(deps(store, zoho.send, () => state.clock), SAMPLE, po(), ACTOR);
  assert.equal(soon.kind, "uncertain");
  assert.equal(state.row?.state, "uncertain");
  age(126);
  const later = await checkRicePo(deps(store, zoho.send, () => state.clock), SAMPLE, po(), ACTOR);
  assert.equal(later.kind, "absent");
  assert.equal(state.row?.state, "rejected");
  assert.equal(zoho.calls.some((call) => call.startsWith("POST")), false);
  // Freed: the next raise goes straight through the lock, as a second attempt.
  assert.equal((await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR)).kind, "raised");
  assert.equal(state.row?.attempts, 2);
});

test("Check Zoho does not free the sample when the search could not finish", async () => {
  const { store, state, age } = memoryStore();
  await store.claim({ sampleId: SAMPLE, attemptId: "a", reference: REF, snapshot: plan(), actor: ACTOR });
  await store.markFailed({ sampleId: SAMPLE, attemptId: "a", state: "uncertain", message: "", detail: "", actor: ACTOR });
  age(600);
  const po = { snapshot: plan(), claimed_at: new Date(state.row!.claimedAt).toISOString(), attempt_id: "a" };
  assert.equal((await checkRicePo(deps(store, fakeZoho({ searchFails: true }).send, () => state.clock), SAMPLE, po, ACTOR)).kind, "uncertain");
  assert.equal((await checkRicePo(deps(store, fakeZoho({ pages: 500 }).send, () => state.clock), SAMPLE, po, ACTOR)).kind, "uncertain");
  assert.equal(state.row?.state, "uncertain");
});

test("issue setting on: marks it issued. If Zoho refuses, the draft stands with a warning and nothing is resent", async () => {
  const on = memoryStore();
  const zoho = fakeZoho();
  const issued = await raiseRicePo(deps(on.store, zoho.send), SAMPLE, plan({ issueOnCreate: true }), ACTOR);
  assert.equal(issued.kind, "raised");
  if (issued.kind === "raised") assert.equal(issued.poStatus, "open");
  assert.ok(zoho.calls.includes("POST purchaseorders/PO1/status/issued"));

  const off = memoryStore();
  const stuck = fakeZoho({ issueFails: true });
  const draft = await raiseRicePo(deps(off.store, stuck.send), SAMPLE, plan({ issueOnCreate: true }), ACTOR);
  assert.equal(draft.kind, "raised");
  if (draft.kind === "raised") { assert.equal(draft.poStatus, "draft"); assert.match(draft.warnings.join(" "), /as a Draft/); }
  assert.equal(stuck.orders.length, 1);
});

test("the draft setting never touches the issue address", async () => {
  const { store } = memoryStore();
  const zoho = fakeZoho();
  await raiseRicePo(deps(store, zoho.send), SAMPLE, plan(), ACTOR);
  assert.equal(zoho.calls.some((call) => call.includes("status/issued")), false);
});

// ---------------------------------------------------------------- Reading Zoho's answers

test("Zoho's answers sort into created, refused and unknown", () => {
  const raw = (status: number, body: Record<string, unknown> | null): ZohoRaw => ({ status, body });
  assert.equal(zohoVerdict(raw(201, { code: 0 })), "ok");
  assert.equal(zohoVerdict(raw(200, { code: 9, message: "no" })), "rejected");
  assert.equal(zohoVerdict(raw(400, { code: 4 })), "rejected");
  assert.equal(zohoVerdict(raw(401, { code: 57 })), "rejected");
  assert.equal(zohoVerdict(raw(429, null)), "rejected");
  for (const unknown of [raw(500, { code: 1 }), raw(502, null), raw(503, null), raw(504, null), raw(408, null), raw(200, null), raw(200, {}), raw(302, null)]) {
    assert.equal(zohoVerdict(unknown), "uncertain", JSON.stringify(unknown));
  }
});

test("refusals come back in plain words with the fix", () => {
  assert.match(plainZohoRefusal({ status: 400, body: { code: 1, message: "Please enter a purchase order number" } }), /automatic numbering/);
  assert.match(plainZohoRefusal({ status: 429, body: null }), /limit/);
  assert.equal(plainZohoRefusal({ status: 502, body: null }), "Zoho is having trouble just now (error 502).");
  assert.match(plainZohoRefusal({ status: 400, body: { code: 1, message: "Enter a valid HSN" } }), /HSN/);
});

test("the search matches the exact reference only, and reads every page", async () => {
  const other = `${REF}-X`;
  const pages: Record<number, Record<string, unknown>[]> = {
    1: [{ purchaseorder_id: "A", reference_number: other, purchaseorder_number: "PO-A", status: "open" }],
    2: [{ purchaseorder_id: "B", reference_number: ` ${REF} `, purchaseorder_number: "PO-B", status: "draft" }],
  };
  const send: ZohoSend = async (_resource, _method, _body, query = {}) => {
    if (query["reference_number"]) return { status: 200, body: { code: 0, purchaseorders: [] } };
    const page = Number(query["page"]);
    return { status: 200, body: { code: 0, purchaseorders: pages[page] ?? [], page_context: { has_more_page: page < 2 } } };
  };
  const found = await findPurchaseOrdersByReference(send, REF);
  assert.deepEqual(found.matches.map((po) => po.id), ["B"]);
  assert.equal(found.complete, true);
});

test("a reference filter Zoho refuses does not stop the search: the walk still answers", async () => {
  const send: ZohoSend = async (_resource, _method, _body, query = {}) => {
    if (query["reference_number"]) return { status: 400, body: { code: 2, message: "Invalid value passed for reference_number" } };
    return { status: 200, body: { code: 0, purchaseorders: [{ purchaseorder_id: "B", reference_number: REF, purchaseorder_number: "PO-B", status: "draft" }], page_context: { has_more_page: false } } };
  };
  const found = await findPurchaseOrdersByReference(send, REF);
  assert.deepEqual(found.matches.map((po) => po.id), ["B"]);
  assert.equal(found.complete, true);
  // Only page and per_page in the walk, the two parameters Zoho's docs list.
  const queries: Record<string, string>[] = [];
  await findPurchaseOrdersByReference(async (_r, _m, _b, query = {}) => { queries.push(query); return { status: 200, body: { code: 0, purchaseorders: [], page_context: { has_more_page: false } } }; }, REF);
  assert.deepEqual(Object.keys(queries[1]!).sort(), ["page", "per_page"]);
});

test("a full page with no page details is not the end of the list", async () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ purchaseorder_id: `P${i}`, reference_number: "" }));
  const send: ZohoSend = async (_resource, _method, _body, query = {}) => {
    if (query["reference_number"]) return { status: 200, body: { code: 0, purchaseorders: [] } };
    return { status: 200, body: { code: 0, purchaseorders: query["page"] === "1" ? full : [{ purchaseorder_id: "B", reference_number: REF, status: "draft" }] } };
  };
  const found = await findPurchaseOrdersByReference(send, REF);
  assert.deepEqual(found.matches.map((po) => po.id), ["B"]);
  assert.equal(found.complete, true);
});

test("Zoho's copy is compared with what was confirmed", () => {
  const same = { vendor_id: "V1", location_id: "L1", sub_total: 420000, line_items: [{ item_id: "I1", rate: 4200, quantity: 100 }] };
  assert.deepEqual(poDifferences(plan(), same), []);
  const moved = poDifferences(plan(), { ...same, location_id: "HO", location_name: "Head Office", vendor_id: "V9", vendor_name: "Other", sub_total: 1, line_items: [{ item_id: "I9", name: "Sugar", rate: 5, quantity: 9 }, {}] });
  assert.equal(moved.length, 7, moved.join("\n"));
  assert.match(moved.join(" "), /Head Office/);
});

test("Zoho's GST is compared with what the admin was shown", () => {
  const copy = (tax: number) => ({ tax_total: tax, sub_total: 420000 });
  assert.deepEqual(poDifferences(plan({ gstPercent: 5 }), copy(21000)), []);
  assert.deepEqual(poDifferences(plan({ gstPercent: 5 }), copy(21000.5)), []);
  assert.match(poDifferences(plan({ gstPercent: 5 }), copy(0))[0]!, /GST is ₹0, not the ₹21000/);
  // Nothing was promised, so nothing to compare.
  assert.deepEqual(poDifferences(plan({ gstPercent: null }), copy(0)), []);
});

test("a deleted purchase order is told apart from a Zoho that could not be asked", async () => {
  const gone: ZohoSend = async () => ({ status: 404, body: { code: 1002, message: "Purchase order does not exist" } });
  assert.deepEqual(await readPoStatus(gone, "1"), { gone: true, status: "", subTotal: null, taxTotal: null, total: null });
  const down: ZohoSend = async () => { throw new Error("network"); };
  assert.equal(await readPoStatus(down, "1"), null);
  const busy: ZohoSend = async () => ({ status: 503, body: null });
  assert.equal(await readPoStatus(busy, "1"), null);
  const live: ZohoSend = async () => ({ status: 200, body: { code: 0, purchaseorder: { status: "open", sub_total: 10, tax_total: 1, total: 11 } } });
  assert.deepEqual(await readPoStatus(live, "1"), { gone: false, status: "open", subTotal: 10, taxTotal: 1, total: 11 });
});

test("Zoho's status names read plainly: open means issued", () => {
  assert.equal(zohoStatusLabel("open"), "Issued");
  assert.equal(zohoStatusLabel("draft"), "Draft");
  assert.equal(zohoStatusLabel("partially_received"), "Partly received");
  assert.equal(zohoStatusLabel("some_new_status"), "Some new status");
});

test("Open in Zoho goes to the right organisation and region", () => {
  assert.equal(zohoPoUrl("in", "60066526172", "99"), "https://inventory.zoho.in/app/60066526172#/purchaseorders/99");
  assert.equal(zohoPoUrl("com_au", "1", "2"), "https://inventory.zoho.com.au/app/1#/purchaseorders/2");
});

// ---------------------------------------------------------------- Units and figures

test("kg per Zoho unit comes from the unit, then the item's name, or a person must say", () => {
  assert.equal(kgPerZohoUnit("qtl", "Sugar"), 100);
  assert.equal(kgPerZohoUnit("Quintal", "Anything"), 100);
  assert.equal(kgPerZohoUnit("kg", "Rice"), 1);
  assert.equal(kgPerZohoUnit("MT", "Rice"), 1000);
  assert.equal(kgPerZohoUnit("", "Grade A Raw Rice 25kg"), 25);
  assert.equal(kgPerZohoUnit("bag", "Sona 26 KG"), 26);
  assert.equal(kgPerZohoUnit("pkt", "Long Grain Basumathi Rice"), null);
  assert.equal(kgPerZohoUnit("", "Rice"), null);
});

test("a purchase order line in quintals, kg and bags", () => {
  assert.deepEqual(planPoLine({ quantityQntl: 350, ratePerQntl: 5135, kgPerUnit: 100 }), { poQuantity: 350, poRate: 5135, subTotal: 1797250, exactTotal: 1797250 });
  assert.deepEqual(planPoLine({ quantityQntl: 100, ratePerQntl: 4200, kgPerUnit: 25 }), { poQuantity: 400, poRate: 1050, subTotal: 420000, exactTotal: 420000 });
  assert.deepEqual(planPoLine({ quantityQntl: 2.5, ratePerQntl: 4200, kgPerUnit: 1 }), { poQuantity: 250, poRate: 42, subTotal: 10500, exactTotal: 10500 });
  // Rounds on the decimal figure: 0.35 x 3716.5 is exactly 1300.775.
  assert.equal(planPoLine({ quantityQntl: 0.35, ratePerQntl: 3716.5, kgPerUnit: 100 }).subTotal, 1300.78);
  assert.equal(planPoLine({ quantityQntl: 1, ratePerQntl: 4227.5, kgPerUnit: 1 }).poRate, 42.28);
});

test("the figures that must stop a purchase order", () => {
  const ok = { quantityQntl: 100, ratePerQntl: 4200, kgPerUnit: 100, availableQntl: 120, unit: "qtl", itemName: "Rice bulk" };
  assert.equal(poLineProblem(ok), null);
  assert.match(poLineProblem({ ...ok, quantityQntl: 0 })!, /quantity/);
  assert.match(poLineProblem({ ...ok, ratePerQntl: 0 })!, /price/);
  assert.match(poLineProblem({ ...ok, kgPerUnit: 0 })!, /how many kg/);
  assert.match(poLineProblem({ ...ok, quantityQntl: 121 })!, /120 quintal available/);
  // 100 quintal does not divide into whole 26 kg bags: it says what does.
  assert.match(poLineProblem({ ...ok, kgPerUnit: 26, unit: "bag" })!, /384 units, which is 99\.84 quintal/);
  assert.equal(poLineProblem({ ...ok, quantityQntl: 99.84, kgPerUnit: 26, unit: "bag" }), null);
  assert.match(poLineProblem({ ...ok, quantityQntl: 0.1, kgPerUnit: 26, unit: "bag" })!, /less than one/);
  // A weight unit's size is fixed: a crafted size could raise a hundred times the rice at the same total.
  assert.match(poLineProblem({ ...ok, kgPerUnit: 1 })!, /One qtl is 100 kg, not 1 kg/);
  // A bag item's own name decides its size.
  assert.match(poLineProblem({ ...ok, quantityQntl: 13, kgPerUnit: 26, unit: "", itemName: "Grade A Raw Rice 25kg" })!, /says 25 kg, not 26 kg/);
  assert.equal(poLineProblem({ ...ok, quantityQntl: 100, kgPerUnit: 25, unit: "", itemName: "Grade A Raw Rice 25kg" }), null);
  // A rate that cannot be held in paise per kg over a large quantity moves the total.
  assert.match(poLineProblem({ ...ok, quantityQntl: 100, ratePerQntl: 4227.5, kgPerUnit: 1, unit: "kg" })!, /Rounding/);
});

test("a price in the wrong unit is caught while typing", () => {
  assert.match(priceUnitWarning(42)!, /per kg/);
  assert.match(priceUnitWarning(42)!, /4200/);
  assert.match(priceUnitWarning(1100)!, /not per bag/);
  assert.match(priceUnitWarning(420000)!, /check the figure/);
  assert.equal(priceUnitWarning(4200), null);
  assert.equal(priceUnitWarning(1500), null);
  assert.equal(priceUnitWarning(20000), null);
  assert.equal(priceUnitWarning(0), null);
});

// ---------------------------------------------------------------- Samples: sorting and comparing

const sample = (id: string, price: number, arrival: string): RiceSample => ({
  id, sample_no: 1, arrival_date: arrival, variety: "Sona", method: "", price_per_qntl: price, quantity_qntl: 10, party_role: "broker", party_name: "B", party_phone: "9000000000", seller_name: "", notes: "",
  status: "tested", status_reason: "", status_changed_at: "", created_by_name: "", created_at: "", updated_at: "",
});
const cooked = (sampleId: string, score: number, at: string): RiceTest => ({ id: `${sampleId}-${at}`, sample_id: sampleId, tested_at: at, tested_by_name: "T", score, grain: "separate", swelling: "good", taste: "good", broken: "few", notes: "", recorded_at: at });

test("the newest test decides the score, and the earlier one is kept", () => {
  const tests = [cooked("a", 9, "2026-11-01T10:00:00Z"), cooked("a", 4, "2026-11-02T10:00:00Z")];
  assert.equal(latestTest(tests)?.score, 4);
  assert.equal(testsBySample(tests).get("a")?.length, 2);
  assert.equal(testsBySample(tests).get("a")?.[0]?.score, 4);
  assert.equal(latestTest([]), null);
});

test("sorting by score, price and arrival; untested last on score", () => {
  const list = [sample("a", 4000, "2026-11-01"), sample("b", 3500, "2026-11-03"), sample("c", 4500, "2026-11-02"), sample("d", 3000, "2026-10-30")];
  const tests = testsBySample([cooked("a", 8, "2026-11-02T00:00:00Z"), cooked("b", 6, "2026-11-02T00:00:00Z"), cooked("c", 8, "2026-11-02T00:00:00Z")]);
  const ids = (sort: "score" | "price" | "arrival_new" | "arrival_old") => sortSamples(list, sort, tests).map((row) => row.id).join("");
  assert.equal(ids("score"), "acbd"); // a and c tie on 8; a is cheaper
  assert.equal(ids("price"), "dbac");
  assert.equal(ids("arrival_new"), "bcad");
  assert.equal(ids("arrival_old"), "dacb");
  assert.deepEqual(list.map((row) => row.id), ["a", "b", "c", "d"]); // the input is left alone
  // Whatever the sort, what can still be bought comes first.
  const gone = [{ ...list[0]!, status: "discarded" as const }, ...list.slice(1)];
  assert.equal(sortSamples(gone, "score", tests).map((row) => row.id).join(""), "cbda");
  assert.equal(sortSamples(gone, "price", tests).map((row) => row.id).join(""), "dbca");
});

test("side by side marks the best price and score, including ties, but never a lone figure", () => {
  const list = [sample("a", 4000, "2026-11-01"), sample("b", 3500, "2026-11-03"), sample("c", 3500, "2026-11-02")];
  const tests = testsBySample([cooked("a", 8, "2026-11-02T00:00:00Z"), cooked("b", 8, "2026-11-02T00:00:00Z"), cooked("c", 5, "2026-11-02T00:00:00Z")]);
  const best = bestInComparison(list, tests);
  assert.deepEqual([...best.bestPrice].sort(), ["b", "c"]);
  assert.deepEqual([...best.bestScore].sort(), ["a", "b"]);
  assert.equal(bestInComparison(list, testsBySample([cooked("a", 8, "2026-11-02T00:00:00Z")])).bestScore.size, 0);
  assert.equal(bestInComparison([sample("a", 4000, "2026-11-01")], new Map()).bestPrice.size, 0);
});

test("side by side never calls a sample best if it cannot be bought or tasted off", () => {
  const gone = { ...sample("a", 1000, "2026-11-01"), status: "unavailable" as const };
  const tests = testsBySample([cooked("a", 10, "2026-11-02T00:00:00Z"), { ...cooked("b", 9, "2026-11-02T00:00:00Z"), taste: "off" as const }, cooked("c", 5, "2026-11-02T00:00:00Z"), cooked("d", 4, "2026-11-02T00:00:00Z")]);
  const best = bestInComparison([gone, sample("b", 3000, "2026-11-01"), sample("c", 4000, "2026-11-01"), sample("d", 5000, "2026-11-01")], tests);
  assert.deepEqual([...best.bestPrice], ["b"]);
  assert.deepEqual([...best.bestScore], ["c"]);
});

test("variety and method choices come from earlier samples, as plain text", () => {
  assert.deepEqual(riceTextOptions([{ variety: " Sona ", method: "Raw" }, { variety: "Sona", method: "" }, { variety: "HMT", method: "Steam" }]), { varieties: ["HMT", "Sona"], methods: ["Raw", "Steam"] });
});

test("tap to call and WhatsApp add India's code to a 10-digit number", () => {
  assert.deepEqual(phoneLinks("90000 00001"), { tel: "tel:+919000000001", whatsapp: "https://wa.me/919000000001" });
  assert.deepEqual(phoneLinks("919000000001"), { tel: "tel:+919000000001", whatsapp: "https://wa.me/919000000001" });
  assert.deepEqual(phoneLinks("09000000001"), { tel: "tel:+919000000001", whatsapp: "https://wa.me/919000000001" });
});

// ---------------------------------------------------------------- Vendors and items

test("vendor search: same phone first, and customers are marked as not usable", () => {
  const matches = vendorMatchesFrom([
    { contact_id: "1", contact_name: "Ravi Traders", contact_type: "vendor", status: "active", mobile: "+91-9111111111" },
    { contact_id: "2", contact_name: "Other Name", contact_type: "vendor", status: "active", phone: "+91-9000000001" },
    { contact_id: "3", contact_name: "Ravi", contact_type: "customer", status: "active", phone: "+91-9000000001" },
    { contact_id: "2", contact_name: "Other Name", contact_type: "vendor", status: "active", phone: "+91-9000000001" },
  ], "Ravi", "90000 00001");
  assert.deepEqual(matches.map((match) => match.id), ["2", "1", "3"]);
  assert.equal(matches[0]!.byPhone, true);
  assert.equal(matches[1]!.byName, true);
  assert.equal(matches[2]!.contactType, "customer");
});

test("items read like the live ones: no unit on bag items, qtl on bulk", () => {
  const bag = itemMatchFrom({ item_id: "1", name: "Grade A Raw Rice 25kg", unit: "", status: "active", hsn_or_sac: "100630", item_tax_preferences: [{ tax_percentage: 5, tax_id: "x" }] });
  assert.deepEqual([bag.kgPerUnit, bag.gstLabel, bag.hsn, bag.active, bag.canBePurchased], [25, "5%", "100630", true, true]);
  const bulk = itemMatchFrom({ item_id: "2", name: "Sugar", unit: "qtl", status: "active", purchase_rate: 4050 });
  assert.deepEqual([bulk.kgPerUnit, bulk.purchaseRate, bulk.gstLabel], [100, 4050, ""]);
  assert.equal(itemMatchFrom({ item_id: "3", name: "Old", status: "inactive", can_be_purchased: false }).active, false);
});

test("a new vendor is a vendor, unregistered unless a GSTIN is given", () => {
  const plain = vendorBody({ name: "Ravi Kumar", phone: "+91 90000 00001", gstin: "", placeOfContact: "KA" });
  assert.deepEqual([plain["contact_type"], plain["gst_treatment"], plain["place_of_contact"], "gst_no" in plain], ["vendor", "business_none", "KA", false]);
  assert.deepEqual((plain["contact_persons"] as Record<string, unknown>[])[0], { first_name: "Ravi", last_name: "Kumar", phone: "9000000001", mobile: "9000000001", is_primary_contact: true });
  assert.deepEqual((vendorBody({ name: "Mill", phone: "", gstin: "", placeOfContact: "KA" })["contact_persons"] as Record<string, unknown>[])[0], { first_name: "Mill", last_name: "", is_primary_contact: true });
  const registered = vendorBody({ name: "M", phone: "9000000001", gstin: "29ABCDE1234F1Z5", placeOfContact: "KA" });
  assert.deepEqual([registered["gst_treatment"], registered["gst_no"]], ["business_gst", "29ABCDE1234F1Z5"]);
});

test("a new item follows the client's bulk item, and tax comes only from an exact match", () => {
  const body = itemBody({ name: " Sona Steam ", unit: "qtl", hsn: "100630", purchaseRate: 4200, taxPreferences: null });
  assert.deepEqual([body["name"], body["unit"], body["item_type"], body["product_type"], body["purchase_rate"], body["purchase_description"]], ["Sona Steam", "qtl", "inventory", "goods", 4200, "QUINTAL PRICE"]);
  assert.equal("item_tax_preferences" in body, false);
  const taxes = [{ tax_id: "1", tax_name: "GST5", tax_percentage: 5 }, { tax_id: "2", tax_name: "IGST5", tax_percentage: 5 }, { tax_id: "3", tax_name: "GST18", tax_percentage: 18 }];
  assert.deepEqual(gstPreferencesFrom(taxes, 5), [{ tax_id: "1", tax_specification: "intra" }, { tax_id: "2", tax_specification: "inter" }]);
  assert.equal(gstPreferencesFrom([...taxes, { tax_id: "4", tax_name: "GST5 old", tax_percentage: 5 }], 5), null);
  assert.equal(gstPreferencesFrom(taxes, 12), null);
});

function memoryCreations() {
  const rows = new Map<string, { state: string; attempt: string; zohoId: string; claimedAt: number }>();
  let clock = Date.now();
  const store: CreationStore = {
    async claim({ key, attemptId }) {
      const row = rows.get(key);
      if (!row) { rows.set(key, { state: "sending", attempt: attemptId, zohoId: "", claimedAt: clock }); return { outcome: "claimed" }; }
      if (row.state === "done") return { outcome: "done", zoho_id: row.zohoId, attempt_id: row.attempt };
      if (row.state === "sending" && clock - row.claimedAt < 120_000) return { outcome: "in_progress", by: ACTOR.name };
      if (row.state === "sending" || row.state === "uncertain") return { outcome: "verify_first", attempt_id: row.attempt };
      Object.assign(row, { state: "sending", attempt: attemptId, claimedAt: clock });
      return { outcome: "claimed" };
    },
    async takeover({ key, expectedAttempt, attemptId }) {
      const row = rows.get(key);
      if (!row || row.attempt !== expectedAttempt) return { outcome: "changed" };
      const wait = 120 - Math.floor((clock - row.claimedAt) / 1000);
      if (wait > 0) return { outcome: "too_soon", wait_seconds: wait };
      Object.assign(row, { state: "sending", attempt: attemptId, zohoId: "", claimedAt: clock });
      return { outcome: "claimed", attempts: 2 };
    },
    async finish({ key, attemptId, state, zohoId }) {
      const row = rows.get(key);
      if (row && row.attempt === attemptId) Object.assign(row, { state, zohoId });
    },
  };
  return { store, age: (seconds: number) => { clock += seconds * 1000; } };
}

const creating = (findExact: () => Promise<string | null>) => ({ name: "Ravi Traders", body: { contact_name: "Ravi Traders" }, resource: "contacts", idField: "contact_id", responseKey: "contact", findExact });

test("creating a vendor: one POST, and a name Zoho already has is never created", async () => {
  const { store } = memoryCreations();
  let posts = 0;
  const send: ZohoSend = async () => { posts += 1; return { status: 201, body: { code: 0, contact: { contact_id: "C1" } } }; };
  const created = await createInZohoOnce({ store, zoho: send, newId: () => `n${ids += 1}` }, "vendor", creating(async () => null), ACTOR);
  assert.deepEqual(created, { kind: "created", id: "C1" });
  assert.equal(posts, 1);
  const exists = await createInZohoOnce({ store, zoho: send, newId: () => `n${ids += 1}` }, "vendor", creating(async () => "C1"), ACTOR);
  assert.equal(exists.kind, "exists");
  assert.equal(posts, 1);
  assert.equal(nameKey("  RAVI   traders "), "ravi traders");
});

test("creating at the same moment: the second is told it is in progress", async () => {
  const { store } = memoryCreations();
  let posts = 0;
  const send: ZohoSend = async () => { posts += 1; return { status: 201, body: { code: 0, contact: { contact_id: "C1" } } }; };
  const deps2 = { store, zoho: send, newId: () => `n${ids += 1}` };
  const results = await Promise.all([createInZohoOnce(deps2, "vendor", creating(async () => null), ACTOR), createInZohoOnce(deps2, "vendor", creating(async () => null), ACTOR)]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["created", "in_progress"]);
  assert.equal(posts, 1);
});

test("creating with no clear answer: found again by name, or locked until it is safe", async () => {
  const landed = memoryCreations();
  let found: string | null = null;
  const lost: ZohoSend = async () => { found = "C7"; throw new Error("timeout"); };
  const first = await createInZohoOnce({ store: landed.store, zoho: lost, newId: () => `n${ids += 1}` }, "vendor", creating(async () => found), ACTOR);
  assert.deepEqual(first, { kind: "created", id: "C7" });

  const nothing = memoryCreations();
  const dead: ZohoSend = async () => { throw new Error("timeout"); };
  const deps3 = { store: nothing.store, zoho: dead, newId: () => `n${ids += 1}` };
  assert.equal((await createInZohoOnce(deps3, "item", creating(async () => null), ACTOR)).kind, "uncertain");
  assert.equal((await createInZohoOnce(deps3, "item", creating(async () => null), ACTOR)).kind, "uncertain"); // too soon
  nothing.age(121);
  const ok: ZohoSend = async () => ({ status: 201, body: { code: 0, contact: { contact_id: "C8" } } });
  assert.deepEqual(await createInZohoOnce({ ...deps3, zoho: ok }, "item", creating(async () => null), ACTOR), { kind: "created", id: "C8" });
});

test("creating when the name search misses but this website made it: the stored ID is used, not a new one", async () => {
  const { store } = memoryCreations();
  let posts = 0, stillThere = true;
  const send: ZohoSend = async (resource, method) => {
    if (method === "POST") { posts += 1; return { status: 201, body: { code: 0, contact: { contact_id: `C${posts}` } } }; }
    return stillThere ? { status: 200, body: { code: 0, contact: { contact_id: resource.split("/")[1] } } } : { status: 404, body: { code: 1002, message: "does not exist" } };
  };
  const make = () => createInZohoOnce({ store, zoho: send, newId: () => `n${ids += 1}` }, "vendor", creating(async () => null), ACTOR);
  assert.deepEqual(await make(), { kind: "created", id: "C1" });
  const again = await make();
  assert.equal(again.kind, "exists");
  if (again.kind === "exists") assert.equal(again.id, "C1");
  assert.equal(posts, 1);
  // A failed check is not a licence to create another.
  stillThere = false;
  const blocked = createInZohoOnce({ store, zoho: async () => ({ status: 503, body: null }), newId: () => `n${ids += 1}` }, "vendor", creating(async () => null), ACTOR);
  assert.equal((await blocked).kind, "uncertain");
});

test("creating refused by Zoho: plain words, and it can be tried again", async () => {
  const { store } = memoryCreations();
  const refuse: ZohoSend = async () => ({ status: 400, body: { code: 3062, message: "The customer name already exists" } });
  const refused = await createInZohoOnce({ store, zoho: refuse, newId: () => `n${ids += 1}` }, "vendor", creating(async () => null), ACTOR);
  assert.equal(refused.kind, "rejected");
  if (refused.kind === "rejected") assert.match(refused.message, /already exists/);
  const ok: ZohoSend = async () => ({ status: 201, body: { code: 0, contact: { contact_id: "C9" } } });
  assert.equal((await createInZohoOnce({ store, zoho: ok, newId: () => `n${ids += 1}` }, "vendor", creating(async () => null), ACTOR)).kind, "created");
});
