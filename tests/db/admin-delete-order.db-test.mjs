// Real-Postgres check of 20261106120000_admin_delete_order.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/admin-delete-order.db-test.mjs
//
// It must end with "admin delete order OK".
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261106120000_admin_delete_order.sql";

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



await q("INSERT INTO auth.users (id, email) VALUES ('" + ADMIN + "','a@test.local'),('" + CUSTOMER + "','c@test.local') ON CONFLICT DO NOTHING");
await q("DELETE FROM public.user_roles WHERE user_id IN ('" + ADMIN + "','" + CUSTOMER + "')");
await q("INSERT INTO public.user_roles (user_id, role) VALUES ('" + ADMIN + "','admin'),('" + CUSTOMER + "','customer')");
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-CLK','CLK','Challakere Godown',true,'LOC-CLK') ON CONFLICT (id) DO UPDATE SET active = true");
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Rice','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Rice", stock: 50, unit: "bag" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Rice',50,50,'bag',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
const batchId = (await q("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'"))[0].id;

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", ...extra };
  const cols = Object.keys(row);
  const id = (await q("INSERT INTO public.orders (" + cols.join(",") + ") VALUES (" + cols.map((_, i) => "$" + (i + 1)).join(",") + ") RETURNING id", Object.values(row)))[0].id;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total) VALUES ($1,'P1','TEST Rice',1,100,100) RETURNING id", [id]))[0].id;
  return { id, item };
}
const O = {
  ok: await order("TEST-EXP-1", "Payment Expired", { payment_hold_outcome: "expired" }),
  utr: await order("TEST-EXP-UTR", "Payment Expired"),
  zoho: await order("TEST-CAN-ZOHO", "Cancelled", { zoho_salesorder_id: "SO-1" }),
  live: await order("TEST-DEL", "Delivered"),
  paid: await order("TEST-CAN-PAID", "Cancelled", { paid_amount: 100, payment_status: "Partially Paid" }),
  open: await order("TEST-EXP-OPEN", "Payment Expired", { payment_hold_until: new Date(Date.now() + 3600e3).toISOString() }),
  held: await order("TEST-EXP-HELD", "Payment Expired"),
  released: await order("TEST-CAN-REL", "Cancelled"),
};
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await q("ALTER TABLE public.upi_payment_submissions DISABLE TRIGGER USER");
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status) VALUES ($1,'TEST-EXP-UTR',$2,'123456789012',100,'submitted')", [O.utr.id, CUSTOMER]);
await q("ALTER TABLE public.upi_payment_submissions ENABLE TRIGGER USER");
await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,1,0,100),($3,$2,1,1,100)", [O.held.item, batchId, O.released.item]);

await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
for (const file of files.filter((name) => name > MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

async function as(uid, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [uid]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const blocker = (no) => as(ADMIN, "authenticated", async () => (await q("SELECT public.order_delete_blocker($1) AS r", [no]))[0].r);
const del = (uid, no) => as(uid, "authenticated", () => q("SELECT public.admin_delete_order($1, 'TEST cleanup') AS r", [no]));
const exists = async (no) => (await q("SELECT count(*)::int AS n FROM public.orders WHERE order_no = $1", [no]))[0].n === 1;

// Only admins, and anon not at all.
await assert.rejects(() => as(CUSTOMER, "authenticated", () => q("SELECT public.order_delete_blocker('TEST-EXP-1')")), /Only administrators/);
await assert.rejects(() => del(CUSTOMER, "TEST-EXP-1"), /Only administrators/);
assert.equal((await q("SELECT has_function_privilege('anon','public.admin_delete_order(text,text)','EXECUTE') AS p"))[0].p, false);
assert.equal((await q("SELECT has_function_privilege('authenticated','public.order_delete_reason_internal(uuid)','EXECUTE') AS p"))[0].p, false);

// Each reason an order must stay.
assert.equal(await blocker("TEST-EXP-1"), null);
assert.equal(await blocker("TEST-CAN-REL"), null);
assert.match(await blocker("TEST-EXP-UTR"), /UTR/);
assert.match(await blocker("TEST-CAN-ZOHO"), /Zoho/);
assert.match(await blocker("TEST-DEL"), /Only an order whose payment window ran out/);
assert.match(await blocker("TEST-CAN-PAID"), /Money was recorded/);
assert.match(await blocker("TEST-EXP-OPEN"), /still open/);
assert.match(await blocker("TEST-EXP-HELD"), /Stock is still held/);
assert.match(await blocker("NO-SUCH"), /no longer exists/);
for (const no of ["TEST-EXP-UTR", "TEST-CAN-ZOHO", "TEST-DEL", "TEST-CAN-PAID", "TEST-EXP-OPEN", "TEST-EXP-HELD"]) {
  await assert.rejects(() => del(ADMIN, no), /stays|Only an order|still open|still held/);
  assert.equal(await exists(no), true, no + " must stay");
}

// A delete: the order, its items and allocations go; stock, batches and Zoho are untouched; a record stays.
const before = {
  stock: (await q("SELECT stock FROM public.branch_stock WHERE product_id = 'P1'"))[0].stock,
  payload: (await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s,
  batch: (await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity,
};
await q("INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type) VALUES ('order', $1, 'upsert')", [O.ok.id]);
const outboxOthers = (await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE NOT (entity_type = 'order' AND entity_id = $1)", [O.ok.id]))[0].n;
const result = (await del(ADMIN, "TEST-EXP-1"))[0].r;
assert.equal(result.order_no, "TEST-EXP-1");
assert.equal(result.items, 1);
assert.equal(await exists("TEST-EXP-1"), false);
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_items WHERE order_id = $1", [O.ok.id]))[0].n, 0);
assert.equal((await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [O.ok.id]))[0].n, 0, "no Zoho job left for a deleted order");
assert.equal((await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE NOT (entity_type = 'order' AND entity_id = $1)", [O.ok.id]))[0].n, outboxOthers, "no new Zoho job");
await del(ADMIN, "TEST-CAN-REL");
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_item_batch_allocations WHERE order_item_id = $1", [O.released.item]))[0].n, 0);
assert.equal((await q("SELECT stock FROM public.branch_stock WHERE product_id = 'P1'"))[0].stock, before.stock, "godown stock unchanged");
assert.equal((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s, before.payload, "catalogue stock unchanged");
assert.equal((await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity, before.batch, "batch unchanged");

const log = await q("SELECT order_no, order_status, total, item_count, reason, deleted_by FROM public.deleted_orders_log ORDER BY id");
assert.deepEqual(log.map((row) => row.order_no), ["TEST-EXP-1", "TEST-CAN-REL"]);
assert.equal(log[0].deleted_by, ADMIN);
assert.equal(log[0].reason, "TEST cleanup");
assert.equal(Number(log[0].total), 100);

// Only admins read the record.
assert.equal((await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS n FROM public.deleted_orders_log")))[0].n, 0);
assert.equal((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS n FROM public.deleted_orders_log")))[0].n, 2);
await assert.rejects(() => as(ADMIN, "authenticated", () => q("DELETE FROM public.deleted_orders_log")), /permission denied/);

// A deleted number is never used again, and deleting twice says it is gone.
await q("ALTER TABLE public.orders DISABLE TRIGGER orders_require_payment_first");
await assert.rejects(() => order("TEST-EXP-1", "Payment Expired"), /used before and deleted/);
await assert.rejects(() => del(ADMIN, "TEST-EXP-1"), /no longer exists/);

console.log("admin delete order OK");
