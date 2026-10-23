// Builds the app as a plain Node server (.output/server/index.mjs) for hosts other than Vercel,
// such as Hostinger Node.js hosting or a VPS. Works the same on Windows, macOS and Linux.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vite", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NITRO_PRESET: "node-server" },
});
if (result.status === 0) await import("./copy-cron-to-output.mjs");
process.exit(result.status ?? 1);
