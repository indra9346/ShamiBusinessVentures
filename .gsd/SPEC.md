# Zoho Commerce read-only integration expansion

Status: FINALIZED

## Objective

Expand the ShamiBusiness Zoho Commerce integration beyond product and coupon import, using only Zoho Commerce APIs and OAuth scopes verified in official documentation. Present supported Zoho data in the ShamiBusiness admin panel without confusing Zoho records with marketplace records. Preserve existing storefront behavior and existing app authorization rules.

## User-requested areas

The user wants the Zoho Commerce areas shown in their screenshots represented in ShamiBusiness: Items/catalog, Sales (quotes, orders, returns, carts, customers), Online Store (pages, files, menu, item filters, item recommendations, microstore, settings), Marketing (coupons and blogs), Reports, and the Zoho Payments area.

## Accuracy and safety requirements

- Do not claim full Zoho dashboard parity.
- Implement only read operations documented by Zoho and verify each operation's OAuth scope and data center host.
- OAuth permissions must be read-only. Never request create/update/delete/payment scopes for this read/sync expansion.
- Keep Zoho access and refresh tokens server-side; preserve current encrypted refresh-token storage and admin-only server functions.
- Keep imported Zoho operational records in a separate read-only data store. Do not turn them into ShamiBusiness orders, payments, customer accounts, inventory movements, or initiate payments.
- Never expose customer addresses, phone numbers, emails, order data, tokens, or source payloads to public storefront routes.
- Do not guess unsupported API endpoints. If an area has no verified documented read endpoint or the needed fields are unavailable, show it as unsupported/not available and document why.
- Keep product/coupon behavior intact; do not sync coupons in the new expanded-data operation unless explicitly chosen by the administrator through the existing safe workflow.
- Avoid destructive remote or local history changes; preserve user modifications and do not stage secrets or environment files.

## Verified implementation scope

- Existing Admin API resources: products, categories (both use `ZohoCommerce.items.READ`), and coupons (`ZohoCommerce.coupons.READ`).
- Add read-only access for Admin API Sales Orders (`ZohoCommerce.salesorders.READ`), tax rules/preferences (`ZohoCommerce.settings.READ`), and store metadata (`ZohoCommerce.sitesIndex.READ`). Sales orders contain customer contact/address fields, line items, payment/shipment/return statuses, and package tracking details; these remain restricted to admin-only views.
- Where Zoho's authenticated site index identifies the organization-owned published domain, call the public Storefront `store-meta` endpoint only at Zoho's regional Commerce host and pass that domain in Zoho's documented `domain-name` header. Retain only the returned published settings snapshot in the admin-only mirror.
- Do not request mutation scopes. Standalone shipment creation/update and sales-return creation APIs require write scopes, so shipment tracking and return/refund states are only shown when embedded in read-only Sales Order responses. No standalone read operation for those entities was verified.
- Dashboard modules without a verified account-wide read endpoint remain explicitly unsupported: quotes, global carts (Storefront Cart API is shopper-session/cart-id scoped), customer directory (customer data appears only on order records in this verified scope), collection-index/administrative collection configuration, files, readable page bodies/menu/theme configuration, product-filter/recommendation management, blog management, native report output, and payment gateway setup/secrets. Page creation exists but is write-only and is not requested. Summary metrics derived from imported sales orders must be labeled as ShamiBusiness summaries, not Zoho's native Reports.
- Zoho Payments onboarding is not a payment-processing API or a payment authorization; this work must not collect or record payments.

## Deliverables

1. A server-side, admin-guarded read/sync path for each verified supported resource with bounded pagination, typed error handling, and independent per-resource outcomes.
2. A database migration for storing imported operational/source snapshots separately from marketplace operational tables, with admin-only access policy and stable organization/resource identifiers.
3. An admin UI organized by Zoho module/resource that identifies synced, unsupported, and permission-required areas and exposes source field data safely to administrators.
4. Updated setup documentation listing precise read-only OAuth scopes, data limitations, migration steps, and explicit unsupported areas.
5. A pushed commit on a clear feature branch, after build verification and review of the diff.

## Acceptance criteria

- Consent scope list contains only verified READ scopes for shipped modules.
- A read/sync operation cannot create or mutate Zoho records and does not place Zoho sales in ShamiBusiness checkout/order tables.
- Sync failures do not erase last-known-good imported snapshots.
- Each supported module shows last sync time, record count, and any error without leaking sensitive data to customers.
- Unsupported areas are plainly marked; no invented API calls or fabricated data.
- Production build succeeds.
