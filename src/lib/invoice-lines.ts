/*
 * The figures on a tax invoice: each line's taxable value and GST, the coupon's share of each line, which number the
 * invoice carries, and the payments list. No app imports, so the node tests can load it directly.
 */

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export type InvoiceLineInput = {
  product: { id: string; name?: string | undefined; sku?: string | undefined; price: number; gst?: number | undefined; hsn?: string | undefined; unit?: string | undefined; weight?: string | undefined };
  qty: number;
  unitPrice?: number | undefined;
  gstRate?: number | undefined;
  capacity?: string | undefined;
  vendor?: string | undefined;
  vendorId?: string | undefined;
  couponShare?: number | undefined;
};
export type InvoiceCatalogItem = { id: string; hsn?: string | undefined; unit?: string | undefined; weight?: string | undefined };
export type InvoiceLineOrder = { items: InvoiceLineInput[]; tax: number; pricesIncludeGst?: boolean | undefined; discount?: number | undefined };

export type Line = {
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
  couponShare: number;
};

/** Splits a coupon across the lines in proportion to each line's amount, largest line first. The pieces add up exactly. */
export function couponShares(grossByLine: number[], discount: number) {
  const order = grossByLine.map((gross, index) => ({ gross, index })).sort((a, b) => b.gross - a.gross || a.index - b.index);
  const shares = grossByLine.map(() => 0);
  let discountLeft = round2(discount);
  let goodsLeft = round2(grossByLine.reduce((sum, gross) => sum + gross, 0));
  for (const { gross, index } of order) {
    const share = goodsLeft > 0 ? Math.min(gross, round2((discountLeft * gross) / goodsLeft)) : 0;
    shares[index] = share;
    discountLeft = round2(discountLeft - share);
    goodsLeft = round2(goodsLeft - gross);
  }
  return shares;
}

/**
 * Per-line tax. An order whose prices include GST shows the GST inside what is left of each line after its coupon share.
 * Within a state, CGST and SGST are each rounded to the paisa, as Zoho Books does on the real invoice (₹130 at 5% is
 * 3.10 + 3.10 and 123.80 taxable). An older order's GST was added on top and is reconciled to the order's own GST total.
 */
export function invoiceLines(order: InvoiceLineOrder, catalog: InvoiceCatalogItem[], options: { intraState?: boolean } = {}): Line[] {
  const intraState = options.intraState !== false;
  const grossOf = (item: InvoiceLineInput) => round2((item.unitPrice ?? item.product.price) * item.qty);
  const stored = order.items.map((item) => Number(item.couponShare) || 0);
  const shares = order.pricesIncludeGst && Number(order.discount) > 0 && stored.every((share) => share === 0)
    ? couponShares(order.items.map(grossOf), Number(order.discount))
    : stored;
  const lines: Line[] = order.items.map((item, index) => {
    const product = catalog.find((candidate) => candidate.id === item.product.id) ?? item.product;
    const price = item.unitPrice ?? item.product.price;
    const gstRate = Number(item.gstRate ?? item.product.gst ?? 0);
    const gross = grossOf(item);
    const couponShare = order.pricesIncludeGst ? shares[index] ?? 0 : 0;
    const left = round2(gross - couponShare);
    let inside = 0;
    if (order.pricesIncludeGst && gstRate > 0) {
      inside = intraState
        ? round2(round2((left * (gstRate / 2)) / (100 + gstRate)) * 2)
        : round2((left * gstRate) / (100 + gstRate));
    }
    const taxable = order.pricesIncludeGst ? round2(left - inside) : gross;
    return {
      name: item.product.name || "Item",
      detail: [item.product.sku ? `SKU ${item.product.sku}` : "", item.capacity || product.weight ? `Pack ${item.capacity || product.weight}` : ""]
        .filter(Boolean).join("  ·  "),
      vendor: item.vendor ? `${item.vendor}${item.vendorId ? ` (${item.vendorId})` : ""}` : "",
      hsn: product.hsn || item.product.hsn || "",
      qty: item.qty,
      unit: product.unit || item.product.unit || "nos",
      rate: order.pricesIncludeGst ? round2(taxable / item.qty) : price,
      taxable,
      gstRate,
      tax: order.pricesIncludeGst ? inside : round2((taxable * gstRate) / 100),
      couponShare,
    };
  });
  if (!order.pricesIncludeGst) {
    const difference = round2(order.tax - lines.reduce((sum, line) => sum + line.tax, 0));
    if (lines.length && difference !== 0 && Math.abs(difference) <= 1) {
      const largest = lines.reduce((best, line) => (line.taxable > best.taxable ? line : best), lines[0]!);
      largest.tax = round2(largest.tax + difference);
    }
  }
  return lines;
}

export type ZohoInvoiceCopy = { invoice_number: string | null; status: string | null; invoice_date?: string | null };

/** The Zoho Books number this order's invoice carries, or null while Zoho has not issued a live one. */
export function issuedZohoNumber(row: ZohoInvoiceCopy | null | undefined): string | null {
  const number = (row?.invoice_number ?? "").trim();
  if (!number) return null;
  return ["none", "void", "deleted", "awaiting_approval"].includes((row?.status ?? "none").toLowerCase()) ? null : number;
}

export type InvoicePaymentRow = { amount: number; method: string | null; status: string | null; txn_ref: string | null; created_at: string };
export type InvoicePayment = { date: string; mode: string; reference: string; amount: number };
/**
 * The invoice's delivery QR as the database hands it out (invoice_delivery_code). `code` is null until the order is
 * paid, confirmed and invoiced; `why` then says which check is still open. `releasedAt` is when the delivery note was
 * released (automatically when the payment was confirmed, or by the godown in-charge's scan), null while it is not.
 */
/** One item handed over at the godown on the invoice's QR: who, when, where (owner, 11 Nov 2026). */
export type InvoiceHandover = { line: number; item: string; qty: number; at: string; by: string; role: string; phone: string; godown: string };
/** The order's godown, as the invoice prints it under the QR. */
export type InvoiceGodown = {
  name: string; address: string; city: string; state: string; pincode: string; phone: string; gstin: string;
  /**
   * The channel partner (owner, 11 Nov 2026: "and there is channel partner also"): on the invoice the order's own
   * partner, whose signature it carries; on the scan screen the partner running the godown today.
   */
  partnerName: string; partnerPhone: string;
};
/** `reopened`: hand-overs the office reopened (those items wait to be handed over again). */
export type InvoiceDelivery = {
  code: string | null; why: string; noteNo: string | null; releasedAt: string | null;
  handovers: InvoiceHandover[]; godown: InvoiceGodown | null; items: number; reopened: number;
};

/** A delivery code: 22 characters of URL-safe base64, the same on every copy of the invoice. */
export const DELIVERY_CODE = /^[A-Za-z0-9_-]{22}$/;

/** invoice_delivery_code's answer, checked: anything that is not a well-formed code counts as no code. */
export function invoiceDelivery(data: unknown): InvoiceDelivery | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const code = text(row["code"]);
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const handovers = (Array.isArray(row["handovers"]) ? row["handovers"] : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      line: Number(entry["line"]) || 0, item: str(entry["item"]), qty: Number(entry["qty"]) || 0, at: str(entry["at"]),
      by: str(entry["by"]), role: str(entry["role"]), phone: str(entry["phone"]), godown: str(entry["godown"]),
    }))
    .filter((entry) => entry.line > 0 && entry.at);
  return {
    code: code && DELIVERY_CODE.test(code) ? code : null,
    why: text(row["why"]) ?? "",
    noteNo: text(row["note_no"]),
    releasedAt: text(row["released_at"]),
    handovers,
    godown: godownDetails(row["godown"]),
    items: Number(row["items"]) || 0,
    reopened: Number(row["reopened"]) || 0,
  };
}

/** A godown's details as the database gives them (private.delivery_godown_details), checked; null without a name. */
export function godownDetails(value: unknown): InvoiceGodown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const godown = {
    name: str(r["name"]), address: str(r["address"]), city: str(r["city"]), state: str(r["state"]), pincode: str(r["pincode"]),
    phone: str(r["phone"]), gstin: str(r["gstin"]), partnerName: str(r["partner_name"]), partnerPhone: str(r["partner_phone"]),
  };
  return godown.name ? godown : null;
}

type Bi = { en: string; kn: string };
const ROLE: Record<string, Bi> = {
  admin: { en: "office", kn: "ಕಚೇರಿ" },
  incharge: { en: "godown in-charge", kn: "ಗೋದಾಮು ಉಸ್ತುವಾರಿ" },
  staff: { en: "godown staff", kn: "ಗೋದಾಮು ಸಿಬ್ಬಂದಿ" },
  partner: { en: "channel partner", kn: "ಚಾನೆಲ್ ಪಾಲುದಾರ" },
};

/** "11 Nov 2026, 08:20:15 PM IST": the exact time in India. */
export function handoverTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}:${part("second")} ${part("dayPeriod").toUpperCase()} IST`;
}

/**
 * Who handed over the goods, when and where, as the invoice prints it under the QR and the customer's order page shows
 * it: one sentence per person and moment, in English and Kannada. Before any hand-over, one line saying so
 * (`done` false: the invoice leaves it out, the order page shows it).
 */
export function handoverWords(
  delivery: (Pick<InvoiceDelivery, "handovers" | "items"> & { reopened?: number }) | null | undefined,
  orderStatus?: string,
): { done: boolean; all: boolean; lines: Bi[] } {
  const handovers = delivery?.handovers ?? [];
  if (!handovers.length) {
    // The office reopened the hand-over (the order stays Delivered): the items wait to be handed over again.
    if ((delivery?.reopened ?? 0) > 0) {
      return { done: false, all: false, lines: [{ en: "Reopened by the office; not handed over again yet.", kn: "ಕಚೇರಿ ಹಸ್ತಾಂತರವನ್ನು ಮರುತೆರೆದಿದೆ; ಇನ್ನೂ ಮತ್ತೆ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ." }] };
    }
    // An order the office marked Delivered by hand has no godown hand-over to name.
    return orderStatus === "Delivered"
      ? { done: true, all: true, lines: [{ en: "Marked delivered by the office; no godown hand-over was recorded.", kn: "ಕಚೇರಿಯಿಂದ ತಲುಪಿಸಲಾಗಿದೆ ಎಂದು ಗುರುತಿಸಲಾಗಿದೆ; ಗೋದಾಮಿನ ಹಸ್ತಾಂತರ ದಾಖಲಾಗಿಲ್ಲ." }] }
      : { done: false, all: false, lines: [{ en: "Not handed over yet.", kn: "ಇನ್ನೂ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ." }] };
  }
  // One sentence for the items one person handed over in one press.
  const groups: InvoiceHandover[][] = [];
  for (const entry of [...handovers].sort((a, b) => a.at.localeCompare(b.at) || a.line - b.line)) {
    const last = groups.at(-1)?.[0];
    if (last && last.by === entry.by && last.phone === entry.phone && last.godown === entry.godown && Math.abs(Date.parse(last.at) - Date.parse(entry.at)) < 60_000) groups.at(-1)!.push(entry);
    else groups.push([entry]);
  }
  const lines = groups.map((group) => {
    const first = group[0]!;
    const role = ROLE[first.role] ?? { en: first.role, kn: first.role };
    const items = group.map((entry) => `${entry.line}. ${entry.item}${entry.qty ? ` x${entry.qty}` : ""}`).join(", ");
    const who = [role.en, first.phone ? `mobile ${first.phone}` : ""].filter(Boolean).join(", ");
    const whoKn = [role.kn, first.phone ? `ಮೊಬೈಲ್ ${first.phone}` : ""].filter(Boolean).join(", ");
    const when = handoverTime(first.at);
    // An office hand-over has no godown of its own; then the sentence leaves the place out.
    return {
      en: `Handed over ${when} by ${first.by} (${who})${first.godown ? ` at ${first.godown}` : ""}: ${items}.`,
      kn: `${when} ರಂದು ${first.godown ? `${first.godown} ನಲ್ಲಿ ` : ""}${first.by} (${whoKn}) ಹಸ್ತಾಂತರಿಸಿದ್ದಾರೆ: ${items}.`,
    };
  });
  const all = delivery?.items ? new Set(handovers.map((entry) => entry.line)).size >= delivery.items : false;
  return { done: true, all, lines };
}

/**
 * "Grain Bazar Challakere Godown, Pavagada Road, Challakere, Karnataka 577522 · Phone 99… · GSTIN … · Channel partner
 * Vamshi (mobile 9…)": the godown that gives the goods, with its channel partner. `lang` "kn" gives the small labels
 * in Kannada for the order page (names and addresses are stored in English).
 */
export function godownLine(godown: InvoiceGodown | null | undefined, lang: "en" | "kn" = "en") {
  if (!godown) return "";
  const kn = lang === "kn";
  // The town, state and PIN only when the address does not already say them.
  const said = (part: string) => Boolean(part) && godown.address.toLowerCase().includes(part.toLowerCase());
  const place = [godown.address, said(godown.city) ? "" : godown.city, [said(godown.state) ? "" : godown.state, said(godown.pincode) ? "" : godown.pincode].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ");
  const mobile = godown.partnerPhone ? ` (${kn ? "ಮೊಬೈಲ್" : "mobile"} ${godown.partnerPhone})` : "";
  const partner = godown.partnerName ? `${kn ? "ಚಾನೆಲ್ ಪಾಲುದಾರ" : "Channel partner"} ${godown.partnerName}${mobile}` : "";
  return [[godown.name, place].filter(Boolean).join(", "), godown.phone ? `${kn ? "ಫೋನ್" : "Phone"} ${godown.phone}` : "", godown.gstin ? `GSTIN ${godown.gstin}` : "", partner]
    .filter(Boolean).join("  ·  ");
}

/** The code the invoice prints as its delivery QR: only on a tax invoice (Zoho's number) and only with a working code. */
export function invoiceQrCode(zohoNumber: string | null | undefined, delivery: InvoiceDelivery | null | undefined) {
  const code = delivery?.code ?? "";
  return zohoNumber && DELIVERY_CODE.test(code) ? code : null;
}

/**
 * The owner's "note under the QR" (11 Nov 2026), in both languages. The PDF's own fonts have no Kannada, so the browser
 * draws the Kannada line as a picture.
 */
export const DELIVERY_QR_NOTE = {
  en: "Show this at the godown. The godown in-charge scans it to release and hand over your goods, once per item.",
  kn: "ಇದನ್ನು ಗೋದಾಮಿನಲ್ಲಿ ತೋರಿಸಿ. ಗೋದಾಮಿನ ಉಸ್ತುವಾರಿ ಇದನ್ನು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ನಿಮ್ಮ ಸರಕನ್ನು ಬಿಡುಗಡೆ ಮಾಡಿ ಹಸ್ತಾಂತರಿಸುತ್ತಾರೆ, ಪ್ರತಿ ವಸ್ತುವನ್ನು ಒಮ್ಮೆ ಮಾತ್ರ.",
} as const;

/**
 * The latest facts when the invoice is pulled: Zoho's own invoice number and date, every payment with its mode and UTR,
 * and what is paid. `paid` null = not known (the order's own figure is used). `delivery` left out = not read yet: the
 * invoice asks the database as the signed-in account when it is built.
 */
export type InvoiceFacts = { zoho: ZohoInvoiceCopy | null; payments: InvoicePayment[]; paid: number | null; delivery?: InvoiceDelivery | null };

const IST_MS = 330 * 60_000;
const dayOf = (iso: string) => {
  const date = new Date(Date.parse(iso) + IST_MS);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
};

/** The money received, oldest first: each payment with its mode and UTR. Only money that counts is listed. */
export function invoicePayments(rows: InvoicePaymentRow[]): InvoicePayment[] {
  return rows.filter((row) => row.status === "Paid")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((row) => ({ date: dayOf(row.created_at), mode: row.method || "Payment", reference: (row.txn_ref ?? "").trim(), amount: Number(row.amount) || 0 }));
}

/** What the invoice says is paid and still due, from the freshest figures. */
export function invoiceBalance(total: number, paid: number) {
  const received = Math.max(0, Math.min(total, paid));
  return { paid: round2(received), balance: round2(total - received) };
}
