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

Generate, Print and Check again read Zoho (sales order, then Books' own invoice record; both reads only) and hand that to the database. The order stays locked from the check to the insert. Just opening a page uses what the website last read from Zoho, so it adds no Zoho call; that reading can show a state but can't generate a note. The database functions take a Zoho reading as an argument, so only the service role may call them; a browser can't pass in a made-up one.

Only `paid` allows a note. It needs all of these:

- Order status is confirmed (`Payment Confirmed` through `Delivered`), and the order has lines.
- `paid_amount` equals the sum of its `Paid` payments, and `payment_status` agrees.
- Paid amount is at least the order total.
- No office stop on the order, and no refund started or made on a return of it.
- No payment's bank UTR is also on another order, however it was typed. Short manual references (under 12 characters) aren't compared, because exact repeats are refused when entered and look-alikes aren't the same money.
- No bank alert for one of its UTRs shows less than was recorded, unless the office has settled that alert with a note.
- Exactly one live Zoho invoice, not a draft, read just now, and not already on another note.
- Zoho status `paid` with balance 0, and `payment_made` covering the invoice total less ₹1. A credit note or a big write-off also makes Books say "paid", so status alone isn't money. A missing amount never reads as zero.
- Invoice total within ₹1 of the order total (Zoho rounds CGST and SGST separately).

| Situation | Code | Note? |
|---|---|---|
| Unpaid | `unpaid` | No |
| Partly paid, records agree | `partly_paid` | No: shows paid, balance, and to complete payment |
| Fully paid, both agree | `paid` | **Yes** |
| Overpaid, Zoho paid | `paid` with `overpaid` | **Yes**, admin is told the excess |
| Refunded | `refunded` | No |
| Stopped by the office | `stopped` | No |
| A refund started or made on a return | `return_refunded` | No |
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
| Books says paid, but a credit note or write-off closed it | `zoho_not_money` | No |
| Invoice already on another order's note | `invoice_used` | No |
| Same bank transfer on another order | `utr_reused` | No |
| Bank alert shows less than was recorded | `bank_credit_short` | No |
| Invoice total over ₹1 off the order | `totals_differ` | No |
| Website's own records disagree | `records_disagree` | No |
| Order has no lines | `no_items` | No |

## After a note exists

- The note is never changed or deleted, even by the service role, and neither is its number or history. An order with a note can't be deleted.
- The check runs again on every view and every print. If it is no longer clean, the paper and the admin screen say so in plain capitals (`paperWarnings`), for example `ORDER CANCELLED. DO NOT DELIVER.` Reprints are never refused: they carry the warning.
- Triggers on `orders`, `zoho_order_invoices`, `return_requests` and `bank_credits` write the change to the note's history and notify admins. Normal progress (Packed to Dispatched) raises nothing. A failure in these only logs a warning: it can't stop the order, invoice or bank change.
- The site has no way to record a refund or a dispute, so the order page has **Stop delivery**, with a reason. A stop refuses a new note and warns on every later print. It changes nothing about the order or its payment, and it can be lifted with a reason. Every stop and lift is kept.
- Admin > Delivery Notes lists every note in number order and flags the ones needing attention, from what the website last read from Zoho. Opening the order reads Zoho again.

## Documents

- One note per order, number `DN-000001` from a one-row counter updated in the same transaction, so a failure takes the number back. No gaps, no reuse, no reset.
- Content is a snapshot fixed at generation. If lines or the invoice change later, the print says so.
- One slip per item line, each on its own page: "Slip x of y".
- **Printed time** is the moment of the press, from the database clock, in IST with seconds. **Generated time** stays on the paper too.
- Paper prints only for 5 minutes after a press of Print, which re-checks the payment and records the copy first. If the record fails, nothing prints. Otherwise the browser's own print menu gets a line saying to use the button, so a tab left open can't print a stale check or an unrecorded copy. It can't be one print per press, because phones ask for the page more than once. So within those 5 minutes the browser's menu can repeat the same paper, with the same time and copy number, unrecorded.
- Copy 1 is the original. Each later copy of the note, and of each slip, is marked `Reprint, copy n`. A press counts as a copy even if the print screen is then cancelled.
- Who and when is in `delivery_note_events`.

## QR codes and the godown check

The client's words (10 Nov 2026): "Delivery slips with unique qr so scanned which is in system recognized then green signal duplicate delivery copies will be avoided if we use this system for delivery notes."

`supabase/migrations/20261110120000_delivery_paper_qr.sql` decides; `src/lib/delivery-papers.ts` puts its answers into words; the scan page is `/slip`.

- **Every printed paper has its own code.** Each press of Print gives the note and each slip it prints a new random code: 22 characters from `gen_random_uuid` (122 random bits). The QR is a link, `https://grainbazar.com/slip#<code>`. The code goes after `#`, so it never reaches a server log or analytics. The database keeps only the code's SHA-256 hash (`delivery_paper_codes`). Nothing in the database can be turned back into a working QR, and no order or note number can be.
- **Only the newest copy works.** Printing a paper again cancels the code on every earlier copy of that paper. Those scan red as "old copy, cancelled", naming the copy that replaced them. The paper says so too: "Copy 3: copies 1 to 2 are cancelled." So a reprint never makes a second paper that scans green. A paper that was never really printed (a cancelled print screen, a jammed printer) needs no special step: print it again.
- **Each item is handed over once.** `delivery_handovers` holds at most one row per note line (a unique key). The scan locks the note's row from the check to the insert, so two people scanning at the same moment can't both record it: the second is told it was already handed over, by whom and when. The note's QR covers all its lines; a slip's QR covers its own line.
- **Green only after recording.** A first scan says "Genuine · not handed over yet" (white) and shows the item and quantity. Green appears only after **Hand over now: record it** is pressed and the database has recorded it. So "no green, no goods" is a rule the godown can follow, and green can't be shown to two people.
- **Every scan re-checks the order.** The delivery-note payment check runs again (`private.delivery_note_state`). A cancelled, refunded or stopped order, or one void in Zoho, scans red. Payment records that need checking, or items or an invoice changed after the note, scan amber. A handover reads Zoho Books first (read-only). If Zoho can't be read, the website's last reading is used, and the handover and the green screen say so.
- **Who may scan.** Administrators, and active godown staff (`staff_employees`). Staff can hand over only their own godown's goods; another godown's paper is amber. Anyone else gets "Sign in to check this paper" and learns nothing about it.
- **Every scan is kept** in `delivery_scans`: who, when, which godown, which paper and copy, and the answer, including codes that are not in the system (only the start of their hash). Admin > Delivery Notes lists the latest scans and flags unknown codes; the order page lists each item's handover and its scans. None of this can be changed or deleted.
- **Scan with the page's own scanner.** The staff app has **Hand over goods: scan the slip**, which opens `/slip` with a camera scanner (the browser's own QR reader; Chrome on Android has one). It refuses a QR that leads to another website: a forged paper can lead the phone's camera app to a fake page that shows green. The real page always shows the scanner's own name and godown at the top, from the server's answer. Where the browser has no QR reader (iPhone Safari), the phone's camera app opens the link, and the code can also be pasted.
- **Reprints after a handover** still print, for records, with "ALREADY HANDED OVER … FOR RECORDS ONLY. DO NOT DELIVER AGAIN." on the slip, and "ITEM 1 ALREADY HANDED OVER. DELIVER ONLY THE REST." on the note. They scan red.

Answers (`public.delivery_paper_scan`), first match wins:

| Answer | Screen | When |
|---|---|---|
| `unknown` | Red: not a genuine paper | The code isn't one the system made |
| `already_handed_over` | Red: already handed over, do not give again | Every line the paper covers is handed over |
| `replaced` | Red: old copy, cancelled | A newer copy of this paper was printed |
| `order_problem` | Red or amber: do not hand over | The payment check isn't clean, or the order is void in Zoho |
| `other_godown` | Amber: another godown's paper | A staff member of a different godown |
| `ready` | White: genuine, not handed over yet | May be handed over (nothing recorded yet) |
| `handed_over` | **Green: hand over the goods** | Recorded just now |

There is no way to undo a handover, and a handed-over line never scans green again.

## Zoho packages and shipments

Separate and untouched. Website `Packed` still makes a Zoho package, and `Dispatched` a shipment (`pushZohoFulfilment`). A delivery note changes no order status and makes no Zoho call except the two reads above. It isn't a Zoho document and has its own number.

## Testing

`tests/delivery-notes.test.ts` is in `npm run test:zoho`: the words, the paper's warnings, IST formatting, slip numbering, reading Zoho's figures, and a check that every database answer has its own words.

The gate itself needs a database. The run for the PR used PGlite with all migrations and Supabase-like default privileges, and the same setup backs the local preview. That harness isn't in the repo because PGlite isn't a dependency here.

The QR codes: `tests/delivery-papers.test.ts` (in `test:zoho`) holds the words and the reading of scanned QR codes to the migration. `tests/db/delivery-paper-qr.db-test.mjs` runs the scan, print and handover functions on PGlite (`PGLITE_PATH=… node tests/db/delivery-paper-qr.db-test.mjs`). `tests/db/delivery-paper-race.pg-test.mjs` needs a real, throwaway PostgreSQL server, because PGlite has only one connection. It has 20 connections hand over one slip at the same instant (exactly one succeeds), makes a second handover wait for an open one, and races a reprint against the old copy (`PG_URL=postgres://postgres@localhost:<port>/postgres PG_MODULES=<node_modules with pg> node tests/db/delivery-paper-race.pg-test.mjs`).
