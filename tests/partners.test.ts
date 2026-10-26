import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commissionAmount, commissionStatus, describeRate, monthLabel, monthStart, partnerPasswordProblem,
  suggestPartnerPassword, targetProgress,
} from "../src/lib/partners.ts";

test("commission: rupees per unit, or % of the line excluding GST, to the paisa", () => {
  assert.equal(commissionAmount("per_unit", 2.5, 10, 15000), 25); // rice Rs 2.50 x 10 bags
  assert.equal(commissionAmount("percent", 1, 2, 5234.26), 52.34);
  assert.equal(commissionAmount("percent", 1.5, 1, 2617.13), 39.26);
  assert.equal(commissionAmount("per_unit", 0, 5, 1000), 0);
});

test("commission status follows the order: earned only when delivered and fully paid", () => {
  assert.equal(commissionStatus("Placed", "Pending"), "pending");
  assert.equal(commissionStatus("Delivered", "Pending"), "pending");
  assert.equal(commissionStatus("Delivered", "Partially Paid"), "pending");
  assert.equal(commissionStatus("Delivered", "Paid"), "earned");
  assert.equal(commissionStatus("Cancelled", "Paid"), "cancelled");
});

test("rates read clearly", () => {
  assert.equal(describeRate("per_unit", 2.5), "₹2.50 per unit");
  assert.equal(describeRate("per_unit", 5), "₹5 per unit");
  assert.equal(describeRate("percent", 1.5), "1.5% of price");
});

test("target progress", () => {
  assert.equal(targetProgress(23234.26, 40000), 58.1);
  assert.equal(targetProgress(50000, 40000), 125);
  assert.equal(targetProgress(100, 0), null);
});

test("months are India months", () => {
  assert.equal(monthStart(new Date("2026-10-31T19:00:00Z")), "2026-11-01"); // 00:30 IST on 1 Nov
  assert.equal(monthStart(new Date("2026-10-26T10:00:00Z")), "2026-10-01");
  assert.equal(monthLabel("2026-10-01"), "October 2026");
});

test("partner passwords: at least 8 characters with letters and a number", () => {
  assert.equal(partnerPasswordProblem("short1"), "Use at least 8 characters");
  assert.equal(partnerPasswordProblem("onlyletters"), "Use letters and at least one number");
  assert.equal(partnerPasswordProblem("Hubli-Partner-2026"), null);
  let seed = 0.123;
  const random = () => (seed = (seed * 9301 + 49297) % 233280 / 233280);
  for (let i = 0; i < 50; i += 1) {
    const suggested = suggestPartnerPassword(random);
    assert.match(suggested, /^[A-HJ-NP-Za-hj-kmnp-z]{8}-[2-9]{3}$/);
    assert.equal(partnerPasswordProblem(suggested), null);
  }
});
