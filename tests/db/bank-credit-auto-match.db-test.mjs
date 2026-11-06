// Real-Postgres check of 20261106220000_bank_credit_auto_match.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho,
// because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/bank-credit-auto-match.db-test.mjs
//
// With LIVE_FNS_DIR=<folder of live function dumps> it first checks that the functions this migration replaces are
// the same in the repo as on live, so the migration changes only what it says. It must end with "auto match OK".
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
const MIGRATION = "20261106220000_bank_credit_auto_match.sql";
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const at = files.indexOf(MIGRATION);
assert.ok(at >= 0, "migration file present");
for (const file of files.slice(0, at)) await db.exec(readFileSync(join(migrations, file), "utf8"));

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

// The functions replaced here must be the live ones, or the migration would also undo or redo something else.
if (process.env.LIVE_FNS_DIR) {
  const flat = (text) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  for (const name of ["public.record_bank_credit_without_reference", "private.release_payment_hold", "public.expire_payment_holds",
    "public.cancel_payment_hold", "public.confirm_order_with_bank_credit", "public.dismiss_bank_credit_without_reference"]) {
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
const checkout = async (qty = 2, product = "PA") => {
  const buyer = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [buyer, `c${buyer.slice(0, 8)}@test.in`]);
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', 'UPI', $4::jsonb, NULL) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }),
    JSON.stringify([{ product_id: product, qty }]),
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

// ---------------------------------------------------------------- 1. one checkout waits for exactly this amount: kept for it
await as(ADMIN);
const A = await checkout();
const credit1 = await record(2484);
assert.equal(credit1.status, "recorded");
assert.equal(credit1.linked_order, A, "the only checkout for Rs 2,484 is picked");
let a = await orderOf(A);
assert.equal(a.order_status, "Awaiting Payment", "not paid yet: an admin confirms");
assert.equal(a.bank_credit_id, credit1.id);
assert.ok(a.bank_credit_seen_at, "the customer's screen can say when the money came");
assert.ok(hoursLeft(a) > 23.9, "its stock is kept for 24 hours");
assert.equal((await creditOf(credit1.id)).suggested_order_no, A);
assert.equal((await notes("Payment received: confirm it", A)).filter((n) => n.recipient_role === "admin").length, 1);
assert.match((await notes("Payment received: confirming", A)).find((n) => n.recipient_role === "customer").message, /do not pay again/);
// The customer can read it on their own order; nobody else can.
assert.equal((await asUser(buyers.get(A), `SELECT bank_credit_id FROM public.orders WHERE order_no = $1`, [A]))[0].bank_credit_id, credit1.id);
assert.equal((await asUser(buyers.get(A), `SELECT count(*)::int AS n FROM public.bank_credits_without_reference`))[0].n, 0, "customers never see bank credits");
// The time passes the old 10 minutes: still kept.
await endsIn(A, -1);
await db.exec(`SELECT set_config('app.payment_workflow', 'on', false)`);
await db.query(`UPDATE public.orders SET payment_hold_until = now() + interval '23 hours' WHERE order_no = $1`, [A]);
await db.exec(`SELECT set_config('app.payment_workflow', 'off', false)`);
await expire();
assert.equal((await orderOf(A)).order_status, "Awaiting Payment");
// The customer cannot drop it now, and the credit cannot be put aside or given to someone else.
await assert.rejects(asUser(buyers.get(A), `SELECT public.cancel_payment_hold($1)`, [A]), /reached our bank/);
await as(ADMIN);
await assert.rejects(db.query(`SELECT public.dismiss_bank_credit_without_reference($1, 'TEST office sale')`, [credit1.id]), /kept for checkout/);
const other = await checkout();
await assert.rejects(confirmWith(credit1.id, other, null), /kept for checkout/);
// The admin confirms it: paid, placed, the stock stays sold, the order goes to Zoho (sales order and invoice).
const jobsBefore = (await one(`SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1`, [a.id])).n;
const done = await confirmWith(credit1.id, A);
assert.equal(done.r.status, "confirmed");
a = await orderOf(A);
assert.equal(a.order_status, "Payment Confirmed");
assert.equal(a.payment_status, "Paid");
assert.equal(Number(a.paid_amount), 2484);
assert.equal(a.payment_hold_until, null);
assert.equal(a.bank_credit_id, credit1.id);
const pay = await one(`SELECT amount, status, txn_ref FROM public.payments WHERE order_id = $1`, [a.id]);
assert.equal(Number(pay.amount), 2484);
assert.match(pay.txn_ref, /^BANK SMS \d\d \w{3} \d\d:\d\d A\/C 000900 #[0-9A-F]{10}$/);
assert.equal((await creditOf(credit1.id)).status, "used");
assert.equal((await creditOf(credit1.id)).order_no, A);
assert.ok((await one(`SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1`, [a.id])).n > jobsBefore, "queued for Zoho");
await assert.rejects(confirmWith(credit1.id, A), /already paid/);
// Only admins confirm.
const B0 = await checkout(3);
const credit0 = await record(3726);
assert.equal(credit0.linked_order, B0);
await assert.rejects(confirmWith(credit0.id, B0, null, buyers.get(B0)), /Only administrators/);
await confirmWith(credit0.id, B0);
// A second SMS for the same money (a repeat of the same text) is one credit, not two.
assert.equal((await asServer(`SELECT public.record_bank_credit_without_reference('000900', 3726, now(), NULL, (SELECT raw FROM public.bank_credits_without_reference WHERE id = $1), 'AX-IDFCFB-S') AS r`, [credit0.id])).r.status, "duplicate");

// ---------------------------------------------------------------- 2. two checkouts for the same amount: nothing picked
const B = await checkout(4), C = await checkout(4);
const credit2 = await record(4968);
assert.equal(credit2.linked_order, null);
assert.equal((await orderOf(B)).bank_credit_id, null);
assert.equal((await orderOf(C)).bank_credit_id, null);
assert.match((await notes("Bank credit to match")).at(-1).message, /2 checkouts wait for this amount/);
// The admin picks the right one from the payer in the bank app: a checkout with no UTR can be paid by the credit.
await confirmWith(credit2.id, C);
assert.equal((await orderOf(C)).payment_status, "Paid");
assert.equal((await orderOf(B)).order_status, "Awaiting Payment");

// ---------------------------------------------------------------- 3. what is never picked
// The money came before the checkout was made.
const early = new Date(Date.now() - 15 * 60_000);
const D = await checkout(5);
const credit3 = await record(6210, early);
assert.equal(credit3.linked_order, null, "money from before the checkout is not its payment");
// Another amount.
const E = await checkout(6);
assert.equal((await record(7451)).linked_order, null, "Rs 7,451 is not Rs 7,452");
assert.equal((await orderOf(E)).bank_credit_id, null);
// A UTR already waits for this amount: the old suggestion, nothing kept.
const F = await checkout(7);
await submit(F, utr());
const credit4 = await record(8694);
assert.equal(credit4.linked_order, null);
assert.equal(credit4.waiting_orders, 1);
assert.equal((await orderOf(F)).bank_credit_id, null);
// A second credit of the same amount does not take a checkout that already has one.
const G = await checkout(8);
const credit5 = await record(9936);
assert.equal(credit5.linked_order, G);
const credit6 = await record(9936);
assert.equal(credit6.linked_order, null);
assert.equal((await orderOf(G)).bank_credit_id, credit5.id);
// Another account's credit is not kept at all.
assert.equal((await record(9936, new Date(), "692557")).status, "other_account");
// A checkout that ended (its time ran out) is not picked; the admins are told it ended around then.
const H = await checkout(9);
await endsIn(H, -1);
await expire();
assert.equal((await orderOf(H)).order_status, "Payment Expired");
const credit7 = await record(11178);
assert.equal(credit7.linked_order, null);
assert.match((await notes("Payment for a checkout that ended", H)).at(-1).message, new RegExp(`${H}.*Reorder`));

// ---------------------------------------------------------------- 4. kept, but nobody confirmed it within 24 hours
const K = await checkout(10);
const credit8 = await record(12420);
assert.equal(credit8.linked_order, K);
await endsIn(K, -1);
await expire();
const k = await orderOf(K);
assert.equal(k.order_status, "Payment Expired");
assert.equal(k.bank_credit_id, null, "the credit is free again");
assert.equal((await creditOf(credit8.id)).status, "new");
assert.equal((await creditOf(credit8.id)).suggested_order_no, null);
assert.match((await notes("Order not placed", K)).at(-1).message, /Your money reached us, so do not pay again/);
assert.match((await notes("Payment not confirmed in time", K)).at(-1).message, /Reorder/);
// The customer presses Reorder: the admin gives the credit to the new checkout (made after the money came).
const K2 = await checkout(10);
await confirmWith(credit8.id, K2);
assert.equal((await orderOf(K2)).payment_status, "Paid");

// ---------------------------------------------------------------- 5. the customer sent a UTR as well: the UTR path, as before
const M = await checkout(11);
const credit9 = await record(13662);
assert.equal(credit9.linked_order, M);
const mUtr = utr();
await submit(M, mUtr);
await confirmWith(credit9.id, M, mUtr);
const m = await orderOf(M);
assert.equal(m.payment_status, "Paid");
assert.equal((await one(`SELECT txn_ref FROM public.payments WHERE order_id = $1`, [m.id])).txn_ref, mUtr, "the customer's UTR is the payment's reference");

// ---------------------------------------------------------------- 6. cancel before paying still works for an unkept checkout
const N = await checkout(12);
await asUser(buyers.get(N), `SELECT public.cancel_payment_hold($1)`, [N]);
assert.equal((await orderOf(N)).order_status, "Payment Expired");
// A kept checkout an admin ends on purpose frees its credit too.
const P = await checkout(13);
const credit10 = await record(16146);
assert.equal(credit10.linked_order, P);
await as(ADMIN);
await db.query(`SELECT public.cancel_payment_hold($1)`, [P]);
assert.equal((await orderOf(P)).bank_credit_id, null);
assert.equal((await creditOf(credit10.id)).suggested_order_no, null);
await db.query(`SELECT public.dismiss_bank_credit_without_reference($1, 'TEST refunded to the customer')`, [credit10.id]);
assert.equal((await creditOf(credit10.id)).status, "dismissed");

// ---------------------------------------------------------------- 7. the Rs 1 test, as the owner did it on 6 Nov 2026
const R = await checkout(1, "PB");
const credit11 = await record(1);
assert.equal(credit11.linked_order, R);
await confirmWith(credit11.id, R);
assert.equal((await orderOf(R)).payment_status, "Paid");

console.log("auto match OK");
