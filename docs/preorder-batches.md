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

## Batch expenses and profit and loss

**For the owner.** On any batch, **Expenses › Add from Zoho Books** lists your Books expenses (freight, hamali,
unloading…) from the batch's date − 30 days; pick one, tick the batches it belongs to and save. **Bill charges** does the
same for the freight, hamali and transport lines of a supplier's bill, its discount and its round-off; in Receive purchase
those lines are ticked already and are tagged to the bill's batches when you save. Admin › Batches › **Expenses** shows
everything tagged (changed or deleted in Zoho first) and the Zoho expenses of a period that no batch carries (overhead).
Reading Books expenses needs **Admin › Zoho › Reauthorize Zoho** once; until then the Expenses screens say so, and bill
charges work without it.

**The amount counted** (`src/lib/batch-costs.ts`): before GST, plus the GST only when it can't be claimed back
(`itc_eligibility` starting `ineligible`, or the admin's choice). Reverse-charge GST is claimed, so freight under reverse
charge counts its amount before GST. An expense charged on to a customer (Books status `invoiced`) needs a tick. An
itemized expense (more than one line) is tagged line by line. A bill's discount is a negative cost, split by value; its
charges are split by bags.

**Split methods:** by bags (the default for one product), by value before GST (the default across products), by weight
(the product's pack weight in kg), typed amounts or percents (these may leave part untagged: overhead). Every split is in
whole paise with the largest-remainder rule, so the parts always add up. The server reads the expense from Zoho again
before every tag and works out the split itself; the database refuses more than the expense, the wrong sign, a cancelled
pre-order and non-administrators.

**Changes in Zoho** (`checkBatchCosts`, hourly when something is tagged and when the Batches page opens, at most every
30 minutes, `settings.batch_cost_check`): 1–3 expense list calls over the tagged dates and one bills list call; a document
whose edit time moved, or that is no longer listed, is read (at most 10 expenses and 5 bills). An amount that fell or rose
is flagged "Expense changed in Zoho: ₹A → ₹B; re-confirm the split"; a deleted expense counts 0; an account or date change
is flagged only. **Re-split** replaces the split (checked against Zoho's amount now); **Accept Zoho's amount** works once the
tags fit in it; **Untag** takes it off. Until then the profit counts each document at most Zoho's current amount:

```
S = Σ tags of the document;  cur = 0 if deleted, else its counted cost
target = sign(S)·min(|S|, |cur|) when the signs agree, else 0;  each tag's part of target in paise, by tag amounts
```

**Profit and loss** (`buildBatchReport` in `src/lib/batches.ts`, all before GST):

```
E (a batch's expenses) = its own tags (effective) + what came with units sent to it
E spread in paise over [sold, awaiting payment, sent on, lost, in stock]   (no units at all: all in stock)
the part on units sent on → the batches made from them, by units received; the rest is "on the way"
profit before expenses = sales − cost of sold − stock lost
profit after expenses  = profit before expenses − expenses on sold − expenses on lost
landed cost per unit   = cost before GST + E / units (expected for a pre-order, received for a sent batch, else purchased)
unsold stock at landed cost = stock value + expenses in stock
cost variance (a matched pre-order) = sold × (bill cost − estimate)
```

A pre-order batch has bought nothing yet (purchased 0, stock value 0, its quantity "expected"); its sales are costed with
the estimate and marked **Estimated** until its bill is matched. Expenses may be tagged to it before the bill (freight paid
ahead); at a partial match they split with it by bags, and at a join they move with it. A batch with tags can't be deleted
or cancelled: untag first. Totals add each batch's own tags only (the money tagged); the batch page's cost check shows
money in = money out (to ±₹0.05) when every unit is accounted for. Channel-partner commissions are not deducted (they stay
in the partner reports). The Excel download has the new columns, an **Expenses** sheet (one row per tag) and a
**Pre-orders** sheet (lots and remainders, waiting orders as counts only).

**Sugar S1 example:** ₹9,000 freight (reverse charge, claimed) + ₹1,800 hamali on 360 bags = ₹30.00 a bag. Bill cost
₹2,527.50 before GST → landed ₹2,557.50 against ₹2,610.48 sold before GST: ₹52.98 a bag after expenses, ₹82.98 before.

**Zoho Books fields** (read from the live organisation on 14 Nov 2026, read only): list rows carry `expense_id`, `date`,
`account_name` (no `account_id`), `description`, `reference_number`, `cf_expense` (the "Expense #", e.g. EXP-00126),
`currency_code`, `exchange_rate`, `total`, `total_without_tax`, `bcy_total`, `bcy_total_without_tax`, `status`
(`nonbillable`…), `is_billable`, `location_id`/`branch_id`, `created_time`, `last_modified_time`; no tax or line fields.
One expense (`GET expenses/:id`) adds `account_id`, `sub_total`, `tax_amount`, `amount`, `is_inclusive_tax`,
`itc_eligibility` (`eligible`), `is_reverse_charge_applied`, `reverse_charge_tax_id`, `gst_treatment`, `tax_treatment`,
`invoice_id` and `line_items[]` (`line_item_id`, `account_id`, `account_name`, `description`, `item_total`, `amount`,
`tax_amount`, `itc_eligibility`). Every expense seen had no GST, so the GST fields are parsed defensively.

| Part | Where |
|---|---|
| Rules (paise, splits, documents, effective amounts, flags) | `src/lib/batch-costs.ts`, tests `tests/batch-costs.test.ts` |
| Server (picker, tag, untag, accept, bill charges, the check) | `src/lib/batch-costs.functions.ts` |
| Screens | `src/components/batches/BatchExpenses.tsx`, `ExpensePicker.tsx`, `BillChargesPicker.tsx`, the charge lines in `ReceiveFromBill.tsx` |
| Database | `supabase/migrations/20261114100000_batch_expenses.sql`, tests `tests/db/batch-expenses.db-test.mjs` |
| P&L | `buildBatchReport` / `batchReportSheets` in `src/lib/batches.ts`, tests in `tests/batches.test.ts` |
