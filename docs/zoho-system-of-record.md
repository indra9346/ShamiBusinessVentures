# Zoho as system of record — audit, mapping and migration plan

Status: **audit + sync hardening done; no cutover performed.** Supabase stays the app's database.
Nothing has been deleted, disabled or migrated.

## 1. Current architecture (where data lives)

| Location | What | Notes |
|---|---|---|
| Supabase Postgres | 39 tables (below), RLS on every table, RPCs for stock/orders/branches | The app's source of truth today |
| Supabase Auth | customers, vendors, admins (email/password, phone OTP) | Roles in `user_roles` |
| Supabase Storage | `catalog-images` (public), `vendor-kyc` (private) | |
| Supabase Realtime | orders, stock, branches | live panels |
| Browser localStorage | `sbv-state-v2` (cart, wishlist), `sbv-language`, `gb-admin-branch`, `shami-admin-last-activity:<user>`, `shamibusiness.zoho-order-views.v1` | per-device convenience only |
| sessionStorage | `gb-reloaded-for-update` | stale-chunk reload guard |
| Cookie | `sidebar_state` | UI only |
| Zoho Inventory/Commerce | sales orders, contacts, items, stock, locations | via OAuth (server-side) |
| External | Nominatim / BigDataCloud (reverse geocode) | no personal data stored there |

Tables: addresses, batches, branch_stock, branches, catalog_products, contact_enquiries, coupons,
crm_notes, customer_settings, integrations, invoices, notifications, order_item_batch_allocations,
order_items, order_tracking, order_vendor_fulfillments, orders, payments, policies,
policy_acceptance, product_reviews, profiles, return_requests, settings, store_categories,
user_roles, vendor_applications, vendor_kyc_documents, vendor_payout_requests, vendor_settings,
website_content, and the Zoho sync tables zoho_catalog_tombstones, zoho_commerce_connection,
zoho_commerce_sync_data, zoho_commerce_sync_state, zoho_contact_links, zoho_item_links,
zoho_oauth_states, zoho_sync_outbox.

Existing Zoho flows: order placed/changed → instant push (`pushOrderChangeToZoho`) → Zoho sales
order `GB-<order_no>`; failures land in `zoho_sync_outbox` (exponential backoff 30 s → 6 h, 12
attempts, `FOR UPDATE SKIP LOCKED`), worked by the daily cron `/api/zoho/sync` (Bearer
`CRON_SECRET`) and the admin "Sync now" button. Zoho → app: workflow webhook `/api/zoho/webhook`
plus polling of orders, contacts and items.

## 2. Entity → Zoho mapping

| Grain Bazar | Zoho resource | Verdict |
|---|---|---|
| orders + order_items | Sales order (`salesorders`, line items, `location_id`, custom field `cf_order_channel`) | **Synced** (both ways for status/cancel/fulfilment) |
| profiles + addresses (customers) | Contact (`contacts`, contact persons, billing/shipping) | **Synced** |
| catalog_products | Item (`items`), images, description | **Synced** |
| branch_stock / branches | Locations + item stock per location | **Partly** — stock is pushed per location; branch PIN rules, pickup/delivery flags stay in Supabase |
| coupons | Commerce coupons | **Partly** — read from Zoho; usage limits enforced in app |
| invoices | Zoho invoice | **Not moved** — app builds its own GST PDF; Zoho invoices are created from the sales order in Zoho |
| payments | Customer payments | **Not moved** — payment capture/refund state must stay transactional in Supabase |
| return_requests | Sales returns | **Gap** — not synced (possible later via `salesreturns` scope) |
| Auth users, user_roles | — | **Unsupported**: Zoho is not an identity provider for this app |
| vendor_* (applications, KYC docs, payouts, settings, fulfilment), commission rules | — | **Unsupported**: no Zoho resource; KYC files are private documents |
| order_tracking, notifications, crm_notes, product_reviews, policies, policy_acceptance, website_content, store_categories, contact_enquiries, settings, batches, order_item_batch_allocations | — | **Unsupported / app-only** |
| localStorage carts/wishlists | — | **Unsupported** (device-local by design) |

Zoho is not a general-purpose database: RLS-style per-user access, RPC transactions (stock
reservation, cancel-restores-stock), realtime and auth have no Zoho equivalent. **Recommendation:
Zoho = system of record for sales orders, customers, items and stock; Supabase stays the
transactional app store.** A full move of everything is not possible.

### Verified vs not verified in Zoho docs (checked 2026-10-17)
- Verified (Inventory API docs): sales order create with unique `salesorder_number` and
  `ignore_auto_number_generation`; `custom_fields`; `location_id`; pagination
  (`page`, `per_page`, `page_context.has_more_page`); rate limits 100 req/min/org, daily caps by
  plan, 429 on excess; scopes `ZohoInventory.<module>.<op>`; `.in` data centre.
- **Not found**: an "email a sales order" endpoint in Inventory (only invoices, credit notes,
  statements have email endpoints); webhook payload signing (HMAC) — the help pages returned 403;
  the Zoho Commerce API reference beyond its intro page.

## 3. Credentials and scopes (names only)

Server env (Vercel): `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`,
`ZOHO_OAUTH_STATE_SECRET`, `ZOHO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. The Zoho refresh token is stored AES-GCM encrypted
in `zoho_commerce_connection`; none of these reach the browser.

Scopes: `ZohoInventory.salesorders.CREATE/READ/UPDATE`, `ZohoInventory.contacts.CREATE/READ/UPDATE`,
`ZohoInventory.items.CREATE/READ/UPDATE`, `ZohoInventory.settings.READ` (organization,
locations), plus the Zoho Commerce scopes the app already requests for the Commerce read mirror
and coupons. Add `ZohoInventory.invoices.CREATE` only if invoice emailing is enabled later.

## 4. Changes in this round
- `src/lib/zoho-sync-core.ts` (pure, tested): order-number idempotency key, retry policy,
  backoff, constant-time webhook key check, reconciliation, JSON log lines.
- `inventoryRequest`: up to 2 retries with backoff — 429 for any call; 5xx/network only for
  GET/PUT (a POST is never blindly resent; order creation re-checks the unique GB- number).
- Outbox worker: one JSON log line per job (`outbox_job_finished`, no customer data/tokens).
- Webhook: key accepted as `X-GB-Webhook-Key` header (preferred) or `?key=`; logs
  accepted/rejected/failed; payload still never trusted (record re-read from Zoho).
- `reconcileZohoOrders` server function + Admin → Zoho diagnostics → "Order reconciliation"
  (read-only).
- Tests: `npm run test:zoho` (Node test runner).

## 5. Notifications through Zoho (official capability)
No Inventory API endpoint emails a sales order, so notifications should use Zoho's own
**Workflow Rules → Email Alert** on Sales Orders (trigger: created, condition: Order Channel =
GrainBazar). This is configured in Zoho Settings, needs no code and keeps delivery inside Zoho.
It sends real emails, so the owner sets it up. Not verified end to end.

## 6. Migration plan (only if more moves to Zoho later)
1. **Backup**: Supabase dashboard → Database → Backups (confirm a daily backup exists) and take a
   `pg_dump` from a fresh, non-compromised login; export Zoho data (Settings → Export).
2. **Parity**: run "Order reconciliation" for 30/60/90 days until it shows 0 issues; compare
   contact and item counts (`zoho_contact_links`, `zoho_item_links` vs Zoho).
3. **Dual-run**: keep Supabase as the writer, Zoho as the mirror, for at least 2 weeks.
4. **Cutover** (needs the owner's explicit approval): switch only the chosen entity's reads to Zoho.
5. **Rollback**: flip reads back to Supabase (no data was deleted); Zoho write sync can be paused
   from Admin → Zoho (write-sync switch) without losing queued jobs.
6. Never drop Supabase tables until 1–5 have passed and a fresh backup is verified.

## 7. Security follow-ups
- The Supabase CLI login pasted in chat on 2026-10-17 must be treated as compromised: revoke it in
  Supabase → Account → Access Tokens (and sign out CLI sessions), then log in again if needed.
  No token was found in this repo's files or git history.
- `.env` is tracked but holds only the public URL and publishable key.
- Prefer moving the webhook key from the URL to the `X-GB-Webhook-Key` header in the Zoho
  workflow webhook, so it does not appear in request logs.
