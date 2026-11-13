// Shared set-up for the pre-order database tests (preorder-*.db-test.mjs, batch-expenses.db-test.mjs): a PGlite database
// with every migration of the repo before the pre-order work and small stand-ins for what Supabase provides, two godowns
// linked to Zoho locations, customers, a channel partner and staff, and Sugar S1 as live has it (₹2,741 with 5% GST,
// 50 ready at Challakere). All data is made up; nothing live is touched. Not a test on its own.
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATION_A = "20261114100000_batch_expenses.sql";
export const MIGRATION_B = "20261114110000_preorder_batches.sql";
const dir = join(root, "supabase", "migrations");
export const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
export const sqlOf = (file) => readFileSync(join(dir, file), "utf8");

const STUBS = `
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
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), owner uuid);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
  CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', -1) $$;
  CREATE PUBLICATION supabase_realtime;
`;

const uid = (s) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
export const ADMIN = uid("a1"), ADMIN2 = uid("a2"), C1 = uid("c1"), C2 = uid("c2"), C3 = uid("c3"), VENDOR_USER = uid("d1");
export const PARTNER_USER = uid("b1"), STAFF_USER = uid("e1"), HBL_STAFF = uid("e2");
export const SUGAR = "ZI-SUGAR", OIL = "ZI-OIL";
export const ADDR = { C1: uid("f1"), C2: uid("f2"), C3: uid("f3") };

/** Today in India (the database's "today"), as yyyy-mm-dd, plus days. */
export function istDay(plus = 0) {
  const ms = Date.now() + 5.5 * 3600_000 + plus * 86400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A database with every migration before the pre-order work and the fixture. With { migrate: true } (default) the two
 * pre-order migrations run too, each twice. Returns helpers.
 */
export async function makeWorld({ migrate = true, pglite = process.env.PGLITE_PATH } = {}) {
  if (!pglite) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
  const { PGlite } = await import(pathToFileURL(join(pglite, "@electric-sql/pglite/dist/index.js")).href);
  const db = new PGlite();
  await db.exec(STUBS);
  for (const file of files.filter((name) => name < MIGRATION_A)) await db.exec(sqlOf(file));
  const q = async (text, params) => (await db.query(text, params)).rows;
  const one = async (text, params) => (await q(text, params))[0];

  // People.
  await q(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}','a@test.local','{"full_name":"TEST Admin"}'),('${ADMIN2}','a2@test.local','{"full_name":"TEST Admin Two"}'),
    ('${C1}','c1@test.local','{"full_name":"TEST Customer One"}'),('${C2}','c2@test.local','{"full_name":"TEST Customer Two"}'),
    ('${C3}','c3@test.local','{"full_name":"TEST Customer Three"}'),('${VENDOR_USER}','v@test.local','{}'),
    ('${PARTNER_USER}','p@test.local','{}'),('${STAFF_USER}','s@test.local','{}'),('${HBL_STAFF}','h@test.local','{}') ON CONFLICT DO NOTHING`);
  await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${ADMIN2}','${C1}','${C2}','${C3}','${VENDOR_USER}','${PARTNER_USER}','${STAFF_USER}','${HBL_STAFF}')`);
  await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${ADMIN2}','admin'),('${C1}','customer'),('${C2}','customer'),('${C3}','customer'),('${VENDOR_USER}','vendor')`);
  await q(`UPDATE public.profiles SET full_name = 'TEST Admin' WHERE id = '${ADMIN}'`);
  await q(`UPDATE public.profiles SET full_name = 'TEST Customer' WHERE id IN ('${C1}','${C2}','${C3}')`);

  // Godowns: Challakere (default) and Hubli, each a Zoho location, each serving its PIN.
  await q(`INSERT INTO public.branches (id, code, name, active, is_default, zoho_location_id, serves_pincodes, pickup_enabled, sort_order)
    VALUES ('BR-CLK','CLK','Challakere Godown',true,true,'LOC-CLK','{577522}',true,1),('BR-HBL','HBL','Hubli Godown',true,false,'LOC-HBL','{580020}',true,2)
    ON CONFLICT (id) DO UPDATE SET active = true, is_default = EXCLUDED.is_default, zoho_location_id = EXCLUDED.zoho_location_id,
      serves_pincodes = EXCLUDED.serves_pincodes, pickup_enabled = true, sort_order = EXCLUDED.sort_order, name = EXCLUDED.name, code = EXCLUDED.code`);
  await q(`UPDATE public.branches SET is_default = false WHERE id NOT IN ('BR-CLK')`);
  await q(`INSERT INTO public.channel_partners (user_id, branch_id, name, email, phone) VALUES ('${PARTNER_USER}','BR-CLK','Partner One','p@test.local','9000000001')`);
  await q(`INSERT INTO public.staff_employees (user_id, branch_id, name, phone) VALUES ('${STAFF_USER}','BR-CLK','Ravi at Challakere','9000000011'),('${HBL_STAFF}','BR-HBL','Hanu at Hubli','9000000012')`);
  for (const [who, id, pin] of [[C1, ADDR.C1, "577522"], [C2, ADDR.C2, "577522"], [C3, ADDR.C3, "580020"]]) {
    await q(`INSERT INTO public.addresses (id, user_id, name, phone, line, city, state, pin) VALUES ($1,$2,'Sample Person','9000000001','1 Sample Road','Sample','Karnataka',$3)`, [id, who, pin]);
  }

  // Settings as live: godown matching on, Zoho the stock master.
  await q(`INSERT INTO public.settings (key, value, is_public) VALUES ('platform_features', '{"branch_routing": true, "marketplace_vendors": false}', true)
    ON CONFLICT (key) DO UPDATE SET value = jsonb_set(public.settings.value, '{branch_routing}', 'true')`);
  await q(`INSERT INTO public.settings (key, value, is_public) VALUES ('zoho_stock_master', '{"enabled": true, "since": "2026-01-01T00:00:00Z"}', false)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await q(`INSERT INTO public.settings (key, value, is_public) VALUES ('bank_transfer', $1::jsonb, false) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ accountName: "Sample Traders", accountNumber: "10234000900", ifsc: "IDFB0000001", bankName: "Sample Bank", branch: "Sample" })]);

  // Products: Sugar S1 (live price, 5% GST, bags) and an oil that never gets a pre-order.
  await q("ALTER TABLE public.catalog_products DISABLE TRIGGER USER");
  await q(`INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES
    ('${SUGAR}','VENDOR-001','Sugar','approved',true,$1),('${OIL}','VENDOR-001','Oil','approved',true,$2)`,
    [JSON.stringify({ id: SUGAR, name: "Sugar S1", price: 2741, mrp: 2752, gst: 5, stock: 50, sold: 0, unit: "pcs", sku: "SBV-S1", vendor: "Grain Bazar", weight: "50 kg", maxPurchaseQuantity: 1000 }),
     JSON.stringify({ id: OIL, name: "TEST Oil 850ml", price: 130, mrp: 130, gst: 5, stock: 40, sold: 0, unit: "pcs", sku: "SBV-OIL", vendor: "Grain Bazar", weight: "850 ml" })]);
  await q("ALTER TABLE public.catalog_products ENABLE TRIGGER USER");
  await q(`INSERT INTO public.branch_stock (branch_id, product_id, stock, zoho_pending) VALUES ('BR-CLK','${SUGAR}',50,false),('BR-HBL','${SUGAR}',0,false),
    ('BR-CLK','${OIL}',30,false),('BR-HBL','${OIL}',10,false)`);
  await q(`INSERT INTO public.zoho_item_links (product_id, zoho_item_id) VALUES ('${SUGAR}','I-SUGAR'),('${OIL}','I-OIL')`);
  await q(`INSERT INTO public.batches (batch_code, product_id, product_name, quantity, remaining_quantity, unit, unit_cost, unit_cost_ex_gst, unit_cost_inc_gst, cost_basis,
      purchase_date, branch_id, warehouse, source, status, zoho_bill_id, zoho_bill_line_id, zoho_bill_number)
    VALUES ('CLK-011126-01','${SUGAR}','Sugar S1',50,50,'pcs',2400,2400,2520,'ex_gst','2026-11-01','BR-CLK','Challakere Godown','website','Active','B-OLD','L-OLD','OLD-1'),
           ('CLK-011126-02','${OIL}','TEST Oil 850ml',30,30,'pcs',110,110,115.5,'ex_gst','2026-11-01','BR-CLK','Challakere Godown','website','Active','B-OLD','L-OLD2','OLD-1')`);
  await db.exec("ALTER ROLE service_role BYPASSRLS; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;");

  if (migrate) await applyMigrations(db);
  return helpers(db);
}

export async function applyMigrations(db, { twice = true } = {}) {
  for (const file of files.filter((name) => name >= MIGRATION_A)) await db.exec(sqlOf(file));
  if (twice) for (const file of files.filter((name) => name >= MIGRATION_A)) await db.exec(sqlOf(file));
}

const DATE_COLUMNS = new Set(["expected_date", "purchase_date", "preorder_by", "mfg_date", "expiry_date", "bill_date", "doc_date", "arrived_on", "by"]);
/** PGlite hands date columns back as Date objects: as yyyy-mm-dd, like the API. */
function days(row) {
  if (!row || typeof row !== "object") return row;
  for (const key of Object.keys(row)) if (DATE_COLUMNS.has(key) && row[key] instanceof Date) row[key] = row[key].toISOString().slice(0, 10);
  return row;
}

export function helpers(db) {
  const q = async (text, params) => {
    try { return (await db.query(text, params)).rows.map(days); }
    catch (error) { if (process.env.SQL_TRACE) console.error("SQL failed:", text.slice(0, 160), "|", error.message); throw error; }
  };
  const one = async (text, params) => (await q(text, params))[0];
  // Inside begin() ... rollback(), every call that may be refused runs in its own savepoint, so a refusal does not end the
  // transaction.
  let depth = 0, spNo = 0;
  const begin = async () => { await db.exec("BEGIN"); depth = 1; };
  const rollback = async () => { await db.exec("ROLLBACK"); depth = 0; };
  async function guarded(fn) {
    if (!depth) return fn();
    const sp = `sp_${++spNo}`;
    await db.exec(`SAVEPOINT ${sp}`);
    try { const out = await fn(); await db.exec(`RELEASE SAVEPOINT ${sp}`); return out; }
    catch (error) { await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); throw error; }
  }
  /** Runs fn with auth.uid() = user, as the given API role. */
  async function as(user, role, fn) {
    if (!depth) {
      await db.query("UPDATE auth.cur SET uid = $1", [user]);
      await db.exec("SET ROLE " + role);
      try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
    }
    const sp = `sp_${++spNo}`;
    await db.exec(`SAVEPOINT ${sp}`);
    await db.query("UPDATE auth.cur SET uid = $1", [user]);
    await db.exec("SET ROLE " + role);
    try {
      const out = await fn();
      await db.exec("RESET ROLE");
      await db.query("UPDATE auth.cur SET uid = NULL");
      await db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (error) {
      await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      await db.exec("RESET ROLE");
      throw error;
    }
  }
  const admin = (text, params) => as(ADMIN, "authenticated", () => q(text, params));
  const adminOne = async (text, params) => (await admin(text, params))[0];
  const server = (text, params) => as(null, "service_role", () => q(text, params));
  const serverOne = async (text, params) => (await server(text, params))[0];
  async function refuses(fn, pattern, label = "") {
    let message = "";
    try { await guarded(fn); } catch (error) { message = error.message; }
    assert.match(message, pattern, `${label}: expected a refusal ${pattern}, got "${message}"`);
    return message;
  }
  const n = (v) => (v === null || v === undefined ? v : Number(v));
  /** The godown's numbers: ready (stock), arriving (incoming), total (free_total). */
  async function pair(branch, product = SUGAR) {
    const r = await one("SELECT stock, incoming, free_total, incoming_detail, zoho_pending FROM public.branch_stock WHERE branch_id = $1 AND product_id = $2", [branch, product]);
    return r ? { ready: n(r.stock), arriving: n(r.incoming), total: n(r.free_total), detail: r.incoming_detail, pending: r.zoho_pending } : null;
  }
  async function watch(branch, product = SUGAR) {
    const w = await one("SELECT * FROM public.preorder_watch WHERE branch_id = $1 AND product_id = $2", [branch, product]);
    return w ? { zoho: n(w.zoho_last), held: n(w.held), waiting: n(w.last_waiting), unbilled: n(w.last_unbilled), raw: n(w.last_raw), opened_at: w.opened_at, held_since: w.held_since } : null;
  }
  const payloadStock = async (product = SUGAR) => n((await one("SELECT payload->>'stock' AS s FROM public.catalog_products WHERE id = $1", [product])).s);
  const batch = (code) => one("SELECT * FROM public.batches WHERE batch_code = $1", [code]);
  const now = () => new Date().toISOString();
  /** The server's snapshot of waiting order lines (before it reads Zoho), as {"BR|P": [ids]}. */
  async function snapshot(products = [SUGAR]) {
    const rows = await server("SELECT * FROM public.preorder_waiting_items($1)", [products]);
    const out = {};
    for (const r of rows) (out[`${r.branch_id}|${r.product_id}`] ??= []).push(r.order_item_id);
    return out;
  }
  /** An order for a customer through the real function, entered by an admin (customers pay first through checkout());
   * Pickup, NEFT: [[product, qty, accept_preorder?]]. */
  async function order(customer, lines, { addr = null, by = ADMIN } = {}) {
    const address = addr ?? (customer === C3 ? ADDR.C3 : customer === C2 ? ADDR.C2 : ADDR.C1);
    const pin = (await one("SELECT pin FROM public.addresses WHERE id = $1", [address])).pin;
    const r = await as(by, "authenticated", () => one(
      "SELECT public.place_marketplace_order('X', $1, '', '', '', NULL, $2::jsonb, 'Pickup', 'NEFT', $3::jsonb) AS r",
      [customer, JSON.stringify({ id: address, pin }), JSON.stringify(lines.map(([product_id, qty, accept]) => ({ product_id, qty, ...(accept === undefined ? {} : { accept_preorder: accept }) })))]));
    return r.r;
  }
  /** A pay-first checkout (Awaiting Payment), as the shop does it. */
  async function checkout(customer, lines) {
    const address = customer === C3 ? ADDR.C3 : customer === C2 ? ADDR.C2 : ADDR.C1;
    const pin = (await one("SELECT pin FROM public.addresses WHERE id = $1", [address])).pin;
    return guarded(async () => { await db.query("UPDATE auth.cur SET uid = $1", [customer]);
    try {
      return (await one(`SELECT public.start_paid_checkout('X', $1, '', '', '', NULL, $2::jsonb, 'Pickup', 'NEFT', $3::jsonb, NULL) AS r`,
        [customer, JSON.stringify({ id: address, pin }), JSON.stringify(lines.map(([product_id, qty, accept]) => ({ product_id, qty, ...(accept === undefined ? {} : { accept_preorder: accept }) })))])).r;
    } finally { if (!depth) await db.query("UPDATE auth.cur SET uid = NULL"); } }).finally(async () => { if (depth) await db.query("UPDATE auth.cur SET uid = NULL"); });
  }
  const orderRow = (no) => one("SELECT * FROM public.orders WHERE order_no = $1", [no]);
  const itemsOf = (no) => q("SELECT i.* FROM public.order_items i JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1 ORDER BY i.product_id, i.id", [no]);
  async function allocsOf(no) {
    return (await q(`SELECT b.batch_code, sum(a.reserved_quantity - a.released_quantity) AS net, a.unit_cost
      FROM public.order_item_batch_allocations a JOIN public.batches b ON b.id = a.batch_id JOIN public.order_items i ON i.id = a.order_item_id
      JOIN public.orders o ON o.id = i.order_id WHERE o.order_no = $1 AND a.reserved_quantity > a.released_quantity
      GROUP BY b.batch_code, a.unit_cost ORDER BY b.batch_code, a.unit_cost`, [no]))
      .map((r) => [r.batch_code, n(r.net), n(r.unit_cost)]);
  }
  /** Zoho's sales order and invoice for an order (the server's sync), as the service role. */
  async function invoiceInZoho(no, status = "confirmed") {
    await server("UPDATE public.orders SET zoho_salesorder_id = 'SO-' || order_no, zoho_order_status = $2 WHERE order_no = $1", [no, status]);
    await q(`INSERT INTO public.zoho_order_invoices (order_id, order_no, zoho_invoice_id, invoice_number, status, total, balance)
      SELECT id, order_no, 'INV-' || order_no, 'INV-' || order_no, 'sent', total, total FROM public.orders WHERE order_no = $1
      ON CONFLICT (order_id) DO UPDATE SET status = 'sent'`, [no]);
  }
  /** Raw status change as the database owner, past every trigger (fixtures only). */
  async function forceStatus(no, status, extra = {}) {
    await db.exec("SET session_replication_role = replica");
    try {
      const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 3}`);
      await q(`UPDATE public.orders SET order_status = $2${sets.length ? ", " + sets.join(", ") : ""} WHERE order_no = $1`, [no, status, ...Object.values(extra)]);
    } finally { await db.exec("SET session_replication_role = DEFAULT"); }
  }
  /** The server's lot creation with fresh readings (Zoho at CLK and HBL). */
  async function createLot({ branch = "BR-CLK", product = SUGAR, qty = 360, cost = 2500, date = istDay(7), holdBack = 0, zoho = { "BR-CLK": 50, "BR-HBL": 0 },
    po = null, checks = {}, by = ADMIN, readAt = null } = {}) {
    const snap = await snapshot([product]);
    const readings = Object.entries(zoho).map(([branch_id, z]) => ({ branch_id, zoho: z }));
    return (await serverOne(`SELECT public.create_incoming_batch($1,$2,$3,$4,$5::date,$6,'SATESH TRADERS',$7::jsonb,'',$8::jsonb,$9::jsonb,$10::jsonb,$11::timestamptz,$12,'TEST Admin') AS r`,
      [branch, product, qty, cost, date, holdBack, po === null ? null : JSON.stringify(po), JSON.stringify(checks), JSON.stringify(readings), JSON.stringify(snap), readAt ?? now(), by])).r;
  }
  /** The hourly pull for one product: snapshot first, then Zoho's numbers; watched pairs take apply_preorder_reading,
   * the others the old path (website stock = Zoho - waiting orders). between(): runs after the snapshot, before the read. */
  async function pull(zoho, { product = SUGAR, between = null } = {}) {
    const readAt = now();
    const snap = await snapshot([product]);
    if (between) await between();
    const out = {};
    for (const [branch, z] of Object.entries(zoho)) {
      const ids = snap[`${branch}|${product}`] ?? [];
      const r = (await serverOne("SELECT public.apply_preorder_reading($1,$2,$3,$4::timestamptz,$5::uuid[]) AS r", [branch, product, z, readAt, ids])).r;
      if (r.watched === false) {
        // The server's own rule (pendingOrderQty): orders since Zoho became the stock master, not cancelled or expired, no
        // sales order beyond a draft.
        const waiting = n((await one("SELECT private.batch_transfer_orders_waiting($1, $2) AS w", [branch, product])).w);
        const legacy = (await serverOne("SELECT public.apply_zoho_branch_stock($1,$2,$3,$4::timestamptz) AS r", [branch, product, Math.max(0, z - waiting), readAt])).r;
        out[branch] = { legacy: true, total: n(legacy) };
      } else out[branch] = r;
    }
    return out;
  }
  /** Receive purchase at the bill's own godown (receive_bill_lines) with fresh readings. */
  async function receive(branch, bill, lines, zoho, { product = SUGAR, costBasis = "ex_gst", by = ADMIN } = {}) {
    const products = [...new Set([product, ...lines.map((l) => l.product_id)])];
    const snap = await snapshot(products);
    const readings = [];
    for (const p of products) for (const [b, z] of Object.entries(zoho)) readings.push({ branch_id: b, product_id: p, zoho: typeof z === "object" ? z[p] : z });
    return (await serverOne("SELECT public.receive_bill_lines($1,$2::jsonb,$3::jsonb,$4,$5::jsonb,$6::jsonb,$7::timestamptz,$8,'TEST Admin') AS r",
      [branch, JSON.stringify(bill), JSON.stringify(lines), costBasis, JSON.stringify(readings.filter((r) => typeof r.zoho === "number")), JSON.stringify(snap), now(), by])).r;
  }
  const events = (kind) => q("SELECT * FROM public.batch_lot_events WHERE kind = $1 ORDER BY id", [kind]);
  const notes = (title) => q("SELECT recipient_role, message, order_no FROM public.notifications WHERE title = $1 ORDER BY created_at, id", [title]);
  const setPreorder = (value) => q("UPDATE public.settings SET value = value || $1::jsonb WHERE key = 'preorder'", [JSON.stringify(value)]);
  return { db, q, one, as, begin, rollback, guarded, admin, adminOne, server, serverOne, refuses, n, pair, watch, payloadStock, batch, now, snapshot, order, checkout,
    orderRow, itemsOf, allocsOf, invoiceInZoho, forceStatus, createLot, pull, receive, events, notes, setPreorder, randomUUID };
}
