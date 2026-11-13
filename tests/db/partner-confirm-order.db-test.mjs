// Real-Postgres check of 20261113230000_godown_location_partner_confirm.sql (a channel partner confirms their godown's
// paid orders; the godown's location link), on PGlite with every migration in the repo and small stand-ins for what
// Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/partner-confirm-order.db-test.mjs
//
// It must end with "partner confirm OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261113230000_godown_location_partner_confirm.sql";

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
// Run twice: the migration must be safe to apply again.
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), ADMIN2 = uid("a2"), CUSTOMER = uid("c1"), VENDOR = uid("d1");
const P_CLK = uid("b1"), P_HBL = uid("b2"), P_OFF = uid("b3");
const people = [ADMIN, ADMIN2, CUSTOMER, VENDOR, P_CLK, P_HBL, P_OFF];
await q(`INSERT INTO auth.users (id, email) SELECT u, u::text || '@test.local' FROM unnest($1::uuid[]) u ON CONFLICT DO NOTHING`, [people]);
await q(`DELETE FROM public.user_roles WHERE user_id = ANY ($1::uuid[])`, [people]);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${ADMIN2}','admin'),('${CUSTOMER}','customer'),('${VENDOR}','vendor')`);
await q(`INSERT INTO public.profiles (id, full_name, email, vendor_id) VALUES ('${VENDOR}','House seller','v@test.local','V1')
  ON CONFLICT (id) DO UPDATE SET vendor_id = 'V1'`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Challakere Godown'");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Hubli Godown'");
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE branch_id IN ('BR-CLK','BR-HBL')");
const at = (day, time = "10:00") => `2026-11-${String(day).padStart(2, "0")}T${time}:00+05:30`;
const PARTNER_CLK = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, status, created_at) VALUES
  ('${P_OFF}','BR-CLK','Partner Gone','p3@test.local','9000000023','suspended',$1) RETURNING id`, [at(1, "08:00")]))[0].id;
void PARTNER_CLK;
const CLK = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES
  ('${P_CLK}','BR-CLK','Partner CLK','p1@test.local','9000000021',$1) RETURNING id`, [at(1, "09:00")]))[0].id;
const HBL = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES
  ('${P_HBL}','BR-HBL','Partner HBL','p2@test.local','9000000022',$1) RETURNING id`, [at(1, "09:00")]))[0].id;

async function as(user, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + (user ? "authenticated" : "anon"));
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};

await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Rice','approved',true,$1) ON CONFLICT (id) DO NOTHING",
  [JSON.stringify({ id: "P1", name: "TEST Rice", stock: 500, sold: 0, hsn: "1006", unit: "bag", weight: "25 kg" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");

// The orders are written with their triggers off (as they stand after checkout and payment), then the triggers go back on
// for the confirms, so every effect seen below is the confirm's own.
const TABLES = ["orders", "order_items", "payments", "partner_commissions", "order_vendor_fulfillments"];
for (const table of TABLES) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
const ids = {};
async function order(no, { branch = "BR-CLK", status = "Payment Confirmed", payment = "Paid", paid = null, zoho = null, partner = CLK } = {}) {
  const id = (await q(`INSERT INTO public.orders (order_no, user_id, customer_name, customer_email, customer_phone, total, subtotal, gst_amount, paid_amount,
      balance_due, payment_status, payment_method, order_status, branch_id, created_at, shipping_address, shipping_method, prices_include_gst, vendor_ids, zoho_order_status)
    VALUES ($1,$2,'TEST Customer','c@test.local','9000000009',105,100,5,$3,$4,$5,'UPI',$6,$7,$8,$9,'Pickup',true,ARRAY['V1'],$10) RETURNING id`,
    [no, CUSTOMER, paid ?? (payment === "Paid" ? 105 : 0), 105 - (paid ?? (payment === "Paid" ? 105 : 0)), payment, status, branch, at(10),
      JSON.stringify({ line: "TEST street", city: "Challakere", state: "Karnataka", pin: "577522" }), zoho]))[0].id;
  const item = (await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, gst_rate, vendor_id, vendor)
    VALUES ($1,'P1','TEST Rice',1,105,105,5,'V1','House seller') RETURNING id`, [id]))[0].id;
  await q(`INSERT INTO public.order_vendor_fulfillments (order_id, vendor_id, status) VALUES ($1,'V1',$2)`,
    [id, ["Placed", "Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered", "Cancelled"].includes(status) ? status : "Placed"]);
  if (partner) {
    await q(`INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id, product_name, qty, line_total, kind, rate, amount, status, placed_at)
      VALUES ($1,$2,$3,$4,$5,'P1','TEST Rice',1,100,'per_unit',2,2,'pending',$6)`, [item, id, no, partner, branch, at(10)]);
  }
  if (payment === "Paid" || paid) {
    await q(`INSERT INTO public.payments (order_id, user_id, amount, method, status, txn_ref) VALUES ($1,$2,$3,'UPI','Paid',$4)`,
      [id, CUSTOMER, paid ?? 105, `5312000${String(Object.keys(ids).length).padStart(5, "0")}`]);
  }
  ids[no] = id;
  return id;
}
await order("T-PARTNER");                                                  // paid, Payment Confirmed: the partner confirms
await order("T-ADMIN");                                                    // the same, confirmed by an admin: effects compared
await order("T-PLACED", { status: "Placed" });                             // paid, still Placed
await order("T-PART", { payment: "Partially Paid", paid: 40 });            // part paid: money is the office's
await order("T-UNPAID", { status: "Placed", payment: "Pending" });         // nothing paid
await order("T-HELD", { status: "Awaiting Payment", payment: "Pending" }); // a checkout waiting for payment
await order("T-ENDED", { status: "Payment Expired", payment: "Pending" }); // a checkout that ended
await order("T-CANCEL", { status: "Cancelled" });                          // cancelled
await order("T-VOID", { zoho: "void" });                                   // void in Zoho
await order("T-REFUND", { payment: "Refunded", paid: 0 });                 // refunded
await order("T-DONE", { status: "Delivered" });                            // long done
await order("T-HBL", { branch: "BR-HBL", partner: HBL });                  // Hubli's order
for (const table of TABLES) await q(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);
await q("DELETE FROM public.notifications");
await q("DELETE FROM public.zoho_sync_outbox");

const confirm = (user, no) => as(user, async () => (await q("SELECT public.partner_confirm_order($1) AS r", [no]))[0].r);
const statusOf = async (no) => (await q("SELECT order_status FROM public.orders WHERE order_no = $1", [no]))[0].order_status;

// ---------------------------------------------------------------- who may confirm, and what
await refuses(() => confirm(P_CLK, "T-HBL"), /not an order of your godown/, "another godown's order");
assert.equal(await statusOf("T-HBL"), "Payment Confirmed");
await refuses(() => confirm(P_CLK, "T-NONE"), /not an order of your godown/, "an unknown number: the same answer");
await refuses(() => confirm(P_HBL, "T-PARTNER"), /not an order of your godown/, "Hubli's partner on a Challakere order");
await refuses(() => confirm(P_OFF, "T-PARTNER"), /Only an active channel partner/, "a suspended partner");
await refuses(() => confirm(CUSTOMER, "T-PARTNER"), /Only an active channel partner/, "the customer");
await refuses(() => confirm(ADMIN, "T-PARTNER"), /Only an active channel partner/, "an admin uses the admin page");
await refuses(() => confirm(null, "T-PARTNER"), /permission denied/, "not signed in");
await refuses(() => confirm(P_CLK, "T-PART"), /not fully paid yet/, "part paid");
await refuses(() => confirm(P_CLK, "T-UNPAID"), /not fully paid yet/, "nothing paid");
await refuses(() => confirm(P_CLK, "T-HELD"), /not a paid order/, "a held checkout");
await refuses(() => confirm(P_CLK, "T-ENDED"), /not a paid order/, "an ended checkout");
await refuses(() => confirm(P_CLK, "T-CANCEL"), /cancelled/, "a cancelled order");
await refuses(() => confirm(P_CLK, "T-VOID"), /void in Zoho/, "void in Zoho");
await refuses(() => confirm(P_CLK, "T-REFUND"), /refunded/, "a refunded payment");
for (const no of ["T-PART", "T-UNPAID", "T-HELD", "T-ENDED", "T-CANCEL", "T-VOID", "T-REFUND"]) {
  assert.notEqual(await statusOf(no), "Accepted", `${no} unchanged`);
}
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications"))[0].n, 0, "a refusal tells nobody anything");
assert.equal((await q("SELECT count(*)::int AS n FROM public.zoho_sync_outbox"))[0].n, 0, "a refusal sends nothing to Zoho");
const done = await confirm(P_CLK, "T-DONE");
assert.deepEqual([done.confirmed, done.already, done.status], [false, true, "Delivered"], "a delivered order is past confirming: nothing changes");

// ---------------------------------------------------------------- the partner's confirm does what the admin's does
const r1 = await confirm(P_CLK, "T-PARTNER");
assert.deepEqual([r1.confirmed, r1.already, r1.status, r1.order_no], [true, false, "Accepted", "T-PARTNER"]);
await as(ADMIN, () => q("SELECT public.admin_update_order_status('T-ADMIN', 'Accepted')"));
const effects = async (no) => {
  const id = ids[no];
  const [o] = await q("SELECT order_status, payment_status, paid_amount::text, total::text, balance_due::text FROM public.orders WHERE id = $1", [id]);
  const outbox = (await q("SELECT entity_type, status FROM public.zoho_sync_outbox WHERE entity_id = $1::text", [id])).map((r) => `${r.entity_type}:${r.status}`);
  const fulfil = (await q("SELECT status FROM public.order_vendor_fulfillments WHERE order_id = $1", [id])).map((r) => r.status);
  const commission = (await q("SELECT status FROM public.partner_commissions WHERE order_id = $1", [id])).map((r) => r.status);
  const notes = (await q("SELECT recipient_id, recipient_role, title, replace(message, $2, 'NO') AS message FROM public.notifications WHERE order_id = $1 ORDER BY recipient_role, recipient_id", [id, no]))
    .map((r) => `${r.recipient_role}:${r.recipient_id}:${r.title}:${r.message}`);
  return { o, outbox, fulfil, commission, notes };
};
const partnerFx = await effects("T-PARTNER");
const adminFx = await effects("T-ADMIN");
assert.deepEqual(partnerFx.o, { order_status: "Accepted", payment_status: "Paid", paid_amount: "105.00", total: "105.00", balance_due: "0.00" }, "only the status changed");
assert.deepEqual(partnerFx.o, adminFx.o);
assert.deepEqual(partnerFx.outbox, ["order:pending"], "the Zoho sync job that makes the Zoho Books invoice");
assert.deepEqual(partnerFx.outbox, adminFx.outbox);
assert.deepEqual(partnerFx.fulfil, ["Accepted"], "the vendor's fulfilment moves with the order");
assert.deepEqual(partnerFx.fulfil, adminFx.fulfil);
assert.deepEqual(partnerFx.commission, adminFx.commission, "the partner's commission line is updated the same way");
// The admin who acted is not told of their own change; everyone else is told the same thing either way.
const withoutActor = (list) => list.filter((line) => !line.startsWith(`admin:${ADMIN}:`));
assert.deepEqual(withoutActor(partnerFx.notes), adminFx.notes, "the same notifications to the customer, the vendor and the admins");
assert.ok(partnerFx.notes.includes(`customer:${CUSTOMER}:Order status updated:Order NO is now Accepted.`));
assert.ok(partnerFx.notes.includes(`vendor:${VENDOR}:Order status updated:Order NO is now Accepted.`));
assert.ok(partnerFx.notes.includes(`admin:${ADMIN}:Order status updated:Order NO is now Accepted.`), "every admin hears of the partner's confirm");
assert.ok(partnerFx.notes.includes(`admin:${ADMIN2}:Order status updated:Order NO is now Accepted.`));
const tracking = await q("SELECT status, note, actor_role FROM public.order_tracking WHERE order_id = $1", [ids["T-PARTNER"]]);
assert.deepEqual(tracking, [{ status: "Accepted", note: "Confirmed by channel partner Partner CLK at Challakere Godown.", actor_role: "partner" }], "who confirmed it is kept");
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_tracking WHERE order_id = $1", [ids["T-ADMIN"]]))[0].n, 0);

// From Placed, paid in full: the same step as the admin's "Mark as Confirmed".
const r3 = await confirm(P_CLK, "T-PLACED");
assert.equal(r3.confirmed, true);
assert.equal(await statusOf("T-PLACED"), "Accepted");
assert.deepEqual((await effects("T-PLACED")).fulfil, ["Accepted"]);

// A second press changes nothing and tells nobody again.
const before = (await q("SELECT count(*)::int AS n FROM public.notifications"))[0].n;
const again = await confirm(P_CLK, "T-PARTNER");
assert.deepEqual([again.confirmed, again.already, again.status], [false, true, "Accepted"]);
assert.equal((await q("SELECT count(*)::int AS n FROM public.notifications"))[0].n, before);
assert.equal((await q("SELECT count(*)::int AS n FROM public.order_tracking WHERE order_id = $1", [ids["T-PARTNER"]]))[0].n, 1);

// Hubli's partner confirms Hubli's order.
assert.equal((await confirm(P_HBL, "T-HBL")).confirmed, true);

// ---------------------------------------------------------------- the database itself holds the line
// Even with the confirm's flag set by hand, the guard lets only that one step through.
const forced = async (user, sql, params) => {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  try {
    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.partner_confirm', 'on', true)");
    await db.query(sql, params);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  } finally {
    await db.query("UPDATE auth.cur SET uid = NULL");
  }
};
await refuses(() => forced(P_CLK, "UPDATE public.orders SET order_status = 'Accepted' WHERE order_no = 'T-PART'"), /Vendor order updates must follow/, "flag, part paid");
await refuses(() => forced(P_HBL, "UPDATE public.orders SET order_status = 'Accepted' WHERE order_no = 'T-UNPAID'"), /Vendor order updates must follow|Customers and vendors cannot/, "flag, another godown");
await refuses(() => forced(P_CLK, "UPDATE public.orders SET order_status = 'Delivered' WHERE order_no = 'T-ADMIN'"), /Vendor order updates must follow/, "flag, any other step");
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET order_status = 'Payment Confirmed' WHERE order_no = 'T-ADMIN'");
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
await refuses(() => forced(P_CLK, "UPDATE public.orders SET order_status = 'Accepted', total = 1 WHERE order_no = 'T-ADMIN'"), /Customers and vendors cannot|Vendor order updates/, "flag, with the total changed too");
// And the partner cannot write the order at all from the site (no update right on orders).
await as(P_CLK, () => q("UPDATE public.orders SET order_status = 'Accepted' WHERE order_no = 'T-PART'")).catch(() => undefined);
assert.equal(await statusOf("T-PART"), "Payment Confirmed");

// ---------------------------------------------------------------- the partner's list
const list = (user) => as(user, () => q("SELECT * FROM public.partner_orders_to_confirm()"));
const rows = await list(P_CLK);
assert.deepEqual(rows.map((r) => r.order_no).sort(), ["T-ADMIN", "T-PART", "T-PARTNER", "T-PLACED", "T-REFUND", "T-UNPAID", "T-VOID"].sort(),
  "waiting ones (paid or not) and the partner's own confirms; not checkouts, cancelled, delivered or Hubli's");
const row = (no) => rows.find((r) => r.order_no === no);
assert.ok(row("T-PARTNER").confirmed_at && row("T-PLACED").confirmed_at, "confirmed by the partner, with when");
assert.equal(row("T-PART").confirmed_at, null);
assert.equal(row("T-VOID").zoho_void, true);
assert.equal(row("T-PART").zoho_void, false);
assert.equal(row("T-PARTNER").invoice_mine, true, "their own order's invoice opens for them");
assert.equal(row("T-PARTNER").items, "TEST Rice × 1");
assert.equal(row("T-PARTNER").customer, "TEST Customer");
assert.equal(Number(row("T-PART").paid_amount), 40);
const lastWaiting = rows.findIndex((r) => r.order_status === "Accepted");
assert.ok(rows.slice(lastWaiting).every((r) => r.order_status === "Accepted"), "the waiting ones first");
assert.deepEqual((await list(P_HBL)).map((r) => r.order_no), ["T-HBL"]);
await refuses(() => list(P_OFF), /Only an active channel partner/, "a suspended partner");
await refuses(() => list(CUSTOMER), /Only an active channel partner/, "a customer");
await refuses(() => list(null), /permission denied/, "not signed in");

const grants = (await q(`SELECT
  has_function_privilege('anon', 'public.partner_confirm_order(text)', 'EXECUTE') AS anon_confirm,
  has_function_privilege('authenticated', 'public.partner_confirm_order(text)', 'EXECUTE') AS auth_confirm,
  has_function_privilege('anon', 'public.partner_orders_to_confirm()', 'EXECUTE') AS anon_list,
  has_function_privilege('authenticated', 'public.partner_orders_to_confirm()', 'EXECUTE') AS auth_list`))[0];
assert.deepEqual(grants, { anon_confirm: false, auth_confirm: true, anon_list: false, auth_list: true });

// ---------------------------------------------------------------- the godown's location link
const setLink = (link) => as(ADMIN, () => q("UPDATE public.branches SET map_url = $1 WHERE id = 'BR-CLK'", [link]));
await setLink("https://maps.app.goo.gl/Xr4Pq9LmZb2VnT8k6");
await setLink("https://www.google.com/maps/place/Grain+Bazar/@14.31,76.65,17z");
await setLink("");
await refuses(() => setLink("http://maps.app.goo.gl/Xr4Pq9LmZb2VnT8k6"), /branches_map_url_https/, "not https");
await refuses(() => setLink("maps.app.goo.gl/Xr4Pq9LmZb2VnT8k6"), /branches_map_url_https/, "no scheme");
await refuses(() => setLink("https://maps.app.goo.gl/a b"), /branches_map_url_https/, "a space");
await refuses(() => setLink(`https://maps.app.goo.gl/${"x".repeat(1000)}`), /branches_map_url_https/, "too long");
await refuses(() => as(P_CLK, async () => {
  const changed = await q("UPDATE public.branches SET map_url = 'https://evil.example/x' WHERE id = 'BR-CLK' RETURNING id");
  if (!changed.length) throw new Error("no rows changed");
}), /no rows changed|permission denied|row-level security/, "a partner cannot set the link");
assert.equal((await q("SELECT map_url FROM public.branches WHERE id = 'BR-CLK'"))[0].map_url, "");

console.log("partner confirm OK");
