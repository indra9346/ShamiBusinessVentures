// The Zoho numbers people use for an order (client, 17 Nov 2026): the sales order's own number (CLK-SO-1711260458) and
// its Books invoice number (CLKINV1711260376), shown in the portal's lists instead of Zoho's internal id. The website's
// order number stays as it is (it is the Reference# in Zoho). No app imports, so the tests load it directly.

export type ZohoNumbers = {
  /** The sales order's number in Zoho, "" until the server has read it (order_zoho_numbers). */
  salesOrder: string;
  /** The Books invoice number, "" when there is none (zoho_order_invoices). */
  invoice: string;
  /** zoho_order_invoices.status: sent, paid, partially_paid, overdue, void, deleted, awaiting_approval. */
  invoiceStatus: string;
};

const INVOICE_GONE: Record<string, string> = { void: "voided", deleted: "deleted" };

/** The parts to show, in order: "SO CLK-SO-…", "Invoice CLKINV…" (or "Invoice CLKINV… (voided)"). */
export function zohoNumberParts(numbers: ZohoNumbers | undefined | null): string[] {
  if (!numbers) return [];
  const parts: string[] = [];
  if (numbers.salesOrder.trim()) parts.push(`SO ${numbers.salesOrder.trim()}`);
  const invoice = numbers.invoice.trim();
  if (invoice) {
    const gone = INVOICE_GONE[numbers.invoiceStatus];
    parts.push(gone ? `Invoice ${invoice} (${gone})` : `Invoice ${invoice}`);
  }
  return parts;
}

const CLOSED_SO = ["void", "cancelled"];

/**
 * Closed in Zoho though open here (client, 19 Nov 2026: "this order is cancelled after raising an invoice and deleted
 * invoice in Zoho Books but it is showing green"): its sales order is void or cancelled in Zoho, or its invoice was voided
 * or deleted. A paid order is not closed here by itself (it needs a refund), so the list shows it red with this label.
 */
export function closedInZoho(order: { zohoSalesOrderId?: string | null; zohoOrderStatus?: string | null }, numbers: ZohoNumbers | undefined | null) {
  const so = Boolean(order.zohoSalesOrderId) && CLOSED_SO.includes((order.zohoOrderStatus ?? "").trim().toLowerCase());
  return so || Boolean(numbers && INVOICE_GONE[numbers.invoiceStatus]);
}
export function zohoClosedLabel(order: { zohoSalesOrderId?: string | null; zohoOrderStatus?: string | null }, numbers: ZohoNumbers | undefined | null) {
  const status = (order.zohoOrderStatus ?? "").trim().toLowerCase();
  if (order.zohoSalesOrderId && CLOSED_SO.includes(status)) return `${status === "cancelled" ? "Cancelled" : "Void"} in Zoho: refund or cancel`;
  return numbers && INVOICE_GONE[numbers.invoiceStatus] ? `Invoice ${INVOICE_GONE[numbers.invoiceStatus]} in Zoho` : "";
}

/** The numbers keyed by website order number, from the two tables' rows. */
export function zohoNumbersByOrder(
  salesOrders: { order_no: string; salesorder_number: string | null }[],
  invoices: { order_no: string; invoice_number: string | null; status: string | null }[],
): Map<string, ZohoNumbers> {
  const out = new Map<string, ZohoNumbers>();
  const at = (orderNo: string) => {
    const seen = out.get(orderNo) ?? { salesOrder: "", invoice: "", invoiceStatus: "" };
    out.set(orderNo, seen);
    return seen;
  };
  for (const row of salesOrders) if (row.order_no && row.salesorder_number) at(row.order_no).salesOrder = row.salesorder_number;
  for (const row of invoices) {
    if (!row.order_no || !row.invoice_number) continue;
    const seen = at(row.order_no);
    seen.invoice = row.invoice_number;
    seen.invoiceStatus = row.status ?? "";
  }
  return out;
}
