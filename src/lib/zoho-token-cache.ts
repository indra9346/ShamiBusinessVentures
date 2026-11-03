/*
 * Keeps one Zoho access token instead of asking for a new one on every call. Zoho allows 10 new
 * access tokens per refresh token in 10 minutes, then answers "Access Denied"; a token lasts an
 * hour, so a site needs about one an hour. Memory only: each server process keeps its own and a
 * restart asks again. Pure, so the node tests can load it.
 */

/** Ask for a new token this long before the old one ends, so a run that is under way can finish on it. */
export const ZOHO_TOKEN_RENEW_EARLY_MS = 10 * 60_000;
/** Zoho's docs give an hour, so a reply never counts for longer than that. */
export const ZOHO_TOKEN_MAX_LIFE_MS = 60 * 60_000;
/**
 * A 401 can mean a dead token or a permission the connection lacks, and only the first is cured by a
 * new token. A token this new isn't dead, so it stays, or a missing permission would cost one new
 * token per refused call and bring back the limit.
 */
export const ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS = 5 * 60_000;

/** What a person sees instead of Zoho's bare "Access Denied". */
export const ZOHO_TOKEN_LIMIT_MESSAGE =
  "Zoho has paused new connections from this site for a few minutes because too many were requested in a short time. Please try again in about 10 minutes.";

export type ZohoTokenReply = {
  access_token?: string;
  expires_in?: unknown;
  error?: string;
  error_description?: string;
};

/** Whether the token call's reply is Zoho's limit on new access tokens (its docs state no status code, so the words decide). */
export function isZohoTokenLimit(status: number, reply: ZohoTokenReply) {
  return (
    status === 429 ||
    /access[ _]denied|too many requests/i.test(
      `${reply.error ?? ""} ${reply.error_description ?? ""}`,
    )
  );
}

/** How long a reply's expires_in (seconds) can be relied on, in ms. 0 when it isn't usable, and then the token isn't kept. */
export function zohoTokenLifeMs(expiresIn: unknown) {
  const seconds =
    typeof expiresIn === "string" && !expiresIn.trim() ? NaN : Number(expiresIn ?? NaN);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, ZOHO_TOKEN_MAX_LIFE_MS)
    : 0;
}

export type ZohoTokenCache = {
  /**
   * The kept token if it belongs to `owner` and has time left, else a new one from `ask`. Calls that
   * arrive while `ask` is running share its answer. `owner` stands for the refresh token, so after a
   * Reauthorize the next call gets a token from the new connection.
   */
  get(owner: string, ask: () => Promise<{ token: string; expiresIn: unknown }>): Promise<string>;
  /** Zoho answered 401 to a call that used `token`. */
  refused(token: string): void;
};

export function createZohoTokenCache(now: () => number = () => Date.now()): ZohoTokenCache {
  let held: { owner: string; token: string; gotAt: number; renewAt: number } | null = null;
  let asking: { owner: string; answer: Promise<string> } | null = null;
  return {
    async get(owner, ask) {
      if (held?.owner === owner && now() < held.renewAt) return held.token;
      if (asking?.owner === owner) return asking.answer;
      const startedAt = now();
      const entry: NonNullable<typeof asking> = {
        owner,
        answer: ask()
          .then(({ token, expiresIn }) => {
            // A newer connection may have started asking meanwhile; this answer must not replace its token.
            if (asking === entry) {
              const life = zohoTokenLifeMs(expiresIn);
              held = life
                ? {
                    owner,
                    token,
                    gotAt: startedAt,
                    renewAt: startedAt + life - ZOHO_TOKEN_RENEW_EARLY_MS,
                  }
                : null;
            }
            return token;
          })
          .finally(() => {
            if (asking === entry) asking = null;
          }),
      };
      asking = entry;
      return entry.answer;
    },
    refused(token) {
      if (held?.token === token && now() - held.gotAt >= ZOHO_TOKEN_KEEP_AFTER_REFUSAL_MS)
        held = null;
    },
  };
}
