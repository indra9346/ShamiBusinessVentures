import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kn } from "../src/lib/i18n-kn.ts";

// 12 Nov 2026, the owner's screenshot: Attendance > Add employee showed an empty Godown list, so no employee (and no
// godown in-charge) could be added. One failed request used to stop the whole page silently.

const page = readFileSync("src/components/attendance/AttendanceManager.tsx", "utf8");

test("every attendance request settles on its own", () => {
  const block = page.slice(page.indexOf("const [b, e, p, t, tp, m, l, dv, rv, hd] = await Promise.all(["), page.indexOf("const failed = [b, e, t, tp, m, l, rv, hd]"));
  const requests = block.split("\n").filter((line) => /^\s+settle\(/.test(line));
  assert.equal(requests.length, 10, "all ten lists are wrapped");
  assert.match(page, /\(cause: unknown\) => \(\{ data: null, error: \{ message: cause instanceof Error \? cause\.message : "The connection dropped" \} \}\)/);
});

test("the page reloads when the sign-in is renewed, and says when it has expired", () => {
  assert.match(page, /supabase\.auth\.onAuthStateChange\(\(event\) => \{\s*if \(event === "SIGNED_IN" \|\| event === "TOKEN_REFRESHED"\) void load\(\);/);
  assert.match(page, /auth\.subscription\.unsubscribe\(\)/);
  assert.match(page, /Your sign-in has expired on this device\. Sign out and sign in again, then open Attendance\./);
});

test("no empty godown list: the form says why and offers Reload", () => {
  const form = page.slice(page.indexOf("function AddEmployeeForm"), page.indexOf("function GodownDevices"));
  assert.match(form, /\{godowns\.length \? \(\s*<select/);
  assert.match(form, /The godowns did not load\. Press Reload\. If they still don't show, sign out and sign in again\./);
  assert.match(form, /onClick=\{\(\) => void onAdded\(\)\}[^>]*>Reload</);
});

test("the admin can set or reset an employee's password from the list", () => {
  assert.match(page, /\{employee\.login_email \? "Reset password" : "Set password"\}/);
  assert.match(page, /await setStaffPassword\(\{ data: \{ employeeId: employee\.id, password \} \}\);/);
});

test("the new lines read in Kannada", () => {
  for (const key of [
    "The godowns did not load. Press Reload. If they still don't show, sign out and sign in again.",
    "Reload",
    "Your sign-in has expired on this device. Sign out and sign in again, then open Attendance.",
    "Some attendance data did not load ({0}). It tries again every minute; check the connection.",
  ]) assert.ok(kn[key], key);
});
