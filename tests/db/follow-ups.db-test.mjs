// Real-Postgres check of 20261106240000_follow_up_tasks.sql, on PGlite with every migration in the repo and small
// stand-ins for what Supabase provides. All data is made up; nothing live is touched. Not part of test:zoho:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/follow-ups.db-test.mjs
//
// It must end with "follow-ups OK".
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
const asServer = async (sql, params) => {
  await as(null);
  await db.exec(`SET ROLE service_role`);
  try { return await one(sql, params); } finally { await db.exec(`RESET ROLE`); }
};
/** Reads as a signed-out visitor, under the real role. */
const asAnon = async (sql, params) => {
  await as(null);
  await db.exec(`SET ROLE anon`);
  try { return await q(sql, params); } finally { await db.exec(`RESET ROLE`); }
};

const ADMIN = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'admin@test.in', '{"full_name":"TEST Admin"}')`, [ADMIN]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
const branch = (await one(`SELECT id FROM public.branches ORDER BY id LIMIT 1`)).id;
const staff = async (name, phone, status = "active") => {
  const uid = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, phone, raw_user_meta_data) VALUES ($1, $2, $3, '{}')`, [uid, `${phone}@staff.test`, phone]);
  const id = (await one(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [uid, branch, name, phone, status])).id;
  return { uid, id };
};
const MANJU = await staff("TEST Manju", "9000000101");
const BASAVA = await staff("TEST Basava", "9000000102");
const LEFT = await staff("TEST Left", "9000000103", "inactive");
const CUSTOMER = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'customer@test.in', '{"full_name":"TEST Customer"}')`, [CUSTOMER]);

// ---------------------------------------------------------------- admins add and see everything
const add = (title, employeeId, dueOn, repeat = "none", kind = "licence_renewal") =>
  asUser(ADMIN, `INSERT INTO public.follow_up_tasks (title, kind, employee_id, branch_id, due_on, repeat_every, remind_days) VALUES ($1, $2, $3, $4, $5, $6, 30) RETURNING id`,
    [title, kind, employeeId, branch, dueOn, repeat]).then((rows) => rows[0].id);
const fssai = await add("TEST Renew the FSSAI licence", MANJU.id, "2027-03-31", "year");
const trade = await add("TEST Trade licence", BASAVA.id, "2026-12-15");
const office = await add("TEST Call the auditor", null, "2026-11-20", "none", "other");
const monthly = await add("TEST Monthly weighbridge check", MANJU.id, "2027-01-31", "month", "maintenance");
const old = await add("TEST Old task", LEFT.id, "2026-12-01");
assert.equal((await asUser(ADMIN, `SELECT count(*)::int AS n FROM public.follow_up_tasks`))[0].n, 5);
await assert.rejects(asUser(ADMIN, `INSERT INTO public.follow_up_tasks (title, due_on) VALUES ('x', '2027-01-01')`), /check constraint/);
await assert.rejects(asUser(ADMIN, `INSERT INTO public.follow_up_tasks (title, due_on, repeat_every) VALUES ('TEST bad', '2027-01-01', 'weekly')`), /check constraint/);

// ---------------------------------------------------------------- nobody else sees them, an employee sees only their own
assert.equal((await asAnon(`SELECT count(*)::int AS n FROM public.follow_up_tasks`).catch(() => [{ n: 0 }]))[0].n, 0);
assert.equal((await asUser(CUSTOMER, `SELECT count(*)::int AS n FROM public.follow_up_tasks`))[0].n, 0);
assert.deepEqual((await asUser(MANJU.uid, `SELECT title FROM public.follow_up_tasks ORDER BY due_on`)).map((r) => r.title), ["TEST Monthly weighbridge check", "TEST Renew the FSSAI licence"]);
assert.deepEqual((await asUser(BASAVA.uid, `SELECT title FROM public.follow_up_tasks`)).map((r) => r.title), ["TEST Trade licence"]);
assert.equal((await asUser(LEFT.uid, `SELECT count(*)::int AS n FROM public.follow_up_tasks`))[0].n, 0, "an employee who left sees nothing");
// Employees cannot add, change or delete tasks themselves.
await assert.rejects(asUser(MANJU.uid, `INSERT INTO public.follow_up_tasks (title, due_on, employee_id) VALUES ('TEST mine', '2027-01-01', $1)`, [MANJU.id]), /row-level security/);
assert.equal((await asUser(MANJU.uid, `UPDATE public.follow_up_tasks SET status = 'done' WHERE id = $1 RETURNING id`, [fssai])).length, 0);
assert.equal((await asUser(MANJU.uid, `DELETE FROM public.follow_up_tasks WHERE id = $1 RETURNING id`, [fssai])).length, 0);
assert.equal((await one(`SELECT status FROM public.follow_up_tasks WHERE id = $1`, [fssai])).status, "open");

// ---------------------------------------------------------------- done by the employee: the next one is made, the admins told
await assert.rejects(asUser(BASAVA.uid, `SELECT public.complete_follow_up_task($1, 'x')`, [fssai]), /not assigned to you/);
await assert.rejects(asUser(CUSTOMER, `SELECT public.complete_follow_up_task($1, 'x')`, [fssai]), /not assigned to you/);
const r1 = (await asUser(MANJU.uid, `SELECT public.complete_follow_up_task($1, 'TEST new licence no. 112233') AS r`, [fssai]))[0].r;
assert.equal(r1.next_due, "2028-03-31");
const done = await one(`SELECT status, done_note, done_by, next_task_id FROM public.follow_up_tasks WHERE id = $1`, [fssai]);
assert.deepEqual([done.status, done.done_note, done.done_by, done.next_task_id], ["done", "TEST new licence no. 112233", MANJU.uid, r1.next_task_id]);
const next = await one(`SELECT title, employee_id, due_on::text AS due, repeat_every, remind_days, status FROM public.follow_up_tasks WHERE id = $1`, [r1.next_task_id]);
assert.deepEqual([next.title, next.employee_id, next.due, next.repeat_every, next.remind_days, next.status], ["TEST Renew the FSSAI licence", MANJU.id, "2028-03-31", "year", 30, "open"]);
assert.match((await one(`SELECT message FROM public.notifications WHERE title = 'Follow-up done' AND recipient_id = $1 ORDER BY created_at DESC LIMIT 1`, [ADMIN])).message, /TEST Manju marked "TEST Renew the FSSAI licence" done: TEST new licence no\. 112233\. Next one due 31 Mar 2028\./);
await assert.rejects(asUser(MANJU.uid, `SELECT public.complete_follow_up_task($1, '')`, [fssai]), /already done/);
assert.ok((await asUser(MANJU.uid, `SELECT id FROM public.follow_up_tasks WHERE id = $1`, [r1.next_task_id])).length === 1, "the employee sees the next one");
// Month ends roll back as in the page's preview (31 Jan + 1 month = 28 Feb).
const r2 = (await asUser(MANJU.uid, `SELECT public.complete_follow_up_task($1) AS r`, [monthly]))[0].r;
assert.equal(r2.next_due, "2027-02-28");

// ---------------------------------------------------------------- done by an admin: no message to themselves
const before = (await one(`SELECT count(*)::int AS n FROM public.notifications WHERE title = 'Follow-up done'`)).n;
const r3 = (await asUser(ADMIN, `SELECT public.complete_follow_up_task($1, 'TEST called') AS r`, [office]))[0].r;
assert.equal(r3.next_task_id, null);
assert.equal((await one(`SELECT count(*)::int AS n FROM public.notifications WHERE title = 'Follow-up done'`)).n, before);
// Cancelled and deleted by an admin.
await asUser(ADMIN, `UPDATE public.follow_up_tasks SET status = 'cancelled' WHERE id = $1`, [trade]);
await assert.rejects(asUser(BASAVA.uid, `SELECT public.complete_follow_up_task($1, '')`, [trade]), /already cancelled/);
assert.equal((await asUser(ADMIN, `DELETE FROM public.follow_up_tasks WHERE id = $1 RETURNING id`, [old])).length, 1);
// An employee removed from the staff list leaves their tasks with the office.
await db.query(`DELETE FROM public.staff_employees WHERE id = $1`, [BASAVA.id]);
assert.equal((await one(`SELECT employee_id FROM public.follow_up_tasks WHERE id = $1`, [trade])).employee_id, null);

console.log("follow-ups OK");
