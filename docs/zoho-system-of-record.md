# Zoho as system of record — audit, mapping, verification and migration plan

Last verified: 2026-10-17 (live production, admin-run; see section 8).
Status: **Orders, customers, products and stock are in parity with Zoho (verified 2026-10-17,
21:57 IST). No cutover performed.** Supabase remains the app's database. Nothing has been
deleted, disabled or migrated away from Supabase.

## 1. Architecture and every persistence location

| Location | What | Notes |
|---|---|---|
| Supabase Postgres | 39 tables (below), RLS on every table, RPCs for stock/orders/branches | The app's transactional store |
| Supabase Auth | customers, vendors, admins (email/phone one-time codes) | Roles in `user_roles` |
| Supabase Storage | `catalog-images` (public), `vendor-kyc` (private) | |
| Supabase Realtime | orders, stock, branches | live admin/vendor panels |
| Browser localStorage | `sbv-state-v2` (cart, wishlist), `sbv-language`, `gb-admin-branch`, `shami-admin-last-activity:<user>`, `shamibusiness.zoho-order-views.v1` | per-device convenience |
| sessionStorage | `gb-reloaded-for-update` | stale-chunk reload guard |
| Cookie | `sidebar_state` | UI only |
| Zoho (one organization: Inventory + Books + Commerce) | sales orders, contacts, items, stock per location | OAuth, server-side only |
| External | Nominatim / BigDataCloud reverse geocode | nothing stored there |

Tables: addresses, batches, branch_stock, branches, catalog_products, contact_enquiries, coupons,
crm_notes, customer_settings, integrations, invoices, notifications, order_item_batch_allocations,
order_items, order_tracking, order_vendor_fulfillments, orders, payments, policies,
policy_acceptance, product_reviews, profiles, return_requests, settings, store_categories,
user_roles, vendor_applications, vendor_kyc_documents, vendor_payout_requests, vendor_settings,
website_content; Zoho sync tables zoho_catalog_tombstones, zoho_commerce_connection,
zoho_commerce_sync_data, zoho_commerce_sync_state, zoho_contact_links, zoho_item_links,
zoho_oauth_states, zoho_sync_outbox.

Flows: order placed/changed → instant push → Zoho sales order `GB-<order_no>` (Inventory API);
failures → `zoho_sync_outbox` (backoff 30 s → 6 h, 12 attempts, `FOR UPDATE SKIP LOCKED`), worked
by the daily cron `/api/zoho/sync` and admin buttons. Zoho → app: signed workflow webhook
`/api/zoho/webhook` plus polling of orders, contacts and items.

## 2. Zoho capabilities (official documentation, read 2026-10-17)

| Capability | Evidence |
|---|---|
| Commerce admin API: products, variants, categories, coupons, taxes, payments, **sales orders: list / retrieve / update status / comments / address — no create** | [Commerce API index](https://www.zoho.com/commerce/api/introduction.html), [Update Status](https://www.zoho.com/commerce/api/update-status.html) |
| Commerce "Place an Order" exists only in the **storefront checkout** API (Zoho cart session) | same index (Storefront APIs) |
| Commerce webhooks: `salesorder.created/confirmed/cancelled/declined/shipped/delivered`, scope `ZohoCommerce.webhooks.CREATE`; signing method not documented there | [Create a Webhook](https://www.zoho.com/commerce/api/create-webhook.html) |
| Commerce API limit: **1,000 calls/day/org (free), 2,500 (paid)** | [API Call Limit](https://www.zoho.com/commerce/api/api-call-limit.html) |
| Inventory sales orders: create (unique `salesorder_number`, `ignore_auto_number_generation`), list, update, retrieve, delete, mark confirmed, mark void; **no "email a sales order"** | [Inventory Sales Orders](https://www.zoho.com/inventory/api/v1/salesorders/) |
| Inventory items list: `filter_by=Status.All`, `page`/`per_page`; **`hsn_or_sac` and available-for-sale are on the item record, not in the list response** | [Inventory Items](https://www.zoho.com/inventory/api/v1/items/) |
| Books "Email a sales order": `POST /books/v3/salesorders/{id}/email`, scope `ZohoBooks.salesorders.CREATE` | [Books Sales Order](https://www.zoho.com/books/api/v3/sales-order/) |
| Books webhooks: secret 12–50 alphanumeric; signature = HMAC-SHA256 of sorted query/form key+value pairs + raw JSON, header `X-Zoho-Webhook-Signature`; 5 s connect / 10 s read timeout; non-2xx retried 5× with the same payload | [Books Webhooks help](https://www.zoho.com/us/books/help/settings/automation/workflow-actions/webhooks.html) |

Observed in this organization (live evidence, not documentation):
- Books workflow rules (and so webhooks and email alerts) fired for every change made **in the Zoho
  UI** (5 of 5) and for **none** of the orders the website created through the API (0 of 5:
  ORD-26889, ORD-23324, ORD-21485, ORD-20430, ORD-24278 creations).
- Zoho offers **Void only on confirmed** sales orders (UI shows only Delete on drafts); the site now
  confirms then voids, and flags for review if Zoho still is not void.
- Live signed deliveries matched **hex** HMAC-SHA256 of the raw body (no query parameters); Zoho's
  sample code uses base64 — the site accepts both encodings of the same digest.

## 3. Entity / workflow → Zoho mapping

| Grain Bazar | Zoho | Verdict |
|---|---|---|
| orders + order_items | Sales order via Inventory API (Commerce admin API cannot create) | **Supported, synced both ways** (status, cancel→void, fulfilment) |
| profiles + addresses (customers) | Contacts | **Supported, partial parity** (see 8) |
| catalog_products | Items (+ images, description, HSN) | **Supported, partial parity** (see 8) |
| stock (app is stock master) | Item available-for-sale via inventory adjustments; locations | **Supported**. Stock moved Head Office → Challakere with transfer order TO-00001 (2026-10-17; 4 bags S1 sugar kept at Head Office for GB-ORD-24198). Stock corrections now carry the default godown's Zoho `location_id`, the same location website orders use. |
| coupons | Commerce coupons | **Partial** — usage limits enforced in app |
| invoices (GST PDF) | Zoho invoices | **Not moved** — app keeps its own PDF |
| payments | Commerce payments (mark paid/refund) | **Not moved** — capture/refund state stays transactional in Supabase |
| return_requests | Sales returns | **Gap** — not synced |
| auth users, roles | — | **Unsupported** (Zoho is not this app's identity provider) |
| vendor_* , commissions, KYC files | — | **Unsupported** |
| tracking, notifications, CRM notes, reviews, policies, website content, categories, enquiries, settings, batches | — (categories exist in Commerce but storefront taxonomy stays in app) | **Unsupported / app-only** |
| carts, wishlists (browser) | — | **Unsupported** (device-local) |
| New-order notification | Books "Email a sales order" (API) — workflow email alerts do not fire for API-created orders | **Supported via API, off by default; needs re-authorization** |

Zoho is not a general-purpose database. **Zoho = record for sales orders (and, once parity is
complete, customers, items and stock); Supabase stays the transactional app store.**

## 4. Credentials and scopes (names only)

Vercel env: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_OAUTH_STATE_SECRET`,
`ZOHO_TOKEN_ENCRYPTION_KEY`, `ZOHO_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`. The Zoho refresh token is AES-GCM encrypted in `zoho_commerce_connection`.

Scopes requested: ZohoCommerce items / coupons / salesorders / settings / sitesIndex / webhooks;
ZohoInventory contacts / items / salesorders / inventoryadjustments (READ, CREATE, UPDATE) and
settings.READ; **ZohoBooks.salesorders.CREATE** (added 2026-10-17 — active only after an admin
re-authorizes Zoho).

## 5. What is implemented

- Idempotent order push (unique `GB-<order_no>`, lookup before re-create, link stored once).
- Retries: Zoho 429 for any call; 5xx/network only for GET/PUT; durable outbox with backoff.
- Webhook: signature verified per Zoho's documented base string (query/form pairs + raw JSON,
  HMAC-SHA256, hex or base64); unsigned calls need the v2 shared key (v1 retired). Payload never
  trusted: the order is re-read from Zoho; handler is idempotent for Zoho's retries.
- Reconciliation (read-only, Admin → Zoho diagnostics): orders; products (SKU, price,
  available-for-sale stock, active) and customers (links, existence in Zoho).
- Draft cancellation: confirm → void → verify, else needs-review.
- Contact sync: updates never send `contact_persons` (Zoho treats it as deleting persons); the
  primary person is updated through the Contact Persons API. Several Zoho contacts with one email:
  the one used by the customer's own Zoho sales orders is chosen, else needs review (merge in Zoho).
- Product sync: refuses (needs review) when another Grain Bazar product has the same SKU or the
  matched Zoho item is linked to another product, so stock never flips between duplicates.
- HSN on order lines: from the Grain Bazar product, else the Zoho item record.
- Optional official notification: Books "Email a sales order" for each new website order to
  configured staff addresses; off by default; failures logged, never block the sync. Zoho marks a
  draft sales order Open when it is emailed (observed live), so enabling this confirms new website
  orders in Zoho on arrival. Test sends use an in-page confirmation (no browser pop-up).
- Structured JSON logs (`source: "zoho-sync"`), no tokens or customer details.
- Tests: `npm run test:zoho` (16 tests, incl. Zoho's documented signature examples).

## 6. Backup, migration, parity, rollback (no cutover without owner approval)

1. **Backup**: check Supabase → Database → Backups for a restorable backup; if none is available on the Free plan, take a `pg_dump` with a
   fresh Supabase login (the old CLI tokens were revoked) or upgrade for daily backups; export Zoho
   data (Settings → Export) before bulk changes. Test a restore into a scratch project.
2. **Parity**: Admin → Zoho diagnostics → run "Order reconciliation" (30/60/90 days) and "Products,
   stock and customers" until both show 0 to review.
3. **Fix links** (writes to Zoho, needs approval): run the product sync for unlinked products
   (matches by SKU, links, pushes price/description and adjusts Zoho stock to the website value);
   run the customer sync for customers with orders but no link.
4. **Dual-run** ≥ 2 weeks with Supabase as writer and Zoho as record for orders.
5. **Cutover** (explicit approval): only per entity, reads switched to Zoho.
6. **Rollback**: switch reads back (nothing deleted); pause Zoho write sync from Admin → Zoho;
   outbox jobs are kept.
7. Never drop Supabase tables.

## 7. Security

- Supabase CLI tokens from 2026-10-17 revoked (17 deleted), CLI logged out; audit log reviewed
  (only the owner's IP). No tokens in repo files or git history.
- Zoho webhook v1 key (shown in chat) retired; webhooks now signed with `ZOHO_WEBHOOK_SECRET`.
- A Resend API key was pasted in chat: delete it in Resend and create a new one (not used by the
  site).
- `.env` is tracked but holds only the public URL and publishable key.

## 8. Verification log (2026-10-17, production)

| Check | Result |
|---|---|
| Website order → Zoho sales order (ORD-23324) | Created in Zoho, total ₹2,518.96 matches |
| Zoho edit → signed webhook → site | Zoho log "Success"; site log `webhook_signature_ok` (hex) |
| Cancel on website → Void in Zoho (ORD-23324, ORD-27818) | Void in Zoho |
| Stock restore after cancel (S1 Refined Sugar 50kg) | Website 175 = Zoho available 175 |
| Order reconciliation, 30 days | 14 checked · 14 in sync · 0 to review (after fixing 5) |
| Products parity (first run) | 26 rows: 14 were Zoho-imported copies (never pushed) and 1 inactive product — both now excluded |
| Products parity (final) | 11 of 11 active Grain Bazar products linked and in sync (SKU, price, available stock, status); 0 to review |
| Customers parity (final) | 9 of 9 linked after fixing contact updates (Zoho refused a replaced person list) and choosing between duplicate Zoho contacts by the customer's own orders; 0 to review |
| Order reconciliation (final, 30 days) | 14 checked · 14 in sync · 0 to review |
| Zoho re-authorization with ZohoBooks.salesorders.CREATE | Done by the owner (consent screen showed Zoho Books: Sales Orders CREATE) |
| Official new-order notification (test, GB-ORD-26889, 22:09 IST) | **Delivered.** Site: "Zoho accepted the test email"; inbox: from `message-service@sender.zoho-books.in` (Shami Business Ventures), sales order PDF attached; Zoho history: "Sales Order emailed to …" |
| Side effect observed | Zoho marked the **draft** sales order **Open** when it was emailed ("Sales Order marked as open"), and the signed webhook to the site returned 200. With order emails On, new website orders become Open in Zoho on arrival — **accepted by the owner on 2026-10-17; order emails stay On.** |

## 9. Step 1: instant two-way product sync (branch `zoho-step1-two-way-items`, 2026-10-22)

Product details stay editable on **both** sides (owner's decision); the latest edit wins.

- **Fields both ways:** name, SKU, price, purchase price, reorder level, description, active, and now
  **HSN** (Inventory `hsn_or_sac`) and **MRP** (Zoho Commerce variant `label_rate`, written with
  `PUT /store/api/v1/variants/{variant_id}`). A blank HSN or zero MRP from Zoho never clears the
  website's value. Zoho's MRP is compared against the value last seen (`zohoSeen.mrp` on the
  product's Zoho Commerce copy), like the description; the first run only records it.
- **HSN backfill:** the "already in sync" shortcut now also checks HSN, so the next product sync
  sends the website's HSN to every Zoho item that lacks it (Admin → Zoho → sync products once).
- **Sellers:** only sellers listed in the `zoho_item_sync_vendor_ids` setting sync with Zoho items
  (`["VENDOR-001"]`, Shami's own products). An empty list means every seller.
- **Instant Zoho → website:** add a Zoho Books workflow rule. Settings → Automation → Workflow
  Rules → New: module **Items**, when **Created or Edited**, action **Webhook** to the same address
  and secret as "Grain Bazar order sync" (`/api/zoho/webhook`, signed with `ZOHO_WEBHOOK_SECRET`).
  The route already handles item payloads (`handleZohoItemWebhook`). Books rules fire only for
  edits made in the Zoho UI, which is the case they need to cover.
- **Catch-up:** the Vercel cron `/api/zoho/sync` now runs every 15 minutes instead of daily, and
  needs Vercel **Pro**: Hobby allows only daily crons and rejects the deployment. Each run reads up to
  20 linked items (one Inventory and one Commerce call each), plus contacts and recent orders. At
  today's size (11 items, 9 customers) that is about 2,000–4,000 Inventory calls a day, inside the
  10,000/day Premium limit. Commerce MRP edits don't fire the Books rule, so they arrive with the
  catch-up.
- **Migration:** `20261022120000_zoho_item_hsn_mrp_two_way.sql` (`apply_zoho_catalog_item` applies
  HSN and MRP; inserts the seller setting).
