# Grain Bazar ↔ Zoho Commerce activation

## What this integration does

Zoho Commerce remains the one administrative workspace. The application imports Zoho Commerce products and read snapshots; the server-side worker writes Grain Bazar customer/vendor contacts, approved marketplace items, and sales orders through Zoho Inventory, then reconciles supported contact, catalogue, and shipment-status edits back into Grain Bazar. The owner has confirmed Zoho Inventory is Active in the Zoho organization shown in the Commerce admin (`60066526172`). The production `/admin/zoho` connection must still be checked against that same organization ID before writes are enabled.

The worker is intentionally disabled by default (`ZOHO_WRITE_SYNC_ENABLED=false`). Supabase triggers enqueue identifiers only; the worker reads current database values at send time. The queue has atomic claims, bounded retries with backoff, visible `needs_review` outcomes, and duplicate prevention. Grain Bazar account credentials, passwords, OTPs, and payment secrets are never sent to Zoho.

### Field ownership for the implemented outbound path

- Grain Bazar profile and address values are the source for the corresponding Zoho customer contact fields.
- A Grain Bazar vendor-role profile is sent as a Zoho vendor contact. This is contact data only; vendor KYC documents, catalog authority, marketplace commission, and payouts are not Zoho Inventory contact fields and are not copied.
- Grain Bazar order number, item quantities, app prices, discount, shipping, GSTIN, and customer association are sent as a Zoho sales order. Payment credentials are never included. Zoho order totals are checked against the Grain Bazar total; differences go to `needs_review`.
- A Grain Bazar catalogue record is created or updated as a Zoho Inventory item only after it is `approved` and active. Its exact SKU is the stable match key. Product name, SKU, selling price, purchase price, reorder level, description, and vendor contact association are synchronized; a rejected or disabled marketplace product deactivates its linked Zoho item.
- Deleting a mapped marketplace product records a short-lived tombstone and deactivates the linked Zoho Inventory item on the next scheduled run. It never deletes the Zoho item, preserving its financial and order history.
- A Zoho Inventory item edit can update only the mapped Grain Bazar product's name, SKU, selling price, purchase price, reorder level, description, and active state. If either side changed since their last common state, the edit is retained as `needs_review` instead of overwriting the other side.
- Zoho remains authoritative for finance-only fields and stock/accounting settings. The worker does not send browser stock values as inventory adjustments and does not import Zoho stock into the marketplace because a safe stock integration needs warehouse, reservation, and fulfillment rules for this business.
- For Zoho-to-app contact reconciliation, only linked records are polled. Non-conflicting name, phone, company, GSTIN, and billing address edits are applied to the mapped Grain Bazar profile/default address. A changed login email or concurrent app edit goes to `needs_review`; Zoho never changes Supabase Auth credentials.
- For Zoho-to-app order reconciliation, only explicit shipment package states `shipped` and `delivered` are mapped to Grain Bazar `Dispatched` and `Delivered`. Generic sales-order states (`open`, `closed`, `fulfilled`) are not treated as delivery proof. This uses scheduled polling, so it is near-real-time, not instantaneous.

## Activation checklist

1. **Confirm the Zoho organization link.** Zoho Inventory is already shown as Active in the owner’s Commerce settings, and the screenshot URL indicates organization `60066526172`. Verify `/admin/zoho` is connected to this same ID. Do not enable outbound writes if the IDs differ.
2. **Confirm item parity.** Every sellable Grain Bazar product must have a unique SKU. The first approved product sync creates or maps one Zoho Inventory item with the same exact SKU; duplicates are held for review. Verify the first batch of mapped `zoho_item_links` before allowing normal order traffic.
3. **Review taxes and totals.** Configure Zoho tax/GST treatment for the matching items and organization. Run a controlled pilot and compare the full Zoho sales-order total with Grain Bazar's calculated total. A mismatched order is retained for review and must not be invoiced until reconciled.
4. **Apply the new Supabase migration** `20261013100000_zoho_sync_outbox.sql` to the production project. In the Supabase SQL Editor, paste the whole migration and run it once. Then run this read-only check:

   ```sql
   select
     to_regclass('public.zoho_sync_outbox') as outbox,
     to_regclass('public.zoho_contact_links') as contact_links,
     to_regclass('public.zoho_item_links') as item_links,
     to_regclass('public.zoho_catalog_tombstones') as catalogue_tombstones,
     to_regclass('public.zoho_oauth_states') as oauth_states;

   select routine_name
   from information_schema.routines
   where routine_schema = 'public'
     and routine_name in (
       'claim_zoho_sync_jobs',
       'finish_zoho_sync_job',
       'retry_zoho_sync_job',
       'apply_zoho_contact_update',
       'apply_zoho_catalog_item',
       'apply_zoho_order_fulfillment'
     )
   order by routine_name;
   ```

   The first query must return all five relation names and the second must return all six functions. These tables/RPCs are service-role only. The OAuth state table stores only a SHA-256 hash and is consumed after a successful authorization callback, preventing callback replay.
5. **Create the Zoho OAuth client.** The Zoho Commerce **Zoho Apps** page only proves that Inventory is enabled. In the India data-center API Console at `https://api-console.zoho.in/`, create a **Server-based** client with the homepage `https://shamibusinessventures.vercel.app` and this exact authorized redirect URI: `https://shamibusinessventures.vercel.app/api/zoho/callback`. Copy the generated client ID and client secret directly to Vercel; never send either secret through chat or place it in browser code.
6. **Configure Vercel Production secrets** from `.env.example`: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ZOHO_OAUTH_STATE_SECRET`, `ZOHO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, and `ZOHO_WRITE_SYNC_ENABLED=false`. Keep every key server-side and independently generated. Never add them as `VITE_` variables or commit them.
7. **Deploy and re-authorize Zoho.** Deploy the code, open `/admin/zoho` as the existing Grain Bazar admin, and reconnect the same India Zoho organization. The authorization request now includes the Inventory contacts, items, and salesorders scopes needed for this worker. Existing refresh tokens do not gain scopes automatically.
8. **Pilot while writes remain disabled.** First confirm the production cron route appears in the Vercel deployment and that requests without the `CRON_SECRET` are rejected. Then set `ZOHO_WRITE_SYNC_ENABLED=true` only for a controlled vendor, customer, product, and low-risk order. Confirm the Zoho Contacts page shows exactly one mapped customer/vendor record; the approved product creates or updates one Inventory item; and the Zoho Commerce/Inventory-linked order shows the correct customer, SKUs, quantities, prices, discounts, shipping, GST, and total. Check retries, queue outcomes, and Vercel logs before enabling normal traffic.
9. **Confirm scheduled execution.** Vercel Cron calls `/api/zoho/sync` every minute with `CRON_SECRET` bearer authorization. Confirm the cron job appears under the deployed Vercel project's Cron Jobs settings and observe at least one authenticated invocation. Cron execution is not guaranteed to happen at an exact wall-clock second.

## Current boundary

This implementation provides scheduled, ownership-aware **partial two-way sync** for linked customer/vendor contact fields, approved marketplace catalogue item fields, and order shipment progress, plus Grain Bazar-to-Zoho customer/vendor contacts, approved catalogue items, and sales orders. It does not sync payment captures/refunds, invoice settlement, inventory quantities, vendor KYC, marketplace commission/payouts, unlinked Zoho customers, product images/categories, or every Commerce admin field. Those require separate endpoint/field mappings and production verification. The Vercel admin panel is an integration-health and read-snapshot surface; Zoho Commerce remains the sole business admin workspace. Do not describe the integration as live until the production migration, OAuth re-consent, cron, and controlled record reconciliation are completed.
