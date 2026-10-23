// Hostinger deploys only the build output (.output/) into the app folder, so the cron script must be
// part of it: after the build, copy scripts/zoho-sync-cron.mjs to .output/scripts/. On Vercel there is
// no .output/ and nothing is copied.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

if (existsSync(".output/server")) {
  mkdirSync(".output/scripts", { recursive: true });
  copyFileSync("scripts/zoho-sync-cron.mjs", ".output/scripts/zoho-sync-cron.mjs");
  console.log("Copied scripts/zoho-sync-cron.mjs to .output/scripts/ for the Hostinger cron job");
}
