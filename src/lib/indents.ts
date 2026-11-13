import type { XlsxSheet } from "./xlsx.ts";

/*
 * Stock requirements (indents) from channel partners (owner, 12-13 Nov 2026). A godown's partner asks head office for
 * stock: products with a quantity in bags or units, a grade and remarks, plus a note. Head office moves each request
 * New -> Seen -> Arranged, or Cancelled. A request only asks: it never changes stock, orders or Zoho.
 * The database (20261113100000) checks the same limits as indentDraftProblem below.
 */

export type IndentStatus = "new" | "seen" | "arranged" | "cancelled";
export type IndentUnit = "bags" | "units";

export const INDENT_STATUSES: { value: IndentStatus; label: string; help: string }[] = [
  { value: "new", label: "New", help: "Sent; head office has not looked at it yet. You can still cancel it." },
  { value: "seen", label: "Seen", help: "Head office has seen it and is working on it." },
  { value: "arranged", label: "Arranged", help: "Head office has arranged the stock." },
  { value: "cancelled", label: "Cancelled", help: "Not going ahead." },
];

export const INDENT_UNITS: { value: IndentUnit; label: string }[] = [
  { value: "bags", label: "Bags" },
  { value: "units", label: "Units" },
];

export const MAX_INDENT_LINES = 30;

export type IndentLineDraft = { productId: string | null; productName: string; quantity: string; unit: IndentUnit; grade: string; remarks: string };
export type IndentLine = { lineNo: number; productId: string | null; productName: string; quantity: number; unit: IndentUnit; grade: string; remarks: string };
export type IndentEvent = { event: string; note: string; byName: string; byRole: string; at: string };
export type Indent = {
  id: string;
  indentNo: string;
  branchId: string;
  godown: string;
  partnerName: string;
  neededBy: string | null;
  notes: string;
  status: IndentStatus;
  statusNote: string;
  statusChangedAt: string | null;
  statusChangedByName: string;
  createdAt: string;
  lines: IndentLine[];
  events: IndentEvent[];
};

export const indentStatusLabel = (status: string) => INDENT_STATUSES.find((s) => s.value === status)?.label ?? status;

/** Open requests still need head office: New and Seen. */
export const isOpenIndent = (status: IndentStatus) => status === "new" || status === "seen";

/** The partner may cancel only while head office has not looked at it. */
export const partnerCanCancel = (status: IndentStatus) => status === "new";

export const emptyIndentLine = (): IndentLineDraft => ({ productId: null, productName: "", quantity: "", unit: "bags", grade: "", remarks: "" });

const isBlank = (line: IndentLineDraft) => !line.productName.trim() && !line.quantity.trim() && !line.grade.trim() && !line.remarks.trim();

/** Lines the partner left completely empty are dropped, not refused. */
export function filledIndentLines(lines: IndentLineDraft[]) {
  return lines.filter((line) => !isBlank(line));
}

export function indentLineProblem(line: IndentLineDraft, index: number): string | null {
  const at = `Line ${index + 1}`;
  if (!line.productName.trim()) return `${at}: choose or type the product`;
  if (line.productName.trim().length > 120) return `${at}: the product name is too long`;
  const text = line.quantity.trim();
  if (!text) return `${at}: enter the quantity`;
  const quantity = Number(text);
  if (!Number.isFinite(quantity)) return `${at}: enter the quantity as a number`;
  if (quantity <= 0) return `${at}: the quantity must be more than 0`;
  if (quantity > 100000) return `${at}: the quantity is too large`;
  if (line.unit !== "bags" && line.unit !== "units") return `${at}: choose bags or units`;
  if (line.grade.trim().length > 60) return `${at}: the grade is too long`;
  if (line.remarks.trim().length > 300) return `${at}: keep the remarks under 300 characters`;
  return null;
}

/** Why the request cannot be sent yet, or null. `today` is the date in India (YYYY-MM-DD). */
export function indentDraftProblem(lines: IndentLineDraft[], notes: string, neededBy: string, today: string): string | null {
  const filled = filledIndentLines(lines);
  if (filled.length === 0) return "Add at least one product";
  if (filled.length > MAX_INDENT_LINES) return `At most ${MAX_INDENT_LINES} products in one requirement`;
  for (const [index, line] of filled.entries()) {
    const problem = indentLineProblem(line, index);
    if (problem) return problem;
  }
  if (notes.trim().length > 1000) return "Keep the notes under 1,000 characters";
  if (neededBy) {
    const limit = addDays(today, 366);
    if (neededBy < today || neededBy > limit) return 'Choose a "needed by" date from today to a year from now';
  }
  return null;
}

/** What the database function receives. */
export function indentLinesPayload(lines: IndentLineDraft[]) {
  return filledIndentLines(lines).map((line) => ({
    product_id: line.productId,
    product_name: line.productName.trim(),
    quantity: Math.round(Number(line.quantity) * 100) / 100,
    unit: line.unit,
    grade: line.grade.trim(),
    remarks: line.remarks.trim(),
  }));
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const numberText = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, ""));

/** "40 bags", "1 bag", "12.5 units". */
export function indentQuantityText(quantity: number, unit: IndentUnit) {
  const one = quantity === 1;
  return `${numberText(quantity)} ${unit === "bags" ? (one ? "bag" : "bags") : one ? "unit" : "units"}`;
}

export type IndentFilter = { status: "all" | "open" | IndentStatus; branchId: string; search: string };

export function filterIndents(indents: Indent[], filter: IndentFilter) {
  const words = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return indents.filter((indent) => {
    if (filter.status === "open" && !isOpenIndent(indent.status)) return false;
    if (filter.status !== "all" && filter.status !== "open" && indent.status !== filter.status) return false;
    if (filter.branchId !== "all" && indent.branchId !== filter.branchId) return false;
    if (!words.length) return true;
    const text = [indent.indentNo, indent.godown, indent.partnerName, indent.notes, indent.statusNote,
      ...indent.lines.flatMap((line) => [line.productName, line.grade, line.remarks])].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function indentCounts(indents: Indent[]) {
  const counts: Record<IndentStatus, number> = { new: 0, seen: 0, arranged: 0, cancelled: 0 };
  for (const indent of indents) counts[indent.status] += 1;
  return counts;
}

const istDateTime = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });

/**
 * The Excel workbook: every line of every request shown (one row each), and, for requests still open (New or Seen),
 * the total asked for per godown and product.
 */
export function indentWorkbook(indents: Indent[]): XlsxSheet[] {
  const header = ["Request no.", "Raised (IST)", "Godown", "Channel partner", "Status", "Needed by", "Line", "Product", "Quantity", "Unit", "Grade", "Remarks", "Notes", "Head office note", "Last change by", "Last change (IST)"];
  const rows: (string | number)[][] = [header];
  for (const indent of indents) {
    for (const line of indent.lines) {
      rows.push([
        indent.indentNo, istDateTime(indent.createdAt), indent.godown, indent.partnerName, indentStatusLabel(indent.status),
        indent.neededBy ? longDate(indent.neededBy) : "", line.lineNo, line.productName, line.quantity, line.unit === "bags" ? "Bags" : "Units",
        line.grade, line.remarks, indent.notes, indent.statusNote, indent.statusChangedByName, indent.statusChangedAt ? istDateTime(indent.statusChangedAt) : "",
      ]);
    }
  }
  const totals = new Map<string, { godown: string; product: string; unit: IndentUnit; quantity: number; requests: Set<string> }>();
  for (const indent of indents) {
    if (!isOpenIndent(indent.status)) continue;
    for (const line of indent.lines) {
      const key = `${indent.godown}\u0000${line.productName.trim().toLowerCase()}\u0000${line.unit}`;
      const entry = totals.get(key) ?? { godown: indent.godown, product: line.productName.trim(), unit: line.unit, quantity: 0, requests: new Set<string>() };
      entry.quantity = Math.round((entry.quantity + line.quantity) * 100) / 100;
      entry.requests.add(indent.indentNo);
      totals.set(key, entry);
    }
  }
  const openRows: (string | number)[][] = [["Godown", "Product", "Quantity still to arrange", "Unit", "Requests"]];
  for (const entry of [...totals.values()].sort((a, b) => a.godown.localeCompare(b.godown) || a.product.localeCompare(b.product))) {
    openRows.push([entry.godown, entry.product, entry.quantity, entry.unit === "bags" ? "Bags" : "Units", [...entry.requests].join(", ")]);
  }
  return [
    { name: "Requests", rows, boldRows: [0], widths: [20, 20, 22, 20, 11, 13, 6, 30, 10, 8, 16, 30, 30, 30, 18, 20] },
    { name: "Still to arrange", rows: openRows, boldRows: [0], widths: [22, 30, 14, 8, 40] },
  ];
}
