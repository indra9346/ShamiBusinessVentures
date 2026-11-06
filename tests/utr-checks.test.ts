import { test } from "node:test";
import assert from "node:assert/strict";
import { accountsInGroup, maskPhone, openUtrGroups, otherOrdersSharingUtr, UTR_SOURCE_LABEL, type UtrChecks, type UtrConflictGroup } from "../src/lib/utr-checks.ts";
import { kn } from "../src/lib/i18n-kn.ts";

const item = (source: UtrConflictGroup["items"][number]["source"], order_no: string | null, user_id: string | null, who: string, at: string) =>
  ({ source, order_no, user_id, who, phone: "9000012345", amount: 2484, state: "submitted", at, ref: "612345678901", detail: null });

const group = (key: string, items: UtrConflictGroup["items"], reviewed = false): UtrConflictGroup => ({
  key, records: items.length, orders: new Set(items.map((i) => i.order_no).filter(Boolean)).size,
  accounts: new Set(items.map((i) => i.user_id).filter(Boolean)).size, last_at: items[items.length - 1]!.at,
  severity: new Set(items.map((i) => i.user_id).filter(Boolean)).size >= 2 ? "high" : "medium", reviewed, review_note: null, reviewed_at: null, items,
});

const checks: UtrChecks = {
  groups: [
    group("612345678901", [
      item("utr_sent", "ORD-A", "user-a", "Asha", "2026-11-06T10:00:00Z"),
      item("tried", "ORD-B", "user-b", "Bala", "2026-11-06T10:05:00Z"),
      item("tried", "ORD-B", "user-b", "Bala", "2026-11-06T10:06:00Z"),
      item("bank_sms", "ORD-A", null, "asha@upi", "2026-11-06T10:01:00Z"),
    ]),
    group("612345678999", [item("utr_sent", "ORD-C", "user-c", "Chitra", "2026-11-05T09:00:00Z"), item("tried", "ORD-D", "user-c", "Chitra", "2026-11-05T09:10:00Z")], true),
  ],
  accounts: [], tries: [], since: "2026-08-08T00:00:00Z",
};

test("the badge in Payments to check names the other orders sharing the transfer", () => {
  assert.deepEqual(otherOrdersSharingUtr("ORD-A", checks), ["ORD-B"]);
  assert.deepEqual(otherOrdersSharingUtr("ORD-B", checks), ["ORD-A"]);
  assert.deepEqual(otherOrdersSharingUtr("ORD-Z", checks), []);
});

test("only groups nobody has looked at since the last record need someone", () => {
  assert.deepEqual(openUtrGroups(checks).map((g) => g.key), ["612345678901"]);
});

test("each account in a group is listed once, the busiest first, phone masked", () => {
  assert.deepEqual(accountsInGroup(checks.groups[0]!).map((a) => [a.who, a.records, a.phone]), [["Bala", 2, "••••2345"], ["Asha", 1, "••••2345"]]);
  assert.equal(maskPhone("98"), "");
  assert.equal(maskPhone(null), "");
});

test("every source label reads in Kannada", () => {
  for (const label of Object.values(UTR_SOURCE_LABEL)) assert.ok(kn[label], `missing Kannada for "${label}"`);
});
