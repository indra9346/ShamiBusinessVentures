// Real-Postgres check of 20261112160000_zoho_contact_numbers.sql, on PGlite with every migration in the repo and small
// stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a dependency
// of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/zoho-contact-numbers.db-test.mjs
//
// It must end with "zoho contact numbers OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261112160000_zoho_contact_numbers.sql";

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

const q = async (text, params) => (await db.query(text, params)).rows;
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), OTHER = uid("c2"), VENDOR = uid("d1"), PARTNER = uid("b1"), H_USER = uid("b2");
const at = (day, time = "10:00") => `2026-11-${String(day).padStart(2, "0")}T${time}:00+05:30`;

// Everything before this migration, with links made the way the website made them until now.
for (const file of files.filter((file) => file !== MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${OTHER}','o@test.local'),
  ('${VENDOR}','v@test.local'),('${PARTNER}','p@test.local'),('${H_USER}','h@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${OTHER}','${VENDOR}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer'),('${OTHER}','customer'),('${VENDOR}','vendor')`);
await q("ALTER TABLE public.profiles DISABLE TRIGGER USER");
await q(`UPDATE public.profiles SET vendor_id = 'V9' WHERE id = '${VENDOR}'`);
await q("ALTER TABLE public.profiles ENABLE TRIGGER USER");
await q(`INSERT INTO public.zoho_contact_links (user_id, contact_type, zoho_contact_id, updated_at, last_polled_at, last_zoho_modified_at) VALUES
  ('${CUSTOMER}','customer','zc-1',$1,$1,$1), ('${OTHER}','customer','zc-2',$1,$1,$1), ('${VENDOR}','vendor','zv-1',$1,$1,$1)`, [at(1)]);
const before = await q("SELECT * FROM public.zoho_contact_links ORDER BY zoho_contact_id");

await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
// Run twice: the migration must be safe to apply again.
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));

// ---------------------------------------------------------------- the columns, and nothing existing changed
const after = await q("SELECT * FROM public.zoho_contact_links ORDER BY zoho_contact_id");
assert.equal(after.length, before.length);
after.forEach((row, index) => {
  const { zoho_contact_number, zoho_contact_number_checked_at, ...rest } = row;
  assert.deepEqual(rest, before[index], "existing link unchanged");
  assert.equal(zoho_contact_number, null);
  assert.equal(zoho_contact_number_checked_at, null);
});
const refuses = async (fn, pattern, label) => {
  let message = "";
  try { await fn(); } catch (error) { message = error.message; }
  assert.match(message, pattern, `${label}: expected a refusal, got "${message}"`);
};
await refuses(() => q(`UPDATE public.zoho_contact_links SET zoho_contact_number = '' WHERE user_id = '${CUSTOMER}'`), /zoho_contact_links_number_length/, "an empty number");
await refuses(() => q(`UPDATE public.zoho_contact_links SET zoho_contact_number = $1 WHERE user_id = '${CUSTOMER}'`, ["X".repeat(51)]), /zoho_contact_links_number_length/, "51 characters");
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = $1, zoho_contact_number_checked_at = now() WHERE user_id = '${CUSTOMER}'`, ["X".repeat(50)]);
// What the website saves after reading Zoho (contactNumberUpdate).
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = 'CUS-00012', zoho_contact_number_checked_at = now() WHERE user_id = '${CUSTOMER}'`);
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = 'CUS-00013', zoho_contact_number_checked_at = now() WHERE user_id = '${OTHER}'`);
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = 'VEN-007', zoho_contact_number_checked_at = now() WHERE user_id = '${VENDOR}'`);

async function as(user, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec("SET ROLE " + (user ? "authenticated" : "anon"));
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}

// ---------------------------------------------------------------- the table stays closed
await refuses(() => as(CUSTOMER, () => q("SELECT zoho_contact_number FROM public.zoho_contact_links")), /permission denied/, "a customer reads the table");
await refuses(() => as(ADMIN, () => q("SELECT zoho_contact_number FROM public.zoho_contact_links")), /permission denied/, "even an admin reads it through the function");
await refuses(() => as(CUSTOMER, () => q(`UPDATE public.zoho_contact_links SET zoho_contact_number = 'FAKE' WHERE user_id = '${CUSTOMER}'`)), /permission denied/, "a customer sets a number");

// ---------------------------------------------------------------- everyone's numbers for an admin, one's own for the rest
const numbers = (user) => as(user, () => q("SELECT * FROM public.zoho_contact_numbers()"));
const adminRows = await numbers(ADMIN);
assert.deepEqual(adminRows.map((r) => [r.user_id, r.vendor_id, r.contact_type, r.contact_number]), [
  [CUSTOMER, null, "customer", "CUS-00012"],
  [OTHER, null, "customer", "CUS-00013"],
  [VENDOR, "V9", "vendor", "VEN-007"],
]);
assert.deepEqual((await numbers(CUSTOMER)).map((r) => r.contact_number), ["CUS-00012"], "a customer sees only their own");
assert.deepEqual((await numbers(OTHER)).map((r) => r.contact_number), ["CUS-00013"]);
assert.deepEqual((await numbers(VENDOR)).map((r) => [r.vendor_id, r.contact_number]), [["V9", "VEN-007"]], "a vendor their own vendor number");
assert.deepEqual(await numbers(PARTNER), [], "a partner has no contact of their own");
await refuses(() => numbers(null), /permission denied/, "not signed in");
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = NULL WHERE user_id = '${OTHER}'`);
assert.deepEqual((await numbers(ADMIN)).map((r) => r.contact_number), ["CUS-00012", "VEN-007"], "no number, no row");
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = 'CUS-00013' WHERE user_id = '${OTHER}'`);

// ---------------------------------------------------------------- the number on an invoice
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ('${PARTNER}','BR-CLK','Partner B','p@test.local','9000000002',$1)`, [at(1, "09:00")]);
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ('${H_USER}','BR-HBL','Partner H','h@test.local','9000000003',$1)`, [at(1, "09:00")]);
for (const table of ["orders", "order_items", "payments", "zoho_order_invoices"]) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
async function order(no, { branch = "BR-CLK", placed = at(3), status = "Delivered", payment = "Paid", user = CUSTOMER } = {}) {
  return (await q(`INSERT INTO public.orders (order_no, user_id, customer_name, customer_email, customer_phone, total, subtotal, gst_amount, paid_amount,
      payment_status, payment_method, order_status, branch_id, created_at, shipping_address, shipping_method, prices_include_gst, vendor_ids)
    VALUES ($1,$2,'TEST Customer','c@test.local','9000000009',105,100,5,$3,$4,'UPI',$5,$6,$7,$8,'Pickup',true,ARRAY['V9']) RETURNING id`,
    [no, user, payment === "Paid" ? 105 : 0, payment, status, branch, placed, JSON.stringify({ line: "TEST street", city: "Challakere", state: "Karnataka", pin: "577522" })]))[0].id;
}
await order("GB-N1");
await order("GB-N2", { user: OTHER });
await order("GB-N3", { branch: "BR-HBL" });
await order("GB-N4", { status: "Awaiting Payment", payment: "Pending" });
await order("GB-N5", { user: null });

const onInvoice = (user, no) => as(user, async () => (await q("SELECT public.invoice_customer_number($1) AS n", [no]))[0].n);
assert.equal(await onInvoice(CUSTOMER, "GB-N1"), "CUS-00012", "the customer's own invoice");
assert.equal(await onInvoice(ADMIN, "GB-N1"), "CUS-00012", "an admin's copy");
assert.equal(await onInvoice(ADMIN, "GB-N2"), "CUS-00013");
assert.equal(await onInvoice(PARTNER, "GB-N1"), "CUS-00012", "the partner who signs it");
assert.equal(await onInvoice(PARTNER, "GB-N2"), "CUS-00013", "any customer's order at the partner's godown in their time");
assert.equal(await onInvoice(OTHER, "GB-N1"), null, "another customer learns nothing");
assert.equal(await onInvoice(CUSTOMER, "GB-N2"), null);
assert.equal(await onInvoice(VENDOR, "GB-N1"), null, "a vendor's office copy prints none");
assert.equal(await onInvoice(H_USER, "GB-N1"), null, "another godown's partner");
assert.equal(await onInvoice(PARTNER, "GB-N3"), null, "Hubli's order");
assert.equal(await onInvoice(H_USER, "GB-N3"), "CUS-00012", "Hubli's own partner");
assert.equal(await onInvoice(PARTNER, "GB-N4"), null, "a checkout never paid is not the partner's invoice");
assert.equal(await onInvoice(CUSTOMER, "GB-N4"), "CUS-00012", "the customer still sees their own number");
assert.equal(await onInvoice(ADMIN, "GB-N5"), null, "an order without an account");
assert.equal(await onInvoice(ADMIN, "GB-NONE"), null, "an unknown order");
await refuses(() => onInvoice(null, "GB-N1"), /permission denied/, "not signed in");
await q(`UPDATE public.channel_partners SET status = 'suspended', updated_at = now() WHERE user_id = '${PARTNER}'`);
assert.equal(await onInvoice(PARTNER, "GB-N1"), null, "a suspended partner gets nothing");
await q(`UPDATE public.zoho_contact_links SET zoho_contact_number = NULL WHERE user_id = '${CUSTOMER}'`);
assert.equal(await onInvoice(CUSTOMER, "GB-N1"), null, "no number in Zoho: the invoice prints none");

// The functions are executable by signed-in accounts only.
const grants = await q(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS signed_in
  FROM pg_proc p WHERE p.proname IN ('zoho_contact_numbers', 'invoice_customer_number') ORDER BY p.proname`);
assert.deepEqual(grants.map((r) => [r.proname, r.anon, r.signed_in]), [["invoice_customer_number", false, true], ["zoho_contact_numbers", false, true]]);

console.log("zoho contact numbers OK");
