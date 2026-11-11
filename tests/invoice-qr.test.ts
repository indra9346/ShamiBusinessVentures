import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as jspdf from "jspdf";
import { encode } from "uqr";
import { deliveryQrLink, deliveryQrOrigin, drawPdfQr } from "../src/lib/pdf-qr.ts";
import { customerInvoiceVisible, INVOICE_STAGE_WORDS, invoiceStage, invoiceStageTone } from "../src/lib/invoice-visibility.ts";
import { DELIVERY_CODE, DELIVERY_QR_NOTE, invoiceDelivery, invoiceQrCode } from "../src/lib/invoice-lines.ts";
import { partnerInvoiceStage, partnerInvoiceVisible } from "../src/lib/partner-invoices.ts";
import { readScannedText } from "../src/lib/delivery-papers.ts";

// 11 Nov 2026, the owner: no separate delivery note paper any more; one delivery QR on the invoice with a short note
// under it, and the invoice (with the QR) shows in the customer's orders only after payment and the admin's confirmation.

const root = new URL("../", import.meta.url);
// Sources are checked out with Windows line endings: the checks below read them with plain newlines.
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const CODE = "AbCdEfGhIjKlMnOpQrSt_-";

/** Records what drawPdfQr draws, so the QR can be read back module by module. */
function recorder() {
  const calls: { fill: number[]; rect: [number, number, number, number, string | undefined] }[] = [];
  let fill: number[] = [];
  const pdf = {
    setFillColor: (...rgb: number[]) => { fill = rgb; },
    rect: (x: number, y: number, w: number, h: number, style?: string) => { calls.push({ fill, rect: [x, y, w, h, style] }); },
  };
  return { pdf: pdf as never, calls };
}

test("the QR is drawn on white, then each row's dark modules as merged runs, and reads back exactly", () => {
  const link = deliveryQrLink("https://grainbazar.com", CODE);
  const { pdf, calls } = recorder();
  const x = 150, y = 35, size = 30;
  const n = drawPdfQr(pdf, link, x, y, size);
  const { data, version } = encode(link, { ecc: "M", border: 4 });
  assert.equal(n, data.length);
  assert.equal(n, 4 * version + 17 + 8, "the symbol plus a quiet zone of 4 modules each side");
  // White first, covering the whole square.
  assert.deepEqual(calls[0]!.fill, [255, 255, 255]);
  assert.deepEqual(calls[0]!.rect, [x, y, size, size, "F"]);
  const dark = calls.slice(1);
  assert.ok(dark.length > 0 && dark.every((call) => call.fill.join() === "0,0,0" && call.rect[4] === "F"));
  // Read the squares back into a grid: it must be the QR itself, quiet zone empty.
  const cell = size / n;
  const grid = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (const { rect: [rx, ry, w] } of dark) {
    const row = Math.round((ry - y) / cell);
    const col = Math.round((rx - x) / cell);
    const run = Math.round((w - 0.02) / cell);
    assert.ok(run >= 1);
    for (let c = col; c < col + run; c += 1) {
      assert.equal(grid[row]![c], false, "no module is drawn twice");
      grid[row]![c] = true;
    }
  }
  assert.deepEqual(grid, data);
  for (let i = 0; i < n; i += 1) {
    for (const edge of [0, 1, 2, 3, n - 4, n - 3, n - 2, n - 1]) {
      assert.equal(grid[edge]![i], false, "quiet zone row");
      assert.equal(grid[i]![edge], false, "quiet zone column");
    }
  }
  // The top-left finder pattern: a solid run of 7 just inside the quiet zone.
  assert.deepEqual(grid[4]!.slice(4, 11), Array(7).fill(true));
  // Runs are merged: fewer rectangles than dark modules.
  assert.ok(dark.length < data.flat().filter(Boolean).length);
});

test("the QR draws into a real jsPDF page", () => {
  const pdf = new jspdf.jsPDF({ unit: "mm", format: "a4" });
  const n = drawPdfQr(pdf, deliveryQrLink("https://grainbazar.com", CODE), 160, 35, 30);
  assert.ok(n >= 29);
  const page = ((pdf.internal as unknown as { pages: (string[] | undefined)[] }).pages[1] ?? []).join("\n");
  assert.ok((page.match(/ re\b/g) ?? []).length > n, "the modules are rectangles");
});

test("the QR opens grainbazar.com on the live site and this copy's own address elsewhere", () => {
  assert.equal(deliveryQrOrigin("grainbazar.com", "https://grainbazar.com"), "https://grainbazar.com");
  assert.equal(deliveryQrOrigin("www.grainbazar.com", "https://www.grainbazar.com"), "https://grainbazar.com");
  assert.equal(deliveryQrOrigin("WWW.GrainBazar.com", "https://www.grainbazar.com"), "https://grainbazar.com");
  assert.equal(deliveryQrOrigin("localhost", "http://localhost:8080/"), "http://localhost:8080");
  assert.equal(deliveryQrOrigin("staging.grainbazar.com", "https://staging.grainbazar.com"), "https://staging.grainbazar.com", "a test copy never prints a live QR");
  assert.equal(deliveryQrLink("https://grainbazar.com/", CODE), `https://grainbazar.com/slip#${CODE}`);
  // The godown's scanner reads the invoice's QR as a code, on the live site and on a local copy.
  assert.deepEqual(readScannedText(deliveryQrLink("https://grainbazar.com", CODE), "www.grainbazar.com"), { code: CODE });
  assert.deepEqual(readScannedText(deliveryQrLink(deliveryQrOrigin("localhost", "http://localhost:8080"), CODE), "localhost:8080"), { code: CODE });
});

test("the invoice shows only when paid in full AND confirmed, never cancelled or refunded", () => {
  for (const status of ["Payment Confirmed", "Accepted", "Packed", "Dispatched", "Out for Delivery", "Delivered", "payment confirmed"]) {
    assert.equal(customerInvoiceVisible({ orderStatus: status, payment: "Paid" }), true, status);
  }
  assert.equal(customerInvoiceVisible({ orderStatus: "Delivered", payment: "paid" }), true);
  const hidden: [string | null | undefined, string | null | undefined][] = [
    ["Placed", "Paid"], // paid, but the office has not confirmed it yet
    ["Payment Confirmed", "Pending"],
    ["Payment Confirmed", "Partially Paid"],
    ["Delivered", "Refunded"],
    ["Cancelled", "Paid"],
    ["Payment Expired", "Paid"],
    ["Rejected", "Paid"],
    ["Awaiting Payment", "Pending"],
    [null, "Paid"],
    ["Delivered", undefined],
    ["Something else", "Paid"],
  ];
  for (const [orderStatus, payment] of hidden) assert.equal(customerInvoiceVisible({ orderStatus, payment }), false, `${orderStatus} / ${payment}`);
});

test("each stage has its words and colour: ready green, waiting yellow, cancelled or refunded red", () => {
  assert.equal(invoiceStage({ orderStatus: "Delivered", payment: "Paid" }), "visible");
  assert.equal(invoiceStage({ orderStatus: "Placed", payment: "Paid" }), "awaiting_confirmation");
  assert.equal(invoiceStage({ orderStatus: "Placed", payment: "Pending" }), "awaiting_payment");
  assert.equal(invoiceStage({ orderStatus: "Payment Confirmed", payment: "Partially Paid" }), "awaiting_payment");
  assert.equal(invoiceStage({ orderStatus: "Cancelled", payment: "Paid" }), "cancelled");
  assert.equal(invoiceStage({ orderStatus: "Delivered", payment: "Refunded" }), "refunded");
  assert.equal(invoiceStageTone("visible"), "confirmed");
  assert.equal(invoiceStageTone("awaiting_payment"), "pending");
  assert.equal(invoiceStageTone("awaiting_confirmation"), "pending");
  assert.equal(invoiceStageTone("cancelled"), "closed");
  assert.equal(invoiceStageTone("refunded"), "closed");
  assert.equal(INVOICE_STAGE_WORDS.awaiting_payment, "Available after payment");
});

test("the channel partner's list follows the customer's rule", () => {
  assert.equal(partnerInvoiceVisible({ order_status: "Payment Confirmed", payment_status: "paid" }), true);
  assert.equal(partnerInvoiceVisible({ order_status: "Placed", payment_status: "paid" }), false);
  assert.equal(partnerInvoiceVisible({ order_status: "Delivered", payment_status: "partially paid" }), false);
  assert.equal(partnerInvoiceVisible({ order_status: "Cancelled", payment_status: "paid" }), false);
  assert.equal(partnerInvoiceStage({ order_status: "Delivered", payment_status: "refunded" }), "refunded");
});

test("the database's answer is checked: only a well-formed code prints, and only on a tax invoice", () => {
  const live = invoiceDelivery({ code: CODE, generation: 1, why: "paid", note_no: "DN-000004", released_at: "2026-11-12T06:30:00Z", released_how: "auto" });
  assert.deepEqual(live, { code: CODE, why: "paid", noteNo: "DN-000004", releasedAt: "2026-11-12T06:30:00Z", handovers: [], godown: null, items: 0, reopened: 0 });
  assert.deepEqual(invoiceDelivery({ code: null, why: "not_confirmed", note_no: null }), { code: null, why: "not_confirmed", noteNo: null, releasedAt: null, handovers: [], godown: null, items: 0, reopened: 0 });
  assert.equal(invoiceDelivery({ code: "short", why: "paid" })!.code, null);
  assert.equal(invoiceDelivery({ code: `${CODE}x`, why: "paid" })!.code, null);
  assert.equal(invoiceDelivery({ code: "AbCdEfGhIjKlMnOpQrSt <", why: "paid" })!.code, null);
  for (const nothing of [null, undefined, "x", [CODE], 42]) assert.equal(invoiceDelivery(nothing), null);
  assert.ok(DELIVERY_CODE.test(CODE));
  assert.equal(invoiceQrCode("CLKINV0711260364", live), CODE);
  assert.equal(invoiceQrCode(null, live), null, "a proforma has no QR");
  assert.equal(invoiceQrCode("", live), null);
  assert.equal(invoiceQrCode("CLKINV0711260364", null), null, "no code from the database: no QR");
  assert.equal(invoiceQrCode("CLKINV0711260364", { code: null, why: "unpaid", noteNo: null, releasedAt: null, handovers: [], godown: null, items: 0, reopened: 0 }), null);
});

test("the note under the QR is the owner's, in English and Kannada", () => {
  assert.equal(DELIVERY_QR_NOTE.en, "Show this at the godown. The godown in-charge scans it to release and hand over your goods, once per item.");
  assert.match(DELIVERY_QR_NOTE.kn, /[ಀ-೿]/);
  assert.match(DELIVERY_QR_NOTE.kn, /^ಇದನ್ನು ಗೋದಾಮಿನಲ್ಲಿ ತೋರಿಸಿ/);
});

test("the invoice asks the database for the code each time, and draws the QR only on a tax invoice with a code", () => {
  const source = read("src/lib/invoice.ts");
  assert.match(source, /supabase\.rpc\("invoice_delivery_code", \{ _order_no: orderNo \}\)/);
  assert.match(source, /return error \? null : invoiceDelivery\(data\);/, "a refusal (a vendor's copy) or an error means no QR");
  assert.match(source, /const deliveryRead = !zohoNumber \? Promise\.resolve\(null\)/, "no Zoho number: the code is not even asked for");
  assert.match(source, /const delivery = await deliveryRead;\n  const qrCode = invoiceQrCode\(zohoNumber, delivery\);/);
  // The QR is drawn in one place, and that is called only in the branch for a tax invoice with a code.
  assert.equal(source.match(/drawPdfQr\(/g)?.length, 1);
  const blockAt = source.indexOf("const deliveryQrBlock = (code: string, top: number, band: ReturnType<typeof qrBandText>) => {");
  assert.ok(blockAt > 0);
  const block = source.slice(blockAt, source.indexOf("\n  };", blockAt));
  assert.match(block, /drawPdfQr\(pdf, deliveryQrLink\(origin, code\), M, qrTop, QR_SIZE\);/);
  assert.equal(source.match(/deliveryQrBlock\(qrCode, y, band\)/g)?.length, 1);
  // At the very bottom (owner, 12 Nov 2026: "in the bottom not top"): after the terms and the signature, before the footer.
  const bottomAt = source.indexOf("y = deliveryQrBlock(qrCode, y, band);");
  assert.ok(bottomAt > source.indexOf('"Authorized Signatory"') && bottomAt < source.indexOf("// Footer on every page."), "the QR band is the last thing on the invoice");
  assert.match(source, /if \(qrCode\) \{\s*y \+= 27\.5;\s*(?:\/\/[^\n]*\s*)*const band = qrBandText\(delivery\);\s*const below = handoverBlock\(delivery\);\s*(?:\/\/[^\n]*\s*)*if \(y \+ band\.height \+ below\.height > H - 17\) newPage\(false\);\s*y = deliveryQrBlock\(qrCode, y, band\);\s*y = below\.draw\(y\);/,
    "a band that does not fit goes to a new page, with the hand-over lines under it");
  assert.ok(!source.includes("qrCorner"), "nothing at the top any more");
  assert.match(source, /canvasTextImage\(DELIVERY_QR_NOTE\.kn,/);
  assert.match(source, /DELIVERY_QR_NOTE\.en/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source), "the code is never kept in the browser");
  assert.ok(!source.includes("Bring this invoice or your order number"), "pickup goes by the QR now");
  assert.match(source, /Show this invoice's delivery QR at the godown counter\./);
  // The logo: the small PNG for the letterhead, and the watermark drawn last on every page.
  assert.match(source, /loadLogoPng\(\)/);
  assert.ok(!source.includes('fetch("/grainbazar-logo.png")'), "the 1920 px WebP is no longer embedded as is");
  assert.match(source, /opacity: 0\.09/);
  const footer = source.slice(source.indexOf("for (let page = 1; page <= pages; page += 1)"), source.indexOf("const fileName"));
  assert.match(footer, /watermark\(\);\s*\}/, "the watermark is the last thing drawn on each page");
  const newPage = source.slice(source.indexOf("const newPage = "), source.indexOf("newPage(true);"));
  assert.ok(!newPage.includes("watermark()"), "not drawn first, where the table band and cards would cover it");
  // Kept: the signature lookup the partner test relies on.
  assert.match(source, /const signature = await loadOrderSignature\(order\.id,/);
});

test("the customer's order page has the invoice and delivery QR panel at its step, tinted by stage", () => {
  const page = read("src/routes/account.orders.$id.tsx");
  assert.match(page, /<Panel title="Invoice and delivery QR"/);
  assert.match(page, /<InvoiceDeliveryPanel order=\{order\} \/>/);
  assert.match(page, /customerInvoiceVisible\(\{ orderStatus: order\.status, payment: order\.payment \}\)/);
  assert.match(page, /supabase\.rpc\("invoice_delivery_code", \{ _order_no: order\.id \}\)/);
  assert.match(page, /renderSVG\(deliveryQrLink\(deliveryQrOrigin\(window\.location\.hostname, window\.location\.origin\), code\), \{ ecc: "M", border: 4 \}\)/);
  assert.match(page, /Your invoice and delivery QR appear here once your payment is confirmed\./);
  assert.match(page, /Show this QR at the godown counter\. The godown in-charge scans it and hands over your goods\./);
  assert.match(page, /className=\{cn\("mt-5", TONE_CLASSES\[tone\]\.tile\)\}/);
  assert.match(page, /<Panel title="Order Timeline" className=\{orderToneClass\(order\.status, "tile"\)\}>/);
  assert.ok(!/order\.payment === "Paid" && <InvoicePreviewButton/.test(page), "no header button that ignores the confirmation");
  assert.ok(!/border-gold bg-gold\/10/.test(page), "done stages are green, not gold");
  assert.ok(!/localStorage|sessionStorage/.test(page));
});

test("the orders list, the Invoices page and the partner's list use the same rule and the status tints", () => {
  const list = read("src/routes/account.orders.tsx");
  assert.match(list, /orderToneClass\(o\.status, "row"\)/);
  assert.match(list, /TONE_CLASSES\.pending\.tile/);
  assert.match(list, /TONE_CLASSES\.closed\.tile/);
  assert.match(list, /customerInvoiceVisible\(\{ orderStatus: o\.status, payment: o\.payment \}\)/);
  assert.match(list, />Invoice &amp; QR/);
  const invoices = read("src/routes/account.invoices.tsx");
  assert.match(invoices, /customerInvoiceVisible\(\{ orderStatus: order\.status, payment: order\.payment \}\)/);
  assert.match(invoices, /issuedZohoNumber\(/);
  assert.ok(!/invoicePrefix|invoice_prefix/.test(invoices), "no made-up invoice numbers");
  const partner = read("src/components/partners/PartnerInvoices.tsx");
  assert.match(partner, /partnerInvoiceVisible\(row\)/);
  assert.match(partner, /orderToneClass\(row\.order_status, "tile"\)/);
  assert.ok(!/invoiceReady\(/.test(partner));
});
