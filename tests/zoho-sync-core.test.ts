import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileOrders,
  shouldRetryZohoCall,
  webhookKeyMatches,
  zohoLogLine,
  zohoOrderNumber,
  zohoRetryDelayMs,
  verifyZohoSignature,
  type GbOrderForReconcile,
} from "../src/lib/zoho-sync-core.ts";
import { createHmac } from "node:crypto";

test("order number is stable and Zoho-safe (idempotency key)", () => {
  assert.equal(zohoOrderNumber("SBV-1001"), "GB-SBV-1001");
  assert.equal(zohoOrderNumber("SBV-1001"), zohoOrderNumber("SBV-1001"));
  assert.equal(zohoOrderNumber("A/B 7"), "GB-A-B-7");
  assert.equal(zohoOrderNumber("x".repeat(60)).length, 3 + 40);
});

test("retry policy: 429 always, 5xx/network only for safe methods, never 4xx", () => {
  assert.equal(shouldRetryZohoCall("POST", 429), true);
  assert.equal(shouldRetryZohoCall("POST", 500), false);
  assert.equal(shouldRetryZohoCall("POST", "network"), false);
  assert.equal(shouldRetryZohoCall("GET", 503), true);
  assert.equal(shouldRetryZohoCall("PUT", "network"), true);
  assert.equal(shouldRetryZohoCall("GET", 400), false);
  assert.equal(shouldRetryZohoCall("GET", 401), false);
});

test("backoff: exponential, honours Retry-After, capped", () => {
  assert.equal(zohoRetryDelayMs(1, null), 1000);
  assert.equal(zohoRetryDelayMs(2, null), 2000);
  assert.equal(zohoRetryDelayMs(3, null), 4000);
  assert.equal(zohoRetryDelayMs(10, null), 10_000);
  assert.equal(zohoRetryDelayMs(1, "3"), 3000);
  assert.equal(zohoRetryDelayMs(1, "120"), 10_000);
  assert.equal(zohoRetryDelayMs(2, "not-a-number"), 2000);
});

test("webhook key: exact match only", () => {
  assert.equal(webhookKeyMatches("abc123", "abc123"), true);
  assert.equal(webhookKeyMatches("abc124", "abc123"), false);
  assert.equal(webhookKeyMatches("abc12", "abc123"), false);
  assert.equal(webhookKeyMatches(null, "abc123"), false);
  assert.equal(webhookKeyMatches("", ""), false);
});

const gb = (order_no: string, extra: Partial<GbOrderForReconcile> = {}): GbOrderForReconcile => ({
  order_no, order_status: "Placed", total: 500, zoho_salesorder_id: null, created_at: "2026-10-16T10:00:00Z", ...extra,
});
const zo = (n: string, id: string, extra: Partial<{ status: string; total: number }> = {}) => ({
  salesorder_id: id, salesorder_number: `GB-${n}`, status: "confirmed", total: 500, ...extra,
});

test("reconcile: classifies every case", () => {
  const report = reconcileOrders(
    [
      gb("1", { zoho_salesorder_id: "z1" }), // in sync
      gb("2"), // not pushed
      gb("3", { zoho_salesorder_id: "z3" }), // linked but not returned
      gb("4", { zoho_salesorder_id: "zOLD" }), // link mismatch
      gb("5", { zoho_salesorder_id: "z5" }), // total differs
      gb("6", { zoho_salesorder_id: "z6", order_status: "Cancelled" }), // cancelled in GB only
      gb("7"), // in Zoho but not linked
      gb("8", { zoho_salesorder_id: "z8a" }), // duplicate in Zoho
      gb("9", { zoho_salesorder_id: "z9", total: 501.5 }), // within ₹2 tolerance
    ],
    [
      zo("1", "z1"), zo("4", "z4"), zo("5", "z5", { total: 650 }), zo("6", "z6"),
      zo("7", "z7"), zo("8", "z8a"), zo("8", "z8b"), zo("9", "z9"), zo("99", "z99"),
      { salesorder_id: "x", salesorder_number: "SO-00012", status: "confirmed", total: 1 }, // not Grain Bazar: ignored
    ],
  );
  const issue = (no: string) => report.issues.find((row) => row.orderNo === no)?.issue;
  assert.equal(report.checked, 9);
  assert.equal(report.inSync, 2);
  assert.equal(issue("1"), undefined);
  assert.equal(issue("2"), "missing_in_zoho");
  assert.equal(issue("3"), "linked_but_not_listed");
  assert.equal(issue("4"), "link_mismatch");
  assert.equal(issue("5"), "total_mismatch");
  assert.equal(issue("6"), "status_mismatch");
  assert.equal(issue("7"), "missing_in_zoho");
  assert.equal(issue("8"), "duplicate_in_zoho");
  assert.equal(issue("9"), undefined);
  assert.equal(issue("GB-99"), "zoho_without_grain_bazar_order");
  assert.equal(report.issues.some((row) => row.orderNo.includes("SO-")), false);
});

test("reconcile: voided in Zoho and cancelled in Grain Bazar is in sync, totals ignored", () => {
  const report = reconcileOrders(
    [gb("1", { zoho_salesorder_id: "z1", order_status: "Cancelled", total: 0 })],
    [zo("1", "z1", { status: "void", total: 500 })],
  );
  assert.deepEqual(report.issues, []);
  assert.equal(report.inSync, 1);
});

test("log line: JSON, truncated strings, undefined dropped", () => {
  const line = JSON.parse(zohoLogLine("outbox_job_finished", { job: "j1", error: "e".repeat(500), skipped: undefined, attempt: 2 }));
  assert.equal(line.source, "zoho-sync");
  assert.equal(line.event, "outbox_job_finished");
  assert.equal(line.error.length, 300);
  assert.equal("skipped" in line, false);
  assert.equal(line.attempt, 2);
});

test("Zoho signature: HMAC-SHA256 of the raw body, hex or base64; wrong secret/body/missing rejected", async () => {
  const body = '{"salesorder":{"salesorder_id":"123"}}';
  const secret = "test-secret-not-real";
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  const base64 = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(await verifyZohoSignature(body, hex, secret), "hex");
  assert.equal(await verifyZohoSignature(body, hex.toUpperCase(), secret), "hex");
  assert.equal(await verifyZohoSignature(body, base64, secret), "base64");
  assert.equal(await verifyZohoSignature(body, hex, "other-secret"), null);
  assert.equal(await verifyZohoSignature(body + " ", hex, secret), null);
  assert.equal(await verifyZohoSignature(body, null, secret), null);
  assert.equal(await verifyZohoSignature(body, hex, ""), null);
});

test("item sync seller scope: empty list keeps everyone, otherwise only listed sellers", async () => {
  const { zohoItemSyncAllows, parseZohoItemSyncVendorIds } = await import("../src/lib/zoho-sync-core.ts");
  assert.equal(zohoItemSyncAllows([], "VENDOR-007"), true);
  assert.equal(zohoItemSyncAllows(["VENDOR-001"], "VENDOR-001"), true);
  assert.equal(zohoItemSyncAllows(["VENDOR-001"], "VENDOR-007"), false);
  assert.deepEqual(parseZohoItemSyncVendorIds([" VENDOR-001 ", "VENDOR-001", 7, "", null]), ["VENDOR-001"]);
  assert.deepEqual(parseZohoItemSyncVendorIds({ vendor: "VENDOR-001" }), []);
  assert.deepEqual(parseZohoItemSyncVendorIds(null), []);
});

test("Zoho API budget: hourly re-check, pause after the daily limit", async () => {
  const { inboundPollDue, isZohoDailyLimitError, zohoPaused } = await import("../src/lib/zoho-sync-core.ts");
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(inboundPollDue(null, now), true);
  assert.equal(inboundPollDue("2026-10-26T11:45:00Z", now), false); // 15 min ago: skip
  assert.equal(inboundPollDue("2026-10-26T11:00:10Z", now), true); // ~an hour ago: due
  assert.equal(isZohoDailyLimitError("The API call for this organization has exceeded the maximum call rate limit of 5,000"), true);
  assert.equal(isZohoDailyLimitError("Selling Price cannot be greater than MRP"), false);
  assert.equal(zohoPaused("2026-10-26T12:30:00Z", now), true);
  assert.equal(zohoPaused("2026-10-26T11:30:00Z", now), false);
  assert.equal(zohoPaused(undefined, now), false);
});
