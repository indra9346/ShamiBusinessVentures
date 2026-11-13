/*
 * A godown's location on its invoices (owner, 13 Nov 2026, on the invoice's NOTES: "Add Location QR here (location link
 * will be uploaded in admin panel for godown location) and show Collect goods from here and rest details").
 *
 * The admin pastes each godown's Google Maps link in Admin > Godowns (branches.map_url). An order collected from a godown
 * then prints, under its notes, a "Collect goods from here" block: the godown's name, address, phone and hours, and a QR
 * of that link labelled "Scan for the godown location". Without a link the block prints without the QR. The QR is drawn
 * with the same code as the invoice's delivery QR (pdf-qr.ts), and on a phone the PDF's QR can also be tapped.
 *
 * Kept free of app imports so the node tests can load it.
 */
import type { jsPDF as JsPdf } from "jspdf";
import { encode } from "uqr";
import { drawPdfQr } from "./pdf-qr.ts";

/** Longest link kept (the database allows the same). */
export const MAP_LINK_MAX = 1000;

/**
 * Why a location link cannot be saved, or null when it can. An empty link is allowed: that godown's invoices then print
 * the address without a QR. The database refuses the same links (branches_map_url_https).
 */
export function mapLinkProblem(value: string | null | undefined): string | null {
  const link = String(value ?? "").trim();
  if (!link) return null;
  if (/\s/.test(link)) return "The location link cannot have spaces. In Google Maps, open the godown, press Share, then Copy link, and paste it here.";
  if (!/^https:\/\//i.test(link)) return "The location link must start with https:// (in Google Maps: Share, then Copy link).";
  if (link.length > MAP_LINK_MAX) return "The location link is too long. In Google Maps, press Share, then Copy link, for a short link.";
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

/** The godown an order is collected from, as the block prints it. */
export type CollectPoint = { name: string; address: string; phone: string; instructions: string; mapUrl: string };

type Rgb = [number, number, number];
/** The invoice's own colours, so the block matches the page. */
export type CollectStyle = { ink: Rgb; muted: Rgb; navy: Rgb; rule: Rgb };

/** The heading and the QR's label, as printed. */
export const COLLECT_HEADING = "COLLECT GOODS FROM HERE";
export const COLLECT_QR_LABEL = "Scan for the godown location";

/**
 * The QR's side in mm: about 0.45 mm a module (a phone reads it from a hand's length), never under 16 mm or over 24 mm,
 * so a short maps.app.goo.gl link stays small (the invoice keeps to one page) and a long google.com/maps link stays
 * readable.
 */
export function collectQrSize(link: string): number {
  const modules = encode(link, { ecc: "M", border: 4 }).data.length;
  return Math.min(24, Math.max(16, Math.round(modules * 0.45 * 10) / 10));
}

/** Only these drawing calls are used, so a test can record them without a real PDF. */
export type CollectSurface = Pick<JsPdf, "setFont" | "setFontSize" | "setTextColor" | "text" | "splitTextToSize" | "setFillColor" | "rect" | "setDrawColor" | "link">;

type Row = { lines: string[]; bold: boolean; size: number; color: "ink" | "muted" | "navy"; step: number };

/**
 * The "Collect goods from here" block, measured first (so the invoice can keep it on the page with the notes) and drawn
 * by `draw(x, top)`. With a link: the QR and its label on the left, the heading and the godown's details beside it.
 * Without one: the heading and the details across the full width. Returns the block's height in mm.
 */
export function collectFromBlock(pdf: CollectSurface, point: CollectPoint, width: number, style: CollectStyle) {
  const link = printableMapLink(point.mapUrl);
  const qr = link ? collectQrSize(link) : 0;
  const GAP = 3.5;
  const textX = qr ? qr + GAP : 0;
  const textW = Math.max(20, width - textX);
  const rows: Row[] = [];
  const add = (text: string, bold: boolean, size: number, color: Row["color"], step: number) => {
    const clean = text.trim();
    if (!clean) return;
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setFontSize(size);
    rows.push({ lines: pdf.splitTextToSize(clean, textW) as string[], bold, size, color, step });
  };
  // Sized like the notes above it, a little tighter: the block must leave room for the delivery QR at the bottom.
  add(COLLECT_HEADING, true, 7.6, "muted", 3.9);
  add(point.name, true, 8, "ink", 3.4);
  add(point.address, false, 7.6, "ink", 3.2);
  add(point.phone ? `Phone ${point.phone}` : "", false, 7.6, "ink", 3.2);
  add(point.instructions, false, 7.2, "muted", 3.1);
  // The label under the QR, in as many short lines as its width needs.
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(6.2);
  const label = qr ? (pdf.splitTextToSize(COLLECT_QR_LABEL, qr + 1) as string[]) : [];
  const LABEL_STEP = 2.4;
  // Text rows: a baseline 2.8 mm under the top for the first line, then each line's own step; about 0.9 mm under the
  // last baseline for its descenders.
  const textH = rows.reduce((sum, row) => sum + row.lines.length * row.step, 0) - (rows.at(-1)?.step ?? 0) + 3.7;
  const qrH = qr ? qr + 1.1 + label.length * LABEL_STEP : 0;
  const height = Math.max(textH, qrH);

  const draw = (x: number, top: number) => {
    if (qr) {
      drawPdfQr(pdf, link, x, top, qr);
      pdf.setDrawColor(...style.rule);
      pdf.rect(x, top, qr, qr);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(6.2);
      pdf.setTextColor(...style.navy);
      label.forEach((line, index) => pdf.text(line, x + qr / 2, top + qr + 2.3 + index * LABEL_STEP, { align: "center" }));
      // A PDF opened on a phone: tapping the QR or its label opens the location.
      pdf.link(x, top, qr, qrH, { url: link });
    }
    let at = top + 2.8;
    for (const row of rows) {
      pdf.setFont("helvetica", row.bold ? "bold" : "normal");
      pdf.setFontSize(row.size);
      pdf.setTextColor(...style[row.color]);
      for (const line of row.lines) {
        pdf.text(line, x + textX, at);
        at += row.step;
      }
    }
    return top + height;
  };
  return { height, link, qrSize: qr, label, rows: rows.map((row) => row.lines.join(" ")), draw };
}
