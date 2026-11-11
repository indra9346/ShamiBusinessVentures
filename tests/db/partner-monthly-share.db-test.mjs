// Real-Postgres check of 20261111150000_partner_profit_share_and_commission_switch.sql, on PGlite with every migration in the repo and
// small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho, because PGlite is not a
// dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/partner-monthly-share.db-test.mjs
//
// It must end with "partner monthly share OK".
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261111150000_partner_profit_share_and_commission_switch.sql";

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
const ADMIN = uid("a1"), CUSTOMER = uid("c1"), C_USER = uid("b1"), H_USER = uid("b2"), OLD_USER = uid("b3"), NEW_USER = uid("b4");
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${CUSTOMER}','c@test.local'),('${C_USER}','pc@test.local'),('${H_USER}','ph@test.local'),('${OLD_USER}','po@test.local'),('${NEW_USER}','pn@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${CUSTOMER}','customer')`);
await q("UPDATE public.profiles SET full_name = 'Head Office' WHERE id = $1", [ADMIN]);
for (const [id, code, name] of [["BR-CLK", "CLK", "Challakere Godown"], ["BR-HBL", "HBL", "Hubli Godown"], ["BR-MID", "MID", "Midway Godown"]])
  await q("INSERT INTO public.branches (id, code, name, active) VALUES ($1,$2,$3,true) ON CONFLICT (id) DO UPDATE SET active = true", [id, code, name]);

const istAt = (day, time = "10:00") => `${day}T${time}:00+05:30`;
const partner = async (user, branch, name, since) => {
  const id = (await q("INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone, created_at) VALUES ($1,$2,$3,$4,'9000000001',$5) RETURNING id", [user, branch, name, `${name}@test.local`, since]))[0].id;
  await q("UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'added'", [id, since]);
  return id;
};
const CHALLAKERE = await partner(C_USER, "BR-CLK", "Partner C", istAt("2026-08-01"));
const HUBLI = await partner(H_USER, "BR-HBL", "Partner H", istAt("2026-08-01"));
const OLD = await partner(OLD_USER, "BR-MID", "Partner Old", istAt("2026-08-01"));
await q("INSERT INTO public.partner_commission_rules (branch_id, product_id, kind, value) VALUES ('BR-CLK',NULL,'per_unit',3),('BR-HBL',NULL,'per_unit',5),('BR-MID',NULL,'percent',2)");

await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
for (const [id, name, cost] of [["P1", "TEST Rice", 40], ["P2", "TEST No Rate", null], ["P3", "TEST Oil", "not a number"]])
  await q("INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ($1,'V1','Rice','approved',true,$2) ON CONFLICT (id) DO NOTHING",
    [id, JSON.stringify({ id, name, stock: 500, sold: 0, ...(cost === null ? {} : { purchasePrice: cost }) })]);
await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
await q("ALTER TABLE public.return_requests DISABLE TRIGGER USER");

// Orders go straight in, but the commission triggers under test stay on.
await q("ALTER TABLE public.orders DISABLE TRIGGER USER");
await q("ALTER TABLE public.orders ENABLE TRIGGER orders_partner_commission_status");
await q("ALTER TABLE public.order_items DISABLE TRIGGER USER");
await q("ALTER TABLE public.order_items ENABLE TRIGGER order_items_partner_commission");
await q("ALTER TABLE public.order_items ENABLE TRIGGER order_items_partner_commission_update");

async function order(no, { branch = "BR-CLK", placed, status = "Payment Confirmed", payment = "Pending", shipping = 0, lines = [["P1", 2, 200, 0, 5]] } = {}) {
  const subtotal = lines.reduce((sum, line) => sum + line[2], 0);
  const id = (await q(`INSERT INTO public.orders (order_no, user_id, customer_name, customer_email, customer_phone, total, subtotal, gst_amount, shipping, paid_amount,
      payment_status, payment_method, order_status, branch_id, created_at, shipping_address, shipping_method, prices_include_gst, vendor_ids)
    VALUES ($1,$2,'TEST Customer','c@test.local','9000000009',$3,$4,0,$5,0,$6,'UPI',$7,$8,$9,$10,'Pickup',true,ARRAY['V1']) RETURNING id`,
    [no, CUSTOMER, subtotal + shipping, subtotal, shipping, payment, status, branch, placed, JSON.stringify({ line: "TEST", city: "TEST", state: "Karnataka", pin: "577522" })]))[0].id;
  const items = [];
  for (const [product, qty, lineTotal, coupon, gst] of lines) {
    items.push((await q(`INSERT INTO public.order_items (order_id, product_id, product_name, qty, unit_price, line_total, gst_rate, coupon_share, vendor_id, vendor)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'V1','House') RETURNING id`, [id, product, `Name of ${product}`, qty, lineTotal / qty, lineTotal, gst, coupon]))[0].id);
  }
  return { id, no, items };
}
/** Marks an order delivered and paid, at a moment in the past. */
async function finish(o, when) {
  await q("UPDATE public.orders SET order_status = 'Delivered', payment_status = 'Paid', paid_amount = total WHERE id = $1", [o.id]);
  await q("UPDATE public.partner_commissions SET earned_at = $2 WHERE order_id = $1", [o.id, when]);
}
const line = async (itemId) => (await q("SELECT * FROM public.partner_commissions WHERE order_item_id = $1", [itemId]))[0];

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
const SEP = "2026-09-01", OCT = "2026-10-01", NOV = "2026-11-01", DEC = "2026-12-01";
const statement = (user, month, branch = null) => as(user, async () => (await q("SELECT public.partner_month_statement($1,$2) AS s", [month, branch]))[0].s);
const adminStatement = (month, branch = "BR-CLK") => statement(ADMIN, month, branch);
const addDeduction = (user, month, category, label, amount, opts = {}) => as(user, async () => (await q("SELECT public.partner_add_month_deduction($1,$2,$3,$4,$5,$6) AS r", [month, category, label, amount, opts.branch ?? null, opts.key ?? null]))[0].r);
const removeDeduction = (user, id) => as(user, () => q("SELECT public.partner_remove_month_deduction($1)", [id]));
const close = (month, branch = "BR-CLK", user = ADMIN) => as(user, async () => (await q("SELECT public.admin_close_partner_month($1,$2) AS r", [branch, month]))[0].r);
const reopen = (month, reason, branch = "BR-CLK") => as(ADMIN, () => q("SELECT public.admin_reopen_partner_month($1,$2,$3)", [branch, month, reason]));
const pay = (id, opts = {}) => as(opts.user ?? ADMIN, async () => (await q("SELECT public.admin_pay_partner_statement($1,$2,$3,$4,'',$5,$6) AS r",
  [id, opts.on ?? "2026-11-10", opts.mode ?? "NEFT", opts.ref === undefined ? `UTR${Math.random().toString(36).slice(2, 12).toUpperCase()}` : opts.ref, opts.amount ?? null, opts.key ?? null]))[0].r);
const summary = async (id = CHALLAKERE) => (await as(ADMIN, () => q("SELECT * FROM public.partner_settlement_summary() WHERE partner_id = $1", [id])))[0];
const money = (v) => Number(v);
const balanced = async (label) => {
  const s = await summary();
  assert.equal(Math.round((money(s.earned) - money(s.paid)) * 100), Math.round((money(s.due) - money(s.owed_back)) * 100), `books out of balance after ${label}: ${JSON.stringify(s)}`);
  return s;
};
const figures = (s, keys) => Object.fromEntries(keys.map((key) => [key, money(s[key])]));

// ---------------------------------------------------------------- Type 1 goes on exactly as before
// Placed before Challakere changes: a per-unit line, even though it finishes in a net-profit month.
const BEFORE = await order("T-BEFORE", { placed: istAt("2026-08-30"), lines: [["P1", 4, 400, 0, 5]] });
assert.deepEqual([(await line(BEFORE.items[0])).kind, money((await line(BEFORE.items[0])).rate), money((await line(BEFORE.items[0])).amount)], ["per_unit", 3, 12], "a per-unit godown records as before");
const HUBLI_ORDER = await order("T-HUBLI", { branch: "BR-HBL", placed: istAt("2026-09-05"), shipping: 20 });
await finish(HUBLI_ORDER, istAt("2026-09-06"));
assert.deepEqual([(await line(HUBLI_ORDER.items[0])).kind, money((await line(HUBLI_ORDER.items[0])).amount), (await line(HUBLI_ORDER.items[0])).status], ["per_unit", 10, "earned"]);
assert.deepEqual((await statement(H_USER, SEP)).applies, false, "a per-unit godown has no monthly statement");
assert.deepEqual((await adminStatement(SEP, "BR-HBL")).applies, false);
await refuses(() => addDeduction(H_USER, SEP, "rent", "", 100), /per-unit commission/, "a deduction on a per-unit godown");
await refuses(() => close(SEP, "BR-HBL"), /per-unit commission/, "closing a per-unit godown");

// ---------------------------------------------------------------- commission switched off for a product
const OFF_BEFORE = await order("T-OFF-BEFORE", { branch: "BR-HBL", placed: istAt("2026-09-07"), lines: [["P3", 2, 200, 0, 5]] });
assert.equal(money((await line(OFF_BEFORE.items[0])).amount), 10, "the godown's default before the switch");
await q("INSERT INTO public.partner_commission_rules (branch_id, product_id, kind, value, enabled) VALUES ('BR-HBL','P3','per_unit',9,false)");
const OFF = await order("T-OFF", { branch: "BR-HBL", placed: istAt("2026-09-08"), lines: [["P3", 2, 200, 0, 5], ["P1", 2, 200, 0, 5]] });
assert.deepEqual([(await line(OFF.items[0])).kind, money((await line(OFF.items[0])).rate), money((await line(OFF.items[0])).amount)], ["per_unit", 0, 0], "switched off: a zero line");
assert.equal(money((await line(OFF.items[1])).amount), 10, "another product on the same order still earns");
assert.equal(money((await line(OFF_BEFORE.items[0])).amount), 10, "an order already placed does not change");
await q("UPDATE public.order_items SET qty = 3, line_total = 300 WHERE id = $1", [OFF.items[0]]);
assert.equal(money((await line(OFF.items[0])).amount), 0, "editing the line keeps it at zero");
await q("UPDATE public.partner_commission_rules SET enabled = false WHERE branch_id = 'BR-HBL' AND product_id IS NULL");
const OFF_DEFAULT = await order("T-OFF-DEFAULT", { branch: "BR-HBL", placed: istAt("2026-09-09"), lines: [["P1", 2, 200, 0, 5]] });
assert.equal(money((await line(OFF_DEFAULT.items[0])).amount), 0, "the default can be switched off too");
await q("UPDATE public.partner_commission_rules SET enabled = true WHERE branch_id = 'BR-HBL'");
const ON_AGAIN = await order("T-ON-AGAIN", { branch: "BR-HBL", placed: istAt("2026-09-10"), lines: [["P3", 2, 200, 0, 5]] });
assert.deepEqual([money((await line(ON_AGAIN.items[0])).rate), money((await line(ON_AGAIN.items[0])).amount)], [9, 18], "switched on again: the saved rate is back");
assert.equal(money((await line(OFF.items[0])).amount), 0, "the order placed while off stays at zero");
await q("DELETE FROM public.partner_commission_rules WHERE branch_id = 'BR-HBL' AND product_id = 'P3'");

// ---------------------------------------------------------------- choosing the way of paying
const setScheme = (user, branch, month, scheme, share = null, tax = 0) => as(user, async () => (await q("SELECT public.admin_set_godown_commission_scheme($1,$2,$3,$4,$5) AS r", [branch, month, scheme, share, tax]))[0].r);
await refuses(() => setScheme(C_USER, "BR-CLK", DEC, "net_profit", 50, 25), /Only administrators/, "a partner chooses their own pay");
await refuses(() => setScheme(CUSTOMER, "BR-CLK", DEC, "net_profit", 50, 25), /Only administrators/, "a customer");
await refuses(() => setScheme(ADMIN, "BR-CLK", OCT, "net_profit", 50, 25), /Earlier months stay as they are/, "back-dating");
await refuses(() => setScheme(ADMIN, "BR-CLK", DEC, "net_profit", null, 25), /partner's share/, "no share");
await refuses(() => setScheme(ADMIN, "BR-CLK", DEC, "net_profit", 0, 25), /partner's share/, "zero share");
await refuses(() => setScheme(ADMIN, "BR-CLK", DEC, "net_profit", 101, 25), /partner's share/, "over 100");
await refuses(() => setScheme(ADMIN, "BR-CLK", DEC, "net_profit", 50, 101), /income tax/, "tax over 100");
await refuses(() => setScheme(ADMIN, "BR-NONE", DEC, "net_profit", 50, 25), /Godown not found/, "unknown godown");
await refuses(() => setScheme(ADMIN, "BR-CLK", DEC, "monthly", 50, 25), /Choose how/, "unknown way");
assert.equal((await as(C_USER, () => q("SELECT * FROM public.godown_commission_schemes"))).length, 0, "a partner cannot read the settings directly");
// A later month is only a plan: today's orders are not touched.
await setScheme(ADMIN, "BR-HBL", DEC, "net_profit", 40, 10);
const STILL_PER_UNIT = await order("T-NOW-HBL", { branch: "BR-HBL", placed: new Date().toISOString() });
assert.equal((await line(STILL_PER_UNIT.items[0])).kind, "per_unit", "a plan for next month leaves this month per-unit");
await q("DELETE FROM public.godown_commission_schemes WHERE branch_id = 'BR-HBL'");

// Challakere has been on monthly profit share since September (dated directly, because the screen cannot back-date).
await q(`INSERT INTO public.godown_commission_schemes (branch_id, from_month, starts_at, scheme, share_percent, tax_percent) VALUES ('BR-CLK',$1,$2,'net_profit',50,25)`, [SEP, "2026-08-31T18:30:00Z"]);

// ---------------------------------------------------------------- what a month counts
// 2 x P1: 200 - coupon 21 with GST (20 without) - cost 80 + delivery 50 = 150
const O1 = await order("T-1", { placed: istAt("2026-09-05"), shipping: 50, lines: [["P1", 2, 200, 21, 5]] });
const l1 = await line(O1.items[0]);
assert.deepEqual([l1.kind, money(l1.rate), money(l1.amount)], ["net_profit", 0, 0], "a net-profit godown records a zero line, whatever the per-unit rate");
await finish(O1, istAt("2026-09-10"));
// No purchase rate: flagged and left out, delivery still counts.
const O2 = await order("T-NORATE", { placed: istAt("2026-09-06"), lines: [["P2", 1, 100, 0, 5]] });
await finish(O2, istAt("2026-09-11"));
// A rate that is not a number is not a rate.
const O3 = await order("T-BADRATE", { placed: istAt("2026-09-06"), lines: [["P3", 1, 60, 0, 5]] });
await finish(O3, istAt("2026-09-11"));
// Placed in September, finishes on 1 October at 00:10 IST: October's.
const O4 = await order("T-LATE", { placed: istAt("2026-09-29"), lines: [["P1", 1, 100, 0, 5]] });
await finish(O4, istAt("2026-10-01", "00:10"));
// Last minute of 30 September IST: September's. (In UTC it is still the 30th either way.)
const O5 = await order("T-EDGE", { placed: istAt("2026-09-29"), lines: [["P1", 1, 90, 0, 5]] });
await finish(O5, istAt("2026-09-30", "23:59"));
await q("UPDATE public.order_items SET unit_price = 90 WHERE order_id = $1", [O5.id]);
// Not finished: pending, nothing counted. Cancelled: nothing counted.
const OPEN_ORDER = await order("T-OPEN", { placed: istAt("2026-09-20") });
const CANCELLED = await order("T-CANCELLED", { placed: istAt("2026-09-20"), status: "Cancelled" });
assert.equal((await line(CANCELLED.items[0])).status, "cancelled");
// The per-unit order placed before the change finishes in September: paid per unit, not in the income.
await finish(BEFORE, istAt("2026-09-12"));

const expectSept = { sales: 290, coupons: 20, cost: 120, delivery: 50, corrections: 0, income: 200 };
let s = await adminStatement(SEP);
assert.deepEqual(figures(s, Object.keys(expectSept)), expectSept, "90 sale on the last minute included, 400 per-unit order and late order not");
assert.equal(s.status, "open"); assert.equal(s.applies, true); assert.equal(s.month_over, true);
assert.equal(s.orders, 4); assert.equal(s.lines_without_cost, 2, "no rate and a bad rate"); assert.equal(money(s.sales_without_cost), 160);
assert.deepEqual([money(s.share_percent), money(s.tax_percent)], [50, 25]);
assert.equal(s.partner_name, "Partner C");
assert.equal(s.lines.filter((row) => row.row_kind === "sale").length, 4);

// ---------------------------------------------------------------- what a partner may see
const seen = await statement(C_USER, SEP);
assert.equal(money(seen.income), 200);
assert.equal(seen.lines, undefined, "a partner gets no lines");
assert.equal(seen.events, undefined, "a partner gets no log");
assert.ok(!JSON.stringify(seen).includes("purchasePrice") && !JSON.stringify(seen).includes("Name of P1"), "no product or purchase rate");
assert.equal(seen.is_admin, false);
for (const table of ["partner_month_statements", "partner_statement_lines", "partner_month_deductions", "partner_statement_events"])
  await refuses(() => as(C_USER, () => q(`SELECT * FROM public.${table}`)), /permission denied/, `a partner reads ${table} directly`);
assert.equal((await statement(H_USER, SEP)).applies, false, "Hubli's partner gets nothing of Challakere's, asked or not");
assert.equal((await as(H_USER, async () => (await q("SELECT public.partner_month_statement($1,'BR-CLK') AS s", [SEP]))[0].s)).applies, false, "naming another godown does not help");
await refuses(() => statement(CUSTOMER, SEP), /Only an active channel partner/, "a customer");
await refuses(() => statement(null, SEP), /permission denied|sign in/, "not signed in");
await refuses(() => statement(ADMIN, SEP, null), /Choose a godown/, "an admin must name the godown");
await refuses(() => statement(C_USER, DEC), /has started/, "a month not started");
for (const fn of ["private.net_month_rows('BR-CLK', '2026-09-01')", "private.net_month_totals('BR-CLK', '2026-09-01', 0, 50)", "private.net_month_partner('BR-CLK', '2026-09-01')"])
  await refuses(() => as(C_USER, () => q(`SELECT * FROM ${fn}`)), /permission denied/, `partner calls ${fn}`);

// ---------------------------------------------------------------- deductions
const rent = await addDeduction(C_USER, SEP, "rent", "September rent", 30, { key: uid("d1") });
assert.equal(rent.added_by_role, "partner"); assert.equal(rent.added_by_name, "Partner C");
const replay = await addDeduction(C_USER, SEP, "rent", "September rent", 30, { key: uid("d1") });
assert.equal(replay.replayed, true, "a double press adds one line"); assert.equal(replay.id, rent.id);
const staff = await addDeduction(ADMIN, SEP, "staff", "", 20, { branch: "BR-CLK" });
assert.equal(staff.added_by_role, "admin"); assert.equal(staff.added_by_name, "Head Office");
const extra = await addDeduction(C_USER, SEP, "other", "Generator diesel", 12.345);
assert.equal(money(extra.amount), 12.35, "to the paisa");
await refuses(() => addDeduction(C_USER, SEP, "other", " ", 10), /Say what this deduction is for/, "other needs words");
await refuses(() => addDeduction(C_USER, SEP, "travel", "x", 10), /Choose what/, "unknown kind");
await refuses(() => addDeduction(C_USER, SEP, "rent", "", 0), /Enter the amount/, "zero");
await refuses(() => addDeduction(C_USER, SEP, "rent", "", -5), /Enter the amount/, "negative");
await refuses(() => addDeduction(C_USER, SEP, "rent", "x".repeat(121), 5), /too long/, "long text");
await refuses(() => addDeduction(H_USER, SEP, "rent", "", 5, { branch: "BR-CLK" }), /per-unit commission/, "Hubli adding to Challakere only reaches Hubli");
await refuses(() => addDeduction(CUSTOMER, SEP, "rent", "", 5), /Only an active/, "a customer");
await refuses(() => addDeduction(C_USER, DEC, "rent", "", 5), /has started/, "future month");
await refuses(() => removeDeduction(C_USER, staff.id), /only remove a deduction you added/, "a partner removes the office's line");
await refuses(() => removeDeduction(H_USER, rent.id), /only remove a deduction you added/, "another partner");
await removeDeduction(C_USER, extra.id);
await refuses(() => removeDeduction(C_USER, extra.id), /already gone/, "twice");
// The admin may remove the partner's line, and the log keeps it.
const wrong = await addDeduction(C_USER, SEP, "marketing", "Banner", 5);
await removeDeduction(ADMIN, wrong.id);

s = await adminStatement(SEP);
const expectAfter = { income: 200, deductions_total: 50, profit_before_tax: 150, tax_amount: 37.5, remaining: 112.5, share_amount: 56.25 };
assert.deepEqual(figures(s, Object.keys(expectAfter)), expectAfter);
assert.deepEqual(s.deductions.map((d) => [d.category, money(d.amount), d.added_by_role, d.can_remove]), [["rent", 30, "partner", true], ["staff", 20, "admin", true]]);
const asPartner = await statement(C_USER, SEP);
assert.deepEqual(asPartner.deductions.map((d) => d.can_remove), [true, false], "a partner sees which lines they can remove");
assert.deepEqual(s.events.map((e) => e.event).filter((e) => e === "deduction_removed").length, 2, "removals are logged");

// A rate for this month only.
await refuses(() => as(C_USER, () => q("SELECT public.admin_set_partner_month_rates('BR-CLK',$1,90,0)", [SEP])), /Only administrators/, "a partner sets their share");
await as(ADMIN, () => q("SELECT public.admin_set_partner_month_rates('BR-CLK',$1,60,20)", [SEP]));
s = await adminStatement(SEP);
assert.deepEqual(figures(s, ["share_percent", "tax_percent", "tax_amount", "remaining", "share_amount"]), { share_percent: 60, tax_percent: 20, tax_amount: 30, remaining: 120, share_amount: 72 });
assert.equal(s.rates_custom, true);
await as(ADMIN, () => q("SELECT public.admin_set_partner_month_rates('BR-CLK',$1,50,25)", [SEP]));

// ---------------------------------------------------------------- closing
await refuses(() => close(NOV), /still running/, "the running month");
await refuses(() => close(SEP, "BR-CLK", C_USER), /Only administrators/, "a partner closes");
await refuses(() => close(OCT), /Close September 2026 first/, "oldest first");
const closed = await close(SEP);
assert.equal(money(closed.share_amount), 56.25);
await refuses(() => close(SEP), /already closed/, "twice");
await refuses(() => addDeduction(C_USER, SEP, "rent", "", 5), /closed/, "adding to a closed month");
await refuses(() => addDeduction(ADMIN, SEP, "rent", "", 5, { branch: "BR-CLK" }), /closed/, "the admin too");
await refuses(() => removeDeduction(C_USER, rent.id), /closed/, "removing from a closed month");
await refuses(() => as(ADMIN, () => q("SELECT public.admin_set_partner_month_rates('BR-CLK',$1,60,20)", [SEP])), /closed/, "percentages of a closed month");
s = await adminStatement(SEP);
assert.equal(s.status, "closed"); assert.equal(s.closed_by_name, "Head Office"); assert.equal(s.can_add, false);
assert.equal(s.lines.length, 4); assert.equal(s.lines.find((row) => row.order_no === "T-1").cost_known, true);
assert.deepEqual(s.deductions.map((d) => d.can_remove), [false, false]);
// A closed month's figures do not move when the world does.
await q(`UPDATE public.catalog_products SET payload = payload || '{"purchasePrice": 9}'::jsonb WHERE id = 'P1'`);
assert.equal(money((await adminStatement(SEP)).income), 200, "a later purchase rate does not change a closed month");
await q(`UPDATE public.catalog_products SET payload = payload || '{"purchasePrice": 40}'::jsonb WHERE id = 'P1'`);

// ---------------------------------------------------------------- it feeds the existing payouts
let pos = await balanced("closing");
assert.equal(money(pos.earned), 56.25 + 12, "the month plus the per-unit order");
assert.equal(money(pos.due), 56.25 + 12);
const settle = await as(ADMIN, () => q("SELECT * FROM public.partner_settlement_lines($1)", [CHALLAKERE]));
assert.deepEqual(settle.map((row) => row.order_no), ["T-BEFORE"], "only per-unit lines are settled line by line");
assert.equal(money(settle[0].due_amount), 12);
const list = await as(ADMIN, () => q("SELECT * FROM public.partner_statements_to_pay()"));
assert.deepEqual(list.map((row) => [row.partner_name, row.godown.includes("Challakere"), money(row.share_amount), money(row.paid), money(row.due)]), [["Partner C", true, 56.25, 0, 56.25]]);
await refuses(() => as(C_USER, () => q("SELECT * FROM public.partner_statements_to_pay()")), /Only administrators/, "a partner lists payments");

const SID = closed.statement_id;
await refuses(() => pay(SID, { user: C_USER }), /Only administrators/, "a partner pays self");
await refuses(() => pay(SID, { amount: 60 }), /most this payout can be is Rs 56\.25/, "more than the share");
await refuses(() => pay(SID, { ref: "" }), /UTR or reference/, "a bank payment needs a reference");
await refuses(() => pay(SID, { on: "2099-01-01" }), /not in the future/, "a future date");
await refuses(() => pay(uid("99")), /not closed/, "unknown");
const part = await pay(SID, { amount: 20, ref: "utr 7777 8888", key: uid("e1") });
assert.equal(money(part.amount), 20);
assert.equal((await pay(SID, { amount: 20, ref: "UTR77778888", key: uid("e1") })).replayed, true, "a second press records nothing new");
await refuses(() => pay(SID, { amount: 1, ref: "UTR77778888" }), /already recorded/, "same UTR");
pos = await balanced("part payment");
assert.equal(money(pos.paid), 20); assert.equal(money(pos.due), 48.25);
let seenBy = await statement(C_USER, SEP);
assert.deepEqual(figures(seenBy, ["paid", "due"]), { paid: 20, due: 36.25 });
const po = (await as(C_USER, () => q("SELECT * FROM public.partner_payouts WHERE partner_id = $1", [CHALLAKERE])))[0];
assert.equal(po.statement_id, SID); assert.equal(po.reference, "UTR77778888");
assert.equal(po.period_from.toISOString?.().slice(0, 7) ?? String(po.period_from).slice(0, 7), "2026-09");
await refuses(() => reopen(SEP, "typing mistake"), /Undo the payout first/, "reopening a paid month");
const second = await pay(SID);
assert.equal(money(second.amount), 36.25, "with no amount: everything left");
await refuses(() => pay(SID, { amount: 1 }), /Nothing is left/, "nothing left");
pos = await balanced("paid in full");
assert.equal(money(pos.due), 12);

// Undo works with the existing button.
await as(ADMIN, () => q("SELECT public.admin_void_partner_payout($1,'the transfer bounced')", [second.id]));
pos = await balanced("undo");
assert.equal(money(pos.due), 12 + 36.25);
assert.equal(money((await statement(C_USER, SEP)).due), 36.25);
await as(ADMIN, () => q("SELECT public.admin_correct_partner_payout($1,$2,'UPI','UTRCORRECTED1','','wrong date typed')", [part.id, "2026-11-09"]));
assert.equal((await q("SELECT mode FROM public.partner_payouts WHERE id = $1", [part.id]))[0].mode, "UPI");
await as(ADMIN, () => q("SELECT public.admin_void_partner_payout($1,'typed in the wrong month')", [part.id]));

// Reopen, change, close again.
await refuses(() => reopen(SEP, "no"), /Say why/, "no reason");
await reopen(SEP, "the rent was wrong");
s = await adminStatement(SEP);
assert.equal(s.status, "open"); assert.equal(s.lines.length, 4); assert.equal(s.rates_custom, true);
await refuses(() => reopen(SEP, "again please"), /not closed/, "not closed");
assert.equal(money((await balanced("reopen")).earned), 12, "an open month is not earned");
await addDeduction(ADMIN, SEP, "marketing", "Pamphlets", 10, { branch: "BR-CLK" });
await close(SEP);
s = await adminStatement(SEP);
assert.deepEqual(figures(s, ["deductions_total", "profit_before_tax", "tax_amount", "remaining", "share_amount"]), { deductions_total: 60, profit_before_tax: 140, tax_amount: 35, remaining: 105, share_amount: 52.5 });
assert.equal((await q("SELECT count(*)::int AS c FROM public.partner_statement_lines WHERE row_kind = 'sale'"))[0].c, 4, "lines are not doubled by closing again");

// ---------------------------------------------------------------- refunds after a month is closed go into the next month
// October: T-LATE earned (100 - 40 = 60). T-1 refunded in full, its 150 comes off, delivery included.
await q("UPDATE public.orders SET payment_status = 'Refunded' WHERE id = $1", [O1.id]);
assert.equal((await line(O1.items[0])).status, "cancelled");
s = await adminStatement(OCT);
assert.deepEqual(figures(s, ["sales", "cost", "delivery", "corrections", "income"]), { sales: 100, cost: 40, delivery: 0, corrections: -150, income: -90 });
assert.equal(s.lines.filter((row) => row.row_kind === "correction").length, 1);
// A loss pays nothing, and no tax is worked out.
assert.deepEqual(figures(s, ["profit_before_tax", "tax_amount", "remaining", "share_amount"]), { profit_before_tax: -90, tax_amount: 0, remaining: -90, share_amount: 0 });
assert.equal(money((await adminStatement(SEP)).income), 200, "September stays as it was closed");
await close(OCT);
await refuses(() => reopen(SEP, "too late now"), /Reopen October 2026 first/, "a later month is closed");
const octId = (await adminStatement(OCT)).statement_id;
await refuses(() => pay(octId, { amount: 1 }), /Nothing is left|most this payout/, "a loss month pays nothing");

// November (the running month): the loss is not carried forward and the correction is not taken twice.
s = await adminStatement(NOV);
assert.deepEqual(figures(s, ["income", "corrections", "share_amount"]), { income: 0, corrections: 0, share_amount: 0 });
assert.equal(s.month_over, false);

// A part return after closing: 1 of 3 bags refunded. Sold in October (still open for this test via November).
const O6 = await order("T-RETURN", { placed: istAt("2026-10-20"), shipping: 30, lines: [["P1", 3, 300, 0, 5]] });
// A line refunded already at the time of counting.
const O7 = await order("T-RETURN-EARLY", { placed: istAt("2026-11-02"), lines: [["P1", 4, 400, 0, 5]] });
const refund = (o, qty) => q(`INSERT INTO public.return_requests (order_id, order_item_id, customer_id, product_id, vendor_id, quantity, amount, reason, status, refund_status)
  VALUES ($1,$2,$3,'P1','V1',$4,10,'TEST','Approved','Refunded')`, [o.id, o.items[0], CUSTOMER, qty]);
await finish(O6, new Date().toISOString());
await finish(O7, new Date().toISOString());
await refund(O7, 1);
s = await adminStatement(NOV);
// O6: 300 - 120 + delivery 30 = 210. O7: 3 of 4 bags: 300 - 120 = 180.
assert.deepEqual(figures(s, ["sales", "cost", "delivery", "income"]), { sales: 600, cost: 240, delivery: 30, income: 390 });

// Everything earned and refunded the same month nets out without a correction.
await refund(O6, 1);
s = await adminStatement(NOV);
assert.deepEqual(figures(s, ["sales", "cost", "delivery", "income"]), { sales: 500, cost: 200, delivery: 30, income: 330 });

// An order counted, un-earned and earned again before the next close is not counted twice.
await q("UPDATE public.orders SET payment_status = 'Partial' WHERE id = $1", [O5.id]);
assert.equal((await line(O5.items[0])).earned_at, null);
assert.equal(money((await adminStatement(NOV)).corrections), -50, "90 - 40 comes off while it is not paid");
await q("UPDATE public.orders SET payment_status = 'Paid' WHERE id = $1", [O5.id]);
s = await adminStatement(NOV);
assert.deepEqual(figures(s, ["corrections", "sales", "income"]), { corrections: 0, sales: 500, income: 330 }, "paid again: no sale and no correction");

// A deleted order is a correction too, and the closed month keeps its record.
await q("DELETE FROM public.partner_commissions WHERE order_item_id = $1", [O3.items[0]]);
s = await adminStatement(NOV);
assert.equal(s.corrections !== undefined, true);
assert.equal(s.lines.filter((row) => row.row_kind === "correction" && row.order_no === "T-BADRATE").length, 1, "a line that is gone is listed");
assert.equal(money(s.corrections), 0, "it had no purchase rate, so it had added nothing to income");

// ---------------------------------------------------------------- the partner changes during a month
await q(`INSERT INTO public.godown_commission_schemes (branch_id, from_month, starts_at, scheme, share_percent, tax_percent) VALUES ('BR-MID',$1,$2,'net_profit',30,0)`, [SEP, "2026-08-31T18:30:00Z"]);
const MID1 = await order("T-MID-OLD", { branch: "BR-MID", placed: istAt("2026-09-05"), lines: [["P1", 1, 100, 0, 5]] });
await finish(MID1, istAt("2026-09-06"));
await addDeduction(OLD_USER, SEP, "rent", "", 10);
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE id = $1", [OLD]);
await q("UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'suspended'", [OLD, istAt("2026-09-20")]);
const NEWCOMER = await partner(NEW_USER, "BR-MID", "Partner New", istAt("2026-09-21"));
const MID2 = await order("T-MID-NEW", { branch: "BR-MID", placed: istAt("2026-09-25"), lines: [["P1", 1, 100, 0, 5]] });
await finish(MID2, istAt("2026-09-26"));
await refuses(() => statement(OLD_USER, SEP), /Only an active channel partner/, "a partner who left");
s = await statement(NEW_USER, SEP);
assert.equal(s.partner_name, "Partner New", "whoever ran it on the last day");
assert.equal(money(s.income), 120, "both partners' orders are in the godown's month");
await close(SEP, "BR-MID");
assert.equal((await q("SELECT partner_id FROM public.partner_month_statements WHERE branch_id = 'BR-MID' AND month = $1", [SEP]))[0].partner_id, NEWCOMER);
assert.equal(money((await summary(NEWCOMER)).due), 33);
assert.equal(money((await summary(OLD)).due), 0);

// A month with nobody at the end cannot be closed: there is no one to pay.
await q("UPDATE public.channel_partners SET status = 'suspended' WHERE id = $1", [NEWCOMER]);
await q("UPDATE public.channel_partner_events SET at = $2 WHERE partner_id = $1 AND event = 'suspended'", [NEWCOMER, istAt("2026-10-10")]);
await addDeduction(ADMIN, OCT, "rent", "", 10, { branch: "BR-MID" });
await refuses(() => close(OCT, "BR-MID"), /no partner to pay/, "nobody running it");

// ---------------------------------------------------------------- switching this month, and back
await setScheme(ADMIN, "BR-HBL", NOV, "net_profit", 40, 10);
const row = (await q("SELECT * FROM public.godown_commission_schemes WHERE branch_id = 'BR-HBL'"))[0];
assert.ok(Date.parse(row.starts_at) <= Date.now() && Date.parse(row.starts_at) > Date.now() - 60_000, "started this month: from now");
const AFTER = await order("T-NOW-AFTER", { branch: "BR-HBL", placed: new Date().toISOString(), lines: [["P1", 1, 100, 0, 5]] });
assert.equal((await line(AFTER.items[0])).kind, "net_profit");
assert.equal((await line(STILL_PER_UNIT.items[0])).kind, "per_unit", "orders already placed this month stay per-unit");
await setScheme(ADMIN, "BR-HBL", NOV, "net_profit", 45, 12);
assert.equal((await q("SELECT starts_at FROM public.godown_commission_schemes WHERE branch_id = 'BR-HBL'"))[0].starts_at.getTime(), new Date(row.starts_at).getTime(), "changing percentages keeps the start");
assert.equal(money((await statement(H_USER, NOV)).share_percent), 45);
await setScheme(ADMIN, "BR-HBL", NOV, "per_unit");
const BACK = await order("T-NOW-BACK", { branch: "BR-HBL", placed: new Date().toISOString() });
assert.equal((await line(BACK.items[0])).kind, "per_unit", "back to per-unit");
assert.equal(money((await line(BACK.items[0])).amount), 10);

// ---------------------------------------------------------------- applying the migration again changes nothing
const before = await q("SELECT id, status, share_amount FROM public.partner_month_statements ORDER BY id");
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
assert.deepEqual(await q("SELECT id, status, share_amount FROM public.partner_month_statements ORDER BY id"), before);
void OPEN_ORDER;

console.log("partner monthly share OK");
