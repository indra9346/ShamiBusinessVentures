# Static preview

Use static preview mode to inspect the site without Supabase tables, email delivery, or a payment provider.

## Local

The Vite development server uses static preview data by default:

```powershell
npm run dev
```

Use OTP `123456` on the customer, vendor, and admin sign-in screens. Demo changes are saved only in that browser's local storage. To exercise Supabase locally, set `VITE_STATIC_DATA_MODE=false` in `.env` and configure the Supabase URL and publishable key for the intended project.

## Vercel Preview

Vercel Preview deployments automatically use static demo mode. Push this branch and open its Preview deployment. In static mode, sign-in is simulated, fixture data is used, and changes stay in browser storage; it must not be used to accept real orders or customer information. Production deployments always use Supabase mode.

## Supabase mode

When `VITE_STATIC_DATA_MODE` is false or unset in a production build, the app uses Supabase. The catalog migration must be applied to the same project as `VITE_SUPABASE_URL` before deploying the Supabase-connected app. Do not run `supabase db push` until the remote migration history and live schema have been reconciled; this repository's migration history may not match tables created manually in the dashboard.
