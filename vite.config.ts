// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Server build target. On Vercel (which sets VERCEL=1 during builds) "vercel" emits API routes such
  // as the OAuth callback and the sync worker as Vercel functions. Everywhere else a plain Node server
  // is built to .output/ (Hostinger Node.js hosting or a VPS; see docs/hosting-hostinger.md), so a
  // host's default `npm run build` finds its output. NITRO_PRESET overrides both.
  nitro: {
    preset: process.env["NITRO_PRESET"] || (process.env["VERCEL"] ? "vercel" : "node-server"),
  },
  vite: {
    // Vercel preview deployments are static UI sandboxes; production remains
    // Supabase-backed unless explicitly configured in local development.
    define: {
      "import.meta.env.VERCEL_ENV": JSON.stringify(process.env["VERCEL_ENV"] ?? ""),
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
