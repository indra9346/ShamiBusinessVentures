import type { jsPDF as JsPdf } from "jspdf";
import type { Order, Product } from "@/lib/data";
import { numberToIndianWords } from "@/lib/export-utils";
import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import {
  PICKUP_SETTINGS_KEY,
  defaultPickupSettings,
  parsePickupSettings,
  pickupPointForPin,
  type PickupSettings,
} from "@/lib/pickup-points";
import { DEMO_BRANCH, branchFromRow, defaultBranchOf, type Branch } from "@/lib/branches";
import { sellerAddressLines } from "@/lib/invoice-seller";
import {
  DELIVERY_QR_NOTE, godownLine, handoverWords, invoiceBalance, invoiceDelivery, invoiceLines, invoicePayments, invoiceQrCode, issuedZohoNumber,
  type InvoiceDelivery, type InvoiceFacts, type InvoicePaymentRow, type Line, type ZohoInvoiceCopy,
} from "@/lib/invoice-lines";
import { GODOWN_SIGNATURE_BUCKET } from "@/lib/godown-signature";
import { canvasTextImage, loadLogoPng } from "@/lib/delivery-note-pdf";
import { deliveryQrLink, deliveryQrOrigin, drawPdfQr } from "@/lib/pdf-qr";
import { cleanContactNumber, contactNumberLine } from "@/lib/zoho-contact-numbers";
import { collectAddressLine, collectFromBlock, type CollectPoint } from "@/lib/godown-location";

export { invoiceLines, type Line };

/**
 * Grain Bazar tax invoice (A4, vector PDF). Layout follows the company's Zoho tax invoice
 * (seller header, Bill To / Ship To, HSN, CGST/SGST or IGST per line, total in words, terms,
 * signatory) with an Amazon-style finish (order details, "Original for Recipient", reverse
 * charge line, page x of y) and the Grain Bazar logo as a light watermark on every page.
 *
 * A tax invoice of a paid, confirmed order carries the order's delivery QR (owner, 11 Nov 2026: no separate delivery
 * note paper any more): the godown in-charge scans it to release and hand over the goods.
 *
 * Grain Bazar (Shami Business Ventures Private Limited) is always the seller of record. The
 * customer copy never names a marketplace vendor; the office copy (admin / vendor panels)
 * adds which vendor fulfilled each line.
 */

export type InvoiceCopy = "customer" | "office";

export type InvoiceCompany = {
  legalName: string;
  brand: string;
  addressLines: string[];
  stateName: string;
  stateCode: string;
  gstin: string;
  pan: string;
  phone: string;
  email: string;
};

/** The company's registered details as printed on its Zoho tax invoice (used when Settings has none). */
export const DEFAULT_INVOICE_COMPANY: InvoiceCompany = {
  legalName: "Shami Business Ventures Private Limited",
  brand: "Grain Bazar",
  addressLines: [
    "Pavagada Road, Behind Mahalakshmi Kalyana Mantapa",
    "Mahadevi Road, Challakere",
    "Karnataka 577522, India",
  ],
  stateName: "Karnataka",
  stateCode: "29",
  gstin: "29ABJCS7870F1ZR",
  pan: "ABJCS7870F",
  phone: "8310084308",
  email: "headoffice@shamibusiness.com",
};

/** GST state codes, for "Place of Supply" and the CGST+SGST vs IGST decision. */
const STATE_CODES: Record<string, string> = {
  "jammu and kashmir": "01", "himachal pradesh": "02", punjab: "03", chandigarh: "04", uttarakhand: "05",
  haryana: "06", delhi: "07", rajasthan: "08", "uttar pradesh": "09", bihar: "10", sikkim: "11",
  "arunachal pradesh": "12", nagaland: "13", manipur: "14", mizoram: "15", tripura: "16", meghalaya: "17",
  assam: "18", "west bengal": "19", jharkhand: "20", odisha: "21", chhattisgarh: "22", "madhya pradesh": "23",
  gujarat: "24", "dadra and nagar haveli and daman and diu": "26", maharashtra: "27", karnataka: "29", goa: "30",
  lakshadweep: "31", kerala: "32", "tamil nadu": "33", puducherry: "34", "andaman and nicobar islands": "35",
  telangana: "36", "andhra pradesh": "37", ladakh: "38",
};
const stateNameForCode = (code: string) =>
  Object.entries(STATE_CODES).find(([, value]) => value === code)?.[0]
    ?.replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? "";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const money = (value: number) => Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupees = (value: number) => `Rs. ${money(value)}`;

/** `phones`: each godown's contact mobile (its channel partner's), printed on that godown's invoices. */
type InvoiceContext = { company: InvoiceCompany; prefix: string; pickup: PickupSettings; branches: Branch[]; phones: Map<string, string> };

async function loadInvoiceContext(): Promise<InvoiceContext> {
  const fallback: InvoiceContext = { company: DEFAULT_INVOICE_COMPANY, prefix: "GB/INV/", pickup: defaultPickupSettings, branches: [DEMO_BRANCH], phones: new Map() };
  if (STATIC_DATA_MODE) return fallback;
  try {
    const [{ data }, { data: branchRows }, { data: phoneRows }] = await Promise.all([
      supabase.from("settings").select("key,value").eq("is_public", true).in("key", ["company", "tax", PICKUP_SETTINGS_KEY]),
      supabase.from("branches").select("*"),
      supabase.rpc("godown_contact_phones"),
    ]);
    const byKey = new Map((data ?? []).map((row) => [row.key, asRecord(row.value)]));
    const saved = byKey.get("company") ?? {};
    const company: InvoiceCompany = { ...DEFAULT_INVOICE_COMPANY };
    if (text(saved["legal_name"]) || text(saved["name"])) company.legalName = text(saved["legal_name"]) || text(saved["name"]);
    if (text(saved["address"])) company.addressLines = text(saved["address"]).split(/\n|,(?=\s*[A-Z][a-z]+ \d{6})/).map((line) => line.trim()).filter(Boolean);
    const gstin = text(saved["gstin"]).toUpperCase();
    if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
      company.gstin = gstin;
      company.stateCode = gstin.slice(0, 2);
      company.stateName = stateNameForCode(company.stateCode) || company.stateName;
      company.pan = gstin.slice(2, 12);
    }
    if (text(saved["pan"])) company.pan = text(saved["pan"]).toUpperCase();
    if (text(saved["phone"])) company.phone = text(saved["phone"]);
    if (text(saved["email"])) company.email = text(saved["email"]);
    const prefix = text((byKey.get("tax") ?? {})["invoice_prefix"]).slice(0, 40).replace(/[^A-Za-z0-9._/-]/g, "");
    return {
      company,
      prefix: prefix || fallback.prefix,
      pickup: byKey.has(PICKUP_SETTINGS_KEY) ? parsePickupSettings(byKey.get(PICKUP_SETTINGS_KEY)) : defaultPickupSettings,
      branches: (branchRows ?? []).map((row) => branchFromRow(row as Record<string, unknown>)),
      phones: new Map((phoneRows ?? []).filter((row) => row.phone).map((row) => [row.branch_id, row.phone as string])),
    };
  } catch {
    return fallback;
  }
}

/**
 * The latest facts when the invoice is pulled (Zoho's number and date, the payments, what is paid). Never from the page's
 * memory, so a payment recorded or removed a moment ago shows at once.
 */
async function loadInvoiceFacts(orderNo: string): Promise<InvoiceFacts> {
  const none: InvoiceFacts = { zoho: null, payments: [], paid: null };
  if (STATIC_DATA_MODE) return none;
  try {
    const { data: row } = await supabase.from("orders").select("id,paid_amount").eq("order_no", orderNo).maybeSingle();
    if (!row) return none;
    const [{ data: zoho }, { data: payments }, customerNumber] = await Promise.all([
      supabase.from("zoho_order_invoices").select("invoice_number,status,invoice_date").eq("order_id", row.id).maybeSingle(),
      // A vendor's account cannot read payments: its copy shows the totals only.
      supabase.from("payments").select("amount,method,status,txn_ref,created_at").eq("order_id", row.id),
      loadCustomerNumber(orderNo),
    ]);
    return { zoho: (zoho as ZohoInvoiceCopy | null) ?? null, payments: invoicePayments((payments ?? []) as InvoicePaymentRow[]), paid: Number(row.paid_amount), customerNumber };
  } catch {
    return none;
  }
}

/**
 * Zoho's customer number of the order's customer, printed under Bill to. The database tells only those who may open the
 * customer copy (the customer, admins, the signing channel partner: public.invoice_customer_number); anyone else, a
 * database without the 12 Nov 2026 update, or a customer with no number in Zoho gets null, and no line is printed.
 */
async function loadCustomerNumber(orderNo: string): Promise<string | null> {
  if (STATIC_DATA_MODE) return null;
  try {
    const { data, error } = await supabase.rpc("invoice_customer_number", { _order_no: orderNo });
    return error ? null : cleanContactNumber(data);
  } catch {
    return null;
  }
}

/** A stored signature as an image for the PDF, or null. */
async function loadSignature(path: string | null | undefined): Promise<string | null> {
  if (!path || STATIC_DATA_MODE) return null;
  try {
    const { data, error } = await supabase.storage.from(GODOWN_SIGNATURE_BUCKET).download(path);
    if (error || !data) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(data);
    });
  } catch {
    return null;
  }
}

/**
 * The signature on an order's invoice: its channel partner's, i.e. the partner who ran the godown when the order was
 * placed (so an old invoice keeps the old partner's after a change); else the godown's own (Admin > Branches); else
 * null, and the blank signature line is printed. The database tells only those who may open the invoice.
 */
async function loadOrderSignature(orderNo: string, godownPath: string | null | undefined): Promise<string | null> {
  if (STATIC_DATA_MODE) return null;
  let partnerPath: string | null = null;
  try {
    const { data, error } = await supabase.rpc("invoice_partner_signature", { _order_no: orderNo });
    if (!error && typeof data === "string" && data) partnerPath = data;
  } catch {
    partnerPath = null;
  }
  return (partnerPath ? await loadSignature(partnerPath) : null) ?? await loadSignature(godownPath);
}

/**
 * The order's delivery QR code, asked of the database every time the invoice is built: never kept in the page or the
 * browser, so a QR an admin replaced never prints again. Only the order's customer, its signing channel partner and
 * admins get one; anyone else (a vendor's office copy) is refused, and that invoice simply has no QR. A failed read
 * also means no QR: the invoice still builds.
 */
async function loadDeliveryCode(orderNo: string): Promise<InvoiceDelivery | null> {
  if (STATIC_DATA_MODE) return null;
  try {
    const { data, error } = await supabase.rpc("invoice_delivery_code", { _order_no: orderNo });
    return error ? null : invoiceDelivery(data);
  } catch {
    return null;
  }
}

/** `facts`: already read by whoever may (the channel partner's copy); otherwise read here as the signed-in account. */
export type InvoiceOptions = { copy?: InvoiceCopy; catalog?: Product[]; facts?: InvoiceFacts };

/** Builds the invoice PDF. Returns the document and its file name. */
export async function buildInvoicePdf(order: Order, options: InvoiceOptions = {}) {
  const copy = options.copy ?? "customer";
  // The logo as a small PNG (the file is a 1920 px WebP): one copy embedded, used by the letterhead and the watermark.
  const [{ GState, jsPDF }, context, logo, facts] = await Promise.all([import("jspdf"), loadInvoiceContext(), loadLogoPng(), options.facts ?? loadInvoiceFacts(order.id)]);
  const { company } = context;
  const pdf: JsPdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  // The tax invoice is the one Zoho Books issues, so it carries Zoho's number. Until Zoho has one, this is a proforma.
  const zohoNumber = issuedZohoNumber(facts.zoho);
  // The delivery QR goes on a tax invoice only; it is read while the signature loads.
  const deliveryRead = !zohoNumber ? Promise.resolve(null) : facts.delivery !== undefined ? Promise.resolve(facts.delivery) : loadDeliveryCode(order.id);
  // Zoho's customer number: with the facts when they were read here; asked now when the caller's facts left it out.
  const customerNumberRead = facts.customerNumber !== undefined ? Promise.resolve(facts.customerNumber) : loadCustomerNumber(order.id);
  const signature = await loadOrderSignature(order.id, (context.branches.find((branch) => branch.id === order.branchId) ?? defaultBranchOf(context.branches))?.signaturePath);
  const delivery = await deliveryRead;
  const qrCode = invoiceQrCode(zohoNumber, delivery);
  const customerNumber = await customerNumberRead;
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 14;
  const R = W - M;
  const usable = W - M * 2;
  const navy: [number, number, number] = [32, 72, 58];
  const gold: [number, number, number] = [196, 150, 52];
  const ink: [number, number, number] = [28, 37, 46];
  const muted: [number, number, number] = [102, 112, 124];
  const rule: [number, number, number] = [222, 226, 230];
  const card: [number, number, number] = [246, 248, 251];

  const invoiceNo = zohoNumber ?? "";
  const orderDate = new Date(order.createdAt || order.date);
  const dateText = Number.isNaN(orderDate.getTime())
    ? order.date
    : orderDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const zohoDate = facts.zoho?.invoice_date ? new Date(`${facts.zoho.invoice_date}T00:00:00Z`) : null;
  const invoiceDateText = zohoDate && !Number.isNaN(zohoDate.getTime())
    ? zohoDate.toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" })
    : dateText;

  // Place of supply: goods collected at the godown are supplied in the godown's state; delivered
  // goods in the delivery state. Same state as the seller -> CGST + SGST, otherwise IGST.
  // The order's godown: collected there when the order is a pickup (or was placed while only
  // pickup was offered); otherwise delivered to the customer's address.
  const orderBranch = context.branches.find((branch) => branch.id === order.branchId) ?? defaultBranchOf(context.branches);
  const isPickup = /^pickup/i.test(order.delivery || "") || (order.shipping === 0 && !(orderBranch?.deliveryEnabled ?? context.pickup.homeDelivery));
  const legacyPoint = pickupPointForPin(context.pickup, order.pin);
  // The godown's contact on its invoices: that area's channel partner's mobile, else the godown's phone.
  const godownPhone = (orderBranch && context.phones.get(orderBranch.id)) || orderBranch?.phone || company.phone;
  const pickupPoint = !isPickup ? null : orderBranch
    ? { name: orderBranch.name, address: orderBranch.address, phone: godownPhone, instructions: orderBranch.instructions, mapUrl: orderBranch.mapUrl }
    : legacyPoint;
  // "Collect goods from here" under the notes (owner, 13 Nov 2026), with the godown's location QR when Admin > Godowns
  // has its location link: on every copy of a collect-from-godown order. The phone and the pickup instructions are in the
  // PICKUP FROM card at the top, so the block does not repeat them (it kept the delivery QR off the first page).
  const collectPoint: CollectPoint | null = !pickupPoint ? null : {
    name: pickupPoint.name,
    address: orderBranch ? collectAddressLine(orderBranch) : pickupPoint.address,
    mapUrl: pickupPoint.mapUrl,
  };
  const customerGstState = /^[0-9]{2}/.test(order.gstin ?? "") ? order.gstin!.slice(0, 2) : "";
  const deliveryStateCode = STATE_CODES[(order.state || "").trim().toLowerCase()] ?? "";
  const supplyCode = pickupPoint ? orderBranch?.stateCode || company.stateCode : customerGstState || deliveryStateCode || company.stateCode;
  const supplyName = stateNameForCode(supplyCode) || (pickupPoint ? company.stateName : order.state) || company.stateName;
  const intraState = supplyCode === company.stateCode;

  const lines = invoiceLines(order, options.catalog ?? [], { intraState });
  const taxableTotal = round2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const taxTotal = round2(lines.reduce((sum, line) => sum + line.tax, 0));
  const { paid, balance } = invoiceBalance(order.amount, facts.paid ?? order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0));
  // A coupon on an order whose prices include GST already came off each line above.
  const couponInLines = Boolean(order.pricesIncludeGst) && order.discount > 0;
  const computedTotal = round2(taxableTotal - (couponInLines ? 0 : Math.abs(order.discount)) + taxTotal + order.shipping);
  const roundOff = round2(order.amount - computedTotal);

  /*
   * The GB logo, light and centred (owner, 11 Nov 2026: "a little darker than today"). It is drawn last on each page, over
   * everything, so the navy table band and the card fills cannot hide it; at 9% it tints them without hiding any text.
   */
  const watermark = () => {
    if (!logo) return;
    try {
      const props = pdf.getImageProperties(logo);
      const w = 110;
      const h = props.width ? (w * props.height) / props.width : w;
      pdf.setGState(new GState({ opacity: 0.09 }));
      pdf.addImage(logo, "PNG", (W - w) / 2, (H - h) / 2, w, h, "gb-logo", "FAST");
    } catch {
      /* watermark is decorative */
    } finally {
      pdf.setGState(new GState({ opacity: 1 }));
    }
  };

  /*
   * The delivery QR (owner, 11-12 Nov 2026: on the invoice, "in the bottom not top"): the last thing on the invoice,
   * under the terms and the signature, with the owner's note and the godown beside it and, once the godown has handed
   * the goods over, who did it under it. Before that it is about 33 mm, which fits in the space an ordinary order
   * leaves above the footer, so it stays on one page.
   */
  const QR_SIZE = 30;

  const brandHeader = (continued: boolean) => {
    // The same alias as the watermark: the picture is stored once in the file however often it is drawn.
    if (logo) pdf.addImage(logo, "PNG", M, 10, 18, 18, "gb-logo", "FAST");
    const tx = M + (logo ? 22 : 0);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(17);
    pdf.setTextColor(...navy);
    pdf.text("GRAIN BAZAR", tx, 18);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    pdf.text(`A brand of ${company.legalName}`, tx, 23.5);
    pdf.text(`GSTIN ${company.gstin}  ·  ${godownPhone}  ·  ${company.email}`, tx, 27.5);
    const right = R;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.setTextColor(...ink);
    const heading = zohoNumber ? "TAX INVOICE" : "PROFORMA INVOICE";
    pdf.text(continued ? `${heading} (contd.)` : heading, right, 17, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    pdf.text(copy === "customer" ? "Original for Recipient" : "Duplicate for Supplier (office copy)", right, 22.5, { align: "right" });
    pdf.text(zohoNumber ? `Invoice ${invoiceNo}` : `Order ${order.id}`, R, 27.5, { align: "right" });
    pdf.setDrawColor(...gold);
    pdf.setLineWidth(0.7);
    pdf.line(M, 32, R, 32);
    pdf.setLineWidth(0.2);
    return 38;
  };

  /**
   * What the band's text column holds, measured before anything is drawn: the owner's note, its Kannada picture, and
   * the godown that gives the goods with its channel partner (owner, 11 Nov 2026: "accordingly godown details"). The
   * band is as tall as the QR, or as this column when that is taller.
   */
  const qrBandText = (facts: InvoiceDelivery | null) => {
    const tx = M + QR_SIZE + 6;
    const textW = R - tx;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    const noteLines = pdf.splitTextToSize(DELIVERY_QR_NOTE.en, textW) as string[];
    // The PDF's own fonts have no Kannada: the browser draws that line as a picture (there is none outside a browser).
    const kannada = canvasTextImage(DELIVERY_QR_NOTE.kn, { sizePt: 7.5, maxWidthMm: textW, color: ink });
    const godown = godownLine(facts?.godown);
    pdf.setFontSize(7);
    const godownLines = godown ? (pdf.splitTextToSize(`Godown: ${godown}`, textW) as string[]) : [];
    const column = 3 + 4.6 + noteLines.length * 3.6 + 1 + 2 + (kannada?.height ?? 0) + (godownLines.length ? 0.6 + godownLines.length * 2.9 : 0);
    return { tx, noteLines, kannada, godownLines, height: 2 + Math.max(QR_SIZE, column) + 1 };
  };

  /**
   * The delivery QR at the bottom of the invoice: a ruled band with the QR on the left and, beside it, the heading, the
   * owner's note, the order number, the note in Kannada and the godown. Returns the band's bottom.
   */
  const deliveryQrBlock = (code: string, top: number, band: ReturnType<typeof qrBandText>) => {
    const origin = typeof window === "undefined" ? "https://grainbazar.com" : deliveryQrOrigin(window.location.hostname, window.location.origin);
    pdf.setDrawColor(...rule);
    pdf.line(M, top, R, top);
    const qrTop = top + 2;
    drawPdfQr(pdf, deliveryQrLink(origin, code), M, qrTop, QR_SIZE);
    pdf.setDrawColor(...rule);
    pdf.rect(M, qrTop, QR_SIZE, QR_SIZE);
    const { tx } = band;
    let at = qrTop + 3;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.setTextColor(...navy);
    pdf.text("DELIVERY QR", tx, at);
    at += 4.6;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(...ink);
    pdf.text(band.noteLines, tx, at);
    at += band.noteLines.length * 3.6 + 1;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...navy);
    pdf.text(`Order ${order.id}${zohoNumber ? `  ·  Invoice ${invoiceNo}` : ""}`, tx, at);
    at += 2;
    if (band.kannada) {
      try {
        pdf.addImage(band.kannada.dataUrl, "PNG", tx, at, band.kannada.width, band.kannada.height, undefined, "FAST");
      } catch {
        /* the English note above still says it */
      }
      at += band.kannada.height;
    }
    if (band.godownLines.length) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(...ink);
      at += 0.6;
      band.godownLines.forEach((line, index) => pdf.text(line, tx, at + 2.3 + index * 2.9));
    }
    return top + band.height;
  };

  /**
   * Under the QR (owner, 11 Nov 2026: "below QR code it should mention who handed over goods and time"): who handed
   * over which item, when, with their role and mobile, at which godown, in English and Kannada; nothing before any
   * hand-over. Measured first, so the QR and these lines stay on one page together.
   */
  const handoverBlock = (facts: InvoiceDelivery | null) => {
    const LABEL_W = 23;
    const LINE = 3.05;
    const GAP = 0.9;
    const textX = M + LABEL_W;
    const textW = R - textX;
    type Row = { label: string; lines: string[]; kannada: ReturnType<typeof canvasTextImage>; beside: boolean };
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.4);
    // Before any hand-over the invoice prints nothing here (the order page says "not handed over yet"), so an
    // ordinary order stays on one page; the lines come once the godown hands the goods over.
    const words = handoverWords(facts, order.status);
    const rows: Row[] = (words.done ? words.lines : []).map((line, index) => {
      const lines = pdf.splitTextToSize(line.en, textW) as string[];
      const kannada = canvasTextImage(line.kn, { sizePt: 7, maxWidthMm: textW, color: ink });
      // A short sentence ("Not handed over yet.") keeps its Kannada beside it, on the same line.
      const beside = Boolean(kannada) && lines.length === 1 && pdf.getTextWidth(lines[0] ?? "") + 3 + (kannada?.width ?? 0) <= textW;
      return { label: index === 0 ? "HANDED OVER" : "", lines, kannada, beside };
    });
    const rowHeight = (row: Row) => (row.beside && row.kannada
      ? Math.max(LINE, row.kannada.height)
      : row.lines.length * LINE + (row.kannada ? 0.2 + row.kannada.height : 0));
    // A small gap above the rows and between them; none after the last.
    const height = rows.length ? 0.8 + rows.reduce((sum, row) => sum + rowHeight(row), 0) + GAP * (rows.length - 1) : 0;
    const draw = (top: number) => {
      let at = top + 0.8;
      rows.forEach((row, rowIndex) => {
        // A long list (many items handed over one at a time) carries on onto the next page, never over the footer.
        let label = row.label;
        if (at + rowHeight(row) > H - 17) {
          newPage(false);
          at = y + 0.8;
          label = "HANDED OVER (contd.)";
        }
        const baseline = at + 2.3;
        if (label) {
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(7.4);
          pdf.setTextColor(...navy);
          pdf.text(pdf.splitTextToSize(label, LABEL_W - 1) as string[], M, baseline);
        }
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7.4);
        pdf.setTextColor(...ink);
        row.lines.forEach((text, index) => pdf.text(text, textX, baseline + index * LINE));
        if (row.kannada) {
          const x = row.beside ? textX + pdf.getTextWidth(row.lines[0] ?? "") + 3 : textX;
          const imageTop = row.beside ? at : at + row.lines.length * LINE + 0.2;
          try {
            pdf.addImage(row.kannada.dataUrl, "PNG", x, imageTop, row.kannada.width, row.kannada.height, undefined, "FAST");
          } catch {
            /* the English sentence still says it */
          }
        }
        at += rowHeight(row) + (rowIndex < rows.length - 1 ? GAP : 0);
      });
      return at;
    };
    return { height, draw };
  };

  let y = 0;
  const newPage = (first: boolean) => {
    if (!first) pdf.addPage();
    y = brandHeader(!first);
  };
  newPage(true);

  // Invoice / order details (two columns of label : value).
  const meta: [string, string][] = [
    ["Invoice No.", zohoNumber ? invoiceNo : "To be issued"],
    ["Invoice Date", zohoNumber ? invoiceDateText : "To be issued"],
    ["Order No.", order.id],
    ["Order Date", dateText],
    ["Place of Supply", `${supplyName} (${supplyCode})`],
    ["Payment", `${order.method || "Online"} · ${order.payment}`],
    ["Fulfilment", pickupPoint ? "Pickup from godown" : order.delivery || "Delivery"],
  ];
  pdf.setFontSize(8.5);
  {
    const colW = usable / 2;
    meta.forEach(([label, value], index) => {
      const x = M + (index % 2) * colW;
      const rowY = y + Math.floor(index / 2) * 5.2;
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(...muted);
      pdf.text(label, x, rowY);
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(...ink);
      pdf.text(`:  ${value}`, x + 27, rowY, { maxWidth: colW - 30 });
    });
    y += Math.ceil(meta.length / 2) * 5.2 + 3;
  }

  // Address cards (the "Sold by" card style), three across.
  const cardGap = 4;
  const cardW = (usable - cardGap * 2) / 3;
  const shipTitle = pickupPoint ? "Pickup from" : "Ship to";
  // Saved addresses often already end with the city/state/PIN; do not print them twice.
  const cityLine = [order.city, order.state, order.pin].filter(Boolean).join(", ");
  const addressHasCity = !!order.pin && (order.address || "").includes(order.pin);
  const shipRows = pickupPoint
    ? [pickupPoint.name, pickupPoint.address, pickupPoint.phone ? `Phone ${pickupPoint.phone}` : "", pickupPoint.instructions]
    : [order.customer, order.address, addressHasCity ? "" : cityLine, order.phone ? `Phone ${order.phone}` : ""];
  const cards: { title: string; rows: string[] }[] = [
    { title: "Sold by", rows: [company.legalName, company.brand, ...sellerAddressLines(orderBranch?.address, company.addressLines), `GSTIN ${company.gstin}`, `Phone ${godownPhone}`] },
    {
      title: "Bill to",
      rows: [
        // A business purchase is billed to the legal name registered with its GSTIN.
        order.businessName || order.customer || "Customer",
        order.businessName && order.customer ? `Attn: ${order.customer}` : "",
        // "Customer No. CUS-00012": the customer's number in Zoho Books, when Zoho has given one.
        contactNumberLine("customer", customerNumber),
        order.address,
        addressHasCity ? "" : cityLine,
        order.phone ? `Phone ${order.phone}` : "",
        order.email,
        order.gstin ? `GSTIN ${order.gstin}` : order.businessName ? "Unregistered business (no GSTIN)" : "Unregistered (B2C)",
      ],
    },
    { title: shipTitle, rows: shipRows },
  ];
  const wrapped = cards.map((entry) => entry.rows.filter(Boolean)
    .flatMap((row, index) => {
      pdf.setFont("helvetica", index === 0 ? "bold" : "normal");
      pdf.setFontSize(8.3);
      return (pdf.splitTextToSize(row, cardW - 8) as string[]).map((part) => ({ part, bold: index === 0 }));
    }));
  const cardH = Math.max(...wrapped.map((rows) => rows.length)) * 3.9 + 12;
  cards.forEach((entry, index) => {
    const x = M + index * (cardW + cardGap);
    pdf.setFillColor(...card);
    pdf.roundedRect(x, y, cardW, cardH, 2.2, 2.2, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.5);
    pdf.setTextColor(...muted);
    pdf.text(entry.title.toUpperCase(), x + 4, y + 6);
    let rowY = y + 11;
    for (const { part, bold } of wrapped[index]!) {
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(8.3);
      pdf.setTextColor(...ink);
      pdf.text(part, x + 4, rowY);
      rowY += 3.9;
    }
  });
  y += cardH + 6;

  // Items table.
  const cols = intraState
    ? [
      { key: "no", label: "#", w: 7, align: "left" as const },
      { key: "item", label: "Item & Description", w: 50, align: "left" as const },
      { key: "hsn", label: "HSN/SAC", w: 16, align: "left" as const },
      { key: "qty", label: "Qty", w: 13, align: "right" as const },
      { key: "rate", label: "Rate", w: 18, align: "right" as const },
      { key: "taxable", label: "Taxable", w: 19, align: "right" as const },
      { key: "cgst", label: "CGST", w: 18, align: "right" as const },
      { key: "sgst", label: "SGST", w: 18, align: "right" as const },
      { key: "amount", label: "Amount", w: 23, align: "right" as const },
    ]
    : [
      { key: "no", label: "#", w: 7, align: "left" as const },
      { key: "item", label: "Item & Description", w: 61, align: "left" as const },
      { key: "hsn", label: "HSN/SAC", w: 16, align: "left" as const },
      { key: "qty", label: "Qty", w: 14, align: "right" as const },
      { key: "rate", label: "Rate", w: 19, align: "right" as const },
      { key: "taxable", label: "Taxable", w: 20, align: "right" as const },
      { key: "igst", label: "IGST", w: 21, align: "right" as const },
      { key: "amount", label: "Amount", w: 24, align: "right" as const },
    ];
  const scale = usable / cols.reduce((sum, col) => sum + col.w, 0);
  let cursor = M;
  const positioned = cols.map((col) => {
    const width = col.w * scale;
    const entry = { ...col, x: cursor, width };
    cursor += width;
    return entry;
  });
  const cellX = (col: (typeof positioned)[number]) => (col.align === "right" ? col.x + col.width - 1.5 : col.x + 1.5);

  const tableHeader = () => {
    pdf.setFillColor(...navy);
    pdf.rect(M, y, usable, 9, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.4);
    pdf.setTextColor(255, 255, 255);
    for (const col of positioned) pdf.text(col.label, cellX(col), y + 5.9, { align: col.align });
    y += 9;
  };
  tableHeader();

  const bottomLimit = H - 24;
  lines.forEach((line, index) => {
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8.2);
    const itemCol = positioned.find((col) => col.key === "item")!;
    const nameParts = pdf.splitTextToSize(line.name, itemCol.width - 3) as string[];
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    const extra = [line.detail, copy === "office" && line.vendor ? `Fulfilled by ${line.vendor}` : ""].filter(Boolean)
      .flatMap((row) => pdf.splitTextToSize(row, itemCol.width - 3) as string[]);
    const rowH = Math.max(11, nameParts.length * 3.8 + extra.length * 3.3 + 4);
    if (y + rowH > bottomLimit) {
      newPage(false);
      tableHeader();
    }
    if (index % 2 === 1) {
      pdf.setFillColor(250, 251, 252);
      pdf.rect(M, y, usable, rowH, "F");
    }
    const half = round2(line.tax / 2);
    const values: Record<string, string[]> = {
      no: [String(index + 1)],
      hsn: [line.hsn || "—"],
      qty: [String(line.qty), line.unit],
      rate: [money(line.rate)],
      taxable: [money(line.taxable)],
      cgst: [`${line.gstRate / 2}%`, money(half)],
      sgst: [`${line.gstRate / 2}%`, money(round2(line.tax - half))],
      igst: [`${line.gstRate}%`, money(line.tax)],
      amount: [money(round2(line.taxable + line.tax))],
    };
    for (const col of positioned) {
      if (col.key === "item") {
        let ty = y + 4.6;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.2);
        pdf.setTextColor(...ink);
        for (const part of nameParts) { pdf.text(part, cellX(col), ty); ty += 3.8; }
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        pdf.setTextColor(...muted);
        for (const part of extra) { pdf.text(part, cellX(col), ty); ty += 3.3; }
        continue;
      }
      const cell = values[col.key] ?? [""];
      pdf.setFont("helvetica", col.key === "amount" ? "bold" : "normal");
      pdf.setFontSize(8.2);
      pdf.setTextColor(...ink);
      pdf.text(cell[0] ?? "", cellX(col), y + 4.6, { align: col.align });
      if (cell[1]) {
        pdf.setFontSize(7);
        pdf.setTextColor(...muted);
        pdf.text(cell[1], cellX(col), y + 8.3, { align: col.align });
      }
    }
    y += rowH;
    pdf.setDrawColor(...rule);
    pdf.line(M, y, R, y);
  });

  // Totals block (right) and amount in words (left).
  const summaryRows: [string, number][] = [["Sub Total (taxable)", taxableTotal]];
  if (order.discount && !couponInLines) summaryRows.push(["Discount", -Math.abs(order.discount)]);
  if (intraState) {
    const cgst = round2(taxTotal / 2);
    summaryRows.push(["CGST", cgst], ["SGST", round2(taxTotal - cgst)]);
  } else {
    summaryRows.push(["IGST", taxTotal]);
  }
  summaryRows.push([pickupPoint ? "Pickup charges" : "Shipping charges", order.shipping]);
  if (roundOff !== 0 && Math.abs(roundOff) < 1) summaryRows.push(["Round off", roundOff]);
  const summaryH = summaryRows.length * 5.6 + 26;
  const sumW = 78;
  // The left column, measured before anything is drawn: the total in words, the notes and, for an order collected from
  // a godown, the "Collect goods from here" block (owner, 13 Nov 2026). It must fit beside the totals, or both move on.
  const leftW = usable - sumW - 10;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.6);
  const words = pdf.splitTextToSize(`Indian Rupee ${numberToIndianWords(order.amount).replace(/ Rupees/, "")}`, leftW) as string[];
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  const notes = [
    `Order ${order.id} placed on Grain Bazar.`,
    // The goods are handed over against the delivery QR now, not the order number (owner, 11 Nov 2026). Where to collect
    // them is the block under the notes (owner, 13 Nov 2026), so the note no longer names the godown. The location QR may
    // sit right under this note, so it names the DELIVERY QR band at the bottom: that is the one shown at the counter.
    pickupPoint ? (qrCode
      ? "At the godown counter, show the DELIVERY QR at the bottom."
      : "The tax invoice carries your DELIVERY QR once the payment is confirmed; show it at the godown counter.") : "",
    !facts.payments.length && (order.utr || order.txn) ? `Payment reference: ${order.utr || order.txn}` : "",
    couponInLines ? `Coupon ${order.coupon ?? ""}: Rs. ${money(order.discount)} taken off the items above in proportion, with the GST on it.`.replace("  ", " ") : "",
    zohoNumber ? "" : "Proforma: the tax invoice number comes from Zoho Books once the invoice is raised.",
    copy === "office" ? "Office copy: includes fulfilling vendor details. Do not share with the customer." : "",
  ].filter(Boolean).flatMap((note) => pdf.splitTextToSize(note, leftW) as string[]);
  const collect = collectPoint ? collectFromBlock(pdf, collectPoint, leftW, { ink, muted, navy, rule }) : null;
  // `ly` runs a line step (3.8 mm) past the notes' last line: the block starts about 1.4 mm under that line's text.
  const COLLECT_GAP = -1.8;
  const leftH = 5 + words.length * 4 + 4 + 4.5 + notes.length * 3.8 + (collect ? COLLECT_GAP + collect.height : 0);
  if (y + summaryH + 52 > bottomLimit || y + 6 + leftH > bottomLimit) newPage(false);
  y += 6;
  const sumX = R - sumW;
  let sy = y;
  pdf.setFontSize(8.6);
  for (const [label, value] of summaryRows) {
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(...muted);
    pdf.text(label, sumX, sy);
    pdf.setTextColor(...ink);
    pdf.text(value === 0 && label.endsWith("charges") ? "Free" : money(value), R, sy, { align: "right" });
    sy += 5.6;
  }
  pdf.setFillColor(...navy);
  pdf.roundedRect(sumX - 3, sy - 3.6, sumW + 3, 9, 1.5, 1.5, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10.5);
  pdf.setTextColor(255, 255, 255);
  pdf.text("Total", sumX, sy + 2.3);
  pdf.text(rupees(order.amount), R - 1.5, sy + 2.3, { align: "right" });
  sy += 11;
  pdf.setFontSize(8.6);
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(...muted);
  pdf.text("Amount paid", sumX, sy);
  pdf.setTextColor(...ink);
  pdf.text(money(paid), R, sy, { align: "right" });
  sy += 5.6;
  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(...(balance > 0 ? ([180, 35, 24] as [number, number, number]) : navy));
  pdf.text("Balance due", sumX, sy);
  pdf.text(rupees(balance), R, sy, { align: "right" });

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.setTextColor(...muted);
  pdf.text("TOTAL IN WORDS", M, y);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.6);
  pdf.setTextColor(...ink);
  pdf.text(words, M, y + 5);
  let ly = y + 5 + words.length * 4 + 4;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.setTextColor(...muted);
  pdf.text("NOTES", M, ly);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(...ink);
  pdf.text(notes, M, ly + 4.5);
  ly += 4.5 + notes.length * 3.8;
  // Where to collect the goods, with the godown's location QR: right under the notes, on every copy.
  if (collect) ly = collect.draw(M, ly + COLLECT_GAP);
  // The block ends on its QR or its own last line (the notes' `ly` runs a line step past theirs), so less space follows.
  y = Math.max(sy + 8, ly + (collect ? 1.8 : 4));

  // The terms and the signature line take about 31 mm. Reserving no more than that keeps an ordinary order on one page.
  const termsH = 33;

  // Every payment received, with its mode and UTR; the balance above is worked out from the same record.
  if (facts.payments.length) {
    const blockH = 11 + facts.payments.length * 4.8;
    if (y + blockH + termsH > bottomLimit) newPage(false);
    pdf.setDrawColor(...rule);
    pdf.line(M, y, R, y);
    y += 5;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7.8);
    pdf.setTextColor(...muted);
    pdf.text("PAYMENTS RECEIVED", M, y);
    y += 4.8;
    pdf.setFontSize(8.2);
    for (const payment of facts.payments) {
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(...ink);
      pdf.text(payment.date, M, y);
      pdf.text(payment.mode, M + 26, y);
      pdf.text(payment.reference ? `UTR / Ref: ${payment.reference}` : "", M + 50, y, { maxWidth: usable - 90 });
      pdf.setFont("helvetica", "bold");
      pdf.text(money(payment.amount), R, y, { align: "right" });
      y += 4.8;
    }
    y += 2;
  }

  // Terms & declaration (left) and signatory (right).
  if (y + termsH > bottomLimit) newPage(false);
  pdf.setDrawColor(...rule);
  pdf.line(M, y, R, y);
  y += 5;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.setTextColor(...muted);
  pdf.text("TERMS & CONDITIONS / DECLARATION", M, y);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7.6);
  pdf.setTextColor(...ink);
  const terms = [
    "1. Goods are released for pickup or delivery only after full payment.",
    "2. Payment amount should match the invoice amount.",
    "3. We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
    "4. Subject to Challakere jurisdiction.",
  ].flatMap((term) => pdf.splitTextToSize(term, leftW) as string[]);
  pdf.text(terms, M, y + 4.5);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(...muted);
  pdf.text(`For ${company.legalName}`, R, y + 1, { align: "right" });
  // The godown's signature, in the space above the line; the line alone when it has none.
  if (signature) {
    try {
      const props = pdf.getImageProperties(signature);
      const boxW = 58, boxH = 16;
      const scale = Math.min(boxW / props.width, boxH / props.height);
      const w = props.width * scale, h = props.height * scale;
      pdf.addImage(signature, "PNG", R - w, y + 20.5 - h, w, h);
    } catch {
      /* a damaged picture must not stop the invoice */
    }
  }
  pdf.setDrawColor(...rule);
  pdf.line(R - 58, y + 21, R, y + 21);
  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(...ink);
  pdf.text("Authorized Signatory", R, y + 25.5, { align: "right" });

  // The delivery QR at the very bottom (owner, 12 Nov 2026), under the terms and the signature. The same QR is on every
  // copy of this invoice; the godown in-charge scans it to release and hand over the goods.
  if (qrCode) {
    y += 27.5;
    // The godown beside the QR and who handed over under it (owner, 11 Nov 2026); the QR and these lines move together.
    const band = qrBandText(delivery);
    const below = handoverBlock(delivery);
    // The band may run down to just above the footer line (H - 15).
    if (y + band.height + below.height > H - 17) newPage(false);
    y = deliveryQrBlock(qrCode, y, band);
    y = below.draw(y);
  }

  // Footer on every page.
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(...rule);
    pdf.line(M, H - 15, R, H - 15);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.2);
    pdf.setTextColor(...muted);
    pdf.text(signature ? "This is a computer-generated invoice." : "This is a computer-generated invoice and does not require a physical signature.", M, H - 10.5);
    pdf.text("Whether tax is payable under reverse charge - No", M, H - 6.8);
    pdf.text(`Page ${page} of ${pages}`, R, H - 10.5, { align: "right" });
    pdf.text(`${company.brand}  ·  ${company.email}`, R, H - 6.8, { align: "right" });
    // Last on the page, so nothing drawn earlier covers it.
    watermark();
  }

  const fileName = (zohoNumber ? `Invoice-${invoiceNo}` : `Proforma-${order.id}`).replace(/[^A-Za-z0-9._-]+/g, "-") + ".pdf";
  return { pdf, fileName, invoiceNo: zohoNumber ?? order.id };
}
