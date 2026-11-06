import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Several testers may share one admin login. A plain signOut() is global in Supabase: one person's logout, or
// their browser going idle, would sign everyone on that account out. Every sign-out must stay on this browser,
// except after a new password, which signs out every device on purpose so anyone holding the old one is cut off.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("every sign-out signs out only this browser, except after a new password", () => {
  const offenders = sourceFiles("src").flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const calls = text.match(/auth\.signOut\([^)]*\)/g) ?? [];
    const allowed = file.endsWith("reset-password.tsx") ? /scope:\s*"global"/ : /scope:\s*"local"/;
    return calls.filter((call) => !allowed.test(call)).map((call) => `${file}: ${call}`);
  });
  assert.deepEqual(offenders, []);
});
