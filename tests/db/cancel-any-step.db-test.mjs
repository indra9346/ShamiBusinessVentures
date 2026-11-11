// Real-Postgres check of 20261111200000_cancel_refund_delete_any_step.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/cancel-any-step.db-test.mjs
//
// It must end with "cancel any step OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261111200000_cancel_refund_delete_any_step.sql";

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
// Everything before this migration first, so the live data it starts from (a UTR already marked refunded) is there.
for (const file of files.filter((name) => name < MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const ADMIN = "00000000-0000-4000-8000-0000000000a1", CUSTOMER = "00000000-0000-4000-8000-0000000000c1", PARTNER_USER = "00000000-0000-4000-8000-0000000000b1";
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${PARTNER_USER}','p@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q(`UPDATE public.profiles SET full_name = 'TEST Admin' WHERE id = '${ADMIN}'`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
const PARTNER = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${PARTNER_USER}','BR-CLK','Partner One','p@test.local','9000000001') RETURNING id`))[0].id;
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Sugar','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Sugar", stock: 50, sold: 10, unit: "bag" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Sugar',100,40,'bag',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
const batchId = (await q("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'"))[0].id;

// The live order of the owner's screenshot, as it is before this migration: an expired NEFT checkout whose UTR nobody
// checked in time and that an admin then marked refunded.
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}, fulfilment = status) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "NEFT", order_status: status, branch_id: "BR-CLK", vendor_ids: ["V1"], ...extra };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Sugar',2,50,100,'V1') RETURNING id", [id]))[0].id;
  if (!["Awaiting Payment", "Payment Expired"].includes(status)) {
    await q("INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status) VALUES ($1,'V1',$2)", [id, fulfilment]);
  }
  // Every order took its 2 bags from the batch when it was placed.
  if (status !== "Payment Expired") {
    await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,2,0,100)", [item, batchId]);
  }
  await q(`INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id, product_name, qty, line_total, kind, rate, amount, status, placed_at)
    VALUES ($1,$2,$3,$4,'BR-CLK','P1','TEST Sugar',2,100,'per_unit',1,2,public.partner_commission_status($5,$6),now())`, [item, id, no, PARTNER, status, row.payment_status]);
  return { id, item, no };
}
const paid = { paid_amount: 100, payment_status: "Paid" };
const O = {
  placed: await order("TEST-PLACED", "Placed"),
  packedPaid: await order("TEST-PACKED-PAID", "Packed", paid),
  deliveredUnpaid: await order("TEST-DELIVERED", "Delivered"),
  outPaid: await order("TEST-OFD-PAID", "Out for Delivery", paid),
  bankPaid: await order("TEST-BANK-PAID", "Payment Confirmed", paid),
  other: await order("TEST-OTHER", "Placed"),
  waiting: await order("TEST-WAITING", "Awaiting Payment", { payment_hold_until: new Date(Date.now() + 600000).toISOString() }),
  waitingOld: await order("TEST-WAITING-OLD", "Awaiting Payment", { payment_hold_until: new Date(Date.now() + 600000).toISOString() }),
  refundedCheckout: await order("CLK-TEST-031126-121319", "Payment Expired", { payment_hold_outcome: "expired" }),
  rejected: await order("TEST-REJECTED-UTR", "Payment Expired", { payment_hold_outcome: "expired" }),
  unchecked: await order("TEST-UNCHECKED-UTR", "Payment Expired", { payment_hold_outcome: "expired" }),
  confirmedUtr: await order("TEST-CONFIRMED-UTR", "Payment Confirmed", paid),
};
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
const payment = (o, ref, method = "NEFT", zoho = null) => q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref, zoho_payment_id) VALUES ($1,$2,'full',100,$3,'Paid',$4,$5) RETURNING id", [o.id, CUSTOMER, method, ref, zoho]);
await payment(O.packedPaid, "PACKEDUTR0000000001", "NEFT", "ZP-PACKED");
await payment(O.outPaid, "CASH", "Cash");
await payment(O.bankPaid, "111122223333", "UPI", "ZP-BANK");
await payment(O.confirmedUtr, "444455556666", "UPI");
await q("INSERT INTO public.bank_credits (amount, utr, status, order_id, order_no) VALUES (100,'111122223333','matched',$1,'TEST-BANK-PAID')", [O.bankPaid.id]);
const utr = (o, value, status, note = null) => q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status, note, reviewed_by, reviewed_at) VALUES ($1,$2,$3,$4,100,$5,$6,$7,$8)",
  [o.id, o.no, CUSTOMER, value, status, note, status === "submitted" ? null : ADMIN, status === "submitted" ? null : new Date().toISOString()]);
await utr(O.refundedCheckout, "VAMSHI12345678910", "rejected", "refunded by our team");
await utr(O.rejected, "REJECTED1234567890", "rejected", "this UTR is not in the bank statement");
await utr(O.unchecked, "UNCHECKED123456789", "rejected", "we could not check your UTR in time");
await utr(O.confirmedUtr, "444455556666", "confirmed");
await utr(O.waitingOld, "WAITING12345678901", "submitted");

await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
for (const file of files.filter((name) => name > MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

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
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const cancel = (no, reason, goodsBack = null, refund = null) => admin(() => q("SELECT public.admin_cancel_order($1,$2,$3,$4) AS r", [no, reason, goodsBack, refund === null ? null : JSON.stringify(refund)]).then((rows) => rows[0].r));
const orderRow = async (no) => (await q("SELECT * FROM public.orders WHERE order_no = $1", [no]))[0];
const stock = async () => ({
  shelf: Number((await q("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = 'P1'"))[0].s),
  batch: Number((await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity),
});
const allCheck = (no) => admin(() => q("SELECT public.order_delete_all_check($1) AS r", [no]).then((rows) => rows[0].r));
const deleteAll = (no) => admin(() => q("SELECT public.admin_delete_order_all_details($1,'TEST cleanup') AS r", [no]));
const commission = async (o) => (await q("SELECT status FROM public.partner_commissions WHERE order_id = $1", [o.id]))[0]?.status;

// ---- the refunded UTR that was already on live is on the never-again list from the start
assert.equal((await q("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE utr = 'VAMSHI12345678910'"))[0].n, 1, "backfilled");

// ---- only an admin, always with a reason
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_cancel_order('TEST-PLACED','changed my mind')")), /Only administrators/, "customer");
await refuses(() => cancel("TEST-PLACED", "  "), /Say why/, "no reason");
await refuses(() => cancel("TEST-WAITING", "TEST reason"), /End checkout/, "a checkout is ended, not cancelled");
await refuses(() => cancel("CLK-TEST-031126-121319", "TEST reason"), /already ended/, "an expired checkout");

// ---- not paid, not sent: as before, stock and batch back
let before = await stock();
const outboxBefore = (await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [O.placed.id]))[0].n;
let r = await cancel("TEST-PLACED", "TEST customer phoned to cancel");
assert.equal(r.stock_back, true); assert.equal(Number(r.refunded), 0);
assert.equal((await orderRow("TEST-PLACED")).order_status, "Cancelled");
let after = await stock();
assert.equal(after.shelf, before.shelf + 2); assert.equal(after.batch, before.batch + 2);
assert.equal(await commission(O.placed), "cancelled");
assert.ok((await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [O.placed.id]))[0].n > outboxBefore, "Zoho is told, so its sales order is voided");
const c1 = (await q("SELECT * FROM public.order_cancellations WHERE order_no = 'TEST-PLACED'"))[0];
assert.equal(c1.stage, "Placed"); assert.equal(c1.goods_back, null); assert.equal(c1.reason, "TEST customer phoned to cancel"); assert.equal(c1.cancelled_by_name, "TEST Admin");
await refuses(() => cancel("TEST-PLACED", "TEST again"), /already cancelled/, "twice");

// ---- paid, before dispatch: refund first
await refuses(() => cancel("TEST-PACKED-PAID", "TEST wrong item"), /Rs 100\.00 was paid/, "no refund given");
await refuses(() => cancel("TEST-PACKED-PAID", "TEST wrong item", null, { mode: "Card", reference: "X1234", refunded_on: today }), /Choose how/, "mode");
await refuses(() => cancel("TEST-PACKED-PAID", "TEST wrong item", null, { mode: "NEFT", reference: "", refunded_on: today }), /UTR or reference/, "reference");
await refuses(() => cancel("TEST-PACKED-PAID", "TEST wrong item", null, { mode: "NEFT", reference: "REF1", refunded_on: "2099-01-01" }), /future/, "future");
await refuses(() => cancel("TEST-PACKED-PAID", "TEST wrong item", null, { mode: "NEFT", reference: "REF1", refunded_on: "2020-01-01" }), /before the order/, "too early");
await refuses(() => cancel("TEST-OTHER", "TEST", null, { mode: "NEFT", reference: "REF1", refunded_on: today }), /no refund to record/, "unpaid with a refund");
before = await stock();
r = await cancel("TEST-PACKED-PAID", "TEST wrong item packed", null, { mode: "NEFT", reference: "refund 9999 8888 7777", refunded_on: today });
assert.equal(Number(r.refunded), 100); assert.equal(r.stock_back, true);
let row = await orderRow("TEST-PACKED-PAID");
assert.equal(row.order_status, "Cancelled"); assert.equal(row.payment_status, "Refunded"); assert.equal(Number(row.paid_amount), 0);
assert.deepEqual((await q("SELECT status FROM public.payments WHERE order_id = $1", [O.packedPaid.id])).map((p) => p.status), ["Refunded"], "the payment stays, marked Refunded");
const refund = (await q("SELECT * FROM public.order_refunds WHERE order_no = 'TEST-PACKED-PAID'"))[0];
assert.equal(Number(refund.amount), 100); assert.equal(refund.reference, "REFUND999988887777"); assert.equal(refund.mode, "NEFT");
assert.equal(refund.zoho_payment_id, "ZP-PACKED", "the sync refunds this Books payment"); assert.equal(refund.paid_ref, "PACKEDUTR0000000001");
after = await stock();
assert.equal(after.shelf, before.shelf + 2); assert.equal(after.batch, before.batch + 2);
assert.equal(await commission(O.packedPaid), "cancelled");
const told = await q("SELECT message FROM public.notifications WHERE order_no = 'TEST-PACKED-PAID' AND title = 'Refund recorded' AND recipient_role = 'customer'");
assert.equal(told.length, 1);
// Word for word as the Kannada dictionary has it: "Order {0} was cancelled. Rs {1} was paid back to you by {2} on {3}. Reference: {4}."
assert.match(told[0].message, /^Order TEST-PACKED-PAID was cancelled\. Rs 100\.00 was paid back to you by NEFT on \d{2} [A-Z][a-z]{2} \d{4}\. Reference: REFUND999988887777\.$/);
// Its transfer can never pay again, and neither can the refund's own reference pay back a second order.
await refuses(() => admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-OTHER', 100, 'PACKEDUTR0000000001', 'NEFT')")), /refunded/, "refunded UTR pays again");
await refuses(() => cancel("TEST-OFD-PAID", "TEST", true, { mode: "NEFT", reference: "REFUND 9999 8888 7777", refunded_on: today }), /already recorded on order TEST-PACKED-PAID/, "one refund, two orders");
// Customers cannot read refunds or cancellations.
assert.equal((await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS n FROM public.order_refunds")))[0].n, 0);
assert.equal((await as(CUSTOMER, "authenticated", () => q("SELECT count(*)::int AS n FROM public.order_cancellations")))[0].n, 0);
assert.equal((await admin(() => q("SELECT count(*)::int AS n FROM public.order_refunds")))[0].n, 1);

// ---- after dispatch: the admin says whether the goods came back
await refuses(() => cancel("TEST-DELIVERED", "TEST customer refused"), /came back/, "goods question");
await refuses(() => admin(() => q("SELECT public.cancel_marketplace_order('TEST-DELIVERED')")), /before dispatch/, "the old cancel still stops at dispatch");
// Straight to the table, past the grants, with the cancel flag on: only admin_cancel_order's own flag gets past dispatch.
await refuses(async () => {
  await db.query("UPDATE auth.cur SET uid = $1", [ADMIN]);
  await q("SELECT set_config('app.cancel_order_workflow','on',false)");
  try { await q("UPDATE public.orders SET order_status = 'Cancelled' WHERE order_no = 'TEST-DELIVERED'"); }
  finally { await q("SELECT set_config('app.cancel_order_workflow','off',false)"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}, /after any vendor has dispatched/, "the guard still refuses any other way");
before = await stock();
r = await cancel("TEST-DELIVERED", "TEST goods lost on the way", false);
assert.equal(r.after_dispatch, true); assert.equal(r.stock_back, false);
after = await stock();
assert.deepEqual(after, before, "goods that did not come back stay out of stock");
assert.equal((await q("SELECT goods_back FROM public.order_cancellations WHERE order_no = 'TEST-DELIVERED'"))[0].goods_back, false);
assert.deepEqual((await q("SELECT status FROM public.order_vendor_fulfillments WHERE order_id = $1", [O.deliveredUnpaid.id])).map((f) => f.status), ["Cancelled"]);
assert.equal((await allCheck("TEST-DELIVERED")).blocker, null, "the stock that left does not keep the order");

// Paid by cash, goods came back.
before = await stock();
r = await cancel("TEST-OFD-PAID", "TEST customer returned at the door", true, { mode: "Cash", reference: "", refunded_on: today });
assert.equal(r.stock_back, true);
after = await stock();
assert.equal(after.shelf, before.shelf + 2); assert.equal(after.batch, before.batch + 2);
assert.equal((await q("SELECT count(*)::int AS n FROM public.refunded_transfers WHERE order_no = 'TEST-OFD-PAID'"))[0].n, 0, "the word CASH is not a transfer");

// A bank alert that paid the order is settled with the refund named, and no longer keeps it.
r = await cancel("TEST-BANK-PAID", "TEST duplicate order", null, { mode: "UPI", reference: "777788889999", refunded_on: today });
const credit = (await q("SELECT status, note, order_no FROM public.bank_credits WHERE utr = '111122223333'"))[0];
assert.equal(credit.status, "settled"); assert.match(credit.note, /Refunded by UPI 777788889999/);
assert.equal((await allCheck("TEST-BANK-PAID")).blocker, null);

// ---- end checkout takes a reason; a screen older than this migration still works
await refuses(() => admin(() => q("SELECT public.admin_end_payment_hold('TEST-WAITING','ab')")), /Say why/, "short reason");
await admin(() => q("SELECT public.admin_end_payment_hold('TEST-WAITING','TEST customer asked on phone')"));
row = await orderRow("TEST-WAITING");
assert.equal(row.order_status, "Payment Expired"); assert.equal(row.payment_hold_outcome, "ended");
assert.equal((await q("SELECT stage, reason FROM public.order_cancellations WHERE order_no = 'TEST-WAITING'"))[0].reason, "TEST customer asked on phone");
await admin(() => q("SELECT public.admin_end_payment_hold('TEST-WAITING-OLD')"));
assert.equal((await orderRow("TEST-WAITING-OLD")).order_status, "Payment Expired");

// ---- delete a UTR record: only one that was rejected or refunded
const delUtr = (no, reason = "TEST typo by customer") => admin(() => q("SELECT public.admin_delete_utr($1,$2) AS r", [no, reason]));
await refuses(() => delUtr("TEST-CONFIRMED-UTR"), /remove the payment/, "confirmed");
await refuses(() => delUtr("TEST-UNCHECKED-UTR"), /Nobody checked/, "unchecked in time");
await refuses(() => delUtr("TEST-REJECTED-UTR", "no"), /Say why/, "reason");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_delete_utr('TEST-REJECTED-UTR','TEST reason')")), /Only administrators/, "customer");
await delUtr("TEST-REJECTED-UTR");
assert.equal((await q("SELECT count(*)::int AS n FROM public.upi_payment_submissions WHERE order_no = 'TEST-REJECTED-UTR'"))[0].n, 0);
const logged = (await q("SELECT kind, reason, payment->>'utr' AS utr FROM public.deleted_payments_log WHERE order_no = 'TEST-REJECTED-UTR'"))[0];
assert.equal(logged.kind, "utr"); assert.equal(logged.utr, "REJECTED1234567890"); assert.equal(logged.reason, "TEST typo by customer");

// ---- the order on the owner's screenshot: the ordinary delete keeps it, Delete all details takes it
assert.match(await admin(() => q("SELECT public.order_delete_blocker('CLK-TEST-031126-121319') AS r").then((rows) => rows[0].r)), /refunded/);
let check = await allCheck("CLK-TEST-031126-121319");
assert.equal(check.blocker, null); assert.ok(check.notes.includes("The UTRs sent for it go too."));
await deleteAll("CLK-TEST-031126-121319");
assert.equal(await orderRow("CLK-TEST-031126-121319"), undefined);
const copy = (await q("SELECT snapshot, utrs FROM public.deleted_orders_log WHERE order_no = 'CLK-TEST-031126-121319'"))[0];
assert.match(copy.utrs, /VAMSHI12345678910 \(rejected: refunded by our team\)/);
assert.equal(copy.snapshot.items.length, 1); assert.equal(copy.snapshot.commissions.length, 1);
// Its UTR record is gone, and the transfer still cannot pay for anything: not as a customer's UTR, not as a payment.
await refuses(() => q("INSERT INTO public.upi_payment_submissions (order_id, order_no, user_id, utr, amount, status) VALUES ($1,'TEST-OTHER',$2,'VAMSHI12345678910',100,'submitted')", [O.other.id, CUSTOMER]), /refunded/, "UTR again");
await refuses(() => payment(O.other, "VAMSHI12345678910"), /refunded/, "payment again");
await refuses(() => admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-OTHER', 100, 'VAMSHI12345678910', 'NEFT')")), /refunded/, "admin again");
// A delete never takes the never-again list with it.
await refuses(() => as(ADMIN, "authenticated", () => q("DELETE FROM public.refunded_transfers")), /permission denied/, "admin cannot clear the list");

// ---- every cancelled order can now be deleted with all its details, and the copy keeps the refund and the cancel
check = await allCheck("TEST-PACKED-PAID");
assert.equal(check.blocker, null);
assert.ok(check.notes.some((note) => /refund of Rs 100\.00 is not in Zoho Books yet/.test(note)), JSON.stringify(check.notes));
await deleteAll("TEST-PACKED-PAID");
const packedCopy = (await q("SELECT snapshot FROM public.deleted_orders_log WHERE order_no = 'TEST-PACKED-PAID'"))[0].snapshot;
assert.equal(packedCopy.refunds.length, 1); assert.equal(packedCopy.cancellation.reason, "TEST wrong item packed"); assert.equal(packedCopy.stock_taken.length, 1);
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_refunds"))[0].n, 2, "the deleted order's refund went with it");
// Its refunded transfer stays refunded after the delete.
await refuses(() => admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-OTHER', 100, 'PACKEDUTR0000000001', 'NEFT')")), /refunded/, "after the delete");
await deleteAll("TEST-DELIVERED");
await deleteAll("TEST-BANK-PAID");
assert.equal((await q("SELECT order_id, order_no, status FROM public.bank_credits WHERE utr = '111122223333'"))[0].order_id, null, "the settled alert stays, without the order");
await deleteAll("TEST-WAITING");

// ---- an ordinary, live order is untouched by all of this, and a non-refunded transfer still pays
await admin(() => q("SELECT public.admin_confirm_manual_payment('TEST-OTHER', 100, '999900001111', 'NEFT')"));
assert.equal((await orderRow("TEST-OTHER")).payment_status, "Paid");

console.log("cancel any step OK");
