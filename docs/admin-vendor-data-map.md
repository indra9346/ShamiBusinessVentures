# Admin and vendor data map

The panels use the shared Supabase-backed application store for common catalog,
order, profile, inventory, and review data. Page-local forms call the RPCs and
tables listed below. Row visibility and writes are enforced by the SQL
migrations in `supabase/migrations`; route guards in `PanelLayout` also verify
the signed-in Supabase role.

## Admin routes

| Route | Supabase data and actions |
| --- | --- |
| `/admin/dashboard` | `orders`, `order_items`, `payments`, `profiles`, `user_roles`, and live `vendor_payout_requests` |
| `/admin/vendors` | `vendor_applications`; `admin_review_vendor_application` approves or rejects applications and provisions the vendor role/profile; suspending a vendor hides their public listings through catalog RLS |
| `/admin/vendors/$id` | `profiles`, `catalog_products`, `orders`/`order_items`, `product_reviews`, `vendor_kyc_documents`, `vendor_payout_requests`; `admin_review_vendor_kyc` |
| `/admin/customers` and `/admin/customers/$id` | `profiles`, `user_roles`, customer addresses/orders, and `admin_set_profile_status` |
| `/admin/products` and `/admin/products/$id` | `catalog_products`, `store_categories`, vendor profiles, and `catalog-images` Storage uploads |
| `/admin/categories` | `store_categories`, product/category counts, and `catalog-images` Storage uploads |
| `/admin/inventory` | `catalog_products`, admin-only FIFO `batches`, and `admin_receive_inventory_batch` |
| `/admin/orders` and `/admin/orders/$id` | `orders`, `order_items`, `payments`; order creation and status changes use protected store/RPC paths |
| `/admin/payments` | `orders`, `payments`, and `admin_confirm_manual_payment`; refunds require an external payment provider and are not enabled |
| `/admin/commissions` | Vendor sales from `orders`/`order_items`; `profiles.commission_rate` through `admin_set_vendor_commission` |
| `/admin/payouts` | `vendor_payout_requests`, vendor `profiles`, `admin_update_payout`, and Realtime refresh |
| `/admin/coupons` | `coupons` |
| `/admin/reports` | Derived views from orders, items, products, profiles, payouts, and reviews |
| `/admin/returns` | `return_requests`, orders/items, and `admin_update_return` |
| `/admin/reviews` | `product_reviews`, `catalog_products`, and review moderation RPCs |
| `/admin/notifications` | `notifications` and `admin_broadcast_notification` |
| `/admin/settings` | `settings` for business, tax, commerce, shipping, and security preferences |
| `/admin/zoho` | Server-side Zoho integration functions and private `zoho_commerce_*` connection/sync tables |
| `/admin/login` | Supabase Auth; panel role is checked from `user_roles` |

## Vendor routes

| Route | Supabase data and actions |
| --- | --- |
| `/vendor/dashboard` | Vendor-scoped `catalog_products`, `orders`/`order_items`, published reviews, and payout data; live refresh uses Supabase Realtime |
| `/vendor/products` and `/vendor/products/add` | Vendor-owned `catalog_products`, enabled `store_categories`, and product image uploads to `catalog-images` |
| `/vendor/orders` and `/vendor/orders/$id` | Vendor-owned order lines from `order_items` and order status from `orders`; vendor updates advance one stage at a time and require full payment before dispatch |
| `/vendor/inventory` | Vendor-owned products in `catalog_products`; stock changes are persisted through the product update path |
| `/vendor/earnings` | Paid/delivered `orders`/`order_items`, vendor commission from `profiles`, and reserved rows in `vendor_payout_requests` |
| `/vendor/payouts` | Own `vendor_payout_requests`; create requests through `request_vendor_payout` |
| `/vendor/reviews` | Vendor-scoped `product_reviews`; `vendor_reply_to_review` and `vendor_report_review` |
| `/vendor/profile` | Own `profiles`, `vendor_kyc_documents`, private `vendor-kyc` Storage, and public `catalog-images` profile uploads |
| `/vendor/settings` | Own `vendor_settings`; password changes through Supabase Auth |
| `/vendor/notifications` | Current recipient's rows in `notifications` |
| `/vendor/register` | Customer-owned `vendor_applications`; submit/resubmit through `customer_submit_vendor_application` |
| `/vendor/login` | Supabase Auth plus an exact vendor role and assigned profile/vendor ID |

## Shared behavior and external dependencies

- Common records are loaded in `src/lib/store.tsx`; its Realtime channel listens
  for catalog, category, profile/role, order, payment, review, return, batch,
  and coupon changes. Refreshes are debounced, stale overlapping reads are
  discarded, and a Realtime reconnect triggers a fresh read. Vendor application
  status and payout/KYC screens also refresh from their own scoped channels.
  Migrations add these tables and the operational tables to the
  `supabase_realtime` publication where supported.
- Vendor profile statuses are normalized for consistent admin filtering and
  metrics across legacy `Active` and new `approved` values. Vendor revenue
  summaries use captured order-line prices, so later catalog edits do not
  rewrite historical sales.
- Order lines and payment transaction details follow the vendor/customer/admin
  scopes in `20261010180000_vendor_order_data_scope.sql`. Profile insertion is
  restricted to trusted signup/profile functions by
  `20261010190000_restore_profile_insert_lock.sql`.
- Public catalog reads require an approved, active vendor profile; suspension
  hides its listings while retaining admin and vendor access in
  `20261010220000_hide_suspended_vendor_catalog.sql`.
- FIFO purchase batches, including internal unit cost layers, are admin-only;
  vendors manage their sellable stock through their own catalog products after
  `20261010230000_admin_only_inventory_batch_reads.sql`.
- Customer accounts marked blocked by an administrator are signed out and
  prevented from writing orders, addresses, returns, reviews, settings, or
  vendor applications by `20261010233000_enforce_blocked_customer_status.sql`.
- External payment collection/refunds and outbound SMS/WhatsApp/email are not
  connected. Manual payment reconciliation and in-app notifications remain the
  supported workflows until provider setup is completed.
- This map documents current code-to-schema wiring. The authenticated
  production migration check confirmed history through `20261011040000`,
  including the admin order-item and protected cancellation workflows. Route
  behavior still needs a live acceptance pass with separate admin, vendor, and
  customer accounts.
