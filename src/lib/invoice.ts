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

/**
 * Grain Bazar tax invoice (A4, vector PDF). Layout follows the company's Zoho tax invoice
 * (seller header, Bill To / Ship To, HSN, CGST/SGST or IGST per line, total in words, terms,
 * signatory) with an Amazon-style finish (order details, "Original for Recipient", reverse
 * charge line, page x of y) and the Grain Bazar logo as a light watermark on every page.
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

async function loadLogo(): Promise<string | null> {
  try {
    const response = await fetch("/grainbazar-logo.png");
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export function invoiceNumberFor(order: Order, prefix: string) {
  return `${prefix}${order.id.replace(/[^0-9]/g, "") || order.id}`;
}

type Line = {
  name: string;
  detail: string;
  vendor: string;
  hsn: string;
  qty: number;
  unit: string;
  rate: number;
  taxable: number;
  gstRate: number;
  tax: number;
};

/** Per-line tax, reconciled to the order's GST total (which the database calculated). */
function invoiceLines(order: Order, catalog: Product[]): Line[] {
  const lines: Line[] = order.items.map((item) => {
    const product = catalog.find((candidate) => candidate.id === item.product.id) ?? item.product;
    const rate = item.unitPrice ?? item.product.price;
    const taxable = round2(rate * item.qty);
    const gstRate = Number(item.gstRate ?? item.product.gst ?? 0);
    return {
      name: item.product.name || "Item",
      detail: [item.product.sku ? `SKU ${item.product.sku}` : "", item.capacity || product.weight ? `Pack ${item.capacity || product.weight}` : ""]
        .filter(Boolean).join("  ·  "),
      vendor: item.vendor ? `${item.vendor}${item.vendorId ? ` (${item.vendorId})` : ""}` : "",
      hsn: product.hsn || item.product.hsn || "",
      qty: item.qty,
      unit: product.unit || item.product.unit || "nos",
      rate,
      taxable,
      gstRate,
      tax: round2((taxable * gstRate) / 100),
    };
  });
  const difference = round2(order.tax - lines.reduce((sum, line) => sum + line.tax, 0));
  if (lines.length && difference !== 0 && Math.abs(difference) <= 1) {
    const largest = lines.reduce((best, line) => (line.taxable > best.taxable ? line : best), lines[0]!);
    largest.tax = round2(largest.tax + difference);
  }
  return lines;
}

export type InvoiceOptions = { copy?: InvoiceCopy; catalog?: Product[] };

/** Builds the invoice PDF. Returns the document and its file name. */
export async function buildInvoicePdf(order: Order, options: InvoiceOptions = {}) {
  const copy = options.copy ?? "customer";
  const [{ GState, jsPDF }, context, logo] = await Promise.all([import("jspdf"), loadInvoiceContext(), loadLogo()]);
  const { company } = context;
  const pdf: JsPdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
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

  const invoiceNo = invoiceNumberFor(order, context.prefix);
  const orderDate = new Date(order.createdAt || order.date);
  const dateText = Number.isNaN(orderDate.getTime())
    ? order.date
    : orderDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

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
    ? { name: orderBranch.name, address: orderBranch.address, phone: godownPhone, instructions: orderBranch.instructions }
    : legacyPoint;
  const customerGstState = /^[0-9]{2}/.test(order.gstin ?? "") ? order.gstin!.slice(0, 2) : "";
  const deliveryStateCode = STATE_CODES[(order.state || "").trim().toLowerCase()] ?? "";
  const supplyCode = pickupPoint ? orderBranch?.stateCode || company.stateCode : customerGstState || deliveryStateCode || company.stateCode;
  const supplyName = stateNameForCode(supplyCode) || (pickupPoint ? company.stateName : order.state) || company.stateName;
  const intraState = supplyCode === company.stateCode;

  const lines = invoiceLines(order, options.catalog ?? []);
  const taxableTotal = round2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const taxTotal = round2(lines.reduce((sum, line) => sum + line.tax, 0));
  const paid = Math.max(0, Math.min(order.amount, order.paidAmount ?? (order.payment === "Paid" ? order.amount : 0)));
  const balance = round2(order.amount - paid);
  const computedTotal = round2(taxableTotal - Math.abs(order.discount) + taxTotal + order.shipping);
  const roundOff = round2(order.amount - computedTotal);

  const watermark = () => {
    if (!logo) return;
    try {
      pdf.setGState(new GState({ opacity: 0.06 }));
      pdf.addImage(logo, "PNG", (W - 110) / 2, (H - 110) / 2, 110, 110);
    } catch {
      /* watermark is decorative */
    } finally {
      pdf.setGState(new GState({ opacity: 1 }));
    }
  };

  const brandHeader = (continued: boolean) => {
    if (logo) pdf.addImage(logo, "PNG", M, 10, 18, 18);
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
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.setTextColor(...ink);
    pdf.text(continued ? "TAX INVOICE (contd.)" : "TAX INVOICE", R, 17, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    pdf.text(copy === "customer" ? "Original for Recipient" : "Duplicate for Supplier (office copy)", R, 22.5, { align: "right" });
    pdf.text(`Invoice ${invoiceNo}`, R, 27.5, { align: "right" });
    pdf.setDrawColor(...gold);
    pdf.setLineWidth(0.7);
    pdf.line(M, 32, R, 32);
    pdf.setLineWidth(0.2);
    return 38;
  };

  let y = 0;
  const newPage = (first: boolean) => {
    if (!first) pdf.addPage();
    watermark();
    y = brandHeader(!first);
  };
  newPage(true);

  // Invoice / order details (two columns of label : value).
  const meta: [string, string][] = [
    ["Invoice No.", invoiceNo],
    ["Invoice Date", dateText],
    ["Order No.", order.id],
    ["Order Date", dateText],
    ["Place of Supply", `${supplyName} (${supplyCode})`],
    ["Payment", `${order.method || "Online"} · ${order.payment}`],
    ["Fulfilment", pickupPoint ? "Pickup from godown" : order.delivery || "Delivery"],
  ];
  pdf.setFontSize(8.5);
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
    { title: "Sold by", rows: [company.legalName, company.brand, ...company.addressLines, `GSTIN ${company.gstin}`, `Phone ${godownPhone}`] },
    {
      title: "Bill to",
      rows: [
        // A business purchase is billed to the legal name registered with its GSTIN.
        order.businessName || order.customer || "Customer",
        order.businessName && order.customer ? `Attn: ${order.customer}` : "",
        order.address,
        addressHasCity ? "" : cityLine,
        order.phone ? `Phone ${order.phone}` : "",
        order.email,
        order.gstin ? `GSTIN ${order.gstin}` : "Unregistered (B2C)",
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
  if (order.discount) summaryRows.push(["Discount", -Math.abs(order.discount)]);
  if (intraState) {
    const cgst = round2(taxTotal / 2);
    summaryRows.push(["CGST", cgst], ["SGST", round2(taxTotal - cgst)]);
  } else {
    summaryRows.push(["IGST", taxTotal]);
  }
  summaryRows.push([pickupPoint ? "Pickup charges" : "Shipping charges", order.shipping]);
  if (roundOff !== 0 && Math.abs(roundOff) < 1) summaryRows.push(["Round off", roundOff]);
  const summaryH = summaryRows.length * 5.6 + 26;
  if (y + summaryH + 52 > bottomLimit) newPage(false);
  y += 6;
  const sumW = 78;
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

  const leftW = usable - sumW - 10;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.setTextColor(...muted);
  pdf.text("TOTAL IN WORDS", M, y);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.6);
  pdf.setTextColor(...ink);
  const words = pdf.splitTextToSize(`Indian Rupee ${numberToIndianWords(order.amount).replace(/ Rupees/, "")}`, leftW) as string[];
  pdf.text(words, M, y + 5);
  let ly = y + 5 + words.length * 4 + 4;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  pdf.setTextColor(...muted);
  pdf.text("NOTES", M, ly);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(...ink);
  const notes = [
    `Order ${order.id} placed on Grain Bazar.`,
    pickupPoint ? `Collect from ${pickupPoint.name}. Bring this invoice or your order number.` : "",
    order.utr || order.txn ? `Payment reference: ${order.utr || order.txn}` : "",
    copy === "office" ? "Office copy: includes fulfilling vendor details. Do not share with the customer." : "",
  ].filter(Boolean).flatMap((note) => pdf.splitTextToSize(note, leftW) as string[]);
  pdf.text(notes, M, ly + 4.5);
  ly += 4.5 + notes.length * 3.8;
  y = Math.max(sy + 8, ly + 4);

  // Terms & declaration (left) and signatory (right).
  if (y + 40 > bottomLimit) newPage(false);
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
  pdf.setDrawColor(...rule);
  pdf.line(R - 58, y + 21, R, y + 21);
  pdf.setFont("helvetica", "bold");
  pdf.setTextColor(...ink);
  pdf.text("Authorized Signatory", R, y + 25.5, { align: "right" });

  // Footer on every page.
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page);
    pdf.setDrawColor(...rule);
    pdf.line(M, H - 15, R, H - 15);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.2);
    pdf.setTextColor(...muted);
    pdf.text("This is a computer-generated invoice and does not require a physical signature.", M, H - 10.5);
    pdf.text("Whether tax is payable under reverse charge - No", M, H - 6.8);
    pdf.text(`Page ${page} of ${pages}`, R, H - 10.5, { align: "right" });
    pdf.text(`${company.brand}  ·  ${company.email}`, R, H - 6.8, { align: "right" });
  }

  const fileName = `Invoice-${invoiceNo}`.replace(/[^A-Za-z0-9._-]+/g, "-") + ".pdf";
  return { pdf, fileName, invoiceNo };
}
