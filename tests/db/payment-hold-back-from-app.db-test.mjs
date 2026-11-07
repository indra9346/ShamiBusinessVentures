// Real-Postgres check of 20261107180000_payment_hold_back_from_app.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/payment-hold-back-from-app.db-test.mjs
//
// It must end with "back from app OK".
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
for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migrations, file), "utf8"));

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);

await db.exec(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('OIL', 'VENDOR-001', 'Oil', $1::jsonb, 'approved', true)`,
  [JSON.stringify({ id: "OIL", name: "Sample Oil", price: 130, stock: 1000, sold: 0, gst: 5, sku: "SKU-OIL", category: "Oil", vendor: "Shami", vendorId: "VENDOR-001", weight: "850 ml" })]);

const customer = async () => {
  const id = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [id, `c${id.slice(0, 8)}@test.in`]);
  return id;
};
const checkout = async (buyer) => {
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', 'UPI', $4::jsonb, NULL) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522" }), JSON.stringify([{ product_id: "OIL", qty: 1 }]),
  ])).r;
  await as(null);
  return r.order_no;
};
const holdOf = (no) => one(`SELECT order_status, payment_hold_until AS until, payment_hold_extended_at AS ext FROM public.orders WHERE order_no = $1`, [no]);
const extend = async (uid, no) => {
  await as(uid);
  await db.exec(`SET ROLE authenticated`);
  try { return (await one(`SELECT public.extend_my_payment_hold($1) AS r`, [no])).r; } finally { await db.exec(`RESET ROLE`); await as(null); }
};
const minutes = (a, b) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60_000);

const buyer = await customer(), other = await customer();
const no = await checkout(buyer);
const before = await holdOf(no);
assert.equal(before.order_status, "Awaiting Payment");
assert.equal(before.ext, null);

// Back from the UPI app: 10 more minutes, once.
const until = await extend(buyer, no);
assert.equal(minutes(until, before.until), 10);
const after = await holdOf(no);
assert.equal(minutes(after.until, before.until), 10);
assert.ok(after.ext);
assert.equal(after.order_status, "Awaiting Payment", "still waiting for the payment");
assert.equal(minutes(await extend(buyer, no), before.until), 10, "a second return keeps the time it has");

// Not someone else's checkout, and not without signing in.
await assert.rejects(() => extend(other, no), /Order not found/);
assert.equal((await q("SELECT has_function_privilege('anon','public.extend_my_payment_hold(text)','EXECUTE') AS p"))[0].p, false);

// A checkout whose time already ran out gets nothing.
const late = await checkout(buyer);
await db.exec(`SET session_replication_role = replica`);
await db.query(`UPDATE public.orders SET payment_hold_until = now() - interval '1 minute' WHERE order_no = $1`, [late]);
await db.exec(`SET session_replication_role = DEFAULT`);
const lateBefore = await holdOf(late);
await extend(buyer, late);
assert.equal((await holdOf(late)).ext, null);
assert.equal(minutes((await holdOf(late)).until, lateBefore.until), 0);

// The expiry still ends an extended checkout once its new time is over.
await db.exec(`SET session_replication_role = replica`);
await db.query(`UPDATE public.orders SET payment_hold_until = now() - interval '1 minute' WHERE order_no = $1`, [no]);
await db.exec(`SET session_replication_role = DEFAULT`);
await q(`SELECT public.expire_payment_holds()`);
assert.equal((await holdOf(no)).order_status, "Payment Expired");

console.log("back from app OK");
