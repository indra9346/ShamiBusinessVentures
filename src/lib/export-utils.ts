import type { Order } from "./data";
import { toast } from "sonner";

export type CustomerInvoiceInfo = {
  gst?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
};

/**
 * Converts a numeric amount to Indian Rupee words (e.g. 2668 -> "Two Thousand Six Hundred Sixty-Eight Rupees Only")
 */
export function numberToIndianWords(amount: number): string {
  const absolute = Math.abs(amount);
  let num = Math.floor(absolute);
  let paise = Math.round((absolute - num) * 100);
  if (paise === 100) { num += 1; paise = 0; }

  const a = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function convertTwoDigits(n: number): string {
    if (n === 0) return "";
    if (n < 20) return a[n] + " ";
    return b[Math.floor(n / 10)] + (n % 10 !== 0 ? "-" + a[n % 10] : "") + " ";
  }

  function convertThreeDigits(n: number): string {
    let result = "";
    if (n >= 100) {
      result += a[Math.floor(n / 100)] + " Hundred ";
      n %= 100;
      if (n > 0) result += "and ";
    }
    result += convertTwoDigits(n);
    return result;
  }

  let crore = Math.floor(num / 10000000);
  let remainder = num % 10000000;
  let lakh = Math.floor(remainder / 100000);
  remainder %= 100000;
  let thousand = Math.floor(remainder / 1000);
  let hundred = remainder % 1000;

  let words = "";
  if (crore > 0) words += convertThreeDigits(crore) + "Crore ";
  if (lakh > 0) words += convertTwoDigits(lakh) + "Lakh ";
  if (thousand > 0) words += convertTwoDigits(thousand) + "Thousand ";
  if (hundred > 0) words += convertThreeDigits(hundred);

  const rupeesInWords = words.trim() || "Zero";
  const paiseInWords = paise ? ` and ${convertTwoDigits(paise).trim()} Paise` : "";
  return `${rupeesInWords} Rupees${paiseInWords} Only`.replace(/\s+/g, " ");
}

/**
 * Escapes values for standard CSV format (RFC 4180)
 */
function escapeCSV(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Downloads a structured CSV file with UTF-8 BOM so Microsoft Excel & Google Sheets render properly
 */
export function downloadCSV(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  try {
    const csvRows: string[] = [];
    csvRows.push(headers.map(escapeCSV).join(","));

    for (const row of rows) {
      csvRows.push(row.map(escapeCSV).join(","));
    }

    const csvContent = "\uFEFF" + csvRows.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast.success(`${link.download} downloaded successfully`);
  } catch (err) {
    console.error("Failed to export CSV:", err);
    toast.error("Failed to export CSV file");
  }
}

/** Downloads the Grain Bazar tax invoice PDF (customer copy unless stated). See src/lib/invoice.ts. */
export async function downloadInvoice(order: Order, _customerInfo?: CustomerInvoiceInfo, _invoicePrefix?: string, copy: "customer" | "office" = "customer"): Promise<void> {
  const toastId = toast.loading("Preparing your PDF invoice...");
  try {
    const { buildInvoicePdf } = await import("@/lib/invoice");
    const { pdf, fileName } = await buildInvoicePdf(order, { copy });
    pdf.save(fileName);
    toast.success(`PDF invoice for ${order.id} downloaded`, { id: toastId });
  } catch (error) {
    console.error("Failed to download invoice PDF:", error);
    toast.error("Failed to download invoice PDF", { id: toastId });
  }
}
