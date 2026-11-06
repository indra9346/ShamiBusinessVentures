import { test } from "node:test";
import assert from "node:assert/strict";
import { MATCH_WINDOW_HOURS, suggestPaymentsForCredit } from "../src/lib/bank-credit-match.ts";

// IDFC FIRST's credit of Rs 2,484 at 14:21 on 6 Nov 2026 (no UTR in its SMS) and UTRs customers sent.
const credit = { amount: 2484, creditedAt: "2026-11-06T14:21:00+05:30", receivedAt: "2026-11-06T08:52:00.000Z" };
const payment = (orderNo: string, amount: number, submittedAt: string, status = "submitted") => ({ orderNo, amount, utr: `6${orderNo.slice(-11).padStart(11, "0")}`, status, submittedAt });

test("only UTRs waiting for a check, for exactly the credited amount, are suggested", () => {
  const rows = [
    payment("ORD-A", 2484, "2026-11-06T14:23:00+05:30"),
    payment("ORD-B", 2484.01, "2026-11-06T14:22:00+05:30"),
    payment("ORD-C", 2484, "2026-11-06T14:20:00+05:30", "confirmed"),
    payment("ORD-D", 2484, "2026-11-06T14:24:00+05:30", "rejected"),
  ];
  assert.deepEqual(suggestPaymentsForCredit(credit, rows).map((row) => row.orderNo), ["ORD-A"]);
});

test("the closest in time comes first, and nothing beyond a day either side", () => {
  const rows = [
    payment("ORD-LATE", 2484, "2026-11-06T20:00:00+05:30"),
    payment("ORD-NEAR", 2484, "2026-11-06T14:30:00+05:30"),
    payment("ORD-BEFORE", 2484, "2026-11-06T13:00:00+05:30"),
    payment("ORD-OLD", 2484, "2026-11-05T14:20:00+05:30"),
    payment("ORD-NEXT-DAY", 2484, "2026-11-07T14:22:00+05:30"),
  ];
  assert.equal(MATCH_WINDOW_HOURS, 24);
  assert.deepEqual(suggestPaymentsForCredit(credit, rows).map((row) => row.orderNo), ["ORD-NEAR", "ORD-BEFORE", "ORD-LATE"]);
});

test("without the bank's time the moment the SMS arrived is used", () => {
  const noTime = { ...credit, creditedAt: null };
  assert.deepEqual(suggestPaymentsForCredit(noTime, [payment("ORD-A", 2484, "2026-11-06T14:25:00+05:30")]).map((row) => row.orderNo), ["ORD-A"]);
  assert.deepEqual(suggestPaymentsForCredit({ ...noTime, receivedAt: "not a time" }, [payment("ORD-A", 2484, "2026-11-06T14:25:00+05:30")]), []);
});

test("paise count: Rs 2,484.00 and Rs 2,484.5 are different money", () => {
  const rows = [payment("ORD-A", 2484.5, "2026-11-06T14:23:00+05:30")];
  assert.deepEqual(suggestPaymentsForCredit(credit, rows), []);
  assert.deepEqual(suggestPaymentsForCredit({ ...credit, amount: 2484.5 }, rows).map((row) => row.orderNo), ["ORD-A"]);
});
