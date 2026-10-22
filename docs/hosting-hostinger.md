# Hosting Grain Bazar on Hostinger (grainbazar.com)

Hand-over for the developer moving the site from Vercel (`shamibusinessventures.vercel.app`)
to Hostinger on the domain `grainbazar.com`. The database, sign-in and file storage stay on
Supabase (project `ppziinqjxqpxpmudinfd`); only the web server moves.

## 1. What the site needs

- **A Node.js server.** This is a TanStack Start app with server code (sign-in actions, admin
  actions, Zoho sync, Zoho webhook, OAuth callback). Use **Hostinger Node.js web app hosting or a
  VPS**. Shared or "website" hosting with only PHP or static files will not work.
- **Node 22** (tested with 22.19). Node 20 is the minimum.
- About 1 GB of RAM for `npm run build:node`. On a small plan, build locally or in CI and upload
  `.output/`.

## 2. Build and run

```bash
npm ci
npm run build:node        # Node server build -> .output/
npm start                 # node .output/server/index.mjs, listens on PORT (default 3000)
```

- `npm run build` (without `:node`) still builds for Vercel. Use `build:node` on Hostinger.
  The target is chosen by `NITRO_PRESET` in `vite.config.ts`.
- On a VPS, run it under a process manager and put Nginx in front for HTTPS, for example
  `pm2 start .output/server/index.mjs --name grainbazar`.
- `.output/` is self-contained. To deploy you only need `.output/` plus the environment variables.

## 3. Environment variables

Set these in Hostinger's environment settings (or a `.env` the process loads on the VPS). **Copy
the values from Vercel → Project → Settings → Environment Variables (Production).** Never commit
them. The owner sends the secret values privately, not in chat or email.

| Name | When | Notes |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | **build time** | Public. Already in the repo's `.env`. Must be present when `npm run build:node` runs. |
| `VITE_STATIC_DATA_MODE` | build time | Must be `false` (or unset) on the live site. `true` shows demo data. |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | server | Same Supabase project. |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **Secret.** Full database access. Server only. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | server | **Secret** (client secret). Zoho API Console app. |
| `ZOHO_REDIRECT_URI` | server | `https://grainbazar.com/api/zoho/callback` once the domain is live (see step 5). |
| `ZOHO_OAUTH_STATE_SECRET` | server | **Secret.** Copy from Vercel. |
| `ZOHO_TOKEN_ENCRYPTION_KEY` | server | **Secret. Copy exactly from Vercel.** It decrypts the saved Zoho login. A new value means Zoho must be reconnected. |
| `ZOHO_WEBHOOK_SECRET` | server | **Secret. Copy exactly from Vercel.** It must match the secret in the Zoho Books webhook. |
| `CRON_SECRET` | server | **Secret.** Used by the scheduled sync call (step 4). |
| `ZOHO_WRITE_SYNC_ENABLED` | server | Leave **unset** (the admin switch in Admin → Zoho decides). `false` stops all website → Zoho sync. |
| `PORT` | server | Only if Hostinger needs a specific port. |

## 4. Scheduled Zoho sync (replaces `vercel.json`)

`vercel.json` crons do nothing outside Vercel. Add a cron job on Hostinger (hPanel → Advanced →
Cron Jobs, or `crontab -e` on a VPS) that runs **every 15 minutes**:

```bash
curl -fsS -H "Authorization: Bearer YOUR_CRON_SECRET" https://grainbazar.com/api/zoho/sync
```

- Use the real `CRON_SECRET` value. This runs **on the Hostinger server**, not in Windows
  PowerShell (there `curl` is a different command).
- A 401 means the secret doesn't match. A JSON result with `processed` and `inboundCatalog` means
  it works.
- Once Hostinger is live and tested, **remove the Vercel cron** (or the Vercel project), so Zoho
  isn't synced from two places.

## 5. Domain and switch-over (in this order)

1. **Hostinger:** point `grainbazar.com` and `www.grainbazar.com` to the Hostinger site and turn on
   SSL. Open `https://grainbazar.com` and check the shop loads products.
2. **Supabase** → Authentication → URL Configuration: set Site URL `https://grainbazar.com`, and
   add `https://grainbazar.com/**` and `https://www.grainbazar.com/**` to Redirect URLs. Without
   this, email and OTP sign-in links go to the old address.
3. **Zoho API Console** (api-console.zoho.in) → the Grain Bazar app → add the redirect URI
   `https://grainbazar.com/api/zoho/callback`. Set the same value in `ZOHO_REDIRECT_URI` and restart.
   Then the owner signs in as admin → **Admin → Zoho → Reauthorize Zoho** once.
4. **Zoho Books** → Settings → Automation → Webhooks: change "Grain Bazar order sync" (and the
   Items webhook, step 6) to `https://grainbazar.com/api/zoho/webhook`, keeping the same secret.
5. **Test:** sign in with a phone/email code, place a small test order and check that
   `GB-ORD-…` appears in Zoho, then cancel it. Check Admin → Zoho shows no failed jobs, and run
   Admin → Zoho diagnostics (order and product reconciliation).
6. Keep `shamibusinessventures.vercel.app` until all of the above passes. Then remove its cron
   and redirect it.

## 6. Pending database and Zoho changes (owner approval needed)

The Supabase database is already live. **Do not create a new database or re-run old migrations.**
Only apply new migrations, one at a time, with the owner's approval (Supabase SQL editor or
`supabase db push` after `supabase migration list` shows what is pending):

- `20261022120000_zoho_item_hsn_mrp_two_way.sql`: Step 1, two-way HSN/MRP product sync. Only
  Shami's own products (`VENDOR-001`) sync with Zoho items.
- A separate fix for signed-out reads of settings/branches/reviews is being prepared
  (`20261022100000_anon_public_read_without_role_helpers.sql`). Apply it when it lands in the repo.

For instant Zoho → website product updates, add a **Zoho Books workflow rule**: module **Items**,
when **Created or Edited**, action **Webhook** to `/api/zoho/webhook` with the same secret as the
order webhook. Details: `docs/zoho-system-of-record.md` section 9.

## 7. Don'ts

- Don't force-push or rewrite history on `main`. The repo is connected to Lovable.
- Don't put `SUPABASE_SERVICE_ROLE_KEY` or any `ZOHO_*` secret in a `VITE_` variable or in the repo.
- Don't change `ZOHO_TOKEN_ENCRYPTION_KEY` or `ZOHO_WEBHOOK_SECRET` without reconnecting Zoho or
  updating the Zoho webhook.
