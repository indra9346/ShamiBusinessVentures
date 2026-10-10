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

A later migration-history check returned HTTP 403 for the current Supabase CLI account. The remote status of migrations added after `20261008300000` (including the Zoho and live-notification migrations through `20261010170000`) is unverified. Have a project owner check `npx supabase migration list` and apply any pending migrations before enabling those features.

## Admin and vendor access

- Admin access requires a Supabase Auth account with the `admin` row in `public.user_roles` and a complete profile. Public admin registration is disabled. Provision the first administrator using the secured Supabase dashboard/SQL process already used by the project owner; never expose a service-role credential to the browser.
- Vendor access begins with a customer-authenticated application. An administrator reviews the application and required KYC files. Vendors must set a password for the approved account before using the vendor email/password login.
- Keep `vendor-kyc` private. Documents are read through short-lived signed URLs and are protected by RLS/storage policies. Do not make this bucket public.
- Admin inactivity timeout is configurable in System Settings (5–1,440 minutes) and signs the admin out of the browser session after inactivity, including across open admin tabs. Admin MFA and configurable password-strength policy are **not enforced by the app yet**. The inactivity timeout is a client-side session control; continue to use Supabase Auth and RLS as the security boundary.

## Zoho Commerce read-only integration

The admin-only Zoho Commerce connector at `/admin/zoho` uses Zoho OAuth authorization; staff must never enter a Zoho username or password into this app. Register a Zoho server-based OAuth client and set its exact redirect URI to `https://<production-domain>/api/zoho/callback` (plus development/preview callback URIs when needed). Configure server-side `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_OAUTH_STATE_SECRET`, and `ZOHO_TOKEN_ENCRYPTION_KEY`. The state secret must be long and random; the encryption key must be a base64 encoding of 32 random bytes. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` must also exist in the server runtime; the service-role key must remain server-only. Never use a `VITE_` prefix for OAuth or encryption secrets. Apply migration `20261010100000_zoho_commerce_integration.sql` before connecting.

The administrator enters the Zoho Commerce organization ID and data center, then authorizes only these read scopes: `ZohoCommerce.items.READ`, `ZohoCommerce.coupons.READ`, `ZohoCommerce.salesorders.READ`, `ZohoCommerce.settings.READ`, and `ZohoCommerce.sitesIndex.READ`. Reauthorize after changing the requested scopes. The app exchanges the one-time OAuth code server-side, encrypts the refresh token using AES-GCM, and stores only the ciphertext in a table inaccessible to `anon` and `authenticated`. The OAuth state is signed and expires after ten minutes. Reauthorization replaces the stored refresh token. Product/coupon import remains a separate manual sync. The catalog sync reads all product pages and hides imported products only after a complete catalog read; customer visibility still follows marketplace approval/access policies.

Mapped product data includes product/variant identifiers, product name, SKU, brand, category, storefront visibility, first-variant sale and list price, available stock, reorder level, package weight, description, tags, returnable/featured flags and SEO metadata. The marketplace price/stock render from the first variant; a limited set of safe display fields is kept for each variant. Raw Zoho responses and internal purchase costs are not copied into the public catalog. Zoho tax configuration is not mapped to marketplace GST, which is set to 0 for imported items and must be reviewed in the marketplace admin product editor. Zoho product image endpoints/URLs vary by response/account, so reliable image mirroring is not guaranteed by this sync.

The additional admin-only data mirror stores complete read responses separately from marketplace orders/payments/returns. It mirrors categories; sales orders (including response-provided contact, address, line-item, payment/shipment/return status, and package fields); tax rules/preferences; Zoho store index records; and public published-store metadata. Each resource is bounded at 5,000 records per sync, and the admin UI displays at most 200 records at a time while the full successful snapshot stays server-side. Resource snapshots are staged as a new batch and only become current after the full resource read and save succeed. The previous complete snapshot remains current if the read or save fails. Do not use this mirror to fulfill Zoho orders, adjust inventory, record payments, or copy order/customer data to customer-facing routes. Derived metrics must be labeled as summaries from imported sales orders, not Zoho native Reports.

This is not full Zoho dashboard parity. The official Commerce [API list](https://www.zoho.com/commerce/api/apis-list.html) exposes resource groups for products, categories, coupons, taxes, payments, sales orders, shipment orders, and sales returns, but the availability of a module in that list does not establish a read operation or safe read scope for every part. Sales-order list/read are documented with `ZohoCommerce.salesorders.READ`; category list uses `ZohoCommerce.items.READ`; tax list/preferences use `ZohoCommerce.settings.READ`; and store index uses `ZohoCommerce.sitesIndex.READ`. The [Storefront API](https://www.zoho.com/commerce/api/introduction-to-storefront-api.html) is public and domain-based, distinct from Admin API access. A store metadata read is used only for the authorized published domain. Standalone shipment mutations and sales-return creation require write permissions and are intentionally not requested; supported package/shipment and return statuses are shown only when included in Sales Order responses.

No verified account-wide read/list API was established for quotes, a global cart list, a full customer directory, standalone shipment/return records, collections administration/index, files, editable page bodies, menus/themes/site-builder settings, filter/recommendation rules, blog management, or Zoho native reports. The [Add Page API](https://www.zoho.com/commerce/api/add-page.html) is a create/write endpoint, so this integration does not request that permission. The cart API requires an individual shopper cart ID. Payment gateway onboarding/configuration and credentials are not imported, and ShamiBusiness checkout/payment collection is not changed by this integration.

Zoho coupons are read from the supported coupons list/detail APIs. Only general active flat and percentage offers without product/category/collection, customer, or shipping-zone restrictions are imported. The API does not expose Zoho's “Show in Store” coupon flag, so active general coupons will be announced to all marketplace customer accounts when first imported or when their terms change. Sync is manual: run **Sync products and coupons now** after adding or changing a Zoho coupon; notifications are in-app and do not send email/SMS. Zoho redemption counts are stored separately; ShamiBusiness checkout limits and redemption counts apply only to marketplace orders and do not update Zoho counters. Per-customer coupon caps are enforced against non-cancelled marketplace orders.

Apply both `20261010100000_zoho_commerce_integration.sql` and `20261010110000_zoho_commerce_read_mirror.sql` to the production Supabase project before testing; Vercel deployment does not automatically apply migrations. After configuring secrets and deploying the migrations, connect as a Supabase administrator. Run **Sync products and coupons now** for the storefront catalog, and **Sync Zoho account data** for the admin-only records. Keep existing role policies and never expose the service-role key, OAuth client secret, OAuth refresh token, order/customer source payloads, or encryption key to customer-facing views.

The Supabase CLI login output included in the referenced conversation contained authentication material. Revoke the exposed Supabase CLI access token in the Supabase account/dashboard and sign in again with a fresh token before using the CLI. This implementation did not read or reuse that token.

## Payments and refunds

The current checkout records orders with payment pending. Admins can reconcile manually recorded payment amounts/UTRs through the payment review tools. It does not create a payment-gateway checkout session, verify gateway webhooks, automatically mark a payment successful, or issue refunds through a gateway. The UI calls out this limitation.

To enable online collection/refunds, select and onboard a payment provider (for example, Razorpay or Cashfree for Indian payment methods), then implement a server-side/Edge Function integration for order creation, signed webhook verification, idempotent payment ledger updates, refund requests, and reconciliation. Store secret keys only in Supabase Edge Function secrets or another server-side secret store. Configure provider webhook URLs and test success, failure, duplicate webhook, cancellation, partial refund, and full refund cases in the provider sandbox before production. Do not mark an order paid from a browser redirect alone.

Until that integration is deployed and verified, treat “Pending” as unpaid and use the existing manual reconciliation flow. Cash on delivery is disabled by the platform; do not accept COD orders as a substitute for gateway settlement.

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

On 2026-10-10, local TypeScript checking (`npx tsc --noEmit --pretty false`) and the production build (`npm run build`, including the Nitro Cloudflare module output) completed successfully after the vendor multi-role, order-workflow, image-validation, and Realtime refresh updates. Targeted ESLint with the Prettier rule disabled reports zero code-quality errors and two Fast Refresh warnings in `src/lib/store.tsx`; the regular targeted lint run still reports Prettier formatting findings in compact files. The authenticated Supabase CLI migration check now matches local and remote history through `20261010210000`. All 12 pending migrations were applied to project `ppziinqjxqpxpmudinfd`; the category seed migration was edited before application to omit demo products assigned to a hard-coded vendor ID. The Supabase dashboard reports the project as healthy.

These checks verify compilation and schema migration history; they do not prove every workflow by exercising live customer/admin/vendor sessions. A complete live acceptance pass still requires access to the deployed production URL and test identities for each role. Payment execution/refunds and outbound SMS/WhatsApp/email delivery remain provider-dependent as described above.
