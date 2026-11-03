// Real-Postgres check of 20261102190000_product_code_master.sql, on PGlite with every migration in the
// repo and small stand-ins for what Supabase provides. Touches nothing live. Not part of test:zoho,
// because PGlite is not a dependency of this project:
//
//   PGLITE_PATH=<folder with @electric-sql/pglite> node tests/db/product-codes.db-test.mjs
//
// It must end with "product code migration OK".
import { readFileSync, readdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pgliteHome = process.env.PGLITE_PATH;
if (!pgliteHome) throw new Error("Set PGLITE_PATH to a node_modules folder holding @electric-sql/pglite");
const { PGlite } = await import(pathToFileURL(join(pgliteHome, "@electric-sql/pglite/dist/index.js")).href);
const MIGRATION = "20261102190000_product_code_master.sql";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE supabase_auth_admin; CREATE ROLE postgres_stub;
  CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  -- What Supabase does for every new table: the migration has to take it back itself.
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
for (const file of files.filter((name) => name < MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

const q = async (text, params) => (await db.query(text, params)).rows;
const ADMIN = "00000000-0000-4000-8000-0000000000a1", VENDOR = "00000000-0000-4000-8000-0000000000b1", CUSTOMER = "00000000-0000-4000-8000-0000000000c1";

// Products from before this migration, in live's shape. They must come out untouched.
await q(`INSERT INTO auth.users (id, email) VALUES ('${ADMIN}','a@test.local'),('${VENDOR}','v@test.local'),('${CUSTOMER}','c@test.local') ON CONFLICT DO NOTHING`);
await q(`DELETE FROM public.user_roles WHERE user_id IN ('${ADMIN}','${VENDOR}','${CUSTOMER}')`);
await q(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}','admin'),('${VENDOR}','vendor'),('${CUSTOMER}','customer')`);
await q(`UPDATE public.profiles SET vendor_id = 'V1' WHERE id = '${VENDOR}'`);
await q(`INSERT INTO public.profiles (id, vendor_id) SELECT '${VENDOR}', 'V1' WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = '${VENDOR}')`);
const product = (id, category, vendor = "V1", extra = {}) => ({ id, name: id, sku: `SKU-${id}`, category, subcategory: "Raw Rice", weight: "25 kg", price: 100, mrp: 100, stock: 5, vendorId: vendor, status: "approved", active: true, ...extra });
const insertProduct = (row) => q(`INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload) VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, row.vendorId, row.category, row.status, row.active, JSON.stringify(row)]);
await q(`ALTER TABLE public.catalog_products DISABLE TRIGGER USER`);
await insertProduct(product("P-OLD-1", "Rice"));
await insertProduct(product("P-OLD-2", "Sugar"));
await q(`ALTER TABLE public.catalog_products ENABLE TRIGGER USER`);
const before = await q(`SELECT id, payload::text p, updated_at::text u FROM public.catalog_products ORDER BY id`);

await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
for (const file of files.filter((name) => name > MIGRATION)) await db.exec(readFileSync(join(dir, file), "utf8"));

// As a signed-in role, under row rules.
async function as(uid, role, fn) {
  await db.query("UPDATE auth.cur SET uid = $1", [uid]);
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); await db.query("UPDATE auth.cur SET uid = NULL"); }
}
const admin = (fn) => as(ADMIN, "authenticated", fn);
const vendor = (fn) => as(VENDOR, "authenticated", fn);
const customer = (fn) => as(CUSTOMER, "authenticated", fn);
const anon = (fn) => as(null, "anon", fn);
const refused = async (fn, pattern) => {
  let error;
  try { await fn(); } catch (cause) { error = cause; }
  assert.ok(error, `expected a refusal: ${pattern}`);
  assert.match(error.message, pattern);
};

/* ---------- the seed is the workbook, exactly ---------- */
function readWorkbook(path) {
  const buf = readFileSync(path);
  const parts = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i += 1) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + n);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + size);
    parts[name] = method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8");
    p += 46 + n + x + c;
  }
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const shared = [...parts["xl/sharedStrings.xml"].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const sheet = (number) => {
    const rows = {};
    for (const c of parts[`xl/worksheets/sheet${number}.xml`].matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[4] ?? "")?.[1];
      if (v === undefined) continue;
      (rows[c[2]] ??= {})[c[1]] = /t="s"/.test(c[3]) ? shared[Number(v)] : decode(v);
    }
    return rows;
  };
  return { matrix: sheet(1), list: sheet(2), legend: sheet(3) };
}
const book = readWorkbook(join(root, "tests", "fixtures", "Rice_Product_Codes.xlsx"));
const riceSet = (await q(`SELECT * FROM public.product_code_sets`));
assert.equal(riceSet.length, 1, "only rice is seeded");
assert.equal(riceSet[0].category, "Rice");
assert.equal(riceSet[0].prefix, "");
const RICE = riceSet[0].id;
const seedMethods = await q(`SELECT letter, name FROM public.product_code_methods ORDER BY sort_order`);
const seedVarieties = await q(`SELECT letter, name FROM public.product_code_varieties ORDER BY sort_order`);
assert.deepEqual(seedMethods, [5, 6, 7, 8, 9].map((row) => ({ letter: book.legend[row].B, name: book.legend[row].A })));
assert.deepEqual(seedVarieties, [5, 6, 7, 8, 9, 10].map((row) => ({ letter: book.legend[row].E, name: book.legend[row].D })));
const seedCodes = await q(`SELECT c.code, m.name method, v.name variety, c.name description, c.serial, c.subcategory, c.description d, c.images, c.retired_at
  FROM public.product_codes c JOIN public.product_code_methods m ON m.id = c.method_id JOIN public.product_code_varieties v ON v.id = c.variety_id
  ORDER BY m.sort_order, v.sort_order`);
assert.equal(seedCodes.length, 30);
Object.keys(book.list).filter((row) => row !== "1").forEach((row, index) => {
  const sheetRow = book.list[row], seeded = seedCodes[index];
  assert.equal(Number(sheetRow.A), index + 1);
  assert.deepEqual({ code: seeded.code, method: seeded.method, variety: seeded.variety, description: seeded.description }, { code: sheetRow.B, method: sheetRow.C, variety: sheetRow.D, description: sheetRow.E });
  assert.equal(seeded.serial, 1);
  assert.equal(seeded.subcategory, seeded.method);
  assert.equal(seeded.d, "");
  assert.deepEqual(seeded.images, []);
  assert.equal(seeded.retired_at, null);
});
const matrixCodes = [4, 5, 6, 7, 8, 9].flatMap((row) => ["B", "C", "D", "E", "F"].map((column) => book.matrix[row][column]));
assert.deepEqual([...new Set(matrixCodes)].sort(), seedCodes.map((row) => row.code).sort());

/* ---------- the migration changed no product ---------- */
assert.deepEqual(await q(`SELECT id, payload::text p, updated_at::text u FROM public.catalog_products ORDER BY id`), before);

/* ---------- admin keeps the list; everything is enforced in the database ---------- */
const method = async (letter) => (await q(`SELECT id FROM public.product_code_methods WHERE set_id = $1 AND letter = $2`, [RICE, letter]))[0].id;
const variety = async (letter) => (await q(`SELECT id FROM public.product_code_varieties WHERE set_id = $1 AND letter = $2`, [RICE, letter]))[0].id;
const R = await method("R"), S = await method("S"), VS = await variety("S");
const insertCode = (setId, m, v, extra = "") => q(`INSERT INTO public.product_codes (set_id, method_id, variety_id${extra ? ", name" : ""}) VALUES ($1,$2,$3${extra ? ", $4" : ""}) RETURNING *`, extra ? [setId, m, v, extra] : [setId, m, v]);

// A new variety, then its codes: the next serial and the code come from the database.
const created = await admin(async () => {
  const [row] = await q(`INSERT INTO public.product_code_varieties (set_id, letter, name, sort_order) VALUES ($1,'a','  Jeera   Samba ',7) RETURNING *`, [RICE]);
  return row;
});
assert.equal(created.letter, "A");
assert.equal(created.name, "Jeera Samba");
const ra = await admin(() => insertCode(RICE, R, created.id));
assert.equal(ra[0].code, "RA01");
assert.equal(ra[0].name, "Raw Rice - Jeera Samba");
assert.equal(ra[0].subcategory, "Raw Rice");
const rs02 = await admin(() => q(`INSERT INTO public.product_codes (set_id, method_id, variety_id, serial, code, retired_at) VALUES ($1,$2,$3,7,'ZZ99',now()) RETURNING *`, [RICE, R, VS]));
assert.equal(rs02[0].code, "RS02", "what the page sends for the code and serial is ignored");
assert.equal(rs02[0].serial, 2);
assert.equal(rs02[0].name, "Raw Rice - Sona Rice 02", "a later serial must not read like the first");
assert.equal(rs02[0].retired_at, null);
await admin(() => q(`UPDATE public.product_codes SET name = 'Sona Raw Super', description = 'Second grade', images = ARRAY['https://x/1.jpg','https://x/2.jpg'] WHERE code = 'RS02'`));
assert.deepEqual((await q(`SELECT name, images FROM public.product_codes WHERE code = 'RS02'`))[0], { name: "Sona Raw Super", images: ["https://x/1.jpg", "https://x/2.jpg"] });

// Letters: unique in each position, the same letter fine across positions.
assert.equal((await q(`SELECT count(*)::int n FROM public.product_code_methods WHERE letter = 'S'`))[0].n, 1);
assert.equal((await q(`SELECT count(*)::int n FROM public.product_code_varieties WHERE letter = 'S'`))[0].n, 1);
await refused(() => admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'R','Another')`, [RICE])), /unique/);
await refused(() => admin(() => q(`INSERT INTO public.product_code_varieties (set_id, letter, name) VALUES ($1,'K','Another')`, [RICE])), /unique/);
await refused(() => admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'Q','raw rice')`, [RICE])), /unique/);
await refused(() => admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'12','Bad')`, [RICE])), /letter_check|check constraint/);
await admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'A','Aged')`, [RICE]));

// A letter is free to fix until a code uses it, then locked. A set's prefix likewise.
await admin(() => q(`UPDATE public.product_code_methods SET letter = 'G' WHERE set_id = $1 AND letter = 'A'`, [RICE]));
await refused(() => admin(() => q(`UPDATE public.product_code_methods SET letter = 'Z' WHERE id = $1`, [R])), /locked.*RA01|locked.*RK01/);
await refused(() => admin(() => q(`UPDATE public.product_code_varieties SET letter = 'Z' WHERE id = $1`, [VS])), /locked/);
await refused(() => admin(() => q(`UPDATE public.product_code_sets SET prefix = 'X' WHERE id = $1`, [RICE])), /prefix/);

// The code is fixed for good.
for (const change of [`code = 'XX01'`, `serial = 9`, `method_id = '${S}'`, `variety_id = '${created.id}'`]) {
  await refused(() => admin(() => q(`UPDATE public.product_codes SET ${change} WHERE code = 'RS01'`)), /never changes/);
}
assert.equal((await q(`SELECT count(*)::int n FROM public.product_codes WHERE code = 'RS01'`))[0].n, 1);

// Never deleted: not by an admin (no rights), not by the server, not by the owner.
await refused(() => admin(() => q(`DELETE FROM public.product_codes WHERE code = 'RK01'`)), /permission denied/);
await refused(() => q(`DELETE FROM public.product_codes WHERE code = 'RK01'`), /never deleted/);
for (const table of ["product_code_sets", "product_code_methods", "product_code_varieties"]) {
  await refused(() => admin(() => q(`DELETE FROM public.${table}`)), /permission denied/);
}

// Retired: the number is never used again, and its details stay as they were until restored.
await admin(() => q(`UPDATE public.product_codes SET retired_at = now() WHERE code = 'RS02'`));
const rs03 = await admin(() => insertCode(RICE, R, VS));
assert.equal(rs03[0].code, "RS03", "a retired serial is not reused");
await refused(() => admin(() => q(`UPDATE public.product_codes SET name = 'Something else' WHERE code = 'RS02'`)), /retired.*Restore/);
await admin(() => q(`UPDATE public.product_codes SET retired_at = NULL WHERE code = 'RS02'`));
assert.equal((await q(`SELECT name FROM public.product_codes WHERE code = 'RS02'`))[0].name, "Sona Raw Super");

// Retiring a method retires its codes; its letter stays reserved; restoring brings back only those.
const P = await method("P");
await admin(() => q(`UPDATE public.product_codes SET retired_at = now() WHERE code = 'PK01'`));
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = now() WHERE id = $1`, [P]));
assert.equal((await q(`SELECT count(*)::int n FROM public.product_codes WHERE method_id = $1 AND retired_at IS NULL`, [P]))[0].n, 0);
await refused(() => admin(() => insertCode(RICE, P, VS)), /retired/);
await refused(() => admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'P','Par Boiled')`, [RICE])), /unique/);
await refused(() => admin(() => q(`UPDATE public.product_codes SET retired_at = NULL WHERE code = 'PS01'`)), /Restore the method/);
// A retired one's name is free, so its replacement can carry it under a new letter: the documented way to change a letter.
const [replacement] = await admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'W','Half Boiled') RETURNING *`, [RICE]));
await refused(() => admin(() => q(`UPDATE public.product_code_methods SET retired_at = NULL WHERE id = $1`, [P])), /unique/);
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = now() WHERE id = $1`, [replacement.id]));
// Retired stays as it was: no new name, and retiring it again changes nothing.
await refused(() => admin(() => q(`UPDATE public.product_code_methods SET name = 'Sun Dried' WHERE id = $1`, [P])), /Restore it/);
await refused(() => admin(() => q(`UPDATE public.product_code_methods SET letter = 'Y' WHERE id = $1`, [replacement.id])), /stays reserved/);
const pStamp = async () => (await q(`SELECT retired_at::text t FROM public.product_code_methods WHERE id = $1`, [P]))[0].t;
const pStampBefore = await pStamp();
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = '2000-01-01' WHERE id = $1`, [P]));
assert.equal(await pStamp(), pStampBefore);
await admin(() => q(`UPDATE public.product_codes SET retired_at = '2000-01-01' WHERE code = 'PS01'`));
assert.equal((await q(`SELECT retired_with_part w FROM public.product_codes WHERE code = 'PS01'`))[0].w, true, "still came with its method");
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = NULL WHERE id = $1`, [P]));
assert.equal((await q(`SELECT code FROM public.product_codes WHERE method_id = $1 AND retired_at IS NOT NULL`, [P]))[0].code, "PK01", "PK01 was retired on its own and stays retired");
assert.equal((await q(`SELECT count(*)::int n FROM public.product_codes WHERE method_id = $1 AND retired_at IS NULL`, [P]))[0].n, 5);

// Both parts retired: whichever comes back first, the code returns once both are live.
const B = await method("B"), VN = await variety("N");
const bn01 = async () => (await q(`SELECT retired_at IS NULL live FROM public.product_codes WHERE code = 'BN01'`))[0].live;
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = now() WHERE id = $1`, [B]));
await admin(() => q(`UPDATE public.product_code_varieties SET retired_at = now() WHERE id = $1`, [VN]));
assert.equal(await bn01(), false);
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = NULL WHERE id = $1`, [B]));
assert.equal(await bn01(), false, "its variety is still retired");
assert.equal((await q(`SELECT retired_at IS NULL live FROM public.product_codes WHERE code = 'BS01'`))[0].live, true);
await admin(() => q(`UPDATE public.product_code_varieties SET retired_at = NULL WHERE id = $1`, [VN]));
assert.equal(await bn01(), true, "both are back");
// The same again the other way round.
await admin(() => q(`UPDATE public.product_code_varieties SET retired_at = now() WHERE id = $1`, [VN]));
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = now() WHERE id = $1`, [B]));
await admin(() => q(`UPDATE public.product_code_varieties SET retired_at = NULL WHERE id = $1`, [VN]));
assert.equal(await bn01(), false, "its method is still retired");
await admin(() => q(`UPDATE public.product_code_methods SET retired_at = NULL WHERE id = $1`, [B]));
assert.equal(await bn01(), true, "both are back");

/* ---------- other categories, later, by admin ---------- */
const [sugar] = await admin(() => q(`INSERT INTO public.product_code_sets (category, first_label, second_label) VALUES ('Sugar','Grade','Mill') RETURNING *`));
await refused(() => admin(() => q(`INSERT INTO public.product_code_sets (category) VALUES (' RICE ')`)), /unique/);
const [sm] = await admin(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'R','Refined') RETURNING *`, [sugar.id]));
const [sv] = await admin(() => q(`INSERT INTO public.product_code_varieties (set_id, letter, name) VALUES ($1,'S','S30') RETURNING *`, [sugar.id]));
await refused(() => admin(() => insertCode(sugar.id, sm.id, sv.id)), /RS01 is already used in Rice/);
await refused(() => admin(() => insertCode(sugar.id, R, sv.id)), /must belong/);
await admin(() => q(`UPDATE public.product_code_sets SET prefix = 'u' WHERE id = $1`, [sugar.id]));
const [urs] = await admin(() => insertCode(sugar.id, sm.id, sv.id));
assert.equal(urs.code, "URS01");
await refused(() => admin(() => q(`UPDATE public.product_code_sets SET prefix = 'V' WHERE id = $1`, [sugar.id])), /prefix/);
await refused(() => admin(() => q(`INSERT INTO public.product_code_sets (category, prefix) VALUES ('Oil','U')`)), /unique/);

/* ---------- nobody else ---------- */
for (const [who, act] of [["customer", customer], ["vendor", vendor]]) {
  for (const table of ["product_code_sets", "product_code_methods", "product_code_varieties", "product_codes"]) {
    assert.equal((await act(() => q(`SELECT count(*)::int n FROM public.${table}`)))[0].n, 0, `${who} reads nothing from ${table}`);
    await refused(() => act(() => q(`DELETE FROM public.${table}`)), /permission denied/);
  }
  await refused(() => act(() => q(`INSERT INTO public.product_code_sets (category) VALUES ('Oil')`)), /row-level security/);
  await refused(() => act(() => q(`INSERT INTO public.product_code_methods (set_id, letter, name) VALUES ($1,'X','X')`, [RICE])), /row-level security/);
  await refused(() => act(() => q(`INSERT INTO public.product_code_varieties (set_id, letter, name) VALUES ($1,'X','X')`, [RICE])), /row-level security/);
  await refused(() => act(() => q(`INSERT INTO public.product_codes (set_id, method_id, variety_id) VALUES ($1,$2,$3)`, [RICE, R, VS])), /row-level security|must belong/);
  for (const table of ["product_code_sets", "product_code_methods", "product_code_varieties", "product_codes"]) {
    const updated = await act(() => db.query(`UPDATE public.${table} SET updated_at = now() RETURNING id`));
    assert.equal(updated.rows.length, 0, `${who} updates nothing in ${table}`);
  }
}
for (const table of ["product_code_sets", "product_code_methods", "product_code_varieties", "product_codes"]) {
  await refused(() => anon(() => q(`SELECT * FROM public.${table}`)), /permission denied/);
  await refused(() => anon(() => q(`DELETE FROM public.${table}`)), /permission denied/);
  await refused(() => anon(() => q(`UPDATE public.${table} SET updated_at = now()`)), /permission denied/);
}
for (const fn of ["guard_catalog_product_code", "product_code_set_guard", "product_code_part_guard", "product_code_part_retired", "product_code_before_insert", "product_code_before_update", "product_code_no_delete"]) {
  assert.deepEqual((await q(`SELECT has_function_privilege('authenticated', 'public.${fn}()', 'EXECUTE') a, has_function_privilege('anon', 'public.${fn}()', 'EXECUTE') b`))[0], { a: false, b: false }, fn);
}
assert.deepEqual((await q(`SELECT has_function_privilege('authenticated', 'public.admin_set_product_code(text,text)', 'EXECUTE') a, has_function_privilege('anon', 'public.admin_set_product_code(text,text)', 'EXECUTE') b`))[0], { a: true, b: false });
for (const table of ["product_code_sets", "product_code_methods", "product_code_varieties", "product_codes"]) {
  assert.deepEqual((await q(`SELECT has_table_privilege('service_role', 'public.${table}', 'SELECT, INSERT, UPDATE') s, has_table_privilege('authenticated', 'public.${table}', 'DELETE') d, has_table_privilege('anon', 'public.${table}', 'SELECT') a`))[0], { s: true, d: false, a: false }, table);
}

/* ---------- a product's code ---------- */
// has_role and current_vendor_id decide; KYC rules on vendors don't matter here, so use admin-made rows.
const save = (row) => q(`INSERT INTO public.catalog_products (id, vendor_id, category, status, active, payload, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT (id) DO UPDATE SET vendor_id = EXCLUDED.vendor_id, category = EXCLUDED.category, status = EXCLUDED.status, active = EXCLUDED.active, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
  [row.id, row.vendorId, row.category, row.status, row.active, JSON.stringify(row)]);
const codeOf = async (id) => (await q(`SELECT payload->>'productCode' c FROM public.catalog_products WHERE id = $1`, [id]))[0].c;

// Admin: any live code of the right category; never a made-up, retired or other-category one.
const riceRow = product("P-A", "Rice", "V1", { productCode: "RS01" });
await admin(() => save(riceRow));
assert.equal(await codeOf("P-A"), "RS01");
await refused(() => admin(() => save(product("P-B", "Rice", "V1", { productCode: "RS99" }))), /not in the product code list/);
await refused(() => admin(() => save(product("P-B", "Rice", "V1", { productCode: "PK01" }))), /retired/);
await refused(() => admin(() => save(product("P-B", "Sugar", "V1", { productCode: "RS01" }))), /belongs to Rice/);
await refused(() => admin(() => save(product("P-Z", "Rice", "zoho:abc", { productCode: "RS01" }))), /Zoho-imported/);
// Two pack sizes can share one code: nothing in the database stops it, the form warns.
await admin(() => save(product("P-A2", "Rice", "V1", { productCode: "RS01", weight: "50 kg" })));
await admin(() => save(product("P-A3", "Rice", "V1", { productCode: "RS01", weight: "25 kg" })));
// The rest of a product's life never meets the guard.
await admin(() => save({ ...riceRow, price: 120 }));
assert.equal(await codeOf("P-A"), "RS01");

// Linking changes nothing else about an old product.
const old = (await q(`SELECT payload FROM public.catalog_products WHERE id = 'P-OLD-1'`))[0].payload;
await admin(() => q(`UPDATE public.catalog_products SET payload = payload || '{"productCode":"RK01"}'::jsonb WHERE id = 'P-OLD-1'`));
const linked = (await q(`SELECT payload FROM public.catalog_products WHERE id = 'P-OLD-1'`))[0].payload;
assert.deepEqual({ ...linked, productCode: undefined }, { ...old, productCode: undefined });
assert.equal(linked.sku, "SKU-P-OLD-1");

// admin_set_product_code changes that one field, not updated_at, and queues nothing for Zoho.
const zohoJobs = async () => (await q(`SELECT count(*)::int n FROM public.zoho_sync_outbox`))[0].n;
const full = async (id) => (await q(`SELECT payload, updated_at::text u FROM public.catalog_products WHERE id = $1`, [id]))[0];
const beforeSet = await full("P-A3"), jobsBefore = await zohoJobs();
assert.equal((await admin(() => q(`SELECT public.admin_set_product_code('P-A3', ' rn01 ') r`)))[0].r, true);
const afterSet = await full("P-A3");
assert.equal(afterSet.payload.productCode, "RN01");
assert.deepEqual({ ...afterSet.payload, productCode: "x" }, { ...beforeSet.payload, productCode: "x" });
assert.equal(afterSet.u, beforeSet.u, "updated_at must not move, or 'latest edit wins' could flip");
assert.equal(await zohoJobs(), jobsBefore);
assert.equal((await admin(() => q(`SELECT public.admin_set_product_code('P-A3', '') r`)))[0].r, true);
assert.equal(await codeOf("P-A3"), null);
assert.equal((await admin(() => q(`SELECT public.admin_set_product_code('no-such-product', 'RS01') r`)))[0].r, false);
await refused(() => admin(() => q(`SELECT public.admin_set_product_code('P-A3', 'NOPE1')`)), /not in the product code list/);
await refused(() => admin(() => q(`SELECT public.admin_set_product_code('P-A3', 'PK01')`)), /retired/);
await refused(() => admin(() => q(`SELECT public.admin_set_product_code('P-OLD-2', 'RS01')`)), /belongs to Rice/);
await refused(() => customer(() => q(`SELECT public.admin_set_product_code('P-A3', 'RS01')`)), /Only an administrator/);
await refused(() => vendor(() => q(`SELECT public.admin_set_product_code('P-A3', 'RS01')`)), /Only an administrator/);
await refused(() => anon(() => q(`SELECT public.admin_set_product_code('P-A3', 'RS01')`)), /permission denied/);
await admin(() => q(`SELECT public.admin_set_product_code('P-A3', 'RS01')`));

// A visitor can't use a save to find out which codes exist: every code gets the same answer.
for (const code of ["RS01", "RS99", "PK01"]) {
  await refused(() => anon(() => save(product("P-ANON", "Rice", "V1", { status: "pending", productCode: code }))), /Only an administrator/);
}

// A code retired later: products keep it and go on saving; another product can't take it.
await admin(() => q(`UPDATE public.product_codes SET retired_at = now() WHERE code = 'RK01'`));
await admin(() => q(`UPDATE public.catalog_products SET payload = jsonb_set(payload, '{price}', '150') WHERE id = 'P-OLD-1'`));
await admin(() => save({ ...linked, price: 160 }));
assert.equal(await codeOf("P-OLD-1"), "RK01");
await refused(() => admin(() => save(product("P-B", "Rice", "V1", { productCode: "RK01" }))), /retired/);
await admin(() => q(`UPDATE public.product_codes SET retired_at = NULL WHERE code = 'RK01'`));

// Zoho and the stock functions merge into the payload, so the code survives them.
await q(`SELECT public.apply_zoho_catalog_item('P-OLD-1', '{"name":"From Zoho","sku":"Z-1","rate":"210","status":"active"}'::jsonb, (SELECT updated_at FROM public.catalog_products WHERE id = 'P-OLD-1'))`);
const afterZoho = (await q(`SELECT payload FROM public.catalog_products WHERE id = 'P-OLD-1'`))[0].payload;
assert.equal(afterZoho.productCode, "RK01");
assert.equal(afterZoho.name, "From Zoho");

// A seller: can't set, change or clear a code, on insert or update. Saving a product that already
// carries one, with the code unchanged, must still work: the upsert fires the insert guard first.
// The marketplace is off on live; turn it on here, with KYC off, so only the code rules can refuse.
await q(`INSERT INTO public.settings (key, value) VALUES ('platform_features', '{"marketplace_vendors":true}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
await q(`INSERT INTO public.settings (key, value) VALUES ('security_config', '{"vendorKyc":false}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
const vendorOwned = product("P-V", "Rice", "V1", { status: "pending" });
await vendor(() => save(vendorOwned));
await refused(() => vendor(() => save({ ...vendorOwned, productCode: "RS01" })), /Only an administrator/);
await refused(() => vendor(() => save(product("P-V2", "Rice", "V1", { status: "pending", productCode: "RS01" }))), /Only an administrator/);
await refused(() => vendor(() => q(`UPDATE public.catalog_products SET payload = payload || '{"productCode":"RS01"}'::jsonb WHERE id = 'P-V'`)), /Only an administrator/);
await admin(() => save({ ...vendorOwned, productCode: "RS01" }));
await vendor(() => save({ ...vendorOwned, productCode: "RS01", description: "Seller edit" }));
assert.deepEqual((await q(`SELECT payload->>'description' d, payload->>'productCode' c FROM public.catalog_products WHERE id = 'P-V'`))[0], { d: "Seller edit", c: "RS01" });
await refused(() => vendor(() => save({ ...vendorOwned, productCode: "RK01" })), /Only an administrator/);
await refused(() => vendor(() => save(vendorOwned)), /Only an administrator/);
await refused(() => vendor(() => q(`UPDATE public.catalog_products SET payload = payload - 'productCode' WHERE id = 'P-V'`)), /Only an administrator/);
assert.equal(await codeOf("P-V"), "RS01");

// The server (no signed-in user) never changes a code: a whole-payload write of a copy read a moment
// earlier keeps whatever is on the product now, so it can't take one off, revert one or add one.
await q(`UPDATE public.catalog_products SET payload = payload - 'productCode' WHERE id = 'P-V'`);
assert.equal(await codeOf("P-V"), "RS01");
await q(`UPDATE public.catalog_products SET payload = payload || '{"productCode":"RK01"}'::jsonb WHERE id = 'P-V'`);
assert.equal(await codeOf("P-V"), "RS01");
await q(`UPDATE public.catalog_products SET payload = payload || '{"productCode":"RK01"}'::jsonb WHERE id = 'P-OLD-2'`);
assert.equal(await codeOf("P-OLD-2"), null);
assert.equal((await q(`SELECT payload ? 'productCode' has FROM public.catalog_products WHERE id = 'P-OLD-2'`))[0].has, false);

// Running the migration a second time leaves the rice seed alone.
const countBefore = (await q(`SELECT count(*)::int n FROM public.product_codes`))[0].n;
await db.exec(readFileSync(join(dir, MIGRATION), "utf8"));
assert.equal((await q(`SELECT count(*)::int n FROM public.product_codes`))[0].n, countBefore);

console.log("product code migration OK");
process.exit(0);
