/*
 * The delivery note and its slips as a PDF file (11 Nov 2026, the owner: "need both print + download options" and "make
 * that delivery note professional ... with water mark"). The same papers as the print page, drawn with jsPDF in the
 * invoice's house style: logo and gold rule, the logo as a faint watermark, and a large DUPLICATE watermark across a
 * duplicate copy. Each paper carries the QR code of the press that made it, so a download counts as a copy exactly like
 * a print (the first is the original). Kannada lines are drawn by the browser into images, because the PDF's built-in
 * fonts have no Kannada. Kept free of app imports so the node tests can load it.
 */
import type { jsPDF as JsPdf } from "jspdf";
import { encode } from "uqr";
import {
  addressLines, companyHeading, deliveryMethodLabel, isPickup, istDateTime, slipPages,
  type DeliveryGate, type DeliveryNote, type DeliveryPrintRecord, type SlipPage,
} from "./delivery-notes.ts";
import { paperKindWords, paperLink, paperStamp, qrCaption, type PaperPrint } from "./delivery-papers.ts";

type Rgb = [number, number, number];
const NAVY: Rgb = [32, 72, 58];
const GOLD: Rgb = [196, 150, 52];
const INK: Rgb = [28, 37, 46];
const MUTED: Rgb = [102, 112, 124];
const RULE: Rgb = [222, 226, 230];
const CARD: Rgb = [246, 248, 251];
const RED: Rgb = [185, 28, 28];
const GREEN: Rgb = [21, 128, 61];

/** A line of text drawn as an image, sized in millimetres. */
export type TextImage = { dataUrl: string; width: number; height: number };
export type TextImageOptions = { sizePt: number; bold?: boolean | undefined; maxWidthMm: number; color?: Rgb | undefined; align?: "left" | "center" | undefined };
/** Draws text the PDF fonts can't (Kannada, other scripts) as an image; null when it can't. */
export type TextImageRenderer = (text: string, options: TextImageOptions) => TextImage | null;

export type DeliveryPdfInput = {
  note: DeliveryNote;
  state: DeliveryGate;
  selection: { note: boolean; slips: number[] };
  record: Pick<DeliveryPrintRecord, "printedAt" | "noteCode" | "slipCodes" | "notePaper" | "slipPapers">;
  noteWarnings: string[];
  slipWarnings: Record<string, string[]>;
  /** The site's address, for the QR's link: https://grainbazar.com */
  origin: string;
};
export type DeliveryPdfDeps = { jspdf: typeof import("jspdf"); logo: string | null; textImage: TextImageRenderer | null };

const PT = 0.3528; // millimetres per point

/** The PDF's built-in fonts read Latin-1 only: typographic marks become plain ones. */
export function pdfSafe(text: string) {
  return String(text ?? "")
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-").replace(/…/g, "...").replace(/₹/g, "Rs ")
    .replace(/[  -​ ]/g, " ");
}
const latin = (text: string) => /^[\x20-\x7e\xa0-\xff\n]*$/.test(text);

/** "DN-000001_CLK-577522-071126-164455_original.pdf": the note, the order and what the papers are. */
export function deliveryPdfFileName(note: Pick<DeliveryNote, "note_no" | "order_no">, input: Pick<DeliveryPdfInput, "selection" | "record">) {
  const kinds = [
    ...(input.selection.note ? [input.record.notePaper] : []),
    ...input.selection.slips.map((line) => input.record.slipPapers[String(line)]),
  ].filter(Boolean) as PaperPrint[];
  const word = (paper: PaperPrint) => (paper.kind === "duplicate" ? `duplicate-${paper.duplicate_no ?? ""}` : paper.kind === "replacement" ? "replacement-original" : "original");
  const distinct = [...new Set(kinds.map(word))];
  const what = input.selection.note && input.selection.slips.length ? "note-and-slips" : input.selection.note ? "note" : input.selection.slips.length === 1 ? `slip-${input.selection.slips[0]}` : "slips";
  const clean = (text: string) => text.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${clean(note.note_no)}_${clean(note.order_no)}_${what}_${distinct.length === 1 ? distinct[0] : "copies"}.pdf`;
}

/** Builds the PDF of the papers just recorded. Returns the document and its file name. */
export function buildDeliveryNotePdf(input: DeliveryPdfInput, deps: DeliveryPdfDeps): { pdf: JsPdf; fileName: string } {
  const { jsPDF, GState } = deps.jspdf;
  // Compressed, and each picture embedded once however often it is drawn: a phone-friendly file.
  const pdf: JsPdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pictures = new Map<string, string>();
  const alias = (dataUrl: string) => {
    let name = pictures.get(dataUrl);
    if (!name) { name = `pic${pictures.size + 1}`; pictures.set(dataUrl, name); }
    return name;
  };
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 14;
  const R = W - M;
  const usable = W - M * 2;
  const FOOT = H - 16; // content stops above the footer
  const { note } = input;
  const { snapshot } = note;
  const company = companyHeading(snapshot.company);
  const companyName = company.name || "Shami Business Ventures";
  const pages: { label: string; paper: number }[] = [];
  let paperIndex = -1;
  let y = 0;

  const color = (rgb: Rgb) => pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
  const font = (size: number, bold = false, rgb: Rgb = INK) => { pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(size); color(rgb); };

  /**
   * Text whose top edge is at `top`, wrapped to maxWidth. Text the built-in font can't draw (Kannada, for one) is
   * drawn by the browser as an image. Returns the height used.
   */
  const write = (raw: string, x: number, top: number, options: { size: number; bold?: boolean | undefined; rgb?: Rgb; maxWidth?: number; align?: "left" | "right" | "center" }) => {
    const text = pdfSafe(raw);
    if (!text.trim()) return 0;
    const { size, bold = false, rgb = INK, maxWidth = usable, align = "left" } = options;
    const lineHeight = size * PT * 1.28;
    if (!latin(text) && deps.textImage) {
      const image = deps.textImage(text, { sizePt: size, bold, maxWidthMm: maxWidth, color: rgb, align: align === "center" ? "center" : "left" });
      if (image) {
        const left = align === "right" ? x - image.width : align === "center" ? x - image.width / 2 : x;
        pdf.addImage(image.dataUrl, "PNG", left, top, image.width, image.height, alias(image.dataUrl), "FAST");
        return image.height;
      }
    }
    font(size, bold, rgb);
    const lines = pdf.splitTextToSize(latin(text) ? text : text.replace(/[^\x20-\x7e\xa0-\xff\n]/g, "?"), maxWidth) as string[];
    lines.forEach((line, index) => pdf.text(line, x, top + size * PT * 0.82 + index * lineHeight, { align }));
    return lines.length * lineHeight;
  };
  /** The height `write` would use, without drawing. */
  const measure = (raw: string, options: { size: number; bold?: boolean | undefined; maxWidth?: number }) => {
    const text = pdfSafe(raw);
    if (!text.trim()) return 0;
    if (!latin(text) && deps.textImage) {
      const image = deps.textImage(text, { sizePt: options.size, bold: options.bold, maxWidthMm: options.maxWidth ?? usable });
      if (image) return image.height;
    }
    font(options.size, options.bold);
    return (pdf.splitTextToSize(text, options.maxWidth ?? usable) as string[]).length * options.size * PT * 1.28;
  };

  const watermark = (paper: PaperPrint | null | undefined) => {
    try {
      if (deps.logo) {
        pdf.setGState(new GState({ opacity: 0.06 }));
        pdf.addImage(deps.logo, "PNG", (W - 120) / 2, (H - 120) / 2, 120, 120, alias(deps.logo), "FAST");
      }
      if (paper?.kind === "duplicate") {
        // DUPLICATE across the page, corner to corner, so a copy can't be taken for the original at a glance.
        pdf.setGState(new GState({ opacity: 0.13 }));
        const words = `DUPLICATE COPY ${paper.duplicate_no ?? ""}`.trim();
        const angle = (Math.atan2(H - 60, W - 30) * 180) / Math.PI;
        font(54, true, RED);
        const width = pdf.getTextWidth(words);
        const rad = (angle * Math.PI) / 180;
        pdf.text(words, W / 2 - (Math.cos(rad) * width) / 2, H / 2 + (Math.sin(rad) * width) / 2 + 6, { angle });
      }
    } catch {
      /* the watermark is decoration */
    } finally {
      pdf.setGState(new GState({ opacity: 1 }));
    }
  };

  const kindPill = (paper: PaperPrint | null | undefined, rightEdge: number, top: number) => {
    const words = paperKindWords(paper?.kind, paper?.duplicate_no).en.toUpperCase();
    const fill = paper?.kind === "duplicate" ? RED : paper?.kind === "replacement" ? NAVY : GREEN;
    font(8, true, [255, 255, 255]);
    const width = pdf.getTextWidth(words) + 6;
    pdf.setFillColor(fill[0], fill[1], fill[2]);
    pdf.roundedRect(rightEdge - width, top, width, 5.6, 1.4, 1.4, "F");
    pdf.text(words, rightEdge - width / 2, top + 3.9, { align: "center" });
  };

  const header = (title: string, side: string, paper: PaperPrint | null | undefined, continued: boolean) => {
    if (deps.logo) pdf.addImage(deps.logo, "PNG", M, 9, 19, 19, alias(deps.logo), "FAST");
    const tx = M + (deps.logo ? 23 : 0);
    font(17, true, NAVY);
    pdf.text("GRAIN BAZAR", tx, 15.5);
    let line = 20;
    write(`A brand of ${companyName}`, tx, line - 2.6, { size: 8, rgb: MUTED, maxWidth: 104 });
    line += 3.6;
    for (const address of company.addressLines.slice(0, 2)) {
      write(address, tx, line - 2.6, { size: 7.5, rgb: MUTED, maxWidth: 104 });
      line += 3.4;
    }
    const facts = [company.gstin && `GSTIN ${company.gstin}`, company.phone && `Phone ${company.phone}`].filter(Boolean).join("  |  ");
    if (facts) write(facts, tx, line - 2.6, { size: 7.5, rgb: MUTED, maxWidth: 104 });
    font(15, true, INK);
    pdf.text(continued ? `${title} (contd.)` : title, R, 15.5, { align: "right" });
    font(10, true, NAVY);
    pdf.text(side, R, 21, { align: "right" });
    kindPill(paper, R, 24);
    const bottom = Math.max(line + 1.5, 32);
    pdf.setDrawColor(GOLD[0], GOLD[1], GOLD[2]);
    pdf.setLineWidth(0.7);
    pdf.line(M, bottom, R, bottom);
    pdf.setLineWidth(0.2);
    return bottom + 5;
  };

  const newPage = (label: string, title: string, side: string, paper: PaperPrint | null | undefined, firstOfPaper: boolean) => {
    if (pages.length) pdf.addPage();
    if (firstOfPaper) paperIndex += 1;
    pages.push({ label, paper: paperIndex });
    watermark(paper);
    y = header(title, side, paper, !firstOfPaper);
  };

  /** The big stamp on a duplicate or a replacement original, in English and Kannada. */
  const stamp = (paper: PaperPrint | null | undefined) => {
    const words = paperStamp(paper);
    if (!words) return;
    const duplicate = paper?.kind === "duplicate";
    const inner = usable - 8;
    const heights = [
      measure(words.title.en, { size: duplicate ? 18 : 15, bold: true, maxWidth: inner }),
      measure(words.title.kn, { size: duplicate ? 15 : 13, bold: true, maxWidth: inner }),
      measure(words.detail.en, { size: 8, bold: true, maxWidth: inner }),
      measure(words.detail.kn, { size: 8, bold: true, maxWidth: inner }),
    ];
    const boxH = heights.reduce((sum, h) => sum + h, 0) + 8;
    const tone = duplicate ? RED : NAVY;
    pdf.setDrawColor(tone[0], tone[1], tone[2]);
    pdf.setLineWidth(0.9);
    if (duplicate) pdf.setFillColor(254, 242, 242); else pdf.setFillColor(CARD[0], CARD[1], CARD[2]);
    pdf.roundedRect(M, y, usable, boxH, 1.5, 1.5, "FD");
    pdf.setLineWidth(0.2);
    let top = y + 3.5;
    top += write(words.title.en, W / 2, top, { size: duplicate ? 18 : 15, bold: true, rgb: tone, maxWidth: inner, align: "center" });
    top += write(words.title.kn, W / 2, top, { size: duplicate ? 15 : 13, bold: true, rgb: tone, maxWidth: inner, align: "center" });
    top += write(words.detail.en, W / 2, top + 0.5, { size: 8, bold: true, maxWidth: inner, align: "center" });
    write(words.detail.kn, W / 2, top + 0.5, { size: 8, bold: true, maxWidth: inner, align: "center" });
    y += boxH + 4;
  };

  const warningBox = (warnings: string[]) => {
    if (!warnings.length) return;
    const inner = usable - 8;
    const boxH = warnings.reduce((sum, w) => sum + measure(w, { size: 9.5, bold: true, maxWidth: inner }), 0) + 6;
    pdf.setDrawColor(INK[0], INK[1], INK[2]);
    pdf.setLineWidth(0.9);
    pdf.rect(M, y, usable, boxH);
    pdf.setLineWidth(0.2);
    let top = y + 3;
    for (const warning of warnings) top += write(warning, W / 2, top, { size: 9.5, bold: true, maxWidth: inner, align: "center" });
    y += boxH + 4;
  };

  /** Label : value rows in two columns. */
  const facts = (rows: [string, string, boolean?][], width: number) => {
    const colW = width / 2;
    const labelW = 22;
    for (let index = 0; index < rows.length; index += 2) {
      const pair = rows.slice(index, index + 2);
      const heights = pair.map(([, value, strong]) => measure(value, { size: 8.5, bold: Boolean(strong), maxWidth: colW - labelW - 3 }));
      pair.forEach(([label, value, strong], column) => {
        const x = M + column * colW;
        write(label, x, y, { size: 8, rgb: MUTED, maxWidth: labelW });
        write(value, x + labelW, y, { size: 8.5, bold: Boolean(strong), maxWidth: colW - labelW - 3 });
      });
      y += Math.max(4.2, ...heights) + 1.2;
    }
  };

  /** The paper's QR, its kind and what to do with it, in both languages. */
  const qrBlock = (code: string | null | undefined, paper: PaperPrint | null | undefined, x: number, top: number, size: number) => {
    if (!code) return top;
    const { data } = encode(paperLink(input.origin, code), { ecc: "M", border: 4 });
    const n = data.length;
    const cell = size / n;
    pdf.setFillColor(255, 255, 255);
    pdf.rect(x, top, size, size, "F");
    pdf.setFillColor(0, 0, 0);
    for (let row = 0; row < n; row += 1) {
      let col = 0;
      while (col < n) {
        if (!data[row]![col]) { col += 1; continue; }
        let end = col;
        while (end < n && data[row]![end]) end += 1;
        pdf.rect(x + col * cell, top + row * cell, (end - col) * cell + 0.02, cell + 0.02, "F");
        col = end;
      }
    }
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
    pdf.rect(x, top, size, size);
    const kind = paperKindWords(paper?.kind, paper?.duplicate_no);
    const caption = qrCaption(paper?.kind, paper?.duplicate_no);
    const mid = x + size / 2;
    let at = top + size + 1.5;
    const tone = paper?.kind === "duplicate" ? RED : NAVY;
    at += write(kind.en.toUpperCase(), mid, at, { size: 8, bold: true, rgb: tone, maxWidth: size + 6, align: "center" });
    at += write(kind.kn, mid, at, { size: 7.5, bold: true, rgb: tone, maxWidth: size + 6, align: "center" });
    at += write(caption.en, mid, at + 0.4, { size: 6.5, rgb: MUTED, maxWidth: size + 6, align: "center" });
    at += write(caption.kn, mid, at + 0.4, { size: 6.5, rgb: MUTED, maxWidth: size + 6, align: "center" });
    return at;
  };

  const card = (x: number, top: number, width: number, heading: string, lines: { text: string; bold?: boolean }[]) => {
    const height = lines.reduce((sum, line) => sum + measure(line.text, { size: 8.5, bold: line.bold, maxWidth: width - 8 }), 0) + 12;
    return {
      height,
      draw: (boxH: number) => {
        pdf.setFillColor(CARD[0], CARD[1], CARD[2]);
        pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
        pdf.roundedRect(x, top, width, boxH, 1.5, 1.5, "FD");
        pdf.setFillColor(NAVY[0], NAVY[1], NAVY[2]);
        pdf.rect(x, top + 1.5, 1.1, boxH - 3, "F");
        write(heading.toUpperCase(), x + 4, top + 3, { size: 7, bold: true, rgb: NAVY, maxWidth: width - 8 });
        let at = top + 8;
        for (const line of lines) at += write(line.text, x + 4, at, { size: 8.5, bold: line.bold, maxWidth: width - 8 });
      },
    };
  };

  const signatures = (labels: string[]) => {
    const gap = 6;
    const width = (usable - gap * (labels.length - 1)) / labels.length;
    if (y + 26 > FOOT) return false;
    labels.forEach((label, index) => {
      const x = M + index * (width + gap);
      pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
      pdf.roundedRect(x, y, width, 24, 1.2, 1.2);
      pdf.setDrawColor(INK[0], INK[1], INK[2]);
      pdf.line(x + 4, y + 15, x + width - 4, y + 15);
      write(label, x + 4, y + 16.5, { size: 8, bold: true, maxWidth: width - 8 });
      write("Name, signature, date and time", x + 4, y + 20.3, { size: 6.5, rgb: MUTED, maxWidth: width - 8 });
    });
    y += 28;
    return true;
  };

  const printedText = input.record.printedAt ? istDateTime(input.record.printedAt) : "";
  const pickup = isPickup(snapshot);
  const customerName = snapshot.customer.business_name || snapshot.customer.name;
  const allSlips = slipPages(snapshot);

  // ---- The delivery note ----
  if (input.selection.note) {
    const paper = input.record.notePaper;
    const label = `${note.note_no} | Delivery note | ${paperKindWords(paper?.kind, paper?.duplicate_no).en}`;
    const title = "DELIVERY NOTE";
    newPage(label, title, note.note_no, paper, true);
    stamp(paper);
    warningBox(input.noteWarnings);

    const qrSize = 36;
    const factsWidth = usable - qrSize - 8;
    const factsTop = y;
    facts([
      ["Order no.", note.order_no, true],
      ["Invoice no.", note.invoice_number, true],
      ["Order date", istDateTime(snapshot.order_placed_at)],
      ["Delivery", deliveryMethodLabel(snapshot.shipping_method)],
      ["Generated", `${istDateTime(note.generated_at)} by ${note.generated_by_name}`],
      ["Payment", input.state.code === "paid" ? "Paid in full" : "See the warning above", true],
      ["Printed", printedText, true],
      ["Copy", paperKindWords(paper?.kind, paper?.duplicate_no).en, paper?.kind !== "original"],
    ], factsWidth);
    const qrBottom = qrBlock(input.record.noteCode, paper, R - qrSize, factsTop, qrSize);
    y = Math.max(y, qrBottom) + 3;

    const godownLines = addressLines(snapshot.godown);
    const customerLines = addressLines(snapshot.address);
    const half = (usable - 5) / 2;
    const left = card(M, y, half, pickup ? "Customer (collects at the godown)" : "Customer", [
      { text: customerName, bold: true },
      ...(snapshot.customer.business_name && snapshot.customer.name ? [{ text: snapshot.customer.name }] : []),
      ...(snapshot.customer.gstin ? [{ text: `GSTIN ${snapshot.customer.gstin}` }] : []),
      ...(snapshot.customer.phone ? [{ text: `Phone ${snapshot.customer.phone}` }] : []),
      ...(pickup ? customerLines.map((text) => ({ text })) : []),
    ]);
    const right = pickup
      ? card(M + half + 5, y, half, "Pickup from godown", [
        { text: snapshot.godown.name ?? "", bold: true },
        ...godownLines.map((text) => ({ text })),
        ...(snapshot.godown.phone ? [{ text: `Phone ${snapshot.godown.phone}` }] : []),
      ])
      : card(M + half + 5, y, half, "Deliver to", [
        ...(snapshot.address.name ? [{ text: snapshot.address.name, bold: true }] : []),
        ...customerLines.map((text) => ({ text })),
        ...(snapshot.address.phone ? [{ text: `Phone ${snapshot.address.phone}` }] : []),
        { text: `From godown: ${snapshot.godown.name ?? ""}`, bold: true },
      ]);
    const cardsH = Math.max(left.height, right.height);
    left.draw(cardsH);
    right.draw(cardsH);
    y += cardsH + 6;

    // The items: a navy heading row, repeated on every page of a long note.
    const hasStockNo = allSlips.some((line) => line.stock_no);
    const cols = hasStockNo
      ? [{ key: "#", w: 10 }, { key: "Item", w: usable - 10 - 34 - 34 - 22 }, { key: "Pack size", w: 34 }, { key: "Stock no.", w: 34 }, { key: "Qty", w: 22 }]
      : [{ key: "#", w: 10 }, { key: "Item", w: usable - 10 - 40 - 24 }, { key: "Pack size", w: 40 }, { key: "Qty", w: 24 }];
    const headRow = () => {
      pdf.setFillColor(NAVY[0], NAVY[1], NAVY[2]);
      pdf.rect(M, y, usable, 7, "F");
      let x = M;
      for (const col of cols) {
        font(8, true, [255, 255, 255]);
        if (col.key === "Qty") pdf.text("QTY", x + col.w - 3, y + 4.7, { align: "right" });
        else pdf.text(col.key.toUpperCase(), x + 2.5, y + 4.7);
        x += col.w;
      }
      y += 7;
    };
    headRow();
    allSlips.forEach((line: SlipPage, index) => {
      const itemW = cols[1]!.w - 5;
      const nameH = measure(line.name, { size: 9, bold: true, maxWidth: itemW });
      const rowH = Math.max(8, nameH + (line.sku ? 4 : 0) + 3.5);
      if (y + rowH > FOOT - 34) {
        newPage(label, title, note.note_no, paper, false);
        headRow();
      }
      if (index % 2 === 1) { pdf.setFillColor(CARD[0], CARD[1], CARD[2]); pdf.rect(M, y, usable, rowH, "F"); }
      let x = M;
      write(String(line.line), x + 2.5, y + 2, { size: 9 });
      x += cols[0]!.w;
      write(line.name, x + 2.5, y + 2, { size: 9, bold: true, maxWidth: itemW });
      if (line.sku) write(`SKU ${line.sku}`, x + 2.5, y + 2 + nameH, { size: 7, rgb: MUTED, maxWidth: itemW });
      x += cols[1]!.w;
      write(line.pack_size || "-", x + 2.5, y + 2, { size: 9, maxWidth: cols[2]!.w - 5 });
      x += cols[2]!.w;
      if (hasStockNo) { write(line.stock_no || "-", x + 2.5, y + 2, { size: 8.5, maxWidth: cols[3]!.w - 5 }); x += cols[3]!.w; }
      write(String(line.qty), x + cols[cols.length - 1]!.w - 3, y + 1.6, { size: 11, bold: true, align: "right" });
      pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
      pdf.line(M, y + rowH, R, y + rowH);
      y += rowH;
    });
    const totalQty = allSlips.reduce((sum, line) => sum + Number(line.qty), 0);
    pdf.setDrawColor(INK[0], INK[1], INK[2]);
    pdf.setLineWidth(0.5);
    pdf.line(M, y, R, y);
    pdf.setLineWidth(0.2);
    write(`${allSlips.length} item line${allSlips.length === 1 ? "" : "s"}  |  ${allSlips.length} delivery slip${allSlips.length === 1 ? "" : "s"}`, M + 2.5, y + 2, { size: 8.5, bold: true });
    write(`Total ${totalQty}`, R - 3, y + 1.6, { size: 11, bold: true, align: "right" });
    y += 11;

    if (y + 40 > FOOT) newPage(label, title, note.note_no, paper, false);
    write("Vehicle no.", M, y, { size: 8.5, bold: true });
    pdf.setDrawColor(INK[0], INK[1], INK[2]);
    pdf.line(M + 20, y + 3.4, M + 80, y + 3.4);
    write("Received the goods above in good condition.", R, y, { size: 7.5, rgb: MUTED, align: "right", maxWidth: 90 });
    y += 9;
    signatures(["Prepared by", "Goods issued by (godown)", "Received by (customer)"]);
  }

  // ---- One slip per item ----
  for (const slip of allSlips.filter((line) => input.selection.slips.includes(line.slip))) {
    const paper = input.record.slipPapers[String(slip.slip)];
    const side = `Slip ${slip.slip} of ${slip.of}`;
    newPage(`${note.note_no} | ${side} | ${paperKindWords(paper?.kind, paper?.duplicate_no).en}`, "DELIVERY SLIP", side, paper, true);
    stamp(paper);
    warningBox(input.slipWarnings[String(slip.slip)] ?? []);

    const qrSize = 44;
    const boxW = usable - qrSize - 8;
    const nameH = measure(slip.name, { size: 20, bold: true, maxWidth: boxW - 10 });
    const boxH = nameH + (slip.sku ? 5 : 0) + 34 + (slip.stock_no ? 6 : 0);
    pdf.setDrawColor(NAVY[0], NAVY[1], NAVY[2]);
    pdf.setLineWidth(0.7);
    pdf.setFillColor(CARD[0], CARD[1], CARD[2]);
    pdf.roundedRect(M, y, boxW, boxH, 2, 2, "FD");
    pdf.setLineWidth(0.2);
    let at = y + 4;
    write("ITEM", M + 5, at, { size: 7, bold: true, rgb: NAVY });
    at += 4;
    at += write(slip.name, M + 5, at, { size: 20, bold: true, maxWidth: boxW - 10 });
    if (slip.sku) at += write(`SKU ${slip.sku}`, M + 5, at, { size: 8.5, rgb: MUTED, maxWidth: boxW - 10 });
    at += 4;
    write("QUANTITY", M + 5, at, { size: 7, bold: true, rgb: NAVY });
    write("PACK SIZE", M + 5 + (boxW - 10) / 2, at, { size: 7, bold: true, rgb: NAVY });
    write(String(slip.qty), M + 5, at + 4, { size: 30, bold: true });
    write(slip.pack_size || "-", M + 5 + (boxW - 10) / 2, at + 5.5, { size: 17, bold: true, maxWidth: (boxW - 10) / 2 });
    if (slip.stock_no) write(`Stock no. ${slip.stock_no}`, M + 5, at + 18, { size: 8.5, bold: true, maxWidth: boxW - 10 });
    const qrBottom = qrBlock(input.record.slipCodes[String(slip.slip)], paper, R - qrSize, y, qrSize);
    y = Math.max(y + boxH, qrBottom) + 6;

    facts([
      ["Note no.", note.note_no, true],
      ["Order no.", note.order_no, true],
      ["Invoice no.", note.invoice_number],
      ["Customer", customerName],
      ["Godown", snapshot.godown.name ?? ""],
      ["Delivery", deliveryMethodLabel(snapshot.shipping_method)],
      ["Generated", istDateTime(note.generated_at)],
      ["Printed", printedText, true],
      ["Copy", paperKindWords(paper?.kind, paper?.duplicate_no).en, paper?.kind !== "original"],
    ], usable);
    y += 6;
    signatures(["Goods issued by (godown)", "Received by"]);
  }

  // Footers: what the paper is and "page x of y" within it, so a loose page still says whose it is.
  const total = pdf.getNumberOfPages();
  for (let page = 1; page <= total; page += 1) {
    pdf.setPage(page);
    const meta = pages[page - 1]!;
    const own = pages.filter((p) => p.paper === meta.paper);
    const index = pages.slice(0, page).filter((p) => p.paper === meta.paper).length;
    pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
    pdf.line(M, H - 13, R, H - 13);
    font(7, false, MUTED);
    pdf.text(pdfSafe(`${meta.label}  |  Order ${note.order_no}`), M, H - 9);
    pdf.text(`Page ${index} of ${own.length}`, R, H - 9, { align: "right" });
    pdf.text("Computer-generated. Goods are handed over only against the QR code of the original or replacement original.", M, H - 5.5);
    pdf.text("grainbazar.com", R, H - 5.5, { align: "right" });
  }
  pdf.setProperties({ title: `${note.note_no} ${note.order_no}`, subject: "Delivery note", author: companyName, creator: "Grain Bazar" });
  return { pdf, fileName: deliveryPdfFileName(note, input) };
}

/** The browser's text drawing for the PDF: Kannada and any other script, shaped by the browser's own fonts. */
export function canvasTextImage(text: string, options: TextImageOptions): TextImage | null {
  if (typeof document === "undefined") return null;
  const scale = 9; // pixels per millimetre: about 230 dots per inch, sharp on paper
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  const px = options.sizePt * PT * scale;
  const fontCss = `${options.bold ? "700" : "400"} ${px}px "Noto Sans Kannada", "Nirmala UI", "Tunga", "Kedage", "Noto Sans", sans-serif`;
  context.font = fontCss;
  const maxPx = options.maxWidthMm * scale;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (current && context.measureText(next).width > maxPx) { lines.push(current); current = word; } else current = next;
    }
    lines.push(current);
  }
  const lineHeight = px * 1.45;
  const width = Math.min(maxPx, Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width))) + 2);
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, Math.ceil(lineHeight * lines.length + px * 0.2));
  context.font = fontCss;
  const [r, g, b] = options.color ?? INK;
  context.fillStyle = `rgb(${r}, ${g}, ${b})`;
  context.textBaseline = "top";
  context.textAlign = options.align === "center" ? "center" : "left";
  lines.forEach((line, index) => context.fillText(line, options.align === "center" ? canvas.width / 2 : 0, index * lineHeight + px * 0.1));
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width / scale, height: canvas.height / scale };
}

/** The Grain Bazar logo as a PNG (the file is a WebP), for the letterhead and the watermark. */
export async function loadLogoPng(): Promise<string | null> {
  if (typeof document === "undefined") return null;
  try {
    const response = await fetch("/grainbazar-logo.png");
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = Math.round((360 * bitmap.height) / bitmap.width);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
