/*
 * Phone OTP by SMS through Fast2SMS. Supabase Auth makes the code and calls our "Send SMS" hook
 * (/api/auth/send-sms) with it; the hook checks Supabase's signature and sends the code with the
 * Fast2SMS OTP route. Supabase still checks the code the customer types, its expiry and rate limits.
 */

/** Supabase signs hook calls the Standard Webhooks way (webhook-id / -timestamp / -signature). */
export const HOOK_TOLERANCE_SECONDS = 5 * 60;

const toBytes = (text: string) => new TextEncoder().encode(text);

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Compares two strings without leaking where they differ. */
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request was signed by Supabase with this hook's secret ("v1,whsec_…" as shown in
 * the Supabase dashboard) less than five minutes ago.
 */
export async function verifyHookSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const key = base64ToBytes(secret.trim().replace(/^v1,/, "").replace(/^whsec_/, ""));
  if (!key || key.length < 16 || !headers.id || !headers.timestamp || !headers.signature) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > HOOK_TOLERANCE_SECONDS) return false;
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToBase64(await crypto.subtle.sign("HMAC", cryptoKey, toBytes(`${headers.id}.${headers.timestamp}.${body}`)));
  // The header may carry several space-separated "v1,<signature>" entries (during secret rotation).
  return headers.signature.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return version === "v1" && !!signature && sameText(signature, expected);
  });
}

/** The 10-digit Indian mobile number and the code from Supabase's hook payload; null when unusable. */
export function smsFromHookPayload(payload: unknown): { mobile: string; otp: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const { user, sms } = payload as { user?: { phone?: unknown }; sms?: { otp?: unknown } };
  const digits = String(user?.phone ?? "").replace(/\D/g, "");
  const otp = String(sms?.otp ?? "");
  // Grain Bazar customers sign in with +91 numbers: 91 + a 10-digit mobile starting 6-9.
  const mobile = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 10 ? digits : "";
  if (!/^[6-9]\d{9}$/.test(mobile) || !/^\d{4,10}$/.test(otp)) return null;
  return { mobile, otp };
}

export const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";

/** The Fast2SMS OTP-route request: the code goes out as "<code> is your verification code…". */
export function fast2smsOtpRequest(apiKey: string, mobile: string, otp: string): { url: string; init: RequestInit } {
  return {
    url: FAST2SMS_URL,
    init: {
      method: "POST",
      headers: { authorization: apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ route: "otp", variables_values: otp, numbers: mobile, flash: "0" }),
    },
  };
}

/** Fast2SMS answers { return: true, request_id } when the SMS is accepted; anything else is a failure. */
export function fast2smsOutcome(status: number, body: unknown): { ok: true; requestId: string } | { ok: false; code: number | null; message: string } {
  const data = (body && typeof body === "object" ? body : {}) as { return?: unknown; request_id?: unknown; message?: unknown; status_code?: unknown };
  if (status >= 200 && status < 300 && data.return === true) return { ok: true, requestId: String(data.request_id ?? "") };
  const message = Array.isArray(data.message) ? data.message.join(" ") : String(data.message ?? `HTTP ${status}`);
  const code = Number.isFinite(Number(data.status_code)) && data.status_code !== undefined && data.status_code !== null ? Number(data.status_code) : null;
  return { ok: false, code, message: `Fast2SMS refused the SMS${code !== null ? ` (${code})` : ""}: ${message}`.slice(0, 300) };
}

/** Fast2SMS refuses more codes to a number that just got several ("Spamming detected"). */
export const FAST2SMS_SPAM_CODE = 995;
export const SMS_TOO_MANY_MESSAGE = "Too many codes were sent to this number. Please wait 10 minutes and try again.";
export const SMS_FAILED_MESSAGE = "Could not send the SMS right now. Please try again or sign in with email.";

/** What the customer is told when Fast2SMS refuses (HTTP code and message for Supabase). */
export function smsFailureForCustomer(code: number | null) {
  return code === FAST2SMS_SPAM_CODE ? { httpCode: 429, message: SMS_TOO_MANY_MESSAGE } : { httpCode: 502, message: SMS_FAILED_MESSAGE };
}

/**
 * The hook's answer to Supabase for a failure. Supabase passes the message on to the app only when
 * the hook answers HTTP 200 with { error: { http_code, message } }; any other HTTP status reaches the
 * customer as "Unexpected status code returned from hook".
 */
export function hookErrorBody(httpCode: number, message: string) {
  return { status: 200, body: { error: { http_code: httpCode, message } } };
}
