import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addGst, couponDiscount, lineFigures, lineGstInside } from "../src/lib/pricing.ts";
import { kn } from "../src/lib/i18n-kn.ts";

// Every selling price includes GST (owner, 7 Nov 2026): a ₹130 item costs the customer ₹130.
test("a line's price holds its GST: ₹130 at 5% is ₹123.81 + ₹6.19", () => {
  assert.deepEqual(lineFigures(130, 1, 5), { gross: 130, gst: 6.19, taxable: 123.81 });
  assert.deepEqual(lineFigures(2700, 2, 5), { gross: 5400, gst: 257.14, taxable: 5142.86 });
  assert.deepEqual(lineFigures(112, 1, 12), { gross: 112, gst: 12, taxable: 100 });
  assert.deepEqual(lineFigures(50, 2, 0), { gross: 100, gst: 0, taxable: 100 });
  // The same per-line rounding as the database: 11 x ₹130 is one line (₹68.10 GST), not 11 x ₹6.19.
  assert.equal(lineGstInside(130, 3, 5), 18.57);
  assert.equal(lineGstInside(130, 11, 5), 68.1);
  assert.notEqual(lineGstInside(130, 11, 5), Math.round(11 * lineGstInside(130, 1, 5) * 100) / 100);
});

test("the Pricing sheet's before-GST price gets GST added when it is set", () => {
  // Hubli S1: ₹2,617.13 before GST is ₹2,747.99 to the customer, as before the change.
  assert.equal(addGst(2617.13, 5), 2747.99);
  assert.equal(addGst(100, 12), 112);
  assert.equal(addGst(100, 0), 100);
  // And back: the GST inside the customer's price is the GST the sheet added (to the paisa).
  assert.equal(lineFigures(addGst(2617.13, 5), 1, 5).taxable, 2617.13);
});

test("a coupon goes by the goods total the customer sees", () => {
  const ten = { type: "Percentage", value: "10%", max: 500, uncapped: false } as Parameters<
    typeof couponDiscount
  >[0];
  assert.equal(couponDiscount(ten, 1040), 104);
  assert.equal(couponDiscount(ten, 9000), 500);
});

test("cart and checkout no longer add GST on top", () => {
  for (const file of ["src/routes/cart.tsx", "src/routes/checkout.tsx"]) {
    const page = readFileSync(file, "utf8");
    assert.doesNotMatch(page, /subtotal \+ (delivery|shipCost) \+ tax/, file);
    assert.match(page, /Subtotal \(incl\. GST\)/, file);
    assert.match(page, /Includes GST of /, file);
  }
  assert.doesNotMatch(
    readFileSync("src/routes/product.$id.tsx", "utf8"),
    /added at checkout|GST calculated at checkout|\+ GST from Grain Bazar/,
  );
  assert.doesNotMatch(
    readFileSync("src/components/site/StickyCartBar.tsx", "utf8"),
    /\+ GST at checkout/,
  );
});

test("Zoho gets the order's own tax mode, and Google sees prices with GST", () => {
  const zoho = readFileSync("src/lib/zoho-commerce.functions.ts", "utf8");
  assert.equal(
    (zoho.match(/is_inclusive_tax: Boolean\(order\.prices_include_gst\)/g) ?? []).length,
    2,
    "create and update of a sales order",
  );
  assert.doesNotMatch(zoho, /is_inclusive_tax: false/);
  assert.match(readFileSync("src/lib/seo.ts", "utf8"), /valueAddedTaxIncluded: true/);
});

test("the database marks new orders, and older ones keep GST on top", () => {
  const sql = readFileSync("supabase/migrations/20261107160000_prices_include_gst.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS prices_include_gst boolean NOT NULL DEFAULT false/);
  assert.match(sql, /round\(line_gross \* product_gst \/ \(100 \+ product_gst\), 2\)/);
  assert.match(
    sql,
    /_payment_method, 'Pending', 'Placed', fulfilment, _shipping_address, target_branch, true/,
  );
  assert.match(sql, /IF target_order\.prices_include_gst THEN/);
});

test("every new line has its Kannada", () => {
  for (const key of [
    "Subtotal (incl. GST)",
    "Includes GST of {0}",
    "Price includes GST · Pack size",
    "{0}% GST, included in the price",
    "incl. GST",
    "Subtotal (before GST)",
    "Sub Total before GST (",
    "Price incl. GST",
    "Selling price before GST (Qntl)",
    "Selling price before GST ({0} kg bag)",
    "Customers pay ({0} kg bag, incl. {1}% GST)",
    "Sheet price {0} + {1}% GST",
    "per {0} kg bag, GST included",
    "{0} at {1}: {2} incl. GST",
  ])
    assert.ok(kn[key], key);
});
