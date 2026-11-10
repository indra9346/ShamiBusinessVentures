// Two people scanning one slip at the same moment, on a real PostgreSQL server with many connections (PGlite has
// only one, so it can't show this). Builds a throwaway database from every migration in the repo, with small
// stand-ins for what Supabase provides, and drops it at the end. Never point it at a live database.
//
//   PG_URL=postgres://postgres@localhost:54399/postgres PG_MODULES=<node_modules folder holding pg> node tests/db/delivery-paper-race.pg-test.mjs
//
// It must end with "delivery paper race OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const adminUrl = process.env.PG_URL;
const modules = process.env.PG_MODULES;
if (!adminUrl || !modules) throw new Error("Set PG_URL (a throwaway server) and PG_MODULES (a node_modules folder holding pg)");
if (/supabase\.co|pooler\.supabase|grainbazar/i.test(adminUrl)) throw new Error("This test creates and drops databases: never point it at a live server");
const pg = (await import(pathToFileURL(join(modules, "pg/lib/index.js")).href)).default;

const dbName = `gb_race_${Date.now()}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const connect = async () => { const client = new pg.Client({ connectionString: url.toString() }); await client.connect(); return client; };
const db = await connect();

try {
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
    END $$;
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
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
    CREATE PUBLICATION supabase_realtime;
  `);
  const dir = join(root, "supabase", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    try { await db.query(readFileSync(join(dir, file), "utf8")); } catch (error) { throw new Error(`${file}: ${error.message}`); }
  }

  const q = async (text, params) => (await db.query(text, params)).rows;
  const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
  const ADMIN = uid("a1"), CUSTOMER = uid("c1"), CLK1 = uid("e1"), CLK2 = uid("e2");
  await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${CLK1}','e1@test.local'),('${CLK2}','e2@test.local') ON CONFLICT DO NOTHING`);
  await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${CLK1}','${CLK2}')`);
  await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
  await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true");
  await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${CLK1}','BR-CLK','Ravi','9000000011'),('${CLK2}','BR-CLK','Suma','9000000012')`);
  for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
  const zoho = (n) => JSON.stringify({ read: true, live_invoices: 1, invoice_id: `INV-${n}`, invoice_number: `CLKINV-${n}`, status: "paid", total: 1000, balance: 0, payment_made: 1000 });
  const notes = {};
  for (const n of [1, 2]) {
    const id = (await q(`INSERT INTO public.orders (order_no, user_id, customer_name, total, subtotal, paid_amount, payment_status, payment_method, order_status, branch_id, shipping_method, shipping_address)
      VALUES ($1,$2,'TEST',1000,1000,1000,'Paid','UPI','Payment Confirmed','BR-CLK','Standard','{}') RETURNING id`, [`TEST-RACE-${n}`, CUSTOMER]))[0].id;
    await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, created_at) VALUES
      ($1,'P1','TEST Rice',2,300,600,'2026-11-10T10:00:00Z'),($1,'P2','TEST Oil',2,100,200,'2026-11-10T10:00:01Z'),($1,'P3','TEST Sugar',1,200,200,'2026-11-10T10:00:02Z')`, [id]);
    await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'full',1000,'UPI','Paid',$3)", [id, CUSTOMER, `UTRRACE${n}000000000`]);
    await q("INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, invoice_number, status, total, balance) VALUES ($1,$2,$3,$4,'paid',1000,0)", [id, `TEST-RACE-${n}`, `INV-${n}`, `CLKINV-${n}`]);
    await q("SET ROLE service_role");
    const issued = (await q("SELECT public.issue_delivery_note($1,$2,$3,'Office') AS r", [`TEST-RACE-${n}`, zoho(n), ADMIN]))[0].r;
    assert.equal(issued.issued, true, JSON.stringify(issued));
    const printed = (await q("SELECT public.record_delivery_print($1,true,'{1,2,3}',$2,$3,'Office') AS r", [issued.note_id, zoho(n), ADMIN]))[0].r;
    await q("RESET ROLE");
    notes[n] = { id: issued.note_id, order: id, note: printed.note_code, slips: printed.slip_codes };
  }
  for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);

  const handover = async (client, code, actor, n = 1, lines = null) =>
    (await client.query("SELECT public.delivery_paper_scan($1,true,$2,$3,$4) AS r", [code, zoho(n), actor, lines])).rows[0].r.result;
  const handedOver = async (noteId, line) =>
    (await q("SELECT count(*)::int AS c FROM public.delivery_handovers h WHERE h.note_id = $1 AND h.slip_line = $2 AND NOT EXISTS (SELECT 1 FROM public.delivery_handover_reopens r WHERE r.handover_id = h.id)", [noteId, line]))[0].c;

  // ---- 1. Twenty people scan slip 1 at the same instant: exactly one green.
  const clients = await Promise.all(Array.from({ length: 20 }, connect));
  await Promise.all(clients.map((client) => client.query("SET ROLE service_role")));
  const actors = [CLK1, CLK2, ADMIN];
  const results = await Promise.all(clients.map((client, i) => handover(client, notes[1].slips["1"], actors[i % 3])));
  assert.equal(results.filter((r) => r === "handed_over").length, 1, results.join());
  assert.equal(results.filter((r) => r === "already_handed_over").length, 19, results.join());
  assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1 AND slip_line = 1", [notes[1].id]))[0].c, 1);

  // ---- 2. Half tick items 2 and 3 on the note, half scan slip 3, all at once: one of them wins, the note's ticks are
  // all or nothing, and item 3 goes once.
  const mixed = await Promise.all(clients.map((client, i) => (i % 2 ? handover(client, notes[1].note, actors[i % 3], 1, [2, 3]) : handover(client, notes[1].slips["3"], actors[i % 3]))));
  assert.equal(mixed.filter((r) => r === "handed_over").length, 1, mixed.join());
  assert.ok(mixed.every((r) => ["handed_over", "already_handed_over", "partly_handed_over"].includes(r)), mixed.join());
  assert.equal(await handedOver(notes[1].id, 3), 1);
  const noteWon = (await handedOver(notes[1].id, 2)) === 1;
  // If a slip won, every note scan saw item 3 gone and recorded nothing.
  if (!noteWon) assert.ok(mixed.filter((r, i) => i % 2).every((r) => r === "partly_handed_over"), mixed.join());

  // ---- 3. The last item, twenty at once: the order is marked Delivered once, and queued for Zoho.
  if (!noteWon) {
    const last = await Promise.all(clients.map((client, i) => (i % 2 ? handover(client, notes[1].note, actors[i % 3], 1, [2]) : handover(client, notes[1].slips["2"], actors[i % 3]))));
    assert.equal(last.filter((r) => r === "handed_over").length, 1, last.join());
  }
  assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [notes[1].order]))[0].order_status, "Delivered");
  assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_scans WHERE note_id = $1 AND order_delivered", [notes[1].id]))[0].c, 1, "marked Delivered once");
  assert.ok((await q("SELECT count(*)::int AS c FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [notes[1].order]))[0].c >= 1);

  // ---- 4. One handover still open (not committed): a second one waits for it, then is refused.
  const [a, b] = clients;
  await a.query("BEGIN");
  assert.equal(await handover(a, notes[2].slips["1"], CLK1, 2), "handed_over");
  const started = Date.now();
  const waiting = handover(b, notes[2].slips["1"], CLK2, 2).then((result) => ({ result, waited: Date.now() - started }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await a.query("COMMIT");
  const second = await waiting;
  assert.equal(second.result, "already_handed_over");
  assert.ok(second.waited >= 1400, `the second scan waited ${second.waited} ms for the first`);

  // ---- 5. A duplicate printed while the original is being scanned: the original still works, the duplicate never.
  await a.query("BEGIN");
  const duplicate = (await a.query("SELECT public.record_delivery_print($1,false,'{3}',$2,$3,'Office') AS r", [notes[2].id, zoho(2), ADMIN])).rows[0].r;
  const original3 = handover(b, notes[2].slips["3"], CLK2, 2);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await a.query("COMMIT");
  assert.equal(duplicate.slip_papers["3"].kind, "duplicate");
  assert.equal(await original3, "handed_over", "the original is not cancelled by a reprint");
  assert.equal(await handover(b, duplicate.slip_codes["3"], CLK2, 2), "already_handed_over");

  // ---- 6. A replacement original and a handover of the original it replaces, at the same moment: the old one loses.
  await a.query("BEGIN");
  const replacement = (await a.query("SELECT public.record_delivery_print($1,false,'{2}',$2,$3,'Office','Lost in the godown') AS r", [notes[2].id, zoho(2), ADMIN])).rows[0].r;
  const old = handover(b, notes[2].slips["2"], CLK2, 2);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await a.query("COMMIT");
  assert.equal(replacement.slip_papers["2"].kind, "replacement");
  assert.equal(await old, "replaced", "a handover on the original being replaced is refused");
  assert.equal(await handover(b, replacement.slip_codes["2"], CLK2, 2), "handed_over", "the replacement works");
  assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1", [notes[2].id]))[0].c, 3);
  assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [notes[2].order]))[0].order_status, "Delivered");

  await Promise.all(clients.map((client) => client.end()));
  console.log("delivery paper race OK");
} finally {
  await db.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
  await admin.end();
}
