// Real-Postgres check of 20261112090000_late_and_partner_utrs.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/late-and-partner-utrs.db-test.mjs
//
// It must end with "late and partner UTRs OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261112090000_late_and_partner_utrs.sql";

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
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), STRANGER = uid("c2"), P_CLK = uid("b1"), P_HBL = uid("b2");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${STRANGER}','s@test.local'),('${P_CLK}','p1@test.local'),('${P_HBL}','p2@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${STRANGER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer'),('${STRANGER}','customer')`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true),('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${P_CLK}','BR-CLK','Partner CLK','p1@test.local','9000000031'),('${P_HBL}','BR-HBL','Partner HBL','p2@test.local','9000000032')`);
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Sugar','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Sugar", stock: 50, sold: 10 })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Sugar',100,40,'bag',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
const batchId = (await q("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'"))[0].id;

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}, qty = 2) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST Customer", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", vendor_ids: ["V1"], ...extra };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Sugar',$2,50,100,'V1') RETURNING id", [id, qty]))[0].id;
  // An ended checkout gave its stock back: its allocation is fully released.
  if (status === "Payment Expired") await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,$3,$3,100)", [item, batchId, qty]);
  return { id, item, no };
}
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const soon = new Date(Date.now() + 600_000).toISOString();
const EXP = await order("TEST-EXP", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(1) });
const EXP2 = await order("TEST-EXP-OFFLINE", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(2) });
const OLD = await order("TEST-EXP-OLD", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(20) });
const REFUNDED = await order("TEST-EXP-REFUNDED", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(1) });
const NOSTOCK = await order("TEST-EXP-NOSTOCK", "Payment Expired", { payment_hold_outcome: "expired", updated_at: ago(1) }, 1000);
const WAIT = await order("TEST-WAIT", "Awaiting Payment", { payment_hold_until: soon });
const WAIT_HBL = await order("TEST-WAIT-HBL", "Awaiting Payment", { payment_hold_until: soon, branch_id: "BR-HBL" });
const PAID = await order("TEST-PAID", "Payment Confirmed", { paid_amount: 100, payment_status: "Paid" });
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_by) VALUES ($1,$2,$3,'111122223333',100,'rejected','refunded by our team',$4)", [REFUNDED.id, REFUNDED.no, CUSTOMER, ADMIN]);
await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'full',100,'UPI','Paid','999988887777')", [PAID.id, CUSTOMER]);

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
const send = (user, no, utr, method = null) => as(user, "authenticated", () => q("SELECT public.submit_utr_for_order($1,$2,$3) AS r", [no, utr, method]).then((rows) => rows[0].r));
const sub = async (o) => (await q("SELECT * FROM public.upi_payment_submissions WHERE order_id = $1", [o.id]))[0];
const status = async (o) => (await q("SELECT order_status, payment_status, paid_amount FROM public.orders WHERE id = $1", [o.id]))[0];

// ---- the customer paid after the time ran out: the UTR waits for the admin, the checkout stays ended
let r = await send(CUSTOMER, EXP.no, "6123 4567 8901");
assert.equal(r.late, true); assert.equal(r.status, "submitted");
let row = await sub(EXP);
assert.equal(row.status, "submitted"); assert.equal(row.utr, "612345678901"); assert.equal(row.late, true); assert.equal(row.sent_by_role, "customer");
assert.equal(row.note, "paid after the checkout ended");
assert.equal((await status(EXP)).order_status, "Payment Expired", "sending a UTR confirms nothing");
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications WHERE order_no = $1 AND recipient_role = 'admin' AND title = 'Late payment to check'", [EXP.no]))[0].n, 1);
r = await send(CUSTOMER, EXP.no, "612345678901");
assert.equal(r.utr, "612345678901", "the same UTR again changes nothing");
await refuses(() => send(CUSTOMER, EXP.no, "612345678902"), /already checking UTR 612345678901/, "a second UTR");
await refuses(() => send(CUSTOMER, OLD.no, "612345678903"), /more than 15 days ago/, "too late");
await refuses(() => send(CUSTOMER, REFUNDED.no, "612345678904"), /was refunded/, "refunded checkout");
await refuses(() => send(CUSTOMER, EXP.no.replace("EXP", "NONE"), "612345678905"), /Order not found/, "no order");
await refuses(() => send(STRANGER, EXP2.no, "612345678906"), /not your order/, "someone else's order");
await refuses(() => send(CUSTOMER, PAID.no, "612345678907"), /not waiting for a payment/, "a paid order");
await refuses(() => send(CUSTOMER, EXP2.no, "999988887777"), /already used for another payment/, "a UTR that paid another order");
await refuses(() => send(CUSTOMER, EXP2.no, "12345", "NEFT"), /UTR from the bank: 12 to 22/, "NEFT format");
await refuses(() => send(CUSTOMER, EXP2.no, "612345678908", "CASH"), /Choose how it was paid/, "method");

// ---- the godown's channel partner sends a UTR for their own godown only; the customer is told
r = await send(P_CLK, WAIT.no, "712345678901");
assert.equal(r.sent_by_role, "partner"); assert.equal(r.late, false);
row = await sub(WAIT);
assert.equal(row.sent_by_role, "partner"); assert.equal(row.sent_by, P_CLK);
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications WHERE order_no = $1 AND recipient_role = 'customer' AND title = 'Payment being checked'", [WAIT.no]))[0].n, 1);
assert.match((await q("SELECT message FROM public.notifications WHERE order_no = $1 AND recipient_role = 'admin' ORDER BY id DESC LIMIT 1", [WAIT.no]))[0].message, /sent by channel partner Partner CLK/);
await refuses(() => send(P_CLK, WAIT_HBL.no, "712345678902"), /not your order/, "another godown");
const seen = await as(P_CLK, "authenticated", () => q("SELECT order_no, status, utr_status, utr_sent_by FROM public.partner_payment_checkouts()"));
assert.deepEqual(seen.map((x) => x.order_no).sort(), [EXP.no, EXP2.no, NOSTOCK.no, WAIT.no].sort(), "own godown, waiting or ended within 15 days, not refunded");
assert.equal(seen.find((x) => x.order_no === WAIT.no).utr_sent_by, "partner");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT * FROM public.partner_payment_checkouts()")), /Only an active channel partner/, "customer");
await refuses(() => as(null, "anon", () => q("SELECT * FROM public.partner_payment_checkouts()")), /permission denied|Only an active/, "anon");

// ---- only the admin places an ended checkout, after finding the money; stock is taken again at its godown
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1)", [EXP.no])), /Only administrators/, "customer");
await refuses(() => as(P_CLK, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1)", [EXP.no])), /Only administrators/, "partner");
const stock = async () => ({
  shelf: Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s),
  batch: Number((await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity),
});
let before = await stock();
r = await as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1, NULL, NULL, 'Checked against bank statement') AS r", [EXP.no]).then((rows) => rows[0].r));
assert.equal(r.utr, "612345678901", "the UTR the customer sent");
let st = await status(EXP);
assert.equal(st.order_status, "Payment Confirmed"); assert.equal(st.payment_status, "Paid"); assert.equal(Number(st.paid_amount), 100);
assert.deepEqual((await q("SELECT status, txn_ref, method FROM public.payments WHERE order_id = $1", [EXP.id])), [{ status: "Paid", txn_ref: "612345678901", method: "UPI" }]);
row = await sub(EXP);
assert.equal(row.status, "confirmed"); assert.equal(row.note, "Paid after the checkout ended; placed again. Checked against bank statement");
let after = await stock();
assert.equal(after.shelf, before.shelf - 2, "its 2 bags are taken again"); assert.equal(after.batch, before.batch - 2);
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_item_batch_allocations WHERE order_item_id = $1 AND released_quantity < reserved_quantity", [EXP.item]))[0].n, 1);
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications WHERE order_no = $1 AND recipient_role = 'customer' AND title = 'Order placed'", [EXP.no]))[0].n, 1);
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1)", [EXP.no])), /Only a checkout that ended/, "twice");

// Paid offline with nothing sent: the admin enters what the bank shows.
r = await as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1, 'HDFCN52026111212345', 'NEFT', 'Checked against bank app') AS r", [EXP2.no]).then((rows) => rows[0].r));
assert.equal((await status(EXP2)).order_status, "Payment Confirmed");
assert.equal((await q("SELECT txn_ref, method FROM public.payments WHERE order_id = $1", [EXP2.id]))[0].method, "NEFT");
assert.equal((await q("SELECT payment_method FROM public.orders WHERE id = $1", [EXP2.id]))[0].payment_method, "NEFT", "a UPI checkout paid by NEFT says NEFT");
after = await stock();
assert.equal(after.shelf, before.shelf - 4, "and 2 more for the offline one");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1, NULL)", [REFUNDED.no])), /was refunded/, "refunded");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1, 'HDFCN52026111299999')", [NOSTOCK.no])), /Only 46 left of TEST Sugar/, "not enough stock");
assert.equal((await status(NOSTOCK)).order_status, "Payment Expired", "a refusal changes nothing");
assert.deepEqual(await stock(), { shelf: after.shelf, batch: after.batch }, "and takes no stock");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_place_ended_checkout($1, '999988887777')", [OLD.no])), /already been recorded on order TEST-PAID|already used|recorded on order/, "a UTR that paid another order");

// ---- nothing else can reopen an ended checkout
await refuses(async () => {
  await db.query("UPDATE auth.cur SET uid = $1", [ADMIN]);
  try { await q("UPDATE public.orders SET order_status = 'Awaiting Payment' WHERE id = $1", [NOSTOCK.id]); } finally { await db.query("UPDATE auth.cur SET uid = NULL"); }
}, /cannot be reopened/, "the guard");

console.log("late and partner UTRs OK");
