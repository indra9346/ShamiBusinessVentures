import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Download, Printer, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addressLines, companyHeading, deliveryMethodLabel, gateWords, isPickup, istDateTime, paperWarnings, slipPages,
  type DeliveryGate, type DeliveryNote, type DeliveryNoteView, type SlipPage,
} from "@/lib/delivery-notes";
import {
  handedOverWarning, paperKindWords, paperLink, paperStamp, personWords, qrCaption, type DeliveryPaperRow, type PaperHandover, type PaperPrint,
} from "@/lib/delivery-papers";
import { getDeliveryNote, recordDeliveryPrint } from "@/lib/delivery-notes.functions";
import { buildDeliveryNotePdf, canvasTextImage, loadLogoPng } from "@/lib/delivery-note-pdf";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/delivery-note/$orderNo")({
  head: ({ params }) => ({
    meta: [
      { title: `Delivery note ${params.orderNo} | Shami Business Ventures Admin` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DeliveryNotePrintPage,
});

/** What the next press prints or downloads: the note, every slip, or both. */
type Selection = { note: boolean; slips: number[] };
/** What the last press made. The QR codes exist only here, in this tab: the database keeps their hashes. */
type Paper = {
  printedAt: string | null; noteCopy: number | null; slipCopies: Record<string, number>; selection: Selection;
  noteCode: string | null; slipCodes: Record<string, string>;
  notePaper: PaperPrint | null; slipPapers: Record<string, PaperPrint>;
};
type Mode = "print" | "download";
type Pick = "all" | "note" | "slips" | number;

/*
 * On screen the sheets are as wide as the phone or window allows. On paper each is one A4 page (a long
 * note runs on, repeating its table header) and only what was chosen prints, each on its own page.
 * The sheets print only for a few minutes after a press of Print, which has just re-checked the payment
 * and recorded the copy. Otherwise the browser's own print menu gets a line saying to use the button, so
 * a tab left open can't print a stale check or a copy nobody recorded.
 */
const PRINT_CSS = `
@page { size: A4 portrait; margin: 10mm; }
@media print {
  html, body { background: #fff !important; }
  [data-sonner-toaster], .dn-screen-only { display: none !important; }
  .dn-root { background: #fff !important; padding: 0 !important; }
  .dn-sheet { box-shadow: none !important; border: 0 !important; margin: 0 !important; padding: 0 !important; max-width: none !important; width: 100% !important; }
  .dn-sheet[data-print="no"] { display: none !important; }
  .dn-sheet[data-print="yes"] ~ .dn-sheet[data-print="yes"] { break-before: page; page-break-before: always; }
  .dn-sheet tr, .dn-keep { break-inside: avoid; page-break-inside: avoid; }
  .dn-sheet thead { display: table-header-group; }
  .dn-sheet tfoot { display: table-row-group; }
  .dn-root[data-armed="no"] .dn-docs { display: none !important; }
  .dn-root[data-armed="no"] .dn-use-button { display: block !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/**
 * How long after a press the paper may still print. A phone's print screen asks for the page after
 * print() returns, and again if the paper size is changed, so this can't be one print only.
 */
const ARMED_MS = 300_000;

const EMPTY_PAPER: Paper = { printedAt: null, noteCopy: null, slipCopies: {}, selection: { note: true, slips: [] }, noteCode: null, slipCodes: {}, notePaper: null, slipPapers: {} };

/** Each paper's prints so far, from the database: "note" and "slip:2". */
function printsByPaper(papers: DeliveryPaperRow[]) {
  const map = new Map<string, DeliveryPaperRow[]>();
  for (const row of papers) {
    const key = row.doc === "note" ? "note" : `slip:${row.slip_line}`;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

/** ["original made 10 Nov, 2:05 PM by Indra", "2 duplicate copies"] for the screen, one phrase each (each translates). */
function printedSoFar(rows: DeliveryPaperRow[] | undefined) {
  if (!rows?.length) return ["not printed yet: the next print or download is the original"];
  const current = [...rows].reverse().find((row) => row.kind !== "duplicate");
  const duplicates = rows.filter((row) => row.kind === "duplicate").length;
  const replaced = rows.filter((row) => row.kind === "replacement").length;
  return [
    current ? `${paperKindWords(current.kind).en.toLowerCase()} made ${istDateTime(current.printed_at)} by ${current.printed_by}` : "",
    replaced ? `${replaced} replacement${replaced === 1 ? "" : "s"}` : "",
    duplicates ? `${duplicates} duplicate cop${duplicates === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean);
}

function SoFar({ label, rows }: { label: string; rows: DeliveryPaperRow[] | undefined }) {
  return (
    <li>
      <span className="font-semibold">{label}</span>{" "}
      {printedSoFar(rows).map((part, index) => <span key={part}>{index ? " · " : ""}<span>{part}</span></span>)}
    </li>
  );
}

/**
 * Everything the papers say that depends on the view: the payment warnings, which items are handed over, and which
 * papers can still get a replacement original. The same for the screen, the print and the download.
 */
function papersState(view: DeliveryNoteView | null) {
  const note = view?.note ?? null;
  const state = view?.state;
  const slips = note ? slipPages(note.snapshot) : [];
  const allSlips = slips.map((slip) => slip.slip);
  const warnings = state && note ? paperWarnings(state) : [];
  // The items handed over now: a handover an administrator has reopened no longer counts.
  const reopened = new Set((view?.reopens ?? []).map((row) => row.handover_id));
  const handovers: Record<string, PaperHandover> = Object.fromEntries((view?.handovers ?? []).filter((row) => !reopened.has(row.id)).map((row) => [String(row.slip_line), {
    at: row.handed_over_at, by: row.actor_name, role: row.actor_role === "admin" || row.actor_role === "partner" ? row.actor_role : "staff",
    godown: row.branch_name, registered_phone: row.device_registered, round: row.round,
  } satisfies PaperHandover]));
  const handedLines = Object.keys(handovers).map(Number).sort((a, b) => a - b);
  const openSlips = allSlips.filter((line) => !handovers[String(line)]);
  const noteWarnings = handedLines.length === 0 ? warnings : [...warnings, handedLines.length === slips.length
    ? "ALL ITEMS ALREADY HANDED OVER. FOR RECORDS ONLY. DO NOT DELIVER AGAIN."
    : `ITEM${handedLines.length === 1 ? "" : "S"} ${handedLines.join(", ")} ALREADY HANDED OVER. DELIVER ONLY THE REST.`];
  const slipWarnings: Record<string, string[]> = Object.fromEntries(allSlips.map((line) => [String(line),
    handovers[String(line)] ? [...warnings, handedOverWarning(handovers[String(line)])] : warnings]));
  const prints = printsByPaper(view?.papers ?? []);
  const hasOriginal = (key: string) => (prints.get(key) ?? []).some((row) => row.kind !== "duplicate");
  // A replacement original only for a paper that has had an original, and only while its goods are still to go.
  const replaceable = [...(hasOriginal("note") && openSlips.length ? ["note"] : []), ...openSlips.filter((line) => hasOriginal(`slip:${line}`)).map(String)];
  return { note, state, slips, allSlips, warnings, handovers, handedLines, openSlips, noteWarnings, slipWarnings, prints, replaceable };
}

const pickSelection = (pick: Pick, allSlips: number[]): Selection =>
  pick === "all" ? { note: true, slips: allSlips } : pick === "note" ? { note: true, slips: [] } : pick === "slips" ? { note: false, slips: allSlips } : { note: false, slips: [pick] };

const keySelection = (keys: string[]): Selection => ({ note: keys.includes("note"), slips: keys.filter((key) => key !== "note").map(Number).sort((a, b) => a - b) });

/** "the note and slip 1" for a toast. */
function selectionWords(selection: Selection) {
  const slips = selection.slips.length ? `slip${selection.slips.length === 1 ? "" : "s"} ${selection.slips.join(", ")}` : "";
  return [selection.note ? "the note" : "", slips].filter(Boolean).join(" and ");
}

function DeliveryNotePrintPage() {
  const { orderNo } = Route.useParams();
  const [view, setView] = useState<DeliveryNoteView | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<"" | Mode>("");
  const [paper, setPaper] = useState<Paper>(EMPTY_PAPER);
  const [armed, setArmed] = useState(false);
  const [pick, setPick] = useState<Pick>("all");
  const [reason, setReason] = useState("");
  const [replacePick, setReplacePick] = useState<string[] | null>(null);
  const disarmTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const next = await getDeliveryNote({ data: { orderNo, fresh: false } });
      setView(next);
      setFailed("");
      const lines = next.note ? slipPages(next.note.snapshot).map((slip) => slip.slip) : [];
      setPaper((current) => (current.printedAt ? current : { ...current, selection: { note: true, slips: lines } }));
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : "Could not open the delivery note");
    }
  }, [orderNo]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  /**
   * One press: the database checks the payment, files each paper as its original, a duplicate copy or (with a reason)
   * a replacement original, and gives this press's QR codes. Then the papers print, or download as a PDF. Either way
   * the press counts as a copy.
   */
  const press = async (selection: Selection, mode: Mode, replaceReason?: string) => {
    setBusy(mode);
    let recorded = "";
    try {
      // Everything the PDF needs is loaded before the press is recorded, so a recorded copy always gets its file.
      const pdfKit = mode === "download" ? await Promise.all([import("jspdf"), loadLogoPng()]) : null;
      const { record, view: next } = await recordDeliveryPrint({ data: { orderNo, note: selection.note, slipLines: selection.slips, replaceReason } });
      const kinds = [...(selection.note ? [record.notePaper] : []), ...selection.slips.map((line) => record.slipPapers[String(line)])]
        .filter(Boolean).map((print) => paperKindWords(print!.kind, print!.duplicate_no).en.toLowerCase());
      recorded = [...new Set(kinds)].join(", ");
      flushSync(() => {
        setView(next);
        setPaper({
          selection, printedAt: record.printedAt, noteCopy: record.noteCopy, slipCopies: record.slipCopies,
          noteCode: record.noteCode, slipCodes: record.slipCodes, notePaper: record.notePaper, slipPapers: record.slipPapers,
        });
        if (mode === "print") setArmed(true);
        if (replaceReason) { setReason(""); setReplacePick(null); }
      });
      if (mode === "print") {
        window.clearTimeout(disarmTimer.current);
        window.print();
        disarmTimer.current = window.setTimeout(() => setArmed(false), ARMED_MS);
        return;
      }
      const papers = papersState(next);
      if (!next.note) throw new Error("This order has no delivery note yet");
      const { pdf, fileName } = buildDeliveryNotePdf({
        note: next.note, state: next.state, selection, record,
        noteWarnings: papers.noteWarnings, slipWarnings: papers.slipWarnings, origin: window.location.origin,
      }, { jspdf: pdfKit![0], logo: pdfKit![1], textImage: canvasTextImage });
      pdf.save(fileName);
      toast.success(`Downloaded ${fileName}`, { description: `${selectionWords(selection)}: ${recorded}. Open the file to print or send it.`, duration: 10_000 });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The copy could not be recorded";
      if (recorded) {
        toast.error("The copy was recorded but the PDF could not be made", { description: `${message}. It counts as ${recorded}. Use Print instead.`, duration: 15_000 });
      } else {
        toast.error(mode === "print" ? "Not printed" : "Not downloaded", { description: message });
      }
    } finally {
      setBusy("");
    }
  };

  const { note, state, slips, allSlips, warnings, handovers, handedLines, noteWarnings, slipWarnings, prints, replaceable } = papersState(view);
  const chosenReplace = (replacePick ?? replaceable).filter((key) => replaceable.includes(key));
  const replaceLabel = (key: string) => (key === "note" ? "Note" : `Slip ${key}`);
  const picks: { pick: Pick; label: string }[] = [
    { pick: "all", label: slips.length > 1 ? `Note and all ${slips.length} slips` : slips.length ? "Note and slip" : "Note" },
    ...(slips.length ? [{ pick: "note" as Pick, label: "Note only" }, { pick: "slips" as Pick, label: slips.length === 1 ? "Slip only" : "All slips only" }] : []),
    ...(slips.length > 1 ? slips.map((slip) => ({ pick: slip.slip as Pick, label: `Slip ${slip.slip}` })) : []),
  ];

  return (
    <div className="dn-root min-h-screen bg-stone-200 px-3 py-4 text-black sm:px-6" data-armed={armed ? "yes" : "no"}>
      <style>{PRINT_CSS}</style>
      <p className="dn-use-button hidden text-lg font-bold">Please use the Print button on this page. It checks the payment again and records the print time and copy number.</p>
      <div className="dn-screen-only mx-auto mb-4 max-w-[210mm] space-y-3 rounded-lg bg-white p-3 shadow-sm sm:p-4">
        <Link to="/admin/orders/$id" params={{ id: orderNo }} className="inline-flex items-center gap-1 text-sm font-semibold text-navy hover:text-gold">
          <ArrowLeft className="h-4 w-4" /> Back to order {orderNo}
        </Link>
        {!view && !failed && <p className="text-sm text-slate">Opening the delivery note…</p>}
        {failed && (
          <p className="text-sm text-danger">{failed} <Link to="/admin/login" className="font-semibold underline">Admin sign in</Link></p>
        )}
        {view && !note && state && (
          <p className="text-sm text-danger">This order has no delivery note yet. {gateWords(state).title}: {gateWords(state).detail}</p>
        )}
        {note && (
          <>
            {view?.qrReady === false && (
              <p className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
                Printing is paused: the database doesn't have the delivery-slip QR update yet, so the papers would have no QR code. Ask your developer to apply it.
              </p>
            )}
            {warnings.length > 0 && (
              <div className="rounded-md border-2 border-red-300 bg-red-50 p-3 text-sm font-bold text-red-900">
                {warnings.map((warning) => <p key={warning}>{warning}</p>)}
                <p className="mt-1 font-normal">These warnings print on the paper. {state ? gateWords(state).detail : ""}</p>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate">What to print or download</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="What to print or download">
                {picks.map((option) => (
                  <button key={String(option.pick)} type="button" aria-pressed={pick === option.pick} onClick={() => setPick(option.pick)}
                    className={cn("rounded-md border px-2.5 py-1.5 text-xs font-semibold", pick === option.pick ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy")}>
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy !== ""} onClick={() => void press(pickSelection(pick, allSlips), "print")}>
                  <Printer className="mr-1.5 h-4 w-4" /> {busy === "print" ? "Printing…" : "Print"}
                </Button>
                <Button size="sm" variant="outline" className="border-navy text-navy" disabled={busy !== ""} onClick={() => void press(pickSelection(pick, allSlips), "download")}>
                  <Download className="mr-1.5 h-4 w-4" /> {busy === "download" ? "Making the PDF…" : "Download PDF"}
                </Button>
              </div>
              <p className="text-xs text-slate">
                Print and Download each check the payment with Zoho again, put the exact time on the paper and count as a copy, even if you then cancel the print screen. On a phone the print screen opens next: choose your printer or Save as PDF. If nothing opens, use Download PDF.
              </p>
            </div>

            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
              <p>
                <span className="font-bold">QR codes:</span>{" "}
                <span>The first copy of each paper (printed or downloaded) is its original, the only paper that hands goods over (once per item). Every later copy is a duplicate copy 1, 2, … for records: it is stamped DUPLICATE and its QR scans red at the godown.</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                <SoFar label="Note:" rows={prints.get("note")} />
                {slips.map((slip) => <SoFar key={slip.slip} label={`Slip ${slip.slip}:`} rows={prints.get(`slip:${slip.slip}`)} />)}
              </ul>
            </div>

            {replaceable.length > 0 && (
              <div className="space-y-2 rounded-md border-2 border-navy bg-[#f6f8fb] p-3 text-xs">
                <p className="flex items-center gap-1.5 text-sm font-bold text-navy"><RotateCcw className="h-4 w-4" /> Need the original again?</p>
                <p>
                  If the original was lost, did not print, or a duplicate copy was sent to the godown by mistake, make a replacement original. It hands the goods over like the original; the old original&apos;s QR stops working, and duplicate copies stay for records only. Only for goods not yet handed over.
                </p>
                <Input aria-label="Why the original is being replaced" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)}
                  placeholder="Reason, for example: duplicate sent to the godown by mistake" className="h-9 bg-white text-xs" />
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Papers to replace">
                  <span className="text-slate">Replace:</span>
                  {replaceable.map((key) => {
                    const on = chosenReplace.includes(key);
                    return (
                      <button key={key} type="button" aria-pressed={on}
                        onClick={() => setReplacePick(on ? chosenReplace.filter((item) => item !== key) : [...chosenReplace, key])}
                        className={cn("rounded-md border px-2.5 py-1 font-semibold", on ? "border-navy bg-navy text-white" : "border-border bg-white text-navy hover:border-navy")}>
                        {replaceLabel(key)}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="bg-navy text-white hover:bg-navy/90" disabled={busy !== "" || reason.trim().length < 3 || chosenReplace.length === 0}
                    onClick={() => void press(keySelection(chosenReplace), "print", reason.trim())}>
                    <Printer className="mr-1.5 h-4 w-4" /> Print replacement original
                  </Button>
                  <Button size="sm" variant="outline" className="border-navy text-navy" disabled={busy !== "" || reason.trim().length < 3 || chosenReplace.length === 0}
                    onClick={() => void press(keySelection(chosenReplace), "download", reason.trim())}>
                    <Download className="mr-1.5 h-4 w-4" /> Download replacement original
                  </Button>
                </div>
                {reason.trim().length < 3 && <p className="text-slate">Write the reason first (at least 3 letters). It is printed on the paper and kept in the history.</p>}
              </div>
            )}

            {handedLines.length > 0 && (
              <ul className="space-y-0.5 text-xs text-emerald-900">
                {handedLines.map((line) => {
                  const handover = handovers[String(line)]!;
                  return <li key={line}>Slip {line} handed over {istDateTime(handover.at)} by {personWords(handover.by, handover.role, handover.godown, handover.registered_phone).en}</li>;
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {note && state && (
        <div className="dn-docs" data-no-translate>
          <NoteSheet note={note} state={state} warnings={noteWarnings} paper={paper} slipCount={slips.length} />
          {slips.map((slip) => (
            <SlipSheet key={slip.slip} slip={slip} note={note} paper={paper} warnings={slipWarnings[String(slip.slip)] ?? warnings} />
          ))}
        </div>
      )}
    </div>
  );
}

// The paper's colours, the same as the PDF and the invoice: navy, gold, ink and grey.
const SHEET = "dn-sheet relative mx-auto mb-4 w-full max-w-[210mm] overflow-hidden bg-white p-4 text-[13px] leading-snug text-[#1c252e] shadow-md sm:p-8";
const LABEL = "text-[10.5px] font-bold uppercase tracking-wider text-[#20483a]";

/** The logo, faint, behind the paper; and DUPLICATE across a duplicate copy, so it can't be taken for the original. */
function Watermark({ print }: { print: PaperPrint | null | undefined }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden">
      <img src="/grainbazar-logo.png" alt="" className="w-[62%] max-w-[125mm] opacity-[0.06]" />
      {print?.kind === "duplicate" && (
        <p className="absolute whitespace-nowrap text-[58px] font-black uppercase tracking-[0.12em] text-[#b91c1c] opacity-[0.13] [transform:rotate(-53deg)]">
          Duplicate copy {print.duplicate_no ?? ""}
        </p>
      )}
    </div>
  );
}

function KindPill({ print }: { print: PaperPrint | null | undefined }) {
  if (!print) return null;
  const tone = print.kind === "duplicate" ? "bg-[#b91c1c]" : print.kind === "replacement" ? "bg-[#20483a]" : "bg-[#15803d]";
  return <span className={`mt-1 inline-block rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white ${tone}`}>{paperKindWords(print.kind, print.duplicate_no).en}</span>;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="dn-keep my-3 border-[3px] border-[#1c252e] p-3 text-center text-[15px] font-extrabold uppercase tracking-wide">
      {warnings.map((warning) => <p key={warning}>{warning}</p>)}
    </div>
  );
}

/** The big stamp on a duplicate (and the replacement note on a replacement original), in both languages. */
function Stamp({ print }: { print: PaperPrint | null | undefined }) {
  const stamp = paperStamp(print);
  if (!stamp) return null;
  const duplicate = print?.kind === "duplicate";
  return (
    <div className={`dn-keep my-3 rounded-md border-[3px] p-3 text-center ${duplicate ? "border-[#b91c1c] bg-[#fef2f2] text-[#b91c1c]" : "border-[#20483a] bg-[#f6f8fb] text-[#20483a]"}`}>
      <p className={`${duplicate ? "text-3xl" : "text-2xl"} font-black uppercase tracking-widest`}>{stamp.title.en}</p>
      <p className={`${duplicate ? "text-2xl" : "text-xl"} font-black`}>{stamp.title.kn}</p>
      <p className="mt-1 text-xs font-bold uppercase text-[#1c252e]">{stamp.detail.en}</p>
      <p className="text-xs font-bold text-[#1c252e]">{stamp.detail.kn}</p>
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[78px] shrink-0 text-[12px] text-[#66707c]">{label}</dt>
      <dd className={`min-w-0 break-words ${strong ? "font-bold" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

/** The copy line: what this paper is. Before a press, or for a paper the last press didn't make, there is nothing yet. */
function PrintedFacts({ printedAt, print, inPrint }: { printedAt: string | null; print: PaperPrint | null | undefined; inPrint: boolean }) {
  const printed = Boolean(printedAt && inPrint && print);
  return (
    <>
      <Fact label="Printed" value={printed ? istDateTime(printedAt!) : printedAt ? "Not in the last copy" : "The time appears when you press Print or Download"} strong />
      <Fact label="Copy" value={printed ? paperKindWords(print!.kind, print!.duplicate_no).en : "—"} strong={Boolean(printed && print!.kind !== "original")} />
    </>
  );
}

function CompanyHead({ note, title, side, print }: { note: DeliveryNote; title: string; side: string; print: PaperPrint | null | undefined }) {
  const company = companyHeading(note.snapshot.company);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b-[2.5px] border-[#c49634] pb-3">
      <div className="flex min-w-0 items-start gap-3">
        <img src="/grainbazar-logo.png" alt="Grain Bazar" className="h-[19mm] w-[19mm] shrink-0 object-contain" />
        <div className="min-w-0">
          <p className="text-[22px] font-extrabold leading-tight tracking-wide text-[#20483a]">GRAIN BAZAR</p>
          <p className="text-[11px] text-[#66707c]">A brand of {company.name || "Shami Business Ventures"}</p>
          {company.addressLines.map((line) => <p key={line} className="text-[10.5px] text-[#66707c]">{line}</p>)}
          {(company.gstin || company.phone) && (
            <p className="text-[10.5px] text-[#66707c]">{[company.gstin && `GSTIN ${company.gstin}`, company.phone && `Phone ${company.phone}`].filter(Boolean).join("  |  ")}</p>
          )}
        </div>
      </div>
      <div className="text-right">
        <p className="text-[21px] font-extrabold uppercase tracking-wide">{title}</p>
        <p className="text-[15px] font-bold text-[#20483a]">{side}</p>
        <KindPill print={print} />
      </div>
    </header>
  );
}

/**
 * The paper's QR: a link to the scan page with this copy's code after "#". Before a press there is no code, so the
 * sheet shows where it will be. The caption says what the paper is, in both languages.
 */
function PaperQr({ code, print, size }: { code: string | null | undefined; print: PaperPrint | null | undefined; size: "note" | "slip" }) {
  // About 0.9 mm (note) and 1.1 mm (slip) per square: easy for a phone held at arm's length.
  const box = size === "slip" ? "h-[44mm] w-[44mm]" : "h-[36mm] w-[36mm]";
  const caption = qrCaption(print?.kind, print?.duplicate_no);
  const tone = print?.kind === "duplicate" ? "text-[#b91c1c]" : "text-[#20483a]";
  return (
    <figure className={`dn-keep ${size === "slip" ? "w-[46mm]" : "w-[38mm]"} shrink-0 text-center`}>
      {code ? (
        <div className={`${box} mx-auto border border-[#dee2e6] bg-white [&>svg]:h-full [&>svg]:w-full`} role="img" aria-label="QR code to check this paper"
          // uqr returns a self-contained <svg> of the QR code (no scripts). A white border of 4 squares, as the QR
          // standard asks, so every reader finds the code's edges.
          dangerouslySetInnerHTML={{ __html: renderSVG(paperLink(window.location.origin, code), { ecc: "M", border: 4 }) }} />
      ) : (
        <div className={`${box} mx-auto grid place-items-center border-2 border-dashed border-neutral-400 p-2 text-[11px] text-neutral-600`}>
          The QR code appears when you press Print or Download
        </div>
      )}
      {code && (
        <figcaption className="mt-1 text-[10px] leading-tight text-[#66707c]">
          <span className={`block font-bold uppercase ${tone}`}>{paperKindWords(print?.kind, print?.duplicate_no).en}</span>
          <span className={`block font-bold ${tone}`}>{paperKindWords(print?.kind, print?.duplicate_no).kn}</span>
          <span className="block">{caption.en}</span>
          <span className="block">{caption.kn}</span>
        </figcaption>
      )}
    </figure>
  );
}

function Card({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="dn-keep min-w-0 rounded-md border border-[#dee2e6] border-l-[4px] border-l-[#20483a] bg-[#f6f8fb] p-3">
      <p className={LABEL}>{heading}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Signature({ label }: { label: string }) {
  return (
    <div className="min-w-0 rounded-md border border-[#dee2e6] px-3 pb-2 pt-3">
      <div className="h-12 border-b border-[#1c252e]" />
      <p className="mt-1 text-xs font-bold">{label}</p>
      <p className="text-[10.5px] text-[#66707c]">Name, signature, date and time</p>
    </div>
  );
}

function SheetFooter() {
  return (
    <div className="dn-keep mt-6 flex flex-wrap justify-between gap-2 border-t border-[#dee2e6] pt-2 text-[10px] text-[#66707c]">
      <p>Computer-generated. Goods are handed over only against the QR code of the original or replacement original.</p>
      <p>grainbazar.com</p>
    </div>
  );
}

function NoteSheet({ note, state, warnings, paper, slipCount }: { note: DeliveryNote; state: DeliveryGate; warnings: string[]; paper: Paper; slipCount: number }) {
  const { snapshot } = note;
  const pickup = isPickup(snapshot);
  const godownLines = addressLines(snapshot.godown);
  const customerLines = addressLines(snapshot.address);
  const lines = slipPages(snapshot);
  const totalQty = lines.reduce((sum, line) => sum + Number(line.qty), 0);
  const hasStockNo = lines.some((line) => line.stock_no);
  const print = paper.noteCode ? paper.notePaper : null;
  return (
    <section className={SHEET} data-print={paper.selection.note ? "yes" : "no"}>
      <Watermark print={print} />
      <div className="relative z-10">
        <CompanyHead note={note} title="Delivery note" side={note.note_no} print={print} />
        <Stamp print={print} />
        <Warnings warnings={warnings} />
        <div className="mt-3 flex flex-wrap items-start gap-4">
          <dl className="grid min-w-0 flex-1 basis-[60%] gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
            <Fact label="Order no." value={note.order_no} strong />
            <Fact label="Invoice no." value={note.invoice_number} strong />
            <Fact label="Order date" value={istDateTime(snapshot.order_placed_at)} />
            <Fact label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
            <Fact label="Generated" value={`${istDateTime(note.generated_at)} by ${note.generated_by_name}`} />
            <Fact label="Payment" value={state.code === "paid" ? "Paid in full" : "See the warning above"} strong />
            <PrintedFacts printedAt={paper.printedAt} print={paper.notePaper} inPrint={paper.selection.note} />
          </dl>
          <PaperQr code={paper.noteCode} print={paper.notePaper} size="note" />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
          <Card heading={pickup ? "Customer (collects at the godown)" : "Customer"}>
            <p className="font-bold">{snapshot.customer.business_name || snapshot.customer.name}</p>
            {snapshot.customer.business_name && snapshot.customer.name && <p>{snapshot.customer.name}</p>}
            {snapshot.customer.gstin && <p>GSTIN {snapshot.customer.gstin}</p>}
            {snapshot.customer.phone && <p>Phone {snapshot.customer.phone}</p>}
            {pickup && customerLines.map((line) => <p key={line} className="break-words">{line}</p>)}
          </Card>
          {pickup ? (
            <Card heading="Pickup from godown">
              <p className="font-bold">{snapshot.godown.name}</p>
              {godownLines.map((line) => <p key={line} className="break-words">{line}</p>)}
              {snapshot.godown.phone && <p>Phone {snapshot.godown.phone}</p>}
            </Card>
          ) : (
            <Card heading="Deliver to">
              {snapshot.address.name && <p className="font-bold">{snapshot.address.name}</p>}
              {customerLines.map((line) => <p key={line} className="break-words">{line}</p>)}
              {snapshot.address.phone && <p>Phone {snapshot.address.phone}</p>}
              <p className="mt-1 font-bold">From godown: {snapshot.godown.name}</p>
              {godownLines.map((line) => <p key={line} className="break-words text-xs text-[#66707c]">{line}</p>)}
            </Card>
          )}
        </div>

        <table className="mt-5 w-full border-collapse text-left text-[13px]">
          <thead>
            {/* Repeats on every page of a long note, so a loose page still says whose it is. */}
            <tr className="text-[11px] font-semibold">
              <th colSpan={hasStockNo ? 5 : 4} className="pb-1 font-semibold text-[#66707c]">
                {note.note_no} · Order {note.order_no}{print && print.kind !== "original" ? ` · ${paperKindWords(print.kind, print.duplicate_no).en.toUpperCase()}` : ""}
              </th>
            </tr>
            <tr className="bg-[#20483a] text-[11px] uppercase tracking-wider text-white">
              <th className="px-2 py-2 font-bold">#</th>
              <th className="px-2 py-2 font-bold">Item</th>
              <th className="px-2 py-2 font-bold">Pack size</th>
              {hasStockNo && <th className="px-2 py-2 font-bold">Stock no.</th>}
              <th className="px-2 py-2 text-right font-bold">Qty</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.line} className={`border-b border-[#dee2e6] align-top ${index % 2 === 1 ? "bg-[#f6f8fb]" : ""}`}>
                <td className="px-2 py-2">{line.line}</td>
                <td className="px-2 py-2">
                  <p className="font-semibold break-words">{line.name}</p>
                  {line.sku && <p className="text-[11px] text-[#66707c]">SKU {line.sku}</p>}
                </td>
                <td className="px-2 py-2">{line.pack_size || "—"}</td>
                {hasStockNo && <td className="px-2 py-2 break-words">{line.stock_no || "—"}</td>}
                <td className="px-2 py-2 text-right text-base font-bold">{line.qty}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#1c252e] font-bold">
              <td className="px-2 py-2" colSpan={hasStockNo ? 4 : 3}>{lines.length} item line{lines.length === 1 ? "" : "s"} · {slipCount} delivery slip{slipCount === 1 ? "" : "s"}</td>
              <td className="px-2 py-2 text-right text-base">Total {totalQty}</td>
            </tr>
          </tfoot>
        </table>

        <div className="dn-keep mt-6 flex flex-wrap items-end justify-between gap-3 text-sm">
          <p><span className="font-semibold">Vehicle no.</span> ______________________</p>
          <p className="text-[11px] text-[#66707c]">Received the goods above in good condition.</p>
        </div>
        <div className="dn-keep mt-4 grid grid-cols-3 gap-3">
          <Signature label="Prepared by" />
          <Signature label="Goods issued by (godown)" />
          <Signature label="Received by (customer)" />
        </div>
        <SheetFooter />
      </div>
    </section>
  );
}

function SlipSheet({ slip, note, warnings, paper }: { slip: SlipPage; note: DeliveryNote; warnings: string[]; paper: Paper }) {
  const { snapshot } = note;
  const code = paper.slipCodes[String(slip.slip)];
  const print = paper.slipPapers[String(slip.slip)];
  const shown = code ? print : null;
  return (
    <section className={SHEET} data-print={paper.selection.slips.includes(slip.slip) ? "yes" : "no"}>
      <Watermark print={shown} />
      <div className="relative z-10">
        <CompanyHead note={note} title="Delivery slip" side={`Slip ${slip.slip} of ${slip.of}`} print={shown} />
        <Stamp print={shown} />
        <Warnings warnings={warnings} />
        <div className="dn-keep my-5 flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 basis-[60%] rounded-lg border-2 border-[#20483a] bg-[#f6f8fb] p-4">
            <p className={LABEL}>Item</p>
            <p className="text-2xl font-extrabold break-words">{slip.name}</p>
            {slip.sku && <p className="text-sm text-[#66707c]">SKU {slip.sku}</p>}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <p className={LABEL}>Quantity</p>
                <p className="text-4xl font-extrabold">{slip.qty}</p>
              </div>
              <div className="min-w-0">
                <p className={LABEL}>Pack size</p>
                <p className="text-2xl font-extrabold break-words">{slip.pack_size || "—"}</p>
              </div>
            </div>
            {slip.stock_no && <p className="mt-3 text-sm font-semibold">Stock no. {slip.stock_no}</p>}
          </div>
          <PaperQr code={code} print={print} size="slip" />
        </div>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
          <Fact label="Note no." value={note.note_no} strong />
          <Fact label="Order no." value={note.order_no} strong />
          <Fact label="Invoice no." value={note.invoice_number} />
          <Fact label="Customer" value={snapshot.customer.business_name || snapshot.customer.name} />
          <Fact label="Godown" value={snapshot.godown.name ?? ""} />
          <Fact label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
          <Fact label="Generated" value={istDateTime(note.generated_at)} />
          <PrintedFacts printedAt={paper.printedAt} print={print} inPrint={paper.selection.slips.includes(slip.slip)} />
        </dl>
        <div className="dn-keep mt-8 grid grid-cols-2 gap-3">
          <Signature label="Goods issued by (godown)" />
          <Signature label="Received by" />
        </div>
        <SheetFooter />
      </div>
    </section>
  );
}
