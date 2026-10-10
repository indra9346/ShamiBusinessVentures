---
status: human_needed
score: 4/5 automated must-haves verified
---

# Admin and vendor verification

This is a current evidence ledger for the end-to-end admin/vendor readiness
goal. Static wiring checks and database metadata do not replace role-based
browser acceptance.

## Must-haves

| Requirement | Status | Evidence |
| --- | --- | --- |
| Production schema matches the repository migrations | VERIFIED | `npx supabase migration list` returned matching local/remote versions through `20261011050000`. |
| Admin category writes and catalog image uploads match production schema and policies | VERIFIED (wiring) | Live `store_categories` columns/policies match `src/lib/store.tsx`; file selection calls `uploadCatalogImage`, whose path and 5 MiB limit match live `catalog-images` bucket policies/limits. A real browser upload was not exercised. |
| Vendor catalog updates follow the live KYC/moderation policy | VERIFIED (code path) | Live update policy requires vendor ownership, complete KYC, and pending status. `updateProduct` now passes the vendor moderation flag so its persisted row satisfies that rule; product/stock success messages explain review. Real vendor-account update still needs browser acceptance. |
| Admin/vendor Realtime tables are published | VERIFIED (configuration) | Production `supabase_realtime` publication includes catalog, categories, orders, order items, per-vendor fulfillments, payments, payouts, notifications, and reviews. Actual browser socket delivery was not observed in this pass. |
| Production build and TypeScript checks pass | VERIFIED | `npm run build` and `npx tsc --noEmit --pretty false` both exited successfully after the current code changes. |

Additional live metadata checks found no public tables without RLS, confirmed the `catalog-images` bucket is public with a 5 MiB cap and `vendor-kyc` is private with a 15 MiB cap, and verified the upload/ownership policies and Realtime publication entries described above.

## Human acceptance still required

1. Sign in with separate admin, approved vendor, and customer test accounts. Upload an image from local storage, create/edit a category, submit and approve a vendor product, update vendor stock, and confirm each result survives refresh and appears only to the permitted roles.
2. Place a multi-vendor test order, advance each vendor shipment separately, and confirm customer tracking, admin aggregate status, Realtime updates, payment gating, and cancellation rules in the browser.
3. Configure and sandbox-test the chosen payment provider before claiming gateway collection/refunds work. The app currently supports manual payment reconciliation.
4. Configure production Supabase Auth SMTP and any required SMS provider; verify password reset and OTP delivery on the production domain. SMS/WhatsApp outbound delivery is not connected.
5. Enable Supabase leaked-password protection and establish an admin MFA policy before production traffic. Admin MFA is not enforced by the app yet.

The production database currently has no catalog product owned by a vendor with
complete approved KYC, so the vendor product update could not be exercised
against a real authenticated vendor row in this pass. Use a dedicated test
vendor with approved required documents for that acceptance check.

## External setup

Provider configuration and credentials that cannot be completed from this
checkout are documented in [production-readiness.md](production-readiness.md),
including Zoho OAuth, payment/refund processing, SMTP/SMS, and WhatsApp delivery.
