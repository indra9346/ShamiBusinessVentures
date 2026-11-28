/*
 * Cashfree Payment Gateway (owner, 28 Nov 2026): what the website sends to Cashfree and how it reads what comes back.
 * The UPI link and QR the site builds itself are not signed by any gateway, so UPI apps refuse bigger amounts; Cashfree's
 * own checkout does not have that problem. See supabase/migrations/20261128120000_cashfree_gateway.sql for the records.
 *
 * Set up only from the server's environment: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (sandbox | production).
 * Nothing here ever returns the secret key. No framework imports, so the node tests run this file as it is.
 */

export type CashfreeEnvironment = "sandbox" | "production";

export type CashfreeConfig = {
  appId: string;
  secretKey: string;
  environment: CashfreeEnvironment;
  apiBase: string;
  sdkUrl: string;
  apiVersion: string;
};

/** The API version every call names. 2025-01-01 is the one Cashfree's own checkout guides use. */
export const CASHFREE_API_VERSION = "2025-01-01";
export const CASHFREE_SDK_URL = "https://sdk.cashfree.com/js/v3/cashfree.js";
export const CASHFREE_API_BASE: Record<CashfreeEnvironment, string> = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
};
/** The admin switch (Admin > UPI & Bank Payments). Off until an admin turns it on. */
export const CASHFREE_SETTING_KEY = "cashfree_gateway";

type Env = Record<string, string | undefined>;
const clean = (value: string | undefined) => (value ?? "").trim();
const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);

/**
 * What is missing or wrong in the server's Cashfree settings, by name only (never a value), or null when all is set.
 */
export function cashfreeSetupProblem(env: Env): string | null {
  const missing = ["CASHFREE_APP_ID", "CASHFREE_SECRET_KEY", "CASHFREE_ENV"].filter((name) => !clean(env[name]));
  if (missing.length) return `Not set on the server: ${missing.join(", ")}`;
  const mode = clean(env["CASHFREE_ENV"]).toLowerCase();
  if (mode !== "sandbox" && mode !== "production") return "CASHFREE_ENV must be sandbox or production";
  return null;
}

/**
 * The Cashfree settings, or null when any is missing: then Cashfree is never offered. In sandbox only, a local stand-in
 * (http://localhost) may replace Cashfree's addresses for a test run (CASHFREE_TEST_API_BASE, CASHFREE_TEST_SDK_URL);
 * production always talks to Cashfree itself.
 */
export function cashfreeConfigFrom(env: Env): CashfreeConfig | null {
  if (cashfreeSetupProblem(env)) return null;
  const environment = clean(env["CASHFREE_ENV"]).toLowerCase() as CashfreeEnvironment;
  const testApi = clean(env["CASHFREE_TEST_API_BASE"]);
  const testSdk = clean(env["CASHFREE_TEST_SDK_URL"]);
  return {
    appId: clean(env["CASHFREE_APP_ID"]),
    secretKey: clean(env["CASHFREE_SECRET_KEY"]),
    environment,
    apiBase: environment === "sandbox" && isLocal(testApi) ? testApi.replace(/\/+$/, "") : CASHFREE_API_BASE[environment],
    sdkUrl: environment === "sandbox" && isLocal(testSdk) ? testSdk : CASHFREE_SDK_URL,
    apiVersion: CASHFREE_API_VERSION,
  };
}

export type CashfreeGatewaySetting = { enabled: boolean; testers: string[] };

/** settings.cashfree_gateway as stored: anything unreadable is "off". Testers are emails or 10-digit mobiles. */
export function cashfreeSettingFrom(value: unknown): CashfreeGatewaySetting {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const testers = Array.isArray(row["testers"]) ? row["testers"] : [];
  return {
    enabled: row["enabled"] === true,
    testers: [...new Set(testers.map((entry) => cashfreeTester(String(entry ?? ""))).filter((entry): entry is string => Boolean(entry)))].slice(0, 20),
  };
}

/** A test login as kept on the list: an email in lower case, or a 10-digit mobile. Null when it is neither. */
export function cashfreeTester(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(text)) return text;
  return cashfreePhone(text);
}

/**
 * Whether this signed-in person may pay through Cashfree now. Production: everyone, while the switch is on. Sandbox: only
 * admins and the listed test logins, so a real customer never "pays" the live site with Cashfree's test money.
 */
export function cashfreeOpenTo(
  config: Pick<CashfreeConfig, "environment"> | null,
  setting: CashfreeGatewaySetting,
  person: { isAdmin: boolean; email?: string | null | undefined; phone?: string | null | undefined },
) {
  if (!config || !setting.enabled) return false;
  if (config.environment === "production") return true;
  if (person.isAdmin) return true;
  const email = (person.email ?? "").trim().toLowerCase();
  const phone = cashfreePhone(person.phone ?? "");
  return setting.testers.some((tester) => tester === email || (phone !== null && tester === phone));
}

/** A 10-digit Indian mobile number, as Cashfree's customer_phone wants it, from what a customer typed. */
export function cashfreePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

/** Cashfree's customer_id: letters and digits only, 3 to 50. Our user id without its dashes. */
export function cashfreeCustomerId(userId: string) {
  const id = userId.replace(/[^0-9A-Za-z]/g, "").slice(0, 50);
  return id.length >= 3 ? id : `customer${id}`;
}

/**
 * When the Cashfree order stops taking payments: two minutes after the checkout's own time, and never sooner than 16
 * minutes from now (Cashfree's own lower limit is not documented; 15 minutes is common). The website asks Cashfree to
 * end it as soon as the checkout's time is up, so a late payment cannot start in between.
 */
export function cashfreeExpiry(holdUntil: string | null, now = Date.now()) {
  const hold = holdUntil ? Date.parse(holdUntil) : NaN;
  const at = Math.max(Number.isFinite(hold) ? hold + 2 * 60_000 : 0, now + 16 * 60_000);
  return new Date(Math.ceil(at / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

export type CashfreeOrderInput = {
  cfOrderRef: string;
  orderNo: string;
  amount: number;
  holdUntil: string | null;
  userId: string;
  customer: { name?: string | null; email?: string | null; phone?: string | null };
  returnUrl: string;
  notifyUrl: string | null;
  now?: number;
};

/** The body of Cashfree's Create Order call, or the reason one cannot be made. */
export function cashfreeOrderBody(input: CashfreeOrderInput): { body: Record<string, unknown> } | { problem: string } {
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount >= 1)) return { problem: "Nothing is due on this order" };
  if (!/^[0-9A-Za-z_-]{3,45}$/.test(input.cfOrderRef)) return { problem: "This order number cannot be sent to Cashfree" };
  const phone = cashfreePhone(input.customer.phone ?? "");
  if (!phone) return { problem: "Add your 10-digit mobile number to your profile or address to pay online" };
  const name = (input.customer.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const email = (input.customer.email ?? "").trim();
  const customer: Record<string, string> = { customer_id: cashfreeCustomerId(input.userId), customer_phone: phone };
  if (name.length >= 3) customer["customer_name"] = name;
  if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) && email.length <= 100) customer["customer_email"] = email;
  const meta: Record<string, string> = { return_url: input.returnUrl.slice(0, 250) };
  if (input.notifyUrl && /^https:\/\//.test(input.notifyUrl) && input.notifyUrl.length <= 250) meta["notify_url"] = input.notifyUrl;
  return {
    body: {
      order_id: input.cfOrderRef,
      order_amount: amount,
      order_currency: "INR",
      customer_details: customer,
      order_meta: meta,
      order_expiry_time: cashfreeExpiry(input.holdUntil, input.now),
      order_note: `Grain Bazar order ${input.orderNo}`.slice(0, 200),
      order_tags: { order_no: input.orderNo.slice(0, 255) },
    },
  };
}

/** Headers for a call to Cashfree's PG API (server only: it carries the secret key). */
export function cashfreeHeaders(config: CashfreeConfig): Record<string, string> {
  return {
    "x-client-id": config.appId,
    "x-client-secret": config.secretKey,
    "x-api-version": config.apiVersion,
    "content-type": "application/json",
    accept: "application/json",
  };
}

/**
 * Where the customer lands after Cashfree's page when it had to leave ours: the order's own page, which shows the
 * checkout still waiting (and asks Cashfree again) or the order once it is placed.
 */
export function cashfreeReturnUrl(origin: string, orderNo: string) {
  return `${origin.replace(/\/+$/, "")}/account/orders/${encodeURIComponent(orderNo)}`;
}

/** The site's own address for return links: the browser's Origin when it is ours (https, or a local test), else the site. */
export function cashfreeReturnOrigin(origin: string | null | undefined, fallback: string) {
  const value = (origin ?? "").trim().replace(/\/+$/, "");
  if (/^https:\/\/([a-z0-9-]+\.)*grainbazar\.com$/i.test(value) || isLocal(`${value}/`)) return value;
  return fallback.replace(/\/+$/, "");
}

/** Supabase's address for Cashfree's webhook (the Edge Function cashfree-webhook). */
export function cashfreeWebhookUrl(supabaseUrl: string | undefined) {
  const base = (supabaseUrl ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? `${base}/functions/v1/cashfree-webhook` : null;
}

// ---------------------------------------------------------------- what comes back

export type CashfreePayment = {
  cfPaymentId: string;
  cfOrderRef: string;
  status: string;
  amount: number;
  bankReference: string;
  group: string;
  paymentTime: string | null;
};

const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** One payment from Cashfree's API (Get Payments for an Order) or a webhook's data.payment, or null when it is not one. */
export function cashfreePaymentFrom(raw: unknown, cfOrderRef: string): CashfreePayment | null {
  const row = record(raw);
  if (!row) return null;
  const cfPaymentId = text(row["cf_payment_id"]);
  const status = text(row["payment_status"]).toUpperCase();
  const amount = Number(row["payment_amount"]);
  const ref = text(row["order_id"]) || cfOrderRef;
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(cfPaymentId) || !/^[A-Z_]{2,30}$/.test(status) || !Number.isFinite(amount) || !ref) return null;
  const time = text(row["payment_completion_time"]) || text(row["payment_time"]);
  return {
    cfPaymentId,
    cfOrderRef: ref,
    status,
    amount: Math.round(amount * 100) / 100,
    bankReference: text(row["bank_reference"]).slice(0, 64),
    group: text(row["payment_group"]).toLowerCase().slice(0, 40),
    paymentTime: time && Number.isFinite(Date.parse(time)) ? new Date(Date.parse(time)).toISOString() : null,
  };
}

export type CashfreeWebhook = { type: string; payment: CashfreePayment | null };

/** What a Cashfree webhook says: its type and the payment in it (null for other events, e.g. refunds or charges). */
export function cashfreeWebhookFrom(body: string): CashfreeWebhook | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root) return null;
  const type = text(root["type"]).toUpperCase();
  const data = record(root["data"]);
  const order = record(data?.["order"]);
  const payment = record(data?.["payment"]);
  const cfOrderRef = text(order?.["order_id"]);
  if (!payment || !cfOrderRef) return { type, payment: null };
  return { type, payment: cashfreePaymentFrom({ ...payment, order_id: cfOrderRef }, cfOrderRef) };
}

const toBase64 = (bytes: ArrayBuffer) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Cashfree signs each webhook: base64(HMAC-SHA256(timestamp + raw body, secret key)), in x-webhook-signature with the
 * timestamp in x-webhook-timestamp. The exact raw body must be used. One page of Cashfree's guide writes the signed text
 * with a dot between the two, so that form is accepted too; both need the secret key.
 */
export async function cashfreeSignatureValid(rawBody: string, timestamp: string, signature: string, secretKey: string) {
  if (!secretKey || !/^[0-9]{6,16}$/.test(timestamp.trim()) || !/^[A-Za-z0-9+/=]{20,100}$/.test(signature.trim())) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  for (const signed of [`${timestamp.trim()}${rawBody}`, `${timestamp.trim()}.${rawBody}`]) {
    const expected = toBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
    if (sameText(expected, signature.trim())) return true;
  }
  return false;
}

/** What to do with an open Cashfree order once its payments are read. */
export function cashfreeNextStep(input: { cashfreeStatus: string; checkoutDone: boolean; expiresAt: string | null; now?: number }): "close" | "end" | "keep" {
  const status = input.cashfreeStatus.toUpperCase();
  if (status === "PAID" || status === "TERMINATION_REQUESTED") return "keep";
  if (status === "EXPIRED" || status === "TERMINATED") return "close";
  const expired = input.expiresAt ? Date.parse(input.expiresAt) <= (input.now ?? Date.now()) : false;
  if (status === "ACTIVE" && input.checkoutDone) return "end";
  if (expired && status === "ACTIVE") return "end";
  return "keep";
}

/** Plain words for a payment's state on the customer's screen. */
export function cashfreeStatusWords(status: string) {
  switch (status.toUpperCase()) {
    case "SUCCESS": return "Paid";
    case "PENDING": return "Waiting for your bank";
    case "FAILED": return "Payment failed";
    case "USER_DROPPED": return "Payment not completed";
    case "CANCELLED": return "Payment cancelled";
    case "VOID": return "Payment cancelled";
    case "NOT_ATTEMPTED": return "Not paid yet";
    default: return "Not paid yet";
  }
}

/** A Cashfree API error as one line for the office, without anything secret. */
export function cashfreeErrorLine(status: number, body: unknown) {
  const row = record(body);
  const message = text(row?.["message"]).slice(0, 200);
  const code = text(row?.["code"]).slice(0, 60);
  return `Cashfree answered ${status}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
}
