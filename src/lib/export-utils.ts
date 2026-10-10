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

async function loadInvoiceLogo(): Promise<string | null> {
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

const invoiceMoney = (value: number) => `Rs. ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Downloads a branded A4 PDF invoice with a Grain Bazar watermark. */
export async function downloadInvoice(order: Order, customerInfo?: CustomerInvoiceInfo, invoicePrefix = "INV-"): Promise<void> {
  const toastId = toast.loading("Preparing your PDF invoice...");
  try {
    const { GState, jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 16;
    const right = pageWidth - margin;
    const usableWidth = pageWidth - margin * 2;
    const safePrefix = invoicePrefix.slice(0, 40).replace(/[^A-Za-z0-9._/-]/g, "");
    const invoiceNumber = `${safePrefix}${order.id.replace(/[^0-9]/g, "") || order.id}`;
    const parsedDate = new Date(order.createdAt || order.date);
    const dateLabel = Number.isNaN(parsedDate.getTime())
      ? order.date
      : parsedDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const logo = await loadInvoiceLogo();
    const navy: [number, number, number] = [12, 35, 65];
    const gold: [number, number, number] = [194, 145, 45];
    const ink: [number, number, number] = [34, 48, 66];
    const muted: [number, number, number] = [103, 119, 139];
    const line: [number, number, number] = [222, 229, 236];
    let page = 1;

    const watermark = () => {
      if (!logo) return;
      try {
        pdf.setGState(new GState({ opacity: 0.07 }));
        pdf.addImage(logo, "PNG", (pageWidth - 78) / 2, (pageHeight - 78) / 2, 78, 78);
      } catch (error) {
        console.warn("Could not add invoice watermark", error);
      } finally {
        pdf.setGState(new GState({ opacity: 1 }));
      }
    };

    const footer = () => {
      pdf.setDrawColor(...line);
      pdf.line(margin, pageHeight - 15, right, pageHeight - 15);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(...muted);
      pdf.text("Grain Bazar  |  A computer-generated invoice", margin, pageHeight - 9);
      pdf.text(`Page ${page}`, right, pageHeight - 9, { align: "right" });
    };

    const startPage = (continued: boolean) => {
      if (page > 1) pdf.addPage();
      watermark();
      pdf.setFillColor(...navy);
      pdf.rect(0, 0, pageWidth, 48, "F");
      if (logo) pdf.addImage(logo, "PNG", margin, 10, 25, 25);
      pdf.setTextColor(255, 255, 255);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(18);
      pdf.text("GRAIN BAZAR", margin + (logo ? 31 : 0), 20);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.text("Shami Business Ventures", margin + (logo ? 31 : 0), 27);
      pdf.setFont("helvetica", "bold");
      pdf.text(continued ? "INVOICE - CONTINUED" : "INVOICE", right, 18, { align: "right" });
      pdf.setFont("helvetica", "normal");
      pdf.text(`Invoice  ${invoiceNumber}`, right, 26, { align: "right" });
      pdf.text(`Date  ${dateLabel}`, right, 33, { align: "right" });
      if (continued) {
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(11);
        pdf.setTextColor(...ink);
        pdf.text("Order items (continued)", margin, 61);
      }
      return continued ? 71 : 61;
    };

    let y = startPage(false);
    const customerName = customerInfo?.name || order.customer || "Customer";
    const customerAddress = customerInfo?.address || order.address;
    const drawInfoCard = (x: number, title: string, rows: string[], width: number) => {
      pdf.setFillColor(248, 250, 252);
      pdf.roundedRect(x, y, width, 34, 2, 2, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8);
      pdf.setTextColor(...muted);
      pdf.text(title.toUpperCase(), x + 4, y + 7);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(...ink);
      pdf.text(rows.filter(Boolean).slice(0, 3), x + 4, y + 14, { maxWidth: width - 8, lineHeightFactor: 1.35 });
    };
    const cardGap = 5;
    const cardWidth = (usableWidth - cardGap) / 2;
    drawInfoCard(margin, "Billed by", ["Shami Business Ventures", "Grain Bazar", "India"], cardWidth);
    drawInfoCard(margin + cardWidth + cardGap, "Bill to", [customerName, customerInfo?.gst || order.gstin || "", customerAddress || order.email || order.phone], cardWidth);
    y += 42;

    pdf.setFillColor(255, 250, 239);
    pdf.roundedRect(margin, y, usableWidth, 16, 2, 2, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...muted);
    pdf.text("ORDER", margin + 4, y + 6);
    pdf.text("PAYMENT", margin + 62, y + 6);
    pdf.text("FULFILMENT", margin + 112, y + 6);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(...ink);
    pdf.text(order.id, margin + 4, y + 12);
    pdf.text(order.payment || "Pending", margin + 62, y + 12);
    pdf.text(order.status || "Placed", margin + 112, y + 12);
    y += 25;

    const columns = { number: margin + 2, item: margin + 12, sku: margin + 94, qty: margin + 130, price: right - 32, total: right - 2 };
    const drawTableHeader = () => {
      pdf.setFillColor(...navy);
      pdf.roundedRect(margin, y, usableWidth, 10, 1.5, 1.5, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7.5);
      pdf.setTextColor(255, 255, 255);
      pdf.text("#", columns.number, y + 6.5);
      pdf.text("ITEM DESCRIPTION", columns.item, y + 6.5);
      pdf.text("SKU", columns.sku, y + 6.5);
      pdf.text("QTY", columns.qty, y + 6.5, { align: "right" });
      pdf.text("UNIT PRICE", columns.price, y + 6.5, { align: "right" });
      pdf.text("AMOUNT", columns.total, y + 6.5, { align: "right" });
      y += 10;
    };
    drawTableHeader();

    order.items.forEach((item, index) => {
      const description = pdf.splitTextToSize(item.product.name || "Item", 79) as string[];
      const sku = pdf.splitTextToSize(item.product.sku || "—", 31) as string[];
      const rowHeight = Math.max(12, Math.max(description.length, sku.length) * 4.2 + 5);
      if (y + rowHeight > pageHeight - 34) {
        footer();
        page += 1;
        y = startPage(true);
        drawTableHeader();
      }
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      pdf.setTextColor(...muted);
      pdf.text(String(index + 1), columns.number, y + 7);
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(...ink);
      pdf.text(description, columns.item, y + 5, { lineHeightFactor: 1.2 });
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.5);
      pdf.setTextColor(...muted);
      pdf.text(sku, columns.sku, y + 5, { lineHeightFactor: 1.2 });
      pdf.setFontSize(8.5);
      pdf.setTextColor(...ink);
      pdf.text(String(item.qty), columns.qty, y + 7, { align: "right" });
      const unitPrice = item.unitPrice ?? item.product.price;
      pdf.text(invoiceMoney(unitPrice), columns.price, y + 7, { align: "right" });
      pdf.setFont("helvetica", "bold");
      pdf.text(invoiceMoney(unitPrice * item.qty), columns.total, y + 7, { align: "right" });
      y += rowHeight;
      pdf.setDrawColor(...line);
      pdf.line(margin, y, right, y);
    });

    if (y + 67 > pageHeight - 25) {
      footer();
      page += 1;
      y = startPage(true);
    }
    y += 7;
    const summaryWidth = 82;
    const summaryX = right - summaryWidth;
    const summaryRows: [string, number][] = [
      ["Subtotal", order.subtotal],
      ["Discount", -Math.abs(order.discount)],
      ["Tax", order.tax],
      ["Shipping", order.shipping],
    ];
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    summaryRows.forEach(([label, value]) => {
      pdf.setTextColor(...muted);
      pdf.text(label, summaryX, y);
      pdf.setTextColor(...ink);
      pdf.text(invoiceMoney(value), right, y, { align: "right" });
      y += 6;
    });
    pdf.setDrawColor(...gold);
    pdf.setLineWidth(0.6);
    pdf.line(summaryX, y - 2, right, y - 2);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    pdf.setTextColor(...navy);
    pdf.text("TOTAL DUE", summaryX, y + 4);
    pdf.text(invoiceMoney(order.amount), right, y + 4, { align: "right" });
    y += 15;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);
    pdf.setTextColor(...muted);
    pdf.text(`Amount in words: ${numberToIndianWords(order.amount)}`, margin, y, { maxWidth: usableWidth });
    y += 9;
    if (order.txn || order.utr) {
      pdf.setFont("helvetica", "bold");
      pdf.setTextColor(...ink);
      pdf.text("Payment reference:", margin, y);
      pdf.setFont("helvetica", "normal");
      pdf.text(order.utr || order.txn, margin + 31, y, { maxWidth: usableWidth - 31 });
      y += 8;
    }
    pdf.setDrawColor(...line);
    pdf.line(margin, y, right, y);
    y += 6;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...navy);
    pdf.text("Thank you for your business.", margin, y);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(...muted);
    pdf.text("Please contact Grain Bazar support if you have questions about this order.", margin, y + 5, { maxWidth: usableWidth });
    footer();

    const safeInvoiceName = `Invoice-${invoiceNumber}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    pdf.save(`${safeInvoiceName}.pdf`);
    toast.success(`PDF invoice for ${order.id} downloaded`, { id: toastId });
  } catch (error) {
    console.error("Failed to download invoice PDF:", error);
    toast.error("Failed to download invoice PDF", { id: toastId });
  }
}
