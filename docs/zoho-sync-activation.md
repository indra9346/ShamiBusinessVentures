# Grain Bazar ↔ Zoho Commerce activation

## What this integration does

Zoho Commerce remains the one administrative workspace. The application imports Zoho Commerce products and read snapshots; the server-side worker writes Grain Bazar customer/vendor contacts, approved marketplace items, and sales orders through Zoho Inventory, then reconciles supported contact, catalogue, and shipment-status edits back into Grain Bazar. The owner has confirmed Zoho Inventory is Active in the Zoho organization shown in the Commerce admin (`60066526172`). The production `/admin/zoho` connection must still be checked against that same organization ID before writes are enabled.

The worker performs active two-way write and read sync. Database triggers enqueue identifiers for changed profiles (customers, vendors, admins), approved catalogue products, and orders; the worker reads current database values at send time and writes them to Zoho Inventory and Zoho Commerce. The queue has atomic claims, bounded retries with backoff, visible `needs_review` outcomes, and duplicate prevention. Grain Bazar account credentials, passwords, OTPs, and payment secrets are never sent to Zoho. Administrators can trigger outbound processing anytime using the **Push pending to Zoho** button in `/admin/zoho`.

### Field ownership for the implemented outbound path

- Grain Bazar profile and address values are the source for the corresponding Zoho customer contact fields.
- A Grain Bazar vendor-role profile is sent as a Zoho vendor contact. This is contact data only; vendor KYC documents, catalog authority, marketplace commission, and payouts are not Zoho Inventory contact fields and are not copied.
- Grain Bazar order number, item quantities, app prices, discount, shipping, GSTIN, and customer association are sent as a Zoho sales order. Payment credentials are never included. Line items automatically ensure the Zoho item exists before placing the order.
- A Grain Bazar catalogue record is created or updated as a Zoho Inventory item only after it is `approved` and active. Its exact SKU is the stable match key. Product name, SKU, selling price, purchase price, reorder level, description, and vendor contact association are synchronized; a rejected or disabled marketplace product deactivates its linked Zoho item.
- Deleting a mapped marketplace product records a short-lived tombstone and deactivates the linked Zoho Inventory item on the next scheduled run. It never deletes the Zoho item, preserving its financial and order history.
- A Zoho Inventory item edit can update only the mapped Grain Bazar product's name, SKU, selling price, purchase price, reorder level, description, and active state. If either side changed since their last common state, the edit is retained as `needs_review` instead of overwriting the other side.
- Zoho remains authoritative for finance-only fields and stock/accounting settings. The worker does not send browser stock values as inventory adjustments and does not import Zoho stock into the marketplace because a safe stock integration needs warehouse, reservation, and fulfillment rules for this business.
- For Zoho-to-app contact reconciliation, only linked records are polled. Non-conflicting name, phone, company, GSTIN, and billing address edits are applied to the mapped Grain Bazar profile/default address. A changed login email or concurrent app edit goes to `needs_review`; Zoho never changes Supabase Auth credentials.
- For Zoho-to-app order reconciliation, only explicit shipment package states `shipped` and `delivered` are mapped to Grain Bazar `Dispatched` and `Delivered`. Generic sales-order states (`open`, `closed`, `fulfilled`) are not treated as delivery proof. This uses scheduled polling and manual push triggers.

## Activation checklist

1. **Confirm the Zoho organization link.** Zoho Inventory is already shown as Active in the owner’s Commerce settings, and the screenshot URL indicates organization `60066526172`. Verify `/admin/zoho` is connected to this same ID.
2. **Re-authorize Zoho for Writable Access.** In `/admin/zoho`, click **Reauthorize Zoho**. The authorization request requests both read and write scopes:
   - `ZohoCommerce.items.READ,ZohoCommerce.items.CREATE,ZohoCommerce.items.UPDATE`
   - `ZohoCommerce.coupons.READ,ZohoCommerce.coupons.CREATE,ZohoCommerce.coupons.UPDATE`
   - `ZohoCommerce.salesorders.READ,ZohoCommerce.salesorders.CREATE,ZohoCommerce.salesorders.UPDATE`
   - `ZohoCommerce.settings.READ,ZohoCommerce.settings.UPDATE,ZohoCommerce.sitesIndex.READ`
   - `ZohoInventory.contacts.READ,ZohoInventory.contacts.CREATE,ZohoInventory.contacts.UPDATE`
   - `ZohoInventory.items.READ,ZohoInventory.items.CREATE,ZohoInventory.items.UPDATE`
   - `ZohoInventory.salesorders.READ,ZohoInventory.salesorders.CREATE,ZohoInventory.salesorders.UPDATE`
   Accept the Zoho consent prompt.
3. **Push Pending Outbox Records.** In `/admin/zoho`, click **Push pending to Zoho** to immediately process all queued customer, vendor, catalogue, and sales order items.
4. **Confirm item parity.** Every sellable Grain Bazar product has a unique SKU. The approved product sync creates or maps Zoho Inventory items with the same exact SKU. Verify the mapped `zoho_item_links` in the database.
5. **Review taxes and totals.** Configure Zoho tax/GST treatment for the matching items and organization.
6. **Configure Vercel Production secrets** from `.env.example`: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_OAUTH_STATE_SECRET`, `ZOHO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`.
7. **Scheduled execution.** Vercel Cron calls `/api/zoho/sync` with `CRON_SECRET` bearer authorization, and the admin panel allows instant on-demand pushes anytime.

## Current boundary

This implementation provides scheduled, ownership-aware **partial two-way sync** for linked customer/vendor contact fields, approved marketplace catalogue item fields, and order shipment progress, plus Grain Bazar-to-Zoho customer/vendor contacts, approved catalogue items, and sales orders. It does not sync payment captures/refunds, invoice settlement, inventory quantities, vendor KYC, marketplace commission/payouts, unlinked Zoho customers, product images/categories, or every Commerce admin field. Those require separate endpoint/field mappings and production verification. The Vercel admin panel is an integration-health and read-snapshot surface; Zoho Commerce remains the sole business admin workspace. Do not describe the integration as live until the production migration, OAuth re-consent, cron, and controlled record reconciliation are completed.
