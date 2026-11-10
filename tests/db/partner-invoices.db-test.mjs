// Real-Postgres check of 20261110200000_partner_invoice_signatures.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/partner-invoices.db-test.mjs
//
// It must end with "partner invoices OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261110200000_partner_invoice_signatures.sql";

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
  GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
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
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), OTHER = uid("c2"), A_USER = uid("b1"), B_USER = uid("b2"), H_USER = uid("b3");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${OTHER}','o@test.local'),
  ('${A_USER}','pa@test.local'),('${B_USER}','pb@test.local'),('${H_USER}','ph@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${OTHER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer'),('${OTHER}','customer')`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q("UPDATE public.branches SET signature_path = 'BR-CLK/godown.png' WHERE id = 'BR-CLK'");

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
const at = (day, time = "10:00") => `2026-11-${String(day).padStart(2, "0")}T${time}:00+05:30`;

// Challakere: A from 1 Nov to 4 Nov, nobody on 4-5 Nov, B from 5 Nov. Hubli: H from 1 Nov.
const A = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ('${A_USER}','BR-CLK','Partner A','pa@test.local','9000000001',$1) RETURNING id`, [at(1, "09:00")]))[0].id;
await q(`UPDATE public.channel_partners SET status = 'suspended', updated_at = $2 WHERE id = $1`, [A, at(4, "12:00")]);
await q(`UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'suspended'`, [A, at(4, "12:00")]);
const B = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ('${B_USER}','BR-CLK','Partner B','pb@test.local','9000000002',$1) RETURNING id`, [at(5, "09:00")]))[0].id;
const H = (await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ('${H_USER}','BR-HBL','Partner H','ph@test.local','9000000003',$1) RETURNING id`, [at(1, "09:00")]))[0].id;
assert.deepEqual((await q(`SELECT event FROM public.channel_partner_events WHERE partner_id = $1 ORDER BY at`, [A])).map((r) => r.event), ["added", "suspended"]);

await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ('P1','V1','Rice','approved',true,$1) ON CONFLICT (id) DO NOTHING",
  [JSON.stringify({ id: "P1", name: "TEST Rice", stock: 500, sold: 0, purchasePrice: 40, hsn: "1006", unit: "bag", weight: "25 kg" })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
for (const table of ["orders", "order_items", "payments", "zoho_order_invoices"]) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);

/** An order; `commission` names the partner its commission line carries (none when null). */
async function order(no, { branch = "BR-CLK", placed, commission = null, status = "Delivered", payment = "Paid", user = CUSTOMER } = {}) {
  const id = (await q(`INSERT INTO public.orders (order_no, user_id, customer_name, customer_email, customer_phone, total, subtotal, gst_amount, paid_amount,
      payment_status, payment_method, order_status, branch_id, created_at, shipping_address, shipping_method, prices_include_gst, vendor_ids)
    VALUES ($1,$2,'TEST Customer','c@test.local','9000000009',105,100,5,$3,$4,'UPI',$5,$6,$7,$8,'Pickup',true,ARRAY['V1']) RETURNING id`,
    [no, user, payment === "Paid" ? 105 : 0, payment, status, branch, placed, JSON.stringify({ line: "TEST street", city: "Challakere", state: "Karnataka", pin: "577522" })]))[0].id;
  const item = (await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, gst_rate, vendor_id, vendor)
    VALUES ($1,'P1','TEST Rice',1,105,105,5,'V1','House seller') RETURNING id`, [id]))[0].id;
  if (commission) {
    await q(`INSERT INTO public.partner_commissions (order_item_id, order_id, order_no, partner_id, branch_id, product_id, product_name, qty, line_total, kind, rate, amount, status, placed_at)
      VALUES ($1,$2,$3,$4,$5,'P1','TEST Rice',1,100,'per_unit',2,2,'pending',$6)`, [item, id, no, commission, branch, placed]);
  }
  await q(`INSERT INTO public.payments (order_id, user_id, amount, method, status, txn_ref, created_at) VALUES ($1,$2,105,'UPI','Paid','531200000001',$3)`, [id, user, placed]);
  return id;
}
const O1 = await order("GB-T1", { placed: at(2), commission: A });          // A's time, commission line A
const O2 = await order("GB-T2", { placed: at(3) });                         // A's time, no rate: the log decides
const O3 = await order("GB-T3", { placed: at(6), commission: B });          // B's time
const O4 = await order("GB-T4", { placed: at(4, "18:00") });                // nobody ran Challakere then
const O5 = await order("GB-T5", { branch: "BR-HBL", placed: at(6) });       // Hubli, H
const O6 = await order("GB-T6", { placed: at(7), status: "Awaiting Payment", payment: "Pending" });  // a checkout request, not an order
const O7 = await order("GB-T7", { placed: at(3, "11:00"), commission: B }); // the line says B: the exact record wins over the log
const O8 = await order("GB-T8", { placed: at(7), user: OTHER });            // another customer's order in B's time
await q(`INSERT INTO public.zoho_order_invoices (order_id, order_no, invoice_number, status, invoice_date, zoho_invoice_id) VALUES ($1,'GB-T3','INV-000777','sent','2026-11-06','z1')`, [O3]);

// ---------------------------------------------------------------- who signs each order
const signer = async (id) => (await q("SELECT private.order_signing_partner($1) AS p", [id]))[0].p;
assert.equal(await signer(O1), A, "A signs an order of their time");
assert.equal(await signer(O2), A, "the log decides an order without a rate");
assert.equal(await signer(O3), B);
assert.equal(await signer(O4), null, "no partner then: nobody signs");
assert.equal(await signer(O5), H);
assert.equal(await signer(O7), B, "the commission line is the exact record");
assert.equal((await q("SELECT private.godown_partner_at('BR-CLK', $1) AS p", [at(4, "12:00")]))[0].p, null, "suspended at that very moment");
assert.equal((await q("SELECT private.godown_partner_at('BR-CLK', $1) AS p", [at(4, "11:59")]))[0].p, A);
assert.equal((await q("SELECT private.godown_partner_at('BR-CLK', $1) AS p", [at(1, "08:59")]))[0].p, null, "before anyone was added");
assert.equal((await q("SELECT private.godown_partner_at('BR-HBL', $1) AS p", [at(2)]))[0].p, H);

// ---------------------------------------------------------------- the signature path, for those who may open the invoice
await q("UPDATE public.channel_partners SET signature_path = 'partners/A/sig.png' WHERE id = $1", [A]);
const sig = (user, no) => as(user, async () => (await q("SELECT public.invoice_partner_signature($1) AS p", [no]))[0].p);
assert.equal(await sig(CUSTOMER, "GB-T1"), "partners/A/sig.png", "the customer's own invoice: A's signature, though A has left");
assert.equal(await sig(ADMIN, "GB-T1"), "partners/A/sig.png");
assert.equal(await sig(CUSTOMER, "GB-T2"), "partners/A/sig.png");
assert.equal(await sig(OTHER, "GB-T1"), null, "another customer learns nothing");
await refuses(() => sig(null, "GB-T1"), /permission denied/, "not signed in");
assert.equal(await sig(A_USER, "GB-T1"), null, "a suspended partner gets nothing");
assert.equal(await sig(B_USER, "GB-T1"), null, "B did not sign A's orders");
assert.equal(await sig(H_USER, "GB-T1"), null, "another godown's partner");
assert.equal(await sig(CUSTOMER, "GB-T3"), null, "B has no signature yet: the godown's spare one is used by the page");
assert.equal(await sig(CUSTOMER, "GB-T4"), null, "no partner then");
assert.equal(await sig(CUSTOMER, "GB-NONE"), null);

// Only admins set a partner's signature; the partner cannot set their own.
await as(B_USER, () => q("UPDATE public.channel_partners SET signature_path = 'partners/B/forged.png' WHERE user_id = $1", [B_USER]));
assert.equal((await q("SELECT signature_path FROM public.channel_partners WHERE id = $1", [B]))[0].signature_path, null, "a partner cannot change their signature");
await as(ADMIN, () => q("UPDATE public.channel_partners SET signature_path = 'partners/B/sig.png' WHERE id = $1", [B]));
assert.equal(await sig(B_USER, "GB-T3"), "partners/B/sig.png", "B sees the signature on their own order");
assert.equal(await sig(CUSTOMER, "GB-T3"), "partners/B/sig.png");
assert.equal(await sig(CUSTOMER, "GB-T1"), "partners/A/sig.png", "A's old invoices keep A's signature");
assert.equal((await as(B_USER, () => q("SELECT signature_path FROM public.channel_partners WHERE user_id = $1", [B_USER])))[0].signature_path, "partners/B/sig.png", "B reads their own");
assert.equal((await as(B_USER, () => q("SELECT signature_path FROM public.channel_partners WHERE id = $1", [A]))).length, 0, "B cannot read A's record");
const eventsAfter = (await q("SELECT count(*)::int AS n FROM public.channel_partner_events"))[0].n;
assert.equal(eventsAfter, 4, "a signature change is not a partner change in the history");

// The bucket stays private and only admins write to it.
const bucket = (await q("SELECT public FROM storage.buckets WHERE id = 'godown-signatures'"))[0];
assert.equal(bucket.public, false);
await refuses(() => as(B_USER, () => q("INSERT INTO storage.objects (bucket_id, name) VALUES ('godown-signatures','partners/x/forged.png')")), /row-level security|violates/i, "a partner uploads into the bucket");
await as(ADMIN, () => q("INSERT INTO storage.objects (bucket_id, name) VALUES ('godown-signatures','partners/x/ok.png')"));

// ---------------------------------------------------------------- the partner's invoice list
const list = (user, from, to) => as(user, () => q("SELECT * FROM public.partner_invoice_orders($1, $2)", [from, to]));
assert.deepEqual((await list(B_USER, "2026-11-01", "2026-11-30")).map((r) => r.order_no), ["GB-T8", "GB-T3", "GB-T7"],
  "B: their own time's orders and the line that names them; not A's, not the gap, not a checkout request");
assert.deepEqual((await list(H_USER, "2026-11-01", "2026-11-30")).map((r) => r.order_no), ["GB-T5"]);
assert.equal((await list(B_USER, "2026-11-01", "2026-11-30")).find((r) => r.order_no === "GB-T3").invoice_number, "INV-000777");
assert.deepEqual((await list(B_USER, "2026-11-06", "2026-11-06")).map((r) => r.order_no), ["GB-T3"], "IST dates");
await refuses(() => list(A_USER, "2026-11-01", "2026-11-30"), /Only an active channel partner/, "a suspended partner");
await refuses(() => list(CUSTOMER, "2026-11-01", "2026-11-30"), /Only an active channel partner/, "a customer");
await refuses(() => list(ADMIN, "2026-11-01", "2026-11-30"), /Only an active channel partner/, "the admin uses the admin panel");
await refuses(() => list(null, "2026-11-01", "2026-11-30"), /permission denied|Only an active/, "not signed in");
await refuses(() => list(B_USER, "2026-11-30", "2026-11-01"), /before the start/, "dates the wrong way round");
await refuses(() => list(B_USER, "2025-01-01", "2026-11-30"), /about a year/, "too long a period");

// ---------------------------------------------------------------- one invoice, customer copy only
const one = (user, no) => as(user, async () => (await q("SELECT public.partner_invoice_order($1) AS j", [no]))[0].j);
const doc = await one(B_USER, "GB-T3");
assert.equal(doc.order.order_no, "GB-T3");
assert.equal(doc.order.customer_name, "TEST Customer");
assert.equal(doc.order.shipping_address.pin, "577522");
assert.equal(doc.items.length, 1);
assert.equal(doc.items[0].product_name, "TEST Rice");
assert.deepEqual([doc.items[0].hsn, doc.items[0].unit, doc.items[0].weight], ["1006", "bag", "25 kg"], "HSN, unit and pack from the catalogue");
assert.equal(doc.zoho.invoice_number, "INV-000777");
assert.equal(doc.payments[0].txn_ref, "531200000001");
const keys = new Set([...Object.keys(doc.order), ...Object.keys(doc.items[0]), ...Object.keys(doc.payments[0])]);
for (const secret of ["user_id", "vendor", "vendor_id", "vendor_ids", "unit_cost", "batch_code", "line_total", "zoho_salesorder_id"]) assert.ok(!keys.has(secret), `no ${secret}`);
assert.ok(!JSON.stringify(doc).includes("House seller") && !JSON.stringify(doc).includes("purchasePrice"), "no vendor or cost anywhere");
await refuses(() => one(B_USER, "GB-T1"), /not one of your godown/, "B opens A's order");
await refuses(() => one(B_USER, "GB-T4"), /not one of your godown/, "B opens an order from the gap");
await refuses(() => one(B_USER, "GB-T5"), /not one of your godown/, "B opens Hubli's order");
await refuses(() => one(B_USER, "GB-T6"), /not one of your godown/, "a checkout request");
await refuses(() => one(H_USER, "GB-T3"), /not one of your godown/, "H opens Challakere's order");
await refuses(() => one(B_USER, "GB-NONE"), /not one of your godown/, "an unknown number");
await refuses(() => one(CUSTOMER, "GB-T1"), /Only an active channel partner/, "a customer");
await refuses(() => one(A_USER, "GB-T1"), /Only an active channel partner/, "A after leaving");

// The helpers cannot be called from the site.
await refuses(() => as(B_USER, () => q("SELECT private.order_signing_partner($1)", [O1])), /permission denied/, "private helper");
await refuses(() => as(B_USER, () => q("SELECT private.godown_partner_at('BR-CLK', now())")), /permission denied/, "private helper");

// ---------------------------------------------------------------- A comes back
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE id = $1", [B]);
await q("UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'suspended'", [B, at(8, "09:00")]);
await q("UPDATE public.channel_partners SET status = 'active' WHERE id = $1", [A]);
await q("UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'reactivated'", [A, at(8, "10:00")]);
const O9 = await order("GB-T9", { placed: at(9) });
assert.equal(await signer(O9), A, "reactivated: A signs again");
assert.equal(await signer(O3), B, "B's orders stay B's");
assert.deepEqual((await list(A_USER, "2026-11-01", "2026-11-30")).map((r) => r.order_no), ["GB-T9", "GB-T2", "GB-T1"], "A sees both of their times, not B's");
assert.equal(await sig(A_USER, "GB-T1"), "partners/A/sig.png");
await refuses(() => list(B_USER, "2026-11-01", "2026-11-30"), /Only an active channel partner/, "B after leaving");
void O5; void O6; void O8;

console.log("partner invoices OK");
