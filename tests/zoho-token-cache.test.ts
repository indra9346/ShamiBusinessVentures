import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS,
  ZOHO_TOKEN_LIMIT_MESSAGE,
  ZOHO_TOKEN_MAX_LIFE_MS,
  ZOHO_TOKEN_RENEW_EARLY_MS,
  createZohoTokenCache,
  isZohoTokenLimit,
  zohoTokenLifeMs,
} from "../src/lib/zoho-token-cache.ts";

const MINUTE = 60_000;

/** A cache on a clock the test moves, and a stand-in token call that counts and numbers its tokens. */
function rig(reply: { expiresIn: unknown } = { expiresIn: 3600 }) {
  let clock = 1_000_000;
  const cache = createZohoTokenCache(() => clock);
  const asked: string[] = [];
  const ask = (owner: string) => async () => {
    asked.push(owner);
    return { token: `${owner}-token-${asked.length}`, expiresIn: reply.expiresIn };
  };
  return {
    cache,
    asked,
    ask,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("many calls in a row make one token request", async () => {
  const { cache, asked, ask } = rig();
  const tokens = [];
  for (let i = 0; i < 50; i += 1) tokens.push(await cache.get("A", ask("A")));
  assert.equal(asked.length, 1);
  assert.deepEqual(new Set(tokens), new Set(["A-token-1"]));
});

test("calls at the same moment share one token request", async () => {
  const { cache, asked, ask } = rig();
  const tokens = await Promise.all(Array.from({ length: 20 }, () => cache.get("A", ask("A"))));
  assert.equal(asked.length, 1);
  assert.deepEqual(new Set(tokens), new Set(["A-token-1"]));
});

test("a token is kept until shortly before it expires, then replaced", async () => {
  const { cache, asked, ask, advance } = rig();
  await cache.get("A", ask("A"));
  advance(60 * MINUTE - ZOHO_TOKEN_RENEW_EARLY_MS - 1);
  assert.equal(await cache.get("A", ask("A")), "A-token-1", "still in time");
  advance(1);
  assert.equal(await cache.get("A", ask("A")), "A-token-2", "too close to the end");
  assert.equal(asked.length, 2);
  advance(60 * MINUTE - ZOHO_TOKEN_RENEW_EARLY_MS - 1);
  assert.equal(await cache.get("A", ask("A")), "A-token-2", "the new token gets its own full life");
});

test("a token already past its expiry is replaced", async () => {
  const { cache, ask, advance } = rig();
  await cache.get("A", ask("A"));
  advance(3 * 60 * MINUTE);
  assert.equal(await cache.get("A", ask("A")), "A-token-2");
});

test("the life is counted from before the request, so a slow reply can't overstate it", async () => {
  let clock = 0;
  const cache = createZohoTokenCache(() => clock);
  await cache.get("A", async () => {
    clock += 30 * MINUTE;
    return { token: "slow", expiresIn: 3600 };
  });
  clock = 60 * MINUTE - ZOHO_TOKEN_RENEW_EARLY_MS;
  assert.equal(await cache.get("A", async () => ({ token: "next", expiresIn: 3600 })), "next");
});

test("a changed refresh token is never served the old one", async () => {
  const { cache, asked, ask } = rig();
  await cache.get("A", ask("A"));
  assert.equal(await cache.get("B", ask("B")), "B-token-2");
  assert.equal(await cache.get("B", ask("B")), "B-token-2");
  assert.deepEqual(asked, ["A", "B"]);
});

test("a token request still running for the old connection neither answers nor overwrites the new one", async () => {
  const cache = createZohoTokenCache(() => 0);
  let finishOld!: (value: { token: string; expiresIn: unknown }) => void;
  const oldAnswer = cache.get(
    "OLD",
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const fresh = await cache.get("NEW", async () => ({ token: "new-token", expiresIn: 3600 }));
  assert.equal(fresh, "new-token");
  finishOld({ token: "old-token", expiresIn: 3600 });
  assert.equal(
    await oldAnswer,
    "old-token",
    "the caller who asked with the old connection gets its own answer",
  );
  assert.equal(
    await cache.get("NEW", async () => ({ token: "unexpected", expiresIn: 3600 })),
    "new-token",
  );
});

test("a failed request is not kept: its callers all get the error and the next call asks again", async () => {
  const { cache, asked, ask } = rig();
  let calls = 0;
  const refuse = async () => {
    calls += 1;
    throw new Error(ZOHO_TOKEN_LIMIT_MESSAGE);
  };
  const results = await Promise.allSettled([
    cache.get("A", refuse),
    cache.get("A", refuse),
    cache.get("A", refuse),
  ]);
  assert.equal(calls, 1);
  for (const result of results)
    assert.equal(result.status === "rejected" && result.reason.message, ZOHO_TOKEN_LIMIT_MESSAGE);
  assert.equal(await cache.get("A", ask("A")), "A-token-1");
  assert.equal(asked.length, 1);
});

test("a failed request for another connection doesn't touch the kept token", async () => {
  const { cache, ask } = rig();
  await cache.get("A", ask("A"));
  await assert.rejects(
    cache.get("B", async () => {
      throw new Error("no");
    }),
  );
  assert.equal(await cache.get("A", ask("A")), "A-token-1");
});

test("a reply with no usable expires_in is used once and not kept", async () => {
  for (const expiresIn of [undefined, null, 0, -5, "", "soon", NaN]) {
    const { cache, asked, ask } = rig({ expiresIn });
    await cache.get("A", ask("A"));
    await cache.get("A", ask("A"));
    assert.equal(asked.length, 2, String(expiresIn));
  }
});

test("expires_in: seconds are read, a string number works, and an hour is the most it counts for", () => {
  assert.equal(zohoTokenLifeMs(3600), ZOHO_TOKEN_MAX_LIFE_MS);
  assert.equal(zohoTokenLifeMs("3600"), ZOHO_TOKEN_MAX_LIFE_MS);
  assert.equal(zohoTokenLifeMs(1800), 30 * MINUTE);
  assert.equal(
    zohoTokenLifeMs(3_600_000),
    ZOHO_TOKEN_MAX_LIFE_MS,
    "a far longer life still counts as an hour",
  );
  for (const bad of [undefined, null, 0, -1, "", " ", "x", NaN, Infinity, {}])
    assert.equal(zohoTokenLifeMs(bad), 0, String(bad));
});

test("a life shorter than the renew margin is used but never served again", async () => {
  const { cache, asked, ask } = rig({ expiresIn: ZOHO_TOKEN_RENEW_EARLY_MS / 1000 });
  await cache.get("A", ask("A"));
  await cache.get("A", ask("A"));
  assert.equal(asked.length, 2);
});

test("a 401 drops the kept token, so the next call gets a new one instead of failing for up to an hour", async () => {
  const { cache, asked, ask, advance } = rig();
  const token = await cache.get("A", ask("A"));
  advance(ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS);
  cache.refused(token);
  assert.equal(await cache.get("A", ask("A")), "A-token-2");
  assert.equal(asked.length, 2);
});

test("a 401 on a token just issued keeps it, so a missing permission can't cost a token per call", async () => {
  const { cache, asked, ask, advance } = rig();
  const token = await cache.get("A", ask("A"));
  for (let i = 0; i < 30; i += 1) {
    cache.refused(token);
    await cache.get("A", ask("A"));
    advance(10_000);
  }
  assert.equal(asked.length, 1, "30 refusals in 5 minutes");
  // Worst case with a refusal on every call: one new token per keep-period, well inside 10 in 10 minutes.
  for (let i = 0; i < 600; i += 1) {
    cache.refused(await cache.get("A", ask("A")));
    advance(1000);
  }
  assert.ok(
    asked.length <= 1 + Math.ceil((10 * MINUTE) / ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS),
    `asked ${asked.length} times`,
  );
});

test("a 401 for some other token leaves the kept one alone", async () => {
  const { cache, asked, ask, advance } = rig();
  await cache.get("A", ask("A"));
  advance(ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS);
  cache.refused("an-older-token");
  cache.refused("");
  await cache.get("A", ask("A"));
  assert.equal(asked.length, 1);
});

test("Zoho's limit reply is recognised, other refusals are not", () => {
  // The reply as Zoho's Token Limits page shows it.
  assert.equal(
    isZohoTokenLimit(400, {
      error: "Access Denied",
      error_description:
        "You have made too many requests continuously. Please try again after some time.",
    }),
    true,
  );
  assert.equal(
    isZohoTokenLimit(200, { error: "Access Denied" }),
    true,
    "no status is documented, so the words decide",
  );
  assert.equal(
    isZohoTokenLimit(400, { error_description: "You have made too many requests continuously." }),
    true,
  );
  assert.equal(isZohoTokenLimit(429, {}), true);
  assert.equal(isZohoTokenLimit(400, { error: "invalid_code" }), false);
  assert.equal(isZohoTokenLimit(400, { error: "invalid_client" }), false);
  assert.equal(isZohoTokenLimit(500, {}), false);
  assert.equal(isZohoTokenLimit(200, { access_token: "x", expires_in: 3600 }), false);
});

test("the limit message doesn't send anyone to Reauthorize or into the daily-limit pause", () => {
  // zohoPermissionHint in zoho-commerce.functions.ts and isZohoDailyLimitError read error text.
  assert.doesNotMatch(
    ZOHO_TOKEN_LIMIT_MESSAGE,
    /not authori[sz]ed|invalid[_ ]?scope|oauth|permission/i,
  );
  assert.doesNotMatch(ZOHO_TOKEN_LIMIT_MESSAGE, /maximum call rate limit/i);
});
