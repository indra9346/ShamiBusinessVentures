/*
 * QR codes on delivery notes and slips (client, 10 Nov 2026): "Delivery slips with unique qr so scanned which is in
 * system recognized then green signal duplicate delivery copies will be avoided". What the scan screen and the paper
 * say, in English and Kannada together (client: "in both languages"). Kept free of app imports so the node tests can
 * load it.
 *
 * The answer itself comes from the database, public.delivery_paper_scan
 * (supabase/migrations/20261110120000_delivery_paper_qr.sql). Nothing here can make a paper valid: these functions
 * only put the database's answer into words, and read a scanned QR.
 *
 * The Kannada was written for this screen and still needs a native speaker's check.
 *
 * 12 Nov 2026 (owner, 11 Nov): no separate delivery paper any more. One QR is printed on the customer's invoice; the
 * delivery note is released automatically once the payment is confirmed in full; the godown in-charge scans the
 * invoice QR, prints the released note and slips (no QR on them) and hands the goods over. The database's answer for
 * that scan is public.delivery_invoice_scan (supabase/migrations/20261112120000_invoice_delivery_qr.sql); its words
 * are invoiceScanWords below. Papers printed before then keep their QR and scanWords.
 */
import { istDateTime, paperWarnings, type DeliveryGate, type DeliveryGateCode, type DeliveryNoteSnapshot } from "./delivery-notes.ts";

/** A paper's code: 22 characters of URL-safe base64 (16 random bytes). */
export const PAPER_CODE = /^[A-Za-z0-9_-]{22}$/;

/** The scan page. The code goes after "#", so it never reaches a server log or an analytics address. */
export const SCAN_PATH = "/slip";

/** The site addresses a printed QR may carry: the live site with or without www, or the page's own address. */
const LIVE_HOSTS = ["grainbazar.com", "www.grainbazar.com"];

export const paperLink = (origin: string, code: string) => `${origin.replace(/\/+$/, "")}${SCAN_PATH}#${code}`;

export type ScannedText =
  | { code: string }
  /** A link to some other website: possibly a forged QR leading to a page that fakes a green screen. */
  | { problem: "other_site"; host: string }
  /** Readable, but not one of our papers' QR codes. */
  | { problem: "not_a_paper" };

/**
 * What a scanned QR (or typed text) holds. Only a link to this site's scan page, or a bare code, is a paper code.
 * pageHost is the host of the page doing the scanning.
 */
export function readScannedText(text: string, pageHost: string): ScannedText {
  const value = text.trim();
  if (PAPER_CODE.test(value)) return { code: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "not_a_paper" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "not_a_paper" };
  // host and pageHost both include a port when there is one (a local preview).
  const host = url.host.toLowerCase();
  const page = pageHost.toLowerCase();
  const ours = host === page || (LIVE_HOSTS.includes(host) && LIVE_HOSTS.includes(page));
  if (!ours) return { problem: "other_site", host };
  const code = url.hash.replace(/^#/, "");
  if (url.pathname.replace(/\/+$/, "").toLowerCase() !== SCAN_PATH || !PAPER_CODE.test(code)) return { problem: "not_a_paper" };
  return { code };
}

/** The code in the scan page's own address (#code), or "" when there is none. */
export const codeFromHash = (hash: string) => {
  const code = hash.replace(/^#/, "").trim();
  return PAPER_CODE.test(code) ? code : "";
};

/** One thing said in both languages. */
export type Bi = { en: string; kn: string };
const bi = (en: string, kn: string): Bi => ({ en, kn });

export type PaperScanResult =
  | "unknown" | "ready" | "handed_over" | "already_handed_over" | "partly_handed_over" | "duplicate" | "replaced" | "order_problem" | "other_godown";

/** incharge: a godown employee the admin marked as the godown in-charge (12 Nov 2026). */
export type ScannerRole = "admin" | "incharge" | "staff" | "partner";
export type PaperKind = "original" | "duplicate" | "replacement";

export type PaperHandover = { at: string; by: string; role: ScannerRole; godown: string; registered_phone?: boolean; round?: number };

export type PaperScanLine = { line: number; name: string; qty: number; pack_size: string; stock_no: string; handover: PaperHandover | null };

/** What the database answered for one scan. Only result and who scanned are there for an unknown code. */
export type PaperScan = {
  result: PaperScanResult;
  action: "check" | "handover";
  scan_id: number;
  scanned_at: string;
  by: string;
  role: ScannerRole;
  /** The scanner's godown; empty for an administrator. */
  godown: string;
  /** Whether the scan was made on the godown's registered phone. */
  device?: { registered: boolean; label: string };
  paper?: {
    doc: "note" | "slip"; slip_line: number | null; slips: number; copy_no: number;
    kind: PaperKind; duplicate_no: number | null; printed_at: string; printed_by: string;
    /** The paper that may hand goods over now: the original, or the replacement original. */
    original_kind: PaperKind | null; original_printed_at: string | null; original_printed_by: string | null;
    /** For an original an administrator replaced: when, by whom and why. */
    replaced_at: string | null; replaced_by: string | null; replaced_reason: string | null;
  };
  note?: { note_no: string; order_no: string; invoice_number: string; customer: string; godown: string; shipping_method: string; generated_at: string };
  lines?: PaperScanLine[];
  /** The items ticked on a note, and the items this scan handed over. */
  asked?: number[];
  handed_now?: number[];
  /** This handover was the last item, so the order was marked Delivered. */
  order_delivered?: boolean;
  order_status_before?: string | null;
  gate?: {
    code: DeliveryGateCode; source: "zoho_now" | "last_reading"; stop_reason: string | null;
    items_changed: boolean; invoice_changed: boolean; invoice_number: string; zoho_void: boolean;
  };
};

/**
 * green: recorded now, hand over. ready: genuine and not handed over, but nothing is recorded yet, so not green.
 * amber: don't hand over here, check with the office. red: don't hand over.
 */
export type ScanTone = "green" | "ready" | "amber" | "red";
export type ScanWords = { tone: ScanTone; headline: Bi; lines: Bi[] };

export const ROLE_WORDS: Record<ScannerRole, Bi> = {
  admin: bi("office", "ಕಚೇರಿ"),
  incharge: bi("godown in-charge", "ಗೋದಾಮು ಉಸ್ತುವಾರಿ"),
  staff: bi("staff", "ಸಿಬ್ಬಂದಿ"),
  partner: bi("channel partner", "ಚಾನೆಲ್ ಪಾಲುದಾರ"),
};
export const roleWords = (role: string): Bi => ROLE_WORDS[role as ScannerRole] ?? bi(role, role);

/** Who is signed in, as the top of the scan screen and the staff app say it. */
export const ROLE_TITLES: Record<ScannerRole, Bi> = {
  admin: bi("Admin", "ನಿರ್ವಾಹಕರು"),
  incharge: bi("Godown in-charge", "ಗೋದಾಮು ಉಸ್ತುವಾರಿ"),
  staff: bi("Godown staff", "ಗೋದಾಮು ಸಿಬ್ಬಂದಿ"),
  partner: bi("Channel partner", "ಚಾನೆಲ್ ಪಾಲುದಾರ"),
};
export const roleTitle = (role: string): Bi => ROLE_TITLES[role as ScannerRole] ?? bi(role, role);
export const phoneWords = (registered: boolean): Bi =>
  (registered ? bi("godown's registered phone", "ಗೋದಾಮಿನ ನೋಂದಾಯಿತ ಫೋನ್") : bi("own phone", "ಸ್ವಂತ ಫೋನ್"));

/** "Ravi (staff, Challakere Godown, own phone)" */
export function personWords(by: string, role: string, godown: string, registered?: boolean): Bi {
  const part = (lang: keyof Bi) =>
    [roleWords(role)[lang], godown, registered === undefined ? "" : phoneWords(registered)[lang]].filter(Boolean).join(", ");
  return bi(`${by} (${part("en")})`, `${by} (${part("kn")})`);
}

/** "Slip 2 of 3" or "Delivery note". */
export function paperName(paper: PaperScan["paper"]): Bi {
  if (!paper) return bi("Paper", "ಪತ್ರ");
  return paper.doc === "note" ? bi("Delivery note", "ಡೆಲಿವರಿ ನೋಟ್") : bi(`Slip ${paper.slip_line} of ${paper.slips}`, `ಸ್ಲಿಪ್ ${paper.slip_line} / ${paper.slips}`);
}

/** "Original" / "Duplicate copy 2" / "Replacement original". */
export function paperKindWords(kind: string | null | undefined, duplicateNo?: number | null): Bi {
  if (kind === "duplicate") return bi(`Duplicate copy ${duplicateNo ?? ""}`.trim(), `ನಕಲು ಪ್ರತಿ ${duplicateNo ?? ""}`.trim());
  if (kind === "replacement") return bi("Replacement original", "ಬದಲಿ ಮೂಲ ಪ್ರತಿ");
  return bi("Original", "ಮೂಲ ಪ್ರತಿ");
}

const handoverWho = (handover: PaperHandover) => personWords(handover.by, handover.role, handover.godown, handover.registered_phone);

/** "Handed over 10 Nov 2026, 10:32:15 AM IST by Ravi (staff, …)" for each line already handed over. */
export function handoverLines(lines: PaperScanLine[] | undefined, many: boolean): Bi[] {
  return (lines ?? []).filter((line) => line.handover).map((line) => {
    const when = istDateTime(line.handover!.at);
    const who = handoverWho(line.handover!);
    return many
      ? bi(`Item ${line.line} (${line.name}): handed over ${when} by ${who.en}.`, `ಸರಕು ${line.line} (${line.name}): ${when} ರಂದು ${who.kn} ಅವರಿಂದ ಹಸ್ತಾಂತರಿಸಲಾಗಿದೆ.`)
      : bi(`Handed over ${when} by ${who.en}.`, `${when} ರಂದು ${who.kn} ಅವರಿಂದ ಹಸ್ತಾಂತರಿಸಲಾಗಿದೆ.`);
  });
}

// What stops a delivery outright, not just a record to check.
const RED_GATES: DeliveryGateCode[] = ["cancelled", "refunded", "payment_expired", "stopped", "return_refunded", "unpaid", "partly_paid"];

/** The paper's warnings (paperWarnings) with their Kannada. */
function gateWarnings(gate: NonNullable<PaperScan["gate"]>): Bi[] {
  const asGate: DeliveryGate = {
    allowed: false, code: gate.code ?? "not_found", items_changed: Boolean(gate.items_changed), invoice_changed: Boolean(gate.invoice_changed), invoice_number: gate.invoice_number ?? "",
  };
  const kn: Partial<Record<DeliveryGateCode, string>> = {
    cancelled: "ಆರ್ಡರ್ ರದ್ದಾಗಿದೆ. ತಲುಪಿಸಬೇಡಿ.",
    refunded: "ಹಣ ಹಿಂತಿರುಗಿಸಲಾಗಿದೆ. ತಲುಪಿಸಬೇಡಿ.",
    payment_expired: "ಆರ್ಡರ್ ಪೂರ್ಣಗೊಂಡಿಲ್ಲ. ತಲುಪಿಸಬೇಡಿ.",
    stopped: "ಕಚೇರಿ ಡೆಲಿವರಿ ನಿಲ್ಲಿಸಿದೆ. ತಲುಪಿಸಬೇಡಿ.",
    return_refunded: "ಈ ಆರ್ಡರ್‌ಗೆ ಮರುಪಾವತಿ ಆರಂಭವಾಗಿದೆ ಅಥವಾ ಆಗಿದೆ. ತಲುಪಿಸುವ ಮೊದಲು ಕಚೇರಿಯನ್ನು ಕೇಳಿ.",
    unpaid: "ಪೂರ್ಣ ಪಾವತಿಯಾಗಿಲ್ಲ. ತಲುಪಿಸಬೇಡಿ.",
    partly_paid: "ಪೂರ್ಣ ಪಾವತಿಯಾಗಿಲ್ಲ. ತಲುಪಿಸಬೇಡಿ.",
    zoho_unreadable: "ಪಾವತಿಯನ್ನು ಮತ್ತೆ ಪರಿಶೀಲಿಸಲು ಆಗಲಿಲ್ಲ. ತಲುಪಿಸುವ ಮೊದಲು ಕಚೇರಿಯನ್ನು ಕೇಳಿ.",
  };
  const out: Bi[] = [];
  if (gate.zoho_void) out.push(bi("ORDER IS VOID IN ZOHO BOOKS. DO NOT DELIVER.", "Zoho Books ನಲ್ಲಿ ಆರ್ಡರ್ ರದ್ದಾಗಿದೆ (void). ತಲುಪಿಸಬೇಡಿ."));
  for (const warning of paperWarnings(asGate)) {
    if (warning.startsWith("ORDER ITEMS CHANGED")) out.push(bi(warning, "ನೋಟ್ ಮಾಡಿದ ನಂತರ ಆರ್ಡರ್‌ನ ಸರಕುಗಳು ಬದಲಾಗಿವೆ. ತಲುಪಿಸುವ ಮೊದಲು ಕಚೇರಿಯನ್ನು ಕೇಳಿ."));
    else if (warning.startsWith("ZOHO INVOICE CHANGED")) out.push(bi(warning, "ನೋಟ್ ಮಾಡಿದ ನಂತರ Zoho ಇನ್‌ವಾಯ್ಸ್ ಬದಲಾಗಿದೆ. ತಲುಪಿಸುವ ಮೊದಲು ಕಚೇರಿಯನ್ನು ಕೇಳಿ."));
    // A clean payment with only items or the invoice changed: no payment line.
    else if (gate.code !== "paid") out.push(bi(warning, kn[gate.code] ?? "ಪಾವತಿ ದಾಖಲೆಗಳನ್ನು ಪರಿಶೀಲಿಸಬೇಕಿದೆ. ತಲುಪಿಸುವ ಮೊದಲು ಕಚೇರಿಯನ್ನು ಕೇಳಿ."));
  }
  if (gate.code === "stopped" && gate.stop_reason) out.push(bi(`Reason given: ${gate.stop_reason}`, `ಕಾರಣ: ${gate.stop_reason}`));
  return out;
}

const KEEP_AND_TELL = bi("Do not hand over. Keep the paper and tell the office.", "ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಪತ್ರವನ್ನು ಇಟ್ಟುಕೊಂಡು ಕಚೇರಿಗೆ ತಿಳಿಸಿ.");

/** The database's answer as the scan screen says it. */
export function scanWords(scan: PaperScan): ScanWords {
  const paper = scan.paper;
  const name = paperName(paper);
  const note = scan.note?.note_no ?? "";
  const many = paper?.doc === "note";
  const me = personWords(scan.by, scan.role, scan.godown, scan.device?.registered);
  const kind = paperKindWords(paper?.kind, paper?.duplicate_no);
  switch (scan.result) {
    case "handed_over": {
      const now = scan.handed_now ?? [];
      const earlier = (scan.lines ?? []).filter((line) => line.handover && !now.includes(line.line));
      const toGo = (scan.lines ?? []).filter((line) => !line.handover);
      const when = istDateTime(scan.scanned_at);
      return {
        tone: "green",
        headline: bi("Hand over the goods", "ಸರಕು ಹಸ್ತಾಂತರಿಸಿ"),
        lines: [
          many
            ? bi(`Give only item${now.length === 1 ? "" : "s"} ${now.join(", ")} now. Recorded ${when} by ${me.en}.`, `ಈಗ ಸರಕು ${now.join(", ")} ಮಾತ್ರ ಕೊಡಿ. ${when} ರಂದು ${me.kn} ಅವರಿಂದ ದಾಖಲಾಗಿದೆ.`)
            : bi(`Genuine ${kind.en.toLowerCase()}. Handover recorded ${when} by ${me.en}.`, `ಅಸಲಿ ${kind.kn}. ${when} ರಂದು ${me.kn} ಅವರಿಂದ ಹಸ್ತಾಂತರ ದಾಖಲಾಗಿದೆ.`),
          ...handoverLines(earlier, true).map((line) => bi(`Before this: ${line.en}`, `ಇದಕ್ಕೂ ಮೊದಲು: ${line.kn}`)),
          ...(many && toGo.length
            ? [bi(`Still to go: item${toGo.length === 1 ? "" : "s"} ${toGo.map((line) => line.line).join(", ")}.`, `ಇನ್ನೂ ಕೊಡಬೇಕಾದವು: ಸರಕು ${toGo.map((line) => line.line).join(", ")}.`)] : []),
          bi("These items can't be handed over again on this paper. A copy of it will show red.", "ಈ ಪತ್ರದಿಂದ ಈ ಸರಕುಗಳನ್ನು ಮತ್ತೆ ಹಸ್ತಾಂತರಿಸಲಾಗದು. ಇದರ ನಕಲು ಕೆಂಪು ತೋರಿಸುತ್ತದೆ."),
          ...(scan.order_delivered ? [bi(`Everything on ${note} is handed over: the order is now marked Delivered.`, `${note} ರ ಎಲ್ಲಾ ಸರಕು ಹಸ್ತಾಂತರವಾಗಿದೆ: ಆರ್ಡರ್ ಈಗ 'ತಲುಪಿಸಲಾಗಿದೆ' ಎಂದು ಗುರುತಾಗಿದೆ.`)] : []),
          ...(scan.gate?.source === "last_reading"
            ? [bi("Zoho Books could not be read just now, so the payment was checked on the website's last reading.", "ಈಗ Zoho Books ಓದಲು ಆಗಲಿಲ್ಲ, ಹಾಗಾಗಿ ವೆಬ್‌ಸೈಟ್‌ನ ಕೊನೆಯ ಮಾಹಿತಿಯಿಂದ ಪಾವತಿ ಪರಿಶೀಲಿಸಲಾಗಿದೆ.")] : []),
        ],
      };
    }
    case "ready":
      return {
        tone: "ready",
        headline: bi("Genuine · not handed over yet", "ಅಸಲಿ · ಇನ್ನೂ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ"),
        lines: [
          bi(`${name.en} of ${note}: the ${kind.en.toLowerCase()}. Paid in full.`, `${note} ರ ${name.kn}: ${kind.kn}. ಪೂರ್ಣ ಪಾವತಿಯಾಗಿದೆ.`),
          ...handoverLines(scan.lines, many),
          many
            ? bi("Tick the items being handed over, then press the button. Give the goods only when the screen turns green.", "ಹಸ್ತಾಂತರಿಸುವ ಸರಕುಗಳನ್ನು ಗುರುತಿಸಿ, ನಂತರ ಬಟನ್ ಒತ್ತಿ. ಪರದೆ ಹಸಿರಾದಾಗ ಮಾತ್ರ ಸರಕು ಕೊಡಿ.")
            : bi("Press the button to record the handover. Give the goods only when the screen turns green.", "ಹಸ್ತಾಂತರ ದಾಖಲಿಸಲು ಬಟನ್ ಒತ್ತಿ. ಪರದೆ ಹಸಿರಾದಾಗ ಮಾತ್ರ ಸರಕು ಕೊಡಿ."),
        ],
      };
    case "already_handed_over":
      return {
        tone: "red",
        headline: bi("Already handed over · do not give again", "ಈಗಾಗಲೇ ಹಸ್ತಾಂತರಿಸಲಾಗಿದೆ · ಮತ್ತೆ ಕೊಡಬೇಡಿ"),
        lines: [
          ...handoverLines(scan.lines, many),
          ...(scan.lines?.some((line) => line.handover?.by === scan.by)
            ? [bi("You recorded this handover yourself. If you gave the goods then, there is nothing more to do: do not give them again.", "ಈ ಹಸ್ತಾಂತರವನ್ನು ನೀವೇ ದಾಖಲಿಸಿದ್ದೀರಿ. ಆಗ ಸರಕು ಕೊಟ್ಟಿದ್ದರೆ ಇನ್ನೇನೂ ಮಾಡಬೇಕಿಲ್ಲ: ಮತ್ತೆ ಕೊಡಬೇಡಿ.")] : []),
          ...(paper?.kind === "duplicate" ? [bi(`This paper is also only ${kind.en.toLowerCase()}.`, `ಈ ಪತ್ರ ${kind.kn} ಕೂಡ.`)] : []),
          bi("If goods are asked for again on this paper, it is a duplicate. Keep the paper and tell the office.", "ಈ ಪತ್ರದ ಮೇಲೆ ಮತ್ತೆ ಸರಕು ಕೇಳಿದರೆ ಅದು ನಕಲು. ಪತ್ರವನ್ನು ಇಟ್ಟುಕೊಂಡು ಕಚೇರಿಗೆ ತಿಳಿಸಿ."),
        ],
      };
    case "partly_handed_over": {
      const gone = (scan.lines ?? []).filter((line) => line.handover && (scan.asked ?? []).includes(line.line));
      return {
        tone: "amber",
        headline: bi("Ticked items already went · nothing recorded", "ಗುರುತಿಸಿದ ಸರಕು ಈಗಾಗಲೇ ಹೋಗಿದೆ · ಏನೂ ದಾಖಲಾಗಿಲ್ಲ"),
        lines: [
          ...handoverLines(gone, true),
          bi("Nothing was recorded. Do not hand those over. Check the list below and tick again.", "ಏನೂ ದಾಖಲಾಗಿಲ್ಲ. ಅವುಗಳನ್ನು ಕೊಡಬೇಡಿ. ಕೆಳಗಿನ ಪಟ್ಟಿ ನೋಡಿ ಮತ್ತೆ ಗುರುತಿಸಿ."),
        ],
      };
    }
    case "duplicate": {
      const printed = paper?.printed_at ? istDateTime(paper.printed_at) : "";
      return {
        tone: "red",
        headline: bi(`${kind.en} · do not hand over`, `${kind.kn} · ಹಸ್ತಾಂತರಿಸಬೇಡಿ`),
        lines: [
          bi(`This is ${kind.en.toLowerCase()} of ${name.en.toLowerCase()} on ${note}, printed ${printed} by ${paper?.printed_by || "the office"}. Only the original hands goods over.`,
            `ಇದು ${note} ರ ${name.kn} ನ ${kind.kn}, ${printed} ರಂದು ${paper?.printed_by || "ಕಚೇರಿ"} ಮುದ್ರಿಸಿದ್ದು. ಮೂಲ ಪ್ರತಿಯಿಂದ ಮಾತ್ರ ಸರಕು ಹಸ್ತಾಂತರಿಸಬಹುದು.`),
          bi("Ask for the original. If it is lost, the office can print a replacement original.", "ಮೂಲ ಪ್ರತಿ ಕೇಳಿ. ಅದು ಕಳೆದುಹೋಗಿದ್ದರೆ ಕಚೇರಿ ಬದಲಿ ಮೂಲ ಪ್ರತಿ ಮುದ್ರಿಸಬಹುದು."),
        ],
      };
    }
    case "replaced": {
      const when = paper?.replaced_at ? istDateTime(paper.replaced_at) : "";
      const by = paper?.replaced_by || "the office";
      return {
        tone: "red",
        headline: bi("Original replaced · cancelled", "ಮೂಲ ಪ್ರತಿ ಬದಲಾಗಿದೆ · ರದ್ದು"),
        lines: [
          bi(`This ${name.en.toLowerCase()} was replaced ${when} by ${by}${paper?.replaced_reason ? `: ${paper.replaced_reason}` : ""}. Its QR no longer works.`,
            `ಈ ${name.kn} ಅನ್ನು ${when} ರಂದು ${by} ಬದಲಿಸಿದ್ದಾರೆ${paper?.replaced_reason ? `: ${paper.replaced_reason}` : ""}. ಇದರ QR ಈಗ ಕೆಲಸ ಮಾಡುವುದಿಲ್ಲ.`),
          bi("Do not hand over against this paper. Ask for the replacement original.", "ಈ ಪತ್ರದ ಮೇಲೆ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಬದಲಿ ಮೂಲ ಪ್ರತಿ ಕೇಳಿ."),
        ],
      };
    }
    case "order_problem": {
      const gate = scan.gate;
      const red = Boolean(gate?.zoho_void) || RED_GATES.includes(gate?.code as DeliveryGateCode);
      return {
        tone: red ? "red" : "amber",
        headline: bi("Do not hand over", "ಹಸ್ತಾಂತರಿಸಬೇಡಿ"),
        lines: [...(gate ? gateWarnings(gate) : []), bi("Tell the office. Keep the paper.", "ಕಚೇರಿಗೆ ತಿಳಿಸಿ. ಪತ್ರವನ್ನು ಇಟ್ಟುಕೊಳ್ಳಿ.")],
      };
    }
    case "other_godown":
      return {
        tone: "amber",
        headline: bi("Another godown's paper", "ಬೇರೆ ಗೋದಾಮಿನ ಪತ್ರ"),
        lines: [
          bi(`This ${name.en.toLowerCase()} is for ${scan.note?.godown || "another godown"}. You are signed in at ${scan.godown || "a different godown"}.`,
            `ಈ ${name.kn} ${scan.note?.godown || "ಬೇರೆ ಗೋದಾಮು"} ಗೆ ಸೇರಿದ್ದು. ನೀವು ${scan.godown || "ಬೇರೆ ಗೋದಾಮು"} ನಲ್ಲಿ ಸೈನ್ ಇನ್ ಆಗಿದ್ದೀರಿ.`),
          bi("Do not hand over these goods here. Ask the office.", "ಈ ಸರಕುಗಳನ್ನು ಇಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ."),
        ],
      };
    case "unknown":
    default:
      return {
        tone: "red",
        headline: bi("Not a genuine paper", "ಅಸಲಿ ಪತ್ರವಲ್ಲ"),
        lines: [
          bi("This QR code is not in Grain Bazar's system. The paper may be forged, damaged or from somewhere else.", "ಈ QR ಕೋಡ್ Grain Bazar ವ್ಯವಸ್ಥೆಯಲ್ಲಿ ಇಲ್ಲ. ಪತ್ರ ನಕಲಿ, ಹಾಳಾದದ್ದು ಅಥವಾ ಬೇರೆಡೆಯದು ಇರಬಹುದು."),
          KEEP_AND_TELL,
        ],
      };
  }
}

/** What the scan page says about a QR it read itself, before asking the database. */
export function scannedTextWords(problem: Exclude<ScannedText, { code: string }>): ScanWords {
  return problem.problem === "other_site"
    ? {
      tone: "red",
      headline: bi("Not a Grain Bazar QR", "ಇದು Grain Bazar QR ಅಲ್ಲ"),
      lines: [
        bi(`This QR leads to another website (${problem.host}), not to Grain Bazar. A forged paper can lead to a page that fakes a green screen.`,
          `ಈ QR ಬೇರೆ ವೆಬ್‌ಸೈಟ್‌ಗೆ (${problem.host}) ಹೋಗುತ್ತದೆ, Grain Bazar ಗೆ ಅಲ್ಲ. ನಕಲಿ ಪತ್ರ ನಕಲಿ ಹಸಿರು ಪರದೆ ತೋರಿಸುವ ಪುಟಕ್ಕೆ ಕರೆದೊಯ್ಯಬಹುದು.`),
        KEEP_AND_TELL,
      ],
    }
    : {
      tone: "red",
      headline: bi("Not a delivery paper QR", "ಇದು ಡೆಲಿವರಿ ಪತ್ರದ QR ಅಲ್ಲ"),
      lines: [
        bi("This is not the QR code of a Grain Bazar delivery note or slip.", "ಇದು Grain Bazar ಡೆಲಿವರಿ ನೋಟ್ ಅಥವಾ ಸ್ಲಿಪ್‌ನ QR ಕೋಡ್ ಅಲ್ಲ."),
        bi("Do not hand over against it. Ask the office.", "ಇದರ ಮೇಲೆ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ."),
      ],
    };
}

// ---------------------------------------------------------------- the QR on the invoice (12 Nov 2026)

export type InvoiceScanAction = "check" | "handover" | "print_note" | "print_slips";
export type InvoiceScanResult =
  | "replaced" | "other_godown" | "not_released" | "order_problem" | "not_allowed"
  | "already_handed_over" | "partly_handed_over" | "released" | "printed" | "handed_over";
/** How a delivery note came to be: an admin's press, automatically when the payment was confirmed, or the in-charge's scan. */
export type ReleasedHow = "admin" | "auto" | "scan";

/** A released note's papers as printed (no QR on them): the copies recorded and what the paper shows. */
export type ReleasePrint = {
  printed_at: string;
  note_copy: number | null;
  slip_copies: Record<string, number>;
  printed_by: string;
  printed_role: ScannerRole;
  note: {
    note_no: string; order_no: string; invoice_number: string; snapshot: DeliveryNoteSnapshot;
    generated_at: string; generated_by_name: string; generated_how: ReleasedHow | string;
  };
};

/** What the database answered for one scan of an invoice's QR (public.delivery_invoice_scan). */
export type InvoiceScan = {
  kind: "invoice";
  result: InvoiceScanResult;
  action: InvoiceScanAction;
  scan_id: number;
  scanned_at: string;
  by: string;
  role: ScannerRole;
  /** The scanner's godown, and the order's; the scanner's is empty for an administrator. */
  godown: string;
  order_godown: string;
  device?: { registered: boolean; label: string };
  /** What this person may do now (the in-charge and admins everything; staff and the partner what the admin allows). */
  can?: { print_note: boolean; print_slips: boolean; handover: boolean };
  invoice: {
    order_no: string; generation: number;
    /** Only for a QR an administrator replaced. */
    revoked_at?: string | null; revoked_by?: string | null; revoke_reason?: string | null; live_generation?: number | null;
  };
  /** This scan (the in-charge's or an admin's) released the note just now. */
  released_now?: boolean;
  note?: {
    note_no: string; order_no: string; invoice_number: string; customer: string;
    /** The last four digits of the customer's phone, to check who collects. */
    phone_end: string;
    godown: string; shipping_method: string; generated_at: string; generated_how: ReleasedHow | string; generated_by_name: string;
  } | null;
  lines?: PaperScanLine[];
  asked?: number[];
  handed_now?: number[];
  order_delivered?: boolean;
  order_status_before?: string | null;
  print?: ReleasePrint | null;
  gate?: PaperScan["gate"];
};

/** The answer for a QR on an invoice, as against a printed delivery paper's. */
export const isInvoiceScan = (scan: unknown): scan is InvoiceScan =>
  typeof scan === "object" && scan !== null && (scan as { kind?: unknown }).kind === "invoice";

/** A customer who opens their own invoice's QR: where to take it. */
export const CUSTOMER_SCAN_WORDS = bi("Show this QR at the godown counter; the godown in-charge scans it.", "ಈ QR ಅನ್ನು ಗೋದಾಮಿನ ಕೌಂಟರ್‌ನಲ್ಲಿ ತೋರಿಸಿ; ಗೋದಾಮು ಉಸ್ತುವಾರಿ ಅದನ್ನು ಸ್ಕ್ಯಾನ್ ಮಾಡುತ್ತಾರೆ.");

/** "Released automatically when the payment was confirmed, 11 Nov 2026, 10:32:15 AM IST." */
export function releasedWords(note: { generated_at: string; generated_how?: string | null; generated_by_name?: string | null }): Bi {
  const when = istDateTime(note.generated_at);
  const who = note.generated_by_name || "the office";
  if (note.generated_how === "auto") {
    return bi(`Released automatically when the payment was confirmed, ${when}.`, `ಪಾವತಿ ದೃಢಪಟ್ಟಾಗ ಸ್ವಯಂಚಾಲಿತವಾಗಿ ಬಿಡುಗಡೆಯಾಗಿದೆ, ${when}.`);
  }
  if (note.generated_how === "scan") {
    return bi(`Released ${when} by ${who}'s scan of the invoice QR.`, `${when} ರಂದು ${who} ಇನ್‌ವಾಯ್ಸ್ QR ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ಬಿಡುಗಡೆ ಮಾಡಿದ್ದಾರೆ.`);
  }
  return bi(`Released ${when} by ${who} (office).`, `${when} ರಂದು ${who} (ಕಚೇರಿ) ಬಿಡುಗಡೆ ಮಾಡಿದ್ದಾರೆ.`);
}

/** The short form for a list: "Automatically (payment confirmed)". */
export function releasedHowLabel(how: string | null | undefined, by?: string | null): Bi {
  if (how === "auto") return bi("Automatically (payment confirmed)", "ಸ್ವಯಂಚಾಲಿತವಾಗಿ (ಪಾವತಿ ದೃಢಪಟ್ಟಾಗ)");
  if (how === "scan") return bi(`By ${by || "the godown in-charge"}'s scan`, `${by || "ಗೋದಾಮು ಉಸ್ತುವಾರಿ"} ಸ್ಕ್ಯಾನ್ ಮೂಲಕ`);
  return bi(`By ${by || "the office"}`, `${by || "ಕಚೇರಿ"} ಅವರಿಂದ`);
}

/** The paper's "Released" line: "11 Nov 2026, 10:32:15 AM IST, automatically when the payment was confirmed". */
export function releasedFact(note: { generated_at: string; generated_how?: string | null; generated_by_name?: string | null }) {
  const when = istDateTime(note.generated_at);
  if (note.generated_how === "auto") return `${when}, automatically when the payment was confirmed`;
  if (note.generated_how === "scan") return `${when} by ${note.generated_by_name || "the godown in-charge"} (scan of the invoice QR)`;
  return `${when} by ${note.generated_by_name || "the office"}`;
}

/**
 * The papers' warnings: the payment check's, and the items already handed over (the note names them; each such slip
 * says it went). The same for the office's print, the godown's print and the PDF.
 */
export function releasedPaperWarnings(warnings: string[], lines: number[], handovers: Record<string, PaperHandover | null | undefined>) {
  const handed = lines.filter((line) => handovers[String(line)]);
  const noteWarnings = handed.length === 0 ? warnings : [...warnings, handed.length === lines.length
    ? "ALL ITEMS ALREADY HANDED OVER. FOR RECORDS ONLY. DO NOT DELIVER AGAIN."
    : `ITEM${handed.length === 1 ? "" : "S"} ${handed.join(", ")} ALREADY HANDED OVER. DELIVER ONLY THE REST.`];
  const slipWarnings: Record<string, string[]> = Object.fromEntries(lines.map((line) => [String(line),
    handovers[String(line)] ? [...warnings, handedOverWarning(handovers[String(line)])] : warnings]));
  return { noteWarnings, slipWarnings };
}

const plural = (count: number) => (count === 1 ? "" : "s");

/** "Handing over goods" / "Printing the delivery note" / "Printing slips", for a refusal. */
function actionWords(action: InvoiceScanAction): Bi {
  if (action === "print_note") return bi("Printing the delivery note", "ಡೆಲಿವರಿ ನೋಟ್ ಮುದ್ರಿಸುವುದು");
  if (action === "print_slips") return bi("Printing delivery slips", "ಡೆಲಿವರಿ ಸ್ಲಿಪ್ ಮುದ್ರಿಸುವುದು");
  if (action === "handover") return bi("Handing over goods", "ಸರಕು ಹಸ್ತಾಂತರಿಸುವುದು");
  return bi("Checking", "ಪರಿಶೀಲನೆ");
}

/** What a print from the scan recorded: the note's copy number and each slip's. */
function printedLines(scan: InvoiceScan, me: Bi): Bi[] {
  const print = scan.print;
  if (!print) return [];
  const when = istDateTime(print.printed_at);
  const out: Bi[] = [];
  const note = print.note.note_no;
  if (print.note_copy) {
    out.push(bi(`Delivery note ${note}: copy ${print.note_copy}, recorded ${when} by ${me.en}.`,
      `ಡೆಲಿವರಿ ನೋಟ್ ${note}: ಪ್ರತಿ ${print.note_copy}, ${when} ರಂದು ${me.kn} ಅವರಿಂದ ದಾಖಲಾಗಿದೆ.`));
  }
  const slips = Object.entries(print.slip_copies ?? {}).map(([line, copy]) => ({ line: Number(line), copy })).sort((a, b) => a.line - b.line);
  if (slips.length) {
    out.push(bi(`Slip${plural(slips.length)} ${slips.map((slip) => `${slip.line} (copy ${slip.copy})`).join(", ")}: recorded ${when} by ${me.en}.`,
      `ಸ್ಲಿಪ್ ${slips.map((slip) => `${slip.line} (ಪ್ರತಿ ${slip.copy})`).join(", ")}: ${when} ರಂದು ${me.kn} ಅವರಿಂದ ದಾಖಲಾಗಿದೆ.`));
  }
  return out;
}

const NOT_HERE = bi("Do not hand over these goods here. Ask the office.", "ಈ ಸರಕುಗಳನ್ನು ಇಲ್ಲಿ ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ.");
const ONLY_GREEN = bi("Tick the items being handed over, then press the button. Give the goods only when the screen turns green.",
  "ಹಸ್ತಾಂತರಿಸುವ ಸರಕುಗಳನ್ನು ಗುರುತಿಸಿ, ನಂತರ ಬಟನ್ ಒತ್ತಿ. ಪರದೆ ಹಸಿರಾದಾಗ ಮಾತ್ರ ಸರಕು ಕೊಡಿ.");
const LAST_READING = bi("Zoho Books could not be read just now, so the payment was checked on the website's last reading.",
  "ಈಗ Zoho Books ಓದಲು ಆಗಲಿಲ್ಲ, ಹಾಗಾಗಿ ವೆಬ್‌ಸೈಟ್‌ನ ಕೊನೆಯ ಮಾಹಿತಿಯಿಂದ ಪಾವತಿ ಪರಿಶೀಲಿಸಲಾಗಿದೆ.");

/**
 * The database's answer for a scan of an invoice's QR, as the scan screen says it. Only a recorded handover is green;
 * released and printed are blue ("ready"): nothing goes until the screen turns green.
 */
export function invoiceScanWords(scan: InvoiceScan): ScanWords {
  const note = scan.note?.note_no ?? scan.print?.note.note_no ?? "";
  const order = scan.invoice?.order_no || scan.note?.order_no || "";
  const me = personWords(scan.by, scan.role, scan.godown, scan.device?.registered);
  const toGo = (scan.lines ?? []).filter((line) => !line.handover).map((line) => line.line);
  const stillToGo = toGo.length
    ? [bi(`Still to go: item${plural(toGo.length)} ${toGo.join(", ")}.`, `ಇನ್ನೂ ಕೊಡಬೇಕಾದವು: ಸರಕು ${toGo.join(", ")}.`)] : [];
  const mayHandOver = Boolean(scan.can?.handover);
  const handoverHint = toGo.length === 0 ? [] : mayHandOver ? [ONLY_GREEN]
    : [bi("Handing over is not switched on for you. The godown in-charge hands these goods over.", "ನಿಮಗೆ ಹಸ್ತಾಂತರಿಸಲು ಅನುಮತಿ ಇಲ್ಲ. ಗೋದಾಮು ಉಸ್ತುವಾರಿ ಈ ಸರಕುಗಳನ್ನು ಹಸ್ತಾಂತರಿಸುತ್ತಾರೆ.")];
  switch (scan.result) {
    case "handed_over": {
      const now = scan.handed_now ?? [];
      const earlier = (scan.lines ?? []).filter((line) => line.handover && !now.includes(line.line));
      const when = istDateTime(scan.scanned_at);
      return {
        tone: "green",
        headline: bi("Hand over the goods", "ಸರಕು ಹಸ್ತಾಂತರಿಸಿ"),
        lines: [
          bi(`Give only item${plural(now.length)} ${now.join(", ")} now. Recorded ${when} by ${me.en}.`, `ಈಗ ಸರಕು ${now.join(", ")} ಮಾತ್ರ ಕೊಡಿ. ${when} ರಂದು ${me.kn} ಅವರಿಂದ ದಾಖಲಾಗಿದೆ.`),
          ...handoverLines(earlier, true).map((line) => bi(`Before this: ${line.en}`, `ಇದಕ್ಕೂ ಮೊದಲು: ${line.kn}`)),
          ...stillToGo,
          bi("These items can't be handed over again on this invoice.", "ಈ ಇನ್‌ವಾಯ್ಸ್‌ನಿಂದ ಈ ಸರಕುಗಳನ್ನು ಮತ್ತೆ ಹಸ್ತಾಂತರಿಸಲಾಗದು."),
          ...(scan.order_delivered ? [bi(`Everything on ${note} is handed over: the order is now marked Delivered.`, `${note} ರ ಎಲ್ಲಾ ಸರಕು ಹಸ್ತಾಂತರವಾಗಿದೆ: ಆರ್ಡರ್ ಈಗ 'ತಲುಪಿಸಲಾಗಿದೆ' ಎಂದು ಗುರುತಾಗಿದೆ.`)] : []),
          ...(scan.gate?.source === "last_reading" ? [LAST_READING] : []),
        ],
      };
    }
    case "released":
      return {
        tone: "ready",
        headline: bi("Delivery note released · not handed over yet", "ಡೆಲಿವರಿ ನೋಟ್ ಬಿಡುಗಡೆಯಾಗಿದೆ · ಇನ್ನೂ ಹಸ್ತಾಂತರಿಸಿಲ್ಲ"),
        lines: [
          bi(`Delivery note ${note} for order ${order}. Paid in full.`, `ಆರ್ಡರ್ ${order} ರ ಡೆಲಿವರಿ ನೋಟ್ ${note}. ಪೂರ್ಣ ಪಾವತಿಯಾಗಿದೆ.`),
          scan.released_now
            ? bi("Released just now by your scan: Zoho Books shows the invoice paid in full.", "ನಿಮ್ಮ ಸ್ಕ್ಯಾನ್‌ನಿಂದ ಈಗಷ್ಟೇ ಬಿಡುಗಡೆಯಾಗಿದೆ: Zoho Books ಪ್ರಕಾರ ಇನ್‌ವಾಯ್ಸ್ ಪೂರ್ಣ ಪಾವತಿಯಾಗಿದೆ.")
            : scan.note ? releasedWords(scan.note) : bi("Released.", "ಬಿಡುಗಡೆಯಾಗಿದೆ."),
          ...handoverLines(scan.lines, true),
          ...handoverHint,
        ],
      };
    case "printed":
      return {
        tone: "ready",
        headline: bi("Printed · copies recorded", "ಮುದ್ರಿಸಲಾಗಿದೆ · ಪ್ರತಿಗಳು ದಾಖಲಾಗಿವೆ"),
        lines: [
          ...printedLines(scan, me),
          bi("Printing does not hand anything over. Give goods only after the screen turns green.", "ಮುದ್ರಣದಿಂದ ಹಸ್ತಾಂತರ ಆಗುವುದಿಲ್ಲ. ಪರದೆ ಹಸಿರಾದ ನಂತರ ಮಾತ್ರ ಸರಕು ಕೊಡಿ."),
          ...handoverLines(scan.lines, true),
          ...handoverHint,
        ],
      };
    case "not_released": {
      const gate = scan.gate;
      const paidButWaiting = !gate || gate.code === "paid";
      return {
        tone: "amber",
        headline: bi("Delivery note not released yet", "ಡೆಲಿವರಿ ನೋಟ್ ಇನ್ನೂ ಬಿಡುಗಡೆಯಾಗಿಲ್ಲ"),
        lines: [
          bi(`Order ${order}: the delivery note is released only once the payment is confirmed in full and Zoho Books has the paid invoice.`,
            `ಆರ್ಡರ್ ${order}: ಪಾವತಿ ಪೂರ್ಣವಾಗಿ ದೃಢಪಟ್ಟು Zoho Books ನಲ್ಲಿ ಪಾವತಿಯಾದ ಇನ್‌ವಾಯ್ಸ್ ಇದ್ದಾಗ ಮಾತ್ರ ಡೆಲಿವರಿ ನೋಟ್ ಬಿಡುಗಡೆಯಾಗುತ್ತದೆ.`),
          ...(gate && !paidButWaiting ? gateWarnings(gate) : []),
          ...(paidButWaiting && (scan.role === "staff" || scan.role === "partner")
            ? [bi("The godown in-charge's scan or the office releases it.", "ಗೋದಾಮು ಉಸ್ತುವಾರಿ ಸ್ಕ್ಯಾನ್ ಅಥವಾ ಕಚೇರಿ ಇದನ್ನು ಬಿಡುಗಡೆ ಮಾಡುತ್ತದೆ.")] : []),
          ...(paidButWaiting && gate?.source === "last_reading" && (scan.role === "incharge" || scan.role === "admin")
            ? [bi("Zoho Books could not be read just now. Scan again in a minute.", "ಈಗ Zoho Books ಓದಲು ಆಗಲಿಲ್ಲ. ಒಂದು ನಿಮಿಷದ ನಂತರ ಮತ್ತೆ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ.")] : []),
          bi("Do not hand over. Ask the office.", "ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ."),
        ],
      };
    }
    case "order_problem": {
      const gate = scan.gate;
      const red = Boolean(gate?.zoho_void) || RED_GATES.includes(gate?.code as DeliveryGateCode);
      return {
        tone: red ? "red" : "amber",
        headline: bi("Do not hand over", "ಹಸ್ತಾಂತರಿಸಬೇಡಿ"),
        lines: [...(gate ? gateWarnings(gate) : []), bi("Tell the office. Nothing was recorded.", "ಕಚೇರಿಗೆ ತಿಳಿಸಿ. ಏನೂ ದಾಖಲಾಗಿಲ್ಲ.")],
      };
    }
    case "not_allowed": {
      const what = actionWords(scan.action);
      const role = roleWords(scan.role);
      return {
        tone: "amber",
        headline: bi("Not allowed for you · nothing recorded", "ನಿಮಗೆ ಅನುಮತಿ ಇಲ್ಲ · ಏನೂ ದಾಖಲಾಗಿಲ್ಲ"),
        lines: [
          bi(`${what.en} is switched off for the ${role.en}.`, `${role.kn} ಅವರಿಗೆ ${what.kn} ಅನುಮತಿ ಇಲ್ಲ.`),
          bi("The godown in-charge or the office can do it. The admin sets this in Delivery QR rules.", "ಗೋದಾಮು ಉಸ್ತುವಾರಿ ಅಥವಾ ಕಚೇರಿ ಇದನ್ನು ಮಾಡಬಹುದು. ನಿರ್ವಾಹಕರು ಇದನ್ನು ಡೆಲಿವರಿ QR ನಿಯಮಗಳಲ್ಲಿ ಬದಲಿಸುತ್ತಾರೆ."),
        ],
      };
    }
    case "already_handed_over":
      return {
        tone: "red",
        headline: bi("Already handed over · do not give again", "ಈಗಾಗಲೇ ಹಸ್ತಾಂತರಿಸಲಾಗಿದೆ · ಮತ್ತೆ ಕೊಡಬೇಡಿ"),
        lines: [
          ...handoverLines(scan.lines, true),
          ...(scan.lines?.some((line) => line.handover?.by === scan.by)
            ? [bi("You recorded this handover yourself. If you gave the goods then, there is nothing more to do: do not give them again.", "ಈ ಹಸ್ತಾಂತರವನ್ನು ನೀವೇ ದಾಖಲಿಸಿದ್ದೀರಿ. ಆಗ ಸರಕು ಕೊಟ್ಟಿದ್ದರೆ ಇನ್ನೇನೂ ಮಾಡಬೇಕಿಲ್ಲ: ಮತ್ತೆ ಕೊಡಬೇಡಿ.")] : []),
          bi("If goods are asked for again on this invoice, tell the office.", "ಈ ಇನ್‌ವಾಯ್ಸ್ ಮೇಲೆ ಮತ್ತೆ ಸರಕು ಕೇಳಿದರೆ ಕಚೇರಿಗೆ ತಿಳಿಸಿ."),
        ],
      };
    case "partly_handed_over": {
      const gone = (scan.lines ?? []).filter((line) => line.handover && (scan.asked ?? []).includes(line.line));
      return {
        tone: "amber",
        headline: bi("Ticked items already went · nothing recorded", "ಗುರುತಿಸಿದ ಸರಕು ಈಗಾಗಲೇ ಹೋಗಿದೆ · ಏನೂ ದಾಖಲಾಗಿಲ್ಲ"),
        lines: [
          ...handoverLines(gone, true),
          bi("Nothing was recorded. Do not hand those over. Check the list below and tick again.", "ಏನೂ ದಾಖಲಾಗಿಲ್ಲ. ಅವುಗಳನ್ನು ಕೊಡಬೇಡಿ. ಕೆಳಗಿನ ಪಟ್ಟಿ ನೋಡಿ ಮತ್ತೆ ಗುರುತಿಸಿ."),
        ],
      };
    }
    case "replaced": {
      const when = scan.invoice.revoked_at ? istDateTime(scan.invoice.revoked_at) : "";
      const by = scan.invoice.revoked_by || "the office";
      const reason = scan.invoice.revoke_reason ? `: ${scan.invoice.revoke_reason}` : "";
      return {
        tone: "red",
        headline: bi("Old invoice QR · replaced", "ಹಳೆಯ ಇನ್‌ವಾಯ್ಸ್ QR · ಬದಲಾಗಿದೆ"),
        lines: [
          bi(`This QR on the invoice of order ${order} was replaced ${when} by ${by}${reason}. It no longer works.`,
            `ಆರ್ಡರ್ ${order} ರ ಇನ್‌ವಾಯ್ಸ್‌ನ ಈ QR ಅನ್ನು ${when} ರಂದು ${by} ಬದಲಿಸಿದ್ದಾರೆ${reason}. ಇದು ಈಗ ಕೆಲಸ ಮಾಡುವುದಿಲ್ಲ.`),
          bi("Do not hand over. The customer downloads the invoice again from their orders on grainbazar.com; scan the QR on that one.",
            "ಹಸ್ತಾಂತರಿಸಬೇಡಿ. ಗ್ರಾಹಕರು grainbazar.com ನ ತಮ್ಮ ಆರ್ಡರ್‌ಗಳಿಂದ ಇನ್‌ವಾಯ್ಸ್ ಮತ್ತೆ ಡೌನ್‌ಲೋಡ್ ಮಾಡುತ್ತಾರೆ; ಅದರ QR ಸ್ಕ್ಯಾನ್ ಮಾಡಿ."),
        ],
      };
    }
    case "other_godown":
      return {
        tone: "amber",
        headline: bi("Another godown's order", "ಬೇರೆ ಗೋದಾಮಿನ ಆರ್ಡರ್"),
        lines: [
          bi(`Order ${order} is for ${scan.order_godown || "another godown"}. You are signed in at ${scan.godown || "a different godown"}.`,
            `ಆರ್ಡರ್ ${order} ${scan.order_godown || "ಬೇರೆ ಗೋದಾಮು"} ಗೆ ಸೇರಿದ್ದು. ನೀವು ${scan.godown || "ಬೇರೆ ಗೋದಾಮು"} ನಲ್ಲಿ ಸೈನ್ ಇನ್ ಆಗಿದ್ದೀರಿ.`),
          NOT_HERE,
        ],
      };
    default:
      return {
        tone: "red",
        headline: bi("Not checked · do not hand over", "ಪರಿಶೀಲನೆ ಆಗಿಲ್ಲ · ಹಸ್ತಾಂತರಿಸಬೇಡಿ"),
        lines: [bi("The system gave an answer this screen doesn't know. Ask the office.", "ಈ ಪರದೆಗೆ ತಿಳಿಯದ ಉತ್ತರ ಬಂದಿದೆ. ಕಚೇರಿಯನ್ನು ಕೇಳಿ."), KEEP_AND_TELL],
      };
  }
}

/** The printed paper's own label and, for a duplicate or replacement, the big stamp. */
export type PaperPrint = {
  kind: PaperKind;
  duplicate_no: number | null;
  original_printed_at?: string | null;
  replaces?: { kind: PaperKind; printed_at: string; printed_by: string } | null;
  reason?: string;
};

/** The big stamp on a duplicate or a replacement original; null on the first original. */
export function paperStamp(paper: Pick<PaperPrint, "kind" | "duplicate_no" | "replaces" | "reason"> | null | undefined): { title: Bi; detail: Bi } | null {
  if (!paper || paper.kind === "original") return null;
  if (paper.kind === "duplicate") {
    return {
      title: bi(`DUPLICATE COPY ${paper.duplicate_no ?? ""}`.trim(), `ನಕಲು ಪ್ರತಿ ${paper.duplicate_no ?? ""}`.trim()),
      detail: bi("FOR RECORDS ONLY. GOODS CAN'T BE HANDED OVER ON THIS PAPER: ITS QR SCANS RED.", "ದಾಖಲೆಗೆ ಮಾತ್ರ. ಈ ಪತ್ರದಿಂದ ಸರಕು ಹಸ್ತಾಂತರಿಸಲಾಗದು: ಇದರ QR ಕೆಂಪು ತೋರಿಸುತ್ತದೆ."),
    };
  }
  const when = paper.replaces?.printed_at ? istDateTime(paper.replaces.printed_at) : "";
  return {
    title: bi("REPLACEMENT ORIGINAL", "ಬದಲಿ ಮೂಲ ಪ್ರತಿ"),
    detail: bi(`Replaces the original printed ${when}, which no longer works. Reason: ${paper.reason ?? ""}`,
      `${when} ರಂದು ಮುದ್ರಿಸಿದ ಮೂಲ ಪ್ರತಿಯ ಬದಲು; ಅದು ಈಗ ಕೆಲಸ ಮಾಡುವುದಿಲ್ಲ. ಕಾರಣ: ${paper.reason ?? ""}`),
  };
}

/** Under the QR on the paper. */
export function qrCaption(kind: string | null | undefined, duplicateNo?: number | null): Bi {
  if (kind === "duplicate") {
    return bi(`Duplicate copy ${duplicateNo ?? ""}: scans red. Records only.`, `ನಕಲು ಪ್ರತಿ ${duplicateNo ?? ""}: ಸ್ಕ್ಯಾನ್ ಮಾಡಿದರೆ ಕೆಂಪು. ದಾಖಲೆಗೆ ಮಾತ್ರ.`);
  }
  const which = kind === "replacement" ? bi("this replacement original", "ಈ ಬದಲಿ ಮೂಲ ಪ್ರತಿ") : bi("this original", "ಈ ಮೂಲ ಪ್ರತಿ");
  return bi(`Godown: scan before handing over. Only ${which.en} works, once per item.`, `ಗೋದಾಮು: ಹಸ್ತಾಂತರಿಸುವ ಮೊದಲು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ. ${which.kn} ಮಾತ್ರ, ಪ್ರತಿ ಸರಕಿಗೆ ಒಮ್ಮೆ.`);
}

/** The warning on a reprinted slip (or note) whose goods are already handed over. */
export function handedOverWarning(handover: PaperHandover | null | undefined) {
  return handover ? `ALREADY HANDED OVER ${istDateTime(handover.at).toUpperCase()} BY ${handover.by.toUpperCase()}. FOR RECORDS ONLY. DO NOT DELIVER AGAIN.` : "";
}

/** A handover as the admin screens read it (public.delivery_handovers). */
export type DeliveryHandoverRow = {
  id: number; slip_line: number; round: number; actor_name: string; actor_role: string; branch_name: string;
  device_registered: boolean; device_label: string; gate_code: string; gate_source: string; handed_over_at: string;
};

/** An administrator's reopening of a handed-over item (public.delivery_handover_reopens). */
export type DeliveryReopenRow = { id: number; handover_id: number; slip_line: number; reason: string; actor_name: string; reopened_at: string };

/** A printed paper as the admin screens read it (public.delivery_paper_codes, without the hash). */
export type DeliveryPaperRow = {
  id: number; print_event_id: number; doc: string; slip_line: number | null; copy_no: number; kind: PaperKind; duplicate_no: number | null; reason: string; printed_by: string; printed_at: string;
};

/** A kept scan as the admin screens read it (public.delivery_scans), with its note when the code was known. */
export type DeliveryScanRow = {
  id: number; action: string; result: string; doc: string | null; slip_line: number | null; copy_no: number | null;
  paper_kind: string | null; duplicate_no: number | null; asked: number[]; lines: number[];
  gate_code: string | null; gate_source: string | null; order_delivered: boolean;
  actor_name: string; actor_role: string; branch_name: string; device_registered: boolean; device_label: string; code_hint: string; occurred_at: string;
  note_no?: string | null; order_no?: string | null;
};

/** "Slip 2, duplicate copy 1" / "Note, original" / "Invoice QR" / "Unknown code 1a2b3c" for the history. */
export function scannedPaperLabel(row: Pick<DeliveryScanRow, "doc" | "slip_line" | "paper_kind" | "duplicate_no" | "code_hint">) {
  if (!row.doc) return `Unknown code ${row.code_hint.slice(0, 6)}`;
  if (row.doc === "invoice") return "Invoice QR";
  return `${row.doc === "note" ? "Note" : `Slip ${row.slip_line}`}, ${paperKindWords(row.paper_kind, row.duplicate_no).en.toLowerCase()}`;
}

/** "Ravi (staff, Challakere Godown, own phone)" for the history. */
export const scannerLabel = (row: Pick<DeliveryScanRow, "actor_name" | "actor_role" | "branch_name" | "device_registered" | "device_label">) =>
  `${personWords(row.actor_name, row.actor_role, row.branch_name, row.device_registered).en.replace(/\)$/, "")}${row.device_registered && row.device_label ? `: ${row.device_label}` : ""})`;

/** Plain words for a kept scan, for the admin's history. "replaced" covers a replaced original and a replaced invoice QR. */
export const SCAN_RESULT_LABELS: Record<PaperScanResult | InvoiceScanResult, string> = {
  handed_over: "Handed over",
  ready: "Checked: genuine, not handed over",
  released: "Checked: note released, items to go",
  printed: "Printed from a scan",
  already_handed_over: "Refused: already handed over",
  partly_handed_over: "Refused: ticked items already went",
  duplicate: "Refused: duplicate copy",
  replaced: "Refused: replaced QR",
  order_problem: "Refused: order problem",
  other_godown: "Refused: another godown",
  not_released: "Refused: note not released yet",
  not_allowed: "Refused: not allowed for this person",
  unknown: "Refused: unknown code",
};
export const scanResultLabel = (result: string) => SCAN_RESULT_LABELS[result as PaperScanResult | InvoiceScanResult] ?? result;
/** A scan that gave nothing: anything but a check that found goods to go, a print, or a handover. */
export const scanIsRefusal = (result: string) => !["ready", "released", "printed", "handed_over"].includes(result);
