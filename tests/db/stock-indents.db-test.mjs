// Real-Postgres check of 20261113100000_stock_indents_and_login_email_owner.sql, on PGlite with every migration in the
// repo and small stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/stock-indents.db-test.mjs
//
// It must end with "stock indents OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  -- What Supabase does for every new table and function: the migration has to take it back itself.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
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
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
  CREATE PUBLICATION supabase_realtime;
`);
const migrations = join(root, "supabase", "migrations");
for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migrations, file), "utf8"));
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);
/** Runs as a signed-in user under the real role, so table rights and row rules apply. */
const asUser = async (uid, sql, params) => {
  await as(uid);
  await db.exec(`SET ROLE authenticated`);
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE`); }
};
const asRole = async (role, sql, params) => {
  await as(null);
  await db.exec(`SET ROLE ${role}`);
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE`); }
};

// ---------------------------------------------------------------- people and godowns (all made up)
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = EXCLUDED.name");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = EXCLUDED.name");
const user = async (email, fullName) => {
  const uid = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)`, [uid, email, JSON.stringify({ full_name: fullName })]);
  return uid;
};
const ADMIN = await user("admin@test.local", "TEST Admin");
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await q(`UPDATE public.profiles SET full_name = 'TEST Admin' WHERE id = $1`, [ADMIN]);
const CUSTOMER = await user("Shopper.Test@Gmail.com", "TEST Shopper");
const A_USER = await user("pa@test.local", "Partner A");
const H_USER = await user("ph@test.local", "Partner H");
const OLD_USER = await user("old@test.local", "Old Partner");
for (const uid of [A_USER, H_USER, OLD_USER]) await q(`DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'customer'`, [uid]);
const OLD = (await one(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ($1,'BR-CLK','Old Partner','old@test.local','9000000009') RETURNING id`, [OLD_USER])).id;
await q(`UPDATE public.channel_partners SET status = 'suspended' WHERE id = $1`, [OLD]);
const A = (await one(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ($1,'BR-CLK','Partner A','pa@test.local','9000000001') RETURNING id`, [A_USER])).id;
await one(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ($1,'BR-HBL','Partner H','ph@test.local','9000000003') RETURNING id`, [H_USER]);

const touched = async () => ({
  orders: (await one(`SELECT count(*)::int AS n FROM public.orders`)).n,
  outbox: (await one(`SELECT count(*)::int AS n FROM public.zoho_sync_outbox`)).n,
  products: (await one(`SELECT md5(COALESCE(string_agg(to_jsonb(c)::text, ',' ORDER BY id), '')) AS h FROM public.catalog_products c`)).h,
  stock: (await one(`SELECT md5(COALESCE(string_agg(to_jsonb(s)::text, ',' ORDER BY 1), '')) AS h FROM public.branch_stock s`).catch(() => ({ h: "no table" }))).h,
});
const before = await touched();

// ---------------------------------------------------------------- a partner raises a requirement
const raise = (uid, lines, notes = "", neededBy = null) =>
  asUser(uid, `SELECT public.partner_raise_stock_indent($1::jsonb, $2, $3::date) AS no`, [JSON.stringify(lines), notes, neededBy]).then((rows) => rows[0].no);
const tomorrow = (await one(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS d`)).d;
const first = await raise(A_USER, [
  { product_name: "TEST Sona Masoori rice 26 kg", quantity: 40, unit: "bags", grade: "Steam, 1 year old", remarks: "Same lot as last time" },
  { product_id: "NOT-A-PRODUCT", product_name: "TEST Sunflower oil 1 L", quantity: 12.5, unit: "units", grade: "", remarks: "" },
], "TEST Diwali rush; second floor is free", tomorrow);
assert.match(first, /^IND-\d{6}-\d{4}$/);
const head = await one(`SELECT branch_id, partner_id, partner_name, status, notes, needed_by::text AS needed FROM public.stock_indents WHERE indent_no = $1`, [first]);
assert.deepEqual([head.branch_id, head.partner_id, head.partner_name, head.status, head.notes, head.needed], ["BR-CLK", A, "Partner A", "new", "TEST Diwali rush; second floor is free", tomorrow]);
const lines = await q(`SELECT line_no, product_id, product_name, quantity::text AS qty, unit, grade, remarks FROM public.stock_indent_lines l JOIN public.stock_indents i ON i.id = l.indent_id WHERE i.indent_no = $1 ORDER BY line_no`, [first]);
assert.deepEqual(lines.map((l) => [l.line_no, l.product_id, l.product_name, l.qty, l.unit, l.grade]), [
  [1, null, "TEST Sona Masoori rice 26 kg", "40.00", "bags", "Steam, 1 year old"],
  [2, null, "TEST Sunflower oil 1 L", "12.50", "units", ""],
], "an unknown product id is dropped and the typed name kept");
assert.match((await one(`SELECT message FROM public.notifications WHERE recipient_id = $1 AND title = 'Stock requirement from a channel partner'`, [ADMIN])).message,
  new RegExp(`Partner A \\(Challakere Godown\\) asked for stock: 2 products, request ${first}\\. Needed by `));
assert.equal((await one(`SELECT count(*)::int AS n FROM public.stock_indent_events e JOIN public.stock_indents i ON i.id = e.indent_id WHERE i.indent_no = $1 AND e.event = 'raised' AND e.by_role = 'partner'`, [first])).n, 1);

// What a request must have.
const refuse = async (lines, pattern, notes = "", neededBy = null, uid = A_USER) => assert.rejects(raise(uid, lines, notes, neededBy), pattern);
await refuse([], /Add at least one product/);
await refuse(Array.from({ length: 31 }, () => ({ product_name: "x", quantity: 1, unit: "bags" })), /At most 30 products/);
await refuse([{ product_name: "  ", quantity: 1, unit: "bags" }], /Line 1: choose or type the product/);
await refuse([{ product_name: "Rice", quantity: 1, unit: "bags" }, { product_name: "Oil", quantity: 0, unit: "units" }], /Line 2: the quantity must be more than 0/);
await refuse([{ product_name: "Rice", quantity: "ten", unit: "bags" }], /Line 1: enter the quantity as a number/);
await refuse([{ product_name: "Rice", quantity: 100001, unit: "bags" }], /too large/);
await refuse([{ product_name: "Rice", quantity: 5, unit: "kg" }], /Line 1: choose bags or units/);
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags", remarks: "r".repeat(301) }], /remarks under 300/);
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags" }], /needed by/, "", "2020-01-01");
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags" }], /under 1,000 characters/, "n".repeat(1001));
// A failed request leaves nothing half-made.
assert.equal((await one(`SELECT count(*)::int AS n FROM public.stock_indents`)).n, 1);
// Only an active channel partner may ask.
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags" }], /Only an active channel partner/, "", null, CUSTOMER);
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags" }], /Only an active channel partner/, "", null, OLD_USER);
await refuse([{ product_name: "Rice", quantity: 5, unit: "bags" }], /Only an active channel partner/, "", null, ADMIN);
await assert.rejects(asRole("anon", `SELECT public.partner_raise_stock_indent('[{"product_name":"x","quantity":1,"unit":"bags"}]'::jsonb)`), /permission denied/);

const second = await raise(A_USER, [{ product_name: "TEST S-30 sugar 50 kg", quantity: 100, unit: "bags" }]);
const hubli = await raise(H_USER, [{ product_name: "TEST Toor dal 30 kg", quantity: 20, unit: "bags", grade: "Bold" }]);
assert.notEqual(first, second);

// ---------------------------------------------------------------- who sees what; nobody writes directly
const seen = async (uid) => (await asUser(uid, `SELECT indent_no FROM public.stock_indents ORDER BY indent_no`)).map((r) => r.indent_no);
assert.deepEqual(await seen(ADMIN), [first, second, hubli].sort());
assert.deepEqual(await seen(A_USER), [first, second].sort());
assert.deepEqual(await seen(H_USER), [hubli]);
assert.deepEqual(await seen(CUSTOMER), []);
assert.deepEqual(await seen(OLD_USER), [], "a suspended partner sees nothing");
assert.equal((await asUser(H_USER, `SELECT count(*)::int AS n FROM public.stock_indent_lines`))[0].n, 1);
assert.equal((await asUser(A_USER, `SELECT count(*)::int AS n FROM public.stock_indent_lines`))[0].n, 3);
assert.equal((await asUser(CUSTOMER, `SELECT count(*)::int AS n FROM public.stock_indent_events`))[0].n, 0);
await assert.rejects(asRole("anon", `SELECT count(*) FROM public.stock_indents`), /permission denied/);
await assert.rejects(asUser(A_USER, `UPDATE public.stock_indents SET status = 'arranged'`), /permission denied/);
await assert.rejects(asUser(A_USER, `INSERT INTO public.stock_indents (indent_no, branch_id) VALUES ('IND-X', 'BR-CLK')`), /permission denied/);
await assert.rejects(asUser(A_USER, `DELETE FROM public.stock_indent_lines`), /permission denied/);
await assert.rejects(asUser(ADMIN, `UPDATE public.stock_indents SET status = 'arranged'`), /permission denied/, "admins change it only through the status function");

// ---------------------------------------------------------------- the partner cancels while New
await assert.rejects(asUser(H_USER, `SELECT public.partner_cancel_stock_indent($1, 'x')`, [second]), /Stock requirement not found/);
await assert.rejects(asUser(CUSTOMER, `SELECT public.partner_cancel_stock_indent($1, 'x')`, [second]), /Only an active channel partner/);
await asUser(A_USER, `SELECT public.partner_cancel_stock_indent($1, 'TEST ordered twice by mistake')`, [second]);
const cancelled = await one(`SELECT status, status_note, status_changed_by_name FROM public.stock_indents WHERE indent_no = $1`, [second]);
assert.deepEqual([cancelled.status, cancelled.status_note, cancelled.status_changed_by_name], ["cancelled", "TEST ordered twice by mistake", "Partner A"]);
await assert.rejects(asUser(A_USER, `SELECT public.partner_cancel_stock_indent($1, '')`, [second]), /already seen this requirement \(Cancelled\)/);
assert.match((await one(`SELECT message FROM public.notifications WHERE recipient_id = $1 AND title = 'Stock requirement cancelled'`, [ADMIN])).message, /Partner A cancelled stock requirement .* Reason: TEST ordered twice by mistake/);

// ---------------------------------------------------------------- head office moves it on; then the partner cannot cancel
await assert.rejects(asUser(A_USER, `SELECT public.admin_set_stock_indent_status($1, 'arranged', '')`, [first]), /Administrator access is required/);
await assert.rejects(asUser(ADMIN, `SELECT public.admin_set_stock_indent_status($1, 'shipped', '')`, [first]), /Unknown status/);
await assert.rejects(asUser(ADMIN, `SELECT public.admin_set_stock_indent_status('IND-000000-9999', 'seen', '')`), /not found/);
await asUser(ADMIN, `SELECT public.admin_set_stock_indent_status($1, 'seen', '')`, [first]);
await assert.rejects(asUser(A_USER, `SELECT public.partner_cancel_stock_indent($1, '')`, [first]), /already seen this requirement \(Seen\)/);
await asUser(ADMIN, `SELECT public.admin_set_stock_indent_status($1, 'arranged', 'TEST Lorry leaves Davangere on Friday')`, [first]);
await asUser(ADMIN, `SELECT public.admin_set_stock_indent_status($1, 'arranged', 'TEST Lorry leaves Davangere on Friday')`, [first]); // same again: no new history
const arranged = await one(`SELECT status, status_note, status_changed_by_name FROM public.stock_indents WHERE indent_no = $1`, [first]);
assert.deepEqual([arranged.status, arranged.status_note, arranged.status_changed_by_name], ["arranged", "TEST Lorry leaves Davangere on Friday", "TEST Admin"]);
const history = await asUser(A_USER, `SELECT e.event, e.by_role, e.by_name FROM public.stock_indent_events e JOIN public.stock_indents i ON i.id = e.indent_id WHERE i.indent_no = $1 ORDER BY e.id`, [first]);
assert.deepEqual(history.map((e) => `${e.event}/${e.by_role}/${e.by_name}`), ["raised/partner/Partner A", "seen/admin/TEST Admin", "arranged/admin/TEST Admin"], "the partner sees the history too");
// Head office can put one back to New, and the partner may then cancel it again.
await asUser(ADMIN, `SELECT public.admin_set_stock_indent_status($1, 'new', 'TEST put back by mistake')`, [hubli]);
await asUser(H_USER, `SELECT public.partner_cancel_stock_indent($1, '')`, [hubli]);

// ---------------------------------------------------------------- a request touches nothing else
assert.deepEqual(await touched(), before, "no order, stock, product or Zoho queue row changed");

// ---------------------------------------------------------------- who already signs in with an email (server only)
const owner = async (email) => (await asRole("service_role", `SELECT public.login_email_owner($1) AS o`, [email]))[0].o;
assert.deepEqual(await owner("shopper.test@gmail.com"), { user_id: CUSTOMER, name: "TEST Shopper", kind: "customer", partner_status: null }, "case does not matter");
assert.deepEqual(await owner("  PA@test.local "), { user_id: A_USER, name: "Partner A", kind: "channel_partner", partner_status: "active" });
assert.equal((await owner("old@test.local")).partner_status, "suspended");
assert.equal((await owner("admin@test.local")).kind, "admin");
assert.equal(await owner("nobody@test.local"), null);
assert.equal(await owner(""), null);
await assert.rejects(asUser(ADMIN, `SELECT public.login_email_owner('pa@test.local')`), /permission denied/, "not even an admin's browser can ask");
await assert.rejects(asRole("anon", `SELECT public.login_email_owner('pa@test.local')`), /permission denied/);

console.log("stock indents OK");
