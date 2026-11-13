// Real-Postgres check of 20261113200000_payment_stale_states.sql, on PGlite with every migration in the repo and small
// stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a dependency of
// this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> [LIVE_FNS_DIR=<folder of live pg_get_functiondef dumps>] \
//     node tests/db/payment-stale-states.db-test.mjs
//
// The database is first built WITHOUT the migration and given the live rows it fixes, so the glitches are shown before
// it runs; then the migration runs (twice, to show the one-off fixes are guarded) and every fix is checked.
// It must end with "payment stale states OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261113200000_payment_stale_states.sql";
const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
assert.ok(files.includes(MIGRATION));
const NEW_SQL = readFileSync(join(dir, MIGRATION), "utf8");

const STUBS = `
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
`;

const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), CUSTOMER2 = uid("c2"), PARTNER_USER = uid("b1");
const LAPSE = "we could not check your UTR in time";
const CLK = "CLK-577522-111126-155932", CLK_OLD = "CLK-577522-071126-164455", CLK_ENDED = "CLK-577522-131126-170854";

/** A database with every migration before this one, the people and the product the cases use. */
async function before() {
  const db = new PGlite();
  await db.exec(STUBS);
  for (const file of files.filter((name) => name < MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));
  const q = async (text, params) => (await db.query(text, params)).rows;
  await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${CUSTOMER2}','d@test.local'),('${PARTNER_USER}','p@test.local') ON CONFLICT DO NOTHING`);
  await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${CUSTOMER2}')`);
  await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer'),('${CUSTOMER2}','customer')`);
  await q(`UPDATE public.profiles SET full_name = 'TEST Admin' WHERE id = '${ADMIN}'`);
  await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
  await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${PARTNER_USER}','BR-CLK','Partner One','p@test.local','9000000001')`);
  await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
  await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','VENDOR-001','Sugar','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Sugar", stock: 500, sold: 10, unit: "bag" })]);
  await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
  await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',500,false)");
  await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Sugar',1000,400,'bag',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
  await q("INSERT INTO public.settings (key, value, is_public) VALUES ('bank_transfer', $1::jsonb, false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({ accountName: "Sample Traders", accountNumber: "10234000900", ifsc: "IDFB0000001", bankName: "Sample Bank", branch: "Sample" })]);
  await db.exec("ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;");
  return db;
}

function helpers(db) {
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0];
  const batchId = async () => (await one("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'")).id;
  /** An order as it stands, built without its triggers (they would refuse a Delivered order out of nowhere). */
  async function order(no, status, extra = {}, { qty = 2, sellers = null } = {}) {
    const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", vendor_ids: ["VENDOR-001"], ...extra };
    const cols = Object.keys(row);
    await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
    await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
    try {
      const id = (await one(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row))).id;
      const item = (await one("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Sugar',$2,50,100,'VENDOR-001') RETURNING id", [id, qty])).id;
      const released = status === "Payment Expired" || status === "Cancelled";
      await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,$3,$4,100)", [item, await batchId(), qty, released ? qty : 0]);
      const rows = sellers ?? (["Awaiting Payment", "Payment Expired"].includes(status) ? [] : [["VENDOR-001", status]]);
      for (const [vendor, fstatus] of rows) await q("INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status) VALUES ($1,$2,$3)", [id, vendor, fstatus]);
      return { id, item, no };
    } finally {
      await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
      await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
    }
  }
  const sub = (o, utr, status, note = null, user = CUSTOMER, amount = 100) =>
    q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'submitted' THEN NULL ELSE now() END)", [o.id, o.no, user, utr, amount, status, note]);
  const pay = (o, ref, status = "Paid", amount = 100, user = CUSTOMER) =>
    q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'advance',$3,'UPI',$4,$5)", [o.id, user, amount, status, ref]);
  /** Runs fn with auth.uid() = user, as the API role. */
  async function as(user, role, fn) {
    await db.query("UPDATE auth.cur SET uid = $1", [user]);
    await db.exec("SET ROLE " + role);
    try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
  }
  const admin = (text, params) => as(ADMIN, "authenticated", () => q(text, params));
  const refuses = async (fn, pattern, label) => {
    let message = "";
    try { await fn(); } catch (error) { message = error.message; }
    assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
  };
  // to_jsonb: follow_up and the refunded_ columns exist only once the migration ran.
  const subOf = async (o) => {
    const s = (await one("SELECT to_jsonb(s) AS s FROM public.upi_payment_submissions s WHERE order_id = $1", [o.id])).s;
    return { status: s.status, note: s.note, utr: s.utr, follow_up: s.follow_up ?? null, reviewed_by: s.reviewed_by, reviewed_at: s.reviewed_at,
      refunded_by: s.refunded_by ?? null, refunded_from: s.refunded_from ?? null, refunded_at: s.refunded_at ?? null };
  };
  const sellers = async (o) => (await q("SELECT vendor_id, status FROM public.order_vendor_fulfillments WHERE order_id = $1 ORDER BY vendor_id", [o.id])).map((r) => `${r.vendor_id}:${r.status}`);
  const notes = async (title, like) => (await q("SELECT DISTINCT recipient_role, message FROM public.notifications WHERE title = $1 AND message LIKE $2", [title, `%${like}%`]));
  /** A channel partner's hand-over scan: only the status moves, under app.delivery_handover, as the partner. */
  async function handover(o) {
    await db.query("UPDATE auth.cur SET uid = $1", [PARTNER_USER]);
    await q("SELECT set_config('app.delivery_handover', 'on', false)");
    try { await q("UPDATE public.orders SET order_status = 'Delivered' WHERE id = $1", [o.id]); }
    finally { await q("SELECT set_config('app.delivery_handover', 'off', false)"); await db.query("UPDATE auth.cur SET uid = NULL"); }
  }
  /** Zoho's package or shipment applied by the server: no user, app.zoho_inbound. */
  async function fromZoho(o, status) {
    await q("SELECT set_config('app.zoho_inbound', 'on', false)");
    try { await q("UPDATE public.orders SET order_status = $2 WHERE id = $1", [o.id, status]); }
    finally { await q("SELECT set_config('app.zoho_inbound', 'off', false)"); }
  }
  const blockers = async (customer) => Object.fromEntries((await one("SELECT private.customer_deletion_blockers($1) AS b", [customer])).b.map((x) => [x.code, x.orders]));
  const today = async () => (await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d")).d;
  return { q, one, order, sub, pay, as, admin, refuses, subOf, sellers, notes, handover, fromZoho, blockers, today };
}

// What every replaced function was allowed to do, and as whom: kept exactly.
const SIGNATURES = [
  "public.admin_confirm_manual_payment(text,numeric,text,text)", "public.admin_place_ended_checkout(text,text,text,text)",
  "public.mark_utr_refunded(text)", "public.sync_order_vendor_fulfillments()", "public.admin_cancel_order(text,text,boolean,jsonb)",
  "private.confirm_held_payment(uuid,text,text)", "private.customer_deletion_blockers(uuid)", "public.admin_delete_payment(uuid,text)",
  "public.cancel_marketplace_order(text)", "public.apply_zoho_order_cancellation(uuid)", "public.admin_utr_conflicts(integer)",
  "public.reopen_bank_credit(uuid)", "public.confirm_order_with_bank_credit(uuid,text,text)",
];
const rights = async (db, signature) => (await db.query(
  `SELECT p.prosecdef, p.proconfig, p.provolatile,
     has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
     has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
   FROM pg_proc p WHERE p.oid = $1::regprocedure`, [signature])).rows[0];

// ================================================================ the live database, before
const db = await before();
const h = helpers(db);
const { q, one, order, sub, pay, admin, refuses, subOf, sellers, notes, handover, fromZoho, blockers } = h;

// The repo's functions before this migration are the live ones it replaces (when the live dumps are given).
if (process.env.LIVE_FNS_DIR) {
  const flat = (text) => text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
  for (const signature of [...SIGNATURES, "public.settle_bank_credit(uuid,text)"]) {
    const name = signature.slice(0, signature.indexOf("("));
    const repo = (await one("SELECT pg_get_functiondef($1::regprocedure) AS d", [signature])).d;
    const live = readFileSync(join(process.env.LIVE_FNS_DIR, `${name}.sql`), "utf8");
    assert.equal(flat(repo), flat(live), `${name} in the repo is the live one`);
  }
  console.log("ok 0 the replaced functions are the live ones");
}
const rightsBefore = Object.fromEntries(await Promise.all(SIGNATURES.map(async (s) => [s, await rights(db, s)])));
const settleBefore = await rights(db, "public.settle_bank_credit(uuid,text)");

// The live rows (read 13 Nov 2026), with nothing that names a customer.
const clk = await order(CLK, "Delivered", { total: 260, subtotal: 260, paid_amount: 260, payment_status: "Paid" }, { sellers: [["VENDOR-001", "Payment Confirmed"]] });
await pay(clk, "578086325096", "Paid", 260);
await q("UPDATE public.payments SET created_at = '2026-11-12T12:19:28.166383Z' WHERE order_id = $1", [clk.id]);
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_at) VALUES ($1,$2,$3,'578086325096',260,'rejected',$4,'2026-11-12T11:25:55Z')", [clk.id, CLK, CUSTOMER, LAPSE]);
const clkOld = await order(CLK_OLD, "Delivered", { total: 130, subtotal: 130, paid_amount: 130, payment_status: "Paid" }, { sellers: [["VENDOR-001", "Packed"]] });
await pay(clkOld, "667714059208", "Paid", 130);
await sub(clkOld, "667714059208", "confirmed", null, CUSTOMER, 130);
const clkEnded = await order(CLK_ENDED, "Payment Expired", { total: 98.04, subtotal: 98.04, payment_hold_outcome: "ended" });
await q("INSERT INTO public.order_cancellations (order_id, order_no, stage, reason, cancelled_by, cancelled_by_name) VALUES ($1,$2,'Awaiting Payment','',$3,'TEST Admin')", [clkEnded.id, CLK_ENDED, ADMIN]);
// The same shape on another order: the one-off fix must leave it alone (the general fix is for payments recorded from now on).
const look = await order("TEST-LOOKALIKE", "Delivered", { paid_amount: 100, payment_status: "Paid" }, { sellers: [["VENDOR-001", "Packed"]] });
await pay(look, "578086325097");
await sub(look, "578086325097", "rejected", LAPSE);
// A UTR refunded before the migration (by the old mark_utr_refunded, which put the refunder in reviewed_by). None live.
const oldRefund = await order("TEST-OLD-REFUND", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(oldRefund, "612300000555", "rejected", "refunded by our team");
await q("UPDATE public.upi_payment_submissions SET reviewed_by = $2, reviewed_at = '2026-11-10T10:00:00Z' WHERE order_id = $1", [oldRefund.id, ADMIN]);

// ---- the glitches, as they are live
// 1/2. "Refunded" on the CLK row succeeds although that transfer paid the delivered order (tried, then undone).
await db.exec("BEGIN");
await admin("SELECT public.mark_utr_refunded($1)", [CLK]);
assert.equal((await subOf(clk)).note, "refunded by our team", "before: Refunded marks money that paid a delivered order");
await db.exec("ROLLBACK");
// 8. The customer cannot have their data deleted: that paid UTR still counts as an open payment.
assert.deepEqual((await blockers(CUSTOMER)).unconfirmed_payment?.includes(CLK), true, "before: the paid CLK UTR blocks the data delete");
// 4. A channel partner's hand-over leaves the seller row behind.
const sync1 = await order("TEST-SYNC-1", "Packed", { paid_amount: 100, payment_status: "Paid" });
await handover(sync1);
assert.equal((await one("SELECT order_status FROM public.orders WHERE id = $1", [sync1.id])).order_status, "Delivered");
assert.deepEqual(await sellers(sync1), ["VENDOR-001:Packed"], "before: the seller row stays Packed on a delivered order");
// 5. An ended checkout placed again cannot be cancelled later: its record of the end is in the way.
const e0 = await order("TEST-END-0", "Awaiting Payment", { payment_hold_until: new Date(Date.now() + 600_000).toISOString() });
await admin("SELECT public.admin_end_payment_hold($1, 'Customer asked us to stop')", [e0.no]);
await admin("SELECT public.admin_place_ended_checkout($1, '612300000001', 'UPI', 'Checked against bank app')", [e0.no]);
const refund = async () => ({ mode: "UPI", reference: "REFUND612300000001", refunded_on: await h.today() });
await refuses(async () => admin("SELECT public.admin_cancel_order($1, 'Customer cancelled', NULL, $2::jsonb)", [e0.no, JSON.stringify(await refund())]),
  /duplicate key|order_cancellations_order_id_key/, "before: cancelling an ended checkout that was placed again");
console.log("ok 1 the glitches reproduce on the old functions");

// ================================================================ the migration, twice
await db.exec(NEW_SQL);
const snapshot = async () => JSON.stringify(await q(`
  SELECT s.order_no, s.status, s.note, s.reviewed_at, s.reviewed_by, s.follow_up, s.refunded_at, s.refunded_by, s.refunded_from FROM public.upi_payment_submissions s ORDER BY s.order_no`))
  + JSON.stringify(await q("SELECT o.order_no, f.status, f.updated_at FROM public.order_vendor_fulfillments f JOIN public.orders o ON o.id = f.order_id ORDER BY o.order_no"))
  + JSON.stringify(await q("SELECT order_no, placed_again_at, placed_again_by_name FROM public.order_cancellations ORDER BY order_no"));
const once = await snapshot();
await db.exec(NEW_SQL);
assert.equal(await snapshot(), once, "running the migration again changes nothing");

// 3. The one live row: confirmed, checked when it was placed again, by the only admin; the look-alike is untouched.
let row = await subOf(clk);
assert.equal(row.status, "confirmed"); assert.equal(row.note, "Paid after the checkout ended; placed again");
assert.equal(new Date(row.reviewed_at).toISOString(), "2026-11-12T12:19:28.166Z"); assert.equal(row.reviewed_by, ADMIN);
assert.equal((await subOf(look)).status, "rejected", "the one-off fix touches only CLK-577522-111126-155932");
assert.equal((await one("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE utr = '578086325096'")).n, 0);
// 4. The two live seller rows: Delivered. TEST-SYNC-1 is not one of them and stays as it was.
assert.deepEqual(await sellers(clk), ["VENDOR-001:Delivered"]); assert.deepEqual(await sellers(clkOld), ["VENDOR-001:Delivered"]);
assert.deepEqual(await sellers(sync1), ["VENDOR-001:Packed"]);
assert.equal((await one("SELECT order_status FROM public.orders WHERE id = $1", [clk.id])).order_status, "Delivered", "the order itself is not recalculated");
// 5. The live ended checkout is still ended: not marked placed again.
assert.equal((await one("SELECT placed_again_at FROM public.order_cancellations WHERE order_id = $1", [clkEnded.id])).placed_again_at, null);
// A UTR refunded before: whoever was in reviewed_by refunded it (nobody had checked it), so it moves to refunded_by.
row = await subOf(oldRefund);
assert.deepEqual([row.note, row.reviewed_by, row.refunded_by, row.refunded_from, new Date(row.refunded_at).toISOString()],
  ["refunded by our team", null, ADMIN, "rejected", "2026-11-10T10:00:00.000Z"], "an earlier refund keeps who did it, not as a checker");
// 8. The CLK customer's data delete is no longer blocked by that UTR (nor by the look-alike: a Paid payment carries it).
assert.deepEqual((await blockers(CUSTOMER)).unconfirmed_payment ?? [], [], "a lapsed UTR that a Paid payment carries does not block");
// Grants, SECURITY DEFINER and search_path are as they were.
for (const signature of SIGNATURES) assert.deepEqual(await rights(db, signature), rightsBefore[signature], `${signature} keeps its rights`);
assert.deepEqual(await rights(db, "public.settle_bank_credit(uuid,text,boolean)"), settleBefore, "settle_bank_credit keeps its rights");
assert.equal((await one("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'settle_bank_credit'")).n, 1, "one settle_bank_credit, so two-argument calls are not ambiguous");
for (const fn of ["private.settle_kept_bank_credit(uuid,text,numeric,boolean)", "private.record_utr_refund(text,text)", "private.clear_settled_follow_up()"]) {
  const r = await rights(db, fn);
  assert.deepEqual([r.anon, r.auth], [false, false], `${fn} is not callable from the API`);
}
console.log("ok 2 one-off fixes: CLK row confirmed, 2 seller rows Delivered, guarded and safe to run twice; rights kept");

// ================================================================ every fix, from now on

// ---- 1. an ended checkout placed again with the UTR the customer sent: that row is settled
const e1 = await order("TEST-EXP-1", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(e1, "612300000011", "rejected", LAPSE);
await admin("SELECT public.admin_place_ended_checkout($1, '6123 0000 0011', 'UPI', 'Checked against bank app')", [e1.no]);
row = await subOf(e1);
assert.equal(row.status, "confirmed"); assert.equal(row.note, "Paid after the checkout ended; placed again. Checked against bank app");
assert.equal(row.reviewed_by, ADMIN, "Approved by: the admin who placed it"); assert.equal(row.follow_up, null);
await refuses(() => admin("SELECT public.mark_utr_refunded($1)", [e1.no]), /not checked in time/, "Refunded on a settled row");
assert.ok(!((await blockers(CUSTOMER)).unconfirmed_payment ?? []).includes(e1.no));
// ... and with another transfer: the lapsed one stays open, says why, and can still be refunded.
const e3 = await order("TEST-EXP-3", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(e3, "612300000031", "rejected", LAPSE);
await admin("SELECT public.admin_place_ended_checkout($1, '612300000032', 'NEFT', NULL)", [e3.no]);
row = await subOf(e3);
assert.equal(row.status, "rejected"); assert.equal(row.note, LAPSE, "the exact note stays: the list, Refunded and the delete guard need it");
assert.match(row.follow_up, /paid with another payment \(612300000032\).*refund it and press Refunded/);
assert.ok((await blockers(CUSTOMER)).unconfirmed_payment.includes(e3.no), "its money is not accounted for, so it still blocks a data delete");
await admin("SELECT public.mark_utr_refunded($1)", [e3.no]);
row = await subOf(e3);
assert.equal(row.note, "refunded by our team"); assert.equal(row.follow_up, null, "settled: the follow-up line goes");
assert.deepEqual([row.reviewed_by, row.refunded_by, row.refunded_from], [null, ADMIN, "rejected"], "nobody approved it; who refunded it is refunded_by");
assert.notEqual(row.refunded_at, null);
assert.equal((await one("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE utr = '612300000031'")).n, 1);
assert.equal((await notes("Refund recorded", "612300000031")).length, 1);
console.log("ok 3 item 1: own lapsed UTR confirmed when it paid; another transfer stays open with a follow-up");

// ---- 2. Refunded is refused when the transfer paid something
const paidElsewhere = await order("TEST-PAID-2", "Payment Confirmed", { paid_amount: 100, payment_status: "Paid" });
const l2 = await order("TEST-LAPSED-2", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(l2, "612300000021", "rejected", LAPSE); await pay(paidElsewhere, "612300000021");
await refuses(() => admin("SELECT public.mark_utr_refunded($1)", [l2.no]), /UTR 612300000021 already paid order TEST-PAID-2/, "a Paid payment");
const l4 = await order("TEST-LAPSED-4", "Payment Expired", { payment_hold_outcome: "expired" });
const confirmedElsewhere = await order("TEST-CONF-4", "Payment Confirmed", { paid_amount: 100, payment_status: "Paid" });
await sub(l4, "612300000041", "rejected", LAPSE); await sub(confirmedElsewhere, "612300000041", "confirmed");
await refuses(() => admin("SELECT public.mark_utr_refunded($1)", [l4.no]), /already paid order TEST-CONF-4/, "a confirmed UTR row");
const l5 = await order("TEST-LAPSED-5", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(l5, "612300000051", "rejected", LAPSE);
await q("INSERT INTO public.bank_credits (amount, utr, status, order_no, raw) VALUES (100, '612300000051', 'matched', 'TEST-SOMEWHERE', 'sms')");
await refuses(() => admin("SELECT public.mark_utr_refunded($1)", [l5.no]), /already paid order TEST-SOMEWHERE/, "a matched bank alert");
const l6 = await order("TEST-LAPSED-6", "Payment Expired", { payment_hold_outcome: "expired" });
const p6 = await order("TEST-OTHER-6", "Placed");
await sub(l6, "612300000061", "rejected", LAPSE);
await q("INSERT INTO public.bank_credits (amount, utr, status, order_id, order_no, raw) VALUES (100, '612300000061', 'balance', $1, $2, 'sms')", [p6.id, p6.no]);
await refuses(() => admin("SELECT public.mark_utr_refunded($1)", [l6.no]), /bank alert for UTR 612300000061 is on order TEST-OTHER-6/, "an alert on another order");
for (const o of [l2, l4, l5, l6]) assert.equal((await subOf(o)).note, LAPSE, "a refusal changes nothing");
console.log("ok 4 item 2: Refunded refused when the transfer paid an order (payment, confirmed UTR, matched alert, alert elsewhere)");

// ---- 7. one refund records both sides
const l7 = await order("TEST-LAPSED-7", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(l7, "612300000071", "rejected", LAPSE);
const late7 = (await one("INSERT INTO public.bank_credits (amount, utr, status, order_id, order_no, raw) VALUES (100, '612300000071', 'late', $1, $2, 'sms') RETURNING id", [l7.id, l7.no])).id;
await admin("SELECT public.mark_utr_refunded($1)", [l7.no]);
assert.deepEqual(await one("SELECT status, note FROM public.bank_credits WHERE id = $1", [late7]), { status: "settled", note: "Refunded: marked refunded on TEST-LAPSED-7" }, "Refunded settles the bank alert too");
const l8 = await order("TEST-LAPSED-8", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(l8, "612300000081", "rejected", LAPSE);
const late8 = (await one("INSERT INTO public.bank_credits (amount, utr, status, order_id, order_no, raw) VALUES (100, '612300000081', 'late', $1, $2, 'sms') RETURNING id", [l8.id, l8.no])).id;
await admin("SELECT public.settle_bank_credit(_credit_id => $1, _note => 'Refunded by UPI on 13 Nov', _refunded => true)", [late8]);
assert.equal((await subOf(l8)).note, "refunded by our team", "settling the alert as refunded marks the UTR refunded");
assert.equal((await one("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE utr = '612300000081'")).n, 1);
assert.equal((await notes("Refund recorded", "612300000081")).length, 1);
await refuses(() => admin("SELECT public.reopen_bank_credit($1)", [late8]), /recorded as refunded/, "reopening a refunded alert");
const plain = (await one("INSERT INTO public.bank_credits (amount, utr, status, raw) VALUES (55, '612300000091', 'unmatched', 'sms') RETURNING id")).id;
await admin("SELECT public.settle_bank_credit(_credit_id => $1, _note => 'Not ours, sent back')", [plain]);
assert.equal((await one("SELECT status FROM public.bank_credits WHERE id = $1", [plain])).status, "settled", "the two-argument call still works");
await admin("SELECT public.reopen_bank_credit($1)", [plain]);
assert.equal((await one("SELECT status FROM public.bank_credits WHERE id = $1", [plain])).status, "mismatch", "an alert not refunded still reopens");
console.log("ok 5 item 7: Refunded settles the alert; settling as refunded marks the UTR; refunded alerts stay closed");

// ---- 4. seller rows follow the order forward, for any role
const sync2 = await order("TEST-SYNC-2", "Packed", { paid_amount: 100, payment_status: "Paid" });
await handover(sync2);
assert.deepEqual(await sellers(sync2), ["VENDOR-001:Delivered"], "a partner's hand-over moves the seller row");
const sync3 = await order("TEST-SYNC-3", "Packed", { paid_amount: 100, payment_status: "Paid", vendor_ids: ["V1", "V2", "V3"] },
  { sellers: [["V1", "Out for Delivery"], ["V2", "Packed"], ["V3", "Cancelled"]] });
await fromZoho(sync3, "Dispatched");
assert.deepEqual(await sellers(sync3), ["V1:Out for Delivery", "V2:Dispatched", "V3:Cancelled"], "forward only, never out of Cancelled");
assert.equal((await one("SELECT order_status FROM public.orders WHERE id = $1", [sync3.id])).order_status, "Dispatched");
console.log("ok 6 item 4: forward-only copy for partners and Zoho");

// ---- 5. + 9. the live latent case: the checkout placed again before the migration can now be cancelled with a refund
let c = await one("SELECT stage, placed_again_at FROM public.order_cancellations WHERE order_id = $1", [e0.id]);
assert.equal(c.stage, "Awaiting Payment"); assert.notEqual(c.placed_again_at, null, "the backstop marks it placed again");
const e2 = await order("TEST-END-2", "Awaiting Payment", { payment_hold_until: new Date(Date.now() + 600_000).toISOString() });
await sub(e2, "612300000201", "submitted");
await admin("SELECT public.admin_end_payment_hold($1, 'Customer asked us to stop')", [e2.no]);
await admin("SELECT public.admin_place_ended_checkout($1, '612300000201', 'UPI', NULL)", [e2.no]);
c = await one("SELECT stage, reason, placed_again_at, placed_again_by_name FROM public.order_cancellations WHERE order_id = $1", [e2.id]);
assert.equal(c.stage, "Awaiting Payment"); assert.equal(c.reason, "Customer asked us to stop", "who ended it and why stay on record");
assert.notEqual(c.placed_again_at, null); assert.equal(c.placed_again_by_name, "TEST Admin");
const approved = await subOf(e2);
assert.equal(approved.status, "confirmed"); assert.equal(approved.reviewed_by, ADMIN);
// Another admin cancels and refunds: the UTR row keeps who approved it (Approved by), only its result changes.
const ADMIN2 = uid("a3");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN2}','a3@test.local')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN2}','admin')`);
for (const o of [e0, e2]) {
  await h.as(ADMIN2, "authenticated", async () => q("SELECT public.admin_cancel_order($1, 'Customer cancelled', NULL, $2::jsonb)", [o.no, JSON.stringify({ ...(await refund()), reference: `REFUND${o.no.replace(/\W/g, "")}` })]));
  c = await one("SELECT stage, reason, placed_again_at, placed_again_by_name, earlier FROM public.order_cancellations WHERE order_id = $1", [o.id]);
  assert.equal(c.stage, "Payment Confirmed"); assert.equal(c.reason, "Customer cancelled"); assert.equal(c.placed_again_at, null);
  assert.equal(c.earlier.stage, "Awaiting Payment"); assert.equal(c.earlier.reason, "Customer asked us to stop", "the ended checkout is kept in earlier");
  assert.equal((await one("SELECT order_status FROM public.orders WHERE id = $1", [o.id])).order_status, "Cancelled");
}
row = await subOf(e2);
assert.equal(row.status, "rejected"); assert.equal(row.note, "refunded by our team", "item 9: the confirmed UTR of a refunded order reads refunded");
assert.equal(row.reviewed_by, ADMIN, "still approved by the admin who placed it"); assert.equal(row.reviewed_at, approved.reviewed_at);
// Approved by stays ADMIN's approval, not a rejection: the refund is its own record, by the admin who cancelled.
assert.deepEqual([row.refunded_by, row.refunded_from], [ADMIN2, "confirmed"], "refunded by the admin who cancelled, after an approval");
assert.notEqual(row.refunded_at, null);
assert.equal((await one("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE utr = '612300000201'")).n, 1);
console.log("ok 7 items 5 + 9: ended checkout marked placed again, later cancel works and keeps it; refunded UTR reads refunded");

// ---- 6. a kept bank credit without a UTR
const recordSms = (amount, n) => h.as(null, "service_role", () => one(
  "SELECT public.record_bank_credit_without_reference('000900', $1::numeric, now(), NULL, $2, 'AX-IDFCFB-S') AS r",
  [String(amount), `Your A/C XXXXX000900 is credited with INR ${amount}.00 on 13/11/26 1${n}:00. Team IDFC FIRST Bank`])).then((x) => x.r);
const soon = () => new Date(Date.now() + 600_000).toISOString();
const k1 = await order("TEST-KEEP-1", "Awaiting Payment", { total: 150, subtotal: 150, payment_hold_until: soon(), created_at: new Date(Date.now() - 300_000).toISOString() });
let r = await recordSms(150, 1);
assert.equal(r.linked_order, k1.no, "the credit is kept for the only checkout of that amount");
await admin("SELECT public.admin_confirm_manual_payment($1, 150, '612300001111')", [k1.no]);
let credit = await one("SELECT status, order_no, paid_by_ref FROM public.bank_credits_without_reference WHERE id = $1", [r.id]);
assert.deepEqual(credit, { status: "used", order_no: k1.no, paid_by_ref: "612300001111" }, "paid another way: the kept credit is that money");
const k1pay = (await one("SELECT id FROM public.payments WHERE order_id = $1", [k1.id])).id;
await admin("SELECT public.admin_delete_payment($1, 'Recorded on the wrong order')", [k1pay]);
credit = await one("SELECT status, order_no, suggested_order_no, paid_by_ref FROM public.bank_credits_without_reference WHERE id = $1", [r.id]);
assert.deepEqual(credit, { status: "new", order_no: null, suggested_order_no: null, paid_by_ref: null }, "removing that payment frees the credit");
assert.equal((await one("SELECT bank_credit_id FROM public.orders WHERE id = $1", [k1.id])).bank_credit_id, null);
// The automatic path (a bank alert with the UTR) does not take it: it may be a second transfer. It is freed and named.
const k2 = await order("TEST-KEEP-2", "Awaiting Payment", { total: 175, subtotal: 175, payment_hold_until: soon(), created_at: new Date(Date.now() - 300_000).toISOString() });
r = await recordSms(175, 2);
assert.equal(r.linked_order, k2.no);
await q("SELECT private.confirm_held_payment($1, '612300002222', 'Matched automatically')", [k2.id]);
credit = await one("SELECT status, suggested_order_no FROM public.bank_credits_without_reference WHERE id = $1", [r.id]);
assert.deepEqual(credit, { status: "new", suggested_order_no: null });
assert.equal((await one("SELECT bank_credit_id FROM public.orders WHERE id = $1", [k2.id])).bank_credit_id, null, "and can pay its real order later");
assert.equal((await notes("Payment needs you", "kept for TEST-KEEP-2")).length, 1);
// One order never closes two credits.
const k3 = await order("TEST-KEEP-3", "Awaiting Payment", { total: 190, subtotal: 190, payment_hold_until: soon(), created_at: new Date(Date.now() - 300_000).toISOString() });
const kept3 = (await recordSms(190, 3)).id;
await sub(k3, "612300003333", "submitted", null, CUSTOMER, 190);
const other3 = (await recordSms(190, 4)).id;
await refuses(() => admin("SELECT public.confirm_order_with_bank_credit($1, $2, '612300003333')", [other3, k3.no]), /Another bank credit is kept for this order/, "a second credit");
await admin("SELECT public.confirm_order_with_bank_credit($1, $2, '612300003333')", [kept3, k3.no]);
assert.deepEqual(await one("SELECT status, order_no, paid_by_ref FROM public.bank_credits_without_reference WHERE id = $1", [kept3]), { status: "used", order_no: k3.no, paid_by_ref: "612300003333" });
assert.equal((await one("SELECT status FROM public.bank_credits_without_reference WHERE id = $1", [other3])).status, "new", "the other credit stays open");
console.log("ok 8 item 6: kept credit used when paid another way, freed on the automatic path, reopened when the payment goes");

// ---- 8. the data-delete blocker keys on the money
const l9 = await order("TEST-LAPSED-9", "Payment Expired", { payment_hold_outcome: "expired", user_id: CUSTOMER2 });
await sub(l9, "612300000099", "rejected", LAPSE, CUSTOMER2);
assert.deepEqual((await blockers(CUSTOMER2)).unconfirmed_payment, [l9.no], "an unchecked UTR still blocks");
await pay(await order("TEST-REFUNDED-9", "Cancelled", { user_id: CUSTOMER2, payment_status: "Refunded" }), "612300000099", "Refunded", 100, CUSTOMER2);
assert.equal((await blockers(CUSTOMER2)).unconfirmed_payment, undefined, "money paid back is accounted for");
console.log("ok 9 item 8: a lapsed UTR blocks the data delete only while its money is not accounted for");

// ---- 10. removing the payment that placed a lapsed UTR again opens it again
const a10 = await order("TEST-A-10", "Payment Expired", { payment_hold_outcome: "expired" });
const b10 = await order("TEST-B-10", "Awaiting Payment", { payment_hold_until: soon() });
await sub(a10, "612300000101", "rejected", LAPSE);
await admin("SELECT public.admin_confirm_manual_payment($1, 100, '612300000101')", [b10.no]);
assert.equal((await subOf(a10)).note, "Placed again as TEST-B-10");
await admin("SELECT public.admin_delete_payment($1, 'Not this customer''s money')", [(await one("SELECT id FROM public.payments WHERE order_id = $1", [b10.id])).id]);
assert.equal((await subOf(a10)).note, LAPSE, "back under Not checked in time");
assert.equal((await notes("Payment needs you", "no longer pays TEST-B-10")).length, 1);
await admin("SELECT public.mark_utr_refunded($1)", [a10.no]);
assert.equal((await subOf(a10)).note, "refunded by our team", "and can be refunded");
// Guarded: another payment still holds that transfer -> the note stays.
const a11 = await order("TEST-A-11", "Payment Expired", { payment_hold_outcome: "expired" });
const b11 = await order("TEST-B-11", "Awaiting Payment", { payment_hold_until: soon() });
await sub(a11, "612300000111", "rejected", LAPSE);
await admin("SELECT public.admin_confirm_manual_payment($1, 100, '612300000111')", [b11.no]);
await db.exec("SET session_replication_role = replica");
await pay(await order("TEST-C-11", "Payment Confirmed", { paid_amount: 100, payment_status: "Paid" }), "612300000111");
await db.exec("SET session_replication_role = origin");
await admin("SELECT public.admin_delete_payment($1, 'Recorded twice')", [(await one("SELECT id FROM public.payments WHERE order_id = $1", [b11.id])).id]);
assert.equal((await subOf(a11)).note, "Placed again as TEST-B-11", "another payment still holds the transfer");
console.log("ok 10 item 10: Placed again as X reverts when X's payment is removed (guarded)");

// ---- 11. cancelling while a UTR waits
const z1 = await order("TEST-ZOHO-1", "Placed");
await sub(z1, "612300000121", "submitted");
await refuses(() => h.as(CUSTOMER, "authenticated", () => q("SELECT public.cancel_marketplace_order($1)", [z1.no])), /still checking the UTR you sent/, "customer cancel");
await refuses(() => admin("SELECT public.cancel_marketplace_order($1)", [z1.no]), /waits for a check/, "admin cancel");
const z2 = await order("TEST-ZOHO-2", "Placed");
await h.as(CUSTOMER, "authenticated", () => q("SELECT public.cancel_marketplace_order($1)", [z2.no]));
assert.equal((await one("SELECT order_status FROM public.orders WHERE id = $1", [z2.id])).order_status, "Cancelled", "no UTR: the customer cancel works as before");
assert.equal((await h.as(null, "service_role", () => one("SELECT public.apply_zoho_order_cancellation($1) AS r", [z1.id]))).r, "cancelled", "Zoho's void is not refused");
row = await subOf(z1);
assert.equal(row.status, "rejected"); assert.equal(row.note, LAPSE, "the waiting UTR goes under Not checked in time");
assert.equal((await notes("Payment needs you", "TEST-ZOHO-1 was voided in Zoho while UTR 612300000121")).length, 1);
assert.ok((await blockers(CUSTOMER)).unconfirmed_payment.includes(z1.no), "and still blocks a data delete");
await refuses(() => admin("SELECT public.admin_delete_utr($1, 'clean up')", [z1.no]), /Nobody checked this UTR/, "it cannot be deleted unchecked");
await admin("SELECT public.mark_utr_refunded($1)", [z1.no]);
console.log("ok 11 item 11: customer/admin cancel refused while a UTR waits; Zoho void closes it as not checked in time and tells admins");

// ---- 12. a lapsed UTR placed again on the same account is settled in UTR checks
const a12 = await order("TEST-A-12", "Payment Expired", { payment_hold_outcome: "expired" });
const b12 = await order("TEST-B-12", "Awaiting Payment", { payment_hold_until: soon() });
await sub(a12, "612300000131", "rejected", LAPSE);
await sub(b12, "612300000131", "submitted");
await admin("SELECT public.review_upi_utr($1, 'confirmed', NULL, '612300000131')", [b12.no]);
assert.equal((await subOf(a12)).note, "Placed again as TEST-B-12");
const a13 = await order("TEST-A-13", "Payment Expired", { payment_hold_outcome: "expired" });
const b13 = await order("TEST-B-13", "Awaiting Payment", { payment_hold_until: soon(), user_id: CUSTOMER2 });
await sub(a13, "612300000141", "rejected", LAPSE);
await sub(b13, "612300000141", "submitted", null, CUSTOMER2);
await admin("SELECT public.review_upi_utr($1, 'confirmed', NULL, '612300000141')", [b13.no]);
const groups = (await admin("SELECT public.admin_utr_conflicts(90) AS r"))[0].r.groups;
const same = groups.find((g) => g.key === "612300000131"), cross = groups.find((g) => g.key === "612300000141");
assert.equal(same.reviewed, true); assert.equal(same.auto_settled, true);
assert.equal(same.review_note, "Lapsed checkout TEST-A-12 placed again as TEST-B-12 on the same account");
assert.equal(cross.reviewed, false, "another account stays open"); assert.equal(cross.severity, "high");
console.log("ok 12 item 12: same-account reuse settled on its own, another account stays a high warning");

// ================================================================ review fixes (13 Nov 2026)

// ---- UTR checks: a third order of the same account that is not "Placed again as" the paid order keeps the group open
// (bool_and skipped its NULL, so the group read settled and its note said that order was placed again).
for (const [n, third] of [["1", "refused try"], ["2", "UTR rejected for another reason"]]) {
  const a = await order(`TEST-RV-A-${n}`, "Payment Expired", { payment_hold_outcome: "expired" });
  const b = await order(`TEST-RV-B-${n}`, "Awaiting Payment", { payment_hold_until: soon() });
  const c3 = await order(`TEST-RV-C-${n}`, "Placed");
  const utr = `71230000013${n}`;
  await sub(a, utr, "rejected", LAPSE);
  await sub(b, utr, "submitted");
  await admin("SELECT public.review_upi_utr($1, 'confirmed', NULL, $2)", [b.no, utr]);
  assert.equal((await subOf(a)).note, `Placed again as ${b.no}`);
  if (n === "1") {
    await q("INSERT INTO public.utr_attempts (order_id, order_no, user_id, utr, utr_key, amount, outcome, reason) VALUES ($1,$2,$3,$4,$4,100,'refused','this UTR already paid an order')", [c3.id, c3.no, CUSTOMER, utr]);
  } else {
    await sub(c3, utr, "rejected", "UTR not in the bank");
  }
  const g = (await admin("SELECT public.admin_utr_conflicts(90) AS r"))[0].r.groups.find((x) => x.key === utr);
  assert.deepEqual([g.orders, g.accounts, g.reviewed, g.auto_settled], [3, 1, false, false], `a ${third} on a third order keeps the group open`);
  assert.equal(g.review_note ?? null, null, "and no note says that order was placed again");
}
assert.equal((await admin("SELECT public.admin_utr_conflicts(90) AS r"))[0].r.groups.find((x) => x.key === "612300000131").auto_settled, true, "the two-order reuse is still settled");

// ---- removing the payment that paid an order clears the follow_up line that said the order was paid
const f4 = await order("TEST-EXP-F4", "Payment Expired", { payment_hold_outcome: "expired" });
await sub(f4, "612300000401", "rejected", LAPSE);
await admin("SELECT public.admin_place_ended_checkout($1, '612300000402', 'NEFT', NULL)", [f4.no]);
assert.match((await subOf(f4)).follow_up, /paid with another payment \(612300000402\)/);
await admin("SELECT public.admin_delete_payment($1, 'Recorded on the wrong order')", [(await one("SELECT id FROM public.payments WHERE order_id = $1", [f4.id])).id]);
assert.equal((await one("SELECT payment_status FROM public.orders WHERE id = $1", [f4.id])).payment_status, "Pending");
row = await subOf(f4);
assert.deepEqual([row.status, row.note, row.follow_up], ["rejected", LAPSE, null], "the order is unpaid: the lapsed UTR stays open, without the stale line");
await admin("SELECT public.admin_confirm_manual_payment($1, 100, '612300000403', 'NEFT')", [f4.no]);
assert.match((await subOf(f4)).follow_up, /paid with another payment \(612300000403\)/, "paid in full again: the line is written again");

// ---- a payment recorded by hand while a bank alert carries its UTR: a kept credit without a UTR is freed and named,
// as on the automatic path, never closed against the same payment.
const k5 = await order("TEST-KEEP-5", "Awaiting Payment", { total: 160, subtotal: 160, payment_hold_until: soon(), created_at: new Date(Date.now() - 300_000).toISOString() });
r = await recordSms(160, 5);
assert.equal(r.linked_order, k5.no);
await db.exec("SET session_replication_role = replica");
const alert5 = (await one("INSERT INTO public.bank_credits (amount, utr, status, raw) VALUES (160, '612300005555', 'unmatched', 'sms') RETURNING id")).id;
await db.exec("SET session_replication_role = origin");
await admin("SELECT public.admin_confirm_manual_payment($1, 160, '612300005555')", [k5.no]);
assert.equal((await one("SELECT status FROM public.bank_credits WHERE id = $1", [alert5])).status, "matched", "the alert with the UTR is the money");
credit = await one("SELECT status, suggested_order_no, paid_by_ref FROM public.bank_credits_without_reference WHERE id = $1", [r.id]);
assert.deepEqual(credit, { status: "new", suggested_order_no: null, paid_by_ref: null }, "the credit without a UTR is not taken too");
assert.equal((await one("SELECT bank_credit_id FROM public.orders WHERE id = $1", [k5.id])).bank_credit_id, null);
assert.equal((await notes("Payment needs you", "kept for TEST-KEEP-5")).length, 1, "the admins are told");

// ---- (kept, reviewer's finding 2) paid under another reference while the customer's UTR waited, then cancelled with a
// refund: that UTR row was closed as this order's money, so it reads refunded and cannot pay another order.
const cr = await order("TEST-CAN-REF", "Awaiting Payment", { payment_hold_until: soon() });
await sub(cr, "612300000601", "submitted");
await admin("SELECT public.admin_confirm_manual_payment($1, 100, 'NEFT HDFC0000123 SBIN612399990000', 'NEFT')", [cr.no]);
row = await subOf(cr);
assert.deepEqual([row.status, row.note, row.reviewed_by], ["confirmed", "Recorded by an admin with reference NEFT HDFC0000123 SBIN612399990000", ADMIN]);
await h.as(ADMIN2, "authenticated", async () => q("SELECT public.admin_cancel_order($1, 'Customer cancelled', NULL, $2::jsonb)", [cr.no, JSON.stringify({ ...(await refund()), mode: "NEFT", reference: "REFUNDTESTCANREF01" })]));
row = await subOf(cr);
assert.deepEqual([row.status, row.note, row.reviewed_by, row.refunded_by, row.refunded_from], ["rejected", "refunded by our team", ADMIN, ADMIN2, "confirmed"]);
const cr2 = await order("TEST-CAN-REF-2", "Placed");
await refuses(() => admin("SELECT public.admin_confirm_manual_payment($1, 100, '612300000601')", [cr2.no]), /This UTR was refunded/, "money paid back cannot pay another order");
console.log("ok 14 review: UTR checks NULL-safe, follow_up cleared when the payment goes, kept credit freed beside a UTR alert, refunds keep the approver");

// ================================================================ the one-off fixes are guarded
{
  const fresh = await before();
  const g = helpers(fresh);
  // The CLK row whose order is not Paid any more, and the seller rows of orders not Delivered: nothing changes.
  const o = await g.order(CLK, "Payment Confirmed", { total: 260, subtotal: 260, paid_amount: 0, payment_status: "Pending" }, { sellers: [["VENDOR-001", "Payment Confirmed"]] });
  await g.q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_at) VALUES ($1,$2,$3,'578086325096',260,'rejected',$4,'2026-11-12T11:25:55Z')", [o.id, CLK, CUSTOMER, LAPSE]);
  const old = await g.order(CLK_OLD, "Out for Delivery", { total: 130, subtotal: 130, paid_amount: 130, payment_status: "Paid" }, { sellers: [["VENDOR-001", "Packed"]] });
  await fresh.exec(NEW_SQL);
  assert.deepEqual([(await g.subOf(o)).status, (await g.subOf(o)).note], ["rejected", LAPSE], "not Paid: the CLK row is left alone");
  assert.deepEqual(await g.sellers(o), ["VENDOR-001:Payment Confirmed"]);
  assert.deepEqual(await g.sellers(old), ["VENDOR-001:Packed"], "not Delivered: the seller row is left alone");
  // Two admins: who placed it again is not known, so Approved by stays empty.
  const second = uid("a2");
  await g.q(`INSERT INTO auth.users (id, email) VALUES ('${second}','a2@test.local')`);
  await g.q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${second}','admin')`);
  await fresh.exec("SET session_replication_role = replica");
  await g.q("UPDATE public.orders SET payment_status = 'Paid', paid_amount = 260 WHERE id = $1", [o.id]);
  await fresh.exec("SET session_replication_role = origin");
  await g.pay(o, "578086325096", "Paid", 260);
  await fresh.exec(NEW_SQL);
  const fixed = await g.subOf(o);
  assert.equal(fixed.status, "confirmed"); assert.equal(fixed.reviewed_by, null, "two admins: nobody is guessed");
  await fresh.close();
}
console.log("ok 13 one-off fixes leave anything else alone");

await db.close();
console.log("payment stale states OK");
