// Order alerts for the office (client's note, 17 Nov 2026):
//   "Notification for each order like Zoho Commerce saying Order received from Challakere branch, order amount. &
//    Voice notifications if abnormal sales orders received for item wise sales average per day."
// What is said and when an order is unusual; the panel (OrderAlerts.tsx) listens for orders and speaks. No app imports,
// so the tests load it directly.

/** Orders that are not (yet) real sales: a checkout waiting for its payment, one that ran out, a cancelled one. */
const NOT_A_SALE = ["Awaiting Payment", "Payment Expired", "Cancelled"];

/** Whether an order seen now should be announced: a real order, made recently (an old one only changed). */
export function shouldAnnounce(order: { order_status: string; created_at: string }, nowMs: number, withinHours = 12) {
  if (NOT_A_SALE.includes(order.order_status)) return false;
  const made = Date.parse(order.created_at);
  return Number.isFinite(made) && nowMs - made <= withinHours * 3600_000 && made <= nowMs + 5 * 60_000;
}

/** "Challakere Godown" → "Challakere branch" (the client's words). */
export function branchWords(godownName: string) {
  const name = godownName.replace(/^grain\s*bazar\s*/i, "").replace(/\s*godown\s*$/i, "").trim();
  return name ? `${name} branch` : "the website";
}

/** ₹13,740.50 in Indian grouping, as shown. */
export const rupees = (amount: number) =>
  `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the alert shows and says for an order. */
export function orderAlertText(order: { order_no: string; total: number }, godownName: string) {
  const where = branchWords(godownName);
  const amount = Math.round(order.total * 100) / 100;
  const whole = Math.floor(amount);
  const paise = Math.round((amount - whole) * 100);
  return {
    title: `Order received from ${where}`,
    body: `${order.order_no} · Order amount ${rupees(amount)}`,
    // Said in words the voice reads well: "13,740 rupees", "and 50 paise".
    speech: `Order received from ${where}. Order amount ${whole.toLocaleString("en-IN")} rupees${paise ? ` and ${paise} paise` : ""}.`,
  };
}

export type SoldLine = { product_id: string | null; product_name: string; qty: number; created_at: string };

/**
 * Each item's average sales per day: the units of real orders over the last `days` days (today included) divided by
 * `days`. Items with no sale in that time are left out (their average is 0).
 */
export function itemDailyAverages(lines: SoldLine[], nowMs: number, days = 30): Map<string, { name: string; perDay: number; units: number }> {
  const from = nowMs - days * 86_400_000;
  const totals = new Map<string, { name: string; units: number }>();
  for (const line of lines) {
    const at = Date.parse(line.created_at);
    if (!Number.isFinite(at) || at < from || at > nowMs) continue;
    const key = line.product_id || line.product_name;
    const seen = totals.get(key) ?? { name: line.product_name, units: 0 };
    seen.units += Math.max(0, Number(line.qty) || 0);
    totals.set(key, seen);
  }
  return new Map([...totals].map(([key, t]) => [key, { name: t.name, units: t.units, perDay: Math.round((t.units / days) * 100) / 100 }]));
}

export type AlertSettings = {
  /** Say the order aloud. */
  voice: boolean;
  /** Show a desktop notification while the panel is in the background. */
  desktop: boolean;
  /** An order line is unusual from this many days' worth of the item's average sales. */
  factor: number;
  /** ...and never below this many units (so small items are not called unusual for a few packs). */
  minUnits: number;
};
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { voice: true, desktop: true, factor: 3, minUnits: 5 };

export function cleanAlertSettings(value: unknown): AlertSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const n = (x: unknown, lo: number, hi: number, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);
  return {
    voice: typeof v["voice"] === "boolean" ? v["voice"] : DEFAULT_ALERT_SETTINGS.voice,
    desktop: typeof v["desktop"] === "boolean" ? v["desktop"] : DEFAULT_ALERT_SETTINGS.desktop,
    factor: n(v["factor"], 1.5, 30, DEFAULT_ALERT_SETTINGS.factor),
    minUnits: n(v["minUnits"], 1, 10_000, DEFAULT_ALERT_SETTINGS.minUnits),
  };
}

export type UnusualLine = { name: string; qty: number; perDay: number; limit: number };

/**
 * The lines of an order far above the item's usual sales: more than `factor` days of its average, and at least
 * `minUnits`. An item with no sales in the period counts as unusual from `minUnits` × `factor` units.
 */
export function unusualLines(
  lines: { product_id: string | null; product_name: string; qty: number }[],
  averages: Map<string, { perDay: number }>,
  settings: Pick<AlertSettings, "factor" | "minUnits">,
): UnusualLine[] {
  const out: UnusualLine[] = [];
  for (const line of lines) {
    const perDay = averages.get(line.product_id || line.product_name)?.perDay ?? 0;
    const limit = perDay > 0 ? Math.max(settings.minUnits, perDay * settings.factor) : settings.minUnits * settings.factor;
    if (line.qty > limit) out.push({ name: line.product_name, qty: line.qty, perDay, limit: Math.round(limit * 100) / 100 });
  }
  return out;
}

/** What is said for unusual lines. */
export function unusualSpeech(orderNo: string, where: string, lines: UnusualLine[]) {
  const parts = lines.map((l) => `${l.qty} of ${l.name}, where the usual is ${l.perDay > 0 ? `${l.perDay} a day` : "almost none"}`);
  return `Attention. Unusual order from ${where}: ${parts.join("; ")}. Please check order ${orderNo.split("-").pop() ?? orderNo}.`;
}

// ------------------------------------------------------------------ the office's voice wording (19 Nov 2026)
// Owner: "Need voice notification customization" (then: "make it accurate with the best of your knowledge"). Saved once for
// the whole office (settings.order_voice_alerts); each computer still switches its own voice and desktop alerts.

export type VoiceLanguage = "en" | "kn";
export type VoiceSettings = {
  language: VoiceLanguage;
  /** What is said for each order: {branch} {items} {amount} {order} {customer}. */
  orderText: string;
  /** What is said for an unusual order: {branch} {qty} {item} {usual} {order}. */
  unusualText: string;
  /** Times each alert is said (1 to 3). */
  repeat: number;
  /** Speaking speed, 0.7 (slow) to 1.3 (fast). */
  rate: number;
  /** A short chime before speaking. */
  chime: boolean;
  /** Godowns (branch ids) announced; empty = all. */
  branches: string[];
  /** Unusual: more than this many days of the item's average sales, and at least minUnits. */
  factor: number;
  minUnits: number;
};

export const ORDER_VOICE_KEY = "order_voice_alerts";
export const SUGGESTED_WORDING: Record<VoiceLanguage, { orderText: string; unusualText: string }> = {
  en: {
    orderText: "New order from {branch} branch. {items}. Order amount {amount}.",
    unusualText: "Attention please. Unusual order from {branch} branch. {qty} {item}, when the usual is {usual}. Please check order {order}.",
  },
  kn: {
    orderText: "{branch} ಶಾಖೆಯಿಂದ ಹೊಸ ಆರ್ಡರ್. {items}. ಆರ್ಡರ್ ಮೊತ್ತ {amount}.",
    unusualText: "ದಯವಿಟ್ಟು ಗಮನಿಸಿ. {branch} ಶಾಖೆಯಿಂದ ಅಸಾಮಾನ್ಯ ಆರ್ಡರ್. {item} {qty}, ಸಾಮಾನ್ಯವಾಗಿ {usual}. ಆರ್ಡರ್ {order} ಪರಿಶೀಲಿಸಿ.",
  },
};
export const DEFAULT_VOICE: VoiceSettings = { language: "en", ...SUGGESTED_WORDING.en, repeat: 1, rate: 0.95, chime: true, branches: [], factor: 3, minUnits: 5 };
export const VOICE_PLACEHOLDERS = {
  order: ["{branch}", "{items}", "{amount}", "{order}", "{customer}"],
  unusual: ["{branch}", "{qty}", "{item}", "{usual}", "{order}"],
} as const;

export function cleanVoiceSettings(value: unknown): VoiceSettings {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const language: VoiceLanguage = v["language"] === "kn" ? "kn" : "en";
  const text = (x: unknown, fallback: string) => (typeof x === "string" && x.trim() ? x.trim().replace(/\s+/g, " ").slice(0, 300) : fallback);
  const num = (x: unknown, lo: number, hi: number, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback);
  return {
    language,
    orderText: text(v["orderText"], SUGGESTED_WORDING[language].orderText),
    unusualText: text(v["unusualText"], SUGGESTED_WORDING[language].unusualText),
    repeat: Math.round(num(v["repeat"], 1, 3, 1)),
    rate: Math.round(num(v["rate"], 0.7, 1.3, 0.95) * 100) / 100,
    chime: v["chime"] !== false,
    branches: Array.isArray(v["branches"]) ? [...new Set(v["branches"].filter((b): b is string => typeof b === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b)))] : [],
    factor: num(v["factor"], 1.5, 30, 3),
    minUnits: Math.round(num(v["minUnits"], 1, 10_000, 5)),
  };
}

/** "Challakere" from "Grain Bazar Challakere Godown". */
export const branchShort = (godownName: string) => godownName.replace(/^grain\s*bazar\s*/i, "").replace(/\s*godown\s*$/i, "").trim() || "website";

/** An amount as said: "5,496 rupees and 50 paise" / "5,496 ರೂಪಾಯಿ 50 ಪೈಸೆ". */
export function spokenAmount(amount: number, language: VoiceLanguage) {
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  const whole = Math.floor(paiseTotal / 100).toLocaleString("en-IN");
  const paise = paiseTotal % 100;
  if (language === "kn") return `${whole} ರೂಪಾಯಿ${paise ? ` ${paise} ಪೈಸೆ` : ""}`;
  return `${whole} rupees${paise ? ` and ${paise} paise` : ""}`;
}

/** The order's lines as said: "2 Sugar S1, 1 Ekadantha OIL 850ML" (at most 3, then "and 2 more"). */
export function spokenItems(lines: { product_name: string; qty: number }[], language: VoiceLanguage) {
  const said = lines.slice(0, 3).map((l) => `${Math.round(l.qty * 100) / 100} ${l.product_name}`);
  const more = lines.length - said.length;
  if (more > 0) said.push(language === "kn" ? `ಇನ್ನೂ ${more}` : `and ${more} more`);
  return said.join(", ");
}

/** A wording with its {placeholders} filled; unknown ones are left out, and spaces tidied. */
export function fillVoice(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "").replace(/\s+([.,])/g, "$1").replace(/\.\s*\./g, ".").replace(/\s+/g, " ").trim();
}

/** The short order number said aloud: the last part (CLK-577522-191126-133550 → 133550). */
export const spokenOrderNo = (orderNo: string) => orderNo.split("-").pop() ?? orderNo;

/** What is said for an order, with the office's wording. */
export function orderSpeech(v: VoiceSettings, o: { orderNo: string; total: number; customer: string; godown: string; lines: { product_name: string; qty: number }[] }) {
  return fillVoice(v.orderText, {
    branch: branchShort(o.godown), items: spokenItems(o.lines, v.language), amount: spokenAmount(o.total, v.language),
    order: spokenOrderNo(o.orderNo), customer: o.customer,
  });
}

/** What is said for each unusual line, with the office's wording. */
export function unusualSpeeches(v: VoiceSettings, orderNo: string, godown: string, lines: UnusualLine[]) {
  return lines.map((l) => fillVoice(v.unusualText, {
    branch: branchShort(godown), qty: String(l.qty), item: l.name,
    usual: v.language === "kn" ? (l.perDay > 0 ? `ದಿನಕ್ಕೆ ${l.perDay}` : "ಬಹುತೇಕ ಇಲ್ಲ") : l.perDay > 0 ? `${l.perDay} a day` : "almost none", order: spokenOrderNo(orderNo),
  }));
}

/** Whether an order's godown is announced (no godowns chosen = all). */
export const branchAnnounced = (v: Pick<VoiceSettings, "branches">, branchId: string | null) => v.branches.length === 0 || (!!branchId && v.branches.includes(branchId));

/** The browser voice for a language: Kannada needs a kn-IN voice; English prefers en-IN, then any English. */
export function pickVoiceFor<V extends { lang: string; name: string }>(voices: V[], language: VoiceLanguage): V | null {
  const lang = (v: V) => v.lang.replace("_", "-").toLowerCase();
  if (language === "kn") return voices.find((v) => lang(v) === "kn-in") ?? voices.find((v) => lang(v).startsWith("kn")) ?? null;
  return voices.find((v) => lang(v) === "en-in") ?? voices.find((v) => lang(v) === "en-gb") ?? voices.find((v) => lang(v).startsWith("en")) ?? null;
}

/** A sample order for "Play" in the settings. */
export const SAMPLE_ORDER = {
  orderNo: "CLK-577522-191126-133550", total: 5496.5, customer: "Sandesh", godown: "Grain Bazar Challakere Godown",
  lines: [{ product_name: "Sugar S1", qty: 2 }, { product_name: "Ekadantha Oil 850 ml", qty: 1 }],
};
export const SAMPLE_UNUSUAL: UnusualLine = { name: "Sugar S1", qty: 25, perDay: 8, limit: 24 };
