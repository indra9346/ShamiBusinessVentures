# Batch / stock-number tracking

Client request (Sandesh, 31 Oct 2026): "Allot purchase — stock no. / batch no. is fixed; reports
according to batch no.; track sales, profit, every data batch-wise." Example: a purchase of 50
Groundnut Oil 5 L cans gets one batch number.

## How it works

1. **Receive purchase** (Admin → Batches → Receive purchase): godown, product, quantity, cost per
   unit, purchase date, supplier, bill/PO no., optional mfg/expiry. The batch gets a fixed number:
   `CLK-311026-01` = godown code, purchase date (DDMMYY), running number that day (or the admin
   types their own; numbers are unique).
2. **Zoho first:** with Zoho as the stock master and the product linked, Zoho gets the stock as an
   inventory adjustment at the godown's location (reference = batch number). Only when Zoho accepts
   it is the batch saved and the godown's website stock raised. Without a Zoho link the batch is
   website-only and the stock goes to Zoho with the next sync.
3. **Sales (FIFO per godown):** an order takes stock from the oldest batch at the order's godown
   first, split over two batches when needed (`private.allocate_order_item_batches`, called by
   `place_marketplace_order` / `admin_update_order_item`). Stock older than batch tracking stays
   unbatched. Cancels, expired payment holds and quantity cuts give it back.
4. **Batch number on Zoho documents:** the sales-order line description (copied to the Books
   invoice) and the package notes carry the batch number(s).
5. **Losses / gains:** stock counts by godown staff and website stock edits are recorded per batch
   (the oldest batch loses first, the newest takes a gain) in `batch_adjustments`.
6. **Reports:** Admin → Batches — dashboard, godown cards, batch list, batch detail (purchased,
   sold, delivered, awaiting payment, lost, available, sales, cost, profit, days to sell out),
   orders and customers of a batch, and "Trace customer / order" (customer or order → batches).
   Excel: Dashboard, Batches, Sales per batch, Customers per batch, Losses and gains.
7. **Customers** see the batch number of each item on their order page (`order_item_batches()`).

Money: sales = qty × the order line's rate before GST, less the order's discount in proportion;
cost = qty × the batch's cost; profit = sales − cost of sold units − value of stock lost.

## Zoho batch tracking (only for new Zoho items)

Zoho's organisation setting "Enable Batch Tracking" is on, but Zoho refuses "Track batches" on an
item that already has transactions ("Batch Number cannot be enabled for items which already have
transactions", 31 Oct 2026). So the existing website products keep website batches plus the batch
number as text in Zoho.

A new Zoho item created with "Track batches" (and linked to a website product) is handled fully:
receipts create the Zoho batch, packages and adjustments name Zoho batches (Zoho requires it), and
the 15-minute sync links Zoho batches to website batches and imports batches made in Zoho (e.g. a
Zoho purchase receive). `zoho_item_links.track_batches` remembers which items these are.

## Database

Migration `supabase/migrations/20261031190000_batch_tracking.sql` (applied 31 Oct 2026): batch
columns (godown, supplier, bill/PO, Zoho link, sold-out time), `batch_adjustments`, batch-number
function, FIFO allocation at the order's godown, server-only receipt / adjustment / Zoho-import
functions. Writes only through functions; batches are readable by admins only.

Tests: `tests/batches.test.ts` (in `npm run test:zoho`).
