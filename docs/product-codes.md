# Product codes: decisions

Master list of product names and codes, kept by admin at **Admin → Product Codes**. Client's request, 2 Nov 2026. The rice seed is the client's workbook `tests/fixtures/Rice_Product_Codes.xlsx`, and a test holds the seed to that file.

`code = [set prefix][method letter][variety letter][serial]`. Example: RS01 = Raw Rice + Sona Rice + 01.

## What a code is

A code names the rice: its method, its variety and its grade. It does not name a pack, a purchase or a seller.

| Thing | What identifies it |
|---|---|
| The rice | Product code, e.g. RS01 |
| A sellable item (one pack size, one price, one stock figure) | SKU |
| A purchase of stock | Batch number (Admin → Batches) |

## Pack sizes: one code across 25 kg and 50 kg

Here each pack size is its own product, with its own SKU, price and stock. There are no variants in this catalogue. So **RS01 goes on both the 25 kg and the 50 kg product**, and those stay two products with two SKUs. The code is the same because the rice is the same.

Two active products with the same code and the same pack size are probably a mistake, so the form warns and asks for a tick before saving. It does not refuse, because two sellers can honestly sell the same rice in the same bag.

*Question for the client: is this right, or should each pack size have a code of its own?*

## What the serial means

The workbook only says "Serial 01". This build treats a serial as **another grade or quality of the same method and variety**: RS01 and RS02 are both Raw Sona, different grades. It is not a purchase lot: Batches already does that job. The next serial is always the next number, and a retired number is never used again.

*Question for the client: is a serial a grade, or do they use it for something else, such as a mill or a brand?*

## Codes never change

The workbook updates every code when a letter changes. Here that is blocked, because codes are printed and spoken:

- A letter can be edited only until the first code uses it. After that it is locked in the database. A name can still be corrected, with a tick saying it is the same thing, and not while retired.
- The code text is worked out by the database when the row is made and is fixed from then on.
- A code is never deleted, only retired. A retired code keeps its number, and a retired method or variety keeps its letter.
- To change a letter: retire that method or variety, create a new one with the letter you want and the same name, make its codes, then move products over on Edit Product. Nothing moves by itself.

Retiring a code changes no product. Products carrying it keep it and go on selling, and new products can't choose it.

## Live products

Nothing here changes a live product by itself: no name, SKU or image.

- Adding a product, the code fills the form, and the admin can change anything before saving.
- Editing a product, the code goes on and nothing else moves. The list's name, subcategory, description or image each need their own tap. Saving only a code changes that one field, through `admin_set_product_code`.
- Changing a code's name or images in the list doesn't touch products already carrying it.
- A code can bring a subcategory its category doesn't list yet (Half Boiled, Boiled, Broken). It is added to the category when a new product uses it, or when an admin takes it on an existing product, and shows as a filter on the store.

## Images

A code can hold up to 8 images. A product holds one image today, so the form uses the first and lets the admin tap another.

## Zoho

The code stays in its own field, `payload.productCode`. It is not the SKU, and **no code is sent to Zoho**.

Why the code can't be the SKU:

- Zoho items are matched by SKU (ignoring case and spaces at the ends) when a product is first linked and on every order line.
- The product sync refuses when two Grain Bazar products share a SKU (`SKU … is used by 2 Grain Bazar products`). With one code across 25 kg and 50 kg, both products would stop syncing.
- Name and SKU sync both ways, so changing a linked product's SKU would rewrite the Zoho item.

The code can't disturb the sync as it stands: it isn't among the values the sync compares or sends, and a Zoho update merges into the product and leaves the code in place. Setting a code changes only that field, not `updated_at`, and runs no push, so "latest edit wins" can't flip. If the server writes a whole product from a copy read a moment earlier, the database keeps the code the product has now. Taking the list's name or description on Edit Product does reach Zoho, like any other edit of those fields.

**Should codes reach Zoho? That is the owner's decision.** Recommendation: not yet. If staff want to see the code in Zoho, add a Zoho custom field on items and send it there, one way, after trying it on one item. Don't use the SKU.

## Other categories

Sets are per category. Rice is the only one seeded; Sugar, Oil and the rest start empty and admin creates them. Codes are unique across all categories, so a Sugar set with the same letters would collide with Rice (RS01). A set can have a prefix of up to 3 letters to keep them apart (U makes URS01). The prefix locks once the set has codes.

A set is tied to the category's name. If a category is renamed, the page warns and offers to move the set, and until then its codes can't go on new products. Existing products don't follow a rename either: that is how categories already work here.

## Who can use it

Admin only, reading included, enforced by database row rules. Sellers, customers and visitors get nothing, and a seller can't set, change or clear a code on their own product. One gap, only if the seller marketplace is switched on: a seller can delete their product and add it again, and the new one has no code.

The code on a product is visible in the product's public data, as the SKU is. The storefront doesn't show it.

## For other pages

`listActiveRiceOptions()` and `listActiveCodeOptions(category)` in `src/lib/product-codes.ts` are the stable read-only list, meant for the sample and purchase desk. Admin only: anyone else gets an empty list.

## Tests

- `npm run test:zoho` includes `tests/product-codes.test.ts`: the seed against all three workbook sheets, the rules, and that the Zoho code can't see the field.
- `tests/db/product-codes.db-test.mjs`: the migration on a real Postgres (PGlite) with every migration before it, with Supabase's default privileges, as the anon and authenticated roles under row rules. Not part of `test:zoho`, because PGlite isn't a dependency. Run it with `PGLITE_PATH` set to a folder holding `@electric-sql/pglite`. It runs on one connection, so two admins acting at the same moment are not exercised.
