// Hostinger cron job (every 15 minutes): runs the website's Zoho sync.
// hPanel → Advanced → Cron Jobs runs it as
//   node --env-file=<app>/config/.env <app>/scripts/zoho-sync-cron.mjs
// so CRON_SECRET comes from the app's environment variables and is never typed into the cron.
const site = (process.env.SITE_URL || "https://grainbazar.com").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error(`${new Date().toISOString()} CRON_SECRET is not set in the app's environment variables`);
  process.exit(1);
}

try {
  const response = await fetch(`${site}/api/zoho/sync`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(240_000),
  });
  const body = await response.text();
  console.log(`${new Date().toISOString()} ${response.status} ${body.slice(0, 2000)}`);
  if (!response.ok) process.exit(1);
} catch (cause) {
  console.error(`${new Date().toISOString()} Zoho sync request failed: ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
}
