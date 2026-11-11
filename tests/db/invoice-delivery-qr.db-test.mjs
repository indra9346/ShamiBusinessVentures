// Real-Postgres check of 20261112120000_invoice_delivery_qr.sql (the invoice QR, the godown in-charge, the admin rules), on PGlite with
// every migration in the repo and small stand-ins for what Supabase provides. Touches nothing live. Not part of
// test:zoho, because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/invoice-delivery-qr.db-test.mjs
//
// It must end with "invoice delivery QR OK".
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261112120000_invoice_delivery_qr.sql";

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
// ---- one printed paper (made the old way), to check the old QR stays separate
const issued = await issue("TEST-QR-1", ZOHO_PAID());
const first = await print(issued.note_id, true, [1]);
const noteOriginal = first.note_code;

// ================================================================ 12 Nov 2026: the delivery QR on the invoice
const callAs = async (user, text, params) => (await as(user, "authenticated", () => q(text, params)))[0].r;
const codeFor = (user, no) => callAs(user, "SELECT public.invoice_delivery_code($1) AS r", [no]);
const iscan = (code, action, actor, opts = {}) =>
  one("SELECT public.delivery_invoice_scan($1,$2,$3,$4,$5,$6) AS r",
    [code, action, opts.zoho === null ? null : JSON.stringify(opts.zoho ?? ZOHO_PAID(opts.invoice, opts.number)), actor, opts.lines ?? null, opts.device ?? null]);
const IN_CHARGE = uid("e4");
await q(`INSERT INTO auth.users (id, email) VALUES ('${IN_CHARGE}','ic@test.local') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${IN_CHARGE}','BR-CLK','Inchara CLK','9000000014')`);
const inchargeId = (await q(`SELECT id FROM public.staff_employees WHERE user_id = '${IN_CHARGE}'`))[0].id;
for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} DISABLE TRIGGER USER`);
await paidOrder("TEST-INV-1", "INV-11", "CLKINV-11");
await paidOrder("TEST-INV-2", "INV-12", "CLKINV-12");
const UNPAID = await paidOrder("TEST-INV-3", "INV-13", "CLKINV-13");
await q("UPDATE public.orders SET order_status = 'Placed', payment_status = 'Pending', paid_amount = 0 WHERE id = $1", [UNPAID]);
await q("DELETE FROM public.payments WHERE order_id = $1", [UNPAID]);
for (const table of ["orders", "order_items", "payments"]) await q(`ALTER TABLE public.${table} ENABLE TRIGGER USER`);

// ---- the admin marks the godown in-charge; nobody else can
await refuses(() => as(CLK_USER, "authenticated", () => q("SELECT public.admin_set_staff_incharge($1, true)", [inchargeId])), /Only administrators can choose the godown in-charge/, "staff");
assert.equal((await callAs(ADMIN, "SELECT public.admin_set_staff_incharge($1, true) AS r", [inchargeId])).is_incharge, true);
const offId = (await q(`SELECT id FROM public.staff_employees WHERE user_id = '${OFF_USER}'`))[0].id;
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_set_staff_incharge($1, true)", [offId])), /Only an active employee/, "inactive");
assert.equal((await callAs(IN_CHARGE, "SELECT public.my_delivery_role() AS r")).role, "incharge");
assert.equal((await callAs(CLK_USER, "SELECT public.my_delivery_role() AS r")).role, "staff");
assert.equal((await callAs(P_CLK, "SELECT public.my_delivery_role() AS r")).role, "partner");
assert.equal(await callAs(CUSTOMER, "SELECT public.my_delivery_role() AS r"), null, "a customer has no godown role");
assert.deepEqual((await callAs(ADMIN, "SELECT public.delivery_qr_rules() AS r")),
  { staff_print_slips: true, staff_print_note: false, staff_handover: false, partner_print_slips: false, partner_print_note: false, partner_handover: false });

// ---- the invoice's code: the customer and admins, only once paid, confirmed and invoiced; the same on every copy
const c1 = await codeFor(CUSTOMER, "TEST-INV-1");
assert.match(c1.code, /^[A-Za-z0-9_-]{22}$/);
assert.equal(c1.why, "paid");
assert.equal((await codeFor(CUSTOMER, "TEST-INV-1")).code, c1.code, "the same QR on every download");
assert.equal((await codeFor(ADMIN, "TEST-INV-1")).code, c1.code, "and on the office's copy");
await refuses(() => codeFor(HBL_USER, "TEST-INV-1"), /This is not your order/, "someone else");
await refuses(() => codeFor(P_OFF, "TEST-INV-1"), /This is not your order/, "a suspended partner");
await refuses(() => codeFor(CUSTOMER, "NO-SUCH-ORDER"), /This is not your order/, "the same answer for an order that does not exist");
assert.equal((await codeFor(ADMIN, "NO-SUCH-ORDER")).why, "not_found", "admins are told it does not exist");
assert.equal((await codeFor(CUSTOMER, "TEST-INV-3")).code, null, "not paid and confirmed: no QR");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.delivery_invoice_scan($1,'check',NULL,$2)", [c1.code, CUSTOMER])), /permission denied/, "customers cannot scan");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT * FROM private.order_delivery_codes")), /permission denied/, "the codes are not served");

// ---- the delivery note is raised automatically when the payment is confirmed (no admin press)
const auto = await one("SELECT public.issue_delivery_note_auto($1,$2) AS r", ["TEST-INV-1", JSON.stringify(ZOHO_PAID("INV-11", "CLKINV-11"))]);
assert.equal(auto.issued, true, JSON.stringify(auto));
const autoNote = (await q("SELECT generated_how, generated_by_name FROM public.delivery_notes WHERE order_no = 'TEST-INV-1'"))[0];
assert.deepEqual(autoNote, { generated_how: "auto", generated_by_name: "Automatic (payment confirmed)" });
assert.equal((await one("SELECT public.issue_delivery_note_auto($1,$2) AS r", ["TEST-INV-1", JSON.stringify(ZOHO_PAID("INV-11", "CLKINV-11"))])).already, true);
assert.equal((await one("SELECT public.issue_delivery_note_auto($1,$2) AS r", ["TEST-INV-3", JSON.stringify(ZOHO_PAID("INV-13", "CLKINV-13"))])).issued, false, "unpaid: not raised");
await refuses(() => one("SELECT public.issue_delivery_note_auto($1,$2,$3,'scan') AS r", ["TEST-INV-2", JSON.stringify(ZOHO_PAID("INV-12", "CLKINV-12")), CLK_USER]),
  /Only the godown in-charge or an administrator can release/, "ordinary staff cannot release");

// ---- scanning the invoice QR
const z1 = { invoice: "INV-11", number: "CLKINV-11" };
let r = await iscan(c1.code, "check", HBL_USER, z1);
assert.equal(r.result, "other_godown");
assert.equal(r.note, undefined, "another godown sees nothing about the customer");
assert.equal(r.lines, undefined);
r = await iscan(c1.code, "check", IN_CHARGE, z1);
assert.equal(r.result, "released", JSON.stringify(r));
assert.equal(r.role, "incharge");
assert.deepEqual(r.can, { print_note: true, print_slips: true, handover: true });
assert.equal(r.note.generated_how, "auto");
assert.equal(r.note.phone_end, "0099");
assert.equal(r.lines.length, 3);
r = await iscan(c1.code, "check", P_CLK, z1);
assert.equal(r.result, "released");
assert.deepEqual(r.can, { print_note: false, print_slips: false, handover: false }, "the partner sees only, by default");
assert.equal((await iscan(c1.code, "handover", P_CLK, { ...z1, lines: [1] })).result, "not_allowed");
assert.equal((await iscan(c1.code, "print_slips", P_CLK, z1)).result, "not_allowed");
r = await iscan(c1.code, "print_slips", CLK_USER, { ...z1, lines: [1, 2] });
assert.equal(r.result, "printed", "staff print slips by default");
assert.deepEqual(r.print.slip_copies, { 1: 1, 2: 1 });
assert.equal(r.print.note.snapshot.items.length, 3, "the paper's content comes with the answer");
assert.equal(r.print.note.snapshot.customer.phone, "", "slips only: no phone");
assert.equal(r.print.note.snapshot.customer.gstin, "", "slips only: no GSTIN");
assert.deepEqual(r.print.note.snapshot.address, {}, "slips only: no address");
assert.equal(r.print.note.snapshot.customer.name, "TEST Customer", "the name is on the slip");
assert.equal((await iscan(c1.code, "print_note", CLK_USER, z1)).result, "not_allowed", "staff do not print the note by default");
assert.equal((await iscan(c1.code, "handover", CLK_USER, { ...z1, lines: [1] })).result, "not_allowed", "staff do not hand over by default");
r = await iscan(c1.code, "print_note", IN_CHARGE, z1);
assert.equal(r.result, "printed");
assert.equal(r.print.note_copy, 1);
assert.equal(r.print.printed_role, "incharge");
assert.equal(r.print.note.snapshot.address.pin, "577522", "the note itself carries the address");

// ---- the admin switches staff handover on; handovers by ticked items, then the order is delivered
await refuses(() => as(CLK_USER, "authenticated", () => q("SELECT public.admin_set_delivery_qr_rules($1)", [JSON.stringify({ staff_handover: true })])), /Only administrators/, "staff");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_set_delivery_qr_rules($1)", [JSON.stringify({ everyone: true })])), /Unknown delivery rule/, "unknown");
assert.equal((await callAs(ADMIN, "SELECT public.admin_set_delivery_qr_rules($1) AS r", [JSON.stringify({ staff_handover: true })])).staff_handover, true);
r = await iscan(c1.code, "handover", CLK_USER, { ...z1, lines: [1] });
assert.equal(r.result, "handed_over", JSON.stringify(r));
assert.deepEqual(r.handed_now, [1]);
assert.equal(r.order_delivered, false);
assert.equal((await iscan(c1.code, "handover", IN_CHARGE, { ...z1, lines: [1, 2] })).result, "partly_handed_over", "item 1 went meanwhile");
r = await iscan(c1.code, "handover", IN_CHARGE, { ...z1, lines: [2, 3] });
assert.equal(r.result, "handed_over");
assert.equal(r.order_delivered, true);
assert.equal((await q("SELECT order_status FROM public.orders WHERE order_no = 'TEST-INV-1'"))[0].order_status, "Delivered");
assert.equal((await iscan(c1.code, "check", IN_CHARGE, z1)).result, "already_handed_over");
const rows = await q("SELECT h.slip_line, h.actor_role, h.code_id, h.invoice_code_id IS NOT NULL AS by_invoice FROM public.delivery_handovers h JOIN public.delivery_notes n ON n.id = h.note_id WHERE n.order_no = 'TEST-INV-1' ORDER BY h.slip_line");
assert.deepEqual(rows.map((x) => [x.slip_line, x.actor_role, x.code_id, x.by_invoice]), [[1, "staff", null, true], [2, "incharge", null, true], [3, "incharge", null, true]]);

// ---- 20261112150000: who handed over, with their mobile, shows on the scan and on the invoice, with the godown
const phones = await q("SELECT h.slip_line, h.actor_phone FROM public.delivery_handovers h JOIN public.delivery_notes n ON n.id = h.note_id WHERE n.order_no = 'TEST-INV-1' ORDER BY h.slip_line");
assert.deepEqual(phones.map((x) => x.actor_phone), ["9000000011", "9000000014", "9000000014"], "each hand-over keeps the person's mobile");
const shown = await codeFor(CUSTOMER, "TEST-INV-1");
assert.equal(shown.items, 3);
assert.equal(shown.handovers.length, 3);
assert.deepEqual(
  shown.handovers.map((x) => [x.line, x.item, x.by, x.role, x.phone, x.godown]),
  [[1, "TEST Rice 25 kg", "Ravi CLK", "staff", "9000000011", "Challakere Godown"],
   [2, "TEST Oil 1 L", "Inchara CLK", "incharge", "9000000014", "Challakere Godown"],
   [3, "TEST Sugar 50 kg", "Inchara CLK", "incharge", "9000000014", "Challakere Godown"]],
  "the invoice lists who handed over which item");
assert.ok(shown.handovers.every((x) => typeof x.at === "string" && x.at.length > 10), "with the time");
assert.equal(shown.godown.name, "Challakere Godown");
assert.equal(shown.godown.id, "BR-CLK");
assert.equal(shown.godown.partner_name, "Partner CLK", "the godown's channel partner too");
assert.equal(shown.godown.partner_phone, "9000000021");
const checked = await iscan(c1.code, "check", IN_CHARGE, z1);
assert.equal(checked.by_phone, "9000000014", "the scan says who scanned, with their mobile");
assert.equal(checked.godown_details.name, "Challakere Godown");
assert.equal(checked.lines[0].handover.phone, "9000000011", "each line's hand-over carries the mobile");

// ---- not raised yet: staff see it is not released; the in-charge's scan raises it (Zoho read just now)
const c2 = await codeFor(CUSTOMER, "TEST-INV-2");
const z2 = { invoice: "INV-12", number: "CLKINV-12" };
assert.equal((await iscan(c2.code, "check", CLK_USER, z2)).result, "not_released");
r = await iscan(c2.code, "check", IN_CHARGE, z2);
assert.equal(r.result, "released");
assert.equal(r.released_now, true);
assert.equal(r.note.generated_how, "scan");
assert.equal(r.note.generated_by_name, "Inchara CLK");
assert.equal((await iscan(c2.code, "check", IN_CHARGE, { zoho: null })).result, "released", "a check on the last reading");

// ---- an admin replaces the QR: the old one scans red, the invoice gets the new one
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT public.admin_replace_invoice_delivery_code('TEST-INV-2','lost')")), /Only administrators/, "customer");
await refuses(() => as(ADMIN, "authenticated", () => q("SELECT public.admin_replace_invoice_delivery_code('TEST-INV-2','x')")), /Enter the reason/, "reason");
assert.equal((await callAs(ADMIN, "SELECT public.admin_replace_invoice_delivery_code('TEST-INV-2','invoice shared on WhatsApp') AS r")).generation, 2);
r = await iscan(c2.code, "check", IN_CHARGE, z2);
assert.equal(r.result, "replaced");
assert.equal(r.invoice.revoke_reason, "invoice shared on WhatsApp");
assert.equal(r.invoice.live_generation, 2);
const elsewhere = await iscan(c2.code, "check", HBL_USER, z2);
assert.equal(elsewhere.result, "other_godown", "another godown is not told why a QR was replaced");
assert.equal(elsewhere.invoice.revoke_reason, undefined);
const c2b = await codeFor(CUSTOMER, "TEST-INV-2");
assert.notEqual(c2b.code, c2.code);
assert.equal(c2b.generation, 2);
assert.equal((await iscan(c2b.code, "check", IN_CHARGE, z2)).result, "released");

// ---- the office prints the released note without a QR; the godown lists
r = await one("SELECT public.delivery_admin_release_print('TEST-INV-2', true, ARRAY[1,2,3], $1, $2) AS r", [JSON.stringify(ZOHO_PAID("INV-12", "CLKINV-12")), ADMIN]);
assert.equal(r.note_copy, 1);
assert.equal(r.printed_role, "admin");
await refuses(() => one("SELECT public.delivery_admin_release_print('TEST-INV-2', true, '{}', NULL, $1) AS r", [CLK_USER]), /Only administrators can print/, "staff at the office page");
const listed = await as(IN_CHARGE, "authenticated", () => q("SELECT note_no, order_no, to_go, released_how, delivered FROM public.godown_released_notes()"));
assert.ok(listed.some((x) => x.order_no === "TEST-INV-1" && x.to_go === 0 && x.delivered === true));
assert.ok(listed.some((x) => x.order_no === "TEST-INV-2" && x.to_go === 3 && x.released_how === "scan"));
assert.equal((await as(HBL_USER, "authenticated", () => q("SELECT * FROM public.godown_released_notes() WHERE order_no LIKE 'TEST-INV-%'"))).length, 0, "another godown's list");
await refuses(() => as(CUSTOMER, "authenticated", () => q("SELECT * FROM public.godown_released_notes()")), /Only godown staff/, "customer");

// ---- 20261112150000: the invoice keeps the order's own channel partner (whose signature it carries) after the
// godown changes partner; the scan screen shows the partner running the godown today.
const P_NEW = uid("b4");
await q(`INSERT INTO auth.users (id, email) VALUES ('${P_NEW}', 'p4@test.local') ON CONFLICT DO NOTHING`);
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE user_id = $1", [P_CLK]);
await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${P_NEW}','BR-CLK','Partner New','p4@test.local','9000000024')`);
const keptPartner = await codeFor(CUSTOMER, "TEST-INV-1");
assert.equal(keptPartner.godown.partner_name, "Partner CLK", "an older invoice keeps its own partner");
assert.equal(keptPartner.godown.partner_phone, "9000000021");
const today = await iscan(c1.code, "check", IN_CHARGE, z1);
assert.equal(today.godown_details.partner_name, "Partner New", "the scan screen names today's partner");
assert.equal(keptPartner.reopened, 0, "nothing reopened on this order");

// ---- a printed paper's QR still works through the old scan (DN papers already printed)
assert.equal(await one("SELECT public.delivery_invoice_scan($1,'check',NULL,$2) AS r", [noteOriginal, IN_CHARGE]), null, "a paper code is not an invoice code");

console.log("invoice delivery QR OK");
