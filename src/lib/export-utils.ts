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
  const num = Math.round(Math.abs(amount));
  if (num === 0) return "Zero Rupees Only";

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

  return (words.trim() + " Rupees Only").replace(/\s+/g, " ");
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

/**
 * Generates an official, print-ready, government GST Tax Invoice HTML document
 */
export function generateInvoiceHTML(order: Order, customerInfo?: CustomerInvoiceInfo, invoicePrefix = "INV-"): string {
  const safePrefix = invoicePrefix.slice(0, 40).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const invoiceNumber = `${safePrefix}${order.id.replace(/[^0-9]/g, "") || order.id}`;
  const cgst = Math.round((order.tax / 2) * 100) / 100;
  const sgst = Math.round((order.tax / 2) * 100) / 100;
  const words = numberToIndianWords(order.amount);

  // Guess HSN based on product category
  const getHSN = (category: string) => {
    switch (category?.toLowerCase()) {
      case "sugar":
        return "1701";
      case "rice":
        return "1006";
      case "oil":
        return "1512";
      case "pulses":
        return "0713";
      case "flours":
        return "1101";
      case "spices":
        return "0910";
      default:
        return "1001";
    }
  };

  const itemRows = order.items
    .map((it, idx) => {
      const lineTotal = it.product.price * it.qty;
      const gstRate = it.product.gst;
      const taxable = Math.round(lineTotal * 100) / 100;
      const taxAmt = Math.round(taxable * gstRate) / 100;
      const cgstAmt = Math.round((taxAmt / 2) * 100) / 100;
      const sgstAmt = Math.round((taxAmt / 2) * 100) / 100;

      return `
        <tr>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${idx + 1}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0;">
            <strong style="color: #0b2341; display: block;">${it.product.name}</strong>
            <span style="font-size: 11px; color: #64748b;">SKU: ${it.product.sku} | Vendor: ${it.vendor}</span>
          </td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: center; font-family: monospace;">${getHSN(it.product.category)}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: center;">${it.qty} (${it.product.weight || "1 unit"})</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">₹${it.product.price.toLocaleString("en-IN")}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">₹${taxable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">
            ${(gstRate / 2).toFixed(1)}%<br><span style="font-size: 11px; color: #64748b;">₹${cgstAmt.toFixed(2)}</span>
          </td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">
            ${(gstRate / 2).toFixed(1)}%<br><span style="font-size: 11px; color: #64748b;">₹${sgstAmt.toFixed(2)}</span>
          </td>
          <td style="padding: 10px 8px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 600; color: #0b2341;">₹${lineTotal.toLocaleString("en-IN")}</td>
        </tr>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tax Invoice - ${invoiceNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      background: #f8fafc;
      padding: 24px;
      font-size: 13px;
      line-height: 1.5;
    }
    .invoice-card {
      max-width: 900px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 36px 40px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #0b2341;
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 800;
      color: #0b2341;
      letter-spacing: -0.5px;
    }
    .brand-subtitle {
      font-size: 12px;
      color: #c99a2e;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 2px;
    }
    .badge-invoice {
      display: inline-block;
      background: #0b2341;
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    .info-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 16px;
    }
    .info-box h3 {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    th {
      background: #0b2341;
      color: #ffffff;
      padding: 10px 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      text-align: left;
    }
    .summary-section {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 24px;
      margin-bottom: 28px;
    }
    .totals-table td {
      padding: 6px 10px;
    }
    .totals-table tr.grand-total {
      background: #0b2341;
      color: #ffffff;
      font-size: 15px;
      font-weight: 700;
    }
    .totals-table tr.grand-total td {
      padding: 10px 12px;
    }
    .footer-note {
      border-top: 1px dashed #cbd5e1;
      padding-top: 16px;
      font-size: 11px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .actions-bar {
      max-width: 900px;
      margin: 0 auto 16px auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .btn-print {
      background: #0b2341;
      color: #ffffff;
      border: none;
      padding: 10px 18px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-print:hover { background: #16365c; }
    @media print {
      body { background: #ffffff; padding: 0; font-size: 12px; }
      .invoice-card { border: none; box-shadow: none; padding: 0; max-width: 100%; }
      .actions-bar { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="actions-bar">
    <div style="font-size: 14px; font-weight: 600; color: #0b2341;">
      GST Tax Invoice Preview
    </div>
    <button class="btn-print" onclick="window.print()">
      🖨️ Print / Save as PDF
    </button>
  </div>

  <div class="invoice-card">
    <div class="header-bar">
      <div>
        <div class="brand-title">SHAMI BUSINESS VENTURES</div>
        <div class="brand-subtitle">Wholesale Grains, Pulses & Staples Marketplace</div>
        <div style="margin-top: 8px; color: #475569; font-size: 12px;">
          APMC Yard, Commercial Complex, Sector 4<br>
          Yeshwanthpur, Bengaluru, Karnataka - 560022<br>
          <strong>GSTIN:</strong> 29AAACB2026D1Z5 | <strong>PAN:</strong> AAACB2026D<br>
          <strong>State:</strong> Karnataka (Code 29) | <strong>Email:</strong> billing@shamibusiness.com
        </div>
      </div>
      <div style="text-align: right;">
        <span class="badge-invoice">Tax Invoice</span>
        <div style="margin-top: 10px; font-size: 13px;">
          <div><strong>Invoice No:</strong> <span style="color: #0b2341; font-weight: 700;">${invoiceNumber}</span></div>
          <div><strong>Invoice Date:</strong> ${order.date}</div>
          <div><strong>Order Ref:</strong> ${order.id}</div>
          <div><strong>Place of Supply:</strong> ${order.state || "Karnataka"} (Code 29)</div>
          <div><strong>Original for Recipient</strong></div>
        </div>
      </div>
    </div>

    <div class="details-grid">
      <div class="info-box">
        <h3>Billed & Shipped To</h3>
        <strong style="color: #0b2341; font-size: 14px;">${order.customer}</strong>
        <div style="color: #475569; margin-top: 4px;">
          ${order.address}<br>
          ${order.city}, ${order.state} - ${order.pin}<br>
          <strong>Phone:</strong> ${order.phone}<br>
          <strong>Email:</strong> ${order.email}<br>
          <strong>Customer GSTIN:</strong> ${order.gstin || customerInfo?.gst || "URP (Unregistered Person)"}
        </div>
      </div>

      <div class="info-box">
        <h3>Payment & Dispatch Details</h3>
        <table style="width: 100%; margin: 0; font-size: 12px;">
          <tr>
            <td style="color: #64748b; padding: 3px 0;">Payment Method:</td>
            <td style="font-weight: 600; text-align: right;">${order.method}</td>
          </tr>
          <tr>
            <td style="color: #64748b; padding: 3px 0;">Payment Status:</td>
            <td style="font-weight: 600; text-align: right; color: ${order.payment === "Paid" ? "#16a34a" : "#ca8a04"};">${order.payment.toUpperCase()}</td>
          </tr>
          <tr>
            <td style="color: #64748b; padding: 3px 0;">Transaction ID:</td>
            <td style="font-family: monospace; font-size: 11px; text-align: right;">${order.txn}</td>
          </tr>
          <tr>
            <td style="color: #64748b; padding: 3px 0;">Delivery Mode:</td>
            <td style="font-weight: 600; text-align: right;">${order.delivery || "Standard B2B Freight"}</td>
          </tr>
          <tr>
            <td style="color: #64748b; padding: 3px 0;">Order Status:</td>
            <td style="font-weight: 600; text-align: right;">${order.status}</td>
          </tr>
        </table>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="text-align: center; width: 36px;">#</th>
          <th>Description of Goods</th>
          <th style="text-align: center; width: 70px;">HSN</th>
          <th style="text-align: center; width: 90px;">Qty</th>
          <th style="text-align: right; width: 90px;">Rate</th>
          <th style="text-align: right; width: 100px;">Taxable (₹)</th>
          <th style="text-align: right; width: 85px;">CGST</th>
          <th style="text-align: right; width: 85px;">SGST</th>
          <th style="text-align: right; width: 100px;">Total (₹)</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>

    <div class="summary-section">
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px;">
        <div style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">
          Amount Chargeable (in words):
        </div>
        <div style="font-weight: 700; color: #0b2341; font-size: 13px; line-height: 1.4;">
          ${words}
        </div>

        <div style="margin-top: 16px; font-size: 11px; color: #475569;">
          <strong>Bank Details for Direct RTGS/NEFT:</strong><br>
          Bank: HDFC Bank Ltd | A/C No: 50200089234120<br>
          IFSC: HDFC0001234 | Branch: Yeshwanthpur APMC
        </div>
      </div>

      <div>
        <table class="totals-table" style="width: 100%; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
          <tr>
            <td style="color: #64748b;">Subtotal (Taxable):</td>
            <td style="text-align: right; font-weight: 600;">₹${order.subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
          </tr>
          ${
            order.discount > 0
              ? `<tr>
                  <td style="color: #16a34a;">Discount / Coupon:</td>
                  <td style="text-align: right; font-weight: 600; color: #16a34a;">-₹${order.discount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                </tr>`
              : ""
          }
          <tr>
            <td style="color: #64748b;">CGST (Central Tax):</td>
            <td style="text-align: right; font-weight: 600;">₹${cgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
          </tr>
          <tr>
            <td style="color: #64748b;">SGST (State Tax):</td>
            <td style="text-align: right; font-weight: 600;">₹${sgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
          </tr>
          <tr>
            <td style="color: #64748b;">Shipping / Freight:</td>
            <td style="text-align: right; font-weight: 600;">${order.shipping > 0 ? "₹" + order.shipping.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "FREE"}</td>
          </tr>
          <tr class="grand-total">
            <td>Grand Total (INR):</td>
            <td style="text-align: right;">₹${order.amount.toLocaleString("en-IN")}</td>
          </tr>
        </table>
      </div>
    </div>

    <div class="footer-note">
      <div>
        <strong>Terms & Conditions:</strong><br>
        1. All disputes are subject to Bengaluru jurisdiction.<br>
        2. Covered under Shami B2B wholesale grain quality guarantee.<br>
        3. This is a computer-generated tax invoice and requires no physical signature.
      </div>
      <div style="text-align: right;">
        <div style="margin-bottom: 24px; color: #64748b; font-size: 11px;">For Shami Business Ventures Pvt Ltd</div>
        <div style="font-weight: 700; color: #0b2341; border-top: 1px solid #cbd5e1; padding-top: 4px; display: inline-block;">
          Authorized Signatory
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Directly downloads the GST Tax Invoice file to the user's computer (.html format ready to view or print)
 */
export function downloadInvoice(order: Order, customerInfo?: CustomerInvoiceInfo, invoicePrefix = "INV-"): void {
  try {
    const htmlContent = generateInvoiceHTML(order, customerInfo, invoicePrefix);
    const invoiceNumber = `Invoice-${invoicePrefix}${order.id.replace(/[^0-9]/g, "") || order.id}`.replace(/[^A-Za-z0-9._-]+/g, "-");
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${invoiceNumber}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast.success(`Invoice for ${order.id} downloaded (${link.download})`);
  } catch (err) {
    console.error("Failed to download invoice:", err);
    toast.error("Failed to download invoice");
  }
}
