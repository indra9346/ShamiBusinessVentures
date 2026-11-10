// Real-Postgres check of 20261110120000_delivery_paper_qr.sql (QR codes on delivery notes and slips), on PGlite with
// every migration in the repo and small stand-ins for what Supabase provides. Touches nothing live. Not part of
// test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/delivery-paper-qr.db-test.mjs
//
// It must end with "delivery paper QR OK".
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261110120000_delivery_paper_qr.sql";

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
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), CLK_USER = uid("e1"), HBL_USER = uid("e2"), OFF_USER = uid("e3");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${CLK_USER}','e1@test.local'),('${HBL_USER}','e2@test.local'),('${OFF_USER}','e3@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}','${CLK_USER}','${HBL_USER}','${OFF_USER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q(`INSERT INTO public.profiles (id, full_name, email) VALUES ('${ADMIN}','Office Admin','a@test.local') ON CONFLICT (id) DO UPDATE SET full_name = 'Office Admin'`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Challakere Godown'");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Hubli Godown'");
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${CLK_USER}','BR-CLK','Ravi CLK','9000000011'),('${HBL_USER}','BR-HBL','Hanu HBL','9000000012')`);
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone, status) VALUES ('${OFF_USER}','BR-CLK','Gone CLK','9000000013','inactive')`);

const ZOHO_PAID = (invoice = "INV-1", number = "CLKINV-1", total = 1000) =>
  ({ read: true, live_invoices: 1, invoice_id: invoice, invoice_number: number, status: "paid", total, balance: 0, payment_made: total });

for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
async function paidOrder(no, invoice, number) {
  const row = {
    order_no: no, user_id: CUSTOMER, customer_name: "TEST Customer", total: 1000, subtotal: 1000, paid_amount: 1000, payment_status: "Paid",
    payment_method: "UPI", order_status: "Payment Confirmed", branch_id: "BR-CLK", shipping_method: "Standard",
    shipping_address: JSON.stringify({ name: "TEST Customer", phone: "9000000099", line: "1 Test Street", city: "Challakere", state: "Karnataka", pin: "577522" }),
  };
  const cols = Object.keys(row);
  const id = (await q(`INSERT INTO public.orders (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")}) RETURNING id`, Object.values(row)))[0].id;
  await q("INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, capacity, created_at) VALUES ($1,'P1','TEST Rice 25 kg',2,300,600,'25 kg','2026-11-10T10:00:00Z'),($1,'P2','TEST Oil 1 L',4,100,400,'1 L','2026-11-10T10:00:01Z')", [id]);
  await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'full',1000,'UPI','Paid',$3)", [id, CUSTOMER, `UTR${no.replace(/\W/g, "")}0000000`]);
  await q("INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, invoice_number, status, total, balance) VALUES ($1,$2,$3,$4,'paid',1000,0)", [id, no, invoice, number]);
  return id;
}
const ORDER1 = await paidOrder("TEST-QR-1", "INV-1", "CLKINV-1");
const ORDER2 = await paidOrder("TEST-QR-2", "INV-2", "CLKINV-2");
for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);

const service = async (fn) => {
  await db.exec("SET ROLE service_role");
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
};
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
const one = async (text, params) => (await service(() => q(text, params)))[0].r;
const issue = (no, zoho) => one("SELECT public.issue_delivery_note($1,$2,$3,'Office Admin') AS r", [no, JSON.stringify(zoho), ADMIN]);
const print = (noteId, note, lines, zoho = ZOHO_PAID()) =>
  one("SELECT public.record_delivery_print($1,$2,$3,$4,$5,'Office Admin') AS r", [noteId, note, lines, JSON.stringify(zoho), ADMIN]);
const scan = (code, handover, actor, zoho = null) =>
  one("SELECT public.delivery_paper_scan($1,$2,$3,$4) AS r", [code, handover, zoho === null ? null : JSON.stringify(zoho), actor]);
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- a note, printed once: note and both slips get their own code
const issued = await issue("TEST-QR-1", ZOHO_PAID());
assert.equal(issued.issued, true, JSON.stringify(issued));
const NOTE1 = issued.note_id;
const first = await print(NOTE1, true, [1, 2]);
assert.equal(first.note_copy, 1);
assert.deepEqual(first.slip_copies, { 1: 1, 2: 1 });
const noteCode1 = first.note_code, slip1 = first.slip_codes["1"], slip2a = first.slip_codes["2"];
for (const code of [noteCode1, slip1, slip2a]) assert.match(code, /^[A-Za-z0-9_-]{22}$/, code);
assert.equal(new Set([noteCode1, slip1, slip2a]).size, 3, "every paper has its own code");
assert.deepEqual(first.handovers, {});

// Only the hash is kept, never the code itself.
const stored = await q("SELECT code_hash FROM public.delivery_paper_codes WHERE note_id = $1 ORDER BY id", [NOTE1]);
assert.deepEqual(stored.map((row) => row.code_hash), [sha(noteCode1), sha(slip1), sha(slip2a)]);

// Codes are random, not counters: 200 fresh ones, no repeats, and the characters are spread out.
const many = (await q("SELECT private.delivery_new_code() AS c FROM generate_series(1,200)")).map((row) => row.c);
assert.equal(new Set(many).size, 200);
assert.ok(many.every((c) => /^[A-Za-z0-9_-]{22}$/.test(c)));
assert.ok(new Set(many.map((c) => c[0])).size > 20, "first characters vary");

// ---- unknown and forged codes: red, logged, nothing about any order given away
for (const fake of ["A".repeat(22), many[0], "TEST-QR-1", "DN-000001", issued.note_no, NOTE1, "", "x".repeat(300), `${slip1} `.trim().slice(0, 21)]) {
  const answer = await scan(fake, false, CLK_USER);
  assert.equal(answer.result, "unknown", `${fake}: ${JSON.stringify(answer)}`);
  assert.equal(answer.note, undefined);
  assert.equal(answer.lines, undefined);
}
const forged = await scan("B".repeat(22), true, CLK_USER);
assert.equal(forged.result, "unknown", "a handover on a forged code is refused");
assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_scans WHERE result = 'unknown' AND note_id IS NULL"))[0].c, 10, "unknown scans are kept");

// ---- only staff and admins
await refuses(() => scan(slip1, false, CUSTOMER), /Only godown staff and administrators/, "a customer");
await refuses(() => scan(slip1, false, OFF_USER), /Only godown staff and administrators/, "an inactive employee");
await refuses(() => scan(slip1, false, uid("ff")), /Only godown staff and administrators/, "a stranger");

// ---- a genuine slip: ready (not green until recorded)
let answer = await scan(slip1, false, CLK_USER);
assert.equal(answer.result, "ready", JSON.stringify(answer));
assert.equal(answer.by, "Ravi CLK");
assert.equal(answer.godown, "Challakere Godown");
assert.equal(answer.paper.doc, "slip");
assert.equal(answer.paper.slip_line, 1);
assert.equal(answer.paper.copy_no, 1);
assert.equal(answer.paper.latest_copy, 1);
assert.equal(answer.note.note_no, issued.note_no);
assert.equal(answer.note.godown, "Challakere Godown");
assert.equal(answer.lines.length, 1);
assert.equal(answer.lines[0].name, "TEST Rice 25 kg");
assert.equal(answer.lines[0].qty, 2);
assert.equal(answer.lines[0].handover, null);
assert.equal(answer.gate.code, "paid");
assert.equal(answer.gate.paid, undefined, "no amounts go to the scanner");
assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers"))[0].c, 0, "a check records nothing");

// The order number for the server's Zoho read, only for a real code.
assert.equal(await one("SELECT public.delivery_paper_order_no($1) AS r", [slip1]), "TEST-QR-1");
assert.equal(await one("SELECT public.delivery_paper_order_no($1) AS r", ["A".repeat(22)]), null);

// ---- another godown's staff: amber, and can't hand over
answer = await scan(slip1, true, HBL_USER);
assert.equal(answer.result, "other_godown");
assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers"))[0].c, 0);

// ---- the handover: green once, red for everyone after
answer = await scan(slip1, true, CLK_USER, ZOHO_PAID());
assert.equal(answer.result, "handed_over", JSON.stringify(answer));
assert.deepEqual(answer.handed_now, [1]);
assert.equal(answer.lines[0].handover.by, "Ravi CLK");
assert.equal(answer.lines[0].handover.godown, "Challakere Godown");
assert.equal(answer.gate.source, "zoho_now");
let rows = await q("SELECT slip_line, actor_name, actor_role, branch_id, gate_code, gate_source FROM public.delivery_handovers WHERE note_id = $1", [NOTE1]);
assert.deepEqual(rows, [{ slip_line: 1, actor_name: "Ravi CLK", actor_role: "staff", branch_id: "BR-CLK", gate_code: "paid", gate_source: "zoho_now" }]);

for (const [who, handover] of [[CLK_USER, true], [ADMIN, true], [CLK_USER, false], [ADMIN, false], [HBL_USER, false]]) {
  answer = await scan(slip1, handover, who, ZOHO_PAID());
  assert.equal(answer.result, "already_handed_over", `${who} ${handover}: ${answer.result}`);
  assert.equal(answer.lines[0].handover.by, "Ravi CLK");
  assert.deepEqual(answer.handed_now, []);
}
assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers"))[0].c, 1, "single use");

// The unique key holds even for the table's owner, if the lock were ever bypassed.
await refuses(() => q("INSERT INTO public.delivery_handovers (note_id, slip_line, code_id, actor_id, actor_name, actor_role, gate_code, gate_source) SELECT note_id, 1, id, $1, 'x', 'admin', 'paid', 'zoho_now' FROM public.delivery_paper_codes WHERE code_hash = $2", [ADMIN, sha(slip1)]),
  /duplicate key|unique/, "a second handover row for the same line");

// ---- the note covers every line: line 1 is done, line 2 is open
answer = await scan(noteCode1, false, CLK_USER);
assert.equal(answer.result, "ready");
assert.equal(answer.paper.doc, "note");
assert.equal(answer.lines.length, 2);
assert.equal(answer.lines[0].handover.by, "Ravi CLK");
assert.equal(answer.lines[1].handover, null);

// ---- a reprint cancels the earlier copy's code; the new copy is the only one that works
const second = await print(NOTE1, false, [2]);
assert.deepEqual(second.slip_copies, { 2: 2 });
assert.deepEqual(Object.keys(second.handovers), ["1"], "the print knows line 1 is handed over");
const slip2b = second.slip_codes["2"];
assert.notEqual(slip2b, slip2a);
answer = await scan(slip2a, true, CLK_USER, ZOHO_PAID());
assert.equal(answer.result, "replaced", "the old copy never records");
assert.equal(answer.paper.copy_no, 1);
assert.equal(answer.paper.latest_copy, 2);
assert.equal(answer.paper.latest_printed_by, "Office Admin");
assert.equal((await q("SELECT count(*)::int AS c FROM public.delivery_handovers"))[0].c, 1);
answer = await scan(slip2b, false, CLK_USER);
assert.equal(answer.result, "ready");
assert.equal(answer.paper.copy_no, 2);

// Reprinting the note cancels the first note's code too.
const third = await print(NOTE1, true, []);
assert.equal(third.note_copy, 2);
const noteCode2 = third.note_code;
assert.equal((await scan(noteCode1, false, ADMIN)).result, "replaced");

// ---- an admin hands over the rest through the note; Zoho could not be read, so the last reading is used and said
answer = await scan(noteCode2, true, ADMIN, { read: false, error: "Zoho timed out" });
assert.equal(answer.result, "handed_over", JSON.stringify(answer));
assert.deepEqual(answer.handed_now, [2]);
assert.equal(answer.gate.source, "last_reading");
assert.equal(answer.role, "admin");
assert.equal(answer.by, "Office Admin");
rows = await q("SELECT slip_line, actor_role, branch_id, branch_name, gate_source FROM public.delivery_handovers WHERE note_id = $1 ORDER BY slip_line", [NOTE1]);
assert.deepEqual(rows[1], { slip_line: 2, actor_role: "admin", branch_id: null, branch_name: "", gate_source: "last_reading" });
// Everything is now handed over: every paper of this note is red, whatever copy.
for (const code of [noteCode2, slip2b, slip2a, slip1, noteCode1]) assert.equal((await scan(code, true, CLK_USER, ZOHO_PAID())).result, "already_handed_over", code);
// A reprint after the handover still prints (for records) and scans red.
const fourth = await print(NOTE1, false, [1]);
assert.equal((await scan(fourth.slip_codes["1"], false, CLK_USER)).result, "already_handed_over");
assert.deepEqual(Object.keys(fourth.handovers).sort(), ["1", "2"]);

// ---- order problems are red or amber, never handed over
const issued2 = await issue("TEST-QR-2", ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(issued2.issued, true);
const p2 = await print(issued2.note_id, true, [1, 2], ZOHO_PAID("INV-2", "CLKINV-2"));
const o2slip = p2.slip_codes["1"];
const handovers = async () => (await q("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1", [issued2.note_id]))[0].c;

// Stopped by the office.
await service(() => q("SELECT public.set_delivery_stop('TEST-QR-2', true, 'Refund asked', $1, 'Office Admin')", [ADMIN]));
answer = await scan(o2slip, true, CLK_USER, ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "stopped");
assert.equal(answer.gate.stop_reason, "Refund asked");
await service(() => q("SELECT public.set_delivery_stop('TEST-QR-2', false, 'Settled', $1, 'Office Admin')", [ADMIN]));
assert.equal((await scan(o2slip, false, CLK_USER)).result, "ready", "lifting the stop makes it usable again");

// Zoho Books says the invoice is no longer paid (fresh reading at the handover).
answer = await scan(o2slip, true, CLK_USER, { ...ZOHO_PAID("INV-2", "CLKINV-2"), status: "sent", balance: 1000, payment_made: 0 });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "zoho_behind");

// The order's items changed after the note.
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
await q("UPDATE public.order_items SET qty = 3 WHERE order_id = $1 AND product_id = 'P1'", [ORDER2]);
answer = await scan(o2slip, true, CLK_USER, ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.items_changed, true);
await q("UPDATE public.order_items SET qty = 2 WHERE order_id = $1 AND product_id = 'P1'", [ORDER2]);
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");

// Void in Zoho (the website keeps a paid order open for a refund, so the gate alone wouldn't say).
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET zoho_order_status = 'void' WHERE id = $1", [ORDER2]);
answer = await scan(o2slip, true, CLK_USER, ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.zoho_void, true);
await q("UPDATE public.orders SET zoho_order_status = 'confirmed' WHERE id = $1", [ORDER2]);

// Cancelled.
await q("UPDATE public.orders SET order_status = 'Cancelled' WHERE id = $1", [ORDER2]);
answer = await scan(o2slip, true, ADMIN, ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "cancelled");
// An old copy of a cancelled order's slip still says it is an old copy first.
await q("UPDATE public.orders SET order_status = 'Payment Confirmed' WHERE id = $1", [ORDER2]);
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
assert.equal(await handovers(), 0, "no order problem ever recorded a handover");

// ---- the scan history: who, when, which godown, what answer
const history = await q("SELECT action, result, actor_name, actor_role, branch_name, doc, slip_line, copy_no, lines FROM public.delivery_scans WHERE note_id = $1 ORDER BY id", [NOTE1]);
assert.ok(history.length >= 15);
assert.ok(history.some((row) => row.result === "handed_over" && row.actor_name === "Ravi CLK" && row.branch_name === "Challakere Godown" && row.lines.join() === "1"));
assert.ok(history.some((row) => row.result === "other_godown" && row.branch_name === "Hubli Godown"));
assert.ok(history.some((row) => row.result === "replaced" && row.copy_no === 1 && row.slip_line === 2));

// Nowhere in the delivery tables is a printed code kept as text.
const everything = (await q(`SELECT string_agg(t::text, ' ') AS all FROM (
  SELECT to_jsonb(c) AS t FROM public.delivery_paper_codes c UNION ALL SELECT to_jsonb(h) FROM public.delivery_handovers h
  UNION ALL SELECT to_jsonb(s) FROM public.delivery_scans s UNION ALL SELECT to_jsonb(e) FROM public.delivery_note_events e
  UNION ALL SELECT to_jsonb(n) FROM public.delivery_notes n) x`))[0].all;
for (const code of [noteCode1, noteCode2, slip1, slip2a, slip2b, o2slip]) assert.ok(!everything.includes(code), "a code was stored as text");

// ---- nothing is changed or removed, even by the owner
for (const [table, column] of [["delivery_paper_codes", "printed_at"], ["delivery_handovers", "handed_over_at"], ["delivery_scans", "occurred_at"]]) {
  await refuses(() => q(`UPDATE public.${table} SET ${column} = now()`), /cannot be changed or deleted/, `${table} update`);
  await refuses(() => q(`DELETE FROM public.${table}`), /cannot be changed or deleted/, `${table} delete`);
  await refuses(() => q(`TRUNCATE public.${table} CASCADE`), /cannot be changed or deleted/, `${table} truncate`);
}

// ---- who can call and read what
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.delivery_paper_scan($1,true,NULL,$2)", [slip2b, ADMIN])), /permission denied/, "a browser calling the scan");
await refuses(() => as(CLK_USER, "authenticated", () => q("SELECT public.delivery_paper_order_no($1)", [slip2b])), /permission denied/, "a browser asking a code's order");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT code_hash FROM public.delivery_paper_codes")), /permission denied/, "an admin reading the hashes");
await refuses(() => as(null, "anon", () => q("SELECT * FROM public.delivery_scans")), /permission denied/, "anon reading scans");
await refuses(() => as(ADMIN, "authenticated", () => q("INSERT INTO public.delivery_handovers (note_id, slip_line, code_id, actor_id, actor_name, actor_role, gate_code, gate_source) VALUES ($1, 1, 1, $2, 'x', 'admin', 'paid', 'zoho_now')", [issued2.note_id, ADMIN])), /permission denied/, "an admin writing a handover");
assert.ok((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_scans")))[0].c > 0, "admins read the scan history");
assert.ok((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_handovers")))[0].c === 2);
assert.equal((await as(CLK_USER, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_scans")))[0].c, 0, "staff don't read the history directly");
assert.equal((await as(CLK_USER, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_handovers")))[0].c, 0);
await refuses(() => service(() => q("SELECT public.record_delivery_print($1,true,'{}',NULL,$2,'Ravi')", [NOTE1, CLK_USER])), /Only administrators can print/, "staff printing");

// ---- the register shows the handovers
const register = await one("SELECT public.delivery_note_register() AS r");
const entry1 = register.find((row) => row.order_no === "TEST-QR-1");
assert.equal(entry1.handed_over, 2);
assert.equal(entry1.items, 2);
assert.ok(entry1.refused_scans > 0);
assert.equal(register.find((row) => row.order_no === "TEST-QR-2").handed_over, 0);

console.log("delivery paper QR OK");
