import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The rules live in a database function, and this suite has no database, so these read the newest
// definition of it. They fail if a later migration brings back the check that refused every edit,
// or drops the rule that protects a deleted customer.
const dir = new URL("../supabase/migrations/", import.meta.url);
const definitions = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()
  .map((file) => readFileSync(new URL(file, dir), "utf8").replaceAll("\r\n", "\n"))
  .filter((sql) => sql.includes("FUNCTION public.apply_zoho_contact_update("));
const newest = definitions.at(-1) ?? "";
const start = newest.indexOf("CREATE OR REPLACE FUNCTION public.apply_zoho_contact_update(");
const body = newest.slice(start, newest.indexOf("\n$$;", start));
const rulesOf = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const code = rulesOf(body);

test("the role is read from user_roles, because has_role() is always false for the server's key", () => {
  assert.ok(code.length > 0, "the function's definition was not found");
  assert.ok(!code.includes("has_role("));
  assert.match(code, /FROM public\.user_roles WHERE user_id = _user_id AND role::text = _contact_type/);
  assert.match(code, /RAISE EXCEPTION 'Zoho contact type does not match the Grain Bazar account role'/);
});

test("a deleted customer is refused before anything is written", () => {
  const lock = code.indexOf("FROM public.profiles WHERE id = _user_id FOR UPDATE");
  const refusal = code.search(/IF NOT FOUND OR person\.status = 'deleted' THEN\s+RAISE EXCEPTION/);
  assert.ok(lock > 0, "the profile row must be locked, so a delete running now can't be missed");
  assert.ok(refusal > lock, "the status must be read after the lock is held");
  for (const write of ["UPDATE public.profiles", "UPDATE public.addresses", "INSERT INTO public.addresses"]) {
    const at = code.indexOf(write);
    assert.ok(at > refusal, `${write} must come after the refusal`);
  }
});

test("an edit from Zoho is not sent back to Zoho", () => {
  const at = code.indexOf("set_config('app.zoho_inbound', 'on', true)");
  assert.ok(at > 0);
  assert.ok(at < code.indexOf("UPDATE public.profiles"));
});

test("a delivery phone of its own on the address stays", () => {
  const update = code.slice(code.indexOf("UPDATE public.addresses"), code.indexOf("WHERE id = address_row.id"));
  assert.match(update, /phone = CASE WHEN COALESCE\(trim\(phone\), ''\) IN \('', COALESCE\(trim\(person\.phone\), ''\)\) THEN COALESCE\(new_phone, phone\) ELSE phone END/);
});

test("only the server's key may run it", () => {
  assert.match(newest, /REVOKE ALL ON FUNCTION public\.apply_zoho_contact_update\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  assert.match(newest, /GRANT EXECUTE ON FUNCTION public\.apply_zoho_contact_update\([^)]*\) TO service_role;/);
});

test("edits made before go-live don't come across in one go", () => {
  assert.match(newest, /UPDATE public\.zoho_contact_links SET last_zoho_modified_at = now\(\)/);
});
