# Production setup and readiness

This repository contains the Shami Business Ventures marketplace and its admin/vendor panels. This runbook records the production configuration that must be in place before enabling live traffic, and which functions currently rely on an external provider.

## Supabase project

The application connects with the Supabase project URL and publishable (formerly anon) key. Set these in the Vercel project environment for **Production**, **Preview**, and **Development** as appropriate:

```text
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
VITE_SUPABASE_PROJECT_ID=<project-ref>
VITE_STATIC_DATA_MODE=false
```

Never place a Supabase service-role key in a `VITE_*` variable or browser bundle. The publishable key is intentionally public; authorization is enforced with Supabase Auth, row-level security, and database functions.

Configure Supabase Auth **Site URL** and **Redirect URLs** for the production domain and any preview domains used for password recovery and auth links. Configure the Auth email template and a production SMTP sender. Email OTP and password reset email are sent through Supabase Auth; this application does not provide an SMTP relay.

Phone OTP needs a supported SMS provider configured in Supabase Auth (provider credentials, sender/number, and any required regional settings). Without it, customer phone login/verification cannot deliver codes. Test the real email and phone flows on the production domain; static preview OTPs are not real authentication.

The repository’s linked production database was checked on 2026-10-08. `npx supabase migration list` showed every local migration through `20261008300000` applied remotely. The catalog/category tables, operational tables, private `vendor-kyc` storage bucket, RLS policies, and application/KYC review functions are included by those migrations. For later schema changes, review the SQL and migration history, then apply via the normal reviewed deployment process. Do not mark a migration as applied unless its SQL effects are already present.

## Admin and vendor access

- Admin access requires a Supabase Auth account with the `admin` row in `public.user_roles` and a complete profile. Public admin registration is disabled. Provision the first administrator using the secured Supabase dashboard/SQL process already used by the project owner; never expose a service-role credential to the browser.
- Vendor access begins with a customer-authenticated application. An administrator reviews the application and required KYC files. Vendors must set a password for the approved account before using the vendor email/password login.
- Keep `vendor-kyc` private. Documents are read through short-lived signed URLs and are protected by RLS/storage policies. Do not make this bucket public.
- Admin inactivity timeout is configurable in System Settings (5–1,440 minutes) and signs the admin out of the browser session after inactivity, including across open admin tabs. Admin MFA and configurable password-strength policy are **not enforced by the app yet**. The inactivity timeout is a client-side session control; continue to use Supabase Auth and RLS as the security boundary.

## Payments and refunds

The current checkout records orders with payment pending. Admins can reconcile manually recorded payment amounts/UTRs through the payment review tools. It does not create a payment-gateway checkout session, verify gateway webhooks, automatically mark a payment successful, or issue refunds through a gateway. The UI calls out this limitation.

To enable online collection/refunds, select and onboard a payment provider (for example, Razorpay or Cashfree for Indian payment methods), then implement a server-side/Edge Function integration for order creation, signed webhook verification, idempotent payment ledger updates, refund requests, and reconciliation. Store secret keys only in Supabase Edge Function secrets or another server-side secret store. Configure provider webhook URLs and test success, failure, duplicate webhook, cancellation, partial refund, and full refund cases in the provider sandbox before production. Do not mark an order paid from a browser redirect alone.

Until that integration is deployed and verified, treat “Pending” as unpaid and use the existing manual reconciliation flow. COD behavior must follow the platform’s manual fulfillment/payment reconciliation process; it is not a gateway settlement.

## Email, SMS, WhatsApp, and notifications

- In-app notifications and Realtime inbox updates are database-backed.
- Customer email OTP/reset messages use the configured Supabase Auth SMTP provider.
- Marketing/order email outside Supabase Auth has no outbound delivery integration yet.
- SMS and WhatsApp delivery channels are not connected. Configure a supported SMS gateway and Meta WhatsApp Business Cloud API (approved business/number, templates where required, and credentials) before enabling delivery. Credentials belong in server-side Edge Function secrets, never in client settings or `VITE_*` variables.
- If outbound notifications are added, record delivery attempts/results, retry transient failures safely, and keep provider webhook signatures verified. Until then, use the in-app inbox and label external channels as unavailable.

## Deploy checklist

1. Set the production environment variables above and make sure `VITE_STATIC_DATA_MODE=false`; the Vite development default is static preview when the flag is omitted.
2. Set Supabase Auth site/redirect URLs, production email SMTP, and SMS provider settings if phone OTP is required.
3. Verify the production app points to the intended Supabase project and the migration history has no pending local migrations.
4. Build with `npm run build` and type-check with `npx tsc --noEmit --pretty false`.
5. In a production-like deployment, sign in separately as customer, admin, and approved vendor. Check role-gated routes, vendor application/review, KYC uploads/review, category/product image uploads, product approval, order creation/status transitions, manual payment reconciliation, inventory receipt, payout visibility, and Realtime dashboards/inboxes.
6. Configure payment and outbound notification providers before claiming those channels work. Run their sandbox and webhook tests before production enablement.
7. Deploy through the connected hosting project only after reviewing the production build and environment configuration. No deployment is performed by the repository build command.

## Verification evidence and limitations

On 2026-10-08, local TypeScript checking (`npx tsc --noEmit --pretty false`) and the production build (`npm run build`, including the Nitro Cloudflare module output) completed successfully. Targeted ESLint completed with zero errors and two existing Fast Refresh warnings in `src/lib/store.tsx`. The remote Supabase migration history matched all local migration versions through `20261008300000`.

These checks verify compilation and schema migration history; they do not prove every workflow by exercising live customer/admin/vendor sessions. A complete live acceptance pass still requires access to the deployed production URL and test identities for each role. Payment execution/refunds and outbound SMS/WhatsApp/email delivery remain provider-dependent as described above.
