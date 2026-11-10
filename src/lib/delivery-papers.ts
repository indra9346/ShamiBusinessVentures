/*
 * QR codes on delivery notes and slips (client, 10 Nov 2026): "Delivery slips with unique qr so scanned which is in
 * system recognized then green signal duplicate delivery copies will be avoided". What the scan screen and the paper
 * say. Kept free of app imports so the node tests can load it.
 *
 * The answer itself comes from the database, public.delivery_paper_scan
 * (supabase/migrations/20261110120000_delivery_paper_qr.sql). Nothing here can make a paper valid: these functions
 * only put the database's answer into words, and read a scanned QR.
 */
import { istDateTime, paperWarnings, type DeliveryGate, type DeliveryGateCode } from "./delivery-notes.ts";

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

export type PaperScanResult = "unknown" | "ready" | "handed_over" | "already_handed_over" | "replaced" | "order_problem" | "other_godown";

export type PaperHandover = { at: string; by: string; role: "admin" | "staff"; godown: string };

export type PaperScanLine = { line: number; name: string; qty: number; pack_size: string; stock_no: string; handover: PaperHandover | null };

/** What the database answered for one scan. Only result and who scanned are there for an unknown code. */
export type PaperScan = {
  result: PaperScanResult;
  action: "check" | "handover";
  scan_id: number;
  scanned_at: string;
  by: string;
  role: "admin" | "staff";
  /** The scanner's godown; empty for an administrator. */
  godown: string;
  paper?: {
    doc: "note" | "slip"; slip_line: number | null; slips: number; copy_no: number; printed_at: string;
    latest_copy: number; latest_printed_at: string; latest_printed_by: string;
  };
  note?: { note_no: string; order_no: string; invoice_number: string; customer: string; godown: string; shipping_method: string; generated_at: string };
  lines?: PaperScanLine[];
  handed_now?: number[];
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
export type ScanWords = { tone: ScanTone; headline: string; lines: string[] };

/** "Slip 2 of 3" or "Delivery note". */
export function paperName(paper: PaperScan["paper"]) {
  if (!paper) return "Paper";
  return paper.doc === "note" ? "Delivery note" : `Slip ${paper.slip_line} of ${paper.slips}`;
}

const who = (handover: PaperHandover) =>
  `${handover.by}${handover.godown ? `, ${handover.godown}` : handover.role === "admin" ? " (office)" : ""}`;

/** "Handed over 10 Nov 2026, 10:32:15 AM IST by Ravi, Challakere Godown" for each line already handed over. */
export function handoverLines(lines: PaperScanLine[] | undefined, many: boolean) {
  return (lines ?? []).filter((line) => line.handover).map((line) =>
    `${many ? `Item ${line.line} (${line.name}): h` : "H"}anded over ${istDateTime(line.handover!.at)} by ${who(line.handover!)}.`);
}

// What stops a delivery outright, not just a record to check.
const RED_GATES: DeliveryGateCode[] = ["cancelled", "refunded", "payment_expired", "stopped", "return_refunded", "unpaid", "partly_paid"];

/** The database's answer as the scan screen says it. */
export function scanWords(scan: PaperScan): ScanWords {
  const paper = scan.paper;
  const name = paperName(paper);
  const many = paper?.doc === "note";
  switch (scan.result) {
    case "handed_over":
      return {
        tone: "green",
        headline: "Hand over the goods",
        lines: [
          `Genuine ${paper?.doc === "note" ? "delivery note" : "slip"}, newest copy. Handover recorded ${istDateTime(scan.scanned_at)} by ${scan.by}${scan.godown ? `, ${scan.godown}` : ""}.`,
          ...(many && (scan.lines?.length ?? 0) > (scan.handed_now?.length ?? 0) ? handoverLines(scan.lines?.filter((line) => !scan.handed_now?.includes(line.line)), true).map((text) => `Before this: ${text}`) : []),
          "This paper can't be used again. A copy of it will show red.",
          ...(scan.gate?.source === "last_reading" ? ["Zoho Books could not be read just now, so the payment was checked on the website's last reading."] : []),
        ],
      };
    case "ready":
      return {
        tone: "ready",
        headline: "Genuine · not handed over yet",
        lines: [
          `${name} of ${scan.note?.note_no ?? "the note"}, newest copy (copy ${paper?.copy_no ?? 1}). Paid in full.`,
          ...handoverLines(scan.lines, many),
          "Press the button to record the handover. Give the goods only when the screen turns green.",
        ],
      };
    case "already_handed_over":
      return {
        tone: "red",
        headline: "Already handed over · do not give again",
        lines: [
          ...handoverLines(scan.lines, many),
          ...(scan.lines?.some((line) => line.handover?.by === scan.by)
            ? ["You recorded this handover yourself. If you gave the goods then, there is nothing more to do: do not give them again."] : []),
          ...(paper && paper.copy_no < paper.latest_copy ? [`This paper is also an old copy (copy ${paper.copy_no} of ${paper.latest_copy}).`] : []),
          "If goods are being asked for again on this paper, it is a duplicate. Keep the paper and tell the office.",
        ],
      };
    case "replaced":
      return {
        tone: "red",
        headline: "Old copy · cancelled",
        lines: [
          `This is copy ${paper?.copy_no} of ${name.toLowerCase()} on ${scan.note?.note_no ?? "this note"}. Copy ${paper?.latest_copy} was printed ${paper?.latest_printed_at ? istDateTime(paper.latest_printed_at) : ""} by ${paper?.latest_printed_by || "the office"}, which cancelled this one.`,
          "Do not hand over against this paper. Ask the office which paper is the real one.",
        ],
      };
    case "order_problem": {
      const gate = scan.gate;
      const asGate: DeliveryGate = {
        allowed: false, code: gate?.code ?? "not_found", items_changed: Boolean(gate?.items_changed), invoice_changed: Boolean(gate?.invoice_changed), invoice_number: gate?.invoice_number ?? "",
      };
      const warnings = gate?.code === "paid" ? paperWarnings(asGate).filter((warning) => !warning.startsWith("PAYMENT")) : paperWarnings(asGate);
      if (gate?.zoho_void) warnings.unshift("ORDER IS VOID IN ZOHO BOOKS. DO NOT DELIVER.");
      if (gate?.code === "stopped" && gate.stop_reason) warnings.push(`Reason given: ${gate.stop_reason}`);
      const red = Boolean(gate?.zoho_void) || RED_GATES.includes(gate?.code as DeliveryGateCode);
      return { tone: red ? "red" : "amber", headline: "Do not hand over", lines: [...warnings, "Tell the office. Keep the paper."] };
    }
    case "other_godown":
      return {
        tone: "amber",
        headline: "Another godown's paper",
        lines: [
          `This ${paper?.doc === "note" ? "delivery note" : "slip"} is for ${scan.note?.godown || "another godown"}. You are signed in at ${scan.godown || "a different godown"}.`,
          "Do not hand over these goods here. Ask the office.",
        ],
      };
    case "unknown":
    default:
      return {
        tone: "red",
        headline: "Not a genuine paper",
        lines: [
          "This QR code is not in Grain Bazar's system. The paper may be forged, damaged or from somewhere else.",
          "Do not hand over. Keep the paper and tell the office.",
        ],
      };
  }
}

/** Under the QR on the paper. */
export function qrCaption(copy: number | null | undefined) {
  const n = copy ?? 1;
  if (n <= 1) return "Godown: scan before handing over. Works once.";
  return `Copy ${n}: ${n === 2 ? "copy 1 is" : `copies 1 to ${n - 1} are`} cancelled. Godown: scan before handing over. Works once.`;
}

/** The warning on a reprinted slip (or note) whose goods are already handed over. */
export function handedOverWarning(handover: PaperHandover | null | undefined) {
  return handover ? `ALREADY HANDED OVER ${istDateTime(handover.at).toUpperCase()} BY ${handover.by.toUpperCase()}. FOR RECORDS ONLY. DO NOT DELIVER AGAIN.` : "";
}

/** A handover as the admin screens read it (public.delivery_handovers). */
export type DeliveryHandoverRow = {
  id: number; slip_line: number; actor_name: string; actor_role: string; branch_name: string; gate_code: string; gate_source: string; handed_over_at: string;
};

/** A kept scan as the admin screens read it (public.delivery_scans), with its note when the code was known. */
export type DeliveryScanRow = {
  id: number; action: string; result: string; doc: string | null; slip_line: number | null; copy_no: number | null; lines: number[];
  gate_code: string | null; gate_source: string | null; actor_name: string; actor_role: string; branch_name: string; code_hint: string; occurred_at: string;
  note_no?: string | null; order_no?: string | null;
};

/** "Slip 2, copy 3" / "Note, copy 1" / "Unknown code 1a2b3c" for the history. */
export function scannedPaperLabel(row: Pick<DeliveryScanRow, "doc" | "slip_line" | "copy_no" | "code_hint">) {
  if (!row.doc) return `Unknown code ${row.code_hint.slice(0, 6)}`;
  return `${row.doc === "note" ? "Note" : `Slip ${row.slip_line}`}, copy ${row.copy_no}`;
}

/** Plain words for a kept scan, for the admin's history. */
export const SCAN_RESULT_LABELS: Record<PaperScanResult, string> = {
  handed_over: "Handed over",
  ready: "Checked: genuine, not handed over",
  already_handed_over: "Refused: already handed over",
  replaced: "Refused: old cancelled copy",
  order_problem: "Refused: order problem",
  other_godown: "Refused: another godown",
  unknown: "Refused: unknown code",
};
export const scanResultLabel = (result: string) => SCAN_RESULT_LABELS[result as PaperScanResult] ?? result;
export const scanIsRefusal = (result: string) => result !== "ready" && result !== "handed_over";
