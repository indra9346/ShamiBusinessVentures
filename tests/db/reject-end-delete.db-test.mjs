// Real-Postgres check of 20261106230000_reject_and_end_checkout.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/reject-end-delete.db-test.mjs
//
// With LIVE_FNS_DIR=<folder of live function dumps> it first checks the two replaced functions equal live.
// It must end with "reject end delete OK".
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
const MIGRATION = "20261106230000_reject_and_end_checkout.sql";
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const at = files.indexOf(MIGRATION);
assert.ok(at >= 0, "migration file present");
for (const file of files.slice(0, at)) await db.exec(readFileSync(join(migrations, file), "utf8"));

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

// The functions replaced here must be the live ones, or the migration would also undo or redo something else.
if (process.env.LIVE_FNS_DIR) {
  const flat = (text) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  for (const name of ["public.order_delete_reason_internal", "public.admin_delete_order"]) {
    const [schema, fn] = name.split(".");
    const repo = (await one(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [schema, fn])).d;
    const live = readFileSync(join(process.env.LIVE_FNS_DIR, `${name}.sql`), "utf8");
    assert.equal(flat(repo), flat(live), `${name} in the repo is the live one`);
  }
  console.log("repo functions = live functions");
}
for (const file of files.slice(at)) await db.exec(readFileSync(join(migrations, file), "utf8"));

const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);
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
// The company's account ends 000900, like the live one.
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('bank_transfer', $1::jsonb, false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [JSON.stringify({ accountName: "Sample Traders", accountNumber: "10234000900", ifsc: "IDFB0000001", bankName: "Sample Bank", branch: "Sample" })]);
await db.exec(`ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
const PRODUCT = (id, name, price) => JSON.stringify({ id, name, price, stock: 100000, sold: 0, active: true, status: "approved", gst: 0, sku: `SKU-${id}`, category: "Rice", vendor: "Shami", vendorId: "VENDOR-001", weight: "25 kg", maxPurchaseQuantity: 5000 });
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PA', 'VENDOR-001', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PA", "Sample Rice", 1242)]);
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PB', 'VENDOR-001', 'Rice', $1::jsonb, 'approved', true)`, [PRODUCT("PB", "Sample Dal", 1)]);

const buyers = new Map();
/** A UPI checkout through the real function: qty x Rs 1,242 of PA, or Rs 1 lines of PB. Waits for payment. */
const checkout = async (qty = 2, product = "PA", method = "UPI") => {
  const buyer = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [buyer, `c${buyer.slice(0, 8)}@test.in`]);
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', $5, $4::jsonb, NULL) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }),
    JSON.stringify([{ product_id: product, qty }]), method,
  ])).r;
  await as(ADMIN);
  buyers.set(r.order_no, buyer);
  return r.order_no;
};
let lastUtr = 600000000000;
const utr = () => String(lastUtr += 1 + Math.floor(Math.random() * 1000));
const submit = async (no, ref) => { await as(buyers.get(no)); const r = await one(`SELECT * FROM public.submit_upi_utr($1, $2)`, [no, ref]); await as(ADMIN); return r; };
let smsNo = 0;
/** The IDFC SMS for a credit, through the server's function (as the bank-alert endpoint calls it). */
const record = (amount, at = new Date(), ending = "000900") => {
  smsNo += 1;
  const raw = `Your A/C XXXXX${ending} is credited with INR ${amount}.00 on 06/11/26 17:${String(smsNo).padStart(2, "0")}. Your new balance is INR ${1000 + smsNo}.00. Team IDFC FIRST Bank`;
  return asServer(`SELECT public.record_bank_credit_without_reference($1, $2::numeric, $3::timestamptz, NULL, $4, 'AX-IDFCFB-S') AS r`, [ending, String(amount), at.toISOString(), raw]).then((row) => row.r);
};
const creditOf = (id) => one(`SELECT status, order_no, suggested_order_no, note FROM public.bank_credits_without_reference WHERE id = $1`, [id]);
const orderOf = (no) => one(`SELECT id, order_status, payment_status, total, paid_amount, payment_hold_until, payment_hold_outcome, bank_credit_id, bank_credit_seen_at FROM public.orders WHERE order_no = $1`, [no]);
const confirmWith = async (id, no, ref = null, uid = ADMIN) => { await as(uid); try { return await one(`SELECT public.confirm_order_with_bank_credit($1, $2, $3) AS r`, [id, no, ref]); } finally { await as(ADMIN); } };
const notes = async (title, no = null) => (await q(`SELECT recipient_role, message FROM public.notifications WHERE title = $1 AND ($2::text IS NULL OR order_no = $2 OR message LIKE '%' || $2 || '%') ORDER BY created_at`, [title, no]));
const hoursLeft = (row) => (new Date(row.payment_hold_until).getTime() - Date.now()) / 3_600_000;
/** Moves a checkout's end, as time passing would. */
const endsIn = async (no, minutes) => {
  await db.exec(`SELECT set_config('app.payment_workflow', 'on', false)`);
  await db.query(`UPDATE public.orders SET payment_hold_until = now() + make_interval(mins => $2) WHERE order_no = $1`, [no, minutes]);
  await db.exec(`SELECT set_config('app.payment_workflow', 'off', false)`);
};
const expire = async () => { await as(null); await db.exec(`SELECT public.expire_payment_holds()`); await as(ADMIN); };

const held = async (no) => Number((await one(`SELECT COALESCE(sum(a.reserved_quantity - a.released_quantity), 0) AS n FROM public.order_item_batch_allocations a JOIN public.order_items i ON i.id = a.order_item_id JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1`, [no])).n);
const stockOf = async (id) => Number((await one(`SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = $1`, [id])).s);
const blocker = async (no) => (await one(`SELECT public.order_delete_blocker($1) AS b`, [no])).b;
const neftRef = () => `IDFBN${utr()}`;

// ---------------------------------------------------------------- 1. the plain reject gives time (unchanged): what the owner saw
await as(ADMIN);
const A = await checkout(2, "PA", "NEFT");
await submit(A, neftRef());
await endsIn(A, -1);
await db.query(`SELECT public.review_upi_utr($1, 'rejected', 'No matching credit in the bank account', NULL)`, [A]);
const a = await orderOf(A);
assert.equal(a.order_status, "Awaiting Payment", "a plain reject keeps the checkout open");
assert.ok(hoursLeft(a) > 0.95 && hoursLeft(a) <= 1.01, "and gives a bank transfer 1 more hour: the timer starts again");
assert.match((await notes("Please check your bank transfer", A)).at(-1).message, /send the correct UTR/);

// ---------------------------------------------------------------- 2. reject and end in one step
const stock0 = await stockOf("PA");
const B = await checkout(3, "PA", "NEFT");
assert.equal(await stockOf("PA"), stock0 - 3);
const bRef = neftRef();
await submit(B, bRef);
// Only admins; the UTR must be the one the admin looked at.
await assert.rejects(asUser(buyers.get(B), `SELECT public.admin_reject_utr_and_end_checkout($1, 'x', NULL)`, [B]), /Only administrators/);
await as(ADMIN);
await assert.rejects(db.query(`SELECT public.admin_reject_utr_and_end_checkout($1, 'x', 'IDFBN000000000001')`, [B]), /The UTR for this order is now/);
await db.query(`SELECT public.admin_reject_utr_and_end_checkout($1, 'TEST fake UTR', $2)`, [B, bRef]);
const b = await orderOf(B);
assert.equal(b.order_status, "Payment Expired");
assert.equal(b.payment_hold_outcome, "ended");
assert.equal(b.payment_hold_until, null);
assert.equal(await held(B), 0, "its stock is no longer held in the batches");
assert.equal(await stockOf("PA"), stock0, "and is back on sale");
const bs = await one(`SELECT status, note, rejections, reviewed_by FROM public.upi_payment_submissions WHERE order_no = $1`, [B]);
assert.deepEqual([bs.status, bs.note, bs.rejections, bs.reviewed_by], ["rejected", "TEST fake UTR", 1, ADMIN]);
assert.match((await notes("Order not placed", B)).at(-1).message, /could not be matched/);
assert.equal((await notes("Please check your bank transfer", B)).length, 0, "no 'send the correct UTR' message for an ended checkout");
await assert.rejects(db.query(`SELECT public.admin_reject_utr_and_end_checkout($1, 'again', NULL)`, [B]), /already rejected/);
// The owner's checkout from section 1 can be stopped now too, with End checkout: nothing waits any more.
await db.query(`SELECT public.admin_end_payment_hold($1)`, [A]);
assert.equal((await orderOf(A)).order_status, "Payment Expired");

// ---------------------------------------------------------------- 3. which ended checkouts can be deleted
// Rejected by an admin after checking the bank: can go, and the log keeps the UTR.
assert.equal(await blocker(B), null);
assert.equal(await blocker(A), null, "an admin rejected its UTR too");
await db.query(`SELECT public.admin_delete_order($1, 'TEST fake UTR checkout')`, [B]);
assert.equal((await one(`SELECT count(*)::int AS n FROM public.orders WHERE order_no = $1`, [B])).n, 0);
const log = await one(`SELECT utrs, reason FROM public.deleted_orders_log WHERE order_no = $1`, [B]);
assert.ok(log.utrs.includes(`${bRef} (rejected: TEST fake UTR)`), log.utrs);
assert.equal((await one(`SELECT count(*)::int AS n FROM public.upi_payment_submissions WHERE order_no = $1`, [B])).n, 0);
// (Order numbers carry the second they were made, and a deleted one is never used again.)
await new Promise((r) => setTimeout(r, 1100));
// A UTR nobody checked: the admin ended the checkout while it waited.
const C = await checkout(1);
await submit(C, utr());
await db.query(`SELECT public.admin_end_payment_hold($1)`, [C]);
assert.match(await blocker(C), /Nobody checked the customer's UTR/);
await assert.rejects(db.query(`SELECT public.admin_delete_order($1, 'x')`, [C]), /Nobody checked/);
// Not checked within 24 hours.
const D = await checkout(1);
await submit(D, utr());
await endsIn(D, -24 * 60 - 1);
await expire();
assert.equal((await orderOf(D)).order_status, "Payment Expired");
assert.match(await blocker(D), /Nobody checked the customer's UTR/);
// Money came and was refunded: stays for the accounts.
await db.query(`UPDATE public.upi_payment_submissions SET note = 'refunded by our team', reviewed_by = $2 WHERE order_no = $1`, [D, ADMIN]);
assert.match(await blocker(D), /was refunded, so it stays/);
// No UTR at all: can go, as before.
const E = await checkout(1);
await asUser(buyers.get(E), `SELECT public.cancel_payment_hold($1)`, [E]);
await as(ADMIN);
assert.equal(await blocker(E), null);
// A UTR still waiting keeps a checkout (even one somehow ended) and a paid order stays.
const F = await checkout(1);
await submit(F, utr());
assert.match(await blocker(F), /payment window|only an order|Only an order/i);

console.log("reject end delete OK");
