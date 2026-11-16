/*
 * A godown's location on its invoices (owner, 13 Nov 2026, on the invoice's NOTES: "Add Location QR here (location link
 * will be uploaded in admin panel for godown location) and show Collect goods from here and rest details").
 *
 * The admin pastes each godown's Google Maps link in Admin > Godowns (branches.map_url). An order collected from a godown
 * then prints, under its notes, a "Collect goods from here" block with the godown's name and address. The godown's phone
 * and pickup instructions are already in the invoice's PICKUP FROM card at the top, so the block does not print them
 * again (review, 13 Nov 2026: repeating them pushed the delivery QR onto a second page).
 *
 * The QR of the link prints at the top right of the first page, beside the invoice dates, with "Scan for the godown
 * location" under it (the owner, 14 Nov 2026, circling that empty space on a live invoice: "Add scan for godown location
 * in the invoice here... and qr code for godown location"). It used to sit inside the block under the notes
 * (collectFromBlock still draws it there when given a link; the invoice now passes none). The QR is drawn with the same
 * code as the invoice's delivery QR (pdf-qr.ts), and on a phone the PDF's QR can also be tapped.
 *
 * Kept free of app imports so the node tests can load it.
 */
import type { jsPDF as JsPdf } from "jspdf";
import { encode } from "uqr";
import { drawPdfQr } from "./pdf-qr.ts";

/**
 * Longest link kept (the database allows the same, branches_map_url_https). The QR on paper must stay readable: at 150
 * characters it is 57 modules across in 24 mm, 0.42 mm a module. A Google Maps link copied from the address bar is often
 * 250-500 characters; Share > Copy link gives a short maps.app.goo.gl link of about 40.
 */
export const MAP_LINK_MAX = 150;

/**
 * Why a location link cannot be saved, or null when it can. An empty link is allowed: that godown's invoices then print
 * the address without a QR. The database refuses the same links (branches_map_url_https).
 */
export function mapLinkProblem(value: string | null | undefined): string | null {
  const link = String(value ?? "").trim();
  if (!link) return null;
  if (/\s/.test(link)) return "The location link cannot have spaces. In Google Maps, open the godown, press Share, then Copy link, and paste it here.";
  if (!/^https:\/\//i.test(link)) return "The location link must start with https:// (in Google Maps: Share, then Copy link).";
  if (link.length > MAP_LINK_MAX) return "The location link is too long to print as a clear QR. In Google Maps, open the godown, press Share, then Copy link, and paste that short link here.";
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "That is not a working link. In Google Maps, open the godown, press Share, then Copy link, and paste it here.";
  }
  if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password) {
    return "That is not a working link. In Google Maps, open the godown, press Share, then Copy link, and paste it here.";
  }
  return null;
}

/** The link to print as a QR, or "" when there is none or it is not a working https link (a bad link never prints). */
export function printableMapLink(value: unknown): string {
  const link = typeof value === "string" ? value.trim() : "";
  return link && !mapLinkProblem(link) ? link : "";
}

/**
 * A Google Maps link: maps.app.goo.gl, goo.gl/maps, maps.google.*, google.* /maps, g.co/kgs. The admin form only warns
 * when a link is not one; any working https link still prints.
 */
export function isGoogleMapsLink(value: string | null | undefined): boolean {
  const link = printableMapLink(value);
  if (!link) return false;
  const url = new URL(link);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  if (host === "maps.app.goo.gl") return true;
  if (host === "goo.gl" && path.startsWith("/maps")) return true;
  if (host === "g.co" && path.startsWith("/kgs")) return true;
  if (/^maps\.google\.[a-z.]+$/.test(host)) return true;
  return /^google\.[a-z.]+$/.test(host) && path.startsWith("/maps");
}

/** The godown's address with its town, state and PIN, each only when the address does not already say it. */
export function collectAddressLine(godown: { address?: string; city?: string; state?: string; pincode?: string }): string {
  const address = String(godown.address ?? "").trim();
  const said = (part: string) => Boolean(part) && address.toLowerCase().includes(part.toLowerCase());
  const city = String(godown.city ?? "").trim();
  const state = String(godown.state ?? "").trim();
  const pin = String(godown.pincode ?? "").trim();
  const tail = [said(state) ? "" : state, said(pin) ? "" : pin].filter(Boolean).join(" ");
  return [address, said(city) ? "" : city, tail].filter(Boolean).join(", ");
}

/** The godown an order is collected from, as the block prints it (its phone and instructions are in PICKUP FROM). */
export type CollectPoint = { name: string; address: string; mapUrl: string };

type Rgb = [number, number, number];
/** The invoice's own colours, so the block matches the page. */
export type CollectStyle = { ink: Rgb; muted: Rgb; navy: Rgb; rule: Rgb };

/** The heading and the QR's label, as printed. */
export const COLLECT_HEADING = "COLLECT GOODS FROM HERE";
export const COLLECT_QR_LABEL = "Scan for the godown location";

/**
 * The QR's side in mm: about 0.45 mm a module (a phone reads it from a hand's length), never under 16 mm or over 24 mm,
 * so a short maps.app.goo.gl link stays small (the invoice keeps to one page). The longest link kept (MAP_LINK_MAX) still
 * gets 0.42 mm a module.
 */
export function collectQrSize(link: string): number {
  const modules = encode(link, { ecc: "M", border: 4 }).data.length;
  return Math.min(24, Math.max(16, Math.round(modules * 0.45 * 10) / 10));
}

/** Only these drawing calls are used, so a test can record them without a real PDF. */
export type CollectSurface = Pick<JsPdf, "setFont" | "setFontSize" | "setTextColor" | "text" | "splitTextToSize" | "setFillColor" | "rect" | "setDrawColor" | "link">;

type Row = { lines: string[]; bold: boolean; size: number; color: "ink" | "muted" | "navy"; step: number; label?: boolean };

/**
 * The "Collect goods from here" block, measured first (so the invoice can keep it on the page with the notes) and drawn
 * by `draw(x, top)`. With a link: the QR on the left and, beside it, the heading, the godown's name and address, and the
 * QR's label, so the block is no taller than the QR. Without one: the heading, name and address across the full width.
 * Returns the block's height in mm.
 */
export function collectFromBlock(pdf: CollectSurface, point: CollectPoint, width: number, style: CollectStyle) {
  const link = printableMapLink(point.mapUrl);
  const qr = link ? collectQrSize(link) : 0;
  const GAP = 3.5;
  const textX = qr ? qr + GAP : 0;
  const textW = Math.max(20, width - textX);
  const rows: Row[] = [];
  const add = (text: string, bold: boolean, size: number, color: Row["color"], step: number, label = false) => {
    const clean = text.trim();
    if (!clean) return;
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    rows.push({ lines: pdf.splitTextToSize(clean, textW) as string[], bold, size, color, step, label });
  };
  // A little smaller than the notes above it: with a two-line address the text is no taller than a short link's QR
  // (16.7 mm), so the delivery QR at the bottom keeps to the first page.
  add(COLLECT_HEADING, true, 7.4, "muted", 3.6);
  add(point.name, true, 7.8, "ink", 3.3);
  add(point.address, false, 7.3, "ink", 3.05);
  if (qr) add(COLLECT_QR_LABEL, true, 6.6, "navy", 3, true);
  // A baseline 2.8 mm under the top for the first line, then each line's own step; about 0.9 mm under the last baseline
  // for its descenders.
  const textH = rows.reduce((sum, row) => sum + row.lines.length * row.step, 0) - (rows.at(-1)?.step ?? 0) + 3.7;
  const height = Math.max(textH, qr);

  const draw = (x: number, top: number) => {
    if (qr) {
      drawPdfQr(pdf, link, x, top, qr);
      pdf.setDrawColor(...style.rule);
      pdf.rect(x, top, qr, qr);
      // A PDF opened on a phone: tapping the QR opens the location.
      pdf.link(x, top, qr, qr, { url: link });
    }
    let at = top + 2.8;
    for (const row of rows) {
      pdf.setFont("helvetica", row.bold ? "bold" : "normal");
      pdf.setFontSize(row.size);
      pdf.setTextColor(...style[row.color]);
      // The label can be tapped too.
      if (row.label) pdf.link(x + textX, at - 2.4, textW, row.lines.length * row.step, { url: link });
      for (const line of row.lines) {
        pdf.text(line, x + textX, at);
        at += row.step;
      }
    }
    return top + height;
  };
  return { height, link, qrSize: qr, rows: rows.map((row) => row.lines.join(" ")), draw };
}

/** Only these drawing calls are used by the corner QR, so a test can record them without a real PDF. */
export type CornerSurface = CollectSurface & Pick<JsPdf, "getTextWidth">;

/** The label's size and where its baseline sits under the QR, in mm. */
const CORNER_LABEL_SIZE = 6.6;
const CORNER_LABEL_DROP = 2.7;

/**
 * The godown's location QR at the top right of the invoice (owner, 14 Nov 2026): the QR with its right edge on `right`,
 * and "Scan for the godown location" under it, right-aligned. Null when the godown has no working link, so nothing is
 * drawn there. `size` is the QR's side (16-24 mm, collectQrSize), `width` the widest thing drawn (the label is wider
 * than the QR), `height` from the QR's top to just under the label. Tapping the QR or its label in the PDF opens the
 * location.
 */
export function locationQrCorner(pdf: CornerSurface, mapUrl: string | null | undefined, style: CollectStyle) {
  const link = printableMapLink(mapUrl);
  if (!link) return null;
  const size = collectQrSize(link);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(CORNER_LABEL_SIZE);
  const labelW = pdf.getTextWidth(COLLECT_QR_LABEL);
  const height = size + CORNER_LABEL_DROP + 0.9;
  const draw = (right: number, top: number) => {
    const x = right - size;
    drawPdfQr(pdf, link, x, top, size);
    pdf.setDrawColor(...style.rule);
    pdf.rect(x, top, size, size);
    pdf.link(x, top, size, size, { url: link });
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(CORNER_LABEL_SIZE);
    pdf.setTextColor(...style.navy);
    const baseline = top + size + CORNER_LABEL_DROP;
    pdf.text(COLLECT_QR_LABEL, right, baseline, { align: "right" });
    pdf.link(right - labelW, baseline - 2.4, labelW, 3.1, { url: link });
    return top + height;
  };
  return { link, size, width: Math.max(size, labelW), height, draw };
}
