// Real-Postgres check of 20261107140000_zoho_void_closes_order.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/zoho-void-closes-order.db-test.mjs
//
// WITHOUT_FIX=1 stops before the migration, to show the old database refusing. It must end with "zoho void closes order OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261107140000_zoho_void_closes_order.sql";

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
for (const file of files.filter((name) => name < MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const ADMIN = "00000000-0000-4000-8000-0000000000a1", CUSTOMER = "00000000-0000-4000-8000-0000000000c1";
await q("INSERT INTO auth.users (id, email) VALUES ('" + ADMIN + "','a@test.local'),('" + CUSTOMER + "','c@test.local') ON CONFLICT DO NOTHING");
await q("DELETE FROM public.user_roles WHERE user_id IN ('" + ADMIN + "','" + CUSTOMER + "')");
await q("INSERT INTO public.user_roles (user_id, role) VALUES ('" + ADMIN + "','admin'),('" + CUSTOMER + "','customer')");
await q("INSERT INTO public.branches (id, code, name, active, zoho_location_id) VALUES ('BR-CLK','CLK','Challakere Godown',true,'LOC-CLK') ON CONFLICT (id) DO UPDATE SET active = true");
await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Oil','approved',true,$1)", [JSON.stringify({ id: "P1", name: "TEST Oil", stock: 50, sold: 10, unit: "tin" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','P1',50,false)");
await q("INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, purchase_date, branch_id, warehouse, source, status) VALUES ('TEST-B1','P1','TEST Oil',50,40,'tin',100,'2026-11-01','BR-CLK','Challakere Godown','website','Active')");
const batchId = (await q("SELECT id FROM public.batches WHERE batch_code = 'TEST-B1'"))[0].id;

await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
async function order(no, status, extra = {}, fulfilment = status) {
  const row = { order_no: no, user_id: CUSTOMER, customer_name: "TEST", total: 100, subtotal: 100, paid_amount: 0, payment_status: "Pending", payment_method: "UPI", order_status: status, branch_id: "BR-CLK", vendor_ids: ["V1"], ...extra };
  const cols = Object.keys(row);
  const id = (await q("INSERT INTO public.orders (" + cols.join(",") + ") VALUES (" + cols.map((_, i) => "$" + (i + 1)).join(",") + ") RETURNING id", Object.values(row)))[0].id;
  const item = (await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, vendor_id) VALUES ($1,'P1','TEST Oil',2,50,100,'V1') RETURNING id", [id]))[0].id;
  await q("INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status) VALUES ($1,'V1',$2)", [id, fulfilment === "Cancelled" ? "Cancelled" : fulfilment]);
  return { id, item };
}
const VOID = { zoho_salesorder_id: "SO-1", zoho_order_status: "void" };
const O = {
  delivered: await order("TEST-DEL-VOID", "Delivered", { ...VOID, zoho_salesorder_id: "SO-DEL" }),
  outForDelivery: await order("TEST-OFD-VOID", "Out for Delivery", { ...VOID, zoho_salesorder_id: "SO-OFD", zoho_order_status: "cancelled" }),
  packed: await order("TEST-PACKED-VOID", "Packed", { ...VOID, zoho_salesorder_id: "SO-PACKED" }),
  paid: await order("TEST-DEL-PAID-VOID", "Delivered", { ...VOID, zoho_salesorder_id: "SO-PAID", paid_amount: 100, payment_status: "Paid" }),
  alive: await order("TEST-DEL-ALIVE", "Delivered", { zoho_salesorder_id: "SO-ALIVE", zoho_order_status: "fulfilled" }),
  liveInvoice: await order("TEST-CAN-INV-SENT", "Cancelled", { ...VOID, zoho_salesorder_id: "SO-INV" }),
  voidInvoice: await order("TEST-CAN-INV-VOID", "Cancelled", { ...VOID, zoho_salesorder_id: "SO-INV-VOID" }),
  unknown: await order("TEST-CAN-ZOHO-UNKNOWN", "Cancelled", { zoho_salesorder_id: "SO-UNKNOWN" }),
  running: await order("TEST-CAN-PUSH-RUNNING", "Cancelled", { ...VOID, zoho_salesorder_id: "SO-RUN" }),
  oldUnanswered: await order("TEST-CAN-OLD-UNANSWERED", "Cancelled", { ...VOID, zoho_salesorder_id: "SO-OLD" }),
  claimOnly: await order("TEST-CAN-CLAIM-NO-SO", "Cancelled"),
};
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
// The packed order holds 2 tins in the batch; the delivered one took its 2 long ago.
await q("INSERT INTO public.order_item_batch_allocations (order_item_id, batch_id, reserved_quantity, released_quantity, unit_cost) VALUES ($1,$2,2,0,100)", [O.packed.item, batchId]);
await q("INSERT INTO public.zoho_order_invoices (order_id, order_no, status) VALUES ($1,'TEST-DEL-VOID','none'),($2,'TEST-CAN-INV-SENT','sent'),($3,'TEST-CAN-INV-VOID','void')", [O.delivered.id, O.liveInvoice.id, O.voidInvoice.id]);
await q("INSERT INTO public.zoho_order_push_claims (order_id, holder, locked_until) VALUES ($1, gen_random_uuid(), now() + interval '2 minutes')", [O.running.id]);
await q("INSERT INTO public.zoho_order_push_claims (order_id, write_unanswered_at) VALUES ($1, now() - interval '3 days')", [O.oldUnanswered.id]);
await q("INSERT INTO public.zoho_order_push_claims (order_id) VALUES ($1)", [O.claimOnly.id]);
for (const o of [O.delivered, O.paid]) {
  await q("INSERT INTO public.zoho_sync_outbox (entity_type, entity_id, event_type, status, last_error) VALUES ('order',$1,'upsert','needs_review','Zoho sales order was voided in Zoho, but the order is Delivered')", [o.id]);
}

const status = async (no) => (await q("SELECT order_status FROM public.orders WHERE order_no = $1", [no]))[0]?.order_status;
const stockNow = async () => ({
  payload: (await q("SELECT payload->>'stock' AS s, payload->>'sold' AS sold FROM public.catalog_products WHERE id = 'P1'"))[0],
  batch: Number((await q("SELECT remaining_quantity FROM public.batches WHERE id = $1", [batchId]))[0].remaining_quantity),
});
async function as(uid, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [uid]);
  await db.exec("SET ROLE " + role);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const blocker = (no) => as(ADMIN, "authenticated", async () => (await q("SELECT public.order_delete_blocker($1) AS r", [no]))[0].r);
const del = (no) => as(ADMIN, "authenticated", () => q("SELECT public.admin_delete_order($1, 'TEST cleanup') AS r", [no]));

// Before the fix: a void in Zoho could not close a dispatched order, and an order once in Zoho could never be deleted.
assert.equal((await q("SELECT public.apply_zoho_order_cancellation($1) AS r", [O.outForDelivery.id]))[0].r, "blocked_after_dispatch");
assert.match(await blocker("TEST-CAN-INV-VOID"), /sent to Zoho/);
if (process.env.WITHOUT_FIX) { console.log("old database refuses, as expected"); process.exit(0); }

const stockBefore = await stockNow();
const notificationsBefore = (await q("SELECT count(*)::int AS n FROM public.notifications"))[0].n;
const outboxBefore = (await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE status = 'pending' AND entity_type = 'order'"))[0].n;
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
for (const file of files.filter((name) => name > MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

// The one-time pass closed every unpaid order the website already knew was void in Zoho.
assert.equal(await status("TEST-DEL-VOID"), "Cancelled");
assert.equal(await status("TEST-OFD-VOID"), "Cancelled", "cancelled in Zoho counts as void");
assert.equal(await status("TEST-PACKED-VOID"), "Cancelled");
assert.equal(await status("TEST-DEL-PAID-VOID"), "Delivered", "money received here: stays for a refund");
assert.equal(await status("TEST-DEL-ALIVE"), "Delivered", "alive in Zoho: untouched");
assert.deepEqual((await q("SELECT status FROM public.order_vendor_fulfillments WHERE order_id = $1", [O.delivered.id])).map((r) => r.status), ["Cancelled"]);
// Its old review is answered; the paid order's stays for a person.
assert.equal((await q("SELECT status FROM public.zoho_sync_outbox WHERE entity_id = $1", [O.delivered.id]))[0].status, "complete");
assert.equal((await q("SELECT status FROM public.zoho_sync_outbox WHERE entity_id = $1", [O.paid.id]))[0].status, "needs_review");
// Stock: the packed order's 2 tins went back to the shelf and the batch; the dispatched ones changed nothing.
const stockAfter = await stockNow();
assert.equal(Number(stockAfter.payload.s), Number(stockBefore.payload.s) + 2, "only the packed order's 2 tins come back");
assert.equal(Number(stockAfter.payload.sold), Number(stockBefore.payload.sold) - 2);
assert.equal(stockAfter.batch, stockBefore.batch + 2, "only the packed order's allocation is released");
// Nothing is sent back to Zoho for orders Zoho itself closed; the customer and admins are told.
assert.equal((await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox WHERE status = 'pending' AND entity_type = 'order'"))[0].n, outboxBefore);
assert.ok((await q("SELECT count(*)::int AS n FROM public.notifications"))[0].n > notificationsBefore);
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications WHERE order_no = 'TEST-DEL-VOID' AND recipient_role = 'customer' AND message LIKE '%Cancelled%'"))[0].n, 1);
// The transaction's flags did not leak.
assert.equal(await q("SELECT current_setting('app.zoho_void', true) AS v").then((r) => r[0].v ?? ""), "");

// Only the server can apply a Zoho void, and everyone else still can't cancel after dispatch.
assert.equal((await q("SELECT has_function_privilege('authenticated','public.apply_zoho_order_cancellation(uuid)','EXECUTE') AS p"))[0].p, false);
assert.equal((await q("SELECT has_function_privilege('anon','public.apply_zoho_order_cancellation(uuid)','EXECUTE') AS p"))[0].p, false);
// The admin's own cancellation (the protected workflow) still stops after dispatch: the guard is checked as the table owner,
// since the browser's role cannot update orders directly at all.
await assert.rejects(() => as(ADMIN, "authenticated", () => q("UPDATE public.orders SET order_status = 'Cancelled' WHERE order_no = 'TEST-DEL-ALIVE'")), /permission denied/);
await db.query("UPDATE auth.cur SET uid = $1", [ADMIN]);
await assert.rejects(async () => {
  await db.exec("BEGIN");
  try {
    await q("SELECT set_config('app.cancel_order_workflow', 'on', true)");
    await q("UPDATE public.orders SET order_status = 'Cancelled' WHERE order_no = 'TEST-DEL-ALIVE'");
  } finally { await db.exec("ROLLBACK"); }
}, /cannot be cancelled after any vendor has dispatched/);
await db.query("UPDATE auth.cur SET uid = NULL");
assert.equal(await status("TEST-DEL-ALIVE"), "Delivered");
// A void arriving now for a dispatched, unpaid order closes it; for a paid one it is refused.
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
const later = await order("TEST-OFD-LATER", "Out for Delivery", { zoho_salesorder_id: "SO-LATER", zoho_order_status: "void" });
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
assert.equal((await q("SELECT public.apply_zoho_order_cancellation($1) AS r", [later.id]))[0].r, "cancelled_after_dispatch");
assert.equal(await status("TEST-OFD-LATER"), "Cancelled");
assert.equal((await q("SELECT public.apply_zoho_order_cancellation($1) AS r", [later.id]))[0].r, "already_cancelled");
assert.equal((await q("SELECT public.apply_zoho_order_cancellation($1) AS r", [O.paid.id]))[0].r, "blocked_paid");

// Delete: a void-in-Zoho order with nothing else to keep it may go; the log keeps its Zoho sales order.
assert.equal(await blocker("TEST-DEL-VOID"), null);
assert.equal(await blocker("TEST-CAN-INV-VOID"), null);
assert.equal(await blocker("TEST-CAN-OLD-UNANSWERED"), null, "an unanswered write from days ago no longer holds it");
assert.match(await blocker("TEST-CAN-INV-SENT"), /live invoice/);
assert.match(await blocker("TEST-CAN-ZOHO-UNKNOWN"), /stays to match Zoho\. It can be deleted once its sales order is void/);
assert.match(await blocker("TEST-CAN-PUSH-RUNNING"), /running or got no clear answer/);
assert.match(await blocker("TEST-CAN-CLAIM-NO-SO"), /sent to Zoho/);
assert.match(await blocker("TEST-DEL-PAID-VOID"), /Only an order whose payment window ran out, or a cancelled order/);
await del("TEST-DEL-VOID");
await del("TEST-CAN-INV-VOID");
assert.equal(await status("TEST-DEL-VOID"), undefined);
assert.equal((await q("SELECT count(*)::int AS n FROM public.zoho_order_invoices WHERE order_id = $1", [O.delivered.id]))[0].n, 0);
const log = await q("SELECT order_no, order_status, zoho_salesorder_id, zoho_order_status FROM public.deleted_orders_log ORDER BY id");
assert.deepEqual(log.map((r) => [r.order_no, r.order_status, r.zoho_salesorder_id, r.zoho_order_status]), [
  ["TEST-DEL-VOID", "Cancelled", "SO-DEL", "void"],
  ["TEST-CAN-INV-VOID", "Cancelled", "SO-INV-VOID", "void"],
]);
for (const no of ["TEST-CAN-INV-SENT", "TEST-CAN-ZOHO-UNKNOWN", "TEST-CAN-PUSH-RUNNING", "TEST-CAN-CLAIM-NO-SO", "TEST-DEL-PAID-VOID"]) {
  await assert.rejects(() => del(no), /stays|Only an order/);
  assert.ok(await status(no), no + " must stay");
}
// Deleting never touches stock.
assert.deepEqual(await stockNow(), stockAfter);

console.log("zoho void closes order OK");
