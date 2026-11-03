# Rice sample and purchase desk

Admin > Rice Samples (`/admin/rice-samples`). The client's note, 2 Nov 2026:

> Rice - Samples - Arrival with purchase price, quantity avl, from broker, contact of him. We cook & test rice, update results, sort out in dashboard. If rice is selected for purchase push the data to Zoho purchase order. Give option to discard or mark unavailable if broker or seller notifies.

Files: `supabase/migrations/20261103100000_rice_samples.sql`, `src/lib/rice-samples.ts` (the rules, no framework, tested by `tests/rice-samples.test.ts`), `src/lib/rice-samples.functions.ts` (server), `src/routes/admin.rice-samples.tsx` (page).

## What a sample holds, and why these cook test fields

Price is rupees per quintal (100 kg) before GST, the same unit as `price_lots`. A figure outside ₹1,500 to ₹20,000 per quintal, which usually means a price per kg or per bag, is questioned while typing and again at the purchase order. Each sample gets a short number (S-12) to write on its bag, so a test lands on the right one.

A cook test takes five taps in the godown, and every test is kept:

| Field | Why it helps the decision |
| --- | --- |
| Score, 1 to 10 | The one number the list sorts by. With four samples on the table, this is the shortlist. |
| Grain after cooking: separate, slightly sticky, sticky | The first thing a customer notices in rice, and what separates grades of the same variety. |
| Swelling after cooking: good, OK, poor | How far a bag goes on the plate, which is what hotels and caterers pay for. |
| Taste and smell: good, OK, off | Off usually means old or badly stored stock. It is a warning whatever the score says, so it stands alone and is repeated on the confirmation screen. |
| Broken grains: few, some, many | What the price should reflect, and a point to bargain on. |
| Notes, tested by, when | Anything else (water, cooking time), and who to ask. |

Left out on purpose: water ratio, cooking time, colour, moisture and new or old crop as separate fields. They slow the form down for a judgement the score already holds, and notes can carry them. If the client measures these every time, adding one is a small change (question 6 below).

The newest test decides the score. A retest replaces the opinion, and the earlier test stays in the history.

## Status

`arrived`, `tested`, `selected` (PO raised), `discarded` (reason required), `unavailable`. Who and when for each is in `rice_sample_events`. Unavailable and discarded can both be reopened until a purchase order exists. The brief asked for this on unavailable; discarded was added because a mistaken discard should not lose the tests. After a purchase order is raised, the database refuses any change to the sample.

## What Zoho's documents say

Read 2 Nov 2026 at <https://www.zoho.com/inventory/api/v1/purchaseorders/> and its OpenAPI file `purchaseorders.yml`, plus `contacts.yml` and `items.yml`.

| Question | Zoho's words | What the code does |
| --- | --- | --- |
| Scope to create | "OAuth Scope : ZohoInventory.purchaseorders.CREATE" | Added, with `.READ`. Owner re-authorizes once. |
| Issue | "Marks a Purchase Order as Issued." at `POST /purchaseorders/{id}/status/issued`, scope `.CREATE` | Only when the setting is on. |
| Required fields | The schema lists `purchaseorder_number`, `vendor_id`, `line_items`. | See the next row for the number. |
| Number | "Ignore auto purchase order number generation for this purchase order. This mandates the purchase order number." | The flag is what makes a number mandatory, so without it Zoho numbers it. None is sent, which keeps the client's own series (live POs read `PO-0211260148`). **The schema and this sentence disagree: the first live test settles it.** A refusal comes back in plain words and creates nothing. |
| Must a line have `item_id`? | Line items have no required fields in the schema, and a live PO shows `non_catalog_items_count`. | The docs allow a line without one, but the code always sends it: without an item Zoho's stock and bills cannot follow the purchase. |
| Rate | The doc's example has `purchase_rate` and `bcy_rate`. A live PO's line reports `rate` and `bcy_rate`, with no `purchase_rate`. | Sends both `rate` and `purchase_rate`, then compares what Zoho saved with what was confirmed. **To confirm on the first live test.** |
| GST | `source_of_supply`: "If not given, place of contact given for the contact will be taken". `destination_of_supply`: "If not given, organisation's home state will be taken". | Not sent, so Zoho takes them from the vendor and the organisation, as on the client's POs. `tax_id` is not sent either, on the assumption that Zoho applies the item's GST choice. **To confirm on the first live test**, which compares the tax Zoho shows. |
| Location | `location_id`, at the top and on the line: "Location ID" | Sent in both places. A godown with no Zoho location is refused, because without one the stock would land at Head Office. |
| Draft and issued | Create returns the document with `"status_formatted": "Draft"`, and "Mark as Issued" is a separate call. A live issued PO reads `status: "open"`. | Created as Draft; `open` shows as "Issued". |
| Finding one again | The Inventory list documents only `page` and `per_page`. The Books list documents `reference_number`. | Tries `reference_number` for a quick yes. A "no" only counts after reading every page, matching the exact reference here. |
| Response key | Create answers `purchase_order`. A live `GET` answers `purchaseorder`. | Reads both. |

Facts from the client's live Zoho, read-only on 2 Nov 2026: purchase orders use a bulk item with unit `qtl` (Sugar, description "QUINTAL PRICE"), every one recent is at location Head Office, none uses Reference#, and the four rice items in Zoho are sold per bag or packet with no `qtl` item among them. So a purchase order for rice needs either a new bulk rice item or a conversion from quintals to bags. The page handles both and shows the result before anything is raised.

## How a second purchase order is stopped

1. **Lock in the database.** `rice_sample_purchase_orders` has one row per sample. `rice_sample_po_claim` locks the sample's row, then answers `claimed`, `in_progress`, `already_raised` or `verify_first`. Only `claimed` may send. A browser cannot call it, even an admin's.
2. **The sample's ID goes to Zoho as Reference#**: `GBS-<sample id>`.
3. **No answer is not a no.** A timeout, a network failure, a 5xx or an answer that cannot be read becomes `uncertain`. The sample stays locked and Zoho is searched by reference at once. Sending again needs a complete search that started at least two minutes after the last send and found nothing. The database enforces the two minutes (`rice_sample_po_takeover`, `rice_sample_po_release`), and the admin must confirm again.
4. **Clear refusals are safe to retry.** 4xx means nothing was created. It is recorded as `rejected`, and the admin can correct it and retry. Any second attempt searches Zoho first, in case an earlier send landed late.
5. **If a late send lands anyway**, which Zoho's lack of a unique reference allows, the resend searches again straight after creating. Both show on the sample in red with the instruction to delete one.

Zoho does not enforce unique references, so step 5 detects this rare race and does not prevent it. Sending our own purchase order numbers would make Zoho refuse a duplicate (if its "prevent duplicates" setting is on), at the cost of breaking the client's series. Numbering stays Zoho's unless the client prefers otherwise (question 5).

After a purchase order exists the server sends nothing more to Zoho for that sample except status reads, which are shown read-only.

**The way out.** When a complete search finds nothing, Check Zoho frees the sample: it can be raised again, discarded or marked unavailable. If the search cannot finish at all (Zoho's list failing, or more than 5,000 purchase orders), an admin can search Zoho by hand and confirm the reference is not there. That is the only manual override. It goes on the sample's history by name, and the two minutes still apply.

A new vendor or item has the same protection (`rice_sample_zoho_creations`), an exact-name search just before creating, and an on-screen confirmation first.

## Who can see what

Only admins can read these tables (row security, tested on a full copy of the migrations against anon, customer, vendor, channel partner and godown staff). Nobody writes to them directly: admins go through `rice_sample_save`, `_add_test` and `_set_status`, and the purchase order functions run only as the service role. The tables are not in the realtime publication.

Nothing internal reaches the vendor: the purchase order carries the rice, quantity and rate, but no scores or tasting notes.

## Going live (owner's steps, only after an explicit OK)

1. Check Hostinger's deployment history and build the zip from a commit containing the latest `main`. Other sessions upload too.
2. Apply `20261103100000_rice_samples.sql` to the live database, then upload the zip.
3. **Re-authorize Zoho once:** Admin > Zoho Commerce > press **Reauthorize Zoho** > on Zoho's page check that it lists Purchase Orders and press **Accept**. The page returns to the admin panel showing Connected. Until this is done, the buy screen says so as soon as it opens, and nothing else on the site is affected.
4. Confirm the godowns: Admin > Branches, each receiving godown needs its Zoho location linked.
5. Run the first live test below, with the owner watching.

## First live test (not run; needs the owner's OK for that specific call)

**Before going live:** Zoho also shows a separate organisation "Shami Business - Sandbox" on this account, but it has no Inventory, locations or GST, so it would not prove these points. The test below uses the live books and the smallest possible order.

1. Ask the client which vendor and rice item to use, and to expect one draft purchase order.
2. On a phone, add a sample with a real vendor, quantity **1.255 quintal** and the real rate, so the test also shows whether Zoho keeps three decimals. Add one cook test.
3. Press Buy this and pick the existing vendor and item (or create one, only if the client agrees). Read every line of the confirmation aloud with the owner. Press **Raise purchase order once**.
4. In Zoho, open the purchase order from **Open in Zoho** and check, against this list:
   - Status **Draft**, with the number from the client's own series. This settles the `purchaseorder_number` question.
   - Reference# is `GBS-` plus the sample's ID, in full.
   - Vendor, item, quantity, unit and rate are as confirmed. This settles `rate` and `purchase_rate`.
   - Location is the receiving godown, not Head Office.
   - GST is what the client expects for this vendor and item, and CGST/SGST or IGST is right for the vendor's state. This settles `tax_id`.
   - The description prints acceptably on the PDF the vendor would receive.
5. On the site, check the sample says PO raised and is locked, and that Admin > Zoho API Calls shows "Rice sample purchase order".
6. Press **Refresh status**. Besides the status, it searches Zoho by the reference, read-only, and says so if it cannot find this purchase order. That proves on real data the search a lost answer depends on.
7. Delete the draft in Zoho if the client does not want it. Refresh status then shows Deleted in Zoho. Stop and report if anything differs.
8. If a new vendor or item was created, check it is not on the storefront. The item is created without any storefront setting, because Zoho's item docs do not list one.

## Questions for the client

1. **Who is the vendor on the purchase order: the broker or the seller?** The screen makes the admin choose, and says the vendor is who bills you. If it is always the mill, the broker option can go.
2. **Which Zoho item should rice purchases use?** Zoho's rice items are retail bags. Sugar uses one bulk item per quintal. A similar bulk item per variety would match, and adding one takes a tap and a confirmation here.
3. **Draft, or issued straight away?** Default is Draft. The owner is being asked. One setting at the bottom of the page changes it. Either way Zoho does not send the purchase order to the vendor by itself: someone sends it from Zoho.
4. **Which location receives the rice?** Recent live purchase orders are all at Head Office. This page uses the receiving godown's Zoho location. Is that what the accounts expect?
5. **Is Zoho's own PO numbering right?** It keeps the series unbroken. If the accountant would rather have numbers from the website, Zoho can then refuse duplicates outright.
6. **Is GST 5% right for bulk rice purchases?** Existing rice items use 5%. A new item here has no default: the admin chooses 5% or "set later in Zoho", because bulk rice may be taxed differently from packed rice. This is for the accountant. A nil rate is set in Zoho, because it needs Zoho's own exemption setting.
7. **Do you record water ratio, cooking time or moisture every time?** If so, each can be its own field.
8. **Should a sample need a cook test before it can be bought?** Today the confirmation warns but allows it.
9. **Who enters cook tests?** Today it needs an admin login, which can also raise purchase orders and see prices. If godown staff should enter tests, a test-only login is a separate small piece of work.

## Possible next step, not built

When a purchase order is raised, the page could offer to start a `price_lots` row (price, quantity, godown) or a batch when the rice arrives. Neither is fed automatically today: the purchase may change in Zoho after the draft, and both tables drive selling prices and stock.

## Testing

`npm run test:zoho` includes `tests/rice-samples.test.ts`: the engine against a fake Zoho and an in-memory copy of the lock. The database itself (row security, lock, guards) was tested on PGlite with all migrations, and the page on a local stand-in database with a fake Zoho at 375 px and desktop. Nothing here has run against the real Zoho.
