// Real-Postgres check of 20261128120000_cashfree_gateway.sql (Cashfree Payment Gateway for pay-first checkouts, owner
// 28 Nov 2026), on PGlite with every migration in the repo and small stand-ins for what Supabase provides. Touches
// nothing live. Not part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/cashfree-gateway.db-test.mjs
//
// It must end with "cashfree gateway OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261128120000_cashfree_gateway.sql";

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
// Safe to run twice.
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const one = async (text, params) => (await q(text, params))[0];
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), OTHER = uid("c2");
await q(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1,'admin@test.local','{"full_name":"TEST Admin"}'),($2,'customer@test.local','{"full_name":"TEST Customer"}'),($3,'other@test.local','{"full_name":"TEST Other"}') ON CONFLICT DO NOTHING`, [ADMIN, CUSTOMER, OTHER]);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await q(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await q(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"TEST Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
const product = { id: "P1", name: "TEST Sugar 50 kg", price: 2500, stock: 100, sold: 0, active: true, status: "approved", gst: 5, hsn: "1701", unit: "bag", sku: "SKU-P1", category: "Sugar", vendor: "TEST", vendorId: "V1", weight: "50 kg", tags: [], specs: [], image: "", mrp: 2500, brand: "TEST", subcategory: "", rating: 0, reviews: 0, reserved: 0, description: "TEST product", created: "", updated: "", purchasePrice: 2000 };
await q(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('P1','V1','Sugar',$1::jsonb,'approved',true)`, [JSON.stringify(product)]);

async function as(user, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const server = (fn) => as(null, "service_role", fn);
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
const stock = async () => Number((await one("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'")).s);
const order = async (no) => one("SELECT id, order_no, order_status, payment_status, paid_amount, total, payment_hold_until, payment_method FROM public.orders WHERE order_no = $1", [no]);

let count = 0;
async function checkout(method = "UPI", qty = 1, user = CUSTOMER) {
  count += 1;
  const address = (await one("INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1,'TEST Customer','9876543210','1 Test Road','Test Town','Karnataka','577000') RETURNING id", [user])).id;
  const r = await as(user, "authenticated", () => one(`SELECT public.start_paid_checkout($1, $2, 'TEST Customer', 'customer@test.local', '9876543210', NULL, $3::jsonb, 'Pickup', $4, $5::jsonb, NULL, NULL, NULL, NULL) AS r`, [
    `T${count}`, user, JSON.stringify({ id: address, pin: "577000", name: "TEST Customer", phone: "9876543210", line: "1 Test Road", city: "Test Town", state: "Karnataka" }), method,
    JSON.stringify([{ product_id: "P1", qty }]),
  ]));
  assert.equal(r.r.order_status, "Awaiting Payment", `checkout ${count} waits for payment`);
  return order(r.r.order_no);
}
const open = (no, user = CUSTOMER, env = "production") => server(() => one("SELECT public.cashfree_open_order($1,$2,$3) AS r", [no, user, env]).then((row) => row.r));
const made = (ref, minutes = 16) => q("UPDATE public.cashfree_orders SET cf_order_id = 'CF' || md5(cf_order_ref), payment_session_id = 'session_' || cf_order_ref, expires_at = now() + make_interval(mins => $2), cashfree_status = 'ACTIVE' WHERE cf_order_ref = $1", [ref, minutes]);
const record = (ref, pid, status, amount, rrn = "512345678901", group = "upi", source = "webhook") =>
  server(() => one("SELECT public.cashfree_record_payment($1,$2,$3,$4,$5,$6,now(),$7) AS r", [ref, pid, status, amount, rrn, group, source]).then((row) => row.r));

// ---------------------------------------------------------------- who may call what
const A = await checkout();
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.cashfree_open_order($1,$2,'production')", [A.order_no, CUSTOMER])), /permission denied/, "a customer cannot make a Cashfree order directly");
await refuses(() => as(null, "anon", () => q("SELECT public.cashfree_record_payment('x','1','SUCCESS',1)")), /permission denied/, "anon cannot record a payment");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.cashfree_record_payment('x','1','SUCCESS',1)")), /permission denied/, "a customer cannot record a payment");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_settle_cashfree_payment('1','refunded')")), /Only administrators/, "a customer cannot settle");
await refuses(() => as(null, "anon", () => q("SELECT * FROM public.cashfree_webhook_inbox")), /permission denied/, "anon cannot read the inbox");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT * FROM public.cashfree_webhook_inbox")), /permission denied/, "a customer cannot read the inbox");
await refuses(() => as(CUSTOMER, "authenticated", () => q("INSERT INTO public.cashfree_orders (order_id, order_no, cf_order_ref, environment, amount) VALUES ($1,$2,'FAKE-REF','production',1)", [A.id, A.order_no])), /permission denied/, "a customer cannot write Cashfree orders");
const setting = await one("SELECT value, is_public FROM public.settings WHERE key = 'cashfree_gateway'");
assert.equal(setting.value.enabled, false, "Cashfree starts switched off");
assert.equal(setting.is_public, false);

// ---------------------------------------------------------------- a Cashfree order for a checkout
await refuses(() => open(A.order_no, OTHER), /not your order/, "another customer's checkout");
await refuses(() => open(A.order_no, CUSTOMER, "live"), /not set up/, "an unknown environment");
const first = await open(A.order_no);
assert.equal(first.action, "create");
assert.equal(first.cf_order_ref, A.order_no, "the first Cashfree order carries our order number");
assert.equal(Number(first.amount), Number(A.total));
assert.equal(first.customer.phone, "9876543210");
assert.equal((await open(A.order_no)).action, "busy", "a second tab waits while the first makes it");
await made(A.order_no);
const again = await open(A.order_no);
assert.equal(again.action, "reuse", "an open Cashfree order with time left is used again");
assert.equal(again.payment_session_id, `session_${A.order_no}`);
// One that has nearly run out at Cashfree is not handed out again: the server checks and closes it, then makes "_2".
await q("UPDATE public.cashfree_orders SET expires_at = now() + interval '1 minute' WHERE cf_order_ref = $1", [A.order_no]);
await q("UPDATE public.cashfree_orders SET status = 'closed', closed_at = now() WHERE cf_order_ref = $1", [A.order_no]);
const second = await open(A.order_no);
assert.equal(second.action, "create");
assert.equal(second.cf_order_ref, `${A.order_no}_2`);
await made(second.cf_order_ref);

// A NEFT checkout keeps its bank transfer; a checkout whose time is up gets no Cashfree order.
const N = await checkout();
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET payment_method = 'NEFT' WHERE id = $1", [N.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await refuses(() => open(N.order_no), /bank transfer/, "NEFT checkout");
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET payment_method = 'UPI', payment_hold_until = now() - interval '1 second' WHERE id = $1", [N.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await refuses(() => open(N.order_no), /time to pay/, "time is up");

// ---------------------------------------------------------------- failed, dropped: the checkout stays as it is
const stockHeld = await stock();
let r = await record(second.cf_order_ref, "9001", "FAILED", Number(A.total), "", "upi");
assert.equal(r.outcome, "not_paid");
r = await record(second.cf_order_ref, "9002", "USER_DROPPED", Number(A.total), "", "upi");
assert.equal(r.outcome, "not_paid");
let a = await order(A.order_no);
assert.equal(a.order_status, "Awaiting Payment");
assert.equal(Number(a.paid_amount), 0);
assert.equal(await stock(), stockHeld, "stock stays held");
assert.equal((await one("SELECT count(*)::int AS n FROM public.payments WHERE order_id = $1", [A.id])).n, 0);
await refuses(() => record("SOMEONE-ELSES", "9003", "SUCCESS", 10), /not one of ours/, "a Cashfree order we never made");

// ---------------------------------------------------------------- a successful payment pays the checkout once
const outboxBefore = (await one("SELECT count(*)::int AS n FROM public.zoho_sync_outbox")).n;
r = await record(second.cf_order_ref, "9101", "SUCCESS", Number(A.total), "512345678901", "upi", "return");
assert.equal(r.outcome, "paid_order", JSON.stringify(r));
assert.equal(r.reference, "CASHFREE 9101 UTR 512345678901");
a = await order(A.order_no);
assert.equal(a.order_status, "Payment Confirmed");
assert.equal(a.payment_status, "Paid");
assert.equal(Number(a.paid_amount), Number(a.total));
assert.equal(a.payment_hold_until, null);
assert.equal(a.payment_method, "UPI", "the order keeps the way the customer chose to pay");
const pays = await q("SELECT amount, method, status, txn_ref, kind FROM public.payments WHERE order_id = $1", [A.id]);
assert.equal(pays.length, 1);
assert.equal(pays[0].method, "Cashfree UPI");
assert.equal(pays[0].status, "Paid");
assert.equal(pays[0].txn_ref, "CASHFREE 9101 UTR 512345678901");
assert.equal(Number(pays[0].amount), Number(a.total));
assert.equal(await stock(), stockHeld, "paying does not take the stock twice");
assert.ok((await one("SELECT count(*)::int AS n FROM public.zoho_sync_outbox")).n > outboxBefore, "the paid order is queued for Zoho");
assert.equal((await one("SELECT status FROM public.cashfree_orders WHERE cf_order_ref = $1", [second.cf_order_ref])).status, "paid");
const cp = await one("SELECT * FROM public.cashfree_payments WHERE cf_payment_id = '9101'");
assert.equal(cp.outcome, "paid_order");
assert.equal(cp.source, "return");
assert.ok(cp.payment_row_id);

// The webhook, the 15-minute job and the page may all bring it again: recorded once.
r = await record(second.cf_order_ref, "9101", "SUCCESS", Number(A.total), "512345678901", "upi", "webhook");
assert.equal(r.already, true);
r = await record(second.cf_order_ref, "9101", "FAILED", Number(A.total), "", "upi", "webhook");
assert.equal(r.already, true, "an older failure never undoes a success");
assert.equal((await one("SELECT count(*)::int AS n FROM public.payments WHERE order_id = $1", [A.id])).n, 1);
assert.equal((await one("SELECT payment_status FROM public.cashfree_payments WHERE cf_payment_id = '9101'")).payment_status, "SUCCESS");
await refuses(() => record(A.order_no, "9101", "SUCCESS", Number(A.total)), /belongs to another order/, "the same payment id on another Cashfree order");

// The same UPI transfer cannot pay another checkout as a UTR.
const B = await checkout();
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.submit_utr_for_order($1,'512345678901')", [B.order_no])), /already used/, "the Cashfree UTR sent again as a customer UTR");

// A second successful payment for a checkout already paid: on record, for a refund, never a second payment row.
await q("INSERT INTO public.cashfree_orders (order_id, order_no, cf_order_ref, environment, amount, status) VALUES ($1,$2,$3,'production',$4,'open')", [A.id, A.order_no, `${A.order_no}_3`, Number(A.total)]);
r = await record(`${A.order_no}_3`, "9102", "SUCCESS", Number(A.total), "512345678902");
assert.equal(r.outcome, "needs_refund");
assert.equal((await one("SELECT count(*)::int AS n FROM public.payments WHERE order_id = $1", [A.id])).n, 1);
assert.ok((await one("SELECT count(*)::int AS n FROM public.notifications WHERE recipient_role = 'admin' AND order_no = $1 AND message LIKE '%9102%'", [A.order_no])).n >= 1, "the admins are told");
assert.ok((await one("SELECT count(*)::int AS n FROM public.notifications WHERE recipient_role = 'customer' AND order_no = $1 AND title = 'Payment received'", [A.order_no])).n >= 1, "the customer is told not to pay again");

// ---------------------------------------------------------------- the amount must be what we asked
const first2 = await open(B.order_no);
await made(first2.cf_order_ref);
r = await record(first2.cf_order_ref, "9201", "SUCCESS", Number(B.total) - 1, "512345678903");
assert.equal(r.outcome, "needs_review");
assert.equal((await order(B.order_no)).order_status, "Awaiting Payment", "a wrong amount pays nothing");

// ---------------------------------------------------------------- a UTR sent on the side is not lost
const C = await checkout();
const cOpen = await open(C.order_no);
await made(cOpen.cf_order_ref);
await as(ADMIN, "authenticated", () => q("SELECT public.submit_utr_for_order($1,'612345678904')", [C.order_no]));
r = await record(cOpen.cf_order_ref, "9301", "SUCCESS", Number(C.total), "512345678905");
assert.equal(r.outcome, "paid_order");
const cs = await one("SELECT status, note, utr FROM public.upi_payment_submissions WHERE order_id = $1", [C.id]);
assert.equal(cs.utr, "612345678904", "the UTR the customer sent stays theirs");
assert.equal(cs.status, "confirmed");
assert.match(cs.note, /paid through Cashfree/);
assert.ok((await one("SELECT count(*)::int AS n FROM public.notifications WHERE recipient_role = 'admin' AND order_no = $1 AND message LIKE '%612345678904%'", [C.order_no])).n >= 1);

// ---------------------------------------------------------------- the time runs out while Cashfree may still pay
const D = await checkout();
const dOpen = await open(D.order_no);
await made(dOpen.cf_order_ref);
const ended = async (no) => (await order(no)).order_status;
const runOut = async (no, ago) => {
  await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
  await q("UPDATE public.orders SET payment_hold_until = now() - $2::interval WHERE order_no = $1", [no, ago]);
  await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
};
await runOut(D.order_no, "1 minute");
await as(CUSTOMER, "authenticated", () => q("SELECT public.expire_payment_holds()"));
assert.equal(await ended(D.order_no), "Awaiting Payment", "not ended while its Cashfree order is open");
r = await record(dOpen.cf_order_ref, "9401", "SUCCESS", Number(D.total), "512345678906");
assert.equal(r.outcome, "paid_order", "a payment made in the last moments still places the order");
assert.equal(await ended(D.order_no), "Payment Confirmed");

const E = await checkout();
const eOpen = await open(E.order_no);
await made(eOpen.cf_order_ref);
await runOut(E.order_no, "1 minute");
await q("UPDATE public.cashfree_orders SET status = 'closed', closed_at = now() WHERE cf_order_ref = $1", [eOpen.cf_order_ref]);
const before = await stock();
await as(CUSTOMER, "authenticated", () => q("SELECT public.expire_payment_holds()"));
assert.equal(await ended(E.order_no), "Payment Expired", "ends once Cashfree said no payment came");
assert.equal(await stock(), before + 1, "its stock goes back");

const F = await checkout();
const fOpen = await open(F.order_no);
await made(fOpen.cf_order_ref);
await runOut(F.order_no, "31 minutes");
await as(CUSTOMER, "authenticated", () => q("SELECT public.expire_payment_holds()"));
assert.equal(await ended(F.order_no), "Payment Expired", "never held more than 30 minutes past its time");

// Money after the end: on record as needs_refund, the order stays ended; an admin places it again with it.
r = await record(fOpen.cf_order_ref, "9501", "SUCCESS", Number(F.total), "512345678907");
assert.equal(r.outcome, "needs_refund");
assert.equal(await ended(F.order_no), "Payment Expired");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_settle_cashfree_payment('9501','placed')")), /No payment with reference/, "placed, before it was placed");
await as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1,$2,'UPI','Cashfree payment 9501')", [F.order_no, r.reference]));
assert.equal(await ended(F.order_no), "Payment Confirmed");
await as(ADMIN, "authenticated", () => q("SELECT public.admin_settle_cashfree_payment('9501','placed')"));
const settled = await one("SELECT outcome, settled_at, settled_note FROM public.cashfree_payments WHERE cf_payment_id = '9501'");
assert.equal(settled.outcome, "paid_order");
assert.ok(settled.settled_at);
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_settle_cashfree_payment('9501','refunded')")), /needs nothing more/, "settled twice");
// The webhook for it arriving later finds it done.
r = await record(fOpen.cf_order_ref, "9501", "SUCCESS", Number(F.total), "512345678907");
assert.equal(r.already, true);
await as(ADMIN, "authenticated", () => q("SELECT public.admin_settle_cashfree_payment('9102','refunded','sent back from the Cashfree dashboard')"));
assert.match((await one("SELECT settled_note FROM public.cashfree_payments WHERE cf_payment_id = '9102'")).settled_note, /Refunded in Cashfree by TEST Admin/);

// ---------------------------------------------------------------- sandbox money is marked as test money
const G = await checkout();
const gOpen = await open(G.order_no, CUSTOMER, "sandbox");
assert.equal(gOpen.action, "create");
await made(gOpen.cf_order_ref);
r = await record(gOpen.cf_order_ref, "9601", "SUCCESS", Number(G.total), "512345678908", "credit_card");
assert.equal(r.outcome, "paid_order");
assert.equal(r.reference, "CASHFREE TEST 9601", "a card payment has no UPI UTR on its reference");
assert.equal((await one("SELECT method FROM public.payments WHERE order_id = $1", [G.id])).method, "Cashfree TEST Card");

// ---------------------------------------------------------------- admins read the records, customers do not
const adminSees = await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS n FROM public.cashfree_payments"));
assert.ok(adminSees[0].n >= 5);
const customerSees = await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS n FROM public.cashfree_payments"));
assert.equal(customerSees[0].n, 0);
assert.equal((await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS n FROM public.cashfree_orders")))[0].n, 0);

console.log("cashfree gateway OK");
process.exit(0);
