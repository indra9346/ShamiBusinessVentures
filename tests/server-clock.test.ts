import { test } from "node:test";
import assert from "node:assert/strict";
import { clockOffset } from "../src/lib/server-clock.ts";

// The phone is 2.3 s behind the server; requests take 40 ms round trip.
const TRUE_OFFSET = 2300;
const sample = (sentAt: number, rtt = 40) => {
  const serverAt = sentAt + rtt / 2 + TRUE_OFFSET;
  return { sentAt, receivedAt: sentAt + rtt, serverDate: Math.floor(serverAt / 1000) * 1000 };
};

test("the moment the server's second ticks over pins the offset to within ~0.1 s", () => {
  const start = 1_000_000_000_000 + 450;
  const samples = Array.from({ length: 13 }, (_, i) => sample(start + i * 140));
  const offset = clockOffset(samples);
  assert.ok(Math.abs(offset - TRUE_OFFSET) <= 120, `offset ${offset}`);
});

test("without a tick-over, the half-second estimate is within 0.5 s", () => {
  const start = 1_000_000_000_000 + 100;
  const offset = clockOffset([sample(start), sample(start + 50), sample(start + 100)]);
  assert.ok(Math.abs(offset - TRUE_OFFSET) <= 500, `offset ${offset}`);
});

test("no usable samples: trust the device clock", () => {
  assert.equal(clockOffset([]), 0);
  assert.equal(clockOffset([{ sentAt: 1, receivedAt: 2, serverDate: Number.NaN }]), 0);
});
