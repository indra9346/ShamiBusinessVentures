// Real-Postgres check of 20261105190000_batches_from_bills.sql, on PGlite with every migration in the
// repo and small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho,
// because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/batches-from-bills.db-test.mjs
//
// It must end with "batches from bills OK".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261105190000_batches_from_bills.sql";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin; CREATE ROLE postgres_stub;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  -- What Supabase does for every new table: the migration has to take it back itself.
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
for (const file of files.filter((name) => name < MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const ADMIN = "00000000-0000-4000-8000-0000000000a1", VENDOR = "00000000-0000-4000-8000-0000000000b1", CUSTOMER = "00000000-0000-4000-8000-0000000000c1";


// Live's shape before the migration: two godowns, the five products of SS4463 / VS903 with stock, and an old
// Receive-purchase batch that posted a Zoho adjustment (like CLK-051126-01). All made up apart from the bill numbers.
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q(`INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-CLK','CLK','Challakere Godown',true,'LOC-CLK') ON CONFLICT (id) DO UPDATE SET active = true, zoho_location_id = 'LOC-CLK'`);
const PRODUCTS = { EKA: "Ekadantha OIL 850ML", BIS: "M Bisebelebath 17 GM", SAM: "M Sambar 17GM", MEE: "C meera Coconut oil 500ML", ZAN: "E Zandu ultra balm 8ML" };
const STOCK = { EKA: 12, BIS: 2, SAM: 6, MEE: 6, ZAN: 4 };
await q(`ALTER TABLE public.catalog_products DISABLE TRIGGER USER`);
for (const [id, name] of Object.entries(PRODUCTS))
  await q(`INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ($1,'V1','Oil','approved',true,$2)`,
    [id, JSON.stringify({ id, name, sku: `SKU-${id}`, stock: STOCK[id], unit: "pcs", vendor: "Grain Bazar" })]);
await q(`ALTER TABLE public.catalog_products ENABLE TRIGGER USER`);
for (const [id, stock] of Object.entries(STOCK)) await q(`INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK',$1,$2,false)`, [id, stock]);
await q(`INSERT INTO public.zoho_item_links (product_id, zoho_item_id) VALUES ('EKA','I-L5'),('BIS','I-L1'),('SAM','I-L2'),('MEE','I-L3'),('ZAN','I-L4')`);
await q(`INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, zoho_adjustment_id, status)
  VALUES ('CLK-051126-01','EKA','Ekadantha OIL 850ML',12,12,'pcs',130,'2026-11-05','BR-CLK','Challakere Godown','website','ADJ-OLD-1','Active')`);

await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
for (const file of files.filter((name) => name > MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

async function as(uid, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [uid]);
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const admin = (fn) => as(ADMIN, "authenticated", fn);
const customer = (fn) => as(CUSTOMER, "authenticated", fn);
const server = (fn) => as(null, "service_role", fn);
const refused = async (fn, pattern) => {
  let error;
  try { await fn(); } catch (cause) { error = cause; }
  assert.ok(error, `expected a refusal: ${pattern}`);
  assert.match(error.message, pattern);
};
const stockNow = async () => JSON.stringify([
  await q(`SELECT branch_id, product_id, stock::text, zoho_pending FROM public.branch_stock ORDER BY product_id`),
  await q(`SELECT id, payload->>'stock' AS s FROM public.catalog_products ORDER BY id`),
]);
const stockBefore = await stockNow();

/* ---------- the old batch is untouched ---------- */
const [old] = await q(`SELECT unit_cost::text, cost_basis, zoho_bill_id, bill_flag, zoho_adjustment_id FROM public.batches WHERE batch_code = 'CLK-051126-01'`);
assert.deepEqual(old, { unit_cost: "130.00", cost_basis: null, zoho_bill_id: "", bill_flag: "", zoho_adjustment_id: "ADJ-OLD-1" });

/* ---------- the old receipt cannot run any more, for anyone ---------- */
await refused(() => server(() => q(`SELECT public.record_batch_receipt('X-1','BR-CLK','EKA',1,1,'2026-11-05',NULL,NULL,'','','','','','',true,NULL,'')`)), /permission denied/);

/* ---------- batches from SS4463 and VS903, with the real numbers ---------- */
const SS4463 = { bill_id: "B-SS4463", bill_number: "SS4463", vendor_name: "NIRANJANA ENTERPRISES", date: "2026-11-03", modified: "2026-11-05T18:10:00+0530", total: 2217 };
const ssLines = [
  { line_id: "L1", product_id: "BIS", zoho_item_id: "I-L1", qty: 2, unit_ex_gst: 98.04, unit_inc_gst: 102.94 },
  { line_id: "L2", product_id: "SAM", zoho_item_id: "I-L2", qty: 6, unit_ex_gst: 92.21, unit_inc_gst: 96.82, expiry_date: "2027-11-01", notes: "Shelf 3" },
  { line_id: "L3", product_id: "MEE", zoho_item_id: "I-L3", qty: 6, unit_ex_gst: 198.41, unit_inc_gst: 208.33 },
  { line_id: "L4", product_id: "ZAN", zoho_item_id: "I-L4", qty: 4, unit_ex_gst: 42.86, unit_inc_gst: 45.0 },
];
// Only the server may make them.
await refused(() => admin(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'')`, [JSON.stringify(SS4463), JSON.stringify(ssLines)])), /permission denied/);
await refused(() => customer(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'')`, [JSON.stringify(SS4463), JSON.stringify(ssLines)])), /permission denied/);
await refused(() => server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'cheapest',NULL,'')`, [JSON.stringify(SS4463), JSON.stringify(ssLines)])), /Choose cost/);

const [{ made }] = await server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',$3,'Admin') AS made`,
  [JSON.stringify(SS4463), JSON.stringify(ssLines), ADMIN]));
assert.deepEqual(made.map((m) => [m.line_id, m.batch_code]), [["L1", "CLK-031126-01"], ["L2", "CLK-031126-02"], ["L3", "CLK-031126-03"], ["L4", "CLK-031126-04"]]);
const VS903 = { bill_id: "B-VS903", bill_number: "VS903", vendor_name: "SHAKTHIDHARA ENTERPRISES", date: "2026-11-03", modified: "", total: 1560 };
const [{ made: madeVs }] = await server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'inc_gst',NULL,'') AS made`,
  [JSON.stringify(VS903), JSON.stringify([{ line_id: "L5", product_id: "EKA", qty: 12, unit_ex_gst: 123.81, unit_inc_gst: 130 }])]));
assert.equal(madeVs[0].batch_code, "CLK-031126-05");

const rows = await q(`SELECT product_id, quantity::text q, remaining_quantity::text r, unit_cost::text c, unit_cost_ex_gst::text ex, unit_cost_inc_gst::text inc,
  cost_basis, supplier, purchase_ref, purchase_date::text d, zoho_bill_line_id, expiry_date::text e, notes, zoho_adjustment_id
  FROM public.batches WHERE zoho_bill_id <> '' ORDER BY batch_code`);
assert.deepEqual(rows.map((r) => [r.product_id, r.q, r.c, r.ex, r.inc, r.cost_basis]), [
  ["BIS", "2.00", "98.04", "98.04", "102.94", "ex_gst"],
  ["SAM", "6.00", "92.21", "92.21", "96.82", "ex_gst"],
  ["MEE", "6.00", "198.41", "198.41", "208.33", "ex_gst"],
  ["ZAN", "4.00", "42.86", "42.86", "45.00", "ex_gst"],
  ["EKA", "12.00", "130.00", "123.81", "130.00", "inc_gst"],
]);
assert.ok(rows.every((r) => r.r === r.q && r.d === "2026-11-03" && r.zoho_adjustment_id === ""));
assert.deepEqual([rows[1].supplier, rows[1].purchase_ref, rows[1].e, rows[1].notes], ["NIRANJANA ENTERPRISES", "SS4463", "2027-11-01", "Shelf 3"]);

/* ---------- making batches changed no stock, on any row ---------- */
assert.equal(await stockNow(), stockBefore, "creating batches must not change godown or catalogue stock");
assert.equal((await q(`SELECT count(*)::int n FROM public.batch_adjustments`))[0].n, 0);

/* ---------- the same bill line can't be batched twice ---------- */
await refused(() => server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'')`, [JSON.stringify(SS4463), JSON.stringify([ssLines[0]])])), /already batch CLK-031126-01/);
// Not even by writing the row directly as the database owner: the index holds.
await refused(() => (q(`INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit_cost, branch_id, zoho_bill_id, zoho_bill_line_id)
  VALUES ('CLK-X-1','BIS','x',1,1,1,'BR-CLK','B-SS4463','L1')`)), /duplicate key/);
// All or none: a bill with one done line and one new line makes nothing.
const before = (await q(`SELECT count(*)::int n FROM public.batches`))[0].n;
await refused(() => server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'')`,
  [JSON.stringify(SS4463), JSON.stringify([{ ...ssLines[0], line_id: "L9" }, ssLines[3]])])), /already batch/);
assert.equal((await q(`SELECT count(*)::int n FROM public.batches`))[0].n, before);

/* ---------- a Zoho batch-tracked item never gets a second batch from the bill ---------- */
await q(`UPDATE public.zoho_item_links SET track_batches = true WHERE product_id = 'BIS'`);
await refused(() => server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'')`,
  [JSON.stringify({ ...SS4463, bill_id: "B-OTHER" }), JSON.stringify([ssLines[0]])])), /batch tracking in Zoho/);
await q(`UPDATE public.zoho_item_links SET track_batches = false WHERE product_id = 'BIS'`);

/* ---------- a bill's cost is the bill's: no typing over it ---------- */
const [{ id: samId }] = await q(`SELECT id FROM public.batches WHERE zoho_bill_line_id = 'L2'`);
await refused(() => admin(() => q(`SELECT public.admin_update_batch($1, 90, '', '', '', NULL, NULL)`, [samId])), /comes from bill SS4463/);
await admin(() => q(`SELECT public.admin_update_batch($1, 92.21, 'someone else', 'X', 'moved to shelf 4', NULL, '2027-12-01')`, [samId]));
assert.deepEqual(await q(`SELECT supplier, purchase_ref, notes, expiry_date::text e, unit_cost::text c FROM public.batches WHERE id = $1`, [samId]),
  [{ supplier: "NIRANJANA ENTERPRISES", purchase_ref: "SS4463", notes: "moved to shelf 4", e: "2027-12-01", c: "92.21" }]);

/* ---------- delete: only while nothing has touched the batch, and never with stock ---------- */
const id = async (line) => (await q(`SELECT id FROM public.batches WHERE zoho_bill_line_id = $1`, [line]))[0].id;
await refused(() => customer(() => q(`SELECT public.admin_delete_batch($1)`, [samId])), /Only administrators/);
await refused(() => server(() => q(`SELECT public.admin_delete_batch($1)`, [samId])), /Only administrators/);
// An order holding Zandu, still awaiting payment.
const [{ id: orderId }] = await q(`INSERT INTO public.orders (order_no, user_id, order_status, branch_id) VALUES ('ORD-T1', '${CUSTOMER}', 'Awaiting Payment', 'BR-CLK') RETURNING id`);
const [{ id: itemId }] = await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty) VALUES ($1,'ZAN','Zandu',1) RETURNING id`, [orderId]);
await q(`SELECT private.allocate_order_item_batches($1,'ZAN','BR-CLK',1)`, [itemId]);
const zanId = await id("L4"), meeId = await id("L3");
await refused(() => admin(() => q(`SELECT public.admin_delete_batch($1)`, [zanId])), /Orders have taken stock/);
// Released again (the checkout lapsed): still kept, for the order's record.
await q(`UPDATE public.order_item_batch_allocations SET released_quantity = reserved_quantity WHERE order_item_id = $1`, [itemId]);
await refused(() => admin(() => q(`SELECT public.admin_delete_batch($1)`, [zanId])), /used batch .* before/);
// A stock count changed Meera's batch.
await q(`INSERT INTO public.batch_adjustments (batch_id, qty, reason, unit_cost) VALUES ($1, -1, 'damaged', 198.41)`, [meeId]);
await refused(() => admin(() => q(`SELECT public.admin_delete_batch($1)`, [meeId])), /Stock counts have changed/);
// Sambar is untouched: it goes, and no stock moves.
const stockMid = await stockNow();
const [{ r: gone }] = await admin(() => q(`SELECT public.admin_delete_batch($1) AS r`, [samId]));
assert.deepEqual(gone, { batch_code: "CLK-031126-02", zoho_adjustment_id: "" });
assert.equal(await stockNow(), stockMid, "deleting a batch must not change stock");
// The old Receive-purchase batch goes too, and says which Zoho adjustment it once made.
const [{ id: oldId }] = await q(`SELECT id FROM public.batches WHERE batch_code = 'CLK-051126-01'`);
const [{ r: oldGone }] = await admin(() => q(`SELECT public.admin_delete_batch($1) AS r`, [oldId]));
assert.deepEqual(oldGone, { batch_code: "CLK-051126-01", zoho_adjustment_id: "ADJ-OLD-1" });
// The deleted Sambar line may be batched again (the bill is still there); its number is new, never reused.
const [{ made: again }] = await server(() => q(`SELECT public.create_batches_from_bill('BR-CLK',$1,$2,'ex_gst',NULL,'') AS made`, [JSON.stringify(SS4463), JSON.stringify([ssLines[1]])]));
assert.equal(again[0].batch_code, "CLK-031126-06");

/* ---------- a bill changed in Zoho is flagged, nothing else moves ---------- */
const snapshot = async () => JSON.stringify(await q(`SELECT id, quantity, remaining_quantity, unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis FROM public.batches ORDER BY id`));
const kept = await snapshot();
await refused(() => admin(() => q(`SELECT public.flag_batch_bill_changes($1)`, [JSON.stringify([{ bill_id: "B-VS903", flag: "x" }])])), /permission denied/);
const [{ n: flagged }] = await server(() => q(`SELECT public.flag_batch_bill_changes($1) AS n`, [JSON.stringify([{ bill_id: "B-VS903", flag: "Bill voided in Zoho" }, { bill_id: "B-SS4463", flag: "" }])]));
assert.equal(flagged, 1);
assert.deepEqual(await q(`SELECT zoho_bill_id, bill_flag, (bill_flag_at IS NOT NULL) f FROM public.batches WHERE zoho_bill_id <> '' GROUP BY 1,2,3 ORDER BY 1`),
  [{ zoho_bill_id: "B-SS4463", bill_flag: "", f: false }, { zoho_bill_id: "B-VS903", bill_flag: "Bill voided in Zoho", f: true }]);
assert.equal(await snapshot(), kept, "a bill flag must not change any quantity or cost");

/* ---------- reading: admins only, as before ---------- */
assert.equal((await customer(() => q(`SELECT count(*)::int n FROM public.batches`)))[0].n, 0);
assert.ok((await admin(() => q(`SELECT count(*)::int n FROM public.batches`)))[0].n > 0);

console.log("batches from bills OK");
