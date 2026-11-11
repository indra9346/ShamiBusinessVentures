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
export type InvoiceDelivery = { code: string | null; why: string; noteNo: string | null; releasedAt: string | null };

/** A delivery code: 22 characters of URL-safe base64, the same on every copy of the invoice. */
export const DELIVERY_CODE = /^[A-Za-z0-9_-]{22}$/;

/** invoice_delivery_code's answer, checked: anything that is not a well-formed code counts as no code. */
export function invoiceDelivery(data: unknown): InvoiceDelivery | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const code = text(row["code"]);
  return {
    code: code && DELIVERY_CODE.test(code) ? code : null,
    why: text(row["why"]) ?? "",
    noteNo: text(row["note_no"]),
    releasedAt: text(row["released_at"]),
  };
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
 * invoice asks the database as the signed-in account when it is built. `customerNumber` (Zoho's customer number, printed
 * under Bill to) likewise: left out = read when the invoice is built; null = none.
 */
export type InvoiceFacts = {
  zoho: ZohoInvoiceCopy | null; payments: InvoicePayment[]; paid: number | null; delivery?: InvoiceDelivery | null;
  customerNumber?: string | null | undefined;
};

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
