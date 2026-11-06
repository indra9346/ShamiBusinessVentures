// Real-Postgres check of 20261106210000_house_seller_name.sql, on PGlite with every migration in the repo and small
// stand-ins for what Supabase provides. It first builds the live situation of 6 Nov 2026 (a test login linked to the
// shop's own seller code, renaming every product to the business name it used at checkout), then applies the
// migration. All data is made up; nothing live is touched. Not part of test:zoho, because PGlite is not a dependency:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/house-seller.db-test.mjs
//
// It must end with "house seller OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  -- What Supabase does for every new table and function: the migration has to take it back itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
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
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
  CREATE PUBLICATION supabase_realtime;
`);
const migrations = join(root, "supabase", "migrations");
const MIGRATION = "20261106210000_house_seller_name.sql";
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const at = files.indexOf(MIGRATION);
assert.ok(at >= 0, "migration file present");
for (const file of files.slice(0, at)) await db.exec(readFileSync(join(migrations, file), "utf8"));
const later = files.slice(at + 1);

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);
/** Runs as a signed-in user under the real role, so table rights and row rules apply. */
const asUser = async (uid, sql, params) => {
  await as(uid);
  await db.exec(`SET ROLE authenticated`);
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE`); }
};
const asServer = async (sql, params) => {
  await as(null);
  await db.exec(`SET ROLE service_role`);
  try { return await one(sql, params); } finally { await db.exec(`RESET ROLE`); }
};
/** Reads as a signed-out visitor, under the real role. */
const asAnon = async (sql, params) => {
  await as(null);
  await db.exec(`SET ROLE anon`);
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE`); }
};
const COMPANY = "Shami Business Ventures Private Limited";
const ADMIN = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'admin@test.in', '{"full_name":"Test Admin"}')`, [ADMIN]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await db.exec(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('company', $1::jsonb, true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [JSON.stringify({ name: COMPANY, gstin: "29AAAAA0000A1Z5" })]);
await db.exec(`ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);

// ---------------------------------------------------------------- the live situation before the fix
// A test login: customer and vendor, linked to the shop's own seller code, approved.
const TESTER = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'tester@test.in', '{"full_name":"TEST Tester"}')`, [TESTER]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'vendor') ON CONFLICT DO NOTHING`, [TESTER]);
await db.query(`UPDATE public.profiles SET vendor_id = 'VENDOR-001', status = 'approved' WHERE id = $1`, [TESTER]);
const PRODUCT = (id, name, vendorId, vendor) => JSON.stringify({ id, name, price: 1000, stock: 500, sold: 0, active: true, status: "approved", gst: 0, sku: `SKU-${id}`, category: "Rice", vendor, vendorId, weight: "25 kg", maxPurchaseQuantity: 5000 });
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PH', 'VENDOR-001', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PH", "TEST House Rice", "VENDOR-001", COMPANY)]);
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PH2', 'VENDOR-001', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PH2", "TEST House Rice 2", "VENDOR-001", COMPANY)]);

const checkout = async (buyer, { b2b = null, name = null } = {}) => {
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', 'UPI', $4::jsonb, NULL, $5, NULL, $6) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }),
    JSON.stringify([{ product_id: "PH", qty: 1 }]), b2b, name,
  ])).r;
  await as(ADMIN);
  return r.order_no;
};
const sellerOn = async (id) => (await one(`SELECT payload->>'vendor' AS v FROM public.catalog_products WHERE id = $1`, [id])).v;
const lineSeller = async (orderNo) => (await one(`SELECT i.vendor FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1`, [orderNo])).vendor;
const outbox = async () => (await one(`SELECT count(*)::int AS n FROM public.zoho_sync_outbox`)).n;

// The tester checks out as a business: checkout saves the business name as the login's company, and the old
// vendor-name rule copies it onto every shop product. This is what happened live.
const bizOrder = await checkout(TESTER, { b2b: true, name: "i-developmentworks" });
assert.equal(await sellerOn("PH"), "i-developmentworks", "the bug: a customer's business name renamed the shop's products");
assert.equal(await sellerOn("PH2"), "i-developmentworks");
const BUYER = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'buyer@test.in', '{"full_name":"TEST Buyer"}')`, [BUYER]);
const oldOrder = await checkout(BUYER);
assert.equal(await lineSeller(oldOrder), "i-developmentworks", "and every order line since copied it");
await db.query(`INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status, vendor, vendor_id)
  VALUES ('TEST-B1', 'PH', 'TEST House Rice', 10, 10, 'bag', 900, '2026-11-01', 'BR-CLK', 'Challakere Godown', 'website', 'Active', 'i-developmentworks', 'VENDOR-001')`);
// Unlinking the tester now (what "delete the vendor" would do) would empty the shop: no seller login left.
await db.exec(`BEGIN`);
await db.query(`UPDATE public.profiles SET vendor_id = NULL WHERE id = $1`, [TESTER]);
assert.equal((await asAnon(`SELECT id FROM public.catalog_products WHERE id IN ('PH','PH2')`)).length, 0, "without the fix, unlinking hides every shop product");
await db.exec(`ROLLBACK`);
assert.equal((await asAnon(`SELECT id FROM public.catalog_products WHERE id IN ('PH','PH2')`)).length, 2);
const stockBefore = await q(`SELECT id, payload->>'stock' AS s FROM public.catalog_products ORDER BY id`);

// ---------------------------------------------------------------- the migration
const jobsBefore = await outbox();
await db.exec(readFileSync(join(migrations, MIGRATION), "utf8"));
for (const file of later) await db.exec(readFileSync(join(migrations, file), "utf8"));
assert.equal(await outbox(), jobsBefore, "the repair sends nothing to Zoho");
assert.deepEqual(await q(`SELECT id, payload->>'stock' AS s FROM public.catalog_products ORDER BY id`), stockBefore, "stock untouched");

// The test login is a customer only, keeps its orders and its business name for its own invoices.
assert.deepEqual((await q(`SELECT role::text AS r FROM public.user_roles WHERE user_id = $1 ORDER BY 1`, [TESTER])).map((row) => row.r), ["customer"]);
const tester = await one(`SELECT vendor_id, company FROM public.profiles WHERE id = $1`, [TESTER]);
assert.equal(tester.vendor_id, null);
assert.equal(tester.company, "i-developmentworks");
assert.equal((await one(`SELECT count(*)::int AS n FROM public.orders WHERE order_no = $1`, [bizOrder])).n, 1);

// The shop still lists the company's products, now under the company name, and so do the old order lines and batches.
assert.deepEqual((await asAnon(`SELECT id, payload->>'vendor' AS v FROM public.catalog_products WHERE id IN ('PH','PH2') ORDER BY id`)),
  [{ id: "PH", v: COMPANY }, { id: "PH2", v: COMPANY }]);
assert.equal(await lineSeller(oldOrder), COMPANY);
assert.equal(await lineSeller(bizOrder), COMPANY);
assert.equal((await one(`SELECT vendor FROM public.batches WHERE batch_code = 'TEST-B1'`)).vendor, COMPANY);
const newOrder = await checkout(BUYER);
assert.equal(await lineSeller(newOrder), COMPANY, "a new order line carries the company name");

// A customer's business name at checkout never renames the shop's products again.
await checkout(TESTER, { b2b: true, name: "TEST Another Biz" });
assert.equal((await one(`SELECT company FROM public.profiles WHERE id = $1`, [TESTER])).company, "TEST Another Biz");
assert.equal(await sellerOn("PH"), COMPANY);

// Nobody can be linked to the shop's seller code again.
await assert.rejects(db.query(`UPDATE public.profiles SET vendor_id = 'VENDOR-001' WHERE id = $1`, [TESTER]), /profiles_not_house_seller/);

// An admin saving a product cannot give it another seller name.
await asUser(ADMIN, `UPDATE public.catalog_products SET payload = jsonb_set(payload, '{vendor}', '"TEST wrong"') WHERE id = 'PH'`);
assert.equal(await sellerOn("PH"), COMPANY);

// A new company name in Website details becomes the seller name, without a Zoho job or a stock change.
const jobs = await outbox();
await asUser(ADMIN, `UPDATE public.settings SET value = value || '{"legal_name":"TEST Renamed Pvt Ltd"}'::jsonb WHERE key = 'company'`);
assert.equal(await sellerOn("PH"), "TEST Renamed Pvt Ltd");
assert.equal(await sellerOn("PH2"), "TEST Renamed Pvt Ltd");
assert.equal(await outbox(), jobs);
assert.equal(await lineSeller(oldOrder), COMPANY, "old order lines keep the name they were sold under");
// Unrelated settings changes do nothing.
await asUser(ADMIN, `UPDATE public.settings SET value = value || '{"phone":"9000000000"}'::jsonb WHERE key = 'company'`);
assert.equal(await sellerOn("PH"), "TEST Renamed Pvt Ltd");
await asUser(ADMIN, `UPDATE public.settings SET value = value - 'legal_name' WHERE key = 'company'`);
assert.equal(await sellerOn("PH"), COMPANY);

// A marketplace vendor still works the old way: shown while active, hidden when suspended, renamed with its profile.
const SELLER = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'seller@test.in', '{"full_name":"TEST Seller"}')`, [SELLER]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'vendor') ON CONFLICT DO NOTHING`, [SELLER]);
await db.query(`UPDATE public.profiles SET vendor_id = 'VND-TEST1', status = 'approved', company = 'TEST Seller Co' WHERE id = $1`, [SELLER]);
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PV', 'VND-TEST1', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PV", "TEST Vendor Rice", "VND-TEST1", "x")]);
assert.equal(await sellerOn("PV"), "TEST Seller Co");
assert.equal((await asAnon(`SELECT id FROM public.catalog_products WHERE id = 'PV'`)).length, 1);
await db.query(`UPDATE public.profiles SET company = 'TEST Seller Renamed' WHERE id = $1`, [SELLER]);
assert.equal(await sellerOn("PV"), "TEST Seller Renamed");
assert.equal(await sellerOn("PH"), COMPANY, "a vendor's rename leaves the shop's products alone");
await db.query(`UPDATE public.profiles SET status = 'suspended' WHERE id = $1`, [SELLER]);
assert.equal((await asAnon(`SELECT id FROM public.catalog_products WHERE id = 'PV'`)).length, 0, "a suspended vendor's products stay hidden");
assert.equal((await asAnon(`SELECT id FROM public.catalog_products WHERE id = 'PH'`)).length, 1);

// The helper is not open to signed-out visitors.
await assert.rejects(asAnon(`SELECT public.house_seller_name('VENDOR-001')`), /permission denied/);
assert.equal((await asUser(ADMIN, `SELECT public.house_seller_name('VND-TEST1') AS n`))[0].n, null);

console.log("house seller OK");
