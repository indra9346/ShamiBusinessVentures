/*
 * The delivery QR printed on the invoice (owner, 11 Nov 2026: no separate delivery note paper any more, one delivery QR
 * on the invoice). The QR is drawn into the PDF as filled squares, not as a picture, so it stays sharp at any printer's
 * size and adds almost nothing to the file. Kept free of app imports so the node tests can load it.
 */
import type { jsPDF as JsPdf } from "jspdf";
import { encode } from "uqr";

/** The live site's own names: a QR made there always carries https://grainbazar.com, with or without www. */
const LIVE_HOSTS = ["grainbazar.com", "www.grainbazar.com"];
const LIVE_ORIGIN = "https://grainbazar.com";

/**
 * The address a delivery QR opens: https://grainbazar.com on the live site, otherwise this page's own address, so a QR
 * made on a local or test copy opens that copy's scan page (and never the live one).
 */
export function deliveryQrOrigin(hostname: string, origin: string) {
  return LIVE_HOSTS.includes(String(hostname ?? "").trim().toLowerCase()) ? LIVE_ORIGIN : String(origin ?? "").replace(/\/+$/, "");
}

/** The godown's scan page with the code after "#", so the code never reaches a server log or an analytics address. */
export const deliveryQrLink = (origin: string, code: string) => `${origin.replace(/\/+$/, "")}/slip#${code}`;

/** Only the two drawing calls are needed, so a test can record them without a real PDF. */
export type PdfQrSurface = Pick<JsPdf, "setFillColor" | "rect">;

/**
 * Draws `text` as a QR code `sizeMm` wide with its top-left corner at (x, y). Medium error correction (a crease or a
 * smudge still scans) and the standard quiet zone of 4 modules, painted white first so the QR reads even on a tinted
 * card. Each row's dark modules that touch are merged into one rectangle: fewer drawing commands, no hairline gaps.
 * Returns the number of modules across, quiet zone included.
 */
export function drawPdfQr(pdf: PdfQrSurface, text: string, x: number, y: number, sizeMm: number) {
  const { data } = encode(text, { ecc: "M", border: 4 });
  const n = data.length;
  const cell = sizeMm / n;
  pdf.setFillColor(255, 255, 255);
  pdf.rect(x, y, sizeMm, sizeMm, "F");
  pdf.setFillColor(0, 0, 0);
  for (let row = 0; row < n; row += 1) {
    let col = 0;
    while (col < n) {
      if (!data[row]![col]) { col += 1; continue; }
      let end = col;
      while (end < n && data[row]![end]) end += 1;
      // A whisker of overlap so neighbouring rows print as one solid block.
      pdf.rect(x + col * cell, y + row * cell, (end - col) * cell + 0.02, cell + 0.02, "F");
      col = end;
    }
  }
  return n;
}
