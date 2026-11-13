# Pre-order batches and bill matching

Client request ("Approved", 14 Nov 2026): sell goods that are ordered from a supplier but not yet at the godown, under a
batch made in advance; when the bill and the bags arrive, match the bill lines to that batch, or make new batches for
lines that have none.

## For the owner

1. **Switch it on** once: Admin › Settings › Pre-orders. It needs Zoho as the stock master and godown matching by PIN.
2. **New pre-order** (Admin › Batches): pick the godown, then a Zoho purchase order line or type it in: product, bags
   coming, expected cost per bag before GST, expected date, and how many to sell before arrival. The batch gets a normal
   number (CLK-141126-01). Recent bills of the product that are not received on the website are listed: receive each
   one first, or tick "Not this purchase".
3. **Customers order at once.** The shop shows "360 arriving by 20 Nov"; ready bags are always sold first. At checkout the
   customer ticks that the whole order is collected after the goods arrive (full refund if they don't come).
4. **Until the bags arrive** the order can't be packed or handed over, gets no delivery note or invoice QR, and its Zoho
   sales order stays a draft (no invoice, no package, Zoho stock never below 0).
5. **Type the bill in Zoho as usual.** The website sees Zoho's stock rise and holds it (it is not sold twice). Admin ›
   Batches shows "Zoho shows N more … than the website counts" with **Match now**.
6. **Receive purchase** opens the bill with each line set to "Match to pre-order CLK-141126-01". Tick that all bags are
   at the godown and press Save. A short bill keeps the rest as a smaller pre-order (-R1) or, if nothing more is coming,
   shrinks the batch (refused while customers bought more than the bill has).
7. **After the match** the batch takes the bill's cost before GST (sold bags are re-costed), waiting customers are told
   their goods arrived, and their orders go on to Zoho (invoice, pickup QR).
8. **Stop typing "YET TO COME" bills or stock in advance.** The pre-order batch replaces that.

## The stock model (per godown G and product P)

| Symbol | Meaning |
|---|---|
| Z | Zoho's available stock at G (read fresh, not floored) |
| W | units of website orders at G that Zoho does not hold yet, read **before** Zoho is read |
| U | units of P's pre-order batches at G still to come |
| I | arriving units not sold (their remaining) |
| held | a rise in Zoho the website has not explained yet (a bill typed but not matched): never sold as ready |
| T | `branch_stock.free_total`: everything that may be promised |

At every Zoho reading: hold step, then `T = Z − held − W + U`. Ready (`branch_stock.stock`) = `max(0, T − I)`;
arriving (`branch_stock.incoming`) = `min(sellable lot units, T)`. Falls in Zoho never reduce held. A match explains the
bill's units when Zoho made the bill after the watch opened. With no pre-order batch anywhere, everything works exactly
as before.

Worked example (Sugar S1 at CLK): Z 50 → lot 360 (T 410, ready 50, arriving 360) → order of 70 (T 340, ready 0,
arriving 340) → bill typed (Z 410, held 360, T 340) → match (held 0, T 340, ready 340) → invoiced (Z 340, T 340).

## Where things are

| What | Where |
|---|---|
| Database (lots, watch, hold step, match, guards) | `supabase/migrations/20261114110000_preorder_batches.sql` |
| The same rules for screens and tests | `src/lib/preorder.ts` (`tests/preorder.test.ts`, `tests/preorder-simulation.test.ts`) |
| Admin actions (setup, purchase orders, create, edit, cancel, join, move to ready, release, unmatch, stock maths) | `src/lib/preorder.functions.ts` |
| Bill check, readings, receive and match, hourly pull, staff count, order push | `src/lib/zoho-commerce.functions.ts` (`preorderZohoKit`, `syncPreorderPair`, `createBatchesFromBill`) |
| Every 15 minutes: arriving re-worked out, overdue alerts | `src/routes/api.zoho.sync.ts` (`refresh_incoming_all`) |
| Screens | `src/components/batches/IncomingBatchDialog.tsx`, `PreorderPanel.tsx`, `ReceiveFromBill.tsx`, `ComingToGodown.tsx`, `src/routes/admin.batches.tsx` (Pre-orders tab) |

## Zoho calls

The hourly pull needs no extra call for watched products. A new pre-order reads one item, 1–3 pages of recent bills and
at most 15 bills (their lines are cached in `zoho_bill_line_cache` until Zoho's edit time moves), plus the purchase order
when one is used. Every pre-order and bill action waits while Zoho's daily limit is reached.

## Batch expenses

Migration `20261114100000_batch_expenses.sql` holds Zoho Books expenses and bill charge lines tagged to batches. The
screens and the profit and loss come in a later build; the permission `ZohoBooks.expenses.READ` is already asked for, so
the owner presses **Admin › Zoho › Reauthorize Zoho** once after this release.
