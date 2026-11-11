// Real-Postgres check of 20261111230000_delete_order_with_payments_check.sql and the Delete it drives, on PGlite with every
// migration in the repo. Replays ORD-26102686593 (a delivered test order, void in Zoho, 3 typed-in payments). Touches
// nothing live. Not part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/delete-with-payments.db-test.mjs
//
// It must end with "delete with payments OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261111230000_delete_order_with_payments_check.sql";

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
const ADMIN = "00000000-0000-4000-8000-0000000000a1", CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Sugar','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST S1 Sugar", stock: 50, sold: 10 })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 2518.95, subtotal: 2399, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", vendor_ids: ["V1"], ...extra };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST S1 Sugar',1,2399,2399,'V1')", [id]);
  if (status !== "Awaiting Payment") await q("INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status) VALUES ($1,'V1',$2)", [id, status]);
  return { id, no };
}
const TEST = await order("ORD-TEST-DELIVERED-PAID", "Delivered", { paid_amount: 2518.95, payment_status: "Paid", zoho_salesorder_id: "SO-1", zoho_order_status: "void" });
const NOTE = await order("ORD-TEST-WITH-NOTE", "Packed", { paid_amount: 100, payment_status: "Partially Paid" });
const HELD = await order("ORD-TEST-HELD", "Awaiting Payment", { payment_hold_until: new Date(Date.now() + 600000).toISOString() });
const UTR = await order("ORD-TEST-UTR-WAITING", "Placed");
const BANK = await order("ORD-TEST-BANK", "Payment Confirmed", { paid_amount: 100, payment_status: "Partially Paid" });
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
for (const [amount, ref, kind] of [[755.69, "2535", "advance"], [1259.48, "1250", "balance"], [503.78, "503.78", "balance"]])
  await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,$3,$4,'UPI','Paid',$5)", [TEST.id, CUSTOMER, kind, amount, ref]);
await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'advance',100,'UPI','Paid','NOTEPAY000000001')", [NOTE.id, CUSTOMER]);
await q(`INSERT INTO public.delivery_notes (seq, note_no, order_id, order_no, zoho_invoice_id, invoice_number, invoice_total, order_total, paid_amount, snapshot, generated_by, generated_by_name)
  VALUES (999001,'DN-TEST-1',$1,$2,'ZINV-TEST-1','INV-TEST-1',100,100,100,'{}'::jsonb,$3,'TEST Admin')`, [NOTE.id, NOTE.no, ADMIN]);
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status) VALUES ($1,$2,$3,'123456789012',100,'submitted')", [UTR.id, UTR.no, CUSTOMER]);
await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'advance',100,'UPI','Paid','222233334444')", [BANK.id, CUSTOMER]);
await q("INSERT INTO public.bank_credits (amount, utr, status, order_id, order_no) VALUES (100,'222233334444','matched',$1,$2)", [BANK.id, BANK.no]);

async function as(uid, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [uid]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const admin = (fn) => as(ADMIN, "authenticated", fn);
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
const check = (no) => admin(() => q("SELECT public.order_delete_with_payments_check($1) AS r", [no]).then((rows) => rows[0].r));

// ---- only an admin
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.order_delete_with_payments_check('ORD-TEST-DELIVERED-PAID')")), /Only administrators/, "customer");
await refuses(() => as(null, "anon", () => q("SELECT public.order_delete_with_payments_check('ORD-TEST-DELIVERED-PAID')")), /permission denied|Only administrators/, "anon");

// ---- the owner's test order: what the Delete would do
let c = await check(TEST.no);
assert.equal(c.blocker, null);
assert.equal(Number(c.paid), 2518.95);
assert.equal(c.payments.length, 3);
assert.deepEqual(c.payments.map((p) => p.reference), ["2535", "1250", "503.78"]);
assert.equal(c.payments.some((p) => p.in_zoho), false);
assert.equal(Number(c.paid_without_record), 0);
assert.equal(c.bank_alert, false); assert.equal(c.confirmed_utr, null);
assert.equal(c.needs_cancel, true); assert.equal(c.after_dispatch, true); assert.equal(c.zoho_alive, false, "its sales order is void in Zoho");
// Today's Delete all details refuses it while the payments count.
assert.match((await admin(() => q("SELECT public.order_delete_all_check($1) AS r", [TEST.no])))[0].r.blocker, /Remove its payments first/);

// ---- what keeps an order whatever is said about the money
assert.match((await check(NOTE.no)).blocker, /delivery note was issued/);
assert.match((await check(HELD.no)).blocker, /still waiting for payment\. End it first/);
assert.match((await check(UTR.no)).blocker, /waits for a check/);
const bank = await check(BANK.no);
assert.equal(bank.blocker, null); assert.equal(bank.bank_alert, true, "the dialog then refuses 'not real money'");
assert.match((await check("NO-SUCH-ORDER")).blocker, /no longer exists/);

// ---- the steps the Delete runs, in its order: remove each payment, cancel, delete all details
const ids = c.payments.map((p) => p.id);
for (const id of ids) await admin(() => q("SELECT public.admin_delete_payment($1, 'TEST typed in during testing')", [id]));
let row = (await q("SELECT order_status, payment_status, paid_amount FROM public.orders WHERE id = $1", [TEST.id]))[0];
assert.equal(Number(row.paid_amount), 0); assert.equal(row.payment_status, "Pending"); assert.equal(row.order_status, "Delivered");
assert.equal((await q("SELECT count(*)::int AS n FROM public.deleted_payments_log WHERE order_no = $1 AND kind = 'payment'", [TEST.no]))[0].n, 3, "a copy of each payment");
c = await check(TEST.no);
assert.equal(Number(c.paid), 0); assert.equal(c.payments.length, 0);
const stockBefore = Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s);
await admin(() => q("SELECT public.admin_cancel_order($1, 'TEST typed in during testing', false, NULL)", [TEST.no]));
assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [TEST.id]))[0].order_status, "Cancelled");
assert.equal(Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s), stockBefore, "goods did not come back: stock unchanged");
assert.equal((await admin(() => q("SELECT public.order_delete_all_check($1) AS r", [TEST.no])))[0].r.blocker, null);
await admin(() => q("SELECT public.admin_delete_order_all_details($1, 'TEST typed in during testing')", [TEST.no]));
assert.equal((await q("SELECT count(*)::int AS n FROM public.orders WHERE id = $1", [TEST.id]))[0].n, 0);
const copy = (await q("SELECT snapshot FROM public.deleted_orders_log WHERE order_no = $1", [TEST.no]))[0].snapshot;
assert.equal(copy.cancellation.reason, "TEST typed in during testing"); assert.equal(copy.items.length, 1);
// The typed-in references were never bank UTRs: nothing is put on the refunded list.
assert.equal((await q("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE order_no = $1", [TEST.no]))[0].n, 0);

// ---- an order with a delivery note keeps its payment too
const notePayment = (await q("SELECT id FROM public.payments WHERE order_id = $1", [NOTE.id]))[0].id;
await refuses(() => admin(() => q("SELECT public.admin_delete_payment($1, 'TEST reason')", [notePayment])), /delivery note was issued/, "payment under a delivery note");

console.log("delete with payments OK");
