import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as jspdf from "jspdf";
import { encode } from "uqr";
import {
  COLLECT_HEADING, COLLECT_QR_LABEL, MAP_LINK_MAX, collectAddressLine, collectFromBlock, collectQrSize, isGoogleMapsLink,
  mapLinkProblem, printableMapLink, type CollectPoint,
} from "../src/lib/godown-location.ts";

// 13 Nov 2026, the owner on the invoice's notes: "Add Location QR here (location link will be uploaded in admin panel
// for godown location) and show Collect goods from here and rest details".

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SHORT = "https://maps.app.goo.gl/Xr4Pq9LmZb2VnT8k6";
// The longest link kept, and a typical one copied from Google Maps' address bar (refused: its QR is too dense for paper).
const MAX = ("https://www.google.com/maps/place/Grain+Bazar+Challakere+Godown/@14.3123456,76.6512345,17z/data=!3m1!4b1" + "x".repeat(150)).slice(0, 150);
const LONG = "https://www.google.com/maps/place/Grain+Bazar+Challakere+Godown/@14.3123456,76.6512345,17z/data=!3m1!4b1!4m6!3m5!1s0x3bb0a1b2c3d4e5f6:0x1234567890abcdef!8m2!3d14.3123456!4d76.6538094";
const STYLE = { ink: [28, 37, 46], muted: [102, 112, 124], navy: [32, 72, 58], rule: [222, 226, 230] } as const;
const POINT: CollectPoint = {
  name: "Grain Bazar Challakere Godown",
  address: "Pavagada Road, Behind Mahalakshmi Kalyana Mantapa, Mahadevi Road, Challakere, Karnataka 577522",
  mapUrl: SHORT,
};

test("the location link is a working https link or nothing", () => {
  for (const ok of ["", "  ", SHORT, MAX, "https://goo.gl/maps/abc123", "https://maps.google.com/?q=14.31,76.65", "https://www.google.co.in/maps/@14.31,76.65,17z"]) {
    assert.equal(mapLinkProblem(ok), null, ok);
  }
  // At most 150 characters (review, 13 Nov 2026): a longer link prints a QR many phones cannot read from paper.
  assert.equal(MAP_LINK_MAX, 150);
  assert.equal(MAX.length, 150);
  assert.ok(LONG.length > 150);
  for (const tooLong of [LONG, `${MAX}x`]) {
    assert.match(mapLinkProblem(tooLong) ?? "", /too long to print as a clear QR\. In Google Maps, open the godown, press Share, then Copy link/);
    assert.equal(printableMapLink(tooLong), "", "a link that is too long never prints");
  }
  assert.match(mapLinkProblem("http://maps.app.goo.gl/x") ?? "", /must start with https:\/\//);
  assert.match(mapLinkProblem("maps.app.goo.gl/x") ?? "", /must start with https:\/\//);
  assert.match(mapLinkProblem("https://maps.app.goo.gl/a b") ?? "", /cannot have spaces/);
  assert.match(mapLinkProblem(`https://maps.app.goo.gl/${"x".repeat(MAP_LINK_MAX)}`) ?? "", /too long/);
  for (const broken of ["https://", "https://localhost/x", "https://user:secret@maps.app.goo.gl/x", "https://[nope"]) {
    assert.match(mapLinkProblem(broken) ?? "", /not a working link/, broken);
  }
  // What prints: only a link that passes, trimmed.
  assert.equal(printableMapLink(`  ${SHORT}  `), SHORT);
  assert.equal(printableMapLink("http://maps.app.goo.gl/x"), "");
  assert.equal(printableMapLink(null), "");
  assert.equal(printableMapLink(42), "");
});

test("Google Maps links are recognised; any other https link is only warned about", () => {
  for (const yes of [SHORT, MAX, "https://goo.gl/maps/abc", "https://maps.google.com/?q=1,2", "https://google.co.in/maps/@1,2,3z", "https://g.co/kgs/abc"]) {
    assert.equal(isGoogleMapsLink(yes), true, yes);
  }
  for (const no of ["https://www.google.com/search?q=godown", "https://example.com/maps", "https://goo.gl/other", "", "http://maps.app.goo.gl/x"]) {
    assert.equal(isGoogleMapsLink(no), false, no);
  }
});

test("the address prints its town, state and PIN once", () => {
  assert.equal(collectAddressLine({ address: "Pavagada Road, Challakere, Karnataka 577522", city: "Challakere", state: "Karnataka", pincode: "577522" }),
    "Pavagada Road, Challakere, Karnataka 577522");
  assert.equal(collectAddressLine({ address: "Pavagada Road", city: "Challakere", state: "Karnataka", pincode: "577522" }),
    "Pavagada Road, Challakere, Karnataka 577522");
  assert.equal(collectAddressLine({ address: "Gokul Road, Hubli", city: "Hubli", state: "Karnataka", pincode: "" }), "Gokul Road, Hubli, Karnataka");
  assert.equal(collectAddressLine({ address: "" }), "");
});

test("the QR is about 0.45 mm a module, from 16 to 24 mm, never under 0.42 mm for a link that is kept", () => {
  const short = collectQrSize(SHORT);
  assert.ok(short >= 16 && short <= 18, `short link: ${short} mm`);
  const max = collectQrSize(MAX);
  assert.equal(max, 24);
  const modules = encode(MAX, { ecc: "M", border: 4 }).data.length;
  assert.ok(max / modules >= 0.42, `${(max / modules).toFixed(3)} mm a module at 150 characters`);
  // Every length up to the limit keeps at least that.
  for (let length = 26; length <= MAP_LINK_MAX; length += 1) {
    const link = `https://maps.app.goo.gl/${"x".repeat(length - 24)}`;
    const n = encode(link, { ecc: "M", border: 4 }).data.length;
    assert.ok(collectQrSize(link) / n >= 0.42, `${link.length} characters`);
  }
  assert.equal(collectQrSize("https://g.co/kgs/a"), 16);
});

/** A surface that measures text with a real jsPDF and records what is drawn. */
function recorder() {
  const real = new jspdf.jsPDF({ unit: "mm", format: "a4" });
  const rects: { fill: number[]; rect: [number, number, number, number, string | undefined] }[] = [];
  const texts: { text: string; x: number; y: number }[] = [];
  const links: { x: number; y: number; w: number; h: number; url: string }[] = [];
  let fill: number[] = [];
  const pdf = {
    setFont: (...args: [string, string]) => real.setFont(...args),
    setFontSize: (size: number) => real.setFontSize(size),
    splitTextToSize: (text: string, width: number) => real.splitTextToSize(text, width),
    setTextColor: () => undefined,
    setDrawColor: () => undefined,
    setFillColor: (...rgb: number[]) => { fill = rgb; },
    rect: (x: number, y: number, w: number, h: number, style?: string) => { rects.push({ fill, rect: [x, y, w, h, style] }); },
    text: (text: string | string[], x: number, y: number) => { texts.push({ text: String(text), x, y }); },
    link: (x: number, y: number, w: number, h: number, options: { url: string }) => { links.push({ x, y, w, h, url: options.url }); },
  };
  return { pdf: pdf as never, rects, texts, links };
}

test("with a link: the QR reads back as the link, beside the heading, the godown's name and address, and its label", () => {
  const { pdf, rects, texts, links } = recorder();
  const block = collectFromBlock(pdf, POINT, 94, STYLE as never);
  assert.equal(block.link, SHORT);
  assert.equal(block.qrSize, collectQrSize(SHORT));
  // The phone and the pickup instructions are in the PICKUP FROM card at the top: not printed again (review, 13 Nov 2026).
  assert.deepEqual(block.rows, [COLLECT_HEADING, POINT.name, POINT.address, COLLECT_QR_LABEL]);
  // With a two-line address the block is no taller than the QR: the delivery QR keeps to the first page.
  assert.equal(block.height, block.qrSize);
  const x = 14, top = 170;
  const bottom = block.draw(x, top);
  assert.equal(bottom, top + block.height);
  // The QR: white first, then the dark modules; read back into the grid it must be exactly the link's QR.
  const size = block.qrSize;
  const { data } = encode(SHORT, { ecc: "M", border: 4 });
  const n = data.length;
  const cell = size / n;
  assert.deepEqual(rects[0]!.rect, [x, top, size, size, "F"]);
  const dark = rects.filter((r) => r.rect[4] === "F" && r.fill.join() === "0,0,0");
  const grid = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (const { rect: [rx, ry, w] } of dark) {
    const row = Math.round((ry - top) / cell);
    const col = Math.round((rx - x) / cell);
    for (let c = col; c < col + Math.round((w - 0.02) / cell); c += 1) grid[row]![c] = true;
  }
  assert.deepEqual(grid, data, "the location QR is the admin's link");
  // A thin frame round it.
  assert.ok(rects.some((r) => r.rect[4] === undefined && r.rect[2] === size));
  // Everything written sits to the right of the QR: the heading first, the label last, nothing under the QR.
  assert.ok(texts.every((t) => t.x > x + size), "no text under or over the QR");
  assert.equal(texts[0]!.text, COLLECT_HEADING);
  assert.equal(texts.at(-1)!.text, COLLECT_QR_LABEL);
  assert.ok(!texts.some((t) => /Phone|Bring/.test(t.text)), "no phone or instructions");
  assert.ok(texts.every((t) => t.y > top && t.y < bottom), "inside the block");
  // Tapping the QR, or its label, in the PDF opens the location too.
  assert.equal(links.length, 2);
  assert.deepEqual([links[0]!.x, links[0]!.y, links[0]!.w, links[0]!.h, links[0]!.url], [x, top, size, size, SHORT]);
  const labelAt = texts.at(-1)!;
  assert.ok(links[1]!.x === labelAt.x && links[1]!.y < labelAt.y && links[1]!.y + links[1]!.h > labelAt.y && links[1]!.url === SHORT, "the label");
});

test("the longest link kept: a 24 mm QR, the text beside it", () => {
  const { pdf, texts } = recorder();
  const block = collectFromBlock(pdf, { ...POINT, mapUrl: MAX }, 94, STYLE as never);
  assert.equal(block.qrSize, 24);
  assert.equal(block.height, 24);
  block.draw(14, 100);
  assert.ok(texts.every((t) => t.x > 14 + 24));
  // A link that is too long prints no QR at all, only the address.
  const refused = collectFromBlock(recorder().pdf, { ...POINT, mapUrl: LONG }, 94, STYLE as never);
  assert.equal(refused.qrSize, 0);
  assert.deepEqual(refused.rows, [COLLECT_HEADING, POINT.name, POINT.address]);
});

test("without a link: the same block, no QR, the details across the full width", () => {
  const { pdf, rects, texts, links } = recorder();
  const block = collectFromBlock(pdf, { ...POINT, mapUrl: "" }, 94, STYLE as never);
  assert.equal(block.qrSize, 0);
  assert.equal(block.link, "");
  block.draw(14, 100);
  assert.equal(rects.length, 0, "no QR drawn");
  assert.equal(links.length, 0);
  assert.equal(texts[0]!.text, COLLECT_HEADING);
  assert.ok(texts.every((t) => t.x === 14));
  assert.ok(!texts.some((t) => t.text.includes("Scan for")), "no label without a QR");
  assert.deepEqual(block.rows, [COLLECT_HEADING, POINT.name, POINT.address]);
  // A bad link is the same as none: it never becomes a QR.
  const bad = collectFromBlock(recorder().pdf, { ...POINT, mapUrl: "http://maps.app.goo.gl/x" }, 94, STYLE as never);
  assert.equal(bad.qrSize, 0);
  // Missing details are left out, not printed blank.
  const bare = collectFromBlock(recorder().pdf, { name: "Hubli Godown", address: "", mapUrl: "" }, 94, STYLE as never);
  assert.deepEqual(bare.rows, [COLLECT_HEADING, "Hubli Godown"]);
});

test("in a real PDF the block is compact and its QR is a link", () => {
  const pdf = new jspdf.jsPDF({ unit: "mm", format: "a4" });
  const block = collectFromBlock(pdf, POINT, 94, STYLE as never);
  assert.ok(block.height <= 17, `the height of a short link's QR (${block.height.toFixed(1)} mm)`);
  block.draw(14, 170);
  const out = pdf.output();
  assert.match(out, /\/URI \(https:\/\/maps\.app\.goo\.gl\/Xr4Pq9LmZb2VnT8k6\)/);
  assert.match(out, /COLLECT GOODS FROM HERE/);
});

test("the invoice prints the block under its notes on every copy of a collect-from-godown order", () => {
  const source = read("src/lib/invoice.ts");
  assert.match(source, /import \{ collectAddressLine, collectFromBlock, type CollectPoint \} from "@\/lib\/godown-location";/);
  assert.match(source, /instructions: orderBranch\.instructions, mapUrl: orderBranch\.mapUrl \}/, "the godown's link from Admin > Godowns");
  assert.match(source, /const collectPoint: CollectPoint \| null = !pickupPoint \? null : \{\n\s+name: pickupPoint\.name,\n\s+address: orderBranch \? collectAddressLine\(orderBranch\) : pickupPoint\.address,\n\s+mapUrl: pickupPoint\.mapUrl,\n\s+\};/,
    "only for an order collected from a godown; name, address and link (the phone and instructions are in PICKUP FROM)");
  // PICKUP FROM at the top still prints the phone and the instructions.
  assert.match(source, /\? \[pickupPoint\.name, pickupPoint\.address, pickupPoint\.phone \? `Phone \$\{pickupPoint\.phone\}` : "", pickupPoint\.instructions\]/);
  assert.match(source, /const collect = collectPoint \? collectFromBlock\(pdf, collectPoint, leftW, \{ ink, muted, navy, rule \}\) : null;/);
  // Measured before the totals are drawn, so the column never runs over the footer.
  assert.match(source, /if \(y \+ summaryH \+ 52 > bottomLimit \|\| y \+ 6 \+ leftH > bottomLimit\) newPage\(false\);/);
  const notesAt = source.indexOf("pdf.text(notes, M, ly + 4.5);");
  const drawAt = source.indexOf("if (collect) ly = collect.draw(M, ly + COLLECT_GAP);");
  assert.ok(notesAt > 0 && drawAt > notesAt, "drawn right under the notes");
  assert.ok(!/copy === "office"[^\n]*collect|collect[^\n]*copy ===/.test(source), "the same on the customer, office and partner copies");
  // The note no longer names the godown: the block says where to collect.
  assert.ok(!source.includes("`Collect from ${pickupPoint.name}."));
  // The location QR may sit right under the notes: the note names the DELIVERY QR band at the bottom.
  assert.match(source, /\? "At the godown counter, show the DELIVERY QR at the bottom\."/);
});

test("the admin enters the link in Admin > Godowns, checked before it is saved; the database refuses others", () => {
  const page = read("src/routes/admin.branches.tsx");
  assert.match(page, /const mapProblem = mapLinkProblem\(form\.mapUrl\);\n\s+if \(mapProblem\) \{ toast\.error\(mapProblem\); return; \}/);
  assert.match(page, /map_url: form\.mapUrl\.trim\(\)/, "saved through the branch's own save, as before");
  assert.match(page, /<Label htmlFor="branch-map-url">Godown location link \(Google Maps\)<\/Label>/);
  assert.match(page, /Open this link to check it/);
  // No length cap on the box: a link pasted too long shows why instead of being cut short and saved.
  const boxAt = page.indexOf('<Input id="branch-map-url"');
  const box = page.slice(boxAt, page.indexOf("/>", boxAt));
  assert.ok(boxAt > 0 && !box.includes("maxLength"), box);
  const vendor = read("src/components/panel/VendorFulfilmentPanel.tsx");
  assert.match(vendor, /const mapProblem = mapLinkProblem\(details\.mapUrl\);/);
  const migration = read("supabase/migrations/20261113230000_godown_location_partner_confirm.sql");
  assert.match(migration, /ADD CONSTRAINT branches_map_url_https\n\s+CHECK \(map_url = '' OR \(map_url ~ '\^https:\/\/\[\^\[:space:\]\]\+\$' AND char_length\(map_url\) <= 150\)\) NOT VALID;/);
});
