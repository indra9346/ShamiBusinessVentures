import { test } from "node:test";
import assert from "node:assert/strict";
import { DIWALI_2026, festiveStatus, festiveThemeOn, isInFestiveWindow, parseFestiveSetting } from "../src/lib/festive-rules.ts";

const at = (iso: string) => Date.parse(iso);

test("festive theme: on through the Deepavali dates in India time, off before and after", () => {
  assert.equal(isInFestiveWindow(at("2026-10-29T18:29:59Z")), false); // 29 Oct 23:59 IST
  assert.equal(isInFestiveWindow(at("2026-10-29T18:30:00Z")), true); // 30 Oct 00:00 IST
  assert.equal(isInFestiveWindow(at("2026-11-08T13:00:00Z")), true); // Lakshmi Puja evening
  assert.equal(isInFestiveWindow(at("2026-11-15T18:29:59Z")), true); // 15 Nov 23:59 IST
  assert.equal(isInFestiveWindow(at("2026-11-15T18:30:00Z")), false); // 16 Nov 00:00 IST
  assert.equal(DIWALI_2026.theme, "diwali");
});

test("festive theme: the admin switch defaults to on and only an explicit false turns it off", () => {
  assert.deepEqual(parseFestiveSetting(null), { enabled: true });
  assert.deepEqual(parseFestiveSetting({}), { enabled: true });
  assert.deepEqual(parseFestiveSetting("off"), { enabled: true });
  assert.deepEqual(parseFestiveSetting([false]), { enabled: true });
  assert.deepEqual(parseFestiveSetting({ enabled: false }), { enabled: false });
  assert.deepEqual(parseFestiveSetting({ enabled: true }), { enabled: true });
});

test("festive theme: shows only when switched on and inside the dates", () => {
  const during = at("2026-11-01T06:00:00Z"), after = at("2026-11-20T06:00:00Z");
  assert.equal(festiveThemeOn({ enabled: true }, during), true);
  assert.equal(festiveThemeOn({ enabled: false }, during), false);
  assert.equal(festiveThemeOn({ enabled: true }, after), false);
});

test("festive theme: admin status line", () => {
  assert.equal(festiveStatus({ enabled: false }, at("2026-11-01T06:00:00Z")), "Switched off");
  assert.equal(festiveStatus({ enabled: true }, at("2026-11-01T06:00:00Z")), "Showing now");
  assert.equal(festiveStatus({ enabled: true }, at("2026-10-20T06:00:00Z")), "Starts 30 Oct");
  assert.equal(festiveStatus({ enabled: true }, at("2026-11-20T06:00:00Z")), "Ended 15 Nov");
});
