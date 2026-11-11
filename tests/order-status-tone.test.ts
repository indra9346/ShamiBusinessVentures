import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLOSED_ORDER_STATUSES, CONFIRMED_ORDER_STATUSES, orderTone, orderToneClass, paymentTone, paymentToneClass, PENDING_ORDER_STATUSES, TONE_CLASSES,
} from "../src/lib/order-status-tone.ts";

// 11 Nov 2026, the owner: "order pending - yellow, order confirmed - green, order rejected or cancelled - red, with
// saturation of 15 to 30%, in the customer portal and all portals, status-wise".

const read = (path: string) => readFileSync(path, "utf8");

test("every order status has its colour group", () => {
  for (const status of ["Awaiting Payment", "Placed"]) assert.equal(orderTone(status), "pending", status);
  for (const status of ["Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered"]) {
    assert.equal(orderTone(status), "confirmed", status);
  }
  for (const status of ["Cancelled", "Payment Expired", "Rejected"]) assert.equal(orderTone(status), "closed", status);
  // The lists are the same ones the screens use, and no status is in two groups.
  const all = [...PENDING_ORDER_STATUSES, ...CONFIRMED_ORDER_STATUSES, ...CLOSED_ORDER_STATUSES];
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 11);
});

test("every payment status has its colour group", () => {
  for (const payment of ["Pending", "Partially Paid", "COD", "Overdue"]) assert.equal(paymentTone(payment), "pending", payment);
  for (const payment of ["Paid", "Successful"]) assert.equal(paymentTone(payment), "confirmed", payment);
  for (const payment of ["Refunded", "Failed"]) assert.equal(paymentTone(payment), "closed", payment);
});

test("spaces and capitals do not change the group", () => {
  assert.equal(orderTone("  out for delivery "), "confirmed");
  assert.equal(orderTone("PAYMENT EXPIRED"), "closed");
  assert.equal(paymentTone(" partially paid"), "pending");
  assert.equal(paymentTone("cod"), "pending");
});

test("a value that is not an order or payment status has no colour", () => {
  for (const value of [null, undefined, "", "Processing", "Active", "Published", "Low Stock", "Expired", "Live", "Requested", "something"]) {
    assert.equal(orderTone(value), null, String(value));
    assert.equal(paymentTone(value), null, String(value));
    assert.equal(orderToneClass(value, "row"), "");
    assert.equal(paymentToneClass(value, "badge"), "");
  }
  // An order status is not a payment status, and the other way round.
  assert.equal(paymentTone("Placed"), null);
  assert.equal(orderTone("Paid"), null);
});

test("the tints: yellow, green, red, light, and a row still shows the pointer", () => {
  assert.match(orderToneClass("Placed", "tile"), /yellow/);
  assert.match(orderToneClass("Awaiting Payment", "row"), /bg-yellow/);
  assert.match(orderToneClass("Delivered", "row"), /bg-emerald/);
  assert.match(orderToneClass("Cancelled", "row"), /bg-red/);
  assert.match(orderToneClass("Payment Expired", "badge"), /bg-red/);
  assert.match(paymentToneClass("Paid", "badge"), /bg-emerald/);
  assert.match(paymentToneClass("Refunded", "badge"), /bg-red/);
  assert.match(paymentToneClass("COD", "badge"), /bg-yellow/);
  for (const [tone, parts] of Object.entries(TONE_CLASSES)) {
    // Light: every background is a see-through tint (15-40%), never a solid colour.
    for (const part of [parts.tile, parts.row, parts.badge]) {
      for (const bg of part.split(/\s+/).filter((name) => /^(hover:)?bg-/.test(name))) {
        const share = Number(/\/(\d+)$/.exec(bg)?.[1]);
        assert.ok(share >= 15 && share <= 40, `${tone}: ${bg}`);
      }
    }
    // A tinted row keeps a hover of its own, a little darker than the row.
    const rest = Number(/(?:^|\s)bg-[a-z]+-\d+\/(\d+)/.exec(parts.row)?.[1]);
    const hover = Number(/hover:bg-[a-z]+-\d+\/(\d+)/.exec(parts.row)?.[1]);
    assert.ok(hover > rest, `${tone} row hover`);
    // Dark words on the light tint, so small type stays readable.
    assert.match(parts.badge, /text-[a-z]+-9\d0/);
    assert.match(parts.text, /text-[a-z]+-9\d0/);
  }
});

test("StatusBadge takes the order colours first and keeps the other pages' colours", () => {
  const widgets = read("src/components/panel/widgets.tsx");
  assert.match(widgets, /import \{ orderTone, paymentTone, TONE_CLASSES \} from "@\/lib\/order-status-tone"/);
  // Order and payment values first, then the old map, then the plain navy pill.
  assert.match(widgets, /orderTone\(status\) \?\? paymentTone\(status\)/);
  assert.match(widgets, /TONE_CLASSES\[tone\]\.badge/);
  assert.match(widgets, /\(plain \? null : orderBadgeClass\(status\)\) \?\? toneMap\[status\] \?\? "bg-navy\/6 text-navy border-navy\/15"/);
  // A return's "Refunded" is its good outcome, not a reversal: that page keeps the general colour.
  assert.match(read("src/routes/admin.returns.tsx"), /<StatusBadge status=\{r\.refund\} plain \/>/);
  // Lower-case values are reviews', vendors' and Zoho jobs' own states: they skip the order colours.
  assert.match(widgets, /if \(!\/\^\[A-Z\]\/\.test\(status\)\) return null;/);
  // The generic keys other pages rely on are all still there.
  for (const key of ["success", "approved", "Approved", "Active", "active", "Published", "warning", "pending", "Processing", "\"Low Stock\"", "rejected", "blocked", "Blocked", "suspended", "Expired"]) {
    assert.match(widgets, new RegExp(`\\n  ${key}: "`), key);
  }
});

test("DataTable takes a class per row and keeps a hover", () => {
  const widgets = read("src/components/panel/widgets.tsx");
  assert.match(widgets, /rowClassNames\?: \(string \| undefined\)\[\];/);
  assert.match(widgets, /<tr key=\{i\} className=\{cn\("border-b border-border\/70 transition-colors last:border-0 hover:bg-ivory", rowClassNames\?\.\[i\]\)\}>/);
});

test("order rows and tiles are tinted by status in every portal", () => {
  const rows: Record<string, RegExp> = {
    "src/routes/account.tsx": /rowClassNames=\{ordersList\.slice\(0, 6\)\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/admin.orders.tsx": /rowClassNames=\{rows\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/admin.dashboard.tsx": /rowClassNames=\{latestOrders\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/admin.customers.$id.tsx": /rowClassNames=\{custOrders\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/admin.products.$id.tsx": /rowClassNames=\{productOrders\.slice\(0, 8\)\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/admin.vendors.$id.tsx": /rowClassNames=\{shownOrders\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/vendor.orders.tsx": /rowClassNames=\{rows\.map\(\(\{ order: o \}\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/vendor.dashboard.tsx": /rowClassNames=\{recentOrders\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
    "src/routes/vendor.earnings.tsx": /rowClassNames=\{shownOrders\.map\(\(o\) => orderToneClass\(o\.status, "row"\)\)\}/,
  };
  for (const [path, wiring] of Object.entries(rows)) {
    const source = read(path);
    assert.match(source, /from "@\/lib\/order-status-tone"/, path);
    assert.match(source, wiring, path);
  }
  // The customer's payments tab follows the payment's own status.
  assert.match(read("src/routes/admin.customers.$id.tsx"), /rowClassNames=\{custOrders\.map\(\(o\) => paymentToneClass\(o\.payment, "row"\)\)\}/);
  // The rows and the paged lists still show the same orders.
  assert.match(read("src/routes/admin.vendors.$id.tsx"), /rows=\{shownOrders\.map\(/);
  assert.match(read("src/routes/vendor.earnings.tsx"), /rows=\{shownOrders\.map\(/);
  assert.match(read("src/routes/admin.dashboard.tsx"), /rows=\{latestOrders\.map\(/);
});

test("trackers: done stages green, the waiting stage yellow, a cancelled order red", () => {
  const track = read("src/routes/account.track.tsx");
  assert.doesNotMatch(track, /CheckCircle2 className="mt-0\.5 h-4 w-4 shrink-0 text-gold"/);
  assert.match(track, /const waiting = i === currentIdx && orderTone\(order\.status\) === "pending";/);
  assert.match(track, /waiting \? "text-yellow-600" : "text-emerald-600"/);
  assert.match(track, /orderToneClass\(order\.status, "tile"\)/);

  const dashboard = read("src/routes/account.tsx");
  assert.doesNotMatch(dashboard, /rounded-full bg-gold"/);
  assert.match(dashboard, /orderTone\(active\.status\) !== "pending"/);

  const admin = read("src/routes/admin.orders.$id.tsx");
  assert.match(admin, /const tone = orderTone\(order\.status\);/);
  assert.match(admin, /const stopped = !step\.done && !step\.current && tone === "closed";/);
  assert.match(admin, /const waiting = step\.current && tone === "pending";/);
  assert.match(admin, /cn\(TONE_CLASSES\.confirmed\.tile, "text-emerald-950"\)/);
  assert.match(admin, /cn\(TONE_CLASSES\.pending\.tile, /);
  assert.match(admin, /cn\(TONE_CLASSES\.closed\.tile, "text-red-950"\)/);
  // The What's Next banner takes the order's tint.
  assert.match(admin, /orderToneClass\(order\.status, "tile"\) \|\| "border-emerald-200 bg-emerald-50\/70"/);
  assert.match(admin, /tone \? TONE_CLASSES\[tone\]\.text : "text-emerald-900"\)\}>What's Next\?/);
});

test("checkouts and partner screens: paying yellow, ended red, commission orders by status", () => {
  const paying = read("src/components/panel/CustomersPayingNow.tsx");
  assert.match(paying, /orderToneClass\(hold\.status, "row"\)/);
  assert.match(paying, /orderToneClass\(AWAITING_PAYMENT, "border"\)/);

  const ended = read("src/components/panel/EndedCheckouts.tsx");
  assert.match(ended, /orderToneClass\(hold\.status, "row"\)/);
  assert.match(ended, /orderToneClass\(PAYMENT_EXPIRED, "tile"\)/);
  assert.match(ended, /orderToneClass\(PAYMENT_EXPIRED, "badge"\)/);

  const widgets = read("src/components/partners/PartnerWidgets.tsx");
  assert.match(widgets, /import \{ StatusBadge \} from "@\/components\/panel\/widgets";/);
  assert.match(widgets, /orderToneClass\(line\.order_status, "row"\)/);
  assert.match(widgets, /<StatusBadge status=\{line\.order_status\} \/><StatusBadge status=\{line\.payment_status\} \/>/);
  assert.match(widgets, /orderToneClass\(order\.orderStatus, "tile"\) \|\| "border-border"/);
  assert.match(widgets, /<StatusBadge status=\{order\.orderStatus\} \/><StatusBadge status=\{order\.paymentStatus\} \/>/);
  // No raw "status · payment" text left.
  assert.doesNotMatch(widgets, /\{order\.orderStatus\} · \{order\.paymentStatus\}/);
  assert.doesNotMatch(widgets, /\{line\.order_status\} · \{line\.payment_status\}/);

  const partnerPayments = read("src/components/panel/PartnerPaymentsPanel.tsx");
  assert.match(partnerPayments, /orderToneClass\(row\.status, "tile"\) \|\| "border-border bg-white"/);
  assert.match(partnerPayments, /orderToneClass\(row\.status, "text"\)/);
});
