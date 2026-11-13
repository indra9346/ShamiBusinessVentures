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
const LONG = "https://www.google.com/maps/place/Grain+Bazar+Challakere+Godown/@14.3123456,76.6512345,17z/data=!3m1!4b1!4m6!3m5!1s0x3bb0a1b2c3d4e5f6:0x1234567890abcdef!8m2!3d14.3123456!4d76.6538094";
const STYLE = { ink: [28, 37, 46], muted: [102, 112, 124], navy: [32, 72, 58], rule: [222, 226, 230] } as const;
const POINT: CollectPoint = {
  name: "Grain Bazar Challakere Godown",
  address: "Pavagada Road, Behind Mahalakshmi Kalyana Mantapa, Mahadevi Road, Challakere, Karnataka 577522",
  phone: "8310084308",
  instructions: "Bring your order number. Collect during working hours.",
  mapUrl: SHORT,
};

test("the location link is a working https link or nothing", () => {
  for (const ok of ["", "  ", SHORT, LONG, "https://goo.gl/maps/abc123", "https://maps.google.com/?q=14.31,76.65", "https://www.google.co.in/maps/@14.31,76.65,17z"]) {
    assert.equal(mapLinkProblem(ok), null, ok);
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
  for (const yes of [SHORT, LONG, "https://goo.gl/maps/abc", "https://maps.google.com/?q=1,2", "https://google.co.in/maps/@1,2,3z", "https://g.co/kgs/abc"]) {
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

test("the QR is about 0.45 mm a module, from 16 to 24 mm", () => {
  const short = collectQrSize(SHORT);
  assert.ok(short >= 16 && short <= 18, `short link: ${short} mm`);
  const long = collectQrSize(LONG);
  assert.ok(long > short && long <= 24, `long link: ${long} mm`);
  assert.equal(collectQrSize(`https://maps.app.goo.gl/${"x".repeat(600)}`), 24);
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

test("with a link: the QR reads back as the link, labelled, beside the heading and the godown's details", () => {
  const { pdf, rects, texts, links } = recorder();
  const block = collectFromBlock(pdf, POINT, 94, STYLE as never);
  assert.equal(block.link, SHORT);
  assert.equal(block.qrSize, collectQrSize(SHORT));
  assert.equal(block.label.join(" "), COLLECT_QR_LABEL);
  assert.deepEqual(block.rows.map((row) => row.split(" ")[0]), ["COLLECT", "Grain", "Pavagada", "Phone", "Bring"]);
  assert.equal(block.rows[0], COLLECT_HEADING);
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
  // A thin frame round it, and the label centred under it.
  assert.ok(rects.some((r) => r.rect[4] === undefined && r.rect[2] === size));
  const label = texts.filter((t) => t.x < x + size);
  assert.equal(label.map((t) => t.text).join(" "), COLLECT_QR_LABEL);
  assert.ok(label.every((t) => Math.abs(t.x - (x + size / 2)) < 0.01 && t.y > top + size), "centred under the QR");
  // The details sit to the right of the QR, the heading first.
  const details = texts.filter((t) => t.x > x + size);
  assert.equal(details[0]!.text, COLLECT_HEADING);
  assert.ok(details.some((t) => t.text === "Phone 8310084308"));
  assert.ok(details.every((t) => t.y < bottom), "nothing below the block");
  // Tapping the QR in the PDF opens the location too.
  assert.equal(links.length, 1);
  assert.deepEqual([links[0]!.x, links[0]!.y, links[0]!.w, links[0]!.url], [x, top, size, SHORT]);
  assert.ok(links[0]!.h > size && links[0]!.h <= block.height, "the QR and its label");
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
  // A bad link is the same as none: it never becomes a QR.
  const bad = collectFromBlock(recorder().pdf, { ...POINT, mapUrl: "http://maps.app.goo.gl/x" }, 94, STYLE as never);
  assert.equal(bad.qrSize, 0);
  // Missing details are left out, not printed blank.
  const bare = collectFromBlock(recorder().pdf, { name: "Hubli Godown", address: "", phone: "", instructions: "", mapUrl: "" }, 94, STYLE as never);
  assert.deepEqual(bare.rows, [COLLECT_HEADING, "Hubli Godown"]);
});

test("in a real PDF the block is compact and its QR is a link", () => {
  const pdf = new jspdf.jsPDF({ unit: "mm", format: "a4" });
  const block = collectFromBlock(pdf, POINT, 94, STYLE as never);
  assert.ok(block.height <= 24, `about the height of the QR and its label (${block.height.toFixed(1)} mm)`);
  block.draw(14, 170);
  const out = pdf.output();
  assert.match(out, /\/URI \(https:\/\/maps\.app\.goo\.gl\/Xr4Pq9LmZb2VnT8k6\)/);
  assert.match(out, /COLLECT GOODS FROM HERE/);
});

test("the invoice prints the block under its notes on every copy of a collect-from-godown order", () => {
  const source = read("src/lib/invoice.ts");
  assert.match(source, /import \{ collectAddressLine, collectFromBlock, type CollectPoint \} from "@\/lib\/godown-location";/);
  assert.match(source, /instructions: orderBranch\.instructions, mapUrl: orderBranch\.mapUrl \}/, "the godown's link from Admin > Godowns");
  assert.match(source, /const collectPoint: CollectPoint \| null = !pickupPoint \? null : \{/, "only for an order collected from a godown");
  assert.match(source, /const collect = collectPoint \? collectFromBlock\(pdf, collectPoint, leftW, \{ ink, muted, navy, rule \}\) : null;/);
  // Measured before the totals are drawn, so the column never runs over the footer.
  assert.match(source, /if \(y \+ summaryH \+ 52 > bottomLimit \|\| y \+ 6 \+ leftH > bottomLimit\) newPage\(false\);/);
  const notesAt = source.indexOf("pdf.text(notes, M, ly + 4.5);");
  const drawAt = source.indexOf("if (collect) ly = collect.draw(M, ly + COLLECT_GAP);");
  assert.ok(notesAt > 0 && drawAt > notesAt, "drawn right under the notes");
  assert.ok(!/copy === "office"[^\n]*collect|collect[^\n]*copy ===/.test(source), "the same on the customer, office and partner copies");
  // The note no longer names the godown: the block says where to collect.
  assert.ok(!source.includes("`Collect from ${pickupPoint.name}."));
  assert.match(source, /\? "Show this invoice's delivery QR at the godown counter\."/);
});

test("the admin enters the link in Admin > Godowns, checked before it is saved; the database refuses others", () => {
  const page = read("src/routes/admin.branches.tsx");
  assert.match(page, /const mapProblem = mapLinkProblem\(form\.mapUrl\);\n\s+if \(mapProblem\) \{ toast\.error\(mapProblem\); return; \}/);
  assert.match(page, /map_url: form\.mapUrl\.trim\(\)/, "saved through the branch's own save, as before");
  assert.match(page, /<Label htmlFor="branch-map-url">Godown location link \(Google Maps\)<\/Label>/);
  assert.match(page, /Open this link to check it/);
  const vendor = read("src/components/panel/VendorFulfilmentPanel.tsx");
  assert.match(vendor, /const mapProblem = mapLinkProblem\(details\.mapUrl\);/);
  const migration = read("supabase/migrations/20261113230000_godown_location_partner_confirm.sql");
  assert.match(migration, /ADD CONSTRAINT branches_map_url_https\n\s+CHECK \(map_url = '' OR \(map_url ~ '\^https:\/\/\[\^\[:space:\]\]\+\$' AND char_length\(map_url\) <= 1000\)\) NOT VALID;/);
});
