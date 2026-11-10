// Real-Postgres check of 20261110180000_batch_receive_and_split.sql (receive at the unloading godown, send part of a
// batch to other godowns), on PGlite with every migration in the repo and small stand-ins for what Supabase provides.
// Touches nothing live. Not part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/batch-transfers.db-test.mjs
//
// It must end with "batch transfers OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261110180000_batch_receive_and_split.sql";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin; CREATE ROLE postgres_stub;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, phone text, aud text, role text, encrypted_password text,
    email_confirmed_at timestamptz, phone_confirmed_at timestamptz, last_sign_in_at timestamptz,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb, raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), banned_until timestamptz, deleted_at timestamptz, is_sso_user boolean DEFAULT false, is_anonymous boolean DEFAULT false
  );
  CREATE TABLE auth.identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider text, provider_id text, identity_data jsonb);
  CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
  CREATE TABLE auth.cur (uid uuid); INSERT INTO auth.cur VALUES (NULL);
  GRANT SELECT, UPDATE ON auth.cur TO anon, authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT uid FROM auth.cur $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT CASE WHEN (SELECT uid FROM auth.cur) IS NULL THEN 'anon' ELSE 'authenticated' END $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
  CREATE PUBLICATION supabase_realtime;
`);

const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
assert.ok(files.includes(MIGRATION));
for (const file of files) await db.exec(readFileSync(join(dir, file), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), HBL_STAFF = uid("e1"), CLK_STAFF = uid("e2"), HBL_PARTNER = uid("b1");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${HBL_STAFF}','e1@test.local'),('${CLK_STAFF}','e2@test.local'),('${HBL_PARTNER}','b1@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
const L_CLK = "LOC-CLK", L_HBL = "LOC-HBL", L_HO = "LOC-HEAD-OFFICE";
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-CLK','CLK','Challakere Godown',true,$1) ON CONFLICT (id) DO UPDATE SET active = true, zoho_location_id = $1, code = 'CLK'", [L_CLK]);
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-HBL','HBL','Hubli Godown',true,$1) ON CONFLICT (id) DO UPDATE SET active = true, zoho_location_id = $1, code = 'HBL'", [L_HBL]);
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-NOZ','NOZ','Unlinked Godown',true,'') ON CONFLICT (id) DO NOTHING");
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${HBL_STAFF}','BR-HBL','Hanu at Hubli','9000000011'),('${CLK_STAFF}','BR-CLK','Ravi at Challakere','9000000012')`);
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${HBL_PARTNER}','BR-HBL','Hubli Partner','b1@test.local','9000000013')`);
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
for (const [id, name] of [["P1", "TEST Oil 850 ML"], ["P2", "TEST Sambar 17 GM"], ["P3", "TEST Tracked Rice"]])
  await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ($1,'V1','Oil','approved',true,$2)", [id, JSON.stringify({ id, name, stock: 0, sold: 0, unit: "pcs" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.zoho_item_links (product_id, zoho_item_id, track_batches) VALUES ('P1','Z1',false),('P2','Z2',false),('P3','Z3',true)");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock) VALUES ('BR-CLK','P1',12)");

// A super batch made from a bill at Challakere, as create_batches_from_bill makes it.
const bill = (id, no) => ({ bill_id: id, bill_number: no, vendor_name: "TEST Supplier", date: "2026-11-03", modified: "2026-11-03T10:00:00+0530", total: 1560 });
const line = (lineId, productId, qty, ex, inc, name, item) => ({ line_id: lineId, product_id: productId, qty, unit_ex_gst: ex, unit_inc_gst: inc, mfg_date: null, expiry_date: null, notes: "", zoho_item_id: item, name, unit: "pcs" });
const service = async (fn) => { await db.exec("SET ROLE service_role"); try { return await fn(); } finally { await db.exec("RESET ROLE"); } };
const one = async (text, params) => (await service(() => q(text, params)))[0].r;
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
async function as(user, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const made = await one("SELECT public.create_batches_from_bill('BR-CLK', $1, $2, 'inc_gst', $3, 'Office Admin') AS r",
  [JSON.stringify(bill("BILL-1", "VS903")), JSON.stringify([line("L1", "P1", 12, 123.81, 130, "TEST Oil 850 ML", "Z1")]), ADMIN]);
const SUPER = made[0].batch_id;
const batch = async (id) => (await q("SELECT * FROM public.batches WHERE id = $1", [id]))[0];
const stock = async (branch, product) => Number((await q("SELECT stock FROM public.branch_stock WHERE branch_id = $1 AND product_id = $2", [branch, product]))[0]?.stock ?? 0);
const total = async (product) => Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = $1", [product]))[0].s);
const split = (targets, by = ADMIN, batchId = SUPER, request = null) =>
  one("SELECT public.begin_batch_split($1, $2, $3, 'Office Admin', $4) AS r", [batchId, JSON.stringify(targets), by, request]);
const json = (value) => (value === null ? null : JSON.stringify(value));
// readings: Zoho's numbers at the godowns after the move (the server reads them); null when Zoho is not the stock master.
const finish = (id, zohoId, status, actor = null, readings = null, claim = null) =>
  one("SELECT public.finish_batch_transfer($1, $2, $3, $4, $5, $6) AS r", [id, zohoId, status, actor, json(readings), claim]);
const cancel = (id, reason, by = ADMIN, readings = null, claim = null) =>
  one("SELECT public.cancel_batch_transfer($1, $2, $3, $4, $5) AS r", [id, reason, by, json(readings), claim]);
const claimIt = (id, claim, seconds = 300) => one("SELECT public.claim_batch_transfer($1, $2, $3) AS r", [id, claim, seconds]);
const release = (id, claim) => service(() => q("SELECT public.release_batch_transfer($1, $2)", [id, claim]));
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222";

// ---- splitting: refusals first
await refuses(() => split([{ branch_id: "BR-HBL", qty: 5 }], CUSTOMER), /Only administrators/, "a customer");
await refuses(() => split([]), /Choose a godown/, "no targets");
await refuses(() => split([{ branch_id: "BR-HBL", qty: 13 }]), /has 12(\.00)? left; 13(\.00)? were chosen/, "more than the batch has");
await refuses(() => split([{ branch_id: "BR-HBL", qty: 7 }, { branch_id: "BR-HBL", qty: 1 }]), /chosen twice/, "the same godown twice");
await refuses(() => split([{ branch_id: "BR-CLK", qty: 2 }]), /already at .*Challakere/, "its own godown");
await refuses(() => split([{ branch_id: "BR-NOZ", qty: 2 }]), /not linked to a Zoho location/, "a godown without a Zoho location");
await refuses(() => split([{ branch_id: "BR-HBL", qty: 0 }]), /how many to send/, "zero");
await refuses(() => split([{ branch_id: "BR-HBL", qty: "5" }]), /how many to send/, "a quantity as text");
await refuses(() => split([{ branch_id: "BR-HBL", qty: 1.005 }]), /how many to send/, "more than 2 decimals");
assert.equal(Number((await batch(SUPER)).remaining_quantity), 12, "a refusal moves nothing");
assert.equal((await q("SELECT count(*)::int AS c FROM public.batch_transfers"))[0].c, 0);

// ---- send 5 to Hubli: the units leave the super batch at once and wait in the transfer
let started = await split([{ branch_id: "BR-HBL", qty: 5 }]);
assert.equal(started.length, 1);
let t = started[0];
assert.equal(t.transfer_no, "GB-TR-000001");
assert.equal(t.kind, "split");
assert.equal(t.status, "pending");
assert.equal(t.from_location_id, L_CLK);
assert.equal(t.to_location_id, L_HBL);
assert.match(t.to_name, /Hubli/);
assert.equal(t.parent_batch_code, (await batch(SUPER)).batch_code);
assert.deepEqual(t.lines, [{ product_id: "P1", zoho_item_id: "Z1", name: "TEST Oil 850 ML", qty: 5, unit: "pack" }].map((l) => ({ ...l, unit: (t.lines[0] ?? {}).unit })));
assert.equal(Number((await batch(SUPER)).remaining_quantity), 7, "kept aside: no order can take them");
assert.equal(await stock("BR-CLK", "P1"), 12, "website stock moves only when Zoho has moved: Zoho still has them here");
assert.equal(Number(t.reserved), 0);

// A Zoho status that is neither: still pending, Zoho's word kept.
t = await finish(t.id, "ZT-1", "draft");
assert.equal(t.status, "pending");
assert.equal(t.zoho_transfer_order_id, "ZT-1");
assert.match(t.last_error, /draft/);
assert.equal(await stock("BR-CLK", "P1"), 12);

// Zoho has it in transit: it left Challakere, and waits for Hubli to mark it received.
t = await finish(t.id, "ZT-1", "in_transit");
assert.equal(t.status, "in_transit");
assert.ok(t.sent_at, "when it left");
assert.equal(t.received_at, null);
assert.match(t.from_name, /Challakere/);
assert.equal(await stock("BR-CLK", "P1"), 7, "it left the sending godown");
assert.equal(Number(t.reserved), 5, "what went down, for a cancel or arrival without Zoho's numbers");
assert.equal(await stock("BR-HBL", "P1"), 0, "not at Hubli until received");
assert.equal((await q("SELECT count(*)::int AS c FROM public.batches WHERE parent_batch_id = $1", [SUPER]))[0].c, 0, "no batch at Hubli yet");
assert.equal((await finish(t.id, "ZT-1", "in_transit")).status, "in_transit", "told twice: nothing more moves");
assert.equal(await stock("BR-CLK", "P1"), 7);
assert.equal(Number((await batch(SUPER)).sent_quantity), 5, "the super batch counts what it sent");
// One server call at a time: another call's live claim refuses finish and cancel; a claim that ran out doesn't.
assert.equal((await claimIt(t.id, C1)).claimed, true);
assert.equal((await claimIt(t.id, C2)).claimed, false, "a second call waits");
await refuses(() => finish(t.id, "ZT-1", "transferred", HBL_STAFF, null, C2), /being worked on/, "finishing under another call's claim");
await refuses(() => cancel(t.id, "x", ADMIN, null, C2), /being worked on/, "cancelling under another call's claim");
await release(t.id, C2);
assert.equal((await claimIt(t.id, C2)).claimed, false, "only the holder lets it go");
await release(t.id, C1);
assert.equal((await claimIt(t.id, C2)).claimed, true, "free once let go");
await q("UPDATE public.batch_transfers SET claimed_until = now() - interval '1 second' WHERE id = $1", [t.id]);
assert.equal((await claimIt(t.id, C1)).claimed, true, "a claim that ran out is taken over");
await release(t.id, C1);
assert.equal((await q("SELECT claim_id FROM public.batch_transfers WHERE id = $1", [t.id]))[0].claim_id, null);
// Only the receiving godown (or the office) marks it received.
await refuses(() => finish(t.id, "ZT-1", "transferred", CLK_STAFF), /Only .*Hubli.* staff, its channel partner or an administrator/, "the sending godown's staff");
await refuses(() => finish(t.id, "ZT-1", "transferred", CUSTOMER), /Only .*Hubli/, "a customer");
assert.equal((await q("SELECT status FROM public.batch_transfers WHERE id = $1", [t.id]))[0].status, "in_transit");

// Received at Hubli by its staff: the Hubli batch appears, numbered after the super batch, with its cost and bill.
t = await finish(t.id, "ZT-1", "transferred", HBL_STAFF);
assert.equal(t.status, "done");
assert.equal(t.received_by_name, "Hanu at Hubli");
assert.equal(t.received_by_role, "staff");
assert.ok(t.received_at);
const superCode = (await batch(SUPER)).batch_code;
assert.equal(t.result[0].batch_code, `${superCode}-HBL1`);
const child = await batch(t.result[0].batch_id);
assert.equal(child.branch_id, "BR-HBL");
assert.equal(Number(child.quantity), 5);
assert.equal(Number(child.remaining_quantity), 5);
assert.equal(child.parent_batch_id, SUPER);
assert.equal(Number(child.transfer_id), Number(t.id));
assert.equal(Number(child.unit_cost), 130);
assert.equal(Number(child.unit_cost_ex_gst), 123.81);
assert.equal(child.cost_basis, "inc_gst");
assert.equal(child.zoho_bill_number, "VS903");
assert.equal(child.zoho_bill_line_id, "", "the bill line stays the super batch's");
assert.equal(child.purchase_ref, "VS903");
assert.equal(String(child.purchase_date).slice(0, 10) === "2026-11-03" || new Date(child.purchase_date).toISOString().startsWith("2026-11-0"), true);
assert.equal(await stock("BR-CLK", "P1"), 7);
assert.equal(await stock("BR-HBL", "P1"), 5);
assert.equal(await total("P1"), 12, "the product's total doesn't change");
// Finishing again (a retry after a lost reply) changes nothing.
const again = await finish(t.id, "ZT-1", "transferred");
assert.equal(again.result[0].batch_code, `${superCode}-HBL1`);
assert.equal((await q("SELECT count(*)::int AS c FROM public.batches WHERE parent_batch_id = $1", [SUPER]))[0].c, 1);
assert.equal(await stock("BR-HBL", "P1"), 5);

// An order at Hubli takes from the Hubli batch.
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
const order = (await q("INSERT INTO public.orders (order_no, user_id, customer_name, total, subtotal, payment_status, order_status, branch_id) VALUES ('TEST-HBL-1',$1,'TEST',260,260,'Paid','Payment Confirmed','BR-HBL') RETURNING id", [CUSTOMER]))[0].id;
const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total) VALUES ($1,'P1','TEST Oil 850 ML',2,130,260) RETURNING id", [order]))[0].id;
assert.equal(Number((await q("SELECT private.allocate_order_item_batches($1,'P1','BR-HBL',2) AS taken", [item]))[0].taken), 2);
assert.equal(Number((await batch(child.id)).remaining_quantity), 3);
assert.equal(Number((await batch(SUPER)).remaining_quantity), 7, "the Challakere super batch is untouched");

// ---- two more godowns at once, one cancelled: its units come back
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-DVG','DVG','Davangere Godown',true,'LOC-DVG') ON CONFLICT (id) DO NOTHING");
started = await split([{ branch_id: "BR-HBL", qty: 2 }, { branch_id: "BR-DVG", qty: 3 }]);
assert.deepEqual(started.map((s) => s.transfer_no), ["GB-TR-000002", "GB-TR-000003"]);
assert.equal(Number((await batch(SUPER)).remaining_quantity), 2);
assert.equal(await stock("BR-CLK", "P1"), 7, "waiting for Zoho: no stock moves yet");
await refuses(() => split([{ branch_id: "BR-HBL", qty: 3 }]), /has 2(\.00)? left/, "units kept aside can't be sent twice");
const toDvg = await cancel(started[1].id, "Zoho refused: not enough stock");
assert.equal(toDvg.status, "cancelled");
assert.equal(Number((await batch(SUPER)).remaining_quantity), 5, "cancelled units are back");
assert.equal(await stock("BR-CLK", "P1"), 7, "a send that never reached Zoho never moved stock");
assert.equal((await cancel(started[1].id, "again")).status, "cancelled", "cancelling twice is harmless");
await refuses(() => finish(started[1].id, "ZT-3", "transferred"), /was cancelled/, "finishing a cancelled transfer");
// Zoho shows it received straight away (marked in Zoho): it leaves and arrives in one go; the Hubli partner pressed.
const second = await finish(started[0].id, "ZT-2", "transferred", HBL_PARTNER);
assert.equal(second.result[0].batch_code, `${superCode}-HBL2`, "a second batch at the same godown gets the next number");
assert.equal(second.received_by_role, "partner");
assert.equal(second.received_by_name, "Hubli Partner");
await refuses(() => cancel(started[0].id, "too late"), /is done/, "cancelling a done transfer");
assert.equal(await stock("BR-HBL", "P1"), 7);
assert.equal(await stock("BR-CLK", "P1"), 5);
assert.equal(await stock("BR-DVG", "P1"), 0);

// Marked received in Zoho itself (no one pressed here): it still finishes, saying so.
const viaZoho = (await split([{ branch_id: "BR-HBL", qty: 1 }]))[0];
await finish(viaZoho.id, "ZT-4", "in_transit");
const viaZohoDone = await finish(viaZoho.id, "ZT-4", "transferred");
assert.equal(viaZohoDone.received_by_role, "zoho");
assert.equal(viaZohoDone.received_by_name, "Marked received in Zoho");
// An administrator may mark one received too.
const byAdmin = (await split([{ branch_id: "BR-HBL", qty: 1 }]))[0];
await finish(byAdmin.id, "ZT-5", "in_transit");
assert.equal((await finish(byAdmin.id, "ZT-5", "transferred", ADMIN)).received_by_role, "admin");
assert.equal(await stock("BR-CLK", "P1"), 3);
assert.equal(await stock("BR-HBL", "P1"), 9);
assert.equal(Number((await batch(SUPER)).sent_quantity), 9, "5 + 2 + 1 + 1 sent; the 3 cancelled came back");

// A batch on its way whose Zoho transfer was voided or deleted (the server checked): cancelled, and the units are
// back on the super batch and at the sending godown.
const voided = (await split([{ branch_id: "BR-HBL", qty: 1 }]))[0];
await finish(voided.id, "ZT-6", "in_transit");
assert.equal(await stock("BR-CLK", "P1"), 2);
assert.equal(Number((await batch(SUPER)).remaining_quantity), 2);
const voidedBack = await cancel(voided.id, "Voided in Zoho");
assert.equal(voidedBack.status, "cancelled");
assert.equal(voidedBack.last_error, "Voided in Zoho");
assert.equal(Number((await batch(SUPER)).remaining_quantity), 3, "back on the super batch");
assert.equal(Number((await batch(SUPER)).sent_quantity), 9);
assert.equal(await stock("BR-CLK", "P1"), 3, "back at Challakere");
assert.equal(await stock("BR-HBL", "P1"), 9, "Hubli never had it");
await refuses(() => finish(voided.id, "ZT-6", "transferred", HBL_STAFF), /was cancelled/, "receiving a cancelled transfer");

// A batch-tracked Zoho item is moved in Zoho itself.
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, branch_id, status) VALUES ('CLK-TRACKED-01','P3','TEST Tracked Rice',10,10,'bag',50,'BR-CLK','Active')");
const tracked = (await q("SELECT id FROM public.batches WHERE batch_code = 'CLK-TRACKED-01'"))[0].id;
await refuses(() => split([{ branch_id: "BR-HBL", qty: 1 }], ADMIN, tracked), /batch tracking in Zoho/, "a Zoho batch-tracked item");

// ---- receiving a bill whose Zoho location is Head Office, unloaded at Hubli
const receive = (branch, from, fromName, b, lines) => one("SELECT public.begin_bill_receive($1,$2,$3,$4,$5,'inc_gst',$6,'Office Admin') AS r",
  [branch, from, fromName, JSON.stringify(b), JSON.stringify(lines), ADMIN]);
const bill2 = bill("BILL-2", "SS4463");
const lines2 = [line("L21", "P2", 6, 9.52, 10, "TEST Sambar 17 GM", "Z2"), line("L22", "P1", 4, 123.81, 130, "TEST Oil 850 ML", "Z1")];
await refuses(() => receive("BR-HBL", L_HBL, "Hubli", bill2, lines2), /already at .*Hubli.*: nothing to move/, "same place");
await refuses(() => receive("BR-NOZ", L_HO, "Head Office", bill2, lines2), /not linked to a Zoho location/, "unlinked godown");
await refuses(() => receive("BR-HBL", "", "", bill2, lines2), /did not say where/, "no location");
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill2, [line("L23", "P3", 1, 40, 42, "TEST Tracked Rice", "Z3")]), /batch tracking in Zoho/, "tracked item on a bill");
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill("BILL-1", "VS903"), [line("L1", "P1", 12, 123.81, 130, "TEST Oil 850 ML", "Z1")]), /already batch/, "a line that has a batch");
let r = await receive("BR-HBL", L_HO, "Head Office", bill2, lines2);
assert.equal(r.kind, "receive");
assert.equal(r.status, "pending");
assert.equal(r.from_branch_id, null, "Head Office is no godown");
assert.equal(r.from_location_name, "Head Office");
assert.equal(r.bill_number, "SS4463");
const again2 = await receive("BR-HBL", L_HO, "Head Office", bill2, lines2);
assert.equal(again2.id, r.id, "a second press gets the same transfer");
assert.equal(again2.resumed, true);
await refuses(() => receive("BR-CLK", L_HO, "Head Office", bill2, lines2), /already being moved to another godown/, "the same bill to another godown meanwhile");
assert.equal((await q("SELECT count(*)::int AS c FROM public.batches WHERE zoho_bill_id = 'BILL-2'"))[0].c, 0, "no batch before Zoho moved it");
r = await finish(r.id, "ZT-9", "transferred");
assert.equal(r.status, "done");
assert.equal(r.result.length, 2);
const received = await q("SELECT batch_code, branch_id, quantity, unit_cost, cost_basis, transfer_id FROM public.batches WHERE zoho_bill_id = 'BILL-2' ORDER BY batch_code");
assert.ok(received.every((row) => row.branch_id === "BR-HBL" && Number(row.transfer_id) === Number(r.id) && row.cost_basis === "inc_gst"));
assert.ok(received.every((row) => row.batch_code.startsWith("HBL-031126-")), "numbered at the unloading godown");
// Zoho not the stock master (no readings): a bill's units never reach website stock, as for a bill received at its own
// godown, so no godown's stock moves.
assert.equal(await stock("BR-HBL", "P2"), 0);
assert.equal(await stock("BR-HBL", "P1"), 9);
assert.equal(await stock("BR-CLK", "P1"), 3, "Head Office is no godown: Challakere is untouched");
// The bill can't be received again.
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill2, lines2), /already batch/, "a received bill");

// A bill at Challakere unloaded at Hubli, Zoho the stock master: the sync had pulled the bill into Challakere (6); both
// godowns take Zoho's numbers after the move, less website orders Zoho doesn't hold yet (the 2 ordered at Hubli above).
const bill3 = bill("BILL-3", "VS910");
await q("UPDATE public.branch_stock SET stock = stock + 3 WHERE branch_id = 'BR-CLK' AND product_id = 'P1'");
r = await receive("BR-HBL", L_CLK, "CLK Shami Business Ventures", bill3, [line("L31", "P1", 3, 123.81, 130, "TEST Oil 850 ML", "Z1")]);
assert.equal(r.from_branch_id, "BR-CLK");
r = await finish(r.id, "ZT-10", "transferred", null, [{ branch_id: "BR-CLK", product_id: "P1", stock: 3 }, { branch_id: "BR-HBL", product_id: "P1", stock: 14 }]);
assert.equal(await stock("BR-CLK", "P1"), 3);
assert.equal(await stock("BR-HBL", "P1"), 12, "Zoho's 14 less the 2 ordered on the website");
// Without Zoho's number for a godown it moves by the quantity: Challakere gives 1 up, Hubli gains 1.
r = await receive("BR-HBL", L_CLK, "CLK Shami Business Ventures", bill("BILL-5", "VS912"), [line("L51", "P1", 1, 123.81, 130, "TEST Oil 850 ML", "Z1")]);
r = await finish(r.id, "ZT-13", "transferred", null, [{ branch_id: "BR-HBL", product_id: "P1", stock: 15 }]);
assert.equal(await stock("BR-CLK", "P1"), 2);
assert.equal(await stock("BR-HBL", "P1"), 13);
await q("UPDATE public.branch_stock SET stock = 3 WHERE branch_id = 'BR-CLK' AND product_id = 'P1'");
// Lines create_batches_from_bill would refuse at finish are refused before Zoho moves anything.
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill("BILL-8", "VS940"), [line("L81", "P2", 0.004, 9.52, 10, "TEST Sambar 17 GM", "Z2")]), /without a Zoho item or quantity/, "a quantity that rounds to 0");
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill("BILL-8", "VS940"), [line("L81", "P2", 1, 10, 9, "TEST Sambar 17 GM", "Z2")]), /wrong cost/, "a cost with GST below the cost without");
await refuses(() => receive("BR-HBL", L_HO, "Head Office", { ...bill("BILL-8", "VS940"), date: "" }, [line("L81", "P2", 1, 9.52, 10, "TEST Sambar 17 GM", "Z2")]), /no date/, "a bill without a date");
await refuses(() => receive("BR-HBL", L_HO, "Head Office", bill("BILL-8", "VS940"), [{ ...line("L81", "P2", 1, 9.52, 10, "TEST Sambar 17 GM", "Z2"), product_id: "NOPE" }]), /not a website product/, "a line that is no website product");
// Cancelling a pending receive frees the bill.
const bill4 = bill("BILL-4", "VS911");
r = await receive("BR-HBL", L_HO, "Head Office", bill4, [line("L41", "P2", 2, 9.52, 10, "TEST Sambar 17 GM", "Z2")]);
await cancel(r.id, "Zoho refused");
r = await receive("BR-CLK", L_HO, "Head Office", bill4, [line("L41", "P2", 2, 9.52, 10, "TEST Sambar 17 GM", "Z2")]);
assert.equal(r.to_branch_id, "BR-CLK", "after a cancel the bill can go elsewhere");

// ---- a pending try noted; a create sent to Zoho is written down first
const noted = await one("SELECT public.note_batch_transfer_attempt($1, 'Zoho gave no answer', '', '', NULL, false) AS r", [r.id]);
assert.equal(noted.attempts, 1);
assert.equal(noted.last_error, "Zoho gave no answer");
assert.equal(noted.create_sent_at, null);
assert.equal((await claimIt(r.id, C1)).claimed, true);
await refuses(() => one("SELECT public.note_batch_transfer_attempt($1, 'x', '', '', $2, false) AS r", [r.id, C2]), /being worked on/, "noting under another call's claim");
await refuses(() => one("SELECT public.note_batch_transfer_create($1, $2) AS r", [r.id, C2]), /being worked on/, "a create under another call's claim");
assert.ok((await one("SELECT public.note_batch_transfer_create($1, $2) AS r", [r.id, C1])).create_sent_at, "when the create went to Zoho");
// Zoho says the number is taken but a look-up can't find it: remembered (Cancel waits on it); a new create clears it.
assert.equal((await one("SELECT public.note_batch_transfer_attempt($1, 'exists', '', '', $2, true) AS r", [r.id, C1])).zoho_number_taken, true);
assert.equal((await one("SELECT public.note_batch_transfer_attempt($1, 'no answer', '', '', $2, false) AS r", [r.id, C1])).zoho_number_taken, true, "kept until a new create");
assert.equal((await one("SELECT public.note_batch_transfer_create($1, $2) AS r", [r.id, C1])).zoho_number_taken, false);
await release(r.id, C1);

// ---- the same bill received at its own godown while it is being moved: refused (Zoho may have moved it already)
const here = (branch, b, lines, by = ADMIN) => one("SELECT public.receive_bill_here($1, $2, $3, 'ex_gst', $4, 'Office Admin') AS r",
  [branch, JSON.stringify(b), JSON.stringify(lines), by]);
await refuses(() => here("BR-HBL", bill4, [line("L41", "P2", 2, 9.52, 10, "TEST Sambar 17 GM", "Z2")]), /VS911 is being moved to .*Challakere.*GB-TR-/, "a bill that is being moved");
await refuses(() => here("BR-HBL", bill("BILL-6", "VS930"), [line("L61", "P2", 1, 9.52, 10, "TEST Sambar 17 GM", "Z2")], CUSTOMER), /Only administrators/, "a customer receiving");
const direct = await here("BR-HBL", bill("BILL-6", "VS930"), [line("L61", "P2", 1, 9.52, 10, "TEST Sambar 17 GM", "Z2")]);
assert.equal(direct.length, 1, "another bill is received as before");
await cancel(r.id, "Not in Zoho");
assert.equal((await here("BR-HBL", bill4, [line("L41", "P2", 2, 9.52, 10, "TEST Sambar 17 GM", "Z2")])).length, 1, "after the cancel it can be received here");

// ---- Zoho's own numbers (Zoho is the stock master): a stock sync that already pulled the move can't count it twice
assert.equal(Number((await batch(SUPER)).remaining_quantity), 3);
assert.equal(await stock("BR-CLK", "P1"), 3);
const synced = (await split([{ branch_id: "BR-HBL", qty: 2 }]))[0];
assert.equal(await stock("BR-CLK", "P1"), 3, "untouched while it waits for Zoho");
// A sync pulled Zoho after Zoho moved the units, before the website finished: Challakere shows Zoho's 1 already.
await finish(synced.id, "ZT-11", "in_transit", null, [{ branch_id: "BR-CLK", product_id: "P1", stock: 1 }, { branch_id: "BR-HBL", product_id: "P1", stock: 13 }]);
assert.equal(await stock("BR-CLK", "P1"), 1, "Zoho's number after the move");
assert.equal(await stock("BR-HBL", "P1"), 13, "Hubli doesn't change while it travels");
// The sync again, after the transfer was marked received in Zoho: Hubli already shows 15 (Zoho's 17 less 2 ordered).
await q("UPDATE public.branch_stock SET stock = 15 WHERE branch_id = 'BR-HBL' AND product_id = 'P1'");
await finish(synced.id, "ZT-11", "transferred", HBL_STAFF, [{ branch_id: "BR-CLK", product_id: "P1", stock: 1 }, { branch_id: "BR-HBL", product_id: "P1", stock: 17 }]);
assert.equal(await stock("BR-HBL", "P1"), 15, "not 17");
assert.equal(await total("P1"), 16);
// A website stock edit still waiting for Zoho keeps the website's count and moves with the transfer; a godown Zoho gave
// no number for moves by the quantity; website orders Zoho doesn't hold yet come off Zoho's number.
await q("UPDATE public.branch_stock SET stock = 10, zoho_pending = true WHERE branch_id = 'BR-CLK' AND product_id = 'P1'");
const waiting = (await split([{ branch_id: "BR-HBL", qty: 1 }]))[0];
assert.equal(await stock("BR-CLK", "P1"), 10, "untouched while it waits for Zoho");
await finish(waiting.id, "ZT-12", "in_transit", null, [{ branch_id: "BR-CLK", product_id: "P1", stock: 0 }]);
assert.equal(await stock("BR-CLK", "P1"), 9, "the waiting edit moves by 1; Zoho's 0 is not taken over it");
await q(`INSERT INTO public.settings (key, value, is_public) VALUES ('zoho_stock_master', '{"enabled": true, "since": "2026-01-01T00:00:00Z"}'::jsonb, false)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await finish(waiting.id, "ZT-12", "transferred", ADMIN, [{ branch_id: "BR-CLK", product_id: "P1", stock: 0 }, { branch_id: "BR-HBL", product_id: "P1", stock: 16 }]);
assert.equal(await stock("BR-HBL", "P1"), 14, "Zoho's 16 less the 2 ordered at Hubli on the website that Zoho doesn't hold yet");
const superNow = await batch(SUPER);
assert.equal(Number(superNow.remaining_quantity), 0);
assert.equal(Number(superNow.sent_quantity), 12, "everything was sent on");

// ---- batches in a transfer are kept
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_delete_batch($1)", [SUPER])), /part of a transfer/, "deleting the super batch");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_delete_batch($1)", [child.id])), /part of a transfer/, "deleting a sent batch");
// Even when its only transfer was cancelled (the transfer still names it): the friendly refusal, not a database error.
const lone = (await one("SELECT public.create_batches_from_bill('BR-CLK', $1, $2, 'ex_gst', $3, 'Office Admin') AS r",
  [JSON.stringify(bill("BILL-7", "VS931")), JSON.stringify([line("L71", "P2", 4, 9.52, 10, "TEST Sambar 17 GM", "Z2")]), ADMIN]))[0].batch_id;
const loneTransfer = (await split([{ branch_id: "BR-HBL", qty: 1 }], ADMIN, lone))[0];
await cancel(loneTransfer.id, "Zoho refused");
assert.equal(await stock("BR-CLK", "P2"), 0, "a cancel gives nothing back that never left");
assert.equal(Number((await batch(lone)).remaining_quantity), 4);
assert.equal(Number((await batch(lone)).sent_quantity), 0);
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_delete_batch($1)", [lone])), /part of a transfer/, "deleting a super batch whose transfer was cancelled");

// ---- the same send request twice (its answer was lost, Send pressed again): the transfers it began, nothing new
const REQ = "33333333-3333-4333-8333-333333333333";
const firstTry = await split([{ branch_id: "BR-HBL", qty: 1 }], ADMIN, lone, REQ);
const secondTry = await split([{ branch_id: "BR-HBL", qty: 1 }], ADMIN, lone, REQ);
assert.deepEqual(secondTry.map((x) => x.id), firstTry.map((x) => x.id));
assert.equal(Number((await batch(lone)).remaining_quantity), 3, "one unit sent, not two");
await cancel(firstTry[0].id, "test over");

// ---- Zoho not the stock master: Challakere's website had none of it, so the move makes none at Hubli either
await q("UPDATE public.branch_stock SET stock = 0 WHERE branch_id = 'BR-HBL' AND product_id = 'P2'");
const noMaster = (await split([{ branch_id: "BR-HBL", qty: 1 }], ADMIN, lone))[0];
assert.equal(Number((await finish(noMaster.id, "ZT-20", "in_transit")).reserved), 0, "nothing went down at Challakere");
await finish(noMaster.id, "ZT-20", "transferred", HBL_STAFF);
assert.equal(await stock("BR-HBL", "P2"), 0, "a move between godowns never makes website stock");

// ---- who may call and read what
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.begin_batch_split($1,$2,$3,'x',NULL)", [SUPER, JSON.stringify([{ branch_id: "BR-HBL", qty: 1 }]), ADMIN])), /permission denied/, "a browser starting a split");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.finish_batch_transfer(1,'x','transferred',NULL,NULL,NULL)")), /permission denied/, "a browser finishing a transfer");
await refuses(() => as(ADMIN, "authenticated", () => q(`SELECT public.claim_batch_transfer(1,'${C1}',60)`)), /permission denied/, "a browser claiming a transfer");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.receive_bill_here('BR-CLK','{}','[]','ex_gst',NULL,'x')")), /permission denied/, "a browser receiving a bill");
await refuses(() => as(null, "anon", () => q("SELECT * FROM public.batch_transfers")), /permission denied/, "anon reading transfers");
assert.ok((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS c FROM public.batch_transfers")))[0].c >= 5, "admins read transfers");
assert.equal((await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS c FROM public.batch_transfers")))[0].c, 0, "others see none");
await refuses(() => q("UPDATE public.batch_transfer_counter SET last_no = 0"), /./, "the counter only goes up through the function");

console.log("batch transfers OK");
