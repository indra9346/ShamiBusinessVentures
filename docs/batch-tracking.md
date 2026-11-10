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

## Unloading godown and sending batches between godowns (10 Nov 2026)

Client: "When we receive batches, at that time we should enter to which warehouse it is unloaded & same should be
updated to Zoho inventory." Owner's choices: a Zoho transfer order (the bill stays untouched); one unloading godown per
bill; and "make batches from super batch and those batches can be sent for multiple any intended godowns".

- **Receive purchase** asks **Unloaded at godown** first and lists recent bills from every Zoho location, each saying
  where Zoho has it. A bill already at that godown changes nothing in Zoho (as before). A bill at another Zoho location
  (another godown, or Head Office) is moved to the unloading godown with a Zoho transfer order, and only then are its
  batches made, numbered at the unloading godown.
- **Send to other godowns** (on a batch with units left): one row per godown and quantity. Each godown gets a Zoho
  transfer order and a batch of its own named after the super batch (`CLK-031126-08` → `CLK-031126-08-HBL1`) with the
  same cost, bill, supplier and dates. The super batch keeps the rest.
- **In transit until the receiving godown marks it received** (owner, 10 Nov 2026). A sent batch goes to Zoho as an
  in-transit transfer order and leaves the sending godown's stock at once. The receiving godown's staff app and
  channel partner page show **Stock between godowns → Coming to your godown** (what, how many, from which godown and
  batch, sent when and by whom) with **Mark received** (after counting it). Only that godown's staff, its partner or an
  administrator can mark it; Zoho is marked received first, then the new batch appears there and that godown's stock
  goes up. The sender sees **Sent from your godown, on the way** and later who received it and when; the admin sees
  **On the way between godowns** and the full trail on both batches. A bill received at the godown where it was
  unloaded is already there, so it is received at once. Only administrators send batches (owner).
- **Safe with Zoho:** every transfer has a fixed number, `GB-TR-000001`, which is also its Zoho transfer order number.
  The website records it and sets the units aside first; then asks Zoho; then finishes. A lost Zoho reply leaves it
  "Waiting for Zoho" under **Transfers waiting for Zoho** with **Retry**, which looks the number up in Zoho first and
  never creates a second one. Numbers are never reused (the counter only goes up).
  - **One request at a time:** each request claims the transfer before it asks Zoho anything (`claim_batch_transfer`,
    released at the end, runs out after 5 minutes if the server stops). A double press, two admins, the stock check
    or a second Receive of the same bill never create, cancel or finish one transfer twice.
  - **A create whose answer was lost** is written down before it goes out (`create_sent_at`). For 10 minutes after it,
    Retry only looks it up and **Cancel** waits, because Zoho may still be making it.
  - **Zoho saying no** (or "number taken") is checked by looking the number up: only when Zoho has nothing under it is
    the transfer cancelled and the units given back. The wording alone is never trusted.
  - **Cancel** works only when Zoho doesn't have it: no transfer order under its id or number, or Zoho's is void. That
    includes a batch already **on its way** whose transfer was voided or deleted in Zoho: its units go back on the super
    batch and at the sending godown.
- **A bill being moved** (waiting for Zoho) can't be received anywhere else until that transfer is retried or
  cancelled (`receive_bill_here`); the bill list shows "Being moved to … (GB-TR-…)".
- **Stock:** Zoho moves it. Right after, the server reads Zoho's stock for the item at the two godowns and the website
  takes Zoho's numbers (less website orders Zoho doesn't hold yet), so a stock sync that already pulled the move can't
  count it twice. A godown with a website stock edit still waiting for Zoho moves by the quantity instead, as the next
  sync sends that count to Zoho. When Zoho is not the stock master, the website moves the godowns by the quantity.
  Zoho batch-tracked items are moved in Zoho itself (refused here, as their receipts are).
- **The 15-minute stock sync checks batches on their way** first: one marked received in Zoho itself is finished
  (its batch made, "Marked received in Zoho"); one voided or deleted in Zoho is cancelled and its units go back. A
  transfer it can't settle keeps that godown's stock for the item out of that run, so an arrival never shows without
  its batch.
- **Staff and partner apps** get only what moves, how many, where from and to, and who received it: no bill, costs,
  supplier or Zoho details. Everything on its way is listed, however old.
- **Report:** a sent batch shows **Received from another godown** (not Purchased, so a purchase counts once); the super
  batch shows **Sent to other godowns** (`batches.sent_quantity`, kept on the batch row); the stock bar and the ledger
  include both; Excel has both columns. A batch in a transfer can't be deleted, even when that transfer was cancelled.
- **Zoho permission:** the website now asks for `ZohoInventory.transferorders.READ/CREATE/UPDATE`. After this goes
  live, the owner presses **Reauthorize Zoho** in Admin › Zoho once; until then Zoho refuses transfers and nothing moves.

Migration `supabase/migrations/20261110180000_batch_receive_and_split.sql`; rules for Zoho in `src/lib/batch-transfers.ts`;
server in `src/lib/zoho-commerce.functions.ts` (`runBatchTransfer`, `sendBatchToGodowns`, `markTransferReceived`,
`retryBatchTransfer`, `cancelBatchTransfer`, `createBatchesFromBill`, `reconcileTransfersOnTheWay` in the stock sync). Tests: `tests/batch-transfers.test.ts` (in `test:zoho`) and
`tests/db/batch-transfers.db-test.mjs` (PGlite).

## Database

Migration `supabase/migrations/20261031190000_batch_tracking.sql` (applied 31 Oct 2026): batch
columns (godown, supplier, bill/PO, Zoho link, sold-out time), `batch_adjustments`, batch-number
function, FIFO allocation at the order's godown, server-only receipt / adjustment / Zoho-import
functions. Writes only through functions; batches are readable by admins only.

Tests: `tests/batches.test.ts` (in `npm run test:zoho`).
