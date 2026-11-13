// Hostinger cron job (every 15 minutes): runs the website's Zoho sync.
// hPanel → Advanced → Cron Jobs runs it as
//   node --env-file=<app>/config/.env <app>/scripts/zoho-sync-cron.mjs
// so CRON_SECRET comes from the app's environment variables and is never typed into the cron.
//
// 13 Nov 2026: from 11 Nov ~13:15 IST every run printed "Zoho sync request failed: fetch failed" and nothing synced
// (no Zoho stock, no Zoho webhooks, no hourly check) for two days. Hostinger's CDN for grainbazar.com was switched
// off on 10 Nov, so grainbazar.com now points at this same server, and the server's call to its own public address
// fails. The job now tries, in order, until the website itself answers:
//   1. the public address (SITE_URL), as before;
//   2. this server's own web server (127.0.0.1, then ::1) under the site's name, so the certificate is still checked;
//   3. the app's own socket from LiteSpeed (/usr/local/lsws/extapp-sock/<domain>:_.sock).
// A route is left for the next one only when the website cannot have run the sync on it: no connection, a quick page
// that is not the website's, or a connection dropped within 5 s with no reply. Anything slower stops the job, so the
// sync never runs twice. Each route that fails prints one line with its reason, so the cron output shows what happened.
import http from "node:http";
import https from "node:https";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const site = new URL((process.env.SITE_URL || "https://grainbazar.com").replace(/\/+$/, ""));
const secret = process.env.CRON_SECRET;
const PATH = "/api/zoho/sync";
const SOCKET_DIR = process.env.CRON_SOCKET_DIR || "/usr/local/lsws/extapp-sock";
const CONNECT_MS = Number(process.env.CRON_CONNECT_MS) || 15_000;
const TOTAL_MS = 240_000;
const now = () => new Date().toISOString();

if (!secret) {
  console.error(`${now()} CRON_SECRET is not set in the app's environment variables`);
  process.exit(1);
}

const secure = site.protocol === "https:";
const port = Number(site.port) || (secure ? 443 : 80);

/** LiteSpeed's sockets for this site's app: grainbazar.com:_.sock first, then www. */
function appSockets() {
  try {
    const names = readdirSync(SOCKET_DIR).filter((name) => name.endsWith(".sock"));
    const bare = site.hostname.replace(/^www\./, "");
    return [`${bare}:`, `www.${bare}:`].flatMap((prefix) => names.filter((name) => name.startsWith(prefix))).map((name) => join(SOCKET_DIR, name));
  } catch {
    return [];
  }
}

const web = secure ? https : http;
const routes = [
  { name: "public address", lib: web, options: { host: site.hostname, port, servername: site.hostname } },
  { name: "this server (127.0.0.1)", lib: web, options: { host: "127.0.0.1", port, servername: site.hostname } },
  { name: "this server (::1)", lib: web, options: { host: "::1", port, servername: site.hostname } },
  ...appSockets().map((socketPath) => ({ name: `app socket ${socketPath}`, lib: http, options: { socketPath } })),
];

function describe(cause) {
  if (!(cause instanceof Error)) return String(cause);
  const code = /** @type {{ code?: string }} */ (cause).code;
  return code && !cause.message.includes(code) ? `${code} ${cause.message}` : cause.message;
}

/**
 * One try. { sent: false, reason } = it never connected, so nothing reached the website and the next route is safe.
 * { sent: true, status, type, body } = the answer; { sent: true, reason, answered } = it failed after the request
 * went out (answered: whether any reply had started).
 */
function attempt(route) {
  return new Promise((resolve) => {
    let connected = false;
    let answered = false;
    let settled = false;
    let connectTimer;
    let totalTimer;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      resolve(value);
    };
    const request = route.lib.request({
      ...route.options,
      path: PATH,
      method: "GET",
      agent: false,
      headers: { Authorization: `Bearer ${secret}`, Host: site.host, "User-Agent": "grainbazar-zoho-cron" },
    }, (response) => {
      answered = true;
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (body.length < 20_000) body += chunk; });
      response.on("end", () => done({ sent: true, status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), body }));
      response.on("error", (cause) => done({ sent: true, answered: true, reason: describe(cause) }));
    });
    connectTimer = setTimeout(() => {
      if (connected) return;
      request.destroy();
      done({ sent: false, reason: `no connection in ${CONNECT_MS / 1000} s` });
    }, CONNECT_MS);
    totalTimer = setTimeout(() => {
      request.destroy();
      done({ sent: connected, answered, reason: `no answer in ${TOTAL_MS / 1000} s` });
    }, TOTAL_MS);
    request.on("socket", (socket) => {
      socket.once(web === https && !route.options.socketPath ? "secureConnect" : "connect", () => { connected = true; });
    });
    request.on("error", (cause) => done({ sent: connected, answered, reason: describe(cause) }));
    request.end();
  });
}

/** The sync answers JSON (a wrong secret too: 401 JSON); a bot check or a proxy error page is HTML. */
const fromTheWebsite = (result) => result.type.includes("application/json");

/** A page that is not the website's but came slowly (a proxy timeout) may sit in front of a sync that did run. */
const QUICK_MS = 20_000;
/**
 * A connection the server dropped this quickly, before any reply, was refused in front of the website (the web
 * server or its bot check): the website answers only when the sync is done, which takes longer than this.
 */
const DROPPED_MS = 5_000;

let tried = 0;
for (const route of routes) {
  tried += 1;
  const started = Date.now();
  const result = await attempt(route);
  if (!result.sent) {
    console.error(`${now()} ${route.name}: could not connect (${result.reason})`);
    continue;
  }
  if (result.reason) {
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (!result.answered && Date.now() - started < DROPPED_MS) {
      // Dropped at once with no reply: refused before the website, so the sync did not run there.
      console.error(`${now()} ${route.name}: dropped after ${seconds} s with no reply (${result.reason})`);
      continue;
    }
    // The request went out and may have reached the website: another route could run the sync twice, so stop here.
    console.error(`${now()} ${route.name}: Zoho sync request failed after it was sent (${result.reason}, ${seconds} s)`);
    process.exit(1);
  }
  if (!fromTheWebsite(result)) {
    const page = `${result.status}, not from the website (${result.type || "no type"}): ${result.body.replace(/\s+/g, " ").slice(0, 160)}`;
    if (Date.now() - started > QUICK_MS) {
      console.error(`${now()} ${route.name}: answered ${page} after ${Math.round((Date.now() - started) / 1000)} s; the sync may have run, so no other route is tried`);
      process.exit(1);
    }
    // A quick page that is not the website's (bot check, proxy error): the sync did not run, so the next route may reach it.
    console.error(`${now()} ${route.name}: answered ${page}`);
    continue;
  }
  console.log(`${now()} ${route.name}: ${result.status} ${result.body.slice(0, 2000)}`);
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}
console.error(`${now()} Zoho sync request failed: no route reached the website (${tried} tried)`);
process.exit(1);
