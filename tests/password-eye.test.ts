import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Edge shows its own eye on a password box only while typing and removes it once the box loses focus, so
// people could not check what they typed. Every password box must use PasswordInput, whose eye stays, and
// the browser's own eye must stay hidden so there are never two.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const OWN_FILE = join("src", "components", "ui", "password-input.tsx");

test("every password box uses PasswordInput (the eye that stays)", () => {
  const offenders = sourceFiles("src")
    .filter((file) => file !== OWN_FILE)
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const plain = text.match(/type=\{?\s*["'`]password["'`]/g) ?? [];
      return plain.map((match) => `${file}: ${match}`);
    });
  assert.deepEqual(offenders, []);
});

test("the password logins of every role use PasswordInput", () => {
  for (const page of [
    "admin.login",
    "vendor.login",
    "partner.login",
    "staff.login",
    "reset-password",
    "account.settings",
    "vendor.settings",
  ]) {
    const text = readFileSync(join("src", "routes", `${page}.tsx`), "utf8");
    assert.ok(text.includes("<PasswordInput"), `${page} has no PasswordInput`);
  }
});

test("the browser's own reveal eye is hidden", () => {
  const css = readFileSync(join("src", "styles.css"), "utf8");
  assert.ok(css.includes("input::-ms-reveal"), "styles.css must hide ::-ms-reveal");
});

test("the eye has Kannada labels", () => {
  const dictionary = readFileSync(join("src", "lib", "i18n-kn.ts"), "utf8");
  assert.ok(dictionary.includes('"Show password":'), "missing Kannada for Show password");
  assert.ok(dictionary.includes('"Hide password":'), "missing Kannada for Hide password");
});
