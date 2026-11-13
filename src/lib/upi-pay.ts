/*
 * Zero-fee direct UPI payments: the customer pays the company's own UPI ID (business account) for
 * the exact order amount, by QR or a UPI app, then enters the 12-digit UTR their app shows. The
 * admin confirms the UTR against the bank credit, which marks the order paid. No gateway, no
 * commission. Pure helpers, so the node tests can load them.
 */

export type UpiSettings = {
  enabled: boolean;
  /** The business UPI ID money goes to, e.g. shamibusiness@icici. */
  vpa: string;
  /** Name shown in the customer's UPI app. */
  payeeName: string;
  /** Minutes the customer has to pay before the QR is shown as expired (they can reopen it). */
  payWindowMinutes: number;
};

export const UPI_SETTINGS_KEY = "upi_direct";
export const DEFAULT_UPI_SETTINGS: UpiSettings = { enabled: false, vpa: "", payeeName: "Shami Business Ventures", payWindowMinutes: 15 };

export type UpiSubmissionStatus = "submitted" | "confirmed" | "rejected";
export type UpiSubmission = {
  orderNo: string;
  amount: number;
  utr: string;
  customer: string;
  submittedAt: string;
  status: UpiSubmissionStatus;
  reviewedAt?: string;
  note?: string;
  /** Sent after the checkout ended without payment ("paid after the time ran out"). */
  late?: boolean;
  /** Who sent it: the customer, the godown's channel partner, or an admin. */
  sentByRole?: "customer" | "partner" | "admin";
  /** The admin who confirmed or rejected it (13 Nov 2026: shown in its own column, and the list filters by it). */
  reviewedById?: string;
  reviewedBy?: string;
};

/** A UPI ID: handle@bank (letters, digits, dot, dash, underscore before @). */
export function isValidVpa(vpa: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(vpa.trim());
}

/** The UTR (UPI reference) is 12 digits; spaces the customer types are ignored. */
export function normaliseUtr(text: string) {
  return text.replace(/\s+/g, "");
}
/**
 * The UTR in whatever the customer pasted: the whole "Share receipt" text of PhonePe, Google Pay or Paytm, or just the
 * number with spaces. A number labelled UTR / UPI Ref / UPI transaction ID wins; otherwise the only 12-digit number in
 * the text. App transaction IDs (PhonePe's T2611... has 22 digits) are never taken. Null when unsure.
 */
export function utrFromText(text: string): string | null {
  const flat = text.replace(/[ \s]+/g, " ");
  const labelled = flat.match(/(?:UTR|UPI\s*Ref(?:erence)?(?:\s*No\.?)?|UPI\s*transaction\s*ID|Ref(?:erence)?\s*No\.?|RRN)\s*[:#-]?\s*((?:\d[ -]?){11}\d)(?!\d)/i);
  if (labelled) return labelled[1]!.replace(/\D/g, "");
  const plain = [...flat.matchAll(/(?<![\dA-Za-z])((?:\d[ -]?){11}\d)(?![\dA-Za-z])/g)].map((match) => match[1]!.replace(/\D/g, ""));
  const unique = [...new Set(plain)];
  return unique.length === 1 ? unique[0]! : null;
}

export function utrProblem(text: string): string | null {
  const utr = normaliseUtr(text);
  if (!utr) return "Enter the 12-digit UTR / UPI reference number from your UPI app";
  if (!/^\d+$/.test(utr)) return "The UTR has only digits";
  if (utr.length !== 12) return `The UTR has 12 digits (you entered ${utr.length})`;
  return null;
}

export function settingsProblem(settings: UpiSettings): string | null {
  if (!settings.enabled) return null;
  if (!isValidVpa(settings.vpa)) return "Enter the business UPI ID, like shamibusiness@icici";
  if (!settings.payeeName.trim()) return "Enter the business name customers see in their UPI app";
  if (!(settings.payWindowMinutes >= 5 && settings.payWindowMinutes <= 60)) return "Payment time must be 5 to 60 minutes";
  return null;
}

/**
 * The standard UPI payment link (NPCI deep-link): payee, exact amount in rupees with 2 decimals,
 * INR, and the order number as the note and transaction reference so it shows in the customer's
 * app and on the bank statement.
 */
export function upiPaymentUri(settings: Pick<UpiSettings, "vpa" | "payeeName">, amount: number, orderNo: string) {
  const params = new URLSearchParams({
    pa: settings.vpa.trim(),
    pn: settings.payeeName.trim().slice(0, 50),
    am: (Math.round(amount * 100) / 100).toFixed(2),
    cu: "INR",
    tn: `Grain Bazar ${orderNo}`.slice(0, 80),
    tr: orderNo.replace(/[^A-Za-z0-9-]/g, "").slice(0, 35),
  });
  // UPI apps expect %20, not "+", for spaces.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/** Buttons that open a specific UPI app on a phone (the generic link opens the app chooser). */
export function upiAppLinks(uri: string) {
  const query = uri.slice("upi://pay?".length);
  return [
    { app: "Google Pay", href: `tez://upi/pay?${query}` },
    { app: "PhonePe", href: `phonepe://pay?${query}` },
    { app: "Paytm", href: `paytmmp://pay?${query}` },
    { app: "Any UPI app", href: uri },
  ];
}

/** Seconds left to pay, from when the payment screen opened. */
export function secondsLeft(openedAt: number, windowMinutes: number, now: number) {
  return Math.max(0, Math.round((openedAt + windowMinutes * 60_000 - now) / 1000));
}

/** Adds or replaces the order's submission (a new UTR for a rejected one is allowed; a confirmed one stays). */
export function upsertSubmission(list: UpiSubmission[], next: UpiSubmission): UpiSubmission[] {
  const existing = list.find((item) => item.orderNo === next.orderNo);
  if (existing?.status === "confirmed") throw new Error("This order's payment is already confirmed");
  const utrUsed = list.find((item) => item.utr === next.utr && item.orderNo !== next.orderNo && item.status !== "rejected");
  if (utrUsed) throw new Error(`This UTR was already used for order ${utrUsed.orderNo}`);
  return [next, ...list.filter((item) => item.orderNo !== next.orderNo)];
}

/** The admin's decision on a submission. */
export function reviewSubmission(list: UpiSubmission[], orderNo: string, status: "confirmed" | "rejected", now: string, note?: string) {
  return list.map((item) => item.orderNo === orderNo ? { ...item, status, reviewedAt: now, ...(note ? { note } : {}) } : item);
}
