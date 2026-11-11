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
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), CLK_USER = uid("e1"), HBL_USER = uid("e2"), OFF_USER = uid("e3");
const P_CLK = uid("b1"), P_HBL = uid("b2"), P_OFF = uid("b3");
const people = [ADMIN, CUSTOMER, CLK_USER, HBL_USER, OFF_USER, P_CLK, P_HBL, P_OFF];
await q(`INSERT INTO auth.users (id, email) SELECT u, u::text || '@test.local' FROM unnest($1::uuid[]) u ON CONFLICT DO NOTHING`, [people]);
await q(`DELETE FROM public.user_roles WHERE user_id = ANY ($1::uuid[])`, [people]);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q(`INSERT INTO public.profiles (id, full_name, email) VALUES ('${ADMIN}','Office Admin','a@test.local') ON CONFLICT (id) DO UPDATE SET full_name = 'Office Admin'`);
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-CLK','CLK','Challakere Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Challakere Godown'");
await q("INSERT INTO public.branches (id, code, name, active) VALUES ('BR-HBL','HBL','Hubli Godown',true) ON CONFLICT (id) DO UPDATE SET active = true, name = 'Hubli Godown'");
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${CLK_USER}','BR-CLK','Ravi CLK','9000000011'),('${HBL_USER}','BR-HBL','Hanu HBL','9000000012')`);
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone, status) VALUES ('${OFF_USER}','BR-CLK','Gone CLK','9000000013','inactive')`);
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE branch_id IN ('BR-CLK','BR-HBL')");
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${P_CLK}','BR-CLK','Partner CLK','p1@test.local','9000000021'),('${P_HBL}','BR-HBL','Partner HBL','p2@test.local','9000000022')`);
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, status) VALUES ('${P_OFF}','BR-CLK','Partner Off','p3@test.local','9000000023','suspended')`);
// The godowns' registered phones (attendance devices): tokens are kept as sha256, like the app does.
const TOKEN_CLK = "tok-clk-registered-phone-000000001", TOKEN_HBL = "tok-hbl-registered-phone-000000002", TOKEN_GONE = "tok-clk-revoked-phone-0000000003";
await q("INSERT INTO public.godown_devices (branch_id, label, token_hash, active) VALUES ('BR-CLK','CLK counter phone',$1,true),('BR-HBL','HBL phone',$2,true),('BR-CLK','old phone',$3,false)",
  [sha(TOKEN_CLK), sha(TOKEN_HBL), sha(TOKEN_GONE)]);

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
  await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, capacity, created_at) VALUES
    ($1,'P1','TEST Rice 25 kg',2,300,600,'25 kg','2026-11-10T10:00:00Z'),($1,'P2','TEST Oil 1 L',2,100,200,'1 L','2026-11-10T10:00:01Z'),($1,'P3','TEST Sugar 50 kg',1,200,200,'50 kg','2026-11-10T10:00:02Z')`, [id]);
  await q("INSERT INTO public.payments (order_id, user_id, kind, amount, method, status, txn_ref) VALUES ($1,$2,'full',1000,'UPI','Paid',$3)", [id, CUSTOMER, `UTR${no.replace(/\W/g, "")}0000000`]);
  await q("INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, invoice_number, status, total, balance) VALUES ($1,$2,$3,$4,'paid',1000,0)", [id, no, invoice, number]);
  return id;
}
const ORDER1 = await paidOrder("TEST-QR-1", "INV-1", "CLKINV-1");
const ORDER2 = await paidOrder("TEST-QR-2", "INV-2", "CLKINV-2");
const ORDER3 = await paidOrder("TEST-QR-3", "INV-3", "CLKINV-3");
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
const print = (noteId, note, lines, opts = {}) =>
  one("SELECT public.record_delivery_print($1,$2,$3,$4,$5,'Office Admin',$6) AS r",
    [noteId, note, lines, JSON.stringify(opts.zoho ?? ZOHO_PAID()), opts.actor ?? ADMIN, opts.reason ?? null]);
const scan = (code, handover, actor, opts = {}) =>
  one("SELECT public.delivery_paper_scan($1,$2,$3,$4,$5,$6) AS r",
    [code, handover, opts.zoho === undefined || opts.zoho === null ? null : JSON.stringify(opts.zoho), actor, opts.lines ?? null, opts.device ?? null]);
const reopen = (orderNo, line, reason, actor = ADMIN) =>
  one("SELECT public.reopen_delivery_handover($1,$2,$3,$4,'Office Admin') AS r", [orderNo, line, reason, actor]);
const count = async (text, params) => (await q(text, params))[0].c;
const handoverRows = (noteId) => q("SELECT slip_line, round, actor_name, actor_role, branch_id, device_registered, device_label, gate_source FROM public.delivery_handovers WHERE note_id = $1 ORDER BY id", [noteId]);

// ---- a note, printed once: the note and every slip get their own code, all of them originals
const issued = await issue("TEST-QR-1", ZOHO_PAID());
assert.equal(issued.issued, true, JSON.stringify(issued));
const NOTE1 = issued.note_id;
const first = await print(NOTE1, true, [1, 2, 3]);
assert.equal(first.note_copy, 1);
assert.deepEqual(first.slip_copies, { 1: 1, 2: 1, 3: 1 });
assert.equal(first.note_paper.kind, "original");
for (const line of ["1", "2", "3"]) assert.equal(first.slip_papers[line].kind, "original", line);
const noteOriginal = first.note_code, slip1 = first.slip_codes["1"], slip2 = first.slip_codes["2"], slip3 = first.slip_codes["3"];
for (const code of [noteOriginal, slip1, slip2, slip3]) assert.match(code, /^[A-Za-z0-9_-]{22}$/, code);
assert.equal(new Set([noteOriginal, slip1, slip2, slip3]).size, 4, "every paper has its own code");
assert.deepEqual(first.handovers, {});
const stored = await q("SELECT code_hash, kind, duplicate_no, printed_by FROM public.delivery_paper_codes WHERE note_id = $1 ORDER BY id", [NOTE1]);
assert.deepEqual(stored.map((row) => row.code_hash), [sha(noteOriginal), sha(slip1), sha(slip2), sha(slip3)], "only the hash is kept");
assert.ok(stored.every((row) => row.kind === "original" && row.duplicate_no === null && row.printed_by === "Office Admin"));

// The code live before this migration calls the print with six arguments: it still works.
const sixArgs = await one("SELECT public.record_delivery_print($1,false,'{3}',$2,$3,'Office Admin') AS r", [NOTE1, JSON.stringify(ZOHO_PAID()), ADMIN]);
assert.equal(sixArgs.slip_papers["3"].kind, "duplicate");
assert.equal(sixArgs.slip_papers["3"].duplicate_no, 1);
const slip3dup1 = sixArgs.slip_codes["3"];

// Codes are random, not counters.
const many = (await q("SELECT private.delivery_new_code() AS c FROM generate_series(1,200)")).map((row) => row.c);
assert.equal(new Set(many).size, 200);
assert.ok(many.every((c) => /^[A-Za-z0-9_-]{22}$/.test(c)));
assert.ok(new Set(many.map((c) => c[0])).size > 20, "first characters vary");

// ---- reprints: the original stays the original; every later print is a duplicate, numbered per paper
const reprint2 = await print(NOTE1, true, [2]);
assert.equal(reprint2.note_paper.kind, "duplicate");
assert.equal(reprint2.note_paper.duplicate_no, 1);
assert.equal(reprint2.slip_papers["2"].kind, "duplicate");
assert.equal(reprint2.slip_papers["2"].duplicate_no, 1);
const reprint3 = await print(NOTE1, false, [2]);
assert.equal(reprint3.slip_papers["2"].duplicate_no, 2, "duplicate copy 2 of slip 2");
assert.deepEqual(reprint3.slip_copies, { 2: 3 }, "the press count goes on");
const noteDup1 = reprint2.note_code, slip2dup1 = reprint2.slip_codes["2"], slip2dup2 = reprint3.slip_codes["2"];

// ---- unknown and forged codes: red, logged, nothing about any order given away
for (const fake of ["A".repeat(22), many[0], "TEST-QR-1", "DN-000001", issued.note_no, NOTE1, "", "x".repeat(300), slip1.slice(0, 21)]) {
  const answer = await scan(fake, false, CLK_USER);
  assert.equal(answer.result, "unknown", `${fake}: ${JSON.stringify(answer)}`);
  assert.equal(answer.note, undefined);
  assert.equal(answer.lines, undefined);
}
assert.equal((await scan("B".repeat(22), true, CLK_USER)).result, "unknown", "a handover on a forged code is refused");

// ---- who may scan: admins, active staff and active channel partners
await refuses(() => scan(slip1, false, CUSTOMER), /Only godown staff, channel partners and administrators/, "a customer");
await refuses(() => scan(slip1, false, OFF_USER), /Only godown staff, channel partners and administrators/, "an inactive employee");
await refuses(() => scan(slip1, false, P_OFF), /Only godown staff, channel partners and administrators/, "a suspended partner");
await refuses(() => scan(slip1, false, uid("ff")), /Only godown staff, channel partners and administrators/, "a stranger");
let answer = await scan(slip1, false, P_CLK);
assert.equal(answer.result, "ready");
assert.equal(answer.role, "partner");
assert.equal(answer.by, "Partner CLK");
assert.equal(answer.godown, "Challakere Godown");
assert.equal((await scan(slip1, false, P_HBL)).result, "other_godown", "a partner of another godown");
assert.equal((await scan(slip1, true, HBL_USER, { zoho: ZOHO_PAID() })).result, "other_godown", "staff of another godown");

// ---- duplicates never hand goods over, and the original still does
for (const [code, label] of [[slip2dup1, "slip 2 duplicate 1"], [slip2dup2, "slip 2 duplicate 2"], [slip3dup1, "slip 3 duplicate 1"], [noteDup1, "note duplicate 1"]]) {
  answer = await scan(code, true, ADMIN, { zoho: ZOHO_PAID(), lines: [1, 2, 3] });
  assert.equal(answer.result, "duplicate", label);
  assert.equal(answer.paper.kind, "duplicate");
  assert.equal(answer.paper.original_kind, "original");
}
answer = await scan(slip2dup2, false, CLK_USER);
assert.equal(answer.paper.duplicate_no, 2);
assert.equal(answer.paper.printed_by, "Office Admin");
assert.equal((await scan(slip2, false, CLK_USER)).result, "ready", "the first print is still the original");
assert.equal(await count("SELECT count(*)::int AS c FROM public.delivery_handovers"), 0, "nothing recorded yet");

// ---- a replacement original: an admin, with a reason; it cancels the original before it
await refuses(() => print(NOTE1, false, [3], { reason: "x" }), /Enter the reason/, "a replacement without a reason");
await refuses(() => print(NOTE1, false, [3], { reason: "Jammed in the printer", actor: CLK_USER }), /Only administrators can print/, "staff");
const replaced3 = await print(NOTE1, false, [3], { reason: "Jammed in the printer" });
assert.equal(replaced3.slip_papers["3"].kind, "replacement");
assert.equal(replaced3.slip_papers["3"].reason, "Jammed in the printer");
assert.equal(replaced3.slip_papers["3"].replaces.kind, "original");
const slip3r = replaced3.slip_codes["3"];
answer = await scan(slip3, true, CLK_USER, { zoho: ZOHO_PAID() });
assert.equal(answer.result, "replaced", "the first original of slip 3 no longer works");
assert.equal(answer.paper.replaced_reason, "Jammed in the printer");
assert.equal(answer.paper.replaced_by, "Office Admin");
assert.ok(answer.paper.replaced_at);
assert.equal((await scan(slip3r, false, CLK_USER)).result, "ready", "the replacement is the one that works");
assert.equal((await scan(slip3dup1, false, CLK_USER)).result, "duplicate", "the old duplicate is still only a duplicate");
const after = await print(NOTE1, false, [3]);
assert.equal(after.slip_papers["3"].kind, "duplicate", "a print after the replacement is a duplicate");
assert.equal(after.slip_papers["3"].duplicate_no, 2, "duplicates of slip 3 keep counting");

// ---- a slip handover: green once, recorded with who, as what, where and on which phone
answer = await scan(slip1, true, CLK_USER, { zoho: ZOHO_PAID(), device: TOKEN_CLK });
assert.equal(answer.result, "handed_over", JSON.stringify(answer));
assert.deepEqual(answer.handed_now, [1]);
assert.deepEqual(answer.device, { registered: true, label: "CLK counter phone" });
assert.equal(answer.order_delivered, false, "items 2 and 3 are still to go");
assert.equal(answer.lines[0].handover.registered_phone, true);
for (const [who, handover] of [[CLK_USER, true], [ADMIN, true], [P_CLK, false], [HBL_USER, false]]) {
  answer = await scan(slip1, handover, who, { zoho: ZOHO_PAID() });
  assert.equal(answer.result, "already_handed_over", `${who} ${handover}`);
  assert.equal(answer.lines[0].handover.by, "Ravi CLK");
}
assert.equal(await count("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1", [NOTE1]), 1, "single use");
await refuses(() => q("INSERT INTO public.delivery_handovers (note_id, slip_line, round, code_id, actor_id, actor_name, actor_role, gate_code, gate_source) SELECT note_id, 1, 1, id, $1, 'x', 'admin', 'paid', 'zoho_now' FROM public.delivery_paper_codes WHERE code_hash = $2", [ADMIN, sha(slip1)]),
  /duplicate key|unique/, "a second handover row for the same line and round");

// Phones: another godown's phone, a removed phone and a made-up token all count as the person's own phone.
for (const token of [TOKEN_HBL, TOKEN_GONE, "not-a-token"]) {
  answer = await scan(slip2, false, CLK_USER, { device: token });
  assert.deepEqual(answer.device, { registered: false, label: "" }, token);
}
answer = await scan(slip2, false, ADMIN, { device: TOKEN_HBL });
assert.deepEqual(answer.device, { registered: true, label: "HBL phone" }, "an admin on any godown's phone");

// ---- the note: tick which items go, and only those are recorded
answer = await scan(noteOriginal, false, P_CLK);
assert.equal(answer.result, "ready");
assert.equal(answer.paper.doc, "note");
assert.deepEqual(answer.lines.map((line) => [line.line, Boolean(line.handover)]), [[1, true], [2, false], [3, false]]);
await refuses(() => scan(noteOriginal, true, P_CLK, { zoho: ZOHO_PAID() }), /Tick the items being handed over/, "no ticks");
await refuses(() => scan(noteOriginal, true, P_CLK, { zoho: ZOHO_PAID(), lines: [] }), /Tick the items being handed over/, "empty ticks");
await refuses(() => scan(noteOriginal, true, P_CLK, { zoho: ZOHO_PAID(), lines: [9] }), /no such item/, "an item the note doesn't have");
answer = await scan(noteOriginal, true, P_CLK, { zoho: ZOHO_PAID(), lines: [1, 2] });
assert.equal(answer.result, "partly_handed_over", "item 1 went already: all or nothing");
assert.deepEqual(answer.asked, [1, 2]);
assert.deepEqual(answer.handed_now, []);
assert.equal(await count("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1", [NOTE1]), 1, "nothing recorded");
answer = await scan(noteOriginal, true, P_CLK, { zoho: ZOHO_PAID(), lines: [2, 2] });
assert.equal(answer.result, "handed_over");
assert.deepEqual(answer.handed_now, [2]);
assert.equal(answer.role, "partner");
assert.deepEqual(answer.device, { registered: false, label: "" }, "the partner's own phone");
assert.equal(answer.order_delivered, false);
assert.equal((await scan(slip2, false, CLK_USER)).result, "already_handed_over", "the slip of an item handed over on the note");

// ---- the last item: the order is marked Delivered, as an admin would, and Zoho's queue hears of it
assert.equal(await count("SELECT count(*)::int AS c FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [ORDER1]), 0);
answer = await scan(slip3r, true, ADMIN, { zoho: { read: false, error: "Zoho timed out" } });
assert.equal(answer.result, "handed_over");
assert.equal(answer.gate.source, "last_reading");
assert.equal(answer.order_delivered, true);
assert.equal(answer.order_status_before, "Payment Confirmed");
assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [ORDER1]))[0].order_status, "Delivered");
assert.ok(await count("SELECT count(*)::int AS c FROM public.zoho_sync_outbox WHERE entity_type = 'order' AND entity_id = $1", [ORDER1]) >= 1, "queued for Zoho");
assert.deepEqual(await handoverRows(NOTE1), [
  { slip_line: 1, round: 1, actor_name: "Ravi CLK", actor_role: "staff", branch_id: "BR-CLK", device_registered: true, device_label: "CLK counter phone", gate_source: "zoho_now" },
  { slip_line: 2, round: 1, actor_name: "Partner CLK", actor_role: "partner", branch_id: "BR-CLK", device_registered: false, device_label: "", gate_source: "zoho_now" },
  { slip_line: 3, round: 1, actor_name: "Office Admin", actor_role: "admin", branch_id: null, device_registered: false, device_label: "", gate_source: "last_reading" },
]);
for (const code of [noteOriginal, slip1, slip2, slip3r, slip2dup1, slip3, noteDup1]) assert.equal((await scan(code, true, CLK_USER, { zoho: ZOHO_PAID(), lines: [1] })).result, "already_handed_over", code);
await refuses(() => print(NOTE1, false, [2], { reason: "Lost it" }), /already handed over/, "a replacement for goods already gone");

// ---- reopen: an admin, with a reason; the item can go again on its original, in a new round
await refuses(() => reopen("TEST-QR-1", 2, "Customer came back", CLK_USER), /Only administrators can reopen/, "staff reopening");
await refuses(() => reopen("TEST-QR-1", 2, "no"), /Enter the reason/, "a reopen without a reason");
await refuses(() => reopen("TEST-QR-2", 1, "No note yet"), /has no delivery note/, "an order without a note");
let reopened = await reopen("TEST-QR-1", 2, "Pressed by mistake, goods still in godown");
assert.equal(reopened.reopened, true);
assert.equal(reopened.order_status, "Delivered", "the order's status is left for the admin");
assert.equal(reopened.delivered_by_handover, true);
await refuses(() => reopen("TEST-QR-1", 2, "Again"), /Item 2 is not handed over/, "reopening twice");
answer = await scan(slip2, false, CLK_USER);
assert.equal(answer.result, "ready", "the reopened item's original works again");
assert.equal((await scan(slip2dup1, false, CLK_USER)).result, "duplicate", "its duplicates still don't");
answer = await scan(noteOriginal, false, CLK_USER);
assert.deepEqual(answer.lines.map((line) => [line.line, Boolean(line.handover)]), [[1, true], [2, false], [3, true]]);
answer = await scan(slip2, true, CLK_USER, { zoho: ZOHO_PAID() });
assert.equal(answer.result, "handed_over");
assert.equal(answer.order_delivered, false, "already Delivered: nothing to change");
assert.deepEqual((await handoverRows(NOTE1)).filter((row) => row.slip_line === 2).map((row) => row.round), [1, 2]);
assert.equal((await scan(slip2, true, ADMIN, { zoho: ZOHO_PAID() })).result, "already_handed_over");
assert.equal(await count("SELECT count(*)::int AS c FROM public.delivery_handover_reopens WHERE note_id = $1", [NOTE1]), 1);

// ---- order problems are red or amber, never handed over
const issued2 = await issue("TEST-QR-2", ZOHO_PAID("INV-2", "CLKINV-2"));
assert.equal(issued2.issued, true);
const p2 = await print(issued2.note_id, true, [1, 2, 3], { zoho: ZOHO_PAID("INV-2", "CLKINV-2") });
const o2slip = p2.slip_codes["1"];
const handovers2 = () => count("SELECT count(*)::int AS c FROM public.delivery_handovers WHERE note_id = $1", [issued2.note_id]);
await service(() => q("SELECT public.set_delivery_stop('TEST-QR-2', true, 'Refund asked', $1, 'Office Admin')", [ADMIN]));
answer = await scan(o2slip, true, CLK_USER, { zoho: ZOHO_PAID("INV-2", "CLKINV-2") });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "stopped");
assert.equal(answer.gate.stop_reason, "Refund asked");
await service(() => q("SELECT public.set_delivery_stop('TEST-QR-2', false, 'Settled', $1, 'Office Admin')", [ADMIN]));
assert.equal((await scan(o2slip, false, CLK_USER)).result, "ready", "lifting the stop makes it usable again");
answer = await scan(o2slip, true, CLK_USER, { zoho: { ...ZOHO_PAID("INV-2", "CLKINV-2"), status: "sent", balance: 1000, payment_made: 0 } });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "zoho_behind");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
await q("UPDATE public.order_items SET qty = 3 WHERE order_id = $1 AND product_id = 'P1'", [ORDER2]);
answer = await scan(o2slip, true, CLK_USER, { zoho: ZOHO_PAID("INV-2", "CLKINV-2") });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.items_changed, true);
await q("UPDATE public.order_items SET qty = 2 WHERE order_id = $1 AND product_id = 'P1'", [ORDER2]);
await q("ALTER TABLE public.order_items ENABLE TRIGGER USER");
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("UPDATE public.orders SET zoho_order_status = 'void' WHERE id = $1", [ORDER2]);
answer = await scan(o2slip, true, CLK_USER, { zoho: ZOHO_PAID("INV-2", "CLKINV-2") });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.zoho_void, true);
await q("UPDATE public.orders SET zoho_order_status = 'confirmed', order_status = 'Cancelled' WHERE id = $1", [ORDER2]);
answer = await scan(p2.note_code, true, P_CLK, { zoho: ZOHO_PAID("INV-2", "CLKINV-2"), lines: [1, 2, 3] });
assert.equal(answer.result, "order_problem");
assert.equal(answer.gate.code, "cancelled");
await q("UPDATE public.orders SET order_status = 'Payment Confirmed' WHERE id = $1", [ORDER2]);
await q("ALTER TABLE public.orders ENABLE TRIGGER USER");
assert.equal(await handovers2(), 0, "no order problem ever recorded a handover");

// ---- the order guard: the handover flag lets only the status move to Delivered
await q("BEGIN");
await refuses(() => q("UPDATE public.orders SET order_status = 'Delivered' WHERE id = $1", [ORDER3]), /Vendor order updates must follow/, "without the flag");
await q("ROLLBACK");
await q("BEGIN");
await q("SELECT set_config('app.delivery_handover', 'on', true)");
await refuses(() => q("UPDATE public.orders SET order_status = 'Delivered', total = 1 WHERE id = $1", [ORDER3]), /cannot edit order totals/, "the flag with another change");
await q("ROLLBACK");
await q("BEGIN");
await q("SELECT set_config('app.delivery_handover', 'on', true)");
await refuses(() => q("UPDATE public.orders SET order_status = 'Packed' WHERE id = $1", [ORDER3]), /Vendor order updates must follow/, "the flag for another status");
await q("ROLLBACK");
await q("BEGIN");
await q("SELECT set_config('app.delivery_handover', 'on', true)");
await q("UPDATE public.orders SET order_status = 'Delivered' WHERE id = $1", [ORDER3]);
assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [ORDER3]))[0].order_status, "Delivered");
await q("ROLLBACK");
assert.equal((await q("SELECT order_status FROM public.orders WHERE id = $1", [ORDER3]))[0].order_status, "Payment Confirmed");

// ---- the scan history: who, as what, when, which godown and phone, which paper, what answer
const history = await q("SELECT action, result, actor_name, actor_role, branch_name, doc, slip_line, copy_no, paper_kind, duplicate_no, asked, lines, device_registered, device_label, order_delivered FROM public.delivery_scans WHERE note_id = $1 ORDER BY id", [NOTE1]);
assert.ok(history.length >= 30);
assert.ok(history.some((row) => row.result === "handed_over" && row.actor_role === "staff" && row.device_registered && row.device_label === "CLK counter phone" && row.lines.join() === "1"));
assert.ok(history.some((row) => row.result === "handed_over" && row.actor_role === "partner" && !row.device_registered && row.doc === "note" && row.lines.join() === "2"));
assert.ok(history.some((row) => row.result === "handed_over" && row.order_delivered && row.actor_role === "admin"));
assert.ok(history.some((row) => row.result === "partly_handed_over" && row.asked.join() === "1,2" && row.lines.length === 0));
assert.ok(history.some((row) => row.result === "duplicate" && row.paper_kind === "duplicate" && row.duplicate_no === 2 && row.slip_line === 2));
assert.ok(history.some((row) => row.result === "replaced" && row.paper_kind === "original" && row.slip_line === 3));
assert.ok(history.some((row) => row.result === "other_godown" && row.branch_name === "Hubli Godown" && row.actor_role === "partner"));
assert.ok((await q("SELECT count(*)::int AS c FROM public.delivery_scans WHERE result = 'unknown' AND note_id IS NULL"))[0].c >= 10, "unknown scans are kept");

// Nowhere in the delivery tables is a printed code kept as text.
const everything = (await q(`SELECT string_agg(t::text, ' ') AS all FROM (
  SELECT to_jsonb(c) AS t FROM public.delivery_paper_codes c UNION ALL SELECT to_jsonb(h) FROM public.delivery_handovers h
  UNION ALL SELECT to_jsonb(r) FROM public.delivery_handover_reopens r UNION ALL SELECT to_jsonb(s) FROM public.delivery_scans s
  UNION ALL SELECT to_jsonb(e) FROM public.delivery_note_events e UNION ALL SELECT to_jsonb(n) FROM public.delivery_notes n) x`))[0].all;
for (const code of [noteOriginal, noteDup1, slip1, slip2, slip3, slip3r, slip2dup1, slip2dup2, slip3dup1, o2slip]) assert.ok(!everything.includes(code), "a code was stored as text");
assert.ok(!everything.includes(TOKEN_CLK), "a phone token was stored as text");

// ---- nothing is changed or removed, even by the owner
for (const [table, column] of [["delivery_paper_codes", "printed_at"], ["delivery_handovers", "handed_over_at"], ["delivery_handover_reopens", "reopened_at"], ["delivery_scans", "occurred_at"]]) {
  await refuses(() => q(`UPDATE public.${table} SET ${column} = now()`), /cannot be changed or deleted/, `${table} update`);
  await refuses(() => q(`DELETE FROM public.${table}`), /cannot be changed or deleted/, `${table} delete`);
  await refuses(() => q(`TRUNCATE public.${table} CASCADE`), /cannot be changed or deleted/, `${table} truncate`);
}

// ---- who can call and read what
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.delivery_paper_scan($1,true,NULL,$2)", [slip2, ADMIN])), /permission denied/, "a browser calling the scan");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.reopen_delivery_handover('TEST-QR-1',1,'Browser try',$1,'x')", [ADMIN])), /permission denied/, "a browser reopening");
await refuses(() => as(CLK_USER, "authenticated", () => q("SELECT public.delivery_paper_order_no($1)", [slip2])), /permission denied/, "a browser asking a code's order");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT code_hash FROM public.delivery_paper_codes")), /permission denied/, "an admin reading the hashes");
await refuses(() => as(null, "anon", () => q("SELECT * FROM public.delivery_scans")), /permission denied/, "anon reading scans");
await refuses(() => as(ADMIN, "authenticated", () => q("INSERT INTO public.delivery_handover_reopens (handover_id, note_id, slip_line, reason, actor_id, actor_name) VALUES (1, $1, 1, 'sneaky', $2, 'x')", [NOTE1, ADMIN])), /permission denied/, "an admin writing a reopen");
assert.ok((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_scans")))[0].c > 0, "admins read the scan history");
assert.equal((await as(ADMIN, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_handover_reopens")))[0].c, 1);
assert.ok((await as(ADMIN, "authenticated", () => q("SELECT kind, duplicate_no, reason FROM public.delivery_paper_codes WHERE kind = 'replacement'"))).length === 1, "admins read paper kinds");
for (const person of [CLK_USER, P_CLK]) {
  assert.equal((await as(person, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_scans")))[0].c, 0, "staff and partners don't read the history directly");
  assert.equal((await as(person, "authenticated", () => q("SELECT count(*)::int AS c FROM public.delivery_handovers")))[0].c, 0);
}

// ---- the register
const register = await one("SELECT public.delivery_note_register() AS r");
const entry1 = register.find((row) => row.order_no === "TEST-QR-1");
assert.equal(entry1.handed_over, 3);
assert.equal(entry1.items, 3);
assert.equal(entry1.reopened, 1);
assert.ok(entry1.refused_scans > 0);
assert.equal(register.find((row) => row.order_no === "TEST-QR-2").handed_over, 0);

console.log("delivery paper QR OK");
