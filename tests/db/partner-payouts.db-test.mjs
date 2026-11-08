// Real-Postgres check of 20261108100000_partner_payouts_and_money_tools.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/partner-payouts.db-test.mjs
//
// It must end with "partner payouts OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261108100000_partner_payouts_and_money_tools.sql";

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
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), P1_USER = uid("b1"), P2_USER = uid("b2"), STRANGER = uid("d1");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${P1_USER}','p1@test.local'),('${P2_USER}','p2@test.local'),('${STRANGER}','s@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
const PARTNER1 = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${P1_USER}','BR-CLK','Partner One','p1@test.local','9000000001') RETURNING id`))[0].id;
const PARTNER2 = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${P2_USER}','BR-HBL','Partner Two','p2@test.local','9000000002') RETURNING id`))[0].id;
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Oil','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Oil", stock: 500, sold: 0 })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
let n = 0;
async function order(no, opts = {}) {
  const { status = "Delivered", payment = "Paid", amount = 10, partner = PARTNER1, placed = "2026-11-05T10:00:00+05:30", extra = {} } = opts;
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 100, subtotal: 100, paid_amount: payment === "Paid" ? 100 : 0, payment_status: payment, payment_method: "UPI", order_status: status, branch_id: partner === PARTNER1 ? "BR-CLK" : "BR-HBL", created_at: placed, ...extra };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  n += 1;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Oil',2,50,100,'V1') RETURNING id", [id]))[0].id;
  const st = (await q("SELECT public.partner_commission_status($1,$2) AS s", [status, payment]))[0].s;
  await q(`INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id, product_name, qty, line_total, kind, rate, amount, status, placed_at, earned_at)
    VALUES ($1,$2,$3,$4,$5,'P1','TEST Oil',2,100,'per_unit',$6,$7,$8,$9, CASE WHEN $8='earned' THEN now() END)`, [item, id, no, partner, row.branch_id, amount / 2, amount, st, placed]);
  return { id, item, no };
}
const A = await order("TEST-A", { placed: "2026-11-03T10:00:00+05:30" });
const B = await order("TEST-B", { placed: "2026-11-04T10:00:00+05:30", amount: 20 });
const C = await order("TEST-C", { placed: "2026-11-05T10:00:00+05:30", amount: 30 });
const D = await order("TEST-D", { status: "Payment Confirmed", amount: 40, placed: "2026-11-05T11:00:00+05:30" });
const H = await order("TEST-HUBLI", { partner: PARTNER2, amount: 7 });
const EXPIRED = await order("TEST-EXPIRED", { status: "Payment Expired", payment: "Pending", amount: 5 });
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");

async function as(user, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const admin = (fn) => as(ADMIN, "authenticated", fn);
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
const TODAY = "2026-11-08";
const pay = (items, opts = {}) => admin(() => q(
  "SELECT public.admin_create_partner_payout($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8) AS r",
  [opts.partner ?? PARTNER1, items, opts.on ?? TODAY, opts.mode ?? "UPI", opts.ref === undefined ? `UTR${Math.random().toString(36).slice(2, 12).toUpperCase()}` : opts.ref, opts.note ?? "", opts.amount ?? null, opts.key ?? null],
).then((rows) => rows[0].r));
const summary = async (partner = PARTNER1) => (await admin(() => q("SELECT * FROM public.partner_settlement_summary() WHERE partner_id = $1", [partner])))[0];
const lineOf = async (order) => (await admin(() => q("SELECT * FROM public.partner_settlement_lines() WHERE order_item_id = $1", [order.item])))[0];
const money = (v) => Number(v);
// Whatever happens, the books balance: earned - paid = due - owed back.
const balanced = async (label) => {
  const s = await summary();
  assert.equal(Math.round((money(s.earned) - money(s.paid)) * 100), Math.round((money(s.due) - money(s.owed_back)) * 100), `books out of balance after ${label}: ${JSON.stringify(s)}`);
  return s;
};

// ---- starting position
let s = await balanced("start");
assert.equal(money(s.earned), 60); assert.equal(money(s.pending), 40); assert.equal(money(s.paid), 0); assert.equal(money(s.due), 60);
assert.equal((await admin(() => q("SELECT count(*)::int AS c FROM public.partner_settlement_lines() WHERE order_no = 'TEST-EXPIRED'")))[0].c, 0, "an expired checkout is not a commission");

// ---- only an admin, only what is earned
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_create_partner_payout($1,$2,$3,'UPI','UTR12345')", [PARTNER1, [A.item], TODAY])), /Only administrators/, "customer pays");
await refuses(() => as(P1_USER, "authenticated", () => q("SELECT public.admin_create_partner_payout($1,$2,$3,'UPI','UTR12345')", [PARTNER1, [A.item], TODAY])), /Only administrators/, "partner pays self");
await refuses(() => pay([D.item]), /no longer due/, "an order not delivered is not payable");
await refuses(() => pay([H.item]), /no longer due/, "another partner's line");
await refuses(() => pay([A.item], { ref: "" }), /UTR or reference/, "bank payment needs a reference");
await refuses(() => pay([A.item], { on: "2099-01-01" }), /not in the future/, "future date");
await refuses(() => pay([A.item], { amount: 11 }), /most this payout can be is Rs 10\.00/, "more than owed");

// ---- pay a whole day; the same line cannot be paid twice
const first = await pay([A.item], { ref: "utr 1111 2222", key: uid("f1") });
assert.equal(money(first.amount), 10); assert.equal(first.replayed, false);
const again = await pay([A.item], { ref: "UTR11112222", key: uid("f1") });
assert.equal(again.replayed, true, "a second press records nothing new"); assert.equal(again.payout_no, first.payout_no);
assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_payouts"))[0].c, 1);
assert.equal((await q("SELECT reference FROM public.partner_payouts"))[0].reference, "UTR11112222", "the reference is kept without spaces");
await refuses(() => pay([A.item]), /no longer due/, "same line twice");
await refuses(() => pay([B.item], { ref: "UTR11112222" }), /already recorded on payout/, "same UTR twice");
s = await balanced("first payout");
assert.equal(money(s.paid), 10); assert.equal(money(s.due), 50);
const a1 = await lineOf(A);
assert.equal(money(a1.paid_amount), 10); assert.equal(money(a1.due_amount), 0); assert.deepEqual(a1.payout_nos, [first.payout_no]);

// ---- part payment: oldest first, the rest stays due
const part = await pay([B.item, C.item], { amount: 25 });
assert.equal(money(part.amount), 25);
assert.equal(money((await lineOf(B)).due_amount), 0, "the oldest line is paid first");
assert.equal(money((await lineOf(C)).paid_amount), 5); assert.equal(money((await lineOf(C)).due_amount), 25, "part of the newest stays due");
s = await balanced("part payment");
assert.equal(money(s.paid), 35); assert.equal(money(s.due), 25);

// ---- two people at once cannot both pay it: the second sees it paid (same statement order as the row lock gives)
// (PGlite has one connection; the lock itself is FOR UPDATE on the partner row, read in the function.)

// ---- an order cancelled after it was paid out: comes off the next payout
await as(ADMIN, "authenticated", async () => {
  await q("SELECT set_config('app.cancel_order_workflow','on',false)");
  await q("UPDATE public.orders SET order_status = 'Cancelled' WHERE id = $1", [A.id]);
  await q("SELECT set_config('app.cancel_order_workflow','off',false)");
}).catch(async () => {
  // The dispatch guard refuses a delivered order; the test only needs the order to stop being earned.
  await q("ALTER TABLE public.orders DISABLE TRIGGER orders_guard_mutation");
  await q("UPDATE public.orders SET order_status = 'Cancelled' WHERE id = $1", [A.id]);
  await q("ALTER TABLE public.orders ENABLE TRIGGER orders_guard_mutation");
});
const ax = await lineOf(A);
assert.equal(ax.status, "cancelled"); assert.equal(money(ax.due_amount), -10, "paid but no longer earned");
s = await balanced("cancel after payout");
assert.equal(money(s.owed_back), 10); assert.equal(money(s.due), 25);

// ---- the next payout is reduced by it, and the most it can be says so
await refuses(() => pay([C.item], { amount: 20 }), /most this payout can be is Rs 15\.00/, "recovery comes off first");
const net = await pay([C.item]);
assert.equal(money(net.amount), 15); assert.equal(money(net.recovered), 10);
assert.equal(money((await lineOf(A)).due_amount), 0, "recovered");
assert.equal(money((await lineOf(C)).due_amount), 0);
s = await balanced("recovered");
assert.equal(money(s.paid), 50); assert.equal(money(s.earned), 50); assert.equal(money(s.owed_back), 0); assert.equal(money(s.due), 0);
const netLines = await q("SELECT l.amount FROM public.partner_payout_lines l JOIN public.partner_payouts p ON p.id = l.payout_id WHERE p.payout_no = $1", [net.payout_no]);
assert.equal(netLines.reduce((sum, row) => sum + money(row.amount), 0), 15, "a payout's lines add up to the money sent");

// ---- undo: its lines fall due again, with a reason and a log; the reference is free again
await refuses(() => admin(() => q("SELECT public.admin_void_partner_payout($1,'x')", [net.id])), /Say why/, "a reason is required");
await admin(() => q("SELECT public.admin_void_partner_payout($1,'transfer bounced')", [net.id]));
s = await balanced("void");
assert.equal(money(s.paid), 35); assert.equal(money(s.due), 25); assert.equal(money(s.owed_back), 10);
await refuses(() => admin(() => q("SELECT public.admin_void_partner_payout($1,'twice over')", [net.id])), /already undone/, "cannot undo twice");
assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_payout_events WHERE payout_id = $1", [net.id]))[0].c, 2);
const fixed = await pay([C.item]);
assert.equal(money(fixed.amount), 15);
await balanced("paid again");

// ---- correct the details, old values logged, amount untouched
await admin(() => q("SELECT public.admin_correct_partner_payout($1,$2,'NEFT','NEWUTR999','typed the wrong one','wrong utr typed')", [fixed.id, "2026-11-07"]));
const corrected = (await q("SELECT * FROM public.partner_payouts WHERE id = $1", [fixed.id]))[0];
assert.equal(corrected.mode, "NEFT"); assert.equal(corrected.reference, "NEWUTR999"); assert.equal(money(corrected.amount), 15);
const log = (await q("SELECT detail FROM public.partner_payout_events WHERE payout_id = $1 AND event = 'corrected'", [fixed.id]))[0].detail;
assert.equal(log.before.mode, "UPI", "the old value is kept");

// ---- nothing is deleted, and nobody writes the tables directly
await refuses(() => q("DELETE FROM public.partner_payouts WHERE id = $1", [fixed.id]), /never deleted/, "delete a payout");
await refuses(() => q("DELETE FROM public.partner_payout_lines WHERE payout_id = $1", [fixed.id]), /never deleted/, "delete payout lines");
await refuses(() => admin(() => q("UPDATE public.partner_payouts SET amount = 1 WHERE id = $1", [fixed.id])), /permission denied/, "admin edits a payout directly");
await refuses(() => admin(() => q("INSERT INTO public.partner_payout_events (payout_id, event) VALUES ($1,'voided')", [fixed.id])), /permission denied/, "admin forges a log entry");

// ---- a partner sees only their own
await as(P2_USER, "authenticated", async () => {
  assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_payouts"))[0].c, 0, "partner two has no payouts");
  assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_settlement_summary()"))[0].c, 1);
  assert.ok((await q("SELECT DISTINCT partner_id FROM public.partner_settlement_lines($1)", [PARTNER1])).every((row) => row.partner_id === PARTNER2), "asking for another partner returns only your own");
  assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_payout_events"))[0].c, 0, "the log is the admin's");
});
await as(P1_USER, "authenticated", async () => {
  const mine = await q("SELECT * FROM public.partner_payouts");
  assert.ok(mine.length >= 3 && mine.every((row) => row.partner_id === PARTNER1));
  assert.ok((await q("SELECT count(*)::int AS c FROM public.partner_commission_lines('2026-11-01')"))[0].c >= 1);
  await refuses(() => q("UPDATE public.partner_payouts SET amount = 999"), /permission denied/, "partner edits a payout");
});
await refuses(() => as(STRANGER, "authenticated", () => q("SELECT * FROM public.partner_settlement_summary()")), /Only channel partners/, "stranger reads the ledger");

// ---- a suspended partner is still owed
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE id = $1", [PARTNER2]);
const h = await pay([H.item], { partner: PARTNER2 });
assert.equal(money(h.amount), 7, "a past partner can still be paid");

// ---- refund and return
await q("ALTER TABLE public.orders DISABLE TRIGGER orders_guard_mutation");
await q("UPDATE public.orders SET payment_status = 'Refunded' WHERE id = $1", [B.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER orders_guard_mutation");
assert.equal((await lineOf(B)).status, "cancelled", "a refunded order earns nothing");
assert.equal(money((await lineOf(B)).due_amount), -20);
await balanced("refund");
await q("ALTER TABLE public.orders DISABLE TRIGGER orders_guard_mutation");
await q("UPDATE public.orders SET payment_status = 'Paid' WHERE id = $1", [B.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER orders_guard_mutation");
await q("ALTER TABLE public.return_requests DISABLE TRIGGER USER");
await q("INSERT INTO public.return_requests (order_id, order_item_id, customer_id, product_id, vendor_id, quantity, amount, reason, status, refund_status) VALUES ($1,$2,$3,'P1','V1',1,50,'damaged','Completed','Refunded')", [B.id, B.item, CUSTOMER]);
await q("ALTER TABLE public.return_requests ENABLE TRIGGER USER");
assert.equal(money((await lineOf(B)).payable), 10, "one of two returned and refunded: half the commission");
assert.equal(money((await lineOf(B)).due_amount), -10);
await balanced("return");

// ---- a commission a payout covers cannot be deleted with its order
await q("ALTER TABLE public.orders DISABLE TRIGGER orders_guard_mutation");
await q("UPDATE public.orders SET paid_amount = 0, payment_status = 'Pending', zoho_salesorder_id = 'SO-C', zoho_order_status = 'void' WHERE id = $1", [C.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER orders_guard_mutation");
await refuses(() => admin(() => q("SELECT public.order_delete_all_check($1) AS r", ["TEST-C"]).then((rows) => { if (rows[0].r.blocker) throw new Error(rows[0].r.blocker); })), /partner payout covers/i, "paid-out order delete");
await refuses(() => q("DELETE FROM public.orders WHERE id = $1", [C.id]), /payout covers/, "the database itself refuses");

// ---- removing a payment
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
const newOrder = async (no, extra = {}) => {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 300, subtotal: 300, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: "Packed", branch_id: "BR-CLK", ...extra };
  const cols = Object.keys(row);
  return (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
};
const P = await newOrder("TEST-PAY", { paid_amount: 300, payment_status: "Paid" });
const voidOrder = await newOrder("TEST-VOID-PAID", { paid_amount: 100, payment_status: "Partially Paid", order_status: "Delivered", zoho_salesorder_id: "SO-1", zoho_order_status: "void" });
const refunded = await newOrder("TEST-REFUNDED", { order_status: "Cancelled", payment_status: "Refunded", zoho_salesorder_id: "SO-2", zoho_order_status: "void" });
const sent = await newOrder("TEST-INV-SENT", { order_status: "Cancelled", zoho_salesorder_id: "SO-3", zoho_order_status: "void" });
const lapsed = await newOrder("TEST-UTR-REFUND", { order_status: "Payment Expired" });
const alive = await newOrder("TEST-ALIVE", { order_status: "Cancelled", zoho_salesorder_id: "SO-4", zoho_order_status: "confirmed" });
const open = await newOrder("TEST-OPEN");
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
const addPayment = async (order, amount, ref, status = "Paid", extra = {}) => {
  const cols = { order_id: order, user_id: CUSTOMER, kind: "advance", amount, method: "NEFT", status, txn_ref: ref, ...extra };
  return (await q(`INSERT INTO public.payments (${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(cols)))[0].id;
};
const p1 = await addPayment(P, 100, "FIRST1111111");
const p2 = await addPayment(P, 200, "SECOND222222");
const orderRow = async (no) => (await q("SELECT * FROM public.orders WHERE order_no = $1", [no]))[0];
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_delete_payment($1,'mistake here')", [p1])), /Only administrators/, "customer removes a payment");
await refuses(() => admin(() => q("SELECT public.admin_delete_payment($1,'no')", [p1])), /Say why/, "reason required");
await admin(() => q("SELECT public.admin_delete_payment($1,'typed the wrong amount')", [p1]));
let po = await orderRow("TEST-PAY");
assert.equal(money(po.paid_amount), 200); assert.equal(money(po.balance_due), 100); assert.equal(po.payment_status, "Partially Paid");
const removed = (await q("SELECT * FROM public.deleted_payments_log WHERE order_no = 'TEST-PAY'"))[0];
assert.equal(removed.reason, "typed the wrong amount"); assert.equal(removed.payment.txn_ref, "FIRST1111111"); assert.equal(money(removed.order_paid_after), 200);
await admin(() => q("SELECT public.admin_delete_payment($1,'typed the wrong one')", [p2]));
po = await orderRow("TEST-PAY");
assert.equal(money(po.paid_amount), 0); assert.equal(po.payment_status, "Pending");
await refuses(() => q("DELETE FROM public.deleted_payments_log"), /never deleted/, "the log stays");
// A payment in Zoho goes through the server, which takes it out of Zoho first.
const inZoho = await addPayment(open, 50, "ZOHO12345678", "Paid", { zoho_payment_id: "ZP1", zoho_invoice_id: "ZI1" });
await refuses(() => admin(() => q("SELECT public.admin_delete_payment($1,'wrong one here')", [inZoho])), /in Zoho Books/, "zoho-linked");
// A delivered order's payment comes off and its commission falls back.
const delivered = C;
await q("ALTER TABLE public.orders DISABLE TRIGGER orders_guard_mutation");
await q("UPDATE public.orders SET payment_status = 'Paid', paid_amount = 100 WHERE id = $1", [delivered.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER orders_guard_mutation");
const cPay = await addPayment(delivered.id, 100, "CCCC11112222");
await admin(() => q("SELECT public.admin_delete_payment($1,'never received it')", [cPay]));
assert.equal((await lineOf(C)).status, "pending", "an unpaid order stops earning");
assert.equal(money((await lineOf(C)).due_amount), -30, "and what was paid out comes back off the next payout");
await balanced("payment removed");

// ---- delete all details
const check = async (no) => (await admin(() => q("SELECT public.order_delete_all_check($1) AS r", [no])))[0].r;
await addPayment(voidOrder, 100, "2535");
assert.match((await check("TEST-VOID-PAID")).blocker, /Remove its payments first/);
await admin(() => q("SELECT public.admin_delete_payment(id,'made up number') FROM public.payments WHERE order_id = $1", [voidOrder]));
assert.equal((await check("TEST-VOID-PAID")).blocker, null, "void in Zoho and unpaid may go, even after delivery");
await addPayment(refunded, 50, "REFUNDED1234", "Refunded");
const rCheck = await check("TEST-REFUNDED");
assert.equal(rCheck.blocker, null); assert.ok(rCheck.notes.some((note) => /refunded payment/.test(note)));
await q("INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, invoice_number, status) VALUES ($1,'TEST-INV-SENT','Z9','CLKINV99','sent')", [sent]);
const sCheck = await check("TEST-INV-SENT");
assert.equal(sCheck.blocker, null); assert.ok(sCheck.notes.some((note) => /CLKINV99 stays in Zoho/.test(note)));
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_by) VALUES ($1,'TEST-UTR-REFUND',$2,'REFUNDUTR123',10,'rejected','refunded by our team',$3)", [lapsed, CUSTOMER, ADMIN]);
assert.equal((await check("TEST-UTR-REFUND")).blocker, null);
assert.match((await check("TEST-ALIVE")).blocker, /alive in Zoho/);
assert.match((await check("TEST-OPEN")).blocker, /Only a cancelled or expired/);
await refuses(() => admin(() => q("SELECT public.admin_delete_order_all_details('TEST-REFUNDED','no')")), /Say why/, "reason");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_delete_order_all_details('TEST-REFUNDED','my reason')")), /Only administrators/, "customer");
await refuses(() => admin(() => q("SELECT public.admin_delete_order_all_details('TEST-ALIVE','my reason')")), /alive in Zoho/, "alive");
await admin(() => q("SELECT public.admin_delete_order_all_details('TEST-REFUNDED','owner said delete it')"));
assert.equal(await orderRow("TEST-REFUNDED"), undefined);
const copy = (await q("SELECT * FROM public.deleted_orders_log WHERE order_no = 'TEST-REFUNDED'"))[0];
assert.equal(copy.reason, "owner said delete it"); assert.equal(copy.snapshot.payments[0].txn_ref, "REFUNDED1234", "a full copy stays"); assert.equal(copy.snapshot.order.order_no, "TEST-REFUNDED");
await refuses(() => q("INSERT INTO public.orders (order_no, user_id, customer_name, total, subtotal, order_status, branch_id) VALUES ('TEST-REFUNDED',$1,'X',1,1,'Placed','BR-CLK')", [CUSTOMER]), /used before|never|deleted|reuse|payment/i, "the number is never used again");

// ---- paying by another mode is recorded as that mode
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
const mixed = await newOrder("TEST-MIXED");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-MIXED',100,'NEFTREF000001','NEFT')"));
await admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-MIXED',50,'UPIREF000002')"));
const modes = await q("SELECT method FROM public.payments WHERE order_id = $1 ORDER BY amount DESC", [mixed]);
assert.deepEqual(modes.map((row) => row.method), ["NEFT", "UPI"], "the chosen mode, else the order's");
await refuses(() => admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-MIXED',10,'XREF00000003','Barter')")), /Choose how/, "unknown mode");

// ---- a coupon takes the GST down with the item amounts
await q(`UPDATE public.settings SET value = jsonb_set(COALESCE(value,'{}'::jsonb),'{branch_routing}','false') WHERE key = 'platform_features'`);
await q("INSERT INTO public.coupons (code, discount_type, discount_value, minimum_order, maximum_discount, starts_on, ends_on, usage_limit, used_count, active) VALUES ('TEN','Percentage',10,0,100000,'2026-01-01','2030-01-01',100,0,true)");
const rupeesInside = (gross, rate) => Math.round((gross * rate / (100 + rate) + Number.EPSILON) * 100) / 100;
assert.equal(rupeesInside(117, 5), 5.57);
const line = await q("SELECT i.id, round(i.qty*i.unit_price,2) gross, i.gst_rate FROM public.order_items i JOIN public.orders o ON o.id=i.order_id WHERE o.order_no='TEST-B' LIMIT 1");
assert.ok(line.length === 1);
// The coupon arithmetic itself, run against rows shaped as the checkout leaves them.
await db.exec(`
  CREATE OR REPLACE FUNCTION public.place_marketplace_order(_order_no text, _target_user_id uuid, _customer_name text, _customer_email text, _customer_phone text, _customer_gstin text, _shipping_address jsonb, _shipping_method text, _payment_method text, _items jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
  DECLARE oid uuid;
  BEGIN
    PERFORM set_config('app.pay_first', 'on', true);
    INSERT INTO public.orders (order_no, user_id, customer_name, subtotal, gst_amount, total, branch_id, order_status, prices_include_gst)
      VALUES (_order_no, _target_user_id, 'T', 214.29, 10.71, 225, 'BR-CLK', 'Placed', true) RETURNING id INTO oid;
    INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, gst_rate, line_total, vendor_id) VALUES
      (oid, 'P1', 'A', 1, 130, 5, 123.81, 'V1'), (oid, 'P1', 'B', 1, 95, 5, 90.48, 'V1');
    RETURN jsonb_build_object('order_no', _order_no, 'subtotal', 214.29, 'gst_amount', 10.71, 'total', 225, 'goods_total', 225, 'prices_include_gst', true);
  END $f$;
`);
await q("ALTER TABLE public.order_items DISABLE TRIGGER order_items_enforce_product_purchase_limit").catch(() => undefined);
await as(CUSTOMER, "authenticated", () => q("SELECT public.place_marketplace_order_with_coupon('TEST-COUPON',$1,'T','t@t','9','',NULL,'Pickup','UPI','[]'::jsonb,'TEN')", [CUSTOMER]));
const couponed = await orderRow("TEST-COUPON");
assert.equal(money(couponed.discount), 22.5); assert.equal(money(couponed.total), 202.5);
const shares = await q("SELECT i.product_name, i.coupon_share, i.unit_price FROM public.order_items i WHERE i.order_id = $1 ORDER BY i.unit_price DESC", [couponed.id]);
assert.equal(money(shares[0].coupon_share), 13, "10% of the ₹130 item"); assert.equal(money(shares[1].coupon_share), 9.5, "10% of the ₹95 item");
assert.equal(money(shares[0].coupon_share) + money(shares[1].coupon_share), 22.5, "the shares add up to the coupon");
const expectedGst = rupeesInside(130 - 13, 5) + rupeesInside(95 - 9.5, 5);
assert.equal(money(couponed.gst_amount), Math.round(expectedGst * 100) / 100, "GST is worked out on what is left");
assert.ok(money(couponed.gst_amount) < 10.71, "and is lower than before the coupon");
assert.equal(money(couponed.discount_taxable), Math.round((22.5 - (10.71 - money(couponed.gst_amount))) * 100) / 100);

// ---- storage bucket for signatures is private
const bucket = (await q("SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'godown-signatures'"))[0];
assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 1048576); assert.deepEqual(bucket.allowed_mime_types, ["image/png"]);

console.log("partner payouts OK");
