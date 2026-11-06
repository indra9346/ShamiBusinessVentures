// Real-Postgres check of 20261106170000_bank_credits_without_reference.sql, on PGlite with every migration in the repo
// and small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho,
// because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/bank-credits-without-reference.db-test.mjs
//
// It must end with "bank credits without reference OK".
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
for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(migrations, file), "utf8"));
}

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

const ADMIN = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'admin@test.in', '{"full_name":"Test Admin"}')`, [ADMIN]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await db.exec(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
// The company's account ends 000900, like the live one; the phone also gets alerts for 354536.
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('bank_transfer', $1::jsonb, false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [JSON.stringify({ accountName: "Sample Traders", accountNumber: "10234000900", ifsc: "IDFB0000001", bankName: "Sample Bank", branch: "Sample" })]);
await db.exec(`ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
const PRODUCT = (id, name, price) => JSON.stringify({ id, name, price, stock: 100000, sold: 0, active: true, status: "approved", gst: 0, sku: `SKU-${id}`, category: "Rice", vendor: "Shami", vendorId: "shami", weight: "25 kg", maxPurchaseQuantity: 5000 });
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PA', 'shami', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PA", "Sample Rice", 1242)]);

const buyers = new Map();
/** A UPI checkout through the real function for Rs 2,484 (2 x 1,242). Waits for payment. */
const checkout = async (qty = 2) => {
  const buyer = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [buyer, `c${buyer.slice(0, 8)}@test.in`]);
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', 'UPI', $4::jsonb, NULL) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }),
    JSON.stringify([{ product_id: "PA", qty }]),
  ])).r;
  await as(ADMIN);
  buyers.set(r.order_no, buyer);
  return r.order_no;
};
let lastUtr = 600000000000;
const utr = () => String(lastUtr += 1 + Math.floor(Math.random() * 1000));
const submit = async (no, ref) => { await as(buyers.get(no)); const r = await one(`SELECT * FROM public.submit_upi_utr($1, $2)`, [no, ref]); await as(ADMIN); return r; };
const record = (ending, amount, raw, balance = null, at = new Date().toISOString()) =>
  asServer(`SELECT public.record_bank_credit_without_reference($1, $2::numeric, $3::timestamptz, $4::numeric, $5, 'AX-IDFCFB-S') AS r`, [ending, String(amount), at, balance, raw]).then((row) => row.r);
const sms = (ending, amount, balance) => `Your A/C XXXXX${ending} is credited with INR ${amount}.00 on 06/11/26 14:21. Your new balance is INR ${balance}. Team IDFC FIRST Bank`;
const creditOf = (id) => one(`SELECT status, order_no, note, amount FROM public.bank_credits_without_reference WHERE id = $1`, [id]);
const orderOf = (no) => one(`SELECT order_status, payment_status, total, paid_amount FROM public.orders WHERE order_no = $1`, [no]);
const confirmWith = async (id, no, ref, uid = ADMIN) => { await as(uid); return one(`SELECT public.confirm_order_with_bank_credit($1, $2, $3) AS r`, [id, no, ref]); };

// ---------------------------------------------------------------- a credit for the company's account, with a waiting UTR
const order = await checkout();
assert.equal(Number((await orderOf(order)).total), 2484);
assert.equal((await orderOf(order)).order_status, "Awaiting Payment");
const ref = utr();
await submit(order, ref);
const first = await record("000900", 2484, sms("000900", "2,484", "4,51,961.38"), 451961.38);
assert.equal(first.status, "recorded");
assert.equal(first.waiting_orders, 1);
assert.equal((await creditOf(first.id)).status, "new");
const told = await q(`SELECT title, message FROM public.notifications WHERE recipient_id = $1 AND title = 'Bank credit to match'`, [ADMIN]);
assert.equal(told.length, 1, "the admins are told a credit came for a waiting amount");
assert.match(told[0].message, /Rs 2484\.00 was credited to A\/C \.\.\.000900/);
// It confirms nothing by itself.
assert.equal((await orderOf(order)).order_status, "Awaiting Payment");
assert.equal((await one(`SELECT status FROM public.upi_payment_submissions WHERE order_no = $1`, [order])).status, "submitted");

// The same SMS forwarded twice is one credit; another account's credit is not kept.
assert.equal((await record("000900", 2484, sms("000900", "2,484", "4,51,961.38"), 451961.38)).status, "duplicate");
assert.equal((await record("354536", 600, sms("354536", "600", "18,25,825.69"), 1825825.69)).status, "other_account");
assert.equal((await record("0900", 600, "Rs 600 credited to A/c XX0900 on 06/11/26")).status, "recorded", "a shorter ending of the same account is the same account");
assert.equal((await record("12", 600, "x")).status, "unreadable");
assert.equal(Number((await one(`SELECT count(*) AS n FROM public.bank_credits_without_reference WHERE account_ending = '354536'`)).n), 0);
// No waiting UTR for Rs 600: no notification for it.
assert.equal((await q(`SELECT 1 FROM public.notifications WHERE recipient_id = $1 AND title = 'Bank credit to match'`, [ADMIN])).length, 1);

// ---------------------------------------------------------------- who can do what
const customer = buyers.get(order);
assert.equal((await asUser(customer, `SELECT id FROM public.bank_credits_without_reference`)).length, 0, "a customer sees none");
assert.ok((await asUser(ADMIN, `SELECT id FROM public.bank_credits_without_reference`)).length >= 2, "an admin sees them");
await assert.rejects(asUser(ADMIN, `INSERT INTO public.bank_credits_without_reference (raw, fingerprint, account_ending, amount) VALUES ('x', 'y', '000900', 1)`), /permission denied|row-level security/);
await assert.rejects(asUser(ADMIN, `UPDATE public.bank_credits_without_reference SET status = 'used'`), /permission denied|row-level security/);
await assert.rejects(asUser(customer, `SELECT public.record_bank_credit_without_reference('000900', 1, now(), NULL, 'fake', NULL)`), /permission denied/);
await assert.rejects(asUser(ADMIN, `SELECT public.record_bank_credit_without_reference('000900', 1, now(), NULL, 'fake', NULL)`), /permission denied/, "only the server records alerts");
await assert.rejects(confirmWith(first.id, order, ref, customer), /Only administrators/);

// ---------------------------------------------------------------- an admin confirms
const small = (await q(`SELECT id FROM public.bank_credits_without_reference WHERE amount = 600`))[0].id;
await assert.rejects(confirmWith(small, order, ref), /The bank credit is Rs 600\.00 but this order's payment is Rs 2484\.00/);
await assert.rejects(confirmWith(first.id, order, utr()), /The UTR for this order is now/, "the UTR the admin looked at must still be the one sent");
const done = await confirmWith(first.id, order, ref);
assert.equal(done.r.status, "confirmed");
const paid = await orderOf(order);
assert.notEqual(paid.order_status, "Awaiting Payment", "the checkout became an order");
assert.equal(paid.payment_status, "Paid");
assert.equal(Number(paid.paid_amount), 2484);
assert.equal((await one(`SELECT status FROM public.upi_payment_submissions WHERE order_no = $1`, [order])).status, "confirmed");
assert.deepEqual({ ...(await creditOf(first.id)), amount: undefined, note: undefined }, { status: "used", order_no: order, amount: undefined, note: undefined });
assert.equal(Number((await one(`SELECT count(*) AS n FROM public.payments p JOIN public.orders o ON o.id = p.order_id WHERE o.order_no = $1 AND p.status = 'Paid'`, [order])).n), 1);

// One credit pays one order.
const second = await checkout();
const ref2 = utr();
await submit(second, ref2);
await assert.rejects(confirmWith(first.id, second, ref2), new RegExp(`already paid for ${order}`));
assert.equal((await orderOf(second)).order_status, "Awaiting Payment");
// An order whose UTR was already confirmed has nothing waiting.
const third = await record("000900", 2484, sms("000900", "2,484", "4,54,445.38"), 454445.38);
assert.equal(third.status, "recorded");
assert.equal(third.waiting_orders, 1, "only the second checkout still waits for Rs 2,484");
// (Since 20261106220000 a credit can also pay a checkout with no UTR; a paid order is still refused.)
await assert.rejects(confirmWith(third.id, order, ref), /is not waiting for a payment/);

// ---------------------------------------------------------------- not a website payment
await as(ADMIN);
await assert.rejects(one(`SELECT public.dismiss_bank_credit_without_reference($1, '  ')`, [small]), /Say what this money was for/);
await one(`SELECT public.dismiss_bank_credit_without_reference($1, 'office sale')`, [small]);
assert.deepEqual({ status: (await creditOf(small)).status, note: (await creditOf(small)).note }, { status: "dismissed", note: "office sale" });
await assert.rejects(confirmWith(small, second, ref2), /dismissed\. Reopen it first/);
await assert.rejects(one(`SELECT public.dismiss_bank_credit_without_reference($1, 'again')`, [first.id]), /Only a credit not yet used/);
await assert.rejects(one(`SELECT public.reopen_bank_credit_without_reference($1)`, [first.id]), /Only a dismissed credit/);
await one(`SELECT public.reopen_bank_credit_without_reference($1)`, [small]);
assert.equal((await creditOf(small)).status, "new");
await assert.rejects(asUser(customer, `SELECT public.dismiss_bank_credit_without_reference($1, 'mine')`, [small]), /Only administrators/);

// The second checkout is confirmed with the later credit; the existing UTR alert path is untouched.
await confirmWith(third.id, second, ref2);
assert.equal((await orderOf(second)).payment_status, "Paid");
assert.equal(Number((await one(`SELECT count(*) AS n FROM public.bank_credits`)).n), 0, "no UTR alert was invented");

console.log("bank credits without reference OK");
