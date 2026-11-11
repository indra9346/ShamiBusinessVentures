import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  addressLines, companyHeading, deliveryMethodLabel, gateWords, isPickup, istDateTime, paperWarnings, slipPages,
  type DeliveryGate, type DeliveryNote, type DeliveryNoteEvent, type DeliveryNoteView, type SlipPage,
} from "@/lib/delivery-notes";
import { personWords, releasedFact, releasedPaperWarnings, roleWords, type PaperHandover } from "@/lib/delivery-papers";
import { getDeliveryNote, printReleasedPapers } from "@/lib/delivery-notes.functions";
import { buildDeliveryNotePdf, canvasTextImage, loadLogoPng, releasedPdfInput } from "@/lib/delivery-note-pdf";
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

/*
 * The office's print and download of a released delivery note and its slips (12 Nov 2026). The one QR is on the
 * customer's invoice and only the godown's scan of it hands goods over, so these papers carry no QR, and every print
 * or download is simply the next numbered copy, with who printed it. Papers printed before then (with their own QR,
 * original or duplicate) are history only: they show in the order's delivery note panel.
 */

/** What the next press prints or downloads: the note, every slip, or both. */
type Selection = { note: boolean; slips: number[] };
/** What the last press made: when, which copy of each paper, and who printed it. */
type Paper = { printedAt: string | null; noteCopy: number | null; slipCopies: Record<string, number>; selection: Selection; printedBy: string };
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

const EMPTY_PAPER: Paper = { printedAt: null, noteCopy: null, slipCopies: {}, selection: { note: true, slips: [] }, printedBy: "" };

/** How the note came to be ('admin', 'auto' or 'scan'): kept on the note since 12 Nov 2026. */
const howOf = (note: DeliveryNote) => (note as DeliveryNote & { generated_how?: string }).generated_how ?? "admin";

/** Each paper's printed copies so far, from the note's history: "note" and "slip:2". */
function printsByPaper(events: DeliveryNoteEvent[]) {
  const map = new Map<string, DeliveryNoteEvent[]>();
  for (const event of events) {
    if (event.kind !== "printed" || !event.doc) continue;
    const key = event.doc === "note" ? "note" : `slip:${event.slip_line}`;
    map.set(key, [...(map.get(key) ?? []), event]);
  }
  return map;
}

/** ["3 copies", "last 11 Nov 2026, … by Indra"] for the screen, one phrase each (each translates). */
function printedSoFar(rows: DeliveryNoteEvent[] | undefined) {
  if (!rows?.length) return ["not printed yet"];
  const last = rows.reduce((latest, row) => (row.occurred_at > latest.occurred_at ? row : latest));
  return [`${rows.length} cop${rows.length === 1 ? "y" : "ies"}`, `last ${istDateTime(last.occurred_at)} by ${last.actor_name}`];
}

function SoFar({ label, rows }: { label: string; rows: DeliveryNoteEvent[] | undefined }) {
  return (
    <li>
      <span className="font-semibold">{label}</span>{" "}
      {printedSoFar(rows).map((part, index) => <span key={part}>{index ? " · " : ""}<span>{part}</span></span>)}
    </li>
  );
}

/**
 * Everything the papers say that depends on the view: the payment warnings and which items are handed over. The same
 * for the screen, the print and the download.
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
    at: row.handed_over_at, by: row.actor_name,
    role: row.actor_role === "admin" || row.actor_role === "partner" || row.actor_role === "incharge" ? row.actor_role : "staff",
    godown: row.branch_name, registered_phone: row.device_registered, round: row.round,
  } satisfies PaperHandover]));
  const handedLines = Object.keys(handovers).map(Number).sort((a, b) => a - b);
  const { noteWarnings, slipWarnings } = releasedPaperWarnings(warnings, allSlips, handovers);
  const prints = printsByPaper(view?.events ?? []);
  return { note, state, slips, allSlips, warnings, handovers, handedLines, noteWarnings, slipWarnings, prints };
}

const pickSelection = (pick: Pick, allSlips: number[]): Selection =>
  pick === "all" ? { note: true, slips: allSlips } : pick === "note" ? { note: true, slips: [] } : pick === "slips" ? { note: false, slips: allSlips } : { note: false, slips: [pick] };

/** "note copy 3 and slips 1, 2" for a toast. */
function copiesWords(selection: Selection, noteCopy: number | null, slipCopies: Record<string, number>) {
  const slips = selection.slips.map((line) => `slip ${line} copy ${slipCopies[String(line)] ?? "?"}`);
  return [selection.note ? `note copy ${noteCopy ?? "?"}` : "", ...slips].filter(Boolean).join(", ");
}

function DeliveryNotePrintPage() {
  const { orderNo } = Route.useParams();
  const [view, setView] = useState<DeliveryNoteView | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<"" | Mode>("");
  const [paper, setPaper] = useState<Paper>(EMPTY_PAPER);
  const [armed, setArmed] = useState(false);
  const [pick, setPick] = useState<Pick>("all");
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
   * One press: the database checks the payment and records the next copy of each paper chosen, with who printed it.
   * Then the papers print, or download as a PDF. Either way the press counts as a copy.
   */
  const press = async (selection: Selection, mode: Mode) => {
    setBusy(mode);
    let recorded = "";
    try {
      // Everything the PDF needs is loaded before the press is recorded, so a recorded copy always gets its file.
      const pdfKit = mode === "download" ? await Promise.all([import("jspdf"), loadLogoPng()]) : null;
      const { print, view: next } = await printReleasedPapers({ data: { orderNo, note: selection.note, slipLines: selection.slips } });
      recorded = copiesWords(selection, print.note_copy, print.slip_copies ?? {});
      flushSync(() => {
        setView(next);
        setPaper({
          selection, printedAt: print.printed_at, noteCopy: print.note_copy, slipCopies: print.slip_copies ?? {},
          printedBy: `${print.printed_by} (${roleWords(print.printed_role).en})`,
        });
        if (mode === "print") setArmed(true);
      });
      if (mode === "print") {
        window.clearTimeout(disarmTimer.current);
        window.print();
        disarmTimer.current = window.setTimeout(() => setArmed(false), ARMED_MS);
        return;
      }
      const papers = papersState(next);
      const { pdf, fileName } = buildDeliveryNotePdf(
        releasedPdfInput(print, { gate: next.state, selection, handovers: papers.handovers, origin: window.location.origin, customerNumber: next.customerNumber ?? null }),
        { jspdf: pdfKit![0], logo: pdfKit![1], textImage: canvasTextImage },
      );
      pdf.save(fileName);
      toast.success(`Downloaded ${fileName}`, { description: `Recorded: ${recorded}. Open the file to print or send it.`, duration: 10_000 });
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

  const { note, state, slips, allSlips, warnings, handovers, handedLines, noteWarnings, slipWarnings, prints } = papersState(view);
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
          <p className="text-sm text-danger">This order's delivery note is not released yet. {gateWords(state).title}: {gateWords(state).detail}</p>
        )}
        {note && (
          <>
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

            <div className="rounded-md border border-sky-200 bg-sky-50 p-2 text-xs text-sky-950">
              <p>
                <span className="font-bold">No QR on these papers:</span>{" "}
                <span>the godown hands goods over only when the godown in-charge scans the QR on the customer's invoice. Each print or download is the next numbered copy, with who printed it.</span>
              </p>
              <ul className="mt-1 space-y-0.5">
                <SoFar label="Note:" rows={prints.get("note")} />
                {slips.map((slip) => <SoFar key={slip.slip} label={`Slip ${slip.slip}:`} rows={prints.get(`slip:${slip.slip}`)} />)}
              </ul>
            </div>

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
          <NoteSheet note={note} state={state} warnings={noteWarnings} paper={paper} slipCount={slips.length} customerNumber={view?.customerNumber ?? null} />
          {slips.map((slip) => (
            <SlipSheet key={slip.slip} slip={slip} note={note} paper={paper} warnings={slipWarnings[String(slip.slip)] ?? warnings} customerNumber={view?.customerNumber ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

// The paper's colours, the same as the PDF and the invoice: navy, gold, ink and grey.
const SHEET = "dn-sheet relative mx-auto mb-4 w-full max-w-[210mm] overflow-hidden bg-white p-4 text-[13px] leading-snug text-[#1c252e] shadow-md sm:p-8";
const LABEL = "text-[10.5px] font-bold uppercase tracking-wider text-[#20483a]";

/**
 * The GB logo, light, in the middle of the paper: a little darker than before (owner, 11 Nov 2026) and laid over the
 * content (multiplied, so the text stays readable), so the table's filled rows can't hide it.
 */
function Watermark() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden mix-blend-multiply">
      <img src="/grainbazar-logo.png" alt="" className="w-[62%] max-w-[125mm] opacity-[0.09]" />
    </div>
  );
}

/** The paper's badge: the note is RELEASED. */
function Badge({ children }: { children: ReactNode }) {
  return <span className="mt-1 inline-block rounded bg-[#15803d] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white">{children}</span>;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="dn-keep my-3 border-[3px] border-[#1c252e] p-3 text-center text-[15px] font-extrabold uppercase tracking-wide">
      {warnings.map((warning) => <p key={warning}>{warning}</p>)}
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

/** When and which copy. Before a press, or for a paper the last press didn't make, there is nothing yet. */
function PrintedFacts({ paper, copy, inPrint }: { paper: Paper; copy: number | null | undefined; inPrint: boolean }) {
  const printed = Boolean(paper.printedAt && inPrint && copy);
  return (
    <>
      <Fact label="Printed" value={printed ? istDateTime(paper.printedAt!) : paper.printedAt ? "Not in the last copy" : "The time appears when you press Print or Download"} strong />
      <Fact label="Copy" value={printed ? `Copy ${copy} by ${paper.printedBy}` : "—"} />
    </>
  );
}

function CompanyHead({ note, title, side }: { note: DeliveryNote; title: string; side: string }) {
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
        <Badge>Released</Badge>
      </div>
    </header>
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
      <p>Computer-generated. Goods are handed over only when the godown scans the QR on the customer's invoice.</p>
      <p>grainbazar.com</p>
    </div>
  );
}

/** customerNumber: the customer's number in Zoho Books, read with the view (not part of the note's snapshot). */
function NoteSheet({ note, state, warnings, paper, slipCount, customerNumber }: { note: DeliveryNote; state: DeliveryGate; warnings: string[]; paper: Paper; slipCount: number; customerNumber: string | null }) {
  const { snapshot } = note;
  const pickup = isPickup(snapshot);
  const godownLines = addressLines(snapshot.godown);
  const customerLines = addressLines(snapshot.address);
  const lines = slipPages(snapshot);
  const totalQty = lines.reduce((sum, line) => sum + Number(line.qty), 0);
  const hasStockNo = lines.some((line) => line.stock_no);
  const copy = paper.selection.note ? paper.noteCopy : null;
  return (
    <section className={SHEET} data-print={paper.selection.note ? "yes" : "no"}>
      <Watermark />
      <div className="relative z-10">
        <CompanyHead note={note} title="Delivery note" side={note.note_no} />
        <Warnings warnings={warnings} />
        <dl className="mt-3 grid min-w-0 gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
          <Fact label="Order no." value={note.order_no} strong />
          <Fact label="Invoice no." value={note.invoice_number} strong />
          <Fact label="Order date" value={istDateTime(snapshot.order_placed_at)} />
          <Fact label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
          <Fact label="Released" value={releasedFact({ generated_at: note.generated_at, generated_how: howOf(note), generated_by_name: note.generated_by_name })} />
          <Fact label="Payment" value={state.code === "paid" ? "Paid in full" : "See the warning above"} strong />
          <PrintedFacts paper={paper} copy={copy} inPrint={paper.selection.note} />
        </dl>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
          <Card heading={pickup ? "Customer (collects at the godown)" : "Customer"}>
            <p className="font-bold">{snapshot.customer.business_name || snapshot.customer.name}</p>
            {snapshot.customer.business_name && snapshot.customer.name && <p>{snapshot.customer.name}</p>}
            {customerNumber && <p className="font-semibold"><span>Customer No.</span> <span data-no-translate>{customerNumber}</span></p>}
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
                {note.note_no} · Order {note.order_no} · Delivery note (released){copy ? ` · Copy ${copy}` : ""}
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

function SlipSheet({ slip, note, warnings, paper, customerNumber }: { slip: SlipPage; note: DeliveryNote; warnings: string[]; paper: Paper; customerNumber: string | null }) {
  const { snapshot } = note;
  const inPrint = paper.selection.slips.includes(slip.slip);
  return (
    <section className={SHEET} data-print={inPrint ? "yes" : "no"}>
      <Watermark />
      <div className="relative z-10">
        <CompanyHead note={note} title="Delivery slip" side={`Slip ${slip.slip} of ${slip.of}`} />
        <Warnings warnings={warnings} />
        <div className="dn-keep my-5 rounded-lg border-2 border-[#20483a] bg-[#f6f8fb] p-4">
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
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
          <Fact label="Note no." value={note.note_no} strong />
          <Fact label="Order no." value={note.order_no} strong />
          <Fact label="Invoice no." value={note.invoice_number} />
          <Fact label="Customer" value={snapshot.customer.business_name || snapshot.customer.name} />
          {customerNumber && <Fact label="Customer No." value={customerNumber} strong />}
          <Fact label="Godown" value={snapshot.godown.name ?? ""} />
          <Fact label="Delivery" value={deliveryMethodLabel(snapshot.shipping_method)} />
          <Fact label="Released" value={releasedFact({ generated_at: note.generated_at, generated_how: howOf(note), generated_by_name: note.generated_by_name })} />
          <PrintedFacts paper={paper} copy={inPrint ? paper.slipCopies[String(slip.slip)] : null} inPrint={inPrint} />
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
