// Payment records on a real Postgres (PGlite), built from every migration in supabase/migrations. All data is made up,
// nothing live is touched. PGlite is not a dependency of the site, so this is not part of test:zoho:
//   PGLITE_PATH=file:///path/to/@electric-sql/pglite/dist/index.js node tests/payment-records.db.mjs
//   WITHOUT_FIX=1 runs the same tests on the database as it was before the fix: the ones for the bugs fail.
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const { PGlite } = await import(process.env.PGLITE_PATH ?? "@electric-sql/pglite");
const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const FIX = "20261103233000_payment_record_fixes.sql";
const WITHOUT_FIX = Boolean(process.env.WITHOUT_FIX);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
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
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
  CREATE PUBLICATION supabase_realtime;
`);
for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name !== FIX).sort()) {
  await db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
}

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const as = (uid) => db.query(`UPDATE auth.cur SET uid = $1`, [uid]);

const ADMIN = randomUUID();
await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'admin@test.in', '{"full_name":"Test Admin"}')`, [ADMIN]);
await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN]);
await db.exec(`UPDATE public.settings SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{branch_routing}', 'false') WHERE key = 'platform_features'`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('upi_direct', '{"enabled":true,"vpa":"shop@upi","payeeName":"Shop","payWindowMinutes":10}', true) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await db.query(`INSERT INTO public.settings (key, value, is_public) VALUES ('bank_transfer', $1::jsonb, false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [JSON.stringify({ accountName: "Sample Traders", accountNumber: "50100123456789", ifsc: "HDFC0001234", bankName: "Sample Bank", branch: "Sample" })]);
await db.exec(`ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;`);
const PRODUCT = (id, name, weight, price) => JSON.stringify({ id, name, price, stock: 100000, sold: 0, active: true, status: "approved", gst: 0, sku: `SKU-${id}`, category: "Rice", vendor: "Shami", vendorId: "shami", weight, maxPurchaseQuantity: 5000 });
await db.query(`INSERT INTO public.catalog_products (id, vendor_id, category, payload, status, active) VALUES ('PA', 'shami', 'Rice', $1::jsonb, 'approved', true), ('PB', 'shami', 'Sugar', $2::jsonb, 'approved', true)`,
  [PRODUCT("PA", "Sample Rice", "25 kg", 1000), PRODUCT("PB", "Sample Sugar", "50 kg", 500)]);

const buyers = new Map();
/** A checkout through the real function: Rs 2500 unless other items are given. Waits for payment. */
const checkout = async (items = [{ product_id: "PA", qty: 2 }, { product_id: "PB", qty: 1 }], method = "UPI") => {
  const buyer = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"full_name":"Test Customer"}')`, [buyer, `c${buyer.slice(0, 8)}@test.in`]);
  const address = (await one(`INSERT INTO public.addresses (user_id, name, phone, line, city, state, pin) VALUES ($1, 'Sample Person', '9000000001', '1 Sample Road', 'Challakere', 'Karnataka', '577522') RETURNING id`, [buyer])).id;
  await as(buyer);
  const r = (await one(`SELECT public.start_paid_checkout($1, $2, 'Test Customer', 'c@test.in', '9000000001', NULL, $3::jsonb, 'Pickup', $4, $5::jsonb, NULL) AS r`, [
    `T${randomUUID().slice(0, 8)}`, buyer, JSON.stringify({ id: address, pin: "577522", name: "Sample Person", phone: "9000000001", line: "1 Sample Road", city: "Challakere", state: "Karnataka" }), method, JSON.stringify(items),
  ])).r;
  await as(ADMIN);
  buyers.set(r.order_no, buyer);
  return r.order_no;
};
const force = async (no, patch) => {
  await db.exec(`SET session_replication_role = replica`);
  const keys = Object.keys(patch);
  await db.query(`UPDATE public.orders SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")} WHERE order_no = $1`, [no, ...keys.map((key) => patch[key])]);
  await db.exec(`SET session_replication_role = origin`);
};
/** An order already placed and not held: only these can be part paid. */
const placed = async (extra = {}) => {
  const no = await checkout();
  await force(no, { order_status: "Placed", payment_hold_until: null, ...extra });
  return no;
};
let lastUtr = 200000000000;
const utr = () => String(lastUtr += 1 + Math.floor(Math.random() * 1000));
const orderRow = (no) => one(`SELECT order_status, payment_status, total, paid_amount, balance_due FROM public.orders WHERE order_no = $1`, [no]);
const money = (value) => Number(value);
const received = async (no) => money((await one(`SELECT COALESCE(sum(amount), 0) AS s FROM public.payments p JOIN public.orders o ON o.id = p.order_id WHERE o.order_no = $1 AND p.status = 'Paid'`, [no])).s);
const asServer = async (sql, params) => {
  const before = (await one(`SELECT uid FROM auth.cur`)).uid;
  await db.query(`UPDATE auth.cur SET uid = NULL`);
  await db.exec(`SET ROLE service_role`);
  try { return await one(sql, params); }
  finally { await db.exec(`RESET ROLE`); await db.query(`UPDATE auth.cur SET uid = $1`, [before]); }
};
const confirm = async (no, amount, ref) => { await as(ADMIN); return one(`SELECT public.admin_confirm_manual_payment($1, $2::numeric, $3) AS r`, [no, String(amount), ref]); };
const submit = async (no, ref) => { await as(buyers.get(no)); const r = await one(`SELECT * FROM public.submit_upi_utr($1, $2)`, [no, ref]); await as(ADMIN); return r; };
const review = async (no, ref, decision = "confirmed", note = null) => { await as(ADMIN); return one(`SELECT * FROM public.review_upi_utr($1, $2, $3, $4)`, [no, decision, note, ref]); };
const sms = (ref, amount, raw = null) => asServer(`SELECT public.record_bank_credit($1, $2, 'Payer', $3, 'sms', 'BANK') AS r`, [ref, amount, raw]).then((row) => row.r);
const credit = (ref) => one(`SELECT id, amount, status, order_no, note FROM public.bank_credits WHERE utr = $1`, [ref]);
const settle = async (ref, note) => { const c = await credit(ref); await as(ADMIN); return one(`SELECT * FROM public.settle_bank_credit($1, $2)`, [c.id, note]); };
const alerts = async (text) => (await q(`SELECT title, message FROM public.notifications WHERE recipient_id = $1 AND message LIKE '%' || $2 || '%' AND title NOT IN ('Bank transfer to check', 'UPI payment to check')`, [ADMIN, text])).map((row) => `${row.title}: ${row.message}`);
const refused = async (fn, pattern) => assert.rejects(fn, pattern);
const partPaid = async (paid = 1000) => { const no = await placed(); await confirm(no, paid, utr()); return no; };

// ------------------------------------------------------------------ the fix itself, on data made before it
let repaired = null;
const before = {};
if (!WITHOUT_FIX) {
  const fixText = readFileSync(new URL(FIX, MIGRATIONS), "utf8");
  // An admin confirmed in full, then the bank alert for less was marked matched and could never be settled.
  const shortOrder = await checkout();
  const beforeRef = utr();
  await submit(shortOrder, beforeRef);
  await review(shortOrder, beforeRef);
  await sms(beforeRef, 1000);
  assert.equal((await credit(beforeRef)).status, "matched");
  // One transfer in two parts under different bank letters, adding up to the alert: the money agrees.
  const partsOrder = await placed();
  before.partsRef = utr();
  await confirm(partsOrder, 1000, `SBIN${before.partsRef}`);
  await confirm(partsOrder, 1500, `HDFC${before.partsRef}`);
  await sms(before.partsRef, 2500);
  assert.equal((await credit(before.partsRef)).status, "matched");
  // Payments the sync had posted: noted by the fix, oldest first, as many as the money on the invoice covers.
  const note = async (no, zohoId, balance) => {
    const o = await one(`SELECT id FROM public.orders WHERE order_no = $1`, [no]);
    await db.query(`INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, status, total, balance) VALUES ($1, $2, $3, 'paid', 2500, $4)`, [o.id, no, zohoId, balance]);
  };
  before.posted = utr(); before.part1 = utr(); before.part2 = utr(); before.noMoney = utr();
  const a = await checkout(), b = await placed(), c = await checkout();
  await confirm(a, 2500, before.posted); await note(a, "Z-A", 0);
  await confirm(b, 1000, before.part1); await confirm(b, 1500, before.part2); await note(b, "Z-B", 1500);
  await confirm(c, 2500, before.noMoney); await note(c, "Z-C", 2500);
  // A part payment not yet posted must stay unnoted however many times the migration runs.
  before.partA = utr(); before.partB = utr();
  const pp = await placed();
  await confirm(pp, 1000, before.partA); await confirm(pp, 500, before.partB); await note(pp, "Z-PP", 1500);
  // The old manual path never looked at an unmatched alert.
  before.quiet = utr();
  await sms(before.quiet, 1234);
  const qq = await placed();
  await confirm(qq, 2500, before.quiet);
  assert.equal((await credit(before.quiet)).status, "unmatched");
  // The old float left a fully paid order "Partially Paid".
  const ff = await placed({ total: 100.21, balance_due: 100.21, payment_method: "NEFT" });
  await confirm(ff, 30.06, utr());
  await confirm(ff, 70.14999999999999, utr());
  assert.equal((await orderRow(ff)).payment_status, "Partially Paid");
  before.float = ff;
  before.voided = utr();
  const v = await checkout();
  await confirm(v, 2500, before.voided);
  const vo = await one(`SELECT id FROM public.orders WHERE order_no = $1`, [v]);
  await db.query(`INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, status, total, balance, updated_at) VALUES ($1, $2, NULL, 'void', NULL, NULL, now() + interval '1 minute')`, [vo.id, v]);
  await db.exec(fixText);
  repaired = beforeRef;
  await db.exec(fixText); // running it twice changes nothing
  await db.exec(fixText);
}

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name}`); }
  catch (cause) { results.push({ name, ok: false }); console.log(`  FAIL  ${name}\n          ${String(cause.message).split("\n").slice(0, 3).join(" ")}`); }
  await db.exec("RESET ROLE").catch(() => undefined);
  await db.exec("SET session_replication_role = origin").catch(() => undefined);
};

console.log("\n1. One bank transfer pays one order, however it is written");
await test("the bare UTR, then the same transfer with the bank's letters, on another order", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await confirm(a, 2500, ref);
  await refused(() => confirm(b, 2500, `SBIN${ref}`), /already been recorded/);
  assert.equal((await orderRow(b)).order_status, "Awaiting Payment");
});
await test("the bank's letters first, then the bare UTR", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await confirm(a, 2500, `HDFC${ref}`);
  await refused(() => confirm(b, 2500, ref), /already been recorded/);
});
await test("with spaces, hyphens, small letters or O for 0", async () => {
  const a = await checkout(), ref = utr();
  await confirm(a, 2500, `SBIN${ref}`);
  for (const written of [`${ref.slice(0, 4)} ${ref.slice(4, 8)} ${ref.slice(8)}`, `${ref.slice(0, 4)}-${ref.slice(4, 8)}-${ref.slice(8)}`, `sbin${ref}`, `SBIN${ref}`.replaceAll("0", "O")]) {
    const b = await checkout();
    await refused(() => confirm(b, 2500, written), /already been recorded/);
  }
  const c = await checkout(), bare = utr();
  await confirm(c, 2500, bare);
  for (const written of [`UTR: ${bare}`, `Ref no ${bare}`, `UPI/${bare}`]) {
    const b = await checkout();
    await refused(() => confirm(b, 2500, written), /already been recorded/);
  }
});
await test("a part payment cannot take the same transfer twice on one order", async () => {
  const no = await placed(), ref = utr();
  await confirm(no, 1000, ref);
  await refused(() => confirm(no, 500, `SBIN${ref}`), /already been recorded/);
  assert.equal(await received(no), 1000);
});
await test("two different transfers from different banks both count", async () => {
  const a = await checkout(), b = await checkout();
  await confirm(a, 2500, "SBIN0000111222333");
  await confirm(b, 2500, "HDFC0000111222334");
  assert.equal((await orderRow(b)).payment_status, "Paid");
});
await test("short references RCPT1 and RCPTI are different money", async () => {
  const a = await checkout(), b = await checkout(), c = await checkout(), d = await checkout();
  await confirm(a, 2500, "RCPT1");
  await confirm(b, 2500, "RCPTI");
  await confirm(c, 2500, "RCPT0");
  await confirm(d, 2500, "RCPTO");
  for (const no of [a, b, c, d]) assert.equal((await orderRow(no)).payment_status, "Paid");
});
await test("the same short reference twice is refused, whatever its case or spaces", async () => {
  const a = await checkout(), b = await checkout(), c = await checkout();
  await confirm(a, 2500, "RCPT77");
  await refused(() => confirm(b, 2500, "rcpt77"), /already been recorded/);
  await refused(() => confirm(c, 2500, "RCPT 77"), /already been recorded/);
});
await test("a UTR a customer sent on another order cannot be recorded here", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await submit(a, ref);
  await refused(() => confirm(b, 2500, ref), new RegExp(`sent this UTR on order ${a} and it waits for a check`));
  await refused(() => confirm(b, 2500, `SBIN${ref}`), new RegExp(`sent this UTR on order ${a}`));
});
await test("a rejected UTR on another order is free to use", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await submit(a, ref);
  await review(a, ref, "rejected", "not found");
  await confirm(b, 2500, ref);
  assert.equal((await orderRow(b)).payment_status, "Paid");
});
await test("a refunded UTR pays for nothing", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await submit(a, ref);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '25 hours' WHERE order_no = '${a}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  await one(`SELECT public.mark_utr_refunded($1) AS r`, [a]);
  await refused(() => confirm(b, 2500, ref), /refunded/);
});
await test("a UTR from a lapsed checkout covers up to its amount, and is then closed", async () => {
  const a = await checkout(), big = await checkout([{ product_id: "PA", qty: 4 }]), same = await checkout(), ref = utr();
  await submit(a, ref);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '25 hours' WHERE order_no = '${a}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  await refused(() => confirm(big, 4000, ref), /lapsed/);
  await confirm(same, 2500, `SBIN${ref}`);
  assert.equal((await one(`SELECT note FROM public.upi_payment_submissions WHERE order_no = $1`, [a])).note, `Placed again as ${same}`);
});
await test("a Rs 2500 lapsed UTR can pay a Rs 1000 order: the customer has a way forward", async () => {
  const a = await checkout(), small = await placed({ total: 1000, balance_due: 1000 }), ref = utr();
  await submit(a, ref);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '25 hours' WHERE order_no = '${a}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  await confirm(small, 1000, ref);
  assert.equal((await orderRow(small)).payment_status, "Paid");
  assert.ok((await alerts(ref)).some((text) => /₹2500\.00 on a checkout that lapsed, and ₹1000\.00 of it/.test(text)));
});
// The shape of the one refund set by hand on live: the payment row and the order both marked Refunded.
const refundByHand = async (no) => {
  await db.exec(`SET session_replication_role = replica`);
  await db.query(`UPDATE public.orders SET payment_status = 'Refunded', paid_amount = 0, balance_due = 0, order_status = 'Cancelled' WHERE order_no = $1`, [no]);
  await db.query(`UPDATE public.payments SET status = 'Refunded' WHERE order_id = (SELECT id FROM public.orders WHERE order_no = $1)`, [no]);
  await db.exec(`SET session_replication_role = origin`);
};
await test("a payment marked refunded cannot pay another order, however it is written", async () => {
  const a = await checkout(), ref = utr();
  await confirm(a, 2500, ref);
  await refundByHand(a);
  const b = await checkout();
  await refused(() => confirm(b, 2500, ref), /refunded/);
  await refused(() => confirm(b, 2500, `SBIN${ref}`), /refunded/);
  assert.equal(await received(b), 0);
  const c = await checkout(), d = await checkout();
  await confirm(c, 2500, "RCPT90");
  await refundByHand(c);
  await confirm(d, 2500, "rcpt 90");
  assert.equal((await orderRow(d)).payment_status, "Paid", "a receipt or the word CASH is no bank transfer: new money can use it");
});
await test("a bank alert for refunded money pays no waiting order, by amount or by UTR", async () => {
  const gone = await checkout([{ product_id: "PA", qty: 21 }]), ref = utr();
  await confirm(gone, 21000, ref);
  await refundByHand(gone);
  const waiting = await checkout([{ product_id: "PA", qty: 21 }]);
  const out = await sms(ref, 21000);
  assert.equal(out.status, "mismatch");
  assert.equal(out.order_no, gone);
  assert.equal(await received(waiting), 0);
  assert.equal((await orderRow(waiting)).order_status, "Awaiting Payment");
  assert.ok((await alerts(ref)).some((text) => /recorded as refunded/.test(text)));
  assert.equal((await settle(ref, "old SMS, money is gone")).status, "settled");
  const gone2 = await checkout([{ product_id: "PA", qty: 22 }]), ref2 = utr();
  await confirm(gone2, 22000, ref2);
  await refundByHand(gone2);
  const sent = await checkout([{ product_id: "PA", qty: 22 }]);
  await submit(sent, ref2);
  assert.equal((await sms(ref2, 22000)).status, "mismatch");
  assert.equal((await orderRow(sent)).order_status, "Awaiting Payment");
  await refused(() => review(sent, ref2), /refunded/);
});
await test("a checkout that ended takes no money", async () => {
  const no = await checkout([{ product_id: "PA", qty: 3 }]);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '2 hours' WHERE order_no = '${no}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  assert.equal((await orderRow(no)).order_status, "Payment Expired");
  await refused(() => confirm(no, 3000, utr()), /checkout has ended/);
  assert.equal(await received(no), 0);
});
await test("the same transfer through the customer's path and the admin's agree", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await confirm(a, 2500, `SBIN${ref}`);
  await refused(() => submit(b, ref), /already used/);
});
await test("a bank credit matched to one order cannot pay another", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await submit(a, ref);
  await sms(ref, 2500);
  assert.equal((await credit(ref)).status, "matched");
  await refused(() => confirm(b, 2500, ref), /already been recorded|already used/);
});
await test("words around the UTR do not hide it, in either order", async () => {
  const a = await checkout(), ref = utr();
  await confirm(a, 2500, ref);
  for (const written of [`${ref} RAHUL`, `UPI/CR/${ref}/RAHUL/SBIN`, `UTR: ${ref}`, `(${ref})`]) {
    const b = await checkout();
    await refused(() => confirm(b, 2500, written), /already been recorded/, written);
  }
  const c = await checkout(), d = await checkout(), other = utr();
  await confirm(c, 2500, `UTR:${other}`);
  await refused(() => confirm(d, 2500, `SBIN${other}`), /already been recorded/);
  await refused(() => submit(d, other), /already used/);
});
await test("a NEFT or RTGS UTR with words beside it is still that transfer", async () => {
  const big = [{ product_id: "PA", qty: 3 }];
  const a = await checkout(big, "NEFT"), b = await checkout(big, "NEFT");
  await confirm(a, 3000, "UTR: HDFCN26307123456");
  await refused(() => submit(b, "HDFCN26307123456"), /already used/);
  await refused(() => confirm(b, 3000, "HDFCN26307123456"), /already been recorded/);
  const c = await checkout(big, "NEFT"), d = await checkout(big, "NEFT");
  await submit(c, "SBINN26307123457");
  await refused(() => confirm(d, 3000, "NEFT-SBINN26307123457-RAHUL KUMAR"), new RegExp(`sent this UTR on order ${c}`));
  const e = await checkout(big, "NEFT"), f = await checkout(big, "NEFT");
  await confirm(e, 3000, "RTGS UTIBR52026110300012345");
  await refused(() => confirm(f, 3000, "UTIBR52026110300012345 RAHUL"), /already been recorded/);
  const g = await checkout(big, "NEFT"), h = await checkout(big, "NEFT");
  await confirm(g, 3000, "CNRBN26307123461");
  await refundByHand(g);
  await refused(() => confirm(h, 3000, "UTR: CNRBN26307123461"), /refunded/);
  const i = await checkout(big, "NEFT");
  await confirm(i, 3000, "UTR: HDFCN26307123499");
  assert.equal((await orderRow(i)).payment_status, "Paid", "a different number is a different transfer");
});
await test("a UTR typed in Kannada or other digits is the same number", async () => {
  const a = await checkout(), b = await checkout(), c = await checkout(), ref = utr();
  const kannada = [...ref].map((digit) => "೦೧೨೩೪೫೬೭೮೯"[Number(digit)]).join("");
  const fullWidth = [...ref].map((digit) => "０１２３４５６７８９"[Number(digit)]).join("");
  await confirm(a, 2500, kannada);
  assert.equal((await one(`SELECT txn_ref FROM public.payments WHERE order_id = (SELECT id FROM public.orders WHERE order_no = $1)`, [a])).txn_ref, ref, "stored in plain digits");
  await refused(() => confirm(b, 2500, ref), /already been recorded/);
  await refused(() => confirm(c, 2500, fullWidth), /already been recorded/);
});
await test("a reference longer than Zoho takes is refused here", async () => {
  const no = await checkout();
  await refused(() => confirm(no, 2500, `UPI/${utr()}/${"R".repeat(90)}`), /Enter the verified UTR/);
});
await test("the same transfer recorded twice on one order says what to do", async () => {
  const no = await placed(), ref = utr();
  await confirm(no, 1000, ref);
  await refused(() => confirm(no, 1500, `${ref} BAL`), /on this order\. If that was only part/);
  await confirm(no, 1500, "REST OF THAT NEFT");
  assert.equal((await orderRow(no)).payment_status, "Paid");
});
await test("every number standing alone counts, not only the first", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await confirm(a, 2500, `A/c 501001234567 UTR ${ref}`);
  await refused(() => confirm(b, 2500, ref), /already been recorded/);
  const no = await placed(), ref2 = utr();
  await sms(ref2, 500);
  await refused(() => confirm(no, 2500, `A/c 501001234568 UTR ${ref2}`), /shows Rs 500\.00/);
  const named = await placed({ total: 2600, balance_due: 2600 }), one1 = utr(), one2 = utr(), waiting = await checkout([{ product_id: "PA", qty: 9 }]);
  await confirm(named, 2600, `${one1} + ${one2}`);
  assert.equal((await sms(one2, 9000)).status, "mismatch", "the second one named is accounted for, not free to pay another order");
  assert.equal(await received(waiting), 0);
  assert.ok((await alerts(one2)).some((text) => /names more than one transfer/.test(text)));
  assert.ok(!(await alerts(one2)).some((text) => /collect the difference/.test(text)), "nobody is asked for money already paid");
});
await test("a bank alert is read through those words too", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 500);
  await refused(() => confirm(no, 2000, `${ref} RAHUL`), /shows Rs 500\.00/);
  const paid = await checkout([{ product_id: "PA", qty: 31 }]), waiting = await checkout([{ product_id: "PA", qty: 31 }]), ref2 = utr();
  await confirm(paid, 31000, `UPI/${ref2}/RAHUL`);
  assert.equal((await sms(ref2, 31000)).status, "matched");
  assert.equal((await credit(ref2)).order_no, paid);
  assert.equal(await received(waiting), 0, "the waiting order of the same amount is not paid with it");
});
await test("one alert pays once, whatever bank letters are typed", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 1000);
  await confirm(no, 1000, `SBIN${ref}`);
  await refused(() => confirm(no, 1000, `HDFC${ref}`), /already used/);
  await refused(() => confirm(no, 500, `ICIC${ref}`), /already used/);
  assert.equal(await received(no), 1000);
  const a = await placed(), b = await placed(), ref2 = utr();
  await sms(ref2, 2500);
  await confirm(a, 1000, `SBIN${ref2}`);
  assert.equal((await credit(ref2)).status, "mismatch", "Rs 1500 of it is still open");
  await refused(() => confirm(b, 1500, `HDFC${ref2}`), /already used/);
});
await test("no alert yet, one transfer on two orders under different letters: the alert flags it", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await confirm(a, 2500, `SBIN${ref}`);
  await confirm(b, 2500, `HDFC${ref}`);
  assert.equal((await sms(ref, 2500)).status, "mismatch");
  assert.match((await credit(ref)).note, /recorded as ₹5000\.00/);
  assert.ok((await alerts(ref)).some((text) => /recorded on more than one order/.test(text)));
});
await test("one transfer on two orders adding up to its alert is still flagged", async () => {
  const a = await placed(), b = await placed(), ref = utr();
  await confirm(a, 1000, `SBIN${ref}`);
  await confirm(b, 1500, `HDFC${ref}`);
  assert.equal((await sms(ref, 2500)).status, "mismatch");
  assert.ok((await alerts(ref)).some((text) => /recorded on more than one order/.test(text)));
});
await test("a transfer already recorded on another order, sent again under other letters: the alert is saved and flagged", async () => {
  const b = await checkout([{ product_id: "PA", qty: 11 }]), a = await checkout([{ product_id: "PA", qty: 11 }], "NEFT"), ref = utr();
  await confirm(b, 11000, `HDFC${ref}`);
  await submit(a, `SBIN${ref}`);
  const out = await sms(ref, 11000);
  assert.equal(out.status, "matched", "it is B's money; recording the alert no longer fails");
  assert.equal(out.order_no, b);
  assert.equal(await received(a), 0);
  assert.equal((await orderRow(a)).order_status, "Awaiting Payment");
});
await test("two orders sent one transfer under different letters: a person chooses", async () => {
  const a = await checkout([{ product_id: "PA", qty: 12 }]), b = await checkout([{ product_id: "PA", qty: 12 }]), ref = utr();
  await force(a, { payment_method: "NEFT" });
  await force(b, { payment_method: "NEFT" });
  await submit(a, `SBIN${ref}`);
  await submit(b, `HDFC${ref}`);
  assert.equal((await sms(ref, 12000)).status, "ambiguous");
  assert.equal(await received(a) + await received(b), 0);
  assert.ok((await alerts(ref)).some((text) => /more than one order sent this UTR/.test(text)));
});
await test("a rejected UTR's money pays no other order by its amount", async () => {
  const a = await checkout([{ product_id: "PA", qty: 15 }]), b = await checkout([{ product_id: "PA", qty: 15 }]), ref = utr();
  await submit(a, ref);
  await review(a, ref, "rejected", "not found");
  const out = await sms(ref, 15000);
  assert.equal(out.status, "mismatch");
  assert.equal(out.order_no, a);
  assert.equal(await received(b), 0);
  assert.ok((await alerts(ref)).some((text) => /was not accepted/.test(text)));
  await submit(a, ref);
  await review(a, ref);
  assert.equal((await orderRow(a)).payment_status, "Paid");
  assert.equal((await credit(ref)).status, "matched");
});
await test("an ended checkout's UTR is late money for a person, not for the next order of that amount", async () => {
  const a = await checkout([{ product_id: "PA", qty: 16 }]), b = await checkout([{ product_id: "PA", qty: 16 }]), ref = utr();
  await submit(a, ref);
  await one(`SELECT public.admin_end_payment_hold($1) AS r`, [a]);
  const out = await sms(ref, 16000);
  assert.equal(out.status, "late");
  assert.equal(await received(b), 0);
  assert.ok((await alerts(ref)).some((text) => /was not accepted/.test(text)));
});
await test("an exact balance for a rejected UTR on a part-paid order still reaches a person", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  await review(no, ref, "rejected", "not found yet");
  assert.equal((await sms(ref, 1500)).status, "mismatch");
  assert.ok((await alerts(ref)).length > 0);
  await submit(no, ref);
  await review(no, ref);
  assert.equal((await orderRow(no)).payment_status, "Paid");
});
await test("the customer's UTR with bank letters is theirs: another order is not paid with it", async () => {
  const a = await checkout([{ product_id: "PA", qty: 5 }], "NEFT"), b = await checkout([{ product_id: "PA", qty: 1 }]), ref = utr();
  await submit(a, `SBIN${ref}`);
  const out = await sms(ref, 1000);
  assert.equal(out.status, "mismatch");
  assert.equal(out.order_no, a);
  assert.equal(await received(b), 0);
  assert.equal((await orderRow(b)).order_status, "Awaiting Payment");
});
await test("the right amount with bank letters confirms a held checkout, and an exact balance is a balance", async () => {
  const a = await checkout([{ product_id: "PA", qty: 6 }], "NEFT"), ref = utr();
  await submit(a, `SBIN${ref}`);
  assert.equal((await sms(ref, 6000)).status, "matched");
  assert.equal((await orderRow(a)).payment_status, "Paid");
  const b = await placed({ payment_method: "NEFT" });
  await confirm(b, 1000, utr());
  const ref2 = utr();
  await submit(b, `SBIN${ref2}`);
  assert.equal((await sms(ref2, 1500)).status, "balance");
});
await test("a customer's UTR closed by a payment under another reference: its alert pays nothing else", async () => {
  const a = await checkout([{ product_id: "PA", qty: 8 }]), waiting = await checkout([{ product_id: "PA", qty: 8 }]), ref = utr();
  await submit(a, ref);
  await confirm(a, 8000, "BANK STATEMENT LINE 4");
  const out = await sms(ref, 8000);
  assert.equal(out.status, "mismatch", "it may be that money or a second payment: the alert is saved, for a person");
  assert.equal((await credit(ref)).order_no, a);
  assert.equal(await received(waiting), 0);
  assert.ok((await alerts(ref)).some((text) => /recorded under another reference/.test(text)));
  const c = await checkout(), ref2 = utr();
  await submit(c, ref2);
  await confirm(c, 2500, "BANK STATEMENT LINE 5");
  assert.equal((await sms(ref2, 900)).status, "mismatch");
  assert.ok((await alerts(ref2)).length > 0);
});
await test("a UTR closed under another reference says how to go on", async () => {
  const a = await checkout(), b = await checkout(), ref = utr();
  await submit(a, ref);
  await confirm(a, 2500, "CASH RECEIPT 5");
  await refused(() => confirm(b, 2500, ref), new RegExp(`sent this UTR on order ${a}, which was paid under another reference`));
  await confirm(b, 2500, "NEFT STATEMENT LINE 7");
  assert.equal((await orderRow(b)).payment_status, "Paid", "the way it describes works");
});
await test("refunded under one set of letters, refused under another once the alert names the transfer", async () => {
  const a = await checkout(), ref = utr();
  await confirm(a, 2500, `HDFC${ref}`);
  await refundByHand(a);
  assert.equal((await sms(ref, 2500)).status, "mismatch");
  const b = await placed();
  await refused(() => confirm(b, 2500, `SBIN${ref}`), /refunded/);
  const c = await checkout(), ref2 = utr(), d = await placed();
  await submit(c, ref2);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '25 hours' WHERE order_no = '${c}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  await one(`SELECT public.mark_utr_refunded($1) AS r`, [c]);
  assert.equal((await sms(ref2, 1234)).status, "mismatch");
  await refused(() => confirm(d, 2500, `SBIN${ref2}`), /refunded/);
});
await test("private functions stay private", async () => {
  await db.exec(`SET ROLE authenticated`);
  await assert.rejects(() => db.query(`SELECT private.same_utr('a', 'b')`), /permission denied/);
  await db.exec(`RESET ROLE`);
  if (!WITHOUT_FIX) {
    const row = await one(`SELECT has_function_privilege('authenticated', 'private.same_payment_ref(text,text)', 'EXECUTE') AS a, has_function_privilege('anon', 'private.same_payment_ref(text,text)', 'EXECUTE') AS b, has_function_privilege('anon', 'public.admin_confirm_manual_payment(text,numeric,text)', 'EXECUTE') AS c, has_function_privilege('authenticated', 'public.admin_confirm_manual_payment(text,numeric,text)', 'EXECUTE') AS d`);
    assert.deepEqual(row, { a: false, b: false, c: false, d: true });
  }
});
await test("only an admin can record a payment or settle an alert", async () => {
  const no = await checkout(), ref = utr();
  await sms(ref, 77);
  await as(buyers.get(no));
  await refused(() => one(`SELECT public.admin_confirm_manual_payment($1, 2500, $2) AS r`, [no, utr()]), /Only administrators/);
  const c = await credit(ref);
  await refused(() => one(`SELECT * FROM public.settle_bank_credit($1, 'x')`, [c.id]), /Only administrators/);
  await as(ADMIN);
});

console.log("\n2. The bank alert and what is recorded agree");
await test("a short alert first: the admin's Confirm is refused and nothing moves", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  assert.equal((await sms(ref, 1000)).status, "mismatch");
  await refused(() => review(no, ref), /shows Rs 1000\.00, not Rs 2500\.00/);
  assert.equal((await orderRow(no)).order_status, "Awaiting Payment");
  assert.equal(await received(no), 0);
  assert.equal((await credit(ref)).status, "mismatch");
  assert.equal((await one(`SELECT status FROM public.upi_payment_submissions WHERE order_no = $1`, [no])).status, "submitted");
});
await test("that held checkout: Reject and settle both still work", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  await sms(ref, 1000);
  await review(no, ref, "rejected", "Bank shows less");
  const settled = await settle(ref, "refunded on 3 Nov");
  assert.equal(settled.status, "settled");
});
await test("a short alert on the manual path is refused, in every way of writing the UTR", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 777);
  await refused(() => confirm(no, 2500, ref), /shows Rs 777\.00, not Rs 2500\.00/);
  await refused(() => confirm(no, 2500, `SBIN${ref}`), /shows Rs 777\.00/);
  assert.equal(await received(no), 0);
});
await test("part paid, the alert shows part of the balance: refused in full, recorded for what came", async () => {
  const no = await partPaid(), ref = utr();
  const s = await submit(no, ref);
  assert.equal(money(s.amount), 1500);
  assert.equal((await sms(ref, 500)).status, "mismatch");
  assert.ok((await alerts(ref)).some((text) => /Bank amount ₹500\.00, order needs ₹1500\.00/.test(text) && /part payment/.test(text)));
  await refused(() => review(no, ref), /shows Rs 500\.00, not Rs 1500\.00/);
  await confirm(no, 500, ref);
  const o = await orderRow(no);
  assert.deepEqual([o.payment_status, money(o.paid_amount), money(o.balance_due)], ["Partially Paid", 1500, 1000]);
  assert.equal((await credit(ref)).status, "matched");
  assert.equal((await one(`SELECT count(*)::int AS n FROM public.upi_payment_submissions WHERE order_no = $1 AND status = 'submitted'`, [no])).n, 0);
});
await test("an alert that came before the customer's UTR is compared too", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 900);
  await submit(no, ref);
  await refused(() => review(no, ref), /shows Rs 900\.00/);
});
await test("the alert equals the amount: confirmed and matched, by Confirm and by hand", async () => {
  const a = await placed(), ref = utr();
  await sms(ref, 2500);
  await submit(a, ref);
  await review(a, ref);
  assert.equal((await orderRow(a)).payment_status, "Paid");
  assert.deepEqual([(await credit(ref)).status, (await credit(ref)).note], ["matched", "Confirmed by an admin"]);
  const b = await placed(), ref2 = utr();
  await sms(ref2, 2500);
  await confirm(b, 2500, `SBIN${ref2}`);
  assert.equal((await credit(ref2)).order_no, b);
  assert.equal((await credit(ref2)).status, "matched");
});
await test("confirmed first, the short alert after: flagged for a person, and it can be settled", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  await review(no, ref);
  assert.equal((await sms(ref, 1000)).status, "mismatch");
  const c = await credit(ref);
  assert.equal(c.order_no, no);
  assert.match(c.note, /Bank amount ₹1000\.00, recorded as ₹2500\.00/);
  assert.ok((await alerts(ref)).some((text) => /Payment needs you/.test(text) && /₹1000\.00/.test(text) && /₹2500\.00/.test(text)));
  assert.equal((await orderRow(no)).payment_status, "Paid", "the record stays until a person decides");
  assert.equal((await settle(ref, "customer paid Rs 1500 in cash on 3 Nov")).status, "settled");
});
await test("confirmed first, the same amount after: quietly matched", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  await review(no, ref);
  assert.equal((await sms(ref, 2500)).status, "matched");
  assert.equal((await credit(ref)).note, "Already confirmed by an admin");
  assert.equal((await alerts(ref)).length, 0);
});
await test("confirmed first, more came in: the extra is flagged", async () => {
  const no = await checkout(), ref = utr();
  await confirm(no, 2500, ref);
  assert.equal((await sms(ref, 3000)).status, "mismatch");
  assert.ok((await alerts(ref)).some((text) => /₹3000\.00/.test(text) && /Refund the extra/.test(text)));
});
await test("more came in than is recorded at Confirm: recorded, and the extra stays open", async () => {
  const no = await placed(), ref = utr();
  await submit(no, ref);
  await sms(ref, 3000);
  await review(no, ref);
  assert.equal((await orderRow(no)).payment_status, "Paid");
  const c = await credit(ref);
  assert.equal(c.status, "mismatch");
  assert.match(c.note, /Bank amount ₹3000\.00, recorded as ₹2500\.00/);
  assert.ok((await alerts(ref)).some((text) => /Refund the extra/.test(text)));
  assert.equal((await settle(ref, "Rs 500 refunded")).status, "settled");
});
await test("a credit settled as refunded cannot pay any order, not even its own", async () => {
  const other = await placed(), ref = utr();
  await sms(ref, 2500);
  await settle(ref, "refunded on 3 Nov");
  await refused(() => confirm(other, 2500, ref), /marked settled \(refunded on 3 Nov\)/);
  const no = await checkout(), ref2 = utr();
  await submit(no, ref2);
  await sms(ref2, 1000);
  await settle(ref2, "refunded on 3 Nov");
  await refused(() => review(no, ref2), /marked settled/);
  assert.equal(await received(no), 0);
});
await test("paise short can be recorded, and the alert stays open for a person", async () => {
  const no = await checkout(undefined, "NEFT"), ref = utr();
  await force(no, { total: 677.25, balance_due: 677.25 });
  await submit(no, ref);
  assert.equal((await sms(ref, 677)).status, "mismatch");
  await review(no, ref);
  const o = await orderRow(no);
  assert.deepEqual([o.payment_status, money(o.paid_amount)], ["Paid", 677.25]);
  assert.match((await credit(ref)).note, /Bank amount ₹677\.00, recorded as ₹677\.25/);
  assert.ok((await alerts(ref)).some((text) => /collect the difference/.test(text)));
  assert.equal((await settle(ref, "25 paise written off")).status, "settled");
});
await test("a rupee short is the limit", async () => {
  const a = await placed(), ref = utr();
  await sms(ref, 2499);
  await confirm(a, 2500, ref);
  assert.equal((await credit(ref)).status, "mismatch");
  const b = await placed(), ref2 = utr();
  await sms(ref2, 2498.99);
  await refused(() => confirm(b, 2500, ref2), /shows Rs 2498\.99/);
  const c = await placed(), ref3 = utr();
  await sms(ref3, 1003);
  await refused(() => confirm(c, 1003.5, ref3), /shows Rs 1003\.00/);
  assert.equal(await received(c), 0, "a part payment gets no allowance");
});
await test("the refusal says how much to record and what percent to type", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 500);
  await refused(() => confirm(no, 2500, ref), /Record Rs 500\.00 as a part payment \(Admin > Payments, 20\.0 percent of the order\)/);
});
await test("settled by mistake: reopen it, and it can pay the order", async () => {
  const no = await placed(), ref = utr();
  await sms(ref, 2500);
  await settle(ref, "order placed by hand");
  await refused(() => confirm(no, 2500, ref), /reopen it first/);
  const c = await credit(ref);
  await as(ADMIN);
  const open = await one(`SELECT * FROM public.reopen_bank_credit($1)`, [c.id]);
  assert.equal(open.status, "mismatch");
  assert.match(open.note, /It was settled: order placed by hand/);
  assert.ok((await alerts(ref)).some((text) => /has been reopened/.test(text)));
  await confirm(no, 2500, ref);
  assert.deepEqual([(await credit(ref)).status, (await orderRow(no)).payment_status], ["matched", "Paid"]);
  await refused(() => one(`SELECT * FROM public.reopen_bank_credit($1)`, [c.id]), /Only a settled credit/);
});
await test("a reopened alert never confirms a checkout by itself", async () => {
  const ref = utr();
  await sms(ref, 14000);
  await settle(ref, "refunded");
  const c = await credit(ref);
  await as(ADMIN);
  await one(`SELECT * FROM public.reopen_bank_credit($1)`, [c.id]);
  const no = await checkout([{ product_id: "PA", qty: 14 }]);
  await submit(no, ref);
  assert.equal((await orderRow(no)).order_status, "Awaiting Payment", "the customer's UTR waits for a person");
  assert.equal(await received(no), 0);
});
await test("a reopened alert linked to an order is a person's again, and only an admin can reopen", async () => {
  const no = await placed(), ref = utr();
  await submit(no, ref);
  await sms(ref, 900);
  await settle(ref, "refunded");
  const c = await credit(ref);
  await as(buyers.get(no));
  await refused(() => one(`SELECT * FROM public.reopen_bank_credit($1)`, [c.id]), /Only administrators/);
  await as(ADMIN);
  assert.equal((await one(`SELECT * FROM public.reopen_bank_credit($1)`, [c.id])).status, "mismatch");
  const rights = await one(`SELECT has_function_privilege('anon', 'public.reopen_bank_credit(uuid)', 'EXECUTE') AS a, has_function_privilege('authenticated', 'public.reopen_bank_credit(uuid)', 'EXECUTE') AS b`);
  assert.deepEqual(rights, { a: false, b: true });
});
await test("two parts adding up to the alert stay matched through the fix", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  assert.equal((await credit(before.partsRef)).status, "matched");
});
await test("payments the sync had posted are noted by the fix; the unsure ones are left for the next sync", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  const row = (ref) => one(`SELECT zoho_invoice_id, zoho_pushed_at FROM public.payments WHERE txn_ref = $1`, [ref]);
  assert.equal((await row(before.posted)).zoho_invoice_id, "Z-A");
  assert.ok((await row(before.posted)).zoho_pushed_at);
  assert.equal((await row(before.part1)).zoho_invoice_id, "Z-B", "the invoice shows Rs 1000 on it");
  assert.equal((await row(before.part2)).zoho_invoice_id, null, "and not this one too");
  assert.equal((await row(before.noMoney)).zoho_invoice_id, null, "the invoice shows no money");
  assert.equal((await row(before.voided)).zoho_invoice_id, "void", "voiding left it in Zoho as the customer's credit");
  assert.equal((await row(before.partA)).zoho_invoice_id, "Z-PP");
  assert.equal((await row(before.partB)).zoho_invoice_id, null, "applying the migration again must not note a part never posted");
});
await test("an unmatched alert that disagrees with what was recorded goes to a person through the fix", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  const c = await credit(before.quiet);
  assert.equal(c.status, "mismatch");
  assert.match(c.note, /Bank amount ₹1234\.00, recorded as ₹2500\.00/);
});
await test("fully paid orders the old float left Partially Paid are put right by the fix", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  assert.equal((await orderRow(before.float)).payment_status, "Paid");
});
await test("a customer is not told money is due while the website shows the order paid", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  const no = await checkout();
  await confirm(no, 2500, utr());
  const o = await one(`SELECT id FROM public.orders WHERE order_no = $1`, [no]);
  await db.query(`INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, status, total, balance) VALUES ($1, $2, 'Z-N', 'paid', 2500, 0)`, [o.id, no]);
  await db.query(`UPDATE public.zoho_order_invoices SET status = 'partially_paid', balance = 1000 WHERE order_id = $1`, [o.id]);
  const told = await q(`SELECT recipient_role FROM public.notifications WHERE order_no = $1 AND title = 'Invoice partly paid'`, [no]);
  assert.ok(told.length > 0 && told.every((row) => row.recipient_role === "admin"), JSON.stringify(told));
});
await test("a matched credit still cannot be settled over", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  await sms(ref, 2500);
  await refused(() => settle(ref, "oops"), /already matched or settled/);
});
await test("a short alert marked matched before this fix is opened up, and can be settled", async () => {
  if (WITHOUT_FIX) throw new Error("needs the fix");
  const c = await credit(repaired);
  assert.equal(c.status, "mismatch");
  assert.match(c.note, /recorded as ₹2500\.00/);
  assert.equal((await settle(repaired, "difference collected")).status, "settled");
});

console.log("\n3. Amounts are rounded to paise");
const floats = [[100.21, 30.06], [100.7, 30.21], [2500.1, 1000.2]];
for (const [total, part] of floats) {
  await test(`total ${total}, part ${part}: what the dialog sends for the rest ends Paid`, async () => {
    const no = await placed({ total, balance_due: total, payment_method: "NEFT" });
    await confirm(no, part, utr());
    const o = await orderRow(no);
    const rest = Math.max(0, money(o.total) - money(o.paid_amount));
    assert.notEqual(String(rest), rest.toFixed(2), "this case needs a float that is not exact");
    await confirm(no, rest, utr());
    const after = await orderRow(no);
    assert.deepEqual([after.payment_status, money(after.paid_amount), money(after.balance_due)], ["Paid", total, 0]);
    assert.equal(await received(no), total);
  });
}
await test("the payment row keeps the rounded amount", async () => {
  const no = await placed(), ref = utr();
  await confirm(no, 1000.004, ref);
  assert.equal(money((await one(`SELECT amount FROM public.payments WHERE txn_ref = $1`, [ref])).amount), 1000);
  assert.equal(money((await orderRow(no)).paid_amount), 1000);
});
await test("less than half a paisa is no payment", async () => {
  const no = await placed();
  await refused(() => confirm(no, 0.004, utr()), /must be positive/);
  await refused(() => confirm(no, -1, utr()), /must be positive/);
});
await test("a full float on a held checkout places it", async () => {
  const no = await checkout();
  await confirm(no, 2499.9999999999995, utr());
  assert.deepEqual([(await orderRow(no)).order_status, (await orderRow(no)).payment_status], ["Payment Confirmed", "Paid"]);
});
await test("still no overpaying", async () => {
  const no = await placed();
  await refused(() => confirm(no, 2500.01, utr()), /exceeds the unpaid balance/);
});

console.log("\n4. The exact balance of a part-paid order");
await test("is a balance to confirm, not a refund", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  const out = await sms(ref, 1500);
  assert.equal(out.status, "balance");
  assert.equal(out.order_no, no);
  assert.equal((await credit(ref)).status, "balance");
  const said = await alerts(ref);
  assert.equal(said.length, 1);
  assert.match(said[0], /^Balance to confirm: /);
  assert.doesNotMatch(said[0], /Refund/i);
  assert.equal(money((await orderRow(no)).paid_amount), 1000, "an admin confirms it; it is not paid by itself");
});
await test("Confirm pays it and closes the alert", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  await sms(ref, 1500);
  await review(no, ref);
  const o = await orderRow(no);
  assert.deepEqual([o.payment_status, money(o.paid_amount), money(o.balance_due)], ["Paid", 2500, 0]);
  assert.equal((await credit(ref)).status, "matched");
});
await test("it can be settled instead", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  await sms(ref, 1500);
  assert.equal((await settle(ref, "not for this order, refunded")).status, "settled");
});
await test("an older unpaid order: the full amount is a balance to confirm too", async () => {
  const no = await placed(), ref = utr();
  await submit(no, ref);
  assert.equal((await sms(ref, 2500)).status, "balance");
});
await test("a held checkout paid in full by alert still confirms by itself", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  assert.equal((await sms(ref, 2500)).status, "matched");
  assert.equal((await orderRow(no)).payment_status, "Paid");
});
await test("a wrong amount on a held checkout still says refund", async () => {
  const no = await checkout(), ref = utr();
  await submit(no, ref);
  await sms(ref, 2000);
  assert.ok((await alerts(ref)).some((text) => /Refund it or call the customer/.test(text)));
});
await test("more than the balance of a part-paid order says refund, not part payment", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  assert.equal((await sms(ref, 2000)).status, "mismatch");
  const said = await alerts(ref);
  assert.ok(said.some((text) => /Refund it or call the customer/.test(text)));
  assert.ok(!said.some((text) => /part payment/.test(text)));
});
await test("a cancelled order's UTR is still a refund", async () => {
  const no = await placed(), ref = utr();
  await submit(no, ref);
  await force(no, { order_status: "Cancelled" });
  assert.equal((await sms(ref, 2500)).status, "mismatch");
  assert.ok((await alerts(ref)).some((text) => /already Cancelled.*Refund it/.test(text)));
});
await test("money for a checkout that ran out is still late", async () => {
  const no = await checkout([{ product_id: "PA", qty: 13 }]), ref = utr();
  await submit(no, ref);
  await db.exec(`UPDATE public.orders SET payment_hold_until = now() - interval '25 hours' WHERE order_no = '${no}'`);
  await one(`SELECT public.expire_payment_holds() AS n`);
  assert.equal((await sms(ref, 13000)).status, "late");
});
await test("matching by amount still works for a UPI checkout with no UTR yet", async () => {
  const no = await checkout([{ product_id: "PA", qty: 7 }]), ref = utr();
  assert.equal((await sms(ref, 7000)).status, "matched");
  assert.equal((await orderRow(no)).payment_status, "Paid");
});
await test("the same alert twice is ignored", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  await sms(ref, 1500);
  assert.equal((await sms(ref, 1500)).status, "duplicate");
  assert.equal((await alerts(ref)).length, 1);
});
await test("a settled balance cannot pay it afterwards", async () => {
  const no = await partPaid(), ref = utr();
  await submit(no, ref);
  await sms(ref, 1500);
  await settle(ref, "refunded");
  await refused(() => review(no, ref), /marked settled/);
});

await db.close();
const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${WITHOUT_FIX ? " (before the fix)" : ""}`);
process.exit(failed.length ? 1 : 0);
