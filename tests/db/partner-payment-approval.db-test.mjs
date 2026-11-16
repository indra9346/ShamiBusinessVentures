// Real-Postgres check of 20261116100000_partner_payment_approval.sql (channel partners approve their own godown's customer
// payments, owner 16 Nov 2026), on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/partner-payment-approval.db-test.mjs
//
// It must end with "partner payment approval OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261116100000_partner_payment_approval.sql";

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
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), P_CLK = uid("b1"), P_HBL = uid("b2"), P_OLD = uid("b3");
const people = [ADMIN, CUSTOMER, P_CLK, P_HBL, P_OLD];
await q(`INSERT INTO auth.users (id, email) SELECT u, u::text || '@test.local' FROM unnest($1::uuid[]) u ON CONFLICT DO NOTHING`, [people]);
await q(`DELETE FROM public.user_roles WHERE user_id = ANY ($1::uuid[])`, [people]);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true),('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = EXCLUDED.name");
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, status) VALUES
  ('${P_OLD}','BR-CLK','Partner Old','p3@test.local','9000000033','suspended')`);
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES
  ('${P_CLK}','BR-CLK','Partner CLK','p1@test.local','9000000031'),('${P_HBL}','BR-HBL','Partner HBL','p2@test.local','9000000032')`);
const partnerId = async (user) => (await q("SELECT id FROM public.channel_partners WHERE user_id = $1", [user]))[0].id;
const CLK_ID = await partnerId(P_CLK), HBL_ID = await partnerId(P_HBL), OLD_ID = await partnerId(P_OLD);
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Sugar','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Sugar", stock: 50, sold: 10 })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Sugar',100,40,'bag',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
const batchId = (await q("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'"))[0].id;
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}, qty = 2) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST Customer", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", vendor_ids: ["V1"], ...extra };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Sugar',$2,50,100,'V1') RETURNING id", [id, qty]))[0].id;
  if (status === "Payment Expired") await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,$3,$3,100)", [item, batchId, qty]);
  return { id, item, no };
}
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const soon = new Date(Date.now() + 600_000).toISOString();
const WAIT = await order("TEST-PA-WAIT", "Awaiting Payment", { payment_hold_until: soon });
const BYPARTNER = await order("TEST-PA-PARTNER", "Awaiting Payment", { payment_hold_until: soon });
const HBL = await order("TEST-PA-HBL", "Awaiting Payment", { payment_hold_until: soon, branch_id: "BR-HBL" });
const ALERT = await order("TEST-PA-ALERT", "Awaiting Payment", { payment_hold_until: soon });
const OFF = await order("TEST-PA-OFF", "Awaiting Payment", { payment_hold_until: soon });
const FLAG = await order("TEST-PA-FLAG", "Awaiting Payment", { payment_hold_until: soon });
const ADMINS = await order("TEST-PA-ADMIN", "Awaiting Payment", { payment_hold_until: soon });
const EXP = await order("TEST-PA-EXP", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(1) });
const OLD = await order("TEST-PA-OLD", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(20) });
const NOSTOCK = await order("TEST-PA-NOSTOCK", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(1) }, 1000);
const DUP = await order("TEST-PA-DUP", "Awaiting Payment", { payment_hold_until: soon });
const OWN = await order("TEST-PA-OWN", "Awaiting Payment", { payment_hold_until: soon, user_id: P_CLK });
const CHANGED = await order("TEST-PA-CHANGED", "Awaiting Payment", { payment_hold_until: soon });
const TX = await order("TEST-PA-TX", "Awaiting Payment", { payment_hold_until: soon });
const PAID = await order("TEST-PA-PAID", "Payment Confirmed", { paid_amount: 100, payment_status: "Paid" });
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'full',100,'UPI','Paid','899988887777')", [PAID.id, CUSTOMER]);

async function as(user, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
const send = (user, no, utr) => as(user, "authenticated", () => q("SELECT public.submit_utr_for_order($1,$2) AS r", [no, utr]).then((rows) => rows[0].r));
const approve = (user, no, utr, checked = "bank_sms") => as(user, "authenticated", () => q("SELECT public.partner_approve_payment($1,$2,$3) AS r", [no, utr, checked]).then((rows) => rows[0].r));
const sub = async (o) => (await q("SELECT * FROM public.upi_payment_submissions WHERE order_id = $1", [o.id]))[0];
const status = async (o) => (await q("SELECT order_status, payment_status, paid_amount, payment_hold_until FROM public.orders WHERE id = $1", [o.id]))[0];
const notices = async (o, title) => (await q("SELECT recipient_role, message FROM public.notifications WHERE order_no = $1 AND title = $2", [o.no, title]));

// ---- on by default: the partner's list says which UTRs they may approve, with the amount and time
assert.equal((await q("SELECT value->>'enabled' AS e FROM public.settings WHERE key = 'partner_payment_approval'"))[0].e, "true");
await send(CUSTOMER, WAIT.no, "7123 4567 8901");
let list = await as(P_CLK, "authenticated", () => q("SELECT order_no, utr, utr_status, utr_amount, utr_sent_at, paid_amount, can_approve FROM public.partner_payment_checkouts()"));
let line = list.find((x) => x.order_no === WAIT.no);
assert.equal(line.utr, "712345678901"); assert.equal(line.can_approve, true); assert.equal(Number(line.utr_amount), 100); assert.ok(line.utr_sent_at);
assert.equal(Number(line.paid_amount), 0);
assert.equal(list.find((x) => x.order_no === BYPARTNER.no).can_approve, false, "no UTR yet");
assert.ok(!list.some((x) => x.order_no === HBL.no), "only their own godown");

// ---- the partner approves the customer's UTR: the same records as an admin's Confirm, plus who did it
await refuses(() => approve(P_CLK, WAIT.no, "712345678901", ""), /Choose where you saw this payment/, "no check named");
await refuses(() => approve(P_CLK, WAIT.no, "712345678901", "whatsapp"), /Choose where you saw this payment/, "unknown check");
await refuses(() => approve(P_CLK, WAIT.no, "712345678900"), /The UTR for this order is now 712345678901/, "a UTR the partner did not look at");
await refuses(() => approve(P_CLK, WAIT.no, null), /The UTR for this order is now 712345678901/, "no UTR named");
let r = await approve(P_CLK, WAIT.no, " 712345678901 ");
assert.deepEqual([r.order_no, r.utr, Number(r.amount), r.status, r.payment_status], [WAIT.no, "712345678901", 100, "Payment Confirmed", "Paid"]);
let st = await status(WAIT);
assert.equal(st.order_status, "Payment Confirmed"); assert.equal(st.payment_status, "Paid"); assert.equal(Number(st.paid_amount), 100);
assert.equal(st.payment_hold_until, null, "the hold is over");
const payment = (await q("SELECT status, txn_ref, method, amount FROM public.payments WHERE order_id = $1", [WAIT.id]));
assert.equal(payment.length, 1); assert.equal(payment[0].status, "Paid"); assert.equal(payment[0].txn_ref, "712345678901"); assert.equal(Number(payment[0].amount), 100);
let row = await sub(WAIT);
assert.equal(row.status, "confirmed"); assert.equal(row.reviewed_by, P_CLK);
assert.equal(row.note, "Approved by channel partner Partner CLK (Challakere Godown) after checking the bank's SMS or alert");
const tracking = await q("SELECT status, note, actor_role, partner_id FROM public.order_tracking WHERE order_id = $1", [WAIT.id]);
assert.equal(tracking.length, 1); assert.equal(tracking[0].actor_role, "partner"); assert.equal(tracking[0].partner_id, CLK_ID);
assert.equal(tracking[0].status, "Payment Confirmed");
assert.match(tracking[0].note, /^Payment approved by channel partner Partner CLK at Challakere Godown: UTR 712345678901, Rs 100\.00, after checking the bank's SMS or alert\.$/);
let told = await notices(WAIT, "Payment approved by channel partner");
assert.equal(told.length, 1); assert.equal(told[0].recipient_role, "admin");
assert.match(told[0].message, /^Partner CLK \(channel partner, Challakere Godown\) approved UTR 712345678901 for ₹100\.00 on order TEST-PA-WAIT after checking the bank's SMS or alert\. Check it in the bank account\.$/);
// The flags do not outlive the step.
await refuses(() => approve(P_CLK, WAIT.no, "712345678901"), /No UTR is waiting for a check/, "twice");
assert.ok(!(await as(P_CLK, "authenticated", () => q("SELECT order_no FROM public.partner_payment_checkouts()"))).some((x) => x.order_no === WAIT.no), "a paid order leaves the list");

// ---- a UTR the partner sent, or the partner's own order, waits for our office: a second person checks it (review, 16 Nov)
await send(P_CLK, BYPARTNER.no, "722345678901");
await refuses(() => approve(P_CLK, BYPARTNER.no, "722345678901"), /You sent this UTR yourself, so our office checks it/, "the partner's own UTR");
assert.equal((await as(P_CLK, "authenticated", () => q("SELECT order_no, can_approve FROM public.partner_payment_checkouts()"))).find((x) => x.order_no === BYPARTNER.no).can_approve, false);
assert.equal((await status(BYPARTNER)).order_status, "Awaiting Payment");
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, sent_by_role) VALUES ($1,$2,$3,'812345678901',100,'submitted','customer')", [OWN.id, OWN.no, P_CLK]);
await refuses(() => approve(P_CLK, OWN.no, "812345678901"), /This is your own order, so our office checks its payment/, "the partner's own order");
assert.equal((await as(P_CLK, "authenticated", () => q("SELECT order_no, can_approve FROM public.partner_payment_checkouts()"))).find((x) => x.order_no === OWN.no).can_approve, false);
const office = await as(ADMIN, "authenticated", () => q("SELECT (public.review_upi_utr($1,'confirmed','Checked against bank SMS','722345678901')).status AS s", [BYPARTNER.no]));
assert.equal(office[0].s, "confirmed", "our office approves the partner's UTR");
// Another godown's partner, a customer, a suspended partner and anon cannot approve.
await send(CUSTOMER, HBL.no, "732345678901");
await refuses(() => approve(P_CLK, HBL.no, "732345678901"), /not an order of your godown/, "CLK partner, HBL order");
await refuses(() => approve(CUSTOMER, HBL.no, "732345678901"), /Only an active channel partner/, "the customer");
await refuses(() => approve(P_OLD, HBL.no, "732345678901"), /Only an active channel partner/, "a suspended partner");
await refuses(() => as(null, "anon", () => q("SELECT public.partner_approve_payment($1,$2,'bank_sms')", [HBL.no, "732345678901"])), /permission denied/, "anon");
r = await approve(P_HBL, HBL.no, "732345678901", "upi_app");
assert.equal(r.status, "Payment Confirmed", "Hubli's partner approves Hubli's order");
assert.match((await sub(HBL)).note, /after checking the business UPI app's received payments$/);

// ---- the order's total changed after the UTR came: no Approve, and the database refuses it
await send(CUSTOMER, CHANGED.no, "822345678901");
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET total = 120 WHERE id = $1", [CHANGED.id]);
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
assert.equal((await as(P_CLK, "authenticated", () => q("SELECT order_no, can_approve FROM public.partner_payment_checkouts()"))).find((x) => x.order_no === CHANGED.no).can_approve, false);
await refuses(() => approve(P_CLK, CHANGED.no, "822345678901"), /An unpaid order is placed only when its full amount is paid/, "a changed total");

// ---- the step leaves no flag behind, inside its own transaction
await send(CUSTOMER, TX.no, "832345678901");
await db.query("UPDATE auth.cur SET uid = $1", [P_CLK]);
await db.exec("BEGIN; SET LOCAL ROLE authenticated");
try {
  await db.query("SELECT public.partner_approve_payment($1,'832345678901','bank_sms')", [TX.no]);
  const flags = (await db.query("SELECT COALESCE(current_setting('app.partner_payment', true), '') AS p, COALESCE(current_setting('app.payment_workflow', true), '') AS w")).rows[0];
  assert.equal(flags.p, "", "the partner flag is cleared");
  assert.notEqual(flags.w, "on", "the payment flag is put back");
  // Within the same transaction the partner still cannot reach the office's functions.
  let message = "";
  try { await db.query("SAVEPOINT x"); await db.query("SELECT public.review_upi_utr($1,'rejected','x',NULL)", [WAIT.no]); } catch (error) { message = error.message; await db.query("ROLLBACK TO SAVEPOINT x"); }
  assert.match(message, /Only administrators can confirm UPI payments/);
} finally { await db.exec("ROLLBACK"); await db.query("UPDATE auth.cur SET uid = NULL"); }
assert.equal((await status(TX)).order_status, "Awaiting Payment", "rolled back");

// ---- the office's checks still apply: a bank alert showing less money refuses it, and nothing changes
await send(CUSTOMER, ALERT.no, "742345678901");
await q("INSERT INTO public.bank_credits (received_at, amount, utr, status, raw) VALUES (now(), 90, '742345678901', 'unmatched', 'TEST alert')");
await refuses(() => approve(P_CLK, ALERT.no, "742345678901"), /^The bank shows a different amount for UTR 742345678901\. Leave this payment for our office\.$/, "bank alert amount, in the partner's words");
assert.equal((await status(ALERT)).order_status, "Awaiting Payment", "a refusal changes nothing");
assert.equal((await sub(ALERT)).status, "submitted");
assert.equal((await notices(ALERT, "Payment approved by channel partner")).length, 0, "and tells nobody");
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_tracking WHERE order_id = $1", [ALERT.id]))[0].n, 0);

// ---- a partner can never reach the office's functions directly, nor reject, nor act for another partner
await send(CUSTOMER, FLAG.no, "752345678901");
await refuses(() => as(P_CLK, "authenticated", () => q("SELECT public.review_upi_utr($1,'confirmed',NULL,'752345678901')", [FLAG.no])), /Only administrators can confirm UPI payments/, "review directly");
await refuses(() => as(P_CLK, "authenticated", () => q("SELECT public.admin_confirm_manual_payment($1,100,'752345678901')", [FLAG.no])), /Only administrators may reconcile/, "manual payment directly");
await refuses(() => as(P_CLK, "authenticated", () => q("SELECT public.admin_set_partner_payment_approval(false)")), /Only administrators can change this/, "the switch");
// With the flag forged in one transaction: another partner's id lets nothing in; the partner's own id never rejects.
async function inTx(user, flagId, sql, params) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("BEGIN; SET LOCAL ROLE authenticated");
  try {
    await db.query("SELECT set_config('app.partner_payment', $1, true)", [flagId]);
    return (await db.query(sql, params)).rows;
  } finally { await db.exec("ROLLBACK"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
await refuses(() => inTx(P_CLK, HBL_ID, "SELECT public.review_upi_utr($1,'confirmed',NULL,'752345678901')", [FLAG.no]), /Only administrators can confirm UPI payments/, "another partner's id");
await refuses(() => inTx(P_CLK, OLD_ID, "SELECT public.review_upi_utr($1,'confirmed',NULL,'752345678901')", [FLAG.no]), /Only administrators can confirm UPI payments/, "a suspended partner's id");
await refuses(() => inTx(P_CLK, CLK_ID, "SELECT public.review_upi_utr($1,'rejected','fake',NULL)", [FLAG.no]), /Only our office can reject a UTR/, "a partner rejecting");
await refuses(() => inTx(P_HBL, HBL_ID, "SELECT public.review_upi_utr($1,'confirmed',NULL,'752345678901')", [FLAG.no]), /not an order of your godown/, "Hubli on a Challakere order");
await refuses(() => inTx(P_HBL, HBL_ID, "SELECT public.admin_confirm_manual_payment($1,100,'752345678901')", [FLAG.no]), /not an order of your godown/, "manual payment, other godown");
await refuses(() => inTx(CUSTOMER, CLK_ID, "SELECT public.review_upi_utr($1,'confirmed',NULL,'752345678901')", [FLAG.no]), /Only administrators can confirm UPI payments/, "a customer with the partner's id");
assert.equal((await status(FLAG)).order_status, "Awaiting Payment");

// ---- switched off by the office: no approvals, the list says so, the office's own Confirm is unchanged
await send(CUSTOMER, OFF.no, "762345678901");
let set = await as(ADMIN, "authenticated", () => q("SELECT public.admin_set_partner_payment_approval(false) AS v").then((rows) => rows[0].v));
assert.equal(set.enabled, false);
await refuses(() => approve(P_CLK, OFF.no, "762345678901"), /turned off payment approval by channel partners/, "switched off");
await refuses(() => inTx(P_CLK, CLK_ID, "SELECT public.review_upi_utr($1,'confirmed',NULL,'762345678901')", [OFF.no]), /Only administrators can confirm UPI payments/, "the flag while switched off");
list = await as(P_CLK, "authenticated", () => q("SELECT order_no, can_approve FROM public.partner_payment_checkouts()"));
assert.equal(list.find((x) => x.order_no === OFF.no).can_approve, false);
await send(CUSTOMER, ADMINS.no, "772345678901");
const confirmed = await as(ADMIN, "authenticated", () => q("SELECT (public.review_upi_utr($1,'confirmed','Checked against bank SMS','772345678901')).status AS s", [ADMINS.no]));
assert.equal(confirmed[0].s, "confirmed", "the office's Confirm");
assert.equal((await sub(ADMINS)).reviewed_by, ADMIN);
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_tracking WHERE order_id = $1", [ADMINS.id]))[0].n, 0, "no partner row for the office's Confirm");
const rejected = await as(ADMIN, "authenticated", () => q("SELECT (public.review_upi_utr($1,'rejected','No such money',NULL)).status AS s", [OFF.no]));
assert.equal(rejected[0].s, "rejected", "the office still rejects");
set = await as(ADMIN, "authenticated", () => q("SELECT public.admin_set_partner_payment_approval(true) AS v").then((rows) => rows[0].v));
assert.equal(set.enabled, true);
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_set_partner_payment_approval(NULL)")), /Choose on or off/, "no choice");

// ---- a UTR that paid another order never pays twice
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status) VALUES ($1,$2,$3,'899988887777',100,'submitted')", [DUP.id, DUP.no, CUSTOMER]);
await refuses(() => approve(P_CLK, DUP.no, "899988887777"), /already been recorded on order TEST-PA-PAID/, "a UTR that paid another order");
// The defence in depth: with the flag, the office's payment function pays only a waiting checkout in full with its UTR.
await refuses(() => inTx(P_CLK, CLK_ID, "SELECT public.admin_confirm_manual_payment($1,50,'899988887777')", [DUP.no]), /A channel partner approves only the full amount of a checkout, with the UTR sent for it|already been recorded/, "a part payment");
await refuses(() => inTx(P_CLK, CLK_ID, "SELECT public.admin_confirm_manual_payment($1,100,'512345678901')", [DUP.no]), /A channel partner approves only the full amount of a checkout, with the UTR sent for it/, "a UTR not sent on the order");
assert.equal((await status(DUP)).order_status, "Awaiting Payment");

// ---- a late UTR on a checkout that ended: the partner approves it within 15 days, stock is taken again
const stock = async () => ({
  shelf: Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s),
  batch: Number((await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity),
});
await send(CUSTOMER, EXP.no, "782345678901");
line = (await as(P_CLK, "authenticated", () => q("SELECT order_no, can_approve, utr_late FROM public.partner_payment_checkouts()"))).find((x) => x.order_no === EXP.no);
assert.equal(line.can_approve, true); assert.equal(line.utr_late, true);
let before = await stock();
r = await approve(P_CLK, EXP.no, "782345678901", "bank_statement");
assert.deepEqual([r.status, Number(r.amount)], ["Payment Confirmed", 100]);
st = await status(EXP);
assert.equal(st.order_status, "Payment Confirmed"); assert.equal(st.payment_status, "Paid");
let after = await stock();
assert.equal(after.shelf, before.shelf - 2, "its 2 bags are taken again"); assert.equal(after.batch, before.batch - 2);
row = await sub(EXP);
assert.equal(row.status, "confirmed"); assert.equal(row.reviewed_by, P_CLK);
assert.equal(row.note, "Paid after the checkout ended; placed again. Approved by channel partner Partner CLK (Challakere Godown) after checking the bank statement or passbook");
assert.equal((await notices(EXP, "Payment approved by channel partner")).length, 1);
assert.equal((await notices(EXP, "Order placed")).filter((n) => n.recipient_role === "customer").length, 1, "the customer hears it was placed");
// Too old, or not enough stock: refused, nothing changes.
await q("ALTER TABLE public.upi_payment_submissions DISABLE TRIGGER USER");
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, late, note) VALUES ($1,$2,$3,'792345678901',100,'submitted',true,'paid after the checkout ended')", [OLD.id, OLD.no, CUSTOMER]);
await q("ALTER TABLE public.upi_payment_submissions ENABLE TRIGGER USER");
await refuses(() => approve(P_CLK, OLD.no, "792345678901"), /more than 15 days ago/, "an old checkout");
await send(CUSTOMER, NOSTOCK.no, "802345678901");
before = await stock();
await refuses(() => approve(P_CLK, NOSTOCK.no, "802345678901"), /^Not enough stock is left at your godown to place this order again\. Leave it for our office\.$/, "not enough stock, in the partner's words");
assert.equal((await status(NOSTOCK)).order_status, "Payment Expired");
assert.deepEqual(await stock(), before, "and takes no stock");
await refuses(() => inTx(P_CLK, CLK_ID, "SELECT public.admin_place_ended_checkout($1, 'HDFCN52026111612345', 'NEFT', 'x')", [NOSTOCK.no]), /Approve only the UTR sent for this order/, "a typed UTR");
await refuses(() => as(P_CLK, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1)", [NOSTOCK.no])), /Only administrators can confirm payments/, "ended checkout directly");

// ---- an order not waiting for payment
await refuses(() => approve(P_CLK, PAID.no, "899988887777"), /No UTR is waiting for a check/, "a paid order");
await refuses(() => approve(P_CLK, "TEST-PA-NONE", "899988887777"), /not an order of your godown/, "no such order");

const grants = (await q(`SELECT has_function_privilege('anon', 'public.partner_approve_payment(text,text,text)', 'EXECUTE') AS a1,
  has_function_privilege('authenticated', 'public.partner_approve_payment(text,text,text)', 'EXECUTE') AS a2,
  has_function_privilege('anon', 'public.admin_set_partner_payment_approval(boolean)', 'EXECUTE') AS a3,
  has_function_privilege('anon', 'public.partner_payment_checkouts()', 'EXECUTE') AS a4`))[0];
assert.deepEqual(grants, { a1: false, a2: true, a3: false, a4: false });

console.log("partner payment approval OK");
