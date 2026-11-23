// What a customer is sent when their payment is confirmed (client, 19 Nov 2026: "emails are not going to customers;
// integrate that emails should go from Zoho Books and SMS order confirmation after marking payment confirmed from admin
// panel"). The invoice email goes through Zoho Books (Email an invoice), the SMS through Fast2SMS (Supabase function
// order-sms, which holds the key already used for sign-in codes). Both are off until an admin switches them on, and each
// goes once per order. No app imports, so the tests and the Supabase function use the same rules.

export type CustomerMessageSettings = {
  /** Zoho Books emails the order's invoice to the customer when the payment is confirmed. */
  email: boolean;
  /** An order-confirmation SMS to the customer's mobile. */
  sms: boolean;
  /**
   * Fast2SMS route: "q" = Quick SMS (plain text, no DLT template; Fast2SMS's own sender, costs more per SMS),
   * "dlt" = the company's DLT-registered sender ID and template (cheaper; the template's variables are filled in order).
   */
  smsRoute: "q" | "dlt";
  /** DLT only: the 6-letter sender ID, and the Fast2SMS message ID of the approved template. */
  senderId: string;
  dltMessageId: string;
  /** When messages were last switched on: only orders made from a day before then get them (never a backlog). */
  since: string;
  /**
   * An SMS when the godown hands the order over (client and Sandesh, 23 Nov 2026: "once the channel partner marks the
   * product handed over at the godown, the message should go to that customer"). Off until switched on.
   */
  deliverySms: boolean;
  /** DLT only: the Fast2SMS message ID of the approved hand-over template (variables: order no, godown, time). */
  deliveryDltMessageId: string;
  /** When the hand-over SMS was last switched on (only orders handed over from then on get it). */
  deliverySince: string;
};

export const CUSTOMER_MESSAGES_KEY = "customer_messages";
export const DEFAULT_CUSTOMER_MESSAGES: CustomerMessageSettings = { email: false, sms: false, smsRoute: "q", senderId: "", dltMessageId: "", since: "", deliverySms: false, deliveryDltMessageId: "", deliverySince: "" };

export function cleanCustomerMessageSettings(value: unknown): CustomerMessageSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  return {
    email: v["email"] === true,
    sms: v["sms"] === true,
    smsRoute: v["smsRoute"] === "dlt" ? "dlt" : "q",
    senderId: text(v["senderId"], 40).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6),
    dltMessageId: text(v["dltMessageId"], 20).replace(/\D/g, ""),
    since: typeof v["since"] === "string" && Number.isFinite(Date.parse(v["since"])) ? v["since"] : "",
    deliverySms: v["deliverySms"] === true,
    deliveryDltMessageId: text(v["deliveryDltMessageId"], 20).replace(/\D/g, ""),
    deliverySince: typeof v["deliverySince"] === "string" && Number.isFinite(Date.parse(v["deliverySince"])) ? v["deliverySince"] : "",
  };
}

/** Whether an order is new enough for messages: made at most a day before they were switched on, and within 3 days. */
export function orderInMessageWindow(createdAt: string, since: string, nowMs: number) {
  const made = Date.parse(createdAt);
  const from = Date.parse(since);
  if (!Number.isFinite(made) || !Number.isFinite(from)) return false;
  return made >= from - 86_400_000 && nowMs - made <= 3 * 86_400_000;
}

/** Why these settings can't be saved, or "". */
export function customerMessageSettingsProblem(s: CustomerMessageSettings) {
  if (s.sms && s.smsRoute === "dlt") {
    if (!/^[A-Z]{6}$/.test(s.senderId)) return "Enter the 6-letter DLT sender ID";
    if (!/^\d{3,20}$/.test(s.dltMessageId)) return "Enter the Fast2SMS message ID of the approved DLT template";
  }
  if (s.deliverySms && s.smsRoute === "dlt") {
    if (!/^[A-Z]{6}$/.test(s.senderId)) return "Enter the 6-letter DLT sender ID";
    if (!/^\d{3,20}$/.test(s.deliveryDltMessageId)) return "Enter the Fast2SMS message ID of the approved hand-over (delivery) DLT template";
  }
  return "";
}

/** A 10-digit Indian mobile number from what the order has (+91, spaces, dashes), or "" when it is not one. */
export function indianMobile(phone: string | null | undefined) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const mobile = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(mobile) ? mobile : "";
}

/**
 * The first Indian mobile among the places a customer's number can be, in order (19 Nov 2026: 7 of 25 pickup orders had
 * no phone on the order itself, so their SMS was skipped; their saved address had one).
 */
export function firstIndianMobile(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    const mobile = indianMobile(candidate);
    if (mobile) return mobile;
  }
  return "";
}

export const isEmail = (value: string | null | undefined) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? "").trim());

const rupees = (amount: number) => `Rs ${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type ConfirmedOrder = { orderNo: string; customer: string; total: number; godown: string; invoiceNumber: string; pickup: boolean };

/** The SMS (plain text, under 160 characters for one SMS where it can be): order, amount, where to collect or delivery. */
export function orderConfirmSms(o: ConfirmedOrder) {
  const where = o.pickup ? `Collect at ${o.godown || "our godown"}.` : "We will deliver soon.";
  return `Grain Bazar: Payment received. Order ${o.orderNo} for ${rupees(o.total)} is confirmed. ${where} Invoice ${o.invoiceNumber || "follows"}. Thank you.`;
}

/** The DLT template's variables, in order (the approved template must carry them in this order). */
export const orderConfirmDltValues = (o: ConfirmedOrder) => [o.orderNo, rupees(o.total), o.invoiceNumber || "-"];

/** The Zoho Books invoice email's subject and body (Zoho attaches the invoice to its own email). */
export function invoiceEmail(o: ConfirmedOrder) {
  return {
    subject: `Grain Bazar order ${o.orderNo} confirmed: invoice ${o.invoiceNumber}`,
    body: [
      `Dear ${o.customer || "Customer"},`,
      "",
      `Thank you for your payment. Your order ${o.orderNo} for ${rupees(o.total)} is confirmed.`,
      `Your invoice ${o.invoiceNumber} is attached.`,
      o.pickup ? `You can collect your goods at ${o.godown || "our godown"}; show the QR code on the invoice.` : "We will tell you when it is on the way.",
      "",
      "For any help, reply to this email or call us.",
      "",
      "Grain Bazar · Shami Business Ventures Private Limited",
    ].join("<br>"),
  };
}

export const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";

/** The Fast2SMS request for an order SMS, by route. */
export function fast2smsOrderRequest(apiKey: string, mobile: string, s: Pick<CustomerMessageSettings, "smsRoute" | "senderId" | "dltMessageId">, o: ConfirmedOrder) {
  const body = s.smsRoute === "dlt"
    ? { route: "dlt", sender_id: s.senderId, message: s.dltMessageId, variables_values: orderConfirmDltValues(o).join("|"), numbers: mobile, flash: "0" }
    : { route: "q", message: orderConfirmSms(o), language: "english", numbers: mobile, flash: "0" };
  return {
    url: FAST2SMS_URL,
    init: { method: "POST", headers: { authorization: apiKey, "Content-Type": "application/json", accept: "application/json" }, body: JSON.stringify(body) },
  };
}

/** An order the godown has handed over: for the hand-over SMS. */
export type HandedOverOrder = { orderNo: string; godown: string; at: string };

/** "23 Nov 2026, 06:53 PM": the hand-over time in India, for the SMS. */
export function handoverSmsTime(iso: string) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

/** The hand-over SMS (plain text, one SMS). */
export function orderDeliveredSms(o: HandedOverOrder) {
  const when = handoverSmsTime(o.at);
  return `Grain Bazar: Your order ${o.orderNo} was handed over at ${o.godown || "our godown"}${when ? ` on ${when}` : ""}. Thank you for shopping with us.`;
}

/** The hand-over DLT template's variables, in order: order no, godown, time. */
export const orderDeliveredDltValues = (o: HandedOverOrder) => [o.orderNo, o.godown || "our godown", handoverSmsTime(o.at) || "-"];

/** The Fast2SMS request for a hand-over SMS, by route. */
export function fast2smsDeliveredRequest(apiKey: string, mobile: string, s: Pick<CustomerMessageSettings, "smsRoute" | "senderId" | "deliveryDltMessageId">, o: HandedOverOrder) {
  const body = s.smsRoute === "dlt"
    ? { route: "dlt", sender_id: s.senderId, message: s.deliveryDltMessageId, variables_values: orderDeliveredDltValues(o).join("|"), numbers: mobile, flash: "0" }
    : { route: "q", message: orderDeliveredSms(o), language: "english", numbers: mobile, flash: "0" };
  return {
    url: FAST2SMS_URL,
    init: { method: "POST", headers: { authorization: apiKey, "Content-Type": "application/json", accept: "application/json" }, body: JSON.stringify(body) },
  };
}

/** The kinds of SMS the order-sms function can send; the website asks before sending a hand-over SMS. */
export const ORDER_SMS_KINDS = ["confirmed", "delivered"] as const;
