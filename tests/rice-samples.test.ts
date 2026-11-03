import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestInComparison, canCancelPo, cancelRicePo, checkRicePo, createInZohoOnce, findPurchaseOrdersByReference, gstPreferencesFrom, itemBody, itemMatchFrom, kgPerZohoUnit, latestTest, nameKey, phoneLinks, planPoLine, plainZohoRefusal,
  differsFromRaised, OFF_LIST_CHECK_MS, poDeathReason, poTaxAmount, poTaxDifferences, poTaxFrom, poTaxLabel, poTaxReason, poDifferences, poLineProblem, poReference, retiredPoProblem, settleRaisedPo, syncRaisedPos, zohoSaysNoSuchPo, priceUnitWarning, purchaseOrderBody, raiseRicePo, readPoStatus, riceTextOptions, sortSamples, testsBySample, vendorBody, vendorMatchesFrom, zohoPoUrl, zohoStatusLabel, zohoVerdict,
  type ClaimAnswer, type CreationStore, type PoActor, type PoFound, type PoLifeStore, type PoPlan, type PoStore, type RaisedPo, type RecordAnswer, type RicePo, type RiceSample, type RiceTest, type ZohoRaw, type ZohoSend,
} from "../src/lib/rice-samples.ts";

const SAMPLE = "11111111-1111-4111-8111-111111111111";
const REF = poReference(SAMPLE);
const ACTOR: PoActor = { userId: "22222222-2222-4222-8222-222222222222", name: "Head Office" };

const plan = (patch: Partial<PoPlan> = {}): PoPlan => ({
  reference: REF, date: "2026-11-03", vendorRole: "broker", vendorId: "V1", vendorName: "Test Traders", itemId: "I1", itemName: "Rice bulk", itemUnit: "qtl", kgPerUnit: 100,
  quantityQntl: 100, ratePerQntl: 4200, poQuantity: 100, poRate: 4200, subTotal: 420000, gstPercent: null, branchId: "BR-CLK", branchName: "Challakere", locationId: "L1", issueOnCreate: false,
  description: "Sona Rice, Steam Rice. 100 quintal at Rs 4200 per quintal.", taxId: "T-GST5", taxName: "GST5", taxKind: "intra", sourceOfSupply: "KA", destinationOfSupply: "KA", ...patch,
});

let clockNow = () => Date.now();

// ---------------------------------------------------------------- The database's rules, in memory (the real ones are tested on PGlite)
function memoryStore(startedAgoSeconds = 0) {
  clockNow = () => state.clock;
  const state = { row: null as null | { state: string; attempt: string; attempts: number; claimedAt: number; snapshot: PoPlan; po?: RicePo; duplicates: PoFound[] }, clock: Date.now() };
  const poRow = (found: PoFound, totals: { total: number | null }): RicePo => ({
    sample_id: SAMPLE, reference: REF, state: "raised", generation: 1, retired_pos: [], attempt_id: state.row!.attempt, attempts: state.row!.attempts, snapshot: state.row!.snapshot, claimed_by_name: ACTOR.name,
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
      source_of_supply: body["source_of_supply"], destination_of_supply: body["destination_of_supply"],
      line_items: [{ item_id: line["item_id"], rate, quantity, unit: "qtl", item_total: rate * quantity, tax_id: line["tax_id"], name: line["name"] }], sub_total: rate * quantity, tax_total: rate * quantity * 0.05, total: rate * quantity * 1.05,
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
  const same = { vendor_id: "V1", location_id: "L1", sub_total: 420000, tax_total: 0, source_of_supply: "KA", destination_of_supply: "KA", line_items: [{ item_id: "I1", name: "Rice bulk", rate: 4200, quantity: 100, tax_id: "T-GST5" }] };
  assert.deepEqual(poDifferences(plan(), same), []);
  const moved = poDifferences(plan(), { ...same, location_id: "HO", location_name: "Head Office", vendor_id: "V9", vendor_name: "Other", sub_total: 1, line_items: [{ item_id: "I9", name: "Sugar", rate: 5, quantity: 9 }, {}] });
  assert.equal(moved.length, 8, moved.join("\n"));
  assert.match(moved.join(" "), /Head Office/);
});

test("Zoho's GST is compared with what the admin was shown", () => {
  const copy = (tax: number) => ({ tax_total: tax, sub_total: 420000, source_of_supply: "KA", destination_of_supply: "KA" });
  assert.deepEqual(poDifferences(plan({ gstPercent: 5 }), copy(21000)), []);
  assert.deepEqual(poDifferences(plan({ gstPercent: 5 }), copy(21000.5)), []);
  assert.match(poDifferences(plan({ gstPercent: 5 }), copy(0))[0]!, /GST is ₹0, not the ₹21000/);
  // Nothing was promised, so nothing to compare.
  assert.deepEqual(poDifferences(plan({ gstPercent: null }), copy(0)), []);
});

test("a deleted purchase order is told apart from a Zoho that could not be asked", async () => {
  const gone: ZohoSend = async () => ({ status: 404, body: { code: 1002, message: "Purchase order does not exist" } });
  assert.deepEqual(await readPoStatus(gone, "1"), { gone: true, status: "", deathReason: null, subTotal: null, taxTotal: null, total: null });
  const down: ZohoSend = async () => { throw new Error("network"); };
  assert.equal(await readPoStatus(down, "1"), null);
  const busy: ZohoSend = async () => ({ status: 503, body: null });
  assert.equal(await readPoStatus(busy, "1"), null);
  const live: ZohoSend = async () => ({ status: 200, body: { code: 0, purchaseorder: { status: "open", sub_total: 10, tax_total: 1, total: 11 } } });
  assert.deepEqual(await readPoStatus(live, "1"), { gone: false, status: "open", deathReason: null, subTotal: 10, taxTotal: 1, total: 11 });
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
  status: "tested", status_reason: "", status_changed_at: "", created_by_name: "", created_at: "", updated_at: "", deleted_at: null, deleted_by_name: "", deleted_reason: "",
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

// ---------------------------------------------------------------- The tax on a purchase order

/** Shaped as the live item and vendors read on 3 Nov 2026, with made-up IDs. */
const taxItem = (patch: Record<string, unknown> = {}) => ({
  item_id: "I1", name: "Rice bulk", is_taxable: true,
  item_tax_preferences: [
    { tax_specification: "inter", tax_specific_type: "igst", tax_name: "IGST5", tax_percentage: 5, tax_id: "T-IGST5", new_tax_type: "tax", tax_groups_details: [] },
    { tax_specification: "intra", tax_specific_type: "tax", tax_name: "GST5", tax_percentage: 5, tax_id: "T-GST5", new_tax_type: "tax_group", tax_groups_details: [{ text: "CGST2.5", percentage: 2.5, tax_specific_type: "cgst" }, { text: "SGST2.5", percentage: 2.5, tax_specific_type: "sgst" }] },
  ], ...patch,
});
const taxVendor = (patch: Record<string, unknown> = {}) => ({ contact_id: "V1", contact_name: "Test Traders", gst_treatment: "business_gst", gst_no: "29ABCDE1234F1Z5", place_of_contact: "KA", ...patch });
const CLK = { name: "Challakere", stateCode: "29" };
const stops = (answer: ReturnType<typeof poTaxFrom>, pattern: RegExp) => {
  assert.equal(answer.ok, false, "should have stopped");
  if (!answer.ok) assert.match(answer.message, pattern);
};

test("tax: vendor and godown in the same state take the item's CGST + SGST group", () => {
  assert.deepEqual(poTaxFrom(taxItem(), taxVendor(), CLK), { ok: true, tax: { taxId: "T-GST5", taxName: "GST5", percent: 5, kind: "intra", parts: ["CGST2.5", "SGST2.5"], sourceOfSupply: "KA", destinationOfSupply: "KA" } });
});

test("tax: a vendor in another state takes the item's IGST", () => {
  const answer = poTaxFrom(taxItem(), taxVendor({ gst_no: "27ABCDE1234F1Z5", place_of_contact: "MH" }), CLK);
  assert.deepEqual(answer, { ok: true, tax: { taxId: "T-IGST5", taxName: "IGST5", percent: 5, kind: "inter", parts: [], sourceOfSupply: "MH", destinationOfSupply: "KA" } });
});

test("tax: the rate is the item's own, whatever it is, never assumed", () => {
  const eighteen = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST18", tax_percentage: 18, tax_id: "T-GST18" }, { tax_specification: "inter", tax_name: "IGST18", tax_percentage: 18, tax_id: "T-IGST18" }] });
  const answer = poTaxFrom(eighteen, taxVendor(), CLK);
  assert.equal(answer.ok && answer.tax.percent, 18);
  assert.equal(answer.ok && answer.tax.taxId, "T-GST18");
});

test("tax: 0% set on the item itself is an answer, so the confirm screen can say so", () => {
  const nil = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST0", tax_percentage: 0, tax_id: "T-GST0" }, { tax_specification: "inter", tax_name: "IGST0", tax_percentage: 0, tax_id: "T-IGST0" }] });
  const answer = poTaxFrom(nil, taxVendor(), CLK);
  assert.equal(answer.ok && answer.tax.percent, 0);
  assert.equal(answer.ok && answer.tax.taxId, "T-GST0");
});

test("tax: stops when the vendor isn't shown as GST-registered", () => {
  stops(poTaxFrom(taxItem(), taxVendor({ gst_treatment: "business_none", gst_no: "" }), CLK), /isn't shown as GST-registered/);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_treatment: "business_gst", gst_no: "" }), CLK), /isn't shown as GST-registered/);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_treatment: "overseas" }), CLK), /isn't shown as GST-registered/);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_treatment: undefined }), CLK), /isn't shown as GST-registered/);
});

test("tax: stops when the vendor's state is missing or disagrees with their GSTIN", () => {
  stops(poTaxFrom(taxItem(), taxVendor({ place_of_contact: "" }), CLK), /no state for Test Traders/);
  stops(poTaxFrom(taxItem(), taxVendor({ place_of_contact: "MH" }), CLK), /GSTIN is from Karnataka, but Zoho has them in Maharashtra/);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_no: "99ABCDE1234F1Z5" }), CLK), /GSTIN is from an unknown state/);
});

test("tax: stops when the godown has no state", () => {
  stops(poTaxFrom(taxItem(), taxVendor(), { name: "Hubli", stateCode: "" }), /Hubli has no state on record/);
  stops(poTaxFrom(taxItem(), taxVendor(), { name: "Hubli", stateCode: "99" }), /Hubli has no state on record/);
});

test("tax: stops when the item's tax for this route isn't there", () => {
  stops(poTaxFrom(taxItem({ item_tax_preferences: [] }), taxVendor(), CLK), /no tax for purchases within the state/);
  stops(poTaxFrom(taxItem({ item_tax_preferences: undefined }), taxVendor(), CLK), /no tax for purchases within the state/);
  const interOnly = taxItem({ item_tax_preferences: [{ tax_specification: "inter", tax_name: "IGST5", tax_percentage: 5, tax_id: "T" }] });
  stops(poTaxFrom(interOnly, taxVendor(), CLK), /no tax for purchases within the state/);
  const intraOnly = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST5", tax_percentage: 5, tax_id: "T" }] });
  stops(poTaxFrom(intraOnly, taxVendor({ gst_no: "27ABCDE1234F1Z5", place_of_contact: "MH" }), CLK), /no tax for purchases from another state/);
  for (const broken of [{ tax_id: "" }, { tax_name: "" }, { tax_percentage: "" }, { tax_percentage: null }, { tax_percentage: "five" }, { tax_percentage: -5 }]) {
    stops(poTaxFrom(taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST5", tax_percentage: 5, tax_id: "T", ...broken }] }), taxVendor(), CLK), /no tax for purchases/);
  }
});

test("tax: stops when the item is marked not taxable", () => {
  stops(poTaxFrom(taxItem({ is_taxable: false }), taxVendor(), CLK), /not taxable/);
});

test("tax: stops when the item's taxes contradict each other", () => {
  const swapped = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "IGST5", tax_percentage: 5, tax_id: "T1" }, { tax_specification: "inter", tax_name: "GST5", tax_percentage: 5, tax_id: "T2" }] });
  stops(poTaxFrom(swapped, taxVendor(), CLK), /IGST5 in Zoho, which doesn't look right/);
  stops(poTaxFrom(swapped, taxVendor({ gst_no: "27ABCDE1234F1Z5", place_of_contact: "MH" }), CLK), /GST5 in Zoho, which doesn't look right/);
  const differ = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST5", tax_percentage: 5, tax_id: "T1" }, { tax_specification: "inter", tax_name: "IGST18", tax_percentage: 18, tax_id: "T2" }] });
  stops(poTaxFrom(differ, taxVendor(), CLK), /5% within the state but 18% from another state/);
  const parts = taxItem({ item_tax_preferences: [{ tax_specification: "intra", tax_name: "GST5", tax_percentage: 5, tax_id: "T1", tax_groups_details: [{ text: "CGST9", percentage: 9 }, { text: "SGST9", percentage: 9 }] }] });
  stops(poTaxFrom(parts, taxVendor(), CLK), /doesn't add up to 5%/);
});

test("tax: the words on the confirm screen", () => {
  const within = { taxName: "GST5", parts: ["CGST2.5", "SGST2.5"], kind: "intra" as const, sourceOfSupply: "KA", destinationOfSupply: "KA" };
  assert.equal(poTaxLabel(within), "GST5 (CGST2.5 + SGST2.5)");
  assert.equal(poTaxReason(within), "CGST + SGST, because the vendor and the godown are both in Karnataka.");
  const across = { taxName: "IGST5", parts: [], kind: "inter" as const, sourceOfSupply: "MH", destinationOfSupply: "KA" };
  assert.equal(poTaxLabel(across), "IGST5");
  assert.equal(poTaxReason(across), "IGST, because the vendor is in Maharashtra and the godown in Karnataka.");
  assert.equal(poTaxAmount(420000, 5), 21000);
  assert.equal(poTaxAmount(1255.5, 5), 62.78);
});

test("tax: the purchase order carries the tax and both states", () => {
  const body = purchaseOrderBody(plan());
  assert.equal(body["source_of_supply"], "KA");
  assert.equal(body["destination_of_supply"], "KA");
  assert.equal((body["line_items"] as Record<string, unknown>[])[0]!["tax_id"], "T-GST5");
  const across = purchaseOrderBody(plan({ taxId: "T-IGST5", sourceOfSupply: "MH" }));
  assert.equal(across["source_of_supply"], "MH");
  assert.equal((across["line_items"] as Record<string, unknown>[])[0]!["tax_id"], "T-IGST5");
});

test("tax: a purchase order with no tax worked out is never sent", async () => {
  let asked = 0;
  const store = new Proxy({}, { get: () => () => { asked += 1; throw new Error("the lock must not be touched"); } }) as PoStore;
  const zoho: ZohoSend = async () => { asked += 1; throw new Error("Zoho must not be called"); };
  const result = await raiseRicePo({ store, zoho, newId: () => "x", now: () => 0 }, SAMPLE, plan({ taxId: undefined }), ACTOR);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.match(result.message, /nothing was sent/);
  assert.equal(asked, 0);
});

test("tax: says so when Zoho's reply differs from what was shown", () => {
  const reply = (patch: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({ tax_total: 21000, sub_total: 420000, source_of_supply: "KA", destination_of_supply: "KA", line_items: [{ name: "Rice bulk", tax_id: "T-GST5", tax_name: "GST5", ...line }], ...patch });
  const shown = plan({ gstPercent: 5 });
  assert.deepEqual(poDifferences(shown, reply()), []);
  // What happened on the first live purchase order.
  assert.match(poDifferences(shown, reply({ tax_total: 0 }))[0]!, /GST is ₹0, not the ₹21000 \(5%\)/);
  assert.match(poDifferences(shown, reply({}, { tax_id: "T-IGST5", tax_name: "IGST5" }))[0]!, /Zoho put IGST5 on this line, not GST5/);
  assert.match(poDifferences(shown, reply({ source_of_supply: "MH" }))[0]!, /vendor's state as Maharashtra, not Karnataka/);
  assert.match(poDifferences(shown, reply({ destination_of_supply: "GA" }))[0]!, /delivery state as Goa, not Karnataka/);
  assert.match(poDifferences(shown, reply({ tax_total: undefined }))[0]!, /doesn't show the GST/);
  assert.match(poDifferences(shown, reply({}, { tax_id: "", tax_name: "" }))[0]!, /line shows no tax, not GST5/);
  assert.match(poDifferences(shown, reply({ source_of_supply: "" }))[0]!, /vendor's state as blank/);
  assert.match(poDifferences(shown, reply({ destination_of_supply: undefined }))[0]!, /delivery state as blank/);
  // The same amount by the wrong route is still wrong.
  assert.equal(poDifferences(shown, reply({}, { tax_id: "T-IGST5", tax_name: "IGST5" })).length, 1);
  assert.deepEqual(poTaxDifferences(shown, reply()), []);
});

test("tax: stops on a GSTIN that isn't one", () => {
  stops(poTaxFrom(taxItem(), taxVendor({ gst_no: "29" }), CLK), /doesn't look right/);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_no: "29ABC" }), CLK), /doesn't look right/);
});

test("tax: Zoho's other code for a state isn't a false alarm, and its own code is what gets sent", () => {
  const answer = poTaxFrom(taxItem(), taxVendor({ gst_no: "22ABCDE1234F1Z5", place_of_contact: "CG" }), CLK);
  assert.equal(answer.ok && answer.tax.kind, "inter");
  assert.equal(answer.ok && answer.tax.sourceOfSupply, "CG");
  assert.equal(poTaxFrom(taxItem(), taxVendor({ gst_no: "22ABCDE1234F1Z5", place_of_contact: "CT" }), CLK).ok, true);
  stops(poTaxFrom(taxItem(), taxVendor({ gst_no: "22ABCDE1234F1Z5", place_of_contact: "OD" }), CLK), /Correct it in Zoho/);
});

test("tax: an already raised purchase order with another tax is called out", () => {
  const saved = plan({ taxId: "T-IGST5", taxName: "IGST5" });
  assert.match(differsFromRaised(saved, plan())[0]!, /tax IGST5/);
  assert.deepEqual(differsFromRaised(plan({ taxId: undefined }), plan()), []);
});

/** A Zoho that holds one purchase order under this reference, found by a search after an earlier send got no clear answer. */
function earlierSendZoho(saved: Record<string, unknown> | null) {
  const row = { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", reference_number: REF, status: "draft" };
  const send: ZohoSend = async (resource) => {
    if (resource === "purchaseorders") return { status: 200, body: { code: 0, purchaseorders: [row], page_context: { has_more_page: false } } };
    return saved ? { status: 200, body: { code: 0, purchaseorder: { ...row, ...saved } } } : { status: 503, body: null };
  };
  return send;
}
const earlierAttempt = (snapshot: PoPlan, recorded: { differences?: string[] }): PoStore => ({
  claim: async () => ({ outcome: "verify_first", attempt_id: "A1", claimed_at: new Date(0).toISOString(), snapshot, attempts: 1 }),
  takeover: async () => { throw new Error("must not send again"); },
  release: async () => { throw new Error("no"); },
  markFailed: async () => undefined,
  record: async ({ po, differences }) => { recorded.differences = differences; return { outcome: "recorded", po: { zoho_po_id: po.id, zoho_po_number: po.number, zoho_po_status: po.status, zoho_total: null } as RicePo }; },
});

test("tax: a purchase order found from an earlier attempt is held to the tax just confirmed, even if that attempt recorded none", async () => {
  const recorded: { differences?: string[] } = {};
  const old = plan({ taxId: undefined, taxName: undefined, sourceOfSupply: undefined, destinationOfSupply: undefined, gstPercent: null });
  const result = await raiseRicePo({ store: earlierAttempt(old, recorded), zoho: earlierSendZoho({ sub_total: 420000, tax_total: 0, line_items: [{}], source_of_supply: "KA", destination_of_supply: "KA" }), newId: () => "x", now: () => 10 ** 13 }, SAMPLE, plan({ gstPercent: 5 }), ACTOR);
  assert.equal(result.kind, "raised");
  assert.match(recorded.differences!.join(" "), /GST is ₹0, not the ₹21000/);
});

test("tax: when Zoho's copy can't be read, it says the comparison didn't happen", async () => {
  const recorded: { differences?: string[] } = {};
  const result = await raiseRicePo({ store: earlierAttempt(plan(), recorded), zoho: earlierSendZoho(null), newId: () => "x", now: () => 10 ** 13 }, SAMPLE, plan(), ACTOR);
  assert.equal(result.kind, "raised");
  assert.match(recorded.differences!.join(" "), /could not be read, so its figures and GST were not compared/);
});

test("tax: a new draft is compared with what Zoho saved, not only with its reply", async () => {
  const recorded: { differences?: string[] } = {};
  const store: PoStore = { ...earlierAttempt(plan(), recorded), claim: async () => ({ outcome: "claimed", attempts: 1 }) };
  const calls: string[] = [];
  const zoho: ZohoSend = async (resource, method) => {
    calls.push(`${method} ${resource}`);
    if (method === "POST") return { status: 201, body: { code: 0, purchase_order: { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", status: "draft", tax_total: 21000, source_of_supply: "KA", destination_of_supply: "KA", line_items: [{ tax_id: "T-GST5" }] } } };
    return { status: 200, body: { code: 0, purchaseorder: { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", status: "draft", tax_total: 0, source_of_supply: "KA", destination_of_supply: "KA", line_items: [{ tax_id: "" }] } } };
  };
  await raiseRicePo({ store, zoho, newId: () => "x", now: () => 0 }, SAMPLE, plan({ gstPercent: 5 }), ACTOR);
  assert.deepEqual(calls, ["POST purchaseorders", "GET purchaseorders/P1"]);
  assert.match(recorded.differences!.join(" "), /GST is ₹0/);
  assert.match(recorded.differences!.join(" "), /line shows no tax/);
});

test("tax: a purchase order raised before this has no tax on record, and none of this applies to it", () => {
  assert.deepEqual(poDifferences(plan({ taxId: undefined, taxName: undefined, sourceOfSupply: undefined, destinationOfSupply: undefined }), { sub_total: 420000, source_of_supply: "MH", line_items: [{ name: "Rice bulk", tax_id: "T" }] }), []);
});

// ---------------------------------------------------------------- After raising: staying in step with Zoho

/** A small Zoho: purchase orders by ID, as the live list and read answered on 3 Nov 2026. */
function liveZoho(orders: Record<string, Record<string, unknown>>, options: { listFails?: boolean; readFails?: boolean; cancel?: "ok" | "refuse" | "lost" | "ignored" } = {}) {
  const calls: string[] = [];
  const send: ZohoSend = async (resource, method, _body, query = {}) => {
    calls.push(`${method} ${resource}`);
    const cancel = /^purchaseorders\/([^/]+)\/status\/cancelled$/.exec(resource);
    if (cancel) {
      if (options.cancel === "refuse") return { status: 400, body: { code: 36, message: "A draft cannot be marked as cancelled." } };
      if (options.cancel === "lost") { orders[cancel[1]!]!["status"] = "cancelled"; throw new Error("timed out"); }
      if (options.cancel !== "ignored") orders[cancel[1]!]!["status"] = "cancelled";
      return { status: 200, body: { code: 0, message: "The purchase order has been marked as cancelled." } };
    }
    const one = /^purchaseorders\/([^/]+)$/.exec(resource);
    if (one) {
      if (options.readFails) return { status: 503, body: null };
      const order = orders[one[1]!];
      return order ? { status: 200, body: { code: 0, purchaseorder: { purchaseorder_id: one[1], ...order } } } : { status: 404, body: { code: 1002, message: "Purchase Order does not exist." } };
    }
    if (options.listFails) return { status: 502, body: null };
    const rows = Object.entries(orders).map(([id, order]) => ({ purchaseorder_id: id, ...order }));
    const wanted = query["reference_number"];
    return { status: 200, body: { code: 0, purchaseorders: wanted ? rows.filter((row) => row["reference_number"] === wanted) : rows, page_context: { has_more_page: false } } };
  };
  return { send, calls };
}
const raised = (patch: Partial<RaisedPo> = {}): RaisedPo => ({ sample_id: SAMPLE, reference: REF, zoho_po_id: "P1", zoho_po_number: "CLK-PO-1", zoho_po_status: "draft", duplicates: [], retired_pos: [], ...patch });
function lifeStore() {
  const refreshed: Parameters<PoLifeStore["refresh"]>[0][] = [];
  const dead: Parameters<PoLifeStore["markDead"]>[0][] = [];
  const asked: Parameters<PoLifeStore["cancelAsked"]>[0][] = [];
  const store: PoLifeStore = {
    refresh: async (args) => { refreshed.push(args); },
    markDead: async (args) => { dead.push(args); return { outcome: dead.length === 1 ? "freed" : "changed" }; },
    cancelAsked: async (args) => { asked.push(args); },
  };
  return { store, refreshed, dead, asked };
}

test("Zoho's dead statuses, and only those, mean dead", () => {
  for (const status of ["cancelled", "Cancelled", "canceled", "cancelled_by_user", "cancelled_by_vendor", "void", "voided"]) assert.equal(poDeathReason(status), "cancelled", status);
  assert.equal(poDeathReason("rejected"), "rejected");
  assert.equal(poDeathReason("open", "cancelled"), "cancelled");
  assert.equal(poDeathReason("draft", "rejected"), "rejected");
  // Rice received or billed outranks whatever order_status says.
  for (const status of ["billed", "partially_billed", "received", "closed"]) assert.equal(poDeathReason(status, "cancelled"), null, status);
  // Live statuses and anything unknown keep the lock.
  for (const status of ["draft", "open", "issued", "billed", "closed", "pending_approval", "approved", "partially_received", "received", "", "something_new", null, undefined]) assert.equal(poDeathReason(status), null, String(status));
});

test("only Zoho's own words mean a purchase order is gone, never a bare 404", () => {
  assert.equal(zohoSaysNoSuchPo({ status: 404, body: { code: 1002, message: "Purchase Order does not exist." } }), true);
  assert.equal(zohoSaysNoSuchPo({ status: 400, body: { code: 1002, message: "x" } }), true);
  assert.equal(zohoSaysNoSuchPo({ status: 404, body: { code: 5, message: "Invalid URL Passed" } }), false);
  assert.equal(zohoSaysNoSuchPo({ status: 404, body: null }), false);
  assert.equal(zohoSaysNoSuchPo({ status: 502, body: null }), false);
  assert.equal(zohoSaysNoSuchPo({ status: 401, body: { code: 57, message: "You are not authorized" } }), false);
  assert.equal(zohoSaysNoSuchPo({ status: 400, body: { code: 9, message: "Purchase order does not exist" } }), true);
  // Something else not existing says nothing about this purchase order.
  assert.equal(zohoSaysNoSuchPo({ status: 400, body: { code: 9, message: "The organization does not exist." } }), false);
});

test("a new purchase order after a dead one gets a reference of its own", () => {
  assert.equal(poReference(SAMPLE), `GBS-${SAMPLE}`);
  assert.equal(poReference(SAMPLE, 1), `GBS-${SAMPLE}`);
  assert.equal(poReference(SAMPLE, 2), `GBS-${SAMPLE}-2`);
  assert.equal(poReference(SAMPLE, 3), `GBS-${SAMPLE}-3`);
});

test("alive in Zoho: the status is noted and nothing is freed", async () => {
  const { store, refreshed, dead } = lifeStore();
  const zoho = liveZoho({ P1: { status: "open", reference_number: REF, sub_total: 10, tax_total: 1, total: 11 } });
  assert.deepEqual(await settleRaisedPo({ store, zoho: zoho.send }, raised(), null), { kind: "alive", status: "open" });
  assert.equal(refreshed[0]!.status, "open");
  assert.equal(refreshed[0]!.total, 11);
  assert.equal(dead.length, 0);
});

test("cancelled in Zoho: confirmed by the search, then freed", async () => {
  const { store, dead } = lifeStore();
  const zoho = liveZoho({ P1: { status: "cancelled", reference_number: REF } });
  assert.deepEqual(await settleRaisedPo({ store, zoho: zoho.send }, raised(), null), { kind: "freed", reason: "cancelled", number: "CLK-PO-1" });
  assert.deepEqual(dead[0], { sampleId: SAMPLE, poId: "P1", reason: "cancelled", status: "cancelled", note: "", actor: null });
});

test("rejected in Zoho is freed too", async () => {
  const { store, dead } = lifeStore();
  await settleRaisedPo({ store, zoho: liveZoho({ P1: { status: "rejected", reference_number: REF } }).send }, raised(), null);
  assert.equal(dead[0]!.reason, "rejected");
});

test("removed in Zoho: needs the full list to agree before it is freed", async () => {
  const { store, dead } = lifeStore();
  const zoho = liveZoho({ OTHER: { status: "open", reference_number: "" } });
  assert.deepEqual(await settleRaisedPo({ store, zoho: zoho.send }, raised(), null), { kind: "freed", reason: "deleted", number: "CLK-PO-1" });
  assert.equal(dead[0]!.reason, "deleted");
  assert.ok(zoho.calls.includes("GET purchaseorders"));
});

test("removed in Zoho but the list can't be read: stays locked", async () => {
  const { store, dead } = lifeStore();
  const result = await settleRaisedPo({ store, zoho: liveZoho({}, { listFails: true }).send }, raised(), null);
  assert.equal(result.kind, "unknown");
  assert.equal(dead.length, 0);
});

test("Zoho can't be asked: stays locked and nothing is written", async () => {
  const { store, dead, refreshed } = lifeStore();
  assert.equal((await settleRaisedPo({ store, zoho: liveZoho({}, { readFails: true }).send }, raised(), null)).kind, "unknown");
  const down: ZohoSend = async () => { throw new Error("network"); };
  assert.equal((await settleRaisedPo({ store, zoho: down }, raised(), null)).kind, "unknown");
  assert.equal(dead.length + refreshed.length, 0);
});

test("the read says gone but the list still shows it: stays locked", async () => {
  const { store, dead } = lifeStore();
  const orders: Record<string, Record<string, unknown>> = { P1: { status: "open", reference_number: REF } };
  const zoho = liveZoho(orders);
  const odd: ZohoSend = async (resource, method, body, query) => (resource === "purchaseorders/P1" ? { status: 404, body: { code: 1002, message: "Purchase Order does not exist." } } : zoho.send(resource, method, body, query));
  assert.equal((await settleRaisedPo({ store, zoho: odd }, raised(), null)).kind, "unknown");
  assert.equal(dead.length, 0);
});

test("dead, but another live purchase order has this reference: stays locked and says which", async () => {
  const { store, dead, refreshed } = lifeStore();
  const zoho = liveZoho({ P1: { status: "cancelled", reference_number: REF }, P2: { status: "draft", purchaseorder_number: "CLK-PO-2", reference_number: REF } });
  const result = await settleRaisedPo({ store, zoho: zoho.send }, raised(), null);
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") assert.match(result.message, /CLK-PO-2/);
  assert.equal(dead.length, 0);
  assert.deepEqual(refreshed[0]!.duplicates!.map((po) => po.id), ["P2"]);
});

test("another dead purchase order with this reference doesn't block", async () => {
  const { store, dead } = lifeStore();
  await settleRaisedPo({ store, zoho: liveZoho({ P1: { status: "cancelled", reference_number: REF }, P2: { status: "cancelled", reference_number: REF } }).send }, raised(), null);
  assert.equal(dead.length, 1);
});

test("reconnected to another Zoho company: nothing is asked and nothing is freed", async () => {
  const { store, dead } = lifeStore();
  const zoho = liveZoho({});
  const elsewhere = raised({ snapshot: { organizationId: "ORG-A" } as RaisedPo["snapshot"] });
  const result = await settleRaisedPo({ store, zoho: zoho.send, organizationId: "ORG-B" }, elsewhere, null);
  assert.equal(result.kind, "unknown");
  if (result.kind === "unknown") assert.match(result.message, /another Zoho company/);
  assert.equal(zoho.calls.length + dead.length, 0);
});

test("same company, or a purchase order from before this was recorded: carries on as usual", async () => {
  for (const row of [raised({ snapshot: { organizationId: "ORG-A" } as RaisedPo["snapshot"] }), raised({ snapshot: {} as RaisedPo["snapshot"] }), raised()]) {
    const { store, dead } = lifeStore();
    assert.equal((await settleRaisedPo({ store, zoho: liveZoho({}).send, organizationId: "ORG-A" }, row, null)).kind, "freed");
    assert.equal(dead.length, 1);
  }
});

test("the item's name goes on the line, and it is flagged if Zoho's line doesn't show it", () => {
  assert.equal((purchaseOrderBody(plan())["line_items"] as Record<string, unknown>[])[0]!["name"], "Rice bulk");
  const copy = (line: Record<string, unknown>) => ({ sub_total: 420000, tax_total: 0, source_of_supply: "KA", destination_of_supply: "KA", line_items: [{ tax_id: "T-GST5", ...line }] });
  assert.deepEqual(poDifferences(plan(), copy({ name: "Rice bulk" })), []);
  assert.match(poDifferences(plan(), copy({ name: "" }))[0]!, /doesn't show the item's name, Rice bulk/);
});

test("the read says cancelled but the list still shows it alive: stays locked", async () => {
  const { store, dead } = lifeStore();
  const zoho = liveZoho({ P1: { status: "open", reference_number: REF } });
  const odd: ZohoSend = async (resource, method, body, query) => (resource === "purchaseorders/P1" ? { status: 200, body: { code: 0, purchaseorder: { purchaseorder_id: "P1", status: "cancelled" } } } : zoho.send(resource, method, body, query));
  assert.equal((await settleRaisedPo({ store, zoho: odd }, raised(), null)).kind, "unknown");
  assert.equal(dead.length, 0);
});

/** As seen live right after a cancel: Zoho's read says cancelled while its list still says draft. */
const listBehindZoho = (listed: string, read: string | null = "cancelled") => {
  const calls: string[] = [];
  const row = { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", reference_number: REF, status: listed, order_status: listed };
  const send: ZohoSend = async (resource, method) => {
    calls.push(`${method} ${resource}`);
    if (method === "POST") return { status: 200, body: { code: 0, message: "The purchase order has been marked as cancelled." } };
    if (resource === "purchaseorders") return { status: 200, body: { code: 0, purchaseorders: [row], page_context: { has_more_page: false } } };
    return read ? { status: 200, body: { code: 0, purchaseorder: { ...row, status: read, order_status: read } } } : { status: 404, body: { code: 1002, message: "Purchase Order does not exist." } };
  };
  return { send, calls };
};

test("Zoho's list catching up: stays locked, in calm words, and the card shows the status it read", async () => {
  const { store, dead, refreshed } = lifeStore();
  const result = await settleRaisedPo({ store, zoho: listBehindZoho("draft").send }, raised(), null);
  assert.equal(result.kind, "unknown");
  if (result.kind === "unknown") {
    assert.equal(result.listBehind, "cancelled");
    assert.match(result.message, /as cancelled, but its list hasn't caught up yet/);
    assert.doesNotMatch(result.message, /disagree/);
  }
  assert.equal(dead.length, 0);
  assert.deepEqual([refreshed[0]!.poId, refreshed[0]!.status, refreshed[0]!.gone], ["P1", "cancelled", false]);
});

test("Zoho's list catching up after a delete: stays locked, and says deleted", async () => {
  const { store, dead, refreshed } = lifeStore();
  const result = await settleRaisedPo({ store, zoho: listBehindZoho("draft", null).send }, raised(), null);
  assert.equal(result.kind === "unknown" && result.listBehind, "deleted");
  assert.equal(dead.length, 0);
  assert.deepEqual([refreshed[0]!.status, refreshed[0]!.gone], [null, true]);
});

test("cancel: Zoho takes it while its list is catching up: reported as cancelled, and the sample comes back at the next check", async () => {
  const { store, dead } = lifeStore();
  const zoho = listBehindZoho("draft");
  assert.deepEqual(await cancelRicePo({ store, zoho: zoho.send }, raised(), ACTOR, "wrong vendor"), { kind: "cancelled", number: "CLK-PO-1", settling: true });
  assert.equal(dead.length, 0);
  // Once the list has caught up, the next check frees it.
  const later = lifeStore();
  assert.equal((await settleRaisedPo({ store: later.store, zoho: listBehindZoho("cancelled").send }, raised({ zoho_po_status: "cancelled" }), null)).kind, "freed");
  assert.equal(later.dead.length, 1);
});

test("cancel: Zoho's read says deleted while its list catches up: not reported as cancelled", async () => {
  const { store } = lifeStore();
  const result = await cancelRicePo({ store, zoho: listBehindZoho("draft", null).send }, raised(), ACTOR, "x");
  assert.equal(result.kind, "unclear");
});

test("the regular check: a list catching up doesn't make every page wait five minutes", async () => {
  const { store } = lifeStore();
  // The list has moved on to cancelled, so the check reads it, and the search by reference is the one still behind.
  const row = { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", reference_number: REF, status: "cancelled" };
  const zoho: ZohoSend = async (resource, _method, _body, query = {}) => {
    if (resource === "purchaseorders/P1") return { status: 200, body: { code: 0, purchaseorder: row } };
    if (query["reference_number"]) return { status: 200, body: { code: 0, purchaseorders: [{ ...row, status: "draft" }], page_context: { has_more_page: false } } };
    return { status: 200, body: { code: 0, purchaseorders: [row], page_context: { has_more_page: false } } };
  };
  const result = await syncRaisedPos({ store, zoho }, [raised()]);
  assert.equal(result.unknown, 0);
  assert.equal(result.freed.length, 0);
});

test("rejected shown only in order_status, in the read and the list alike: freed", async () => {
  const { store, dead } = lifeStore();
  assert.equal((await settleRaisedPo({ store, zoho: liveZoho({ P1: { status: "draft", order_status: "rejected", reference_number: REF } }).send }, raised(), null)).kind, "freed");
  assert.equal(dead[0]!.reason, "rejected");
});

test("a search hit on a page that goes on is not the whole answer: a second one further down still stops it", async () => {
  const { store, dead, refreshed } = lifeStore();
  const hit = { purchaseorder_id: "P1", purchaseorder_number: "CLK-PO-1", status: "cancelled", reference_number: REF };
  const second = { purchaseorder_id: "P2", purchaseorder_number: "CLK-PO-2", status: "draft", reference_number: REF };
  const zoho: ZohoSend = async (resource, _method, _body, query = {}) => {
    if (resource === "purchaseorders/P1") return { status: 200, body: { code: 0, purchaseorder: hit } };
    if (query["page"] === "2") return { status: 200, body: { code: 0, purchaseorders: [second], page_context: { has_more_page: false } } };
    return { status: 200, body: { code: 0, purchaseorders: [hit], page_context: { has_more_page: true } } };
  };
  assert.equal((await settleRaisedPo({ store, zoho }, raised(), null)).kind, "blocked");
  assert.equal(dead.length, 0);
  assert.deepEqual(refreshed[0]!.duplicates!.map((po) => po.id), ["P2"]);
});

test("every write about a purchase order names which one, so a slow check can't land on a newer one", async () => {
  const { store, refreshed } = lifeStore();
  await settleRaisedPo({ store, zoho: liveZoho({ P1: { status: "open", reference_number: REF } }).send }, raised(), null);
  await syncRaisedPos({ store, zoho: liveZoho({ P1: { status: "draft" } }).send }, [raised()]);
  await settleRaisedPo({ store, zoho: liveZoho({ P1: { status: "cancelled", reference_number: REF }, P2: { status: "draft", reference_number: REF } }).send }, raised(), null);
  assert.deepEqual(refreshed.map((row) => row.poId), ["P1", "P1", "P1"]);
});

test("two checks at once: the second is told it changed", async () => {
  const { store } = lifeStore();
  const zoho = liveZoho({ P1: { status: "cancelled", reference_number: REF } });
  const [first, second] = await Promise.all([settleRaisedPo({ store, zoho: zoho.send }, raised(), null), settleRaisedPo({ store, zoho: zoho.send }, raised(), null)]);
  assert.deepEqual([first.kind, second.kind].sort(), ["changed", "freed"]);
});

test("the regular check: one list call when nothing changed, however many purchase orders", async () => {
  const { store, refreshed, dead } = lifeStore();
  const orders = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`P${i}`, { status: "draft", total: 10 }]));
  const zoho = liveZoho(orders);
  const rows = Object.keys(orders).map((id) => raised({ sample_id: id, zoho_po_id: id, reference: `R${id}` }));
  const result = await syncRaisedPos({ store, zoho: zoho.send }, rows);
  assert.equal(zoho.calls.length, 1);
  assert.equal(result.checked, 20);
  assert.equal(refreshed.length, 20);
  assert.equal(dead.length, 0);
});

test("the regular check: nothing raised means no Zoho call at all", async () => {
  const { store } = lifeStore();
  const zoho = liveZoho({});
  assert.deepEqual(await syncRaisedPos({ store, zoho: zoho.send }, []), { checked: 0, freed: [], unknown: 0, listRead: false });
  assert.equal(zoho.calls.length, 0);
});

test("the regular check: frees what Zoho removed or cancelled, and notices a new status", async () => {
  const { store, dead, refreshed } = lifeStore();
  const zoho = liveZoho({ P2: { status: "cancelled", reference_number: "R2" }, P3: { status: "open", reference_number: "R3" } });
  const rows = [raised({ sample_id: "S1", zoho_po_id: "P1", reference: "R1" }), raised({ sample_id: "S2", zoho_po_id: "P2", reference: "R2", zoho_po_number: "CLK-PO-2" }), raised({ sample_id: "S3", zoho_po_id: "P3", reference: "R3" })];
  // markDead answers "freed" only once in this stand-in, so the count of freed is what is checked here.
  const result = await syncRaisedPos({ store, zoho: zoho.send }, rows);
  assert.deepEqual(dead.map((row) => [row.sampleId, row.reason]), [["S1", "deleted"], ["S2", "cancelled"]]);
  assert.equal(result.freed[0]!.sampleId, "S1");
  assert.equal(refreshed.find((row) => row.sampleId === "S3")!.status, "open");
});

test("the regular check: a failed list call changes nothing and reads nothing else", async () => {
  const { store, refreshed, dead } = lifeStore();
  const zoho = liveZoho({}, { listFails: true });
  const result = await syncRaisedPos({ store, zoho: zoho.send }, [raised()]);
  assert.equal(result.listRead, false);
  assert.equal(zoho.calls.length, 1);
  assert.equal(refreshed.length + dead.length, 0);
});

test("the regular check: reads of its own are capped, and the rest wait for the next check", async () => {
  const { store } = lifeStore();
  const zoho = liveZoho({ K: { status: "draft" } });
  const orders = Array.from({ length: 12 }, (_, i) => raised({ sample_id: `S${i}`, zoho_po_id: `GONE${i}`, reference: `R${i}` }));
  await syncRaisedPos({ store, zoho: zoho.send }, orders, { maxReads: 3 });
  assert.equal(zoho.calls.filter((call) => call.startsWith("GET purchaseorders/")).length, 3);
});

test("the regular check: an old purchase order brought back to life is shown as a second one", async () => {
  const { store, refreshed } = lifeStore();
  const zoho = liveZoho({ P2: { status: "draft", purchaseorder_number: "CLK-PO-2" }, P1: { status: "open", purchaseorder_number: "CLK-PO-1" } });
  await syncRaisedPos({ store, zoho: zoho.send }, [raised({ zoho_po_id: "P2", zoho_po_number: "CLK-PO-2", retired_pos: [{ id: "P1", number: "CLK-PO-1" } as RaisedPo["retired_pos"][number]] })]);
  assert.deepEqual(refreshed[0]!.duplicates!.map((po) => po.number), ["CLK-PO-1"]);
});

/** A Zoho with more purchase orders than one page of its list. */
const longListZoho = (orders: Record<string, Record<string, unknown>>) => {
  const calls: string[] = [];
  const send: ZohoSend = async (resource) => {
    calls.push(resource);
    const one = /^purchaseorders\/([^/]+)$/.exec(resource);
    if (one) return { status: 200, body: { code: 0, purchaseorder: { purchaseorder_id: one[1], status: "draft" } } };
    return { status: 200, body: { code: 0, purchaseorders: Object.entries(orders).map(([id, order]) => ({ purchaseorder_id: id, ...order })), page_context: { has_more_page: true } } };
  };
  return { send, calls };
};

test("the regular check: off the first page of a long list, checked one at a time and not every minute", async () => {
  const { store } = lifeStore();
  const now = Date.parse("2026-11-03T12:00:00Z");
  const zoho = longListZoho({ K: { status: "draft" } });
  const stale = new Date(now - OFF_LIST_CHECK_MS - 1000).toISOString();
  const fresh = new Date(now - 60_000).toISOString();
  const rows = [
    raised({ sample_id: "S1", zoho_po_id: "A", zoho_checked_at: fresh }),
    raised({ sample_id: "S2", zoho_po_id: "B", zoho_checked_at: stale }),
    raised({ sample_id: "S3", zoho_po_id: "C", zoho_checked_at: stale }),
  ];
  await syncRaisedPos({ store, zoho: zoho.send }, rows, { now });
  // One list and one read, of the first one due. A minute later the next one's turn comes.
  assert.deepEqual(zoho.calls, ["purchaseorders", "purchaseorders/B"]);
});

test("the regular check: a short list that doesn't show it means ask right away", async () => {
  const { store, dead } = lifeStore();
  const now = Date.parse("2026-11-03T12:00:00Z");
  const zoho = liveZoho({ K: { status: "draft" } });
  await syncRaisedPos({ store, zoho: zoho.send }, [raised({ zoho_checked_at: new Date(now - 60_000).toISOString() })], { now });
  assert.equal(dead.length, 1);
});

test("the regular check: something left unsettled counts, so the caller waits longer before asking again", async () => {
  const { store } = lifeStore();
  const blocked = liveZoho({ P1: { status: "cancelled", reference_number: REF }, P2: { status: "draft", reference_number: REF } });
  assert.equal((await syncRaisedPos({ store, zoho: blocked.send }, [raised()])).unknown, 1);
  const unread = liveZoho({ P1: { status: "cancelled", reference_number: REF } }, { readFails: true });
  assert.equal((await syncRaisedPos({ store, zoho: unread.send }, [raised()])).unknown, 1);
});

test("cancel: uses Zoho's own Cancelled status, frees only when Zoho shows it, and never deletes", async () => {
  const { store, dead } = lifeStore();
  const zoho = liveZoho({ P1: { status: "draft", reference_number: REF } });
  const result = await cancelRicePo({ store, zoho: zoho.send }, raised(), ACTOR, "wrong vendor");
  assert.deepEqual(result, { kind: "cancelled", number: "CLK-PO-1" });
  assert.ok(zoho.calls.includes("POST purchaseorders/P1/status/cancelled"));
  assert.equal(dead[0]!.actor, ACTOR);
  assert.match(dead[0]!.note, /wrong vendor/);
  assert.equal(zoho.calls.some((call) => call.startsWith("DELETE")), false);
});

test("cancel: Zoho refuses, in plain words, and the sample stays as it is", async () => {
  const { store, dead } = lifeStore();
  const result = await cancelRicePo({ store, zoho: liveZoho({ P1: { status: "draft" } }, { cancel: "refuse" }).send }, raised(), ACTOR, "x");
  assert.equal(result.kind, "refused");
  if (result.kind === "refused") assert.match(result.message, /draft cannot be marked/);
  assert.equal(dead.length, 0);
});

test("cancel: the answer is lost but Zoho did it, so the read frees the sample", async () => {
  const { store, dead } = lifeStore();
  const result = await cancelRicePo({ store, zoho: liveZoho({ P1: { status: "draft", reference_number: REF } }, { cancel: "lost" }).send }, raised(), ACTOR, "x");
  assert.equal(result.kind, "cancelled");
  assert.equal(dead.length, 1);
});

test("cancel: Zoho says yes but still shows it alive, so the sample isn't freed", async () => {
  const { store, dead } = lifeStore();
  const result = await cancelRicePo({ store, zoho: liveZoho({ P1: { status: "open", reference_number: REF } }, { cancel: "ignored" }).send }, raised(), ACTOR, "x");
  assert.equal(result.kind, "unclear");
  assert.equal(dead.length, 0);
});

test("cancel: asked twice, the second refused because the first worked, is reported as cancelled", async () => {
  const { store, dead } = lifeStore();
  // The first press worked but its read failed. This second press is refused, and Zoho's status shows why.
  const result = await cancelRicePo({ store, zoho: liveZoho({ P1: { status: "cancelled", reference_number: REF } }, { cancel: "refuse" }).send }, raised(), ACTOR, "wrong vendor");
  assert.deepEqual(result, { kind: "cancelled", number: "CLK-PO-1" });
  assert.match(dead[0]!.note, /Already cancelled when asked from the website: wrong vendor/);
});

test("cancel: refused and Zoho can't be read: says it isn't clear, not that nothing changed", async () => {
  const { store, dead } = lifeStore();
  const result = await cancelRicePo({ store, zoho: liveZoho({ P1: { status: "draft" } }, { cancel: "refuse", readFails: true }).send }, raised(), ACTOR, "x");
  assert.equal(result.kind, "unclear");
  if (result.kind === "unclear") assert.doesNotMatch(result.message, /Nothing changed/);
  assert.equal(dead.length, 0);
});

test("cancel: who asked and why is on the history before the request goes out, whatever Zoho answers", async () => {
  const { store, asked } = lifeStore();
  const zoho = liveZoho({ P1: { status: "draft" } }, { readFails: true, cancel: "lost" });
  let askedFirst = false;
  const first: PoLifeStore = { ...store, cancelAsked: async (args) => { askedFirst = zoho.calls.length === 0; await store.cancelAsked(args); } };
  await cancelRicePo({ store: first, zoho: zoho.send }, raised(), ACTOR, "wrong vendor");
  assert.equal(askedFirst, true);
  assert.deepEqual(asked, [{ sampleId: SAMPLE, number: "CLK-PO-1", reason: "wrong vendor", actor: ACTOR }]);
});

test("cancel: not offered once rice is received or billed", () => {
  for (const status of ["draft", "open", "issued", "pending_approval", "approved"]) assert.equal(canCancelPo(status), true, status);
  for (const status of ["billed", "partially_billed", "closed", "received", "partially_received", "cancelled", "rejected"]) assert.equal(canCancelPo(status), false, status);
});

test("before a new purchase order: every earlier one must still be dead", async () => {
  const old = [{ id: "P1", number: "CLK-PO-1" }, { id: "P2", number: "CLK-PO-2" }];
  assert.equal(await retiredPoProblem(liveZoho({ P2: { status: "cancelled" } }).send, old), null); // P1 is gone, P2 cancelled.
  assert.match((await retiredPoProblem(liveZoho({ P1: { status: "open" } }).send, old))!, /CLK-PO-1 is alive in Zoho again/);
  assert.match((await retiredPoProblem(liveZoho({}, { readFails: true }).send, old))!, /could not be asked/);
  const quiet = liveZoho({});
  assert.equal(await retiredPoProblem(quiet.send, []), null);
  assert.equal(quiet.calls.length, 0);
});

test("before a new purchase order: nothing alive may carry an earlier reference", async () => {
  const old = [{ id: "P1", number: "CLK-PO-1", reference: REF }];
  assert.equal(await retiredPoProblem(liveZoho({ P1: { status: "cancelled", reference_number: REF } }).send, old), null);
  assert.equal(await retiredPoProblem(liveZoho({}).send, old), null);
  // A copy made in Zoho, say: dead original, live copy with the same reference.
  const copied = await retiredPoProblem(liveZoho({ P1: { status: "cancelled", reference_number: REF }, P9: { status: "draft", purchaseorder_number: "CLK-PO-9", reference_number: REF } }).send, old);
  assert.match(copied!, /CLK-PO-9/);
  assert.match(copied!, /Nothing was sent/);
  assert.match((await retiredPoProblem(liveZoho({}, { listFails: true }).send, old))!, /could not be read in full/);
});

