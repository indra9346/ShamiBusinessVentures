// Real-Postgres check of 20261106190000_utr_attempts_and_conflicts.sql, on PGlite with every migration in the repo
// and small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho,
// because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/utr-conflicts.db-test.mjs
//
// It must end with "utr conflicts OK".
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


// ---------------------------------------------------------------- helpers for this test
const send = async (no, ref, uid = buyers.get(no)) => { await as(uid); const r = (await one(`SELECT public.send_payment_utr($1, $2) AS r`, [no, ref])).r; await as(ADMIN); return r; };
const attempts = (no) => q(`SELECT outcome, reason, utr_key FROM public.utr_attempts WHERE order_no = $1 ORDER BY at, id`, [no]);
const conflicts = async () => { await as(ADMIN); return (await one(`SELECT public.admin_utr_conflicts() AS r`)).r; };
const adminTold = async (title) => (await q(`SELECT message FROM public.notifications WHERE recipient_id = $1 AND title = $2`, [ADMIN, title])).map((row) => row.message);

// ---------------------------------------------------------------- a UTR sent and accepted is recorded
const first = await checkout();
const shared = utr();
const ok = await send(first, shared);
assert.equal(ok.ok, true);
assert.equal(ok.submission.status, "submitted");
assert.deepEqual((await attempts(first)).map((row) => row.outcome), ["accepted"]);
assert.equal((await attempts(first))[0].utr_key, shared.slice(-12));

// ---------------------------------------------------------------- another account tries the same UTR
const second = await checkout();
const refused = await send(second, shared);
assert.equal(refused.ok, false);
assert.match(refused.error, /already used for another payment/);
const tried = await attempts(second);
assert.deepEqual(tried.map((row) => row.outcome), ["refused"], "the refusal is kept, though the submit was undone");
assert.equal(Number((await one(`SELECT count(*) AS n FROM public.upi_payment_submissions WHERE order_no = $1`, [second])).n), 0);
const sameTold = await adminTold("Same UTR tried on another order");
assert.equal(sameTold.length, 1);
assert.match(sameTold[0], new RegExp(`UTR ${shared} was sent for ${second} but it belongs to ${first}`));
// Written another way (with spaces or a bank's letters in front), it is still the same transfer.
const respelled = await send(second, `UPI/${shared.slice(0, 6)} ${shared.slice(6)}`);
assert.equal(respelled.ok, false);
assert.equal((await attempts(second))[1].utr_key, shared.slice(-12));

let found = await conflicts();
assert.equal(found.groups.length, 1);
const group = found.groups[0];
assert.equal(group.key, shared.slice(-12));
assert.equal(group.accounts, 2);
assert.equal(group.orders, 2);
assert.equal(group.severity, "high");
assert.equal(group.reviewed, false);
assert.deepEqual(group.items.map((item) => `${item.source}:${item.order_no}`), [`utr_sent:${first}`, `tried:${second}`, `tried:${second}`]);
assert.equal(group.items[1].who, "Test Customer");

// ---------------------------------------------------------------- an admin marks it looked at; a new try brings it back
await as(ADMIN);
await assert.rejects(one(`SELECT public.review_utr_conflict($1, ' ')`, [group.key]), /Say what you found or did/);
await one(`SELECT public.review_utr_conflict($1, 'second account mistyped, called them')`, [group.key]);
found = await conflicts();
assert.equal(found.groups[0].reviewed, true);
assert.equal(found.groups[0].review_note, "second account mistyped, called them");
const third = await checkout();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal((await send(third, shared)).ok, false);
found = await conflicts();
assert.equal(found.groups[0].reviewed, false, "a newer record brings the group back");
assert.equal(found.groups[0].accounts, 3);

// ---------------------------------------------------------------- guessing: five refusals in an hour pause the account
const guesser = buyers.get(second);
const refusedSoFar = Number((await one(`SELECT count(*) AS n FROM public.utr_attempts WHERE user_id = $1 AND outcome = 'refused'`, [guesser])).n);
assert.equal(refusedSoFar, 2);
for (let i = refusedSoFar; i < 5; i += 1) assert.equal((await send(second, shared)).ok, false);
const paused = await send(second, utr());
assert.equal(paused.ok, false);
assert.match(paused.error, /Too many UTRs could not be used in the last hour/);
assert.equal((await send(second, utr())).ok, false, "still paused");
assert.equal((await adminTold("UTR tries paused")).length, 1, "the admins are told once");
assert.equal(Number((await one(`SELECT count(*) AS n FROM public.upi_payment_submissions WHERE order_no = $1`, [second])).n), 0, "nothing was accepted while paused");
found = await conflicts();
const account = found.accounts.find((row) => row.user_id === guesser);
assert.ok(account && account.refused >= 7 && account.paused_now === true);
assert.ok(found.tries.length >= 8);
// Another account is not paused by it.
const other = await checkout();
assert.equal((await send(other, utr())).ok, true);

// ---------------------------------------------------------------- the same account on two orders is shown too (medium)
const buyerOrderA = await checkout();
const buyerOrderB = await checkout();
// Make B belong to A's account.
await db.query(`UPDATE public.orders SET user_id = $1 WHERE order_no = $2`, [buyers.get(buyerOrderA), buyerOrderB]);
buyers.set(buyerOrderB, buyers.get(buyerOrderA));
const own = utr();
assert.equal((await send(buyerOrderA, own)).ok, true);
assert.equal((await send(buyerOrderB, own)).ok, false);
found = await conflicts();
const ownGroup = found.groups.find((row) => row.key === own.slice(-12));
assert.equal(ownGroup.accounts, 1);
assert.equal(ownGroup.orders, 2);
assert.equal(ownGroup.severity, "medium");

// ---------------------------------------------------------------- who can do what
const customer = buyers.get(first);
assert.equal((await asUser(customer, `SELECT id FROM public.utr_attempts`)).length, 0, "a customer sees no tries, not even their own");
assert.equal((await asUser(customer, `SELECT utr_key FROM public.utr_conflict_reviews`)).length, 0);
assert.ok((await asUser(ADMIN, `SELECT id FROM public.utr_attempts`)).length >= 10);
await assert.rejects(asUser(customer, `SELECT public.admin_utr_conflicts()`), /Only administrators/);
await assert.rejects(asUser(customer, `SELECT public.review_utr_conflict('${own.slice(-12)}', 'hide it')`), /Only administrators/);
await assert.rejects(asUser(ADMIN, `INSERT INTO public.utr_attempts (order_no, utr, utr_key, outcome) VALUES ('X', 'Y', 'Z', 'accepted')`), /permission denied|row-level security/);
await assert.rejects(asUser(ADMIN, `DELETE FROM public.utr_attempts`), /permission denied|row-level security/);
await as(null);
assert.equal((await one(`SELECT public.send_payment_utr($1, $2) AS r`, [first, utr()])).r.ok, false, "signed out: nothing happens");

// ---------------------------------------------------------------- the old way still works, and the admin confirm path is unchanged
await as(ADMIN);
const review = await one(`SELECT status FROM public.review_upi_utr($1, 'confirmed', NULL, $2)`, [first, shared]);
assert.equal(review.status, "confirmed");
const direct = await checkout();
await as(buyers.get(direct));
assert.equal((await one(`SELECT status FROM public.submit_upi_utr($1, $2)`, [direct, utr()])).status, "submitted");

console.log("utr conflicts OK");
