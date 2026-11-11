// Real-Postgres check of 20261112170000_panel_favourites.sql (each person's favourite pages and buttons), on PGlite
// with every migration in the repo and small stand-ins for what Supabase provides. Touches nothing live. Not part of
// test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/panel-favourites.db-test.mjs
//
// It must end with "panel favourites OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261112170000_panel_favourites.sql";

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
// Twice: the migration can run again without harm.
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ADMIN = uid("a1"), PARTNER = uid("b1"), STAFF = uid("e1");
await q(`INSERT INTO auth.users (id, email) SELECT u, u::text || '@test.local' FROM unnest($1::uuid[]) u`, [[ADMIN, PARTNER, STAFF]]);

async function as(user, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [user]);
  await db.exec(`SET ROLE ${user ? "authenticated" : "anon"}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const fails = async (fn, pattern, why) => {
  let error = null;
  try { await fn(); } catch (cause) { error = cause; }
  assert.ok(error, `should be refused: ${why}`);
  if (pattern) assert.match(String(error.message), pattern, why);
};
const add = (user, panel, key, to, find = "", position = 0) => as(user, () => q(
  "INSERT INTO public.panel_favourites (user_id, panel, item_key, label, to_path, find_text, position) VALUES ($1, $2, $3, $4, $5, $6, $7)",
  [user, panel, key, key, to, find, position]));

// ---- each person keeps their own
await add(ADMIN, "admin", "/admin/attendance#Add employee", "/admin/attendance", "Add employee");
await add(ADMIN, "admin", "/admin/orders", "/admin/orders");
await add(PARTNER, "partner", "/partner#Customer invoices", "/partner", "Customer invoices");
assert.equal((await as(ADMIN, () => q("SELECT * FROM public.panel_favourites"))).length, 2, "the admin sees only their own");
assert.equal((await as(PARTNER, () => q("SELECT * FROM public.panel_favourites"))).length, 1, "the partner sees only their own");
assert.equal((await as(STAFF, () => q("SELECT * FROM public.panel_favourites"))).length, 0, "the staff member sees none of the others'");
assert.equal((await as(null, () => q("SELECT * FROM public.panel_favourites").catch(() => []))).length, 0, "signed out: nothing");

// ---- nobody adds, changes or removes another person's
await fails(() => add(STAFF, "admin", "/admin/x", "/admin/x").then(() => as(STAFF, () => q("INSERT INTO public.panel_favourites (user_id, panel, item_key, label, to_path) VALUES ($1, 'admin', 'k', 'k', '/admin')", [ADMIN]))), null, "a row in someone else's name");
const changed = await as(STAFF, () => q("UPDATE public.panel_favourites SET label = 'hacked' WHERE user_id = $1 RETURNING id", [ADMIN]));
assert.equal(changed.length, 0, "another person's rows cannot be changed");
const removed = await as(STAFF, () => q("DELETE FROM public.panel_favourites WHERE user_id = $1 RETURNING id", [ADMIN]));
assert.equal(removed.length, 0, "another person's rows cannot be removed");
assert.equal((await q("SELECT count(*)::int AS n FROM public.panel_favourites WHERE user_id = $1", [ADMIN]))[0].n, 2);
await fails(() => as(null, () => q("INSERT INTO public.panel_favourites (user_id, panel, item_key, label, to_path) VALUES ($1, 'admin', 'k', 'k', '/admin')", [ADMIN])), null, "signed out");

// ---- only this site's addresses, known panels, no repeats
await fails(() => add(ADMIN, "admin", "evil", "https://evil.example/x"), /check/i, "another site");
await fails(() => add(ADMIN, "admin", "evil2", "//evil.example/x"), /check/i, "another site without https");
await fails(() => add(ADMIN, "admin", "evil3", "/admin/x?y=<script>"), /check/i, "odd characters");
await fails(() => add(ADMIN, "boss", "/admin", "/admin"), /check/i, "unknown panel");
await fails(() => add(ADMIN, "admin", "/admin/orders", "/admin/orders"), /duplicate|unique/i, "the same favourite twice");

// ---- 40 per person and panel; saving the order again still works at 40
for (let i = 0; i < 38; i += 1) await add(STAFF, "staff", `/staff#Item ${i}`, "/staff", `Item ${i}`, i);
await add(STAFF, "staff", "/staff", "/staff", "", 38);
await add(STAFF, "staff", "/slip", "/slip", "", 39);
await fails(() => add(STAFF, "staff", "/staff/device", "/staff/device"), /up to 40/, "the 41st");
const resaved = await as(STAFF, () => q(
  "INSERT INTO public.panel_favourites (user_id, panel, item_key, label, to_path, find_text, position) VALUES ($1, 'staff', '/slip', '/slip', '/slip', '', 0) ON CONFLICT (user_id, panel, item_key) DO UPDATE SET position = EXCLUDED.position RETURNING position",
  [STAFF]));
assert.equal(resaved[0].position, 0, "moving one at 40 is a save, not a 41st");
// The same person's other panel has its own 40.
await add(STAFF, "customer", "/account/orders", "/account/orders");
// Changing a row in place at 40 still works (a new key, a new place).
const renamed = await as(STAFF, () => q("UPDATE public.panel_favourites SET item_key = '/staff#Renamed', find_text = 'Renamed' WHERE user_id = $1 AND item_key = '/staff#Item 0' RETURNING item_key", [STAFF]));
assert.equal(renamed[0].item_key, "/staff#Renamed");
// Moving a row into a full panel is a 41st there: refused.
await add(STAFF, "admin", "/admin/a", "/admin/a");
await fails(() => as(STAFF, () => q("UPDATE public.panel_favourites SET panel = 'staff' WHERE user_id = $1 AND item_key = '/admin/a'", [STAFF])), /up to 40/, "moved into a full panel");

// ---- no peeking at someone else's (review, 12 Nov 2026): the 40 check runs with the caller's own rights, so a row in
// someone else's name is refused by the policy the same way whether or not that person has the favourite or is full.
const refusal = async (key) => {
  try {
    await as(ADMIN, () => q("INSERT INTO public.panel_favourites (user_id, panel, item_key, label, to_path) VALUES ($1, 'staff', $2, 'x', '/staff')", [STAFF, key]));
  } catch (error) {
    return `${error.code ?? ""} ${String(error.message).replace(/"[^"]*"/g, "")}`;
  }
  return "allowed";
};
const known = await refusal("/slip");
const unknown = await refusal("/staff#Not there");
assert.equal(known, unknown, "the same answer either way");
assert.match(known, /row-level security|42501/i, "refused by the policy, not by the 40 check");
assert.doesNotMatch(known, /up to 40/);
const fn = await q("SELECT prosecdef FROM pg_proc WHERE proname = 'panel_favourites_cap'");
assert.equal(fn[0].prosecdef, false, "the check runs with the caller's rights");

// ---- gone with the person
await q("DELETE FROM auth.users WHERE id = $1", [PARTNER]);
assert.equal((await q("SELECT count(*)::int AS n FROM public.panel_favourites WHERE user_id = $1", [PARTNER]))[0].n, 0);

console.log("panel favourites OK");
