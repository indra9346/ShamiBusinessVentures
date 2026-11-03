# Delivery notes and delivery slips

The client's handwritten rules (2 Nov 2026):

> Option to generate delivery note only after full invoice amount is paid. Partly paid - Do not generate, show them to make complete payment.

> Generate different delivery slips for each item & delivery note, time should be printed.

## How paid amount and invoice total are really recorded

Money is written in two places that only partly talk to each other.

| Where | Holds | Written by |
|---|---|---|
| `orders.total`, `paid_amount`, `balance_due`, `payment_status` and one `payments` row per receipt (`status = 'Paid'`, with its UTR) | The website's view | `admin_confirm_manual_payment` (part or full), `private.confirm_held_payment` (full, from a checked UTR or bank alert), the coupon path (`Paid` with nothing to pay and no `payments` row) |
| Zoho Books invoice: `total`, `balance`, `status` | The official invoice | Zoho. The website pushes its receipts there at sync (`ensureZohoBooksInvoice`) and writes off GST rounding of up to ₹1 |
| `zoho_order_invoices` | The website's copy of the Zoho invoice | `recordZohoInvoiceState`, when an order is opened or synced |

So:

- A payment confirmed on the website reaches Books only at the next sync.
- A payment entered directly in Books **never** reaches `orders.paid_amount`. It reaches only `zoho_order_invoices`.
- A website checkout can only be paid in full: the guard lets `Awaiting Payment` leave only by full payment or by ending. A website part payment happens only on an order an admin entered, through Admin > Payments & Matching. Zoho Books can hold a part payment on any order.
- Refunds have no code path. `payment_status = 'Refunded'` has only ever been set by hand in SQL.

That is why `payment_status` alone proves nothing, and why the gate compares both sides.

## The gate

`private.delivery_note_gate(order, zoho reading)` in `supabase/migrations/20261103090000_delivery_notes.sql` is the only thing that decides. The browser and the server code only put its answer into words (`src/lib/delivery-notes.ts`).

Each press reads Zoho (sales order, then Books' own invoice record; both reads only) and hands that to the database. The order stays locked from the check to the insert. The database functions take a Zoho reading as an argument, so only the service role may call them; a browser can't pass in a made-up one.

Only `paid` allows a note. It needs all of these:

- Order status is confirmed (`Payment Confirmed` through `Delivered`), and the order has lines.
- `paid_amount` equals the sum of its `Paid` payments, and `payment_status` agrees.
- Paid amount is at least the order total.
- Exactly one live Zoho invoice, not a draft, read just now.
- Zoho status `paid` with balance 0. A missing amount never reads as zero.
- Invoice total within ₹1 of the order total (Zoho rounds CGST and SGST separately).

| Situation | Code | Note? |
|---|---|---|
| Unpaid | `unpaid` | No |
| Partly paid, records agree | `partly_paid` | No: shows paid, balance, and to complete payment |
| Fully paid, both agree | `paid` | **Yes** |
| Overpaid, Zoho paid | `paid` with `overpaid` | **Yes**, admin is told the excess |
| Refunded | `refunded` | No |
| A return on the order refunded | `return_refunded` | No |
| Cancelled | `cancelled` | No |
| Payment time ran out | `payment_expired` | No |
| Checkout waiting, or `Placed` | `not_confirmed` | No |
| Paid, no invoice yet | `no_invoice` | No |
| Paid, invoice still a draft | `invoice_draft` | No |
| Paid, Zoho can't be read | `zoho_unreadable` | No |
| Paid here, Zoho still shows money due | `zoho_behind` | No: re-sync |
| Zoho paid, website not | `website_behind` | No: record the payment with its UTR |
| Zoho has a part payment, website nothing | `zoho_has_payment` | No |
| Both part paid, different amounts | `payment_mismatch` | No |
| Two live invoices | `several_invoices` | No |
| Zoho's figures don't add up or are missing | `zoho_inconsistent` | No |
| Invoice total over ₹1 off the order | `totals_differ` | No |
| Website's own records disagree | `records_disagree` | No |
| Order has no lines | `no_items` | No |

## After a note exists

- The note is never changed or deleted, even by the service role, and neither is its number or history. An order with a note can't be deleted.
- The check runs again on every view and every print. If it is no longer clean, the paper and the admin screen say so in plain capitals (`paperWarnings`), for example `ORDER CANCELLED. DO NOT DELIVER.` Reprints are never refused: they carry the warning.
- Triggers on `orders` and `zoho_order_invoices` write the change to the note's history and notify admins. Normal progress (Packed to Dispatched) raises nothing.
- Admin > Delivery Notes lists every note in number order and flags the ones needing attention, from what the website last read from Zoho. Opening the order reads Zoho again.

## Documents

- One note per order, number `DN-000001` from a one-row counter updated in the same transaction, so a failure takes the number back. No gaps, no reuse, no reset.
- Content is a snapshot fixed at generation. If lines or the invoice change later, the print says so.
- One slip per item line, each on its own page: "Slip x of y".
- **Printed time** is the moment of the press, from the database clock, in IST with seconds. The browser's own print menu is covered too: the `beforeprint` handler stamps the time from the server-corrected clock and records the print. **Generated time** stays on the paper too.
- Copy 1 is the original. Each later copy of the note, and of each slip, is marked `Reprint, copy n`.
- Who and when is in `delivery_note_events`.

## Zoho packages and shipments

Separate and untouched. Website `Packed` still makes a Zoho package, and `Dispatched` a shipment (`pushZohoFulfilment`). A delivery note changes no order status and makes no Zoho call except the two reads above. It isn't a Zoho document and has its own number.

## Testing

`tests/delivery-notes.test.ts` is in `npm run test:zoho`: the words, the paper's warnings, IST formatting, slip numbering, reading Zoho's figures, and a check that every database answer has its own words.

The gate itself needs a database. The run for the PR used PGlite with all migrations and Supabase-like default privileges, and the same setup backs the local preview. That harness isn't in the repo because PGlite isn't a dependency here.
