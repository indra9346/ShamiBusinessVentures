// Real-Postgres check of 20261107160000_prices_include_gst.sql, on PGlite with every migration in the repo and small
// stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho, because
// PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/prices-include-gst.db-test.mjs
//
// Orders go through the real checkout function (start_paid_checkout). It must end with "prices include GST OK".
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
const MIGRATION = "20261107160000_prices_include_gst.sql";
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const at = files.indexOf(MIGRATION);
assert.ok(at >= 0, "migration file present");
for (const file of files.slice(0, at)) await db.exec(readFileSync(join(migrations, file), "utf8"));

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);
const n = (value) => Number(value);

const ADMIN = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'admin@test.in', '{"full_name":"Test Admin"}')`, [ADMIN]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await db.exec(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
// The default godown delivers too, free from ₹5,000 of goods, so the free-delivery rule can be seen.
await db.exec(`UPDATE public.branches SET delivery_enabled = true, pickup_enabled = true, delivery_fee = 100, free_delivery_above = 5000 WHERE id = public.default_branch_id()`);
const PRODUCT = (id, name, price, gst) => JSON.stringify({ id, name, price, mrp: price, stock: 100000, sold: 0, active: true, status: "approved", gst, sku: `SKU-${id}`, category: "Oil", vendor: "Shami", vendorId: "VENDOR-001", weight: "1 pc", maxPurchaseQuantity: 5000 });
for (const [id, name, price, gst] of [["OIL", "Sample Oil 850ml", 130, 5], ["SUGAR", "Sample Sugar 50kg", 2700, 5], ["SOAP", "Sample Soap", 112, 12], ["SALT", "Sample Salt", 50, 0]]) {
  await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ($1, 'VENDOR-001', 'Oil', $2::jsonb, 'approved', true)`, [id, PRODUCT(id, name, price, gst)]);
}
await db.query(`INSERT INTO public.coupons (code, discount_type, discount_value, minimum_order, maximum_discount, usage_limit, used_count, starts_on, ends_on, active)
  VALUES ('TEN', 'Percentage', 10, 1000, 500, 100, 0, current_date - 1, current_date + 30, true)`);

/** A UPI checkout through the real function, as a new customer. */
const checkout = async (lines, { ship = "Pickup", coupon = null } = {}) => {
  const buyer = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [buyer, `c${buyer.slice(0, 8)}@test.in`]);
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  try {
    const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, $4, 'UPI', $5::jsonb, $6) AS r`, [
      `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }),
      ship, JSON.stringify(lines.map(([product_id, qty]) => ({ product_id, qty }))), coupon,
    ])).r;
    return r.order_no;
  } finally { await as(null); }
};
const orderOf = (no) => one(`SELECT * FROM public.orders WHERE order_no = $1`, [no]);
const itemsOf = async (no) => q(`SELECT i.product_id, i.qty, i.unit_price, i.line_total FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1 ORDER BY i.product_id`, [no]);
const figures = (o) => [n(o.subtotal), n(o.gst_amount), n(o.shipping), n(o.discount), n(o.total)];

// Before: GST on top. ₹130 came to ₹136.50.
const oldOrder = await checkout([["OIL", 1]]);
assert.deepEqual(figures(await orderOf(oldOrder)), [130, 6.5, 0, 0, 136.5]);

await db.exec(readFileSync(join(migrations, MIGRATION), "utf8"));
for (const file of files.slice(at + 1)) await db.exec(readFileSync(join(migrations, file), "utf8"));

// The order placed before keeps its figures and is marked as GST on top.
assert.deepEqual(figures(await orderOf(oldOrder)), [130, 6.5, 0, 0, 136.5]);
assert.equal((await orderOf(oldOrder)).prices_include_gst, false);

// The owner's example: ₹130 is what the customer pays, with ₹6.19 GST inside (130 x 5 / 105).
const oil = await checkout([["OIL", 1]]);
assert.deepEqual(figures(await orderOf(oil)), [123.81, 6.19, 0, 0, 130]);
assert.equal((await orderOf(oil)).prices_include_gst, true);
assert.deepEqual((await itemsOf(oil)).map((i) => [i.product_id, i.qty, n(i.unit_price), n(i.line_total)]), [["OIL", 1, 130, 123.81]]);

// Several lines at 5%, 12% and 0%: GST per line, rounded to paise; the total is the sum of the prices.
const mixed = await checkout([["OIL", 3], ["SUGAR", 2], ["SOAP", 1], ["SALT", 2]]);
// 390 -> 18.57 GST; 5,400 -> 257.14; 112 at 12% -> 12.00; 100 at 0% -> 0.
assert.deepEqual(figures(await orderOf(mixed)), [5714.29, 287.71, 0, 0, 6002]);
assert.deepEqual((await itemsOf(mixed)).map((i) => [i.product_id, n(i.line_total)]), [["OIL", 371.43], ["SALT", 100], ["SOAP", 100], ["SUGAR", 5142.86]]);

// Free delivery goes by the goods the customer sees: ₹5,040 of goods is ₹4,800 before GST, and still free.
const nearFree = await checkout([["SUGAR", 1], ["OIL", 18]], { ship: "Standard" });
assert.deepEqual(figures(await orderOf(nearFree)), [4800, 240, 0, 0, 5040]);
const smallDelivered = await checkout([["OIL", 1]], { ship: "Standard" });
assert.deepEqual(figures(await orderOf(smallDelivered)), [123.81, 6.19, 100, 0, 230]);

// A coupon's minimum and percentage go by the goods the customer sees: ₹1,040 of oil meets a ₹1,000 minimum
// (₹990.48 before GST did not), and 10% of it is ₹104.
const coupon = await checkout([["OIL", 8]], { coupon: "TEN" });
assert.deepEqual(figures(await orderOf(coupon)), [990.48, 49.52, 0, 104, 936]);

// An admin's line edit: on a new order the typed price includes GST; on an older order GST goes on top, as before.
await db.exec(`SET session_replication_role = replica`);
await db.query(`UPDATE public.orders SET order_status = 'Placed', payment_status = 'Pending' WHERE order_no IN ($1, $2)`, [oil, oldOrder]);
await db.exec(`SET session_replication_role = DEFAULT`);
const edit = async (no, qty, price) => {
  const item = (await one(`SELECT i.id FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1`, [no])).id;
  await as(ADMIN);
  try { return (await one(`SELECT public.admin_update_order_item($1, $2, $3, '850 ml', $4) AS r`, [no, item, qty, price])).r; } finally { await as(null); }
};
const editedNew = await edit(oil, 2, 130);
assert.deepEqual([n(editedNew.line_total), n(editedNew.subtotal), n(editedNew.gst_amount), n(editedNew.total)], [247.62, 247.62, 12.38, 260]);
assert.deepEqual(figures(await orderOf(oil)), [247.62, 12.38, 0, 0, 260]);
const editedOld = await edit(oldOrder, 2, 130);
assert.deepEqual([n(editedOld.line_total), n(editedOld.subtotal), n(editedOld.gst_amount), n(editedOld.total)], [260, 260, 13, 273]);

// Partner commissions and reports read line_total, which stays the value before GST.
assert.equal(n((await one(`SELECT public.partner_commission_amount('percent', 5, 1, 123.81) AS a`)).a), 6.19);

console.log("prices include GST OK");
