import type { XlsxCell, XlsxSheet } from "@/lib/xlsx";

/*
 * Admin > Customers > a customer > Information requests: turns what admin_export_customer_data
 * returns into a workbook the admin can read and send on. One sheet per kind of record, and a
 * sheet is kept even when it is empty, so the file shows that the kind of record was checked.
 */

export type CustomerDataRow = Record<string, unknown>;

export type CustomerDataFile = {
  customer_id: string;
  generated_at: string;
  generated_by: string;
  label: string;
  account: CustomerDataRow | null;
  profile: CustomerDataRow | null;
  zoho_contacts: CustomerDataRow[];
} & Record<string, unknown>;

/** Every kind of record in the file, in the order the sheets appear. */
export const CUSTOMER_DATA_SECTIONS = [
  { key: "profile", title: "Profile" },
  { key: "account", title: "Login" },
  { key: "sign_in_methods", title: "Sign-in methods" },
  { key: "roles", title: "Account type" },
  { key: "addresses", title: "Saved addresses" },
  { key: "settings", title: "Preferences" },
  { key: "orders", title: "Orders" },
  { key: "order_items", title: "Order items" },
  { key: "order_tracking", title: "Order tracking" },
  { key: "delivery_notes", title: "Delivery notes" },
  { key: "invoices", title: "Invoices" },
  { key: "zoho_invoices", title: "Zoho invoices" },
  { key: "payments", title: "Payments" },
  { key: "payment_references", title: "Payment references" },
  { key: "bank_receipts", title: "Bank receipts" },
  { key: "reviews", title: "Reviews" },
  { key: "returns", title: "Returns" },
  { key: "enquiries", title: "Enquiries" },
  { key: "notifications", title: "Notifications" },
  { key: "policy_acceptance", title: "Terms accepted" },
  { key: "admin_notes", title: "Admin notes" },
  { key: "seller_applications", title: "Seller applications" },
  { key: "seller_documents", title: "Seller documents" },
  { key: "zoho_contacts", title: "Zoho contact" },
  { key: "zoho_sales_orders", title: "Zoho sales orders" },
] as const;

/** Row ids that mean nothing outside the database; the order number says which order. */
const HIDDEN_COLUMNS = new Set(["id", "order_id", "order_item_id", "customer_id", "subject_id"]);

const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const label = (key: string) =>
  key.split(/[._]/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function customerDataCell(value: unknown): XlsxCell {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    if (!TIMESTAMP.test(value)) return value;
    const when = new Date(value);
    return Number.isNaN(when.getTime()) ? value : `${IST.format(when)} IST`;
  }
  if (Array.isArray(value) && value.every((item) => !isPlainObject(item) && !Array.isArray(item))) return value.join(", ");
  return JSON.stringify(value);
}

/** One level of an address or similar becomes its own columns: "shipping_address.line". */
export function flattenCustomerRow(row: CustomerDataRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (HIDDEN_COLUMNS.has(key)) continue;
    if (isPlainObject(value)) for (const [inner, innerValue] of Object.entries(value)) out[`${key}.${inner}`] = innerValue;
    else out[key] = value;
  }
  return out;
}

const NOTHING_HELD = "Nothing held";
/** The database returns columns in its own order; these come first, as a person reads them. */
const LEADING_COLUMNS = ["order_no", "salesorder_number", "invoice_no", "invoice_number", "title", "label", "name", "line", "landmark", "city", "state", "pin", "phone", "email"];
const leadingFirst = (columns: string[]) => [
  ...LEADING_COLUMNS.filter((column) => columns.includes(column)),
  ...columns.filter((column) => !LEADING_COLUMNS.includes(column)),
];
const widthOf = (rows: XlsxCell[][], column: number) =>
  Math.min(60, Math.max(10, ...rows.map((row) => String(row[column] ?? "").length + 2)));

function tableSheet(name: string, records: CustomerDataRow[]): XlsxSheet {
  if (!records.length) return { name, rows: [[NOTHING_HELD]], widths: [24] };
  const flat = records.map(flattenCustomerRow);
  const columns = leadingFirst([...new Set(flat.flatMap((row) => Object.keys(row)))]);
  const rows: XlsxCell[][] = [columns.map(label), ...flat.map((row) => columns.map((column) => customerDataCell(row[column])))];
  return { name, rows, boldRows: [0], widths: columns.map((_, index) => widthOf(rows, index)) };
}

function recordSheet(name: string, record: CustomerDataRow | null): XlsxSheet {
  if (!record) return { name, rows: [[NOTHING_HELD]], widths: [24] };
  const flat = flattenCustomerRow(record);
  const rows: XlsxCell[][] = [["Detail", "Value"], ...Object.entries(flat).map(([key, value]): XlsxCell[] => [label(key), customerDataCell(value)])];
  return { name, rows, boldRows: [0], widths: [widthOf(rows, 0), widthOf(rows, 1)] };
}

const recordsOf = (file: CustomerDataFile, key: string): CustomerDataRow[] => {
  const value = file[key];
  return Array.isArray(value) ? (value as CustomerDataRow[]) : [];
};

const countOf = (file: CustomerDataFile, key: string) => {
  const value = file[key];
  if (Array.isArray(value)) return value.length;
  return value ? 1 : 0;
};

export function customerDataSheets(file: CustomerDataFile): XlsxSheet[] {
  const zohoContacts = (file.zoho_contacts ?? []).map((row) => row["zoho_contact_id"]).filter(Boolean).join(", ");
  const about: XlsxCell[][] = [
    ["Information we hold on this customer"],
    [],
    ["Customer", file.label],
    ["Customer ID", file.customer_id],
    ["Downloaded", customerDataCell(file.generated_at)],
    ["Downloaded by", file.generated_by],
    [],
    ["What this file holds", "Records"],
    ...CUSTOMER_DATA_SECTIONS.map(({ key, title }): XlsxCell[] => [title, countOf(file, key)]),
    [],
    ["What this file does not hold"],
    [`Zoho keeps its own copy of the contact, sales orders and invoices${zohoContacts ? ` (Zoho contact ${zohoContacts})` : ""}. Look in Zoho for those.`],
    ["Database backups, and emails or text messages already sent."],
    ["Files uploaded as seller documents: the sheet lists them, and the files open from the seller's page."],
    ["The store's own bank messages: the bank receipts sheet shows only the amount, reference and payer."],
    [],
    ["Before sending this file to the customer"],
    ["Read the Admin notes sheet: those notes were written by the admin team."],
    ["An enquiry is matched on email or phone, so check any enquiry matched by phone is really theirs."],
  ];
  const boldRows = [0, 7, 9 + CUSTOMER_DATA_SECTIONS.length, 15 + CUSTOMER_DATA_SECTIONS.length];
  return [
    { name: "Read me", rows: about, boldRows, widths: [30, 44] },
    ...CUSTOMER_DATA_SECTIONS.map(({ key, title }) =>
      key === "profile" || key === "account"
        ? recordSheet(title, (file[key] as CustomerDataRow | null) ?? null)
        : tableSheet(title, recordsOf(file, key))),
  ];
}

/** No name or phone in the file name: it sits in the admin's downloads folder and in emails. */
export function customerDataFileName(file: Pick<CustomerDataFile, "customer_id" | "generated_at">) {
  return `Customer_data_${file.customer_id.slice(0, 8)}_${file.generated_at.slice(0, 10)}.xlsx`;
}

/** What the admin types to confirm. The database checks the same word. */
export const CUSTOMER_DELETE_WORD = "DELETE";

export type DeletionBlocker = { code: string; orders: string[] };
export type DeletionPlan = {
  removed: Record<string, number>;
  kept: Record<string, number>;
  kept_orders: string[];
  cleared_orders: string[];
  zoho_contacts: string[];
};
export type DeletionPreview = { blockers: DeletionBlocker[]; plan: DeletionPlan };

const BLOCKER_TEXT: Record<string, string> = {
  other_login: "This person also has a seller, partner, staff or admin login. Those have their own records, so they cannot be deleted from here.",
  open_order: "These orders are still open. Finish or cancel them first.",
  unpaid_delivery: "These orders were delivered but are not fully paid. Record the payment first.",
  money_not_refunded: "These orders were cancelled with money not refunded. Refund it first.",
  open_return: "These orders have a return or refund still open. Close it first.",
  unconfirmed_payment: "These orders have a payment reference waiting. Confirm or reject it first.",
  waiting_for_zoho: "These orders are still going to Zoho or need a review in Zoho Sync. Clear that first.",
  not_in_zoho: "These delivered orders have not reached Zoho yet. Send them first, so the sales records are complete.",
};
export const deletionBlockerText = (code: string) => BLOCKER_TEXT[code] ?? "This customer cannot be deleted yet.";

const REMOVED_LABELS: [string, string][] = [
  ["addresses", "Saved addresses and map positions"],
  ["preferences", "Preferences"],
  ["reviews", "Reviews"],
  ["enquiries", "Enquiries"],
  ["notifications", "Messages sent to them"],
  ["admin_notes", "Admin notes about them"],
  ["seller_applications", "Seller applications"],
  ["seller_documents", "Uploaded seller documents"],
  ["orders_cleared", "Unpaid orders: name, phone, GSTIN and address cleared"],
];
const KEPT_LABELS: [string, string][] = [
  ["orders", "Paid or delivered orders, with name, address and GSTIN"],
  ["invoices", "Invoices"],
  ["payments", "Payments"],
  ["payment_references", "Payment references (UTR)"],
  ["returns", "Returns"],
  ["partner_commissions", "Partner commissions"],
  ["delivery_notes", "Delivery notes, exactly as printed, with phone"],
];
/** The confirmation lists only what this customer actually has. */
const countedLines = (labels: [string, string][], counts: Record<string, number>) =>
  labels.filter(([key]) => (counts[key] ?? 0) > 0).map(([key, text]) => ({ text, count: counts[key]! }));
export const removedLines = (plan: DeletionPlan) => countedLines(REMOVED_LABELS, plan.removed);
export const keptLines = (plan: DeletionPlan) => countedLines(KEPT_LABELS, plan.kept);
